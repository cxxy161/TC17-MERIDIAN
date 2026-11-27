import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  AlertTriangle,
  Check,
  Compass,
  Loader2,
  LogOut,
  MapPin,
  Orbit,
  Package,
  Rocket,
  Sparkles,
} from 'lucide-react';
import {
  ApiError,
  authApi,
  type OnboardingOptions,
  type OnboardingPlanet,
  type OnboardingTile,
  type SessionUser,
} from '../api/client';
import type { PlanetSummary } from '../types/meridian';
import { Planet3DCanvas } from '../components/Planet3DCanvas';
import { StarSystemOrbitSvg } from '../components/StarSystemOrbitSvg';
import { MeridianLogo } from '../components/MeridianLogo';

export interface OnboardingScreenProps {
  user: SessionUser;
  onComplete: (user: SessionUser) => void;
  onLogout: () => Promise<void>;
}

const MOD_LABELS: Record<string, string> = {
  power_water_station: '能源水站',
  recycling_plant: '生态回收',
  bio_greenhouse: '生态温室',
  consumer_workshop: '消费工坊',
  mine_smelter: '矿业冶炼',
  infra_factory: '结构日用',
  shipyard: '轨道船坞',
};

const PROF_KEY_BUILDINGS: Record<string, string[]> = {
  env_recycle: ['power_water_station', 'recycling_plant'],
  agri_bio: ['bio_greenhouse', 'consumer_workshop'],
  mining_ind: ['mine_smelter', 'infra_factory'],
};

const ARCHETYPE_ZH: Record<string, string> = {
  terrestrial: '宜居类地星',
  arid: '干旱矿星',
  icy: '冰冻远星',
  volcanic: '熔岩强光星',
  temperate: '温带行星',
};

type TileSortMode = 'best' | 'mine_smelter' | 'power_water_station' | 'bio_greenhouse' | 'capacity' | 'slot';

function tileScoreForProfession(tile: OnboardingTile, professionId: string): number {
  const keys = PROF_KEY_BUILDINGS[professionId] ?? [];
  const modSum = keys.reduce((acc, k) => acc + (tile.building_mods[k] ?? 1), 0);
  const avg = keys.length > 0 ? modSum / keys.length : 1;
  return avg + tile.capacity * 0.08;
}

function multTone(v: number): string {
  if (v >= 1.25) return 'text-emerald-300';
  if (v >= 0.9) return 'text-slate-200';
  return 'text-amber-300';
}

function planetFitHint(planet: OnboardingPlanet | null, professionId: string): { text: string; good: boolean } | null {
  if (!planet) return null;
  if (professionId === 'env_recycle') {
    const score = (planet.water_mult + planet.solar_mult) / 2;
    if (planet.water_mult >= 1.15 || planet.solar_mult >= 1.2) {
      return { text: `水光禀赋 ${score.toFixed(2)}x · 适合起能水`, good: true };
    }
    if (planet.city_count === 0) {
      return { text: '无原生城市 · 垃圾回收需靠外运', good: false };
    }
    return { text: `能水基准 ${score.toFixed(2)}x`, good: true };
  }
  if (professionId === 'agri_bio') {
    const score = (planet.water_mult + planet.solar_mult) / 2;
    if (planet.habitability >= 0.65 || score >= 1.1) {
      return { text: `宜居 ${Math.round(planet.habitability * 100)}% · 温室条件佳`, good: true };
    }
    return { text: `低温干旱 (${planet.water_mult.toFixed(2)}x水) · 建议自带水起步`, good: false };
  }
  if (planet.mineral_mult >= 1.15) {
    return { text: `矿产丰度 ${planet.mineral_mult.toFixed(2)}x · 高产矿星`, good: true };
  }
  return { text: `矿产系数 ${planet.mineral_mult.toFixed(2)}x`, good: planet.mineral_mult >= 0.9 };
}

function toPlanetSummary(p: OnboardingPlanet): PlanetSummary {
  const demands: Record<string, number> = {};
  for (const d of p.demands) demands[d.item_id] = d.qty;
  return {
    id: p.id,
    system_id: p.system_id,
    name: p.name,
    archetype: p.archetype,
    wealth_tier: p.wealth_tier,
    prosperity: p.prosperity,
    population: p.population,
    treasury: p.treasury,
    bank_reserves: p.bank_reserves,
    bank_rate_bps: p.bank_rate_bps,
    waste_backlog: 0,
    unclaimed_plots: p.unclaimed_count,
    orbit_radius: p.orbit_radius,
    orbit_angle: p.orbit_angle,
    habitability: p.habitability,
    solar_mult: p.solar_mult,
    mineral_mult: p.mineral_mult,
    water_mult: p.water_mult,
    ocean_ratio: p.ocean_ratio,
    rotation_days: p.rotation_days,
    visual_seed: p.visual_seed,
    city_count: p.city_count,
    city_level: p.city_level,
    city_capacity: p.city_capacity,
    demands,
  };
}

export const OnboardingScreen: React.FC<OnboardingScreenProps> = ({
  user,
  onComplete,
  onLogout,
}) => {
  const [options, setOptions] = useState<OnboardingOptions | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadErr, setLoadErr] = useState<string | null>(null);

  const [companyName, setCompanyName] = useState(() => user.nickname || 'Pioneer');
  const [professionId, setProfessionId] = useState('mining_ind');
  const [planetId, setPlanetId] = useState('');
  const [slotId, setSlotId] = useState<number | null>(null);
  const [tileSort, setTileSort] = useState<TileSortMode>('best');
  const [tileQuery, setTileQuery] = useState('');

  const [submitting, setSubmitting] = useState(false);
  const [submitErr, setSubmitErr] = useState<string | null>(null);

  const fetchOptions = useCallback(async (preserveSelection = false) => {
    setLoading(true);
    setLoadErr(null);
    try {
      const data = await authApi.onboardingOptions();
      setOptions(data);
      if (data.professions.length > 0 && !preserveSelection) {
        setProfessionId(data.professions[0].id);
      }
      const availPlanets = data.planets.filter((p) => p.tiles.length > 0);
      if (!preserveSelection) {
        const bestP =
          availPlanets
            .slice()
            .sort((a, b) => b.habitability - a.habitability || b.unclaimed_count - a.unclaimed_count)[0] ??
          data.planets[0];
        if (bestP) {
          setPlanetId(bestP.id);
        }
      }
    } catch (err) {
      setLoadErr(err instanceof Error ? err.message : '加载开局选项失败');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void fetchOptions(false);
  }, [fetchOptions]);

  const selectedPlanet: OnboardingPlanet | null = useMemo(() => {
    if (!options) return null;
    return options.planets.find((p) => p.id === planetId) ?? options.planets[0] ?? null;
  }, [options, planetId]);

  const selectedPlanetSummary = useMemo(
    () => (selectedPlanet ? toPlanetSummary(selectedPlanet) : undefined),
    [selectedPlanet],
  );

  const selectedProfession = useMemo(() => {
    if (!options) return null;
    return options.professions.find((p) => p.id === professionId) ?? options.professions[0] ?? null;
  }, [options, professionId]);

  const sortedTiles = useMemo(() => {
    if (!selectedPlanet) return [];
    const q = tileQuery.trim().toLowerCase();
    const list = selectedPlanet.tiles.filter((t) => {
      if (!q) return true;
      return t.terrain_name.toLowerCase().includes(q) || String(t.slot_id).includes(q);
    });
    return list.slice().sort((a, b) => {
      if (tileSort === 'capacity') return b.capacity - a.capacity || a.slot_id - b.slot_id;
      if (tileSort === 'slot') return a.slot_id - b.slot_id;
      if (tileSort === 'mine_smelter' || tileSort === 'power_water_station' || tileSort === 'bio_greenhouse') {
        const ma = a.building_mods[tileSort] ?? 0;
        const mb = b.building_mods[tileSort] ?? 0;
        return mb - ma || b.capacity - a.capacity || a.slot_id - b.slot_id;
      }
      return tileScoreForProfession(b, professionId) - tileScoreForProfession(a, professionId);
    });
  }, [selectedPlanet, tileQuery, tileSort, professionId]);

  useEffect(() => {
    if (!selectedPlanet) {
      setSlotId(null);
      return;
    }
    const stillValid = slotId !== null && selectedPlanet.tiles.some((t) => t.slot_id === slotId);
    if (!stillValid) {
      const best = selectedPlanet.tiles
        .slice()
        .sort((a, b) => tileScoreForProfession(b, professionId) - tileScoreForProfession(a, professionId))[0];
      setSlotId(best ? best.slot_id : null);
    }
  }, [selectedPlanet, professionId, slotId]);

  const selectedTile = useMemo(
    () => selectedPlanet?.tiles.find((t) => t.slot_id === slotId) ?? null,
    [selectedPlanet, slotId],
  );

  const pickRecommended = () => {
    if (!selectedPlanet || selectedPlanet.tiles.length === 0) return;
    const best = selectedPlanet.tiles
      .slice()
      .sort((a, b) => tileScoreForProfession(b, professionId) - tileScoreForProfession(a, professionId))[0];
    if (best) setSlotId(best.slot_id);
  };

  const handleSelectPlanetFromOrbit = (pid: string) => {
    const target = options?.planets.find((p) => p.id === pid);
    if (!target) return;
    setPlanetId(target.id);
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    const cleanName = companyName.trim();
    if (cleanName.length < 2 || cleanName.length > 24) {
      setSubmitErr('公司名称长度须为 2–24 个字符');
      return;
    }
    if (!selectedProfession || !selectedPlanet || slotId === null) {
      setSubmitErr('请先完整选择职业、行星与空地格点');
      return;
    }
    if (selectedPlanet.unclaimed_count === 0) {
      setSubmitErr('该行星暂无免费空地，请选择其他行星');
      return;
    }
    setSubmitting(true);
    setSubmitErr(null);
    try {
      const updatedUser = await authApi.submitOnboarding({
        company_name: cleanName,
        profession: selectedProfession.id,
        planet_id: selectedPlanet.id,
        slot_id: slotId,
      });
      onComplete(updatedUser);
    } catch (err) {
      if (err instanceof ApiError) {
        const msg =
          typeof err.payload === 'object' && err.payload && 'message' in err.payload
            ? String((err.payload as { message?: unknown }).message)
            : err.message;
        setSubmitErr(msg);
        if (err.status === 409) {
          void fetchOptions(true);
        }
      } else {
        setSubmitErr(err instanceof Error ? err.message : '创建公司失败，请稍后重试');
      }
    } finally {
      setSubmitting(false);
    }
  };

  if (loading && !options) {
    return (
      <div className="flex h-screen w-screen items-center justify-center bg-[#161b22] text-slate-300">
        <div className="flex items-center gap-2 font-mono text-xs text-sky-300">
          <Loader2 size={15} className="animate-spin" />
          正在扫描星系航图与星球遥测数据…
        </div>
      </div>
    );
  }

  const habPct = selectedPlanet ? Math.round(selectedPlanet.habitability * 100) : 0;
  const oceanPct = selectedPlanet ? Math.round(selectedPlanet.ocean_ratio * 100) : 0;
  const capPct =
    selectedPlanet && selectedPlanet.city_capacity > 0
      ? Math.round((selectedPlanet.population / selectedPlanet.city_capacity) * 100)
      : 0;

  return (
    <div className="flex h-screen w-screen flex-col overflow-hidden bg-[#161b22] text-slate-200">
      {/* Header */}
      <header className="flex shrink-0 flex-wrap items-center justify-between gap-3 border-b border-[rgba(56,189,248,0.16)] bg-[#232a36] px-4 py-2">
        <div className="flex flex-wrap items-center gap-2.5">
          <MeridianLogo className="w-5 h-5 shrink-0" />
          <span className="inline-flex items-center gap-1.5 rounded-[2px] border border-sky-400/35 bg-sky-500/15 px-2 py-0.5 text-[10px] font-semibold tracking-[0.16em] text-sky-300">
            MERIDIAN · 星际开局勘探
          </span>
          <h1 className="text-[13.5px] font-semibold text-slate-100">
            {options?.system.name ?? '新伊甸星系'}
          </h1>
          <span className="mono rounded-[2px] border border-amber-400/25 bg-amber-500/10 px-1.5 py-0.5 text-[10px] text-amber-200">
            {options?.system.star_class ?? 'G2V'} · 第 {options?.tick ?? 0} 回合
          </span>
          <span className="hidden text-[11px] text-slate-400 xl:inline">
            不送工厂 · 零脚本预设 · 自由勘测星系与 3D 星表后降落起步
          </span>
        </div>

        <div className="flex items-center gap-3">
          <span className="mono text-[11px] text-slate-400">
            账号：<strong className="text-slate-200">{user.nickname}</strong>
          </span>
          <button
            type="button"
            onClick={() => void onLogout()}
            className="pill-btn inline-flex items-center gap-1 text-[11px]"
          >
            <LogOut size={11} />
            切换账号
          </button>
        </div>
      </header>

      {loadErr && (
        <div className="flex items-center justify-between border-b border-rose-500/40 bg-rose-500/15 px-5 py-2 text-xs text-rose-200">
          <span>{loadErr}</span>
          <button type="button" onClick={() => void fetchOptions(false)} className="underline">
            重试加载
          </button>
        </div>
      )}

      <form onSubmit={handleSubmit} className="flex min-h-0 flex-1 flex-col">
        {/* Main telemetry + selection workspace */}
        <div className="grid min-h-0 flex-1 grid-cols-1 gap-3 overflow-hidden p-3 lg:grid-cols-[minmax(480px,1.15fr)_minmax(420px,1fr)]">
          {/* LEFT: Star System Orbit + Interactive 3D Globe + Planet Telemetry */}
          <section className="flex min-h-0 flex-col overflow-hidden rounded-[2px] border border-[rgba(56,189,248,0.16)] bg-[#1b212b]">
            {/* Visual title bar & planet quick switcher */}
            <div className="flex shrink-0 flex-wrap items-center justify-between gap-2 border-b border-sky-500/15 bg-[#232a36] px-2.5 py-1.5">
              <div className="flex items-center gap-1.5 text-[10.5px] font-semibold text-sky-300">
                <Orbit size={12} />
                <span>星系航图与 3D 星表遥测（点击轨道星体切换）</span>
              </div>
              <div className="flex flex-wrap items-center gap-1">
                {(options?.planets ?? []).map((p) => {
                  const active = p.id === selectedPlanet?.id;
                  return (
                    <button
                      key={p.id}
                      type="button"
                      onClick={() => setPlanetId(p.id)}
                      className={`pill-btn py-0 text-[10px] whitespace-nowrap ${active ? 'active' : ''} ${
                        p.unclaimed_count === 0 ? 'opacity-50' : ''
                      }`}
                    >
                      {p.name} ({p.id})
                      <span className={`ml-1 mono text-[9px] ${p.unclaimed_count > 0 ? 'text-emerald-300' : 'text-rose-400'}`}>
                        {p.unclaimed_count}地
                      </span>
                    </button>
                  );
                })}
              </div>
            </div>

            {/* Dual visual deck: Orbit map (left) + 3D Planet Canvas (right) */}
            <div className="grid min-h-[210px] flex-1 grid-cols-1 border-b border-slate-700/70 bg-[#191f27] md:grid-cols-[1.02fr_1fr]">
              <div className="relative min-h-[190px] border-b border-slate-800/80 md:border-b-0 md:border-r">
                <div className="pointer-events-none absolute top-1.5 left-2.5 z-10 text-[10px] text-slate-400">
                  恒星系轨道分布 · 点击星体选址
                </div>
                <StarSystemOrbitSvg
                  planets={options?.planets ?? []}
                  hubOrbitRadius={options?.system.hub_orbit_radius ?? 1.45}
                  hubOrbitDays={options?.system.hub_orbit_days ?? 200}
                  hubOrbitAngle={options?.system.hub_orbit_angle}
                  tick={options?.tick ?? 0}
                  ticksPerDay={options?.ticks_per_day ?? 24}
                  selectedPlanetId={selectedPlanet?.id}
                  onSelectPlanet={handleSelectPlanetFromOrbit}
                />
              </div>

              <div className="relative min-h-[190px]">
                {selectedPlanet && (
                  <>
                    <div className="pointer-events-none absolute top-1.5 left-2.5 z-10 flex items-center gap-1.5 text-[10px] text-sky-200">
                      <span className="font-semibold">{selectedPlanet.name}</span>
                      <span className="mono text-slate-400">({selectedPlanet.id})</span>
                    </div>
                    <Planet3DCanvas
                      planetId={selectedPlanet.id}
                      planet={selectedPlanetSummary}
                      tick={options?.tick ?? 0}
                      paused={false}
                      tickMs={options?.tick_ms ?? 1000}
                      ticksPerDay={options?.ticks_per_day ?? 24}
                    />
                  </>
                )}
              </div>
            </div>

            {/* Structured Planet Telemetry Table */}
            {selectedPlanet && (
              <div className="shrink-0 overflow-y-auto divide-y divide-slate-700/60 text-[10.5px]">
                <div className="flex">
                  <div className="w-[24%] min-w-[84px] shrink-0 border-r border-slate-700/60 bg-[#244465]/75 px-2.5 py-1 text-slate-100">
                    类型 / 轨道
                  </div>
                  <div className="flex-1 px-2.5 py-1 text-right text-slate-200">
                    {ARCHETYPE_ZH[selectedPlanet.archetype] ?? selectedPlanet.archetype} ·{' '}
                    <span className="mono">{selectedPlanet.orbit_radius.toFixed(2)} AU</span>
                  </div>
                </div>

                <div className="flex">
                  <div className="w-[24%] min-w-[84px] shrink-0 border-r border-slate-700/60 bg-[#244465]/75 px-2.5 py-1 text-slate-100">
                    宜居 / 城市
                  </div>
                  <div className="mono flex-1 px-2.5 py-1 text-right">
                    <span className={habPct >= 75 ? 'text-emerald-300' : habPct >= 38 ? 'text-sky-300' : 'text-amber-300'}>
                      宜居 {habPct}%
                    </span>
                    <span className="mx-1.5 text-slate-500">·</span>
                    <span className="text-slate-200">
                      {selectedPlanet.city_count > 0
                        ? `${selectedPlanet.city_count} 座城市 (Lv.${selectedPlanet.city_level})`
                        : '无原生城市'}
                    </span>
                  </div>
                </div>

                <div className="flex">
                  <div className="w-[24%] min-w-[84px] shrink-0 border-r border-slate-700/60 bg-[#244465]/75 px-2.5 py-1 text-slate-100">
                    资源禀赋
                  </div>
                  <div className="mono flex-1 px-2.5 py-1 text-right">
                    <span className="mr-1 text-slate-400">矿产</span>
                    <span className={multTone(selectedPlanet.mineral_mult)}>
                      {selectedPlanet.mineral_mult.toFixed(2)}x
                    </span>
                    <span className="mx-1.5 text-slate-500">·</span>
                    <span className="mr-1 text-slate-400">光照</span>
                    <span className={multTone(selectedPlanet.solar_mult)}>
                      {selectedPlanet.solar_mult.toFixed(2)}x
                    </span>
                    <span className="mx-1.5 text-slate-500">·</span>
                    <span className="mr-1 text-slate-400">水资源</span>
                    <span className={multTone(selectedPlanet.water_mult)}>
                      {selectedPlanet.water_mult.toFixed(2)}x
                    </span>
                  </div>
                </div>

                <div className="flex">
                  <div className="w-[24%] min-w-[84px] shrink-0 border-r border-slate-700/60 bg-[#244465]/75 px-2.5 py-1 text-slate-100">
                    地貌 / 重力
                  </div>
                  <div className="mono flex-1 px-2.5 py-1 text-right text-slate-200">
                    <span className="mr-1 text-slate-400">海洋</span>
                    {oceanPct}%
                    <span className="mx-1.5 text-slate-500">·</span>
                    <span className="mr-1 text-slate-400">重力</span>
                    {selectedPlanet.gravity.toFixed(2)}g
                    <span className="mx-1.5 text-slate-500">·</span>
                    <span className="mr-1 text-slate-400">人口</span>
                    {Math.round(selectedPlanet.population).toLocaleString()}
                    {selectedPlanet.city_capacity > 0 && (
                      <span className="text-slate-400"> ({capPct}%)</span>
                    )}
                  </div>
                </div>

                <div className="flex">
                  <div className="w-[24%] min-w-[84px] shrink-0 border-r border-slate-700/60 bg-[#244465]/75 px-2.5 py-1 text-slate-100">
                    航运 / 入驻
                  </div>
                  <div className="mono flex-1 px-2.5 py-1 text-right text-slate-200">
                    <span className="mr-1 text-slate-400">登轨</span>
                    {selectedPlanet.launch_cost
                      ? `${selectedPlanet.launch_cost[0]}t/${selectedPlanet.launch_cost[1]}油`
                      : '--'}
                    <span className="mx-1.5 text-slate-500">·</span>
                    <span className="mr-1 text-slate-400">往枢纽</span>
                    {selectedPlanet.hub_cost
                      ? `${selectedPlanet.hub_cost[0]}t/${selectedPlanet.hub_cost[1]}油`
                      : '--'}
                    <span className="mx-1.5 text-slate-500">·</span>
                    <span className={selectedPlanet.unclaimed_count > 0 ? 'text-emerald-300' : 'text-rose-400'}>
                      余地 {selectedPlanet.unclaimed_count}
                    </span>
                    <span className="mx-1 text-slate-500">/</span>
                    <span className="text-sky-300">{selectedPlanet.resident_count} 家</span>
                  </div>
                </div>

                <div className="flex items-center">
                  <div className="w-[24%] min-w-[84px] shrink-0 self-stretch border-r border-slate-700/60 bg-[#244465]/75 px-2.5 py-1 flex items-center text-slate-100">
                    市民需求
                  </div>
                  <div className="flex flex-1 flex-wrap justify-end gap-1 px-2.5 py-1">
                    {selectedPlanet.demands.length === 0 ? (
                      <span className="text-slate-500">当前无原生城市收购需求（适合生产后航运枢纽交易）</span>
                    ) : (
                      selectedPlanet.demands.slice(0, 7).map((d) => (
                        <span
                          key={d.item_id}
                          className="mono rounded-[2px] border border-emerald-500/25 bg-emerald-500/10 px-1.5 py-[0.5px] text-[10px] text-emerald-200"
                        >
                          {d.item_name} ×{d.qty}
                        </span>
                      ))
                    )}
                  </div>
                </div>
              </div>
            )}
          </section>

          {/* RIGHT: Company Name + Profession Pack + Unclaimed Surface Tile Picker */}
          <section className="flex min-h-0 flex-col gap-2.5 overflow-hidden rounded-[2px] border border-[rgba(56,189,248,0.14)] bg-[#202732] p-3">
            {/* 01 Company Name + 02 Profession Packs */}
            <div className="flex shrink-0 flex-col gap-2">
              <div className="flex items-center gap-3">
                <label
                  htmlFor="onboarding-company-name"
                  className="shrink-0 text-[10.5px] font-semibold uppercase tracking-[0.12em] text-slate-400"
                >
                  01 · 企业代号
                </label>
                <input
                  id="onboarding-company-name"
                  value={companyName}
                  onChange={(e) => setCompanyName(e.target.value)}
                  maxLength={24}
                  placeholder="输入 2–24 位公司名称"
                  className="flex-1 rounded-[2px] border border-slate-700/80 bg-[#181e27] px-2.5 py-1 text-[12px] text-slate-100 outline-none focus:border-sky-400"
                />
              </div>

              <div className="flex items-center justify-between pt-0.5">
                <span className="text-[10.5px] font-semibold uppercase tracking-[0.12em] text-slate-400">
                  02 · 选择起步物资包（无额外加成 · 仅初始物资差异）
                </span>
                <span className="mono text-[10px] text-emerald-300">
                  含 {(options?.starter_cash ?? 3500).toLocaleString()} 信用点 + 小货船 ×1
                </span>
              </div>

              <div className="grid grid-cols-1 gap-2">
                {(options?.professions ?? []).map((prof) => {
                  const active = prof.id === selectedProfession?.id;
                  const fit = planetFitHint(selectedPlanet, prof.id);
                  return (
                    <button
                      key={prof.id}
                      type="button"
                      onClick={() => setProfessionId(prof.id)}
                      className={`rounded-[2px] border px-2.5 py-2 text-left transition-colors ${
                        active
                          ? 'border-sky-400 bg-[#1b2432] shadow-[0_0_0_1px_rgba(56,189,248,0.25)]'
                          : 'border-slate-700/70 bg-[#1b212b] hover:border-slate-500'
                      }`}
                    >
                      <div className="flex flex-wrap items-center justify-between gap-1.5">
                        <div className="flex items-center gap-2">
                          <span
                            className="inline-block h-2.5 w-2.5 rounded-full"
                            style={{ backgroundColor: prof.color }}
                          />
                          <span className="text-[12px] font-semibold text-slate-100">
                            {prof.name}
                          </span>
                        </div>
                        <div className="flex items-center gap-1.5">
                          {fit && (
                            <span
                              className={`mono rounded-[2px] border px-1.5 py-[0.5px] text-[9.5px] ${
                                fit.good
                                  ? 'border-emerald-500/35 bg-emerald-500/10 text-emerald-300'
                                  : 'border-amber-500/35 bg-amber-500/10 text-amber-200'
                              }`}
                            >
                              {fit.text}
                            </span>
                          )}
                          {active && (
                            <span className="inline-flex items-center gap-0.5 rounded-[2px] bg-sky-500/20 px-1.5 py-0.5 text-[9.5px] font-medium text-sky-300">
                              <Check size={10} />
                              已选
                            </span>
                          )}
                        </div>
                      </div>

                      <p className="mt-1 text-[10.5px] leading-snug text-slate-400">
                        {prof.description}
                      </p>

                      <div className="mt-1.5 flex flex-wrap items-center gap-1 border-t border-white/[0.06] pt-1.5">
                        <Package size={10} className="mr-0.5 text-sky-400" />
                        {prof.starter_supplies.map((s) => (
                          <span
                            key={s.item_id}
                            className="mono rounded-[2px] border border-sky-500/20 bg-[#141a23] px-1.5 py-[0.5px] text-[9.5px] text-slate-300"
                          >
                            {s.item_name} <strong className="text-sky-300">×{s.qty}</strong>
                          </span>
                        ))}
                      </div>
                    </button>
                  );
                })}
              </div>
            </div>

            {/* 03 Surface Tile Toolbar + Scrollable Tile Grid */}
            <div className="flex shrink-0 flex-wrap items-center justify-between gap-1.5 border-t border-white/[0.08] pt-2">
              <div className="flex items-center gap-2">
                <span className="inline-flex items-center gap-1 text-[10.5px] font-semibold uppercase tracking-[0.12em] text-slate-400">
                  <MapPin size={11} className="text-sky-400" />
                  03 · {selectedPlanet?.name ?? '行星'}免费降落地块（{sortedTiles.length}）
                </span>
                <button
                  type="button"
                  onClick={pickRecommended}
                  className="pill-btn inline-flex items-center gap-1 py-0 text-[10px] text-sky-300"
                >
                  <Sparkles size={10} />
                  推荐最佳
                </button>
              </div>

              <div className="flex flex-wrap items-center gap-1">
                <input
                  value={tileQuery}
                  onChange={(e) => setTileQuery(e.target.value)}
                  placeholder="搜地形 / #id..."
                  className="w-24 rounded-[2px] border border-slate-700/70 bg-[#181e27] px-1.5 py-0.5 text-[10px] outline-none focus:border-sky-400"
                />
                {([
                  ['best', '综合'],
                  ['mine_smelter', '矿冶'],
                  ['power_water_station', '能水'],
                  ['bio_greenhouse', '农业'],
                  ['capacity', '槽位'],
                  ['slot', '编号'],
                ] as const).map(([key, label]) => (
                  <button
                    key={key}
                    type="button"
                    onClick={() => setTileSort(key)}
                    className={`pill-btn py-0 text-[10px] ${tileSort === key ? 'active' : ''}`}
                  >
                    {label}
                  </button>
                ))}
              </div>
            </div>

            <div className="min-h-0 flex-1 overflow-y-auto pr-1">
              {sortedTiles.length === 0 ? (
                <div className="flex h-28 items-center justify-center text-xs text-slate-500">
                  {selectedPlanet?.unclaimed_count === 0
                    ? '当前行星暂无未占领空地，请在左侧星系图点击其他行星'
                    : '没有匹配的未认领空地，请清空筛选词'}
                </div>
              ) : (
                <div className="grid grid-cols-1 gap-1.5 sm:grid-cols-2">
                  {sortedTiles.map((t) => {
                    const active = t.slot_id === slotId;
                    const topMods = Object.entries(t.building_mods)
                      .filter(([, v]) => Math.abs(v - 1) >= 0.04)
                      .sort((a, b) => b[1] - a[1])
                      .slice(0, 4);
                    return (
                      <button
                        key={t.slot_id}
                        type="button"
                        onClick={() => setSlotId(t.slot_id)}
                        className={`rounded-[2px] border p-2 text-left transition-colors ${
                          active
                            ? 'border-sky-400 bg-[#1b2432] shadow-[0_0_0_1px_rgba(56,189,248,0.25)]'
                            : 'border-slate-700/60 bg-[#1b212b] hover:border-slate-500'
                        }`}
                      >
                        <div className="flex items-center justify-between gap-1">
                          <span className="text-[11px] font-medium text-slate-100">
                            {t.terrain_name}
                          </span>
                          <span className="mono text-[10px] text-sky-400">
                            #{t.slot_id} · <span className="text-emerald-300">{t.capacity}槽</span>
                          </span>
                        </div>
                        <div className="mt-1 flex flex-wrap items-center justify-between gap-1">
                          <div className="flex flex-wrap gap-1">
                            {topMods.length === 0 ? (
                              <span className="text-[9.5px] text-slate-500">均衡地形 1.00x</span>
                            ) : (
                              topMods.map(([bid, val]) => (
                                <span
                                  key={bid}
                                  className={`mono rounded-[2px] border px-1 py-[0.5px] text-[9px] ${
                                    val >= 1.15
                                      ? 'border-emerald-500/40 bg-emerald-500/10 text-emerald-300'
                                      : val < 0.92
                                        ? 'border-rose-500/30 bg-rose-500/10 text-rose-300'
                                        : 'border-slate-700 bg-[#141a23] text-slate-300'
                                  }`}
                                >
                                  {MOD_LABELS[bid] ?? bid} {val.toFixed(2)}x
                                </span>
                              ))
                            )}
                          </div>
                          <span className="mono text-[9.5px] text-slate-500">
                            {t.lat.toFixed(0)}°,{t.lon.toFixed(0)}°
                          </span>
                        </div>
                      </button>
                    );
                  })}
                </div>
              )}
            </div>
          </section>
        </div>

        {/* Footer action bar */}
        <footer className="flex shrink-0 flex-wrap items-center justify-between gap-3 border-t border-[rgba(56,189,248,0.16)] bg-[#232a36] px-5 py-2.5">
          <div className="flex flex-wrap items-center gap-3 text-[11px]">
            {submitErr ? (
              <span className="inline-flex items-center gap-1.5 text-rose-300">
                <AlertTriangle size={13} />
                {submitErr}
              </span>
            ) : (
              <span className="inline-flex items-center gap-2 text-slate-300">
                <Compass size={13} className="text-sky-400" />
                <span>
                  降落方案：<strong className="text-slate-100">{companyName.trim() || '未命名'}</strong>
                  {' · '}
                  <strong className="text-sky-300">{selectedProfession?.name ?? '--'}</strong>
                  {' · '}
                  <strong className="text-emerald-300">
                    {selectedPlanet ? `${selectedPlanet.name}(${selectedPlanet.id})` : '--'}
                  </strong>
                  {' · '}
                  <span className="mono">
                    {selectedTile
                      ? `#${selectedTile.slot_id} ${selectedTile.terrain_name} (${selectedTile.capacity}槽)`
                      : '请选择可用地块'}
                  </span>
                  {' · '}
                  <span className="text-slate-400">
                    资金 {(options?.starter_cash ?? 3500).toLocaleString()} + 小货船 ×1
                  </span>
                </span>
              </span>
            )}
          </div>

          <button
            type="submit"
            disabled={
              submitting ||
              !selectedProfession ||
              !selectedPlanet ||
              selectedPlanet.unclaimed_count === 0 ||
              slotId === null
            }
            className="cta-green inline-flex items-center gap-1.5 px-4 py-1.5 text-[12px] disabled:cursor-not-allowed disabled:opacity-50"
          >
            {submitting ? <Loader2 size={13} className="animate-spin" /> : <Rocket size={13} />}
            {submitting ? '正在创建公司与飞船…' : '确认降落并进入工作台'}
          </button>
        </footer>
      </form>
    </div>
  );
};

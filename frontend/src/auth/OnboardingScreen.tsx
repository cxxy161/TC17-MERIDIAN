import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  AlertTriangle,
  Check,
  Compass,
  Globe2,
  Loader2,
  LogOut,
  MapPin,
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

function tileScoreForProfession(tile: OnboardingTile, professionId: string): number {
  const keys = PROF_KEY_BUILDINGS[professionId] ?? [];
  const modSum = keys.reduce((acc, k) => acc + (tile.building_mods[k] ?? 1), 0);
  const avg = keys.length > 0 ? modSum / keys.length : 1;
  return avg + tile.capacity * 0.08;
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
  const [tileSort, setTileSort] = useState<'best' | 'capacity' | 'slot'>('best');
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

  const selectedProfession = useMemo(() => {
    if (!options) return null;
    return options.professions.find((p) => p.id === professionId) ?? options.professions[0] ?? null;
  }, [options, professionId]);

  const sortedTiles = useMemo(() => {
    if (!selectedPlanet) return [];
    const q = tileQuery.trim().toLowerCase();
    const list = selectedPlanet.tiles.filter((t) => {
      if (!q) return true;
      return (
        t.terrain_name.toLowerCase().includes(q) ||
        String(t.slot_id).includes(q)
      );
    });
    return list.slice().sort((a, b) => {
      if (tileSort === 'capacity') {
        return b.capacity - a.capacity || a.slot_id - b.slot_id;
      }
      if (tileSort === 'slot') {
        return a.slot_id - b.slot_id;
      }
      return tileScoreForProfession(b, professionId) - tileScoreForProfession(a, professionId);
    });
  }, [selectedPlanet, tileQuery, tileSort, professionId]);

  // Auto-select top recommended tile whenever planet changes or current slot disappears
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
          正在扫描星系航图与可降落地块…
        </div>
      </div>
    );
  }

  return (
    <div className="flex h-screen w-screen flex-col overflow-hidden bg-[#161b22] text-slate-200">
      {/* Header */}
      <header className="flex shrink-0 flex-wrap items-center justify-between gap-3 border-b border-[rgba(56,189,248,0.16)] bg-[#232a36] px-5 py-2.5">
        <div className="flex items-center gap-3">
          <span className="inline-flex items-center gap-1.5 rounded-[2px] border border-sky-400/35 bg-sky-500/15 px-2 py-0.5 text-[10px] font-semibold tracking-[0.18em] text-sky-300">
            MERIDIAN · 开局初始化
          </span>
          <h1 className="text-[14px] font-semibold text-slate-100">星际企业落地控制台</h1>
          <span className="hidden text-[11px] text-slate-400 lg:inline">
            不送工厂、不预设脚本 — 选择行业起步包与降落坐标，亲手建造第一座工厂并赚取第一桶金
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
        {/* Main two-column selector */}
        <div className="grid min-h-0 flex-1 grid-cols-1 gap-3 overflow-hidden p-3 lg:grid-cols-[380px_1fr]">
          {/* Left: Company Name + Profession Pack */}
          <section className="flex min-h-0 flex-col gap-3 overflow-y-auto rounded-[2px] border border-[rgba(56,189,248,0.14)] bg-[#202732] p-3">
            <div>
              <label
                htmlFor="onboarding-company-name"
                className="mb-1 block text-[10px] font-semibold uppercase tracking-[0.14em] text-slate-400"
              >
                01 · 企业代号 / 公司名称
              </label>
              <input
                id="onboarding-company-name"
                value={companyName}
                onChange={(e) => setCompanyName(e.target.value)}
                maxLength={24}
                placeholder="输入 2–24 位公司名称"
                className="w-full rounded-[2px] border border-slate-700/80 bg-[#181e27] px-2.5 py-1.5 text-[12px] text-slate-100 outline-none focus:border-sky-400"
              />
            </div>

            <div className="flex flex-col gap-2">
              <div className="flex items-center justify-between">
                <span className="text-[10px] font-semibold uppercase tracking-[0.14em] text-slate-400">
                  02 · 选择行业起步物资包
                </span>
                <span className="text-[10px] text-slate-500">各行业后续均可自由建全系建筑</span>
              </div>

              {(options?.professions ?? []).map((prof) => {
                const active = prof.id === selectedProfession?.id;
                return (
                  <button
                    key={prof.id}
                    type="button"
                    onClick={() => setProfessionId(prof.id)}
                    className={`rounded-[2px] border p-3 text-left transition-colors ${
                      active
                        ? 'border-sky-400 bg-[#1b2432] shadow-[0_0_0_1px_rgba(56,189,248,0.25)]'
                        : 'border-slate-700/70 bg-[#1b212b] hover:border-slate-500'
                    }`}
                  >
                    <div className="flex items-center justify-between gap-2">
                      <div className="flex items-center gap-2">
                        <span
                          className="inline-block h-2.5 w-2.5 rounded-full"
                          style={{ backgroundColor: prof.color }}
                        />
                        <span className="text-[12.5px] font-semibold text-slate-100">
                          {prof.name}
                        </span>
                      </div>
                      {active && (
                        <span className="inline-flex items-center gap-0.5 rounded-[2px] bg-sky-500/20 px-1.5 py-0.5 text-[9.5px] font-medium text-sky-300">
                          <Check size={10} />
                          已选择
                        </span>
                      )}
                    </div>

                    <p className="mt-1.5 text-[11px] leading-relaxed text-slate-400">
                      {prof.description}
                    </p>

                    <div className="mt-2.5 border-t border-white/[0.06] pt-2">
                      <div className="mb-1 flex items-center gap-1 text-[10px] text-slate-400">
                        <Package size={10} className="text-sky-400" />
                        <span>开局赠送：{prof.starter_cash.toLocaleString()} 信用点 · 小货船 ×1 · 无预设工厂</span>
                      </div>
                      <div className="flex flex-wrap gap-1">
                        {prof.starter_supplies.map((s) => (
                          <span
                            key={s.item_id}
                            className="mono rounded-[2px] border border-sky-500/20 bg-[#141a23] px-1.5 py-[1px] text-[10px] text-slate-300"
                          >
                            {s.item_name} <strong className="text-sky-300">×{s.qty}</strong>
                          </span>
                        ))}
                      </div>
                    </div>
                  </button>
                );
              })}
            </div>
          </section>

          {/* Right: Planet + Unclaimed Tile Picker */}
          <section className="flex min-h-0 flex-col gap-3 overflow-hidden rounded-[2px] border border-[rgba(56,189,248,0.14)] bg-[#202732] p-3">
            {/* Planets strip */}
            <div className="shrink-0">
              <div className="mb-1.5 flex items-center justify-between">
                <span className="inline-flex items-center gap-1 text-[10px] font-semibold uppercase tracking-[0.14em] text-slate-400">
                  <Globe2 size={11} className="text-sky-400" />
                  03 · 选择母星（免费赠送所选首块地）
                </span>
                <span className="text-[10px] text-slate-500">
                  共 {(options?.planets ?? []).length} 颗行星
                </span>
              </div>
              <div className="grid grid-cols-1 gap-2 sm:grid-cols-2 xl:grid-cols-3">
                {(options?.planets ?? []).map((p) => {
                  const active = p.id === selectedPlanet?.id;
                  const disabled = p.unclaimed_count === 0;
                  return (
                    <button
                      key={p.id}
                      type="button"
                      disabled={disabled}
                      onClick={() => setPlanetId(p.id)}
                      className={`rounded-[2px] border px-2.5 py-2 text-left transition-colors ${
                        disabled
                          ? 'cursor-not-allowed border-slate-800 bg-[#181d25] opacity-45'
                          : active
                            ? 'border-sky-400 bg-[#1b2432]'
                            : 'border-slate-700/70 bg-[#1b212b] hover:border-slate-500'
                      }`}
                    >
                      <div className="flex items-center justify-between gap-1">
                        <span className="text-[12px] font-semibold text-slate-100">
                          {p.name} <span className="mono text-[10px] text-sky-400">({p.id})</span>
                        </span>
                        <span className="text-[10px] text-slate-400">
                          {ARCHETYPE_ZH[p.archetype] ?? p.archetype}
                        </span>
                      </div>
                      <div className="mono mt-1.5 grid grid-cols-2 gap-x-2 gap-y-0.5 text-[10px] text-slate-400">
                        <span>宜居 {Math.round(p.habitability * 100)}%</span>
                        <span>重力 {p.gravity.toFixed(2)}g</span>
                        <span>人口 {Math.round(p.population).toLocaleString()}</span>
                        <span className={p.unclaimed_count > 0 ? 'text-emerald-300' : 'text-rose-400'}>
                          空地 {p.unclaimed_count} 块
                        </span>
                      </div>
                    </button>
                  );
                })}
              </div>
            </div>

            {/* Tile list toolbar */}
            <div className="flex shrink-0 flex-wrap items-center justify-between gap-2 border-t border-white/[0.06] pt-2.5">
              <div className="flex items-center gap-2">
                <span className="inline-flex items-center gap-1 text-[10px] font-semibold uppercase tracking-[0.14em] text-slate-400">
                  <MapPin size={11} className="text-sky-400" />
                  04 · 选择降落地块（{sortedTiles.length} 个可用空地）
                </span>
                <button
                  type="button"
                  onClick={pickRecommended}
                  className="pill-btn inline-flex items-center gap-1 py-0 text-[10px] text-sky-300"
                >
                  <Sparkles size={10} />
                  推荐最佳格点
                </button>
              </div>

              <div className="flex items-center gap-1.5">
                <input
                  value={tileQuery}
                  onChange={(e) => setTileQuery(e.target.value)}
                  placeholder="搜地形 / 编号..."
                  className="w-28 rounded-[2px] border border-slate-700/70 bg-[#181e27] px-2 py-0.5 text-[10.5px] outline-none focus:border-sky-400"
                />
                {([
                  ['best', '综合推荐'],
                  ['capacity', '按槽位'],
                  ['slot', '按编号'],
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

            {/* Tile cards grid */}
            <div className="min-h-0 flex-1 overflow-y-auto pr-1">
              {sortedTiles.length === 0 ? (
                <div className="flex h-32 items-center justify-center text-xs text-slate-500">
                  该行星当前没有匹配的未认领空地，请切换其他行星或清空搜索
                </div>
              ) : (
                <div className="grid grid-cols-1 gap-2 sm:grid-cols-2 xl:grid-cols-3">
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
                        className={`rounded-[2px] border p-2.5 text-left transition-colors ${
                          active
                            ? 'border-sky-400 bg-[#1b2432] shadow-[0_0_0_1px_rgba(56,189,248,0.25)]'
                            : 'border-slate-700/60 bg-[#1b212b] hover:border-slate-500'
                        }`}
                      >
                        <div className="flex items-center justify-between gap-1">
                          <span className="text-[11.5px] font-medium text-slate-100">
                            {t.terrain_name}
                          </span>
                          <span className="mono text-[10px] text-sky-400">#{t.slot_id}</span>
                        </div>
                        <div className="mono mt-1 flex items-center justify-between text-[10px] text-slate-400">
                          <span>
                            {t.lat.toFixed(1)}°, {t.lon.toFixed(1)}°
                          </span>
                          <span className="text-emerald-300">{t.capacity} 槽位</span>
                        </div>
                        <div className="mt-1.5 flex flex-wrap gap-1">
                          {topMods.length === 0 ? (
                            <span className="text-[9.5px] text-slate-500">均衡地形 1.00x</span>
                          ) : (
                            topMods.map(([bid, val]) => (
                              <span
                                key={bid}
                                className={`mono rounded-[2px] border px-1 py-[0.5px] text-[9.5px] ${
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
                  确认方案：<strong className="text-slate-100">{companyName.trim() || '未命名'}</strong>
                  {' · '}
                  <strong className="text-sky-300">{selectedProfession?.name ?? '--'}</strong>
                  {' · '}
                  <strong className="text-emerald-300">
                    {selectedPlanet ? `${selectedPlanet.name}(${selectedPlanet.id})` : '--'}
                  </strong>
                  {' · '}
                  <span className="mono">
                    {selectedTile ? `#${selectedTile.slot_id} ${selectedTile.terrain_name} (${selectedTile.capacity}槽)` : '请选择地块'}
                  </span>
                </span>
              </span>
            )}
          </div>

          <button
            type="submit"
            disabled={submitting || !selectedProfession || !selectedPlanet || slotId === null}
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

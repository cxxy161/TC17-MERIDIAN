import React, { useEffect, useState } from 'react';
import { useGameStore } from '../store/useGameStore';
import type { PaneProps } from '../layout/paneRegistry';
import { moneyToCredits } from '../types/meridian';
import { Planet3DCanvas } from '../components/Planet3DCanvas';

function multTone(v: number): string {
  if (v >= 1.25) return 'text-emerald-300';
  if (v >= 0.9) return 'text-slate-200';
  return 'text-amber-300';
}

export const PlanetPanel: React.FC<PaneProps> = ({ params, setParams, openTemp }) => {
  const state = useGameStore((s) => s.state);
  const catalog = useGameStore((s) => s.catalog);

  const [planetId, setPlanetId] = useState<string>(params.planetId || '');

  useEffect(() => {
    if (params.planetId) setPlanetId(params.planetId);
  }, [params.planetId]);

  const planets = state?.planets ?? [];
  const homePlanetId = state?.player_snapshot?.company.home_planet_id;
  const defaultPlanet =
    planets.find((p) => p.id === homePlanetId) ??
    planets.find((p) => p.population > 0) ??
    planets[0];
  const pSum = (planetId ? planets.find((p) => p.id === planetId) : undefined) ?? defaultPlanet;
  const pView = pSum ? state?.player_snapshot?.planets[pSum.id] : undefined;
  const routes = state?.player_snapshot?.routes ?? {};

  const switchPlanet = (pid: string) => {
    setPlanetId(pid);
    setParams({ planetId: pid });
  };

  if (!pSum) {
    return <div className="p-4 text-slate-500">正在同步行星遥测数据...</div>;
  }

  const landPrice = moneyToCredits(pView?.primary_land_price);
  const gravity = pView?.gravity ?? 1.0;
  const stationId = `ST:${pSum.id}`;
  const hubId =
    state?.systems?.find((s) => s.id === (pSum.system_id || 'S1'))?.hub_station_id ??
    state?.systems?.[0]?.hub_station_id ??
    'ST:HUB';
  const rCost = routes[pSum.id]?.[stationId];
  const hubCost = routes[stationId]?.[hubId];
  const demandCount = Object.keys(pSum.demands ?? {}).length;
  const ticksPerDay = catalog?.meta.ticks_per_day || 24;

  const cityCount = pSum.city_count ?? (pSum.population > 0 ? 1 : 0);
  const cityLevel = pSum.city_level ?? (cityCount > 0 ? 1 : 0);
  const cityCap = pSum.city_capacity ?? 0;
  const capPct = cityCap > 0 ? Math.round((pSum.population / cityCap) * 100) : 0;
  const habPct = Math.round((pSum.habitability ?? 0) * 100);
  const oceanPct = Math.round((pSum.ocean_ratio ?? 0) * 100);
  const mineralMult = pSum.mineral_mult ?? 1.0;
  const solarMult = pSum.solar_mult ?? 1.0;
  const waterMult = pSum.water_mult ?? 1.0;
  const residentCount = (state?.leaderboard ?? []).filter((c) => c.home_planet_id === pSum.id).length;

  return (
    <div className="h-full flex flex-col bg-[#1b212b] text-slate-200 overflow-hidden">
      {/* Planet Selector Header */}
      <div className="px-2.5 py-1 border-b border-sky-500/15 bg-[#232a36] flex items-center justify-between gap-2 shrink-0 flex-wrap">
        <div className="flex items-center gap-1 flex-wrap">
          {planets.map((p) => (
            <button
              key={p.id}
              onClick={() => switchPlanet(p.id)}
              className={`pill-btn py-0 text-[10px] whitespace-nowrap ${p.id === pSum.id ? 'active' : ''}`}
            >
              {p.name} ({p.id})
              {p.id === homePlanetId && (
                <span className="ml-1 text-[9px] text-sky-300">母星</span>
              )}
            </button>
          ))}
        </div>
        <button
          onClick={() => openTemp('land', { planetId: pSum.id })}
          className="cta-blue text-[10px] py-0 px-2 shrink-0"
        >
          地块分布
        </button>
      </div>

      {/* Clean Multi-Row Telemetry Table + 3D Globe */}
      <div className="flex-1 min-h-0 flex flex-col overflow-y-auto">
        <div className="divide-y divide-slate-700/60 border-b border-slate-700/70 text-[10.5px] shrink-0">
          <div className="flex">
            <div className="w-[28%] min-w-[76px] bg-[#244465]/75 px-2 py-[3px] text-slate-100 border-r border-slate-700/60 shrink-0">
              类型 / 轨道
            </div>
            <div className="flex-1 min-w-0 px-2 py-[3px] text-right text-slate-200 truncate">
              {pSum.archetype} · <span className="mono">{pSum.orbit_radius.toFixed(2)} AU</span>
            </div>
          </div>

          <div className="flex">
            <div className="w-[28%] min-w-[76px] bg-[#244465]/75 px-2 py-[3px] text-slate-100 border-r border-slate-700/60 shrink-0">
              宜居 / 城市
            </div>
            <div className="flex-1 min-w-0 px-2 py-[3px] text-right mono truncate">
              <span className={habPct >= 75 ? 'text-emerald-300' : habPct >= 38 ? 'text-sky-300' : 'text-amber-300'}>
                宜居 {habPct}%
              </span>
              <span className="text-slate-500 mx-1.5">·</span>
              <span className="text-slate-200">
                {cityCount > 0 ? `${cityCount} 座城市 (Lv.${cityLevel})` : '无原生城市'}
              </span>
            </div>
          </div>

          <div className="flex">
            <div className="w-[28%] min-w-[76px] bg-[#244465]/75 px-2 py-[3px] text-slate-100 border-r border-slate-700/60 shrink-0">
              资源禀赋
            </div>
            <div className="flex-1 min-w-0 px-2 py-[3px] text-right mono truncate">
              <span className="text-slate-400 mr-1">矿产</span>
              <span className={multTone(mineralMult)}>{mineralMult.toFixed(2)}x</span>
              <span className="text-slate-500 mx-1.5">·</span>
              <span className="text-slate-400 mr-1">光照</span>
              <span className={multTone(solarMult)}>{solarMult.toFixed(2)}x</span>
              <span className="text-slate-500 mx-1.5">·</span>
              <span className="text-slate-400 mr-1">水资源</span>
              <span className={multTone(waterMult)}>{waterMult.toFixed(2)}x</span>
            </div>
          </div>

          <div className="flex">
            <div className="w-[28%] min-w-[76px] bg-[#244465]/75 px-2 py-[3px] text-slate-100 border-r border-slate-700/60 shrink-0">
              地貌 / 重力
            </div>
            <div className="flex-1 min-w-0 px-2 py-[3px] text-right mono text-slate-200 truncate">
              <span className="text-slate-400 mr-1">海洋</span>
              {oceanPct}%
              <span className="text-slate-500 mx-1.5">·</span>
              <span className="text-slate-400 mr-1">重力</span>
              {gravity.toFixed(2)}g
            </div>
          </div>

          <div className="flex">
            <div className="w-[28%] min-w-[76px] bg-[#244465]/75 px-2 py-[3px] text-slate-100 border-r border-slate-700/60 shrink-0">
              人口 / 容量
            </div>
            <div className="flex-1 min-w-0 px-2 py-[3px] text-right mono truncate">
              {cityCount > 0 || pSum.population > 0 ? (
                <>
                  <span className="text-sky-300">{Math.round(pSum.population).toLocaleString()}</span>
                  <span className="text-slate-400">
                    {' '}/ {cityCap > 0 ? Math.round(cityCap).toLocaleString() : '--'} (
                    <span className={capPct >= 82 ? 'text-amber-300' : 'text-slate-300'}>
                      {cityCap > 0 ? `${capPct}%` : '--%'}
                    </span>
                    )
                  </span>
                </>
              ) : (
                <span className="text-slate-400">0 / 0 (0%)</span>
              )}
            </div>
          </div>

          <div className="flex">
            <div className="w-[28%] min-w-[76px] bg-[#244465]/75 px-2 py-[3px] text-slate-100 border-r border-slate-700/60 shrink-0">
              城市繁荣
            </div>
            <div className="flex-1 min-w-0 px-2 py-[3px] text-right mono truncate">
              {cityCount > 0 || pSum.population > 0 ? (
                <span className="text-emerald-300">
                  {pSum.prosperity.toFixed(2)}x ({pSum.wealth_tier}级)
                </span>
              ) : (
                <span className="text-slate-400">-- (无原生城市)</span>
              )}
            </div>
          </div>

          <div className="flex">
            <div className="w-[28%] min-w-[76px] bg-[#244465]/75 px-2 py-[3px] text-slate-100 border-r border-slate-700/60 shrink-0">
              轨道航运
            </div>
            <div className="flex-1 min-w-0 px-2 py-[3px] text-right mono text-slate-200 truncate">
              <span className="text-slate-400 mr-1">登轨</span>
              {rCost ? `${rCost[0]}回合 / ${rCost[1]}油` : '--'}
              <span className="text-slate-500 mx-1.5">·</span>
              <span className="text-slate-400 mr-1">往枢纽</span>
              {hubCost ? `${hubCost[0]}回合 / ${hubCost[1]}油` : '--'}
            </div>
          </div>

          <div className="flex">
            <div className="w-[28%] min-w-[76px] bg-[#244465]/75 px-2 py-[3px] text-slate-100 border-r border-slate-700/60 shrink-0">
              土地 / 入驻
            </div>
            <button
              onClick={() => openTemp('land', { planetId: pSum.id })}
              className="flex-1 min-w-0 px-2 py-[3px] text-right mono text-slate-200 truncate hover:bg-sky-500/10 cursor-pointer"
              title="点击打开全星公开地块窗口"
            >
              余地 <span className="text-sky-300 underline decoration-sky-500/40">{pSum.unclaimed_plots}</span>
              {landPrice > 0 ? ` (一手 ${landPrice.toFixed(1)})` : ''}
              <span className="text-slate-500 mx-1.5">·</span>
              <span className="text-slate-400 mr-1">入驻</span>
              <span className="text-sky-300">{residentCount}</span> 家
            </button>
          </div>

          <div className="flex">
            <div className="w-[28%] min-w-[76px] bg-[#244465]/75 px-2 py-[3px] text-slate-100 border-r border-slate-700/60 shrink-0">
              金融财政
            </div>
            <div className="flex-1 min-w-0 px-2 py-[3px] text-right mono text-slate-200 truncate">
              <span className="text-slate-400 mr-1">金库</span>
              {Math.round(pSum.treasury).toLocaleString()}
              <span className="text-slate-500 mx-1.5">·</span>
              <span className="text-slate-400 mr-1">准备</span>
              {Math.round(pSum.bank_reserves).toLocaleString()}
              <span className="text-slate-500 mx-1.5">·</span>
              <span className="text-amber-300">{(pSum.bank_rate_bps / 100).toFixed(2)}%</span>
            </div>
          </div>

          <div className="flex items-stretch">
            <div className="w-[28%] min-w-[76px] bg-[#244465]/75 px-2 py-1 text-slate-100 border-r border-slate-700/60 flex items-center shrink-0">
              快捷面板
            </div>
            <div className="flex-1 min-w-0 px-2 py-1 flex flex-wrap justify-end gap-x-2.5 gap-y-0.5">
              <button
                onClick={() => openTemp('land', { planetId: pSum.id })}
                className="text-sky-300 hover:text-sky-200 hover:underline"
              >
                地块总览
              </button>
              <button
                onClick={() => openTemp('cargo', { locationId: pSum.id })}
                className="text-sky-300 hover:text-sky-200 hover:underline"
              >
                地面仓库
              </button>
              <button
                onClick={() => openTemp('cargo', { locationId: `ST:${pSum.id}` })}
                className="text-sky-300 hover:text-sky-200 hover:underline"
              >
                轨道站
              </button>
              <button
                onClick={() => openTemp('factory', { planetId: pSum.id })}
                className="text-sky-300 hover:text-sky-200 hover:underline"
              >
                工业产线
              </button>
              <button
                onClick={() => openTemp('demand', { planetId: pSum.id })}
                className="text-emerald-300 hover:text-emerald-200 hover:underline"
              >
                消费需求({demandCount})
              </button>
            </div>
          </div>
        </div>

        {/* 3D Interactive Planet Globe synced to simulation tick/speed/paused */}
        <div className="flex-1 min-h-[200px]">
          <Planet3DCanvas
            planetId={pSum.id}
            planet={pSum}
            tick={state?.tick ?? 0}
            paused={state?.paused ?? false}
            tickMs={state?.tick_ms ?? 1000}
            ticksPerDay={ticksPerDay}
            flights={state?.visible_flights}
            onOpenLand={() => openTemp('land', { planetId: pSum.id })}
          />
        </div>
      </div>
    </div>
  );
};

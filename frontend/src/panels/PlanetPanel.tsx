import React, { useEffect, useState } from 'react';
import { useGameStore } from '../store/useGameStore';
import type { PaneProps } from '../layout/paneRegistry';
import { moneyToCredits, READ_ONLY_OBSERVATION_MODE } from '../types/meridian';
import { PLANET_ROTATION_DAYS, Planet3DCanvas } from '../components/Planet3DCanvas';

const StatBarRow: React.FC<{
  badge: string;
  badgeColor: string;
  label: string;
  value: string;
  fillRatio: number;
  barClass: string;
}> = ({ badge, badgeColor, label, value, fillRatio, barClass }) => (
  <div className="flex items-center justify-end gap-1.5 min-w-0">
    <span
      className={`w-4 h-4 flex items-center justify-center text-[9px] font-bold rounded-[1px] shrink-0 ${badgeColor}`}
    >
      {badge}
    </span>
    <span className="text-[10px] text-slate-300 truncate">{label}</span>
    <div className="w-10 h-2 bg-[#151a22] border border-slate-700 overflow-hidden shrink-0">
      <div
        style={{ width: `${Math.max(4, Math.min(100, fillRatio * 100))}%` }}
        className={`h-full ${barClass}`}
      />
    </div>
    <span className="mono text-[10.5px] text-slate-200 min-w-[54px] text-right shrink-0">
      {value}
    </span>
  </div>
);

export const PlanetPanel: React.FC<PaneProps> = ({ params, setParams, openTemp }) => {
  const state = useGameStore((s) => s.state);
  const catalog = useGameStore((s) => s.catalog);
  const sendIntent = useGameStore((s) => s.sendIntent);

  const [planetId, setPlanetId] = useState<string>(params.planetId || '');

  useEffect(() => {
    if (params.planetId) setPlanetId(params.planetId);
  }, [params.planetId]);

  const planets = state?.planets ?? [];
  const defaultPlanet =
    planets.find((p) => p.id === state?.player_snapshot?.company.home_planet_id) ??
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
  const rCost = routes[pSum.id]?.[`ST:${pSum.id}`];
  const demandCount = Object.keys(pSum.demands ?? {}).length;
  const ticksPerDay = catalog?.meta.ticks_per_day || 24;
  const rotDays = pSum.rotation_days && pSum.rotation_days > 0
    ? pSum.rotation_days
    : (PLANET_ROTATION_DAYS[pSum.id] ?? 1.0);
  const rotHours = Math.round(rotDays * ticksPerDay);

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
              {p.name}
            </button>
          ))}
        </div>
        {!READ_ONLY_OBSERVATION_MODE && (
          <button
            disabled={pSum.unclaimed_plots <= 0}
            onClick={() => void sendIntent({ BuyPlot: { planet_id: pSum.id, listing_id: null } })}
            className="cta-blue text-[10px] py-0 px-2 disabled:opacity-40"
          >
            购置新地块
          </button>
        )}
      </div>

      {/* Tabular Info + Full-Fit 3D Globe */}
      <div className="flex-1 min-h-0 flex flex-col overflow-y-auto">
        <div className="divide-y divide-slate-700/60 border-b border-slate-700/70 text-[10.5px] shrink-0">
          <div className="flex">
            <div className="w-[29%] min-w-[78px] bg-[#244465]/75 px-2 py-[3px] text-slate-100 border-r border-slate-700/60 shrink-0">
              名称 / 编号
            </div>
            <div className="flex-1 min-w-0 px-2 py-[3px] text-right text-slate-200 truncate">
              {pSum.name} <span className="text-sky-300 mono">({pSum.id})</span>
            </div>
          </div>

          <div className="flex">
            <div className="w-[29%] min-w-[78px] bg-[#244465]/75 px-2 py-[3px] text-slate-100 border-r border-slate-700/60 shrink-0">
              类型 / 宜居
            </div>
            <div className="flex-1 min-w-0 px-2 py-[3px] text-right text-slate-200 truncate">
              {pSum.archetype} · <span className="mono">{pSum.orbit_radius.toFixed(2)} AU</span>
              {pSum.habitability !== undefined && (
                <span className="ml-1.5 mono text-emerald-300">
                  宜居 {Math.round(pSum.habitability * 100)}%
                </span>
              )}
            </div>
          </div>

          <div className="flex">
            <div className="w-[29%] min-w-[78px] bg-[#244465]/75 px-2 py-[3px] text-slate-100 border-r border-slate-700/60 shrink-0">
              人口 / 繁荣
            </div>
            <div className="flex-1 min-w-0 px-2 py-[3px] text-right mono truncate">
              <span className="text-sky-300">
                {pSum.population > 0 ? Math.round(pSum.population).toLocaleString() : '0'}
              </span>
              <span className="text-slate-500 mx-1">·</span>
              <span className="text-emerald-300">
                {pSum.prosperity.toFixed(2)}x ({pSum.wealth_tier}级)
              </span>
            </div>
          </div>

          <div className="flex">
            <div className="w-[29%] min-w-[78px] bg-[#244465]/75 px-2 py-[3px] text-slate-100 border-r border-slate-700/60 shrink-0">
              可用地块
            </div>
            <div className="flex-1 min-w-0 px-2 py-[3px] text-right mono text-slate-200 truncate">
              {pSum.unclaimed_plots} 剩余{landPrice > 0 ? ` · 一手 ${landPrice.toFixed(1)}` : ''}
            </div>
          </div>

          <div className="flex items-stretch">
            <div className="w-[29%] min-w-[78px] bg-[#244465]/75 px-2 py-1 text-slate-100 border-r border-slate-700/60 flex items-center shrink-0">
              环境与物理
            </div>
            <div className="flex-1 min-w-0 px-2 py-1 space-y-0.5 mono text-right">
              <div className="flex items-center justify-end gap-3 text-slate-200">
                <span>
                  <span className="text-slate-400 mr-1">重力</span>
                  {gravity.toFixed(2)}g
                </span>
                <span>
                  <span className="text-slate-400 mr-1">自转</span>
                  {rotHours}回合/圈
                </span>
              </div>
              <div className="flex items-center justify-end gap-3 text-slate-200">
                <span>
                  <span className="text-slate-400 mr-1">登轨</span>
                  {rCost ? `${rCost[0]}回合 / ${rCost[1]}油` : '--'}
                </span>
                <span>
                  <span className="text-slate-400 mr-1">废料</span>
                  {pSum.waste_backlog}
                </span>
              </div>
            </div>
          </div>

          <div className="flex items-stretch">
            <div className="w-[29%] min-w-[78px] bg-[#244465]/75 px-2 py-1 text-slate-100 border-r border-slate-700/60 flex items-center shrink-0">
              金融与储备
            </div>
            <div className="flex-1 min-w-0 px-2 py-1 space-y-0.5">
              <StatBarRow
                badge="库"
                badgeColor="bg-sky-800/80 text-sky-200"
                label="星球金库"
                value={Math.round(pSum.treasury).toLocaleString()}
                fillRatio={pSum.treasury / 1000000}
                barClass="bg-sky-400"
              />
              <StatBarRow
                badge="银"
                badgeColor="bg-emerald-800/80 text-emerald-200"
                label="央行准备"
                value={Math.round(pSum.bank_reserves).toLocaleString()}
                fillRatio={pSum.bank_reserves / 100000}
                barClass="bg-emerald-400"
              />
              <StatBarRow
                badge="利"
                badgeColor="bg-amber-800/80 text-amber-200"
                label="年化利率"
                value={`${(pSum.bank_rate_bps / 100).toFixed(2)}%`}
                fillRatio={pSum.bank_rate_bps / 2000}
                barClass="bg-amber-400"
              />
            </div>
          </div>

          <div className="flex items-stretch">
            <div className="w-[29%] min-w-[78px] bg-[#244465]/75 px-2 py-1 text-slate-100 border-r border-slate-700/60 flex items-center shrink-0">
              行星项目
            </div>
            <div className="flex-1 min-w-0 px-2 py-1 flex flex-wrap justify-end gap-x-2.5 gap-y-0.5">
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

          {pView && pView.land_listings.length > 0 && (
            <div className="flex items-stretch">
              <div className="w-[29%] min-w-[78px] bg-[#244465]/75 px-2 py-1 text-slate-100 border-r border-slate-700/60 flex items-center shrink-0">
                二手地块
              </div>
              <div className="flex-1 min-w-0 px-2 py-0.5 space-y-0.5">
                {pView.land_listings.map((l) => (
                  <div key={l.listing_id} className="flex items-center justify-end gap-2 mono">
                    <span className="text-slate-400">#{l.plot_id}</span>
                    <span className="text-emerald-400">{moneyToCredits(l.ask_price).toFixed(1)}</span>
                    {!READ_ONLY_OBSERVATION_MODE && (
                      <button
                        onClick={() =>
                          void sendIntent({ BuyPlot: { planet_id: pSum.id, listing_id: l.listing_id } })
                        }
                        className="cta-green text-[10px] py-0 px-1.5"
                      >
                        收购
                      </button>
                    )}
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>

        {/* 3D Interactive Planet Globe synced to simulation tick/speed/paused */}
        <div className="flex-1 min-h-[200px]">
          <Planet3DCanvas
            planetId={pSum.id}
            planet={pSum}
            tick={state?.tick ?? 0}
            paused={state?.paused ?? false}
            tickMs={state?.tick_ms ?? 2000}
            ticksPerDay={ticksPerDay}
          />
        </div>
      </div>
    </div>
  );
};

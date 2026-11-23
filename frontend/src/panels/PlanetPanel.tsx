import React, { useState } from 'react';
import { useGameStore } from '../store/useGameStore';
import type { PaneProps } from '../layout/paneRegistry';
import { moneyToCredits } from '../types/meridian';

export const PlanetPanel: React.FC<PaneProps> = ({ params, setTitle, openTemp }) => {
  const state = useGameStore((s) => s.state);
  const catalog = useGameStore((s) => s.catalog);
  const sendIntent = useGameStore((s) => s.sendIntent);

  const [planetId, setPlanetId] = useState<string>(params.planetId || 'P2');
  const planets = state?.planets ?? [];
  const pSum = planets.find((p) => p.id === planetId) ?? planets[0];
  const pView = pSum ? state?.player_snapshot?.planets[pSum.id] : undefined;

  const switchPlanet = (pid: string) => {
    setPlanetId(pid);
    const found = planets.find((x) => x.id === pid);
    setTitle(`行星 · ${found?.name ?? pid}`);
  };

  if (!pSum) {
    return <div className="p-4 text-slate-500">正在同步行星遥测数据...</div>;
  }

  const itemNames = new Map((catalog?.items ?? []).map((it) => [it.id, it.name]));
  const landPrice = moneyToCredits(pView?.primary_land_price);
  const demandEntries = Object.entries(pSum.demands ?? {});

  return (
    <div className="h-full flex flex-col bg-[#0b1119] text-slate-200 overflow-hidden">
      <div className="px-3 py-1.5 border-b border-sky-500/10 bg-[#0a111a] flex items-center justify-between gap-2 shrink-0 flex-wrap">
        <div className="flex items-center gap-1.5 flex-wrap">
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
        <div className="flex items-center gap-1 shrink-0">
          <button
            onClick={() => openTemp('factory', { planetId: pSum.id })}
            className="pill-btn py-0 text-[10px] whitespace-nowrap"
          >
            打开产线
          </button>
          <button
            onClick={() => openTemp('cargo', { locationId: pSum.id })}
            className="pill-btn py-0 text-[10px] whitespace-nowrap"
          >
            地面仓库
          </button>
        </div>
      </div>

      <div className="flex-1 overflow-y-auto p-3 space-y-3">
        {/* Header telemetry */}
        <div className="flex items-center gap-3 pb-2.5 border-b border-slate-800/80">
          <svg viewBox="0 0 80 80" className="w-14 h-14 text-sky-400 shrink-0">
            <circle cx="40" cy="40" r="32" fill="rgba(16,185,129,0.06)" stroke="#38bdf8" strokeWidth="1" />
            <ellipse cx="40" cy="40" rx="16" ry="32" fill="none" stroke="#34d399" strokeOpacity="0.5" strokeWidth="0.9" />
            <ellipse cx="40" cy="40" rx="32" ry="12" fill="none" stroke="#38bdf8" strokeOpacity="0.35" strokeWidth="0.9" />
            <line x1="8" y1="40" x2="72" y2="40" stroke="#38bdf8" strokeOpacity="0.3" strokeWidth="0.8" />
            <circle cx="52" cy="28" r="2.5" fill="#10b981" />
          </svg>
          <div className="min-w-0 flex-1">
            <div className="text-[11px] text-slate-400">
              {pSum.archetype} · 重力 {(pView?.gravity ?? 1).toFixed(2)}g
            </div>
            <div className="text-[13px] font-semibold text-slate-100 mt-0.5 mono">
              {pSum.population > 0
                ? `人口 ${Math.round(pSum.population).toLocaleString()} · 财富等级 ${pSum.wealth_tier}`
                : '无人工业资源星'}
            </div>
            <div className="flex items-center justify-between mt-1.5">
              <span className="text-[10px] text-slate-500 mono">
                剩余未开发地块 {pSum.unclaimed_plots} · 一手价 {landPrice > 0 ? landPrice.toFixed(1) : '--'}
              </span>
              <button
                disabled={pSum.unclaimed_plots <= 0}
                onClick={() => void sendIntent({ BuyPlot: { planet_id: pSum.id, listing_id: null } })}
                className="cta-blue text-[10px] py-0.5 px-2 disabled:opacity-40"
              >
                购置新地块
              </button>
            </div>
          </div>
        </div>

        {/* KPI Grid */}
        <div className="grid grid-cols-2 gap-1.5">
          <div className="metric-card">
            <div className="text-[10px] text-slate-500">繁荣指数</div>
            <div className="mono text-[13px] font-semibold text-emerald-400 mt-0.5">
              {pSum.prosperity.toFixed(2)}x
            </div>
          </div>
          <div className="metric-card">
            <div className="text-[10px] text-slate-500">星球金库</div>
            <div className="mono text-[13px] font-semibold text-sky-300 mt-0.5">
              {pSum.treasury.toLocaleString(undefined, { maximumFractionDigits: 1 })}
            </div>
          </div>
          <div className="metric-card">
            <div className="text-[10px] text-slate-500">央行准备金 / 年化</div>
            <div className="mono text-[12px] font-semibold text-slate-200 mt-0.5">
              {Math.round(pSum.bank_reserves).toLocaleString()} · {(pSum.bank_rate_bps / 100).toFixed(1)}%
            </div>
          </div>
          <div className="metric-card">
            <div className="text-[10px] text-slate-500">城市废料积压</div>
            <div className="mono text-[13px] font-semibold text-cyan-300 mt-0.5">
              {pSum.waste_backlog} 单位
            </div>
          </div>
        </div>

        {/* Secondary Land Listings */}
        {pView && pView.land_listings.length > 0 && (
          <div className="space-y-1.5 pt-1 border-t border-slate-800/80">
            <div className="text-[10px] text-slate-400">二手转让地块</div>
            {pView.land_listings.map((l) => (
              <div key={l.listing_id} className="metric-card flex items-center justify-between text-[11px]">
                <span className="mono">地块 #{l.plot_id}</span>
                <div className="flex items-center gap-2">
                  <span className="mono text-emerald-400">{moneyToCredits(l.ask_price).toFixed(1)}</span>
                  <button
                    onClick={() =>
                      void sendIntent({ BuyPlot: { planet_id: pSum.id, listing_id: l.listing_id } })
                    }
                    className="cta-green text-[10px] py-0 px-2"
                  >
                    收购
                  </button>
                </div>
              </div>
            ))}
          </div>
        )}

        {/* City Demands */}
        <div className="space-y-1.5 pt-1 border-t border-slate-800/80">
          <div className="flex items-center justify-between text-[10px] text-slate-400">
            <span>本回合城市消费挂单需求</span>
            <span>{demandEntries.length} 项</span>
          </div>
          {demandEntries.length === 0 ? (
            <div className="text-[11px] text-slate-500 py-2">本星球暂无城市居民采购需求</div>
          ) : (
            <div className="grid grid-cols-2 gap-1.5">
              {demandEntries.map(([itemId, qty]) => (
                <div
                  key={itemId}
                  onClick={() =>
                    openTemp('chart', { stationId: `ST:${pSum.id}`, itemId })
                  }
                  className="metric-card flex items-center justify-between cursor-pointer hover:border-sky-400/50"
                >
                  <span className="text-slate-300">{itemNames.get(itemId) ?? itemId}</span>
                  <span className="mono text-sky-400 font-semibold">{qty}</span>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
};

import React, { useEffect, useState } from 'react';
import { useGameStore } from '../store/useGameStore';
import type { PaneProps } from '../layout/paneRegistry';

export const DemandPanel: React.FC<PaneProps> = ({ params, setTitle, openTemp }) => {
  const state = useGameStore((s) => s.state);
  const catalog = useGameStore((s) => s.catalog);

  const [planetId, setPlanetId] = useState<string>(params.planetId || 'P2');

  useEffect(() => {
    if (params.planetId) setPlanetId(params.planetId);
  }, [params.planetId]);

  const planets = state?.planets ?? [];
  const pSum = planets.find((p) => p.id === planetId) ?? planets[0];

  const switchPlanet = (pid: string) => {
    setPlanetId(pid);
    const found = planets.find((x) => x.id === pid);
    setTitle(`消费需求 · ${found?.name ?? pid}`);
  };

  if (!pSum) {
    return <div className="p-4 text-slate-500">正在同步城市消费需求...</div>;
  }

  const itemNames = new Map((catalog?.items ?? []).map((it) => [it.id, it.name]));
  const stationId = `ST:${pSum.id}`;
  const tickerByItem = new Map(
    (state?.market_tickers ?? [])
      .filter((t) => t.station_id === stationId)
      .map((t) => [t.item_id, t]),
  );
  const myStationStore = state?.player_snapshot?.company.station_stores[stationId] ?? {};

  const demandEntries = Object.entries(pSum.demands ?? {}).sort((a, b) => b[1] - a[1]);
  const totalQty = demandEntries.reduce((acc, [, q]) => acc + q, 0);

  return (
    <div className="h-full flex flex-col bg-[#202732] text-slate-200 overflow-hidden">
      {/* Planet Selector Header */}
      <div className="px-2.5 py-1.5 border-b border-sky-500/15 bg-[#232a36] flex items-center justify-between gap-2 shrink-0 flex-wrap">
        <div className="flex items-center gap-1 flex-wrap">
          {planets.map((p) => {
            const cnt = Object.keys(p.demands ?? {}).length;
            return (
              <button
                key={p.id}
                onClick={() => switchPlanet(p.id)}
                className={`pill-btn py-0 text-[10px] whitespace-nowrap ${p.id === pSum.id ? 'active' : ''}`}
              >
                {p.name} ({cnt})
              </button>
            );
          })}
        </div>
        <span className="text-[10px] text-slate-400 mono">
          回合 {state?.tick ?? 0} · {stationId}
        </span>
      </div>

      {/* City Summary Bar */}
      <div className="px-3 py-1.5 bg-[#1b212b] border-b border-slate-800/80 flex items-center justify-between text-[11px] shrink-0">
        <span className="text-slate-400">
          居民 <strong className="text-sky-300 mono">{Math.round(pSum.population).toLocaleString()}</strong> · 繁荣{' '}
          <strong className="text-emerald-400 mono">{pSum.prosperity.toFixed(2)}x</strong>
        </span>
        <span className="text-slate-400">
          本回合需求合计 <strong className="text-sky-300 mono">{totalQty}</strong> 单位
        </span>
      </div>

      {/* Demands Table */}
      <div className="flex-1 overflow-y-auto">
        {demandEntries.length === 0 ? (
          <div className="p-4 text-[11px] text-slate-500 text-center">
            {pSum.name} 当前暂无城市居民消费挂单需求
          </div>
        ) : (
          <table className="w-full text-[11px] border-collapse">
            <thead className="sticky top-0 bg-[#232a36] text-slate-400 text-[10px] border-b border-slate-700/70">
              <tr>
                <th className="text-left font-medium px-3 py-1.5">消费物资</th>
                <th className="text-right font-medium px-2 py-1.5">本回合需求</th>
                <th className="text-right font-medium px-2 py-1.5">本地买一 / 最新</th>
                <th className="text-right font-medium px-2 py-1.5">我的站内仓</th>
                <th className="text-right font-medium px-3 py-1.5">市场</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-800/70">
              {demandEntries.map(([itemId, qty]) => {
                const ticker = tickerByItem.get(itemId);
                const myStock = myStationStore[itemId] ?? 0;
                return (
                  <tr key={itemId} className="hover:bg-sky-500/10">
                    <td className="px-3 py-1.5 text-slate-200 font-medium">
                      {itemNames.get(itemId) ?? itemId}
                    </td>
                    <td className="px-2 py-1.5 text-right mono text-sky-300 font-semibold">
                      {qty}
                    </td>
                    <td className="px-2 py-1.5 text-right mono text-slate-300">
                      <span className="text-emerald-400">
                        {ticker?.best_bid !== null && ticker?.best_bid !== undefined
                          ? ticker.best_bid.toFixed(2)
                          : '--'}
                      </span>
                      <span className="text-slate-600 mx-1">/</span>
                      <span>{ticker ? ticker.last_price.toFixed(2) : '--'}</span>
                    </td>
                    <td className="px-2 py-1.5 text-right mono text-slate-300">
                      {myStock > 0 ? <span className="text-emerald-300">{myStock}</span> : '0'}
                    </td>
                    <td className="px-3 py-1.5 text-right space-x-1 whitespace-nowrap">
                      <button
                        onClick={() => openTemp('orderbook', { stationId, itemId })}
                        className="pill-btn py-0 px-1.5 text-[10px]"
                      >
                        盘口
                      </button>
                      <button
                        onClick={() => openTemp('chart', { stationId, itemId })}
                        className="pill-btn py-0 px-1.5 text-[10px]"
                      >
                        K线
                      </button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
};

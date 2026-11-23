import React, { useState } from 'react';
import type { IDockviewPanelProps } from 'dockview-react';
import { useGameStore } from '../store/useGameStore';
import { openPane, type PaneParams } from '../layout/paneRegistry';
import { STATION_NAMES } from '../types/meridian';

export const TickerPanel: React.FC<IDockviewPanelProps<PaneParams>> = ({ params, api, containerApi }) => {
  const state = useGameStore((s) => s.state);
  const catalog = useGameStore((s) => s.catalog);
  const [stationId, setStationId] = useState<string>(params.stationId || 'ST:HUB');

  const stations = Object.keys(STATION_NAMES);
  const itemNames = new Map((catalog?.items ?? []).map((it) => [it.id, it.name]));
  const storeAtStation = state?.player_snapshot?.company.station_stores[stationId] ?? {};
  const rows = (state?.market_tickers ?? []).filter((r) => r.station_id === stationId);

  const switchStation = (sid: string) => {
    setStationId(sid);
    api.setTitle(`行情 · ${STATION_NAMES[sid] ?? sid}`);
  };

  return (
    <div className="h-full flex flex-col bg-[#0b1119] text-slate-200 overflow-hidden">
      <div className="px-3 py-1.5 border-b border-sky-500/10 bg-[#0a111a] flex items-center justify-between gap-2 shrink-0 flex-wrap">
        <div className="flex items-center gap-1 flex-wrap">
          {stations.map((sid) => (
            <button
              key={sid}
              onClick={() => switchStation(sid)}
              className={`pill-btn py-0 text-[10px] ${stationId === sid ? 'active' : ''}`}
            >
              {STATION_NAMES[sid]}
            </button>
          ))}
        </div>
        <span className="text-[10px] text-slate-500">点击打开 K线图 或 盘口</span>
      </div>

      <div className="flex-1 overflow-y-auto">
        <table className="w-full text-[11px] mono text-left">
          <thead className="bg-[#0e1622] text-slate-500 text-[10px] sticky top-0">
            <tr>
              <th className="px-3 py-1.5 font-normal">物资名称</th>
              <th className="px-2 py-1.5 text-right font-normal">买一</th>
              <th className="px-2 py-1.5 text-right font-normal">卖一</th>
              <th className="px-2 py-1.5 text-right font-normal">最新价</th>
              <th className="px-2 py-1.5 text-right font-normal">50回合量</th>
              <th className="px-2 py-1.5 text-right font-normal">站内持仓</th>
              <th className="px-3 py-1.5 text-right font-normal">窗口</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-800/60">
            {rows.map((r) => (
              <tr key={r.item_id} className="hover:bg-sky-500/10">
                <td className="px-3 py-1.5 text-slate-100 font-sans">
                  {itemNames.get(r.item_id) ?? r.item_id}
                </td>
                <td className="px-2 py-1.5 text-right text-emerald-400">
                  {r.best_bid !== null ? r.best_bid.toFixed(2) : '--'}
                </td>
                <td className="px-2 py-1.5 text-right text-rose-400">
                  {r.best_ask !== null ? r.best_ask.toFixed(2) : '--'}
                </td>
                <td className="px-2 py-1.5 text-right text-sky-400">{r.last_price.toFixed(2)}</td>
                <td className="px-2 py-1.5 text-right text-slate-300">{r.vol_50t.toLocaleString()}</td>
                <td className="px-2 py-1.5 text-right text-slate-400">{storeAtStation[r.item_id] ?? 0}</td>
                <td className="px-3 py-1.5 text-right space-x-1">
                  <button
                    onClick={() => openPane(containerApi, 'chart', { stationId, itemId: r.item_id })}
                    className="pill-btn py-0 text-[10px]"
                  >
                    K线
                  </button>
                  <button
                    onClick={() => openPane(containerApi, 'orderbook', { stationId, itemId: r.item_id })}
                    className="pill-btn py-0 text-[10px] text-emerald-300"
                  >
                    盘口
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
};

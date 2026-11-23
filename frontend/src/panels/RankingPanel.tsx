import React from 'react';
import { useGameStore } from '../store/useGameStore';
import type { PaneProps } from '../layout/paneRegistry';

export const RankingPanel: React.FC<PaneProps> = () => {
  const state = useGameStore((s) => s.state);
  const catalog = useGameStore((s) => s.catalog);
  const rows = state?.leaderboard ?? [];
  const profNames = new Map((catalog?.professions ?? []).map((p) => [p.id, p.name]));

  return (
    <div className="h-full flex flex-col bg-[#0b1119] text-slate-200 overflow-hidden">
      <div className="px-3 py-1.5 border-b border-sky-500/10 bg-[#0a111a] flex items-center justify-between text-[11px] shrink-0">
        <span className="font-medium">势力净资产排行（活跃 {rows.length} 家）</span>
        <span className="mono text-[10px] text-emerald-400">
          全星系发行 {state ? Math.round(state.total_minted).toLocaleString() : '--'} · 守恒误差 Δ=
          {state?.conservation_error ?? 0}
        </span>
      </div>

      <div className="flex-1 overflow-y-auto">
        <table className="w-full text-[11px] mono text-left">
          <thead className="bg-[#0e1622] text-slate-500 text-[10px] sticky top-0">
            <tr>
              <th className="px-3 py-1.5 font-normal">#</th>
              <th className="px-2 py-1.5 font-normal">公司名称</th>
              <th className="px-2 py-1.5 font-normal">职业</th>
              <th className="px-2 py-1.5 text-right font-normal">净流动资产</th>
              <th className="px-2 py-1.5 text-right font-normal">现金</th>
              <th className="px-2 py-1.5 text-right font-normal">负债</th>
              <th className="px-3 py-1.5 text-right font-normal">地/船</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-800/60">
            {rows.map((r, idx) => (
              <tr key={r.id} className={r.is_player ? 'bg-emerald-500/10' : 'hover:bg-sky-500/5'}>
                <td className="px-3 py-1.5 text-slate-500">{idx + 1}</td>
                <td className="px-2 py-1.5 font-sans">
                  <span className={r.is_player ? 'text-emerald-300 font-semibold' : 'text-slate-200'}>
                    {r.name}
                  </span>
                  {r.is_player && (
                    <span className="ml-1.5 px-1 py-0 text-[9px] bg-emerald-500/20 text-emerald-300 border border-emerald-500/30">
                      玩家
                    </span>
                  )}
                </td>
                <td className="px-2 py-1.5 font-sans text-slate-400">
                  {profNames.get(r.profession) ?? r.profession}
                </td>
                <td className="px-2 py-1.5 text-right text-sky-300 font-semibold">
                  {r.net_liquid.toLocaleString(undefined, { maximumFractionDigits: 1 })}
                </td>
                <td className="px-2 py-1.5 text-right text-slate-300">
                  {r.cash.toLocaleString(undefined, { maximumFractionDigits: 0 })}
                </td>
                <td className="px-2 py-1.5 text-right text-rose-400">
                  {r.debt > 0 ? r.debt.toLocaleString(undefined, { maximumFractionDigits: 0 }) : '0'}
                </td>
                <td className="px-3 py-1.5 text-right text-slate-400">
                  {r.plots_count}/{r.ships_count}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
};

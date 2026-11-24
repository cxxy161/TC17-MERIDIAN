import React, { useMemo, useState } from 'react';
import { Search } from 'lucide-react';
import { useGameStore } from '../store/useGameStore';
import { useWorldIndex } from '../entities/hooks';
import type { PaneProps } from '../layout/paneRegistry';

export const RankingPanel: React.FC<PaneProps> = ({ openTemp }) => {
  const state = useGameStore((s) => s.state);
  const world = useWorldIndex();
  const rows = state?.leaderboard ?? [];
  const [query, setQuery] = useState('');

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return rows
      .map((r, idx) => ({ row: r, rank: idx + 1 }))
      .filter(({ row }) => {
        if (!q) return true;
        return (
          row.name.toLowerCase().includes(q) ||
          row.id.toLowerCase().includes(q) ||
          world.planetName(row.home_planet_id).toLowerCase().includes(q)
        );
      });
  }, [rows, query, world]);

  return (
    <div className="h-full flex flex-col bg-[#202732] text-slate-200 overflow-hidden">
      <div className="px-3 py-1.5 border-b border-sky-500/10 bg-[#232a36] flex items-center justify-between gap-2 text-[11px] shrink-0">
        <span className="font-medium shrink-0">星系势力排行（活跃 {rows.length} 家）</span>
        <div className="flex items-center gap-1.5 px-2 py-0.5 bg-[#191f28] border border-slate-700/80 rounded-[2px] w-48 max-w-full">
          <Search className="w-3 h-3 text-slate-500 shrink-0" />
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="搜公司 / ID / 母星…"
            className="w-full bg-transparent outline-none text-[10.5px] text-slate-200 placeholder:text-slate-600"
          />
        </div>
        <span className="text-[10px] text-slate-400 shrink-0">点击查看公司详情</span>
      </div>

      <div className="flex-1 overflow-y-auto">
        <table className="w-full text-[11px] mono text-left">
          <thead className="bg-[#252e3b] text-slate-500 text-[10px] sticky top-0">
            <tr>
              <th className="px-3 py-1.5 font-normal">#</th>
              <th className="px-2 py-1.5 font-normal">公司名称</th>
              <th className="px-2 py-1.5 font-normal">母星</th>
              <th className="px-2 py-1.5 font-normal text-right">地块</th>
              <th className="px-2 py-1.5 font-normal text-right">建筑</th>
              <th className="px-2 py-1.5 font-normal text-right">飞船</th>
              <th className="px-2 py-1.5 font-normal text-right">挂单</th>
              <th className="px-3 py-1.5 text-right font-normal">公开净流动资产</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-800/60">
            {filtered.map(({ row: r, rank }) => (
              <tr
                key={r.id}
                onClick={() => openTemp('company', { companyId: r.id })}
                title="点击打开公司详情"
                className={`cursor-pointer ${r.is_player ? 'bg-emerald-500/10 hover:bg-emerald-500/15' : 'hover:bg-sky-500/10'}`}
              >
                <td className="px-3 py-1.5 text-slate-500">{rank}</td>
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
                  {world.planetName(r.home_planet_id)}
                </td>
                <td className="px-2 py-1.5 text-right text-slate-300">{r.plots_count ?? 0}</td>
                <td className="px-2 py-1.5 text-right text-slate-300">{r.buildings_count ?? 0}</td>
                <td className="px-2 py-1.5 text-right text-slate-300">{r.ships_count ?? 0}</td>
                <td className="px-2 py-1.5 text-right text-amber-300/90">{r.open_orders_count ?? 0}</td>
                <td className="px-3 py-1.5 text-right text-sky-300 font-semibold">
                  {r.net_liquid.toLocaleString(undefined, { maximumFractionDigits: 1 })}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
};

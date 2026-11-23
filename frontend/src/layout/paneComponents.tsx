import React, { useMemo, useState } from 'react';
import { Search } from 'lucide-react';
import {
  PANE_CATALOG,
  type PaneKind,
  type PaneParams,
  type PaneProps,
  type TileContent,
} from './paneRegistry';
import { useGameStore } from '../store/useGameStore';

import { OrbitPanel } from '../panels/OrbitPanel';
import { PlanetPanel } from '../panels/PlanetPanel';
import { FactoryPanel } from '../panels/FactoryPanel';
import { CargoPanel } from '../panels/CargoPanel';
import { FleetPanel } from '../panels/FleetPanel';
import { TickerPanel } from '../panels/TickerPanel';
import { ChartPanel } from '../panels/ChartPanel';
import { OrderBookPanel } from '../panels/OrderBookPanel';
import { TreasuryPanel } from '../panels/TreasuryPanel';
import { RankingPanel } from '../panels/RankingPanel';
import { ScriptIdePanel } from '../panels/ScriptIdePanel';
import { ConsolePanel } from '../panels/ConsolePanel';

const PANEL_COMPONENTS: Record<PaneKind, React.FC<PaneProps>> = {
  orbit: OrbitPanel,
  planet: PlanetPanel,
  factory: FactoryPanel,
  cargo: CargoPanel,
  fleet: FleetPanel,
  ticker: TickerPanel,
  chart: ChartPanel,
  orderbook: OrderBookPanel,
  treasury: TreasuryPanel,
  ranking: RankingPanel,
  script: ScriptIdePanel,
  console: ConsolePanel,
};

export const PaneRenderer: React.FC<{
  kind: PaneKind;
  params: PaneParams;
  setTitle: (title: string) => void;
  openTemp: (kind: PaneKind, params?: PaneParams) => void;
}> = ({ kind, params, setTitle, openTemp }) => {
  const Comp = PANEL_COMPONENTS[kind];
  if (!Comp) {
    return <div className="p-3 text-rose-400">未知面板类型：{kind}</div>;
  }
  return <Comp params={params} setTitle={setTitle} openTemp={openTemp} />;
};

interface EmptyTilePaneProps {
  onSelect: (content: TileContent) => void;
}

export const EmptyTilePane: React.FC<EmptyTilePaneProps> = ({ onSelect }) => {
  const [query, setQuery] = useState('');
  const state = useGameStore((s) => s.state);
  const catalog = useGameStore((s) => s.catalog);

  const options = useMemo(() => {
    const list: Array<{ id: string; label: string; sub: string; content: TileContent }> = PANE_CATALOG.map(
      (p) => ({
        id: `base-${p.kind}`,
        label: p.label,
        sub: p.description,
        content: { kind: p.kind, params: p.defaultParams ?? {} },
      }),
    );
    for (const pl of state?.planets ?? []) {
      list.push({
        id: `pl-${pl.id}`,
        label: `行星 · ${pl.name}`,
        sub: '行星遥测与需求',
        content: { kind: 'planet', params: { planetId: pl.id } },
      });
      list.push({
        id: `fac-${pl.id}`,
        label: `产线 · ${pl.name}`,
        sub: '设施与配方切换',
        content: { kind: 'factory', params: { planetId: pl.id } },
      });
      list.push({
        id: `cg-${pl.id}`,
        label: `仓库 · ${pl.name}地表`,
        sub: '地面仓库库存',
        content: { kind: 'cargo', params: { locationId: pl.id } },
      });
    }
    list.push({
      id: 'cg-hub',
      label: '仓库 · 中心贸易枢纽站',
      sub: '中心枢纽站仓库',
      content: { kind: 'cargo', params: { locationId: 'ST:HUB' } },
    });
    for (const it of catalog?.items ?? []) {
      list.push({
        id: `ch-${it.id}`,
        label: `K线 · ${it.name} @ 枢纽`,
        sub: '价格蜡烛图与均线',
        content: { kind: 'chart', params: { stationId: 'ST:HUB', itemId: it.id } },
      });
      list.push({
        id: `ob-${it.id}`,
        label: `盘口 · ${it.name} @ 枢纽`,
        sub: '买卖深度与下单',
        content: { kind: 'orderbook', params: { stationId: 'ST:HUB', itemId: it.id } },
      });
    }
    return list;
  }, [state, catalog]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return options.slice(0, 12);
    return options
      .filter((o) => o.label.toLowerCase().includes(q) || o.sub.toLowerCase().includes(q))
      .slice(0, 16);
  }, [options, query]);

  return (
    <div className="h-full flex flex-col bg-[#1b212b] p-3 gap-2.5 overflow-hidden">
      <div className="text-[11px] text-slate-400">
        空窗口 · 可在下方搜索选择要显示的内容，或将任意<strong className="text-sky-300 font-normal">临时悬浮窗</strong>直接拖入此格覆盖
      </div>

      <div className="flex items-center gap-2 px-2.5 py-1.5 bg-[#212834] border border-sky-500/30 rounded-sm">
        <Search className="w-3.5 h-3.5 text-sky-400 shrink-0" />
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="搜索功能窗口、星球、K线品种..."
          className="flex-1 bg-transparent outline-none text-[12px] text-slate-100 placeholder:text-slate-600"
        />
        {query && (
          <button onClick={() => setQuery('')} className="text-[10px] text-slate-500 hover:text-white">
            清空
          </button>
        )}
      </div>

      <div className="flex-1 overflow-y-auto space-y-1 pr-1">
        {filtered.map((item) => (
          <button
            key={item.id}
            onClick={() => onSelect(item.content)}
            className="w-full text-left px-2.5 py-1.5 rounded-sm bg-[#242c38] border border-slate-800/80 hover:border-sky-400/55 hover:bg-sky-500/10 flex items-center justify-between gap-2"
          >
            <span className="text-sky-300 font-medium text-[11px] truncate">{item.label}</span>
            <span className="text-slate-500 text-[10px] shrink-0">{item.sub}</span>
          </button>
        ))}
      </div>
    </div>
  );
};

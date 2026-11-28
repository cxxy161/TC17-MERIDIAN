import React, { useMemo, useState } from 'react';
import { ArrowDown, ArrowUp, PackageSearch, Search } from 'lucide-react';
import { isCoarsePointer } from '../utils/useDragPointer';
import type { PaneProps } from '../layout/paneRegistry';
import { useCatalogIndex, useWorldIndex } from '../entities/hooks';
import { VirtualList } from '../components/VirtualList';

type SortKey = 'name' | 'held' | 'bid' | 'ask' | 'last' | 'vol' | 'orders';

interface Row {
  id: string;
  name: string;
  category: string;
  role: string;
  held: number;
  inTransit: number;
  bid: number | null;
  ask: number | null;
  last: number | null;
  vol: number;
  orders: number;
  producedBy: number;
  usedBy: number;
  instant: boolean;
  quoted: number;
}

const ROW_HEIGHT = 26;

/**
 * Item-centric overview: every item in the pack in one searchable, sortable, filterable table with
 * my holdings and my open orders attached. This is the "what do I have / what is it worth" screen
 * that previously did not exist at all (you had to open one location at a time).
 */
export const ItemListPanel: React.FC<PaneProps> = ({ setParams, openTemp }) => {
  const catalog = useCatalogIndex();
  const world = useWorldIndex();

  const [query, setQuery] = useState('');
  const [category, setCategory] = useState<string>('all');
  const [role, setRole] = useState<string>('all');
  const [onlyHeld, setOnlyHeld] = useState(false);
  const [onlyQuoted, setOnlyQuoted] = useState(false);
  const [onlyOrders, setOnlyOrders] = useState(false);
  const [sortKey, setSortKey] = useState<SortKey>('name');
  const [sortDir, setSortDir] = useState<1 | -1>(1);

  const rows = useMemo<Row[]>(() => {
    const hub = world.stations.find((s) => s.isHub)?.id ?? null;
    return catalog.items.map((item) => {
      const quotes = world.quotesByItem.get(item.id) ?? [];
      const hubRow = hub ? quotes.find((q) => q.stationId === hub)?.row : undefined;
      const best = hubRow ?? quotes.find((q) => q.row.last_price > 0)?.row;
      const holding = world.holding(item.id);
      return {
        id: item.id,
        name: item.name,
        category: catalog.categoryName(item.demand_category) ?? '—',
        role: catalog.roleLabel(item.role),
        held: holding?.total ?? 0,
        inTransit: holding?.inTransit ?? 0,
        bid: best?.best_bid ?? null,
        ask: best?.best_ask ?? null,
        last: best ? best.last_price : null,
        vol: best?.vol_50t ?? 0,
        orders: world.openOrdersByItem.get(item.id)?.length ?? 0,
        producedBy: catalog.recipesProducing.get(item.id)?.length ?? 0,
        usedBy: catalog.recipesConsuming.get(item.id)?.length ?? 0,
        instant: catalog.isInstant(item.id),
        quoted: quotes.length,
      };
    });
  }, [catalog, world]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    const out = rows.filter((r) => {
      if (category !== 'all') {
        const def = catalog.item(r.id);
        if ((catalog.categoryName(def?.demand_category ?? null) ?? '') !== category) return false;
      }
      if (role !== 'all' && r.role !== role) return false;
      if (onlyHeld && r.held <= 0) return false;
      if (onlyQuoted && r.quoted === 0) return false;
      if (onlyOrders && r.orders === 0) return false;
      if (!q) return true;
      return (
        r.name.toLowerCase().includes(q) ||
        r.id.toLowerCase().includes(q) ||
        r.category.toLowerCase().includes(q) ||
        r.role.toLowerCase().includes(q) ||
        (catalog.item(r.id)?.tags ?? []).some((t) => t.toLowerCase().includes(q))
      );
    });
    const dir = sortDir;
    out.sort((a, b) => {
      switch (sortKey) {
        case 'held':
          return (a.held - b.held) * dir;
        case 'bid':
          return ((a.bid ?? -1) - (b.bid ?? -1)) * dir;
        case 'ask':
          return ((a.ask ?? -1) - (b.ask ?? -1)) * dir;
        case 'last':
          return ((a.last ?? -1) - (b.last ?? -1)) * dir;
        case 'vol':
          return (a.vol - b.vol) * dir;
        case 'orders':
          return (a.orders - b.orders) * dir;
        default:
          return a.name.localeCompare(b.name, 'zh-Hans-CN') * dir;
      }
    });
    return out;
  }, [rows, query, category, role, onlyHeld, onlyQuoted, onlyOrders, sortKey, sortDir, catalog]);

  const toggleSort = (key: SortKey) => {
    if (key === sortKey) setSortDir((d) => (d === 1 ? -1 : 1));
    else {
      setSortKey(key);
      setSortDir(key === 'name' ? 1 : -1);
    }
  };

  const coarse = isCoarsePointer();

  const SortHead: React.FC<{ k: SortKey; label: string; className?: string }> = ({ k, label, className }) => (
    <button
      onClick={() => toggleSort(k)}
      className={`flex items-center justify-end gap-0.5 hover:text-sky-300 ${
        sortKey === k ? 'text-sky-300' : ''
      } ${className ?? ''}`}
      title="点击按此列排序"
    >
      {label}
      {sortKey === k ? (
        sortDir === 1 ? <ArrowUp className="w-2.5 h-2.5" /> : <ArrowDown className="w-2.5 h-2.5" />
      ) : (
        <span className="opacity-35 text-[8px]">↕</span>
      )}
    </button>
  );

  const totalHeldValue = filtered.reduce((acc, r) => acc + (r.last ?? 0) * r.held, 0);

  return (
    <div className="h-full flex flex-col bg-[#202732] text-slate-200 overflow-hidden">
      <div className="px-2 py-1.5 border-b border-sky-500/10 bg-[#232a36] flex items-center gap-2 shrink-0 flex-wrap">
        <div className="flex items-center gap-1.5 px-2 py-0.5 bg-[#1b212b] border border-slate-700 rounded-sm flex-1 min-w-[140px]">
          <Search className="w-3 h-3 text-sky-400 shrink-0" />
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="搜索物品名 / id / 标签…"
            className="flex-1 min-w-0 bg-transparent outline-none text-[11px] text-slate-100 placeholder:text-slate-600"
          />
          <span className="text-[9px] mono text-slate-500 shrink-0">{filtered.length}</span>
        </div>
        <span className="text-[10px] text-slate-500 mono shrink-0">
          持有估值 {totalHeldValue.toLocaleString(undefined, { maximumFractionDigits: 1 })}
        </span>
      </div>

      <div className="px-2 py-1 border-b border-slate-800/80 flex items-center gap-1 flex-wrap shrink-0">
        <button
          onClick={() => setCategory('all')}
          className={`text-[10px] px-1.5 py-[1px] border rounded-[2px] ${
            category === 'all' ? 'bg-sky-500/25 border-sky-400/60 text-sky-100' : 'border-slate-700/70 text-slate-400'
          }`}
        >
          全部类别
        </button>
        {catalog.facets.category.map((c) => (
          <button
            key={c.id}
            onClick={() => setCategory(category === c.label ? 'all' : c.label)}
            className={`text-[10px] px-1.5 py-[1px] border rounded-[2px] ${
              category === c.label
                ? 'bg-sky-500/25 border-sky-400/60 text-sky-100'
                : 'border-slate-700/70 text-slate-400 hover:text-slate-200'
            }`}
          >
            {c.label}
            <span className="text-slate-500 ml-1">{c.count}</span>
          </button>
        ))}
        <span className="w-px h-3 bg-slate-700 mx-0.5" />
        {catalog.facets.role.map((r) => (
          <button
            key={r.id}
            onClick={() => setRole(role === r.label ? 'all' : r.label)}
            className={`text-[10px] px-1.5 py-[1px] border rounded-[2px] ${
              role === r.label
                ? 'bg-emerald-500/20 border-emerald-400/50 text-emerald-100'
                : 'border-slate-700/70 text-slate-400 hover:text-slate-200'
            }`}
          >
            {r.label}
          </button>
        ))}
        <span className="w-px h-3 bg-slate-700 mx-0.5" />
        {([
          ['我有库存', onlyHeld, setOnlyHeld],
          ['有行情', onlyQuoted, setOnlyQuoted],
          ['有挂单', onlyOrders, setOnlyOrders],
        ] as Array<[string, boolean, (v: boolean) => void]>).map(([label, on, set]) => (
          <button
            key={label}
            onClick={() => set(!on)}
            className={`text-[10px] px-1.5 py-[1px] border rounded-[2px] ${
              on ? 'bg-amber-500/20 border-amber-400/50 text-amber-100' : 'border-slate-700/70 text-slate-400'
            }`}
          >
            {label}
          </button>
        ))}
      </div>

      <div className="flex-1 min-h-0 flex flex-col overflow-x-auto">
        <div className="min-w-[400px] flex-1 min-h-0 flex flex-col">
          <div className="px-2 py-1 bg-[#252e3b] border-b border-slate-800/80 grid grid-cols-[minmax(96px,1fr)_52px_50px_50px_50px_44px_36px] gap-1 text-[10px] text-slate-400 shrink-0">
            <SortHead k="name" label="物品" className="justify-start" />
            <SortHead k="held" label="持有" />
            <SortHead k="bid" label="买一" />
            <SortHead k="ask" label="卖一" />
            <SortHead k="last" label="最新" />
            <SortHead k="vol" label="50量" />
            <SortHead k="orders" label="挂单" />
          </div>

          <VirtualList
            className="flex-1 min-h-0 overflow-y-auto"
            count={filtered.length}
            rowHeight={coarse ? 40 : ROW_HEIGHT}
            emptyState={
              <div className="px-3 py-6 text-center text-[11px] text-slate-500 flex flex-col items-center gap-2">
                <PackageSearch className="w-5 h-5 text-slate-600" />
                没有匹配的物品。清空搜索或关闭筛选试试。
              </div>
            }
            renderRow={(idx) => {
              const r = filtered[idx];
              return (
                <div
                  onClick={() => openTemp('item', { itemId: r.id })}
                  className={`${
                    coarse ? 'h-[40px]' : 'h-[26px]'
                  } grid grid-cols-[minmax(96px,1fr)_52px_50px_50px_50px_44px_36px] gap-1 items-center px-2 text-[11px] cursor-pointer hover:bg-sky-500/10 border-b border-slate-800/40`}
                >
                  <span className="flex items-center gap-1 min-w-0">
                    <span className="truncate text-slate-100">{r.name}</span>
                    {r.instant && <span className="text-[8px] px-1 bg-emerald-500/15 text-emerald-300 shrink-0">瞬时</span>}
                    {r.orders > 0 && <span className="text-[8px] text-amber-300 shrink-0">●</span>}
                  </span>
                  <span className={`text-right mono ${r.held > 0 ? 'text-emerald-300' : 'text-slate-600'}`}>
                    {r.held}
                  </span>
                  <span className="text-right mono text-emerald-400/90">{r.bid?.toFixed(1) ?? '--'}</span>
                  <span className="text-right mono text-rose-400/90">{r.ask?.toFixed(1) ?? '--'}</span>
                  <span className="text-right mono text-sky-300">{r.last?.toFixed(1) ?? '--'}</span>
                  <span className="text-right mono text-slate-400">{r.vol || ''}</span>
                  <span className="text-right mono text-amber-300">{r.orders || ''}</span>
                </div>
              );
            }}
          />
        </div>
      </div>

      <div className="px-2 py-1 border-t border-slate-800 text-[9px] text-slate-500 flex items-center justify-between shrink-0">
        <span>点击行打开物品详情（在当前位置展开，不弹新窗口）</span>
        <span className="flex items-center gap-1">
          <button className="hover:text-sky-300" onClick={() => { setParams({}); openTemp('item', {}); }}>
            新开详情窗
          </button>
        </span>
      </div>
    </div>
  );
};

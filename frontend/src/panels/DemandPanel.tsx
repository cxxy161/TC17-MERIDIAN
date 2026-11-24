import React, { useMemo, useState } from 'react';
import { AlertTriangle, ArrowDown, ArrowUp, Search } from 'lucide-react';
import type { PaneProps } from '../layout/paneRegistry';
import { useCatalogIndex, useWorldIndex } from '../entities/hooks';
import { SearchSelect, type PickerFacet, type PickerOption } from '../components/SearchSelect';
import { VirtualList } from '../components/VirtualList';
import { stationIdForPlanet } from '../types/meridian';

const COLS = 'grid-cols-[minmax(0,1fr)_64px_100px_62px_54px_92px]';
const ROW_HEIGHT = 26;

type SortKey = 'qty' | 'name';

interface DemandRow {
  itemId: string;
  name: string;
  categoryId: string | null;
  qty: number;
  bid: number | null;
  last: number | null;
  stock: number;
  gap: number;
}

/**
 * City consumption for exactly ONE planet, chosen through a searchable picker.
 *
 * The old version built a pill-button wall from `state.planets` and fell back to the first planet
 * for an unknown id, so a removed planet silently showed another city's demand. The planet now
 * lives in `params.planetId`, an unknown id is reported explicitly, and the table is virtualized.
 */
export const DemandPanel: React.FC<PaneProps> = ({ params, setParams, openTemp }) => {
  const catalog = useCatalogIndex();
  const world = useWorldIndex();

  const planetId = params.planetId;
  const planet = world.planet(planetId);
  const stationId = planet ? stationIdForPlanet(planet.id) : null;

  const [query, setQuery] = useState('');
  const [category, setCategory] = useState<string>('all');
  const [sortKey, setSortKey] = useState<SortKey>('qty');
  const [sortDir, setSortDir] = useState<1 | -1>(-1);

  const planetOptions = useMemo<PickerOption[]>(
    () =>
      world.planets.map((p) => ({
        id: p.id,
        label: p.name,
        sub: `人口 ${Math.round(p.population).toLocaleString()} · 繁荣 ${p.prosperity.toFixed(2)}x · ${p.id}`,
        keywords: `${p.id} ${p.name} ${p.archetype}`,
        facets: { tier: String(p.wealth_tier) },
      })),
    [world.planets],
  );

  const planetFacets = useMemo<PickerFacet[]>(() => {
    const counts = new Map<number, number>();
    for (const p of world.planets) counts.set(p.wealth_tier, (counts.get(p.wealth_tier) ?? 0) + 1);
    return [
      {
        key: 'tier',
        label: '财富',
        values: [...counts.entries()]
          .sort((a, b) => a[0] - b[0])
          .map(([tier, count]) => ({ id: String(tier), label: `${tier} 级`, count })),
      },
    ];
  }, [world.planets]);

  /** My warehouse stock at this city's orbital station, aggregated by the world index. */
  const stationStock = useMemo(() => {
    const map = new Map<string, number>();
    if (!stationId) return map;
    for (const [itemId, holding] of world.holdings) {
      const slice = holding.byLocation.find((s) => s.location === stationId);
      if (slice && slice.qty > 0) map.set(itemId, slice.qty);
    }
    return map;
  }, [world, stationId]);

  const rows = useMemo<DemandRow[]>(() => {
    if (!planet) return [];
    return Object.entries(planet.demands ?? {}).map(([itemId, qty]) => {
      const def = catalog.item(itemId);
      const ticker = stationId ? world.ticker(stationId, itemId) : undefined;
      const stock = stationStock.get(itemId) ?? 0;
      return {
        itemId,
        name: catalog.itemName(itemId),
        categoryId: def?.demand_category ?? null,
        qty,
        bid: ticker?.best_bid ?? null,
        last: ticker?.last_price ?? null,
        stock,
        gap: Math.max(0, qty - stock),
      };
    });
  }, [planet, catalog, world, stationId, stationStock]);

  const categoryChips = useMemo(() => {
    const counts = new Map<string, number>();
    for (const r of rows) if (r.categoryId) counts.set(r.categoryId, (counts.get(r.categoryId) ?? 0) + 1);
    // Facet labels/order come from the catalog index; counts are this planet's demand entries.
    return catalog.facets.category
      .map((c) => ({ id: c.id, label: c.label, count: counts.get(c.id) ?? 0 }))
      // Keep the selected chip visible even if this tick's demand vanished, so the filter can be cleared.
      .filter((c) => c.count > 0 || c.id === category);
  }, [rows, catalog, category]);

  const visible = useMemo(() => {
    const q = query.trim().toLowerCase();
    const out = rows.filter((r) => {
      if (category !== 'all' && r.categoryId !== category) return false;
      if (!q) return true;
      return (
        r.name.toLowerCase().includes(q) ||
        r.itemId.toLowerCase().includes(q) ||
        (catalog.item(r.itemId)?.tags ?? []).some((t) => t.toLowerCase().includes(q))
      );
    });
    out.sort((a, b) => {
      if (sortKey === 'name') return a.name.localeCompare(b.name, 'zh-Hans-CN') * sortDir;
      return (a.qty - b.qty) * sortDir || a.name.localeCompare(b.name, 'zh-Hans-CN');
    });
    return out;
  }, [rows, query, category, sortKey, sortDir, catalog]);

  const totals = useMemo(() => {
    let qty = 0;
    let gap = 0;
    for (const r of rows) {
      qty += r.qty;
      gap += r.gap;
    }
    return { qty, gap };
  }, [rows]);

  const toggleSort = (key: SortKey) => {
    if (key === sortKey) setSortDir((d) => (d === 1 ? -1 : 1));
    else {
      setSortKey(key);
      setSortDir(key === 'name' ? 1 : -1);
    }
  };

  const picker = (
    <SearchSelect
      options={planetOptions}
      value={planetId}
      onChange={(id) => setParams({ planetId: id })}
      facets={planetFacets}
      placeholder="搜索行星 / 编号…"
      emptyLabel="选择行星"
      className="max-w-[220px]"
    />
  );

  if (!planet) {
    return (
      <div className="h-full flex flex-col bg-[#202732] text-slate-200 overflow-hidden">
        <div className="px-2.5 py-1.5 border-b border-sky-500/15 bg-[#232a36] flex items-center gap-2 shrink-0 flex-wrap">
          {picker}
          <span className="text-[11px] text-amber-300">
            {!world.ready
              ? '正在同步城市数据…'
              : planetId
                ? `行星「${planetId}」不存在（可能来自已移除的行星）`
                : '未选择行星'}
          </span>
        </div>
        <div className="flex-1 flex flex-col items-center justify-center gap-2 text-[11px] text-slate-500 px-4 text-center">
          <AlertTriangle className="w-5 h-5 text-amber-400/70" />
          <span>从上方选择器选一颗行星，查看该城市的本回合消费需求。</span>
        </div>
      </div>
    );
  }

  return (
    <div className="h-full flex flex-col bg-[#202732] text-slate-200 overflow-hidden">
      <div className="px-2.5 py-1.5 border-b border-sky-500/15 bg-[#232a36] flex items-center gap-2 shrink-0 flex-wrap">
        {picker}
        <span className="text-[10px] text-slate-500 mono">{planet.archetype}</span>
        <span className="ml-auto text-[10px] text-slate-400 mono">
          回合 {world.tick} · {world.stationLabel(stationId ?? '')}
        </span>
      </div>

      <div className="px-3 py-1.5 bg-[#1b212b] border-b border-slate-800/80 flex items-center justify-between text-[11px] shrink-0 flex-wrap gap-1">
        <span className="text-slate-400">
          居民{' '}
          <strong className="text-sky-300 mono">{Math.round(planet.population).toLocaleString()}</strong>
          {(planet.city_capacity ?? 0) > 0 && (
            <span className="mono text-slate-400">
              {' '}/ {Math.round(planet.city_capacity ?? 0).toLocaleString()} (
              {Math.round((planet.population / (planet.city_capacity ?? 1)) * 100)}%)
            </span>
          )}{' '}
          · 繁荣 <strong className="text-emerald-400 mono">{planet.prosperity.toFixed(2)}x</strong> ·{' '}
          {planet.wealth_tier} 级
        </span>
        <span className="text-slate-400">
          本回合需求合计 <strong className="text-sky-300 mono">{totals.qty}</strong> 单位 · 缺口{' '}
          <strong className="text-amber-300 mono">{totals.gap}</strong>
        </span>
      </div>

      <div className="px-2 py-1 border-b border-slate-800/80 flex items-center gap-1.5 flex-wrap shrink-0">
        <div className="flex items-center gap-1.5 px-2 py-0.5 bg-[#1b212b] border border-slate-700 rounded-sm flex-1 min-w-[140px]">
          <Search className="w-3 h-3 text-sky-400 shrink-0" />
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="搜索物品名 / id / 标签…"
            className="flex-1 min-w-0 bg-transparent outline-none text-[11px] text-slate-100 placeholder:text-slate-600"
          />
          <span className="text-[9px] mono text-slate-500 shrink-0">{visible.length}</span>
        </div>
        <button
          onClick={() => toggleSort('qty')}
          className={`flex items-center gap-0.5 text-[10px] px-1.5 py-[1px] border rounded-[2px] ${
            sortKey === 'qty'
              ? 'bg-sky-500/25 border-sky-400/60 text-sky-100'
              : 'border-slate-700/70 text-slate-400 hover:text-slate-200'
          }`}
        >
          需求量大
          {sortKey === 'qty' && (sortDir === 1 ? <ArrowUp className="w-2.5 h-2.5" /> : <ArrowDown className="w-2.5 h-2.5" />)}
        </button>
        <button
          onClick={() => toggleSort('name')}
          className={`flex items-center gap-0.5 text-[10px] px-1.5 py-[1px] border rounded-[2px] ${
            sortKey === 'name'
              ? 'bg-sky-500/25 border-sky-400/60 text-sky-100'
              : 'border-slate-700/70 text-slate-400 hover:text-slate-200'
          }`}
        >
          名称
          {sortKey === 'name' && (sortDir === 1 ? <ArrowUp className="w-2.5 h-2.5" /> : <ArrowDown className="w-2.5 h-2.5" />)}
        </button>
        <span className="w-px h-3 bg-slate-700 mx-0.5" />
        <button
          onClick={() => setCategory('all')}
          className={`text-[10px] px-1.5 py-[1px] border rounded-[2px] ${
            category === 'all'
              ? 'bg-emerald-500/20 border-emerald-400/50 text-emerald-100'
              : 'border-slate-700/70 text-slate-400 hover:text-slate-200'
          }`}
        >
          全部类别
        </button>
        {categoryChips.map((c) => (
          <button
            key={c.id}
            onClick={() => setCategory(category === c.id ? 'all' : c.id)}
            className={`text-[10px] px-1.5 py-[1px] border rounded-[2px] ${
              category === c.id
                ? 'bg-emerald-500/20 border-emerald-400/50 text-emerald-100'
                : 'border-slate-700/70 text-slate-400 hover:text-slate-200'
            }`}
          >
            {c.label}
            <span className="text-slate-500 ml-1">{c.count}</span>
          </button>
        ))}
      </div>

      <div className={`px-2 py-1 bg-[#252e3b] border-b border-slate-800/80 grid ${COLS} gap-1 text-[9px] text-slate-500 shrink-0`}>
        <span>消费物资</span>
        <span className="text-right">本回合需求</span>
        <span className="text-right">本地买一 / 最新</span>
        <span className="text-right">我的站内仓</span>
        <span className="text-right">缺口</span>
        <span className="text-right">操作</span>
      </div>

      <VirtualList
        className="flex-1 min-h-0 overflow-y-auto"
        count={visible.length}
        rowHeight={ROW_HEIGHT}
        emptyState={
          <div className="px-3 py-6 text-center text-[11px] text-slate-500">
            {rows.length === 0
              ? `${planet.name} 当前暂无城市居民消费需求`
              : '没有匹配的需求项。清空搜索或切换类别试试。'}
          </div>
        }
        renderRow={(idx) => {
          const r = visible[idx];
          return (
            <div
              className={`h-[26px] grid ${COLS} gap-1 items-center px-2 text-[11px] border-b border-slate-800/40 hover:bg-sky-500/10`}
            >
              <span className="truncate text-slate-200 font-medium" title={r.itemId}>
                {r.name}
              </span>
              <span className="text-right mono text-sky-300 font-semibold">{r.qty}</span>
              <span className="text-right mono text-slate-300 whitespace-nowrap">
                <span className="text-emerald-400">{r.bid !== null ? r.bid.toFixed(2) : '--'}</span>
                <span className="text-slate-600 mx-1">/</span>
                <span>{r.last !== null ? r.last.toFixed(2) : '--'}</span>
              </span>
              <span className="text-right mono">
                {r.stock > 0 ? <span className="text-emerald-300">{r.stock}</span> : <span className="text-slate-600">0</span>}
              </span>
              <span className={`text-right mono ${r.gap > 0 ? 'text-amber-300' : 'text-emerald-400/80'}`}>
                {r.gap > 0 ? r.gap : '—'}
              </span>
              <span className="text-right whitespace-nowrap space-x-1">
                <button
                  onClick={() => openTemp('orderbook', { stationId: stationId ?? undefined, itemId: r.itemId })}
                  className="pill-btn py-0 px-1.5 text-[10px]"
                >
                  盘口
                </button>
                <button
                  onClick={() => openTemp('chart', { stationId: stationId ?? undefined, itemId: r.itemId })}
                  className="pill-btn py-0 px-1.5 text-[10px]"
                >
                  K线
                </button>
              </span>
            </div>
          );
        }}
      />
    </div>
  );
};

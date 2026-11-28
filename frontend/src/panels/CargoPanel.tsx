import React, { useMemo, useState } from 'react';
import { AlertTriangle, Search } from 'lucide-react';
import type { PaneProps } from '../layout/paneRegistry';
import { useCatalogIndex, useWorldIndex } from '../entities/hooks';
import { SearchSelect, type PickerFacet, type PickerOption } from '../components/SearchSelect';
import { VirtualList } from '../components/VirtualList';
import { isCoarsePointer } from '../utils/useDragPointer';

/** Shared column template so the sticky header and every virtualized row stay pixel-aligned. */
const COLS = 'grid-cols-[minmax(96px,1fr)_58px_72px_70px_86px]';
const ROW_HEIGHT = 26;

interface StockRow {
  id: string;
  name: string;
  qty: number;
  categoryId: string | null;
  categoryLabel: string;
  roleLabel: string;
  tags: string[];
  hubLast: number | null;
  value: number;
}

function fmtNum(n: number): string {
  return n.toLocaleString(undefined, { maximumFractionDigits: 1 });
}

/**
 * Warehouse inventory for exactly ONE location, chosen through a searchable picker.
 *
 * The old version enumerated every ground store and every station store as an `2N+1` pill-button
 * wall (station ids string-concatenated from planet ids), held the selection in local state, and
 * rendered every catalog item — including the ~1000 zero-stock ones — as chips on every tick.
 *
 * Now the location is `params.locationId` (the pane title derives from it), the inventory is a
 * virtualized table, and zero-stock items collapse into one expandable line.
 */
export const CargoPanel: React.FC<PaneProps> = ({ params, setParams, openTemp }) => {
  const catalog = useCatalogIndex();
  const world = useWorldIndex();

  const locationId = params.locationId;
  const [query, setQuery] = useState('');
  const [category, setCategory] = useState<string>('all');
  /** Default on: the 1000-odd zero-stock items stay collapsed until explicitly expanded. */
  const [onlyStocked, setOnlyStocked] = useState(true);

  const location = locationId ? world.locationById.get(locationId) : undefined;
  const hubStationId = useMemo(() => world.stations.find((s) => s.isHub)?.id ?? null, [world.stations]);

  const locationOptions = useMemo<PickerOption[]>(
    () =>
      world.locations.map((loc) => ({
        id: loc.id,
        label: loc.label,
        sub: loc.kind === 'planet' ? '地表仓库' : loc.isHub ? '中心枢纽' : '轨道站仓库',
        badge: loc.isHub ? '枢纽' : loc.kind === 'station' && loc.planetId ? '轨道站' : undefined,
        keywords: `${loc.id} ${loc.label}`,
        facets: { kind: loc.kind },
      })),
    [world.locations],
  );

  const locationFacets = useMemo<PickerFacet[]>(() => {
    const planets = world.locations.filter((l) => l.kind === 'planet').length;
    const stations = world.locations.length - planets;
    return [
      {
        key: 'kind',
        label: '类型',
        values: [
          { id: 'planet', label: '地表仓库', count: planets },
          { id: 'station', label: '轨道站仓库', count: stations },
        ],
      },
    ];
  }, [world.locations]);

  /**
   * Per-item quantity for the selected location, taken from the sparse world index instead of
   * re-reading and re-walking the raw snapshot store on every render.
   */
  const locationQty = useMemo(() => {
    const map = new Map<string, number>();
    if (!locationId) return map;
    for (const [itemId, holding] of world.holdings) {
      const slice = holding.byLocation.find((s) => s.location === locationId);
      if (slice && slice.qty > 0) map.set(itemId, slice.qty);
    }
    return map;
  }, [world, locationId]);

  const rows = useMemo<StockRow[]>(() => {
    const out: StockRow[] = catalog.items.map((item) => {
      const qty = locationQty.get(item.id) ?? 0;
      const hubLast = hubStationId ? world.ticker(hubStationId, item.id)?.last_price ?? null : null;
      return {
        id: item.id,
        name: item.name,
        qty,
        categoryId: item.demand_category,
        categoryLabel: catalog.categoryName(item.demand_category) ?? '未分类',
        roleLabel: catalog.roleLabel(item.role),
        tags: item.tags ?? [],
        hubLast,
        value: (hubLast ?? 0) * qty,
      };
    });
    // Items still sitting in a store after being dropped from the production pack must not vanish
    // silently: surface them as explicitly-unknown rows instead of hiding the stock.
    for (const [itemId, qty] of locationQty) {
      if (qty <= 0 || catalog.byId.has(itemId)) continue;
      const hubLast = hubStationId ? world.ticker(hubStationId, itemId)?.last_price ?? null : null;
      out.push({
        id: itemId,
        name: `未知物品（${itemId}）`,
        qty,
        categoryId: null,
        categoryLabel: '未分类',
        roleLabel: '未知',
        tags: [],
        hubLast,
        value: (hubLast ?? 0) * qty,
      });
    }
    return out.sort((a, b) => b.qty - a.qty || a.name.localeCompare(b.name, 'zh-Hans-CN'));
  }, [catalog, world, locationQty, hubStationId]);

  const scoped = useMemo(() => {
    const q = query.trim().toLowerCase();
    return rows.filter((r) => {
      if (category !== 'all' && r.categoryId !== category) return false;
      if (!q) return true;
      return (
        r.name.toLowerCase().includes(q) ||
        r.id.toLowerCase().includes(q) ||
        r.categoryLabel.toLowerCase().includes(q) ||
        r.roleLabel.toLowerCase().includes(q) ||
        r.tags.some((t) => t.toLowerCase().includes(q))
      );
    });
  }, [rows, query, category]);

  const stocked = useMemo(() => scoped.filter((r) => r.qty > 0), [scoped]);
  const zeroCount = scoped.length - stocked.length;
  const visible = onlyStocked ? stocked : scoped;

  const totals = useMemo(() => {
    let items = 0;
    let qty = 0;
    let value = 0;
    for (const r of rows) {
      if (r.qty <= 0) continue;
      items += 1;
      qty += r.qty;
      value += r.value;
    }
    return { items, qty, value };
  }, [rows]);

  const picker = (
    <SearchSelect
      options={locationOptions}
      value={locationId}
      onChange={(id) => setParams({ locationId: id })}
      facets={locationFacets}
      placeholder="搜索地点 / 行星 / 站点…"
      emptyLabel="选择仓库地点"
      className="max-w-[220px]"
    />
  );

  return (
    <div className="h-full flex flex-col bg-[#202732] text-slate-200 overflow-hidden">
      <div className="px-2 py-1.5 border-b border-sky-500/10 bg-[#232a36] flex items-center gap-2 shrink-0 flex-wrap">
        {picker}
        {location && (
          <span className="text-[10px] text-slate-400">
            {location.kind === 'planet' ? '地表仓库' : location.isHub ? '中心枢纽仓库' : '轨道站仓库'}
          </span>
        )}
        <span className="ml-auto text-[10px] mono text-emerald-400">
          有货 {totals.items} 项 · {totals.qty} 单位 · 估值 {fmtNum(totals.value)}
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
          onClick={() => setOnlyStocked((v) => !v)}
          className={`text-[10px] px-1.5 py-[1px] border rounded-[2px] whitespace-nowrap ${
            onlyStocked
              ? 'bg-emerald-500/20 border-emerald-400/50 text-emerald-100'
              : 'border-slate-700/70 text-slate-400 hover:text-slate-200'
          }`}
          title="关闭后会列出零库存品类（仍然走虚拟列表）"
        >
          只看有货
        </button>
        <span className="w-px h-3 bg-slate-700 mx-0.5" />
        <button
          onClick={() => setCategory('all')}
          className={`text-[10px] px-1.5 py-[1px] border rounded-[2px] ${
            category === 'all'
              ? 'bg-sky-500/25 border-sky-400/60 text-sky-100'
              : 'border-slate-700/70 text-slate-400 hover:text-slate-200'
          }`}
        >
          全部类别
        </button>
        {catalog.facets.category.map((c) => (
          <button
            key={c.id}
            onClick={() => setCategory(category === c.id ? 'all' : c.id)}
            className={`text-[10px] px-1.5 py-[1px] border rounded-[2px] ${
              category === c.id
                ? 'bg-sky-500/25 border-sky-400/60 text-sky-100'
                : 'border-slate-700/70 text-slate-400 hover:text-slate-200'
            }`}
          >
            {c.label}
            <span className="text-slate-500 ml-1">{c.count}</span>
          </button>
        ))}
      </div>

      {!world.ready ? (
        <div className="flex-1 flex items-center justify-center text-[11px] text-slate-500">
          正在同步仓库数据…
        </div>
      ) : !location ? (
        <div className="flex-1 flex flex-col items-center justify-center gap-2 text-[11px] text-slate-500 px-4 text-center">
          <AlertTriangle className="w-5 h-5 text-amber-400/70" />
          <span className="text-amber-300">
            {locationId ? `地点「${locationId}」不存在（可能来自已移除的行星或站点）` : '未选择仓库地点'}
          </span>
          <span className="text-[10px] text-slate-600">从上方选择器选一个地点后即可查看该处库存。</span>
        </div>
      ) : (
        <>
          <div className="flex-1 min-h-0 flex flex-col overflow-x-auto">
            <div className="min-w-[400px] flex-1 min-h-0 flex flex-col">
              <div className={`px-2 py-1 bg-[#252e3b] border-b border-slate-800/80 grid ${COLS} gap-1 text-[10px] text-slate-400 shrink-0`}>
                <span>物品</span>
                <span className="text-right">数量</span>
                <span className="text-right">类别</span>
                <span className="text-right">枢纽最新</span>
                <span className="text-right">估值</span>
              </div>

              <VirtualList
                className="flex-1 min-h-0 overflow-y-auto"
                count={visible.length}
                rowHeight={isCoarsePointer() ? 40 : ROW_HEIGHT}
                emptyState={
                  <div className="px-3 py-6 text-center text-[11px] text-slate-500">
                    {totals.items === 0 ? '当前仓库暂无存货' : '没有匹配的物品。清空搜索或关闭筛选试试。'}
                  </div>
                }
                renderRow={(idx) => {
                  const r = visible[idx];
                  return (
                    <div
                      onClick={() => openTemp('item', { itemId: r.id })}
                      className={`${
                        isCoarsePointer() ? 'h-[40px]' : 'h-[26px]'
                      } grid ${COLS} gap-1 items-center px-2 text-[11px] cursor-pointer hover:bg-sky-500/10 border-b border-slate-800/40 ${
                        r.qty > 0 ? '' : 'opacity-60'
                      }`}
                      title="在新窗口打开物品详情"
                    >
                      <span className="truncate text-slate-100">{r.name}</span>
                      <span className={`text-right mono ${r.qty > 0 ? 'text-emerald-300' : 'text-slate-600'}`}>
                        {r.qty}
                      </span>
                      <span className="text-right text-slate-400 truncate">{r.categoryLabel}</span>
                      <span className="text-right mono text-sky-300">
                        {r.hubLast !== null ? r.hubLast.toFixed(2) : '--'}
                      </span>
                      <span className="text-right mono text-slate-300">
                        {r.value > 0 ? fmtNum(r.value) : '--'}
                      </span>
                    </div>
                  );
                }}
              />
            </div>
          </div>

          <div className="px-2 py-1 border-t border-slate-800 text-[9px] text-slate-500 flex items-center justify-between gap-2 shrink-0">
            <span className="truncate">
              {onlyStocked && zeroCount > 0 ? (
                <>
                  另有 <span className="text-slate-300 mono">{zeroCount}</span> 类零库存
                  <button
                    onClick={() => setOnlyStocked(false)}
                    className="ml-1 text-sky-400 hover:text-sky-300"
                  >
                    展开
                  </button>
                </>
              ) : !onlyStocked ? (
                <button onClick={() => setOnlyStocked(true)} className="text-sky-400 hover:text-sky-300">
                  收起零库存（{zeroCount} 类）
                </button>
              ) : (
                <span>该地点没有零库存品类</span>
              )}
            </span>
            <span className="shrink-0">点击物品行 → 打开物品详情</span>
          </div>
        </>
      )}
    </div>
  );
};

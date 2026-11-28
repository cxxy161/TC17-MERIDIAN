import React, { useMemo, useState } from 'react';
import { AlertTriangle, ArrowDown, ArrowUp, Search } from 'lucide-react';
import type { PaneProps } from '../layout/paneRegistry';
import { useCatalogIndex, useWorldIndex } from '../entities/hooks';
import { SearchSelect, type PickerOption } from '../components/SearchSelect';
import { VirtualList } from '../components/VirtualList';
import { useGameStore } from '../store/useGameStore';

type SortKey = 'name' | 'bid' | 'ask' | 'last' | 'vol' | 'held';

interface TickerRow {
  id: string;
  name: string;
  category: string;
  bid: number | null;
  ask: number | null;
  last: number;
  vol: number;
  /** Quantity of this item held in the selected station's store. */
  held: number;
  /** Whether the company has any open order for this item anywhere. */
  hasOrder: boolean;
}

const ROW_HEIGHT = 22;
/** 物品 / 买一 / 卖一 / 最新 / 50回合量 / 站内持仓 / 窗口 */
const GRID = 'grid-cols-[1fr_50px_50px_50px_42px_44px_84px]';

/**
 * Whole-station quote board.
 *
 * The station is an entity, so it lives in `params` (never in local state) — the pane title is
 * derived from it. Rows come from the world index's per-station ticker bucket (O(1) lookup) instead
 * of filtering the full ticker array on every tick. The search box and the three toggles are pure
 * view state, which is exactly what `useState` is for.
 */
export const TickerPanel: React.FC<PaneProps> = ({ params, setParams, openTemp }) => {
  const catalog = useCatalogIndex();
  const world = useWorldIndex();
  const state = useGameStore((s) => s.state);

  const stationId = params.stationId;

  const [query, setQuery] = useState('');
  const [onlyQuoted, setOnlyQuoted] = useState(false);
  const [onlyHeld, setOnlyHeld] = useState(false);
  const [onlyOrders, setOnlyOrders] = useState(false);
  const [sortKey, setSortKey] = useState<SortKey>('name');
  const [sortDir, setSortDir] = useState<1 | -1>(1);

  const stationOptions = useMemo<PickerOption[]>(
    () =>
      world.stations.map((s) => ({
        id: s.id,
        label: s.label,
        sub: s.planetId ? world.planetName(s.planetId) : undefined,
        keywords: `${s.id} ${s.label}`,
        badge: s.isHub ? '枢纽' : undefined,
      })),
    [world],
  );

  // A location that is not one of the known stations (or no station at all) is an explicit error
  // state — never silently replaced by "the first station".
  const stationValid = useMemo(
    () => !!stationId && world.locationExists(stationId) && world.stations.some((s) => s.id === stationId),
    [world, stationId],
  );

  const hubId = useMemo(() => world.stations.find((s) => s.isHub)?.id, [world]);

  const stationStore = useMemo<Record<string, number>>(() => {
    if (!stationValid || !stationId) return {};
    return state?.player_snapshot?.company.station_stores?.[stationId] ?? {};
  }, [state, stationId, stationValid]);

  const rows = useMemo<TickerRow[]>(() => {
    if (!stationId || !stationValid) return [];
    const tickers = world.tickerByStation.get(stationId) ?? [];
    return tickers.map((t) => {
      const def = catalog.item(t.item_id);
      return {
        id: t.item_id,
        name: def?.name ?? catalog.itemName(t.item_id),
        category: catalog.categoryName(def?.demand_category ?? null) ?? '—',
        bid: t.best_bid,
        ask: t.best_ask,
        last: t.last_price,
        vol: t.vol_50t,
        held: stationStore[t.item_id] ?? 0,
        hasOrder: (world.openOrdersByItem.get(t.item_id)?.length ?? 0) > 0,
      };
    });
  }, [stationId, stationValid, world, catalog, stationStore]);

  const filtered = useMemo<TickerRow[]>(() => {
    const q = query.trim().toLowerCase();
    const out = rows.filter((r) => {
      if (onlyQuoted && r.bid === null && r.ask === null) return false;
      if (onlyHeld && r.held <= 0) return false;
      if (onlyOrders && !r.hasOrder) return false;
      if (!q) return true;
      return (
        r.name.toLowerCase().includes(q) ||
        r.id.toLowerCase().includes(q) ||
        r.category.toLowerCase().includes(q)
      );
    });
    const dir = sortDir;
    out.sort((a, b) => {
      switch (sortKey) {
        case 'bid':
          return ((a.bid ?? -1) - (b.bid ?? -1)) * dir;
        case 'ask':
          return ((a.ask ?? -1) - (b.ask ?? -1)) * dir;
        case 'last':
          return (a.last - b.last) * dir;
        case 'vol':
          return (a.vol - b.vol) * dir;
        case 'held':
          return (a.held - b.held) * dir;
        default:
          return a.name.localeCompare(b.name, 'zh-Hans-CN') * dir;
      }
    });
    return out;
  }, [rows, query, onlyQuoted, onlyHeld, onlyOrders, sortKey, sortDir]);

  const toggleSort = (key: SortKey) => {
    if (key === sortKey) setSortDir((d) => (d === 1 ? -1 : 1));
    else {
      setSortKey(key);
      setSortDir(key === 'name' ? 1 : -1);
    }
  };

  const stationPicker = (
    <SearchSelect
      options={stationOptions}
      value={stationId}
      onChange={(id) => setParams({ stationId: id })}
      placeholder="搜索站点 / 行星名…"
      emptyLabel="选择站点"
      title="切换行情站点"
    />
  );

  if (!world.ready) {
    return (
      <div className="h-full flex flex-col bg-[#202732] text-slate-200 overflow-hidden">
        <div className="px-2.5 py-1.5 border-b border-sky-500/10 bg-[#232a36] flex items-center gap-2 shrink-0">
          <span className="text-[11px] text-slate-400">站点</span>
          <span className="text-[11px] text-slate-500">正在加载世界状态…</span>
        </div>
        <div className="flex-1 flex items-center justify-center text-[11px] text-slate-500">
          行情面板需要世界状态与站点列表，数据到达后会自动显示。
        </div>
      </div>
    );
  }

  if (!stationValid) {
    return (
      <div className="h-full flex flex-col bg-[#202732] text-slate-200 overflow-hidden">
        <div className="px-2.5 py-1.5 border-b border-sky-500/10 bg-[#232a36] flex items-center gap-2 shrink-0 flex-wrap">
          <span className="text-[11px] text-slate-400">站点</span>
          {stationPicker}
          {hubId && (
            <button
              className="pill-btn py-0 text-[10px]"
              onClick={() => setParams({ stationId: hubId })}
              title="切换到中心贸易枢纽站"
            >
              用中心枢纽
            </button>
          )}
          <span className="ml-auto text-[10px] text-slate-500">按站点查看买一 / 卖一 / 最新价</span>
        </div>
        <div className="px-2.5 py-1.5 bg-amber-500/10 border-b border-amber-500/30 text-[11px] text-amber-200 flex items-center gap-1.5 shrink-0">
          <AlertTriangle className="w-3.5 h-3.5 shrink-0" />
          {stationId
            ? `站点「${stationId}」不存在（可能该行星已不在当前宇宙），请重新选择站点。`
            : '尚未选择站点，请在上方选择要观察的站点。'}
        </div>
        <div className="flex-1 flex flex-col items-center justify-center gap-2 text-[11px] text-slate-500">
          <span>行情面板需要一个有效站点。当前宇宙共 {world.stations.length} 个站点，请用上方的搜索选择器挑一个。</span>
        </div>
      </div>
    );
  }

  const SortHead: React.FC<{ k: SortKey; label: string; className?: string }> = ({ k, label, className }) => (
    <button
      onClick={() => toggleSort(k)}
      className={`flex items-center justify-end gap-0.5 hover:text-sky-300 ${className ?? ''}`}
      title="点击按此列排序"
    >
      {label}
      {sortKey === k && (sortDir === 1 ? <ArrowUp className="w-2.5 h-2.5" /> : <ArrowDown className="w-2.5 h-2.5" />)}
    </button>
  );

  return (
    <div className="h-full flex flex-col bg-[#202732] text-slate-200 overflow-hidden">
      <div className="px-2 py-1.5 border-b border-sky-500/10 bg-[#232a36] flex items-center gap-2 shrink-0 flex-wrap">
        <span className="text-[11px] text-slate-400 shrink-0">站点</span>
        {stationPicker}
        <span className="text-[10px] text-slate-500 mono shrink-0">
          {rows.length} 个物品有报价
        </span>
        <div className="flex items-center gap-1.5 px-2 py-0.5 bg-[#1b212b] border border-slate-700 rounded-sm flex-1 min-w-[140px]">
          <Search className="w-3 h-3 text-sky-400 shrink-0" />
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="搜索物品名 / id / 类别…"
            className="flex-1 min-w-0 bg-transparent outline-none text-[11px] text-slate-100 placeholder:text-slate-600"
          />
          <span className="text-[9px] mono text-slate-500 shrink-0">{filtered.length}</span>
        </div>
      </div>

      <div className="px-2 py-1 border-b border-slate-800/80 flex items-center gap-1 flex-wrap shrink-0">
        {([
          ['只看有报价', onlyQuoted, setOnlyQuoted],
          ['只看我有库存', onlyHeld, setOnlyHeld],
          ['只看我有挂单', onlyOrders, setOnlyOrders],
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
        <span className="w-px h-3 bg-slate-700 mx-0.5" />
        <span className="text-[9px] text-slate-500">● 我有挂单 · 点击行看物品详情</span>
      </div>

      <div className={`px-2 py-1 bg-[#252e3b] border-b border-slate-800/80 grid ${GRID} gap-1 text-[9px] text-slate-500 shrink-0`}>
        <SortHead k="name" label="物品" className="justify-start" />
        <SortHead k="bid" label="买一" />
        <SortHead k="ask" label="卖一" />
        <SortHead k="last" label="最新" />
        <SortHead k="vol" label="50量" />
        <SortHead k="held" label="站内持仓" />
        <span className="text-right pr-0.5">窗口</span>
      </div>

      <VirtualList
        className="flex-1 min-h-0 overflow-y-auto"
        count={filtered.length}
        rowHeight={ROW_HEIGHT}
        emptyState={
          <div className="px-3 py-6 text-center text-[11px] text-slate-500 flex flex-col items-center gap-1.5">
            <span>
              {rows.length === 0
                ? `「${world.stationLabel(stationId)}」当前没有任何物品报价（新站点或尚无成交时正常）。`
                : '没有匹配的报价。清空搜索或关闭筛选试试。'}
            </span>
            <span className="text-[10px] text-slate-600">
              {rows.length === 0 ? '换个站点，或等市场产生第一笔报价。' : `该站点共 ${rows.length} 条报价`}
            </span>
          </div>
        }
        renderRow={(idx) => {
          const r = filtered[idx];
          return (
            <div
              onClick={() => openTemp('item', { itemId: r.id })}
              className={`h-[22px] grid ${GRID} gap-1 items-center px-2 text-[11px] cursor-pointer hover:bg-sky-500/10 border-b border-slate-800/40`}
              title={`${r.name}（${r.id}）· ${r.category}`}
            >
              <span className="flex items-center gap-1 min-w-0">
                {r.hasOrder && <span className="text-[8px] text-amber-300 shrink-0" title="我有该物品的挂单">●</span>}
                <span className="truncate text-slate-100">{r.name}</span>
                <span className="text-[8px] text-slate-500 truncate shrink-0 max-w-[70px]">{r.category}</span>
              </span>
              <span className="text-right mono text-emerald-400/90">{r.bid !== null ? r.bid.toFixed(2) : '--'}</span>
              <span className="text-right mono text-rose-400/90">{r.ask !== null ? r.ask.toFixed(2) : '--'}</span>
              <span className="text-right mono text-sky-300">{r.last.toFixed(2)}</span>
              <span className="text-right mono text-slate-400">{r.vol || ''}</span>
              <span className={`text-right mono ${r.held > 0 ? 'text-emerald-300' : 'text-slate-600'}`}>
                {r.held || ''}
              </span>
              <span className="flex items-center justify-end gap-1">
                <button
                  onClick={(e) => {
                    e.stopPropagation();
                    openTemp('chart', { stationId, itemId: r.id });
                  }}
                  className="pill-btn py-0 text-[9px]"
                  title="在浮动窗口打开 K 线（可并排盯多个）"
                >
                  K线
                </button>
                <button
                  onClick={(e) => {
                    e.stopPropagation();
                    openTemp('orderbook', { stationId, itemId: r.id });
                  }}
                  className="pill-btn py-0 text-[9px] text-emerald-300"
                  title="在浮动窗口打开盘口"
                >
                  盘口
                </button>
              </span>
            </div>
          );
        }}
      />

      <div className="px-2 py-1 border-t border-slate-800 text-[9px] text-slate-500 flex items-center justify-between shrink-0 gap-2">
        <span>
          显示 {filtered.length} / {rows.length} 条 · 「K线」「盘口」在浮动窗口打开，便于并排盯盘
        </span>
        <span className="mono shrink-0">站点 {world.stationLabel(stationId)}</span>
      </div>
    </div>
  );
};

import React, { useEffect, useMemo, useState } from 'react';
import { AlertTriangle, BookOpen } from 'lucide-react';
import type { PaneProps } from '../layout/paneRegistry';
import { useCatalogIndex, useWorldIndex } from '../entities/hooks';
import { SearchSelect, type PickerOption } from '../components/SearchSelect';
import {
  creditsToMoney,
  moneyToCredits,
  READ_ONLY_OBSERVATION_MODE,
} from '../types/meridian';
import { useGameStore } from '../store/useGameStore';

const DEPTH_ROWS = 10;
const TRADE_ROWS = 14;

/**
 * Market depth for one (station, item) pair.
 *
 * Both entities live in `params` — no local copies of entity ids, no imperative title writes,
 * and no hardcoded station/item defaults.
 * The book subscription follows the params, price history is only fetched for the watched pair,
 * and every derived array is memoised so the per-tick re-render stays cheap.
 */
export const OrderBookPanel: React.FC<PaneProps> = ({ params, setParams, openTemp }) => {
  const catalog = useCatalogIndex();
  const world = useWorldIndex();
  const books = useGameStore((s) => s.books);
  const watchBook = useGameStore((s) => s.watchBook);
  const sendIntent = useGameStore((s) => s.sendIntent);
  const leaderboard = useGameStore((s) => s.state?.leaderboard);

  const stationId = params.stationId;
  const itemId = params.itemId;
  const item = catalog.item(itemId);
  const itemExists = !!item;

  const [side, setSide] = useState<'buy' | 'sell'>('sell');
  const [priceStr, setPriceStr] = useState('');
  const [qtyStr, setQtyStr] = useState('');

  useEffect(() => {
    if (!stationId || !itemId || !itemExists) return undefined;
    return watchBook(stationId, itemId);
  }, [stationId, itemId, itemExists, watchBook]);

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

  const itemOptions = useMemo<PickerOption[]>(
    () =>
      catalog.items.map((it) => ({
        id: it.id,
        label: it.name,
        sub: catalog.categoryName(it.demand_category) ?? undefined,
        keywords: `${it.id} ${it.tags.join(' ')} ${catalog.roleLabel(it.role)}`,
        badge: catalog.isInstant(it.id) ? '瞬时' : undefined,
        facets: {
          category: it.demand_category ?? undefined,
          role: it.role,
        },
      })),
    [catalog],
  );

  const stationValid = useMemo(
    () => !!stationId && world.locationExists(stationId) && world.stations.some((s) => s.id === stationId),
    [world, stationId],
  );

  const book = useMemo(
    () => (stationId && itemId ? books[`${stationId}::${itemId}`] : undefined),
    [books, stationId, itemId],
  );

  const quote = stationValid && stationId && itemId ? world.ticker(stationId, itemId) : undefined;

  const stats = useMemo(
    () => ({
      bid: book?.best_bid ?? quote?.best_bid ?? null,
      ask: book?.best_ask ?? quote?.best_ask ?? null,
      last: book?.last_price ?? quote?.last_price ?? null,
      vol: book?.vol_50t ?? quote?.vol_50t ?? 0,
      emaFast: book?.ema_fast,
      emaSlow: book?.ema_slow,
    }),
    [book, quote],
  );

  const bids = useMemo(() => book?.bids?.slice(0, DEPTH_ROWS) ?? [], [book]);
  const asks = useMemo(() => book?.asks?.slice(0, DEPTH_ROWS) ?? [], [book]);
  const trades = useMemo(() => (book?.recent_trades ?? []).slice(0, TRADE_ROWS), [book]);

  const maxDepthQty = useMemo(() => {
    let max = 0;
    for (const l of bids) if (l.qty > max) max = l.qty;
    for (const l of asks) if (l.qty > max) max = l.qty;
    return max || 1;
  }, [bids, asks]);

  const ownOrders = useMemo(
    () => world.openOrders.filter((o) => o.station_id === stationId && o.item_id === itemId),
    [world, stationId, itemId],
  );

  const allStationOrders = useMemo(
    () => (itemId ? world.openOrdersByItem.get(itemId) ?? [] : []),
    [world, itemId],
  );

  const companyNames = useMemo(() => {
    const map = new Map<string, string>();
    for (const row of leaderboard ?? []) map.set(row.id, row.name);
    return map;
  }, [leaderboard]);

  /** Trade flow only stores company ids; fall back to the raw id when it is not on the board. */
  const nameOf = (companyId: string): string => companyNames.get(companyId) ?? companyId;

  const handleSubmit = () => {
    if (!stationId || !itemId) return;
    const price = Number(priceStr);
    const qty = Math.floor(Number(qtyStr));
    if (!Number.isFinite(price) || price <= 0 || !Number.isFinite(qty) || qty <= 0) return;
    void sendIntent({
      CreateOrder: {
        station_id: stationId,
        side,
        item_id: itemId,
        qty,
        price: creditsToMoney(price),
      },
    });
  };

  const stationPicker = (
    <SearchSelect
      options={stationOptions}
      value={stationId}
      onChange={(id) => setParams({ stationId: id })}
      placeholder="搜索站点 / 行星名…"
      emptyLabel="选择站点"
      title="切换盘口站点"
    />
  );

  const itemPicker = (
    <SearchSelect
      options={itemOptions}
      value={itemId}
      onChange={(id) => setParams({ itemId: id })}
      placeholder="搜索物品名 / id / 标签…"
      emptyLabel="选择物品"
      title="切换盘口物品"
      facets={[
        { key: 'category', label: '类别', values: catalog.facets.category },
        { key: 'role', label: '角色', values: catalog.facets.role },
      ]}
    />
  );

  const header = (
    <div className="px-2.5 py-1.5 border-b border-sky-500/10 bg-[#232a36] flex items-center justify-between gap-2 shrink-0 flex-wrap">
      <div className="flex items-center gap-1.5 min-w-0">
        {stationPicker}
        {itemPicker}
        {item && <span className="text-[11px] text-slate-300 truncate">{item.name}</span>}
        {itemId && (
          <span className="text-[9px] mono text-sky-300/70 truncate">{itemId}</span>
        )}
      </div>

      <div className="flex items-center gap-1.5 shrink-0">
        <span className="text-[10px] mono text-emerald-400">站费 0.50%</span>
        {item && (
          <button
            className="pill-btn py-0 text-[10px]"
            onClick={() => openTemp('item', { itemId: item.id })}
            title="在新窗口打开物品详情（库存分布、全站行情）"
          >
            详情
          </button>
        )}
        <button
          onClick={() => openTemp('chart', { stationId, itemId })}
          className="pill-btn py-0 text-[10px]"
          disabled={!stationValid || !item}
          title="在浮动窗口打开 K 线"
        >
          看K线
        </button>
      </div>
    </div>
  );

  if (!catalog.ready || !world.ready) {
    return (
      <div className="h-full flex flex-col bg-[#202732] text-slate-200 overflow-hidden">
        {header}
        <div className="flex-1 flex flex-col items-center justify-center gap-1.5 text-[11px] text-slate-500">
          <BookOpen className="w-5 h-5 text-slate-600" />
          <span>正在加载生产包与世界状态…</span>
          <span className="text-[10px] text-slate-600">盘口需要物品目录与站点列表，数据到达后会自动显示。</span>
        </div>
      </div>
    );
  }

  if (!stationValid) {
    return (
      <div className="h-full flex flex-col bg-[#202732] text-slate-200 overflow-hidden">
        {header}
        <div className="px-2.5 py-1.5 bg-amber-500/10 border-b border-amber-500/30 text-[11px] text-amber-200 flex items-center gap-1.5 shrink-0">
          <AlertTriangle className="w-3.5 h-3.5 shrink-0" />
          {stationId
            ? `站点「${stationId}」不存在（可能该行星已不在当前宇宙），请重新选择站点。`
            : '尚未选择站点，请在上方选择站点。'}
        </div>
        <div className="flex-1 flex flex-col items-center justify-center gap-1.5 text-[11px] text-slate-500">
          <BookOpen className="w-5 h-5 text-slate-600" />
          <span>盘口需要一个有效站点。当前宇宙共 {world.stations.length} 个站点。</span>
        </div>
      </div>
    );
  }

  if (!item) {
    return (
      <div className="h-full flex flex-col bg-[#202732] text-slate-200 overflow-hidden">
        {header}
        <div className="px-2.5 py-1.5 bg-amber-500/10 border-b border-amber-500/30 text-[11px] text-amber-200 flex items-center gap-1.5 shrink-0">
          <AlertTriangle className="w-3.5 h-3.5 shrink-0" />
          {itemId
            ? `物品「${itemId}」不存在（可能已从生产包移除），请重新选择物品。`
            : '尚未选择物品，请在上方选择物品。'}
        </div>
        <div className="flex-1 flex flex-col items-center justify-center gap-1.5 text-[11px] text-slate-500">
          <BookOpen className="w-5 h-5 text-slate-600" />
          <span>当前生产包共 {catalog.items.length} 个物品，可在上方搜索并选择。</span>
        </div>
      </div>
    );
  }

  return (
    <div className="h-full flex flex-col bg-[#202732] text-slate-200 overflow-hidden">
      {header}

      {/* Quote summary */}
      <div className="px-2.5 py-1 border-b border-slate-800/80 flex items-center gap-3 mono text-[10px] shrink-0 flex-wrap">
        <span className="text-slate-500">
          买一 <span className="text-emerald-400">{stats.bid !== null ? stats.bid.toFixed(2) : '--'}</span>
        </span>
        <span className="text-slate-500">
          卖一 <span className="text-rose-400">{stats.ask !== null ? stats.ask.toFixed(2) : '--'}</span>
        </span>
        <span className="text-slate-500">
          最新 <span className="text-sky-300">{stats.last !== null ? stats.last.toFixed(2) : '--'}</span>
        </span>
        <span className="text-slate-500">
          50回合量 <span className="text-slate-300">{stats.vol || 0}</span>
        </span>
        <span className="text-slate-500">
          EMA 快/慢{' '}
          <span className="text-amber-300">
            {stats.emaFast !== undefined ? stats.emaFast.toFixed(2) : '--'} /{' '}
            {stats.emaSlow !== undefined ? stats.emaSlow.toFixed(2) : '--'}
          </span>
        </span>
        <span className="text-slate-500 ml-auto">我的挂单 {ownOrders.length}</span>
      </div>

      {book === undefined ? (
        <div className="px-2.5 py-3 border-b border-slate-800/80 bg-[#1b212b] flex flex-col items-center gap-1 text-[11px] text-slate-400 shrink-0">
          <BookOpen className="w-4 h-4 text-slate-600" />
          <span>该物品在此站点还没有盘口数据</span>
          <span className="text-[10px] text-slate-600">
            {world.stationLabel(stationId)} · {item.name} · 可能是新物品或尚未有人在该站点报过价
          </span>
        </div>
      ) : (
        <div className="grid grid-cols-2 divide-x divide-slate-800/80 p-2.5 gap-2 mono text-[11px] border-b border-slate-800/80 shrink-0">
          <div className="space-y-0.5">
            <div className="text-[10px] text-emerald-400 font-semibold pb-0.5">
              买方深度（{bids.length} 档）
            </div>
            {bids.length === 0 ? (
              <div className="text-slate-600 text-[10px]">暂无买单</div>
            ) : (
              bids.map((l, idx) => (
                <div
                  key={idx}
                  onClick={() => setPriceStr(l.price.toFixed(2))}
                  className="relative flex justify-between cursor-pointer hover:bg-emerald-500/10 px-1 overflow-hidden"
                  title="点击填入下单价格"
                >
                  <span
                    className="absolute inset-y-0 right-0 bg-emerald-500/10"
                    style={{ width: `${Math.round((l.qty / maxDepthQty) * 100)}%` }}
                  />
                  <span className="relative text-emerald-300">{l.price.toFixed(2)}</span>
                  <span className="relative text-slate-400">{l.qty}</span>
                </div>
              ))
            )}
          </div>

          <div className="space-y-0.5 pl-2">
            <div className="text-[10px] text-rose-400 font-semibold pb-0.5">
              卖方深度（{asks.length} 档）
            </div>
            {asks.length === 0 ? (
              <div className="text-slate-600 text-[10px]">暂无卖单</div>
            ) : (
              asks.map((l, idx) => (
                <div
                  key={idx}
                  onClick={() => setPriceStr(l.price.toFixed(2))}
                  className="relative flex justify-between cursor-pointer hover:bg-rose-500/10 px-1 overflow-hidden"
                  title="点击填入下单价格"
                >
                  <span
                    className="absolute inset-y-0 right-0 bg-rose-500/10"
                    style={{ width: `${Math.round((l.qty / maxDepthQty) * 100)}%` }}
                  />
                  <span className="relative text-rose-300">{l.price.toFixed(2)}</span>
                  <span className="relative text-slate-400">{l.qty}</span>
                </div>
              ))
            )}
          </div>
        </div>
      )}

      {/* Manual order form (hidden in code-only observation mode) */}
      {!READ_ONLY_OBSERVATION_MODE && (
        <div className="p-2 border-b border-slate-800/80 bg-[#1a2029] flex items-center gap-1.5 shrink-0 flex-wrap">
          <select
            value={side}
            onChange={(e) => setSide(e.target.value as 'buy' | 'sell')}
            className="bg-[#27303e] border border-slate-700 px-1.5 py-1 text-[11px] rounded-sm"
          >
            <option value="buy">买入</option>
            <option value="sell">卖出</option>
          </select>
          <input
            type="number"
            step="0.05"
            value={priceStr}
            onChange={(e) => setPriceStr(e.target.value)}
            placeholder="单价"
            className="w-20 bg-[#191f27] border border-slate-700 px-1.5 py-1 text-[11px] mono text-right rounded-sm"
          />
          <input
            type="number"
            min="1"
            value={qtyStr}
            onChange={(e) => setQtyStr(e.target.value)}
            placeholder="数量"
            className="w-16 bg-[#191f27] border border-slate-700 px-1.5 py-1 text-[11px] mono text-right rounded-sm"
          />
          <span className="text-[9px] text-slate-500">点击深度行可填入价格</span>
          <button onClick={handleSubmit} className={side === 'buy' ? 'cta-green ml-auto' : 'cta-blue ml-auto'}>
            提交限价单
          </button>
        </div>
      )}

      {/* Own Active Orders & Recent Trades */}
      <div className="flex-1 min-h-0 overflow-y-auto p-2.5 space-y-3 text-[11px]">
        <div>
          <div className="text-[10px] text-slate-400 mb-1">我的当前挂单（永久有效，无48回合强制过期）</div>
          {ownOrders.length === 0 ? (
            <div className="text-[10px] text-slate-600">该物品在本站点暂无挂单</div>
          ) : (
            <div className="space-y-1 mono">
              {ownOrders.map((o) => (
                <div key={o.order_id} className="metric-card flex items-center justify-between">
                  <span className={o.side === 'buy' ? 'text-emerald-400' : 'text-rose-400'}>
                    {o.side === 'buy' ? '买' : '卖'} · {moneyToCredits(o.price).toFixed(2)} × {o.qty}
                  </span>
                  {!READ_ONLY_OBSERVATION_MODE && (
                    <button
                      onClick={() => void sendIntent({ CancelOrder: { order_id: o.order_id } })}
                      className="pill-btn py-0 text-[10px]"
                    >
                      撤单
                    </button>
                  )}
                </div>
              ))}
            </div>
          )}
          <div className="text-[9px] text-slate-500 mt-1">
            该物品在全站共 <span className="text-amber-300 mono">{allStationOrders.length}</span> 个挂单 ·{' '}
            <button
              className="hover:text-sky-300 underline decoration-dotted"
              onClick={() => openTemp('item', { itemId: item.id })}
              title="在新窗口打开物品详情，查看全部站点的挂单与库存分布"
            >
              查看物品总览
            </button>
          </div>
        </div>

        <div>
          <div className="text-[10px] text-slate-400 mb-1">最近成交流水（{trades.length} 笔）</div>
          {trades.length === 0 ? (
            <div className="text-[10px] text-slate-600">
              {book === undefined ? '还没有盘口数据，暂无成交流水' : '暂无成交记录'}
            </div>
          ) : (
            <div className="space-y-1 mono text-[10px]">
              {trades.map((tr, i) => (
                <div key={i} className="flex justify-between gap-2 text-slate-400 border-b border-slate-800/50 pb-0.5">
                  <span className="shrink-0">T#{tr.tick}</span>
                  <span className="text-sky-300 shrink-0">
                    {tr.price.toFixed(2)} × {tr.qty}
                  </span>
                  <span className="truncate max-w-[220px]" title={`${tr.seller_id} → ${tr.buyer_id}`}>
                    {nameOf(tr.seller_id)} → {nameOf(tr.buyer_id)}
                  </span>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
};

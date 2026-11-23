import React, { useMemo } from 'react';
import { PackageSearch } from 'lucide-react';
import type { PaneProps } from '../layout/paneRegistry';
import { useCatalogIndex, useWorldIndex } from '../entities/hooks';
import { SearchSelect, type PickerOption } from '../components/SearchSelect';
import { VirtualList } from '../components/VirtualList';
import type { RecipeDef } from '../types/meridian';
import { moneyToCredits } from '../types/meridian';

/**
 * Item-centric detail: what it is, who makes/consumes it, where mine is, my orders, and every
 * station quoting it. This is the drill-down that turns an id into knowledge instead of making the
 * player read production.json.
 */
export const ItemDetailPanel: React.FC<PaneProps> = ({ params, setParams, openInPlace }) => {
  const catalog = useCatalogIndex();
  const world = useWorldIndex();
  const itemId = params.itemId;
  const item = catalog.item(itemId);

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
          profession: it.profession,
        },
      })),
    [catalog],
  );

  const picker = (
    <SearchSelect
      options={itemOptions}
      value={itemId}
      onChange={(id) => setParams({ itemId: id })}
      placeholder="搜索物品名 / id / 标签…"
      emptyLabel="选择物品"
      facets={[
        { key: 'category', label: '类别', values: catalog.facets.category },
        { key: 'role', label: '角色', values: catalog.facets.role },
      ]}
    />
  );

  const recipesIn = useMemo(
    () => (itemId ? catalog.recipesConsuming.get(itemId) ?? [] : []),
    [catalog, itemId],
  );
  const recipesOut = useMemo(
    () => (itemId ? catalog.recipesProducing.get(itemId) ?? [] : []),
    [catalog, itemId],
  );
  const holding = itemId ? world.holding(itemId) : undefined;
  const myOrders = useMemo(
    () => (itemId ? world.openOrdersByItem.get(itemId) ?? [] : []),
    [world, itemId],
  );
  const quotes = useMemo(
    () => (itemId ? [...(world.quotesByItem.get(itemId) ?? [])] : []),
    [world, itemId],
  );

  const sortedQuotes = useMemo(() => {
    const hub = world.stations.find((s) => s.isHub)?.id;
    return quotes.sort((a, b) => {
      if (a.stationId === hub) return -1;
      if (b.stationId === hub) return 1;
      const la = world.stationLabel(a.stationId);
      const lb = world.stationLabel(b.stationId);
      return la.localeCompare(lb, 'zh-Hans-CN');
    });
  }, [quotes, world]);

  const recipeLine = (r: RecipeDef) => {
    const inputs = r.inputs.map((i) => `${catalog.itemName(i.item)}×${i.qty}`).join(' + ') || '—';
    const outputs = r.outputs.map((o) => `${catalog.itemName(o.item)}×${o.qty}`).join(' + ') || '—';
    return { inputs, outputs, building: catalog.buildingName(r.building_id) };
  };

  if (!item) {
    return (
      <div className="h-full flex flex-col bg-[#202732] text-slate-200">
        <div className="px-3 py-2 border-b border-sky-500/10 bg-[#232a36] flex items-center gap-2">
          <span className="text-[11px] text-amber-300">
            {itemId ? `物品「${itemId}」不存在（可能已从生产包移除）` : '未选择物品'}
          </span>
          <span className="ml-auto">{picker}</span>
        </div>
        <div className="flex-1 flex flex-col items-center justify-center gap-2 text-slate-500 text-[11px]">
          <PackageSearch className="w-6 h-6 text-slate-600" />
          <span>从右上角选一个物品，或在工作区里点任一物品行。</span>
        </div>
      </div>
    );
  }

  const category = catalog.categoryName(item.demand_category);
  const badges = [
    category,
    catalog.roleLabel(item.role),
    catalog.professionName(item.profession),
    `${item.wealth_tier} 级`,
    catalog.isInstant(item.id) ? '瞬时货物（无需飞船）' : '实体货物（需飞船）',
  ].filter(Boolean) as string[];

  return (
    <div className="h-full flex flex-col bg-[#202732] text-slate-200 overflow-hidden">
      <div className="px-2.5 py-1.5 border-b border-sky-500/10 bg-[#232a36] flex items-center gap-2 shrink-0 flex-wrap">
        <span className="text-[12px] font-semibold text-slate-100">{item.name}</span>
        <span className="text-[9px] mono text-sky-300/80">{item.id}</span>
        <div className="ml-auto flex items-center gap-1">
          {picker}
          <button
            className="pill-btn py-0 text-[10px]"
            onClick={() => openInPlace('chart', { stationId: params.stationId, itemId: item.id })}
            title="在当前窗口打开 K 线"
          >
            K线
          </button>
          <button
            className="pill-btn py-0 text-[10px]"
            onClick={() => openInPlace('orderbook', { stationId: params.stationId, itemId: item.id })}
          >
            盘口
          </button>
        </div>
      </div>

      <div className="px-2.5 py-1 border-b border-slate-800/70 flex items-center gap-1 flex-wrap shrink-0">
        {badges.map((b) => (
          <span key={b} className="text-[9px] px-1.5 py-[1px] bg-[#27303e] border border-slate-700/70 text-slate-300 rounded-[2px]">
            {b}
          </span>
        ))}
        {(item.tags ?? []).map((t) => (
          <span key={t} className="text-[9px] px-1.5 py-[1px] bg-slate-800/60 text-slate-400 rounded-[2px]">
            #{t}
          </span>
        ))}
      </div>

      <div className="flex-1 min-h-0 overflow-y-auto p-2.5 space-y-2.5">
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-2">
          <div className="border border-slate-800 bg-[#1b212b] p-2 rounded-sm space-y-1">
            <div className="text-[10px] text-slate-400 border-b border-slate-800 pb-1">
              我的持有（合计 <span className="text-emerald-300 mono">{holding?.total ?? 0}</span>）
            </div>
            {!holding || holding.byLocation.length === 0 ? (
              <div className="text-[10px] text-slate-600 py-2">
                {holding?.inTransit ? '全部在途' : '没有任何地点持有该物品'}
              </div>
            ) : (
              <div className="space-y-0.5 max-h-40 overflow-y-auto">
                {holding.byLocation.map((s) => (
                  <button
                    key={s.location}
                    onClick={() => setParams({ locationId: s.location })}
                    className="w-full flex items-center justify-between text-[10px] hover:bg-sky-500/10 px-1 rounded-sm"
                    title="记录为该地点焦点（仓库面板会用它作为默认）"
                  >
                    <span className="truncate text-slate-300">{s.label}</span>
                    <span className="mono text-emerald-300">{s.qty}</span>
                  </button>
                ))}
              </div>
            )}
            {!!holding?.inTransit && (
              <div className="text-[10px] text-amber-300/90 pt-0.5">在途 {holding.inTransit}</div>
            )}
          </div>

          <div className="border border-slate-800 bg-[#1b212b] p-2 rounded-sm space-y-1">
            <div className="text-[10px] text-slate-400 border-b border-slate-800 pb-1">
              我的挂单（{myOrders.length}）
            </div>
            {myOrders.length === 0 ? (
              <div className="text-[10px] text-slate-600 py-2">该物品没有挂单</div>
            ) : (
              <div className="space-y-0.5 max-h-40 overflow-y-auto">
                {myOrders.map((o) => (
                  <div key={o.order_id} className="flex items-center justify-between text-[10px] px-1">
                    <span className={o.side === 'buy' ? 'text-emerald-300' : 'text-rose-300'}>
                      {o.side === 'buy' ? '买' : '卖'} {moneyToCredits(o.price).toFixed(2)} × {o.qty}
                    </span>
                    <span className="text-slate-500 truncate ml-1">{world.stationLabel(o.station_id)}</span>
                  </div>
                ))}
              </div>
            )}
            <div className="text-[9px] text-slate-600 pt-0.5">
              跨全部站点的该物品挂单（这是原先只能在盘口逐个物品查看的总览）
            </div>
          </div>

          <div className="border border-slate-800 bg-[#1b212b] p-2 rounded-sm space-y-1">
            <div className="text-[10px] text-slate-400 border-b border-slate-800 pb-1">配方关系</div>
            <div className="text-[10px] text-slate-300">
              产出配方 <span className="text-sky-300 mono">{recipesOut.length}</span> 条 · 消耗配方{' '}
              <span className="text-rose-300 mono">{recipesIn.length}</span> 条
            </div>
            {recipesOut.length === 0 && recipesIn.length === 0 ? (
              <div className="text-[10px] text-slate-600">该物品不参与任何配方（可能只由城市消费）</div>
            ) : (
              <div className="space-y-1 max-h-40 overflow-y-auto">
                {recipesOut.slice(0, 6).map((r) => {
                  const line = recipeLine(r);
                  return (
                    <div key={r.id} className="text-[10px] leading-tight">
                      <span className="text-emerald-300">{line.building}</span>
                      <span className="text-slate-500"> · {r.cycle_ticks}回合 · </span>
                      <span className="text-slate-300">{line.inputs}</span>
                      <span className="text-slate-500"> → </span>
                      <span className="text-sky-300">{line.outputs}</span>
                    </div>
                  );
                })}
                {recipesIn.length > 0 && (
                  <div className="text-[9px] text-slate-500 pt-0.5">
                    被消耗于：{recipesIn.slice(0, 4).map((r) => catalog.buildingName(r.building_id)).join('、')}
                    {recipesIn.length > 4 ? ` 等 ${recipesIn.length} 条` : ''}
                  </div>
                )}
              </div>
            )}
          </div>
        </div>

        <div className="border border-slate-800 bg-[#1b212b] rounded-sm flex flex-col min-h-[140px]">
          <div className="px-2 py-1 border-b border-slate-800 flex items-center justify-between text-[10px] text-slate-400">
            <span>全站行情（{sortedQuotes.length} 个站点报价）</span>
            <span className="text-slate-600">点击站点行 → 在该站点打开行情</span>
          </div>
          <div className="px-2 py-1 grid grid-cols-[1fr_56px_56px_56px_50px] gap-1 text-[9px] text-slate-500 border-b border-slate-800/60">
            <span>站点</span>
            <span className="text-right">买一</span>
            <span className="text-right">卖一</span>
            <span className="text-right">最新</span>
            <span className="text-right">50回合量</span>
          </div>
          <VirtualList
            className="flex-1 min-h-0 overflow-y-auto"
            count={sortedQuotes.length}
            rowHeight={22}
            emptyState={
              <div className="px-2 py-4 text-[10px] text-slate-600">
                当前没有任何站点为它报过价（新物品或无人交易时是正常的）。
              </div>
            }
            renderRow={(idx) => {
              const q = sortedQuotes[idx];
              return (
                <div
                  onClick={() => openInPlace('ticker', { stationId: q.stationId })}
                  className="h-[22px] grid grid-cols-[1fr_56px_56px_56px_50px] gap-1 items-center px-2 text-[10px] cursor-pointer hover:bg-sky-500/10 border-b border-slate-800/30"
                >
                  <span className="truncate text-slate-300">{world.stationLabel(q.stationId)}</span>
                  <span className="text-right mono text-emerald-400/90">
                    {q.row.best_bid !== null ? q.row.best_bid.toFixed(2) : '--'}
                  </span>
                  <span className="text-right mono text-rose-400/90">
                    {q.row.best_ask !== null ? q.row.best_ask.toFixed(2) : '--'}
                  </span>
                  <span className="text-right mono text-sky-300">{q.row.last_price.toFixed(2)}</span>
                  <span className="text-right mono text-slate-400">{q.row.vol_50t || ''}</span>
                </div>
              );
            }}
          />
        </div>
      </div>
    </div>
  );
};

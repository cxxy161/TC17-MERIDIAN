import React, { useEffect, useState } from 'react';
import type { IDockviewPanelProps } from 'dockview-react';
import { useGameStore } from '../store/useGameStore';
import { openPane, type PaneParams } from '../layout/paneRegistry';
import { creditsToMoney, moneyToCredits, STATION_NAMES } from '../types/meridian';

export const OrderBookPanel: React.FC<IDockviewPanelProps<PaneParams>> = ({
  params,
  api,
  containerApi,
}) => {
  const catalog = useGameStore((s) => s.catalog);
  const state = useGameStore((s) => s.state);
  const watchBook = useGameStore((s) => s.watchBook);
  const books = useGameStore((s) => s.books);
  const sendIntent = useGameStore((s) => s.sendIntent);

  const [stationId, setStationId] = useState<string>(params.stationId || 'ST:HUB');
  const [itemId, setItemId] = useState<string>(params.itemId || 'steel');
  const [side, setSide] = useState<'buy' | 'sell'>('sell');
  const [priceStr, setPriceStr] = useState<string>('6.00');
  const [qtyStr, setQtyStr] = useState<string>('10');

  useEffect(() => {
    const unwatch = watchBook(stationId, itemId);
    return unwatch;
  }, [stationId, itemId, watchBook]);

  const book = books[`${stationId}::${itemId}`];
  const itemNames = new Map((catalog?.items ?? []).map((it) => [it.id, it.name]));
  const ownOrders = (state?.player_snapshot?.company.open_orders ?? []).filter(
    (o) => o.station_id === stationId && o.item_id === itemId,
  );

  const updateTitle = (sid: string, iid: string) => {
    api.setTitle(`盘口 · ${itemNames.get(iid) ?? iid} @ ${sid === 'ST:HUB' ? '枢纽' : sid}`);
  };

  const handleSubmit = () => {
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

  return (
    <div className="h-full flex flex-col bg-[#0b1119] text-slate-200 overflow-hidden">
      <div className="px-2.5 py-1.5 border-b border-sky-500/10 bg-[#0a111a] flex items-center justify-between gap-2 shrink-0 flex-wrap">
        <div className="flex items-center gap-1.5">
          <select
            value={stationId}
            onChange={(e) => {
              setStationId(e.target.value);
              updateTitle(e.target.value, itemId);
            }}
            className="bg-[#0e1724] border border-slate-700 text-[11px] px-1.5 py-0.5 rounded-sm"
          >
            {Object.entries(STATION_NAMES).map(([id, name]) => (
              <option key={id} value={id}>
                {name}
              </option>
            ))}
          </select>
          <select
            value={itemId}
            onChange={(e) => {
              setItemId(e.target.value);
              updateTitle(stationId, e.target.value);
            }}
            className="bg-[#0e1724] border border-slate-700 text-[11px] px-1.5 py-0.5 rounded-sm text-sky-300"
          >
            {(catalog?.items ?? []).map((it) => (
              <option key={it.id} value={it.id}>
                {it.name}
              </option>
            ))}
          </select>
        </div>

        <div className="flex items-center gap-2">
          <span className="text-[10px] mono text-emerald-400">站费 0.50%</span>
          <button
            onClick={() => openPane(containerApi, 'chart', { stationId, itemId })}
            className="pill-btn py-0 text-[10px]"
          >
            看K线
          </button>
        </div>
      </div>

      {/* Depth Book */}
      <div className="grid grid-cols-2 divide-x divide-slate-800/80 p-2.5 gap-2 mono text-[11px] border-b border-slate-800/80">
        <div className="space-y-1">
          <div className="text-[10px] text-emerald-400 font-semibold pb-0.5">买方深度</div>
          {(book?.bids ?? []).length === 0 ? (
            <div className="text-slate-600 text-[10px]">暂无买单</div>
          ) : (
            (book?.bids ?? []).slice(0, 8).map((l, idx) => (
              <div
                key={idx}
                onClick={() => setPriceStr(l.price.toFixed(2))}
                className="flex justify-between cursor-pointer hover:bg-emerald-500/10 px-1"
              >
                <span className="text-emerald-300">{l.price.toFixed(2)}</span>
                <span className="text-slate-400">{l.qty}</span>
              </div>
            ))
          )}
        </div>

        <div className="space-y-1 pl-2">
          <div className="text-[10px] text-rose-400 font-semibold pb-0.5">卖方深度</div>
          {(book?.asks ?? []).length === 0 ? (
            <div className="text-slate-600 text-[10px]">暂无卖单</div>
          ) : (
            (book?.asks ?? []).slice(0, 8).map((l, idx) => (
              <div
                key={idx}
                onClick={() => setPriceStr(l.price.toFixed(2))}
                className="flex justify-between cursor-pointer hover:bg-rose-500/10 px-1"
              >
                <span className="text-rose-300">{l.price.toFixed(2)}</span>
                <span className="text-slate-400">{l.qty}</span>
              </div>
            ))
          )}
        </div>
      </div>

      {/* Manual Order Form */}
      <div className="p-2 border-b border-slate-800/80 bg-[#080c12] flex items-center gap-1.5 shrink-0">
        <select
          value={side}
          onChange={(e) => setSide(e.target.value as 'buy' | 'sell')}
          className="bg-[#0e1724] border border-slate-700 px-1.5 py-1 text-[11px] rounded-sm"
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
          className="w-20 bg-[#070b11] border border-slate-700 px-1.5 py-1 text-[11px] mono text-right rounded-sm"
        />
        <input
          type="number"
          min="1"
          value={qtyStr}
          onChange={(e) => setQtyStr(e.target.value)}
          placeholder="数量"
          className="w-16 bg-[#070b11] border border-slate-700 px-1.5 py-1 text-[11px] mono text-right rounded-sm"
        />
        <button onClick={handleSubmit} className={side === 'buy' ? 'cta-green ml-auto' : 'cta-blue ml-auto'}>
          提交限价单
        </button>
      </div>

      {/* Own Active Orders & Recent Trades */}
      <div className="flex-1 overflow-y-auto p-2.5 space-y-3 text-[11px]">
        <div>
          <div className="text-[10px] text-slate-400 mb-1">我的当前挂单（永久有效，无48回合强制过期）</div>
          {ownOrders.length === 0 ? (
            <div className="text-[10px] text-slate-600">暂无挂单</div>
          ) : (
            <div className="space-y-1 mono">
              {ownOrders.map((o) => (
                <div key={o.order_id} className="metric-card flex items-center justify-between">
                  <span className={o.side === 'buy' ? 'text-emerald-400' : 'text-rose-400'}>
                    {o.side === 'buy' ? '买' : '卖'} · {moneyToCredits(o.price).toFixed(2)} × {o.qty}
                  </span>
                  <button
                    onClick={() => void sendIntent({ CancelOrder: { order_id: o.order_id } })}
                    className="pill-btn py-0 text-[10px]"
                  >
                    撤单
                  </button>
                </div>
              ))}
            </div>
          )}
        </div>

        <div>
          <div className="text-[10px] text-slate-400 mb-1">最近成交流水</div>
          {(book?.recent_trades ?? []).length === 0 ? (
            <div className="text-[10px] text-slate-600">暂无成交记录</div>
          ) : (
            <div className="space-y-1 mono text-[10px]">
              {(book?.recent_trades ?? []).slice(0, 12).map((tr, i) => (
                <div key={i} className="flex justify-between text-slate-400 border-b border-slate-800/50 pb-0.5">
                  <span>T#{tr.tick}</span>
                  <span className="text-sky-300">{tr.price.toFixed(2)} × {tr.qty}</span>
                  <span className="truncate max-w-[140px]">
                    {tr.seller_id} → {tr.buyer_id}
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

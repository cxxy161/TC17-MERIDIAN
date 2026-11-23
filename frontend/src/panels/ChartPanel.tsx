import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  createChart,
  ColorType,
  CrosshairMode,
  type IChartApi,
  type ISeriesApi,
  type UTCTimestamp,
} from 'lightweight-charts';
import { useGameStore } from '../store/useGameStore';
import type { PaneProps } from '../layout/paneRegistry';
import { STATION_NAMES, type CandleRow } from '../types/meridian';

function aggregateCandles(candles: CandleRow[], period: number): CandleRow[] {
  if (period <= 1 || candles.length === 0) return candles;
  const buckets = new Map<number, CandleRow>();
  for (const c of candles) {
    const b = Math.floor(c.bucket_tick / period) * period;
    const prev = buckets.get(b);
    if (!prev) {
      buckets.set(b, { ...c, bucket_tick: b });
    } else {
      prev.high = Math.max(prev.high, c.high);
      prev.low = Math.min(prev.low, c.low);
      prev.close = c.close;
      prev.volume += c.volume;
    }
  }
  return Array.from(buckets.values()).sort((a, b) => a.bucket_tick - b.bucket_tick);
}

export const ChartPanel: React.FC<PaneProps> = ({
  params,
  setTitle,
  openTemp,
}) => {
  const catalog = useGameStore((s) => s.catalog);
  const watchBook = useGameStore((s) => s.watchBook);
  const books = useGameStore((s) => s.books);

  const [stationId, setStationId] = useState<string>(params.stationId || 'ST:HUB');
  const [itemId, setItemId] = useState<string>(params.itemId || 'steel');
  const [period, setPeriod] = useState<number>(1);

  const containerRef = useRef<HTMLDivElement | null>(null);
  const chartRef = useRef<IChartApi | null>(null);
  const candleSeriesRef = useRef<ISeriesApi<'Candlestick'> | null>(null);
  const smaSeriesRef = useRef<ISeriesApi<'Line'> | null>(null);
  const volSeriesRef = useRef<ISeriesApi<'Histogram'> | null>(null);

  useEffect(() => {
    const unwatch = watchBook(stationId, itemId);
    return unwatch;
  }, [stationId, itemId, watchBook]);

  const itemMap = new Map((catalog?.items ?? []).map((i) => [i.id, i.name]));

  const updateTitle = (sid: string, iid: string) => {
    const itemName = itemMap.get(iid) ?? iid;
    const stName = sid === 'ST:HUB' ? '枢纽' : sid;
    setTitle(`K线 · ${itemName} @ ${stName}`);
  };

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;

    const chart = createChart(el, {
      layout: {
        background: { type: ColorType.Solid, color: '#191f27' },
        textColor: '#94a3b8',
        fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
        fontSize: 11,
      },
      grid: {
        vertLines: { color: 'rgba(56, 189, 248, 0.08)' },
        horzLines: { color: 'rgba(56, 189, 248, 0.08)' },
      },
      crosshair: { mode: CrosshairMode.Normal },
      rightPriceScale: { borderColor: 'rgba(56, 189, 248, 0.16)' },
      timeScale: { borderColor: 'rgba(56, 189, 248, 0.16)', timeVisible: false },
    });

    const candleSeries = chart.addCandlestickSeries({
      upColor: '#10b981',
      downColor: '#f43f5e',
      borderUpColor: '#10b981',
      borderDownColor: '#f43f5e',
      wickUpColor: '#10b981',
      wickDownColor: '#f43f5e',
    });

    const smaSeries = chart.addLineSeries({
      color: '#38bdf8',
      lineWidth: 2,
      priceLineVisible: false,
      lastValueVisible: true,
    });

    const volSeries = chart.addHistogramSeries({
      priceFormat: { type: 'volume' },
      priceScaleId: '',
    });
    volSeries.priceScale().applyOptions({
      scaleMargins: { top: 0.78, bottom: 0 },
    });

    chartRef.current = chart;
    candleSeriesRef.current = candleSeries;
    smaSeriesRef.current = smaSeries;
    volSeriesRef.current = volSeries;

    const ro = new ResizeObserver((entries) => {
      const rect = entries[0]?.contentRect;
      if (rect && rect.width > 0 && rect.height > 0) {
        chart.applyOptions({ width: Math.floor(rect.width), height: Math.floor(rect.height) });
      }
    });
    ro.observe(el);

    return () => {
      ro.disconnect();
      chart.remove();
      chartRef.current = null;
    };
  }, []);

  const book = books[`${stationId}::${itemId}`];
  const agg = useMemo(
    () => aggregateCandles(book?.candles ?? [], period),
    [book?.candles, period],
  );

  useEffect(() => {
    if (!candleSeriesRef.current || !smaSeriesRef.current || !volSeriesRef.current) return;
    if (agg.length === 0) {
      candleSeriesRef.current.setData([]);
      smaSeriesRef.current.setData([]);
      volSeriesRef.current.setData([]);
      return;
    }

    const toTime = (t: number) => (1_700_000_000 + t * 60) as UTCTimestamp;
    candleSeriesRef.current.setData(
      agg.map((c) => ({
        time: toTime(c.bucket_tick),
        open: c.open,
        high: c.high,
        low: c.low,
        close: c.close,
      })),
    );
    volSeriesRef.current.setData(
      agg.map((c) => ({
        time: toTime(c.bucket_tick),
        value: c.volume,
        color: c.close >= c.open ? 'rgba(16, 185, 129, 0.25)' : 'rgba(244, 63, 94, 0.25)',
      })),
    );
    smaSeriesRef.current.setData(
      agg.map((c, idx) => {
        const win = agg.slice(Math.max(0, idx - 9), idx + 1);
        const avg = win.reduce((s, x) => s + x.close, 0) / win.length;
        return { time: toTime(c.bucket_tick), value: avg };
      }),
    );
    chartRef.current?.timeScale().fitContent();
  }, [agg]);

  const latest = agg[agg.length - 1];

  return (
    <div className="h-full flex flex-col bg-[#191f27] text-slate-200 overflow-hidden">
      <div className="px-2.5 py-1.5 border-b border-sky-500/10 bg-[#232a36] flex items-center justify-between gap-2 shrink-0 flex-wrap">
        <div className="flex items-center gap-1.5">
          <select
            value={stationId}
            onChange={(e) => {
              setStationId(e.target.value);
              updateTitle(e.target.value, itemId);
            }}
            className="bg-[#27303e] border border-slate-700 text-[11px] px-1.5 py-0.5 rounded-sm"
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
            className="bg-[#27303e] border border-slate-700 text-[11px] px-1.5 py-0.5 rounded-sm text-sky-300"
          >
            {(catalog?.items ?? []).map((it) => (
              <option key={it.id} value={it.id}>
                {it.name}
              </option>
            ))}
          </select>
        </div>

        <div className="flex items-center gap-1">
          {[1, 5, 15].map((p) => (
            <button
              key={p}
              onClick={() => setPeriod(p)}
              className={`pill-btn py-0 text-[10px] ${period === p ? 'active' : ''}`}
            >
              {p}回合
            </button>
          ))}
          <button
            onClick={() => openTemp('orderbook', { stationId, itemId })}
            className="pill-btn py-0 text-[10px] text-emerald-300"
          >
            打开盘口
          </button>
        </div>
      </div>

      {/* OHLCV Readout */}
      <div className="px-3 py-1 bg-[#1f2630] border-b border-slate-800/70 flex items-center justify-between text-[11px] mono shrink-0">
        {latest ? (
          <span className="text-slate-300">
            开 {latest.open.toFixed(2)} · 高 <span className="text-emerald-400">{latest.high.toFixed(2)}</span> · 低{' '}
            <span className="text-rose-400">{latest.low.toFixed(2)}</span> · 收{' '}
            <span className="text-sky-400">{latest.close.toFixed(2)}</span> · 量 {latest.volume}
          </span>
        ) : (
          <span className="text-slate-500">
            最新参考价 {book ? book.last_price.toFixed(2) : '--'} · 暂无 K 线成交
          </span>
        )}
        <span className="text-sky-400">
          均线 {book ? book.ema_fast.toFixed(2) : '--'}
        </span>
      </div>

      <div className="flex-1 min-h-0 relative">
        <div ref={containerRef} className="w-full h-full" />
        {agg.length === 0 && (
          <div className="absolute inset-0 flex items-center justify-center pointer-events-none text-slate-500 text-[11px]">
            等待市场撮合产生该物品 K 线数据...
          </div>
        )}
      </div>
    </div>
  );
};

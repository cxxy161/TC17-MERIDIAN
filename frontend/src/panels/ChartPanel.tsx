import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  createChart,
  ColorType,
  CrosshairMode,
  LineStyle,
  type IChartApi,
  type IPriceLine,
  type ISeriesApi,
  type Time,
  type UTCTimestamp,
} from 'lightweight-charts';
import { useGameStore } from '../store/useGameStore';
import type { PaneProps } from '../layout/paneRegistry';
import { STATION_NAMES, type CandleRow } from '../types/meridian';

const BASE_TS = 1_700_000_000;
const toTime = (t: number): UTCTimestamp => (BASE_TS + t * 60) as UTCTimestamp;
const fromTime = (ts: Time): string => {
  if (typeof ts === 'number') {
    return `T${Math.max(0, Math.round((ts - BASE_TS) / 60))}`;
  }
  return String(ts);
};

function aggregateCandles(candles: CandleRow[], period: number): CandleRow[] {
  if (candles.length === 0) return [];
  const step = Math.max(1, period);
  const sorted = [...candles].sort((a, b) => a.bucket_tick - b.bucket_tick);
  const buckets = new Map<number, CandleRow>();
  for (const c of sorted) {
    const b = Math.floor(c.bucket_tick / step) * step;
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
  const state = useGameStore((s) => s.state);
  const watchBook = useGameStore((s) => s.watchBook);
  const books = useGameStore((s) => s.books);
  const quoteHistory = useGameStore((s) => s.quoteHistory);

  const [stationId, setStationId] = useState<string>(params.stationId || 'ST:HUB');
  const [itemId, setItemId] = useState<string>(params.itemId || 'steel');
  const [period, setPeriod] = useState<number>(1);
  const [hoverCandle, setHoverCandle] = useState<{
    tick: string;
    open: number;
    high: number;
    low: number;
    close: number;
    volume?: number;
  } | null>(null);

  useEffect(() => {
    if (params.stationId) setStationId(params.stationId);
    if (params.itemId) setItemId(params.itemId);
  }, [params.stationId, params.itemId]);

  const containerRef = useRef<HTMLDivElement | null>(null);
  const chartRef = useRef<IChartApi | null>(null);
  const candleSeriesRef = useRef<ISeriesApi<'Candlestick'> | null>(null);
  const smaSeriesRef = useRef<ISeriesApi<'Line'> | null>(null);
  const volSeriesRef = useRef<ISeriesApi<'Histogram'> | null>(null);
  const priceLinesRef = useRef<IPriceLine[]>([]);
  const loadedKeyRef = useRef<string>('');
  const lastCandleTickRef = useRef<number>(-1);
  const lastSampleTickRef = useRef<number>(-1);
  const volByTimeRef = useRef<Map<number, number>>(new Map());

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
      width: Math.max(el.clientWidth, 240),
      height: Math.max(el.clientHeight, 160),
      layout: {
        attributionLogo: false,
        background: { type: ColorType.Solid, color: '#191f27' },
        textColor: '#94a3b8',
        fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
        fontSize: 11,
      },
      localization: {
        timeFormatter: (time: Time) => fromTime(time),
      },
      grid: {
        vertLines: { color: 'rgba(148, 163, 184, 0.08)' },
        horzLines: { color: 'rgba(148, 163, 184, 0.08)' },
      },
      crosshair: { mode: CrosshairMode.Normal },
      rightPriceScale: {
        borderColor: 'rgba(148, 163, 184, 0.18)',
        autoScale: true,
        scaleMargins: { top: 0.12, bottom: 0.22 },
      },
      timeScale: {
        borderColor: 'rgba(148, 163, 184, 0.18)',
        barSpacing: 12,
        minBarSpacing: 2,
        rightOffset: 6,
        timeVisible: false,
        tickMarkFormatter: (time: Time) => fromTime(time),
      },
    });

    const candleSeries = chart.addCandlestickSeries({
      upColor: '#3fb950',
      downColor: '#f85149',
      borderVisible: false,
      wickUpColor: '#3fb950',
      wickDownColor: '#f85149',
      priceFormat: { type: 'price', precision: 2, minMove: 0.01 },
    });

    const smaSeries = chart.addLineSeries({
      color: '#58a6ff',
      lineWidth: 1,
      priceLineVisible: false,
      lastValueVisible: false,
      priceFormat: { type: 'price', precision: 2, minMove: 0.01 },
    });

    const volSeries = chart.addHistogramSeries({
      priceFormat: { type: 'volume' },
      priceScaleId: '',
      priceLineVisible: false,
      lastValueVisible: false,
    });
    volSeries.priceScale().applyOptions({
      scaleMargins: { top: 0.8, bottom: 0 },
    });

    chart.subscribeCrosshairMove((param) => {
      if (!param || !param.time) {
        setHoverCandle(null);
        return;
      }
      const d = param.seriesData.get(candleSeries) as
        | { open: number; high: number; low: number; close: number }
        | undefined;
      if (d && typeof d.open === 'number') {
        const vol =
          typeof param.time === 'number' ? volByTimeRef.current.get(param.time) : undefined;
        setHoverCandle({
          tick: fromTime(param.time),
          open: d.open,
          high: d.high,
          low: d.low,
          close: d.close,
          volume: vol,
        });
      } else {
        setHoverCandle(null);
      }
    });

    chartRef.current = chart;
    candleSeriesRef.current = candleSeries;
    smaSeriesRef.current = smaSeries;
    volSeriesRef.current = volSeries;

    const ro = new ResizeObserver((entries) => {
      const rect = entries[0]?.contentRect;
      if (rect && rect.width > 0 && rect.height > 0) {
        chart.applyOptions({
          width: Math.floor(rect.width),
          height: Math.floor(rect.height),
        });
      }
    });
    ro.observe(el);

    return () => {
      ro.disconnect();
      priceLinesRef.current = [];
      chart.remove();
      chartRef.current = null;
    };
  }, []);

  const bookKey = `${stationId}::${itemId}`;
  const book = books[bookKey];
  const samples = quoteHistory[bookKey];
  const tickerRow = (state?.market_tickers ?? []).find(
    (t) => t.station_id === stationId && t.item_id === itemId,
  );
  const currentTick = state?.tick ?? 0;

  const agg = useMemo(
    () => aggregateCandles(book?.candles ?? [], period),
    [book?.candles, period],
  );

  const refPrice = book?.last_price ?? tickerRow?.last_price;
  const bestBid = book?.best_bid ?? tickerRow?.best_bid ?? null;
  const bestAsk = book?.best_ask ?? tickerRow?.best_ask ?? null;

  // Separate effect for updating series data WITHOUT stealing user pan/zoom state!
  useEffect(() => {
    const candleSeries = candleSeriesRef.current;
    const smaSeries = smaSeriesRef.current;
    const volSeries = volSeriesRef.current;
    const chart = chartRef.current;
    if (!candleSeries || !smaSeries || !volSeries || !chart) return;

    const mode = agg.length > 0 ? 'candle' : 'ref';
    const key = `${stationId}::${itemId}::${period}::${mode}`;
    const isInitialOrSwitch = loadedKeyRef.current !== key;

    const precision = (refPrice ?? 10) < 10 ? 4 : 2;
    const minMove = precision === 4 ? 0.0001 : 0.01;
    candleSeries.applyOptions({ priceFormat: { type: 'price', precision, minMove } });
    smaSeries.applyOptions({
      lastValueVisible: agg.length === 0,
      priceFormat: { type: 'price', precision, minMove },
    });

    if (agg.length > 0) {
      const nextVolMap = new Map<number, number>();
      for (const c of agg) {
        nextVolMap.set(toTime(c.bucket_tick), c.volume);
      }
      volByTimeRef.current = nextVolMap;

      const latestTick = agg[agg.length - 1].bucket_tick;
      const tickWentBackwards = latestTick < lastCandleTickRef.current;

      if (isInitialOrSwitch || tickWentBackwards) {
        candleSeries.setData(
          agg.map((c) => ({
            time: toTime(c.bucket_tick),
            open: c.open,
            high: c.high,
            low: c.low,
            close: c.close,
          })),
        );
        volSeries.setData(
          agg.map((c) => ({
            time: toTime(c.bucket_tick),
            value: c.volume,
            color: c.close >= c.open ? 'rgba(63, 185, 80, 0.35)' : 'rgba(248, 81, 73, 0.35)',
          })),
        );
        smaSeries.setData(
          agg.map((c, idx) => {
            const win = agg.slice(Math.max(0, idx - 9), idx + 1);
            const avg = win.reduce((s, x) => s + x.close, 0) / win.length;
            return { time: toTime(c.bucket_tick), value: avg };
          }),
        );

        loadedKeyRef.current = key;
        if (agg.length > 20) {
          chart.timeScale().fitContent();
        } else {
          chart.timeScale().applyOptions({ barSpacing: 14, rightOffset: 6 });
          chart.timeScale().scrollToRealTime();
        }
      } else {
        for (let i = 0; i < agg.length; i++) {
          const c = agg[i];
          if (c.bucket_tick < lastCandleTickRef.current) continue;
          const time = toTime(c.bucket_tick);
          candleSeries.update({
            time,
            open: c.open,
            high: c.high,
            low: c.low,
            close: c.close,
          });
          volSeries.update({
            time,
            value: c.volume,
            color: c.close >= c.open ? 'rgba(63, 185, 80, 0.35)' : 'rgba(248, 81, 73, 0.35)',
          });
          const win = agg.slice(Math.max(0, i - 9), i + 1);
          const avg = win.reduce((s, x) => s + x.close, 0) / win.length;
          smaSeries.update({ time, value: avg });
        }
      }
      lastCandleTickRef.current = latestTick;
      lastSampleTickRef.current = -1;
    } else {
      volByTimeRef.current.clear();
      const sortedSamples =
        samples && samples.length >= 2 ? [...samples].sort((a, b) => a.tick - b.tick) : null;

      if (isInitialOrSwitch) {
        candleSeries.setData([]);
        volSeries.setData([]);
        if (sortedSamples) {
          smaSeries.setData(
            sortedSamples.map((s) => ({ time: toTime(s.tick), value: s.price })),
          );
          lastSampleTickRef.current = sortedSamples[sortedSamples.length - 1].tick;
        } else if (refPrice !== undefined && refPrice > 0) {
          const endT = Math.max(1, currentTick);
          const startT = Math.max(0, endT - 20);
          const pts: Array<{ time: UTCTimestamp; value: number }> = [];
          const stepT = Math.max(1, Math.floor((endT - startT) / 10));
          for (let t = startT; t <= endT; t += stepT) {
            pts.push({ time: toTime(t), value: refPrice });
          }
          if (pts[pts.length - 1].time !== toTime(endT)) {
            pts.push({ time: toTime(endT), value: refPrice });
          }
          smaSeries.setData(pts);
          lastSampleTickRef.current = endT;
        } else {
          smaSeries.setData([]);
          lastSampleTickRef.current = -1;
        }
        loadedKeyRef.current = key;
        chart.timeScale().applyOptions({ barSpacing: 14, rightOffset: 6 });
        chart.timeScale().scrollToRealTime();
      } else if (sortedSamples) {
        const latest = sortedSamples[sortedSamples.length - 1];
        if (latest.tick < lastSampleTickRef.current) {
          smaSeries.setData(
            sortedSamples.map((s) => ({ time: toTime(s.tick), value: s.price })),
          );
          lastSampleTickRef.current = latest.tick;
        } else {
          for (const s of sortedSamples) {
            if (s.tick >= lastSampleTickRef.current) {
              smaSeries.update({ time: toTime(s.tick), value: s.price });
              lastSampleTickRef.current = s.tick;
            }
          }
        }
      } else if (refPrice !== undefined && refPrice > 0 && currentTick > lastSampleTickRef.current) {
        smaSeries.update({ time: toTime(currentTick), value: refPrice });
        lastSampleTickRef.current = currentTick;
      }
      lastCandleTickRef.current = -1;
    }
  }, [agg, samples, refPrice, currentTick, stationId, itemId, period]);

  // Separate effect for bid/ask horizontal lines so they never trigger chart zoom reset
  useEffect(() => {
    const smaSeries = smaSeriesRef.current;
    if (!smaSeries) return;
    for (const pl of priceLinesRef.current) {
      try {
        smaSeries.removePriceLine(pl);
      } catch {
        // ignore if already detached
      }
    }
    priceLinesRef.current = [];

    if (bestBid !== null) {
      priceLinesRef.current.push(
        smaSeries.createPriceLine({
          price: bestBid,
          color: 'rgba(63, 185, 80, 0.75)',
          lineWidth: 1,
          lineStyle: LineStyle.Dashed,
          axisLabelVisible: true,
          title: '买一',
        }),
      );
    }
    if (bestAsk !== null) {
      priceLinesRef.current.push(
        smaSeries.createPriceLine({
          price: bestAsk,
          color: 'rgba(248, 81, 73, 0.75)',
          lineWidth: 1,
          lineStyle: LineStyle.Dashed,
          axisLabelVisible: true,
          title: '卖一',
        }),
      );
    }
  }, [bestBid, bestAsk]);

  const latest = agg[agg.length - 1];
  const shownBar = hoverCandle ?? (latest ? { ...latest, tick: `T${latest.bucket_tick}` } : null);
  const priceDigits = (refPrice ?? 10) < 10 ? 4 : 2;

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
            onClick={() => chartRef.current?.timeScale().scrollToRealTime()}
            className="pill-btn py-0 text-[10px]"
            title="回到最新回合位置"
          >
            最新
          </button>
          <button
            onClick={() => openTemp('orderbook', { stationId, itemId })}
            className="pill-btn py-0 text-[10px] text-[#3fb950]"
          >
            打开盘口
          </button>
        </div>
      </div>

      {/* OHLCV Readout */}
      <div className="px-3 py-1 bg-[#1f2630] border-b border-slate-800/70 flex items-center justify-between text-[11px] mono shrink-0">
        {shownBar ? (
          <span className="text-slate-300">
            <span className="text-slate-500 mr-1.5">{shownBar.tick}</span>
            开 {shownBar.open.toFixed(priceDigits)} · 高{' '}
            <span className="text-[#3fb950]">{shownBar.high.toFixed(priceDigits)}</span> · 低{' '}
            <span className="text-[#f85149]">{shownBar.low.toFixed(priceDigits)}</span> · 收{' '}
            <span className={shownBar.close >= shownBar.open ? 'text-[#3fb950]' : 'text-[#f85149]'}>
              {shownBar.close.toFixed(priceDigits)}
            </span>
            {shownBar.volume !== undefined ? ` · 量 ${shownBar.volume}` : ''}
          </span>
        ) : (
          <span className="text-slate-400">
            参考价 {refPrice !== undefined ? refPrice.toFixed(priceDigits) : '--'}
            {bestBid !== null ? ` · 买一 ${bestBid.toFixed(priceDigits)}` : ''}
            {bestAsk !== null ? ` · 卖一 ${bestAsk.toFixed(priceDigits)}` : ''}
            {' · '}暂无撮合 K 线
          </span>
        )}
        <span className="text-[#58a6ff]">
          均线 {book ? book.ema_fast.toFixed(priceDigits) : '--'}
        </span>
      </div>

      <div className="flex-1 min-h-0 relative">
        <div ref={containerRef} className="w-full h-full" />
        {agg.length === 0 && (
          <div className="absolute top-2 left-2.5 z-10 pointer-events-none px-2 py-0.5 rounded bg-[#1f2630]/85 border border-slate-700/70 text-slate-400 text-[10px]">
            暂无撮合成交 K 线 · 显示实时参考价与盘口报价线
          </div>
        )}
      </div>
    </div>
  );
};

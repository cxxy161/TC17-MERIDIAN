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
import { useGameStore, type QuoteSample } from '../store/useGameStore';
import type { PaneProps } from '../layout/paneRegistry';
import { STATION_NAMES, type CandleRow } from '../types/meridian';

const BASE_TS = 1_700_000_000;
const WINDOW_BARS = 50;

const toTime = (t: number): UTCTimestamp => (BASE_TS + t * 60) as UTCTimestamp;
const fromTime = (ts: Time): string => {
  if (typeof ts === 'number') {
    return `T${Math.max(0, Math.round((ts - BASE_TS) / 60))}`;
  }
  return String(ts);
};

interface DisplayBar extends CandleRow {
  isReal: boolean;
}

function buildDisplayCandles(
  rawCandles: CandleRow[],
  samples: QuoteSample[] | undefined,
  refPrice: number | undefined,
  currentTick: number,
  period: number,
): { bars: DisplayBar[]; realCount: number } {
  const step = Math.max(1, period);
  const sortedRaw = [...rawCandles].sort((a, b) => a.bucket_tick - b.bucket_tick);
  const realBuckets = new Map<number, DisplayBar>();
  for (const c of sortedRaw) {
    const b = Math.floor(c.bucket_tick / step) * step;
    const prev = realBuckets.get(b);
    if (!prev) {
      realBuckets.set(b, { ...c, bucket_tick: b, isReal: true });
    } else {
      prev.high = Math.max(prev.high, c.high);
      prev.low = Math.min(prev.low, c.low);
      prev.close = c.close;
      prev.volume += c.volume;
    }
  }

  const realList = Array.from(realBuckets.values()).sort((a, b) => a.bucket_tick - b.bucket_tick);
  const lastReal = realList[realList.length - 1];
  const effectiveTick = Math.max(currentTick, lastReal?.bucket_tick ?? 0);
  const curBucket = Math.floor(effectiveTick / step) * step;

  // Need a fallback price when no real trade happened in a bucket
  const basePrice = refPrice ?? lastReal?.close;
  if (realList.length === 0 && (basePrice === undefined || basePrice <= 0)) {
    return { bars: [], realCount: 0 };
  }

  // Index quote samples by bucket so any reference price drift in no-trade ticks shows up
  const sampleBuckets = new Map<number, QuoteSample[]>();
  for (const s of samples ?? []) {
    const b = Math.floor(s.tick / step) * step;
    const list = sampleBuckets.get(b);
    if (list) list.push(s);
    else sampleBuckets.set(b, [s]);
  }

  const windowStart = Math.max(0, curBucket - (WINDOW_BARS - 1) * step);
  const out: DisplayBar[] = [];

  // Keep any earlier real trade candles before the trailing live window
  for (const rc of realList) {
    if (rc.bucket_tick < windowStart) {
      out.push(rc);
    }
  }

  // Carry forward into trailing window up to live curBucket so chart always tracks currentTick
  let carryPrice =
    out.length > 0 ? out[out.length - 1].close : (basePrice ?? 0);

  for (let b = windowStart; b <= curBucket; b += step) {
    const realBar = realBuckets.get(b);
    if (realBar) {
      out.push(realBar);
      carryPrice = realBar.close;
      continue;
    }
    const bucketSamples = sampleBuckets.get(b);
    if (bucketSamples && bucketSamples.length > 0) {
      const open = bucketSamples[0].price;
      let high = open;
      let low = open;
      for (const s of bucketSamples) {
        if (s.price > high) high = s.price;
        if (s.price < low) low = s.price;
      }
      const close = bucketSamples[bucketSamples.length - 1].price;
      carryPrice = close;
      out.push({
        bucket_tick: b,
        open,
        high,
        low,
        close,
        volume: 0,
        isReal: false,
      });
    } else if (carryPrice > 0) {
      out.push({
        bucket_tick: b,
        open: carryPrice,
        high: carryPrice,
        low: carryPrice,
        close: carryPrice,
        volume: 0,
        isReal: false,
      });
    }
  }

  return { bars: out, realCount: realList.length };
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
  const lastBarTickRef = useRef<number>(-1);
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
        barSpacing: 9,
        minBarSpacing: 2,
        rightOffset: 4,
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

  const refPrice = book?.last_price ?? tickerRow?.last_price;
  const bestBid = book?.best_bid ?? tickerRow?.best_bid ?? null;
  const bestAsk = book?.best_ask ?? tickerRow?.best_ask ?? null;

  const { bars, realCount } = useMemo(
    () => buildDisplayCandles(book?.candles ?? [], samples, refPrice, currentTick, period),
    [book?.candles, samples, refPrice, currentTick, period],
  );

  // Push initial setData on switch, then incremental .update() on every live tick without locking pan/zoom
  useEffect(() => {
    const candleSeries = candleSeriesRef.current;
    const smaSeries = smaSeriesRef.current;
    const volSeries = volSeriesRef.current;
    const chart = chartRef.current;
    if (!candleSeries || !smaSeries || !volSeries || !chart) return;

    const precision = (refPrice ?? 10) < 10 ? 4 : 2;
    const minMove = precision === 4 ? 0.0001 : 0.01;
    candleSeries.applyOptions({ priceFormat: { type: 'price', precision, minMove } });
    smaSeries.applyOptions({ priceFormat: { type: 'price', precision, minMove } });

    if (bars.length === 0) {
      candleSeries.setData([]);
      volSeries.setData([]);
      smaSeries.setData([]);
      volByTimeRef.current.clear();
      lastBarTickRef.current = -1;
      return;
    }

    const nextVolMap = new Map<number, number>();
    for (const c of bars) {
      nextVolMap.set(toTime(c.bucket_tick), c.volume);
    }
    volByTimeRef.current = nextVolMap;

    const key = `${stationId}::${itemId}::${period}::${book && book.candles.length > 0 ? 'hasCandles' : 'flat'}`;
    const latestTick = bars[bars.length - 1].bucket_tick;
    const isSwitch = loadedKeyRef.current !== key;
    const tickReset = latestTick < lastBarTickRef.current;

    if (isSwitch || tickReset) {
      candleSeries.setData(
        bars.map((c) => ({
          time: toTime(c.bucket_tick),
          open: c.open,
          high: c.high,
          low: c.low,
          close: c.close,
        })),
      );
      volSeries.setData(
        bars.map((c) => ({
          time: toTime(c.bucket_tick),
          value: c.volume,
          color: c.close >= c.open ? 'rgba(63, 185, 80, 0.35)' : 'rgba(248, 81, 73, 0.35)',
        })),
      );
      smaSeries.setData(
        bars.map((c, idx) => {
          const win = bars.slice(Math.max(0, idx - 9), idx + 1);
          const avg = win.reduce((s, x) => s + x.close, 0) / win.length;
          return { time: toTime(c.bucket_tick), value: avg };
        }),
      );
      loadedKeyRef.current = key;
      chart.timeScale().applyOptions({ barSpacing: 9, rightOffset: 4 });
      chart.timeScale().fitContent();
    } else {
      for (let i = 0; i < bars.length; i++) {
        const c = bars[i];
        if (c.bucket_tick < lastBarTickRef.current) continue;
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
        const win = bars.slice(Math.max(0, i - 9), i + 1);
        const avg = win.reduce((s, x) => s + x.close, 0) / win.length;
        smaSeries.update({ time, value: avg });
      }
    }
    lastBarTickRef.current = latestTick;
  }, [bars, book, refPrice, stationId, itemId, period]);

  // Bid / Ask horizontal lines kept independent from pan/zoom state
  useEffect(() => {
    const smaSeries = smaSeriesRef.current;
    if (!smaSeries) return;
    for (const pl of priceLinesRef.current) {
      try {
        smaSeries.removePriceLine(pl);
      } catch {
        // ignore if detached
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

  const latest = bars[bars.length - 1];
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
          <span className="text-slate-400">加载市场行情中...</span>
        )}
        <span className="text-[#58a6ff]">
          均线 {book ? book.ema_fast.toFixed(priceDigits) : '--'}
        </span>
      </div>

      <div className="flex-1 min-h-0 relative">
        <div ref={containerRef} className="w-full h-full" />
        {realCount === 0 && (
          <div className="absolute top-2 left-2.5 z-10 pointer-events-none px-2 py-0.5 rounded bg-[#1f2630]/85 border border-slate-700/70 text-slate-400 text-[10px]">
            暂无新成交 · 当前按参考价随回合推进
          </div>
        )}
      </div>
    </div>
  );
};

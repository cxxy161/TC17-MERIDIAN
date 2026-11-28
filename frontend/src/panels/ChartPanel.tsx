import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  createChart,
  ColorType,
  CrosshairMode,
  LineStyle,
  type AutoscaleInfo,
  type CandlestickData,
  type IChartApi,
  type IPriceLine,
  type ISeriesApi,
  type LogicalRange,
  type MouseEventParams,
  type Time,
  type UTCTimestamp,
} from 'lightweight-charts';
import { api } from '../api/client';
import { useGameStore, type QuoteSample } from '../store/useGameStore';
import type { PaneProps } from '../layout/paneRegistry';
import type { CandleRow } from '../types/meridian';
import { useCatalogIndex, useWorldIndex } from '../entities/hooks';
import { SearchSelect, type PickerOption } from '../components/SearchSelect';
import { isCoarsePointer } from '../utils/useDragPointer';

// Exact UTC midnight (2024-01-01 00:00:00 UTC) so minute-stepped ticks align cleanly.
const BASE_TS = 1_704_067_200;
const INITIAL_BUCKETS = 400;
const PAGE_BUCKETS = 600;
const DEFAULT_VISIBLE_BARS = 64;
const MAX_ALL_HISTORY_BARS = 6000;
const PERIOD_OPTIONS = [1, 5, 15, 60] as const;
const CHART_PERIOD_STORAGE_KEY = 'meridian.chart.period.v1';

function loadSavedPeriod(): number {
  try {
    const raw = window.localStorage.getItem(CHART_PERIOD_STORAGE_KEY);
    if (!raw) return 1;
    const n = Number(raw);
    if ((PERIOD_OPTIONS as readonly number[]).includes(n)) return n;
  } catch {
    // ignore storage errors
  }
  return 1;
}

function savePeriodPref(period: number): void {
  try {
    window.localStorage.setItem(CHART_PERIOD_STORAGE_KEY, String(period));
  } catch {
    // ignore storage errors
  }
}

const UP_COLOR = '#3fb950';
const DOWN_COLOR = '#f85149';
const FLAT_COLOR = '#64748b';

const toTime = (tick: number): UTCTimestamp => (BASE_TS + tick * 60) as UTCTimestamp;
const fromTimeNum = (ts: number): number => Math.max(0, Math.round((ts - BASE_TS) / 60));
const fromTime = (ts: Time): string => {
  if (typeof ts === 'number') {
    return `T${fromTimeNum(ts)}`;
  }
  return String(ts);
};

interface DisplayBar extends CandleRow {
  isReal: boolean;
  ma10: number;
  prevClose: number;
}

interface HistorySlice {
  key: string;
  stationId: string;
  itemId: string;
  period: number;
  loadedFromBucket: number;
  loadedToBucket: number;
  prevCloseBeforeLoaded: number | null;
  refPrice: number;
  earliestTradeTick: number | null;
  latestTradeTick: number | null;
  totalTradeTicks: number;
  realByBucket: Map<number, CandleRow>;
  apiSupported: boolean;
}

interface RenderedMeta {
  key: string;
  firstBucket: number;
  lastBucket: number;
  realSigs: Map<number, string>;
}

interface HoverReadout {
  tick: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  ma10: number;
  prevClose: number;
  isReal: boolean;
}

function aggregateIntoBuckets(rows: CandleRow[], step: number): Map<number, CandleRow> {
  const sorted = [...rows].sort((a, b) => a.bucket_tick - b.bucket_tick);
  const out = new Map<number, CandleRow>();
  for (const c of sorted) {
    const b = Math.floor(c.bucket_tick / step) * step;
    const prev = out.get(b);
    if (!prev) {
      out.set(b, { ...c, bucket_tick: b });
    } else {
      prev.high = Math.max(prev.high, c.high);
      prev.low = Math.min(prev.low, c.low);
      prev.close = c.close;
      prev.volume += c.volume;
    }
  }
  return out;
}

function computePriceDigits(price: number | undefined): number {
  if (price === undefined || !Number.isFinite(price) || price <= 0) return 2;
  if (price < 1) return 4;
  if (price < 10) return 4;
  return 2;
}

function toCandlePoint(bar: DisplayBar): CandlestickData<Time> {
  const time = toTime(bar.bucket_tick);
  if (!bar.isReal) {
    return {
      time,
      open: bar.open,
      high: bar.high,
      low: bar.low,
      close: bar.close,
      color: FLAT_COLOR,
      borderColor: FLAT_COLOR,
      wickColor: FLAT_COLOR,
    };
  }
  const c = bar.close >= bar.open ? UP_COLOR : DOWN_COLOR;
  return {
    time,
    open: bar.open,
    high: bar.high,
    low: bar.low,
    close: bar.close,
    color: c,
    borderColor: c,
    wickColor: c,
  };
}

function buildContinuousBars(
  slice: HistorySlice | null,
  bookCandles: CandleRow[],
  samples: QuoteSample[] | undefined,
  fallbackPrice: number | undefined,
  currentTick: number,
  period: number,
): {
  bars: DisplayBar[];
  realSigs: Map<number, string>;
  latestTradeTick: number | null;
  earliestTradeTick: number | null;
  effectiveTick: number;
} {
  const step = Math.max(1, period);

  // Merge backend historical slice + live book.candles for the forming/recent tail
  const realByBucket = new Map<number, CandleRow>();
  if (slice) {
    for (const [b, row] of slice.realByBucket) {
      realByBucket.set(b, row);
    }
  }

  const liveAgg = aggregateIntoBuckets(bookCandles, step);
  const effectiveSeedTick = Math.max(currentTick, slice?.loadedToBucket ?? 0);
  const loadedFrom = slice
    ? slice.loadedFromBucket
    : Math.max(0, Math.floor(effectiveSeedTick / step) * step - (INITIAL_BUCKETS - 1) * step);

  let earliestTradeTick = slice?.earliestTradeTick ?? null;
  let latestTradeTick = slice?.latestTradeTick ?? null;
  for (const raw of bookCandles) {
    if (earliestTradeTick === null || raw.bucket_tick < earliestTradeTick) {
      earliestTradeTick = raw.bucket_tick;
    }
    if (latestTradeTick === null || raw.bucket_tick > latestTradeTick) {
      latestTradeTick = raw.bucket_tick;
    }
  }

  for (const [b, row] of liveAgg) {
    if (b >= loadedFrom) {
      // Only overwrite recent/live buckets from book.candles when we have full coverage or fallback mode
      const isLiveTail = !slice || !slice.apiSupported || b >= Math.max(loadedFrom, slice.loadedToBucket - step);
      if (isLiveTail || !realByBucket.has(b)) {
        realByBucket.set(b, row);
      }
    }
  }

  let maxRealBucket = -1;
  for (const b of realByBucket.keys()) {
    if (b > maxRealBucket) maxRealBucket = b;
  }

  const effectiveTick = Math.max(effectiveSeedTick, maxRealBucket >= 0 ? maxRealBucket : 0);
  const curBucket = Math.floor(effectiveTick / step) * step;
  const startBucket = Math.min(loadedFrom, curBucket);

  // Determine exact carry-forward anchor price at startBucket
  let initialCarry: number | undefined;
  if (slice && slice.prevCloseBeforeLoaded !== null && slice.prevCloseBeforeLoaded > 0) {
    initialCarry = slice.prevCloseBeforeLoaded;
  } else if (!slice || !slice.apiSupported) {
    // Fallback mode without /api/market/candles: look for last real candle strictly before startBucket
    let priorClose: number | undefined;
    let priorTick = -1;
    for (const raw of bookCandles) {
      const b = Math.floor(raw.bucket_tick / step) * step;
      if (b < startBucket && raw.bucket_tick >= priorTick) {
        priorTick = raw.bucket_tick;
        priorClose = raw.close;
      }
    }
    initialCarry = priorClose ?? fallbackPrice;
  } else {
    // At T0 before any trade ever happened: use catalog ref_price, fallback to last_price
    initialCarry = slice.refPrice > 0 ? slice.refPrice : fallbackPrice;
  }

  if (realByBucket.size === 0 && (initialCarry === undefined || initialCarry <= 0)) {
    return { bars: [], realSigs: new Map(), latestTradeTick, earliestTradeTick, effectiveTick };
  }

  // Index quote samples in live window so reference price drift without fills is still reflected
  const sampleBuckets = new Map<number, QuoteSample[]>();
  for (const s of samples ?? []) {
    const b = Math.floor(s.tick / step) * step;
    if (b < startBucket || b > curBucket) continue;
    const list = sampleBuckets.get(b);
    if (list) list.push(s);
    else sampleBuckets.set(b, [s]);
  }

  const bars: DisplayBar[] = [];
  let carry = initialCarry && initialCarry > 0 ? initialCarry : 0;
  let maSum = 0;
  const maWindow: number[] = [];
  const realSigs = new Map<number, string>();

  for (let b = startBucket; b <= curBucket; b += step) {
    const prevClose = carry;
    const real = realByBucket.get(b);
    let open: number;
    let high: number;
    let low: number;
    let close: number;
    let volume: number;
    let isReal: boolean;

    if (real) {
      open = real.open;
      high = real.high;
      low = real.low;
      close = real.close;
      volume = real.volume;
      isReal = true;
      carry = close;
      realSigs.set(
        b,
        `${open.toFixed(4)}:${high.toFixed(4)}:${low.toFixed(4)}:${close.toFixed(4)}:${volume}`,
      );
    } else {
      const bSamples = sampleBuckets.get(b);
      if (bSamples && bSamples.length > 0 && bSamples[0].price > 0) {
        open = bSamples[0].price;
        high = open;
        low = open;
        for (const s of bSamples) {
          if (s.price > high) high = s.price;
          if (s.price < low) low = s.price;
        }
        close = bSamples[bSamples.length - 1].price;
        volume = 0;
        isReal = false;
        carry = close;
      } else if (carry > 0) {
        open = carry;
        high = carry;
        low = carry;
        close = carry;
        volume = 0;
        isReal = false;
      } else {
        continue;
      }
    }

    maWindow.push(close);
    maSum += close;
    if (maWindow.length > 10) {
      maSum -= maWindow.shift()!;
    }
    const ma10 = maSum / maWindow.length;

    bars.push({
      bucket_tick: b,
      open,
      high,
      low,
      close,
      volume,
      isReal,
      ma10,
      prevClose: prevClose > 0 ? prevClose : open,
    });
  }

  return {
    bars,
    realSigs,
    latestTradeTick,
    earliestTradeTick,
    effectiveTick,
  };
}

function hasHistoricalRealChange(
  prevSigs: Map<number, string>,
  nextSigs: Map<number, string>,
  cutoffBucket: number,
): boolean {
  for (const [b, sig] of prevSigs) {
    if (b < cutoffBucket && nextSigs.get(b) !== sig) return true;
  }
  for (const [b, sig] of nextSigs) {
    if (b < cutoffBucket && prevSigs.get(b) !== sig) return true;
  }
  return false;
}

export const ChartPanel: React.FC<PaneProps> = ({ params, setParams, openTemp }) => {
  const catalog = useGameStore((s) => s.catalog);
  const state = useGameStore((s) => s.state);
  const watchBook = useGameStore((s) => s.watchBook);
  const books = useGameStore((s) => s.books);
  const quoteHistory = useGameStore((s) => s.quoteHistory);
  const catalogIdx = useCatalogIndex();
  const world = useWorldIndex();

  // Params are the identity of this pane: no local copy, no hardcoded default symbol.
  const stationId =
    params.stationId ?? world.stations.find((s) => s.isHub)?.id ?? world.stations[0]?.id ?? '';
  const itemId = params.itemId ?? catalogIdx.items[0]?.id ?? '';
  const [period, setPeriod] = useState<number>(() => loadSavedPeriod());
  const updatePeriod = useCallback((next: number) => {
    savePeriodPref(next);
    setPeriod(next);
  }, []);
  const coarse = isCoarsePointer();
  const [hoverBar, setHoverBar] = useState<HoverReadout | null>(null);
  const [lockedBar, setLockedBar] = useState<HoverReadout | null>(null);
  const lockedBarRef = useRef<HoverReadout | null>(null);
  lockedBarRef.current = lockedBar;
  const [historySlice, setHistorySlice] = useState<HistorySlice | null>(null);
  const [loadingHistory, setLoadingHistory] = useState<boolean>(false);

  const setStation = useCallback((id: string) => setParams({ stationId: id }), [setParams]);
  const setItem = useCallback((id: string) => setParams({ itemId: id }), [setParams]);

  const stationOptions = useMemo<PickerOption[]>(
    () =>
      world.stations.map((s) => ({
        id: s.id,
        label: s.label,
        sub: s.isHub ? '中心枢纽' : undefined,
        badge: s.isHub ? '枢纽' : undefined,
        keywords: s.id,
      })),
    [world.stations],
  );

  const itemOptions = useMemo<PickerOption[]>(
    () =>
      catalogIdx.items.map((it) => ({
        id: it.id,
        label: it.name,
        sub: catalogIdx.categoryName(it.demand_category) ?? undefined,
        keywords: `${it.id} ${it.tags.join(' ')} ${catalogIdx.roleLabel(it.role)}`,
        facets: { category: it.demand_category ?? undefined, role: it.role },
      })),
    [catalogIdx],
  );

  const containerRef = useRef<HTMLDivElement | null>(null);
  const chartRef = useRef<IChartApi | null>(null);
  const candleSeriesRef = useRef<ISeriesApi<'Candlestick'> | null>(null);
  const smaSeriesRef = useRef<ISeriesApi<'Line'> | null>(null);
  const volSeriesRef = useRef<ISeriesApi<'Histogram'> | null>(null);
  const priceLinesRef = useRef<IPriceLine[]>([]);

  const renderedMetaRef = useRef<RenderedMeta | null>(null);
  const barByTimeRef = useRef<Map<number, DisplayBar>>(new Map());
  const precisionRef = useRef<number>(-1);
  const isUpdatingChartRef = useRef<boolean>(false);
  const loadingMoreRef = useRef<boolean>(false);
  const pendingFitAllRef = useRef<boolean>(false);
  const pendingFocusTickRef = useRef<number | null>(null);
  const historySliceRef = useRef<HistorySlice | null>(null);
  const reqSeqRef = useRef<number>(0);

  historySliceRef.current = historySlice;

  useEffect(() => {
    if (!stationId || !itemId) return;
    const unwatch = watchBook(stationId, itemId);
    return unwatch;
  }, [stationId, itemId, watchBook]);

  const itemMap = useMemo(
    () => new Map((catalog?.items ?? []).map((i) => [i.id, i])),
    [catalog?.items],
  );



  // Clear stale hover readout whenever switching symbol/station/period
  useEffect(() => {
    setHoverBar(null);
  }, [stationId, itemId, period]);

  const bookKey = `${stationId}::${itemId}`;
  const book = books[bookKey];
  const samples = quoteHistory[bookKey];
  const tickerRow = useMemo(
    () => (state?.market_tickers ?? []).find((t) => t.station_id === stationId && t.item_id === itemId),
    [state?.market_tickers, stationId, itemId],
  );
  const currentTick = state?.tick ?? 0;
  const catalogRefPrice = itemMap.get(itemId)?.ref_price;
  const refPrice = book?.last_price ?? tickerRow?.last_price ?? catalogRefPrice;
  const bestBid = book?.best_bid ?? tickerRow?.best_bid ?? null;
  const bestAsk = book?.best_ask ?? tickerRow?.best_ask ?? null;

  const seriesKey = `${stationId}::${itemId}::${period}`;

  // Fetch older history page on demand (called by left-drag pagination, Fit All, or Jump to Trade)
  const loadOlderRange = useCallback(
    async (targetFromTick: number) => {
      const slice = historySliceRef.current;
      if (!slice || !slice.apiSupported || slice.loadedFromBucket <= 0 || loadingMoreRef.current) {
        return;
      }
      const step = slice.period;
      const alignedTarget = Math.max(0, Math.floor(targetFromTick / step) * step);
      if (alignedTarget >= slice.loadedFromBucket) return;

      loadingMoreRef.current = true;
      setLoadingHistory(true);
      const expectedKey = slice.key;
      const toBucket = Math.max(0, slice.loadedFromBucket - step);

      try {
        const resp = await api.getMarketCandles(slice.stationId, slice.itemId, {
          period: step,
          fromTick: alignedTarget,
          toTick: toBucket,
        });
        setHistorySlice((prev) => {
          if (!prev || prev.key !== expectedKey) return prev;
          const merged = new Map(prev.realByBucket);
          for (const c of resp.candles) {
            merged.set(c.bucket_tick, c);
          }
          return {
            ...prev,
            loadedFromBucket: Math.min(prev.loadedFromBucket, resp.from_bucket),
            prevCloseBeforeLoaded: resp.prev_close,
            earliestTradeTick: resp.earliest_trade_tick,
            latestTradeTick: resp.latest_trade_tick ?? prev.latestTradeTick,
            totalTradeTicks: resp.total_trade_ticks,
            realByBucket: merged,
          };
        });
      } catch {
        // Keep current loaded window intact if fetch fails transiently
      } finally {
        loadingMoreRef.current = false;
        setLoadingHistory(false);
      }
    },
    [],
  );

  // Initial load for (stationId, itemId, period) + automatic re-fetch on world reset
  const prevTickForResetRef = useRef<number>(currentTick);
  useEffect(() => {
    const rolledBack = currentTick < prevTickForResetRef.current;
    prevTickForResetRef.current = currentTick;
    if (rolledBack) {
      renderedMetaRef.current = null;
      setHistorySlice(null);
    }
  }, [currentTick]);

  useEffect(() => {
    let cancelled = false;
    const seq = ++reqSeqRef.current;
    const step = Math.max(1, period);

    // Nothing selected yet (fresh pane / removed entity) — show the picker instead of fetching.
    if (!stationId || !itemId) return;

    // Avoid redundant initial fetch when slice already matches this key
    const existing = historySliceRef.current;
    if (existing && existing.key === seriesKey) {
      return;
    }

    loadingMoreRef.current = true;
    setLoadingHistory(true);

    // Omit toTick so the backend uses its authoritative world.tick even before /api/state resolves
    const reqOpts = pendingFitAllRef.current
      ? { period: step, fromTick: 0 }
      : { period: step };

    void api
      .getMarketCandles(stationId, itemId, reqOpts)
      .then((resp) => {
        if (cancelled || reqSeqRef.current !== seq) return;
        const map = new Map<number, CandleRow>();
        for (const c of resp.candles) {
          map.set(c.bucket_tick, c);
        }
        setHistorySlice({
          key: seriesKey,
          stationId,
          itemId,
          period: step,
          loadedFromBucket: resp.from_bucket,
          loadedToBucket: resp.to_bucket,
          prevCloseBeforeLoaded: resp.prev_close,
          refPrice: resp.ref_price,
          earliestTradeTick: resp.earliest_trade_tick,
          latestTradeTick: resp.latest_trade_tick,
          totalTradeTicks: resp.total_trade_ticks,
          realByBucket: map,
          apiSupported: true,
        });
      })
      .catch(() => {
        if (cancelled || reqSeqRef.current !== seq) return;
        const curBucket = Math.floor(currentTick / step) * step;
        const initFrom = Math.max(0, curBucket - (INITIAL_BUCKETS - 1) * step);
        // Graceful fallback if running against an older backend without /api/market/candles
        setHistorySlice({
          key: seriesKey,
          stationId,
          itemId,
          period: step,
          loadedFromBucket: initFrom,
          loadedToBucket: curBucket,
          prevCloseBeforeLoaded: null,
          refPrice: catalogRefPrice ?? refPrice ?? 0,
          earliestTradeTick: null,
          latestTradeTick: null,
          totalTradeTicks: 0,
          realByBucket: new Map(),
          apiSupported: false,
        });
      })
      .finally(() => {
        if (!cancelled && reqSeqRef.current === seq) {
          loadingMoreRef.current = false;
          setLoadingHistory(false);
        }
      });

    return () => {
      cancelled = true;
    };
    // Intentionally triggered on symbol/period switch or when slice was cleared on reset
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [seriesKey, historySlice === null]);

  // Catch up tail if tab slept or reconnected far ahead of loadedToBucket
  useEffect(() => {
    const slice = historySliceRef.current;
    if (!slice || slice.key !== seriesKey || !slice.apiSupported || loadingMoreRef.current) return;
    const step = slice.period;
    const curBucket = Math.floor(currentTick / step) * step;
    if (curBucket <= slice.loadedToBucket + 300 * step) return;

    let cancelled = false;
    const expectedKey = slice.key;
    const catchupFrom = slice.loadedToBucket;
    void api
      .getMarketCandles(slice.stationId, slice.itemId, {
        period: step,
        fromTick: catchupFrom,
        toTick: curBucket,
      })
      .then((resp) => {
        if (cancelled) return;
        setHistorySlice((prev) => {
          if (!prev || prev.key !== expectedKey) return prev;
          const merged = new Map(prev.realByBucket);
          for (const c of resp.candles) {
            merged.set(c.bucket_tick, c);
          }
          return {
            ...prev,
            loadedToBucket: Math.max(prev.loadedToBucket, resp.to_bucket),
            earliestTradeTick: resp.earliest_trade_tick ?? prev.earliestTradeTick,
            latestTradeTick: resp.latest_trade_tick ?? prev.latestTradeTick,
            totalTradeTicks: resp.total_trade_ticks,
            realByBucket: merged,
          };
        });
      })
      .catch(() => {
        // ignore transient catchup errors
      });
    return () => {
      cancelled = true;
    };
  }, [currentTick, seriesKey]);

  // Create chart instance once per mounted panel
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
      handleScale: {
        mouseWheel: true,
        pinch: true,
        axisPressedMouseMove: !coarse,
        axisDoubleClickReset: true,
      },
      handleScroll: {
        mouseWheel: true,
        pressedMouseMove: true,
        horzTouchDrag: true,
        vertTouchDrag: !coarse,
      },
      timeScale: {
        borderColor: 'rgba(148, 163, 184, 0.18)',
        barSpacing: 9,
        minBarSpacing: 1.5,
        rightOffset: 4,
        timeVisible: true,
        secondsVisible: false,
        allowBoldLabels: false,
        lockVisibleTimeRangeOnResize: true,
        shiftVisibleRangeOnNewBar: true,
        tickMarkFormatter: (time: Time) => fromTime(time),
      },
    });

    const candleSeries = chart.addCandlestickSeries({
      upColor: UP_COLOR,
      downColor: DOWN_COLOR,
      borderVisible: false,
      wickUpColor: UP_COLOR,
      wickDownColor: DOWN_COLOR,
      priceFormat: { type: 'price', precision: 2, minMove: 0.01 },
      autoscaleInfoProvider: (original: () => AutoscaleInfo | null) => {
        const res = original();
        if (!res || !res.priceRange) return res;
        const { minValue, maxValue } = res.priceRange;
        const span = maxValue - minValue;
        const mid = (maxValue + minValue) / 2;
        const minSpan = Math.max(mid * 0.04, 0.02);
        if (span < minSpan) {
          const pad = (minSpan - span) / 2;
          return {
            ...res,
            priceRange: {
              minValue: Math.max(0, minValue - pad),
              maxValue: maxValue + pad,
            },
          };
        }
        return res;
      },
    });

    const smaSeries = chart.addLineSeries({
      color: '#58a6ff',
      lineWidth: 1,
      priceLineVisible: false,
      lastValueVisible: false,
      crosshairMarkerVisible: false,
      priceFormat: { type: 'price', precision: 2, minMove: 0.01 },
    });

    const volSeries = chart.addHistogramSeries({
      priceFormat: { type: 'volume' },
      priceScaleId: '',
      priceLineVisible: false,
      lastValueVisible: false,
    });
    volSeries.priceScale().applyOptions({
      scaleMargins: { top: 0.82, bottom: 0 },
    });

    const toReadout = (bar: DisplayBar): HoverReadout => ({
      tick: bar.bucket_tick,
      open: bar.open,
      high: bar.high,
      low: bar.low,
      close: bar.close,
      volume: bar.volume,
      ma10: bar.ma10,
      prevClose: bar.prevClose,
      isReal: bar.isReal,
    });

    const onCrosshairMove = (param: MouseEventParams<Time>) => {
      if (!param || param.time === undefined || typeof param.time !== 'number') {
        setHoverBar(null);
        return;
      }
      const bar = barByTimeRef.current.get(param.time);
      setHoverBar(bar ? toReadout(bar) : null);
    };
    chart.subscribeCrosshairMove(onCrosshairMove);

    const onChartClick = (param: MouseEventParams<Time>) => {
      if (!param || param.time === undefined || typeof param.time !== 'number') {
        setLockedBar(null);
        return;
      }
      const bar = barByTimeRef.current.get(param.time);
      if (!bar) {
        setLockedBar(null);
        return;
      }
      const prev = lockedBarRef.current;
      if (prev && prev.tick === bar.bucket_tick) {
        setLockedBar(null);
      } else {
        setLockedBar(toReadout(bar));
      }
    };
    chart.subscribeClick(onChartClick);

    let prefetchTimer: number | null = null;
    const onVisibleLogicalRangeChange = (range: LogicalRange | null) => {
      if (!range || isUpdatingChartRef.current || loadingMoreRef.current) return;
      const slice = historySliceRef.current;
      if (!slice || !slice.apiSupported || slice.loadedFromBucket <= 0) return;
      if (range.from < 80) {
        if (prefetchTimer !== null) window.clearTimeout(prefetchTimer);
        prefetchTimer = window.setTimeout(() => {
          prefetchTimer = null;
          if (loadingMoreRef.current) return;
          const latestSlice = historySliceRef.current;
          if (!latestSlice || !latestSlice.apiSupported || latestSlice.loadedFromBucket <= 0) return;
          const nextFrom = Math.max(0, latestSlice.loadedFromBucket - PAGE_BUCKETS * latestSlice.period);
          void loadOlderRange(nextFrom);
        }, 150);
      }
    };
    chart.timeScale().subscribeVisibleLogicalRangeChange(onVisibleLogicalRangeChange);

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
      if (prefetchTimer !== null) window.clearTimeout(prefetchTimer);
      chart.unsubscribeCrosshairMove(onCrosshairMove);
      chart.unsubscribeClick(onChartClick);
      chart.timeScale().unsubscribeVisibleLogicalRangeChange(onVisibleLogicalRangeChange);
      priceLinesRef.current = [];
      barByTimeRef.current.clear();
      renderedMetaRef.current = null;
      precisionRef.current = -1;
      chart.remove();
      chartRef.current = null;
      candleSeriesRef.current = null;
      smaSeriesRef.current = null;
      volSeriesRef.current = null;
    };
  }, [loadOlderRange]);

  const activeSlice = historySlice && historySlice.key === seriesKey ? historySlice : null;

  const { bars, realSigs, latestTradeTick, earliestTradeTick, effectiveTick } = useMemo(
    () =>
      buildContinuousBars(
        activeSlice,
        book?.candles ?? [],
        samples,
        refPrice,
        currentTick,
        period,
      ),
    [activeSlice, book?.candles, samples, refPrice, currentTick, period],
  );

  // Sync bars to chart with smooth rightward live streaming and jump-free left-history prepending
  useEffect(() => {
    const candleSeries = candleSeriesRef.current;
    const smaSeries = smaSeriesRef.current;
    const volSeries = volSeriesRef.current;
    const chart = chartRef.current;
    if (!candleSeries || !smaSeries || !volSeries || !chart) return;

    const precision = computePriceDigits(refPrice ?? bars[bars.length - 1]?.close);
    if (precisionRef.current !== precision) {
      const minMove = precision === 4 ? 0.0001 : 0.01;
      candleSeries.applyOptions({ priceFormat: { type: 'price', precision, minMove } });
      smaSeries.applyOptions({ priceFormat: { type: 'price', precision, minMove } });
      precisionRef.current = precision;
    }

    if (bars.length === 0) {
      isUpdatingChartRef.current = true;
      try {
        candleSeries.setData([]);
        volSeries.setData([]);
        smaSeries.setData([]);
        barByTimeRef.current.clear();
        renderedMetaRef.current = null;
      } finally {
        isUpdatingChartRef.current = false;
      }
      return;
    }

    const nextMap = new Map<number, DisplayBar>();
    for (const b of bars) {
      nextMap.set(toTime(b.bucket_tick), b);
    }
    barByTimeRef.current = nextMap;

    const step = Math.max(1, period);
    const firstBucket = bars[0].bucket_tick;
    const lastBucket = bars[bars.length - 1].bucket_tick;
    const prevMeta = renderedMetaRef.current;

    const isSwitchOrReset =
      !prevMeta || prevMeta.key !== seriesKey || lastBucket < prevMeta.lastBucket;
    const isPrepend = !isSwitchOrReset && firstBucket < prevMeta.firstBucket;
    const isHistoryBackfill =
      !isSwitchOrReset &&
      !isPrepend &&
      hasHistoricalRealChange(prevMeta.realSigs, realSigs, prevMeta.lastBucket);

    const pushFullData = () => {
      candleSeries.setData(bars.map(toCandlePoint));
      volSeries.setData(
        bars.map((c) => ({
          time: toTime(c.bucket_tick),
          value: c.volume,
          color:
            c.volume > 0
              ? c.close >= c.open
                ? 'rgba(63, 185, 80, 0.42)'
                : 'rgba(248, 81, 73, 0.42)'
              : 'rgba(0, 0, 0, 0)',
        })),
      );
      smaSeries.setData(
        bars.map((c) => ({
          time: toTime(c.bucket_tick),
          value: c.ma10,
        })),
      );
    };

    const applyPendingCamera = (fallbackRange: LogicalRange | null, prependDelta: number) => {
      const ts = chart.timeScale();
      if (pendingFitAllRef.current && firstBucket === 0) {
        pendingFitAllRef.current = false;
        ts.fitContent();
        return;
      }
      if (pendingFocusTickRef.current !== null) {
        const targetBucket = Math.floor(pendingFocusTickRef.current / step) * step;
        if (targetBucket >= firstBucket) {
          const idx = Math.max(0, Math.min(bars.length - 1, Math.round((targetBucket - firstBucket) / step)));
          pendingFocusTickRef.current = null;
          ts.setVisibleLogicalRange({
            from: Math.max(-4, idx - 32),
            to: Math.min(bars.length - 1 + 4, idx + 32),
          });
          return;
        }
      }
      if (fallbackRange) {
        ts.setVisibleLogicalRange({
          from: fallbackRange.from + prependDelta,
          to: fallbackRange.to + prependDelta,
        });
        return;
      }
      if (bars.length > DEFAULT_VISIBLE_BARS) {
        ts.setVisibleLogicalRange({
          from: bars.length - DEFAULT_VISIBLE_BARS,
          to: bars.length - 1 + 4,
        });
      } else {
        ts.applyOptions({ barSpacing: 9, rightOffset: 4 });
        ts.scrollToRealTime();
      }
    };

    isUpdatingChartRef.current = true;
    try {
      if (isSwitchOrReset) {
        pushFullData();
        applyPendingCamera(null, 0);
      } else if (isPrepend) {
        const prevRange = chart.timeScale().getVisibleLogicalRange();
        const addedBars = Math.round((prevMeta.firstBucket - firstBucket) / step);
        pushFullData();
        applyPendingCamera(prevRange, addedBars);
      } else if (isHistoryBackfill) {
        const prevRange = chart.timeScale().getVisibleLogicalRange();
        pushFullData();
        applyPendingCamera(prevRange, 0);
      } else {
        const startIdx = Math.max(
          0,
          Math.min(bars.length - 1, Math.round((prevMeta.lastBucket - firstBucket) / step)),
        );
        for (let i = startIdx; i < bars.length; i++) {
          const c = bars[i];
          const time = toTime(c.bucket_tick);
          candleSeries.update(toCandlePoint(c));
          volSeries.update({
            time,
            value: c.volume,
            color:
              c.volume > 0
                ? c.close >= c.open
                  ? 'rgba(63, 185, 80, 0.42)'
                  : 'rgba(248, 81, 73, 0.42)'
                : 'rgba(0, 0, 0, 0)',
          });
          smaSeries.update({ time, value: c.ma10 });
        }
      }
    } finally {
      isUpdatingChartRef.current = false;
    }

    renderedMetaRef.current = {
      key: seriesKey,
      firstBucket,
      lastBucket,
      realSigs,
    };
  }, [bars, realSigs, refPrice, period, seriesKey]);

  // Bid / Ask horizontal lines attached to candleSeries (with opaque axis labels and outlier guard)
  useEffect(() => {
    const candleSeries = candleSeriesRef.current;
    if (!candleSeries) return;
    for (const pl of priceLinesRef.current) {
      try {
        candleSeries.removePriceLine(pl);
      } catch {
        // ignore if detached
      }
    }
    priceLinesRef.current = [];

    const anchor = refPrice && refPrice > 0 ? refPrice : bars[bars.length - 1]?.close;
    const isSaneLinePrice = (p: number | null): p is number => {
      if (p === null || !Number.isFinite(p) || p <= 0) return false;
      if (!anchor || anchor <= 0) return true;
      return p >= anchor * 0.2 && p <= anchor * 5;
    };

    if (isSaneLinePrice(bestBid)) {
      priceLinesRef.current.push(
        candleSeries.createPriceLine({
          price: bestBid,
          color: 'rgba(63, 185, 80, 0.7)',
          lineWidth: 1,
          lineStyle: LineStyle.Dashed,
          axisLabelVisible: true,
          axisLabelColor: '#2ea043',
          axisLabelTextColor: '#ffffff',
          title: '买一',
        }),
      );
    }
    if (isSaneLinePrice(bestAsk)) {
      priceLinesRef.current.push(
        candleSeries.createPriceLine({
          price: bestAsk,
          color: 'rgba(248, 81, 73, 0.7)',
          lineWidth: 1,
          lineStyle: LineStyle.Dashed,
          axisLabelVisible: true,
          axisLabelColor: '#da3633',
          axisLabelTextColor: '#ffffff',
          title: '卖一',
        }),
      );
    }
  }, [bestBid, bestAsk, refPrice, seriesKey, bars.length === 0]);

  const handleFitAllHistory = useCallback(() => {
    const step = Math.max(1, period);
    const totalBuckets = Math.floor(effectiveTick / step) + 1;
    const slice = historySliceRef.current;

    if (totalBuckets > MAX_ALL_HISTORY_BARS) {
      // Auto-pick the finest period that covers T0..now smoothly without overloading the browser
      const chosen =
        PERIOD_OPTIONS.find((p) => Math.floor(effectiveTick / p) + 1 <= MAX_ALL_HISTORY_BARS) ?? 60;
      pendingFitAllRef.current = true;
      if (chosen !== period) {
        updatePeriod(chosen);
        return;
      }
    }

    if (slice && slice.loadedFromBucket > 0 && slice.apiSupported) {
      pendingFitAllRef.current = true;
      void loadOlderRange(0);
    } else {
      chartRef.current?.timeScale().fitContent();
    }
  }, [period, effectiveTick, loadOlderRange]);

  const handleJumpToLatestTrade = useCallback(() => {
    if (latestTradeTick === null) return;
    const step = Math.max(1, period);
    const targetBucket = Math.floor(latestTradeTick / step) * step;
    const slice = historySliceRef.current;
    const chart = chartRef.current;
    if (!chart) return;

    if (slice && targetBucket < slice.loadedFromBucket && slice.apiSupported) {
      pendingFocusTickRef.current = latestTradeTick;
      const loadFrom = Math.max(0, targetBucket - 40 * step);
      void loadOlderRange(loadFrom);
    } else if (bars.length > 0) {
      const firstBucket = bars[0].bucket_tick;
      const idx = Math.max(0, Math.min(bars.length - 1, Math.round((targetBucket - firstBucket) / step)));
      chart.timeScale().setVisibleLogicalRange({
        from: Math.max(-4, idx - 32),
        to: Math.min(bars.length - 1 + 4, idx + 32),
      });
    }
  }, [latestTradeTick, period, bars, loadOlderRange]);

  const handleZoomChart = useCallback((factor: number) => {
    const ts = chartRef.current?.timeScale();
    if (!ts) return;
    const cur = ts.options().barSpacing ?? 9;
    const next = Math.max(2, Math.min(32, cur * factor));
    ts.applyOptions({ barSpacing: next });
  }, []);

  const handleScrollLatest = useCallback(() => {
    setLockedBar(null);
    const ts = chartRef.current?.timeScale();
    if (!ts) return;
    if (bars.length > DEFAULT_VISIBLE_BARS) {
      ts.setVisibleLogicalRange({
        from: bars.length - DEFAULT_VISIBLE_BARS,
        to: bars.length - 1 + 4,
      });
    } else {
      ts.applyOptions({ barSpacing: 9, rightOffset: 4 });
      ts.scrollToRealTime();
    }
  }, [bars.length]);

  const latest = bars[bars.length - 1];
  const shown: HoverReadout | null =
    lockedBar ??
    hoverBar ??
    (latest
      ? {
          tick: latest.bucket_tick,
          open: latest.open,
          high: latest.high,
          low: latest.low,
          close: latest.close,
          volume: latest.volume,
          ma10: latest.ma10,
          prevClose: latest.prevClose,
          isReal: latest.isReal,
        }
      : null);

  const priceDigits = computePriceDigits(refPrice ?? latest?.close);
  const pctChange =
    shown && shown.prevClose > 0 ? ((shown.close - shown.prevClose) / shown.prevClose) * 100 : 0;
  const loadedFromBucket = activeSlice?.loadedFromBucket ?? bars[0]?.bucket_tick ?? 0;
  const hasDistantTrade =
    latestTradeTick !== null && effectiveTick - latestTradeTick > DEFAULT_VISIBLE_BARS * period;

  return (
    <div className="h-full flex flex-col bg-[#191f27] text-slate-200 overflow-hidden">
      <div className="px-2.5 py-1.5 border-b border-sky-500/10 bg-[#232a36] flex items-center justify-between gap-2 shrink-0 flex-wrap select-none">
        <div className="flex items-center gap-1.5">
          <SearchSelect
            options={stationOptions}
            value={stationId}
            onChange={setStation}
            emptyLabel="选择站点"
            placeholder="搜索站点…"
            title="切换站点"
          />
          <SearchSelect
            options={itemOptions}
            value={itemId}
            onChange={setItem}
            emptyLabel="选择物品"
            placeholder="搜索物品名 / id / 标签…"
            facets={[
              { key: 'category', label: '类别', values: catalogIdx.facets.category },
              { key: 'role', label: '角色', values: catalogIdx.facets.role },
            ]}
            title="切换物品"
          />
        </div>

        <div className="flex items-center gap-1 flex-wrap">
          {PERIOD_OPTIONS.map((p) => (
            <button
              key={p}
              onClick={() => updatePeriod(p)}
              className={`pill-btn py-0 text-[10px] ${period === p ? 'active' : ''}`}
            >
              {p}回合
            </button>
          ))}
          <button
            onClick={() => handleZoomChart(1.25)}
            className="pill-btn py-0 px-1.5 text-[11px]"
            title="放大 K 线"
          >
            +
          </button>
          <button
            onClick={() => handleZoomChart(0.8)}
            className="pill-btn py-0 px-1.5 text-[11px]"
            title="缩小 K 线"
          >
            −
          </button>
          <button
            onClick={handleFitAllHistory}
            className="pill-btn py-0 text-[10px]"
            title="从开服 T0 到当前回合全览"
          >
            全览
          </button>
          <button
            onClick={handleScrollLatest}
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
      <div className="px-3 py-1 bg-[#1f2630] border-b border-slate-800/70 flex items-center justify-between gap-2 text-[11px] mono shrink-0 flex-wrap select-none">
        {shown ? (
          <span className="text-slate-300 flex items-center flex-wrap gap-x-1">
            {lockedBar && (
              <button
                type="button"
                onClick={() => setLockedBar(null)}
                className="mr-1 px-1.5 py-0 rounded bg-sky-500/20 border border-sky-400/50 text-sky-200 text-[9px]"
                title="点击解锁并跟随最新回合"
              >
                锁定 ×
              </button>
            )}
            <span className="text-slate-400 mr-1">T{shown.tick}</span>
            开 {shown.open.toFixed(priceDigits)} · 高{' '}
            <span className={shown.isReal ? 'text-[#3fb950]' : 'text-slate-300'}>
              {shown.high.toFixed(priceDigits)}
            </span>{' '}
            · 低{' '}
            <span className={shown.isReal ? 'text-[#f85149]' : 'text-slate-300'}>
              {shown.low.toFixed(priceDigits)}
            </span>{' '}
            · 收{' '}
            <span
              className={
                !shown.isReal
                  ? 'text-slate-300'
                  : shown.close >= shown.open
                    ? 'text-[#3fb950]'
                    : 'text-[#f85149]'
              }
            >
              {shown.close.toFixed(priceDigits)}
            </span>
            {shown.isReal ? (
              <>
                <span className={`ml-1 ${pctChange >= 0 ? 'text-[#3fb950]' : 'text-[#f85149]'}`}>
                  ({pctChange >= 0 ? '+' : ''}
                  {pctChange.toFixed(2)}%)
                </span>
                {' · '}量 {shown.volume}
              </>
            ) : (
              <span className="text-slate-500"> · 无成交(平盘)</span>
            )}
          </span>
        ) : (
          <span className="text-slate-400">加载市场行情中...</span>
        )}
        <span className="flex items-center gap-2 text-[10px]">
          <span className="text-[#58a6ff]">
            MA10 {shown ? shown.ma10.toFixed(priceDigits) : '--'}
          </span>
          {book && (
            <span className="text-slate-500" title="交易所快速指数均价">
              EMA {book.ema_fast.toFixed(priceDigits)}
            </span>
          )}
        </span>
      </div>

      <div className="flex-1 min-h-0 relative">
        <div ref={containerRef} className="w-full h-full" />

        {/* History status / quick jump overlay */}
        <div className="absolute top-2 left-2.5 z-10 flex items-center gap-1.5 pointer-events-none">
          {loadingHistory && (
            <div className="px-2 py-0.5 rounded bg-[#1f2630]/90 border border-sky-500/30 text-sky-300 text-[10px]">
              加载历史 K 线...
            </div>
          )}
          {!loadingHistory && latestTradeTick === null && (
            <div className="px-2 py-0.5 rounded bg-[#1f2630]/85 border border-slate-700/70 text-slate-400 text-[10px]">
              开服至今暂无成交 · 按参考价平盘推进 (已载入 T{loadedFromBucket}–T{effectiveTick})
            </div>
          )}
          {!loadingHistory && hasDistantTrade && (
            <button
              onClick={handleJumpToLatestTrade}
              className="pointer-events-auto px-2 py-0.5 rounded bg-[#1f2630]/90 hover:bg-[#27303e] border border-slate-700/80 text-slate-300 text-[10px] transition-colors"
              title={`开服最早成交 T${earliestTradeTick ?? latestTradeTick}，点击跳转到最近成交`}
            >
              最近成交 T{latestTradeTick} · 点击定位
            </button>
          )}
        </div>
      </div>
    </div>
  );
};

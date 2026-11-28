import React, { useCallback, useEffect, useRef, useState } from 'react';

export interface VirtualListProps {
  count: number;
  rowHeight: number;
  renderRow: (index: number) => React.ReactNode;
  className?: string;
  /** Rows rendered beyond the viewport on each side. */
  overscan?: number;
  emptyState?: React.ReactNode;
  /** Optional fixed height; when omitted the list measures its own box. */
  height?: number;
  /** Ensure this item index is visible whenever index or trigger changes. */
  scrollToIndex?: number | null;
  scrollTrigger?: number;
}

/**
 * Minimal windowing list. The codebase had zero virtualization, so every long table (ticker rows,
 * inventory, demands, the catalog itself) rendered every row on every 2s tick. Fixed row height
 * keeps this ~40 lines and dependency-free.
 */
export const VirtualList: React.FC<VirtualListProps> = ({
  count,
  rowHeight,
  renderRow,
  className,
  overscan = 6,
  emptyState,
  height,
  scrollToIndex,
  scrollTrigger,
}) => {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const [scrollTop, setScrollTop] = useState(0);
  const [viewport, setViewport] = useState(height ?? 320);

  useEffect(() => {
    if (height !== undefined) {
      setViewport(height);
      return;
    }
    const el = hostRef.current;
    if (!el) return;
    const measure = () => setViewport(el.clientHeight || 320);
    measure();
    if (typeof ResizeObserver === 'undefined') {
      window.addEventListener('resize', measure);
      return () => window.removeEventListener('resize', measure);
    }
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [height]);

  useEffect(() => {
    if (scrollToIndex === undefined || scrollToIndex === null || scrollToIndex < 0) return;
    const el = hostRef.current;
    if (!el) return;
    const vh = el.clientHeight || viewport;
    const rowTop = scrollToIndex * rowHeight;
    const rowBottom = rowTop + rowHeight;
    if (rowTop < el.scrollTop || rowBottom > el.scrollTop + vh) {
      const target = Math.max(0, rowTop - Math.max(0, vh - rowHeight) / 2);
      el.scrollTop = target;
      setScrollTop(target);
    }
  }, [scrollToIndex, scrollTrigger, rowHeight, viewport]);

  useEffect(() => {
    if (count === 0) {
      setScrollTop(0);
      return;
    }
    const el = hostRef.current;
    if (!el) return;
    const vh = height ?? (el.clientHeight || viewport);
    const maxScroll = Math.max(0, count * rowHeight - vh);
    if (el.scrollTop > maxScroll) {
      el.scrollTop = maxScroll;
    }
    const clamped = el.scrollTop;
    setScrollTop((prev) => (prev !== clamped ? clamped : prev));
  }, [count, rowHeight, height, viewport]);

  const onScroll = useCallback((e: React.UIEvent<HTMLDivElement>) => {
    setScrollTop(e.currentTarget.scrollTop);
  }, []);

  if (count === 0 && emptyState) {
    return <div className={className}>{emptyState}</div>;
  }

  const total = count * rowHeight;
  const activeViewport = height ?? viewport;
  const effectiveScrollTop = Math.min(scrollTop, Math.max(0, total - activeViewport));
  const start = Math.max(0, Math.floor(effectiveScrollTop / rowHeight) - overscan);
  const visible = Math.ceil(activeViewport / rowHeight) + overscan * 2;
  const end = Math.min(count, start + visible);

  const rows: React.ReactNode[] = [];
  for (let i = start; i < end; i += 1) {
    rows.push(
      <div
        key={i}
        style={{
          position: 'absolute',
          top: i * rowHeight,
          height: rowHeight,
          left: 0,
          right: 0,
          overflow: 'hidden',
        }}
      >
        {renderRow(i)}
      </div>,
    );
  }

  return (
    <div
      ref={hostRef}
      onScroll={onScroll}
      style={height !== undefined ? { height } : undefined}
      className={`${className ?? 'flex-1 min-h-0 overflow-y-auto'} overscroll-contain`}
    >
      <div style={{ height: total, position: 'relative' }}>{rows}</div>
    </div>
  );
};

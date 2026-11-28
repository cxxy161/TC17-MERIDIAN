import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { ChevronDown, Search, X } from 'lucide-react';
import { VirtualList } from './VirtualList';
import { isCoarsePointer } from '../utils/useDragPointer';

export interface PickerOption {
  id: string;
  label: string;
  sub?: string;
  group?: string;
  /** Extra text that should match the search box (aliases, pinyin, tags). */
  keywords?: string;
  badge?: string;
  disabled?: boolean;
  /** Values this option satisfies, keyed by `PickerFacet.key` (string or list). */
  facets?: Record<string, string | string[] | null | undefined>;
}

export interface PickerFacet {
  key: string;
  label: string;
  values: Array<{ id: string; label: string; count?: number }>;
}

export interface SearchSelectProps {
  options: PickerOption[];
  value?: string | null;
  onChange: (id: string) => void;
  facets?: PickerFacet[];
  placeholder?: string;
  emptyLabel?: string;
  title?: string;
  className?: string;
  /** Extra content pinned above the result list. */
  header?: React.ReactNode;
  disabled?: boolean;
  size?: 'sm' | 'md';
}

const ROW_HEIGHT = 26;

function Highlight({ text, query }: { text: string; query: string }) {
  const q = query.trim().toLowerCase();
  if (!q) return <>{text}</>;
  const idx = text.toLowerCase().indexOf(q);
  if (idx < 0) return <>{text}</>;
  return (
    <>
      {text.slice(0, idx)}
      <mark className="bg-sky-500/30 text-sky-100 rounded-[1px]">{text.slice(idx, idx + q.length)}</mark>
      {text.slice(idx + q.length)}
    </>
  );
}

/**
 * The single searchable entity selector for the whole app.
 *
 * Replaces every native `<select>` that enumerated a whole catalog (items / buildings / recipes)
 * and every "pill button wall" that enumerated every planet or station. Supports search, facets,
 * keyboard navigation and windowed rendering, and its popover is fixed-positioned so it is never
 * clipped by a pane's `overflow-hidden`.
 */
export const SearchSelect: React.FC<SearchSelectProps> = ({
  options,
  value,
  onChange,
  facets,
  placeholder = '搜索…',
  emptyLabel = '请选择',
  title,
  className,
  header,
  disabled,
  size = 'sm',
}) => {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [active, setActive] = useState(0);
  const [scrollTarget, setScrollTarget] = useState<{ index: number; seq: number }>({
    index: 0,
    seq: 0,
  });
  const [facetSel, setFacetSel] = useState<Record<string, string | undefined>>({});
  const [rect, setRect] = useState<{
    top: number;
    left: number;
    width: number;
    maxHeight: number;
    listHeight: number;
  }>({
    top: 0,
    left: 0,
    width: 320,
    maxHeight: 360,
    listHeight: 240,
  });

  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const popRef = useRef<HTMLDivElement | null>(null);
  const listBoxRef = useRef<HTMLDivElement | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const coarse = isCoarsePointer();
  const rowHeight = coarse ? 42 : ROW_HEIGHT;

  const selected = options.find((o) => o.id === value);

  const measured = useMemo(() => {
    const q = query.trim().toLowerCase();
    const activeFacets = Object.entries(facetSel).filter(([, v]) => !!v) as Array<[string, string]>;
    const filtered = options.filter((o) => {
      for (const [key, val] of activeFacets) {
        const raw = o.facets?.[key];
        if (Array.isArray(raw)) {
          if (!raw.includes(val)) return false;
        } else if (raw !== val) {
          return false;
        }
      }
      if (!q) return true;
      return (
        o.label.toLowerCase().includes(q) ||
        (o.sub ?? '').toLowerCase().includes(q) ||
        (o.keywords ?? '').toLowerCase().includes(q) ||
        o.id.toLowerCase().includes(q)
      );
    });
    if (q) {
      filtered.sort((a, b) => {
        const ap = a.label.toLowerCase().startsWith(q) ? 0 : 1;
        const bp = b.label.toLowerCase().startsWith(q) ? 0 : 1;
        return ap - bp || a.label.length - b.label.length;
      });
    }
    return filtered;
  }, [options, query, facetSel]);

  const listDesiredHeight = Math.min(320, Math.max(120, measured.length * rowHeight + 4));

  /**
   * 用「弹层真实目标高度」决定朝上还是朝下，并始终与触发按钮保持 4px 间距、夹在视口内。
   * 注意不能用 `pop.scrollHeight`：弹层自身 `border-box` 含 2px 边框且列表容器会 `flex-shrink`，
   * 若滚轮滚动触发重算并把 `scrollHeight` 回写进 `maxHeight`，每滚一次都会被边框吃掉 2px 直到缩死。
   */
  const reposition = useCallback(() => {
    const trigger = triggerRef.current;
    if (!trigger) return;
    const r = trigger.getBoundingClientRect();
    const margin = 8;
    const gap = 4;
    const vv = window.visualViewport;
    const vvTop = vv?.offsetTop ?? 0;
    const vvLeft = vv?.offsetLeft ?? 0;
    const vw = vv ? vv.width : window.innerWidth;
    const vh = vv ? vv.height : window.innerHeight;
    const width = Math.min(Math.max(r.width, 320), Math.max(240, vw - margin * 2));
    const left = Math.min(
      Math.max(vvLeft + margin, r.left),
      Math.max(vvLeft + margin, vvLeft + vw - width - margin),
    );
    const pop = popRef.current;
    let nonListChromeH = 2; // 1px top + 1px bottom border
    if (pop) {
      for (const child of Array.from(pop.children) as HTMLElement[]) {
        if (child !== listBoxRef.current) {
          nonListChromeH += child.offsetHeight;
        }
      }
    }
    const naturalHeight = Math.max(140, nonListChromeH + listDesiredHeight);
    const spaceBelow = vvTop + vh - r.bottom - gap - margin;
    const spaceAbove = r.top - vvTop - gap - margin;
    const openUp = spaceBelow < naturalHeight && spaceAbove > spaceBelow;
    const available = Math.max(110, openUp ? spaceAbove : spaceBelow);
    const maxHeight = Math.max(110, Math.min(naturalHeight, available));
    const listHeight = Math.max(64, Math.min(listDesiredHeight, maxHeight - nonListChromeH));
    const top = openUp
      ? Math.max(vvTop + margin, r.top - maxHeight - gap)
      : Math.min(r.bottom + gap, vvTop + vh - margin - maxHeight);
    setRect((prev) =>
      prev.top === top &&
      prev.left === left &&
      prev.width === width &&
      prev.maxHeight === maxHeight &&
      prev.listHeight === listHeight
        ? prev
        : { top, left, width, maxHeight, listHeight },
    );
  }, [listDesiredHeight]);

  useLayoutEffect(() => {
    if (!open) return;
    reposition();
    // 结果数量/分面变化会改变弹层高度，重新贴回按钮旁边（否则会留下空隙或盖住按钮）。
  }, [open, reposition, measured.length, facetSel]);

  // 悬浮窗/分割条拖动只触发 pointermove，不触发 scroll：按住拖动时让弹层跟着按钮走。
  useEffect(() => {
    if (!open) return;
    const onDragMove = (e: PointerEvent) => {
      if (e.buttons !== 0) reposition();
    };
    window.addEventListener('pointermove', onDragMove, { passive: true });
    return () => window.removeEventListener('pointermove', onDragMove);
  }, [open, reposition]);

  useEffect(() => {
    if (!open) return;
    const onDocDown = (e: MouseEvent) => {
      const target = e.target as Node;
      if (popRef.current?.contains(target) || triggerRef.current?.contains(target)) return;
      setOpen(false);
    };
    const onScroll = (e: Event) => {
      // 弹层内部列表/筛选条自己滚轮时不要触发重定位
      if (e.target instanceof Node && popRef.current?.contains(e.target)) return;
      reposition();
    };
    const onResize = () => reposition();
    const vv = window.visualViewport;
    window.addEventListener('pointerdown', onDocDown as EventListener, true);
    window.addEventListener('resize', onResize);
    vv?.addEventListener('resize', onResize);
    vv?.addEventListener('scroll', onResize);
    document.addEventListener('scroll', onScroll, true);
    return () => {
      window.removeEventListener('pointerdown', onDocDown as EventListener, true);
      window.removeEventListener('resize', onResize);
      vv?.removeEventListener('resize', onResize);
      vv?.removeEventListener('scroll', onResize);
      document.removeEventListener('scroll', onScroll, true);
    };
  }, [open, reposition]);

  const valueRef = useRef(value);
  valueRef.current = value;
  const optionsRef = useRef(options);
  optionsRef.current = options;

  useEffect(() => {
    if (open) {
      setQuery('');
      const curVal = valueRef.current;
      const curOpts = optionsRef.current;
      const selectedIdx = curVal ? curOpts.findIndex((o) => o.id === curVal) : -1;
      const initIdx = selectedIdx >= 0 ? selectedIdx : 0;
      setActive(initIdx);
      setScrollTarget((prev) => ({ index: initIdx, seq: prev.seq + 1 }));
      if (!coarse) {
        window.setTimeout(() => inputRef.current?.focus(), 10);
      }
    } else {
      setFacetSel({});
    }
  }, [open, coarse]);

  const commit = useCallback(
    (id: string) => {
      onChange(id);
      setOpen(false);
    },
    [onChange],
  );

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      setOpen(false);
      return;
    }
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setActive((v) => {
        const next = Math.min(Math.max(0, measured.length - 1), v + 1);
        setScrollTarget((prev) => ({ index: next, seq: prev.seq + 1 }));
        return next;
      });
      return;
    }
    if (e.key === 'ArrowUp') {
      e.preventDefault();
      setActive((v) => {
        const next = Math.max(0, v - 1);
        setScrollTarget((prev) => ({ index: next, seq: prev.seq + 1 }));
        return next;
      });
      return;
    }
    if (e.key === 'Enter') {
      e.preventDefault();
      const hit = measured[active];
      if (hit && !hit.disabled) commit(hit.id);
    }
  };

  const triggerSize = size === 'md' ? 'text-[11px] px-2 py-1' : 'text-[11px] px-1.5 py-0.5';

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        title={title ?? selected?.label ?? emptyLabel}
        disabled={disabled}
        onClick={() => setOpen((v) => !v)}
        className={`flex items-center justify-between gap-1 bg-[#27303e] border border-slate-700 hover:border-sky-500/60 active:border-sky-400 rounded-sm text-slate-200 disabled:opacity-50 max-w-[240px] touch-row ${triggerSize} ${className ?? ''}`}
      >
        <span className={`truncate ${selected ? 'text-sky-300' : 'text-slate-500'}`}>
          {selected?.label ?? emptyLabel}
        </span>
        <ChevronDown className="w-3 h-3 shrink-0 opacity-60" />
      </button>

      {open && (
        <div
          ref={popRef}
          style={{
            position: 'fixed',
            top: rect.top,
            left: rect.left,
            width: rect.width,
            maxHeight: rect.maxHeight,
            zIndex: 10000,
          }}
          className="bg-[#212834] border border-sky-400/45 rounded-[3px] shadow-2xl overflow-hidden flex flex-col"
          onKeyDown={onKeyDown}
        >
          <div className="px-2 py-1.5 border-b border-slate-800 flex items-center gap-1.5 shrink-0">
            <Search className="w-3.5 h-3.5 text-sky-400 shrink-0" />
            <input
              ref={inputRef}
              value={query}
              onChange={(e) => {
                setQuery(e.target.value);
                setActive(0);
              }}
              placeholder={placeholder}
              className="flex-1 bg-transparent outline-none text-[12px] text-slate-100 placeholder:text-slate-600"
            />
            {query && (
              <button
                type="button"
                onClick={() => setQuery('')}
                className="text-slate-500 hover:text-white p-1.5 -m-1 rounded-[2px]"
                title="清空"
              >
                <X className="w-3.5 h-3.5" />
              </button>
            )}
            <span className="text-[10px] text-slate-500 mono shrink-0">{measured.length}</span>
          </div>

          {facets && facets.length > 0 && (
            <div className="px-2 py-1.5 border-b border-slate-800 space-y-1 shrink-0 max-h-[76px] overflow-y-auto">
              {facets.map((f) => (
                <div key={f.key} className="flex items-center gap-1 flex-wrap">
                  <span className="text-[9px] text-slate-500 w-9 shrink-0">{f.label}</span>
                  {f.values.map((v) => {
                    const on = facetSel[f.key] === v.id;
                    return (
                      <button
                        key={v.id}
                        onClick={() =>
                          setFacetSel((prev) => ({ ...prev, [f.key]: prev[f.key] === v.id ? undefined : v.id }))
                        }
                        className={`text-[10px] px-1.5 py-[1px] rounded-[2px] border ${
                          on
                            ? 'bg-sky-500/25 border-sky-400/60 text-sky-100'
                            : 'bg-[#1b212b] border-slate-700/70 text-slate-400 hover:text-slate-200'
                        }`}
                      >
                        {v.label}
                        {v.count !== undefined && <span className="text-slate-500 ml-1">{v.count}</span>}
                      </button>
                    );
                  })}
                </div>
              ))}
            </div>
          )}

          {header}

          <div
            ref={listBoxRef}
            className="shrink-0 min-h-0"
            style={{
              height: rect.listHeight,
              minHeight: 0,
            }}
          >
            <VirtualList
              count={measured.length}
              rowHeight={rowHeight}
              height={rect.listHeight}
              className="overflow-y-auto overscroll-contain"
              scrollToIndex={scrollTarget.index}
              scrollTrigger={scrollTarget.seq}
              emptyState={
                <div className="px-3 py-4 text-[11px] text-slate-500">
                  没有匹配项{options.length > 0 ? `（共 ${options.length} 个可选）` : ''}
                </div>
              }
              renderRow={(idx) => {
                const opt = measured[idx];
                const isSel = opt.id === value;
                const isAct = idx === active;
                return (
                  <button
                    onMouseEnter={() => setActive(idx)}
                    onPointerDown={() => setActive(idx)}
                    onClick={() => !opt.disabled && commit(opt.id)}
                    disabled={opt.disabled}
                    className={`w-full text-left px-2 flex items-center justify-between gap-2 ${
                      coarse ? 'h-[40px]' : 'h-[24px]'
                    } rounded-sm disabled:opacity-40 hover:bg-sky-500/20 active:bg-sky-500/30 ${
                      isAct
                        ? 'bg-sky-500/25 text-white'
                        : isSel
                          ? 'bg-sky-500/10 text-sky-200'
                          : 'text-slate-300'
                    }`}
                  >
                    <span className="truncate text-[11px] flex items-center gap-1.5">
                      {isSel && <span className="w-1.5 h-1.5 rounded-full bg-sky-400 shrink-0" />}
                      <Highlight text={opt.label} query={query} />
                    </span>
                    <span className="flex items-center gap-2 shrink-0">
                      {opt.sub && <span className="text-[10px] text-slate-500 truncate max-w-[140px]">{opt.sub}</span>}
                      {opt.badge && (
                        <span className="text-[9px] px-1 bg-slate-700/60 text-slate-300 rounded-[2px]">{opt.badge}</span>
                      )}
                    </span>
                  </button>
                );
              }}
            />
          </div>

          <div className="px-2 py-1 border-t border-slate-800 text-[10px] text-slate-500 flex justify-between shrink-0">
            <span className="touch-hide">↑↓ Enter Esc</span>
            <span className="touch-only">点选一项</span>
            <span>共 {measured.length} 条</span>
          </div>
        </div>
      )}
    </>
  );
};

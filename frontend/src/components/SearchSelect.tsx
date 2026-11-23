import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { ChevronDown, Search, X } from 'lucide-react';
import { VirtualList } from './VirtualList';

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
  const [facetSel, setFacetSel] = useState<Record<string, string | undefined>>({});
  const [rect, setRect] = useState<{ top: number; left: number; width: number; openUp: boolean }>({
    top: 0,
    left: 0,
    width: 320,
    openUp: false,
  });

  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const popRef = useRef<HTMLDivElement | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);

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

  const reposition = useCallback(() => {
    const el = triggerRef.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    const wantHeight = 320;
    const openUp = r.bottom + wantHeight > window.innerHeight - 8 && r.top > wantHeight;
    setRect({
      top: openUp ? Math.max(8, r.top - Math.min(wantHeight, r.top - 8) - 4) : r.bottom + 4,
      left: Math.min(r.left, window.innerWidth - Math.max(r.width, 320) - 8),
      width: Math.max(r.width, 320),
      openUp,
    });
  }, []);

  useLayoutEffect(() => {
    if (open) reposition();
  }, [open, reposition]);

  useEffect(() => {
    if (!open) return;
    const onDocDown = (e: MouseEvent) => {
      const target = e.target as Node;
      if (popRef.current?.contains(target) || triggerRef.current?.contains(target)) return;
      setOpen(false);
    };
    const onScroll = () => reposition();
    window.addEventListener('mousedown', onDocDown, true);
    window.addEventListener('resize', onScroll);
    document.addEventListener('scroll', onScroll, true);
    return () => {
      window.removeEventListener('mousedown', onDocDown, true);
      window.removeEventListener('resize', onScroll);
      document.removeEventListener('scroll', onScroll, true);
    };
  }, [open, reposition]);

  useEffect(() => {
    if (open) {
      setQuery('');
      setActive(0);
      window.setTimeout(() => inputRef.current?.focus(), 10);
    } else {
      setFacetSel({});
    }
  }, [open]);

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
      setActive((v) => Math.min(measured.length - 1, v + 1));
      return;
    }
    if (e.key === 'ArrowUp') {
      e.preventDefault();
      setActive((v) => Math.max(0, v - 1));
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
        className={`flex items-center gap-1 bg-[#27303e] border border-slate-700 hover:border-sky-500/60 rounded-sm text-slate-200 disabled:opacity-50 max-w-[240px] ${triggerSize} ${className ?? ''}`}
      >
        <span className={`truncate ${selected ? 'text-sky-300' : 'text-slate-500'}`}>
          {selected?.label ?? emptyLabel}
        </span>
        <ChevronDown className="w-3 h-3 shrink-0 opacity-60" />
      </button>

      {open && (
        <div
          ref={popRef}
          style={{ position: 'fixed', top: rect.top, left: rect.left, width: rect.width, zIndex: 10000 }}
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
              <button onClick={() => setQuery('')} className="text-slate-500 hover:text-white" title="清空">
                <X className="w-3 h-3" />
              </button>
            )}
            <span className="text-[10px] text-slate-500 mono shrink-0">{measured.length}</span>
          </div>

          {facets && facets.length > 0 && (
            <div className="px-2 py-1.5 border-b border-slate-800 space-y-1 shrink-0 max-h-[92px] overflow-y-auto">
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

          <div style={{ height: Math.min(300, Math.max(120, measured.length * ROW_HEIGHT + 4)) }}>
            <VirtualList
              count={measured.length}
              rowHeight={ROW_HEIGHT}
              className="h-full overflow-y-auto"
              emptyState={
                <div className="px-3 py-4 text-[11px] text-slate-500">
                  没有匹配项{options.length > 0 ? `（共 ${options.length} 个可选）` : ''}
                </div>
              }
              renderRow={(idx) => {
                const opt = measured[idx];
                return (
                  <button
                    onMouseEnter={() => setActive(idx)}
                    onClick={() => !opt.disabled && commit(opt.id)}
                    disabled={opt.disabled}
                    className={`w-full text-left px-2 flex items-center justify-between gap-2 h-[24px] rounded-sm disabled:opacity-40 ${
                      idx === active ? 'bg-sky-500/20 text-sky-100' : 'text-slate-300 hover:bg-sky-500/10'
                    }`}
                  >
                    <span className="truncate text-[11px]">
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

          <div className="px-2 py-1 border-t border-slate-800 text-[9px] text-slate-500 flex justify-between shrink-0">
            <span>↑↓ Enter Esc</span>
            <span>共 {measured.length} 条</span>
          </div>
        </div>
      )}
    </>
  );
};

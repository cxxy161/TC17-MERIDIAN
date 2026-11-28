import React, { useMemo, useState } from 'react';
import { Search } from 'lucide-react';
import { VirtualList } from '../components/VirtualList';
import type { EntityOption } from './entitySearch';

const ROW_HEIGHT = 34;

export interface EntitySearchListProps {
  options: EntityOption[];
  onPick: (option: EntityOption) => void;
  placeholder?: string;
  autoFocus?: boolean;
  className?: string;
  /** Show the group facet chips (功能窗口 / 物品 / 行星 / 地点). */
  showGroupFilter?: boolean;
  /** Initial active group tab (defaults to '全部'). */
  defaultGroup?: string;
}

/**
 * The shared entity browser used by both the ⌘K palette and the empty-tile picker, so the two can
 * no longer drift apart (they used to expand planets/items into different sets of entries).
 */
export const EntitySearchList: React.FC<EntitySearchListProps> = ({
  options,
  onPick,
  placeholder = '搜索公司 / 物品 / 行星 / 站点 / 面板…',
  autoFocus,
  className,
  showGroupFilter = true,
  defaultGroup = '全部',
}) => {
  const [query, setQuery] = useState('');
  const [group, setGroup] = useState<string>(defaultGroup);
  const [active, setActive] = useState(0);

  const groups = useMemo(() => {
    const seen = new Map<string, number>();
    for (const o of options) seen.set(o.group, (seen.get(o.group) ?? 0) + 1);
    return [...seen.entries()];
  }, [options]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return options.filter((o) => {
      if (group !== '全部' && o.group !== group) return false;
      if (!q) return true;
      return (
        o.label.toLowerCase().includes(q) ||
        (o.sub ?? '').toLowerCase().includes(q) ||
        (o.keywords ?? '').toLowerCase().includes(q) ||
        o.key.toLowerCase().includes(q)
      );
    });
  }, [options, query, group]);

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setActive((v) => Math.min(filtered.length - 1, v + 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setActive((v) => Math.max(0, v - 1));
    } else if (e.key === 'Enter') {
      e.preventDefault();
      const hit = filtered[active];
      if (hit) onPick(hit);
    }
  };

  // Keep the highlight inside the list when the query narrows results.
  const activeSafe = Math.min(active, Math.max(0, filtered.length - 1));

  return (
    <div className={`flex flex-col min-h-0 ${className ?? ''}`} onKeyDown={onKeyDown}>
      <div className="flex items-center gap-2 px-2.5 py-1.5 bg-[#242c38] border border-sky-500/30 rounded-sm shrink-0 mx-2 mt-2">
        <Search className="w-3.5 h-3.5 text-sky-400 shrink-0" />
        <input
          autoFocus={autoFocus}
          value={query}
          onChange={(e) => {
            setQuery(e.target.value);
            setActive(0);
          }}
          placeholder={placeholder}
          className="flex-1 bg-transparent outline-none text-[12px] text-slate-100 placeholder:text-slate-600"
        />
        <span className="text-[10px] mono text-slate-500">{filtered.length}</span>
      </div>

      {showGroupFilter && (
        <div className="flex items-center gap-1 flex-wrap px-2 pt-1.5 shrink-0">
          {[['全部', options.length] as const, ...groups].map(([g, n]) => (
            <button
              key={g}
              onClick={() => {
                setGroup(g);
                setActive(0);
              }}
              className={`text-[10px] px-1.5 py-[1px] rounded-[2px] border ${
                group === g
                  ? 'bg-sky-500/25 border-sky-400/60 text-sky-100'
                  : 'bg-[#1b212b] border-slate-700/70 text-slate-400 hover:text-slate-200'
              }`}
            >
              {g}
              <span className="text-slate-500 ml-1">{n}</span>
            </button>
          ))}
        </div>
      )}

      <VirtualList
        className="flex-1 min-h-0 overflow-y-auto px-2 py-1.5"
        count={filtered.length}
        rowHeight={ROW_HEIGHT}
        emptyState={
          <div className="px-3 py-6 text-center text-[11px] text-slate-500">
            没有匹配的实体。试试物品名、行星名、站点名或面板名；也可以切换上方分组。
          </div>
        }
        renderRow={(idx) => {
          const opt = filtered[idx];
          return (
            <button
              onMouseEnter={() => setActive(idx)}
              onClick={() => onPick(opt)}
              className={`w-full h-[32px] text-left px-2 rounded-sm flex items-center justify-between gap-2 ${
                idx === activeSafe ? 'bg-sky-500/20' : 'hover:bg-sky-500/10'
              }`}
            >
              <span className="min-w-0 flex flex-col">
                <span className="text-[11px] text-sky-200 truncate">{opt.label}</span>
                {opt.sub && <span className="text-[9px] text-slate-500 truncate">{opt.sub}</span>}
              </span>
              <span className="flex items-center gap-1.5 shrink-0">
                {opt.badge && (
                  <span className="text-[9px] px-1 bg-slate-700/60 text-slate-300 rounded-[2px]">
                    {opt.badge}
                  </span>
                )}
                <span className="text-[9px] text-slate-600">{opt.group}</span>
              </span>
            </button>
          );
        }}
      />
    </div>
  );
};

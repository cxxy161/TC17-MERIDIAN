import React, { useEffect, useMemo, useRef, useState } from 'react';
import type { DockviewApi } from 'dockview-react';
import { PANE_CATALOG, openPane, type PaneKind, type PaneParams } from './paneRegistry';
import { useGameStore } from '../store/useGameStore';

interface CommandPaletteProps {
  open: boolean;
  onClose: () => void;
  dockApi: DockviewApi | null;
}

interface QuickPreset {
  id: string;
  label: string;
  sub: string;
  kind: PaneKind;
  params: PaneParams;
}

export const CommandPalette: React.FC<CommandPaletteProps> = ({ open, onClose, dockApi }) => {
  const [query, setQuery] = useState('');
  const [floating, setFloating] = useState(false);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const state = useGameStore((s) => s.state);
  const catalog = useGameStore((s) => s.catalog);
  const planets = state?.planets ?? [];
  const items = catalog?.items ?? [];

  useEffect(() => {
    if (open) {
      setQuery('');
      window.setTimeout(() => inputRef.current?.focus(), 20);
    }
  }, [open]);

  const presets = useMemo<QuickPreset[]>(() => {
    const list: QuickPreset[] = PANE_CATALOG.map((p) => ({
      id: `base-${p.kind}`,
      label: p.label,
      sub: p.description,
      kind: p.kind,
      params: {},
    }));
    for (const pl of planets) {
      list.push({
        id: `pl-${pl.id}`,
        label: `行星 · ${pl.name}`,
        sub: `打开 ${pl.name} 遥测与买地面板`,
        kind: 'planet',
        params: { planetId: pl.id },
      });
      list.push({
        id: `fac-${pl.id}`,
        label: `产线 · ${pl.name}`,
        sub: `管理 ${pl.name} 设施与配方`,
        kind: 'factory',
        params: { planetId: pl.id },
      });
      list.push({
        id: `cg-${pl.id}`,
        label: `仓库 · ${pl.name}地表`,
        sub: `查看 ${pl.name} 地面仓库`,
        kind: 'cargo',
        params: { locationId: pl.id },
      });
    }
    list.push({
      id: 'cg-hub',
      label: '仓库 · 中心贸易枢纽站',
      sub: '查看枢纽站公共仓库',
      kind: 'cargo',
      params: { locationId: 'ST:HUB' },
    });
    for (const it of items.slice(0, 8)) {
      list.push({
        id: `ch-${it.id}`,
        label: `K线 · 中心枢纽 / ${it.name}`,
        sub: `并排打开 ${it.name} 价格走势图`,
        kind: 'chart',
        params: { stationId: 'ST:HUB', itemId: it.id },
      });
    }
    return list;
  }, [planets, items]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return presets.slice(0, 14);
    return presets
      .filter((p) => p.label.toLowerCase().includes(q) || p.sub.toLowerCase().includes(q))
      .slice(0, 16);
  }, [presets, query]);

  if (!open) return null;

  return (
    <div
      onClick={onClose}
      className="fixed inset-0 bg-black/65 backdrop-blur-[1px] z-50 flex items-start justify-center pt-20"
    >
      <div
        onClick={(e) => e.stopPropagation()}
        className="w-[500px] max-w-[92vw] bg-[#0b121b] border border-sky-400/45 rounded-[3px] shadow-2xl overflow-hidden"
      >
        <div className="px-3 py-2 border-b border-slate-800 flex items-center gap-2">
          <span className="text-sky-400 mono font-bold">&gt;</span>
          <input
            ref={inputRef}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="搜索并新开任意窗格（支持多开行星、K线、仓库并排）..."
            className="flex-1 bg-transparent outline-none text-slate-100 text-[12px]"
          />
          <label className="flex items-center gap-1 text-[10px] text-slate-400 cursor-pointer">
            <input
              type="checkbox"
              checked={floating}
              onChange={(e) => setFloating(e.target.checked)}
              className="accent-sky-400"
            />
            悬浮打开
          </label>
          <button onClick={onClose} className="pill-btn py-0 text-[10px]">
            关闭
          </button>
        </div>

        <div className="max-h-80 overflow-y-auto p-1.5 space-y-0.5">
          {filtered.map((item) => (
            <button
              key={item.id}
              onClick={() => {
                openPane(dockApi, item.kind, item.params, { floating });
                onClose();
              }}
              className="w-full text-left px-2.5 py-1.5 rounded-sm hover:bg-sky-500/15 flex items-center justify-between gap-3"
            >
              <span className="text-sky-300 font-medium">{item.label}</span>
              <span className="text-slate-500 text-[10px] truncate">{item.sub}</span>
            </button>
          ))}
        </div>
      </div>
    </div>
  );
};

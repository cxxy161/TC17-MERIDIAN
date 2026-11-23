import React from 'react';
import { GripHorizontal, X } from 'lucide-react';
import {
  paneTitle,
  type FloatingWindowItem,
  type PaneKind,
  type PaneParams,
} from './paneRegistry';
import { useCatalogIndex, useWorldIndex } from '../entities/hooks';
import { PaneRenderer } from './paneComponents';

interface FloatingWindowsLayerProps {
  windows: FloatingWindowItem[];
  onBringToFront: (id: string) => void;
  onMove: (id: string, x: number, y: number) => void;
  onResize: (id: string, w: number, h: number) => void;
  onClose: (id: string) => void;
  onSetParams: (id: string, patch: Partial<PaneParams>) => void;
  onReplaceContent: (id: string, kind: PaneKind, params: PaneParams) => void;
  onHoverTile: (tileId: string | null) => void;
  onDropOnTile: (winId: string, tileId: string) => void;
  openTemp: (kind: PaneKind, params?: PaneParams) => void;
}

function findEmptyTileUnderPoint(clientX: number, clientY: number): string | null {
  const els = document.elementsFromPoint(clientX, clientY);
  for (const el of els) {
    // Skip elements inside floating window layer
    if (el instanceof HTMLElement && el.closest('[data-floating-win="true"]')) {
      continue;
    }
    const emptyTile = el instanceof HTMLElement ? el.closest('[data-empty-tile="true"]') : null;
    if (emptyTile) {
      return emptyTile.getAttribute('data-tile-id');
    }
  }
  return null;
}

export const FloatingWindowsLayer: React.FC<FloatingWindowsLayerProps> = ({
  windows,
  onBringToFront,
  onMove,
  onResize,
  onClose,
  onSetParams,
  onReplaceContent,
  onHoverTile,
  onDropOnTile,
  openTemp,
}) => {
  const catalog = useCatalogIndex();
  const world = useWorldIndex();

  return (
    <>
      {windows.map((win) => {
        const title = paneTitle(win.kind, win.params, { catalog, world });

        const handleDragStart = (e: React.PointerEvent<HTMLDivElement>) => {
          if ((e.target as HTMLElement).closest('button')) return;
          e.preventDefault();
          onBringToFront(win.id);

          const startX = e.clientX;
          const startY = e.clientY;
          const origX = win.x;
          const origY = win.y;
          let moved = false;

          const onPointerMove = (ev: PointerEvent) => {
            const dx = ev.clientX - startX;
            const dy = ev.clientY - startY;
            if (Math.abs(dx) > 4 || Math.abs(dy) > 4) {
              moved = true;
            }
            onMove(win.id, Math.max(48, origX + dx), Math.max(38, origY + dy));
            if (moved) {
              onHoverTile(findEmptyTileUnderPoint(ev.clientX, ev.clientY));
            }
          };

          const onPointerUp = (ev: PointerEvent) => {
            window.removeEventListener('pointermove', onPointerMove);
            window.removeEventListener('pointerup', onPointerUp);
            onHoverTile(null);
            if (moved) {
              const targetTile = findEmptyTileUnderPoint(ev.clientX, ev.clientY);
              if (targetTile) {
                onDropOnTile(win.id, targetTile);
              }
            }
          };

          window.addEventListener('pointermove', onPointerMove);
          window.addEventListener('pointerup', onPointerUp);
        };

        const handleResizeStart = (e: React.PointerEvent<HTMLDivElement>) => {
          e.preventDefault();
          e.stopPropagation();
          onBringToFront(win.id);

          const startX = e.clientX;
          const startY = e.clientY;
          const origW = win.w;
          const origH = win.h;

          const onPointerMove = (ev: PointerEvent) => {
            onResize(
              win.id,
              Math.max(280, origW + (ev.clientX - startX)),
              Math.max(200, origH + (ev.clientY - startY)),
            );
          };
          const onPointerUp = () => {
            window.removeEventListener('pointermove', onPointerMove);
            window.removeEventListener('pointerup', onPointerUp);
          };
          window.addEventListener('pointermove', onPointerMove);
          window.addEventListener('pointerup', onPointerUp);
        };

        return (
          <div
            key={win.id}
            data-floating-win="true"
            onPointerDown={() => onBringToFront(win.id)}
            style={{
              left: win.x,
              top: win.y,
              width: win.w,
              height: win.h,
              zIndex: win.z,
            }}
            className="fixed flex flex-col bg-[#212834] border border-sky-400/60 rounded-[3px] shadow-[0_14px_40px_rgba(0,0,0,0.75)] overflow-hidden"
          >
            {/* Draggable Header */}
            <div
              onPointerDown={handleDragStart}
              className="h-7 bg-[#2a3545] border-b border-sky-400/25 px-2.5 flex items-center justify-between gap-2 cursor-move select-none shrink-0"
            >
              <div className="flex items-center gap-1.5 min-w-0">
                <GripHorizontal className="w-3.5 h-3.5 text-sky-400 shrink-0" />
                <span className="text-[11px] font-medium text-sky-100 truncate">{title}</span>
                <span className="text-[9px] px-1 py-0 bg-emerald-500/15 text-emerald-300 border border-emerald-500/30 shrink-0">
                  临时悬浮 · 拖入空窗口嵌入
                </span>
              </div>
              <button
                onClick={() => onClose(win.id)}
                title="关闭临时窗口"
                className="w-5 h-5 flex items-center justify-center text-slate-400 hover:text-rose-300 hover:bg-rose-500/20 shrink-0"
              >
                <X className="w-3.5 h-3.5" />
              </button>
            </div>

            <div className="flex-1 min-h-0 min-w-0">
              <PaneRenderer
                kind={win.kind}
                params={win.params}
                setParams={(patch) => onSetParams(win.id, patch)}
                openInPlace={(kind, params) => onReplaceContent(win.id, kind, params ?? {})}
                openTemp={openTemp}
              />
            </div>

            {/* Bottom-right resize grip */}
            <div
              onPointerDown={handleResizeStart}
              className="absolute right-0 bottom-0 w-3.5 h-3.5 cursor-nwse-resize"
              title="拖拽调整大小"
            >
              <svg viewBox="0 0 12 12" className="w-full h-full text-sky-400/60">
                <path d="M11 3L3 11M11 7L7 11" stroke="currentColor" strokeWidth="1.2" />
              </svg>
            </div>
          </div>
        );
      })}
    </>
  );
};

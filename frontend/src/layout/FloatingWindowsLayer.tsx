import React from 'react';
import {
  paneTitle,
  type FloatingWindowItem,
  type PaneKind,
  type PaneParams,
} from './paneRegistry';
import { useCatalogIndex, useWorldIndex } from '../entities/hooks';
import { PaneRenderer } from './paneComponents';
import { FloatingWindowFrame } from './FloatingWindowFrame';

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
        return (
          <FloatingWindowFrame
            key={win.id}
            x={win.x}
            y={win.y}
            w={win.w}
            h={win.h}
            z={win.z}
            title={title}
            badge={
              <span className="text-[9px] px-1 py-0 bg-emerald-500/15 text-emerald-300 border border-emerald-500/30 shrink-0">
                临时悬浮 · 拖入空窗口嵌入
              </span>
            }
            onFocus={() => onBringToFront(win.id)}
            onMove={(nx, ny) => onMove(win.id, nx, ny)}
            onResize={(nw, nh) => onResize(win.id, nw, nh)}
            onClose={() => onClose(win.id)}
            closeTitle="关闭临时窗口"
            onDragMove={(cx, cy) => onHoverTile(findEmptyTileUnderPoint(cx, cy))}
            onDragEnd={(cx, cy, moved) => {
              onHoverTile(null);
              if (moved) {
                const targetTile = findEmptyTileUnderPoint(cx, cy);
                if (targetTile) {
                  onDropOnTile(win.id, targetTile);
                }
              }
            }}
          >
            <PaneRenderer
              kind={win.kind}
              params={win.params}
              setParams={(patch) => onSetParams(win.id, patch)}
              openInPlace={(kind, params) => onReplaceContent(win.id, kind, params ?? {})}
              openTemp={openTemp}
            />
          </FloatingWindowFrame>
        );
      })}
    </>
  );
};

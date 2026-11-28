import React, { useRef, useState } from 'react';
import { MoreVertical, Settings, X } from 'lucide-react';
import { paneTitle, type PaneKind, type PaneParams, type TileContent } from './paneRegistry';
import { EmptyTilePane, PaneRenderer } from './paneComponents';
import { useCatalogIndex, useWorldIndex } from '../entities/hooks';
import { useGameStore } from '../store/useGameStore';
import type { SplitDirection, SplitNode } from './splitTree';
import { isCoarsePointer, useDragPointer } from '../utils/useDragPointer';

interface SplitLayoutProps {
  node: SplitNode;
  dropTargetTileId: string | null;
  onSplit: (tileId: string, dir: SplitDirection) => void;
  onClose: (tileId: string) => void;
  onClear: (tileId: string) => void;
  onSelectContent: (tileId: string, content: TileContent) => void;
  onSetParams: (tileId: string, patch: Partial<PaneParams>) => void;
  onResize: (splitId: string, ratio: number) => void;
  openTemp: (kind: PaneKind, params?: PaneParams) => void;
}

const TileFrame: React.FC<{
  tileId: string;
  content: TileContent | null;
  isDropTarget: boolean;
  onSplit: (tileId: string, dir: SplitDirection) => void;
  onClose: (tileId: string) => void;
  onClear: (tileId: string) => void;
  onSelectContent: (tileId: string, content: TileContent) => void;
  onSetParams: (tileId: string, patch: Partial<PaneParams>) => void;
  openTemp: (kind: PaneKind, params?: PaneParams) => void;
}> = ({
  tileId,
  content,
  isDropTarget,
  onSplit,
  onClose,
  onClear,
  onSelectContent,
  onSetParams,
  openTemp,
}) => {
  const [actionsOpen, setActionsOpen] = useState(false);
  const [confirmClose, setConfirmClose] = useState(false);
  const coarse = isCoarsePointer();
  const catalog = useCatalogIndex();
  const world = useWorldIndex();
  const tutorialHighlight = useGameStore((s) => s.tutorialHighlight);
  const isTutorialTarget = !!content && tutorialHighlight === `pane:${content.kind}`;

  // Always derived from params; never a stored copy (a stored title could keep naming a different
  // entity than the pane was actually showing).
  const title = content
    ? paneTitle(content.kind, content.params, { catalog, world })
    : '空窗口';

  return (
    <div
      data-tile-id={tileId}
      data-empty-tile={content === null ? 'true' : 'false'}
      className={`relative w-full h-full flex flex-col bg-[#1e242d] border rounded-[2px] overflow-hidden min-w-0 min-h-0 transition-shadow ${
        isDropTarget
          ? 'border-sky-400 ring-1 ring-sky-400/60'
          : isTutorialTarget
            ? 'border-cyan-400/80 ring-1 ring-cyan-400/80 shadow-[0_0_16px_rgba(34,211,238,0.22)]'
            : 'border-sky-500/15'
      }`}
    >
      {/* Single-Pane Header (NO tabs inside tile!) */}
      <div className="h-7 bg-[#27303e] border-b border-sky-500/15 px-2.5 flex items-center justify-between gap-2 shrink-0 select-none relative">
        <span className={`text-[11px] font-medium truncate ${content ? 'text-slate-100' : 'text-slate-400'}`}>
          {title}
        </span>

        {/* Gear click (and optional desktop hover) reveals Split / Swap / Close */}
        <div
          className="flex items-center shrink-0 h-5 relative z-20"
          onMouseEnter={() => {
            if (!coarse) setActionsOpen(true);
          }}
          onMouseLeave={() => {
            if (!coarse) {
              setActionsOpen(false);
              setConfirmClose(false);
            }
          }}
        >
          {actionsOpen && (
            <div
              className="fixed inset-0 z-30"
              onClick={() => {
                setActionsOpen(false);
                setConfirmClose(false);
              }}
            />
          )}
          {actionsOpen ? (
            <div className="relative z-40 flex items-center gap-1.5 bg-[#1e2530] border border-sky-500/35 rounded-[3px] p-1 shadow-lg">
              <button
                type="button"
                onClick={() => {
                  setActionsOpen(false);
                  setConfirmClose(false);
                  onSplit(tileId, 'horizontal');
                }}
                title="上下分割（新开空窗口）"
                className="min-w-[24px] min-h-[24px] touch-target flex items-center justify-center text-slate-300 hover:text-white hover:bg-sky-500/20 rounded-[2px]"
              >
                <span className="block w-3.5 h-[2px] bg-current" />
              </button>
              <button
                type="button"
                onClick={() => {
                  setActionsOpen(false);
                  setConfirmClose(false);
                  onSplit(tileId, 'vertical');
                }}
                title="左右分割（新开空窗口）"
                className="min-w-[24px] min-h-[24px] touch-target flex items-center justify-center text-slate-300 hover:text-white hover:bg-sky-500/20 rounded-[2px]"
              >
                <span className="block w-[2px] h-3.5 bg-current" />
              </button>
              <button
                type="button"
                onClick={() => {
                  setActionsOpen(false);
                  setConfirmClose(false);
                  onClear(tileId);
                }}
                title="更换窗口内容（置为空窗口）"
                className="min-w-[24px] min-h-[24px] touch-target flex items-center justify-center bg-sky-500/20 text-sky-300 hover:bg-sky-500/40 hover:text-white rounded-[2px]"
              >
                <MoreVertical className="w-3.5 h-3.5" />
              </button>
              {confirmClose ? (
                <button
                  type="button"
                  onClick={() => {
                    setActionsOpen(false);
                    setConfirmClose(false);
                    onClose(tileId);
                  }}
                  className="px-2 min-h-[24px] touch-target text-[10px] font-medium bg-rose-500/30 border border-rose-400/70 text-rose-100 rounded-[2px] whitespace-nowrap"
                >
                  确认关闭
                </button>
              ) : (
                <button
                  type="button"
                  onClick={() => {
                    if (coarse || content !== null) {
                      setConfirmClose(true);
                    } else {
                      setActionsOpen(false);
                      onClose(tileId);
                    }
                  }}
                  title="关闭此窗口"
                  className="min-w-[24px] min-h-[24px] touch-target ml-1 flex items-center justify-center text-slate-300 hover:text-rose-300 hover:bg-rose-500/20 rounded-[2px]"
                >
                  <X className="w-3.5 h-3.5" />
                </button>
              )}
            </div>
          ) : (
            <button
              type="button"
              aria-label="窗口布局操作"
              onClick={() => setActionsOpen(true)}
              className="min-w-[24px] min-h-[24px] touch-target flex items-center justify-center text-slate-400 hover:text-sky-300"
            >
              <Settings className="w-3.5 h-3.5" />
            </button>
          )}
        </div>
      </div>

      {/* Tile Body */}
      <div className="flex-1 min-h-0 min-w-0 relative">
        {content ? (
          <PaneRenderer
            kind={content.kind}
            params={content.params}
            setParams={(patch) => onSetParams(tileId, patch)}
            openInPlace={(kind, params) => onSelectContent(tileId, { kind, params: params ?? {} })}
            openTemp={openTemp}
          />
        ) : (
          <EmptyTilePane onSelect={(c) => onSelectContent(tileId, c)} />
        )}

        {isDropTarget && (
          <div className="absolute inset-0 bg-sky-500/15 border-2 border-dashed border-sky-400 flex items-center justify-center pointer-events-none z-20">
            <span className="px-3 py-1 bg-[#1b222c]/95 border border-sky-400 text-sky-200 text-[11px] font-medium">
              松手嵌入此空窗口
            </span>
          </div>
        )}
      </div>
    </div>
  );
};

export const SplitLayout: React.FC<SplitLayoutProps> = ({
  node,
  dropTargetTileId,
  onSplit,
  onClose,
  onClear,
  onSelectContent,
  onSetParams,
  onResize,
  openTemp,
}) => {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const startDragPointer = useDragPointer();

  if (node.type === 'leaf') {
    return (
      <TileFrame
        tileId={node.id}
        content={node.content}
        isDropTarget={dropTargetTileId === node.id}
        onSplit={onSplit}
        onClose={onClose}
        onClear={onClear}
        onSelectContent={onSelectContent}
        onSetParams={onSetParams}
        openTemp={openTemp}
      />
    );
  }

  const isRow = node.direction === 'horizontal'; // horizontal divider splits top/bottom

  const startDrag = (e: React.PointerEvent<HTMLDivElement>) => {
    e.preventDefault();
    const box = containerRef.current?.getBoundingClientRect();
    if (!box) return;
    const totalSize = isRow ? Math.max(1, box.height) : Math.max(1, box.width);
    const origin = isRow ? box.top : box.left;
    const pointerPos = isRow ? e.clientY : e.clientX;
    const currentDividerPos = origin + node.ratio * totalSize;
    const grabOffset = pointerPos - currentDividerPos;

    startDragPointer(e, {
      thresholdPx: e.pointerType === 'touch' ? 6 : 2,
      onMove: (ev) => {
        const pos = isRow ? ev.clientY : ev.clientX;
        const nextRatio = (pos - grabOffset - origin) / totalSize;
        onResize(node.id, nextRatio);
      },
    });
  };

  return (
    <div
      ref={containerRef}
      className={`w-full h-full flex ${isRow ? 'flex-col' : 'flex-row'} min-w-0 min-h-0`}
    >
      <div
        style={{ flexBasis: `${node.ratio * 100}%` }}
        className="min-w-0 min-h-0 overflow-hidden shrink-0 grow-0"
      >
        <SplitLayout
          node={node.first}
          dropTargetTileId={dropTargetTileId}
          onSplit={onSplit}
          onClose={onClose}
          onClear={onClear}
          onSelectContent={onSelectContent}
          onSetParams={onSetParams}
          onResize={onResize}
          openTemp={openTemp}
        />
      </div>

      <div
        onPointerDown={startDrag}
        onContextMenu={(e) => e.preventDefault()}
        className={`${
          isRow
            ? 'h-1.5 w-full cursor-row-resize'
            : 'w-1.5 h-full cursor-col-resize'
        } relative shrink-0 select-none touch-none group`}
      >
        {/* Expanded invisible hit area (22px wide/tall) so touch never misses into neighbor pane */}
        <div
          className={`absolute ${
            isRow ? '-inset-y-2 inset-x-0' : '-inset-x-2 inset-y-0'
          } z-10`}
        />
        {/* Always-visible 1px subtle seam */}
        <div
          className={`pointer-events-none absolute ${
            isRow
              ? 'inset-x-0 top-1/2 -translate-y-1/2 h-[1px]'
              : 'inset-y-0 left-1/2 -translate-x-1/2 w-[1px]'
          } bg-sky-500/20 group-hover:bg-sky-400/70 transition-colors`}
        />
      </div>

      <div className="flex-1 min-w-0 min-h-0 overflow-hidden">
        <SplitLayout
          node={node.second}
          dropTargetTileId={dropTargetTileId}
          onSplit={onSplit}
          onClose={onClose}
          onClear={onClear}
          onSelectContent={onSelectContent}
          onSetParams={onSetParams}
          onResize={onResize}
          openTemp={openTemp}
        />
      </div>
    </div>
  );
};

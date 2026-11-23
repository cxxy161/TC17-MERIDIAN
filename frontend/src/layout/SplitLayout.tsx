import React, { useRef, useState } from 'react';
import { MoreVertical, Settings, X } from 'lucide-react';
import { formatPaneTitle, type PaneKind, type PaneParams, type TileContent } from './paneRegistry';
import { EmptyTilePane, PaneRenderer } from './paneComponents';
import type { SplitDirection, SplitNode } from './splitTree';

interface SplitLayoutProps {
  node: SplitNode;
  dropTargetTileId: string | null;
  onSplit: (tileId: string, dir: SplitDirection) => void;
  onClose: (tileId: string) => void;
  onClear: (tileId: string) => void;
  onSelectContent: (tileId: string, content: TileContent) => void;
  onSetTitle: (tileId: string, title: string) => void;
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
  onSetTitle: (tileId: string, title: string) => void;
  openTemp: (kind: PaneKind, params?: PaneParams) => void;
}> = ({
  tileId,
  content,
  isDropTarget,
  onSplit,
  onClose,
  onClear,
  onSelectContent,
  onSetTitle,
  openTemp,
}) => {
  const [actionsHover, setActionsHover] = useState(false);

  const title = content
    ? content.title ?? formatPaneTitle(content.kind, content.params)
    : '空窗口';

  return (
    <div
      data-tile-id={tileId}
      className={`relative w-full h-full flex flex-col bg-[#0b1119] border rounded-[2px] overflow-hidden min-w-0 min-h-0 ${
        isDropTarget
          ? 'border-sky-400 ring-1 ring-sky-400/60'
          : 'border-sky-500/15'
      }`}
    >
      {/* Single-Pane Header (NO tabs inside tile!) */}
      <div className="h-7 bg-[#0e1724] border-b border-sky-500/15 px-2.5 flex items-center justify-between gap-2 shrink-0 select-none">
        <span className={`text-[11px] font-medium truncate ${content ? 'text-slate-100' : 'text-slate-400'}`}>
          {title}
        </span>

        {/* Gear hover -> reveals Split Horizontal (─), Split Vertical (│), Close (✕), Swap/Empty (⋮) */}
        <div
          className="flex items-center shrink-0 h-5"
          onMouseEnter={() => setActionsHover(true)}
          onMouseLeave={() => setActionsHover(false)}
        >
          {actionsHover ? (
            <div className="flex items-center gap-0.5 bg-[#09111a] border border-sky-500/25 rounded-[2px] p-0.5">
              <button
                onClick={() => {
                  setActionsHover(false);
                  onSplit(tileId, 'horizontal');
                }}
                title="上下分割（新开空窗口）"
                className="w-5 h-5 flex items-center justify-center text-slate-300 hover:text-white hover:bg-sky-500/20"
              >
                <span className="block w-3 h-[1.5px] bg-current" />
              </button>
              <button
                onClick={() => {
                  setActionsHover(false);
                  onSplit(tileId, 'vertical');
                }}
                title="左右分割（新开空窗口）"
                className="w-5 h-5 flex items-center justify-center text-slate-300 hover:text-white hover:bg-sky-500/20"
              >
                <span className="block w-[1.5px] h-3 bg-current" />
              </button>
              <button
                onClick={() => {
                  setActionsHover(false);
                  onClose(tileId);
                }}
                title="关闭此窗口"
                className="w-5 h-5 flex items-center justify-center text-slate-300 hover:text-rose-300 hover:bg-rose-500/20"
              >
                <X className="w-3.5 h-3.5" />
              </button>
              <button
                onClick={() => {
                  setActionsHover(false);
                  onClear(tileId);
                }}
                title="更换窗口内容（置为空窗口）"
                className="w-5 h-5 flex items-center justify-center bg-sky-500/25 text-sky-300 hover:bg-sky-500/45 hover:text-white"
              >
                <MoreVertical className="w-3.5 h-3.5" />
              </button>
            </div>
          ) : (
            <button
              aria-label="窗口布局操作"
              className="w-5 h-5 flex items-center justify-center text-slate-400 hover:text-sky-300"
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
            setTitle={(t) => onSetTitle(tileId, t)}
            openTemp={openTemp}
          />
        ) : (
          <EmptyTilePane onSelect={(c) => onSelectContent(tileId, c)} />
        )}

        {isDropTarget && (
          <div className="absolute inset-0 bg-sky-500/15 border-2 border-dashed border-sky-400 flex items-center justify-center pointer-events-none z-20">
            <span className="px-3 py-1 bg-[#08101a]/95 border border-sky-400 text-sky-200 text-[11px] font-medium">
              松手嵌入并覆盖此窗口
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
  onSetTitle,
  onResize,
  openTemp,
}) => {
  const containerRef = useRef<HTMLDivElement | null>(null);

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
        onSetTitle={onSetTitle}
        openTemp={openTemp}
      />
    );
  }

  const isRow = node.direction === 'horizontal'; // horizontal divider splits top/bottom

  const startDrag = (e: React.PointerEvent<HTMLDivElement>) => {
    e.preventDefault();
    const box = containerRef.current?.getBoundingClientRect();
    if (!box) return;

    const onMove = (ev: PointerEvent) => {
      const nextRatio = isRow
        ? (ev.clientY - box.top) / Math.max(1, box.height)
        : (ev.clientX - box.left) / Math.max(1, box.width);
      onResize(node.id, nextRatio);
    };
    const onUp = () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
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
          onSetTitle={onSetTitle}
          onResize={onResize}
          openTemp={openTemp}
        />
      </div>

      <div
        onPointerDown={startDrag}
        className={`${
          isRow
            ? 'h-1.5 w-full cursor-row-resize hover:bg-sky-400/40'
            : 'w-1.5 h-full cursor-col-resize hover:bg-sky-400/40'
        } shrink-0 bg-transparent transition-colors`}
      />

      <div className="flex-1 min-w-0 min-h-0 overflow-hidden">
        <SplitLayout
          node={node.second}
          dropTargetTileId={dropTargetTileId}
          onSplit={onSplit}
          onClose={onClose}
          onClear={onClear}
          onSelectContent={onSelectContent}
          onSetTitle={onSetTitle}
          onResize={onResize}
          openTemp={openTemp}
        />
      </div>
    </div>
  );
};

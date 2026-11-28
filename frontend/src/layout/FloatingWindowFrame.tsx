import React from 'react';
import { GripHorizontal, X } from 'lucide-react';

export interface FloatingWindowFrameProps {
  x: number;
  y: number;
  w: number;
  h: number;
  z: number;
  minW?: number;
  minH?: number;
  title: React.ReactNode;
  badge?: React.ReactNode;
  headerExtra?: React.ReactNode;
  onFocus?: () => void;
  onMove: (x: number, y: number) => void;
  onResize: (w: number, h: number) => void;
  onClose: () => void;
  closeTitle?: string;
  onDragMove?: (clientX: number, clientY: number) => void;
  onDragEnd?: (clientX: number, clientY: number, moved: boolean) => void;
  children: React.ReactNode;
}

/**
 * Shared floating window shell used by both temporary panes (`FloatingWindowsLayer`) and the
 * tutorial guide (`TutorialOverlay`), keeping drag, resize, z-index and visual chrome identical.
 */
export const FloatingWindowFrame: React.FC<FloatingWindowFrameProps> = ({
  x,
  y,
  w,
  h,
  z,
  minW = 280,
  minH = 200,
  title,
  badge,
  headerExtra,
  onFocus,
  onMove,
  onResize,
  onClose,
  closeTitle = '关闭窗口',
  onDragMove,
  onDragEnd,
  children,
}) => {
  const handleDragStart = (e: React.PointerEvent<HTMLDivElement>) => {
    if ((e.target as HTMLElement).closest('button')) return;
    e.preventDefault();
    onFocus?.();

    const startX = e.clientX;
    const startY = e.clientY;
    const origX = x;
    const origY = y;
    let moved = false;

    const onPointerMove = (ev: PointerEvent) => {
      const dx = ev.clientX - startX;
      const dy = ev.clientY - startY;
      if (Math.abs(dx) > 4 || Math.abs(dy) > 4) {
        moved = true;
      }
      const maxX = Math.max(48, window.innerWidth - 120);
      const maxY = Math.max(38, window.innerHeight - 60);
      const nextX = Math.max(8, Math.min(maxX, origX + dx));
      const nextY = Math.max(38, Math.min(maxY, origY + dy));
      onMove(nextX, nextY);
      if (moved) {
        onDragMove?.(ev.clientX, ev.clientY);
      }
    };

    const onPointerUp = (ev: PointerEvent) => {
      window.removeEventListener('pointermove', onPointerMove);
      window.removeEventListener('pointerup', onPointerUp);
      onDragEnd?.(ev.clientX, ev.clientY, moved);
    };

    window.addEventListener('pointermove', onPointerMove);
    window.addEventListener('pointerup', onPointerUp);
  };

  const handleResizeStart = (e: React.PointerEvent<HTMLDivElement>) => {
    e.preventDefault();
    e.stopPropagation();
    onFocus?.();

    const startX = e.clientX;
    const startY = e.clientY;
    const origW = w;
    const origH = h;

    const onPointerMove = (ev: PointerEvent) => {
      onResize(
        Math.max(minW, Math.min(window.innerWidth - x - 8, origW + (ev.clientX - startX))),
        Math.max(minH, Math.min(window.innerHeight - y - 8, origH + (ev.clientY - startY))),
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
      data-floating-win="true"
      onPointerDown={() => onFocus?.()}
      style={{
        left: x,
        top: y,
        width: w,
        height: h,
        zIndex: z,
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
          {badge}
        </div>
        <div className="flex items-center gap-1 shrink-0">
          {headerExtra}
          <button
            type="button"
            onClick={onClose}
            title={closeTitle}
            className="w-5 h-5 flex items-center justify-center text-slate-400 hover:text-rose-300 hover:bg-rose-500/20 shrink-0 rounded-[2px]"
          >
            <X className="w-3.5 h-3.5" />
          </button>
        </div>
      </div>

      <div className="flex-1 min-h-0 min-w-0 relative flex flex-col">{children}</div>

      {/* Bottom-right resize grip */}
      <div
        onPointerDown={handleResizeStart}
        className="absolute right-0 bottom-0 w-3.5 h-3.5 cursor-nwse-resize z-10"
        title="拖拽调整大小"
      >
        <svg viewBox="0 0 12 12" className="w-full h-full text-sky-400/60">
          <path d="M11 3L3 11M11 7L7 11" stroke="currentColor" strokeWidth="1.2" />
        </svg>
      </div>
    </div>
  );
};

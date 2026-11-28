import React, { useState } from 'react';
import { GripHorizontal, Maximize2, Minimize2, X } from 'lucide-react';
import { useDragPointer } from '../utils/useDragPointer';
import { useIsPortrait } from '../utils/useViewportMode';

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
  const isPortrait = useIsPortrait();
  const [maximized, setMaximized] = useState(false);
  const effectiveMaximized = isPortrait && maximized;
  const startDragPointer = useDragPointer();

  const vw = typeof window !== 'undefined' ? window.innerWidth : 1280;
  const vh = typeof window !== 'undefined' ? window.innerHeight : 800;
  const effW = effectiveMaximized
    ? Math.max(240, vw - 12)
    : Math.max(Math.min(minW, vw - 12), Math.min(w, vw - 12));
  const effH = effectiveMaximized
    ? Math.max(200, vh - 88)
    : Math.max(Math.min(minH, vh - 88), Math.min(h, vh - 88));
  const effX = effectiveMaximized ? 6 : Math.max(6, Math.min(x, Math.max(6, vw - effW - 6)));
  const effY = effectiveMaximized ? 38 : Math.max(38, Math.min(y, Math.max(38, vh - effH - 48)));

  const handleDragStart = (e: React.PointerEvent<HTMLDivElement>) => {
    if (effectiveMaximized) return;
    if ((e.target as HTMLElement).closest('button')) return;
    e.preventDefault();
    onFocus?.();

    const origX = effX;
    const origY = effY;

    startDragPointer(e, {
      thresholdPx: e.pointerType === 'touch' ? 8 : 4,
      onMove: (ev, session) => {
        const curVw = window.innerWidth;
        const curVh = window.innerHeight;
        const maxX = Math.max(6, curVw - effW - 6);
        const maxY = Math.max(38, curVh - effH - 48);
        const nextX = Math.max(6, Math.min(maxX, origX + session.dx));
        const nextY = Math.max(38, Math.min(maxY, origY + session.dy));
        onMove(nextX, nextY);
        onDragMove?.(ev.clientX, ev.clientY);
      },
      onEnd: (ev, session, cancelled) => {
        onDragEnd?.(
          ev ? ev.clientX : session.lastX,
          ev ? ev.clientY : session.lastY,
          !cancelled && session.moved,
        );
      },
    });
  };

  const handleResizeStart = (e: React.PointerEvent<HTMLDivElement>) => {
    if (effectiveMaximized) return;
    e.preventDefault();
    e.stopPropagation();
    onFocus?.();

    const origW = effW;
    const origH = effH;

    startDragPointer(e, {
      thresholdPx: 2,
      onMove: (_ev, session) => {
        const curVw = window.innerWidth;
        const curVh = window.innerHeight;
        const effMinW = Math.min(minW, curVw - 12);
        const effMinH = Math.min(minH, curVh - 88);
        onResize(
          Math.max(effMinW, Math.min(curVw - effX - 6, origW + session.dx)),
          Math.max(effMinH, Math.min(curVh - effY - 48, origH + session.dy)),
        );
      },
    });
  };

  return (
    <div
      data-floating-win="true"
      onPointerDown={() => onFocus?.()}
      style={{
        left: effX,
        top: effY,
        width: effW,
        height: effH,
        zIndex: z,
      }}
      className="fixed flex flex-col bg-[#212834] border border-sky-400/60 rounded-[3px] shadow-[0_14px_40px_rgba(0,0,0,0.75)] overflow-hidden"
    >
      {/* Draggable Header */}
      <div
        onPointerDown={handleDragStart}
        onContextMenu={(e) => e.preventDefault()}
        className={`${isPortrait ? 'h-8' : 'h-7'} bg-[#2a3545] border-b border-sky-400/25 px-2.5 flex items-center justify-between gap-2 touch-none select-none shrink-0 ${
          effectiveMaximized ? '' : 'cursor-move'
        }`}
      >
        <div className="flex items-center gap-1.5 min-w-0">
          <GripHorizontal className="w-3.5 h-3.5 text-sky-400 shrink-0" />
          <span className="text-[11px] font-medium text-sky-100 truncate">{title}</span>
          {badge}
        </div>
        <div className={`flex items-center shrink-0 ${isPortrait ? 'gap-1.5 pl-2' : 'gap-1'}`}>
          {headerExtra}
          {isPortrait && (
            <button
              type="button"
              onClick={() => setMaximized((v) => !v)}
              title={maximized ? '还原窗口大小' : '最大化窗口'}
              className="w-6 h-6 touch-target flex items-center justify-center text-slate-400 hover:text-sky-200 hover:bg-sky-500/20 shrink-0 rounded-[2px]"
            >
              {maximized ? <Minimize2 className="w-3 h-3" /> : <Maximize2 className="w-3 h-3" />}
            </button>
          )}
          <button
            type="button"
            onClick={onClose}
            title={closeTitle}
            className={`${
              isPortrait ? 'w-6 h-6 touch-target' : 'w-5 h-5'
            } flex items-center justify-center text-slate-400 hover:text-rose-300 hover:bg-rose-500/20 shrink-0 rounded-[2px]`}
          >
            <X className="w-3.5 h-3.5" />
          </button>
        </div>
      </div>

      <div className="flex-1 min-h-0 min-w-0 relative flex flex-col">{children}</div>

      {/* Bottom-right resize grip */}
      {!effectiveMaximized && (
        <div
          onPointerDown={handleResizeStart}
          onContextMenu={(e) => e.preventDefault()}
          className="absolute right-0 bottom-0 w-7 h-7 flex items-end justify-end p-0.5 cursor-nwse-resize z-10 touch-none select-none"
          title="拖拽调整大小"
        >
          <svg viewBox="0 0 12 12" className="w-3.5 h-3.5 text-sky-400/70">
            <path d="M11 3L3 11M11 7L7 11" stroke="currentColor" strokeWidth="1.2" />
          </svg>
        </div>
      )}
    </div>
  );
};

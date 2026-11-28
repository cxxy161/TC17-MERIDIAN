import { useCallback, useEffect, useRef } from 'react';

export function isCoarsePointer(): boolean {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return false;
  return window.matchMedia('(pointer: coarse)').matches;
}

export interface DragSession {
  pointerId: number;
  startX: number;
  startY: number;
  lastX: number;
  lastY: number;
  dx: number;
  dy: number;
  moved: boolean;
  pointerType: string;
}

export interface StartDragOptions {
  /** Minimum movement in px before `onMove` fires and `moved` becomes true. Defaults to 6. */
  thresholdPx?: number;
  onMove?: (ev: PointerEvent, session: DragSession) => void;
  onEnd?: (ev: PointerEvent | null, session: DragSession, cancelled: boolean) => void;
}

/**
 * Unified pointer-capture drag helper with pointerId filtering, pointercancel/lostpointercapture
 * cleanup, move threshold, and body user-select suppression for reliable touch & mouse dragging.
 */
export function useDragPointer() {
  const cleanupRef = useRef<(() => void) | null>(null);

  useEffect(() => {
    return () => {
      cleanupRef.current?.();
    };
  }, []);

  const startDrag = useCallback(
    (e: React.PointerEvent<HTMLElement>, options: StartDragOptions) => {
      cleanupRef.current?.();

      const targetEl = e.currentTarget;
      const pointerId = e.pointerId;
      const thresholdPx =
        options.thresholdPx ?? (e.pointerType === 'touch' ? 8 : 4);

      const session: DragSession = {
        pointerId,
        startX: e.clientX,
        startY: e.clientY,
        lastX: e.clientX,
        lastY: e.clientY,
        dx: 0,
        dy: 0,
        moved: thresholdPx <= 0,
        pointerType: e.pointerType || 'mouse',
      };

      const prevUserSelect = document.body.style.userSelect;
      const prevWebkitUserSelect = (document.body.style as CSSStyleDeclaration & { webkitUserSelect?: string }).webkitUserSelect;
      document.body.style.userSelect = 'none';
      (document.body.style as CSSStyleDeclaration & { webkitUserSelect?: string }).webkitUserSelect = 'none';

      try {
        targetEl.setPointerCapture(pointerId);
      } catch {
        // Ignore if pointer already inactive
      }

      let ended = false;
      const finish = (ev: PointerEvent | null, cancelled: boolean) => {
        if (ended) return;
        ended = true;
        cleanup();
        options.onEnd?.(ev, session, cancelled);
      };

      const onPointerMove = (ev: PointerEvent) => {
        if (ev.pointerId !== pointerId) return;
        session.dx = ev.clientX - session.startX;
        session.dy = ev.clientY - session.startY;
        session.lastX = ev.clientX;
        session.lastY = ev.clientY;
        if (!session.moved && Math.hypot(session.dx, session.dy) >= thresholdPx) {
          session.moved = true;
        }
        if (session.moved) {
          options.onMove?.(ev, session);
        }
      };

      const onPointerUp = (ev: PointerEvent) => {
        if (ev.pointerId !== pointerId) return;
        finish(ev, false);
      };

      const onPointerCancel = (ev: PointerEvent) => {
        if (ev.pointerId !== pointerId) return;
        finish(ev, true);
      };

      const onContextMenu = (ev: Event) => {
        ev.preventDefault();
      };

      const cleanup = () => {
        window.removeEventListener('pointermove', onPointerMove);
        window.removeEventListener('pointerup', onPointerUp);
        window.removeEventListener('pointercancel', onPointerCancel);
        window.removeEventListener('contextmenu', onContextMenu);
        targetEl.removeEventListener('lostpointercapture', onPointerCancel as EventListener);
        document.body.style.userSelect = prevUserSelect;
        (document.body.style as CSSStyleDeclaration & { webkitUserSelect?: string }).webkitUserSelect =
          prevWebkitUserSelect ?? '';
        try {
          if (targetEl.hasPointerCapture(pointerId)) {
            targetEl.releasePointerCapture(pointerId);
          }
        } catch {
          // Ignore
        }
        cleanupRef.current = null;
      };

      cleanupRef.current = () => finish(null, true);
      window.addEventListener('pointermove', onPointerMove);
      window.addEventListener('pointerup', onPointerUp);
      window.addEventListener('pointercancel', onPointerCancel);
      window.addEventListener('contextmenu', onContextMenu);
      targetEl.addEventListener('lostpointercapture', onPointerCancel as EventListener);
    },
    [],
  );

  return startDrag;
}

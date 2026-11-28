import React, { useEffect, useState } from 'react';
import { useEntitySearch } from './entitySearch';
import { EntitySearchList } from './EntitySearchList';
import type { PaneKind, PaneParams } from './paneRegistry';

interface CommandPaletteProps {
  open: boolean;
  onClose: () => void;
  openTemp: (kind: PaneKind, params?: PaneParams) => void;
}

/**
 * Global entity search. It no longer builds (or truncates) its own list: it renders the shared
 * entity index, so every item / planet / station is reachable by name and the "first 10 items"
 * ceiling is gone.
 */
export const CommandPalette: React.FC<CommandPaletteProps> = ({ open, onClose, openTemp }) => {
  const options = useEntitySearch();
  const [vvHeight, setVvHeight] = useState<number>(() =>
    typeof window !== 'undefined' ? window.visualViewport?.height ?? window.innerHeight : 800,
  );

  useEffect(() => {
    if (!open) return;
    const syncViewport = () => {
      setVvHeight(window.visualViewport?.height ?? window.innerHeight);
    };
    syncViewport();
    const vv = window.visualViewport;
    vv?.addEventListener('resize', syncViewport);
    window.addEventListener('resize', syncViewport);
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => {
      vv?.removeEventListener('resize', syncViewport);
      window.removeEventListener('resize', syncViewport);
      window.removeEventListener('keydown', onKey);
    };
  }, [open, onClose]);

  if (!open) return null;

  const panelHeight = Math.max(200, Math.min(440, vvHeight - 32));

  return (
    <div
      onClick={onClose}
      className="fixed inset-0 bg-black/65 backdrop-blur-[1px] z-[9999] flex items-start justify-center pt-3 sm:pt-16 px-2"
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{ height: panelHeight, maxHeight: 'calc(100dvh - 24px)' }}
        className="w-[560px] max-w-[96vw] bg-[#212834] border border-sky-400/45 rounded-[3px] shadow-2xl overflow-hidden flex flex-col"
      >
        <EntitySearchList
          options={options}
          onPick={(opt) => {
            openTemp(opt.content.kind, opt.content.params);
            onClose();
          }}
          autoFocus
          className="flex-1 min-h-0"
        />
      </div>
    </div>
  );
};

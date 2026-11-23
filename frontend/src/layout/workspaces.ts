import type { DockviewApi, SerializedDockview } from 'dockview-react';
import { openPane } from './paneRegistry';

export interface WorkspaceEntry {
  id: string;
  name: string;
  layout?: SerializedDockview;
}

const STORAGE_KEY = 'meridian.workspaces.v1';
const ACTIVE_KEY = 'meridian.active_workspace.v1';

export const DEFAULT_WORKSPACES: WorkspaceEntry[] = [
  { id: 'ws-overview', name: '01 遥测总览' },
  { id: 'ws-market', name: '02 双图盯盘' },
  { id: 'ws-script', name: '03 脚本终端' },
];

export function loadSavedWorkspaces(): { list: WorkspaceEntry[]; activeId: string } {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    const active = window.localStorage.getItem(ACTIVE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw) as WorkspaceEntry[];
      if (Array.isArray(parsed) && parsed.length > 0) {
        return {
          list: parsed,
          activeId: active && parsed.some((w) => w.id === active) ? active : parsed[0].id,
        };
      }
    }
  } catch {
    // ignore corrupted local storage
  }
  return { list: DEFAULT_WORKSPACES, activeId: DEFAULT_WORKSPACES[0].id };
}

export function persistWorkspaces(list: WorkspaceEntry[], activeId: string): void {
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(list));
    window.localStorage.setItem(ACTIVE_KEY, activeId);
  } catch {
    // ignore storage quota errors
  }
}

export function populateDefaultLayout(api: DockviewApi, wsId: string): void {
  api.clear();

  if (wsId === 'ws-market') {
    const c1 = openPane(api, 'chart', { stationId: 'ST:HUB', itemId: 'steel' });
    if (c1) {
      openPane(api, 'chart', { stationId: 'ST:HUB', itemId: 'ore' }, { referencePanelId: c1, direction: 'right' });
      const ob = openPane(api, 'orderbook', { stationId: 'ST:HUB', itemId: 'steel' }, { referencePanelId: c1, direction: 'below' });
      if (ob) {
        const tk = openPane(api, 'ticker', { stationId: 'ST:HUB' }, { referencePanelId: ob, direction: 'right' });
        if (tk) {
          openPane(api, 'ranking', {}, { referencePanelId: tk, direction: 'right' });
        }
      }
    }
    return;
  }

  if (wsId === 'ws-script') {
    const ide = openPane(api, 'script', {});
    if (ide) {
      openPane(api, 'console', {}, { referencePanelId: ide, direction: 'below' });
      openPane(api, 'ticker', { stationId: 'ST:HUB' }, { referencePanelId: ide, direction: 'right' });
    }
    return;
  }

  // Default overview workspace ('ws-overview' or new custom workspaces)
  const orbit = openPane(api, 'orbit', {});
  if (orbit) {
    const planet = openPane(api, 'planet', { planetId: 'P2' }, { referencePanelId: orbit, direction: 'left' });
    const factory = openPane(api, 'factory', { planetId: 'P1' }, { referencePanelId: orbit, direction: 'right' });
    openPane(api, 'fleet', {}, { referencePanelId: factory ?? orbit, direction: 'within' });
    const cargo = openPane(api, 'cargo', { locationId: 'P1' }, { referencePanelId: orbit, direction: 'below' });
    if (planet) {
      openPane(api, 'console', {}, { referencePanelId: planet, direction: 'below' });
    }
    if (cargo) {
      openPane(api, 'cargo', { locationId: 'ST:HUB' }, { referencePanelId: cargo, direction: 'within' });
    }
  }
}

import { makeLeaf, makeSplit, type SplitNode } from './splitTree';

export interface WorkspaceEntry {
  id: string;
  name: string;
  tree: SplitNode;
}

const STORAGE_KEY = 'meridian.split_workspaces.v3';
const ACTIVE_KEY = 'meridian.active_split_workspace.v3';

export function buildPresetTree(wsId: string): SplitNode {
  if (wsId === 'ws-market') {
    return makeSplit(
      'horizontal',
      0.55,
      makeSplit(
        'vertical',
        0.5,
        makeLeaf({ kind: 'chart', params: { stationId: 'ST:HUB', itemId: 'steel' } }),
        makeLeaf({ kind: 'chart', params: { stationId: 'ST:HUB', itemId: 'ore' } }),
      ),
      makeSplit(
        'vertical',
        0.35,
        makeLeaf({ kind: 'orderbook', params: { stationId: 'ST:HUB', itemId: 'steel' } }),
        makeSplit(
          'vertical',
          0.6,
          makeLeaf({ kind: 'ticker', params: { stationId: 'ST:HUB' } }),
          makeLeaf({ kind: 'ranking', params: {} }),
        ),
      ),
    );
  }

  if (wsId === 'ws-script') {
    return makeSplit(
      'vertical',
      0.18,
      makeLeaf({ kind: 'files', params: {} }),
      makeSplit(
        'vertical',
        0.65,
        makeSplit(
          'horizontal',
          0.66,
          makeLeaf({ kind: 'script', params: {} }),
          makeLeaf({ kind: 'console', params: {} }),
        ),
        makeLeaf({ kind: 'memory', params: {} }),
      ),
    );
  }

  // Default overview workspace (strictly 1 pane per tile, zero internal tabs)
  return makeSplit(
    'vertical',
    0.3,
    makeSplit(
      'horizontal',
      0.66,
      makeLeaf({ kind: 'planet', params: { planetId: 'P2' } }),
      makeLeaf({ kind: 'console', params: {} }),
    ),
    makeSplit(
      'vertical',
      0.58,
      makeSplit(
        'horizontal',
        0.62,
        makeLeaf({ kind: 'orbit', params: {} }),
        makeLeaf({ kind: 'cargo', params: { locationId: 'P1' } }),
      ),
      makeSplit(
        'horizontal',
        0.58,
        makeLeaf({ kind: 'factory', params: { planetId: 'P1' } }),
        makeLeaf({ kind: 'fleet', params: {} }),
      ),
    ),
  );
}

export function createDefaultWorkspaces(): WorkspaceEntry[] {
  return [
    { id: 'ws-overview', name: '01 遥测总览', tree: buildPresetTree('ws-overview') },
    { id: 'ws-market', name: '02 双图盯盘', tree: buildPresetTree('ws-market') },
    { id: 'ws-script', name: '03 脚本终端', tree: buildPresetTree('ws-script') },
  ];
}

export function loadSavedWorkspaces(): { list: WorkspaceEntry[]; activeId: string } {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    const active = window.localStorage.getItem(ACTIVE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw) as WorkspaceEntry[];
      if (Array.isArray(parsed) && parsed.length > 0 && parsed[0].tree) {
        return {
          list: parsed,
          activeId: active && parsed.some((w) => w.id === active) ? active : parsed[0].id,
        };
      }
    }
  } catch {
    // fallback cleanly
  }
  const defaults = createDefaultWorkspaces();
  return { list: defaults, activeId: defaults[0].id };
}

export function persistWorkspaces(list: WorkspaceEntry[], activeId: string): void {
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(list));
    window.localStorage.setItem(ACTIVE_KEY, activeId);
  } catch {
    // ignore storage quota errors
  }
}

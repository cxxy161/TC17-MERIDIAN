import { makeLeaf, makeSplit, type SplitNode } from './splitTree';
import type { PaneKind, PaneParams, TileContent } from './paneRegistry';

export interface WorkspaceEntry {
  id: string;
  name: string;
  tree: SplitNode;
}

const STORAGE_KEY = 'meridian.split_workspaces.v4';
const ACTIVE_KEY = 'meridian.active_split_workspace.v4';

/**
 * Presets contain no entity ids: what a pane opens with is derived from the live world the first
 * time data arrives (see {@link hydrateTree}). Hardcoding "P2" / "steel" here is what made every
 * preset point at a non-existent entity once the world moved past the three hand-authored planets.
 */
export function buildPresetTree(wsId: string): SplitNode {
  if (wsId === 'ws-market') {
    return makeSplit(
      'horizontal',
      0.55,
      makeSplit(
        'vertical',
        0.5,
        makeLeaf({ kind: 'chart', params: {} }),
        makeLeaf({ kind: 'chart', params: {} }),
      ),
      makeSplit(
        'vertical',
        0.35,
        makeLeaf({ kind: 'orderbook', params: {} }),
        makeSplit(
          'vertical',
          0.6,
          makeLeaf({ kind: 'ticker', params: {} }),
          makeLeaf({ kind: 'items', params: {} }),
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

  return makeSplit(
    'vertical',
    0.3,
    makeSplit(
      'horizontal',
      0.66,
      makeLeaf({ kind: 'planet', params: {} }),
      makeLeaf({ kind: 'console', params: {} }),
    ),
    makeSplit(
      'vertical',
      0.58,
      makeSplit(
        'horizontal',
        0.62,
        makeLeaf({ kind: 'orbit', params: {} }),
        makeLeaf({ kind: 'cargo', params: {} }),
      ),
      makeSplit(
        'horizontal',
        0.58,
        makeLeaf({ kind: 'factory', params: {} }),
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

export interface HydrateContext {
  homePlanetId: string | null;
  defaultStationId: string | null;
  defaultItemId: string | null;
}

function needs(kind: PaneKind, params: PaneParams, ctx: HydrateContext): boolean {
  const hasPlanet = !!params.planetId;
  const hasLoc = !!params.locationId;
  const hasStation = !!params.stationId;
  const hasItem = !!params.itemId;
  switch (kind) {
    case 'planet':
    case 'demand':
    case 'factory':
    case 'treasury':
      return !hasPlanet && !!ctx.homePlanetId;
    case 'cargo':
      return !hasLoc && !!ctx.homePlanetId;
    case 'ticker':
      return !hasStation && !!ctx.defaultStationId;
    case 'chart':
    case 'orderbook':
      return (!hasStation && !!ctx.defaultStationId) || (!hasItem && !!ctx.defaultItemId);
    case 'item':
      return !hasItem && !!ctx.defaultItemId;
    default:
      return false;
  }
}

function withDefaults(kind: PaneKind, params: PaneParams, ctx: HydrateContext): PaneParams {
  const next: PaneParams = { ...params };
  switch (kind) {
    case 'planet':
    case 'demand':
    case 'factory':
    case 'treasury':
      if (!next.planetId && ctx.homePlanetId) next.planetId = ctx.homePlanetId;
      return next;
    case 'cargo':
      if (!next.locationId && ctx.homePlanetId) next.locationId = ctx.homePlanetId;
      return next;
    case 'ticker':
      if (!next.stationId && ctx.defaultStationId) next.stationId = ctx.defaultStationId;
      return next;
    case 'chart':
    case 'orderbook':
      if (!next.stationId && ctx.defaultStationId) next.stationId = ctx.defaultStationId;
      if (!next.itemId && ctx.defaultItemId) next.itemId = ctx.defaultItemId;
      return next;
    case 'item':
      if (!next.itemId && ctx.defaultItemId) next.itemId = ctx.defaultItemId;
      return next;
    default:
      return next;
  }
}

/** Fill empty pane params from the live world. Returns the same tree when nothing changed. */
export function hydrateTree(tree: SplitNode, ctx: HydrateContext): SplitNode {
  if (tree.type === 'leaf') {
    const content: TileContent | null = tree.content;
    if (!content) return tree;
    if (!needs(content.kind, content.params, ctx)) return tree;
    return { ...tree, content: { ...content, params: withDefaults(content.kind, content.params, ctx) } };
  }
  const first = hydrateTree(tree.first, ctx);
  const second = hydrateTree(tree.second, ctx);
  if (first === tree.first && second === tree.second) return tree;
  return { ...tree, first, second };
}

export function hydrateWorkspaces(list: WorkspaceEntry[], ctx: HydrateContext): WorkspaceEntry[] {
  let changed = false;
  const next = list.map((w) => {
    const tree = hydrateTree(w.tree, ctx);
    if (tree !== w.tree) changed = true;
    return tree === w.tree ? w : { ...w, tree };
  });
  return changed ? next : list;
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
    // fall through to defaults
  }
  // Migrate v3 (which stored per-pane titles and hardcoded entity ids) by ignoring it entirely.
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

export type PresetDeviceTag = 'all' | 'desktop' | 'portrait';

export interface LayoutPreset {
  id: string;
  name: string;
  device: PresetDeviceTag;
  workspaces: WorkspaceEntry[];
  activeWorkspaceId: string;
  updatedAt: number;
}

export interface LayoutBundle {
  version: 1;
  presets: LayoutPreset[];
}

const BUNDLE_STORAGE_KEY = 'meridian.layout_bundle.v1';
const DEVICE_PRESET_KEY = 'meridian.device_preset_id.v1';

export function createDefaultPresetBundle(initialDesktop?: {
  list: WorkspaceEntry[];
  activeId: string;
}): LayoutBundle {
  const now = Date.now();
  const desktopWorkspaces = initialDesktop?.list ?? createDefaultWorkspaces();
  const desktopActive = initialDesktop?.activeId ?? desktopWorkspaces[0].id;
  const portraitWorkspaces = createDefaultWorkspaces();
  return {
    version: 1,
    presets: [
      {
        id: 'desktop-default',
        name: '桌面默认',
        device: 'desktop',
        workspaces: desktopWorkspaces,
        activeWorkspaceId: desktopActive,
        updatedAt: now,
      },
      {
        id: 'portrait-default',
        name: '竖屏便携',
        device: 'portrait',
        workspaces: portraitWorkspaces,
        activeWorkspaceId: portraitWorkspaces[0].id,
        updatedAt: now,
      },
    ],
  };
}

export function loadLocalLayoutBundle(isPortrait: boolean): {
  bundle: LayoutBundle;
  activePresetId: string;
} {
  let bundle: LayoutBundle | null = null;
  try {
    const raw = window.localStorage.getItem(BUNDLE_STORAGE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw) as Partial<LayoutBundle>;
      if (parsed?.version === 1 && Array.isArray(parsed.presets) && parsed.presets.length > 0) {
        const valid = parsed.presets.filter(
          (p): p is LayoutPreset =>
            Boolean(p && typeof p.id === 'string' && typeof p.name === 'string' && Array.isArray(p.workspaces) && p.workspaces.length > 0),
        );
        if (valid.length > 0) {
          bundle = { version: 1, presets: valid };
        }
      }
    }
  } catch {
    // fall through
  }

  if (!bundle) {
    bundle = createDefaultPresetBundle(loadSavedWorkspaces());
  }

  let savedPresetId: string | null = null;
  try {
    savedPresetId = window.localStorage.getItem(DEVICE_PRESET_KEY);
  } catch {
    savedPresetId = null;
  }

  const matchedSaved = savedPresetId ? bundle.presets.find((p) => p.id === savedPresetId) : undefined;
  const targetDevice: PresetDeviceTag = isPortrait ? 'portrait' : 'desktop';
  const matchedDevice = bundle.presets.find((p) => p.device === targetDevice);
  const chosen = matchedSaved ?? matchedDevice ?? bundle.presets[0];

  return { bundle, activePresetId: chosen.id };
}

export function persistLocalLayoutBundle(bundle: LayoutBundle, activePresetId: string): void {
  try {
    window.localStorage.setItem(BUNDLE_STORAGE_KEY, JSON.stringify(bundle));
    window.localStorage.setItem(DEVICE_PRESET_KEY, activePresetId);
  } catch {
    // ignore storage quota errors
  }
}

export function mergeLayoutBundles(local: LayoutBundle, remoteRaw: unknown): LayoutBundle {
  if (!remoteRaw || typeof remoteRaw !== 'object') return local;
  const remote = remoteRaw as Partial<LayoutBundle>;
  if (remote.version !== 1 || !Array.isArray(remote.presets)) return local;

  const byId = new Map<string, LayoutPreset>();
  for (const p of local.presets) {
    byId.set(p.id, p);
  }
  for (const rp of remote.presets) {
    if (
      !rp ||
      typeof rp.id !== 'string' ||
      typeof rp.name !== 'string' ||
      !Array.isArray(rp.workspaces) ||
      rp.workspaces.length === 0
    ) {
      continue;
    }
    const existing = byId.get(rp.id);
    if (!existing || (Number(rp.updatedAt) || 0) > (Number(existing.updatedAt) || 0)) {
      byId.set(rp.id, {
        id: rp.id,
        name: rp.name,
        device: rp.device === 'desktop' || rp.device === 'portrait' ? rp.device : 'all',
        workspaces: rp.workspaces,
        activeWorkspaceId:
          rp.activeWorkspaceId && rp.workspaces.some((w) => w.id === rp.activeWorkspaceId)
            ? rp.activeWorkspaceId
            : rp.workspaces[0].id,
        updatedAt: Number(rp.updatedAt) || Date.now(),
      });
    }
  }
  const merged = Array.from(byId.values());
  return merged.length > 0 ? { version: 1, presets: merged } : local;
}

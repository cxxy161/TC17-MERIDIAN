import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Activity,
  BookOpen,
  Box,
  CandlestickChart,
  Check,
  ChevronDown,
  Compass,
  Factory,
  Globe2,
  HelpCircle,
  Landmark,
  Layers,
  Monitor,
  PackageSearch,
  Plus,
  RefreshCw,
  Rocket,
  Search,
  ShoppingBag,
  Terminal,
  Trash2,
  Trophy,
  User,
  Workflow,
  X,
} from 'lucide-react';
import { useGameStore } from '../store/useGameStore';
import { useSessionStore } from '../store/useSessionStore';
import { PORTRAIT_MEDIA_QUERY, useIsPortrait } from '../utils/useViewportMode';
import { accountApi } from '../api/client';
import { moneyToCredits } from '../types/meridian';
import {
  focusDefaults,
  paneTitle,
  type FloatingWindowItem,
  type PaneKind,
  type PaneParams,
  type TileContent,
} from './paneRegistry';
import {
  clearLeaf,
  closeLeaf,
  flattenLeaves,
  makeLeaf,
  setLeafContent,
  setLeafParams,
  splitLeaf,
  updateSplitRatio,
  type SplitDirection,
  type SplitNode,
} from './splitTree';
import {
  hydrateWorkspaces,
  loadLocalLayoutBundle,
  mergeLayoutBundles,
  persistLocalLayoutBundle,
  persistWorkspaces,
  type LayoutBundle,
  type LayoutPreset,
  type PresetDeviceTag,
  type WorkspaceEntry,
} from './workspaces';
import { useCatalogIndex, useWorldIndex } from '../entities/hooks';
import { SplitLayout } from './SplitLayout';
import { FloatingWindowsLayer } from './FloatingWindowsLayer';
import { CommandPalette } from './CommandPalette';
import { MeridianLogo } from '../components/MeridianLogo';
import { TutorialOverlay } from '../components/TutorialOverlay';

/**
 * Rail entries carry no entity ids: what they open is resolved from the player's last focused
 * entity (or from the live world the first time). "K线" no longer always opens steel@HUB.
 */
const RAIL_BUTTONS: Array<{ kind: PaneKind; label: string; icon: React.ReactNode }> = [
  { kind: 'orbit', label: '星图', icon: <Compass className="w-4 h-4" /> },
  { kind: 'planet', label: '行星', icon: <Globe2 className="w-4 h-4" /> },
  { kind: 'demand', label: '需求', icon: <ShoppingBag className="w-4 h-4" /> },
  { kind: 'factory', label: '工厂', icon: <Factory className="w-4 h-4" /> },
  { kind: 'production', label: '图鉴', icon: <Workflow className="w-4 h-4" /> },
  { kind: 'cargo', label: '仓库', icon: <Box className="w-4 h-4" /> },
  { kind: 'fleet', label: '舰队', icon: <Rocket className="w-4 h-4" /> },
  { kind: 'items', label: '物品', icon: <PackageSearch className="w-4 h-4" /> },
  { kind: 'ticker', label: '行情', icon: <Activity className="w-4 h-4" /> },
  { kind: 'chart', label: 'K线', icon: <CandlestickChart className="w-4 h-4" /> },
  { kind: 'orderbook', label: '盘口', icon: <Layers className="w-4 h-4" /> },
  { kind: 'treasury', label: '银行', icon: <Landmark className="w-4 h-4" /> },
  { kind: 'ranking', label: '排行', icon: <Trophy className="w-4 h-4" /> },
  { kind: 'console', label: '控制台', icon: <Terminal className="w-4 h-4" /> },
  { kind: 'apidocs', label: 'API', icon: <BookOpen className="w-4 h-4" /> },
];

const MAX_FLOATING_WINDOWS = 10;

/**
 * PaneParams 里只有这 4 个是「实体焦点」。docId 之类的面板私有参数不能写进 lastFocus，
 * 否则下次开别的窗口时会被当成焦点状态带出去。
 */
function focusOnly(params: Partial<PaneParams>): {
  planetId?: string;
  locationId?: string;
  stationId?: string;
  itemId?: string;
} {
  const out: { planetId?: string; locationId?: string; stationId?: string; itemId?: string } = {};
  if (params.planetId) out.planetId = params.planetId;
  if (params.locationId) out.locationId = params.locationId;
  if (params.stationId) out.stationId = params.stationId;
  if (params.itemId) out.itemId = params.itemId;
  return out;
}

/**
 * Fill any missing entity for a pane that is being opened, so the pane's title and its content agree
 * from the first frame. Uses only the live world/catalog — no default entity is ever hardcoded.
 */
function fillPaneDefaults(
  kind: PaneKind,
  params: PaneParams,
  world: ReturnType<typeof useWorldIndex>,
  catalog: ReturnType<typeof useCatalogIndex>,
): PaneParams {
  const out: PaneParams = { ...params };
  const hub = world.stations.find((s) => s.isHub)?.id ?? world.stations[0]?.id ?? null;
  const planet = world.homePlanetId ?? world.planets[0]?.id ?? null;
  if (!out.stationId && (kind === 'ticker' || kind === 'chart' || kind === 'orderbook')) {
    if (hub) out.stationId = hub;
  }
  if (!out.itemId && (kind === 'chart' || kind === 'orderbook' || kind === 'item')) {
    const first = catalog.items[0]?.id;
    if (first) out.itemId = first;
  }
  if (!out.planetId && (kind === 'planet' || kind === 'demand' || kind === 'factory' || kind === 'treasury')) {
    if (planet) out.planetId = planet;
  }
  if (!out.locationId && kind === 'cargo') {
    const loc = planet ?? hub;
    if (loc) out.locationId = loc;
  }
  return out;
}

/** Distinct staggered slots so several floating windows never land exactly on top of each other. */
function slotPosition(index: number, width: number, height: number): { x: number; y: number } {
  const cols = 3;
  const i = index % 12;
  const col = i % cols;
  const row = Math.floor(i / cols);
  return {
    x: Math.max(12, Math.min(window.innerWidth - width - 12, 64 + col * 46)),
    y: Math.max(44, Math.min(window.innerHeight - height - 12, 52 + row * 38)),
  };
}

export const DesktopShell: React.FC = () => {
  const isPortrait = useIsPortrait();
  const init = useGameStore((s) => s.init);
  const state = useGameStore((s) => s.state);
  const wsStatus = useGameStore((s) => s.wsStatus);
  const lastError = useGameStore((s) => s.lastError);
  const clearError = useGameStore((s) => s.clearError);
  const actionNotices = useGameStore((s) => s.actionNotices);
  const dismissActionNotice = useGameStore((s) => s.dismissActionNotice);
  const tutorialHighlight = useGameStore((s) => s.tutorialHighlight);
  const openTutorial = useGameStore((s) => s.openTutorial);
  const touchFocus = useGameStore((s) => s.touchFocus);
  const catalog = useCatalogIndex();
  const world = useWorldIndex();
  // 玩家 chip 的数据源是会话 store：设置页改昵称后这里立即跟着变
  const sessionUser = useSessionStore((s) => s.user);
  const playerName = sessionUser?.nickname ?? '本地预览';

  const initialBundleRef = useRef(
    loadLocalLayoutBundle(
      typeof window !== 'undefined' ? window.matchMedia(PORTRAIT_MEDIA_QUERY).matches : false,
    ),
  );
  const [layoutBundle, setLayoutBundle] = useState<LayoutBundle>(initialBundleRef.current.bundle);
  const [activePresetId, setActivePresetId] = useState<string>(initialBundleRef.current.activePresetId);
  const initialActivePreset =
    initialBundleRef.current.bundle.presets.find((p) => p.id === initialBundleRef.current.activePresetId) ??
    initialBundleRef.current.bundle.presets[0];

  const [workspaces, setWorkspaces] = useState<WorkspaceEntry[]>(initialActivePreset.workspaces);
  const [activeWsId, setActiveWsId] = useState<string>(initialActivePreset.activeWorkspaceId);
  const [floatingWindows, setFloatingWindows] = useState<FloatingWindowItem[]>([]);
  const [dropTargetTileId, setDropTargetTileId] = useState<string | null>(null);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [addingWs, setAddingWs] = useState(false);
  const [newWsName, setNewWsName] = useState('');
  const [windowListOpen, setWindowListOpen] = useState(false);
  const [presetMenuOpen, setPresetMenuOpen] = useState(false);
  const [newPresetName, setNewPresetName] = useState('');
  const [newPresetDevice, setNewPresetDevice] = useState<PresetDeviceTag>(
    isPortrait ? 'portrait' : 'desktop',
  );
  const [cloudSyncStatus, setCloudSyncStatus] = useState<'idle' | 'syncing' | 'synced' | 'offline'>(
    sessionUser ? 'idle' : 'offline',
  );
  const [portraitLeafIdx, setPortraitLeafIdx] = useState(0);
  const hydratedRef = useRef(false);
  const workspaceRef = useRef(workspaces);
  workspaceRef.current = workspaces;
  const layoutBundleRef = useRef(layoutBundle);
  layoutBundleRef.current = layoutBundle;
  const activePresetIdRef = useRef(activePresetId);
  activePresetIdRef.current = activePresetId;
  const cloudSyncTimerRef = useRef<number | null>(null);
  const cloudSyncedUserRef = useRef<string | null>(null);
  const worldRef = useRef(world);
  worldRef.current = world;
  const catalogRef = useRef(catalog);
  catalogRef.current = catalog;

  const scheduleCloudPush = useCallback(
    (bundleToPush: LayoutBundle) => {
      if (!sessionUser) {
        setCloudSyncStatus('offline');
        return;
      }
      if (cloudSyncTimerRef.current !== null) {
        window.clearTimeout(cloudSyncTimerRef.current);
      }
      setCloudSyncStatus('syncing');
      cloudSyncTimerRef.current = window.setTimeout(() => {
        cloudSyncTimerRef.current = null;
        accountApi
          .saveLayouts(bundleToPush)
          .then(() => setCloudSyncStatus('synced'))
          .catch(() => setCloudSyncStatus('offline'));
      }, 800);
    },
    [sessionUser],
  );

  const commitPresetState = useCallback(
    (nextWorkspaces: WorkspaceEntry[], nextActiveWsId: string, pushCloud = true) => {
      persistWorkspaces(nextWorkspaces, nextActiveWsId);
      const curBundle = layoutBundleRef.current;
      const curPresetId = activePresetIdRef.current;
      const now = Date.now();
      const nextBundle: LayoutBundle = {
        version: 1,
        presets: curBundle.presets.map((p) =>
          p.id === curPresetId
            ? { ...p, workspaces: nextWorkspaces, activeWorkspaceId: nextActiveWsId, updatedAt: now }
            : p,
        ),
      };
      setLayoutBundle(nextBundle);
      persistLocalLayoutBundle(nextBundle, curPresetId);
      if (pushCloud) {
        scheduleCloudPush(nextBundle);
      }
    },
    [scheduleCloudPush],
  );

  const pullCloudPresets = useCallback(async () => {
    if (!sessionUser) {
      setCloudSyncStatus('offline');
      return;
    }
    setCloudSyncStatus('syncing');
    try {
      const resp = await accountApi.getLayouts();
      if (resp.bundle) {
        const merged = mergeLayoutBundles(layoutBundleRef.current, resp.bundle);
        setLayoutBundle(merged);
        const curPresetId = activePresetIdRef.current;
        const activeP = merged.presets.find((p) => p.id === curPresetId) ?? merged.presets[0];
        if (activeP) {
          setActivePresetId(activeP.id);
          setWorkspaces(activeP.workspaces);
          setActiveWsId(activeP.activeWorkspaceId);
          persistWorkspaces(activeP.workspaces, activeP.activeWorkspaceId);
          persistLocalLayoutBundle(merged, activeP.id);
        }
        setCloudSyncStatus('synced');
      } else {
        await accountApi.saveLayouts(layoutBundleRef.current);
        setCloudSyncStatus('synced');
      }
    } catch {
      setCloudSyncStatus('offline');
    }
  }, [sessionUser]);

  useEffect(() => {
    if (!sessionUser) {
      cloudSyncedUserRef.current = null;
      setCloudSyncStatus('offline');
      return;
    }
    if (cloudSyncedUserRef.current === sessionUser.email) return;
    cloudSyncedUserRef.current = sessionUser.email;
    void pullCloudPresets();
  }, [sessionUser, pullCloudPresets]);

  useEffect(() => {
    return () => {
      if (cloudSyncTimerRef.current !== null) {
        window.clearTimeout(cloudSyncTimerRef.current);
      }
    };
  }, []);

  const topZRef = useRef(40);
  const floatSeqRef = useRef(1);
  const [tutorialZ, setTutorialZ] = useState(60);
  const bringTutorialToFront = useCallback(() => {
    setTutorialZ(++topZRef.current);
  }, []);

  useEffect(() => {
    void init();
  }, [init]);

  // Fill preset panes with real entities once the world is available, instead of shipping
  // "P2"/"steel" constants that stop existing the moment the world grows.
  const hubStationId = world.stations.find((s) => s.isHub)?.id ?? world.stations[0]?.id ?? null;
  const defaultItemId =
    catalog.items.find((i) => (world.quotesByItem.get(i.id)?.length ?? 0) > 0)?.id ??
    catalog.items[0]?.id ??
    null;

  useEffect(() => {
    if (!world.ready) return;
    hydratedRef.current = true;
    const ctx = { homePlanetId: world.homePlanetId, defaultStationId: hubStationId, defaultItemId };
    setWorkspaces((prev) => {
      const next = hydrateWorkspaces(prev, ctx);
      if (next === prev) return prev;
      commitPresetState(next, activeWsId, false);
      return next;
    });
    // Deps are primitives: this only re-runs when the resolved defaults actually change.
  }, [world.ready, world.homePlanetId, hubStationId, defaultItemId, activeWsId, workspaces, commitPresetState]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        setPaletteOpen((v) => !v);
      } else if (e.key === 'Escape') {
        setPaletteOpen(false);
        setPresetMenuOpen(false);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  useEffect(() => {
    const onResize = () => {
      const vw = window.innerWidth;
      const vh = window.innerHeight;
      setFloatingWindows((prev) =>
        prev.map((win) => {
          const nw = Math.max(Math.min(260, vw - 12), Math.min(win.w, vw - 12));
          const nh = Math.max(Math.min(200, vh - 88), Math.min(win.h, vh - 88));
          const nx = Math.max(6, Math.min(win.x, Math.max(6, vw - nw - 6)));
          const ny = Math.max(38, Math.min(win.y, Math.max(38, vh - nh - 48)));
          if (nx === win.x && ny === win.y && nw === win.w && nh === win.h) return win;
          return { ...win, x: nx, y: ny, w: nw, h: nh };
        }),
      );
    };
    window.addEventListener('resize', onResize);
    window.addEventListener('orientationchange', onResize);
    return () => {
      window.removeEventListener('resize', onResize);
      window.removeEventListener('orientationchange', onResize);
    };
  }, []);

  const updateActiveTree = useCallback(
    (fn: (tree: SplitNode) => SplitNode) => {
      setWorkspaces((prev) => {
        const next = prev.map((w) => (w.id === activeWsId ? { ...w, tree: fn(w.tree) } : w));
        commitPresetState(next, activeWsId);
        return next;
      });
    },
    [activeWsId, commitPresetState],
  );

  const openTemp = useCallback(
    (kind: PaneKind, params: PaneParams = {}) => {
      const seq = floatSeqRef.current++;
      const z = ++topZRef.current;
      const focus = useGameStore.getState().lastFocus;
      const resolved = fillPaneDefaults(
        kind,
        { ...focusDefaults(kind, focus), ...params },
        worldRef.current,
        catalogRef.current,
      );
      const rawW =
        kind === 'apidocs'
          ? 760
          : kind === 'script'
            ? 680
            : kind === 'settings'
              ? 600
              : kind === 'chart' || kind === 'orbit'
                ? 520
                : 460;
      const rawH = kind === 'apidocs' ? 560 : kind === 'script' || kind === 'settings' ? 460 : 380;
      const vw = typeof window !== 'undefined' ? window.innerWidth : 1280;
      const vh = typeof window !== 'undefined' ? window.innerHeight : 800;
      const width = Math.min(rawW, Math.max(260, vw - 16));
      const height = Math.min(rawH, Math.max(240, vh - 96));

      setFloatingWindows((prev) => {
        const next = [
          ...prev,
          {
            id: `float-${Date.now()}-${seq}`,
            kind,
            params: resolved,
            // Stagger, but never beyond the six visible offsets: pick the least-used slot.
            ...slotPosition(prev.length, width, height),
            w: width,
            h: height,
            z,
          },
        ];
        // Bounded: past a handful of windows they overlap beyond recovery and each one is a full
        // pane mount with its own data subscriptions.
        return next.length > MAX_FLOATING_WINDOWS ? next.slice(next.length - MAX_FLOATING_WINDOWS) : next;
      });
    },
    [],
  );

  const bringFloatToFront = useCallback((id: string) => {
    const z = ++topZRef.current;
    setFloatingWindows((prev) => prev.map((w) => (w.id === id ? { ...w, z } : w)));
  }, []);

  const moveFloat = useCallback((id: string, x: number, y: number) => {
    setFloatingWindows((prev) => prev.map((w) => (w.id === id ? { ...w, x, y } : w)));
  }, []);

  const resizeFloat = useCallback((id: string, w: number, h: number) => {
    setFloatingWindows((prev) => prev.map((win) => (win.id === id ? { ...win, w, h } : win)));
  }, []);

  const closeFloat = useCallback((id: string) => {
    setFloatingWindows((prev) => prev.filter((w) => w.id !== id));
  }, []);

  const setFloatParams = useCallback(
    (id: string, patch: Partial<PaneParams>) => {
      touchFocus(focusOnly(patch));
      setFloatingWindows((prev) =>
        prev.map((w) => {
          if (w.id !== id) return w;
          return { ...w, title: undefined, params: { ...w.params, ...patch } };
        }),
      );
    },
    [touchFocus],
  );

  const replaceFloat = useCallback((id: string, kind: PaneKind, params: PaneParams) => {
    touchFocus(focusOnly(params));
    setFloatingWindows((prev) =>
      prev.map((w) => (w.id === id ? { ...w, kind, params, title: undefined } : w)),
    );
  }, [touchFocus]);

  const setTileParams = useCallback(
    (tileId: string, patch: Partial<PaneParams>) => {
      touchFocus(focusOnly(patch));
      updateActiveTree((tree) => setLeafParams(tree, tileId, patch));
    },
    [touchFocus, updateActiveTree],
  );

  const dockFloatToTile = useCallback(
    (winId: string, tileId: string) => {
      setFloatingWindows((prev) => {
        const win = prev.find((w) => w.id === winId);
        if (!win) return prev;
        const content: TileContent = {
          kind: win.kind,
          params: fillPaneDefaults(win.kind, win.params, worldRef.current, catalogRef.current),
        };
        updateActiveTree((tree) => setLeafContent(tree, tileId, content));
        return prev.filter((w) => w.id !== winId);
      });
    },
    [updateActiveTree],
  );

  const switchWorkspace = (nextId: string) => {
    setActiveWsId(nextId);
    setPortraitLeafIdx(0);
    commitPresetState(workspaces, nextId);
  };

  const openAddWorkspace = () => {
    setNewWsName(`工作区 ${workspaces.length + 1}`);
    setAddingWs(true);
  };

  const commitAddWorkspace = () => {
    const trimmed = newWsName.trim();
    if (!trimmed) {
      setAddingWs(false);
      return;
    }
    const newId = `ws-${Date.now()}`;
    const entry: WorkspaceEntry = {
      id: newId,
      name: trimmed,
      tree: makeLeaf(null),
    };
    const next = [...workspaces, entry];
    setWorkspaces(next);
    setActiveWsId(newId);
    setPortraitLeafIdx(0);
    commitPresetState(next, newId);
    setAddingWs(false);
    setNewWsName('');
  };

  const selectPreset = (presetId: string) => {
    const target = layoutBundle.presets.find((p) => p.id === presetId);
    if (!target) return;
    setActivePresetId(target.id);
    setWorkspaces(target.workspaces);
    setActiveWsId(target.activeWorkspaceId);
    setPortraitLeafIdx(0);
    persistWorkspaces(target.workspaces, target.activeWorkspaceId);
    persistLocalLayoutBundle(layoutBundle, target.id);
    setPresetMenuOpen(false);
  };

  const saveAsNewPreset = () => {
    const trimmed = newPresetName.trim();
    if (!trimmed) return;
    const now = Date.now();
    const id = `preset-${now}`;
    const clonedWorkspaces = JSON.parse(JSON.stringify(workspaces)) as WorkspaceEntry[];
    const created: LayoutPreset = {
      id,
      name: trimmed,
      device: newPresetDevice,
      workspaces: clonedWorkspaces,
      activeWorkspaceId: activeWsId,
      updatedAt: now,
    };
    const nextBundle: LayoutBundle = {
      version: 1,
      presets: [...layoutBundle.presets, created],
    };
    setLayoutBundle(nextBundle);
    setActivePresetId(id);
    persistLocalLayoutBundle(nextBundle, id);
    scheduleCloudPush(nextBundle);
    setNewPresetName('');
  };

  const overwritePreset = (presetId: string) => {
    const now = Date.now();
    const clonedWorkspaces = JSON.parse(JSON.stringify(workspaces)) as WorkspaceEntry[];
    const nextBundle: LayoutBundle = {
      version: 1,
      presets: layoutBundle.presets.map((p) =>
        p.id === presetId
          ? { ...p, workspaces: clonedWorkspaces, activeWorkspaceId: activeWsId, updatedAt: now }
          : p,
      ),
    };
    setLayoutBundle(nextBundle);
    setActivePresetId(presetId);
    persistLocalLayoutBundle(nextBundle, presetId);
    scheduleCloudPush(nextBundle);
  };

  const deletePreset = (presetId: string) => {
    if (layoutBundle.presets.length <= 1) return;
    const nextPresets = layoutBundle.presets.filter((p) => p.id !== presetId);
    const nextBundle: LayoutBundle = { version: 1, presets: nextPresets };
    const nextActiveId = activePresetId === presetId ? nextPresets[0].id : activePresetId;
    setLayoutBundle(nextBundle);
    if (activePresetId === presetId) {
      const fallback = nextPresets[0];
      setActivePresetId(fallback.id);
      setWorkspaces(fallback.workspaces);
      setActiveWsId(fallback.activeWorkspaceId);
      setPortraitLeafIdx(0);
      persistWorkspaces(fallback.workspaces, fallback.activeWorkspaceId);
    }
    persistLocalLayoutBundle(nextBundle, nextActiveId);
    scheduleCloudPush(nextBundle);
  };

  const activePreset = layoutBundle.presets.find((p) => p.id === activePresetId) ?? layoutBundle.presets[0];
  const activeWorkspace = workspaces.find((w) => w.id === activeWsId) ?? workspaces[0];
  const portraitLeaves = useMemo(
    () => (activeWorkspace ? flattenLeaves(activeWorkspace.tree) : []),
    [activeWorkspace],
  );
  const clampedLeafIdx = portraitLeaves.length > 0 ? Math.min(portraitLeafIdx, portraitLeaves.length - 1) : 0;
  const activePortraitLeaf = portraitLeaves[clampedLeafIdx] ?? null;
  const cash = moneyToCredits(state?.player_snapshot?.company.cash);
  const paused = state?.paused ?? false;

  return (
    <div className="h-full w-full flex flex-col bg-[#161b22] text-slate-200 overflow-hidden">
      {/* Top Telemetry Chrome */}
      <header className="min-h-9 bg-[#1f2630] border-b border-sky-500/15 px-2 sm:px-3 py-1 flex flex-col gap-1 shrink-0">
        <div className="flex items-center justify-between gap-2 min-w-0">
          <div className="flex items-center gap-2 sm:gap-3 min-w-0 flex-1">
            <div className="flex items-center gap-1.5 sm:gap-2 pr-2 sm:pr-3 border-r border-slate-800 shrink-0">
              <MeridianLogo className="w-4 h-4 shrink-0" />
              <span className="font-semibold tracking-[0.14em] sm:tracking-[0.18em] text-[11px] text-slate-100 whitespace-nowrap">
                <span className="hidden sm:inline">子午线 · </span>MERIDIAN
              </span>
            </div>

            <div className="flex items-center gap-1 overflow-x-auto min-w-0">
              {workspaces.map((w) => {
                const isTutTarget = tutorialHighlight === `ws:${w.id}`;
                return (
                  <button
                    key={w.id}
                    onClick={() => switchWorkspace(w.id)}
                    className={`pill-btn shrink-0 whitespace-nowrap ${w.id === activeWsId ? 'active' : ''} ${
                      isTutTarget ? 'ring-1 ring-cyan-400 border-cyan-400/80 text-cyan-200 animate-pulse' : ''
                    }`}
                  >
                    {w.name}
                  </button>
                );
              })}
              {addingWs ? (
                <div className="flex items-center gap-1 shrink-0 bg-[#1b212b] border border-sky-500/40 rounded px-1.5 py-0.5">
                  <input
                    autoFocus
                    value={newWsName}
                    onChange={(e) => setNewWsName(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') {
                        e.preventDefault();
                        commitAddWorkspace();
                      } else if (e.key === 'Escape') {
                        setAddingWs(false);
                      }
                    }}
                    placeholder="工作区名称"
                    className="bg-transparent text-[11px] text-slate-100 outline-none w-24"
                  />
                  <button
                    onClick={commitAddWorkspace}
                    className="text-[10px] text-emerald-300 hover:text-emerald-200 px-1"
                  >
                    创建
                  </button>
                  <button
                    onClick={() => setAddingWs(false)}
                    className="text-[10px] text-slate-400 hover:text-slate-200 px-0.5"
                  >
                    取消
                  </button>
                </div>
              ) : (
                <button onClick={openAddWorkspace} className="pill-btn px-1.5 shrink-0" title="新建空白自定义工作区">
                  <Plus className="w-3.5 h-3.5" />
                </button>
              )}
            </div>
          </div>

          {/* Player Metrics (desktop/landscape inline) & Window Palette */}
          <div className="flex items-center gap-2 sm:gap-3 text-[11px] mono shrink-0">
            {!isPortrait && (
              <div className="flex items-center gap-3 text-slate-400">
                <span className="whitespace-nowrap">
                  回合 <strong className="text-slate-100">{String(state?.tick ?? 0).padStart(4, '0')}</strong>
                </span>
                <span className="whitespace-nowrap">
                  物价指数 <strong className="text-sky-400">{(state?.cpi ?? 1).toFixed(3)}</strong>
                </span>
                <span className="whitespace-nowrap">
                  现金 <strong className="text-emerald-400">{cash.toLocaleString(undefined, { maximumFractionDigits: 2 })}</strong>
                </span>
                <span
                  className="flex items-center gap-1 text-[10px] whitespace-nowrap text-slate-400"
                  title={
                    paused
                      ? '仿真已暂停'
                      : wsStatus === 'connected'
                        ? 'WebSocket 在线同步中'
                        : '连接同步中'
                  }
                >
                  <span
                    className={`w-1.5 h-1.5 rounded-full ${
                      paused
                        ? 'bg-amber-400'
                        : wsStatus === 'connected'
                          ? 'bg-emerald-400'
                          : 'bg-amber-400 animate-pulse'
                    }`}
                  />
                  {paused ? <span className="text-amber-300">已暂停</span> : null}
                </span>
              </div>
            )}

            <div className={`flex items-center gap-1.5 sm:gap-2 ${!isPortrait ? 'pl-2 sm:pl-2.5 border-l border-slate-700/60' : ''}`}>
              <button
                onClick={() => {
                  setPresetMenuOpen((v) => !v);
                  setWindowListOpen(false);
                }}
                className={`h-7 px-2 rounded-[2px] border text-[11px] inline-flex items-center gap-1 whitespace-nowrap transition-colors ${
                  presetMenuOpen
                    ? 'border-sky-400 bg-sky-500/15 text-sky-100'
                    : 'border-slate-700/80 bg-[#232a36] text-slate-300 hover:border-sky-400/50 hover:text-sky-100'
                }`}
                title="切换或保存多设备窗口预设"
              >
                <Monitor className="w-3.5 h-3.5 text-sky-400/85 shrink-0" />
                <span className="max-w-[72px] truncate font-sans">{activePreset?.name ?? '预设'}</span>
                <ChevronDown className="w-3 h-3 text-slate-400 shrink-0" />
              </button>
              {floatingWindows.length > 0 && (
                <button
                  onClick={() => {
                    setWindowListOpen((v) => !v);
                    setPresetMenuOpen(false);
                  }}
                  className="h-7 px-2 rounded-[2px] border border-slate-700/80 bg-[#232a36] text-[11px] text-slate-300 hover:border-sky-400/50 hover:text-sky-100 inline-flex items-center gap-1 whitespace-nowrap transition-colors"
                  title="列出/切换已打开的临时窗口"
                >
                  <span>悬浮窗</span>
                  <span className="text-sky-300">{floatingWindows.length}</span>
                </button>
              )}
              <button
                onClick={() => setPaletteOpen(true)}
                title="全局搜索 (Ctrl / ⌘ + K)"
                className="h-7 px-2 sm:px-3 rounded-[2px] border border-slate-700/80 bg-[#181e26] text-[11px] text-slate-300 hover:border-sky-400/50 hover:text-slate-100 inline-flex items-center gap-1.5 whitespace-nowrap transition-colors"
              >
                <Search className="w-3.5 h-3.5 text-slate-400 shrink-0" />
                <span className="hidden sm:inline font-sans">搜索</span>
              </button>
              <button
                onClick={() => {
                  bringTutorialToFront();
                  openTutorial();
                }}
                className="h-7 px-2 sm:px-2.5 rounded-[2px] border border-slate-700/80 bg-[#232a36] text-[11px] text-slate-200 hover:border-sky-400/50 hover:text-sky-100 inline-flex items-center gap-1.5 whitespace-nowrap transition-colors"
                title="打开新手引导教程"
              >
                <HelpCircle className="w-3.5 h-3.5 text-sky-400/85 shrink-0" />
                <span className="hidden sm:inline font-sans">引导</span>
              </button>
              <button
                onClick={() => openTemp('settings')}
                title="个人设置"
                className="h-7 px-2 sm:px-2.5 rounded-[2px] border border-slate-700/70 bg-[#232a36]/80 text-[11px] text-slate-200 hover:border-sky-400/50 hover:text-sky-100 inline-flex items-center gap-1.5 whitespace-nowrap transition-colors"
              >
                <User className="w-3.5 h-3.5 text-slate-400 shrink-0" />
                <span className="max-w-[72px] sm:max-w-[96px] truncate font-sans">{playerName}</span>
              </button>
            </div>
          </div>
        </div>

        {isPortrait && (
          <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-0.5 pt-1 border-t border-slate-800/80 text-[11px] mono text-slate-400">
            <div className="flex flex-wrap items-center gap-x-3 gap-y-0.5">
              <span className="whitespace-nowrap">
                回合 <strong className="text-slate-100 tabular-nums">{String(state?.tick ?? 0).padStart(4, '0')}</strong>
              </span>
              <span className="whitespace-nowrap">
                物价指数 <strong className="text-sky-400 tabular-nums">{(state?.cpi ?? 1).toFixed(3)}</strong>
              </span>
              <span className="whitespace-nowrap">
                现金 <strong className="text-emerald-400 tabular-nums">{cash.toLocaleString(undefined, { maximumFractionDigits: 2 })}</strong>
              </span>
            </div>
            <span
              className="flex items-center gap-1 text-[10px] whitespace-nowrap text-slate-400 shrink-0"
              title={
                paused
                  ? '仿真已暂停'
                  : wsStatus === 'connected'
                    ? 'WebSocket 在线同步中'
                    : '连接同步中'
              }
            >
              <span
                className={`w-1.5 h-1.5 rounded-full ${
                  paused
                    ? 'bg-amber-400'
                    : wsStatus === 'connected'
                      ? 'bg-emerald-400'
                      : 'bg-amber-400 animate-pulse'
                }`}
              />
              <span>{paused ? '已暂停' : wsStatus === 'connected' ? '同步中' : '重连中'}</span>
            </span>
          </div>
        )}
      </header>

      {lastError && (
        <div className="px-3 py-1 bg-rose-500/15 border-b border-rose-500/40 text-rose-300 text-[11px] flex items-center justify-between">
          <span>连接或请求异常：{lastError}</span>
          <button onClick={clearError} className="text-[10px] underline">
            忽略
          </button>
        </div>
      )}

      {/* Body: Left Rail (desktop) / Bottom Dock + Single-Pane Tabs (portrait) */}
      <div className={isPortrait ? 'flex-1 flex flex-col min-h-0 relative' : 'flex-1 flex min-h-0 relative'}>
        {!isPortrait && (
          <aside className="w-12 bg-[#1a2029] border-r border-sky-500/15 py-2 flex flex-col items-center justify-between shrink-0 overflow-y-auto">
            <div className="flex flex-col gap-1">
              {RAIL_BUTTONS.map((btn) => {
                const isTutTarget = tutorialHighlight === `rail:${btn.kind}`;
                return (
                  <button
                    key={btn.kind}
                    onClick={() => openTemp(btn.kind)}
                    className={`w-10 min-h-[38px] py-1 px-0.5 rounded-[3px] flex flex-col items-center justify-center transition-colors border ${
                      isTutTarget
                        ? 'text-cyan-200 bg-cyan-500/20 border-cyan-400 ring-1 ring-cyan-400/70 animate-pulse'
                        : 'text-slate-400 hover:text-sky-300 hover:bg-sky-500/10 border-transparent hover:border-sky-500/30'
                    }`}
                    title={`打开临时悬浮窗：${btn.label}`}
                  >
                    <span className="shrink-0 flex items-center justify-center">{btn.icon}</span>
                    <span className="text-[9px] mt-0.5 whitespace-nowrap leading-none">{btn.label}</span>
                  </button>
                );
              })}
            </div>
          </aside>
        )}

        {/* Portrait single-pane leaf switcher */}
        {isPortrait && portraitLeaves.length > 0 && (
          <div className="bg-[#1a2029] border-b border-sky-500/15 px-1.5 py-1 flex items-center gap-1 overflow-x-auto shrink-0">
            {portraitLeaves.map((leaf, idx) => {
              const active = idx === clampedLeafIdx;
              const title = leaf.content
                ? paneTitle(leaf.content.kind, leaf.content.params, { catalog, world })
                : `空白窗口 ${idx + 1}`;
              return (
                <button
                  key={leaf.id}
                  onClick={() => setPortraitLeafIdx(idx)}
                  className={`px-2 py-1 rounded-[2px] text-[10px] whitespace-nowrap border transition-colors shrink-0 ${
                    active
                      ? 'bg-sky-500/20 border-sky-400/70 text-sky-100'
                      : 'bg-[#212834] border-slate-700/70 text-slate-400 hover:text-slate-200'
                  }`}
                >
                  {title}
                </button>
              );
            })}
            {activePortraitLeaf && (
              <button
                onClick={() => {
                  updateActiveTree((tree) => splitLeaf(tree, activePortraitLeaf.id, 'horizontal'));
                  setPortraitLeafIdx(portraitLeaves.length);
                }}
                className="px-2 py-1 rounded-[2px] text-[10px] whitespace-nowrap border border-dashed border-slate-700 text-slate-400 hover:text-sky-200 hover:border-sky-400/60 shrink-0"
                title="在当前工作区新增一页"
              >
                + 页
              </button>
            )}
          </div>
        )}

        {/* Tiled Split Layout Workspace (desktop) or Active Single Leaf (portrait) */}
        <div className="flex-1 min-w-0 min-h-0 p-1 bg-[#161b22]">
          {activeWorkspace && (!isPortrait || activePortraitLeaf) && (
            <SplitLayout
              node={
                isPortrait && activePortraitLeaf
                  ? { id: activePortraitLeaf.id, type: 'leaf', content: activePortraitLeaf.content }
                  : activeWorkspace.tree
              }
              dropTargetTileId={dropTargetTileId}
              onSplit={(tileId, dir: SplitDirection) =>
                updateActiveTree((tree) => splitLeaf(tree, tileId, dir))
              }
              onClose={(tileId) => updateActiveTree((tree) => closeLeaf(tree, tileId))}
              onClear={(tileId) => updateActiveTree((tree) => clearLeaf(tree, tileId))}
              onSelectContent={(tileId, content) =>
                updateActiveTree((tree) =>
                  setLeafContent(tree, tileId, {
                    kind: content.kind,
                    params: fillPaneDefaults(
                      content.kind,
                      content.params,
                      worldRef.current,
                      catalogRef.current,
                    ),
                  }),
                )
              }
              onSetParams={setTileParams}
              onResize={(splitId, ratio) =>
                updateActiveTree((tree) => updateSplitRatio(tree, splitId, ratio))
              }
              openTemp={openTemp}
            />
          )}
        </div>

        {/* Portrait Bottom Quick-Launch Dock */}
        {isPortrait && (
          <nav className="h-12 bg-[#1a2029] border-t border-sky-500/15 px-1.5 flex items-center gap-1 shrink-0 overflow-x-auto">
            {RAIL_BUTTONS.map((btn) => {
              const isTutTarget = tutorialHighlight === `rail:${btn.kind}`;
              return (
                <button
                  key={btn.kind}
                  onClick={() => openTemp(btn.kind)}
                  className={`min-w-[44px] h-10 px-1.5 rounded-[3px] flex flex-col items-center justify-center transition-colors border shrink-0 ${
                    isTutTarget
                      ? 'text-cyan-200 bg-cyan-500/20 border-cyan-400 ring-1 ring-cyan-400/70 animate-pulse'
                      : 'text-slate-400 hover:text-sky-300 hover:bg-sky-500/10 border-transparent hover:border-sky-500/30'
                  }`}
                  title={`打开临时悬浮窗：${btn.label}`}
                >
                  <span className="shrink-0 flex items-center justify-center">{btn.icon}</span>
                  <span className="text-[9px] mt-0.5 whitespace-nowrap leading-none">{btn.label}</span>
                </button>
              );
            })}
          </nav>
        )}
      </div>

      {/* Temporary Floating Windows Layer */}
      <FloatingWindowsLayer
        windows={floatingWindows}
        onBringToFront={bringFloatToFront}
        onMove={moveFloat}
        onResize={resizeFloat}
        onClose={closeFloat}
        onSetParams={setFloatParams}
        onReplaceContent={replaceFloat}
        onHoverTile={setDropTargetTileId}
        onDropOnTile={dockFloatToTile}
        openTemp={openTemp}
      />

      <CommandPalette
        open={paletteOpen}
        onClose={() => setPaletteOpen(false)}
        openTemp={openTemp}
      />

      <TutorialOverlay
        activeWorkspaceId={activeWorkspace?.id ?? activeWsId}
        zIndex={tutorialZ}
        onBringToFront={bringTutorialToFront}
        onSwitchWorkspace={switchWorkspace}
        onOpenTemp={openTemp}
      />

      {actionNotices.length > 0 && (
        <div className="fixed right-3 top-11 z-[9998] flex flex-col gap-1.5 max-w-[380px] pointer-events-none">
          {actionNotices.map((n) => (
            <div
              key={n.id}
              className={`pointer-events-auto flex items-start justify-between gap-2 px-2.5 py-1.5 rounded-[3px] border text-[11px] shadow-xl backdrop-blur-sm ${
                n.level === 'error'
                  ? 'bg-[#2a171c]/95 border-rose-500/55 text-rose-200'
                  : 'bg-[#1a2634]/95 border-sky-500/45 text-sky-100'
              }`}
            >
              <div className="min-w-0 leading-snug break-all">
                <span className="mono text-[9px] opacity-70 mr-1.5">T#{n.tick}</span>
                <span>{n.message}</span>
              </div>
              <button
                onClick={() => dismissActionNotice(n.id)}
                className="text-slate-400 hover:text-white shrink-0 mt-0.5"
                title="关闭提示"
              >
                <X className="w-3 h-3" />
              </button>
            </div>
          ))}
        </div>
      )}

      {presetMenuOpen && (
        <>
          <div className="fixed inset-0 z-[9998]" onClick={() => setPresetMenuOpen(false)} />
          <div className="fixed right-2 top-11 z-[9999] w-80 max-w-[calc(100vw-16px)] bg-[#212834] border border-sky-400/45 rounded-[3px] shadow-2xl overflow-hidden text-[11px]">
          <div className="px-2.5 py-2 border-b border-slate-800 flex items-center justify-between">
            <div className="flex items-center gap-2">
              <span className="font-medium text-slate-100">多设备窗口预设</span>
              <span
                className={`text-[10px] px-1.5 py-0.5 rounded ${
                  cloudSyncStatus === 'synced'
                    ? 'bg-emerald-500/15 text-emerald-300'
                    : cloudSyncStatus === 'syncing'
                      ? 'bg-sky-500/15 text-sky-300'
                      : 'bg-slate-700/60 text-slate-400'
                }`}
              >
                {cloudSyncStatus === 'synced'
                  ? '云端已同步'
                  : cloudSyncStatus === 'syncing'
                    ? '同步中…'
                    : '仅本地'}
              </span>
            </div>
            <div className="flex items-center gap-1.5">
              {sessionUser && (
                <button
                  onClick={() => void pullCloudPresets()}
                  className="text-slate-400 hover:text-sky-300 p-0.5"
                  title="从云端拉取最新预设"
                >
                  <RefreshCw className="w-3.5 h-3.5" />
                </button>
              )}
              <button onClick={() => setPresetMenuOpen(false)} className="text-slate-400 hover:text-white p-0.5">
                <X className="w-3.5 h-3.5" />
              </button>
            </div>
          </div>

          <div className="max-h-60 overflow-y-auto divide-y divide-slate-800/70">
            {layoutBundle.presets.map((p) => {
              const isCur = p.id === activePresetId;
              const deviceLabel =
                p.device === 'portrait' ? '竖屏' : p.device === 'desktop' ? '桌面' : '通用';
              return (
                <div
                  key={p.id}
                  className={`px-2.5 py-1.5 flex items-center justify-between gap-2 ${
                    isCur ? 'bg-sky-500/10' : 'hover:bg-slate-800/50'
                  }`}
                >
                  <button
                    onClick={() => selectPreset(p.id)}
                    className="flex-1 min-w-0 text-left flex items-center gap-1.5"
                  >
                    <Check className={`w-3.5 h-3.5 shrink-0 ${isCur ? 'text-sky-300' : 'opacity-0'}`} />
                    <span className={`truncate ${isCur ? 'text-sky-100 font-medium' : 'text-slate-200'}`}>
                      {p.name}
                    </span>
                    <span className="text-[9px] px-1 py-0.2 rounded bg-slate-800 text-slate-400 shrink-0">
                      {deviceLabel}
                    </span>
                  </button>
                  <div className="flex items-center gap-1 shrink-0">
                    <button
                      onClick={() => overwritePreset(p.id)}
                      className="text-[10px] px-1.5 py-0.5 rounded border border-slate-700/80 text-slate-300 hover:border-sky-400/50 hover:text-sky-200"
                      title="用当前工作区覆盖保存到此预设"
                    >
                      保存
                    </button>
                    {layoutBundle.presets.length > 1 && (
                      <button
                        onClick={() => deletePreset(p.id)}
                        className="text-slate-500 hover:text-rose-300 p-0.5"
                        title="删除预设"
                      >
                        <Trash2 className="w-3.5 h-3.5" />
                      </button>
                    )}
                  </div>
                </div>
              );
            })}
          </div>

          <div className="p-2.5 border-t border-slate-800 bg-[#1a2029] space-y-1.5">
            <div className="text-[10px] text-slate-400">另存当前工作区为新预设（不同设备独立选择激活项）：</div>
            <div className="flex items-center gap-1.5">
              <input
                value={newPresetName}
                onChange={(e) => setNewPresetName(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') {
                    e.preventDefault();
                    saveAsNewPreset();
                  }
                }}
                placeholder="预设名称（如：手机盘口）"
                className="flex-1 min-w-0 h-7 px-2 bg-[#161b22] border border-slate-700 rounded-[2px] text-[11px] text-slate-100 outline-none focus:border-sky-400"
              />
              <select
                value={newPresetDevice}
                onChange={(e) => setNewPresetDevice(e.target.value as PresetDeviceTag)}
                className="h-7 px-1.5 bg-[#161b22] border border-slate-700 rounded-[2px] text-[10px] text-slate-200 outline-none"
              >
                <option value="desktop">桌面</option>
                <option value="portrait">竖屏</option>
                <option value="all">通用</option>
              </select>
              <button
                onClick={saveAsNewPreset}
                disabled={!newPresetName.trim()}
                className="h-7 px-2.5 rounded-[2px] bg-sky-500/20 border border-sky-400/60 text-sky-100 text-[10px] hover:bg-sky-500/30 disabled:opacity-40 shrink-0"
              >
                新建
              </button>
            </div>
          </div>
        </div>
        </>
      )}

      {windowListOpen && (
        <>
          <div className="fixed inset-0 z-[9998]" onClick={() => setWindowListOpen(false)} />
          <div className="fixed right-2 top-11 z-[9999] w-72 max-w-[calc(100vw-16px)] bg-[#212834] border border-sky-400/45 rounded-[3px] shadow-2xl overflow-hidden">
            <div className="px-2.5 py-2 border-b border-slate-800 flex items-center justify-between text-[11px] text-slate-400">
              <span>临时窗口（{floatingWindows.length}/{MAX_FLOATING_WINDOWS}）</span>
              <button
                onClick={() => setWindowListOpen(false)}
                className="w-7 h-7 touch-target flex items-center justify-center hover:text-white rounded-[2px]"
              >
                <X className="w-3.5 h-3.5" />
              </button>
            </div>
            <div className="max-h-72 overflow-y-auto overscroll-contain divide-y divide-slate-800/60">
              {floatingWindows.length === 0 && (
                <div className="px-2.5 py-3 text-[11px] text-slate-500">没有打开的临时窗口</div>
              )}
              {floatingWindows.map((win) => (
                <div key={win.id} className="px-2.5 py-1.5 touch-row flex items-center justify-between gap-2 hover:bg-sky-500/10">
                  <button
                    onClick={() => {
                      bringFloatToFront(win.id);
                      setWindowListOpen(false);
                    }}
                    className="flex-1 min-w-0 py-1 text-[11px] text-sky-200 truncate text-left"
                  >
                    {paneTitle(win.kind, win.params, { catalog, world })}
                  </button>
                  <button
                    onClick={() => closeFloat(win.id)}
                    className="w-8 h-8 touch-target flex items-center justify-center text-slate-400 hover:text-rose-300 hover:bg-rose-500/15 shrink-0 rounded-[2px]"
                    title="关闭"
                  >
                    <X className="w-3.5 h-3.5" />
                  </button>
                </div>
              ))}
            </div>
          </div>
        </>
      )}
    </div>
  );
};

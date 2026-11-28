import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  Activity,
  BookOpen,
  Box,
  CandlestickChart,
  Compass,
  Factory,
  Globe2,
  HelpCircle,
  Landmark,
  Layers,
  PackageSearch,
  Plus,
  Rocket,
  Search,
  ShoppingBag,
  Terminal,
  Trophy,
  User,
  Workflow,
  X,
} from 'lucide-react';
import { useGameStore } from '../store/useGameStore';
import { useSessionStore } from '../store/useSessionStore';
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
  loadSavedWorkspaces,
  persistWorkspaces,
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

  const initialWs = useRef(loadSavedWorkspaces());
  const [workspaces, setWorkspaces] = useState<WorkspaceEntry[]>(initialWs.current.list);
  const [activeWsId, setActiveWsId] = useState<string>(initialWs.current.activeId);
  const [floatingWindows, setFloatingWindows] = useState<FloatingWindowItem[]>([]);
  const [dropTargetTileId, setDropTargetTileId] = useState<string | null>(null);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [addingWs, setAddingWs] = useState(false);
  const [newWsName, setNewWsName] = useState('');
  const [windowListOpen, setWindowListOpen] = useState(false);
  const hydratedRef = useRef(false);
  const workspaceRef = useRef(workspaces);
  workspaceRef.current = workspaces;
  const worldRef = useRef(world);
  worldRef.current = world;
  const catalogRef = useRef(catalog);
  catalogRef.current = catalog;

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
      persistWorkspaces(next, activeWsId);
      return next;
    });
    // Deps are primitives: this only re-runs when the resolved defaults actually change.
  }, [world.ready, world.homePlanetId, hubStationId, defaultItemId, activeWsId, workspaces]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        setPaletteOpen((v) => !v);
      } else if (e.key === 'Escape') {
        setPaletteOpen(false);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const updateActiveTree = useCallback(
    (fn: (tree: SplitNode) => SplitNode) => {
      setWorkspaces((prev) => {
        const next = prev.map((w) => (w.id === activeWsId ? { ...w, tree: fn(w.tree) } : w));
        persistWorkspaces(next, activeWsId);
        return next;
      });
    },
    [activeWsId],
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
      const width =
        kind === 'apidocs'
          ? 760
          : kind === 'script'
            ? 680
            : kind === 'settings'
              ? 600
              : kind === 'chart' || kind === 'orbit'
                ? 520
                : 460;
      const height = kind === 'apidocs' ? 560 : kind === 'script' || kind === 'settings' ? 460 : 380;

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
    persistWorkspaces(workspaces, nextId);
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
    persistWorkspaces(next, newId);
    setAddingWs(false);
    setNewWsName('');
  };

  const activeWorkspace = workspaces.find((w) => w.id === activeWsId) ?? workspaces[0];
  const cash = moneyToCredits(state?.player_snapshot?.company.cash);
  const paused = state?.paused ?? false;

  return (
    <div className="h-screen w-screen flex flex-col bg-[#161b22] text-slate-200 overflow-hidden">
      {/* Top Telemetry Chrome */}
      <header className="h-9 bg-[#1f2630] border-b border-sky-500/15 px-3 flex items-center justify-between gap-3 shrink-0">
        <div className="flex items-center gap-3 min-w-0">
          <div className="flex items-center gap-2 pr-3 border-r border-slate-800 shrink-0">
            <MeridianLogo className="w-4 h-4 shrink-0" />
            <span className="font-semibold tracking-[0.18em] text-[11px] text-slate-100 whitespace-nowrap">
              子午线 · MERIDIAN
            </span>
          </div>

          <div className="flex items-center gap-1 overflow-x-auto">
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

        {/* Player Metrics & Window Palette */}
        <div className="flex items-center gap-3 text-[11px] mono shrink-0">
          <div className="hidden md:flex items-center gap-3 text-slate-400">
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

          <div className="flex items-center gap-2 pl-2.5 border-l border-slate-700/60">
            {floatingWindows.length > 0 && (
              <button
                onClick={() => setWindowListOpen((v) => !v)}
                className="h-7 px-2.5 rounded-[2px] border border-slate-700/80 bg-[#232a36] text-[11px] text-slate-300 hover:border-sky-400/50 hover:text-sky-100 inline-flex items-center gap-1.5 whitespace-nowrap transition-colors"
                title="列出/切换已打开的临时窗口"
              >
                <span>悬浮窗</span>
                <span className="text-sky-300">{floatingWindows.length}</span>
              </button>
            )}
            <button
              onClick={() => setPaletteOpen(true)}
              title="全局搜索 (Ctrl / ⌘ + K)"
              className="h-7 px-3 rounded-[2px] border border-slate-700/80 bg-[#181e26] text-[11px] text-slate-300 hover:border-sky-400/50 hover:text-slate-100 inline-flex items-center gap-1.5 whitespace-nowrap transition-colors"
            >
              <Search className="w-3.5 h-3.5 text-slate-400 shrink-0" />
              <span className="font-sans">搜索</span>
            </button>
            <button
              onClick={() => {
                bringTutorialToFront();
                openTutorial();
              }}
              className="h-7 px-2.5 rounded-[2px] border border-slate-700/80 bg-[#232a36] text-[11px] text-slate-200 hover:border-sky-400/50 hover:text-sky-100 inline-flex items-center gap-1.5 whitespace-nowrap transition-colors"
              title="打开新手引导教程"
            >
              <HelpCircle className="w-3.5 h-3.5 text-sky-400/85 shrink-0" />
              <span className="font-sans">引导</span>
            </button>
            <button
              onClick={() => openTemp('settings')}
              title="个人设置"
              className="h-7 px-2.5 rounded-[2px] border border-slate-700/70 bg-[#232a36]/80 text-[11px] text-slate-200 hover:border-sky-400/50 hover:text-sky-100 inline-flex items-center gap-1.5 whitespace-nowrap transition-colors"
            >
              <User className="w-3.5 h-3.5 text-slate-400 shrink-0" />
              <span className="max-w-[96px] truncate font-sans">{playerName}</span>
            </button>
          </div>
        </div>
      </header>

      {lastError && (
        <div className="px-3 py-1 bg-rose-500/15 border-b border-rose-500/40 text-rose-300 text-[11px] flex items-center justify-between">
          <span>连接或请求异常：{lastError}</span>
          <button onClick={clearError} className="text-[10px] underline">
            忽略
          </button>
        </div>
      )}

      {/* Body: Left Rail (all clicks open temporary floating windows!) + Split Tile Desktop */}
      <div className="flex-1 flex min-h-0 relative">
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

        {/* Tiled Split Layout Workspace (strictly 1 panel per tile, NO tabs!) */}
        <div className="flex-1 min-w-0 min-h-0 p-1 bg-[#161b22]">
          {activeWorkspace && (
            <SplitLayout
              node={activeWorkspace.tree}
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

      {windowListOpen && (
        <div className="fixed right-2 top-11 z-[9999] w-64 bg-[#212834] border border-sky-400/45 rounded-[3px] shadow-2xl overflow-hidden">
          <div className="px-2 py-1.5 border-b border-slate-800 flex items-center justify-between text-[10px] text-slate-400">
            <span>临时窗口（{floatingWindows.length}/{MAX_FLOATING_WINDOWS}）</span>
            <button onClick={() => setWindowListOpen(false)} className="hover:text-white">
              <X className="w-3 h-3" />
            </button>
          </div>
          <div className="max-h-72 overflow-y-auto">
            {floatingWindows.length === 0 && (
              <div className="px-2 py-3 text-[10px] text-slate-500">没有打开的临时窗口</div>
            )}
            {floatingWindows.map((win) => (
              <div key={win.id} className="px-2 py-1 flex items-center justify-between gap-2 hover:bg-sky-500/10">
                <button
                  onClick={() => {
                    bringFloatToFront(win.id);
                    setWindowListOpen(false);
                  }}
                  className="text-[11px] text-sky-200 truncate text-left"
                >
                  {paneTitle(win.kind, win.params, { catalog, world })}
                </button>
                <button
                  onClick={() => closeFloat(win.id)}
                  className="text-slate-500 hover:text-rose-300 shrink-0"
                  title="关闭"
                >
                  <X className="w-3 h-3" />
                </button>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
};

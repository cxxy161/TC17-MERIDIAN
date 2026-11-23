import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  Activity,
  Box,
  CandlestickChart,
  Code2,
  Compass,
  Factory,
  Globe2,
  Landmark,
  Layers,
  Pause,
  Play,
  Plus,
  Rocket,
  RotateCcw,
  SkipForward,
  Terminal,
  Trophy,
} from 'lucide-react';
import { useGameStore } from '../store/useGameStore';
import { moneyToCredits } from '../types/meridian';
import type { FloatingWindowItem, PaneKind, PaneParams, TileContent } from './paneRegistry';
import {
  clearLeaf,
  closeLeaf,
  makeLeaf,
  setLeafContent,
  setLeafTitle,
  splitLeaf,
  updateSplitRatio,
  type SplitDirection,
  type SplitNode,
} from './splitTree';
import {
  loadSavedWorkspaces,
  persistWorkspaces,
  type WorkspaceEntry,
} from './workspaces';
import { SplitLayout } from './SplitLayout';
import { FloatingWindowsLayer } from './FloatingWindowsLayer';
import { CommandPalette } from './CommandPalette';

const RAIL_BUTTONS: Array<{ kind: PaneKind; label: string; icon: React.ReactNode; params?: PaneParams }> = [
  { kind: 'orbit', label: '星图', icon: <Compass className="w-4 h-4" /> },
  { kind: 'planet', label: '行星', icon: <Globe2 className="w-4 h-4" />, params: { planetId: 'P2' } },
  { kind: 'factory', label: '产线', icon: <Factory className="w-4 h-4" />, params: { planetId: 'P1' } },
  { kind: 'cargo', label: '仓库', icon: <Box className="w-4 h-4" />, params: { locationId: 'P1' } },
  { kind: 'fleet', label: '舰队', icon: <Rocket className="w-4 h-4" /> },
  { kind: 'ticker', label: '行情', icon: <Activity className="w-4 h-4" />, params: { stationId: 'ST:HUB' } },
  { kind: 'chart', label: 'K线', icon: <CandlestickChart className="w-4 h-4" />, params: { stationId: 'ST:HUB', itemId: 'steel' } },
  { kind: 'orderbook', label: '盘口', icon: <Layers className="w-4 h-4" />, params: { stationId: 'ST:HUB', itemId: 'steel' } },
  { kind: 'treasury', label: '银行', icon: <Landmark className="w-4 h-4" />, params: { planetId: 'P1' } },
  { kind: 'ranking', label: '排行', icon: <Trophy className="w-4 h-4" /> },
  { kind: 'script', label: '脚本', icon: <Code2 className="w-4 h-4" /> },
  { kind: 'console', label: '终端', icon: <Terminal className="w-4 h-4" /> },
];

export const DesktopShell: React.FC = () => {
  const init = useGameStore((s) => s.init);
  const state = useGameStore((s) => s.state);
  const wsStatus = useGameStore((s) => s.wsStatus);
  const lastError = useGameStore((s) => s.lastError);
  const clearError = useGameStore((s) => s.clearError);
  const simControl = useGameStore((s) => s.simControl);

  const initialWs = useRef(loadSavedWorkspaces());
  const [workspaces, setWorkspaces] = useState<WorkspaceEntry[]>(initialWs.current.list);
  const [activeWsId, setActiveWsId] = useState<string>(initialWs.current.activeId);
  const [floatingWindows, setFloatingWindows] = useState<FloatingWindowItem[]>([]);
  const [dropTargetTileId, setDropTargetTileId] = useState<string | null>(null);
  const [paletteOpen, setPaletteOpen] = useState(false);

  const topZRef = useRef(40);
  const floatSeqRef = useRef(1);

  useEffect(() => {
    void init();
  }, [init]);

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

  const openTemp = useCallback((kind: PaneKind, params: PaneParams = {}) => {
    const seq = floatSeqRef.current++;
    const z = ++topZRef.current;
    const offset = (seq % 6) * 26;
    const width = kind === 'script' ? 680 : kind === 'chart' || kind === 'orbit' ? 520 : 460;
    const height = kind === 'script' ? 460 : 380;

    setFloatingWindows((prev) => [
      ...prev,
      {
        id: `float-${Date.now()}-${seq}`,
        kind,
        params,
        x: Math.min(window.innerWidth - width - 20, 120 + offset),
        y: Math.min(window.innerHeight - height - 20, 72 + offset),
        w: width,
        h: height,
        z,
      },
    ]);
  }, []);

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

  const setFloatTitle = useCallback((id: string, title: string) => {
    setFloatingWindows((prev) => prev.map((w) => (w.id === id ? { ...w, title } : w)));
  }, []);

  const dockFloatToTile = useCallback(
    (winId: string, tileId: string) => {
      setFloatingWindows((prev) => {
        const win = prev.find((w) => w.id === winId);
        if (!win) return prev;
        const content: TileContent = {
          kind: win.kind,
          params: win.params,
          title: win.title,
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

  const addWorkspace = () => {
    const name = window.prompt('输入新工作区名称：', `工作区 ${workspaces.length + 1}`);
    if (!name) return;
    const newId = `ws-${Date.now()}`;
    const entry: WorkspaceEntry = {
      id: newId,
      name: name.trim(),
      tree: makeLeaf(null),
    };
    const next = [...workspaces, entry];
    setWorkspaces(next);
    setActiveWsId(newId);
    persistWorkspaces(next, newId);
  };

  const activeWorkspace = workspaces.find((w) => w.id === activeWsId) ?? workspaces[0];
  const cash = moneyToCredits(state?.player_snapshot?.company.cash);
  const paused = state?.paused ?? false;
  const tickMs = state?.tick_ms ?? 2000;

  return (
    <div className="h-screen w-screen flex flex-col bg-[#161b22] text-slate-200 overflow-hidden">
      {/* Top Telemetry Chrome */}
      <header className="h-9 bg-[#1f2630] border-b border-sky-500/15 px-3 flex items-center justify-between gap-3 shrink-0">
        <div className="flex items-center gap-3 min-w-0">
          <div className="flex items-center gap-2 pr-3 border-r border-slate-800 shrink-0">
            <svg viewBox="0 0 24 24" className="w-4 h-4 text-sky-400" fill="none" stroke="currentColor" strokeWidth="1.6">
              <circle cx="12" cy="12" r="9" />
              <ellipse cx="12" cy="12" rx="4" ry="9" stroke="#34d399" />
              <line x1="3" y1="12" x2="21" y2="12" />
            </svg>
            <span className="font-semibold tracking-[0.18em] text-[11px] text-slate-100 whitespace-nowrap">
              子午线 · MERIDIAN
            </span>
          </div>

          <div className="flex items-center gap-1 overflow-x-auto">
            {workspaces.map((w) => (
              <button
                key={w.id}
                onClick={() => switchWorkspace(w.id)}
                className={`pill-btn shrink-0 whitespace-nowrap ${w.id === activeWsId ? 'active' : ''}`}
              >
                {w.name}
              </button>
            ))}
            <button onClick={addWorkspace} className="pill-btn px-1.5 shrink-0" title="新建空白自定义工作区">
              <Plus className="w-3.5 h-3.5" />
            </button>
          </div>
        </div>

        {/* Metrics & Controls */}
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
              className={`flex items-center gap-1 text-[10px] whitespace-nowrap ${
                (state?.conservation_error ?? 0) === 0 ? 'text-emerald-400' : 'text-rose-400'
              }`}
            >
              <span
                className={`w-1.5 h-1.5 rounded-full ${
                  wsStatus === 'connected' ? 'bg-emerald-400' : 'bg-amber-400'
                }`}
              />
              守恒 Δ={state?.conservation_error ?? 0}
            </span>
          </div>

          <div className="flex items-center gap-1.5 pl-2 border-l border-slate-800">
            <button
              onClick={() => void simControl(paused ? 'resume' : 'pause')}
              className={`${paused ? 'cta-green' : 'pill-btn'} flex items-center gap-1 whitespace-nowrap`}
            >
              {paused ? <Play className="w-3 h-3" /> : <Pause className="w-3 h-3" />}
              {paused ? '继续' : '暂停'}
            </button>
            <button onClick={() => void simControl('step')} className="pill-btn flex items-center gap-1 whitespace-nowrap">
              <SkipForward className="w-3 h-3" />
              步进
            </button>
            <select
              value={tickMs}
              onChange={(e) => void simControl('speed', Number(e.target.value))}
              className="bg-[#27303e] border border-slate-700 text-[10px] px-1.5 py-0.5 rounded-sm text-slate-300"
              title="模拟节奏"
            >
              <option value={500}>极速 0.5s</option>
              <option value={1000}>快速 1.0s</option>
              <option value={2000}>标准 2.0s</option>
              <option value={5000}>慢速 5.0s</option>
            </select>
            <button
              onClick={() => {
                if (window.confirm('确认重置星系并清空当前档位交易与历史？')) {
                  void simControl('reset');
                }
              }}
              className="pill-btn text-slate-400 hover:text-rose-300"
              title="重置星系"
            >
              <RotateCcw className="w-3 h-3" />
            </button>
            <button onClick={() => setPaletteOpen(true)} className="cta-blue whitespace-nowrap">
              ⌘K 临时窗口
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
            {RAIL_BUTTONS.map((btn) => (
              <button
                key={btn.kind}
                onClick={() => openTemp(btn.kind, btn.params)}
                className="w-9 h-9 rounded-[3px] flex flex-col items-center justify-center text-slate-400 hover:text-sky-300 hover:bg-sky-500/10 border border-transparent hover:border-sky-500/30 transition-colors"
                title={`打开临时悬浮窗：${btn.label}`}
              >
                {btn.icon}
                <span className="text-[9px] mt-0.5">{btn.label}</span>
              </button>
            ))}
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
                updateActiveTree((tree) => setLeafContent(tree, tileId, content))
              }
              onSetTitle={(tileId, title) =>
                updateActiveTree((tree) => setLeafTitle(tree, tileId, title))
              }
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
        onSetTitle={setFloatTitle}
        onHoverTile={setDropTargetTileId}
        onDropOnTile={dockFloatToTile}
        openTemp={openTemp}
      />

      <CommandPalette
        open={paletteOpen}
        onClose={() => setPaletteOpen(false)}
        openTemp={openTemp}
      />
    </div>
  );
};

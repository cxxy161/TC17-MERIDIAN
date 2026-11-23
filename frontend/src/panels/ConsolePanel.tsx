import React, { useEffect, useRef, useState } from 'react';
import { useGameStore } from '../store/useGameStore';
import type { PaneProps } from '../layout/paneRegistry';
import { moneyToCredits } from '../types/meridian';

function buildEvalContext(
  state: ReturnType<typeof useGameStore.getState>['state'],
  catalog: ReturnType<typeof useGameStore.getState>['catalog'],
  scripts: ReturnType<typeof useGameStore.getState>['scripts'],
) {
  const snap = state?.player_snapshot;
  const mem = (() => {
    try {
      return JSON.parse(scripts?.memory_json ?? '{}');
    } catch {
      return {};
    }
  })();

  const makeStoreProxy = (raw: Record<string, number>) =>
    new Proxy(
      {
        ...raw,
        getUsedCapacity(res?: string) {
          if (res === undefined) {
            return Object.values(raw).reduce((a, b) => a + b, 0);
          }
          return raw[res] ?? 0;
        },
      },
      {
        get(target, prop: string) {
          if (prop in target) return (target as Record<string, unknown>)[prop];
          if ((catalog?.items ?? []).some((i) => i.id === prop)) return 0;
          return undefined;
        },
      },
    );

  const planets: Record<string, unknown> = {};
  if (snap) {
    for (const [pid, pv] of Object.entries(snap.planets)) {
      planets[pid] = {
        ...pv,
        groundStore: makeStoreProxy(pv.ground_store),
        stationStore: makeStoreProxy(pv.station_store),
      };
    }
  }

  const stations: Record<string, unknown> = {};
  if (snap) {
    for (const [sid, st] of Object.entries(snap.company.station_stores)) {
      stations[sid] = { id: sid, store: makeStoreProxy(st) };
    }
  }

  const tickers = state?.market_tickers ?? [];
  const Game = snap
    ? {
        time: state?.tick ?? 0,
        cpi: state?.cpi ?? 1,
        company: {
          id: snap.company.id,
          name: snap.company.name,
          profession: snap.company.profession,
          homePlanetId: snap.company.home_planet_id,
          cash: moneyToCredits(snap.company.cash),
          savings: moneyToCredits(snap.company.savings),
          debt: moneyToCredits(snap.company.debt),
        },
        planets,
        stations,
        buildings: Object.fromEntries(snap.company.buildings.map((b) => [String(b.id), b])),
        ships: Object.fromEntries(
          snap.company.ships.map((s) => [
            String(s.id),
            { ...s, store: makeStoreProxy(s.cargo) },
          ]),
        ),
        market: {
          credits: moneyToCredits(snap.company.cash),
          orders: Object.fromEntries(snap.company.open_orders.map((o) => [String(o.order_id), o])),
          quote(stationId: string, itemId: string) {
            return tickers.find((t) => t.station_id === stationId && t.item_id === itemId) ?? null;
          },
          calcRoute(from: string, to: string) {
            const pair = snap.routes[from]?.[to];
            return pair ? { ticks: pair[0], fuel: pair[1] } : null;
          },
        },
      }
    : { time: state?.tick ?? 0, cpi: state?.cpi ?? 1 };

  return { Game, Memory: mem };
}

function formatVal(v: unknown): string {
  if (v === undefined) return 'undefined';
  if (v === null) return 'null';
  if (typeof v === 'string') return JSON.stringify(v);
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  try {
    return JSON.stringify(v, null, 2);
  } catch {
    return String(v);
  }
}

export const ConsolePanel: React.FC<PaneProps> = () => {
  const history = useGameStore((s) => s.consoleHistory);
  const state = useGameStore((s) => s.state);
  const catalog = useGameStore((s) => s.catalog);
  const scripts = useGameStore((s) => s.scripts);
  const lastOut = state?.last_player_output;
  const clearConsole = useGameStore((s) => s.clearConsole);
  const appendConsoleLines = useGameStore((s) => s.appendConsoleLines);
  const saveMemory = useGameStore((s) => s.saveMemory);

  const [cmd, setCmd] = useState('');
  const [cmdHistory, setCmdHistory] = useState<string[]>([]);
  const [histIdx, setHistIdx] = useState<number>(-1);
  const bottomRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'auto' });
  }, [history.length]);

  const badgeStyle = (lvl: string) => {
    switch (lvl) {
      case 'warn':
        return 'text-amber-300';
      case 'error':
        return 'text-rose-400';
      case 'system':
        return 'text-emerald-400';
      case 'input':
        return 'text-sky-300';
      case 'result':
        return 'text-slate-200';
      default:
        return 'text-sky-400';
    }
  };

  const levelLabel = (lvl: string) => {
    switch (lvl) {
      case 'warn':
        return '警告';
      case 'error':
        return '异常';
      case 'system':
        return '系统';
      case 'input':
        return '>';
      case 'result':
        return '<-';
      default:
        return '日志';
    }
  };

  const executeCommand = async () => {
    const raw = cmd.trim();
    if (!raw) return;
    const tick = state?.tick ?? 0;
    setCmd('');
    setCmdHistory((prev) => [raw, ...prev.filter((x) => x !== raw)].slice(0, 60));
    setHistIdx(-1);

    if (raw === 'clear' || raw === 'clear()') {
      clearConsole();
      return;
    }

    if (raw === 'help') {
      appendConsoleLines([
        { tick, level: 'input', message: raw },
        {
          tick,
          level: 'system',
          message:
            '控制台支持 F12 式 JS 表达式实时求值：例如 Game.company / Game.planets.P2.demands / Game.market.quote("ST:HUB","steel") / Memory / clear()',
        },
      ]);
      return;
    }

    const logsOut: Array<{ level: 'log' | 'warn' | 'error'; msg: string }> = [];
    const fakeConsole = {
      log: (...args: unknown[]) => logsOut.push({ level: 'log', msg: args.map(formatVal).join(' ') }),
      warn: (...args: unknown[]) => logsOut.push({ level: 'warn', msg: args.map(formatVal).join(' ') }),
      error: (...args: unknown[]) => logsOut.push({ level: 'error', msg: args.map(formatVal).join(' ') }),
    };

    const { Game, Memory } = buildEvalContext(state, catalog, scripts);
    const beforeMem = JSON.stringify(Memory);

    try {
      const resourceConstLines = (catalog?.items ?? [])
        .map((it) => `const RESOURCE_${it.id.toUpperCase()} = ${JSON.stringify(it.id)};`)
        .join('\n');
      const wrapped = `
        ${resourceConstLines}
        const RESOURCES_ALL = ${JSON.stringify((catalog?.items ?? []).map((i) => i.id))};
        const OK = 0, ORDER_BUY = "buy", ORDER_SELL = "sell";
        return (${raw});
      `;
      let result: unknown;
      try {
        const fn = new Function('Game', 'Memory', 'console', wrapped);
        result = fn(Game, Memory, fakeConsole);
      } catch {
        const stmtFn = new Function(
          'Game',
          'Memory',
          'console',
          `${resourceConstLines}\nconst RESOURCES_ALL = ${JSON.stringify((catalog?.items ?? []).map((i) => i.id))};\n${raw}`,
        );
        result = stmtFn(Game, Memory, fakeConsole);
      }

      const afterMem = JSON.stringify(Memory);
      if (afterMem !== beforeMem) {
        await saveMemory(afterMem);
      }

      const newLines = [
        { tick, level: 'input' as const, message: raw },
        ...logsOut.map((l) => ({ tick, level: l.level, message: l.msg })),
        { tick, level: 'result' as const, message: formatVal(result) },
      ];
      appendConsoleLines(newLines);
    } catch (e) {
      appendConsoleLines([
        { tick, level: 'input', message: raw },
        { tick, level: 'error', message: e instanceof Error ? e.message : String(e) },
      ]);
    }
  };

  return (
    <div className="h-full flex flex-col bg-[#191f27] text-slate-200 overflow-hidden">
      <div className="px-3 py-1.5 border-b border-sky-500/15 bg-[#232a36] flex items-center justify-between text-[11px] shrink-0">
        <span className="font-medium">F12 交互控制台</span>
        <div className="flex items-center gap-3">
          <span className="mono text-[10px] text-emerald-400">
            沙盒耗时 {(lastOut?.cpu_used_ms ?? 0).toFixed(2)} / 5.00 ms
          </span>
          <button onClick={clearConsole} className="pill-btn py-0 text-[10px]">
            清空
          </button>
        </div>
      </div>

      <div className="flex-1 overflow-y-auto p-2.5 mono text-[11px] space-y-1">
        {history.length === 0 ? (
          <div className="text-slate-500">
            输入 JS 表达式回车即时调试（例如 <span className="text-sky-300">Game.company</span>、
            <span className="text-sky-300">Memory</span> 或 <span className="text-sky-300">help</span>）
          </div>
        ) : (
          history.map((line, i) => (
            <div key={i} className="leading-relaxed break-all whitespace-pre-wrap">
              <span className="text-slate-600 mr-1.5">[{String(line.tick).padStart(4, '0')}]</span>
              <span className={`${badgeStyle(line.level)} mr-1.5 font-semibold`}>
                {levelLabel(line.level)}
              </span>
              <span className={line.level === 'result' ? 'text-emerald-200' : 'text-slate-300'}>
                {line.message}
              </span>
            </div>
          ))
        )}
        <div ref={bottomRef} />
      </div>

      {/* Interactive F12 REPL prompt */}
      <div className="border-t border-sky-500/20 bg-[#1e2530] px-2.5 py-1.5 flex items-center gap-2 shrink-0">
        <span className="text-sky-400 mono font-bold text-[12px]">&gt;</span>
        <input
          value={cmd}
          onChange={(e) => setCmd(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault();
              void executeCommand();
            } else if (e.key === 'ArrowUp') {
              e.preventDefault();
              if (cmdHistory.length > 0) {
                const next = Math.min(cmdHistory.length - 1, histIdx + 1);
                setHistIdx(next);
                setCmd(cmdHistory[next]);
              }
            } else if (e.key === 'ArrowDown') {
              e.preventDefault();
              if (histIdx > 0) {
                const next = histIdx - 1;
                setHistIdx(next);
                setCmd(cmdHistory[next]);
              } else {
                setHistIdx(-1);
                setCmd('');
              }
            }
          }}
          placeholder="输入 JS 命令回车执行，↑↓ 翻历史，help 看示例..."
          className="flex-1 bg-transparent outline-none mono text-[11px] text-slate-100 placeholder:text-slate-500"
        />
      </div>
    </div>
  );
};

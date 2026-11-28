import React, { useEffect, useRef, useState } from 'react';
import { ChevronDown, ChevronRight } from 'lucide-react';
import { api } from '../api/client';
import { useGameStore, type LogHistoryLine } from '../store/useGameStore';
import type { PaneProps } from '../layout/paneRegistry';
import {
  parseMessageToSegments,
  toConsoleValue,
  type ConsoleValue,
} from '../utils/consoleFormat';

const primitiveClass = (t: string): string => {
  switch (t) {
    case 'number':
      return 'text-amber-300';
    case 'string':
      return 'text-emerald-300';
    case 'boolean':
      return 'text-sky-300';
    case 'undefined':
    case 'null':
      return 'text-slate-500';
    default:
      return 'text-slate-300';
  }
};

/** DevTools-style collapsible console value renderer: objects/arrays/JSON always default to collapsed. */
const ConsoleValueNode: React.FC<{ value: ConsoleValue; propKey?: string }> = ({
  value,
  propKey,
}) => {
  const [open, setOpen] = useState(false);

  const keyPrefix = propKey !== undefined ? (
    <span className="text-sky-200/80 mr-1 shrink-0">{propKey}:</span>
  ) : null;

  if (value.kind === 'primitive') {
    return (
      <span className="inline-flex items-baseline gap-0.5 break-all">
        {keyPrefix}
        <span className={primitiveClass(value.valType)}>{value.display}</span>
      </span>
    );
  }

  if (value.kind === 'function') {
    return (
      <span className="inline-flex items-baseline gap-0.5 text-violet-300/90 italic">
        {keyPrefix}
        <span>ƒ {value.name || 'anonymous'}()</span>
      </span>
    );
  }

  if (value.kind === 'circular') {
    return (
      <span className="inline-flex items-baseline gap-0.5 text-amber-400">
        {keyPrefix}
        <span>[Circular]</span>
      </span>
    );
  }

  if (value.kind === 'truncated') {
    return (
      <span className="inline-flex items-baseline gap-0.5 text-slate-500">
        {keyPrefix}
        <span>{value.label}</span>
      </span>
    );
  }

  const label =
    value.kind === 'array'
      ? `Array(${value.length})`
      : value.tag
        ? `${value.tag}`
        : '';
  const children = value.kind === 'array' ? value.items : value.entries;

  return (
    <span className="inline-block align-top max-w-full">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="inline-flex items-center gap-0.5 text-left hover:bg-sky-500/10 rounded px-0.5 -ml-0.5 max-w-full"
      >
        {open ? (
          <ChevronDown className="w-3 h-3 text-slate-400 shrink-0" />
        ) : (
          <ChevronRight className="w-3 h-3 text-slate-400 shrink-0" />
        )}
        {keyPrefix}
        {label && <span className="text-slate-400 mr-1 shrink-0">{label}</span>}
        {!open && (
          <span className="text-slate-300/90 truncate max-w-[460px] inline-block align-bottom">
            {value.preview}
          </span>
        )}
      </button>
      {open && (
        <div className="pl-3.5 border-l border-slate-700/70 ml-1.5 mt-0.5 space-y-0.5">
          {children.length === 0 ? (
            <div className="text-slate-500 text-[10px]">(empty)</div>
          ) : (
            children.map((entry) => (
              <div key={entry.key} className="leading-snug">
                <ConsoleValueNode value={entry.value} propKey={entry.key} />
              </div>
            ))
          )}
        </div>
      )}
    </span>
  );
};

const ConsoleLineContent: React.FC<{ line: LogHistoryLine }> = ({ line }) => {
  if (line.values && line.values.length > 0) {
    return (
      <span className="inline-flex flex-wrap items-baseline gap-x-2 align-top">
        {line.values.map((val, idx) => (
          <ConsoleValueNode key={idx} value={val} />
        ))}
      </span>
    );
  }

  const segments = line.level !== 'input' ? parseMessageToSegments(line.message) : null;
  if (segments) {
    return (
      <span className="inline-flex flex-wrap items-baseline gap-x-1.5 align-top">
        {segments.map((seg, idx) =>
          typeof seg === 'string' ? (
            <span key={idx} className="text-slate-300">
              {seg}
            </span>
          ) : (
            <ConsoleValueNode key={idx} value={seg} />
          ),
        )}
      </span>
    );
  }

  return (
    <span className={line.level === 'result' ? 'text-emerald-200' : 'text-slate-300'}>
      {line.message}
    </span>
  );
};

function sandboxResultToConsoleValue(res: { kind: string; value?: unknown }): ConsoleValue {
  if (res.kind === 'undefined') return toConsoleValue(undefined);
  if (res.kind === 'null') return toConsoleValue(null);
  if (res.kind === 'function') {
    return { kind: 'function', name: 'anonymous' };
  }
  return toConsoleValue(res.value);
}

export const ConsolePanel: React.FC<PaneProps> = () => {
  const history = useGameStore((s) => s.consoleHistory);
  const state = useGameStore((s) => s.state);
  const scripts = useGameStore((s) => s.scripts);
  const companyId = useGameStore((s) => s.companyId);
  const lastOut = state?.last_player_output;
  const clearConsole = useGameStore((s) => s.clearConsole);
  const appendConsoleLines = useGameStore((s) => s.appendConsoleLines);
  const refreshScripts = useGameStore((s) => s.refreshScripts);

  const [cmd, setCmd] = useState('');
  const [busy, setBusy] = useState(false);
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
    if (!raw || busy) return;
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
            '控制台直连后端 QuickJS 真沙盒（与脚本共享同一 Game 与 Memory）：可试 Game.company / Game.sites / Game.catalog.recipesByBuilding / Game.market.quote("ST:HUB","steel") / Game.lastTick / clear()。完整接口见 API 参考窗口或 /docs/。',
        },
      ]);
      return;
    }

    setBusy(true);
    try {
      const resp = await api.evalConsole(companyId, raw);
      const t = resp.tick ?? tick;
      const lines: LogHistoryLine[] = [
        { tick: t, level: 'input', message: raw },
        ...resp.logs.map((l) => ({
          tick: t,
          level: l.level,
          message: l.message,
        })),
      ];
      if (resp.error) {
        lines.push({ tick: t, level: 'error', message: resp.error });
      } else {
        lines.push({
          tick: t,
          level: 'result',
          message: '',
          values: [sandboxResultToConsoleValue(resp.result)],
        });
        if (resp.intents_queued > 0) {
          lines.push({
            tick: t,
            level: 'system',
            message: `已入队 ${resp.intents_queued} 条动作等待下回合结算`,
          });
        }
        if (resp.memory_changed) {
          void refreshScripts();
        }
      }
      appendConsoleLines(lines);
    } catch (e) {
      appendConsoleLines([
        { tick, level: 'input', message: raw },
        { tick, level: 'error', message: e instanceof Error ? e.message : String(e) },
      ]);
    } finally {
      setBusy(false);
    }
  };

  const cpuLimit = scripts?.cpu_limit_ms ?? 10;
  const cpuBucketLimit = scripts?.cpu_bucket_limit_ms ?? cpuLimit * 5;
  const cpuBucket = lastOut?.cpu_bucket_ms ?? scripts?.cpu_bucket_ms ?? cpuBucketLimit;

  return (
    <div className="h-full flex flex-col bg-[#191f27] text-slate-200 overflow-hidden">
      <div className="px-3 py-1.5 border-b border-sky-500/15 bg-[#232a36] flex items-center justify-between text-[11px] shrink-0">
        <span className="font-medium">F12 真沙盒控制台</span>
        <div className="flex items-center gap-3">
          <span
            className="mono text-[10px] text-emerald-400"
            title="每回合基础配额与可透支 CPU 缓存桶（上限为每 tick 配额的 5 倍）"
          >
            沙盒耗时 {(lastOut?.cpu_used_ms ?? 0).toFixed(2)} / {cpuLimit.toFixed(2)} ms · 缓存{' '}
            {cpuBucket.toFixed(1)}/{cpuBucketLimit.toFixed(0)} ms
          </span>
          <button onClick={clearConsole} className="pill-btn py-0 text-[10px]">
            清空
          </button>
        </div>
      </div>

      <div className="flex-1 overflow-y-auto p-2.5 mono text-[11px] space-y-1">
        {history.length === 0 ? (
          <div className="text-slate-500">
            直连 QuickJS 真沙盒实时求值（例如 <span className="text-sky-300">Game.company</span>、
            <span className="text-sky-300">Game.catalog</span> 或 <span className="text-sky-300">help</span>）
          </div>
        ) : (
          history.map((line, i) => (
            <div key={i} className="leading-relaxed flex items-start gap-1.5">
              <span className="text-slate-600 shrink-0">[{String(line.tick).padStart(4, '0')}]</span>
              <span className={`${badgeStyle(line.level)} font-semibold shrink-0`}>
                {levelLabel(line.level)}
              </span>
              <div className="min-w-0 flex-1 break-all">
                <ConsoleLineContent line={line} />
              </div>
            </div>
          ))
        )}
        <div ref={bottomRef} />
      </div>

      {/* Recent command chips for touch users without arrow keys */}
      {cmdHistory.length > 0 && (
        <div className="border-t border-slate-800/80 bg-[#1a2029] px-2.5 py-1 flex items-center gap-1.5 overflow-x-auto shrink-0">
          <span className="text-[10px] text-slate-500 shrink-0">历史:</span>
          {cmdHistory.slice(0, 6).map((h, idx) => (
            <button
              key={`${idx}-${h}`}
              type="button"
              onClick={() => setCmd(h)}
              className="pill-btn py-0 px-2 text-[10px] mono max-w-[160px] truncate shrink-0"
              title={h}
            >
              {h}
            </button>
          ))}
        </div>
      )}

      {/* Interactive F12 REPL prompt */}
      <div className="border-t border-sky-500/20 bg-[#1e2530] px-2.5 py-1.5 flex items-center gap-2 shrink-0">
        <span className="text-sky-400 mono font-bold text-[12px]">&gt;</span>
        <input
          value={cmd}
          onChange={(e) => setCmd(e.target.value)}
          disabled={busy}
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
          placeholder="输入 JS 命令（回车或点执行），help 看示例..."
          className="flex-1 min-w-0 bg-transparent outline-none mono text-[11px] text-slate-100 placeholder:text-slate-500 disabled:opacity-60"
        />
        <button
          type="button"
          disabled={busy || !cmd.trim()}
          onClick={() => void executeCommand()}
          className="cta-blue py-0.5 px-2.5 text-[10px] disabled:opacity-40 shrink-0"
        >
          执行
        </button>
      </div>
    </div>
  );
};

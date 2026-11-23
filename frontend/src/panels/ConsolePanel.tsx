import React, { useEffect, useRef } from 'react';
import { useGameStore } from '../store/useGameStore';
import type { PaneProps } from '../layout/paneRegistry';

export const ConsolePanel: React.FC<PaneProps> = () => {
  const history = useGameStore((s) => s.consoleHistory);
  const lastOut = useGameStore((s) => s.state?.last_player_output);
  const clearConsole = useGameStore((s) => s.clearConsole);
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
      default:
        return '日志';
    }
  };

  return (
    <div className="h-full flex flex-col bg-[#191f27] text-slate-200 overflow-hidden">
      <div className="px-3 py-1.5 border-b border-sky-500/10 bg-[#232a36] flex items-center justify-between text-[11px] shrink-0">
        <span className="font-medium">遥测终端输出</span>
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
          <div className="text-slate-600">暂无日志输出（点击运行或步进触发玩家脚本执行）</div>
        ) : (
          history.map((line, i) => (
            <div key={i} className="leading-relaxed break-all">
              <span className="text-slate-600 mr-1.5">[{String(line.tick).padStart(4, '0')}]</span>
              <span className={`${badgeStyle(line.level)} mr-1.5 font-semibold`}>
                {levelLabel(line.level)}
              </span>
              <span className="text-slate-300">{line.message}</span>
            </div>
          ))
        )}
        <div ref={bottomRef} />
      </div>
    </div>
  );
};

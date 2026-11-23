import React, { useEffect, useMemo, useRef, useState } from 'react';
import type { IDockviewPanelProps } from 'dockview-react';
import { EditorState } from '@codemirror/state';
import { EditorView, keymap, lineNumbers } from '@codemirror/view';
import { defaultKeymap, history, historyKeymap } from '@codemirror/commands';
import { javascript } from '@codemirror/lang-javascript';
import { autocompletion, type CompletionContext } from '@codemirror/autocomplete';
import { oneDark } from '@codemirror/theme-one-dark';
import { useGameStore } from '../store/useGameStore';
import type { PaneParams } from '../layout/paneRegistry';

const SCREEPS_COMPLETIONS = [
  { label: 'Game.time', type: 'property', detail: '当前回合数' },
  { label: 'Game.cpi', type: 'property', detail: '全星系物价指数' },
  { label: 'Game.cpu.getUsed()', type: 'method', detail: '当前脚本已消耗毫秒数' },
  { label: 'Game.company', type: 'property', detail: '现金/储蓄/负债/职业信息' },
  { label: 'Game.planets', type: 'property', detail: '所有行星遥测与仓库 Store' },
  { label: 'Game.stations', type: 'property', detail: '各轨道站与枢纽站 Store' },
  { label: 'Game.buildings', type: 'property', detail: '名下设施（setRecipe / setActive）' },
  { label: 'Game.ships', type: 'property', detail: '名下飞船（dispatch / repair）' },
  { label: 'Game.market.quote(stationId, item)', type: 'method', detail: '懒加载查询盘口报价' },
  { label: 'Game.market.depth(stationId, item, limit)', type: 'method', detail: '查询买卖深度' },
  { label: 'Game.market.getAllOrders(filter)', type: 'method', detail: '查询市场挂单' },
  { label: 'Game.market.createOrder({ type, resourceType, price, totalAmount, stationId })', type: 'method', detail: '发布限价买卖单' },
  { label: 'Game.market.cancelOrder(orderId)', type: 'method', detail: '撤销本人挂单' },
  { label: 'Game.market.deal(orderId, amount)', type: 'method', detail: '直接吃单成交' },
  { label: 'Game.market.calcRoute(fromId, toId)', type: 'method', detail: '计算航线耗时与油耗' },
  { label: 'Game.buyPlot(planetId, listingId)', type: 'method', detail: '购买一手或二手地块' },
  { label: 'Game.buildFacility(plotId, buildingType)', type: 'method', detail: '建造设施' },
  { label: 'Game.demolishFacility(plotId, buildingId)', type: 'method', detail: '拆除设施' },
  { label: 'Game.bank(planetId, op, amount)', type: 'method', detail: '央行存取借还' },
  { label: 'Game.getRecipe(recipeId)', type: 'method', detail: '读取配方静态详情' },
  { label: 'Memory', type: 'variable', detail: '128KB 持久化 JSON 树' },
  { label: 'RESOURCES_ALL', type: 'constant', detail: '全物资数组' },
  { label: 'OK', type: 'constant', detail: '0 成功' },
  { label: 'ERR_NOT_OWNER', type: 'constant', detail: '-1 无权限' },
  { label: 'ERR_NO_PATH', type: 'constant', detail: '-2 无可用航线' },
  { label: 'ERR_BUSY', type: 'constant', detail: '-4 飞船航行中' },
  { label: 'ERR_NOT_FOUND', type: 'constant', detail: '-5 目标不存在' },
  { label: 'ERR_NOT_ENOUGH_RESOURCES', type: 'constant', detail: '-6 库存/燃料不足' },
  { label: 'ERR_FULL', type: 'constant', detail: '-8 满载或挂单上限' },
  { label: 'ERR_NOT_IN_RANGE', type: 'constant', detail: '-9 位置不匹配' },
  { label: 'ERR_NOT_ENOUGH_CREDITS', type: 'constant', detail: '-14 现金不足' },
  { label: 'ORDER_BUY', type: 'constant', detail: '"buy"' },
  { label: 'ORDER_SELL', type: 'constant', detail: '"sell"' },
];

export const ScriptIdePanel: React.FC<IDockviewPanelProps<PaneParams>> = () => {
  const scripts = useGameStore((s) => s.scripts);
  const catalog = useGameStore((s) => s.catalog);
  const saveScripts = useGameStore((s) => s.saveScripts);
  const saveMemory = useGameStore((s) => s.saveMemory);

  const [draftModules, setDraftModules] = useState<Record<string, string>>({});
  const [activeMod, setActiveMod] = useState<string>('main');
  const [showMemory, setShowMemory] = useState<boolean>(false);
  const [memoryDraft, setMemoryDraft] = useState<string>('{}');
  const [dirty, setDirty] = useState<boolean>(false);
  const [saveNote, setSaveNote] = useState<string>('');

  const editorHostRef = useRef<HTMLDivElement | null>(null);
  const viewRef = useRef<EditorView | null>(null);

  useEffect(() => {
    if (scripts?.modules && !dirty) {
      setDraftModules(scripts.modules);
      if (!scripts.modules[activeMod] && scripts.modules.main) {
        setActiveMod('main');
      }
    }
    if (scripts?.memory_json && !showMemory) {
      setMemoryDraft(scripts.memory_json);
    }
  }, [scripts, dirty, activeMod, showMemory]);

  const dynamicResourceCompletions = useMemo(() => {
    const items = (catalog?.items ?? []).map((it) => ({
      label: `RESOURCE_${it.id.toUpperCase()}`,
      type: 'constant',
      detail: `${it.name} ("${it.id}")`,
    }));
    return [...SCREEPS_COMPLETIONS, ...items];
  }, [catalog]);

  useEffect(() => {
    const host = editorHostRef.current;
    if (!host) return;

    const screepsSource = (context: CompletionContext) => {
      const word = context.matchBefore(/[\w.]+/);
      if (!word || (word.from === word.to && !context.explicit)) return null;
      return {
        from: word.from,
        options: dynamicResourceCompletions,
      };
    };

    const startDoc = draftModules[activeMod] ?? scripts?.modules[activeMod] ?? '';
    const state = EditorState.create({
      doc: startDoc,
      extensions: [
        lineNumbers(),
        history(),
        keymap.of([...defaultKeymap, ...historyKeymap]),
        javascript(),
        oneDark,
        autocompletion({ override: [screepsSource] }),
        EditorView.updateListener.of((upd) => {
          if (upd.docChanged) {
            const val = upd.state.doc.toString();
            setDraftModules((prev) => ({ ...prev, [activeMod]: val }));
            setDirty(true);
          }
        }),
        EditorView.theme({
          '&': { height: '100%', backgroundColor: '#070b11', fontSize: '12px' },
          '.cm-gutters': { backgroundColor: '#090e15', borderRight: '1px solid rgba(56,189,248,0.12)' },
        }),
      ],
    });

    const view = new EditorView({ state, parent: host });
    viewRef.current = view;

    return () => {
      view.destroy();
      viewRef.current = null;
    };
  }, [activeMod, dynamicResourceCompletions]);

  // Sync external module resets into active editor when not dirty
  useEffect(() => {
    const view = viewRef.current;
    if (!view || dirty) return;
    const expected = scripts?.modules[activeMod] ?? '';
    if (view.state.doc.toString() !== expected) {
      view.dispatch({
        changes: { from: 0, to: view.state.doc.length, insert: expected },
      });
    }
  }, [scripts, activeMod, dirty]);

  const moduleNames = Object.keys(draftModules).length > 0 ? Object.keys(draftModules) : Object.keys(scripts?.modules ?? { main: '' });

  const handleSave = async () => {
    const toSave = Object.keys(draftModules).length > 0 ? draftModules : (scripts?.modules ?? {});
    await saveScripts(toSave, scripts?.enabled ?? true);
    setDirty(false);
    setSaveNote('已热重载部署');
    window.setTimeout(() => setSaveNote(''), 2000);
  };

  const handleAddModule = () => {
    const raw = window.prompt('输入新模块名称（如 market 或 logistics）：');
    if (!raw) return;
    const clean = raw.trim().replace(/\.js$/, '');
    if (!clean) return;
    setDraftModules((prev) => ({
      ...prev,
      [clean]: prev[clean] ?? `// 模块 ${clean}\nexports.run = function () {\n  \n};\n`,
    }));
    setActiveMod(clean);
    setDirty(true);
  };

  const cpuMs = scripts?.last_output?.cpu_used_ms ?? 0;

  return (
    <div className="h-full flex flex-col bg-[#070b11] text-slate-200 overflow-hidden">
      <div className="px-2.5 py-1.5 border-b border-sky-500/15 bg-[#0a111a] flex items-center justify-between gap-2 shrink-0 flex-wrap">
        <div className="flex items-center gap-1 flex-wrap">
          {moduleNames.map((m) => (
            <button
              key={m}
              onClick={() => setActiveMod(m)}
              className={`pill-btn py-0 text-[10px] mono ${activeMod === m ? 'active' : ''}`}
            >
              {m}.js
            </button>
          ))}
          <button onClick={handleAddModule} className="pill-btn py-0 text-[10px]">
            + 模块
          </button>
        </div>

        <div className="flex items-center gap-2">
          <span className="mono text-[10px] text-emerald-400">
            耗时 {cpuMs.toFixed(2)} / 5.00 ms
          </span>
          <button
            onClick={() => {
              setMemoryDraft(scripts?.memory_json ?? '{}');
              setShowMemory((v) => !v);
            }}
            className={`pill-btn py-0 text-[10px] ${showMemory ? 'active' : ''}`}
          >
            {showMemory ? '返回代码' : '查看 Memory'}
          </button>
          <button onClick={() => void handleSave()} className="cta-green text-[10px] py-0.5">
            {dirty ? '保存并热重载 *' : saveNote || '保存热重载'}
          </button>
        </div>
      </div>

      {showMemory ? (
        <div className="flex-1 flex flex-col p-3 gap-2 min-h-0">
          <div className="flex items-center justify-between text-[11px] text-slate-400">
            <span>持久化 Memory JSON（上限 128 KB）</span>
            <button
              onClick={() => void saveMemory(memoryDraft)}
              className="cta-blue text-[10px] py-0.5"
            >
              写入 Memory
            </button>
          </div>
          <textarea
            value={memoryDraft}
            onChange={(e) => setMemoryDraft(e.target.value)}
            className="flex-1 bg-[#080d14] border border-slate-800 p-3 mono text-[12px] text-emerald-300 outline-none resize-none"
          />
        </div>
      ) : (
        <div ref={editorHostRef} className="flex-1 min-h-0 overflow-hidden" />
      )}
    </div>
  );
};

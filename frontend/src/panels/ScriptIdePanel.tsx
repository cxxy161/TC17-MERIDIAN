import React, { useEffect, useMemo, useRef, useState } from 'react';
import { EditorState } from '@codemirror/state';
import { EditorView, keymap, lineNumbers } from '@codemirror/view';
import { defaultKeymap, history, historyKeymap } from '@codemirror/commands';
import { javascript } from '@codemirror/lang-javascript';
import { autocompletion, type CompletionContext } from '@codemirror/autocomplete';
import { oneDark } from '@codemirror/theme-one-dark';
import { useGameStore } from '../store/useGameStore';
import type { PaneProps } from '../layout/paneRegistry';

const API_COMPLETIONS = [
  { label: 'Game.time', type: 'property', detail: '当前 tick 序号' },
  { label: 'Game.cpi', type: 'property', detail: '全星系物价指数' },
  { label: 'Game.cpu.limit', type: 'property', detail: '单 tick CPU 毫秒上限' },
  { label: 'Game.cpu.getUsed()', type: 'method', detail: '本 tick 已消耗毫秒数' },
  { label: 'Game.company', type: 'property', detail: '本公司现金/储蓄/负债/母星与职业' },
  { label: 'Game.planets', type: 'property', detail: '全星系行星遥测与本公司仓库' },
  { label: 'Game.plots', type: 'property', detail: '本公司名下地块（含 slotId / lat / lon / buildingMods）' },
  { label: 'Game.stations', type: 'property', detail: '本公司有库存记录的站点 Store' },
  { label: 'Game.buildings', type: 'property', detail: '名下已完工建筑（setRecipe / setActive）' },
  { label: 'Game.ships', type: 'property', detail: '名下飞船（dispatch / repair）' },
  { label: 'Game.market.credits', type: 'property', detail: '本 tick 开盘现金副本' },
  { label: 'Game.market.orders', type: 'property', detail: '本公司活跃挂单字典' },
  { label: 'Game.market.quote(stationId, resourceType)', type: 'method', detail: '查询盘口报价' },
  { label: 'Game.market.depth(stationId, resourceType, limit)', type: 'method', detail: '查询买卖盘口深度（最多 5 档）' },
  { label: 'Game.market.getAllOrders(filter)', type: 'method', detail: '筛选全星系活跃挂单' },
  { label: 'Game.market.createOrder({ type, resourceType, price, totalAmount, stationId })', type: 'method', detail: '发布限价买卖单' },
  { label: 'Game.market.cancelOrder(orderId)', type: 'method', detail: '撤销本公司挂单' },
  { label: 'Game.market.deal(orderId, amount)', type: 'method', detail: '直接吃单成交' },
  { label: 'Game.market.calcRoute(fromId, toId)', type: 'method', detail: '估算航线耗时与基准油耗' },
  { label: 'Game.market.getLandPlots(planetId)', type: 'method', detail: '获取行星全部公开地表格点' },
  { label: 'Game.market.listCompanies(filter)', type: 'method', detail: '分页筛选全星系公司公开摘要' },
  { label: 'Game.market.getCompany(companyId)', type: 'method', detail: '查看指定公司的公开商业情报' },
  { label: 'Game.buyPlot(planetId, { slotId } | { listingId })', type: 'method', detail: '购买一手空地或收购二手挂牌地' },
  { label: 'Game.buildFacility(plotId, buildingType)', type: 'method', detail: '在地块上建造建筑' },
  { label: 'Game.demolishFacility(plotId, buildingId)', type: 'method', detail: '拆除地块上的建筑' },
  { label: 'Game.bank(planetId, op, amount)', type: 'method', detail: '母星央行存取借还' },
  { label: 'Game.getRecipe(recipeId)', type: 'method', detail: '读取静态配方详情' },
  { label: 'Memory', type: 'variable', detail: '128 KB 跨 tick 持久化 JSON 对象' },
  { label: 'console.log', type: 'method', detail: '输出普通日志（每 tick 限 200 行）' },
  { label: 'console.warn', type: 'method', detail: '输出警告日志' },
  { label: 'console.error', type: 'method', detail: '输出错误日志' },
  { label: 'require(name)', type: 'function', detail: '加载同项目扁平模块' },
  { label: 'RESOURCES_ALL', type: 'constant', detail: '全部物品 ID 只读数组' },
  { label: 'OK', type: 'constant', detail: '0 成功' },
  { label: 'ERR_NOT_OWNER', type: 'constant', detail: '-1 无权限' },
  { label: 'ERR_NO_PATH', type: 'constant', detail: '-2 没有可行航线' },
  { label: 'ERR_BUSY', type: 'constant', detail: '-4 飞船航行中' },
  { label: 'ERR_NOT_FOUND', type: 'constant', detail: '-5 目标不存在' },
  { label: 'ERR_NOT_ENOUGH_RESOURCES', type: 'constant', detail: '-6 出发地燃料不足' },
  { label: 'ERR_INVALID_TARGET', type: 'constant', detail: '-7 目标无效或不匹配' },
  { label: 'ERR_FULL', type: 'constant', detail: '-8 满载或配额/挂单上限' },
  { label: 'ERR_NOT_IN_RANGE', type: 'constant', detail: '-9 飞船不在指定出发地' },
  { label: 'ERR_INVALID_ARGS', type: 'constant', detail: '-10 参数非法' },
  { label: 'ERR_NOT_ENOUGH_CREDITS', type: 'constant', detail: '-14 现金不足' },
  { label: 'ORDER_BUY', type: 'constant', detail: '"buy"' },
  { label: 'ORDER_SELL', type: 'constant', detail: '"sell"' },
];

export const ScriptIdePanel: React.FC<PaneProps> = ({ openTemp }) => {
  const scripts = useGameStore((s) => s.scripts);
  const catalog = useGameStore((s) => s.catalog);
  const draftModules = useGameStore((s) => s.draftModules);
  const activeMod = useGameStore((s) => s.activeScriptModule);
  const dirty = useGameStore((s) => s.scriptDirty);
  const setActiveMod = useGameStore((s) => s.setActiveScriptModule);
  const updateDraftModule = useGameStore((s) => s.updateDraftModule);
  const createDraftModule = useGameStore((s) => s.createDraftModule);
  const saveDraftScripts = useGameStore((s) => s.saveDraftScripts);

  const [addingFile, setAddingFile] = useState(false);
  const [newFileName, setNewFileName] = useState('');
  const [saveNote, setSaveNote] = useState('');

  const editorHostRef = useRef<HTMLDivElement | null>(null);
  const viewRef = useRef<EditorView | null>(null);

  const dynamicResourceCompletions = useMemo(() => {
    const items = catalog?.items ?? [];
    const valid = items.filter((it) => /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(`RESOURCE_${it.id.toUpperCase()}`));
    const constants = valid.map((it) => ({
      label: `RESOURCE_${it.id.toUpperCase()}`,
      type: 'constant' as const,
      detail: `${it.name} (${JSON.stringify(it.id)})`,
    }));
    // Chinese-name aliases: you know "金属钢材", but not whether the constant is RESOURCE_STEEL or
    // RESOURCE_BUILDING_MAT. Typing the Chinese name now suggests (and inserts) the right constant.
    const aliases = valid.map((it) => ({
      label: it.name,
      type: 'property' as const,
      detail: `→ RESOURCE_${it.id.toUpperCase()}`,
      apply: `RESOURCE_${it.id.toUpperCase()}`,
    }));
    return [...API_COMPLETIONS, ...constants, ...aliases];
  }, [catalog]);

  useEffect(() => {
    const host = editorHostRef.current;
    if (!host) return;

    const apiCompletionSource = (context: CompletionContext) => {
      // CJK included so Chinese item names trigger the alias completions.
      const word = context.matchBefore(/[\w.\u4e00-\u9fa5]+/);
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
        autocompletion({ override: [apiCompletionSource] }),
        EditorView.updateListener.of((upd) => {
          if (upd.docChanged) {
            updateDraftModule(activeMod, upd.state.doc.toString());
          }
        }),
        EditorView.theme(
          {
            '&': {
              height: '100%',
              backgroundColor: '#1b212b',
              color: '#dbe4f0',
              fontSize: '12px',
            },
            '.cm-scroller': {
              backgroundColor: '#1b212b',
              fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
            },
            '.cm-content': {
              backgroundColor: '#1b212b',
              caretColor: '#38bdf8',
            },
            '.cm-gutters': {
              backgroundColor: '#181e27',
              color: '#64748b',
              borderRight: '1px solid rgba(56, 189, 248, 0.14)',
            },
            '.cm-activeLine': {
              backgroundColor: 'rgba(56, 189, 248, 0.06)',
            },
            '.cm-activeLineGutter': {
              backgroundColor: '#222a36',
              color: '#94a3b8',
            },
          },
          { dark: true },
        ),
      ],
    });

    const view = new EditorView({ state, parent: host });
    viewRef.current = view;

    return () => {
      view.destroy();
      viewRef.current = null;
    };
  }, [activeMod, dynamicResourceCompletions, updateDraftModule]);

  // Sync content when active file is updated externally (e.g., reset or initial load)
  useEffect(() => {
    const view = viewRef.current;
    if (!view) return;
    const expected = draftModules[activeMod] ?? scripts?.modules[activeMod] ?? '';
    if (view.state.doc.toString() !== expected && !dirty) {
      view.dispatch({
        changes: { from: 0, to: view.state.doc.length, insert: expected },
      });
    }
  }, [draftModules, scripts, activeMod, dirty]);

  const moduleNames = Object.keys(draftModules).length > 0
    ? Object.keys(draftModules)
    : Object.keys(scripts?.modules ?? { main: '' });

  const handleSave = async () => {
    await saveDraftScripts();
    setSaveNote('已热重载部署');
    window.setTimeout(() => setSaveNote(''), 2000);
  };

  const submitNewFile = () => {
    const clean = newFileName.trim().replace(/\.js$/, '');
    if (clean) {
      createDraftModule(clean);
    }
    setNewFileName('');
    setAddingFile(false);
  };

  const cpuMs = scripts?.last_output?.cpu_used_ms ?? 0;

  return (
    <div className="h-full flex flex-col bg-[#1b212b] text-slate-200 overflow-hidden">
      <div className="px-2.5 py-1.5 border-b border-sky-500/15 bg-[#232a36] flex items-center justify-between gap-2 shrink-0 flex-wrap">
        <div className="flex items-center gap-1 flex-wrap min-w-0">
          {moduleNames.map((m) => (
            <button
              key={m}
              onClick={() => setActiveMod(m)}
              className={`pill-btn py-0 text-[10px] mono whitespace-nowrap ${activeMod === m ? 'active' : ''}`}
            >
              {m}.js
            </button>
          ))}
          {addingFile ? (
            <div className="flex items-center gap-1">
              <input
                autoFocus
                value={newFileName}
                onChange={(e) => setNewFileName(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') submitNewFile();
                  if (e.key === 'Escape') {
                    setAddingFile(false);
                    setNewFileName('');
                  }
                }}
                placeholder="如 market（扁平名）"
                className="w-28 bg-[#191f27] border border-sky-400/50 px-1.5 py-0 text-[10px] mono outline-none rounded-sm"
              />
              <button onClick={submitNewFile} className="cta-blue py-0 px-1.5 text-[10px]">
                确定
              </button>
            </div>
          ) : (
            <button onClick={() => setAddingFile(true)} className="pill-btn py-0 text-[10px] whitespace-nowrap">
              + 文件
            </button>
          )}
        </div>

        <div className="flex items-center gap-2 shrink-0">
          <button
            onClick={() => openTemp('apidocs', { docId: 'guides/quickstart' })}
            className="pill-btn py-0 text-[10px] whitespace-nowrap"
            title="打开玩家脚本 API 参考（Game / Memory / 返回码）"
          >
            API 参考
          </button>
          <span className="mono text-[10px] text-emerald-400 whitespace-nowrap">
            耗时 {cpuMs.toFixed(2)} / 5.00 ms
          </span>
          <button onClick={() => void handleSave()} className="cta-green text-[10px] py-0.5 whitespace-nowrap">
            {dirty ? '保存并热重载 *' : saveNote || '保存热重载'}
          </button>
        </div>
      </div>

      <div ref={editorHostRef} className="flex-1 min-h-0 overflow-hidden" />
    </div>
  );
};

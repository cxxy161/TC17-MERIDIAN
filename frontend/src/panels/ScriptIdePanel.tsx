import React, { useEffect, useMemo, useRef, useState } from 'react';
import { EditorState } from '@codemirror/state';
import {
  crosshairCursor,
  drawSelection,
  dropCursor,
  EditorView,
  highlightActiveLine,
  highlightActiveLineGutter,
  highlightSpecialChars,
  keymap,
  lineNumbers,
  rectangularSelection,
} from '@codemirror/view';
import { defaultKeymap, history, historyKeymap, indentWithTab } from '@codemirror/commands';
import {
  bracketMatching,
  defaultHighlightStyle,
  foldGutter,
  foldKeymap,
  indentOnInput,
  syntaxHighlighting,
} from '@codemirror/language';
import {
  completionPath,
  javascript,
  javascriptLanguage,
  scopeCompletionSource,
} from '@codemirror/lang-javascript';
import {
  acceptCompletion,
  autocompletion,
  closeBrackets,
  closeBracketsKeymap,
  completeAnyWord,
  completionKeymap,
  snippetCompletion,
  type Completion,
  type CompletionContext,
  type CompletionResult,
} from '@codemirror/autocomplete';
import { oneDark } from '@codemirror/theme-one-dark';
import { useGameStore } from '../store/useGameStore';
import type { PaneProps } from '../layout/paneRegistry';

const GAME_ROOT_COMPLETIONS: Completion[] = [
  { label: 'time', type: 'property', detail: '当前 tick 序号' },
  { label: 'cpi', type: 'property', detail: '全星系物价指数' },
  { label: 'cpu', type: 'namespace', detail: 'CPU 配额与耗时查询' },
  { label: 'company', type: 'property', detail: '本公司现金/储蓄/负债/母星与职业' },
  { label: 'systems', type: 'property', detail: '全星系恒星系字典' },
  { label: 'planets', type: 'property', detail: '全星系行星遥测（含 stationId / groundStore / stationStore / landListings）' },
  { label: 'stations', type: 'property', detail: '全星系空间站对象与库存 Store' },
  { label: 'plots', type: 'property', detail: '本公司名下地块（含 buildings / sites / build()）' },
  { label: 'buildings', type: 'property', detail: '名下已完工建筑（setRecipe / setActive / demolish）' },
  { label: 'sites', type: 'property', detail: '名下在建工程字典（ticksRemaining）' },
  { label: 'ships', type: 'property', detail: '名下飞船（dispatch(to, cargo) / repair）' },
  { label: 'catalog', type: 'namespace', detail: '全量只读静态规则（items / buildings / recipes / recipesByBuilding）' },
  { label: 'lastTick', type: 'namespace', detail: '上一回合真实成交 fills 与被拒 rejected 回执' },
  { label: 'map', type: 'namespace', detail: '星图、航线、公开格点与一手买地接口' },
  { label: 'market', type: 'namespace', detail: '星际交易所与二级土地市场接口' },
  { label: 'bank', type: 'namespace', detail: '母星央行存取借还接口' },
  snippetCompletion('getObjectById(${id})', {
    label: 'getObjectById',
    type: 'method',
    detail: '按字符串 ID 检索建筑/地块/工地/飞船/行星/站点',
  }),
];

const GAME_CPU_COMPLETIONS: Completion[] = [
  { label: 'limit', type: 'property', detail: '单 tick CPU 毫秒上限' },
  { label: 'getUsed', type: 'method', apply: 'getUsed()', detail: '本 tick 已消耗毫秒数' },
];

const GAME_MAP_COMPLETIONS: Completion[] = [
  snippetCompletion('calcRoute(${fromId}, ${toId})', {
    label: 'calcRoute',
    type: 'method',
    detail: '估算航线耗时、油耗与类型（orbital / interplanetary）',
  }),
  snippetCompletion('getLandPlots(${planetId})', {
    label: 'getLandPlots',
    type: 'method',
    detail: '获取行星全部公开地表格点与价格',
  }),
  snippetCompletion('buyPlot(${planetId}, ${slotId})', {
    label: 'buyPlot',
    type: 'method',
    detail: '购买星球一手未认领空地',
  }),
  snippetCompletion('listCompanies(${filter})', {
    label: 'listCompanies',
    type: 'method',
    detail: '分页筛选全星系公司公开摘要',
  }),
  snippetCompletion('getCompany(${companyId})', {
    label: 'getCompany',
    type: 'method',
    detail: '查看指定公司的公开商业情报',
  }),
];

const GAME_MARKET_COMPLETIONS: Completion[] = [
  { label: 'orders', type: 'property', detail: '本公司活跃挂单字典' },
  { label: 'transactions', type: 'property', detail: '上一 tick 本公司成交流水列表' },
  snippetCompletion('quote(${stationId}, ${resourceType})', {
    label: 'quote',
    type: 'method',
    detail: '查询盘口报价与 EMA 锚价',
  }),
  snippetCompletion('depth(${stationId}, ${resourceType}, ${5})', {
    label: 'depth',
    type: 'method',
    detail: '查询买卖盘口深度（默认最多 5 档）',
  }),
  snippetCompletion('getAllOrders(${filter})', {
    label: 'getAllOrders',
    type: 'method',
    detail: '分页筛选全星系活跃挂单（支持 offset / limit）',
  }),
  snippetCompletion('getOrderById(${orderId})', {
    label: 'getOrderById',
    type: 'method',
    detail: '按订单 ID 精确查询挂单',
  }),
  snippetCompletion(
    'createOrder({ type: ${ORDER_BUY}, resourceType: ${resourceType}, price: ${price}, totalAmount: ${qty}, stationId: ${stationId} })',
    {
      label: 'createOrder',
      type: 'method',
      detail: '发布限价买卖单',
    },
  ),
  snippetCompletion('cancelOrder(${orderId})', {
    label: 'cancelOrder',
    type: 'method',
    detail: '撤销本公司挂单',
  }),
  snippetCompletion('deal(${orderId}, ${amount})', {
    label: 'deal',
    type: 'method',
    detail: '直接吃单成交',
  }),
  snippetCompletion('buyLand(${listingId})', {
    label: 'buyLand',
    type: 'method',
    detail: '收购二手挂牌工业地块',
  }),
];

const GAME_BANK_COMPLETIONS: Completion[] = [
  snippetCompletion('deposit(${amount})', {
    label: 'deposit',
    type: 'method',
    detail: '存入现金到母星央行赚取利息',
  }),
  snippetCompletion('withdraw(${amount})', {
    label: 'withdraw',
    type: 'method',
    detail: '从母星央行提取储蓄',
  }),
  snippetCompletion('borrow(${amount})', {
    label: 'borrow',
    type: 'method',
    detail: '向母星央行申请信用贷款',
  }),
  snippetCompletion('repay(${amount})', {
    label: 'repay',
    type: 'method',
    detail: '偿还母星央行贷款本息',
  }),
];

const GAME_CATALOG_COMPLETIONS: Completion[] = [
  { label: 'items', type: 'property', detail: '全部物品定义字典' },
  { label: 'buildings', type: 'property', detail: '全部建筑定义与建造成本字典' },
  { label: 'recipes', type: 'property', detail: '全部生产配方定义字典' },
  { label: 'recipesByBuilding', type: 'property', detail: '按建筑类型分组的配方 ID 列表' },
];

const GAME_LAST_TICK_COMPLETIONS: Completion[] = [
  { label: 'fills', type: 'property', detail: '上一回合本公司全部真实成交记录' },
  { label: 'rejected', type: 'property', detail: '上一回合结算阶段被拒意图及原因列表' },
];

const CONSOLE_COMPLETIONS: Completion[] = [
  snippetCompletion('log(${msg})', {
    label: 'log',
    type: 'method',
    detail: '输出普通日志（每 tick 限 200 行）',
  }),
  snippetCompletion('warn(${msg})', {
    label: 'warn',
    type: 'method',
    detail: '输出警告日志',
  }),
  snippetCompletion('error(${msg})', {
    label: 'error',
    type: 'method',
    detail: '输出错误日志',
  }),
];

const TOP_LEVEL_API_COMPLETIONS: Completion[] = [
  { label: 'Game', type: 'variable', detail: '游戏世界状态与全部动作 API 根对象' },
  { label: 'Memory', type: 'variable', detail: '128 KB 跨 tick 持久化 JSON 对象' },
  { label: 'console', type: 'variable', detail: '脚本控制台日志输出对象' },
  snippetCompletion("require('${module}')", {
    label: 'require',
    type: 'function',
    detail: '加载当前项目模块',
  }),
  { label: 'exports', type: 'variable', detail: 'CommonJS 模块导出对象' },
  { label: 'module', type: 'variable', detail: '当前 CommonJS 模块元数据' },
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
  { label: 'MONEY_SCALE', type: 'constant', detail: '10000（1 信用点 = 10000 定点单位）' },
];

/** QuickJS 沙箱内置标准库，配合 scopeCompletionSource 提供 Math. / JSON. / Array. 等属性补全 */
const SANDBOX_STD_SCOPE = {
  Math,
  JSON,
  Object,
  Array,
  String,
  Number,
  Boolean,
  Date,
  RegExp,
  Map,
  Set,
  Error,
  TypeError,
  RangeError,
  parseInt,
  parseFloat,
  isNaN,
  isFinite,
};
const sandboxScopeCompletions = scopeCompletionSource(SANDBOX_STD_SCOPE);

interface SavedEditorViewport {
  scrollTop: number;
  scrollLeft: number;
  anchor: number;
  head: number;
}

const savedEditorViewports = new Map<string, SavedEditorViewport>();

export const ScriptIdePanel: React.FC<PaneProps> = ({ openTemp }) => {
  const companyId = useGameStore((s) => s.companyId);
  const scripts = useGameStore((s) => s.scripts);
  const catalog = useGameStore((s) => s.catalog);
  const draftModules = useGameStore((s) => s.draftModules);
  const activeMod = useGameStore((s) => s.activeScriptModule);
  const dirty = useGameStore((s) => s.scriptDirty);
  const setActiveMod = useGameStore((s) => s.setActiveScriptModule);
  const updateDraftModule = useGameStore((s) => s.updateDraftModule);
  const createDraftModule = useGameStore((s) => s.createDraftModule);
  const saveDraftScripts = useGameStore((s) => s.saveDraftScripts);
  const discardDraftScripts = useGameStore((s) => s.discardDraftScripts);

  const [addingFile, setAddingFile] = useState(false);
  const [newFileName, setNewFileName] = useState('');
  const [saveNote, setSaveNote] = useState('');

  const editorHostRef = useRef<HTMLDivElement | null>(null);
  const viewRef = useRef<EditorView | null>(null);
  const lastLocalDocRef = useRef<{ mod: string; code: string } | null>(null);

  const topLevelCompletions = useMemo<Completion[]>(() => {
    const items = catalog?.items ?? [];
    const valid = items.filter((it) => /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(`RESOURCE_${it.id.toUpperCase()}`));
    const constants: Completion[] = valid.map((it) => ({
      label: `RESOURCE_${it.id.toUpperCase()}`,
      type: 'constant',
      detail: `${it.name} (${JSON.stringify(it.id)})`,
    }));
    // Chinese-name aliases: you know "金属钢材", but not whether the constant is RESOURCE_STEEL or
    // RESOURCE_BUILDING_MAT. Typing the Chinese name now suggests (and inserts) the right constant.
    const aliases: Completion[] = valid.map((it) => ({
      label: it.name,
      type: 'property',
      detail: `→ RESOURCE_${it.id.toUpperCase()}`,
      apply: `RESOURCE_${it.id.toUpperCase()}`,
    }));
    return [...TOP_LEVEL_API_COMPLETIONS, ...constants, ...aliases];
  }, [catalog]);

  const moduleNames = useMemo(
    () =>
      Object.keys(draftModules).length > 0
        ? Object.keys(draftModules)
        : Object.keys(scripts?.modules ?? { main: '' }),
    [draftModules, scripts],
  );

  const topLevelRef = useRef<Completion[]>(topLevelCompletions);
  topLevelRef.current = topLevelCompletions;
  const moduleNamesRef = useRef<string[]>(moduleNames);
  moduleNamesRef.current = moduleNames;
  const updateDraftRef = useRef(updateDraftModule);
  updateDraftRef.current = updateDraftModule;
  const saveDraftRef = useRef(saveDraftScripts);
  saveDraftRef.current = saveDraftScripts;

  useEffect(() => {
    const host = editorHostRef.current;
    if (!host) return;

    const apiCompletionSource = (context: CompletionContext): CompletionResult | null => {
      // Complete require('...') with project module names
      const reqMatch = context.matchBefore(/require\(\s*['"][^'"]*$/);
      if (reqMatch) {
        const quoteIdx = Math.max(reqMatch.text.lastIndexOf("'"), reqMatch.text.lastIndexOf('"'));
        const from = reqMatch.from + quoteIdx + 1;
        const options: Completion[] = moduleNamesRef.current
          .filter((m) => m !== activeMod)
          .map((m) => ({ label: m, type: 'text', detail: `${m}.js` }));
        return { from, options, validFor: /^[^'"]*$/ };
      }

      // Context-aware property completion for Game.*, Game.market.*, Game.cpu.*, console.*
      const prop = completionPath(context);
      if (prop && prop.path.length > 0) {
        const prefix = prop.path.join('.');
        const word = context.matchBefore(/[\w$]*$/);
        const from = word ? word.from : context.pos;
        if (prefix === 'Game') {
          return { from, options: GAME_ROOT_COMPLETIONS, validFor: /^[\w$]*$/ };
        }
        if (prefix === 'Game.map') {
          return { from, options: GAME_MAP_COMPLETIONS, validFor: /^[\w$]*$/ };
        }
        if (prefix === 'Game.market') {
          return { from, options: GAME_MARKET_COMPLETIONS, validFor: /^[\w$]*$/ };
        }
        if (prefix === 'Game.bank') {
          return { from, options: GAME_BANK_COMPLETIONS, validFor: /^[\w$]*$/ };
        }
        if (prefix === 'Game.catalog') {
          return { from, options: GAME_CATALOG_COMPLETIONS, validFor: /^[\w$]*$/ };
        }
        if (prefix === 'Game.lastTick') {
          return { from, options: GAME_LAST_TICK_COMPLETIONS, validFor: /^[\w$]*$/ };
        }
        if (prefix === 'Game.cpu') {
          return { from, options: GAME_CPU_COMPLETIONS, validFor: /^[\w$]*$/ };
        }
        if (prefix === 'console') {
          return { from, options: CONSOLE_COMPLETIONS, validFor: /^[\w$]*$/ };
        }
        return null;
      }

      // Top-level identifiers & Chinese resource aliases
      const word = context.matchBefore(/[\w$\u4e00-\u9fa5]+/);
      if (!word || (word.from === word.to && !context.explicit)) return null;
      return {
        from: word.from,
        options: topLevelRef.current,
        validFor: /^[\w$\u4e00-\u9fa5]*$/,
      };
    };

    const viewportKey = `${companyId}::${activeMod}`;
    const savedViewport = savedEditorViewports.get(viewportKey);
    const startDoc = draftModules[activeMod] ?? scripts?.modules[activeMod] ?? '';
    const clampedAnchor = savedViewport ? Math.min(savedViewport.anchor, startDoc.length) : 0;
    const clampedHead = savedViewport ? Math.min(savedViewport.head, startDoc.length) : clampedAnchor;
    let restoringViewport = !!savedViewport;

    const saveCurrentViewport = (targetView: EditorView, includeScroll: boolean) => {
      const sel = targetView.state.selection.main;
      const prev = savedEditorViewports.get(viewportKey);
      savedEditorViewports.set(viewportKey, {
        scrollTop:
          includeScroll && targetView.scrollDOM.isConnected
            ? targetView.scrollDOM.scrollTop
            : (prev?.scrollTop ?? 0),
        scrollLeft:
          includeScroll && targetView.scrollDOM.isConnected
            ? targetView.scrollDOM.scrollLeft
            : (prev?.scrollLeft ?? 0),
        anchor: sel.anchor,
        head: sel.head,
      });
    };

    const state = EditorState.create({
      doc: startDoc,
      selection: { anchor: clampedAnchor, head: clampedHead },
      extensions: [
        lineNumbers(),
        highlightActiveLineGutter(),
        highlightSpecialChars(),
        history(),
        foldGutter(),
        drawSelection(),
        dropCursor(),
        EditorState.allowMultipleSelections.of(true),
        indentOnInput(),
        syntaxHighlighting(defaultHighlightStyle, { fallback: true }),
        bracketMatching(),
        closeBrackets(),
        highlightActiveLine(),
        rectangularSelection(),
        crosshairCursor(),
        javascript(),
        javascriptLanguage.data.of({ autocomplete: apiCompletionSource }),
        javascriptLanguage.data.of({ autocomplete: sandboxScopeCompletions }),
        javascriptLanguage.data.of({ autocomplete: completeAnyWord }),
        oneDark,
        autocompletion({ activateOnTyping: true }),
        keymap.of([
          { key: 'Tab', run: acceptCompletion },
          {
            key: 'Mod-s',
            preventDefault: true,
            run: () => {
              void saveDraftRef.current();
              setSaveNote('已热重载部署');
              window.setTimeout(() => setSaveNote(''), 2000);
              return true;
            },
          },
          ...closeBracketsKeymap,
          ...defaultKeymap,
          ...historyKeymap,
          ...foldKeymap,
          ...completionKeymap,
          indentWithTab,
        ]),
        EditorView.updateListener.of((upd) => {
          if (upd.docChanged) {
            const code = upd.state.doc.toString();
            lastLocalDocRef.current = { mod: activeMod, code };
            updateDraftRef.current(activeMod, code);
          }
          if (!restoringViewport && (upd.selectionSet || upd.docChanged)) {
            saveCurrentViewport(upd.view, upd.view.scrollDOM.isConnected);
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
              backgroundColor: 'transparent',
              caretColor: '#38bdf8',
            },
            '.cm-cursor, .cm-dropCursor': {
              borderLeftColor: '#38bdf8',
            },
            '&.cm-focused > .cm-scroller > .cm-selectionLayer .cm-selectionBackground, .cm-selectionBackground': {
              backgroundColor: 'rgba(56, 189, 248, 0.28)',
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
            '.cm-matchingBracket': {
              backgroundColor: 'rgba(56, 189, 248, 0.24)',
              outline: '1px solid rgba(56, 189, 248, 0.55)',
            },
            '.cm-tooltip.cm-tooltip-autocomplete': {
              backgroundColor: '#181e27',
              border: '1px solid rgba(56, 189, 248, 0.28)',
            },
          },
          { dark: true },
        ),
      ],
    });

    const view = new EditorView({ state, parent: host });
    viewRef.current = view;

    const onEditorScroll = () => {
      if (restoringViewport || !view.scrollDOM.isConnected) return;
      saveCurrentViewport(view, true);
    };
    view.scrollDOM.addEventListener('scroll', onEditorScroll, { passive: true });

    let destroyed = false;
    let raf1 = 0;
    let raf2 = 0;
    if (savedViewport) {
      view.scrollDOM.scrollTop = savedViewport.scrollTop;
      view.scrollDOM.scrollLeft = savedViewport.scrollLeft;
      raf1 = window.requestAnimationFrame(() => {
        if (destroyed) return;
        view.requestMeasure();
        view.scrollDOM.scrollTop = savedViewport.scrollTop;
        view.scrollDOM.scrollLeft = savedViewport.scrollLeft;
        raf2 = window.requestAnimationFrame(() => {
          if (destroyed) return;
          view.scrollDOM.scrollTop = savedViewport.scrollTop;
          view.scrollDOM.scrollLeft = savedViewport.scrollLeft;
          restoringViewport = false;
        });
      });
    }

    return () => {
      destroyed = true;
      window.cancelAnimationFrame(raf1);
      window.cancelAnimationFrame(raf2);
      if (!restoringViewport && view.scrollDOM.isConnected) {
        saveCurrentViewport(view, true);
      }
      view.scrollDOM.removeEventListener('scroll', onEditorScroll);
      view.destroy();
      viewRef.current = null;
    };
  }, [companyId, activeMod]);

  // Sync content when active file is updated externally (e.g., reset, draft restore, or discard)
  useEffect(() => {
    const view = viewRef.current;
    if (!view) return;
    const expected = draftModules[activeMod] ?? scripts?.modules[activeMod] ?? '';
    const isOwnTypingEcho =
      lastLocalDocRef.current?.mod === activeMod && lastLocalDocRef.current?.code === expected;
    if (view.state.doc.toString() !== expected && !isOwnTypingEcho) {
      view.dispatch({
        changes: { from: 0, to: view.state.doc.length, insert: expected },
      });
    }
  }, [draftModules, scripts, activeMod]);

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

  const [kbInset, setKbInset] = useState(0);
  useEffect(() => {
    const vv = window.visualViewport;
    if (!vv) return;
    const sync = () => {
      const diff = Math.max(0, window.innerHeight - vv.height - vv.offsetTop);
      setKbInset(diff > 80 ? diff : 0);
    };
    sync();
    vv.addEventListener('resize', sync);
    vv.addEventListener('scroll', sync);
    return () => {
      vv.removeEventListener('resize', sync);
      vv.removeEventListener('scroll', sync);
    };
  }, []);

  const cpuMs = scripts?.last_output?.cpu_used_ms ?? 0;

  return (
    <div
      style={kbInset > 0 ? { paddingBottom: kbInset } : undefined}
      className="h-full flex flex-col bg-[#1b212b] text-slate-200 overflow-hidden"
    >
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
            耗时 {cpuMs.toFixed(2)} / {(scripts?.cpu_limit_ms ?? 10).toFixed(2)} ms
          </span>
          {dirty && (
            <button
              onClick={() => discardDraftScripts()}
              className="pill-btn py-0 text-[10px] text-amber-300 border-amber-500/40 whitespace-nowrap"
              title="放弃未保存的本地浏览器草稿，恢复为服务端当前运行的脚本"
            >
              放弃草稿
            </button>
          )}
          <button onClick={() => void handleSave()} className="cta-green text-[10px] py-0.5 whitespace-nowrap">
            {dirty ? '保存并热重载 *' : saveNote || '保存热重载'}
          </button>
        </div>
      </div>

      <div ref={editorHostRef} className="flex-1 min-h-0 overflow-hidden" />
    </div>
  );
};

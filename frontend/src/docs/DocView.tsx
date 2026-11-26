import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  AlertTriangle,
  ArrowUpRight,
  BookOpen,
  Check,
  ChevronRight,
  Copy,
  Info,
  List,
  Search,
  ShieldAlert,
  X,
} from 'lucide-react';
import {
  DEFAULT_DOC_ID,
  DOC_BY_ID,
  DOC_VERSION,
  docGroups,
  findEntry,
  searchDocs,
} from './apiDocs';
import type { DocBlock, DocEntry, DocParamRequired } from './types';
import type { ProductionPack } from '../types/meridian';

export interface DocViewProps {
  variant: 'pane' | 'page';
  docId?: string;
  onNavigate: (id: string) => void;
  /** 当前世界的物品表，用于渲染 RESOURCE_<ID> 的动态常量清单。 */
  items?: Array<{ id: string; name: string }>;
  /** 可选：完整世界生产包，用于在速查页渲染实时建筑与配方表。 */
  catalog?: ProductionPack | null;
  className?: string;
}

const cx = (...parts: Array<string | false | null | undefined>): string =>
  parts.filter(Boolean).join(' ');

/** 轻量行内解析：支持反引号行内代码与加粗。 */
const Inline: React.FC<{ text: string }> = ({ text }) => {
  const parts = text.split(/(\u0060[^\u0060]+\u0060|\*\*[^*]+\*\*)/g);
  return (
    <>
      {parts.map((part, i) => {
        if (part.length > 2 && part.startsWith('\u0060') && part.endsWith('\u0060')) {
          return (
            <code
              key={i}
              className="mono rounded-[2px] border border-sky-500/20 bg-[#181e27] px-1 py-[1px] text-[10.5px] text-sky-200/90"
            >
              {part.slice(1, -1)}
            </code>
          );
        }
        if (part.length > 4 && part.startsWith('**') && part.endsWith('**')) {
          return (
            <strong key={i} className="font-semibold text-slate-100">
              {part.slice(2, -2)}
            </strong>
          );
        }
        return <React.Fragment key={i}>{part}</React.Fragment>;
      })}
    </>
  );
};

const SectionLabel: React.FC<{ children: React.ReactNode }> = ({ children }) => (
  <div className="mb-1 text-[9.5px] font-medium uppercase tracking-[0.1em] text-slate-400">
    {children}
  </div>
);

const CopyButton: React.FC<{ label: string; copied: boolean; onCopy: () => void }> = ({
  label,
  copied,
  onCopy,
}) => (
  <button
    type="button"
    onClick={onCopy}
    className={cx(
      'inline-flex shrink-0 items-center gap-1 rounded-[2px] border px-1.5 py-[1px] text-[9px] transition-colors',
      copied
        ? 'border-emerald-400/50 bg-emerald-500/10 text-emerald-300'
        : 'border-slate-600/60 bg-transparent text-slate-400 hover:border-sky-400/60 hover:text-sky-200',
    )}
  >
    {copied ? <Check size={10} /> : <Copy size={10} />}
    {copied ? '已复制' : label}
  </button>
);

const CodePanel: React.FC<{
  code: string;
  caption?: string;
  wrap?: boolean;
  copied: boolean;
  onCopy: () => void;
}> = ({ code, caption, wrap, copied, onCopy }) => (
  <div className="overflow-hidden rounded-[2px] border border-[rgba(56,189,248,0.16)] bg-[#1b212b]">
    <div className="flex items-center justify-between gap-2 border-b border-white/[0.06] bg-[#232a36] px-2 py-[3px]">
      <span className="mono truncate text-[9px] uppercase tracking-[0.14em] text-slate-500">
        {caption ?? 'js'}
      </span>
      <CopyButton label="复制" copied={copied} onCopy={onCopy} />
    </div>
    <pre
      className={cx(
        'mono overflow-x-auto px-2.5 py-2 text-[10.5px] leading-[1.65] text-slate-300',
        wrap ? 'whitespace-pre-wrap break-words' : 'whitespace-pre',
      )}
    >
      {code}
    </pre>
  </div>
);

const TH: React.FC<{ children: React.ReactNode; className?: string }> = ({ children, className }) => (
  <th
    className={cx(
      'border-b border-sky-500/15 px-1.5 py-1 text-left text-[9px] font-normal uppercase tracking-[0.1em] text-slate-500',
      className,
    )}
  >
    {children}
  </th>
);

const TD: React.FC<{ children: React.ReactNode; className?: string }> = ({ children, className }) => (
  <td className={cx('border-b border-white/[0.04] px-1.5 py-1 align-top text-slate-300', className)}>
    {children}
  </td>
);

const RequiredBadge: React.FC<{ state: DocParamRequired }> = ({ state }) => {
  if (state === 'required') {
    return <span className="text-[9px] font-medium text-amber-300">必填</span>;
  }
  if (state === 'oneOf') {
    return <span className="text-[9px] font-medium text-sky-300">二选一</span>;
  }
  return <span className="text-[9px] text-slate-500">可选</span>;
};

const ErrorCodePill: React.FC<{ code: string; onGo?: (id: string) => void }> = ({ code, onGo }) => {
  const targetId = DOC_BY_ID[code] ? code : DOC_BY_ID['constants/return-codes'] ? 'constants/return-codes' : null;
  const cls =
    'mono inline-flex items-center rounded-[2px] border border-rose-500/35 bg-rose-500/[0.06] px-1 py-[1px] text-[10px] text-rose-300';
  if (!targetId || !onGo) return <span className={cls}>{code}</span>;
  return (
    <button
      type="button"
      onClick={() => onGo(targetId)}
      className={cls + ' hover:border-rose-400/70'}
      title="查看返回码一览"
    >
      {code}
    </button>
  );
};

const BlockView: React.FC<{
  block: DocBlock;
  entryId: string;
  blockIndex: number;
  copiedKey: string | null;
  onCopy: (text: string, key: string) => void;
  onGo: (id: string) => void;
}> = ({ block, entryId, blockIndex, copiedKey, onCopy, onGo }) => {
  switch (block.kind) {
    case 'prose':
      return (
        <p className="text-[11.5px] leading-relaxed text-slate-300">
          <Inline text={block.text} />
        </p>
      );
    case 'syntax': {
      const key = entryId + ':syntax:' + blockIndex;
      return (
        <CodePanel
          code={block.code}
          caption="签名（TypeScript）"
          wrap
          copied={copiedKey === key}
          onCopy={() => onCopy(block.code, key)}
        />
      );
    }
    case 'params':
      return (
        <div>
          <SectionLabel>输入参数（Input）</SectionLabel>
          {block.rows.length === 0 ? (
            <div className="rounded-[2px] border border-white/[0.06] bg-white/[0.02] px-2 py-1.5 text-[10.5px] text-slate-500">
              无输入参数
            </div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full border-collapse text-[10.5px]">
                <thead>
                  <tr>
                    <TH className="w-36">参数</TH>
                    <TH className="w-40">类型</TH>
                    <TH className="w-12">必填</TH>
                    <TH>说明</TH>
                  </tr>
                </thead>
                <tbody>
                  {block.rows.map((row) => (
                    <tr key={row.name}>
                      <TD>
                        <span className="mono text-sky-200">{row.name}</span>
                      </TD>
                      <TD>
                        <span className="mono text-[10px] text-slate-400">
                          <Inline text={row.type} />
                        </span>
                      </TD>
                      <TD>
                        <RequiredBadge state={row.required} />
                      </TD>
                      <TD>
                        <Inline text={row.desc} />
                      </TD>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      );
    case 'returns':
      return (
        <div>
          <SectionLabel>返回值（Output）</SectionLabel>
          <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1 rounded-[2px] border border-emerald-500/20 bg-emerald-500/[0.03] px-2 py-1.5">
            <span className="mono text-[11px] text-emerald-300">
              <Inline text={block.type} />
            </span>
            {block.desc && (
              <span className="text-[10.5px] text-slate-300">
                <Inline text={block.desc} />
              </span>
            )}
          </div>
          {block.fields && block.fields.length > 0 && (
            <div className="mt-1.5 overflow-x-auto">
              <table className="w-full border-collapse text-[10.5px]">
                <thead>
                  <tr>
                    <TH className="w-36">返回字段</TH>
                    <TH className="w-48">类型</TH>
                    <TH>说明</TH>
                  </tr>
                </thead>
                <tbody>
                  {block.fields.map((row) => (
                    <tr key={row.name}>
                      <TD>
                        <span className="mono text-emerald-200">{row.name}</span>
                      </TD>
                      <TD>
                        <span className="mono text-[10px] text-slate-400">
                          <Inline text={row.type} />
                        </span>
                      </TD>
                      <TD>
                        <Inline text={row.desc} />
                      </TD>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      );
    case 'errors':
      return (
        <div>
          <SectionLabel>同步返回错误码</SectionLabel>
          <div className="overflow-x-auto">
            <table className="w-full border-collapse text-[10.5px]">
              <thead>
                <tr>
                  <TH className="w-44">错误码</TH>
                  <TH>触发条件</TH>
                </tr>
              </thead>
              <tbody>
                {block.rows.map((row) => (
                  <tr key={row.code}>
                    <TD>
                      <ErrorCodePill code={row.code} onGo={onGo} />
                    </TD>
                    <TD>
                      <Inline text={row.when} />
                    </TD>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      );
    case 'settlement':
      return (
        <div className="rounded-[2px] border border-amber-500/30 bg-amber-500/[0.05] px-2.5 py-2">
          <div className="mb-1 flex items-center gap-1.5 text-[10px] font-medium text-amber-200">
            <ShieldAlert size={11} className="shrink-0" />
            <Inline text="落账阶段失败条件（若被拒绝，可在下一 tick `Game.lastTick.rejected` 查看原因）" />
          </div>
          <ul className="list-disc space-y-0.5 pl-4 text-[10.5px] leading-relaxed text-amber-100/85">
            {block.items.map((item, idx) => (
              <li key={idx}>
                <Inline text={item} />
              </li>
            ))}
          </ul>
        </div>
      );
    case 'fields':
      return (
        <div>
          <SectionLabel>{block.title ?? '对象字段（Properties）'}</SectionLabel>
          <div className="overflow-x-auto">
            <table className="w-full border-collapse text-[10.5px]">
              <thead>
                <tr>
                  <TH className="w-36">字段</TH>
                  <TH className="w-48">类型</TH>
                  <TH>说明</TH>
                </tr>
              </thead>
              <tbody>
                {block.rows.map((row) => (
                  <tr key={row.name}>
                    <TD>
                      <span className="mono text-sky-200">{row.name}</span>
                    </TD>
                    <TD>
                      <span className="mono text-[10px] text-slate-400">
                        <Inline text={row.type} />
                      </span>
                    </TD>
                    <TD>
                      <Inline text={row.desc} />
                    </TD>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      );
    case 'methods':
      return (
        <div>
          <SectionLabel>{block.title ?? '方法一览（Methods）'}</SectionLabel>
          <div className="overflow-x-auto">
            <table className="w-full border-collapse text-[10.5px]">
              <thead>
                <tr>
                  <TH>方法</TH>
                  <TH className="w-36">返回值</TH>
                  <TH>说明</TH>
                </tr>
              </thead>
              <tbody>
                {block.rows.map((row) => {
                  const exists = !!DOC_BY_ID[row.id];
                  return (
                    <tr key={row.id}>
                      <TD>
                        {exists ? (
                          <button
                            type="button"
                            onClick={() => onGo(row.id)}
                            className="mono inline-flex items-center gap-0.5 text-left text-sky-300 hover:text-sky-100 hover:underline"
                          >
                            <span>{row.signature}</span>
                            <ArrowUpRight size={9} className="shrink-0 opacity-70" />
                          </button>
                        ) : (
                          <span className="mono text-sky-200">{row.signature}</span>
                        )}
                      </TD>
                      <TD>
                        <span className="mono text-[10px] text-emerald-300">{row.returns}</span>
                      </TD>
                      <TD>
                        <Inline text={row.desc} />
                      </TD>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      );
    case 'table':
      return (
        <div>
          {block.title && <SectionLabel>{block.title}</SectionLabel>}
          <div className="overflow-x-auto">
            <table className="w-full border-collapse text-[10.5px]">
              <thead>
                <tr>
                  {block.headers.map((h) => (
                    <TH key={h}>{h}</TH>
                  ))}
                </tr>
              </thead>
              <tbody>
                {block.rows.map((row, i) => (
                  <tr key={i}>
                    {row.map((cell, j) => (
                      <TD key={j} className={j === 0 ? 'mono text-sky-200' : undefined}>
                        <Inline text={cell} />
                      </TD>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      );
    case 'note': {
      const tone =
        block.level === 'danger'
          ? 'border-rose-500/35 bg-rose-500/[0.07] text-rose-200/90'
          : block.level === 'warn'
            ? 'border-amber-500/35 bg-amber-500/[0.07] text-amber-100/90'
            : 'border-sky-500/30 bg-sky-500/[0.06] text-sky-100/85';
      const Icon = block.level === 'info' ? Info : AlertTriangle;
      return (
        <div
          className={cx(
            'flex items-start gap-1.5 rounded-[2px] border px-2 py-1.5 text-[10.5px] leading-relaxed',
            tone,
          )}
        >
          <Icon size={11} className="mt-[2px] shrink-0 opacity-80" />
          <span>
            {block.title && <strong className="mr-1 font-semibold">{block.title}：</strong>}
            <Inline text={block.text} />
          </span>
        </div>
      );
    }
    case 'example': {
      const key = entryId + ':example:' + blockIndex;
      return (
        <CodePanel
          code={block.code}
          caption={block.caption ?? '示例'}
          copied={copiedKey === key}
          onCopy={() => onCopy(block.code, key)}
        />
      );
    }
    case 'links':
      return (
        <div className="flex flex-wrap items-center gap-1 pt-1">
          <span className="mr-1 text-[9px] uppercase tracking-[0.12em] text-slate-500">相关</span>
          {block.items.map((item) => {
            const exists = !!DOC_BY_ID[item.id];
            return (
              <button
                key={item.id}
                type="button"
                disabled={!exists}
                onClick={() => onGo(item.id)}
                className={cx(
                  'inline-flex items-center gap-0.5 rounded-[2px] border px-1.5 py-[1px] text-[10px] transition-colors',
                  exists
                    ? 'border-sky-500/30 bg-sky-500/[0.06] text-sky-200/90 hover:border-sky-400/70 hover:text-sky-100'
                    : 'cursor-not-allowed border-slate-700/60 text-slate-600',
                )}
                title={exists ? item.id : item.id + '（暂未收录）'}
              >
                {item.label}
                <ArrowUpRight size={9} className="opacity-60" />
              </button>
            );
          })}
        </div>
      );
    default:
      return null;
  }
};

const OVERVIEW_SECTIONS: Array<{
  title: string;
  desc: string;
  items: Array<{ label: string; id: string }>;
}> = [
  {
    title: '上手指南与核心机制',
    desc: '双阶段沙盒执行模型、影账校验与回执、配额限制与固定点计价规则。',
    items: [
      { label: '快速开始', id: 'guides/quickstart' },
      { label: '执行与落账机制', id: 'guides/execution' },
      { label: '配额与限制', id: 'guides/limits' },
      { label: 'ID 与坐标约定', id: 'guides/ids' },
      { label: '核心经济规则', id: 'guides/economy' },
    ],
  },
  {
    title: '全局运行时',
    desc: '跨 tick JSON 持久化存储、日志调试与模块化引入。',
    items: [
      { label: 'Memory', id: 'Memory' },
      { label: 'console', id: 'console' },
      { label: 'require', id: 'require' },
      { label: '返回码一览', id: 'constants/return-codes' },
    ],
  },
  {
    title: 'Game 根对象与回执',
    desc: '全局只读世界容器、静态配置与上回合结算回执。',
    items: [
      { label: 'Game', id: 'Game' },
      { label: 'Game.catalog', id: 'Game.catalog' },
      { label: 'Game.lastTick', id: 'Game.lastTick' },
      { label: 'Game.getObjectById', id: 'Game.getObjectById' },
      { label: 'Game.company', id: 'Game.company' },
      { label: 'Game.cpu', id: 'Game.cpu' },
    ],
  },
  {
    title: '星图、市场与央行域',
    desc: '按职责拆分的四大操作域：星图航线与土地、全星系交易所、母星央行。',
    items: [
      { label: 'Game.map', id: 'Game.map' },
      { label: 'Game.map.buyPlot', id: 'Game.map.buyPlot' },
      { label: 'Game.market', id: 'Game.market' },
      { label: 'Game.market.createOrder', id: 'Game.market.createOrder' },
      { label: 'Game.market.buyLand', id: 'Game.market.buyLand' },
      { label: 'Game.bank', id: 'Game.bank' },
    ],
  },
  {
    title: '核心实体与实例方法',
    desc: '面向对象的建造、排产、停开机、拆厂与派船操作直接挂在实体上。',
    items: [
      { label: 'Planet', id: 'Planet' },
      { label: 'Plot', id: 'Plot' },
      { label: 'Plot.build', id: 'Plot.build' },
      { label: 'Building', id: 'Building' },
      { label: 'ConstructionSite', id: 'ConstructionSite' },
      { label: 'Ship', id: 'Ship' },
      { label: 'Ship.dispatch', id: 'Ship.dispatch' },
      { label: 'Store', id: 'Store' },
    ],
  },
  {
    title: '常量、世界配置与实战',
    desc: '返回码字典、物品常量与可直接粘贴运行的闭环示例。',
    items: [
      { label: '返回码一览', id: 'constants/return-codes' },
      { label: 'MONEY_SCALE', id: 'constants/money-scale' },
      { label: 'RESOURCE_<ID>', id: 'RESOURCE_<ID>' },
      { label: '当前世界建筑与配方', id: 'constants/world-catalog' },
      { label: '开局：买地建厂', id: 'examples/open' },
      { label: '物流：地面到轨道站', id: 'examples/logistics' },
    ],
  },
];

const OverviewGrid: React.FC<{ onGo: (id: string) => void }> = ({ onGo }) => (
  <div className="mt-4 grid grid-cols-1 gap-2.5 sm:grid-cols-2">
    {OVERVIEW_SECTIONS.map((sec) => (
      <div
        key={sec.title}
        className="flex flex-col justify-between rounded-[2px] border border-[rgba(56,189,248,0.14)] bg-[#202732] p-3"
      >
        <div>
          <div className="text-[12px] font-medium text-slate-100">{sec.title}</div>
          <p className="mt-1 text-[10.5px] leading-relaxed text-slate-400">{sec.desc}</p>
        </div>
        <div className="mt-2.5 flex flex-wrap gap-1">
          {sec.items.map((it) => {
            const exists = !!DOC_BY_ID[it.id];
            return (
              <button
                key={it.id}
                type="button"
                disabled={!exists}
                onClick={() => onGo(it.id)}
                className={cx(
                  'mono inline-flex items-center gap-0.5 rounded-[2px] border px-1.5 py-[2px] text-[10px] transition-colors',
                  exists
                    ? 'border-sky-500/25 bg-[#181e27] text-sky-200/90 hover:border-sky-400/70 hover:text-sky-100'
                    : 'cursor-not-allowed border-slate-700/60 text-slate-600',
                )}
              >
                {it.label}
                <ArrowUpRight size={9} className="opacity-60" />
              </button>
            );
          })}
        </div>
      </div>
    ))}
  </div>
);

const LiveCatalogView: React.FC<{
  catalog: ProductionPack;
  copiedKey: string | null;
  onCopy: (text: string, key: string) => void;
}> = ({ catalog, copiedKey, onCopy }) => (
  <div className="mt-4 space-y-4">
    <div>
      <SectionLabel>当前世界建筑定义（{catalog.buildings.length} 种，来自实时世界配置）</SectionLabel>
      <div className="overflow-x-auto">
        <table className="w-full border-collapse text-[10.5px]">
          <thead>
            <tr>
              <TH>建筑 ID</TH>
              <TH>名称 / 耗时 / 占位</TH>
              <TH>建造成本（另加 80 × cpi 信用点）</TH>
            </tr>
          </thead>
          <tbody>
            {catalog.buildings.map((b) => (
              <tr key={b.id}>
                <TD>
                  <button
                    type="button"
                    onClick={() => onCopy(b.id, 'bldg:' + b.id)}
                    title="点击复制建筑 ID"
                    className={cx(
                      'mono text-left transition-colors',
                      copiedKey === 'bldg:' + b.id ? 'text-emerald-300' : 'text-sky-200 hover:text-sky-100',
                    )}
                  >
                    {b.id}
                  </button>
                </TD>
                <TD>
                  {b.name}（{b.build_ticks} tick · 占 {b.slots_used} 槽）
                </TD>
                <TD>
                  {b.build_cost.map((c) => `${c.qty} × ${c.item}`).join(' + ')}；待机耗电 {b.standby_power}
                </TD>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>

    <div>
      <SectionLabel>当前世界生产配方（{catalog.recipes.length} 条，来自实时世界配置）</SectionLabel>
      <div className="overflow-x-auto">
        <table className="w-full border-collapse text-[10.5px]">
          <thead>
            <tr>
              <TH>配方 ID</TH>
              <TH>所属建筑 / 周期 / 功耗 / 工资</TH>
              <TH>输入 → 输出</TH>
            </tr>
          </thead>
          <tbody>
            {catalog.recipes.map((r) => (
              <tr key={r.id}>
                <TD>
                  <button
                    type="button"
                    onClick={() => onCopy(r.id, 'rcp:' + r.id)}
                    title="点击复制配方 ID"
                    className={cx(
                      'mono text-left transition-colors',
                      copiedKey === 'rcp:' + r.id ? 'text-emerald-300' : 'text-sky-200 hover:text-sky-100',
                    )}
                  >
                    {r.id}
                  </button>
                </TD>
                <TD>
                  <span className="mono text-slate-400">{r.building_id}</span>
                  {' '}（{r.cycle_ticks}t / {r.power_cost}电 / 工资 {r.labor_cost}）
                </TD>
                <TD>
                  {r.inputs.length > 0 ? r.inputs.map((i) => `${i.qty} ${i.item}`).join(' + ') : '无原料'}
                  {' → '}
                  {r.outputs.map((o) => `${o.qty} ${o.item}`).join(' + ')}
                </TD>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  </div>
);

const ResourceChips: React.FC<{
  items: Array<{ id: string; name: string }>;
  onCopy: (text: string, key: string) => void;
  copiedKey: string | null;
}> = ({ items, onCopy, copiedKey }) => (
  <div className="mt-4">
    <div className="mb-1.5 text-[9.5px] uppercase tracking-[0.1em] text-slate-400">
      当前世界的物品常量（{items.length}）
    </div>
    <div className="flex flex-wrap gap-1">
      {items.map((item) => {
        const constant = 'RESOURCE_' + item.id.toUpperCase();
        const valid = /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(constant);
        const key = 'res:' + item.id;
        return (
          <button
            key={item.id}
            type="button"
            onClick={() => onCopy(valid ? constant : `globalThis["${constant}"]`, key)}
            title={
              valid
                ? `${constant} = "${item.id}"（点击复制）`
                : `${constant} 不是合法 JS 标识符，点击复制 globalThis["${constant}"]`
            }
            className={cx(
              'inline-flex items-center gap-1 rounded-[2px] border px-1.5 py-[2px] text-[9.5px] transition-colors',
              copiedKey === key
                ? 'border-emerald-400/60 bg-emerald-500/10'
                : valid
                  ? 'border-slate-700/70 bg-[#181e27] text-slate-400 hover:border-sky-400/60 hover:text-sky-200'
                  : 'border-amber-500/40 bg-[#181e27] text-amber-200/80 hover:border-amber-400/70',
            )}
          >
            <span className="mono">{constant}</span>
            <span className="text-slate-500">{item.name}</span>
          </button>
        );
      })}
    </div>
  </div>
);

export const DocView: React.FC<DocViewProps> = ({ variant, docId, onNavigate, items, catalog, className }) => {
  const page = variant === 'page';
  const entry: DocEntry = findEntry(docId) ?? (findEntry(DEFAULT_DOC_ID) as DocEntry);
  const groups = useMemo(() => docGroups(), []);
  const [query, setQuery] = useState('');
  const [navOpen, setNavOpen] = useState(true);
  const [activeHit, setActiveHit] = useState(0);
  const [copiedKey, setCopiedKey] = useState<string | null>(null);
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const activeNavRef = useRef<HTMLButtonElement | null>(null);
  const results = useMemo(() => (query.trim() ? searchDocs(query) : []), [query]);

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: 0 });
  }, [entry.id]);

  useEffect(() => {
    setActiveHit(0);
  }, [query]);

  useEffect(() => {
    activeNavRef.current?.scrollIntoView({ block: 'nearest' });
  }, [entry.id, navOpen]);

  const onCopy = useCallback((text: string, key: string) => {
    const remember = () => {
      setCopiedKey(key);
      window.setTimeout(() => setCopiedKey((cur) => (cur === key ? null : cur)), 1300);
    };
    if (navigator.clipboard && window.isSecureContext) {
      navigator.clipboard.writeText(text).then(remember, () => fallbackCopy(text, remember));
      return;
    }
    fallbackCopy(text, remember);
  }, []);

  const go = useCallback(
    (id: string) => {
      setQuery('');
      onNavigate(id);
    },
    [onNavigate],
  );

  const onSearchKey = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Escape') {
      setQuery('');
      return;
    }
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setActiveHit((i) => Math.min(i + 1, Math.max(results.length - 1, 0)));
      return;
    }
    if (e.key === 'ArrowUp') {
      e.preventDefault();
      setActiveHit((i) => Math.max(i - 1, 0));
      return;
    }
    if (e.key === 'Enter') {
      const hit = results[activeHit];
      if (hit) go(hit.id);
    }
  };

  const navWidth = page ? 'w-[240px]' : 'w-[164px]';

  return (
    <div
      className={cx(
        'docs-print-root flex h-full min-h-0 w-full text-slate-200',
        page ? 'bg-[#161b22]' : 'bg-[#1e242d]',
        className,
      )}
    >
      {navOpen && (
        <nav
          className={cx(
            'docs-nav flex shrink-0 flex-col border-r border-[rgba(56,189,248,0.14)] bg-[#202732]',
            navWidth,
          )}
        >
          <div className="shrink-0 border-b border-white/[0.06] p-1.5">
            <div className="flex items-center gap-1 rounded-[2px] border border-slate-700/70 bg-[#181e27] px-1.5 py-[3px] focus-within:border-sky-400/60">
              <Search size={11} className="shrink-0 text-sky-400/80" />
              <input
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                onKeyDown={onSearchKey}
                placeholder="搜索 API / 字段 / 错误码…"
                spellCheck={false}
                className="min-w-0 flex-1 bg-transparent text-[10.5px] text-slate-100 outline-none placeholder:text-slate-600"
              />
              {query && (
                <button
                  type="button"
                  onClick={() => setQuery('')}
                  className="text-slate-500 hover:text-slate-200"
                  title="清空"
                >
                  <X size={10} />
                </button>
              )}
            </div>
          </div>

          <div className="min-h-0 flex-1 overflow-y-auto py-1">
            {query.trim() ? (
              results.length === 0 ? (
                <div className="px-2 py-3 text-[10px] text-slate-600">没有匹配的条目</div>
              ) : (
                results.map((hit, i) => (
                  <button
                    key={hit.id}
                    type="button"
                    onClick={() => go(hit.id)}
                    onMouseEnter={() => setActiveHit(i)}
                    className={cx(
                      'block w-full px-2 py-[3px] text-left text-[10.5px] leading-tight',
                      i === activeHit ? 'bg-sky-500/15 text-sky-200' : 'text-slate-400 hover:bg-white/[0.03]',
                    )}
                  >
                    <span className="block truncate">{hit.title}</span>
                    <span className="mono block truncate text-[8.5px] text-slate-600">{hit.id}</span>
                  </button>
                ))
              )
            ) : (
              groups.map((group) => (
                <div key={group.group} className="mb-1.5">
                  <div className="px-2 pb-[2px] pt-1 text-[8.5px] font-medium uppercase tracking-[0.14em] text-slate-500">
                    {group.group}
                  </div>
                  {group.entries.map((e) => {
                    const active = e.id === entry.id;
                    return (
                      <button
                        key={e.id}
                        type="button"
                        ref={active ? activeNavRef : undefined}
                        onClick={() => go(e.id)}
                        title={e.id}
                        style={{ paddingLeft: e.parent ? 18 : 8 }}
                        className={cx(
                          'block w-full border-l-2 py-[2.5px] pr-1.5 text-left text-[10.5px] leading-tight transition-colors',
                          active
                            ? 'border-sky-400 bg-sky-500/10 text-sky-200'
                            : 'border-transparent text-slate-400 hover:bg-white/[0.03] hover:text-slate-200',
                        )}
                      >
                        <span className="block truncate">{e.title}</span>
                      </button>
                    );
                  })}
                </div>
              ))
            )}
          </div>

          <div className="shrink-0 border-t border-white/[0.05] px-2 py-1.5 text-[8.5px] leading-relaxed text-slate-600">
            <div className="mono">{DOC_VERSION}</div>
            <div className="truncate">Meridian 脚本接口参考</div>
          </div>
        </nav>
      )}

      <div className="flex min-w-0 flex-1 flex-col">
        {!page && (
          <div className="docs-pane-bar flex shrink-0 items-center gap-2 border-b border-white/[0.06] bg-[#232a36] px-2 py-1">
            <button
              type="button"
              onClick={() => setNavOpen((v) => !v)}
              className="inline-flex items-center gap-1 rounded-[2px] border border-slate-600/70 bg-[#181e27] px-1.5 py-[1px] text-[9px] text-slate-300 hover:border-sky-400/60 hover:text-sky-200"
              title={navOpen ? '收起目录' : '展开目录'}
            >
              <List size={10} />
              目录
            </button>
            <span className="inline-flex min-w-0 items-center gap-1 text-[10px] text-slate-500">
              <BookOpen size={11} className="shrink-0 text-sky-400/70" />
              <span className="truncate">脚本 API 参考</span>
            </span>
            <a
              href={'/docs/#' + encodeURIComponent(entry.id)}
              target="_blank"
              rel="noreferrer"
              className="ml-auto inline-flex items-center gap-0.5 text-[9px] text-slate-500 hover:text-sky-300"
              title="在独立网页版中打开当前条目"
            >
              网页版
              <ArrowUpRight size={9} />
            </a>
          </div>
        )}

        <div ref={scrollRef} className="docs-print-content min-h-0 flex-1 overflow-y-auto">
          <div className={page ? 'mx-auto w-full max-w-[880px] px-6 py-7' : 'px-3 py-2.5'}>
            <div className="mono flex items-center gap-1 text-[9px] text-slate-500">
              <span>{entry.group}</span>
              {entry.parent && (
                <>
                  <ChevronRight size={9} />
                  <button
                    type="button"
                    onClick={() => go(entry.parent!)}
                    className="hover:text-sky-300"
                  >
                    {entry.parent}
                  </button>
                </>
              )}
              <ChevronRight size={9} />
              <span className="text-slate-600">{entry.kind}</span>
            </div>
            <h1 className={cx('mt-1 font-medium text-slate-100', page ? 'text-[20px]' : 'text-[15px]')}>
              {entry.title}
            </h1>
            <div className="mono mt-0.5 text-[9.5px] text-sky-400/80">{entry.id}</div>
            <p className="mt-2 text-[11px] leading-relaxed text-slate-400">
              <Inline text={entry.summary} />
            </p>

            <div className={cx('space-y-3', page ? 'mt-5' : 'mt-3')}>
              {entry.blocks.map((block, i) => (
                <BlockView
                  key={i}
                  block={block}
                  entryId={entry.id}
                  blockIndex={i}
                  copiedKey={copiedKey}
                  onCopy={onCopy}
                  onGo={go}
                />
              ))}

              {entry.id === 'guides/overview' && <OverviewGrid onGo={go} />}

              {entry.id === 'constants/world-catalog' && catalog && (
                <LiveCatalogView catalog={catalog} copiedKey={copiedKey} onCopy={onCopy} />
              )}

              {entry.id === 'RESOURCE_<ID>' && (catalog?.items || items) && (
                <ResourceChips
                  items={(catalog?.items ?? items ?? []).map((it) => ({ id: it.id, name: it.name }))}
                  onCopy={onCopy}
                  copiedKey={copiedKey}
                />
              )}
            </div>

            <div className="mt-6 flex flex-wrap items-center justify-between gap-2 border-t border-white/[0.05] pt-2 text-[8.5px] text-slate-600">
              <span className="mono">{DOC_VERSION}</span>
              <span>Meridian 脚本 API 参考</span>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
};

function fallbackCopy(text: string, done: () => void): void {
  try {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.setAttribute('readonly', '');
    ta.style.position = 'fixed';
    ta.style.top = '-1000px';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    document.execCommand('copy');
    document.body.removeChild(ta);
  } catch {
    /* 剪贴板不可用时静默失败，用户仍可手动选中复制 */
  }
  done();
}

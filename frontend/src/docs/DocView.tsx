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
  X,
} from 'lucide-react';
import {
  DEFAULT_DOC_ID,
  DOC_BY_ID,
  DOC_SOURCE,
  DOC_VERSION,
  docGroups,
  findEntry,
  searchDocs,
} from './apiDocs';
import type { DocBlock, DocEntry } from './types';

export interface DocViewProps {
  variant: 'pane' | 'page';
  docId?: string;
  onNavigate: (id: string) => void;
  /** 当前世界的物品表，用于渲染 RESOURCE_<ID> 的动态常量清单。 */
  items?: Array<{ id: string; name: string }>;
  className?: string;
}

const cx = (...parts: Array<string | false | null | undefined>): string =>
  parts.filter(Boolean).join(' ');

/** 只处理行内代码与加粗，避免为了一页文档引入 markdown 依赖。 */
const Inline: React.FC<{ text: string }> = ({ text }) => {
  const parts = text.split(/(\u0060[^\u0060]+\u0060|\*\*[^*]+\*\*)/g);
  return (
    <>
      {parts.map((part, i) => {
        if (part.length > 2 && part.startsWith('\u0060') && part.endsWith('\u0060')) {
          return (
            <code
              key={i}
              className="mono rounded-[2px] border border-sky-500/20 bg-[#070b11] px-1 py-[1px] text-[10.5px] text-sky-200/90"
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
  <div className="overflow-hidden rounded-[2px] border border-sky-500/20 bg-[#070b11]">
    <div className="flex items-center justify-between gap-2 border-b border-sky-500/10 bg-[#0e141c] px-2 py-[3px]">
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

const ErrorCode: React.FC<{ code: string; onGo?: (id: string) => void }> = ({ code, onGo }) => {
  const exists = !!DOC_BY_ID[code];
  const cls =
    'mono inline-flex items-center rounded-[2px] border border-rose-500/35 bg-rose-500/[0.06] px-1 py-[1px] text-[10px] text-rose-300';
  if (!exists || !onGo) return <span className={cls}>{code}</span>;
  return (
    <button type="button" onClick={() => onGo(code)} className={cls + ' hover:border-rose-400/70'}>
      {code}
    </button>
  );
};

const BlockView: React.FC<{
  block: DocBlock;
  entryId: string;
  copiedKey: string | null;
  onCopy: (text: string, key: string) => void;
  onGo: (id: string) => void;
}> = ({ block, entryId, copiedKey, onCopy, onGo }) => {
  switch (block.kind) {
    case 'prose':
      return (
        <p className="text-[11.5px] leading-relaxed text-slate-300">
          <Inline text={block.text} />
        </p>
      );
    case 'syntax': {
      const key = entryId + ':syntax';
      return (
        <CodePanel
          code={block.code}
          caption="签名"
          wrap
          copied={copiedKey === key}
          onCopy={() => onCopy(block.code, key)}
        />
      );
    }
    case 'params':
      return (
        <div className="overflow-x-auto">
          <table className="w-full border-collapse text-[10.5px]">
            <thead>
              <tr>
                <TH>参数</TH>
                <TH>类型</TH>
                <TH className="w-10">必填</TH>
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
                    {row.required ? (
                      <span className="text-[9px] text-amber-300">必填</span>
                    ) : (
                      <span className="text-[9px] text-slate-600">可选</span>
                    )}
                  </TD>
                  <TD>
                    <Inline text={row.desc} />
                  </TD>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      );
    case 'returns':
      return (
        <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1 rounded-[2px] border border-white/[0.06] bg-white/[0.02] px-2 py-1.5">
          <span className="text-[9px] uppercase tracking-[0.12em] text-slate-500">返回值</span>
          <span className="mono text-[11px] text-emerald-300">
            <Inline text={block.type} />
          </span>
          {block.desc && (
            <span className="text-[10px] text-slate-400">
              <Inline text={block.desc} />
            </span>
          )}
        </div>
      );
    case 'errors':
      return (
        <div>
          <div className="mb-1 text-[9px] uppercase tracking-[0.12em] text-slate-500">可能返回</div>
          <div className="overflow-x-auto">
            <table className="w-full border-collapse text-[10.5px]">
              <thead>
                <tr>
                  <TH className="w-32">错误码</TH>
                  <TH>触发条件</TH>
                </tr>
              </thead>
              <tbody>
                {block.rows.map((row) => (
                  <tr key={row.code}>
                    <TD>
                      <ErrorCode code={row.code} onGo={onGo} />
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
    case 'fields':
      return (
        <div className="overflow-x-auto">
          <table className="w-full border-collapse text-[10.5px]">
            <thead>
              <tr>
                <TH className="w-36">字段</TH>
                <TH className="w-44">类型</TH>
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
      );
    case 'table':
      return (
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
                      {cell}
                    </TD>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
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
        <div className={cx('flex items-start gap-1.5 rounded-[2px] border px-2 py-1.5 text-[10.5px] leading-relaxed', tone)}>
          <Icon size={11} className="mt-[2px] shrink-0 opacity-80" />
          <span>
            <Inline text={block.text} />
          </span>
        </div>
      );
    }
    case 'example': {
      const key = entryId + ':example:' + (block.caption ?? '') + ':' + block.code.length;
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
        <div className="flex flex-wrap items-center gap-1">
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
                title={exists ? item.id : item.id + '（文档暂未收录）'}
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

const ResourceChips: React.FC<{
  items: Array<{ id: string; name: string }>;
  onCopy: (text: string, key: string) => void;
  copiedKey: string | null;
}> = ({ items, onCopy, copiedKey }) => (
  <div className="mt-4">
    <div className="mb-1.5 text-[9px] uppercase tracking-[0.12em] text-slate-500">
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
            onClick={() => onCopy(constant, key)}
            title={
              valid
                ? constant + ' = "' + item.id + '"（点击复制）'
                : constant + ' 不是合法 JS 标识符，需用 globalThis["' + constant + '"]'
            }
            className={cx(
              'inline-flex items-center gap-1 rounded-[2px] border px-1 py-[1px] text-[9px] transition-colors',
              copiedKey === key
                ? 'border-emerald-400/60 bg-emerald-500/10'
                : valid
                  ? 'border-slate-700/70 text-slate-400 hover:border-sky-400/60 hover:text-sky-200'
                  : 'border-amber-500/40 text-amber-200/80 hover:border-amber-400/70',
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

export const DocView: React.FC<DocViewProps> = ({ variant, docId, onNavigate, items, className }) => {
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

  const navWidth = page ? 'w-[240px]' : 'w-[156px]';

  return (
    <div className={cx('docs-print-root flex h-full min-h-0 w-full bg-[#0b1017] text-slate-200', className)}>
      {navOpen && (
        <nav
          className={cx(
            'docs-nav flex shrink-0 flex-col border-r border-[rgba(56,189,248,0.16)] bg-[#0e141c]',
            navWidth,
          )}
        >
          <div className="shrink-0 border-b border-white/[0.05] p-1.5">
            <div className="flex items-center gap-1 rounded-[2px] border border-slate-700/70 bg-[#070b11] px-1.5 py-[3px] focus-within:border-sky-400/60">
              <Search size={11} className="shrink-0 text-sky-400/80" />
              <input
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                onKeyDown={onSearchKey}
                placeholder="搜索 API…"
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
                <div key={group.group} className="mb-1">
                  <div className="px-2 pb-[2px] pt-1 text-[8.5px] uppercase tracking-[0.16em] text-slate-600">
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
            <div className="truncate" title={'同步自 ' + DOC_SOURCE}>
              同步自 {DOC_SOURCE}
            </div>
          </div>
        </nav>
      )}

      <div className="flex min-w-0 flex-1 flex-col">
        {!page && (
          <div className="docs-pane-bar flex shrink-0 items-center gap-2 border-b border-white/[0.06] bg-[#0e141c] px-2 py-1">
            <button
              type="button"
              onClick={() => setNavOpen((v) => !v)}
              className="inline-flex items-center gap-1 rounded-[2px] border border-slate-700/70 px-1.5 py-[1px] text-[9px] text-slate-400 hover:border-sky-400/60 hover:text-sky-200"
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
                  <span>{entry.parent}</span>
                </>
              )}
              <ChevronRight size={9} />
              <span className="text-slate-600">{entry.kind}</span>
            </div>
            <h1 className={cx('mt-1 font-medium text-slate-100', page ? 'text-[20px]' : 'text-[15px]')}>
              {entry.title}
            </h1>
            <div className="mono mt-0.5 text-[9.5px] text-sky-400/80">{entry.id}</div>
            <p className="mt-2 text-[11px] leading-relaxed text-slate-400">{entry.summary}</p>

            <div className={cx('space-y-3', page ? 'mt-5' : 'mt-3')}>
              {entry.blocks.map((block, i) => (
                <BlockView
                  key={i}
                  block={block}
                  entryId={entry.id}
                  copiedKey={copiedKey}
                  onCopy={onCopy}
                  onGo={go}
                />
              ))}

              {entry.id === 'RESOURCE_<ID>' && items && items.length > 0 && (
                <ResourceChips items={items} onCopy={onCopy} copiedKey={copiedKey} />
              )}
            </div>

            <div className="mt-6 flex flex-wrap items-center justify-between gap-2 border-t border-white/[0.05] pt-2 text-[8.5px] text-slate-600">
              <span className="mono">
                {DOC_VERSION} · {DOC_SOURCE}
              </span>
              <span>发现文档与代码不一致？以代码为准，并反馈到 docs/PROTOCOL.md。</span>
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

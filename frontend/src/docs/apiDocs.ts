import type { DocBlock, DocEntry, DocGroup } from './types';
import { DOC_GROUP_ORDER } from './types';
import { GUIDE_ENTRIES } from './data/guides';
import { RUNTIME_ENTRIES } from './data/runtime';
import { GAME_ENTRIES } from './data/game';
import { MARKET_ENTRIES } from './data/market';
import { ENTITY_ENTRIES } from './data/entities';
import { CONSTANT_ENTRIES } from './data/constants';
import { EXAMPLE_ENTRIES } from './data/examples';

/** 将 Game.market 子条目紧跟在 Game.market 后面，确保目录缩进层级正确。 */
function withMarketInGame(): DocEntry[] {
  return [...GAME_ENTRIES, ...MARKET_ENTRIES];
}

export const DOC_ENTRIES: DocEntry[] = [
  ...GUIDE_ENTRIES,
  ...RUNTIME_ENTRIES,
  ...withMarketInGame(),
  ...ENTITY_ENTRIES,
  ...CONSTANT_ENTRIES,
  ...EXAMPLE_ENTRIES,
];

export const DOC_BY_ID: Record<string, DocEntry> = DOC_ENTRIES.reduce(
  (acc, entry) => {
    acc[entry.id] = entry;
    return acc;
  },
  {} as Record<string, DocEntry>,
);

/** 兼容旧版保存布局与 URL 锚点的别名映射。 */
const LEGACY_DOC_ALIASES: Record<string, string> = {
  'overview/quickstart': 'guides/quickstart',
  'overview/execution': 'guides/execution',
  execution: 'guides/execution',
  'overview/limits': 'guides/limits',
  quotas: 'guides/limits',
  'overview/ids': 'guides/ids',
  'error-matrix': 'constants/return-codes',
  OK: 'constants/return-codes',
  ERR_NOT_OWNER: 'constants/return-codes',
  ERR_NO_PATH: 'constants/return-codes',
  ERR_BUSY: 'constants/return-codes',
  ERR_NOT_FOUND: 'constants/return-codes',
  ERR_NOT_ENOUGH_RESOURCES: 'constants/return-codes',
  ERR_INVALID_TARGET: 'constants/return-codes',
  ERR_FULL: 'constants/return-codes',
  ERR_NOT_IN_RANGE: 'constants/return-codes',
  ERR_INVALID_ARGS: 'constants/return-codes',
  ERR_NOT_ENOUGH_CREDITS: 'constants/return-codes',
  ORDER_BUY: 'constants/order-sides',
  ORDER_SELL: 'constants/order-sides',
  'example-open': 'examples/open',
  'example-quote': 'examples/quote',
  'example-restock': 'examples/restock',
  'example-logistics': 'examples/logistics',
};

export const DEFAULT_DOC_ID = 'guides/quickstart';

export function findEntry(id: string | undefined | null): DocEntry | null {
  if (!id) return null;
  const resolved = LEGACY_DOC_ALIASES[id] ?? id;
  return DOC_BY_ID[resolved] ?? null;
}

/** 纯函数：供窗口标题、目录与独立页标题复用。 */
export function docTitle(id: string | undefined | null): string {
  const entry = findEntry(id);
  return entry ? entry.title : 'API 参考';
}

export interface DocNavGroup {
  group: DocGroup;
  entries: DocEntry[];
}

export function docGroups(): DocNavGroup[] {
  return DOC_GROUP_ORDER.map((group) => ({
    group,
    entries: DOC_ENTRIES.filter((e) => e.group === group),
  })).filter((g) => g.entries.length > 0);
}

function extractBlockText(block: DocBlock): string {
  switch (block.kind) {
    case 'prose':
    case 'note':
      return block.text;
    case 'syntax':
      return block.code;
    case 'params':
      return block.rows.map((r) => `${r.name} ${r.type} ${r.desc}`).join(' ');
    case 'returns':
      return `${block.type} ${block.desc ?? ''} ${(block.fields ?? []).map((f) => `${f.name} ${f.type} ${f.desc}`).join(' ')}`;
    case 'errors':
      return block.rows.map((r) => `${r.code} ${r.when}`).join(' ');
    case 'settlement':
      return block.items.join(' ');
    case 'fields':
      return block.rows.map((r) => `${r.name} ${r.type} ${r.desc}`).join(' ');
    case 'methods':
      return block.rows.map((r) => `${r.signature} ${r.returns} ${r.desc}`).join(' ');
    case 'table':
      return block.rows.map((r) => r.join(' ')).join(' ');
    case 'example':
      return `${block.caption ?? ''} ${block.code}`;
    case 'links':
      return block.items.map((i) => i.label).join(' ');
    default:
      return '';
  }
}

const SEARCH_INDEX = DOC_ENTRIES.map((entry) => ({
  entry,
  title: entry.title.toLowerCase(),
  id: entry.id.toLowerCase(),
  keywords: (entry.keywords ?? '').toLowerCase(),
  summary: entry.summary.toLowerCase(),
  body: entry.blocks.map(extractBlockText).join(' ').toLowerCase(),
}));

export function searchDocs(query: string, limit = 40): DocEntry[] {
  const q = query.trim().toLowerCase();
  if (!q) return [];
  const terms = q.split(/\s+/).filter(Boolean);
  const hits: Array<{ entry: DocEntry; score: number }> = [];
  for (const item of SEARCH_INDEX) {
    const hay = `${item.title} ${item.id} ${item.keywords} ${item.summary} ${item.entry.group} ${item.body}`;
    let score = 0;
    let ok = true;
    for (const term of terms) {
      if (!hay.includes(term)) {
        ok = false;
        break;
      }
      if (item.title.includes(term)) score += 8;
      if (item.id.includes(term)) score += 5;
      if (item.keywords.includes(term)) score += 3;
      if (item.summary.includes(term)) score += 2;
      if (item.body.includes(term)) score += 1;
    }
    if (ok) hits.push({ entry: item.entry, score });
  }
  return hits
    .sort((a, b) => b.score - a.score || a.entry.id.localeCompare(b.entry.id))
    .slice(0, limit)
    .map((h) => h.entry);
}

export const DOC_VERSION = 'API v1 · 2026-11-25';

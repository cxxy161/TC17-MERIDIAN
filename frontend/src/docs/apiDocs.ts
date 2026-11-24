import type { DocEntry, DocGroup } from './types';
import { DOC_GROUP_ORDER } from './types';
import { OVERVIEW_ENTRIES } from './data/overview';
import { CONSTANT_ENTRIES } from './data/constants';
import { GAME_ENTRIES } from './data/game';
import { MARKET_ENTRIES } from './data/market';
import { ENTITY_ENTRIES } from './data/entities';
import { RUNTIME_ENTRIES } from './data/runtime';
import { EXAMPLE_ENTRIES } from './data/examples';
import { ERROR_ENTRIES } from './data/errors';

/** 市场条目必须紧跟在 Game.market 后面，TOC 的缩进层级才不会错位。 */
function withMarketAfterGame(): DocEntry[] {
  const out = [...GAME_ENTRIES];
  const at = out.findIndex((e) => e.id === 'Game.market');
  out.splice(at < 0 ? out.length : at + 1, 0, ...MARKET_ENTRIES);
  return out;
}

export const DOC_ENTRIES: DocEntry[] = [
  ...OVERVIEW_ENTRIES,
  ...CONSTANT_ENTRIES,
  ...withMarketAfterGame(),
  ...ENTITY_ENTRIES,
  ...RUNTIME_ENTRIES,
  ...EXAMPLE_ENTRIES,
  ...ERROR_ENTRIES,
];

export const DOC_BY_ID: Record<string, DocEntry> = DOC_ENTRIES.reduce(
  (acc, entry) => {
    acc[entry.id] = entry;
    return acc;
  },
  {} as Record<string, DocEntry>,
);

export const DEFAULT_DOC_ID = 'overview/quickstart';

export function findEntry(id: string | undefined | null): DocEntry | null {
  if (!id) return null;
  return DOC_BY_ID[id] ?? null;
}

/** 纯函数：窗口标题、TOC、独立页标题都靠它，不能依赖 React 或 store。 */
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

/**
 * 中文没有空格分词，用「子串 + 标题/ID 加权」比引入 lunr 更准，也不需要新依赖。
 */
export function searchDocs(query: string, limit = 40): DocEntry[] {
  const q = query.trim().toLowerCase();
  if (!q) return [];
  const terms = q.split(/\s+/).filter(Boolean);
  const hits: Array<{ entry: DocEntry; score: number }> = [];
  for (const entry of DOC_ENTRIES) {
    const title = entry.title.toLowerCase();
    const id = entry.id.toLowerCase();
    const summary = entry.summary.toLowerCase();
    const keywords = (entry.keywords ?? '').toLowerCase();
    const hay = title + ' ' + id + ' ' + summary + ' ' + keywords + ' ' + entry.group;
    let score = 0;
    let ok = true;
    for (const term of terms) {
      if (!hay.includes(term)) {
        ok = false;
        break;
      }
      if (title.includes(term)) score += 6;
      if (id.includes(term)) score += 4;
      if (keywords.includes(term)) score += 2;
      if (summary.includes(term)) score += 1;
    }
    if (ok) hits.push({ entry, score });
  }
  return hits
    .sort((a, b) => b.score - a.score || a.entry.id.localeCompare(b.entry.id))
    .slice(0, limit)
    .map((h) => h.entry);
}

/** 数据源版本，显示在两栏底部，提醒玩家文档与代码的对应关系。 */
export const DOC_SOURCE = 'prelude.js · js_runner.rs';
export const DOC_VERSION = 'API v1 · 2026-11-23';

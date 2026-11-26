#!/usr/bin/env node
/**
 * API 文档漂移与规范守卫（无依赖，node scripts/check-api-docs.mjs 即可跑）。
 *
 * 依据 docs/API_DOCS_SPEC.md 强制校验：
 *  1. 条目 id 唯一，所有 links / parent / methods[].id 无悬空引用；
 *  2. 6 个分组均存在条目，无残留 § 占位符；
 *  3. js_runner.rs 中注册的 __meridian_* 宿主函数全部有对应文档条目；
 *  4. 所有 kind === '方法' 的条目必须同时包含 syntax、params、returns；返回 RetCode 的写方法必须包含 errors；
 *  5. fields 块一行仅一个字段（禁止 /、() 或空格），且禁止在 syntax 中混用 → 箭头伪代码；
 *  6. 禁止面向玩家的文档文案出现内部黑名单术语，且示例代码中的物品/建筑/配方字符串须与 production.json 对齐。
 */
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const dataDir = join(root, 'frontend/src/docs/data');
const problems = [];

const files = readdirSync(dataDir)
  .filter((f) => f.endsWith('.ts'))
  .sort();
const sources = files.map((file) => ({
  file,
  src: readFileSync(join(dataDir, file), 'utf8'),
}));

const catalog = JSON.parse(readFileSync(join(root, 'data/production.json'), 'utf8'));
const validItems = new Set(catalog.items.map((x) => x.id));
const validBuildings = new Set(catalog.buildings.map((x) => x.id));
const validRecipes = new Set(catalog.recipes.map((x) => x.id));

const FORBIDDEN_TERMS = [
  'prelude.js',
  'js_runner.rs',
  'world.rs',
  'PROTOCOL.md',
  'run_error',
  '旧文档',
  '已知缺口',
  '盲盒式',
  'QuickJS Runtime',
  'SQLite WAL',
  '跨 FFI',
];

const entries = new Map();
const groups = new Map();

for (const { file, src } of sources) {
  if (src.includes('\u00a7')) {
    problems.push(`${file}: 残留 § 占位符`);
  }
  for (const term of FORBIDDEN_TERMS) {
    if (src.includes(term)) {
      problems.push(`${file}: 含有禁止面向玩家暴露的内部词 "${term}"`);
    }
  }

  // 解析每个顶层 DocEntry 块
  const entryMatches = [
    ...src.matchAll(
      /\n  \{\s*\n\s*id:\s*'([^']+)',\s*\n\s*title:\s*'([^']+)',\s*\n\s*group:\s*'([^']+)',(?:\s*\n\s*parent:\s*'([^']+)',)?\s*\n\s*kind:\s*'([^']+)',\s*\n\s*summary:\s*'([^']+)'/g,
    ),
  ];

  for (let i = 0; i < entryMatches.length; i++) {
    const m = entryMatches[i];
    const [, id, title, group, parent, kind, summary] = m;
    const start = m.index;
    const end = i + 1 < entryMatches.length ? entryMatches[i + 1].index : src.length;
    const chunk = src.slice(start, end);

    if (entries.has(id)) problems.push(`重复条目 id: ${id}`);
    entries.set(id, { id, title, group, parent, kind, summary, file, chunk });
    groups.set(group, (groups.get(group) ?? 0) + 1);

    if (summary.endsWith('。')) {
      problems.push(`${file} (${id}): summary 末尾不应带句号`);
    }

    const blockKinds = [...chunk.matchAll(/kind:\s*'([a-z]+)'/g)].map((x) => x[1]);
    if (kind === '方法') {
      for (const req of ['syntax', 'params', 'returns']) {
        if (!blockKinds.includes(req)) {
          problems.push(`${file} (${id}): 方法条目缺少必填区块 kind: '${req}'`);
        }
      }
      if (chunk.includes(': RetCode') && !blockKinds.includes('errors')) {
        problems.push(`${file} (${id}): 返回 RetCode 的写方法缺少 errors 区块`);
      }
      if (chunk.includes(': RetCode') && !blockKinds.includes('settlement')) {
        problems.push(`${file} (${id}): 返回 RetCode 的写方法缺少 settlement（落账阶段失败条件）区块`);
      }
    }

    // 检查 syntax 是否混用箭头伪代码
    const syntaxMatch = chunk.match(/kind:\s*'syntax',\s*\n\s*code:\s*(['"`])([\s\S]*?)\1/);
    if (syntaxMatch && syntaxMatch[2].includes('→')) {
      problems.push(`${file} (${id}): syntax 签名禁止使用 → 箭头伪代码，请使用标准 TS 冒号语法`);
    }

    // 检查 fields 块：一行只能有一个字段（不含 /、()、空格）
    for (const fm of chunk.matchAll(/kind:\s*'fields'[\s\S]*?rows:\s*\[([\s\S]*?)\n\s*\],/g)) {
      for (const nm of fm[1].matchAll(/\{\s*name:\s*'([^']+)'/g)) {
        const fname = nm[1];
        if (/[\s/()]/.test(fname)) {
          problems.push(`${file} (${id}): fields 字段名 "${fname}" 违规（禁止合并字段或放入方法/空格）`);
        }
      }
    }
  }
}

// 检查引用完整性（links、parent、methods[].id）
let linkCount = 0;
for (const { file, src } of sources) {
  for (const m of src.matchAll(/\{ label: '[^']*', id: '([^']+)' \}/g)) {
    linkCount += 1;
    if (!entries.has(m[1])) problems.push(`${file}: 悬空 links -> ${m[1]}`);
  }
  for (const m of src.matchAll(/\n\s*parent:\s*'([^']+)',/g)) {
    if (!entries.has(m[1])) problems.push(`${file}: 悬空 parent -> ${m[1]}`);
  }
  for (const m of src.matchAll(/signature:\s*'[^']+',[\s\S]*?id:\s*'([^']+)'/g)) {
    if (!entries.has(m[1])) problems.push(`${file}: 悬空 methods[].id -> ${m[1]}`);
  }
}

// 检查宿主函数映射
const expected = new Map([
  ['log', 'console.log'],
  ['cpu_used', 'Game.cpu.getUsed'],
  ['get_module', 'require'],
  ['get_catalog', 'Game.catalog'],
  ['quote', 'Game.market.quote'],
  ['depth', 'Game.market.depth'],
  ['get_all_orders', 'Game.market.getAllOrders'],
  ['get_order_by_id', 'Game.market.getOrderById'],
  ['calc_route', 'Game.map.calcRoute'],
  ['get_land_plots', 'Game.map.getLandPlots'],
  ['list_companies', 'Game.map.listCompanies'],
  ['get_company', 'Game.map.getCompany'],
  ['set_recipe', 'Building.setRecipe'],
  ['set_active', 'Building.setActive'],
  ['dispatch_ship', 'Ship.dispatch'],
  ['repair_ship', 'Ship.repair'],
  ['create_order', 'Game.market.createOrder'],
  ['cancel_order', 'Game.market.cancelOrder'],
  ['deal_order', 'Game.market.deal'],
  ['buy_plot', 'Game.map.buyPlot'],
  ['build_facility', 'Plot.build'],
  ['demolish_facility', 'Building.demolish'],
  ['bank', 'Game.bank'],
]);

const jsRunner = readFileSync(join(root, 'backend/crates/meridian-sandbox/src/js_runner.rs'), 'utf8');
const hosts = new Set(
  Array.from(jsRunner.matchAll(/__meridian_([a-z_]+)/g), (m) => m[1]).filter(
    (h) => h !== 'run_tick' && h !== 'eval_console',
  ),
);
for (const host of hosts) {
  if (!expected.has(host)) problems.push('新增宿主函数未登记到守卫: __meridian_' + host);
}
for (const [host, docId] of expected) {
  if (!hosts.has(host)) problems.push('守卫登记的宿主函数已不存在: __meridian_' + host);
  if (!entries.has(docId)) problems.push(`宿主函数 __meridian_${host} 的文档条目不存在: ${docId}`);
}

// 检查示例与正文中的显式 build / setRecipe / RESOURCE_* 常量合法性
const allDocSrc = sources.map((s) => s.src).join('\n');
for (const m of allDocSrc.matchAll(/\.build\('([^']+)'/g)) {
  if (!validBuildings.has(m[1])) problems.push(`Plot.build 示例使用了不存在的建筑 ID: ${m[1]}`);
}
for (const m of allDocSrc.matchAll(/setRecipe\('([^']+)'/g)) {
  if (!validRecipes.has(m[1])) problems.push(`setRecipe 示例使用了不存在的配方 ID: ${m[1]}`);
}
for (const m of allDocSrc.matchAll(/\bRESOURCE_([A-Z0-9_]+)\b/g)) {
  if (m[1] === '<ID>' || m[1] === 'ID') continue;
  const itemId = m[1].toLowerCase();
  if (!validItems.has(itemId)) problems.push(`文档引用了不存在的物品常量: RESOURCE_${m[1]}`);
}

// 检查 DocView / DocsPage 不泄露禁止术语
for (const uiFile of ['frontend/src/docs/DocView.tsx', 'frontend/src/docs/DocsPage.tsx', 'frontend/src/docs/apiDocs.ts']) {
  const uiSrc = readFileSync(join(root, uiFile), 'utf8');
  for (const term of FORBIDDEN_TERMS) {
    if (uiSrc.includes(term)) {
      problems.push(`${uiFile}: UI 文案含有禁止暴露的内部词 "${term}"`);
    }
  }
}

const summary = Array.from(groups, ([g, n]) => `${g} ${n}`).join(' / ');
console.log(`条目 ${entries.size}（${summary}）`);
console.log(`链接 ${linkCount} 条；宿主函数 ${hosts.size} 个`);
if (problems.length > 0) {
  console.error(`\n发现 ${problems.length} 个问题：`);
  for (const p of problems) console.error('  - ' + p);
  process.exit(1);
}
console.log('OK');

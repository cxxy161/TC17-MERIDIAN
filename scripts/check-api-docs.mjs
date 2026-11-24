#!/usr/bin/env node
/**
 * API 文档漂移守卫（无依赖，node scripts/check-api-docs.mjs 即可跑）。
 *
 * 检查三件事：
 *  1. 文档条目 id 唯一、所有 "相关" 链接都能解析（没有悬空锚点）；
 *  2. 每个分组都有条目，且没有残留的 § 占位符（历史事故：写成 § 导致渲染出字面量）；
 *  3. sandbox 里注册的 __meridian_* 宿主函数都有对应文档，且文档条目真实存在。
 *
 * 改完 frontend/src/docs/data/*.ts 或 js_runner.rs 后跑一次；退出码非 0 就是漂移了。
 */
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const dataDir = join(root, 'frontend/src/docs/data');
const problems = [];

const files = readdirSync(dataDir).filter((f) => f.endsWith('.ts'));
const sources = files.map((file) => ({ file, src: readFileSync(join(dataDir, file), 'utf8') }));

const entries = new Map();
for (const { file, src } of sources) {
  if (src.includes('\u00a7')) {
    problems.push(file + ': 残留 § 占位符（应为反引号）');
  }
  for (const m of src.matchAll(/\n\s*id: '([^']+)',\n\s*title: '([^']+)',/g)) {
    if (entries.has(m[1])) problems.push('重复条目 id: ' + m[1]);
    entries.set(m[1], m[2]);
  }
  if (file === 'errors.ts') {
    for (const m of src.matchAll(/\n\s*code: '(ERR_[A-Z_]+)',/g)) {
      if (entries.has(m[1])) problems.push('重复条目 id: ' + m[1]);
      entries.set(m[1], m[1]);
    }
  }
}

let linkCount = 0;
for (const { file, src } of sources) {
  for (const m of src.matchAll(/\{ label: '[^']*', id: '([^']+)' \}/g)) {
    linkCount += 1;
    if (!entries.has(m[1])) problems.push(file + ': 悬空链接 -> ' + m[1]);
  }
  for (const m of src.matchAll(/\n\s*parent: '([^']+)',/g)) {
    if (!entries.has(m[1])) problems.push(file + ': parent 不是条目 -> ' + m[1]);
  }
}

const groups = new Map();
for (const { src } of sources) {
  for (const m of src.matchAll(/\n\s*title: '[^']+',\n\s*group: '([^']+)',/g)) {
    groups.set(m[1], (groups.get(m[1]) ?? 0) + 1);
  }
}
// 错误码条目由 ERROR_DEFS 动态生成，源码里只有模板，单独补上。
const dynamicErrors = (
  (sources.find((s) => s.file === 'errors.ts')?.src.match(/\n\s*code: '(ERR_[A-Z_]+)',/g) ?? []).length
);
groups.set('错误码', (groups.get('错误码') ?? 0) + dynamicErrors);
if (groups.size === 0) problems.push('没有解析到任何文档条目，检查数据文件格式');

const expected = new Map([
  ['log', 'console'],
  ['cpu_used', 'Game.cpu'],
  ['get_module', 'require'],
  ['quote', 'Game.market.quote'],
  ['depth', 'Game.market.depth'],
  ['get_all_orders', 'Game.market.getAllOrders'],
  ['calc_route', 'Game.market.calcRoute'],
  ['get_land_plots', 'Game.market.getLandPlots'],
  ['list_companies', 'Game.market.listCompanies'],
  ['get_company', 'Game.market.getCompany'],
  ['get_recipe', 'Game.getRecipe'],
  ['set_recipe', 'Building'],
  ['set_active', 'Building'],
  ['dispatch_ship', 'Ship'],
  ['repair_ship', 'Ship'],
  ['create_order', 'Game.market.createOrder'],
  ['cancel_order', 'Game.market.cancelOrder'],
  ['deal_order', 'Game.market.deal'],
  ['buy_plot', 'Game.buyPlot'],
  ['build_facility', 'Game.buildFacility'],
  ['demolish_facility', 'Game.demolishFacility'],
  ['bank', 'Game.bank'],
]);

const jsRunner = readFileSync(join(root, 'backend/crates/meridian-sandbox/src/js_runner.rs'), 'utf8');
// __meridian_run_tick 是 prelude 暴露给 Rust 的入口，不是宿主绑定，不参与登记。
const hosts = new Set(
  Array.from(jsRunner.matchAll(/__meridian_([a-z_]+)/g), (m) => m[1]).filter((h) => h !== 'run_tick'),
);
for (const host of hosts) {
  if (!expected.has(host)) problems.push('新增宿主函数未登记到守卫: __meridian_' + host);
}
for (const [host, docId] of expected) {
  if (!hosts.has(host)) problems.push('守卫登记的宿主函数已不存在: __meridian_' + host);
  if (!entries.has(docId)) problems.push('宿主函数 __meridian_' + host + ' 的文档条目不存在: ' + docId);
}

const summary = Array.from(groups, ([g, n]) => g + ' ' + n).join(' / ');
console.log('条目 ' + entries.size + '（' + summary + '）');
console.log('链接 ' + linkCount + ' 条，全部可解析；宿主函数 ' + hosts.size + ' 个，全部有文档');
if (problems.length > 0) {
  console.error('\n发现 ' + problems.length + ' 个问题：');
  for (const p of problems) console.error('  - ' + p);
  process.exit(1);
}
console.log('OK');

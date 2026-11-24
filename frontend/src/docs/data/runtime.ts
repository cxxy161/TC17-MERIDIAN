import type { DocEntry } from '../types';

/**
 * 「运行时」分组：脚本跑在什么样的沙盒里——能记什么、能打什么日志、
 * 怎么拆模块，以及每 tick 有哪些硬上限、写操作什么时候真正生效。
 */
export const RUNTIME_ENTRIES: DocEntry[] = [
  {
    id: 'execution',
    title: 'tick 执行模型',
    group: '运行时',
    kind: '章节',
    summary: '脚本在只读快照上跑、写操作只进缓冲，Phase 2 才按伪随机顺序落账。',
    keywords: 'execution 执行 运行 tick Phase1 Phase2 两段式 只读 快照 缓冲 Intent 落账 冻结 freeze',
    blocks: [
      {
        kind: 'prose',
        text: '一个 tick 分两段：**Phase 1** 你的 `loop()` 在只读的 `WorldSnapshot` 上跑，所有写方法只往本 tick 的 Intent 缓冲里塞一条记录，同步返回 `OK` 或错误码；**Phase 2** 引擎单线程按伪随机洗牌顺序逐条校验并提交这些 Intent（扣钱、扣货、下单、派船、建厂）。',
      },
      {
        kind: 'note',
        level: 'warn',
        text: '本 tick 内的写操作**不会立刻反映到 `Game`**。刚调完 `ship.dispatch()` 读 `ship.isBusy`、刚调完 `building.setActive(true)` 读 `building.active`、刚下单读 `company.cash`，拿到的都是本 tick 开始时的旧值。',
      },
      {
        kind: 'note',
        level: 'danger',
        text: 'Phase 2 会重新校验每条 Intent，失败就**静默丢弃**，脚本这边完全看不到。所以"返回 OK"不等于"一定成功"：下一 tick 自己复查 `Game` 里的实际状态。',
      },
      {
        kind: 'note',
        level: 'info',
        text: '跨公司的提交顺序是伪随机洗牌，不要写"我先下单所以我先成交"这类逻辑；想知道结果，下一 tick 读 `Game.market`。',
      },
      {
        kind: 'note',
        level: 'danger',
        text: '所有 id 都是**字符串**。`Game.planets[2]` 恒为 `undefined`，`planet.id === 2` 恒为 `false`——数字不会自动变成字符串，从配置或算出来的 id 记得转成字符串再查。',
      },
      {
        kind: 'note',
        level: 'danger',
        text: '`Game`、实体对象、`Store` 都被 `Object.freeze` 过：给它们挂自定义字段会失败（非严格模式下静默无效）。要存状态请写 `Memory`。',
      },
      {
        kind: 'links',
        items: [
          { label: 'Building', id: 'Building' },
          { label: 'Ship', id: 'Ship' },
          { label: 'Memory', id: 'Memory' },
          { label: 'quotas', id: 'quotas' },
        ],
      },
    ],
  },
  {
    id: 'quotas',
    title: '每 tick 配额',
    group: '运行时',
    kind: '章节',
    summary: '5 ms CPU、32 条 Intent、64 条挂单、4 MB 堆、200 行日志——撞上会怎样。',
    keywords: 'quotas 配额 上限 限制 CPU 5ms 墙钟 Intent 32 挂单 64 内存 4MB 日志 200 行 截断',
    blocks: [
      {
        kind: 'prose',
        text: '引擎强制的每公司资源上限。它们是**硬限制**，不是建议：撞上要么当场拿到错误码，要么整个 tick 被丢掉。',
      },
      {
        kind: 'fields',
        rows: [
          { name: 'Intent 配额', type: '32 条 / tick', desc: '每 tick 每公司最多 32 条有效 Intent；超出后写方法直接返回 ERR_FULL，引擎也会再截断一次。游戏界面的手动操作也占这 32 条，且排在脚本之后——脚本用满时人工操作会被截掉。' },
          { name: '活跃挂单', type: '64 条 / 公司', desc: '全星系合计；到顶后 createOrder 返回 ERR_FULL。' },
          { name: 'CPU 预算', type: '5 ms（墙钟）', desc: '含 prelude（你的模块加载）。超时本 tick 的 Intent 全部丢弃，Memory 回滚到上一 tick。' },
          { name: '堆内存', type: '4 MB', desc: 'QuickJS Runtime 的硬上限，爆了整 tick 失败。' },
          { name: '日志', type: '200 行 / tick、1 KB / 行', desc: '超出按 UTF-8 截断并追加提示，详见 console。' },
        ],
      },
      {
        kind: 'note',
        level: 'warn',
        text: '5 ms 是**墙钟**，不是纯 CPU 指令时间：读 `Game` 触发的跨 FFI 抓取也算在里面。`Game.cpu.getUsed()` 和它用同一个时钟，`Game.cpu.limit` 是预算毫秒数，可以拿来衡量自己的余量。',
      },
      {
        kind: 'note',
        level: 'danger',
        text: '超时的代价是整个 tick 白跑：Intent 全丢、`Memory` 回滚，而且脚本里看不到任何报错——只能靠自己量 `getUsed()` 留余量。',
      },
      {
        kind: 'links',
        items: [
          { label: 'console', id: 'console' },
          { label: 'Memory', id: 'Memory' },
          { label: 'Building', id: 'Building' },
          { label: 'Ship', id: 'Ship' },
          { label: 'execution', id: 'execution' },
        ],
      },
    ],
  },
  {
    id: 'Memory',
    title: 'Memory',
    group: '运行时',
    kind: '属性',
    summary: '唯一跨 tick 的持久化容器：普通对象，每 tick 结束自动 JSON 落盘。',
    keywords: 'Memory 记忆 持久化 状态 跨 tick JSON 128KB 序列化 回滚',
    blocks: [
      {
        kind: 'prose',
        text: '一个全局普通对象，想存什么都行。引擎每 tick 结束时用它做 `JSON.stringify` 落盘（SQLite WAL），下一 tick 开头原样还原。',
      },
      {
        kind: 'syntax',
        code: 'Memory: Record<string, any>',
      },
      {
        kind: 'note',
        level: 'warn',
        text: '单玩家上限 **128 KB**（按 UTF-8 字节算，不是字符数）。超限时**整份丢弃**并报错——不是截断到 128 KB，而是这次写进去的东西全部作废。并且超限会置 `run_error`，**本 tick 的 Intent 也一并丢弃**（和 CPU 超时同一条回滚分支）。',
      },
      {
        kind: 'note',
        level: 'danger',
        text: '必须能 `JSON.stringify`：函数、`undefined`、`Symbol` 会被丢掉，**循环引用会让整个 tick 报错**（`a.self = a` 这种别写）。',
      },
      {
        kind: 'note',
        level: 'warn',
        text: 'CPU 超时（5 ms 墙钟）时，整个 tick 的 `Memory` 改动回滚到上一 tick 的内容——本 tick 写的状态白写。',
      },
      {
        kind: 'note',
        level: 'info',
        text: '模块级变量、`globalThis` 上的东西都**不跨 tick**（每 tick 重建 Runtime）。想记住任何跨 tick 的状态，只能写 `Memory`。',
      },
      {
        kind: 'example',
        caption: '用 Memory 累计各艘船的出勤，并把体积控制在 128KB 以内',
        code: "Memory.ticks = (Memory.ticks || 0) + 1;\nMemory.shipTrips = Memory.shipTrips || {};\n\nfor (const ship of Object.values(Game.ships)) {\n  if (ship.isBusy) continue;\n  const rec = (Memory.shipTrips[ship.id] = Memory.shipTrips[ship.id] || { trips: 0 });\n  rec.trips += 1;\n}\n\nconsole.log('第', Memory.ticks, 'tick');",
      },
      {
        kind: 'links',
        items: [
          { label: 'quotas', id: 'quotas' },
          { label: 'require', id: 'require' },
          { label: 'execution', id: 'execution' },
        ],
      },
    ],
  },
  {
    id: 'console',
    title: 'console',
    group: '运行时',
    kind: '属性',
    summary: '游戏内控制台面板的唯一出口：只有 log / warn / error，单行 1KB、每 tick 200 行。',
    keywords: 'console 日志 log warn error 控制台 输出 截断 1024 200 行',
    blocks: [
      {
        kind: 'prose',
        text: '脚本输出到游戏内控制台面板的唯一渠道。只有三个方法：`log`、`warn`、`error`；参数用空格拼成一行。',
      },
      {
        kind: 'syntax',
        code: 'console.log(...args: any[]): void\nconsole.warn(...args: any[]): void\nconsole.error(...args: any[]): void',
      },
      {
        kind: 'note',
        level: 'info',
        text: '多参数用空格拼接，和浏览器 DevTools 不同——对象不会展开。想看清结构，先 `JSON.stringify(obj)` 再打。',
      },
      {
        kind: 'note',
        level: 'warn',
        text: '单行超过 **1024 字节**会按 UTF-8 边界截断，并在末尾补 `...`。中文一个字 3 字节，几百个汉字就到顶了。',
      },
      {
        kind: 'note',
        level: 'warn',
        text: '每 tick 最多保留 **200 行**；超出后会插入一条 `[sandbox] console output truncated at 200 lines`，然后本 tick 剩下的日志全部丢弃。',
      },
      {
        kind: 'note',
        level: 'info',
        text: '没有 `debug` / `info` / `table` / `group` / `time`——调它们直接 TypeError，请统一用 `log`。',
      },
      {
        kind: 'note',
        level: 'info',
        text: 'console 不是持久化通道：日志只给这一 tick 看，要跨 tick 保留数据写 `Memory`。',
      },
      {
        kind: 'example',
        caption: '只在出错时打印，避免刷爆 200 行',
        code: "for (const ship of Object.values(Game.ships)) {\n  if (ship.durability >= 30) continue;\n  console.warn('低耐久', ship.id, ship.location, ship.durability);\n}\n\nconsole.log('tick', Game.time, '用 CPU', Game.cpu.getUsed(), 'ms');",
      },
      {
        kind: 'links',
        items: [
          { label: 'quotas', id: 'quotas' },
          { label: 'Memory', id: 'Memory' },
          { label: 'execution', id: 'execution' },
        ],
      },
    ],
  },
  {
    id: 'require',
    title: 'require',
    group: '运行时',
    kind: '方法',
    summary: '加载另一个模块并拿到它的 module.exports；模块名是扁平的，缓存每 tick 清空。',
    keywords: 'require 模块 module exports main 循环依赖 缓存 __filename 拆分 多文件',
    blocks: [
      {
        kind: 'prose',
        text: '把脚本拆成多个文件维护的入口：加载目标模块并返回它的 `module.exports`。',
      },
      {
        kind: 'syntax',
        code: "const market = require('market');",
      },
      {
        kind: 'params',
        rows: [
          {
            name: 'name',
            type: 'string',
            required: true,
            desc: '模块名。会先归一化：trim、去掉一个前导 `./`、去掉 `.js`——所以 `"./market.js"` 和 `"market"` 是同一个模块。',
          },
        ],
      },
      {
        kind: 'returns',
        type: 'any',
        desc: '目标模块的 `module.exports`。',
      },
      {
        kind: 'note',
        level: 'info',
        text: '模块名是**扁平**的：没有目录层级，也没有 node_modules / 包名解析。`require("lib/market")` 找不到东西。',
      },
      {
        kind: 'note',
        level: 'warn',
        text: '每个 tick 都会重建 Runtime，**模块缓存每 tick 清空**：`require` 回来的模块不保留模块级状态。要跨 tick，把状态写 `Memory`。',
      },
      {
        kind: 'note',
        level: 'danger',
        text: '循环依赖抛 `Error("Circular dependency detected while requiring \'<name>\'")`；模块不存在抛 `Error("Cannot find module \'<raw>\'")`——注意括号里是**未归一化的原始名**，别拿它反推归一化结果。',
      },
      {
        kind: 'note',
        level: 'info',
        text: '模块以 `new Function("exports", "require", "module", "__filename", src)` 执行（**非严格模式**），`__filename` 形如 `"market.js"`。',
      },
      {
        kind: 'note',
        level: 'warn',
        text: '入口固定是 `main`，且必须挂 `module.exports.loop = function () {}`，否则这个 tick 根本不会跑你的主逻辑。',
      },
      {
        kind: 'example',
        caption: 'main.js 引用 market.js',
        code: "// market.js\nmodule.exports.bestPrice = function (stationId, item) {\n  const q = Game.market.quote(stationId, item);\n  return q.bestAsk;\n};\n\n// main.js\nconst market = require('./market.js');\n\nmodule.exports.loop = function () {\n  console.log('卖一价', market.bestPrice('ST:P2', 'steel'));\n};",
      },
      {
        kind: 'links',
        items: [
          { label: 'Memory', id: 'Memory' },
          { label: 'quotas', id: 'quotas' },
        ],
      },
    ],
  },
];

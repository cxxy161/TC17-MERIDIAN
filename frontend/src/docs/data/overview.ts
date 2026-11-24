import type { DocEntry } from '../types';

export const OVERVIEW_ENTRIES: DocEntry[] = [
  {
    id: 'overview/quickstart',
    title: '快速开始',
    group: '总览',
    kind: '章节',
    summary: '脚本入口、热重载与最小可运行示例',
    keywords: '入门 开始 第一个脚本 loop 热重载 require 保存',
    blocks: [
      {
        kind: 'prose',
        text: "脚本写在游戏内的「脚本编辑器」里，入口固定是 main 模块导出的 `loop` 函数。点「保存热重载」后从下一 tick 开始执行，之后每个 tick 调用一次 `loop`。多文件用 `require('模块名')` 加载，模块名是扁平的，不能带目录。",
      },
      {
        kind: 'syntax',
        code: 'module.exports.loop = function () {\n  // 每个 tick 调用一次\n};',
      },
      {
        kind: 'example',
        caption: 'main.js',
        code: `module.exports.loop = function () {
  console.log('tick', Game.time, '现金', Game.company.cash);

  // Memory 是唯一的跨 tick 持久化通道；模块级变量每个 tick 都会重置
  if (!Memory.startedAt) {
    Memory.startedAt = Game.time;
  }
};`,
      },
      {
        kind: 'note',
        level: 'info',
        text: '`loop` 抛异常只会终止本 tick 并把错误写进控制台，不会删掉你的代码。模块用 `new Function` 执行，所以脚本不在严格模式下运行。',
      },
      {
        kind: 'links',
        items: [
          { label: '执行模型', id: 'overview/execution' },
          { label: 'Game.time', id: 'Game.time' },
          { label: 'Memory', id: 'Memory' },
          { label: 'console', id: 'console' },
          { label: 'require', id: 'require' },
        ],
      },
    ],
  },
  {
    id: 'overview/execution',
    title: '执行模型',
    group: '总览',
    kind: '章节',
    summary: '只读快照 + Intent 缓冲；写入下一 tick 才生效',
    keywords: '快照 只读 intent 缓冲 两段式 phase 落账 静默丢弃',
    blocks: [
      {
        kind: 'prose',
        text: '脚本运行在只读的世界快照上。`loop` 里读到的是本 tick 开始时的世界；写操作（下单、派船、建厂、切配方、存取款）不会立刻改变任何对象，而是写进本 tick 的 Intent 缓冲并同步返回 `OK` 或负数错误码。引擎在 Phase 2 重新校验并落账，**校验失败会被静默丢弃**，脚本拿不到回执。',
      },
      {
        kind: 'note',
        level: 'warn',
        text: '同一 tick 内读不到自己刚写的结果：`createOrder` 之后 `Game.market.orders` 不会立刻多一单；`dispatch` 之后 `ships[id].isBusy` 仍是 `false`；`Game.company.cash` 也不会变。',
      },
      {
        kind: 'note',
        level: 'info',
        text: '每家公司每 tick 最多 32 条写操作，第 33 条起返回 `ERR_FULL`。游戏界面里的手动操作也占这 32 条，而且排在脚本之后——脚本用满时人工下单会被截掉。跨公司的提交顺序是伪随机洗牌的，不要依赖其他公司在同一 tick 的行为。',
      },
      {
        kind: 'links',
        items: [
          { label: '配额与熔断', id: 'quotas' },
          { label: 'Game.market.createOrder', id: 'Game.market.createOrder' },
          { label: '错误码速查', id: 'error-matrix' },
        ],
      },
    ],
  },
  {
    id: 'overview/limits',
    title: '硬性上限',
    group: '总览',
    kind: '章节',
    summary: '内存、CPU、Intent、挂单、日志的硬限制',
    keywords: '限制 配额 上限 5ms 128kb 32 64 200 熔断 超时',
    blocks: [
      {
        kind: 'prose',
        text: '这些是**硬上限**，触到边界会直接失败，不是软告警：',
      },
      {
        kind: 'fields',
        rows: [
          { name: '堆内存', type: '4 MB', desc: '单个玩家 QuickJS Runtime 的硬上限' },
          { name: '单 tick CPU', type: '5 ms', desc: '墙钟，含 prelude 加载与宿主绑定；见 `Game.cpu.limit`' },
          { name: 'Intent', type: '32 条 / tick', desc: '超出后写方法返回 `ERR_FULL`，引擎还会再截断一次' },
          { name: '活跃挂单', type: '64 / 公司', desc: '含买卖双边；撤单/成交释放名额要等下一 tick 快照' },
          { name: 'Memory', type: '128 KB', desc: '按 JSON 序列化后的 UTF-8 字节数计算' },
          { name: 'console', type: '200 行 / tick', desc: '单行上限 1024 字节，超出按 UTF-8 截断并追加 `...`' },
          { name: '盘口深度', type: '5 档', desc: '`depth(limit)` 传更大也只返回快照里的 5 档' },
          { name: '二手地', type: '8 条 / 行星', desc: '`planet.landListings` 最多 8 条' },
        ],
      },
      {
        kind: 'note',
        level: 'danger',
        text: 'CPU 超时：本 tick 的全部 Intent 被丢弃，Memory 回滚到上一 tick，但日志保留。Memory 超限：**整份** Memory 丢弃并报错，而且会置 `run_error`——本 tick 的 Intent 同样全部丢弃，不是只丢状态。',
      },
      {
        kind: 'links',
        items: [
          { label: 'Memory', id: 'Memory' },
          { label: 'quotas', id: 'quotas' },
          { label: 'Game.cpu', id: 'Game.cpu' },
        ],
      },
    ],
  },
  {
    id: 'overview/ids',
    title: 'ID 与坐标',
    group: '总览',
    kind: '章节',
    summary: '行星、站点、物品与实体 id 的命名规则',
    keywords: 'id 标识 行星 站点 坐标 字符串 类型',
    blocks: [
      {
        kind: 'prose',
        text: '所有 id 都是**字符串**，包括后端用整数表示的地块、飞船、建筑与订单。',
      },
      {
        kind: 'fields',
        rows: [
          { name: '行星', type: "`'P1'`", desc: '`Game.planets` 的键' },
          { name: '轨道站', type: "`'ST:P1'`", desc: '行星 P1 的轨道站' },
          { name: '枢纽站', type: "`'ST:HUB'`", desc: '星系中心枢纽' },
          { name: '物品', type: "`'steel'`", desc: '同时有 `RESOURCE_STEEL` 常量' },
          { name: '飞船 / 地块 / 建筑 / 订单', type: "`'42'`", desc: '数字转成的十进制字符串' },
        ],
      },
      {
        kind: 'note',
        level: 'warn',
        text: '数字 id 不要和数字比较：`ship.id === 42` 永远为 `false`。同理，`getAllOrders` 里的 `order.id` 也是字符串。',
      },
      {
        kind: 'links',
        items: [
          { label: 'Planet', id: 'Planet' },
          { label: 'Station', id: 'Station' },
          { label: 'MarketOrder', id: 'MarketOrder' },
        ],
      },
    ],
  },
];

import type { DocEntry } from '../types';

export const RUNTIME_ENTRIES: DocEntry[] = [
  {
    id: 'Memory',
    title: 'Memory',
    group: '全局运行时',
    kind: '属性',
    summary: '唯一的跨 tick 持久化对象，每 tick 结束时自动以 JSON 序列化保存',
    keywords: 'Memory 持久化 状态 跨tick JSON 128KB 回滚',
    blocks: [
      {
        kind: 'prose',
        text: '`Memory` 是一个全局普通 JavaScript 对象，用于在多个 tick 之间保存状态机、行情缓存、任务队列等自定义数据。每个 tick 结束时，系统会自动对其进行 `JSON.stringify` 并持久化；下一 tick 启动时原样反序列化恢复。',
      },
      {
        kind: 'syntax',
        code: 'let Memory: Record<string, any>',
      },
      {
        kind: 'note',
        level: 'warn',
        title: '128 KB 体积上限',
        text: '`Memory` 序列化后的 UTF-8 字节数上限为 **128 KB**（131,072 字节）。一旦超限，不仅本次 `Memory` 修改会被**整份丢弃并报错**，本 tick 的所有写操作也会一并回滚。',
      },
      {
        kind: 'note',
        level: 'danger',
        title: '必须可 JSON 序列化',
        text: '存入 `Memory` 的函数、`undefined`、`Symbol` 会在序列化时丢失；**循环引用**会导致脚本抛出序列化异常，进而丢弃本 tick 的全部写操作。',
      },
      {
        kind: 'note',
        level: 'info',
        text: '正常连续运行时沙盒实例会在多 tick 间复用（`globalThis` 与模块缓存保留）；一旦修改代码、服务重启，或脚本触发 CPU 超时 / 堆内存溢出 / 未捕获异常，沙盒会立即销毁重建。因此只有 `Memory` 能确保跨异常与重启持久留存，且超时或溢出时 `Memory` 也会自动回滚到上一 tick 的内容。',
      },
      {
        kind: 'example',
        caption: '在 Memory 中维护精简的状态与统计',
        code: `module.exports.loop = function () {
  Memory.stats = Memory.stats || { ticks: 0 };
  Memory.stats.ticks += 1;

  // 避免把整张市场挂单或全星地块直接塞进 Memory，防止突破 128 KB
  Memory.stats.lastCash = Game.company.cash;
  console.log('累计运行 tick:', Memory.stats.ticks);
};`,
      },
      {
        kind: 'links',
        items: [
          { label: '配额与限制', id: 'guides/limits' },
          { label: '执行与落账机制', id: 'guides/execution' },
          { label: 'require', id: 'require' },
        ],
      },
    ],
  },
  {
    id: 'console',
    title: 'console',
    group: '全局运行时',
    kind: '属性',
    summary: '向游戏内控制台面板输出日志的全局对象',
    keywords: 'console 日志 log warn error 控制台 截断 1024 200',
    blocks: [
      {
        kind: 'prose',
        text: '`console` 是脚本向游戏内控制台面板输出调试信息的唯一渠道，仅提供 `log`、`warn`、`error` 三个方法。',
      },
      {
        kind: 'syntax',
        code: 'readonly console: {\n  log(...args: unknown[]): void;\n  warn(...args: unknown[]): void;\n  error(...args: unknown[]): void;\n}',
      },
      {
        kind: 'methods',
        rows: [
          { signature: 'console.log(...args: unknown[])', returns: 'void', desc: '输出普通级别日志', id: 'console.log' },
          { signature: 'console.warn(...args: unknown[])', returns: 'void', desc: '输出警告级别日志', id: 'console.warn' },
          { signature: 'console.error(...args: unknown[])', returns: 'void', desc: '输出错误级别日志', id: 'console.error' },
        ],
      },
      {
        kind: 'note',
        level: 'warn',
        title: '行数与单行长度限制',
        text: '每 tick 最多保留 **200 行**日志（超出后会追加截断提示并丢弃本 tick 剩余输出）；单行最多 **1024 字节**（按 UTF-8 截断并在末尾补 `...`）。',
      },
      {
        kind: 'note',
        level: 'info',
        text: '不存在 `console.debug`、`console.info`、`console.table` 等方法，调用它们会抛出 `TypeError`。传入的对象和数组会自动使用 `JSON.stringify` 格式化。',
      },
      {
        kind: 'links',
        items: [
          { label: 'console.log', id: 'console.log' },
          { label: 'console.warn', id: 'console.warn' },
          { label: 'console.error', id: 'console.error' },
          { label: '配额与限制', id: 'guides/limits' },
        ],
      },
    ],
  },
  {
    id: 'console.log',
    title: 'log',
    group: '全局运行时',
    parent: 'console',
    kind: '方法',
    summary: '输出一条普通日志到控制台面板',
    keywords: 'console.log 日志 打印 调试',
    blocks: [
      {
        kind: 'prose',
        text: '将任意数量的参数转换为字符串并以空格拼接，作为普通级别日志写入本 tick 控制台。对象会自动做 `JSON.stringify` 序列化。',
      },
      {
        kind: 'syntax',
        code: 'console.log(...args: unknown[]): void',
      },
      {
        kind: 'params',
        rows: [
          { name: '...args', type: 'unknown[]', required: 'optional', desc: '待输出的任意个参数；`Error` 对象输出堆栈，普通对象自动 JSON 序列化' },
        ],
      },
      {
        kind: 'returns',
        type: 'void',
        desc: '无返回值',
      },
      {
        kind: 'example',
        caption: '打印当前资金与 CPU 耗时',
        code: `module.exports.loop = function () {
  console.log('tick', Game.time, '现金', Game.company.cash, 'CPU', Game.cpu.getUsed().toFixed(2));
};`,
      },
      {
        kind: 'links',
        items: [
          { label: 'console', id: 'console' },
          { label: 'console.warn', id: 'console.warn' },
          { label: 'console.error', id: 'console.error' },
        ],
      },
    ],
  },
  {
    id: 'console.warn',
    title: 'warn',
    group: '全局运行时',
    parent: 'console',
    kind: '方法',
    summary: '输出一条警告级别日志到控制台面板',
    keywords: 'console.warn 警告 日志',
    blocks: [
      {
        kind: 'prose',
        text: '以警告样式输出一条日志到本 tick 控制台，参数格式化和截断规则与 `console.log` 完全相同。',
      },
      {
        kind: 'syntax',
        code: 'console.warn(...args: unknown[]): void',
      },
      {
        kind: 'params',
        rows: [
          { name: '...args', type: 'unknown[]', required: 'optional', desc: '待输出的任意个参数' },
        ],
      },
      {
        kind: 'returns',
        type: 'void',
        desc: '无返回值',
      },
      {
        kind: 'example',
        caption: '低耐久飞船提醒',
        code: `module.exports.loop = function () {
  for (const ship of Object.values(Game.ships)) {
    if (ship.durability < 30) {
      console.warn('飞船耐久过低:', ship.id, ship.location, ship.durability);
    }
  }
};`,
      },
      {
        kind: 'links',
        items: [
          { label: 'console', id: 'console' },
          { label: 'console.log', id: 'console.log' },
          { label: 'console.error', id: 'console.error' },
        ],
      },
    ],
  },
  {
    id: 'console.error',
    title: 'error',
    group: '全局运行时',
    parent: 'console',
    kind: '方法',
    summary: '输出一条错误级别日志到控制台面板',
    keywords: 'console.error 错误 日志',
    blocks: [
      {
        kind: 'prose',
        text: '以错误样式输出一条日志到本 tick 控制台。注意它仅记录日志，不会中断当前 `loop()` 执行也不会回滚写操作。',
      },
      {
        kind: 'syntax',
        code: 'console.error(...args: unknown[]): void',
      },
      {
        kind: 'params',
        rows: [
          { name: '...args', type: 'unknown[]', required: 'optional', desc: '待输出的任意个参数' },
        ],
      },
      {
        kind: 'returns',
        type: 'void',
        desc: '无返回值',
      },
      {
        kind: 'example',
        caption: '捕获非预期返回码',
        code: `module.exports.loop = function () {
  const pid = Game.company.homePlanetId;
  const rc = Game.bank(pid, 'deposit', 100);
  if (rc !== OK) {
    console.error('银行存款请求异常，返回码:', rc);
  }
};`,
      },
      {
        kind: 'links',
        items: [
          { label: 'console', id: 'console' },
          { label: 'console.log', id: 'console.log' },
          { label: 'console.warn', id: 'console.warn' },
        ],
      },
    ],
  },
  {
    id: 'require',
    title: 'require',
    group: '全局运行时',
    kind: '方法',
    summary: '加载同项目中的其他 JS 模块并返回其 module.exports',
    keywords: 'require 模块 module exports main 循环依赖 缓存 多文件',
    blocks: [
      {
        kind: 'prose',
        text: '加载脚本编辑器中保存的另一个 JS 模块，执行它并返回其 `module.exports`。模块在沙盒实例存活期间会被缓存，重复 `require` 同一模块不会重复解析编译。',
      },
      {
        kind: 'syntax',
        code: 'require(name: string): any',
      },
      {
        kind: 'params',
        rows: [
          {
            name: 'name',
            type: 'string',
            required: 'required',
            desc: '目标模块名。会自动去除首尾空格、一个前导 `./` 与末尾 `.js`（因此 `\'./market.js\'` 与 `\'market\'` 指向同一模块）',
          },
        ],
      },
      {
        kind: 'returns',
        type: 'any',
        desc: '目标模块导出的 `module.exports` 对象或值；找不到模块或发生循环依赖时会抛出 `Error`',
      },
      {
        kind: 'note',
        level: 'info',
        title: '扁平模块命名空间',
        text: '模块不支持目录层级，也不支持第三方 npm 包。请直接用扁平文件名（如 `market`、`logistics`），不要写成 `lib/market`。',
      },
      {
        kind: 'note',
        level: 'warn',
        title: '不要把关键持久状态放在模块顶层',
        text: '模块顶层变量仅在当前沙盒实例存活期间作为临时缓存有效（修改代码、超时/OOM 或服务端重启时会重置）；所有需要可靠持久化的数据必须存入 `Memory`。',
      },
      {
        kind: 'example',
        caption: 'main.js 引入 market.js 模块',
        code: `// —— market.js ——
module.exports.getBestAsk = function (stationId, item) {
  const q = Game.market.quote(stationId, item);
  return q ? q.bestAsk : null;
};

// —— main.js ——
const market = require('market');

module.exports.loop = function () {
  const ask = market.getBestAsk('ST:P2', RESOURCE_STEEL);
  if (ask !== null) {
    console.log('P2 轨道站钢材卖一价:', ask);
  }
};`,
      },
      {
        kind: 'links',
        items: [
          { label: '快速开始', id: 'guides/quickstart' },
          { label: 'Memory', id: 'Memory' },
        ],
      },
    ],
  },
];

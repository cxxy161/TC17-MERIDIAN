import type { DocEntry } from '../types';

export const CONSTANT_ENTRIES: DocEntry[] = [
  {
    id: 'OK',
    title: 'OK',
    group: '常量',
    kind: '常量',
    summary: '成功返回码 0',
    keywords: '成功 0 返回码 写操作',
    blocks: [
      {
        kind: 'prose',
        text: '写方法被接受时返回 `0`。它只表示 **Intent 已进入本 tick 的缓冲**，不代表已经成交或扣款——最终结果由引擎落地阶段决定，失败不会回传给你。',
      },
      { kind: 'syntax', code: 'OK // 0' },
      {
        kind: 'links',
        items: [
          { label: '执行模型', id: 'overview/execution' },
          { label: '错误码速查', id: 'error-matrix' },
        ],
      },
    ],
  },
  {
    id: 'ORDER_BUY',
    title: 'ORDER_BUY',
    group: '常量',
    kind: '常量',
    summary: '买单方向常量 "buy"',
    keywords: '买单 buy 方向 下单',
    blocks: [
      {
        kind: 'prose',
        text: '字符串常量 `"buy"`，用在 `Game.market.createOrder` 的 `type` 和 `getAllOrders` 的 `filter.type` 上。',
      },
      { kind: 'syntax', code: 'ORDER_BUY // "buy"' },
      {
        kind: 'example',
        code: `Game.market.createOrder({
  type: ORDER_BUY,
  resourceType: RESOURCE_STEEL,
  price: 12.5,
  totalAmount: 20,
  stationId: 'ST:HUB',
});`,
      },
      {
        kind: 'links',
        items: [
          { label: 'Game.market.createOrder', id: 'Game.market.createOrder' },
          { label: 'Game.market.getAllOrders', id: 'Game.market.getAllOrders' },
          { label: 'ORDER_SELL', id: 'ORDER_SELL' },
        ],
      },
    ],
  },
  {
    id: 'ORDER_SELL',
    title: 'ORDER_SELL',
    group: '常量',
    kind: '常量',
    summary: '卖单方向常量 "sell"',
    keywords: '卖单 sell 方向 下单',
    blocks: [
      {
        kind: 'prose',
        text: '字符串常量 `"sell"`，用在 `Game.market.createOrder` 的 `type` 和 `getAllOrders` 的 `filter.type` 上。',
      },
      { kind: 'syntax', code: 'ORDER_SELL // "sell"' },
      {
        kind: 'example',
        code: `Game.market.createOrder({
  type: ORDER_SELL,
  resourceType: RESOURCE_STEEL,
  price: 18,
  totalAmount: 10,
  stationId: 'ST:HUB',
});`,
      },
      {
        kind: 'links',
        items: [
          { label: 'Game.market.createOrder', id: 'Game.market.createOrder' },
          { label: 'Game.market.getAllOrders', id: 'Game.market.getAllOrders' },
          { label: 'ORDER_BUY', id: 'ORDER_BUY' },
        ],
      },
    ],
  },
  {
    id: 'RESOURCES_ALL',
    title: 'RESOURCES_ALL',
    group: '常量',
    kind: '常量',
    summary: '全部物品 id 的只读数组',
    keywords: '物品 列表 全部 遍历 resources',
    blocks: [
      {
        kind: 'prose',
        text: '当前 production pack 里全部物品 id 的只读数组（已排序），脚本启动时注入。用来遍历物品，或检查一个 id 是否存在。',
      },
      { kind: 'syntax', code: 'RESOURCES_ALL: readonly string[]' },
      {
        kind: 'example',
        code: `console.log(RESOURCES_ALL.length);
for (const item of RESOURCES_ALL) {
  const q = Game.market.quote('ST:HUB', item);
  if (q && q.bestAsk !== null) console.log(item, q.bestAsk);
}`,
      },
      {
        kind: 'note',
        level: 'info',
        text: '数组被冻结：`push` 或整体重新赋值在非严格模式下静默无效。物品清单随 production pack 变化，不要把它写死在脚本里。',
      },
      {
        kind: 'links',
        items: [
          { label: 'RESOURCE_<ID>', id: 'RESOURCE_<ID>' },
          { label: 'Game.getRecipe', id: 'Game.getRecipe' },
        ],
      },
    ],
  },
  {
    id: 'RESOURCE_<ID>',
    title: 'RESOURCE_<ID>',
    group: '常量',
    kind: '常量',
    summary: '每个物品一个 RESOURCE_ 常量',
    keywords: '物品 常量 resource steel 标识符 动态',
    blocks: [
      {
        kind: 'prose',
        text: '每个物品都会注入一个 `RESOURCE_<ID 大写>` 常量，值就是物品 id 字符串。物品清单随 production pack 变化，这个窗口会按当前世界列出全部常量。',
      },
      { kind: 'syntax', code: 'RESOURCE_STEEL // "steel"' },
      {
        kind: 'example',
        code: `Game.market.quote('ST:HUB', RESOURCE_STEEL);
Game.market.quote('ST:HUB', RESOURCE_BUILDING_MAT);`,
      },
      {
        kind: 'note',
        level: 'warn',
        text: '常量名直接用 id 大写拼接，**不保证是合法 JS 标识符**：id 含 `-` 或 `.` 时（例如 `a-b`），只能写 `globalThis["RESOURCE_A-B"]`；直接写 `RESOURCE_A-B` 会被解析成减法。',
      },
      {
        kind: 'links',
        items: [
          { label: 'RESOURCES_ALL', id: 'RESOURCES_ALL' },
          { label: 'Game.market.quote', id: 'Game.market.quote' },
        ],
      },
    ],
  },
];

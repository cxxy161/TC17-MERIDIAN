import type { DocEntry } from '../types';

export const MARKET_ENTRIES: DocEntry[] = [
  {
    id: 'Game.market.credits',
    title: 'credits',
    group: 'Game',
    parent: 'Game.market',
    kind: '属性',
    summary: '本 tick 开盘时的现金副本',
    keywords: 'credits 现金 余额 预算',
    blocks: [
      {
        kind: 'prose',
        text: '本 tick 开盘时的现金副本，单位信用点。它和 `Game.company.cash` 取自同一个开盘快照。',
      },
      { kind: 'syntax', code: 'Game.market.credits: number' },
      {
        kind: 'note',
        level: 'warn',
        text: '**不是实时余额**：本 tick 内的下单、建造、存取款都不会改变它。要连下多单，请用局部变量自己扣预算。',
      },
      {
        kind: 'links',
        items: [
          { label: 'Game.company', id: 'Game.company' },
          { label: 'Game.market.createOrder', id: 'Game.market.createOrder' },
        ],
      },
    ],
  },
  {
    id: 'Game.market.orders',
    title: 'orders',
    group: 'Game',
    parent: 'Game.market',
    kind: '属性',
    summary: '自己的活跃挂单（已落账）',
    keywords: 'orders 挂单 订单 我的订单 活跃',
    blocks: [
      {
        kind: 'prose',
        text: '自己的活跃挂单，键是订单 id，值见 `MarketOrder`。只包含**已落账**的订单：本 tick 新建的下一 tick 才会出现。',
      },
      { kind: 'syntax', code: 'Game.market.orders: Record<string, MarketOrder>' },
      {
        kind: 'example',
        code: `for (const order of Object.values(Game.market.orders)) {
  // 卖单挂太高、想改价：先撤再下一 tick 重挂
  if (order.type === ORDER_SELL && order.price > 50) {
    Game.market.cancelOrder(order.id);
  }
}`,
      },
      {
        kind: 'note',
        level: 'info',
        text: '每家公司同时最多 64 条活跃挂单；达到上限后 `createOrder` 返回 `ERR_FULL`。撤单/成交释放的名额要等下一 tick 快照。',
      },
      {
        kind: 'links',
        items: [
          { label: 'MarketOrder', id: 'MarketOrder' },
          { label: 'Game.market.cancelOrder', id: 'Game.market.cancelOrder' },
          { label: 'Game.market.createOrder', id: 'Game.market.createOrder' },
        ],
      },
    ],
  },
  {
    id: 'Game.market.quote',
    title: 'quote',
    group: 'Game',
    parent: 'Game.market',
    kind: '方法',
    summary: '查询站点 × 物品的盘口快照',
    keywords: '报价 盘口 买一 卖一 最新价 ema 成交量 quote',
    blocks: [
      { kind: 'syntax', code: 'Game.market.quote(stationId, resourceType) → MarketQuote | null' },
      {
        kind: 'prose',
        text: '查询某站点某物品的盘口快照：买一、卖一、最新价、快慢 EMA 与 50 tick 成交量。数据来自本 tick 的全站快照。',
      },
      {
        kind: 'params',
        rows: [
          { name: 'stationId', type: 'string', required: true, desc: '站点 id，如 `ST:HUB`' },
          { name: 'resourceType', type: 'string', required: true, desc: '物品 id 或 `RESOURCE_*` 常量' },
        ],
      },
      { kind: 'returns', type: 'MarketQuote | null', desc: '该站点该物品的盘口；参数不合法时返回 null' },
      {
        kind: 'example',
        code: `const q = Game.market.quote('ST:HUB', RESOURCE_STEEL);
if (q) {
  console.log('买一', q.bestBid, '卖一', q.bestAsk, '最新', q.lastPrice);
}`,
      },
      {
        kind: 'note',
        level: 'info',
        text: '`bestBid / bestAsk` 可能为 `null`（单边空盘）。快照只在本 tick 有效，下个 tick 要重新查。',
      },
      {
        kind: 'links',
        items: [
          { label: 'MarketQuote', id: 'MarketQuote' },
          { label: 'Game.market.depth', id: 'Game.market.depth' },
        ],
      },
    ],
  },
  {
    id: 'Game.market.depth',
    title: 'depth',
    group: 'Game',
    parent: 'Game.market',
    kind: '方法',
    summary: '查询买卖深度（最多 5 档）',
    keywords: '深度 盘口 档位 bids asks',
    blocks: [
      { kind: 'syntax', code: 'Game.market.depth(stationId, resourceType, limit?) → { bids, asks }' },
      { kind: 'prose', text: '查询买卖盘的前若干档价格与数量。' },
      {
        kind: 'params',
        rows: [
          { name: 'stationId', type: 'string', required: true, desc: '站点 id' },
          { name: 'resourceType', type: 'string', required: true, desc: '物品 id' },
          { name: 'limit', type: 'number', required: false, desc: '默认 10，上限 50；但快照只存 5 档' },
        ],
      },
      {
        kind: 'returns',
        type: '{ bids: Array<{ price, qty }>, asks: Array<{ price, qty }> }',
        desc: 'bids 从高价到低价，asks 从低价到高价',
      },
      {
        kind: 'example',
        code: `const d = Game.market.depth('ST:HUB', RESOURCE_STEEL, 5);
if (d.asks.length > 0) {
  console.log('最低卖价', d.asks[0].price, '数量', d.asks[0].qty);
}`,
      },
      {
        kind: 'note',
        level: 'warn',
        text: '快照只保存 5 档：`limit` 传 10 或 50 也不会多返回。参数不合法（非字符串）时返回空数组对象，不抛错。',
      },
      {
        kind: 'links',
        items: [
          { label: 'Game.market.quote', id: 'Game.market.quote' },
          { label: 'Game.market.getAllOrders', id: 'Game.market.getAllOrders' },
        ],
      },
    ],
  },
  {
    id: 'Game.market.getAllOrders',
    title: 'getAllOrders',
    group: 'Game',
    parent: 'Game.market',
    kind: '方法',
    summary: '查询市场挂单（含其他公司）',
    keywords: '订单 挂单 查询 全站 filter owner',
    blocks: [
      { kind: 'syntax', code: 'Game.market.getAllOrders(filter?) → MarketOrder[]' },
      { kind: 'prose', text: '查询全站挂单，可按站点、物品、方向过滤。没有匹配时返回空数组。' },
      {
        kind: 'params',
        rows: [
          { name: 'filter.stationId', type: 'string', required: false, desc: '只看某个站点' },
          { name: 'filter.resourceType', type: 'string', required: false, desc: '只看某个物品' },
          { name: 'filter.type', type: '"buy" | "sell"', required: false, desc: '只看买单或卖单（用 `ORDER_BUY / ORDER_SELL`）' },
        ],
      },
      { kind: 'returns', type: 'MarketOrder[]', desc: '挂单数组；含其他公司，可通过 ownerId 区分' },
      {
        kind: 'example',
        code: `const asks = Game.market.getAllOrders({
  stationId: 'ST:HUB',
  resourceType: RESOURCE_STEEL,
  type: ORDER_SELL,
});
const best = asks.reduce((a, b) => (a === null || b.price < a.price ? b : a), null);
if (best) Game.market.deal(best.id, Math.min(best.amount, 10));`,
      },
      {
        kind: 'note',
        level: 'info',
        text: '订单 id 是字符串。别人的订单能看到 ownerId，但看不到对方的资金、地块与库存。',
      },
      {
        kind: 'links',
        items: [
          { label: 'MarketOrder', id: 'MarketOrder' },
          { label: 'Game.market.deal', id: 'Game.market.deal' },
          { label: 'ORDER_SELL', id: 'ORDER_SELL' },
        ],
      },
    ],
  },
  {
    id: 'Game.market.createOrder',
    title: 'createOrder',
    group: 'Game',
    parent: 'Game.market',
    kind: '方法',
    summary: '发布限价买卖单',
    keywords: '下单 挂单 限价 买单 卖单 冻结 保证金',
    blocks: [
      { kind: 'syntax', code: 'Game.market.createOrder({ type, resourceType, price, totalAmount, stationId }) → number' },
      {
        kind: 'prose',
        text: '发布限价单。买单在落账时冻结 `price * totalAmount` 的现金；卖单从站点仓库扣货（`power`、`waste_service` 这类即时物品允许从该星地面仓扣）。',
      },
      {
        kind: 'params',
        rows: [
          { name: 'type', type: '"buy" | "sell"', required: true, desc: '`ORDER_BUY` 或 `ORDER_SELL`' },
          { name: 'resourceType', type: 'string', required: true, desc: '物品 id' },
          { name: 'price', type: 'number', required: true, desc: '单价，必须大于 0' },
          { name: 'totalAmount', type: 'number', required: true, desc: '总量，正整数' },
          { name: 'stationId', type: 'string', required: true, desc: '挂单站点' },
        ],
      },
      { kind: 'returns', type: 'number', desc: '`OK` 或错误码' },
      {
        kind: 'errors',
        rows: [
          { code: 'ERR_INVALID_ARGS', when: '字段类型/数值非法，或数量取整后为 0' },
          { code: 'ERR_INVALID_TARGET', when: '物品未知，或该站点没有这个物品的报价' },
          { code: 'ERR_NOT_ENOUGH_CREDITS', when: '买单现金不足 price × totalAmount' },
          { code: 'ERR_FULL', when: '活跃挂单已达 64 条，或本 tick Intent 已满' },
        ],
      },
      {
        kind: 'example',
        code: `const cash = Game.market.credits;
const price = 12.5;
const qty = 20;
if (cash > price * qty + 100) {
  const rc = Game.market.createOrder({
    type: ORDER_BUY,
    resourceType: RESOURCE_STEEL,
    price,
    totalAmount: qty,
    stationId: 'ST:HUB',
  });
  if (rc !== OK) console.log('下单失败', rc);
}`,
      },
      {
        kind: 'note',
        level: 'warn',
        text: '本 tick 内 `Game.market.orders` 不会出现新单；成交与否下一 tick 才看得到。用 `Game.market.credits` 做预算时记得自己扣掉前面已经下过的单。另外引擎会拒绝与**自家反向单**交叉的新单（同站点同物品），JS 侧不判——返回 OK 后可能被静默丢弃。',
      },
      {
        kind: 'links',
        items: [
          { label: 'ORDER_BUY', id: 'ORDER_BUY' },
          { label: 'Game.market.cancelOrder', id: 'Game.market.cancelOrder' },
          { label: 'Game.market.orders', id: 'Game.market.orders' },
        ],
      },
    ],
  },
  {
    id: 'Game.market.cancelOrder',
    title: 'cancelOrder',
    group: 'Game',
    parent: 'Game.market',
    kind: '方法',
    summary: '撤销自己的挂单',
    keywords: '撤单 取消 挂单 撤销',
    blocks: [
      { kind: 'syntax', code: 'Game.market.cancelOrder(orderId) → number' },
      { kind: 'prose', text: '撤销自己的一条活跃挂单，释放在该单上占用的现金或货物。' },
      {
        kind: 'params',
        rows: [{ name: 'orderId', type: 'string', required: true, desc: '订单 id（`Game.market.orders` 的键）' }],
      },
      { kind: 'returns', type: 'number', desc: '`OK` 或错误码' },
      {
        kind: 'errors',
        rows: [
          { code: 'ERR_INVALID_ARGS', when: 'orderId 不是合法数字' },
          { code: 'ERR_NOT_FOUND', when: '不在自己的活跃挂单里' },
          { code: 'ERR_FULL', when: '本 tick 已用满 32 条 Intent' },
        ],
      },
      {
        kind: 'example',
        code: `const mine = Object.values(Game.market.orders);
for (const order of mine) {
  if (order.price > 60) Game.market.cancelOrder(order.id);
}`,
      },
      {
        kind: 'note',
        level: 'info',
        text: '撤单释放的挂单名额与资金同样是下一 tick 才回到快照里。',
      },
      {
        kind: 'links',
        items: [
          { label: 'Game.market.orders', id: 'Game.market.orders' },
          { label: 'Game.market.createOrder', id: 'Game.market.createOrder' },
        ],
      },
    ],
  },
  {
    id: 'Game.market.deal',
    title: 'deal',
    group: 'Game',
    parent: 'Game.market',
    kind: '方法',
    summary: '直接吃单成交',
    keywords: '成交 吃单 买入 卖出 deal',
    blocks: [
      { kind: 'syntax', code: 'Game.market.deal(orderId, amount) → number' },
      { kind: 'prose', text: '立即与某条挂单成交，成交价以挂单价为准。' },
      {
        kind: 'params',
        rows: [
          { name: 'orderId', type: 'string', required: true, desc: '全站订单 id（来自 `getAllOrders`）' },
          { name: 'amount', type: 'number', required: true, desc: '成交数量，正整数，不能超过剩余量' },
        ],
      },
      { kind: 'returns', type: 'number', desc: '`OK` 或错误码' },
      {
        kind: 'errors',
        rows: [
          { code: 'ERR_INVALID_ARGS', when: 'amount ≤ 0 或 orderId 非法' },
          { code: 'ERR_NOT_FOUND', when: '订单不在全站订单簿里（可能已成交/撤销）' },
          { code: 'ERR_FULL', when: '本 tick 已用满 32 条 Intent' },
        ],
      },
      {
        kind: 'example',
        code: `const asks = Game.market.getAllOrders({
  stationId: 'ST:HUB',
  resourceType: RESOURCE_STEEL,
  type: ORDER_SELL,
});
const best = asks.reduce((a, b) => (a === null || b.price < a.price ? b : a), null);
if (best && Game.market.credits > best.price * 5) {
  Game.market.deal(best.id, 5);
}`,
      },
      {
        kind: 'note',
        level: 'info',
        text: '`OK` 只表示已排进本 tick 的 Intent 缓冲；资金与库存是否够由落地阶段校验，失败会静默丢弃。',
      },
      {
        kind: 'links',
        items: [
          { label: 'Game.market.getAllOrders', id: 'Game.market.getAllOrders' },
          { label: 'MarketOrder', id: 'MarketOrder' },
        ],
      },
    ],
  },
  {
    id: 'Game.market.calcRoute',
    title: 'calcRoute',
    group: 'Game',
    parent: 'Game.market',
    kind: '方法',
    summary: '计算航线耗时与油耗',
    keywords: '航线 路线 耗时 油耗 运输 dispatch',
    blocks: [
      { kind: 'syntax', code: 'Game.market.calcRoute(from, to) → RouteCost | null' },
      { kind: 'prose', text: '计算两地之间的航线：需要几个 tick、消耗多少燃料。没有可行航线时返回 `null`。' },
      {
        kind: 'params',
        rows: [
          { name: 'from', type: 'string', required: true, desc: '出发地：`P1` 或 `ST:P1` / `ST:HUB`' },
          { name: 'to', type: 'string', required: true, desc: '目的地' },
        ],
      },
      { kind: 'returns', type: 'RouteCost | null', desc: '`{ ticks, fuel }`；不可达时为 null' },
      {
        kind: 'example',
        code: `const route = Game.market.calcRoute('P1', 'ST:P1');
const ship = Object.values(Game.ships).find((s) => !s.isBusy && s.location === 'P1');
if (route && ship) {
  const cargo = Math.min(ship.store[RESOURCE_STEEL] || 0, ship.capacity);
  if (cargo > 0) ship.dispatch('P1', 'ST:P1', { steel: cargo });
}`,
      },
      {
        kind: 'note',
        level: 'warn',
        text: '油耗只在 `dispatch` 时从出发地扣。注意 `calcRoute` 返回的 `fuel` 是按**小船 × 100 耐久**预算的近似值：中大船或低耐久船实际烧得更多（地面 ↔ 轨道还有按船型的 launch_fuel），不要只照它备油。出发地燃料不足会返回 `ERR_NOT_ENOUGH_RESOURCES`。',
      },
      {
        kind: 'links',
        items: [
          { label: 'RouteCost', id: 'RouteCost' },
          { label: 'Ship', id: 'Ship' },
          { label: 'Game.ships', id: 'Game.ships' },
        ],
      },
    ],
  },
];

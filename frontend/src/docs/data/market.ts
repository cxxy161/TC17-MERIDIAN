import type { DocEntry } from '../types';

export const MARKET_ENTRIES: DocEntry[] = [
  {
    id: 'Game.market',
    title: 'market',
    group: 'Game 接口',
    kind: '属性',
    summary: '市场行情查询、限价挂单、直接吃单、航线估算与公开情报入口',
    keywords: 'Game.market 市场 交易所 盘口 挂单 下单 情报 地块',
    blocks: [
      {
        kind: 'prose',
        text: '`Game.market` 聚合了全星系市场的实时只读查询、限价下单/吃单接口，以及航线成本、行星公开地块和竞争对手公开商业情报查询。',
      },
      {
        kind: 'syntax',
        code: 'readonly Game.market: MarketAPI',
      },
      {
        kind: 'fields',
        title: '只读属性（Properties）',
        rows: [
          { name: 'credits', type: 'number', desc: '本 tick 开盘现金副本（与 `Game.company.cash` 相等）' },
          { name: 'orders', type: 'Record<string, MarketOrder>', desc: '本公司已落账的活跃挂单字典（以订单 ID 为键）' },
        ],
      },
      {
        kind: 'methods',
        title: '查询与交易方法（Methods）',
        rows: [
          { signature: 'Game.market.quote(stationId: string, resourceType: string)', returns: 'MarketQuote | null', desc: '查询指定站点与物品的盘口快照', id: 'Game.market.quote' },
          { signature: 'Game.market.depth(stationId: string, resourceType: string, limit?: number)', returns: 'MarketDepth', desc: '查询买卖盘口深度（最多 5 档）', id: 'Game.market.depth' },
          { signature: 'Game.market.getAllOrders(filter?: OrderFilter)', returns: 'MarketOrder[]', desc: '查询全星系所有活跃挂单（含其他公司）', id: 'Game.market.getAllOrders' },
          { signature: 'Game.market.createOrder(params: CreateOrderParams)', returns: 'RetCode', desc: '在指定站点挂出限价买单或卖单', id: 'Game.market.createOrder' },
          { signature: 'Game.market.cancelOrder(orderId: string)', returns: 'RetCode', desc: '撤销本公司的一条活跃挂单', id: 'Game.market.cancelOrder' },
          { signature: 'Game.market.deal(orderId: string, amount: number)', returns: 'RetCode', desc: '直接与全站订单簿中的指定对手单成交', id: 'Game.market.deal' },
          { signature: 'Game.market.calcRoute(fromId: string, toId: string)', returns: 'RouteCost | null', desc: '估算两地之间的航线耗时与基准油耗', id: 'Game.market.calcRoute' },
          { signature: 'Game.market.getLandPlots(planetId: string)', returns: 'PublicLandPlot[] | null', desc: '获取指定行星的全部公开地表格点与购买信息', id: 'Game.market.getLandPlots' },
          { signature: 'Game.market.listCompanies(filter?: CompanyFilter)', returns: 'PublicCompanySummary[]', desc: '分页筛选全星系公司的公开资产摘要', id: 'Game.market.listCompanies' },
          { signature: 'Game.market.getCompany(companyId: string)', returns: 'PublicCompanyDetail | null', desc: '查看指定公司的公开地块、建筑分布与挂单详情', id: 'Game.market.getCompany' },
        ],
      },
      {
        kind: 'links',
        items: [
          { label: 'Game.market.quote', id: 'Game.market.quote' },
          { label: 'Game.market.createOrder', id: 'Game.market.createOrder' },
          { label: 'Game.market.deal', id: 'Game.market.deal' },
          { label: '核心经济规则', id: 'guides/economy' },
        ],
      },
    ],
  },
  {
    id: 'Game.market.credits',
    title: 'credits',
    group: 'Game 接口',
    parent: 'Game.market',
    kind: '属性',
    summary: '本 tick 开盘时的可用现金副本（信用点）',
    keywords: 'Game.market.credits 现金 余额 预算',
    blocks: [
      {
        kind: 'prose',
        text: '本 tick 开始时的可用现金快照，数值上与 `Game.company.cash` 完全相同，单位为信用点。',
      },
      {
        kind: 'syntax',
        code: 'readonly Game.market.credits: number',
      },
      {
        kind: 'note',
        level: 'warn',
        text: '此字段**不是实时余额**：同一 tick 内执行 `createOrder`、`deal`、`buyPlot` 或 `bank` 后都不会实时减少。同一 tick 内连续下多张买单时，请用局部变量自己扣减预算。',
      },
      {
        kind: 'example',
        caption: '用局部变量跟踪本 tick 下单预算',
        code: `module.exports.loop = function () {
  let budget = Game.market.credits;
  const price = 12;
  const qty = 10;
  if (budget >= price * qty) {
    const rc = Game.market.createOrder({
      type: ORDER_BUY,
      resourceType: RESOURCE_STEEL,
      price,
      totalAmount: qty,
      stationId: 'ST:HUB',
    });
    if (rc === OK) budget -= price * qty;
  }
};`,
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
    group: 'Game 接口',
    parent: 'Game.market',
    kind: '属性',
    summary: '本公司当前已落账的全部活跃挂单字典',
    keywords: 'Game.market.orders 我的挂单 活跃订单',
    blocks: [
      {
        kind: 'prose',
        text: '以订单 ID（数字字符串）为键的只读字典，包含本公司在全星系所有站点中尚未完全成交或撤销的活跃挂单。本 tick 新发起的挂单要到下一 tick 才会出现在此字典中。',
      },
      {
        kind: 'syntax',
        code: 'readonly Game.market.orders: Record<string, MarketOrder>',
      },
      {
        kind: 'note',
        level: 'info',
        text: '每家公司全星系最多同时持有 **64** 条活跃挂单；撤单或完全成交后释放的名额会在下一 tick 快照中反映。',
      },
      {
        kind: 'example',
        caption: '撤销价格偏高的自有卖单',
        code: `module.exports.loop = function () {
  for (const order of Object.values(Game.market.orders)) {
    if (order.type === ORDER_SELL && order.price > 50) {
      Game.market.cancelOrder(order.id);
    }
  }
};`,
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
    group: 'Game 接口',
    parent: 'Game.market',
    kind: '方法',
    summary: '查询指定站点与物品的盘口买一、卖一、最新价及均线快照',
    keywords: 'Game.market.quote 报价 行情 买一 卖一 ema vol50t',
    blocks: [
      {
        kind: 'prose',
        text: '按站点与物品按需查询本 tick 的盘口汇总行情，包含买一价、卖一价、最近成交价、快慢指数均线以及近 50 tick 成交量。',
      },
      {
        kind: 'syntax',
        code: 'Game.market.quote(stationId: string, resourceType: string): MarketQuote | null',
      },
      {
        kind: 'params',
        rows: [
          { name: 'stationId', type: 'string', required: 'required', desc: '站点 ID，如 `\'ST:HUB\'`、`\'ST:P2\'`' },
          { name: 'resourceType', type: 'string', required: 'required', desc: '物品 ID 或 `RESOURCE_*` 常量' },
        ],
      },
      {
        kind: 'returns',
        type: 'MarketQuote | null',
        desc: '存在该站点与物品报价时返回 `MarketQuote`；参数非字符串、站点不存在或物品不存在时返回 `null`',
      },
      {
        kind: 'note',
        level: 'info',
        text: '即使返回的 `MarketQuote` 不为 `null`，当买盘或卖盘一侧没有挂单时，`bestBid` 或 `bestAsk` 仍可能为 `null`。计算价差前请先对两边判非空。',
      },
      {
        kind: 'example',
        caption: '读取 Hub 钢材买卖价差',
        code: `module.exports.loop = function () {
  const q = Game.market.quote('ST:HUB', RESOURCE_STEEL);
  if (q && q.bestBid !== null && q.bestAsk !== null) {
    console.log('买一:', q.bestBid, '卖一:', q.bestAsk, '价差:', q.bestAsk - q.bestBid);
  }
};`,
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
    group: 'Game 接口',
    parent: 'Game.market',
    kind: '方法',
    summary: '查询指定站点与物品的买卖盘口深度（最多 5 档）',
    keywords: 'Game.market.depth 深度 档位 盘口 bids asks',
    blocks: [
      {
        kind: 'prose',
        text: '查询某站点某物品当前买卖双边的价格聚合深度，用于估算大单冲击成本或滑点。',
      },
      {
        kind: 'syntax',
        code: 'Game.market.depth(\n  stationId: string,\n  resourceType: string,\n  limit?: number\n): { bids: Array<{ price: number; qty: number }>; asks: Array<{ price: number; qty: number }> }',
      },
      {
        kind: 'params',
        rows: [
          { name: 'stationId', type: 'string', required: 'required', desc: '站点 ID，如 `\'ST:HUB\'`' },
          { name: 'resourceType', type: 'string', required: 'required', desc: '物品 ID 或 `RESOURCE_*` 常量' },
          { name: 'limit', type: 'number', required: 'optional', desc: '返回档数上限，默认 `10`（受理上限 `50`；但本 tick 快照实际只保留前 `5` 档）' },
        ],
      },
      {
        kind: 'returns',
        type: '{ bids: Array<{ price: number; qty: number }>; asks: Array<{ price: number; qty: number }> }',
        desc: '始终返回包含 `bids` 与 `asks` 数组的对象；参数非法或该盘口无挂单时返回 `{ bids: [], asks: [] }`',
        fields: [
          { name: 'bids', type: 'Array<{ price: number; qty: number }>', desc: '买盘档位列表，按 `price` 从高到低排序' },
          { name: 'asks', type: 'Array<{ price: number; qty: number }>', desc: '卖盘档位列表，按 `price` 从低到高排序' },
        ],
      },
      {
        kind: 'example',
        caption: '估算扫空前 3 档卖单所需资金',
        code: `module.exports.loop = function () {
  const d = Game.market.depth('ST:HUB', RESOURCE_STEEL, 5);
  const top3Cost = d.asks.slice(0, 3).reduce((sum, lvl) => sum + lvl.price * lvl.qty, 0);
  console.log('卖盘前3档总货值:', top3Cost);
};`,
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
    group: 'Game 接口',
    parent: 'Game.market',
    kind: '方法',
    summary: '按条件筛选并返回全星系活跃挂单数组（含其他公司）',
    keywords: 'Game.market.getAllOrders 挂单 订单 全站 filter 筛选',
    blocks: [
      {
        kind: 'prose',
        text: '查询全星系所有站点上的活跃限价挂单（包括本公司、其他玩家公司、NPC 公司及行星需求买单），可用于配合 `Game.market.deal` 吃单或对比竞争对手报价。',
      },
      {
        kind: 'syntax',
        code: "Game.market.getAllOrders(filter?: {\n  stationId?: string;\n  resourceType?: string;\n  type?: 'buy' | 'sell';\n}): MarketOrder[]",
      },
      {
        kind: 'params',
        rows: [
          { name: 'filter', type: 'object', required: 'optional', desc: '可选筛选条件对象；省略或传空对象时返回全星系所有活跃挂单' },
          { name: 'filter.stationId', type: 'string', required: 'optional', desc: '仅匹配该站点 ID，如 `\'ST:HUB\'`' },
          { name: 'filter.resourceType', type: 'string', required: 'optional', desc: '仅匹配该物品 ID 或 `RESOURCE_*` 常量' },
          { name: 'filter.type', type: "'buy' | 'sell'", required: 'optional', desc: '仅匹配买单或卖单（建议使用 `ORDER_BUY` / `ORDER_SELL`）；传入其他非空字符串返回 `[]`' },
        ],
      },
      {
        kind: 'returns',
        type: 'MarketOrder[]',
        desc: '符合条件的挂单数组；无匹配项时返回空数组 `[]`',
      },
      {
        kind: 'example',
        caption: '查找 Hub 最便宜的钢材卖单并尝试吃单',
        code: `module.exports.loop = function () {
  const asks = Game.market.getAllOrders({
    stationId: 'ST:HUB',
    resourceType: RESOURCE_STEEL,
    type: ORDER_SELL,
  }).filter((o) => o.ownerId !== Game.company.id);

  const best = asks.reduce((a, b) => (!a || b.price < a.price ? b : a), null);
  if (best) {
    const qty = Math.min(best.amount, 10);
    if (Game.market.credits >= best.price * qty) {
      Game.market.deal(best.id, qty);
    }
  }
};`,
      },
      {
        kind: 'links',
        items: [
          { label: 'MarketOrder', id: 'MarketOrder' },
          { label: 'Game.market.deal', id: 'Game.market.deal' },
          { label: 'ORDER_BUY / ORDER_SELL', id: 'constants/order-sides' },
        ],
      },
    ],
  },
  {
    id: 'Game.market.createOrder',
    title: 'createOrder',
    group: 'Game 接口',
    parent: 'Game.market',
    kind: '方法',
    summary: '在指定站点挂出一条限价买单或卖单',
    keywords: 'Game.market.createOrder 下单 挂单 限价单 冻结 价格带 自成交',
    blocks: [
      {
        kind: 'prose',
        text: '发布限价买单或卖单。挂买单会在落账时立即冻结 `price * totalAmount` 信用点；挂卖单会在落账时立即从目标站点仓库扣除货物（`power` 与 `disposal_cert` 在行星轨道站 `ST:P*` 上缺货时允许从该星地面仓自动补扣）。',
      },
      {
        kind: 'syntax',
        code: "Game.market.createOrder(params: {\n  type: 'buy' | 'sell';\n  resourceType: string;\n  price: number;\n  totalAmount: number;\n  stationId: string;\n}): RetCode",
      },
      {
        kind: 'params',
        rows: [
          { name: 'params', type: 'object', required: 'required', desc: '下单参数对象' },
          { name: 'params.type', type: "'buy' | 'sell'", required: 'required', desc: '订单方向：`ORDER_BUY`（买）或 `ORDER_SELL`（卖）' },
          { name: 'params.resourceType', type: 'string', required: 'required', desc: '物品 ID 或 `RESOURCE_*` 常量' },
          { name: 'params.price', type: 'number', required: 'required', desc: '限价单价（信用点），必须 `> 0`' },
          { name: 'params.totalAmount', type: 'number', required: 'required', desc: '下单总数量，会向下取整为正整数（`1..10000`）' },
          { name: 'params.stationId', type: 'string', required: 'required', desc: '挂单站点 ID，如 `\'ST:HUB\'`、`\'ST:P2\'`' },
        ],
      },
      {
        kind: 'returns',
        type: 'RetCode',
        desc: '返回 `OK` 表示下单请求已入队，否则返回负数错误码',
      },
      {
        kind: 'errors',
        rows: [
          { code: 'ERR_INVALID_ARGS', when: '`params` 缺失、方向非法、单价/数量非正数或取整后为 0' },
          { code: 'ERR_INVALID_TARGET', when: '物品 ID 未知，或站点 ID 不存在' },
          { code: 'ERR_NOT_ENOUGH_CREDITS', when: '挂买单时开盘现金不足 `price * totalAmount`' },
          { code: 'ERR_FULL', when: '开盘活跃挂单已达 64 条上限，或本 tick 已用满 32 条写操作配额' },
        ],
      },
      {
        kind: 'settlement',
        items: [
          '下单数量超过单笔上限 `10000`；',
          '单价超出允许价格带（必须位于 `0` 以上且不超过站点参考价的 `100` 倍，同时不超过 `1,000,000` 信用点）；',
          '同一 tick 内累计新增挂单导致总活跃挂单达到或超过 `64` 条；',
          '新订单价格与自己在同一站点、同一物品上的反向挂单交叉（禁止自成交）；',
          '挂买单时因同一 tick 其他扣款导致现金不足，或挂卖单时对应站点仓库库存不足。',
        ],
      },
      {
        kind: 'example',
        caption: '在 Hub 按当前买一价上方挂限价买单',
        code: `module.exports.loop = function () {
  const q = Game.market.quote('ST:HUB', RESOURCE_STEEL);
  if (!q) return;

  const price = q.bestBid !== null ? q.bestBid + 0.05 : q.lastPrice;
  const qty = 20;
  if (Game.market.credits >= price * qty) {
    const rc = Game.market.createOrder({
      type: ORDER_BUY,
      resourceType: RESOURCE_STEEL,
      price,
      totalAmount: qty,
      stationId: 'ST:HUB',
    });
    if (rc !== OK) console.warn('挂单失败:', rc);
  }
};`,
      },
      {
        kind: 'links',
        items: [
          { label: '核心经济规则', id: 'guides/economy' },
          { label: 'Game.market.orders', id: 'Game.market.orders' },
          { label: 'Game.market.cancelOrder', id: 'Game.market.cancelOrder' },
          { label: 'ORDER_BUY / ORDER_SELL', id: 'constants/order-sides' },
        ],
      },
    ],
  },
  {
    id: 'Game.market.cancelOrder',
    title: 'cancelOrder',
    group: 'Game 接口',
    parent: 'Game.market',
    kind: '方法',
    summary: '撤销本公司的一条活跃挂单并退还剩余冻结资金或货物',
    keywords: 'Game.market.cancelOrder 撤单 取消挂单 退款',
    blocks: [
      {
        kind: 'prose',
        text: '撤销自己的一条活跃挂单，释放在该单上占用的剩余买单冻结现金或卖单库存，并在下一 tick 释放一个活跃挂单名额。',
      },
      {
        kind: 'syntax',
        code: 'Game.market.cancelOrder(orderId: string): RetCode',
      },
      {
        kind: 'params',
        rows: [
          { name: 'orderId', type: 'string', required: 'required', desc: '要撤销的订单 ID（来自 `Game.market.orders`）' },
        ],
      },
      {
        kind: 'returns',
        type: 'RetCode',
        desc: '返回 `OK` 表示撤单请求已入队，否则返回负数错误码',
      },
      {
        kind: 'errors',
        rows: [
          { code: 'ERR_INVALID_ARGS', when: '`orderId` 缺失或无法解析为数字 ID' },
          { code: 'ERR_NOT_FOUND', when: '该订单不在本公司的活跃挂单列表 `Game.market.orders` 中' },
          { code: 'ERR_FULL', when: '本 tick 已用满 32 条写操作配额' },
        ],
      },
      {
        kind: 'settlement',
        items: [
          '该订单在落账前已被同 tick 内的对手单撮合/吃单消耗完毕，或已被手动操作提前撤销。',
        ],
      },
      {
        kind: 'example',
        caption: '撤销所有挂单超过 100 tick 的陈旧买单',
        code: `module.exports.loop = function () {
  for (const order of Object.values(Game.market.orders)) {
    if (order.type === ORDER_BUY && Game.time - order.created > 100) {
      Game.market.cancelOrder(order.id);
    }
  }
};`,
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
    group: 'Game 接口',
    parent: 'Game.market',
    kind: '方法',
    summary: '直接与全站订单簿中的指定对手挂单成交',
    keywords: 'Game.market.deal 吃单 成交 买入 卖出 价格优先',
    blocks: [
      {
        kind: 'prose',
        text: '指定对手挂单 ID 与成交数量，以该挂单价格立即完成吃单成交。若传入的数量大于该挂单剩余数量（或单笔上限 `10000`），落账时会自动按实际可成交数量截断。',
      },
      {
        kind: 'syntax',
        code: 'Game.market.deal(orderId: string, amount: number): RetCode',
      },
      {
        kind: 'params',
        rows: [
          { name: 'orderId', type: 'string', required: 'required', desc: '全站订单簿中的目标订单 ID（来自 `Game.market.getAllOrders`）' },
          { name: 'amount', type: 'number', required: 'required', desc: '期望成交数量，会向下取整为正整数（单次最多成交 `10000`）' },
        ],
      },
      {
        kind: 'returns',
        type: 'RetCode',
        desc: '返回 `OK` 表示吃单请求已入队，否则返回负数错误码',
      },
      {
        kind: 'errors',
        rows: [
          { code: 'ERR_INVALID_ARGS', when: '`orderId` 缺失/格式非法，或 `amount` 非有限正数/取整后为 0' },
          { code: 'ERR_NOT_FOUND', when: '目标订单不在本 tick 快照的全站订单簿中' },
          { code: 'ERR_FULL', when: '本 tick 已用满 32 条写操作配额' },
        ],
      },
      {
        kind: 'settlement',
        items: [
          '目标订单在本 tick 落账轮到自己之前已被他人吃光或被卖方撤销；',
          '尝试吃自己公司挂出的订单（禁止自成交）；',
          '违反价格优先规则：同一站点同一物品的对手盘中还存在价格更优的其他公司挂单（不能跳过买一/卖一去吃深度更差的挂单）；',
          '吃卖单时本公司现金不足，或吃买单时本公司在该站点的可用库存不足。',
        ],
      },
      {
        kind: 'example',
        caption: '吃掉 Hub 价格最优且未超预算的卖单',
        code: `module.exports.loop = function () {
  const asks = Game.market
    .getAllOrders({ stationId: 'ST:HUB', resourceType: RESOURCE_STEEL, type: ORDER_SELL })
    .filter((o) => o.ownerId !== Game.company.id)
    .sort((a, b) => a.price - b.price);

  const best = asks[0];
  if (!best) return;

  const qty = Math.min(best.amount, 10);
  if (Game.market.credits >= best.price * qty) {
    const rc = Game.market.deal(best.id, qty);
    if (rc !== OK) console.warn('吃单失败:', rc);
  }
};`,
      },
      {
        kind: 'links',
        items: [
          { label: 'Game.market.getAllOrders', id: 'Game.market.getAllOrders' },
          { label: 'MarketOrder', id: 'MarketOrder' },
          { label: '核心经济规则', id: 'guides/economy' },
        ],
      },
    ],
  },
  {
    id: 'Game.market.calcRoute',
    title: 'calcRoute',
    group: 'Game 接口',
    parent: 'Game.market',
    kind: '方法',
    summary: '估算两地之间的航线耗时与小船基准燃料消耗',
    keywords: 'Game.market.calcRoute 航线 耗时 油耗 燃料 距离',
    blocks: [
      {
        kind: 'prose',
        text: '根据本 tick 行星与枢纽站的实时轨道坐标，查询两地之间的航行耗时与基准燃料消耗。没有可行直达航线时返回 `null`。',
      },
      {
        kind: 'syntax',
        code: 'Game.market.calcRoute(fromId: string, toId: string): RouteCost | null',
      },
      {
        kind: 'params',
        rows: [
          { name: 'fromId', type: 'string', required: 'required', desc: '出发地 ID：行星地面（如 `\'P2\'`）、轨道站（如 `\'ST:P2\'`）或枢纽站（如 `\'ST:HUB\'`）' },
          { name: 'toId', type: 'string', required: 'required', desc: '目的地 ID（格式同上；仅支持同星地面 ↔ 轨道站、同星系轨道站 ↔ 枢纽站）' },
        ],
      },
      {
        kind: 'returns',
        type: 'RouteCost | null',
        desc: '存在可行航线时返回 `{ ticks, fuel }`；不可达、`fromId === toId` 或参数非字符串时返回 `null`',
      },
      {
        kind: 'note',
        level: 'warn',
        title: '船型与耐久差异说明',
        text: '`calcRoute` 返回的 `ticks` 与 `fuel` 均按**小货船（small）与满耐久**估算：在地面 ↔ 轨道站航段，中型船（medium）的起降耗时与油耗约为小船的 **2 倍**，大型船（large）约为 **4 倍**；在星际航段（`ST:P* ↔ ST:HUB`），油耗与船型无关。此外，耐久降至 `0` 的飞船耗时翻倍，但不额外增加油耗。',
      },
      {
        kind: 'example',
        caption: '将地面仓钢材装上空闲小货船运往轨道站',
        code: `module.exports.loop = function () {
  const pid = Game.company.homePlanetId;
  const stationId = 'ST:' + pid;
  const route = Game.market.calcRoute(pid, stationId);
  const ship = Object.values(Game.ships).find((s) => !s.isBusy && s.location === pid);
  if (!route || !ship) return;

  const ground = Game.planets[pid].groundStore;
  const fuelNeed = ship.size === 'large' ? route.fuel * 4 : ship.size === 'medium' ? route.fuel * 2 : route.fuel;
  const qty = Math.min(ground[RESOURCE_STEEL], ship.capacity);

  if (qty > 0 && ground[RESOURCE_FUEL] >= fuelNeed) {
    ship.dispatch(pid, stationId, { [RESOURCE_STEEL]: qty });
  }
};`,
      },
      {
        kind: 'links',
        items: [
          { label: 'RouteCost', id: 'RouteCost' },
          { label: 'Ship.dispatch', id: 'Ship.dispatch' },
          { label: 'Game.ships', id: 'Game.ships' },
        ],
      },
    ],
  },
  {
    id: 'Game.market.getLandPlots',
    title: 'getLandPlots',
    group: 'Game 接口',
    parent: 'Game.market',
    kind: '方法',
    summary: '查询指定行星的全部公开地表位置（含坐标、地形加成、归属与价格）',
    keywords: 'Game.market.getLandPlots 地块 土地 坐标 地形 加成 slotId listingId',
    blocks: [
      {
        kind: 'prose',
        text: '返回指定行星表面全部公开格点（包括城市区、未开发空地、在售挂牌地和已开发企业地块）。每个格点包含永久位置编号 `slotId`、经纬度 `(lat, lon)`、槽位容量与地形效率加成，可与 `Game.buyPlot` 配合实现精准选址购买。',
      },
      {
        kind: 'syntax',
        code: 'Game.market.getLandPlots(planetId: string): PublicLandPlot[] | null',
      },
      {
        kind: 'params',
        rows: [
          { name: 'planetId', type: 'string', required: 'required', desc: '行星 ID，如 `\'P2\'`' },
        ],
      },
      {
        kind: 'returns',
        type: 'PublicLandPlot[] | null',
        desc: '存在该行星时返回 `PublicLandPlot` 数组；`planetId` 非法或行星不存在时返回 `null`',
      },
      {
        kind: 'example',
        caption: '筛选槽位 ≥ 4 且矿冶加成最高的一手空地',
        code: `module.exports.loop = function () {
  const pid = Game.company.homePlanetId;
  const plots = Game.market.getLandPlots(pid);
  if (!plots) return;

  const best = plots
    .filter((t) => t.status === 'unclaimed' && t.capacity >= 4 && t.price !== null)
    .sort((a, b) => (b.buildingMods.mine_smelter || 0) - (a.buildingMods.mine_smelter || 0))[0];

  if (best && best.price !== null && Game.company.cash >= best.price) {
    Game.buyPlot(pid, { slotId: best.slotId });
  }
};`,
      },
      {
        kind: 'links',
        items: [
          { label: 'PublicLandPlot', id: 'PublicLandPlot' },
          { label: 'Game.buyPlot', id: 'Game.buyPlot' },
          { label: 'Plot', id: 'Plot' },
        ],
      },
    ],
  },
  {
    id: 'Game.market.listCompanies',
    title: 'listCompanies',
    group: 'Game 接口',
    parent: 'Game.market',
    kind: '方法',
    summary: '筛选并分页列出全星系公司的公开商业摘要（按净流动资产降序）',
    keywords: 'Game.market.listCompanies 公司 列表 排行 搜索 对手 情报',
    blocks: [
      {
        kind: 'prose',
        text: '按公开净流动资产从高到低返回星系内公司的公开摘要列表，支持关键字搜索、按母星过滤、仅看玩家公司以及分页。不会返回各公司的现金/存款/负债明细或仓库库存。',
      },
      {
        kind: 'syntax',
        code: 'Game.market.listCompanies(filter?: {\n  query?: string;\n  planetId?: string;\n  onlyPlayers?: boolean;\n  offset?: number;\n  limit?: number;\n}): PublicCompanySummary[]',
      },
      {
        kind: 'params',
        rows: [
          { name: 'filter', type: 'object', required: 'optional', desc: '可选筛选与分页参数对象；省略时按默认分页返回前 100 家公司' },
          { name: 'filter.query', type: 'string', required: 'optional', desc: '按公司名称、公司 ID 或母星 ID 进行不区分大小写的模糊匹配' },
          { name: 'filter.planetId', type: 'string', required: 'optional', desc: '仅返回母星为该行星 ID 的公司' },
          { name: 'filter.onlyPlayers', type: 'boolean', required: 'optional', desc: '为 `true` 时仅返回玩家公司（过滤掉 NPC 公司）' },
          { name: 'filter.offset', type: 'number', required: 'optional', desc: '分页起始偏移量（非负整数），默认 `0`' },
          { name: 'filter.limit', type: 'number', required: 'optional', desc: '最大返回条数（夹紧在 `1..1000` 之间），默认 `100`' },
        ],
      },
      {
        kind: 'returns',
        type: 'PublicCompanySummary[]',
        desc: '匹配到的公司公开摘要数组；无匹配公司时返回空数组 `[]`',
      },
      {
        kind: 'example',
        caption: '查看同母星净资产排名前 5 的玩家公司',
        code: `module.exports.loop = function () {
  const peers = Game.market.listCompanies({
    planetId: Game.company.homePlanetId,
    onlyPlayers: true,
    limit: 5,
  });
  for (const c of peers) {
    console.log(c.name, '净流动资产:', c.netLiquid.toFixed(1), '地块:', c.plotsCount);
  }
};`,
      },
      {
        kind: 'links',
        items: [
          { label: 'PublicCompanySummary', id: 'PublicCompanySummary' },
          { label: 'Game.market.getCompany', id: 'Game.market.getCompany' },
        ],
      },
    ],
  },
  {
    id: 'Game.market.getCompany',
    title: 'getCompany',
    group: 'Game 接口',
    parent: 'Game.market',
    kind: '方法',
    summary: '查看指定公司的公开商业情报（净流动资产、地块设施分布与活跃挂单）',
    keywords: 'Game.market.getCompany 公司详情 情报 地块 建筑 挂单 舰队',
    blocks: [
      {
        kind: 'prose',
        text: '根据公司 ID 查询目标公司的公开情报，包括净流动资产、名下每块土地上的建筑列表、按类型统计的建筑数量、按船型统计的舰队数量以及该公司全部活跃挂单。不暴露私有财务明细、仓库库存、在产配方或飞船航线。',
      },
      {
        kind: 'syntax',
        code: 'Game.market.getCompany(companyId: string): PublicCompanyDetail | null',
      },
      {
        kind: 'params',
        rows: [
          { name: 'companyId', type: 'string', required: 'required', desc: '目标公司 ID（可从 `listCompanies`、`getAllOrders` 的 `ownerId` 或 `getLandPlots` 的 `ownerId` 获取）' },
        ],
      },
      {
        kind: 'returns',
        type: 'PublicCompanyDetail | null',
        desc: '找到时返回 `PublicCompanyDetail`；`companyId` 非法或不存在时返回 `null`',
      },
      {
        kind: 'example',
        caption: '分析 Hub 钢材最低卖单卖家的生产规模',
        code: `module.exports.loop = function () {
  const orders = Game.market.getAllOrders({
    stationId: 'ST:HUB',
    resourceType: RESOURCE_STEEL,
    type: ORDER_SELL,
  });
  if (orders.length === 0) return;

  const seller = Game.market.getCompany(orders[0].ownerId);
  if (seller) {
    console.log(seller.name, '建筑分布:', seller.buildingCounts, '挂单数:', seller.openOrdersCount);
  }
};`,
      },
      {
        kind: 'links',
        items: [
          { label: 'PublicCompanyDetail', id: 'PublicCompanyDetail' },
          { label: 'Game.market.listCompanies', id: 'Game.market.listCompanies' },
          { label: 'MarketOrder', id: 'MarketOrder' },
        ],
      },
    ],
  },
];

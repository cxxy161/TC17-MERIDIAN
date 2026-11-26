import type { DocEntry } from '../types';

export const MARKET_ENTRIES: DocEntry[] = [
  {
    id: 'Game.market',
    title: 'market',
    group: 'Game 接口',
    kind: '属性',
    summary: '星际交易所与二级土地市场域：盘口行情、订单簿分页查询、挂撤吃单及二手购地',
    keywords: 'Game.market 市场 交易所 盘口 挂单 下单 撤单 吃单 transactions buyLand',
    blocks: [
      {
        kind: 'prose',
        text: '`Game.market` 专注于全星系商品交易与二手地块收购，包含自有挂单 `orders`、上回合个人成交流水 `transactions`，以及行情报价、深度盘口、按页查询/精确检索订单与四大交易写方法。',
      },
      {
        kind: 'syntax',
        code: 'readonly Game.market: MarketAPI',
      },
      {
        kind: 'fields',
        title: '只读属性（Properties）',
        rows: [
          { name: 'orders', type: 'Record<string, MarketOrder>', desc: '本公司当前已落账的全部活跃挂单字典（以订单 ID 为键）' },
          { name: 'transactions', type: 'readonly LastTickFill[]', desc: '上一 tick 本公司参与的真实成交流水列表（与 `Game.lastTick.fills` 相同）' },
        ],
      },
      {
        kind: 'methods',
        title: '查询与交易方法（Methods）',
        rows: [
          { signature: 'Game.market.quote(stationId: string, resourceType: string)', returns: 'MarketQuote | null', desc: '查询指定站点与物品的盘口汇总报价与 EMA', id: 'Game.market.quote' },
          { signature: 'Game.market.depth(stationId: string, resourceType: string, limit?: number)', returns: 'MarketDepth', desc: '查询买卖盘口分档聚合深度（最多 5 档）', id: 'Game.market.depth' },
          { signature: 'Game.market.getAllOrders(filter?: OrderFilter)', returns: 'MarketOrder[]', desc: '按条件与分页筛选全星系活跃挂单', id: 'Game.market.getAllOrders' },
          { signature: 'Game.market.getOrderById(orderId: string | number)', returns: 'MarketOrder | null', desc: '按订单 ID 精确查询全站订单簿中的单笔挂单', id: 'Game.market.getOrderById' },
          { signature: 'Game.market.createOrder(params: CreateOrderParams)', returns: 'RetCode', desc: '在指定站点挂出限价买单或卖单', id: 'Game.market.createOrder' },
          { signature: 'Game.market.cancelOrder(orderId: string | number)', returns: 'RetCode', desc: '撤销本公司的一条活跃挂单并退回托管资金或库存', id: 'Game.market.cancelOrder' },
          { signature: 'Game.market.deal(orderId: string | number, amount: number)', returns: 'RetCode', desc: '直接与全站订单簿中价格优先的对手单成交', id: 'Game.market.deal' },
          { signature: 'Game.market.buyLand(listingId: string | number)', returns: 'RetCode', desc: '按挂牌编号收购二手或银行清算工业地块', id: 'Game.market.buyLand' },
        ],
      },
      {
        kind: 'links',
        items: [
          { label: 'Game.market.quote', id: 'Game.market.quote' },
          { label: 'Game.market.createOrder', id: 'Game.market.createOrder' },
          { label: 'Game.market.deal', id: 'Game.market.deal' },
          { label: 'Game.market.buyLand', id: 'Game.market.buyLand' },
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
    keywords: 'Game.market.orders 我的挂单 活跃订单 64',
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
        text: '每家公司全星系最多同时持有 **64** 条活跃挂单；在同一个 tick 内部，已调用 `cancelOrder` 的挂单会被影账视为释放名额，而新挂单会占用名额。',
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
    id: 'Game.market.transactions',
    title: 'transactions',
    group: 'Game 接口',
    parent: 'Game.market',
    kind: '属性',
    summary: '上一 tick 本公司真实成交的买卖流水数组（等价于 Game.lastTick.fills）',
    keywords: 'Game.market.transactions 成交 流水 fills fee buyerRefund',
    blocks: [
      {
        kind: 'prose',
        text: '包含上一 tick 结算期间本公司作为买方或卖方真实撮合成交的每笔流水，记录成交站点、物品、数量、真实成交价、名义总额、手续费以及买方差价退款。',
      },
      {
        kind: 'syntax',
        code: 'readonly Game.market.transactions: readonly LastTickFill[]',
      },
      {
        kind: 'example',
        caption: '记录上一 tick 卖货收入扣除交易税后的净入账',
        code: `module.exports.loop = function () {
  let netSell = 0;
  for (const tx of Game.market.transactions) {
    if (tx.side === ORDER_SELL) netSell += tx.notional - tx.fee;
  }
  if (netSell > 0) console.log('上回合卖出净回款:', netSell.toFixed(2));
};`,
      },
      {
        kind: 'links',
        items: [
          { label: 'LastTickFeedback', id: 'LastTickFeedback' },
          { label: 'Game.lastTick', id: 'Game.lastTick' },
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
        text: '即使返回的 `MarketQuote` 不为 `null`，当某一侧盘口无挂单时，`bestBid` 或 `bestAsk` 仍为 `null`。计算价差前请同时对两边判非空。',
      },
      {
        kind: 'example',
        caption: '读取枢纽站钢材买卖价差',
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
    summary: '查询指定站点与物品的分档聚合盘口深度（默认最多 5 档）',
    keywords: 'Game.market.depth 盘口 深度 bids asks 档位',
    blocks: [
      {
        kind: 'prose',
        text: '按价格聚合并返回指定站点与物品的买盘（价格降序）和卖盘（价格升序）各最多 `5` 档挂单深度。',
      },
      {
        kind: 'syntax',
        code: 'Game.market.depth(stationId: string, resourceType: string, limit?: number): MarketDepth',
      },
      {
        kind: 'params',
        rows: [
          { name: 'stationId', type: 'string', required: 'required', desc: '站点 ID，如 `\'ST:HUB\'`、`\'ST:P2\'`' },
          { name: 'resourceType', type: 'string', required: 'required', desc: '物品 ID 或 `RESOURCE_*` 常量' },
          { name: 'limit', type: 'number', required: 'optional', desc: '期望返回档数，默认 `5`，最大截断到 `5`' },
        ],
      },
      {
        kind: 'returns',
        type: 'MarketDepth',
        desc: '返回含 `bids` 与 `asks` 的深度对象；不存在挂单或参数无效时两数组为空 `{ bids: [], asks: [] }`',
        fields: [
          { name: 'bids', type: 'Array<{ price: number; qty: number }>', desc: '买盘各档位汇总（按价格从高到低）' },
          { name: 'asks', type: 'Array<{ price: number; qty: number }>', desc: '卖盘各档位汇总（按价格从低到高）' },
        ],
      },
      {
        kind: 'example',
        caption: '估算连续吃进 30 单位钢材的加权平均成交价',
        code: `module.exports.loop = function () {
  const book = Game.market.depth('ST:HUB', RESOURCE_STEEL, 5);
  let need = 30;
  let cost = 0;
  for (const level of book.asks) {
    const take = Math.min(need, level.qty);
    cost += take * level.price;
    need -= take;
    if (need === 0) break;
  }
  console.log('未满足数量:', need, '预计花费:', cost);
};`,
      },
      {
        kind: 'links',
        items: [
          { label: 'Game.market.quote', id: 'Game.market.quote' },
          { label: 'Game.market.deal', id: 'Game.market.deal' },
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
    summary: '按站点、物品、买卖方向与分页范围检索全星系活跃挂单',
    keywords: 'Game.market.getAllOrders 订单簿 挂单 筛选 分页 offset limit',
    blocks: [
      {
        kind: 'prose',
        text: '从全星系活跃订单簿按可选条件过滤并分页返回挂单详情。为防止单次返回全站所有挂单耗尽沙盒内存，默认单页上限为 `200` 条（最大可显式请求 `1000` 条）。',
      },
      {
        kind: 'syntax',
        code: `Game.market.getAllOrders(filter?: {
  stationId?: string;
  resourceType?: string;
  type?: 'buy' | 'sell';
  offset?: number;
  limit?: number;
}): MarketOrder[]`,
      },
      {
        kind: 'params',
        rows: [
          { name: 'filter', type: 'object', required: 'optional', desc: '可选筛选与分页参数；省略时默认最多返回前 `200` 条活跃订单' },
          { name: 'filter.stationId', type: 'string', required: 'optional', desc: '按站点过滤，如 `\'ST:HUB\'`、`\'ST:P2\'`' },
          { name: 'filter.resourceType', type: 'string', required: 'optional', desc: '按物品过滤，如 `RESOURCE_STEEL`' },
          { name: 'filter.type', type: '\'buy\' | \'sell\'', required: 'optional', desc: '按买卖方向过滤（`ORDER_BUY` / `ORDER_SELL`）' },
          { name: 'filter.offset', type: 'number', required: 'optional', desc: '分页起始下标，默认 `0`' },
          { name: 'filter.limit', type: 'number', required: 'optional', desc: '本页最多返回条数，默认 `200`，上限 `1000`' },
        ],
      },
      {
        kind: 'returns',
        type: 'MarketOrder[]',
        desc: '匹配的挂单数组；筛选条件无匹配时返回空数组 `[]`',
      },
      {
        kind: 'example',
        caption: '找到枢纽站价格最低的竞争对手钢材卖单并吃单',
        code: `module.exports.loop = function () {
  const asks = Game.market
    .getAllOrders({ stationId: 'ST:HUB', resourceType: RESOURCE_STEEL, type: ORDER_SELL, limit: 100 })
    .filter((o) => o.ownerId !== Game.company.id)
    .sort((a, b) => a.price - b.price || a.created - b.created);

  if (asks.length > 0 && asks[0].price <= 15) {
    Game.market.deal(asks[0].id, Math.min(10, asks[0].amount));
  }
};`,
      },
      {
        kind: 'links',
        items: [
          { label: 'MarketOrder', id: 'MarketOrder' },
          { label: 'Game.market.getOrderById', id: 'Game.market.getOrderById' },
          { label: 'Game.market.deal', id: 'Game.market.deal' },
        ],
      },
    ],
  },
  {
    id: 'Game.market.getOrderById',
    title: 'getOrderById',
    group: 'Game 接口',
    parent: 'Game.market',
    kind: '方法',
    summary: '按订单 ID 直接检索全站活跃订单簿中的单笔挂单',
    keywords: 'Game.market.getOrderById orderId 查询 订单 精确',
    blocks: [
      {
        kind: 'prose',
        text: '直接传入订单编号查询其在当前 tick 的最新挂单快照。适合跟踪长期关注的特定挂单或确认 `Memory` 中保存的目标单是否仍然活跃。',
      },
      {
        kind: 'syntax',
        code: 'Game.market.getOrderById(orderId: string | number): MarketOrder | null',
      },
      {
        kind: 'params',
        rows: [
          { name: 'orderId', type: 'string | number', required: 'required', desc: '订单 ID（字符串或可转为正整数的数字）' },
        ],
      },
      {
        kind: 'returns',
        type: 'MarketOrder | null',
        desc: '若订单仍处于活跃订单簿则返回 `MarketOrder`；已完全成交、已撤单或 ID 无效时返回 `null`',
      },
      {
        kind: 'example',
        caption: '追踪记忆中保存的目标挂单剩余可吃数量',
        code: `module.exports.loop = function () {
  if (!Memory.watchOrderId) return;
  const ord = Game.market.getOrderById(Memory.watchOrderId);
  if (!ord) {
    console.log('跟踪订单已结束:', Memory.watchOrderId);
    delete Memory.watchOrderId;
  } else {
    console.log('订单剩余:', ord.amount, '/', ord.totalAmount, '单价:', ord.price);
  }
};`,
      },
      {
        kind: 'links',
        items: [
          { label: 'MarketOrder', id: 'MarketOrder' },
          { label: 'Game.market.getAllOrders', id: 'Game.market.getAllOrders' },
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
    summary: '在指定站点挂出限价买单或卖单，并同步通过影账预扣资金或货品',
    keywords: 'Game.market.createOrder 挂单 买单 卖单 限价 下单',
    blocks: [
      {
        kind: 'prose',
        text: '在指定空间站按固定单价提交限价买单或卖单。卖单在普通物品上要求对应 `stationId` 库存充足；即时物品（`power`、`disposal_cert`）在行星轨道站库存不足时允许自动从对应行星地面仓补扣。',
      },
      {
        kind: 'syntax',
        code: `Game.market.createOrder(params: {
  type: 'buy' | 'sell';
  resourceType: string;
  price: number;
  totalAmount: number;
  stationId: string;
}): RetCode`,
      },
      {
        kind: 'params',
        rows: [
          { name: 'params', type: 'object', required: 'required', desc: '下单参数对象' },
          { name: 'params.type', type: '\'buy\' | \'sell\'', required: 'required', desc: '买卖方向：`ORDER_BUY`（买单）或 `ORDER_SELL`（卖单）' },
          { name: 'params.resourceType', type: 'string', required: 'required', desc: '物品 ID 或 `RESOURCE_*` 常量' },
          { name: 'params.price', type: 'number', required: 'required', desc: '限价单价（须在 `(0, min(refPrice * 100, 1_000_000)]` 价格带内，精确到 `1 / MONEY_SCALE`）' },
          { name: 'params.totalAmount', type: 'number', required: 'required', desc: '挂单数量，将向下取整至正整数，范围 `1..10000`' },
          { name: 'params.stationId', type: 'string', required: 'required', desc: '交易空间站 ID，如 `\'ST:HUB\'` 或 `\'ST:P2\'`' },
        ],
      },
      {
        kind: 'returns',
        type: 'RetCode',
        desc: '返回 `OK` 表示通过价格带、防自成交及影账校验并入队；否则返回对应负数错误码',
      },
      {
        kind: 'errors',
        rows: [
          { code: 'ERR_INVALID_ARGS', when: '字段缺失、方向非法、`totalAmount <= 0` 或 `> 10000`、`price` 舍入后 `<= 0` 或超出站内价格带（100 倍参考价或 `1,000,000` 封顶）' },
          { code: 'ERR_INVALID_TARGET', when: '物品或站点不存在，或新单价格与自己在同站同物品现存反向活跃挂单价格交叉（禁止自成交）' },
          { code: 'ERR_FULL', when: '全星系活跃挂单计入本 tick 新挂后达到 `64` 条上限，或本 tick `32` 条写配额已满' },
          { code: 'ERR_NOT_ENOUGH_CREDITS', when: '挂买单时可用现金（含影账扣减后）不足 `price * totalAmount`' },
          { code: 'ERR_NOT_ENOUGH_RESOURCES', when: '挂卖单时站点库存（及即时物品地面可补仓）计入影账扣减后不足 `totalAmount`' },
        ],
      },
      {
        kind: 'settlement',
        items: [
          '同 tick 若先提交了先出价买单/建厂费用，或前序意图扣费导致落账顺序到该单时实际资金/货物/活跃订单槽位不足，将落入 `Game.lastTick.rejected`；',
          '同 tick 连续提交正反两张价格交叉的自有新单时，第二张会在落账撮合拦截自成交并返回错误。',
        ],
      },
      {
        kind: 'example',
        caption: '在枢纽站以略高于买一价的价格挂单采购钢材',
        code: `module.exports.loop = function () {
  const q = Game.market.quote('ST:HUB', RESOURCE_STEEL);
  if (!q) return;
  const price = Math.round((q.bestBid ? q.bestBid + 0.05 : q.lastPrice * 0.98) * MONEY_SCALE) / MONEY_SCALE;
  const qty = 20;
  if (Game.company.cash >= price * qty) {
    const rc = Game.market.createOrder({
      type: ORDER_BUY,
      resourceType: RESOURCE_STEEL,
      price,
      totalAmount: qty,
      stationId: 'ST:HUB',
    });
    if (rc !== OK) console.warn('createOrder 失败:', rc);
  }
};`,
      },
      {
        kind: 'links',
        items: [
          { label: 'ORDER_BUY / ORDER_SELL', id: 'constants/order-sides' },
          { label: 'MONEY_SCALE', id: 'constants/money-scale' },
          { label: 'Game.market.cancelOrder', id: 'Game.market.cancelOrder' },
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
    summary: '撤销本公司一条尚未结束的活跃挂单，释放托管资金或库存',
    keywords: 'Game.market.cancelOrder 撤单 退回 挂单',
    blocks: [
      {
        kind: 'prose',
        text: '撤销 `Game.market.orders` 中本公司的一条活跃挂单。买单撤单后未成交托管现金退回可用现金；卖单未成交托管货品退回原站点仓库（即时物品退回行星地面）。',
      },
      {
        kind: 'syntax',
        code: 'Game.market.cancelOrder(orderId: string | number): RetCode',
      },
      {
        kind: 'params',
        rows: [
          { name: 'orderId', type: 'string | number', required: 'required', desc: '待撤销的自有订单 ID' },
        ],
      },
      {
        kind: 'returns',
        type: 'RetCode',
        desc: '返回 `OK` 表示撤单请求已受理；否则返回负数错误码',
      },
      {
        kind: 'errors',
        rows: [
          { code: 'ERR_INVALID_ARGS', when: '`orderId` 缺失或无法解析为正整数订单号' },
          { code: 'ERR_NOT_FOUND', when: '该订单不在本公司活跃挂单 `Game.market.orders` 中，或本 tick 已被撤单一次' },
          { code: 'ERR_FULL', when: '本 tick 写操作配额（32 条）已满' },
        ],
      },
      {
        kind: 'settlement',
        items: [
          '落账阶段如该挂单已在撮合序列中被前序吃单完全成交，本次撤单将作为空目标跳过（不产生副作用）。',
        ],
      },
      {
        kind: 'example',
        caption: '撤掉开盘价远低于买一价的旧买单',
        code: `module.exports.loop = function () {
  for (const ord of Object.values(Game.market.orders)) {
    const q = Game.market.quote(ord.stationId, ord.resourceType);
    if (ord.type === ORDER_BUY && q && q.bestBid !== null && ord.price < q.bestBid * 0.8) {
      Game.market.cancelOrder(ord.id);
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
    summary: '直接与全站订单簿中指定的最优价格对手挂单即时吃单成交',
    keywords: 'Game.market.deal 吃单 成交 对手单 价格优先',
    blocks: [
      {
        kind: 'prose',
        text: '直接按对手挂单的价格与位置主动成交指定数量（自动截断到对手单剩余数量与单笔上限 `10000` 内）。必须严格遵守**价格优先**规则，不能跳过价格更优的其他对手挂单直接与较差价单成交。',
      },
      {
        kind: 'syntax',
        code: 'Game.market.deal(orderId: string | number, amount: number): RetCode',
      },
      {
        kind: 'params',
        rows: [
          { name: 'orderId', type: 'string | number', required: 'required', desc: '来自 `getAllOrders` 或 `getOrderById` 的对手订单 ID' },
          { name: 'amount', type: 'number', required: 'required', desc: '期望成交数量（正数，向下取整并自动按挂单余量截断）' },
        ],
      },
      {
        kind: 'returns',
        type: 'RetCode',
        desc: '返回 `OK` 表示通过价格优先、价格带及影账资源检查并已入队；否则返回负数错误码',
      },
      {
        kind: 'errors',
        rows: [
          { code: 'ERR_INVALID_ARGS', when: '`orderId` 无效或 `amount` 非正数' },
          { code: 'ERR_NOT_FOUND', when: '目标挂单不存在、已结清，或本 tick 影账已将对手余量吃空' },
          { code: 'ERR_INVALID_TARGET', when: '目标为本公司自有单、同站同物存在价格更优的其他对手挂单、目标单价格超出现行价格带，或对手买单托管现金不足' },
          { code: 'ERR_NOT_ENOUGH_CREDITS', when: '吃对方卖单买货时可用现金（含影账）不足' },
          { code: 'ERR_NOT_ENOUGH_RESOURCES', when: '吃对方买单卖货时站点（含即时物品地面补仓）可用库存不足' },
          { code: 'ERR_FULL', when: '本 tick 写操作配额（32 条）已满' },
        ],
      },
      {
        kind: 'settlement',
        items: [
          '落账阶段如其他竞争公司先一步吃光了该对手挂单，或卖方中途撤单，将写入 `Game.lastTick.rejected` 报 `ERR_NOT_FOUND` 或 `ERR_INVALID_TARGET`。',
        ],
      },
      {
        kind: 'example',
        caption: '快速采购 Hub 最便宜的 15 单位建筑建材',
        code: `module.exports.loop = function () {
  const asks = Game.market
    .getAllOrders({ stationId: 'ST:HUB', resourceType: RESOURCE_BUILDING_MAT, type: ORDER_SELL, limit: 50 })
    .filter((o) => o.ownerId !== Game.company.id)
    .sort((a, b) => a.price - b.price);

  if (asks.length > 0 && asks[0].price <= 30) {
    const qty = Math.min(15, asks[0].amount);
    const rc = Game.market.deal(asks[0].id, qty);
    if (rc === OK) console.log('已吃单建材:', qty, '@', asks[0].price);
  }
};`,
      },
      {
        kind: 'links',
        items: [
          { label: 'Game.market.getAllOrders', id: 'Game.market.getAllOrders' },
          { label: 'Game.market.getOrderById', id: 'Game.market.getOrderById' },
          { label: '核心经济规则', id: 'guides/economy' },
        ],
      },
    ],
  },
  {
    id: 'Game.market.buyLand',
    title: 'buyLand',
    group: 'Game 接口',
    parent: 'Game.market',
    kind: '方法',
    summary: '按挂牌编号收购其他公司挂售或银行清算中的二手工业地块',
    keywords: 'Game.market.buyLand 买地 二手地 清算 listingId landListings',
    blocks: [
      {
        kind: 'prose',
        text: '直接购入全星系任意行星上的二手挂牌地块或银行清算地块（`listingId` 可从 `planet.landListings` 或 `Game.map.getLandPlots` 读取）。地块上原有的槽位及遗留设施归属一并转移到买方名下。',
      },
      {
        kind: 'syntax',
        code: 'Game.market.buyLand(listingId: string | number): RetCode',
      },
      {
        kind: 'params',
        rows: [
          { name: 'listingId', type: 'string | number', required: 'required', desc: '来自 `planet.landListings[].listingId` 或 `getLandPlots()` 的挂牌 ID' },
        ],
      },
      {
        kind: 'returns',
        type: 'RetCode',
        desc: '返回 `OK` 表示通过影账资金与可购校验并已入队；否则返回负数错误码',
      },
      {
        kind: 'errors',
        rows: [
          { code: 'ERR_INVALID_ARGS', when: '`listingId` 缺失或无法解析为正整数 ID' },
          { code: 'ERR_NOT_FOUND', when: '全星系当前不存在此挂牌编号，或本 tick 已被同脚本买走' },
          { code: 'ERR_INVALID_TARGET', when: '试图购买本公司自己挂售的地块' },
          { code: 'ERR_NOT_ENOUGH_CREDITS', when: '可用现金不足挂牌要价 `askPrice`，或当前公司有逾期未还贷款' },
          { code: 'ERR_FULL', when: '本 tick 写操作配额（32 条）已满' },
        ],
      },
      {
        kind: 'settlement',
        items: [
          '卖家同 tick 下架挂牌或被其他买家抢先成交，将在落账阶段失败并在 `Game.lastTick.rejected` 返回 `ERR_NOT_FOUND`；',
          '落账时刻实际可用现金不足以支付要价 `askPrice`。',
        ],
      },
      {
        kind: 'example',
        caption: '在母星捡漏价格低于一手地价且已带工厂的二手挂牌地',
        code: `module.exports.loop = function () {
  const home = Game.planets[Game.company.homePlanetId];
  if (!home) return;
  const maxBid = home.primaryLandPrice || 500;
  const dealPlot = home.landListings.find(
    (l) => l.sellerId !== Game.company.id && l.buildings.length > 0 && l.price <= maxBid * 1.2
  );
  if (dealPlot && Game.company.cash >= dealPlot.price) {
    const rc = Game.market.buyLand(dealPlot.listingId);
    if (rc === OK) console.log('收购二手带厂地块:', dealPlot.listingId, '价格:', dealPlot.price);
  }
};`,
      },
      {
        kind: 'links',
        items: [
          { label: 'Planet', id: 'Planet' },
          { label: 'Game.map.buyPlot', id: 'Game.map.buyPlot' },
          { label: 'Plot', id: 'Plot' },
        ],
      },
    ],
  },
];

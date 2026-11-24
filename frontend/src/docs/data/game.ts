import type { DocEntry } from '../types';

export const GAME_ENTRIES: DocEntry[] = [
  {
    id: 'Game',
    title: 'Game',
    group: 'Game',
    kind: '属性',
    summary: '脚本的世界入口：只读状态 + 写方法',
    keywords: 'Game 全局 入口 世界状态',
    blocks: [
      {
        kind: 'prose',
        text: '`Game` 是每个 tick 的世界入口。它同时提供两类东西：**只读状态**（本 tick 开始时的快照）和**写方法**（把操作写进本 tick 的 Intent 缓冲）。',
      },
      {
        kind: 'fields',
        rows: [
          { name: 'time', type: 'number', desc: '当前 tick 序号' },
          { name: 'cpi', type: 'number', desc: '全星系物价指数' },
          { name: 'cpu', type: 'object', desc: 'CPU 预算与已用量' },
          { name: 'company', type: 'object', desc: '自己的公司：现金、储蓄、负债' },
          { name: 'planets', type: 'Record<string, Planet>', desc: '全部行星（含别人所在的）' },
          { name: 'plots', type: 'Record<string, Plot>', desc: '自己的地块' },
          { name: 'stations', type: 'Record<string, Station>', desc: '有库存记录的站点' },
          { name: 'buildings', type: 'Record<string, Building>', desc: '自己的设施' },
          { name: 'ships', type: 'Record<string, Ship>', desc: '自己的飞船' },
          { name: 'market', type: 'MarketAPI', desc: '市场查询与下单' },
        ],
      },
      {
        kind: 'note',
        level: 'warn',
        text: '`Game` 和它下面的实体对象都被 Object.freeze 冻结：给它们挂自定义字段在非严格模式下静默失败。要存状态请写 `Memory`。',
      },
      {
        kind: 'links',
        items: [
          { label: 'Game.time', id: 'Game.time' },
          { label: 'Game.planets', id: 'Game.planets' },
          { label: 'Game.market', id: 'Game.market' },
          { label: 'Game.buyPlot', id: 'Game.buyPlot' },
        ],
      },
    ],
  },
  {
    id: 'Game.time',
    title: 'time',
    group: 'Game',
    kind: '属性',
    summary: '当前 tick 序号',
    keywords: 'tick 时间 回合 序号 计时',
    blocks: [
      {
        kind: 'prose',
        text: '本 tick 的序号，从 0 开始单调递增。保存热重载不会重置它，也不会重置世界。',
      },
      { kind: 'syntax', code: 'Game.time: number' },
      {
        kind: 'example',
        code: `if (Game.time % 20 === 0) {
  console.log('每 20 tick 打印一次', Game.time);
}`,
      },
      {
        kind: 'links',
        items: [
          { label: '快速开始', id: 'overview/quickstart' },
          { label: 'Memory', id: 'Memory' },
        ],
      },
    ],
  },
  {
    id: 'Game.cpi',
    title: 'cpi',
    group: 'Game',
    kind: '属性',
    summary: '全星系物价指数',
    keywords: 'cpi 物价 指数 通胀 折算',
    blocks: [
      {
        kind: 'prose',
        text: '全星系物价指数，用来把历史成交价折算到当前物价水平。开局接近 1，长期随经济体的货币量变化。',
      },
      { kind: 'syntax', code: 'Game.cpi: number' },
      {
        kind: 'example',
        code: `const q = Game.market.quote('ST:HUB', RESOURCE_STEEL);
if (q) {
  // 把名义价折算成"开局购买力"下的真实价
  const real = q.lastPrice / Game.cpi;
  console.log('真实钢价', real);
}`,
      },
      {
        kind: 'note',
        level: 'info',
        text: '这是宏观指数，不是某个物品的价格；单个物品的行情看 `Game.market.quote`。',
      },
      {
        kind: 'links',
        items: [
          { label: 'Game.market.quote', id: 'Game.market.quote' },
          { label: 'Game.market', id: 'Game.market' },
        ],
      },
    ],
  },
  {
    id: 'Game.cpu',
    title: 'cpu',
    group: 'Game',
    kind: '属性',
    summary: 'CPU 预算与已用墙钟毫秒',
    keywords: 'cpu 性能 5ms 预算 getUsed 超时',
    blocks: [
      {
        kind: 'prose',
        text: 'CPU 预算与用量。`limit` 是本 tick 允许的墙钟毫秒数（默认 5），`getUsed()` 返回本 tick 已经用掉的毫秒数，包含 prelude 加载与宿主绑定开销。',
      },
      {
        kind: 'fields',
        rows: [
          { name: 'limit', type: 'number', desc: '本 tick 的毫秒预算' },
          { name: 'getUsed()', type: '() => number', desc: '本 tick 已用毫秒数（墙钟）' },
        ],
      },
      {
        kind: 'example',
        code: `if (Game.cpu.getUsed() > Game.cpu.limit * 0.8) {
  console.log('本 tick 预算快用完，提前 return');
  return;
}`,
      },
      {
        kind: 'note',
        level: 'danger',
        text: '超时后果很重：本 tick 的全部 Intent 被丢弃，Memory 回滚到上一 tick（日志保留）。5ms 是墙钟，不是 CPU 指令数。',
      },
      {
        kind: 'links',
        items: [
          { label: 'quotas', id: 'quotas' },
          { label: '硬性上限', id: 'overview/limits' },
        ],
      },
    ],
  },
  {
    id: 'Game.company',
    title: 'company',
    group: 'Game',
    kind: '属性',
    summary: '自己公司的资金与身份',
    keywords: 'company 公司 现金 cash 储蓄 savings 负债 debt 职业',
    blocks: [
      {
        kind: 'prose',
        text: '自己公司的身份与资金。金额单位是信用点（credits）。',
      },
      {
        kind: 'fields',
        rows: [
          { name: 'id', type: 'string', desc: '公司 id' },
          { name: 'name', type: 'string', desc: '公司名' },
          { name: 'profession', type: 'string', desc: '职业：如 env_recycle / agri_bio / mining_ind' },
          { name: 'homePlanetId', type: 'string', desc: '母星 id' },
          { name: 'cash', type: 'number', desc: '现金' },
          { name: 'savings', type: 'number', desc: '储蓄' },
          { name: 'debt', type: 'number', desc: '负债' },
        ],
      },
      {
        kind: 'note',
        level: 'warn',
        text: '`cash` 是本 tick 开始时的快照：下单、建造、存取款都不会让它在本 tick 内变化，下一 tick 才看得到结果。',
      },
      {
        kind: 'links',
        items: [
          { label: 'Game.bank', id: 'Game.bank' },
          { label: 'Game.market.credits', id: 'Game.market.credits' },
        ],
      },
    ],
  },
  {
    id: 'Game.planets',
    title: 'planets',
    group: 'Game',
    kind: '属性',
    summary: '全部行星的遥测与仓库',
    keywords: 'planets 行星 星球 需求 demands 仓库 土地',
    blocks: [
      {
        kind: 'prose',
        text: '全星系所有行星（不只自己的），键是行星 id，值见 `Planet`。',
      },
      {
        kind: 'example',
        code: `for (const p of Object.values(Game.planets)) {
  const want = p.demands[RESOURCE_STEEL] && p.demands[RESOURCE_STEEL].qty;
  if (want > 0) console.log(p.name, '本回合需要钢材', want);
}`,
      },
      {
        kind: 'note',
        level: 'warn',
        text: '`demands[item]` 只有 `qty`，**没有 satisfaction**（旧文档写错了）。星球仓库没有容量上限，`groundStore.getCapacity()` 恒为 `null`。',
      },
      {
        kind: 'links',
        items: [
          { label: 'Planet', id: 'Planet' },
          { label: 'RESOURCE_<ID>', id: 'RESOURCE_<ID>' },
          { label: 'Game.buyPlot', id: 'Game.buyPlot' },
        ],
      },
    ],
  },
  {
    id: 'Game.plots',
    title: 'plots',
    group: 'Game',
    kind: '属性',
    summary: '自己名下地块与剩余槽位',
    keywords: 'plots 地块 土地 槽位 capacity usedSlots terrain',
    blocks: [
      {
        kind: 'prose',
        text: '自己名下的地块，键是地块 id。`capacity` 与 `usedSlots` 决定还能建几座设施。',
      },
      {
        kind: 'example',
        code: `for (const plot of Object.values(Game.plots)) {
  if (plot.usedSlots < plot.capacity) {
    const rc = Game.buildFacility(plot.id, 'mine_smelter');
    if (rc !== OK) console.log('建造失败', plot.id, rc);
  }
}`,
      },
      {
        kind: 'note',
        level: 'info',
        text: '只包含自己的地块；`buildingMods` 是地形对各类建筑的效率修正（乘数）。',
      },
      {
        kind: 'links',
        items: [
          { label: 'Plot', id: 'Plot' },
          { label: 'Game.buildFacility', id: 'Game.buildFacility' },
          { label: 'Game.buyPlot', id: 'Game.buyPlot' },
        ],
      },
    ],
  },
  {
    id: 'Game.stations',
    title: 'stations',
    group: 'Game',
    kind: '属性',
    summary: '本公司有库存记录的站点',
    keywords: 'stations 站点 轨道站 hub 仓库 库存',
    blocks: [
      {
        kind: 'prose',
        text: '本公司有库存记录的站点，键是站点 id（`ST:HUB`、`ST:P1`…），值见 `Station`。**不是**全星系站点表。',
      },
      {
        kind: 'example',
        code: `for (const sid of Object.keys(Game.stations)) {
  const st = Game.stations[sid];
  console.log(sid, '钢材库存', st.store[RESOURCE_STEEL] || 0);
}`,
      },
      {
        kind: 'note',
        level: 'warn',
        text: '新公司可能连 `ST:HUB` 都没有——不要假设某个站点键一定存在。站点仓库同样没有容量上限。',
      },
      {
        kind: 'links',
        items: [
          { label: 'Station', id: 'Station' },
          { label: 'Store', id: 'Store' },
          { label: 'Game.ships', id: 'Game.ships' },
        ],
      },
    ],
  },
  {
    id: 'Game.buildings',
    title: 'buildings',
    group: 'Game',
    kind: '属性',
    summary: '自己的设施、配方与生产进度',
    keywords: 'buildings 建筑 设施 工厂 配方 生产 进度',
    blocks: [
      {
        kind: 'prose',
        text: '自己名下的设施，键是设施 id。每座设施按当前配方推进生产周期，`progress / cycleTicks` 是本周期进度。',
      },
      {
        kind: 'example',
        code: `for (const b of Object.values(Game.buildings)) {
  if (!b.active) {
    const rc = b.setActive(true);
    if (rc !== OK) console.log('开机失败', b.id, rc);
  }
}`,
      },
      {
        kind: 'note',
        level: 'warn',
        text: '同一 tick 改配方或开关不会改变本 tick 的 `recipeId / active / progress` 字段——下一 tick 才生效。',
      },
      {
        kind: 'links',
        items: [
          { label: 'Building', id: 'Building' },
          { label: 'Game.getRecipe', id: 'Game.getRecipe' },
        ],
      },
    ],
  },
  {
    id: 'Game.ships',
    title: 'ships',
    group: 'Game',
    kind: '属性',
    summary: '自己的飞船、货舱与航线状态',
    keywords: 'ships 飞船 舰队 运输 派船 货舱 耐久',
    blocks: [
      {
        kind: 'prose',
        text: '自己名下的飞船，键是飞船 id。`isBusy` 为 `false` 的飞船可以派活，`busyUntil` 是到达 tick。',
      },
      {
        kind: 'example',
        code: `const idle = Object.values(Game.ships).filter((s) => !s.isBusy);
for (const ship of idle) {
  console.log(ship.id, ship.location, ship.durability);
}`,
      },
      {
        kind: 'note',
        level: 'info',
        text: '派船只校验出发地库存与燃料，路线耗时/油耗用 `calcRoute` 先算。`location` 是地面 `P1` 或站点 `ST:P1` / `ST:HUB`。',
      },
      {
        kind: 'links',
        items: [
          { label: 'Ship', id: 'Ship' },
          { label: 'Game.market.calcRoute', id: 'Game.market.calcRoute' },
        ],
      },
    ],
  },
  {
    id: 'Game.market',
    title: 'market',
    group: 'Game',
    kind: '属性',
    summary: '市场查询与下单入口',
    keywords: 'market 市场 交易所 盘口 挂单 下单',
    blocks: [
      {
        kind: 'prose',
        text: '市场入口：查询走惰性读取（真正读到才抓数据），写操作进本 tick 的 Intent 缓冲。',
      },
      {
        kind: 'fields',
        rows: [
          { name: 'credits', type: 'number', desc: '本 tick 开盘时的现金副本' },
          { name: 'orders', type: 'Record<string, MarketOrder>', desc: '自己的活跃挂单' },
          { name: 'quote(stationId, item)', type: 'MarketQuote | null', desc: '盘口快照' },
          { name: 'depth(stationId, item, limit?)', type: '{ bids, asks }', desc: '买卖深度' },
          { name: 'getAllOrders(filter?)', type: 'MarketOrder[]', desc: '查询挂单（含他人）' },
          { name: 'createOrder(params)', type: 'number', desc: '发布限价单' },
          { name: 'cancelOrder(orderId)', type: 'number', desc: '撤销自己的挂单' },
          { name: 'deal(orderId, amount)', type: 'number', desc: '直接吃单成交' },
          { name: 'calcRoute(from, to)', type: 'RouteCost | null', desc: '航线耗时与油耗' },
        ],
      },
      {
        kind: 'note',
        level: 'info',
        text: '`credits` 是本 tick 开盘时的现金副本，不是实时余额；同一 tick 内它与 `Game.company.cash` 相等。',
      },
      {
        kind: 'links',
        items: [
          { label: 'Game.market.createOrder', id: 'Game.market.createOrder' },
          { label: 'Game.market.quote', id: 'Game.market.quote' },
          { label: 'Game.market.depth', id: 'Game.market.depth' },
          { label: 'Game.market.getAllOrders', id: 'Game.market.getAllOrders' },
        ],
      },
    ],
  },
  {
    id: 'Game.buyPlot',
    title: 'buyPlot',
    group: 'Game',
    kind: '方法',
    summary: '购买一手或二手地块',
    keywords: '买地 地块 土地 plot listing 一手 二手',
    blocks: [
      {
        kind: 'syntax',
        code: 'Game.buyPlot(planetId, listingId?) → number',
      },
      { kind: 'prose', text: '购买地块。省略 `listingId` 表示买一手地（价格看 `primaryLandPrice`）；传 `landListings` 里的 id 表示买二手地。' },
      {
        kind: 'params',
        rows: [
          { name: 'planetId', type: 'string', required: true, desc: '行星 id，如 `P1`' },
          { name: 'listingId', type: 'string', required: false, desc: '来自 `planet.landListings[].listingId`；省略 = 买一手地' },
        ],
      },
      { kind: 'returns', type: 'number', desc: '`OK` 或错误码' },
      {
        kind: 'errors',
        rows: [
          { code: 'ERR_NOT_FOUND', when: '行星不存在' },
          { code: 'ERR_INVALID_ARGS', when: 'planetId 不是字符串/为空串，或 listingId 不是合法数字' },
          { code: 'ERR_FULL', when: '本 tick 已用满 32 条 Intent' },
        ],
      },
      {
        kind: 'example',
        code: `const p = Game.planets[Game.company.homePlanetId];
const listing = p.landListings[0];
if (listing && Game.company.cash > listing.askPrice) {
  const rc = Game.buyPlot(p.id, listing.listingId);
  if (rc !== OK) console.log('买地失败', rc);
}`,
      },
      {
        kind: 'note',
        level: 'info',
        text: '`primaryLandPrice` 为 `null` 表示该星当前没有一手地可买。现金是否足够在落地阶段校验。',
      },
      {
        kind: 'links',
        items: [
          { label: 'Game.plots', id: 'Game.plots' },
          { label: 'Planet', id: 'Planet' },
        ],
      },
    ],
  },
  {
    id: 'Game.buildFacility',
    title: 'buildFacility',
    group: 'Game',
    kind: '方法',
    summary: '在地块上建造设施',
    keywords: '建造 设施 工厂 plot building type',
    blocks: [
      { kind: 'syntax', code: 'Game.buildFacility(plotId, buildingType) → number' },
      { kind: 'prose', text: '在自己名下的地块上建造一座设施，消耗现金与建材。' },
      {
        kind: 'params',
        rows: [
          { name: 'plotId', type: 'string', required: true, desc: '自己的地块 id（`Game.plots` 的键）' },
          { name: 'buildingType', type: 'string', required: true, desc: '建筑类型 id，如 `mine_smelter`' },
        ],
      },
      { kind: 'returns', type: 'number', desc: '`OK` 或错误码' },
      {
        kind: 'errors',
        rows: [
          { code: 'ERR_INVALID_ARGS', when: 'plotId 不是合法数字' },
          { code: 'ERR_NOT_OWNER', when: '地块不属于自己' },
          { code: 'ERR_INVALID_TARGET', when: '建筑类型不存在' },
          { code: 'ERR_FULL', when: '本 tick 已用满 32 条 Intent' },
        ],
      },
      {
        kind: 'example',
        code: `const empty = Object.values(Game.plots).find((p) => p.usedSlots < p.capacity);
if (empty) {
  const rc = Game.buildFacility(empty.id, 'mine_smelter');
  if (rc !== OK) console.log('建造失败', rc);
}`,
      },
      {
        kind: 'note',
        level: 'warn',
        text: '建筑类型目前没有可从脚本枚举的目录（Game 里没有建筑表），只能从已知类型名或游戏界面确认——这是当前 API 的已知缺口。',
      },
      {
        kind: 'links',
        items: [
          { label: 'Game.plots', id: 'Game.plots' },
          { label: 'Building', id: 'Building' },
          { label: 'Game.demolishFacility', id: 'Game.demolishFacility' },
        ],
      },
    ],
  },
  {
    id: 'Game.demolishFacility',
    title: 'demolishFacility',
    group: 'Game',
    kind: '方法',
    summary: '拆除地块上的设施',
    keywords: '拆除 拆掉 设施 建筑 plot',
    blocks: [
      { kind: 'syntax', code: 'Game.demolishFacility(plotId, buildingId) → number' },
      { kind: 'prose', text: '拆除自己地块上的设施。' },
      {
        kind: 'params',
        rows: [
          { name: 'plotId', type: 'string', required: true, desc: '地块 id' },
          { name: 'buildingId', type: 'string', required: true, desc: '设施 id（`Game.buildings` 的键）' },
        ],
      },
      { kind: 'returns', type: 'number', desc: '`OK` 或错误码' },
      {
        kind: 'errors',
        rows: [
          { code: 'ERR_INVALID_ARGS', when: 'id 不是合法数字' },
          { code: 'ERR_NOT_OWNER', when: '地块不属于自己' },
          { code: 'ERR_FULL', when: '本 tick 已用满 32 条 Intent' },
        ],
      },
      {
        kind: 'example',
        code: `const b = Object.values(Game.buildings)[0];
if (b && !b.active) {
  Game.demolishFacility(b.plotId, b.id);
}`,
      },
      {
        kind: 'note',
        level: 'warn',
        text: '宿主只校验地块归属，不校验设施是否属于你、是否在该地块上——引擎落地阶段会再校验，失败会静默丢弃。',
      },
      {
        kind: 'links',
        items: [
          { label: 'Game.buildFacility', id: 'Game.buildFacility' },
          { label: 'Building', id: 'Building' },
        ],
      },
    ],
  },
  {
    id: 'Game.bank',
    title: 'bank',
    group: 'Game',
    kind: '方法',
    summary: '在行星央行存取借还',
    keywords: '银行 央行 存款 取款 借款 还款 deposit withdraw borrow repay',
    blocks: [
      { kind: 'syntax', code: "Game.bank(planetId, op, amount) → number" },
      { kind: 'prose', text: '在指定行星的央行做资金操作。`op` 只能是四个字符串之一。' },
      {
        kind: 'params',
        rows: [
          { name: 'planetId', type: 'string', required: true, desc: '行星 id' },
          { name: 'op', type: '"deposit" | "withdraw" | "borrow" | "repay"', required: true, desc: '操作类型' },
          { name: 'amount', type: 'number', required: true, desc: '金额（信用点），必须大于 0' },
        ],
      },
      { kind: 'returns', type: 'number', desc: '`OK` 或错误码' },
      {
        kind: 'errors',
        rows: [
          { code: 'ERR_INVALID_ARGS', when: '行星不存在 / op 非法 / 金额 ≤ 0' },
          { code: 'ERR_FULL', when: '本 tick 已用满 32 条 Intent' },
        ],
      },
      {
        kind: 'example',
        code: `// 先看利率，再决定存还是借
const p = Game.planets[Game.company.homePlanetId];
console.log('年化', p.bankRatePct, '%');
if (Game.company.cash > 2000) {
  Game.bank(p.id, 'deposit', 1000);
}`,
      },
      {
        kind: 'note',
        level: 'info',
        text: '利率见 `planet.bankRatePct`。余额、额度与利息在落地阶段校验/结算。',
      },
      {
        kind: 'links',
        items: [
          { label: 'Planet', id: 'Planet' },
          { label: 'Game.company', id: 'Game.company' },
        ],
      },
    ],
  },
  {
    id: 'Game.getRecipe',
    title: 'getRecipe',
    group: 'Game',
    kind: '方法',
    summary: '按 id 读取静态配方',
    keywords: '配方 recipe 输入 输出 周期 功耗 工资',
    blocks: [
      { kind: 'syntax', code: 'Game.getRecipe(recipeId) → RecipeInfo | null' },
      { kind: 'prose', text: '读取一条静态配方：输入、输出、周期、电耗与工资。查不到返回 `null`。' },
      {
        kind: 'params',
        rows: [{ name: 'recipeId', type: 'string', required: true, desc: '配方 id' }],
      },
      { kind: 'returns', type: 'RecipeInfo | null', desc: '配方静态详情；不存在时为 null' },
      {
        kind: 'example',
        code: `const b = Object.values(Game.buildings)[0];
if (b) {
  const recipe = Game.getRecipe(b.recipeId);
  if (recipe) {
    console.log(recipe.cycleTicks, 'tick 一炉', recipe.inputs, '→', recipe.outputs);
  }
}`,
      },
      {
        kind: 'note',
        level: 'warn',
        text: '目前没有"列出全部配方"的入口，只能按 id 查询；配方 id 可从工厂界面或 production pack 得知。',
      },
      {
        kind: 'links',
        items: [
          { label: 'RecipeInfo', id: 'RecipeInfo' },
          { label: 'Game.buildings', id: 'Game.buildings' },
        ],
      },
    ],
  },
];

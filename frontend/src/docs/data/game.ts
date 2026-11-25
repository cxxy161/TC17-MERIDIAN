import type { DocEntry } from '../types';

export const GAME_ENTRIES: DocEntry[] = [
  {
    id: 'Game',
    title: 'Game',
    group: 'Game 接口',
    kind: '属性',
    summary: '脚本运行时的全局世界入口，提供只读快照状态与写操作方法',
    keywords: 'Game 全局 入口 世界 快照 属性 方法',
    blocks: [
      {
        kind: 'prose',
        text: '`Game` 是每个 tick 进入脚本的世界入口对象。其所有属性均为本 tick 开始时冻结的只读快照；全局操作方法则用于发起购买地块、建拆建筑、母星央行存取借还及查询静态配方。',
      },
      {
        kind: 'syntax',
        code: 'readonly Game: GameGlobal',
      },
      {
        kind: 'fields',
        title: '全局属性（Properties）',
        rows: [
          { name: 'time', type: 'number', desc: '当前 tick 序号（从 0 递增）' },
          { name: 'cpi', type: 'number', desc: '全星系物价指数（初始为 1）' },
          { name: 'cpu', type: '{ limit: number; getUsed(): number }', desc: '本 tick 的 CPU 预算与实时已用毫秒数' },
          { name: 'company', type: 'CompanyInfo', desc: '本公司身份与开盘资金快照（现金、储蓄、负债）' },
          { name: 'planets', type: 'Record<string, Planet>', desc: '全星系所有行星的公开遥测与本公司仓库视图' },
          { name: 'plots', type: 'Record<string, Plot>', desc: '本公司名下的全部地块' },
          { name: 'stations', type: 'Record<string, Station>', desc: '本公司当前有库存记录的站点字典' },
          { name: 'buildings', type: 'Record<string, Building>', desc: '本公司名下的全部建筑' },
          { name: 'ships', type: 'Record<string, Ship>', desc: '本公司名下的全部飞船' },
          { name: 'market', type: 'MarketAPI', desc: '市场行情查询、下单、物流估算与公开情报接口' },
        ],
      },
      {
        kind: 'methods',
        title: '全局方法（Methods）',
        rows: [
          {
            signature: 'Game.buyPlot(planetId: string, target: { slotId: number } | { listingId: string | number })',
            returns: 'RetCode',
            desc: '按位置编号购买一手空地，或按挂牌编号收购二手地块',
            id: 'Game.buyPlot',
          },
          {
            signature: 'Game.buildFacility(plotId: string, buildingType: string)',
            returns: 'RetCode',
            desc: '在自己的地块上建造一座新建筑',
            id: 'Game.buildFacility',
          },
          {
            signature: 'Game.demolishFacility(plotId: string, buildingId: string)',
            returns: 'RetCode',
            desc: '拆除自己地块上的指定建筑',
            id: 'Game.demolishFacility',
          },
          {
            signature: 'Game.bank(planetId: string, op: \'deposit\' | \'withdraw\' | \'borrow\' | \'repay\', amount: number)',
            returns: 'RetCode',
            desc: '在母星央行执行存款、取款、借款或还款操作',
            id: 'Game.bank',
          },
          {
            signature: 'Game.getRecipe(recipeId: string)',
            returns: 'RecipeInfo | null',
            desc: '按配方 ID 查询静态配方输入、输出与消耗明细',
            id: 'Game.getRecipe',
          },
        ],
      },
      {
        kind: 'note',
        level: 'warn',
        text: '`Game` 及其下属所有快照对象都已被冻结，向其挂载自定义属性不会生效。请使用 `Memory` 保存跨 tick 状态。',
      },
      {
        kind: 'links',
        items: [
          { label: '执行与落账机制', id: 'guides/execution' },
          { label: 'Game.market', id: 'Game.market' },
          { label: 'Memory', id: 'Memory' },
        ],
      },
    ],
  },
  {
    id: 'Game.time',
    title: 'time',
    group: 'Game 接口',
    kind: '属性',
    summary: '当前世界的 tick 序号（从 0 开始单调递增）',
    keywords: 'Game.time tick 时间 序号 节流',
    blocks: [
      {
        kind: 'prose',
        text: '当前模拟 tick 序号，每个模拟步长加 1。保存并热重载脚本不会重置该计数。',
      },
      {
        kind: 'syntax',
        code: 'readonly Game.time: number',
      },
      {
        kind: 'example',
        caption: '每 20 个 tick 执行一次低频巡检',
        code: `module.exports.loop = function () {
  if (Game.time % 20 !== 0) return;
  console.log('巡检 tick:', Game.time);
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
  {
    id: 'Game.cpi',
    title: 'cpi',
    group: 'Game 接口',
    kind: '属性',
    summary: '全星系综合消费者物价指数（影响工资、施工费与部分固定费用）',
    keywords: 'Game.cpi cpi 物价 指数 通胀 工资 施工费',
    blocks: [
      {
        kind: 'prose',
        text: '全星系综合物价指数，开局初始为 `1`，随星系内各类商品的长期价格水平动态变化（范围 `0.25..10`）。除用于平减折算真实价格外，建筑生产工资、建厂施工费与初始贷款额度均随 `Game.cpi` 浮动。',
      },
      {
        kind: 'syntax',
        code: 'readonly Game.cpi: number',
      },
      {
        kind: 'example',
        caption: '将钢材名义价格折算为基准购买力价格',
        code: `module.exports.loop = function () {
  const q = Game.market.quote('ST:HUB', RESOURCE_STEEL);
  if (q) {
    const realPrice = q.lastPrice / Game.cpi;
    console.log('真实钢价:', realPrice.toFixed(2), '当前 CPI:', Game.cpi.toFixed(3));
  }
};`,
      },
      {
        kind: 'note',
        level: 'info',
        text: '`Game.cpi` 是全星系宏观指数；查询单个物品的实时报价请调用 `Game.market.quote`。',
      },
      {
        kind: 'links',
        items: [
          { label: '核心经济规则', id: 'guides/economy' },
          { label: 'Game.market.quote', id: 'Game.market.quote' },
        ],
      },
    ],
  },
  {
    id: 'Game.cpu',
    title: 'cpu',
    group: 'Game 接口',
    kind: '属性',
    summary: '本 tick 的 CPU 墙钟预算与已消耗时间监控对象',
    keywords: 'Game.cpu limit getUsed 预算 超时 5ms',
    blocks: [
      {
        kind: 'prose',
        text: '提供当前 tick 允许的墙钟时间上限与实时耗时查询，用于在复杂计算前判断预算余量。',
      },
      {
        kind: 'syntax',
        code: 'readonly Game.cpu: {\n  readonly limit: number;\n  getUsed(): number;\n}',
      },
      {
        kind: 'fields',
        rows: [
          { name: 'limit', type: 'number', desc: '本 tick 允许的最大墙钟毫秒数（默认为 `5`）' },
        ],
      },
      {
        kind: 'methods',
        rows: [
          {
            signature: 'Game.cpu.getUsed()',
            returns: 'number',
            desc: '返回本 tick 从脚本启动到当前调用点的已用毫秒数',
            id: 'Game.cpu.getUsed',
          },
        ],
      },
      {
        kind: 'note',
        level: 'danger',
        title: '超时将导致整 tick 回滚',
        text: '一旦运行时间达到 `Game.cpu.limit`，脚本会被立即终止，本 tick 的全部写操作丢弃，`Memory` 回滚到上一 tick（已输出日志保留）。',
      },
      {
        kind: 'example',
        caption: '预算接近上限时提前退出循环',
        code: `module.exports.loop = function () {
  for (const item of RESOURCES_ALL) {
    if (Game.cpu.getUsed() > Game.cpu.limit * 0.8) {
      console.warn('CPU 接近上限，提前结束扫描');
      return;
    }
    Game.market.quote('ST:HUB', item);
  }
};`,
      },
      {
        kind: 'links',
        items: [
          { label: 'Game.cpu.getUsed', id: 'Game.cpu.getUsed' },
          { label: '配额与限制', id: 'guides/limits' },
        ],
      },
    ],
  },
  {
    id: 'Game.cpu.getUsed',
    title: 'getUsed',
    group: 'Game 接口',
    parent: 'Game.cpu',
    kind: '方法',
    summary: '获取本 tick 从启动到当前时刻的已消耗墙钟毫秒数',
    keywords: 'Game.cpu.getUsed 耗时 cpu 性能',
    blocks: [
      {
        kind: 'prose',
        text: '返回当前 tick 脚本执行累计消耗的墙钟毫秒数（包含沙盒启动与数据查询耗时）。',
      },
      {
        kind: 'syntax',
        code: 'Game.cpu.getUsed(): number',
      },
      {
        kind: 'params',
        rows: [],
      },
      {
        kind: 'returns',
        type: 'number',
        desc: '已用毫秒数（浮点数，如 `0.42`）',
      },
      {
        kind: 'example',
        caption: '测量一段扫描逻辑的耗时',
        code: `module.exports.loop = function () {
  const t0 = Game.cpu.getUsed();
  const orders = Game.market.getAllOrders({ stationId: 'ST:HUB' });
  const cost = Game.cpu.getUsed() - t0;
  console.log('读取订单数:', orders.length, '耗时(ms):', cost.toFixed(3));
};`,
      },
      {
        kind: 'links',
        items: [
          { label: 'Game.cpu', id: 'Game.cpu' },
          { label: '配额与限制', id: 'guides/limits' },
        ],
      },
    ],
  },
  {
    id: 'Game.company',
    title: 'company',
    group: 'Game 接口',
    kind: '属性',
    summary: '本公司身份信息与本 tick 开盘资金快照',
    keywords: 'Game.company 公司 现金 cash 储蓄 savings 负债 debt 职业 母星',
    blocks: [
      {
        kind: 'prose',
        text: '返回当前脚本所属公司的静态身份与开盘资金状态，所有金额单位均为信用点。',
      },
      {
        kind: 'syntax',
        code: 'readonly Game.company: {\n  readonly id: string;\n  readonly name: string;\n  readonly profession: string;\n  readonly homePlanetId: string;\n  readonly cash: number;\n  readonly savings: number;\n  readonly debt: number;\n}',
      },
      {
        kind: 'fields',
        rows: [
          { name: 'id', type: 'string', desc: '公司 ID' },
          { name: 'name', type: 'string', desc: '公司名称' },
          { name: 'profession', type: 'string', desc: '职业 ID，如 `\'env_recycle\'`、`\'agri_bio\'`、`\'mining_ind\'`' },
          { name: 'homePlanetId', type: 'string', desc: '母星行星 ID（如 `\'P2\'`）；央行操作仅限在母星执行' },
          { name: 'cash', type: 'number', desc: '本 tick 开盘可用现金（信用点）' },
          { name: 'savings', type: 'number', desc: '在母星央行的当前存款余额（信用点）' },
          { name: 'debt', type: 'number', desc: '在母星央行的当前贷款本息余额（信用点）' },
        ],
      },
      {
        kind: 'note',
        level: 'warn',
        text: '`cash`、`savings`、`debt` 均为本 tick 开始时的开盘快照；同一 tick 内多次下单或存取款不会实时更新这些字段，连续下单请自行用局部变量跟踪剩余现金。',
      },
      {
        kind: 'example',
        caption: '读取公司资产状况',
        code: `module.exports.loop = function () {
  const c = Game.company;
  console.log(c.name, '母星:', c.homePlanetId, '现金:', c.cash, '存款:', c.savings, '负债:', c.debt);
};`,
      },
      {
        kind: 'links',
        items: [
          { label: 'Game.bank', id: 'Game.bank' },
          { label: 'Game.market.credits', id: 'Game.market.credits' },
          { label: '执行与落账机制', id: 'guides/execution' },
        ],
      },
    ],
  },
  {
    id: 'Game.planets',
    title: 'planets',
    group: 'Game 接口',
    kind: '属性',
    summary: '全星系全部行星的公开遥测、需求与本公司行星仓库映射',
    keywords: 'Game.planets 行星 星球 仓库 需求',
    blocks: [
      {
        kind: 'prose',
        text: '以行星 ID（如 `\'P1\'`、`\'P2\'`）为键的只读字典，包含星系内所有行星（即使本公司在该行星尚无地块或库存）。每个元素的详细结构见 `Planet`。',
      },
      {
        kind: 'syntax',
        code: 'readonly Game.planets: Record<string, Planet>',
      },
      {
        kind: 'example',
        caption: '遍历所有行星并输出钢材本 tick 城市需求',
        code: `module.exports.loop = function () {
  for (const planet of Object.values(Game.planets)) {
    const demand = planet.demands[RESOURCE_STEEL];
    if (demand && demand.qty > 0) {
      console.log(planet.name, '钢材需求:', demand.qty);
    }
  }
};`,
      },
      {
        kind: 'links',
        items: [
          { label: 'Planet', id: 'Planet' },
          { label: 'Game.buyPlot', id: 'Game.buyPlot' },
          { label: 'Game.bank', id: 'Game.bank' },
        ],
      },
    ],
  },
  {
    id: 'Game.plots',
    title: 'plots',
    group: 'Game 接口',
    kind: '属性',
    summary: '本公司名下全部已持有地块的字典',
    keywords: 'Game.plots 地块 土地 槽位 建筑',
    blocks: [
      {
        kind: 'prose',
        text: '以地块 ID（数字字符串，如 `\'1\'`）为键的只读字典，仅包含本公司当前持有的地块。若要浏览全星系公开空地或挂牌二手地，请使用 `Game.market.getLandPlots`。详细字段见 `Plot`。',
      },
      {
        kind: 'syntax',
        code: 'readonly Game.plots: Record<string, Plot>',
      },
      {
        kind: 'example',
        caption: '统计名下地块的总剩余槽位',
        code: `module.exports.loop = function () {
  let freeSlots = 0;
  for (const plot of Object.values(Game.plots)) {
    freeSlots += Math.max(0, plot.capacity - plot.usedSlots);
  }
  console.log('名下地块数:', Object.keys(Game.plots).length, '剩余槽位:', freeSlots);
};`,
      },
      {
        kind: 'links',
        items: [
          { label: 'Plot', id: 'Plot' },
          { label: 'Game.buyPlot', id: 'Game.buyPlot' },
          { label: 'Game.buildFacility', id: 'Game.buildFacility' },
          { label: 'Game.market.getLandPlots', id: 'Game.market.getLandPlots' },
        ],
      },
    ],
  },
  {
    id: 'Game.stations',
    title: 'stations',
    group: 'Game 接口',
    kind: '属性',
    summary: '本公司当前有库存记录的站点字典',
    keywords: 'Game.stations 站点 轨道站 HUB 仓库',
    blocks: [
      {
        kind: 'prose',
        text: '以站点 ID（如 `\'ST:P2\'`、`\'ST:HUB\'`）为键的只读字典，仅收录本公司存在库存记录的站点。详细结构见 `Station`。',
      },
      {
        kind: 'syntax',
        code: 'readonly Game.stations: Record<string, Station>',
      },
      {
        kind: 'note',
        level: 'warn',
        text: '新开局的公司在向某个站点运货或买货前，该站点键可能尚不存在（例如 `Game.stations[\'ST:HUB\']` 为 `undefined`），访问 `.store` 前请务必判空。',
      },
      {
        kind: 'example',
        caption: '安全读取各站点的钢材库存',
        code: `module.exports.loop = function () {
  for (const station of Object.values(Game.stations)) {
    console.log(station.id, '钢材库存:', station.store[RESOURCE_STEEL]);
  }
};`,
      },
      {
        kind: 'links',
        items: [
          { label: 'Station', id: 'Station' },
          { label: 'Store', id: 'Store' },
        ],
      },
    ],
  },
  {
    id: 'Game.buildings',
    title: 'buildings',
    group: 'Game 接口',
    kind: '属性',
    summary: '本公司名下全部已完工生产建筑的字典',
    keywords: 'Game.buildings 建筑 工厂 生产 配方',
    blocks: [
      {
        kind: 'prose',
        text: '以建筑 ID（数字字符串）为键的只读字典，包含本公司所有已建成的生产建筑。尚处于施工中的建筑不会出现在此字典中（但会占用所在 `Plot.usedSlots`）。详细字段与控制方法见 `Building`。',
      },
      {
        kind: 'syntax',
        code: 'readonly Game.buildings: Record<string, Building>',
      },
      {
        kind: 'example',
        caption: '统计各类建筑数量并开启停产中的建筑',
        code: `module.exports.loop = function () {
  for (const b of Object.values(Game.buildings)) {
    if (!b.active) {
      b.setActive(true);
    }
  }
};`,
      },
      {
        kind: 'links',
        items: [
          { label: 'Building', id: 'Building' },
          { label: 'Building.setRecipe', id: 'Building.setRecipe' },
          { label: 'Building.setActive', id: 'Building.setActive' },
          { label: 'Game.buildFacility', id: 'Game.buildFacility' },
        ],
      },
    ],
  },
  {
    id: 'Game.ships',
    title: 'ships',
    group: 'Game 接口',
    kind: '属性',
    summary: '本公司名下全部运输飞船的字典',
    keywords: 'Game.ships 飞船 舰队 运输 货舱',
    blocks: [
      {
        kind: 'prose',
        text: '以飞船 ID（数字字符串）为键的只读字典，包含本公司拥有的全部飞船。详细字段与调度方法见 `Ship`。',
      },
      {
        kind: 'syntax',
        code: 'readonly Game.ships: Record<string, Ship>',
      },
      {
        kind: 'example',
        caption: '列出所有空闲飞船的位置与耐久',
        code: `module.exports.loop = function () {
  const idle = Object.values(Game.ships).filter((s) => !s.isBusy);
  for (const ship of idle) {
    console.log('空闲飞船:', ship.id, '位置:', ship.location, '耐久:', ship.durability);
  }
};`,
      },
      {
        kind: 'links',
        items: [
          { label: 'Ship', id: 'Ship' },
          { label: 'Ship.dispatch', id: 'Ship.dispatch' },
          { label: 'Ship.repair', id: 'Ship.repair' },
          { label: 'Game.market.calcRoute', id: 'Game.market.calcRoute' },
        ],
      },
    ],
  },
  {
    id: 'Game.buyPlot',
    title: 'buyPlot',
    group: 'Game 接口',
    kind: '方法',
    summary: '按位置编号购买一手空地，或按挂牌编号收购二手地块',
    keywords: 'Game.buyPlot 买地 地块 slotId listingId 一手 二手',
    blocks: [
      {
        kind: 'prose',
        text: '购买指定行星上的一手空地，或收购其他公司/银行清算挂牌的二手地块。购买一手空地前可通过 `Game.market.getLandPlots` 筛选空地的 `slotId`；收购二手地可通过 `planet.landListings` 或 `getLandPlots` 获取 `listingId`。',
      },
      {
        kind: 'syntax',
        code: 'Game.buyPlot(\n  planetId: string,\n  target: { slotId: number } | { listingId: string | number }\n): RetCode',
      },
      {
        kind: 'params',
        rows: [
          { name: 'planetId', type: 'string', required: 'required', desc: '目标行星 ID，如 `\'P2\'`' },
          { name: 'target', type: 'object', required: 'required', desc: '购买目标对象，以下两个字段二选一（同时提供时优先按 `listingId` 处理）' },
          { name: 'target.slotId', type: 'number', required: 'oneOf', desc: '一手空地的永久位置编号，来自 `getLandPlots(planetId)` 中 `status === \'unclaimed\'` 的记录' },
          { name: 'target.listingId', type: 'string | number', required: 'oneOf', desc: '二手/银行挂牌编号，来自 `planet.landListings[].listingId` 或 `getLandPlots()`' },
        ],
      },
      {
        kind: 'returns',
        type: 'RetCode',
        desc: '返回 `OK` 表示买地请求已进入本 tick 队列，否则返回负数错误码',
      },
      {
        kind: 'errors',
        rows: [
          { code: 'ERR_INVALID_ARGS', when: '`planetId` 非字符串、`target` 缺失，或未提供合法的数字型 `slotId` / `listingId`' },
          { code: 'ERR_NOT_FOUND', when: '行星不存在，或指定的 `slotId` / `listingId` 不存在' },
          { code: 'ERR_INVALID_TARGET', when: '按 `slotId` 购买时，目标位置并非未开发空地（城市区、已被占用或正在挂牌）' },
          { code: 'ERR_FULL', when: '本 tick 已用满 32 条写操作配额' },
        ],
      },
      {
        kind: 'settlement',
        items: [
          '本公司当前存在逾期未还贷款（无法扩张购地）；',
          '落账时可用现金不足以支付地价（一手地为 `planet.primaryLandPrice`，二手地为 `askPrice`）；',
          '同一 tick 内目标 `slotId` 或 `listingId` 被其他公司抢先买走（引擎不会自动替换为其他空地）；',
          '尝试购买本公司自己挂牌出售的地块。',
        ],
      },
      {
        kind: 'example',
        caption: '挑选母星上矿冶加成最高的一手空地并购买',
        code: `module.exports.loop = function () {
  const pid = Game.company.homePlanetId;
  const tiles = Game.market.getLandPlots(pid);
  if (!tiles) return;

  const best = tiles
    .filter((t) => t.status === 'unclaimed' && t.price !== null)
    .sort((a, b) => (b.buildingMods.mine_smelter || 0) - (a.buildingMods.mine_smelter || 0))[0];

  if (best && best.price !== null && Game.company.cash >= best.price) {
    const rc = Game.buyPlot(pid, { slotId: best.slotId });
    if (rc !== OK) console.warn('buyPlot 失败:', rc);
  }
};`,
      },
      {
        kind: 'links',
        items: [
          { label: 'Game.market.getLandPlots', id: 'Game.market.getLandPlots' },
          { label: 'PublicLandPlot', id: 'PublicLandPlot' },
          { label: 'Game.plots', id: 'Game.plots' },
          { label: 'Planet', id: 'Planet' },
        ],
      },
    ],
  },
  {
    id: 'Game.buildFacility',
    title: 'buildFacility',
    group: 'Game 接口',
    kind: '方法',
    summary: '在自己名下的地块上建造一座指定类型的建筑',
    keywords: 'Game.buildFacility 建造 建厂 建筑 地块 building_mat',
    blocks: [
      {
        kind: 'prose',
        text: '在自己的地块上发起一座建筑的建造任务。建造需要消耗所在行星地面仓的建材（常见为 6~14 个 `building_mat`）和 `80 × Game.cpi` 信用点施工费，并在施工期（数个 tick）结束后加入 `Game.buildings`。施工期间即占用该地块的 `usedSlots`。',
      },
      {
        kind: 'syntax',
        code: 'Game.buildFacility(plotId: string, buildingType: string): RetCode',
      },
      {
        kind: 'params',
        rows: [
          { name: 'plotId', type: 'string', required: 'required', desc: '自己的地块 ID（`Game.plots` 的键）' },
          { name: 'buildingType', type: 'string', required: 'required', desc: '建筑类型 ID，如 `\'mine_smelter\'`（完整清单见「默认世界建筑与配方」）' },
        ],
      },
      {
        kind: 'returns',
        type: 'RetCode',
        desc: '返回 `OK` 表示建造请求已入队，否则返回负数错误码',
      },
      {
        kind: 'errors',
        rows: [
          { code: 'ERR_INVALID_ARGS', when: '`plotId` 格式非法（无法解析为数字）或参数类型不对' },
          { code: 'ERR_NOT_OWNER', when: '地块不存在或不属于本公司' },
          { code: 'ERR_INVALID_TARGET', when: '指定的 `buildingType` 不存在' },
          { code: 'ERR_FULL', when: '本 tick 已用满 32 条写操作配额' },
        ],
      },
      {
        kind: 'settlement',
        items: [
          '地块剩余槽位不足（`plot.usedSlots + 建筑占用格数 > plot.capacity`）；',
          '落账时现金不足 `80 × Game.cpi` 施工费；',
          '所在行星的地面仓（`planet.groundStore`）中建材数量不足（如 `building_mat`）。',
        ],
      },
      {
        kind: 'example',
        caption: '在还有空位的地块上建造一座矿业冶炼厂',
        code: `module.exports.loop = function () {
  const plot = Object.values(Game.plots).find((p) => p.usedSlots < p.capacity);
  if (!plot) return;

  const ground = Game.planets[plot.planetId].groundStore;
  if (ground[RESOURCE_BUILDING_MAT] >= 8 && Game.company.cash >= 80 * Game.cpi) {
    const rc = Game.buildFacility(plot.id, 'mine_smelter');
    if (rc !== OK) console.warn('建造失败:', rc);
  }
};`,
      },
      {
        kind: 'links',
        items: [
          { label: '默认世界建筑与配方', id: 'constants/world-catalog' },
          { label: 'Game.plots', id: 'Game.plots' },
          { label: 'Game.demolishFacility', id: 'Game.demolishFacility' },
          { label: 'Building', id: 'Building' },
        ],
      },
    ],
  },
  {
    id: 'Game.demolishFacility',
    title: 'demolishFacility',
    group: 'Game 接口',
    kind: '方法',
    summary: '拆除自己地块上的指定已完工建筑并释放槽位',
    keywords: 'Game.demolishFacility 拆除 建筑 释放槽位',
    blocks: [
      {
        kind: 'prose',
        text: '立即拆除指定地块上的建筑并释放其占用的槽位。拆除不会返还建造成本或建材。',
      },
      {
        kind: 'syntax',
        code: 'Game.demolishFacility(plotId: string, buildingId: string): RetCode',
      },
      {
        kind: 'params',
        rows: [
          { name: 'plotId', type: 'string', required: 'required', desc: '所属地块 ID（`Game.plots` 的键）' },
          { name: 'buildingId', type: 'string', required: 'required', desc: '待拆除建筑 ID（`Game.buildings` 的键）' },
        ],
      },
      {
        kind: 'returns',
        type: 'RetCode',
        desc: '返回 `OK` 表示拆除请求已入队，否则返回负数错误码',
      },
      {
        kind: 'errors',
        rows: [
          { code: 'ERR_INVALID_ARGS', when: '`plotId` 或 `buildingId` 无法解析为数字，或参数类型不对' },
          { code: 'ERR_NOT_OWNER', when: '地块不存在或不属于本公司' },
          { code: 'ERR_FULL', when: '本 tick 已用满 32 条写操作配额' },
        ],
      },
      {
        kind: 'settlement',
        items: [
          '指定的 `buildingId` 并不存在于该 `plotId` 上（例如输入了错配的建筑 ID，或该建筑尚在建造中）。',
        ],
      },
      {
        kind: 'example',
        caption: '拆除已停产的建筑以腾出地块槽位',
        code: `module.exports.loop = function () {
  const idle = Object.values(Game.buildings).find((b) => !b.active);
  if (idle) {
    const rc = Game.demolishFacility(idle.plotId, idle.id);
    if (rc !== OK) console.warn('拆除请求失败:', rc);
  }
};`,
      },
      {
        kind: 'links',
        items: [
          { label: 'Game.buildFacility', id: 'Game.buildFacility' },
          { label: 'Building', id: 'Building' },
          { label: 'Plot', id: 'Plot' },
        ],
      },
    ],
  },
  {
    id: 'Game.bank',
    title: 'bank',
    group: 'Game 接口',
    kind: '方法',
    summary: '在母星央行进行存款、取款、借款或还款操作',
    keywords: 'Game.bank 银行 央行 存款 取款 借款 还款 deposit withdraw borrow repay 利息 逾期',
    blocks: [
      {
        kind: 'prose',
        text: '在公司所属母星（`Game.company.homePlanetId`）的央行执行资金操作。贷款利率见 `planet.bankRatePct`，存款利率为贷款利率的一半；单笔贷款期限为 360 tick。',
      },
      {
        kind: 'syntax',
        code: "Game.bank(\n  planetId: string,\n  op: 'deposit' | 'withdraw' | 'borrow' | 'repay',\n  amount: number\n): RetCode",
      },
      {
        kind: 'params',
        rows: [
          { name: 'planetId', type: 'string', required: 'required', desc: '行星 ID；**必须等于 `Game.company.homePlanetId`**，否则落账阶段会被拒绝' },
          { name: 'op', type: "'deposit' | 'withdraw' | 'borrow' | 'repay'", required: 'required', desc: '操作类型：`deposit` 存款、`withdraw` 取款、`borrow` 借款、`repay` 还款' },
          { name: 'amount', type: 'number', required: 'required', desc: '操作金额（信用点），必须为有限正数（`> 0`）' },
        ],
      },
      {
        kind: 'returns',
        type: 'RetCode',
        desc: '返回 `OK` 表示银行操作已入队，否则返回负数错误码',
      },
      {
        kind: 'errors',
        rows: [
          { code: 'ERR_INVALID_ARGS', when: '行星不存在、`op` 不在四种合法值之中，或 `amount <= 0` / 取整至货币最小精度（0.0001）后为 0' },
          { code: 'ERR_FULL', when: '本 tick 已用满 32 条写操作配额' },
        ],
      },
      {
        kind: 'settlement',
        items: [
          '`planetId` 不是本公司的母星 `Game.company.homePlanetId`；',
          '`deposit`：落账时公司现金不足 `amount`；',
          '`withdraw`：公司储蓄余额不足，或母星央行可用准备金不足；',
          '`borrow`：存在逾期未还贷款、借款后总负债超过公司授信额度，或央行准备金扣除 25% 存款最低准备后可贷余额不足；',
          '`repay`：当前无负债或公司现金不足（若 `amount` 超过实际负债，引擎会自动按 `min(amount, debt)` 结清）。',
        ],
      },
      {
        kind: 'example',
        caption: '查看母星利率并在现金充裕时存入闲置资金',
        code: `module.exports.loop = function () {
  const homeId = Game.company.homePlanetId;
  const home = Game.planets[homeId];
  if (!home) return;

  console.log('母星央行年化贷款利率:', home.bankRatePct, '%');
  if (Game.company.debt > 0 && Game.company.cash > Game.company.debt) {
    Game.bank(homeId, 'repay', Game.company.debt);
  } else if (Game.company.cash > 3000) {
    Game.bank(homeId, 'deposit', 1000);
  }
};`,
      },
      {
        kind: 'links',
        items: [
          { label: '核心经济规则', id: 'guides/economy' },
          { label: 'Game.company', id: 'Game.company' },
          { label: 'Planet', id: 'Planet' },
        ],
      },
    ],
  },
  {
    id: 'Game.getRecipe',
    title: 'getRecipe',
    group: 'Game 接口',
    kind: '方法',
    summary: '按配方 ID 读取静态配方的输入、输出、周期与成本定义',
    keywords: 'Game.getRecipe 配方 recipe 输入 输出 周期 电耗 工资',
    blocks: [
      {
        kind: 'prose',
        text: '根据配方 ID 查询该配方的静态生产参数。所有默认世界的配方 ID 可在「默认世界建筑与配方」速查表中查看。',
      },
      {
        kind: 'syntax',
        code: 'Game.getRecipe(recipeId: string): RecipeInfo | null',
      },
      {
        kind: 'params',
        rows: [
          { name: 'recipeId', type: 'string', required: 'required', desc: '配方 ID，如 `\'steel_carbon\'`' },
        ],
      },
      {
        kind: 'returns',
        type: 'RecipeInfo | null',
        desc: '存在时返回静态 `RecipeInfo` 对象；`recipeId` 非字符串、为空或不存在时返回 `null`',
      },
      {
        kind: 'example',
        caption: '读取当前建筑绑定配方的投入与产出',
        code: `module.exports.loop = function () {
  const b = Object.values(Game.buildings)[0];
  if (!b) return;

  const recipe = Game.getRecipe(b.recipeId);
  if (recipe) {
    console.log(recipe.id, '周期:', recipe.cycleTicks, '投入:', recipe.inputs, '产出:', recipe.outputs);
  }
};`,
      },
      {
        kind: 'links',
        items: [
          { label: 'RecipeInfo', id: 'RecipeInfo' },
          { label: '默认世界建筑与配方', id: 'constants/world-catalog' },
          { label: 'Building.setRecipe', id: 'Building.setRecipe' },
        ],
      },
    ],
  },
];

import type { DocEntry } from '../types';

export const GAME_ENTRIES: DocEntry[] = [
  {
    id: 'Game',
    title: 'Game',
    group: 'Game 接口',
    kind: '属性',
    summary: '脚本运行时的全局世界入口，提供全部只读快照视图与职能子域接口',
    keywords: 'Game 全局 入口 世界 快照 systems planets stations plots buildings sites ships catalog lastTick map market bank',
    blocks: [
      {
        kind: 'prose',
        text: '`Game` 是每个 tick 进入脚本的唯一顶层世界入口。v2 将世界状态收敛为只读图谱属性与四大职能域：`Game.map`（星图/航线/一手购地/情报）、`Game.market`（全星系交易所/二手土地）、`Game.bank`（母星央行）及实体实例方法（`Plot.build`、`Building.*`、`Ship.*`）。',
      },
      {
        kind: 'syntax',
        code: 'readonly Game: GameGlobal',
      },
      {
        kind: 'fields',
        title: '全局属性与操作域（Properties）',
        rows: [
          { name: 'time', type: 'number', desc: '当前模拟 tick 序号（从 0 单调递增）' },
          { name: 'cpi', type: 'number', desc: '全星系物价指数（初始为 1）' },
          { name: 'cpu', type: '{ limit: number; getUsed(): number }', desc: '本 tick 的 CPU 毫秒预算与实时已用耗时查询' },
          { name: 'company', type: 'CompanyInfo', desc: '本公司身份、职业、母星及开盘资金状态（含 `debtDueTick`）' },
          { name: 'systems', type: 'Record<string, StarSystem>', desc: '全星系全部恒星系字典（含中心枢纽 `hubStationId` 与所辖 `planetIds`）' },
          { name: 'planets', type: 'Record<string, Planet>', desc: '全星系行星遥测、地面/轨道仓与二手挂牌视图' },
          { name: 'stations', type: 'Record<string, Station>', desc: '全星系所有空间站字典（轨道站与枢纽站全集，即使库存为空也存在）' },
          { name: 'plots', type: 'Record<string, Plot>', desc: '本公司名下全部地块（内含 `buildings`、`sites` 与 `build()` 方法）' },
          { name: 'buildings', type: 'Record<string, Building>', desc: '本公司名下全部已完工建筑（含 `setRecipe` / `setActive` / `demolish`）' },
          { name: 'sites', type: 'Record<string, ConstructionSite>', desc: '本公司名下全部在建工地字典（含 `finishTick` 与 `ticksRemaining`）' },
          { name: 'ships', type: 'Record<string, Ship>', desc: '本公司名下全部飞船（含 `dispatch(to, cargo)` 与 `repair()`）' },
          { name: 'catalog', type: 'CatalogInfo', desc: '全局只读静态规则字典（items / buildings / recipes / recipesByBuilding）' },
          { name: 'lastTick', type: 'LastTickFeedback', desc: '上一 tick 真实成交流水 `fills` 与落账阶段被拒回执 `rejected`' },
          { name: 'map', type: 'MapAPI', desc: '星图航线、公开格点、一手购地与对手公司公开情报接口' },
          { name: 'market', type: 'MarketAPI', desc: '市场行情、盘口深度、挂单/撤单/吃单与二手土地交易接口' },
          { name: 'bank', type: 'BankAPI', desc: '母星央行存款、取款、借贷与还款接口' },
        ],
      },
      {
        kind: 'methods',
        title: '全局辅助方法（Methods）',
        rows: [
          {
            signature: 'Game.getObjectById(id: string)',
            returns: 'Building | Plot | ConstructionSite | Ship | Planet | Station | StarSystem | null',
            desc: '按全局唯一字符串 ID 直接检索任意自有或公开世界对象',
            id: 'Game.getObjectById',
          },
        ],
      },
      {
        kind: 'note',
        level: 'warn',
        text: '`Game` 及其所有嵌套属性均已深度冻结（`Object.freeze`），向其挂载自定义属性不会生效。请使用 `Memory` 保存跨 tick 状态。',
      },
      {
        kind: 'links',
        items: [
          { label: 'API 总览', id: 'guides/overview' },
          { label: '执行与落账机制', id: 'guides/execution' },
          { label: 'Game.map', id: 'Game.map' },
          { label: 'Game.market', id: 'Game.market' },
          { label: 'Game.bank', id: 'Game.bank' },
        ],
      },
    ],
  },
  {
    id: 'Game.time',
    title: 'time',
    group: 'Game 接口',
    parent: 'Game',
    kind: '属性',
    summary: '当前世界的 tick 序号（从 0 开始单调递增）',
    keywords: 'Game.time tick 时间 序号 节流',
    blocks: [
      {
        kind: 'prose',
        text: '当前模拟 tick 序号，每推进一个模拟步长加 1。修改并热重载代码不会重置该计数。',
      },
      {
        kind: 'syntax',
        code: 'readonly Game.time: number',
      },
      {
        kind: 'example',
        caption: '每 5 个 tick 执行一次全市场扫描',
        code: `module.exports.loop = function () {
  if (Game.time % 5 === 0) {
    console.log('tick', Game.time, '定周期巡检');
  }
};`,
      },
      {
        kind: 'links',
        items: [
          { label: '执行与落账机制', id: 'guides/execution' },
          { label: 'Game.cpi', id: 'Game.cpi' },
        ],
      },
    ],
  },
  {
    id: 'Game.cpi',
    title: 'cpi',
    group: 'Game 接口',
    parent: 'Game',
    kind: '属性',
    summary: '全星系物价指数（初始为 1，影响建筑工资与施工现金费）',
    keywords: 'Game.cpi 通胀 物价 工资 施工费 指数',
    blocks: [
      {
        kind: 'prose',
        text: '全星系消费与工业成本指数（初期约为 `1`）。新建筑建造的施工费固定为 `80 × Game.cpi` 信用点，各产线每周期扣除的人力工资也按 `recipe.laborCost × Game.cpi` 实时折算。',
      },
      {
        kind: 'syntax',
        code: 'readonly Game.cpi: number',
      },
      {
        kind: 'example',
        caption: '估算当前建厂现金门槛与配方真实工资',
        code: `module.exports.loop = function () {
  const buildCashFee = 80 * Game.cpi;
  const steelLabor = Game.catalog.recipes.steel_carbon.laborCost * Game.cpi;
  console.log('施工费:', buildCashFee.toFixed(2), '炼钢工资:', steelLabor.toFixed(2));
};`,
      },
      {
        kind: 'links',
        items: [
          { label: 'Plot.build', id: 'Plot.build' },
          { label: 'Game.catalog', id: 'Game.catalog' },
          { label: '核心经济规则', id: 'guides/economy' },
        ],
      },
    ],
  },
  {
    id: 'Game.cpu',
    title: 'cpu',
    group: 'Game 接口',
    parent: 'Game',
    kind: '属性',
    summary: '当前 tick 的 CPU 毫秒预算上限与实时消耗查询入口',
    keywords: 'Game.cpu limit getUsed 超时 熔断 性能',
    blocks: [
      {
        kind: 'prose',
        text: '提供本 tick 脚本运行的墙钟 CPU 上限 `limit` 与实时消耗查询函数 `getUsed()`。',
      },
      {
        kind: 'syntax',
        code: 'readonly Game.cpu: {\n  readonly limit: number;\n  getUsed(): number;\n}',
      },
      {
        kind: 'fields',
        title: '子属性（Properties）',
        rows: [
          { name: 'limit', type: 'number', desc: '单 tick 允许的最大玩家脚本执行毫秒数（默认 `10` ms）' },
        ],
      },
      {
        kind: 'methods',
        title: '方法（Methods）',
        rows: [
          { signature: 'Game.cpu.getUsed()', returns: 'number', desc: '返回本 tick 从脚本开始执行到当前已消耗的毫秒数', id: 'Game.cpu.getUsed' },
        ],
      },
      {
        kind: 'note',
        level: 'warn',
        text: '耗时超过 `Game.cpu.limit` 会触发沙盒硬中断并重置实例，同时丢弃本 tick 脚本全部写操作并回滚 `Memory`。',
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
    summary: '返回当前 tick 从进入脚本到现在已消耗的 CPU 毫秒数',
    keywords: 'Game.cpu.getUsed cpu 耗时 监控',
    blocks: [
      {
        kind: 'prose',
        text: '查询当前 tick 玩家代码已消耗的毫秒数，用于在循环或全星系扫描中实现软预算保护。',
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
        desc: '当前 tick 已用 CPU 时间（毫秒浮点数）',
      },
      {
        kind: 'example',
        caption: '高耗时循环前做 CPU 守卫',
        code: `module.exports.loop = function () {
  for (const item of RESOURCES_ALL) {
    if (Game.cpu.getUsed() > Game.cpu.limit * 0.75) {
      console.warn('CPU 预算接近上限，提前结束扫描');
      break;
    }
    Game.market.quote('ST:HUB', item);
  }
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
    parent: 'Game',
    kind: '属性',
    summary: '本公司身份、职业、母星及开盘现金、储蓄、负债和到期 tick 快照',
    keywords: 'Game.company 公司 现金 储蓄 负债 母星 homePlanetId debtDueTick',
    blocks: [
      {
        kind: 'prose',
        text: '包含本公司静态身份与本 tick 开盘资产负债状态，完整字段说明见 `CompanyInfo`。',
      },
      {
        kind: 'syntax',
        code: 'readonly Game.company: CompanyInfo',
      },
      {
        kind: 'example',
        caption: '检查贷款是否临近逾期',
        code: `module.exports.loop = function () {
  const c = Game.company;
  if (c.debt > 0 && c.debtDueTick !== null && c.debtDueTick - Game.time < 20) {
    console.warn('距离贷款逾期不足 20 tick，待还本息:', c.debt);
  }
};`,
      },
      {
        kind: 'links',
        items: [
          { label: 'CompanyInfo', id: 'CompanyInfo' },
          { label: 'Game.bank', id: 'Game.bank' },
        ],
      },
    ],
  },
  {
    id: 'Game.systems',
    title: 'systems',
    group: 'Game 接口',
    parent: 'Game',
    kind: '属性',
    summary: '全星系所有恒星系的只读字典，包含星系坐标与下辖行星列表',
    keywords: 'Game.systems 恒星系 星图 枢纽 planetIds hubStationId',
    blocks: [
      {
        kind: 'prose',
        text: '以恒星系 ID（如 `\'S1\'`）为键的只读字典，汇总该恒星系的恒星类型、星图坐标、中心贸易枢纽 `hubStationId` 以及所辖行星列表 `planetIds`。',
      },
      {
        kind: 'syntax',
        code: 'readonly Game.systems: Record<string, StarSystem>',
      },
      {
        kind: 'example',
        caption: '遍历恒星系及所属行星',
        code: `module.exports.loop = function () {
  for (const sys of Object.values(Game.systems)) {
    console.log(sys.name, '枢纽:', sys.hubStationId, '行星:', sys.planetIds);
  }
};`,
      },
      {
        kind: 'links',
        items: [
          { label: 'StarSystem', id: 'StarSystem' },
          { label: 'Game.planets', id: 'Game.planets' },
        ],
      },
    ],
  },
  {
    id: 'Game.planets',
    title: 'planets',
    group: 'Game 接口',
    parent: 'Game',
    kind: '属性',
    summary: '全星系所有行星的公开遥测、城市需求、地面/轨道仓与二手挂牌字典',
    keywords: 'Game.planets 行星 仓库 需求 宜居度 重力 stationId groundStore',
    blocks: [
      {
        kind: 'prose',
        text: '以行星 ID（如 `\'P1\'`、`\'P2\'`）为键的只读字典。每个 `Planet` 同时聚合公开遥测参数（含 `systemId`、`stationId`、`habitability`、`gravity` 等）与本公司地面仓、对应轨道站仓视图。',
      },
      {
        kind: 'syntax',
        code: 'readonly Game.planets: Record<string, Planet>',
      },
      {
        kind: 'example',
        caption: '读取母星地面燃料与对应轨道站 ID',
        code: `module.exports.loop = function () {
  const home = Game.planets[Game.company.homePlanetId];
  if (!home) return;
  console.log(home.name, '轨道站:', home.stationId, '地面燃料:', home.groundStore[RESOURCE_FUEL]);
};`,
      },
      {
        kind: 'links',
        items: [
          { label: 'Planet', id: 'Planet' },
          { label: 'Store', id: 'Store' },
        ],
      },
    ],
  },
  {
    id: 'Game.stations',
    title: 'stations',
    group: 'Game 接口',
    parent: 'Game',
    kind: '属性',
    summary: '全星系所有空间站的只读字典（覆盖轨道站与中心枢纽站全集）',
    keywords: 'Game.stations 空间站 轨道站 枢纽站 ST:HUB store 库存',
    blocks: [
      {
        kind: 'prose',
        text: '以空间站 ID（如 `\'ST:P2\'`、`\'ST:HUB\'`）为键的只读字典，包含世界上的**全部空间站对象**。即使本公司在某站点暂无任何库存，该条目依然存在且其 `store` 所有物品读数为 `0`。',
      },
      {
        kind: 'syntax',
        code: 'readonly Game.stations: Record<string, Station>',
      },
      {
        kind: 'example',
        caption: '巡检所有空间站的燃料储量',
        code: `module.exports.loop = function () {
  for (const st of Object.values(Game.stations)) {
    const fuel = st.store[RESOURCE_FUEL] || 0;
    if (fuel > 0) console.log(st.id, '所属星系:', st.systemId, '燃料:', fuel);
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
    id: 'Game.plots',
    title: 'plots',
    group: 'Game 接口',
    parent: 'Game',
    kind: '属性',
    summary: '本公司名下全部地块的只读字典，每个 Plot 挂载建筑/工地列表与 build() 方法',
    keywords: 'Game.plots 地块 建筑 工地 build 槽位',
    blocks: [
      {
        kind: 'prose',
        text: '以地块字符串 ID 为键的只读字典，包含本公司拥有的全部工业地块。每个 `Plot` 内含 `buildings`、`sites` 以及建厂方法 `plot.build(buildingType)`。',
      },
      {
        kind: 'syntax',
        code: 'readonly Game.plots: Record<string, Plot>',
      },
      {
        kind: 'example',
        caption: '寻找空余槽位并在其上建造矿业冶炼厂',
        code: `module.exports.loop = function () {
  const freePlot = Object.values(Game.plots).find((p) => p.usedSlots < p.capacity);
  if (freePlot) {
    console.log('可用地块:', freePlot.id, '剩余槽位:', freePlot.capacity - freePlot.usedSlots);
  }
};`,
      },
      {
        kind: 'links',
        items: [
          { label: 'Plot', id: 'Plot' },
          { label: 'Plot.build', id: 'Plot.build' },
        ],
      },
    ],
  },
  {
    id: 'Game.buildings',
    title: 'buildings',
    group: 'Game 接口',
    parent: 'Game',
    kind: '属性',
    summary: '本公司名下全部已完工建筑的只读字典',
    keywords: 'Game.buildings 建筑 工厂 产线 setRecipe setActive demolish',
    blocks: [
      {
        kind: 'prose',
        text: '以建筑字符串 ID 为键的只读字典，包含所有已完工并投入使用的建筑。正在施工中的建造任务位于 `Game.sites`，完工后才会迁入本字典。',
      },
      {
        kind: 'syntax',
        code: 'readonly Game.buildings: Record<string, Building>',
      },
      {
        kind: 'example',
        caption: '统计本公司各类型已完工建筑数量',
        code: `module.exports.loop = function () {
  const counts = {};
  for (const b of Object.values(Game.buildings)) {
    counts[b.type] = (counts[b.type] || 0) + 1;
  }
  console.log('已完工建筑分布:', counts);
};`,
      },
      {
        kind: 'links',
        items: [
          { label: 'Building', id: 'Building' },
          { label: 'Game.sites', id: 'Game.sites' },
        ],
      },
    ],
  },
  {
    id: 'Game.sites',
    title: 'sites',
    group: 'Game 接口',
    parent: 'Game',
    kind: '属性',
    summary: '本公司名下全部在建工程的只读字典（对应正在施工中的建造队列）',
    keywords: 'Game.sites 工地 在建 建造 倒计时 ConstructionSite ticksRemaining',
    blocks: [
      {
        kind: 'prose',
        text: '以工地字符串 ID 为键的只读字典，列出本公司正在施工中的全部建造项目。通过 `plot.build()` 发起建造且落账后，在完工前的每一个 tick 都可在此查询剩余施工时间 `ticksRemaining`。',
      },
      {
        kind: 'syntax',
        code: 'readonly Game.sites: Record<string, ConstructionSite>',
      },
      {
        kind: 'example',
        caption: '查看仍在施工中的建筑及其剩余周期',
        code: `module.exports.loop = function () {
  for (const site of Object.values(Game.sites)) {
    console.log('在建:', site.buildingType, '地块:', site.plotId, '剩余:', site.ticksRemaining, 'tick');
  }
};`,
      },
      {
        kind: 'links',
        items: [
          { label: 'ConstructionSite', id: 'ConstructionSite' },
          { label: 'Plot.build', id: 'Plot.build' },
          { label: 'Game.buildings', id: 'Game.buildings' },
        ],
      },
    ],
  },
  {
    id: 'Game.ships',
    title: 'ships',
    group: 'Game 接口',
    parent: 'Game',
    kind: '属性',
    summary: '本公司名下全部飞船的只读字典',
    keywords: 'Game.ships 飞船 舰队 dispatch repair',
    blocks: [
      {
        kind: 'prose',
        text: '以飞船字符串 ID 为键的只读字典，包含本公司所有货船与航运状态，可在每艘 `Ship` 上直接调用 `dispatch(to, cargo)` 与 `repair()`。',
      },
      {
        kind: 'syntax',
        code: 'readonly Game.ships: Record<string, Ship>',
      },
      {
        kind: 'example',
        caption: '筛选所有空闲飞船',
        code: `module.exports.loop = function () {
  const idle = Object.values(Game.ships).filter((s) => !s.isBusy);
  console.log('空闲飞船数:', idle.length);
};`,
      },
      {
        kind: 'links',
        items: [
          { label: 'Ship', id: 'Ship' },
          { label: 'Ship.dispatch', id: 'Ship.dispatch' },
        ],
      },
    ],
  },
  {
    id: 'Game.catalog',
    title: 'catalog',
    group: 'Game 接口',
    parent: 'Game',
    kind: '属性',
    summary: '全量只读静态世界配置字典（物品、建筑、配方及按建筑分组的配方索引）',
    keywords: 'Game.catalog 静态 数据 物品 建筑 配方 items buildings recipes recipesByBuilding getRecipe',
    blocks: [
      {
        kind: 'prose',
        text: '`Game.catalog` 在沙盒实例化时加载一次并深度冻结，提供当前世界的全部物品参考价与角色、建筑建造成本与耗时、生产配方输入输出及按建筑类型索引的配方清单。读取耗时几乎为零，不再需要反复按 ID 查询单个配方。',
      },
      {
        kind: 'syntax',
        code: 'readonly Game.catalog: CatalogInfo',
      },
      {
        kind: 'example',
        caption: '动态遍历某建筑类型的所有可用配方并计算毛利',
        code: `module.exports.loop = function () {
  const smelterRecipes = Game.catalog.recipesByBuilding.mine_smelter || [];
  for (const rid of smelterRecipes) {
    const r = Game.catalog.recipes[rid];
    console.log(rid, r.name, '周期:', r.cycleTicks, '输入:', r.inputs, '输出:', r.outputs);
  }
};`,
      },
      {
        kind: 'links',
        items: [
          { label: 'CatalogInfo', id: 'CatalogInfo' },
          { label: '默认世界建筑与配方', id: 'constants/world-catalog' },
          { label: 'RESOURCES_ALL', id: 'RESOURCES_ALL' },
        ],
      },
    ],
  },
  {
    id: 'Game.lastTick',
    title: 'lastTick',
    group: 'Game 接口',
    parent: 'Game',
    kind: '属性',
    summary: '上一 tick 结算阶段的真实成交流水与被拒意图回执',
    keywords: 'Game.lastTick fills rejected 成交流水 拒绝回执 错误原因 闭环',
    blocks: [
      {
        kind: 'prose',
        text: '由世界内核在上一 tick 落账阶段完成后注入的反馈快照。包含本公司真实成交的每一笔 `fills`（同时挂在 `Game.market.transactions` 上）以及同步曾返回 `OK`、但落账阶段未生效的请求列表 `rejected`（帮助脚本彻底告别静默失效）。',
      },
      {
        kind: 'syntax',
        code: 'readonly Game.lastTick: LastTickFeedback',
      },
      {
        kind: 'example',
        caption: '统计上回合市场成交额并处理被拒操作',
        code: `module.exports.loop = function () {
  for (const fill of Game.lastTick.fills) {
    console.log('[成交]', fill.stationId, fill.side, fill.itemId, fill.qty, '@', fill.price);
  }
  for (const rej of Game.lastTick.rejected) {
    console.warn('[被拒]', rej.action, rej.target, 'code=', rej.code, rej.reason);
  }
};`,
      },
      {
        kind: 'links',
        items: [
          { label: 'LastTickFeedback', id: 'LastTickFeedback' },
          { label: '执行与落账机制', id: 'guides/execution' },
          { label: '返回码一览', id: 'constants/return-codes' },
        ],
      },
    ],
  },
  {
    id: 'Game.getObjectById',
    title: 'getObjectById',
    group: 'Game 接口',
    parent: 'Game',
    kind: '方法',
    summary: '按全局唯一字符串 ID 检索建筑、地块、工地、飞船、行星、空间站或恒星系',
    keywords: 'Game.getObjectById id 查找 对象 实体 Memory 还原',
    blocks: [
      {
        kind: 'prose',
        text: '传入字符串 ID（仅保存 ID 在 `Memory` 中的场景尤为常见），依次在 `buildings`、`plots`、`sites`、`ships`、`planets`、`stations` 与 `systems` 中查找并返回对应只读快照对象。',
      },
      {
        kind: 'syntax',
        code: 'Game.getObjectById(id: string): Building | Plot | ConstructionSite | Ship | Planet | Station | StarSystem | null',
      },
      {
        kind: 'params',
        rows: [
          { name: 'id', type: 'string', required: 'required', desc: '待查找的实体字符串 ID' },
        ],
      },
      {
        kind: 'returns',
        type: 'Building | Plot | ConstructionSite | Ship | Planet | Station | StarSystem | null',
        desc: '找到时返回对应的只读实体对象；传入 `null`、`undefined` 或 ID 不存在时返回 `null`',
      },
      {
        kind: 'example',
        caption: '根据 Memory 中记录的飞船 ID 取回对象',
        code: `module.exports.loop = function () {
  if (!Memory.mainShipId) {
    const first = Object.values(Game.ships)[0];
    if (first) Memory.mainShipId = first.id;
  }
  const ship = Memory.mainShipId ? Game.getObjectById(Memory.mainShipId) : null;
  if (ship) console.log('主力飞船位置:', ship.location, '忙碌:', ship.isBusy);
};`,
      },
      {
        kind: 'links',
        items: [
          { label: 'ID 与坐标约定', id: 'guides/ids' },
          { label: 'Memory', id: 'Memory' },
        ],
      },
    ],
  },
  {
    id: 'Game.map',
    title: 'map',
    group: 'Game 接口',
    kind: '属性',
    summary: '星图、航线估算、行星地面格点、一手购地及公开公司情报域',
    keywords: 'Game.map 星图 航线 土地 买地 情报 calcRoute getLandPlots buyPlot listCompanies getCompany',
    blocks: [
      {
        kind: 'prose',
        text: '`Game.map` 集中负责空间拓扑与地图资源域：估算星球/站点航线耗时油耗、勘测某颗行星的全部公开网格坐标、认购一手未开发空地，以及查看竞争对手公司的公开资产与设施布局。',
      },
      {
        kind: 'syntax',
        code: 'readonly Game.map: MapAPI',
      },
      {
        kind: 'methods',
        title: '星图与情报方法（Methods）',
        rows: [
          { signature: 'Game.map.calcRoute(fromId: string, toId: string)', returns: 'RouteCost | null', desc: '估算两点间航线耗时、小船基准油耗及航段类型', id: 'Game.map.calcRoute' },
          { signature: 'Game.map.getLandPlots(planetId: string)', returns: 'PublicLandPlot[] | null', desc: '获取行星表面全部公开格点状态、地形加成与报价', id: 'Game.map.getLandPlots' },
          { signature: 'Game.map.buyPlot(planetId: string, slotId: number)', returns: 'RetCode', desc: '按位置编号 `slotId` 购买行星上的一手未认领空地', id: 'Game.map.buyPlot' },
          { signature: 'Game.map.listCompanies(filter?: CompanyFilter)', returns: 'PublicCompanySummary[]', desc: '分页筛选全星系各公司的公开资产摘要', id: 'Game.map.listCompanies' },
          { signature: 'Game.map.getCompany(companyId: string)', returns: 'PublicCompanyDetail | null', desc: '查看指定公司的公开地块坐标、建筑分布与活跃挂单', id: 'Game.map.getCompany' },
        ],
      },
      {
        kind: 'links',
        items: [
          { label: 'Game.map.calcRoute', id: 'Game.map.calcRoute' },
          { label: 'Game.map.getLandPlots', id: 'Game.map.getLandPlots' },
          { label: 'Game.map.buyPlot', id: 'Game.map.buyPlot' },
          { label: 'Game.market.buyLand', id: 'Game.market.buyLand' },
        ],
      },
    ],
  },
  {
    id: 'Game.map.calcRoute',
    title: 'calcRoute',
    group: 'Game 接口',
    parent: 'Game.map',
    kind: '方法',
    summary: '估算起点到终点之间的航线耗时、小船基准油耗与航段类型',
    keywords: 'Game.map.calcRoute 航线 耗时 油耗 燃料 orbital interplanetary',
    blocks: [
      {
        kind: 'prose',
        text: '计算任意两个位置标识之间的单程航行成本，可用于派船前的燃料预检查与物流利润测算。',
      },
      {
        kind: 'syntax',
        code: 'Game.map.calcRoute(fromId: string, toId: string): RouteCost | null',
      },
      {
        kind: 'params',
        rows: [
          { name: 'fromId', type: 'string', required: 'required', desc: '出发位置，如行星 `\'P2\'`、轨道站 `\'ST:P2\'` 或 `\'ST:HUB\'`' },
          { name: 'toId', type: 'string', required: 'required', desc: '目标位置（不能与 `fromId` 相同）' },
        ],
      },
      {
        kind: 'returns',
        type: 'RouteCost | null',
        desc: '存在可达航线时返回 `RouteCost`；参数错误、站点无效、起终点相同或不可达时返回 `null`',
      },
      {
        kind: 'note',
        level: 'info',
        text: '`ticks` 与 `fuel` 按**小货船（small）且满耐久**估算：地面 ↔ 轨道航段中型/大型船真实耗时与油耗约为小船的 **2 / 4 倍**；星际段耗时与船型无关；耐久为 `0` 时耗时翻倍但不增加油耗。',
      },
      {
        kind: 'example',
        caption: '估算从母星地面飞往枢纽站的总耗时与单船油耗',
        code: `module.exports.loop = function () {
  const pid = Game.company.homePlanetId;
  const r1 = Game.map.calcRoute(pid, 'ST:' + pid);
  const r2 = Game.map.calcRoute('ST:' + pid, 'ST:HUB');
  if (r1 && r2) {
    console.log('地面->轨道:', r1, '轨道->Hub:', r2);
  }
};`,
      },
      {
        kind: 'links',
        items: [
          { label: 'RouteCost', id: 'RouteCost' },
          { label: 'Ship.dispatch', id: 'Ship.dispatch' },
        ],
      },
    ],
  },
  {
    id: 'Game.map.getLandPlots',
    title: 'getLandPlots',
    group: 'Game 接口',
    parent: 'Game.map',
    kind: '方法',
    summary: '获取指定行星表面全部公开格点的坐标、地形加成与归属状态',
    keywords: 'Game.map.getLandPlots 地块 坐标 地形 加成 slotId status',
    blocks: [
      {
        kind: 'prose',
        text: '返回目标行星全部地面格点信息（包括城市区块、未认领空地、二手/清算挂牌地与他方已占工业区），通常与 `Game.map.buyPlot` 配合进行定向选址。',
      },
      {
        kind: 'syntax',
        code: 'Game.map.getLandPlots(planetId: string): PublicLandPlot[] | null',
      },
      {
        kind: 'params',
        rows: [
          { name: 'planetId', type: 'string', required: 'required', desc: '目标行星 ID，如 `\'P2\'`' },
        ],
      },
      {
        kind: 'returns',
        type: 'PublicLandPlot[] | null',
        desc: '行星存在时返回公开格点数组；参数非法或行星不存在时返回 `null`',
      },
      {
        kind: 'example',
        caption: '筛选炼钢效率加成最高的未认领空地',
        code: `module.exports.loop = function () {
  const tiles = Game.map.getLandPlots(Game.company.homePlanetId);
  if (!tiles) return;
  const best = tiles
    .filter((t) => t.status === 'unclaimed' && t.capacity >= 4)
    .sort((a, b) => (b.buildingMods.mine_smelter || 0) - (a.buildingMods.mine_smelter || 0))[0];
  if (best) {
    console.log('推荐空地 slotId:', best.slotId, '地形:', best.terrainName, '价格:', best.price);
  }
};`,
      },
      {
        kind: 'links',
        items: [
          { label: 'PublicLandPlot', id: 'PublicLandPlot' },
          { label: 'Game.map.buyPlot', id: 'Game.map.buyPlot' },
        ],
      },
    ],
  },
  {
    id: 'Game.map.buyPlot',
    title: 'buyPlot',
    group: 'Game 接口',
    parent: 'Game.map',
    kind: '方法',
    summary: '按位置编号购买指定行星上的一手未认领空地',
    keywords: 'Game.map.buyPlot 买地 一手空地 slotId 地块',
    blocks: [
      {
        kind: 'prose',
        text: '使用地面格点坐标 `slotId` 购买对应行星上的未开发空地（一手工业用地）。若需购买玩家或银行挂牌的二手地块，请改用 `Game.market.buyLand(listingId)`。',
      },
      {
        kind: 'syntax',
        code: 'Game.map.buyPlot(planetId: string, slotId: number): RetCode',
      },
      {
        kind: 'params',
        rows: [
          { name: 'planetId', type: 'string', required: 'required', desc: '目标行星 ID，如 `\'P2\'`' },
          { name: 'slotId', type: 'number', required: 'required', desc: '来自 `Game.map.getLandPlots(planetId)` 且 `status === \'unclaimed\'` 的永久位置编号' },
        ],
      },
      {
        kind: 'returns',
        type: 'RetCode',
        desc: '返回 `OK` 表示买地请求通过影账预扣并已入队；否则返回对应负数错误码',
      },
      {
        kind: 'errors',
        rows: [
          { code: 'ERR_INVALID_ARGS', when: '`planetId` 非非空字符串，或 `slotId` 缺失 / 无法解析为整数' },
          { code: 'ERR_NOT_FOUND', when: '目标行星或该行星下对应 `slotId` 不存在' },
          { code: 'ERR_INVALID_TARGET', when: '目标格点非 `unclaimed` 空地，或本 tick 已被同脚本认购' },
          { code: 'ERR_NOT_ENOUGH_CREDITS', when: '可用现金不足一手地价（计入本 tick 影账已支出），或当前公司存在逾期未还贷款' },
          { code: 'ERR_FULL', when: '本 tick 32 条脚本写操作配额已满' },
        ],
      },
      {
        kind: 'settlement',
        items: [
          '多名玩家在同一个 tick 抢拍同一块一手空地时，洗牌排在后面的玩家将在落账阶段失败并在 `Game.lastTick.rejected` 收到 `ERR_INVALID_TARGET` 或 `ERR_NOT_FOUND`；',
          '同 tick 若因先前订单/施工扣款导致落账时刻实际余额低于一手地价，将收到 `ERR_NOT_ENOUGH_CREDITS`。',
        ],
      },
      {
        kind: 'example',
        caption: '挑选槽位充足的未认领空地并购入',
        code: `module.exports.loop = function () {
  const pid = Game.company.homePlanetId;
  const tiles = Game.map.getLandPlots(pid);
  if (!tiles) return;
  const target = tiles.find((t) => t.status === 'unclaimed' && t.capacity >= 4 && t.price !== null);
  if (!target || target.price === null || Game.company.cash < target.price) return;

  const rc = Game.map.buyPlot(pid, target.slotId);
  if (rc === OK) console.log('已申购空地 slotId:', target.slotId);
};`,
      },
      {
        kind: 'links',
        items: [
          { label: 'Game.map.getLandPlots', id: 'Game.map.getLandPlots' },
          { label: 'Game.market.buyLand', id: 'Game.market.buyLand' },
          { label: 'Plot.build', id: 'Plot.build' },
        ],
      },
    ],
  },
  {
    id: 'Game.map.listCompanies',
    title: 'listCompanies',
    group: 'Game 接口',
    parent: 'Game.map',
    kind: '方法',
    summary: '分页筛选并查看全星系所有公司的公开资产摘要',
    keywords: 'Game.map.listCompanies 公司 排名 筛选 分页 情报',
    blocks: [
      {
        kind: 'prose',
        text: '按关键字、母星或玩家标识分页查询所有在册公司的公开统计摘要（净流动资金、地块数、建筑数、各型飞船数与挂单数）。',
      },
      {
        kind: 'syntax',
        code: `Game.map.listCompanies(filter?: {
  query?: string;
  planetId?: string;
  onlyPlayers?: boolean;
  offset?: number;
  limit?: number;
}): PublicCompanySummary[]`,
      },
      {
        kind: 'params',
        rows: [
          { name: 'filter', type: 'object', required: 'optional', desc: '可选筛选与分页参数对象；省略则返回前 `100` 家公司' },
          { name: 'filter.query', type: 'string', required: 'optional', desc: '按公司 ID、名称或母星 ID 做不区分大小写子串匹配' },
          { name: 'filter.planetId', type: 'string', required: 'optional', desc: '按母星 ID 精确过滤，如 `\'P2\'`' },
          { name: 'filter.onlyPlayers', type: 'boolean', required: 'optional', desc: '传 `true` 时仅返回人类玩家公司' },
          { name: 'filter.offset', type: 'number', required: 'optional', desc: '分页偏移量，默认 `0`' },
          { name: 'filter.limit', type: 'number', required: 'optional', desc: '每页最大返回条数，默认 `100`，硬上限 `1000`' },
        ],
      },
      {
        kind: 'returns',
        type: 'PublicCompanySummary[]',
        desc: '符合条件的公司公开摘要数组；无匹配结果时返回空数组 `[]`',
      },
      {
        kind: 'example',
        caption: '列出资金实力最强的 5 家玩家公司',
        code: `module.exports.loop = function () {
  const rivals = Game.map
    .listCompanies({ onlyPlayers: true, limit: 200 })
    .sort((a, b) => b.netLiquid - a.netLiquid)
    .slice(0, 5);
  console.log('玩家资金前五:', rivals.map((c) => [c.name, c.netLiquid]));
};`,
      },
      {
        kind: 'links',
        items: [
          { label: 'PublicCompanySummary', id: 'PublicCompanySummary' },
          { label: 'Game.map.getCompany', id: 'Game.map.getCompany' },
        ],
      },
    ],
  },
  {
    id: 'Game.map.getCompany',
    title: 'getCompany',
    group: 'Game 接口',
    parent: 'Game.map',
    kind: '方法',
    summary: '查看指定公司的公开地块坐标、建筑分类统计与活跃挂单详情',
    keywords: 'Game.map.getCompany 公司 详情 竞品 建筑 挂单',
    blocks: [
      {
        kind: 'prose',
        text: '按公司 ID 查询竞争对手的完整公开商业情报，用于评估全市场同类产能供给与挂单分布。',
      },
      {
        kind: 'syntax',
        code: 'Game.map.getCompany(companyId: string): PublicCompanyDetail | null',
      },
      {
        kind: 'params',
        rows: [
          { name: 'companyId', type: 'string', required: 'required', desc: '目标公司 ID（可从 `listCompanies` 或挂单 `ownerId` 获取）' },
        ],
      },
      {
        kind: 'returns',
        type: 'PublicCompanyDetail | null',
        desc: '公司存在时返回公开详情对象；否则返回 `null`',
      },
      {
        kind: 'example',
        caption: '分析枢纽站钢材最低卖单挂出方的公司产能',
        code: `module.exports.loop = function () {
  const orders = Game.market.getAllOrders({ stationId: 'ST:HUB', resourceType: RESOURCE_STEEL, type: ORDER_SELL });
  if (orders.length === 0) return;
  const info = Game.map.getCompany(orders[0].ownerId);
  if (info) {
    console.log(info.name, '建筑分布:', info.buildingCounts, '在挂单:', info.openOrdersCount);
  }
};`,
      },
      {
        kind: 'links',
        items: [
          { label: 'PublicCompanyDetail', id: 'PublicCompanyDetail' },
          { label: 'Game.map.listCompanies', id: 'Game.map.listCompanies' },
        ],
      },
    ],
  },
  {
    id: 'Game.bank',
    title: 'bank',
    group: 'Game 接口',
    kind: '属性',
    summary: '母星央行域：提供存款、取款、申请信用贷款与还款四个语义化方法',
    keywords: 'Game.bank 银行 央行 存款 取款 借款 还款 利息 deposit withdraw borrow repay',
    blocks: [
      {
        kind: 'prose',
        text: '`Game.bank` 将央行操作拆分为四个语义独立方法。`planetId` 参数均可省略，默认操作本公司母星（`Game.company.homePlanetId`）。若主动传入其他行星 ID，将返回 `ERR_INVALID_TARGET`。',
      },
      {
        kind: 'syntax',
        code: 'readonly Game.bank: BankAPI',
      },
      {
        kind: 'methods',
        title: '央行方法一览（Methods）',
        rows: [
          { signature: 'Game.bank.deposit(amount: number, planetId?: string)', returns: 'RetCode', desc: '将可用现金存入母星央行储蓄生息', id: 'Game.bank.deposit' },
          { signature: 'Game.bank.withdraw(amount: number, planetId?: string)', returns: 'RetCode', desc: '从母星央行储蓄取出信用点到可用现金', id: 'Game.bank.withdraw' },
          { signature: 'Game.bank.borrow(amount: number, planetId?: string)', returns: 'RetCode', desc: '向母星央行申请短期信用贷款（期限 360 tick）', id: 'Game.bank.borrow' },
          { signature: 'Game.bank.repay(amount: number, planetId?: string)', returns: 'RetCode', desc: '偿还母星央行贷款本息', id: 'Game.bank.repay' },
        ],
      },
      {
        kind: 'note',
        level: 'warn',
        text: '贷款期限固定为 `360` tick；逾期后将无法再买地与借贷，且卖货/卖地收入会被系统自动扣缴 **25%** 抵债。',
      },
      {
        kind: 'links',
        items: [
          { label: 'Game.bank.deposit', id: 'Game.bank.deposit' },
          { label: 'Game.bank.borrow', id: 'Game.bank.borrow' },
          { label: 'CompanyInfo', id: 'CompanyInfo' },
          { label: '核心经济规则', id: 'guides/economy' },
        ],
      },
    ],
  },
  {
    id: 'Game.bank.deposit',
    title: 'deposit',
    group: 'Game 接口',
    parent: 'Game.bank',
    kind: '方法',
    summary: '将指定金额可用现金存入母星央行赚取储蓄利息',
    keywords: 'Game.bank.deposit 存款 储蓄 利息 银行',
    blocks: [
      {
        kind: 'prose',
        text: '将现金划入母星央行储蓄账户。存款可在保证一定闲置资金增值同时随时通过 `withdraw` 支取。',
      },
      {
        kind: 'syntax',
        code: 'Game.bank.deposit(amount: number, planetId?: string): RetCode',
      },
      {
        kind: 'params',
        rows: [
          { name: 'amount', type: 'number', required: 'required', desc: '存入信用点数量（须大于 `0` 且精度 `>= 0.0001`）' },
          { name: 'planetId', type: 'string', required: 'optional', desc: '目标央行所在行星 ID，省略默认 `Game.company.homePlanetId`' },
        ],
      },
      {
        kind: 'returns',
        type: 'RetCode',
        desc: '返回 `OK` 表示通过校验并入队；否则返回负数错误码',
      },
      {
        kind: 'errors',
        rows: [
          { code: 'ERR_INVALID_ARGS', when: '`amount` 非正有限数、舍入后 `<= 0`，或 `planetId` 非有效非空字符串' },
          { code: 'ERR_NOT_FOUND', when: '指定 `planetId` 对应的行星不存在' },
          { code: 'ERR_INVALID_TARGET', when: '传入的 `planetId` 不是本公司母星 `Game.company.homePlanetId`' },
          { code: 'ERR_NOT_ENOUGH_CREDITS', when: '可用现金少于 `amount`（含本 tick 影账已消费部分）' },
          { code: 'ERR_FULL', when: '本 tick 脚本 32 条写操作配额已满' },
        ],
      },
      {
        kind: 'settlement',
        items: [
          '落账阶段因市场买单或施工费用扣款导致实际剩余现金不足 `amount`（触发部分成交扣除或失败记账 `Game.lastTick.rejected`）。',
        ],
      },
      {
        kind: 'example',
        caption: '保留 2000 现金周转，把多余资金存入母星央行',
        code: `module.exports.loop = function () {
  const surplus = Game.company.cash - 2000;
  if (surplus > 100) {
    Game.bank.deposit(surplus);
  }
};`,
      },
      {
        kind: 'links',
        items: [
          { label: 'Game.bank', id: 'Game.bank' },
          { label: 'Game.bank.withdraw', id: 'Game.bank.withdraw' },
        ],
      },
    ],
  },
  {
    id: 'Game.bank.withdraw',
    title: 'withdraw',
    group: 'Game 接口',
    parent: 'Game.bank',
    kind: '方法',
    summary: '从母星央行储蓄账户取回指定金额到可用现金',
    keywords: 'Game.bank.withdraw 取款 提现 储蓄 银行',
    blocks: [
      {
        kind: 'prose',
        text: '从母星央行取出已有储蓄。注意取款受银行流动性储备池比例（最低 25% 准备金约束）限制；若全行准备金吃紧，实际可取金额可能低于自身账面储蓄。',
      },
      {
        kind: 'syntax',
        code: 'Game.bank.withdraw(amount: number, planetId?: string): RetCode',
      },
      {
        kind: 'params',
        rows: [
          { name: 'amount', type: 'number', required: 'required', desc: '期望取回的信用点金额（`> 0`）' },
          { name: 'planetId', type: 'string', required: 'optional', desc: '省略时默认本公司母星' },
        ],
      },
      {
        kind: 'returns',
        type: 'RetCode',
        desc: '返回 `OK` 表示通过影账检验并入队；否则返回负数错误码',
      },
      {
        kind: 'errors',
        rows: [
          { code: 'ERR_INVALID_ARGS', when: '`amount <= 0` 或非有限数，或 `planetId` 无效' },
          { code: 'ERR_NOT_FOUND', when: '目标行星不存在' },
          { code: 'ERR_INVALID_TARGET', when: '目标行星非母星 `Game.company.homePlanetId`' },
          { code: 'ERR_NOT_ENOUGH_CREDITS', when: '自身剩余储蓄 `Game.company.savings` 小于 `amount`' },
          { code: 'ERR_FULL', when: '本 tick 写操作配额已满' },
        ],
      },
      {
        kind: 'settlement',
        items: [
          '落账阶段母星银行可用流动现金不足或触及 25% 准备金红线导致无法足额兑付（写入 `Game.lastTick.rejected`）。',
        ],
      },
      {
        kind: 'example',
        caption: '现金不足 500 时从央行储蓄补充流动资金',
        code: `module.exports.loop = function () {
  if (Game.company.cash < 500 && Game.company.savings >= 500) {
    Game.bank.withdraw(500);
  }
};`,
      },
      {
        kind: 'links',
        items: [
          { label: 'Game.bank', id: 'Game.bank' },
          { label: 'Game.bank.deposit', id: 'Game.bank.deposit' },
        ],
      },
    ],
  },
  {
    id: 'Game.bank.borrow',
    title: 'borrow',
    group: 'Game 接口',
    parent: 'Game.bank',
    kind: '方法',
    summary: '向母星央行申请指定金额信用贷款，期限 360 tick',
    keywords: 'Game.bank.borrow 借款 贷款 杠杆 银行',
    blocks: [
      {
        kind: 'prose',
        text: '向母星央行借入资金扩大经营。授信额度与央行准备金池以及当前公司信用状况挂钩，年化参考利率见 `Game.planets[homePlanetId].bankRatePct`。',
      },
      {
        kind: 'syntax',
        code: 'Game.bank.borrow(amount: number, planetId?: string): RetCode',
      },
      {
        kind: 'params',
        rows: [
          { name: 'amount', type: 'number', required: 'required', desc: '申请借款信用点金额（`> 0`）' },
          { name: 'planetId', type: 'string', required: 'optional', desc: '省略时默认本公司母星' },
        ],
      },
      {
        kind: 'returns',
        type: 'RetCode',
        desc: '返回 `OK` 表示通过同步检查并入队；否则返回负数错误码',
      },
      {
        kind: 'errors',
        rows: [
          { code: 'ERR_INVALID_ARGS', when: '`amount <= 0`、累加负债后数值溢出，或 `planetId` 无效' },
          { code: 'ERR_NOT_FOUND', when: '目标行星不存在' },
          { code: 'ERR_INVALID_TARGET', when: '非母星请求，或当前已有贷款处于逾期状态（`debt > 0 && Game.time > debtDueTick`）' },
          { code: 'ERR_FULL', when: '本 tick 写操作配额已满' },
        ],
      },
      {
        kind: 'settlement',
        items: [
          '落账阶段超出公司在母星的抵押授信上限、或母星央行可贷现金池储备不足以拨付。',
        ],
      },
      {
        kind: 'example',
        caption: '无负债时向央行借入 1000 信用点启动扩产',
        code: `module.exports.loop = function () {
  if (Game.company.debt === 0 && Game.company.cash < 300) {
    const rc = Game.bank.borrow(1000);
    if (rc === OK) console.log('已提交借款申请');
  }
};`,
      },
      {
        kind: 'links',
        items: [
          { label: 'Game.bank', id: 'Game.bank' },
          { label: 'Game.bank.repay', id: 'Game.bank.repay' },
        ],
      },
    ],
  },
  {
    id: 'Game.bank.repay',
    title: 'repay',
    group: 'Game 接口',
    parent: 'Game.bank',
    kind: '方法',
    summary: '偿还母星央行已有贷款本息',
    keywords: 'Game.bank.repay 还款 债务 利息 银行',
    blocks: [
      {
        kind: 'prose',
        text: '使用可用现金偿还当前母星央行欠款（自动截断为当前剩余欠款 `Game.company.debt` 以内的实付额）。还清后逾期限制即刻解除。',
      },
      {
        kind: 'syntax',
        code: 'Game.bank.repay(amount: number, planetId?: string): RetCode',
      },
      {
        kind: 'params',
        rows: [
          { name: 'amount', type: 'number', required: 'required', desc: '本次期望偿还的信用点金额（`> 0`，超出剩余负债部分自动截断）' },
          { name: 'planetId', type: 'string', required: 'optional', desc: '省略时默认本公司母星' },
        ],
      },
      {
        kind: 'returns',
        type: 'RetCode',
        desc: '返回 `OK` 表示通过检查并入队；否则返回负数错误码',
      },
      {
        kind: 'errors',
        rows: [
          { code: 'ERR_INVALID_ARGS', when: '`amount <= 0` 或非有限数，或 `planetId` 无效' },
          { code: 'ERR_NOT_FOUND', when: '目标行星不存在' },
          { code: 'ERR_INVALID_TARGET', when: '传入行星非本公司母星' },
          { code: 'ERR_NOT_ENOUGH_CREDITS', when: '当前无剩余待还负债（`debt === 0`），或可用现金不足实际待还金额' },
          { code: 'ERR_FULL', when: '本 tick 写操作配额已满' },
        ],
      },
      {
        kind: 'settlement',
        items: [
          '落账阶段因先前扣款消费导致实际可用现金低于待还本息金额。',
        ],
      },
      {
        kind: 'example',
        caption: '贷款剩余不足 30 tick 到期时自动全额清偿',
        code: `module.exports.loop = function () {
  const c = Game.company;
  if (c.debt > 0 && c.debtDueTick !== null && c.debtDueTick - Game.time <= 30) {
    if (c.cash >= c.debt) Game.bank.repay(c.debt);
  }
};`,
      },
      {
        kind: 'links',
        items: [
          { label: 'Game.bank', id: 'Game.bank' },
          { label: 'Game.bank.borrow', id: 'Game.bank.borrow' },
        ],
      },
    ],
  },
];

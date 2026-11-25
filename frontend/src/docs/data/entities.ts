import type { DocEntry } from '../types';

export const ENTITY_ENTRIES: DocEntry[] = [
  {
    id: 'Planet',
    title: 'Planet',
    group: '实体与数据结构',
    kind: '类型',
    summary: '行星公开遥测数据、二手地挂牌、城市需求与本公司在该星的仓库视图',
    keywords: 'Planet 行星 人口 繁荣 重力 废料 地价 二手地 landListings demands 需求 仓库 利率',
    blocks: [
      {
        kind: 'prose',
        text: '`Game.planets[planetId]` 返回的行星只读快照对象，同时包含行星公共遥测信息与本公司在该行星的地面仓、轨道站仓。',
      },
      {
        kind: 'fields',
        rows: [
          { name: 'id', type: 'string', desc: '行星 ID，如 `\'P2\'`' },
          { name: 'name', type: 'string', desc: '行星显示名称' },
          { name: 'wealthTier', type: 'number', desc: '富裕等级（`1..5`），等级越高城市消费种类与能力越强' },
          { name: 'prosperity', type: 'number', desc: '当前繁荣度指标' },
          { name: 'population', type: 'number', desc: '当前城市总人口' },
          { name: 'gravity', type: 'number', desc: '行星表面重力系数（影响飞船地面 ↔ 轨道起降耗时与油耗）' },
          { name: 'wasteBacklog', type: 'number', desc: '城市尚未消纳的废料堆积量（可由回收中心在生产时直接消纳）' },
          { name: 'primaryLandPrice', type: 'number | null', desc: '一手空地单价（信用点）；`null` 表示该行星已无未开发空地' },
          {
            name: 'landListings',
            type: 'Array<{ listingId: string; plotId: string; slotId: number; sellerId: string; askPrice: number; terrainName: string; lat: number; lon: number; capacity: number; usedSlots: number; buildingMods: Record<string, number>; buildings: string[] }>',
            desc: '本行星当前全部二手地与银行清算挂牌地块列表',
          },
          { name: 'bankRatePct', type: 'number', desc: '本星央行当前年化贷款利率（百分数，如 `4.5` 表示 4.5%）' },
          { name: 'groundStore', type: 'Store', desc: '本公司在该行星地面仓库的只读视图（无容量上限）' },
          { name: 'stationStore', type: 'Store', desc: '本公司在该行星轨道站（`ST:<planetId>`）仓库的只读视图（无容量上限）' },
          { name: 'demands', type: 'Record<string, { qty: number }>', desc: '本 tick 城市对各物品的需求量字典，键为物品 ID' },
        ],
      },
      {
        kind: 'note',
        level: 'info',
        text: '`groundStore` 与 `stationStore` 的 `getCapacity()` 和 `getFreeCapacity()` 均返回 `null`（星球地面仓与行星轨道站仓库不设容量上限）。',
      },
      {
        kind: 'example',
        caption: '查看行星最紧缺的 3 项物品需求与二手挂牌地',
        code: `module.exports.loop = function () {
  const p = Game.planets[Game.company.homePlanetId];
  if (!p) return;

  const top = Object.entries(p.demands)
    .sort((a, b) => b[1].qty - a[1].qty)
    .slice(0, 3);
  console.log(p.name, '需求前三:', top);

  for (const lst of p.landListings) {
    console.log('二手挂牌:', lst.listingId, lst.terrainName, '要价:', lst.askPrice);
  }
};`,
      },
      {
        kind: 'links',
        items: [
          { label: 'Game.planets', id: 'Game.planets' },
          { label: 'Game.buyPlot', id: 'Game.buyPlot' },
          { label: 'Station', id: 'Station' },
          { label: 'Store', id: 'Store' },
        ],
      },
    ],
  },
  {
    id: 'Station',
    title: 'Station',
    group: '实体与数据结构',
    kind: '类型',
    summary: '空间站对象，提供本公司在该站点的只读库存视图',
    keywords: 'Station 轨道站 枢纽站 ST:HUB store 仓库 库存',
    blocks: [
      {
        kind: 'prose',
        text: '`Game.stations[stationId]` 返回的空间站对象。注意 `Game.stations` 仅包含本公司当前有库存记录的站点，并非全星系站点全集。',
      },
      {
        kind: 'fields',
        rows: [
          { name: 'id', type: 'string', desc: '站点 ID，如 `\'ST:P2\'` 或 `\'ST:HUB\'`' },
          { name: 'store', type: 'Store', desc: '本公司在该站点的只读库存视图（`getCapacity()` 恒为 `null`）' },
        ],
      },
      {
        kind: 'note',
        level: 'warn',
        text: '在星系枢纽站 `ST:HUB` 存放物资会每 12 个 tick 按货物估值收取 **0.8%** 仓租；行星轨道站（`ST:P*`）免费。访问 `Game.stations[\'ST:HUB\']` 前请先判空。',
      },
      {
        kind: 'example',
        caption: '安全读取枢纽站库存总量',
        code: `module.exports.loop = function () {
  const hub = Game.stations['ST:HUB'];
  if (hub) {
    console.log('Hub 总存货量:', hub.store.getUsedCapacity());
  } else {
    console.log('当前在 ST:HUB 无任何库存记录');
  }
};`,
      },
      {
        kind: 'links',
        items: [
          { label: 'Game.stations', id: 'Game.stations' },
          { label: 'Store', id: 'Store' },
          { label: '核心经济规则', id: 'guides/economy' },
        ],
      },
    ],
  },
  {
    id: 'Plot',
    title: 'Plot',
    group: '实体与数据结构',
    kind: '类型',
    summary: '本公司名下的一块土地，包含地形、槽位容量与建筑效率修正',
    keywords: 'Plot 地块 土地 地形 slotId lat lon capacity usedSlots buildingMods',
    blocks: [
      {
        kind: 'prose',
        text: '`Game.plots[plotId]` 返回的自有地块只读快照对象。建筑的建造与拆除操作通过 `Game.buildFacility` 和 `Game.demolishFacility` 发起。',
      },
      {
        kind: 'fields',
        rows: [
          { name: 'id', type: 'string', desc: '地块 ID（数字字符串，用于建造与拆除）' },
          { name: 'slotId', type: 'number', desc: '行星表面永久位置编号' },
          { name: 'planetId', type: 'string', desc: '所属行星 ID' },
          { name: 'lat', type: 'number', desc: '行星表面纬度（度）' },
          { name: 'lon', type: 'number', desc: '行星表面经度（度）' },
          { name: 'terrainName', type: 'string', desc: '地形名称' },
          { name: 'capacity', type: 'number', desc: '最大建筑槽位数' },
          { name: 'usedSlots', type: 'number', desc: '当前已占用槽位数（含已完工建筑与施工中任务）' },
          { name: 'buildingMods', type: 'Record<string, number>', desc: '各建筑类型在该地形上的效率乘数（键为建筑类型 ID）' },
        ],
      },
      {
        kind: 'note',
        level: 'info',
        text: '当 `usedSlots >= capacity` 时无法继续建造新建筑，需先调用 `Game.demolishFacility` 腾出槽位，或调用 `Game.buyPlot` 购买新地块。',
      },
      {
        kind: 'example',
        caption: '查找适合建造矿业冶炼厂的空闲地块',
        code: `module.exports.loop = function () {
  const bestPlot = Object.values(Game.plots)
    .filter((p) => p.usedSlots < p.capacity)
    .sort((a, b) => (b.buildingMods.mine_smelter || 1) - (a.buildingMods.mine_smelter || 1))[0];

  if (bestPlot) {
    console.log('最优空闲地块:', bestPlot.id, '地形:', bestPlot.terrainName, '加成:', bestPlot.buildingMods.mine_smelter);
  }
};`,
      },
      {
        kind: 'links',
        items: [
          { label: 'Game.plots', id: 'Game.plots' },
          { label: 'Game.buildFacility', id: 'Game.buildFacility' },
          { label: 'Game.demolishFacility', id: 'Game.demolishFacility' },
          { label: 'PublicLandPlot', id: 'PublicLandPlot' },
        ],
      },
    ],
  },
  {
    id: 'Building',
    title: 'Building',
    group: '实体与数据结构',
    kind: '类型',
    summary: '公司名下的一座已完工生产建筑，可切换配方或控制开机停产',
    keywords: 'Building 建筑 工厂 生产 配方 efficiency progress cycleTicks',
    blocks: [
      {
        kind: 'prose',
        text: '`Game.buildings[buildingId]` 返回的生产建筑只读快照对象。处于开机状态（`active === true`）且原料、电力、现金工资满足时，建筑在周期开始时一次性扣除本周期原料、电力与工资，并在推进满 `cycleTicks` 后按 `efficiency` 倍率产出成品。',
      },
      {
        kind: 'fields',
        rows: [
          { name: 'id', type: 'string', desc: '建筑 ID（数字字符串）' },
          { name: 'type', type: 'string', desc: '建筑类型 ID，如 `\'mine_smelter\'`' },
          { name: 'plotId', type: 'string', desc: '所在地块 ID' },
          { name: 'planetId', type: 'string', desc: '所在行星 ID' },
          { name: 'efficiency', type: 'number', desc: '当前综合产出效率（地形修正 × 职业加成，保留两位小数）' },
          { name: 'recipeId', type: 'string', desc: '当前绑定的配方 ID' },
          { name: 'active', type: 'boolean', desc: '是否处于开机生产状态' },
          { name: 'progress', type: 'number', desc: '当前生产周期已推进的 tick 数' },
          { name: 'cycleTicks', type: 'number', desc: '当前绑定配方的总周期 tick 数' },
        ],
      },
      {
        kind: 'methods',
        rows: [
          { signature: 'building.setRecipe(recipeId: string)', returns: 'RetCode', desc: '切换该建筑的生产配方', id: 'Building.setRecipe' },
          { signature: 'building.setActive(active: boolean)', returns: 'RetCode', desc: '设置该建筑开机生产或停产待机', id: 'Building.setActive' },
        ],
      },
      {
        kind: 'example',
        caption: '查看所有建筑的生产进度',
        code: `module.exports.loop = function () {
  for (const b of Object.values(Game.buildings)) {
    console.log(b.id, b.type, b.recipeId, b.active ? '运行中' : '停产', b.progress + '/' + b.cycleTicks);
  }
};`,
      },
      {
        kind: 'links',
        items: [
          { label: 'Building.setRecipe', id: 'Building.setRecipe' },
          { label: 'Building.setActive', id: 'Building.setActive' },
          { label: 'RecipeInfo', id: 'RecipeInfo' },
          { label: 'Game.buildings', id: 'Game.buildings' },
        ],
      },
    ],
  },
  {
    id: 'Building.setRecipe',
    title: 'setRecipe',
    group: '实体与数据结构',
    parent: 'Building',
    kind: '方法',
    summary: '切换建筑当前绑定的生产配方（下一 tick 生效）',
    keywords: 'Building.setRecipe 切配方 换配方 生产',
    blocks: [
      {
        kind: 'prose',
        text: '为指定建筑更换生产配方。写操作在下一 tick 落账后生效；若当前建筑正处于一个已扣料的生产周期中，切换配方**不会清零 `progress`**，当前周期跑满时将按新配方的 `cycleTicks` 与 `outputs` 结算产出。',
      },
      {
        kind: 'syntax',
        code: 'building.setRecipe(recipeId: string): RetCode',
      },
      {
        kind: 'params',
        rows: [
          { name: 'recipeId', type: 'string', required: 'required', desc: '目标配方 ID（必须与 `building.type` 匹配，可通过 `Game.getRecipe(recipeId).buildingId` 确认）' },
        ],
      },
      {
        kind: 'returns',
        type: 'RetCode',
        desc: '返回 `OK` 表示切配方请求已入队，否则返回负数错误码',
      },
      {
        kind: 'errors',
        rows: [
          { code: 'ERR_INVALID_ARGS', when: '`recipeId` 不是非空字符串' },
          { code: 'ERR_NOT_OWNER', when: '该建筑不属于本公司' },
          { code: 'ERR_NOT_FOUND', when: '指定的 `recipeId` 不存在' },
          { code: 'ERR_INVALID_TARGET', when: '该配方不属于此建筑类型（`recipe.buildingId !== building.type`）' },
          { code: 'ERR_FULL', when: '本 tick 已用满 32 条写操作配额' },
        ],
      },
      {
        kind: 'settlement',
        items: [
          '目标配方在当前世界中处于禁用状态；',
          '该建筑在落账前已被拆除或随地块过户给其他公司。',
        ],
      },
      {
        kind: 'example',
        caption: '将矿业冶炼厂切换为碳还原炼钢配方',
        code: `module.exports.loop = function () {
  for (const b of Object.values(Game.buildings)) {
    if (b.type === 'mine_smelter' && b.recipeId !== 'steel_carbon') {
      const rc = b.setRecipe('steel_carbon');
      if (rc !== OK) console.warn('切换配方失败:', b.id, rc);
    }
  }
};`,
      },
      {
        kind: 'links',
        items: [
          { label: 'Building', id: 'Building' },
          { label: 'Building.setActive', id: 'Building.setActive' },
          { label: '默认世界建筑与配方', id: 'constants/world-catalog' },
        ],
      },
    ],
  },
  {
    id: 'Building.setActive',
    title: 'setActive',
    group: '实体与数据结构',
    parent: 'Building',
    kind: '方法',
    summary: '设置建筑开机运行或停产待机（下一 tick 生效）',
    keywords: 'Building.setActive 开机 停产 开关 active',
    blocks: [
      {
        kind: 'prose',
        text: '控制建筑开启生产或停产待机。停产期间不发起新的生产批次，仅每隔一个周期消耗少量的待机电力。',
      },
      {
        kind: 'syntax',
        code: 'building.setActive(active: boolean): RetCode',
      },
      {
        kind: 'params',
        rows: [
          { name: 'active', type: 'boolean', required: 'required', desc: '`true` 表示开机生产，`false` 表示停产待机' },
        ],
      },
      {
        kind: 'returns',
        type: 'RetCode',
        desc: '返回 `OK` 表示开关请求已入队，否则返回负数错误码',
      },
      {
        kind: 'errors',
        rows: [
          { code: 'ERR_INVALID_ARGS', when: '`active` 不是布尔类型（例如误传了 `1` 或 `\'true\'`）' },
          { code: 'ERR_NOT_OWNER', when: '该建筑不属于本公司' },
          { code: 'ERR_FULL', when: '本 tick 已用满 32 条写操作配额' },
        ],
      },
      {
        kind: 'settlement',
        items: [
          '该建筑在落账前已被拆除或随地块过户给其他公司。',
        ],
      },
      {
        kind: 'example',
        caption: '地面现金紧张时暂停冶炼厂，现金充足时恢复',
        code: `module.exports.loop = function () {
  const shouldRun = Game.company.cash >= 200;
  for (const b of Object.values(Game.buildings)) {
    if (b.type === 'mine_smelter' && b.active !== shouldRun) {
      b.setActive(shouldRun);
    }
  }
};`,
      },
      {
        kind: 'links',
        items: [
          { label: 'Building', id: 'Building' },
          { label: 'Building.setRecipe', id: 'Building.setRecipe' },
        ],
      },
    ],
  },
  {
    id: 'Ship',
    title: 'Ship',
    group: '实体与数据结构',
    kind: '类型',
    summary: '公司名下的星际运输飞船，支持混装派船与原地维修',
    keywords: 'Ship 飞船 运输 货舱 耐久 location isBusy busyUntil size',
    blocks: [
      {
        kind: 'prose',
        text: '`Game.ships[shipId]` 返回的飞船只读快照对象。飞船每次可接取一段单程运输任务（行星地面 ↔ 本星轨道站，或轨道站 ↔ 枢纽站），允许在同一趟中混装多种货物。',
      },
      {
        kind: 'fields',
        rows: [
          { name: 'id', type: 'string', desc: '飞船 ID（数字字符串）' },
          { name: 'size', type: "'small' | 'medium' | 'large'", desc: '船型规格（对应载货上限 `40` / `120` / `360` 件）' },
          { name: 'capacity', type: 'number', desc: '货舱最大载货件数' },
          { name: 'durability', type: 'number', desc: '当前耐久度（`0..100`）；降至 `0` 后航行耗时翻倍' },
          { name: 'location', type: 'string', desc: '当前位置 ID（如 `\'P2\'`、`\'ST:P2\'`、`\'ST:HUB\'`）；航行中显示目标目的地' },
          { name: 'isBusy', type: 'boolean', desc: '是否正在航行中（判断飞船是否空闲**必须使用此字段**）' },
          { name: 'busyUntil', type: 'number', desc: '最近一次派船的预计到达 tick（到站后不会自动清零）' },
          { name: 'store', type: 'Store', desc: '飞船货舱只读库存（仅在航行途中持有货物，到站卸载后清空）' },
        ],
      },
      {
        kind: 'methods',
        rows: [
          { signature: 'ship.dispatch(from: string, to: string, cargo: Record<string, number>)', returns: 'RetCode', desc: '从当前所在位置装货并派往目的地', id: 'Ship.dispatch' },
          { signature: 'ship.repair()', returns: 'RetCode', desc: '在当前位置消耗日用品恢复满耐久', id: 'Ship.repair' },
        ],
      },
      {
        kind: 'note',
        level: 'warn',
        text: '飞船到站后 `busyUntil` 仍保留上一次到达时的 tick 数值而不会归零，请不要用 `busyUntil === 0` 判断飞船是否空闲。',
      },
      {
        kind: 'links',
        items: [
          { label: 'Ship.dispatch', id: 'Ship.dispatch' },
          { label: 'Ship.repair', id: 'Ship.repair' },
          { label: 'Game.ships', id: 'Game.ships' },
          { label: 'Game.market.calcRoute', id: 'Game.market.calcRoute' },
        ],
      },
    ],
  },
  {
    id: 'Ship.dispatch',
    title: 'dispatch',
    group: '实体与数据结构',
    parent: 'Ship',
    kind: '方法',
    summary: '为当前空闲的飞船指派一段单程混装货运任务',
    keywords: 'Ship.dispatch 派船 运货 装货 燃料 航线',
    blocks: [
      {
        kind: 'prose',
        text: '指派飞船从 `from` 出发前往 `to`，并将 `cargo` 指定的货物从出发地仓库装载上船。出发地消耗的燃料也在 `from` 仓库中直接扣除。每次出航都会磨损耐久（地面 ↔ 轨道为 4.0 / 3.0 / 2.5；星际航段磨损乘以 1.4）。',
      },
      {
        kind: 'syntax',
        code: 'ship.dispatch(from: string, to: string, cargo: Record<string, number>): RetCode',
      },
      {
        kind: 'params',
        rows: [
          { name: 'from', type: 'string', required: 'required', desc: '出发地 ID（必须与飞船当前的 `ship.location` 一致）' },
          { name: 'to', type: 'string', required: 'required', desc: '目的地 ID（必须存在从 `from` 到 `to` 的可行直达航线）' },
          { name: 'cargo', type: 'Record<string, number>', required: 'required', desc: '装船货物字典，如 `{ [RESOURCE_STEEL]: 20 }`；每项数量向下取整为正整数，总量不能超过 `ship.capacity`' },
        ],
      },
      {
        kind: 'returns',
        type: 'RetCode',
        desc: '返回 `OK` 表示派船请求已入队，否则返回负数错误码',
      },
      {
        kind: 'errors',
        rows: [
          { code: 'ERR_INVALID_ARGS', when: '参数类型错误、`cargo` 为空对象、含未知物品或数量非正数' },
          { code: 'ERR_NOT_OWNER', when: '该飞船不属于本公司' },
          { code: 'ERR_BUSY', when: '飞船正在航行中（`ship.isBusy === true`）' },
          { code: 'ERR_NOT_IN_RANGE', when: '`from` 与飞船当前的 `ship.location` 不一致' },
          { code: 'ERR_NO_PATH', when: '`from` 与 `to` 之间没有可行直达航线（包含 `from === to`）' },
          { code: 'ERR_FULL', when: '装货总件数超过 `ship.capacity`，或本 tick 已用满 32 条写操作配额' },
          { code: 'ERR_NOT_ENOUGH_RESOURCES', when: '出发地仓库的 `fuel`（按小船基准估算）不足' },
        ],
      },
      {
        kind: 'settlement',
        items: [
          '实际船型为 `medium` / `large` 时，地面 ↔ 轨道段真实油耗高于 `calcRoute` 的小船基准值，出发地实际 `fuel` 不足；',
          '出发地仓库的待运货物数量不足（如果同时运送 `fuel` 本身，需保证出发地燃料满足 `航线油耗 + 货舱运载燃料`）；',
          '同一 tick 内对同一艘船重复派船，前一条派船落账后该船已处于航行中。',
        ],
      },
      {
        kind: 'example',
        caption: '把母星地面仓的建材运往轨道站',
        code: `module.exports.loop = function () {
  const pid = Game.company.homePlanetId;
  const stId = 'ST:' + pid;
  const ship = Object.values(Game.ships).find((s) => !s.isBusy && s.location === pid);
  if (!ship) return;

  const ground = Game.planets[pid].groundStore;
  const qty = Math.min(ground[RESOURCE_BUILDING_MAT], ship.capacity);
  if (qty <= 0) return;

  const rc = ship.dispatch(pid, stId, { [RESOURCE_BUILDING_MAT]: qty });
  if (rc !== OK) console.warn('派船失败:', ship.id, rc);
};`,
      },
      {
        kind: 'links',
        items: [
          { label: 'Ship', id: 'Ship' },
          { label: 'Game.market.calcRoute', id: 'Game.market.calcRoute' },
          { label: 'RouteCost', id: 'RouteCost' },
          { label: 'Ship.repair', id: 'Ship.repair' },
        ],
      },
    ],
  },
  {
    id: 'Ship.repair',
    title: 'repair',
    group: '实体与数据结构',
    parent: 'Ship',
    kind: '方法',
    summary: '在飞船当前位置消耗日用品将其耐久恢复至 100',
    keywords: 'Ship.repair 修船 维修 耐久 daily_goods',
    blocks: [
      {
        kind: 'prose',
        text: '在飞船当前停靠位置（地面或空间站）消耗维修用品 `daily_goods`，将飞船耐久立即恢复至 `100`。不同船型消耗不同：小船消耗 **1** 件、中船 **2** 件、大船 **4** 件。',
      },
      {
        kind: 'syntax',
        code: 'ship.repair(): RetCode',
      },
      {
        kind: 'params',
        rows: [],
      },
      {
        kind: 'returns',
        type: 'RetCode',
        desc: '返回 `OK` 表示修船请求已入队，否则返回负数错误码',
      },
      {
        kind: 'errors',
        rows: [
          { code: 'ERR_NOT_OWNER', when: '该飞船不属于本公司' },
          { code: 'ERR_BUSY', when: '飞船正在航行中（`ship.isBusy === true`）' },
          { code: 'ERR_FULL', when: '本 tick 已用满 32 条写操作配额' },
        ],
      },
      {
        kind: 'settlement',
        items: [
          '飞船当前耐久已达 `99.9` 及以上（无需维修）；',
          '飞船当前所在位置的仓库中 `daily_goods` 数量不足（小船 1 / 中船 2 / 大船 4 件）。',
        ],
      },
      {
        kind: 'example',
        caption: '当空闲飞船耐久低于 50 且本地维修件足够时自动维修',
        code: `module.exports.loop = function () {
  for (const ship of Object.values(Game.ships)) {
    if (ship.isBusy || ship.durability >= 50) continue;

    const need = ship.size === 'large' ? 4 : ship.size === 'medium' ? 2 : 1;
    const store = ship.location.startsWith('ST:')
      ? Game.stations[ship.location] && Game.stations[ship.location].store
      : Game.planets[ship.location] && Game.planets[ship.location].groundStore;

    if (store && store[RESOURCE_DAILY_GOODS] >= need) {
      const rc = ship.repair();
      if (rc !== OK) console.warn('修船失败:', ship.id, rc);
    }
  }
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
    id: 'Store',
    title: 'Store',
    group: '实体与数据结构',
    kind: '类型',
    summary: '行星仓、站点仓与飞船货舱共用的只读库存容器',
    keywords: 'Store 库存 仓库 容量 货舱 只读',
    blocks: [
      {
        kind: 'prose',
        text: '`planet.groundStore`、`planet.stationStore`、`station.store` 与 `ship.store` 均实现统一的 `Store` 只读接口。支持直接通过物品 ID 下标读取持有数量，或调用容量查询方法。',
      },
      {
        kind: 'syntax',
        code: 'interface Store {\n  readonly [resourceType: string]: number | undefined;\n  getCapacity(resource?: string): number | null;\n  getUsedCapacity(resource?: string): number | null;\n  getFreeCapacity(resource?: string): number | null;\n}',
      },
      {
        kind: 'methods',
        rows: [
          { signature: 'store.getCapacity(resource?: string)', returns: 'number | null', desc: '获取容器总容量（仅飞船货舱有有限容量，地面仓与站仓返回 null）', id: 'Store.getCapacity' },
          { signature: 'store.getUsedCapacity(resource?: string)', returns: 'number | null', desc: '获取已用容量或指定物品持有量', id: 'Store.getUsedCapacity' },
          { signature: 'store.getFreeCapacity(resource?: string)', returns: 'number | null', desc: '获取剩余可用容量（地面仓与站仓返回 null）', id: 'Store.getFreeCapacity' },
        ],
      },
      {
        kind: 'note',
        level: 'info',
        title: '下标读取与 Object.keys 行为',
        text: '通过 `store[item]` 读取时：合法物品但未持有返回 `0`，非法物品名返回 `undefined`。`Object.keys(store)` 只会枚举持有量 `> 0` 的物品键。所有写操作（如 `store.steel = 0`）均会被静默拒绝。',
      },
      {
        kind: 'example',
        caption: '列出飞船货舱占用与明细',
        code: `module.exports.loop = function () {
  const ship = Object.values(Game.ships)[0];
  if (!ship) return;

  console.log('货舱占用:', ship.store.getUsedCapacity(), '/', ship.store.getCapacity());
  for (const item of Object.keys(ship.store)) {
    console.log('装载:', item, ship.store[item]);
  }
};`,
      },
      {
        kind: 'links',
        items: [
          { label: 'Store.getCapacity', id: 'Store.getCapacity' },
          { label: 'Store.getUsedCapacity', id: 'Store.getUsedCapacity' },
          { label: 'Store.getFreeCapacity', id: 'Store.getFreeCapacity' },
        ],
      },
    ],
  },
  {
    id: 'Store.getCapacity',
    title: 'getCapacity',
    group: '实体与数据结构',
    parent: 'Store',
    kind: '方法',
    summary: '返回库存容器的总容量上限（无上限仓库返回 null）',
    keywords: 'Store.getCapacity 容量 上限',
    blocks: [
      {
        kind: 'prose',
        text: '查询当前 `Store` 容器的总容量。飞船货舱返回对应的数值上限（如 `40`、`120`、`360`）；行星地面仓与空间站仓库没有容量限制，始终返回 `null`。',
      },
      {
        kind: 'syntax',
        code: 'store.getCapacity(resource?: string): number | null',
      },
      {
        kind: 'params',
        rows: [
          { name: 'resource', type: 'string', required: 'optional', desc: '可选物品 ID；若传入非法物品 ID 则返回 `null`' },
        ],
      },
      {
        kind: 'returns',
        type: 'number | null',
        desc: '飞船货舱返回总容量数字；星球地面仓、站点仓或传入非法物品 ID 时返回 `null`',
      },
      {
        kind: 'example',
        caption: '检查飞船总载货容量',
        code: `module.exports.loop = function () {
  const ship = Object.values(Game.ships)[0];
  if (ship) {
    console.log('总容量:', ship.store.getCapacity());
  }
};`,
      },
      {
        kind: 'links',
        items: [
          { label: 'Store', id: 'Store' },
          { label: 'Store.getUsedCapacity', id: 'Store.getUsedCapacity' },
          { label: 'Store.getFreeCapacity', id: 'Store.getFreeCapacity' },
        ],
      },
    ],
  },
  {
    id: 'Store.getUsedCapacity',
    title: 'getUsedCapacity',
    group: '实体与数据结构',
    parent: 'Store',
    kind: '方法',
    summary: '返回全部库存总量或指定物品的持有数量',
    keywords: 'Store.getUsedCapacity 库存 数量 已用容量',
    blocks: [
      {
        kind: 'prose',
        text: '不传参数时返回该 `Store` 内所有物品的数量总和；传入合法物品 ID 时返回该物品的持有数量（未持有返回 `0`）。',
      },
      {
        kind: 'syntax',
        code: 'store.getUsedCapacity(resource?: string): number | null',
      },
      {
        kind: 'params',
        rows: [
          { name: 'resource', type: 'string', required: 'optional', desc: '可选物品 ID 或 `RESOURCE_*` 常量；省略时统计全部物品总量' },
        ],
      },
      {
        kind: 'returns',
        type: 'number | null',
        desc: '不传参时返回所有物品总件数；传入合法物品 ID 时返回该物品持有数（`>= 0`）；传入未知物品 ID 时返回 `null`',
      },
      {
        kind: 'example',
        caption: '查询母星地面仓的钢材数量',
        code: `module.exports.loop = function () {
  const home = Game.planets[Game.company.homePlanetId];
  if (home) {
    console.log('钢材库存:', home.groundStore.getUsedCapacity(RESOURCE_STEEL));
  }
};`,
      },
      {
        kind: 'links',
        items: [
          { label: 'Store', id: 'Store' },
          { label: 'Store.getCapacity', id: 'Store.getCapacity' },
          { label: 'Store.getFreeCapacity', id: 'Store.getFreeCapacity' },
        ],
      },
    ],
  },
  {
    id: 'Store.getFreeCapacity',
    title: 'getFreeCapacity',
    group: '实体与数据结构',
    parent: 'Store',
    kind: '方法',
    summary: '返回库存容器的剩余可用容量（无上限仓库返回 null）',
    keywords: 'Store.getFreeCapacity 剩余容量 可用空间',
    blocks: [
      {
        kind: 'prose',
        text: '计算 `max(0, 总容量 - 已用总量)`。仅当容器存在有限容量（如飞船货舱）时返回非负整数，行星地面仓与空间站仓库返回 `null`。',
      },
      {
        kind: 'syntax',
        code: 'store.getFreeCapacity(resource?: string): number | null',
      },
      {
        kind: 'params',
        rows: [
          { name: 'resource', type: 'string', required: 'optional', desc: '可选物品 ID；若传入非法物品 ID 则返回 `null`' },
        ],
      },
      {
        kind: 'returns',
        type: 'number | null',
        desc: '飞船货舱返回剩余可装载件数；无容量限制仓库或传入非法物品 ID 时返回 `null`',
      },
      {
        kind: 'example',
        caption: '读取飞船剩余货舱容量',
        code: `module.exports.loop = function () {
  const ship = Object.values(Game.ships)[0];
  if (ship) {
    console.log('剩余空间:', ship.store.getFreeCapacity());
  }
};`,
      },
      {
        kind: 'links',
        items: [
          { label: 'Store', id: 'Store' },
          { label: 'Store.getCapacity', id: 'Store.getCapacity' },
          { label: 'Store.getUsedCapacity', id: 'Store.getUsedCapacity' },
        ],
      },
    ],
  },
  {
    id: 'RecipeInfo',
    title: 'RecipeInfo',
    group: '实体与数据结构',
    kind: '类型',
    summary: '由 Game.getRecipe 返回的静态配方定义对象',
    keywords: 'RecipeInfo 配方 inputs outputs cycleTicks powerCost laborCost',
    blocks: [
      {
        kind: 'prose',
        text: '描述一条生产配方的归属建筑、周期、电耗、基础工资以及每周期投入产出清单。',
      },
      {
        kind: 'fields',
        rows: [
          { name: 'id', type: 'string', desc: '配方 ID' },
          { name: 'buildingId', type: 'string', desc: '该配方适用的建筑类型 ID' },
          { name: 'cycleTicks', type: 'number', desc: '一个完整生产周期所需的 tick 数' },
          { name: 'powerCost', type: 'number', desc: '每个周期开始时消耗的 `power` 数量' },
          { name: 'laborCost', type: 'number', desc: '每个周期开始时的基础工资（实际扣款为 `laborCost × Game.cpi`）' },
          { name: 'inputs', type: 'Array<{ item: string; qty: number }>', desc: '每周期开始时消耗的原料清单' },
          { name: 'outputs', type: 'Array<{ item: string; qty: number }>', desc: '每周期结束时产出的成品清单（实际产量再乘以 `building.efficiency` 四舍五入）' },
        ],
      },
      {
        kind: 'links',
        items: [
          { label: 'Game.getRecipe', id: 'Game.getRecipe' },
          { label: 'Building.setRecipe', id: 'Building.setRecipe' },
          { label: '默认世界建筑与配方', id: 'constants/world-catalog' },
        ],
      },
    ],
  },
  {
    id: 'MarketOrder',
    title: 'MarketOrder',
    group: '实体与数据结构',
    kind: '类型',
    summary: '市场订单簿中的一条活跃限价挂单对象',
    keywords: 'MarketOrder 挂单 订单 order buy sell price amount totalAmount ownerId',
    blocks: [
      {
        kind: 'prose',
        text: '`Game.market.orders`、`Game.market.getAllOrders` 与 `PublicCompanyDetail.openOrders` 返回的挂单结构。',
      },
      {
        kind: 'fields',
        rows: [
          { name: 'id', type: 'string', desc: '订单 ID（数字字符串）' },
          { name: 'created', type: 'number', desc: '挂单创建时的 tick 序号' },
          { name: 'type', type: "'buy' | 'sell'", desc: '订单方向（`ORDER_BUY` 或 `ORDER_SELL`）' },
          { name: 'resourceType', type: 'string', desc: '物品 ID' },
          { name: 'stationId', type: 'string', desc: '挂单所在站点 ID' },
          { name: 'price', type: 'number', desc: '限价单价（信用点）' },
          { name: 'amount', type: 'number', desc: '当前剩余未成交数量' },
          { name: 'totalAmount', type: 'number', desc: '下单时的初始总数量' },
          { name: 'ownerId', type: 'string', desc: '挂单方公司 ID（行星需求买单形如 `\'PLANET:P2\'`）' },
        ],
      },
      {
        kind: 'links',
        items: [
          { label: 'Game.market.orders', id: 'Game.market.orders' },
          { label: 'Game.market.getAllOrders', id: 'Game.market.getAllOrders' },
          { label: 'Game.market.deal', id: 'Game.market.deal' },
        ],
      },
    ],
  },
  {
    id: 'MarketQuote',
    title: 'MarketQuote',
    group: '实体与数据结构',
    kind: '类型',
    summary: '由 Game.market.quote 返回的站点物品盘口行情快照',
    keywords: 'MarketQuote 行情 买一 卖一 bestBid bestAsk emaFast emaSlow vol50t',
    blocks: [
      {
        kind: 'prose',
        text: '聚合某个站点上某种物品的盘口最优买卖价、最近成交价、均线与近期成交量。',
      },
      {
        kind: 'fields',
        rows: [
          { name: 'stationId', type: 'string', desc: '站点 ID' },
          { name: 'resourceType', type: 'string', desc: '物品 ID' },
          { name: 'bestBid', type: 'number | null', desc: '当前最高买价；买盘为空时为 `null`' },
          { name: 'bestAsk', type: 'number | null', desc: '当前最低卖价；卖盘为空时为 `null`' },
          { name: 'lastPrice', type: 'number', desc: '最近一次成交价格（未成交过时为基准参考价）' },
          { name: 'emaFast', type: 'number', desc: '快指数移动均线' },
          { name: 'emaSlow', type: 'number', desc: '慢指数移动均线' },
          { name: 'vol50t', type: 'number', desc: '最近 50 个 tick 内的累计成交量' },
        ],
      },
      {
        kind: 'links',
        items: [
          { label: 'Game.market.quote', id: 'Game.market.quote' },
          { label: 'Game.market.depth', id: 'Game.market.depth' },
        ],
      },
    ],
  },
  {
    id: 'RouteCost',
    title: 'RouteCost',
    group: '实体与数据结构',
    kind: '类型',
    summary: '由 Game.market.calcRoute 返回的航线耗时与基准油耗对象',
    keywords: 'RouteCost 航线 ticks fuel 耗时 燃料',
    blocks: [
      {
        kind: 'prose',
        text: '表示两地之间单程航线的飞行周期与小船满耐久基准油耗。',
      },
      {
        kind: 'fields',
        rows: [
          { name: 'ticks', type: 'number', desc: '单程所需 tick 数（按小船满耐久估算）' },
          { name: 'fuel', type: 'number', desc: '所需燃料数量（按小船估算；地面 ↔ 轨道段中/大船分别按 2 倍/4 倍计）' },
        ],
      },
      {
        kind: 'links',
        items: [
          { label: 'Game.market.calcRoute', id: 'Game.market.calcRoute' },
          { label: 'Ship.dispatch', id: 'Ship.dispatch' },
        ],
      },
    ],
  },
  {
    id: 'PublicLandPlot',
    title: 'PublicLandPlot',
    group: '实体与数据结构',
    kind: '类型',
    summary: '行星表面公开格点结构，由 Game.market.getLandPlots 返回',
    keywords: 'PublicLandPlot 地块 格点 slotId lat lon status isCity cityName price',
    blocks: [
      {
        kind: 'prose',
        text: '代表行星表面的一个永久地理格点（城市、未开发空地、在售挂牌地或私有地块）。可用于购买一手或二手地前的全星选址分析。',
      },
      {
        kind: 'fields',
        rows: [
          { name: 'slotId', type: 'number', desc: '行星表面永久位置编号（购买一手空地时传给 `Game.buyPlot`）' },
          { name: 'planetId', type: 'string', desc: '所属行星 ID' },
          { name: 'lat', type: 'number', desc: '行星表面纬度（度）' },
          { name: 'lon', type: 'number', desc: '行星表面经度（度）' },
          { name: 'terrainName', type: 'string', desc: '地形名称' },
          { name: 'capacity', type: 'number', desc: '可用建筑槽位数' },
          { name: 'usedSlots', type: 'number', desc: '已占用建筑槽位数' },
          { name: 'buildingMods', type: 'Record<string, number>', desc: '各建筑类型在该格点的效率乘数' },
          { name: 'status', type: "'city' | 'unclaimed' | 'listed' | 'owned'", desc: '格点公开状态：城市 / 未开发 / 二手挂牌 / 已私有' },
          { name: 'isCity', type: 'boolean', desc: '是否为城市规划区（不可购买）' },
          { name: 'cityName', type: 'string | null', desc: '若为城市区则为城市名称，否则为 `null`' },
          { name: 'ownerId', type: 'string | null', desc: '当前归属公司 ID；未开发空地或城市区为 `null`' },
          { name: 'ownerName', type: 'string | null', desc: '当前归属公司名称；未开发空地或城市区为 `null`' },
          { name: 'isPlayerOwner', type: 'boolean', desc: '归属方是否为玩家公司' },
          { name: 'plotId', type: 'string | null', desc: '已开发地块的地块 ID；未开发空地或城市区为 `null`' },
          { name: 'listingId', type: 'string | null', desc: '若 `status === \'listed\'` 则为挂牌编号，否则为 `null`' },
          { name: 'price', type: 'number | null', desc: '未开发空地为一手地价，挂牌地为挂牌要价，其余状态为 `null`' },
          { name: 'buildings', type: 'string[]', desc: '该格点上已建成的建筑类型 ID 列表' },
        ],
      },
      {
        kind: 'links',
        items: [
          { label: 'Game.market.getLandPlots', id: 'Game.market.getLandPlots' },
          { label: 'Game.buyPlot', id: 'Game.buyPlot' },
          { label: 'Plot', id: 'Plot' },
        ],
      },
    ],
  },
  {
    id: 'PublicCompanySummary',
    title: 'PublicCompanySummary',
    group: '实体与数据结构',
    kind: '类型',
    summary: '全星系公司公开摘要条目，由 Game.market.listCompanies 返回',
    keywords: 'PublicCompanySummary 公司摘要 排行 netLiquid shipsBySize',
    blocks: [
      {
        kind: 'prose',
        text: '提供任意公司的公开经营规模摘要。出于商业保密，不包含现金/储蓄/负债明细、仓库库存或具体在产配方。',
      },
      {
        kind: 'fields',
        rows: [
          { name: 'id', type: 'string', desc: '公司 ID' },
          { name: 'name', type: 'string', desc: '公司名称' },
          { name: 'isPlayer', type: 'boolean', desc: '是否为玩家公司' },
          { name: 'homePlanetId', type: 'string', desc: '所属母星 ID' },
          { name: 'netLiquid', type: 'number', desc: '公开净流动资产估值（信用点）' },
          { name: 'plotsCount', type: 'number', desc: '名下地块总数' },
          { name: 'buildingsCount', type: 'number', desc: '名下已完工建筑总数' },
          { name: 'shipsCount', type: 'number', desc: '名下飞船总数' },
          { name: 'shipsBySize', type: '{ small: number; medium: number; large: number }', desc: '按船型统计的飞船数量分布' },
          { name: 'openOrdersCount', type: 'number', desc: '全星系当前活跃挂单数量' },
        ],
      },
      {
        kind: 'links',
        items: [
          { label: 'Game.market.listCompanies', id: 'Game.market.listCompanies' },
          { label: 'PublicCompanyDetail', id: 'PublicCompanyDetail' },
        ],
      },
    ],
  },
  {
    id: 'PublicCompanyDetail',
    title: 'PublicCompanyDetail',
    group: '实体与数据结构',
    kind: '类型',
    summary: '指定公司的完整公开商业情报，由 Game.market.getCompany 返回',
    keywords: 'PublicCompanyDetail 公司详情 buildingCounts plots openOrders',
    blocks: [
      {
        kind: 'prose',
        text: '包含目标公司的全部公开摘要字段以及名下地块建筑明细与活跃挂单。',
      },
      {
        kind: 'fields',
        rows: [
          { name: 'id', type: 'string', desc: '公司 ID' },
          { name: 'name', type: 'string', desc: '公司名称' },
          { name: 'isPlayer', type: 'boolean', desc: '是否为玩家公司' },
          { name: 'homePlanetId', type: 'string', desc: '所属母星 ID' },
          { name: 'netLiquid', type: 'number', desc: '公开净流动资产估值（信用点）' },
          { name: 'plotsCount', type: 'number', desc: '名下地块总数' },
          { name: 'buildingsCount', type: 'number', desc: '名下已完工建筑总数' },
          { name: 'shipsCount', type: 'number', desc: '名下飞船总数' },
          { name: 'shipsBySize', type: '{ small: number; medium: number; large: number }', desc: '按船型统计的飞船数量分布' },
          { name: 'buildingCounts', type: 'Record<string, number>', desc: '按建筑类型汇总的设施数量映射' },
          {
            name: 'plots',
            type: "Array<{ planetId: string; slotId: number; plotId: string | null; lat: number; lon: number; terrainName: string; capacity: number; usedSlots: number; status: 'owned' | 'listed'; listingId: string | null; price: number | null; buildings: string[] }>",
            desc: '名下全部公开地块与各地块上的建筑列表',
          },
          { name: 'openOrdersCount', type: 'number', desc: '全星系活跃公开挂单数' },
          { name: 'openOrders', type: 'MarketOrder[]', desc: '该公司在各站点的全部活跃公开挂单数组' },
        ],
      },
      {
        kind: 'links',
        items: [
          { label: 'Game.market.getCompany', id: 'Game.market.getCompany' },
          { label: 'PublicCompanySummary', id: 'PublicCompanySummary' },
          { label: 'MarketOrder', id: 'MarketOrder' },
        ],
      },
    ],
  },
];

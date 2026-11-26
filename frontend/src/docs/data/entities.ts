import type { DocEntry } from '../types';

export const ENTITY_ENTRIES: DocEntry[] = [
  {
    id: 'StarSystem',
    title: 'StarSystem',
    group: '实体与数据结构',
    kind: '类型',
    summary: '恒星系公开对象，包含恒星光色分类、坐标、枢纽站与所属行星列表',
    keywords: 'StarSystem 恒星系 starClass luminosity hubStationId planetIds',
    blocks: [
      {
        kind: 'prose',
        text: '`Game.systems[systemId]` 返回的恒星系只读快照对象，描述星图拓扑中的一颗恒星系及其全部所辖行星与中心枢纽站。',
      },
      {
        kind: 'fields',
        rows: [
          { name: 'id', type: 'string', desc: '恒星系 ID，如 `\'S1\'`' },
          { name: 'name', type: 'string', desc: '恒星系名称' },
          { name: 'starClass', type: 'string', desc: '恒星光谱分类标识（如 `\'G2V\'`）' },
          { name: 'luminosity', type: 'number', desc: '相对太阳光度系数' },
          { name: 'x', type: 'number', desc: '星图坐标 X' },
          { name: 'y', type: 'number', desc: '星图坐标 Y' },
          { name: 'hubStationId', type: 'string', desc: '该星系中心贸易枢纽站 ID（默认 `\'ST:HUB\'`）' },
          { name: 'planetIds', type: 'readonly string[]', desc: '属于该恒星系的全部行星 ID 数组' },
        ],
      },
      {
        kind: 'example',
        caption: '列出恒星系及其所有行星名称',
        code: `module.exports.loop = function () {
  for (const sys of Object.values(Game.systems)) {
    const names = sys.planetIds.map((pid) => Game.planets[pid].name);
    console.log(sys.name, '(' + sys.starClass + ')', '行星:', names.join(', '));
  }
};`,
      },
      {
        kind: 'links',
        items: [
          { label: 'Game.systems', id: 'Game.systems' },
          { label: 'Planet', id: 'Planet' },
          { label: 'Station', id: 'Station' },
        ],
      },
    ],
  },
  {
    id: 'Planet',
    title: 'Planet',
    group: '实体与数据结构',
    kind: '类型',
    summary: '行星公开遥测、轨道站关联、二手挂牌、城市需求与本公司地面/轨道仓库视图',
    keywords: 'Planet 行星 systemId stationId habitability gravity wasteBacklog primaryLandPrice landListings demands',
    blocks: [
      {
        kind: 'prose',
        text: '`Game.planets[planetId]` 返回的行星只读快照对象，同时汇总行星物理/人口遥测指标、所属恒星系与近地轨道站映射、城市消费需求，以及本公司在该星的地面仓与轨道站仓。',
      },
      {
        kind: 'fields',
        rows: [
          { name: 'id', type: 'string', desc: '行星 ID，如 `\'P1\'`、`\'P2\'`' },
          { name: 'systemId', type: 'string', desc: '所属恒星系 ID，如 `\'S1\'`' },
          { name: 'stationId', type: 'string', desc: '对应的行星近地轨道站 ID，如 `\'ST:P2\'`' },
          { name: 'name', type: 'string', desc: '行星显示名称' },
          { name: 'wealthTier', type: 'number', desc: '富裕等级（`1..5`），等级越高城市消费物品种类与能力越强' },
          { name: 'prosperity', type: 'number', desc: '当前城市繁荣度指标' },
          { name: 'population', type: 'number', desc: '当前城市总人口' },
          { name: 'gravity', type: 'number', desc: '表面重力系数（直接影响地面 ↔ 轨道起降耗时与油耗）' },
          { name: 'habitability', type: 'number', desc: '宜居度指标（影响行星人口自然增长潜力）' },
          { name: 'wasteBacklog', type: 'number', desc: '城市待消纳垃圾堆积量（`recycling_plant` 生产时可直接消纳并赚取处置凭证）' },
          { name: 'primaryLandPrice', type: 'number | null', desc: '当前一手未认领空地单价（信用点）；无空地时为 `null`' },
          { name: 'bankRatePct', type: 'number', desc: '本星央行当前年化基准贷款利率（百分数，如 `4.5` 表示 4.5%）' },
          { name: 'groundStore', type: 'Store', desc: '本公司在该行星地面仓库的只读视图（无容量上限）' },
          { name: 'stationStore', type: 'Store', desc: '本公司在对应轨道站 `stationId` 的只读库存视图（等价于 `Game.stations[planet.stationId].store`）' },
          { name: 'demands', type: 'Record<string, { qty: number }>', desc: '本 tick 城市对各消费品的理论需求量字典' },
          {
            name: 'landListings',
            type: 'Array<{ listingId: string; plotId: string; slotId: number; sellerId: string; price: number; terrainName: string; lat: number; lon: number; capacity: number; usedSlots: number; buildingMods: Record<string, number>; buildings: string[] }>',
            desc: '按需读取的本行星二手地及银行清算挂牌列表',
          },
        ],
      },
      {
        kind: 'note',
        level: 'info',
        text: '`groundStore` 与 `stationStore` 的 `getCapacity()` 和 `getFreeCapacity()` 均返回 `null`（星球地面仓与行星轨道站仓不设容量上限）。',
      },
      {
        kind: 'example',
        caption: '查看母星需求前三的物品并检索轨道站库存',
        code: `module.exports.loop = function () {
  const p = Game.planets[Game.company.homePlanetId];
  if (!p) return;

  const top = Object.entries(p.demands)
    .sort((a, b) => b[1].qty - a[1].qty)
    .slice(0, 3);
  console.log(p.name, '轨道站:', p.stationId, '需求前三:', top);
};`,
      },
      {
        kind: 'links',
        items: [
          { label: 'Game.planets', id: 'Game.planets' },
          { label: 'Station', id: 'Station' },
          { label: 'Game.market.buyLand', id: 'Game.market.buyLand' },
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
    summary: '空间站只读对象，提供所在星系、绑定行星与本公司库存视图',
    keywords: 'Station 轨道站 枢纽站 ST:HUB systemId planetId store 仓租',
    blocks: [
      {
        kind: 'prose',
        text: '`Game.stations[stationId]` 返回的空间站对象，涵盖全星系所有空间站（行星轨道站与中心枢纽站）。',
      },
      {
        kind: 'fields',
        rows: [
          { name: 'id', type: 'string', desc: '空间站 ID，如 `\'ST:P2\'` 或 `\'ST:HUB\'`' },
          { name: 'systemId', type: 'string', desc: '所属恒星系 ID' },
          { name: 'planetId', type: 'string | null', desc: '绑定的行星 ID（中心枢纽站为 `null`）' },
          { name: 'store', type: 'Store', desc: '本公司在该空间站的只读库存视图（`getCapacity()` 恒为 `null`）' },
        ],
      },
      {
        kind: 'note',
        level: 'warn',
        text: '枢纽站 `ST:HUB` 的存货每 `12` 个 tick 会按估值收取 **0.8%** 仓租；各行星轨道站（`ST:P*`）仓储免费。',
      },
      {
        kind: 'example',
        caption: '统计枢纽站全部在库货物总件数',
        code: `module.exports.loop = function () {
  const hub = Game.stations['ST:HUB'];
  if (hub) {
    console.log('Hub 所属星系:', hub.systemId, '总件数:', hub.store.getUsedCapacity());
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
    summary: '本公司名下的已购买工业地块，含槽位信息、旗下建筑/工地与 build() 建造方法',
    keywords: 'Plot 地块 槽位 地形加成 buildings sites build',
    blocks: [
      {
        kind: 'prose',
        text: '`Game.plots[plotId]` 返回的自有地块只读对象，直接挂载了所在建筑 `buildings`、正在施工的 `sites` 以及建厂实例方法 `build()`。',
      },
      {
        kind: 'fields',
        rows: [
          { name: 'id', type: 'string', desc: '地块 ID（十进制数字字符串）' },
          { name: 'slotId', type: 'number', desc: '行星表面永久网格编号（与 `getLandPlots()` 一致）' },
          { name: 'planetId', type: 'string', desc: '所在行星 ID' },
          { name: 'lat', type: 'number', desc: '纬度（度）' },
          { name: 'lon', type: 'number', desc: '经度（度）' },
          { name: 'terrainName', type: 'string', desc: '地形名称，如 `\'玄武岩裂谷\'`' },
          { name: 'capacity', type: 'number', desc: '总建筑槽位数' },
          { name: 'usedSlots', type: 'number', desc: '已占用槽位数（含已完工建筑与在建工地）' },
          { name: 'buildingMods', type: 'Record<string, number>', desc: '地形对特定建筑类型的产出效率加成系数' },
          { name: 'buildings', type: 'readonly Building[]', desc: '该地块上已完工的建筑数组' },
          { name: 'sites', type: 'readonly ConstructionSite[]', desc: '该地块上正在施工中的在建工地数组' },
        ],
      },
      {
        kind: 'methods',
        title: '实例方法（Methods）',
        rows: [
          { signature: 'plot.build(buildingType: string)', returns: 'RetCode', desc: '在本地块发起建造一座指定类型的新建筑', id: 'Plot.build' },
        ],
      },
      {
        kind: 'note',
        level: 'info',
        text: '当 `usedSlots >= capacity` 时需调用 `building.demolish()` 拆除建筑腾出槽位，或调用 `Game.map.buyPlot` 购入新地块。',
      },
      {
        kind: 'example',
        caption: '查看本地块在产建筑与在建任务并利用空槽建厂',
        code: `module.exports.loop = function () {
  for (const plot of Object.values(Game.plots)) {
    const free = plot.capacity - plot.usedSlots;
    if (free > 0 && plot.buildings.length === 0 && plot.sites.length === 0) {
      plot.build('mine_smelter');
      break;
    }
  }
};`,
      },
      {
        kind: 'links',
        items: [
          { label: 'Plot.build', id: 'Plot.build' },
          { label: 'Building', id: 'Building' },
          { label: 'ConstructionSite', id: 'ConstructionSite' },
        ],
      },
    ],
  },
  {
    id: 'Plot.build',
    title: 'build',
    group: '实体与数据结构',
    parent: 'Plot',
    kind: '方法',
    summary: '在本自有地块上建造一座新建筑，扣除所在行星地面建材与施工现金',
    keywords: 'Plot.build 建造 建厂 建筑 地块 building_mat',
    blocks: [
      {
        kind: 'prose',
        text: '在当前自有地块发起一座新建筑建造。扣取该行星地面仓对应的 `buildCost` 建材以及 `80 × Game.cpi` 信用点施工费。调用成功后，`plot.usedSlots` 在下 tick 即刻占用并在 `Game.sites` 创建在建工地，待施工周期倒计时归零后转为 `Game.buildings`。',
      },
      {
        kind: 'syntax',
        code: 'plot.build(buildingType: string): RetCode',
      },
      {
        kind: 'params',
        rows: [
          { name: 'buildingType', type: 'string', required: 'required', desc: '建筑类型 ID，见 `Game.catalog.buildings`（如 `\'mine_smelter\'`、`\'power_water_station\'`）' },
        ],
      },
      {
        kind: 'returns',
        type: 'RetCode',
        desc: '返回 `OK` 表示建造校验通过并在影账预扣槽位/建材/现金后入队；否则返回负数错误码',
      },
      {
        kind: 'errors',
        rows: [
          { code: 'ERR_INVALID_ARGS', when: '`buildingType` 非非空字符串，或地块 ID 无效' },
          { code: 'ERR_NOT_OWNER', when: '该地块不属于本公司' },
          { code: 'ERR_INVALID_TARGET', when: '目标建筑类型不存在' },
          { code: 'ERR_FULL', when: '计入本 tick 同地块已入队建造后剩余槽位不足，或写操作达到 32 条配额' },
          { code: 'ERR_NOT_ENOUGH_CREDITS', when: '可用现金不足 `80 × Game.cpi` 施工费（计入本 tick 影账）' },
          { code: 'ERR_NOT_ENOUGH_RESOURCES', when: '所在行星地面仓 `groundStore` 建造成本建材不足（计入本 tick 影账）' },
        ],
      },
      {
        kind: 'settlement',
        items: [
          '极少数同 tick 先序买地/扣费或生产消费导致落账时刻真实资金或地面建材低于阈值（回执记入 `Game.lastTick.rejected`）。',
        ],
      },
      {
        kind: 'example',
        caption: '查询建造成本并在条件满足时直接调用 plot.build',
        code: `module.exports.loop = function () {
  const bdef = Game.catalog.buildings.mine_smelter;
  const plot = Object.values(Game.plots).find((p) => p.capacity - p.usedSlots >= bdef.slotsUsed);
  if (!plot) return;

  const ground = Game.planets[plot.planetId].groundStore;
  const matOk = bdef.buildCost.every((c) => ground[c.item] >= c.qty);
  if (matOk && Game.company.cash >= bdef.cashFeeBase * Game.cpi) {
    const rc = plot.build('mine_smelter');
    if (rc === OK) console.log('建造已排期，预计耗时:', bdef.buildTicks, 'tick');
  }
};`,
      },
      {
        kind: 'links',
        items: [
          { label: 'Plot', id: 'Plot' },
          { label: 'ConstructionSite', id: 'ConstructionSite' },
          { label: 'Game.catalog', id: 'Game.catalog' },
          { label: 'Building.demolish', id: 'Building.demolish' },
        ],
      },
    ],
  },
  {
    id: 'Building',
    title: 'Building',
    group: '实体与数据结构',
    kind: '类型',
    summary: '已完工建筑对象，提供地形效率、当前配方、周期进度以及控制方法',
    keywords: 'Building 建筑 工厂 recipeId active efficiency progress setRecipe setActive demolish',
    blocks: [
      {
        kind: 'prose',
        text: '`Game.buildings[buildingId]` 与 `plot.buildings[]` 返回的已完工建筑只读快照对象。排产切换、开关机及拆除通过其实例方法发起。',
      },
      {
        kind: 'fields',
        rows: [
          { name: 'id', type: 'string', desc: '建筑 ID（十进制数字字符串）' },
          { name: 'type', type: 'string', desc: '建筑类型 ID，如 `\'mine_smelter\'`' },
          { name: 'plotId', type: 'string', desc: '所属地块 ID' },
          { name: 'planetId', type: 'string', desc: '所在行星 ID' },
          { name: 'efficiency', type: 'number', desc: '地形效率系数（仅线性放大每次产出成品数量，不增加单次原料消耗）' },
          { name: 'recipeId', type: 'string', desc: '当前绑定配方 ID' },
          { name: 'active', type: 'boolean', desc: '是否处于开机状态（`false` 时不扣料也不产出，每隔一周期收取轻待机电费）' },
          { name: 'progress', type: 'number', desc: '当前生产周期已累计运行 tick 数' },
          { name: 'cycleTicks', type: 'number', desc: '当前绑定配方的完整生产周期长度（单位 tick）' },
        ],
      },
      {
        kind: 'methods',
        title: '实例方法（Methods）',
        rows: [
          { signature: 'building.setRecipe(recipeId: string)', returns: 'RetCode', desc: '切换当前生产配方（保留当前进度，按新周期运行）', id: 'Building.setRecipe' },
          { signature: 'building.setActive(active: boolean)', returns: 'RetCode', desc: '设置建筑开机（`true`）或停产（`false`）', id: 'Building.setActive' },
          { signature: 'building.demolish()', returns: 'RetCode', desc: '拆除当前建筑并立即释放所占用的地块槽位', id: 'Building.demolish' },
        ],
      },
      {
        kind: 'links',
        items: [
          { label: 'Game.buildings', id: 'Game.buildings' },
          { label: 'Building.setRecipe', id: 'Building.setRecipe' },
          { label: 'Building.setActive', id: 'Building.setActive' },
          { label: 'Building.demolish', id: 'Building.demolish' },
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
    summary: '为自有建筑切换绑定的生产配方，不退还已扣除原料且不重置当前进度',
    keywords: 'Building.setRecipe 配方 切换 产线 排产',
    blocks: [
      {
        kind: 'prose',
        text: '修改目标建筑下一 tick 生效的生产配方。必须属于同一建筑类型且处于启用状态。切换不会清零 `progress`，也不会退还当前周期已投入原料；若切换到周期不同的配方，`progress` 在后续周期边界自动对齐。',
      },
      {
        kind: 'syntax',
        code: 'building.setRecipe(recipeId: string): RetCode',
      },
      {
        kind: 'params',
        rows: [
          { name: 'recipeId', type: 'string', required: 'required', desc: '目标配方 ID，必须存在于 `Game.catalog.recipes` 且适配 `building.type`' },
        ],
      },
      {
        kind: 'returns',
        type: 'RetCode',
        desc: '返回 `OK` 表示切配方请求已入队；否则返回负数错误码',
      },
      {
        kind: 'errors',
        rows: [
          { code: 'ERR_INVALID_ARGS', when: '`recipeId` 非非空字符串，或建筑 ID 无效' },
          { code: 'ERR_NOT_OWNER', when: '该建筑不属于本公司' },
          { code: 'ERR_NOT_FOUND', when: '指定 `recipeId` 不存在，或该建筑已在本 tick 调用过 `demolish()`' },
          { code: 'ERR_INVALID_TARGET', when: '配方已禁用，或配方所属 `buildingId !== building.type`' },
          { code: 'ERR_FULL', when: '本 tick 写操作配额（32 条）已满' },
        ],
      },
      {
        kind: 'settlement',
        items: [
          '若同一 tick 先行提交了拆除指令或地块发生所有权变更，落账时会跳过并在 `Game.lastTick.rejected` 通知。',
        ],
      },
      {
        kind: 'example',
        caption: '依据地面生物纤维库存自动切换炼钢工艺',
        code: `module.exports.loop = function () {
  for (const b of Object.values(Game.buildings)) {
    if (b.type !== 'mine_smelter') continue;
    const fiber = Game.planets[b.planetId].groundStore[RESOURCE_BIO_FIBER];
    const target = fiber >= 6 ? 'steel_carbon' : 'steel_electric';
    if (b.recipeId !== target) b.setRecipe(target);
  }
};`,
      },
      {
        kind: 'links',
        items: [
          { label: 'Building', id: 'Building' },
          { label: 'Building.setActive', id: 'Building.setActive' },
          { label: 'Game.catalog', id: 'Game.catalog' },
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
    summary: '开启或暂停指定自有建筑的生产（停产免扣原料工资，仅按待机功耗耗电）',
    keywords: 'Building.setActive 开机 停产 开关 待机 电费',
    blocks: [
      {
        kind: 'prose',
        text: '控制建筑开机运行或停机休眠。停产时既不会扣原料和人力工资，也不会产出成品，只按建筑类型以轻待机功耗扣减少量 `power`。',
      },
      {
        kind: 'syntax',
        code: 'building.setActive(active: boolean): RetCode',
      },
      {
        kind: 'params',
        rows: [
          { name: 'active', type: 'boolean', required: 'required', desc: '`true` 表示开机生产，`false` 表示暂停生产' },
        ],
      },
      {
        kind: 'returns',
        type: 'RetCode',
        desc: '返回 `OK` 表示启停请求已入队；否则返回负数错误码',
      },
      {
        kind: 'errors',
        rows: [
          { code: 'ERR_INVALID_ARGS', when: '`active` 不是严格的布尔值' },
          { code: 'ERR_NOT_OWNER', when: '建筑不属于本公司' },
          { code: 'ERR_NOT_FOUND', when: '该建筑已在本 tick 被调用过 `demolish()`' },
          { code: 'ERR_FULL', when: '本 tick 32 条写配额已满' },
        ],
      },
      {
        kind: 'settlement',
        items: [
          '落账阶段建筑已因拆除指令或关联地块处置失效时，将在 `Game.lastTick.rejected` 报 `ERR_NOT_FOUND` 或 `ERR_NOT_OWNER`。',
        ],
      },
      {
        kind: 'example',
        caption: '当母星地面钢材堆存超 200 件时临时关停部分冶炼厂',
        code: `module.exports.loop = function () {
  for (const b of Object.values(Game.buildings)) {
    if (b.type === 'mine_smelter' && (b.recipeId === 'steel_carbon' || b.recipeId === 'steel_electric')) {
      const steelQty = Game.planets[b.planetId].groundStore[RESOURCE_STEEL];
      const wantActive = steelQty < 200;
      if (b.active !== wantActive) b.setActive(wantActive);
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
    id: 'Building.demolish',
    title: 'demolish',
    group: '实体与数据结构',
    parent: 'Building',
    kind: '方法',
    summary: '拆除本建筑并释放占用槽位（不退还建造成本与当前周期投入）',
    keywords: 'Building.demolish 拆除 建筑 释放 槽位',
    blocks: [
      {
        kind: 'prose',
        text: '拆除当前建筑实体，落账后即从 `Game.buildings` 移除并回收地块占用的 `slotsUsed` 槽位。不退还历史建造成本或已扣除原料。',
      },
      {
        kind: 'syntax',
        code: 'building.demolish(): RetCode',
      },
      {
        kind: 'params',
        rows: [],
      },
      {
        kind: 'returns',
        type: 'RetCode',
        desc: '返回 `OK` 表示拆迁校验通过并入队；否则返回负数错误码',
      },
      {
        kind: 'errors',
        rows: [
          { code: 'ERR_NOT_OWNER', when: '建筑或其所属地块不属于本公司' },
          { code: 'ERR_NOT_FOUND', when: '该建筑已在本 tick 被拆除过一次' },
          { code: 'ERR_FULL', when: '本 tick 写操作配额（32 条）已满' },
        ],
      },
      {
        kind: 'settlement',
        items: [
          '若同一地块已在本 tick 外处置转移，落账将会拒绝该拆除请求并写入 `Game.lastTick.rejected`。',
        ],
      },
      {
        kind: 'example',
        caption: '拆除指定 ID 的冗余建筑',
        code: `module.exports.loop = function () {
  const target = Game.getObjectById('105');
  if (target && target.demolish) {
    const rc = target.demolish();
    if (rc === OK) console.log('已排期拆除建筑:', target.id);
  }
};`,
      },
      {
        kind: 'links',
        items: [
          { label: 'Building', id: 'Building' },
          { label: 'Plot.build', id: 'Plot.build' },
        ],
      },
    ],
  },
  {
    id: 'ConstructionSite',
    title: 'ConstructionSite',
    group: '实体与数据结构',
    kind: '类型',
    summary: '已提交建造但尚未完工的在建工地只读对象',
    keywords: 'ConstructionSite 工地 在建 finishTick ticksRemaining Game.sites',
    blocks: [
      {
        kind: 'prose',
        text: '通过 `plot.build()` 创建的建造项目在施工完成前会以 `ConstructionSite` 形式出现在 `Game.sites` 与 `plot.sites` 中，供脚本精确获知预计完工时刻。',
      },
      {
        kind: 'fields',
        rows: [
          { name: 'id', type: 'string', desc: '工地全局唯一 ID（可通过 `Game.getObjectById(site.id)` 检索）' },
          { name: 'plotId', type: 'string', desc: '所在地块 ID' },
          { name: 'planetId', type: 'string', desc: '所在行星 ID' },
          { name: 'buildingType', type: 'string', desc: '正在建造的建筑类型 ID，如 `\'mine_smelter\'`' },
          { name: 'finishTick', type: 'number', desc: '预计正式落成并迁入 `Game.buildings` 的绝对 tick 序号' },
          { name: 'ticksRemaining', type: 'number', desc: '距离完工的剩余 tick 数（随每个 tick 自动减 1）' },
        ],
      },
      {
        kind: 'example',
        caption: '避免对正在建造相同建筑的地块重复施工',
        code: `module.exports.loop = function () {
  const buildingNow = Object.values(Game.sites).some((s) => s.buildingType === 'shipyard');
  console.log('是否正在建造船坞:', buildingNow);
};`,
      },
      {
        kind: 'links',
        items: [
          { label: 'Game.sites', id: 'Game.sites' },
          { label: 'Plot.build', id: 'Plot.build' },
          { label: 'Building', id: 'Building' },
        ],
      },
    ],
  },
  {
    id: 'Ship',
    title: 'Ship',
    group: '实体与数据结构',
    kind: '类型',
    summary: '自有货船实体，含规格载重、实时状态、货舱与 dispatch(to, cargo) / repair() 方法',
    keywords: 'Ship 飞船 size capacity durability location busyUntil isBusy store dispatch repair',
    blocks: [
      {
        kind: 'prose',
        text: '`Game.ships[shipId]` 返回的自有飞船对象。所有星际与地表-轨道物流通过 `ship.dispatch(to, cargo)` 发起；耐久低时可在所在位置调用 `ship.repair()` 修复。',
      },
      {
        kind: 'fields',
        rows: [
          { name: 'id', type: 'string', desc: '飞船 ID（十进制数字字符串）' },
          { name: 'size', type: '\'small\' | \'medium\' | \'large\'', desc: '船型级别（地面 ↔ 轨道起降油耗/耗时与修船零件呈 1 / 2 / 4 倍）' },
          { name: 'capacity', type: 'number', desc: '货舱总件数容量上限' },
          { name: 'durability', type: 'number', desc: '船体当前耐久（`0 ~ 100`；降至 `0` 时航行耗时翻倍）' },
          { name: 'location', type: 'string', desc: '当前位置 ID（航行中保留出发地，到达后更新为终点 `to`）' },
          { name: 'busyUntil', type: 'number', desc: '最近一趟航行的预计到达 tick；到站后**不主动清零**，空闲判据请始终使用 `isBusy`' },
          { name: 'isBusy', type: 'boolean', desc: '是否正在航行途中（仅 `!ship.isBusy` 时才可派船或修船）' },
          { name: 'store', type: 'Store', desc: '当前在途货舱库存（到站卸货后自动清空，静态时通常全 `0`）' },
        ],
      },
      {
        kind: 'methods',
        title: '实例方法（Methods）',
        rows: [
          { signature: 'ship.dispatch(to: string, cargo?: Record<string, number>)', returns: 'RetCode', desc: '从当前位置 `ship.location` 起飞，将指定混装货物或空船运往目的地 `to`', id: 'Ship.dispatch' },
          { signature: 'ship.repair()', returns: 'RetCode', desc: '消耗当前位置的 `daily_goods` 将飞船耐久恢复至 100', id: 'Ship.repair' },
        ],
      },
      {
        kind: 'links',
        items: [
          { label: 'Game.ships', id: 'Game.ships' },
          { label: 'Ship.dispatch', id: 'Ship.dispatch' },
          { label: 'Ship.repair', id: 'Ship.repair' },
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
    summary: '以飞船当前 location 为起点装货并起飞运往目标位置 to',
    keywords: 'Ship.dispatch 派船 运输 货舱 物流 燃料 cargo',
    blocks: [
      {
        kind: 'prose',
        text: '指派空闲飞船从其当前所在地 `ship.location` 自动装货，经由可达航线运往目的地 `to`（支持混装多种物品，最多不超过 `ship.capacity`；**省略 `cargo` 或传 `{}` 表示空船飞行/返航**，仅消耗航线燃料）。v2 起不再需要冗余传入 `from`。',
      },
      {
        kind: 'syntax',
        code: 'ship.dispatch(to: string, cargo?: Record<string, number>): RetCode',
      },
      {
        kind: 'params',
        rows: [
          { name: 'to', type: 'string', required: 'required', desc: '目标位置，如行星 `\'P2\'`、轨道站 `\'ST:P2\'` 或 `\'ST:HUB\'`' },
          { name: 'cargo', type: 'Record<string, number>', required: 'optional', desc: '装运物品映射 `{ 物品ID: 正整数数量 }`；省略或传 `{}` 时执行空船飞行' },
        ],
      },
      {
        kind: 'returns',
        type: 'RetCode',
        desc: '返回 `OK` 表示飞船状态、航线及出发地影账货物+燃料校验全部通过并入队；否则返回负数错误码',
      },
      {
        kind: 'errors',
        rows: [
          { code: 'ERR_INVALID_ARGS', when: '`to` 为空，`cargo` 不是普通对象或包含非注册物品 / 非正数量' },
          { code: 'ERR_NOT_OWNER', when: '飞船不属于本公司' },
          { code: 'ERR_BUSY', when: '飞船正在航行中（`isBusy === true`），或同一 tick 内已被重复调用一次 `dispatch`' },
          { code: 'ERR_NO_PATH', when: '`ship.location` 与 `to` 之间没有直达航线（包含起终点相同或跨不可达端点）' },
          { code: 'ERR_FULL', when: '`cargo` 各物品总件数超过 `ship.capacity`，或本 tick 写操作配额已满' },
          { code: 'ERR_NOT_ENOUGH_RESOURCES', when: '出发地 `ship.location` 当前库存（计入影账预扣）不足以支付待运货物或全部航程燃料 `fuel`' },
        ],
      },
      {
        kind: 'settlement',
        items: [
          '当同一 tick 先前派船、挂卖单或建造扣减了同一个出发地的燃料或货物时，若影账无法覆盖全部顺序变动，落账复核失败会记录到 `Game.lastTick.rejected`；',
          '飞船出发后当即锁定为 `isBusy = true` 并在到达 tick 结束时自动把货物与飞船卸载交割至 `to`。',
        ],
      },
      {
        kind: 'example',
        caption: '将母星地面产出的钢材混装建材运上母星轨道站',
        code: `module.exports.loop = function () {
  const pid = Game.company.homePlanetId;
  const sid = Game.planets[pid].stationId;
  const ship = Object.values(Game.ships).find((s) => !s.isBusy && s.location === pid);
  if (!ship) return;

  const ground = Game.planets[pid].groundStore;
  const route = Game.map.calcRoute(pid, sid);
  if (!route) return;

  const mult = ship.size === 'large' ? 4 : ship.size === 'medium' ? 2 : 1;
  if (ground[RESOURCE_FUEL] < route.fuel * mult) return;

  const qty = Math.min(ground[RESOURCE_STEEL], ship.capacity);
  if (qty <= 0) return;

  const rc = ship.dispatch(sid, { [RESOURCE_STEEL]: qty });
  if (rc === OK) console.log('已发出飞船:', ship.id, '数量:', qty);
};`,
      },
      {
        kind: 'links',
        items: [
          { label: 'Ship', id: 'Ship' },
          { label: 'Game.map.calcRoute', id: 'Game.map.calcRoute' },
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
    summary: '消耗所在位置仓库中的维修件（daily_goods）将飞船耐久恢复至 100',
    keywords: 'Ship.repair 修船 维修 耐久 daily_goods',
    blocks: [
      {
        kind: 'prose',
        text: '飞船在星际跨站运输后会累计损耗船体耐久（低于 1 时触发速度惩罚，航行耗时翻倍）。在空闲状态调用本方法，消耗当前停靠点仓库中的 `daily_goods`（小船 1 件 / 中船 2 件 / 大船 4 件）瞬间恢复满耐久。',
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
        desc: '返回 `OK` 表示停靠点库存充足且维修请求已入队；否则返回负数错误码',
      },
      {
        kind: 'errors',
        rows: [
          { code: 'ERR_NOT_OWNER', when: '飞船不属于本公司' },
          { code: 'ERR_BUSY', when: '飞船在途（`isBusy === true`）或本 tick 已被指派航行' },
          { code: 'ERR_INVALID_TARGET', when: '飞船耐久已满（`>= 99.9`）、当前世界未配置维修件，或本 tick 已被维修过一次' },
          { code: 'ERR_NOT_ENOUGH_RESOURCES', when: '当前停靠点 `ship.location` 库存的 `daily_goods` 不足对应船型所需数量' },
          { code: 'ERR_FULL', when: '本 tick 写操作配额已满' },
        ],
      },
      {
        kind: 'settlement',
        items: [
          '落账复核时如当前停靠点的 `daily_goods` 已被同 tick 先执行挂单或运走导致不足，将在 `Game.lastTick.rejected` 报 `ERR_NOT_ENOUGH_RESOURCES`。',
        ],
      },
      {
        kind: 'example',
        caption: '耐久低于 40 时自动寻找维修品并原地修船',
        code: `module.exports.loop = function () {
  for (const s of Object.values(Game.ships)) {
    if (!s.isBusy && s.durability < 40) {
      const rc = s.repair();
      if (rc !== OK) console.warn('修船失败:', s.id, 'location=', s.location, 'rc=', rc);
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
    summary: '行星地面仓、空间站仓库与飞船货舱共用的统一只读库存容器接口',
    keywords: 'Store 仓库 库存 getCapacity getFreeCapacity getUsedCapacity',
    blocks: [
      {
        kind: 'prose',
        text: '`planet.groundStore`、`planet.stationStore`、`station.store` 与 `ship.store` 均实现统一的 `Store` 接口。读取已注册物品 ID（如 `store[RESOURCE_STEEL]`）在零库存时直接返回 `0`，未注册键返回 `undefined`。',
      },
      {
        kind: 'fields',
        title: '索引与序列化说明（Properties）',
        rows: [
          { name: 'resourceType', type: 'number | undefined', desc: '下标访问任意注册物品 ID 返回当前整数库存（无存货返回 `0`，非注册键返回 `undefined`）' },
        ],
      },
      {
        kind: 'methods',
        title: '容量查询方法（Methods）',
        rows: [
          { signature: 'store.getUsedCapacity(resource?: string)', returns: 'number', desc: '返回指定物品库存或容器全部物品总件数', id: 'Store.getUsedCapacity' },
          { signature: 'store.getCapacity(resource?: string)', returns: 'number | null', desc: '返回容器总容量上限（地面仓与空间站不限容量返回 `null`）', id: 'Store.getCapacity' },
          { signature: 'store.getFreeCapacity(resource?: string)', returns: 'number | null', desc: '返回剩余可装容量（无容量上限容器返回 `null`）', id: 'Store.getFreeCapacity' },
        ],
      },
      {
        kind: 'links',
        items: [
          { label: 'Store.getUsedCapacity', id: 'Store.getUsedCapacity' },
          { label: 'Store.getCapacity', id: 'Store.getCapacity' },
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
    summary: '返回指定物品的库存数量，省略参数时返回容器内所有物品总件数',
    keywords: 'Store.getUsedCapacity 库存 已用 数量',
    blocks: [
      {
        kind: 'prose',
        text: '传入物品 ID 时返回对应数量（无存货或非注册物品返回 `0`）；不传参数时遍历汇总容器内当前全部存货总件数。',
      },
      {
        kind: 'syntax',
        code: 'store.getUsedCapacity(resource?: string): number',
      },
      {
        kind: 'params',
        rows: [
          { name: 'resource', type: 'string', required: 'optional', desc: '可选物品 ID，省略则返回全部存货之和' },
        ],
      },
      {
        kind: 'returns',
        type: 'number',
        desc: '当前已存放的整数件数',
      },
      {
        kind: 'example',
        caption: '查询母星地面仓总库存与钢材存量',
        code: `module.exports.loop = function () {
  const ground = Game.planets[Game.company.homePlanetId].groundStore;
  console.log('总件数:', ground.getUsedCapacity(), '钢材:', ground.getUsedCapacity(RESOURCE_STEEL));
};`,
      },
      {
        kind: 'links',
        items: [
          { label: 'Store', id: 'Store' },
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
    summary: '返回仓库最大容量；地面仓与空间站无限容量容器返回 null',
    keywords: 'Store.getCapacity 总容量 上限 null',
    blocks: [
      {
        kind: 'prose',
        text: '飞船货舱返回其固定 `capacity` 数字上限；行星地面仓、轨道站与枢纽站仓库不设容量限制，恒返回 `null`。',
      },
      {
        kind: 'syntax',
        code: 'store.getCapacity(resource?: string): number | null',
      },
      {
        kind: 'params',
        rows: [
          { name: 'resource', type: 'string', required: 'optional', desc: '兼容性可选物品参数（全部物品共享总件数上限）' },
        ],
      },
      {
        kind: 'returns',
        type: 'number | null',
        desc: '有限容量容器返回数字；无限容器返回 `null`',
      },
      {
        kind: 'example',
        caption: '对比飞船货舱上限与地面仓容量',
        code: `module.exports.loop = function () {
  const s = Object.values(Game.ships)[0];
  if (s) console.log('飞船上限:', s.store.getCapacity(), '地面上限:', Game.planets.P2.groundStore.getCapacity());
};`,
      },
      {
        kind: 'links',
        items: [
          { label: 'Store', id: 'Store' },
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
    summary: '返回容器当前剩余可装容量；无限容器返回 null',
    keywords: 'Store.getFreeCapacity 剩余空间 空余 容量',
    blocks: [
      {
        kind: 'prose',
        text: '计算方式为 `Math.max(0, getCapacity() - getUsedCapacity())`；对行星地面仓与空间站恒返回 `null`。',
      },
      {
        kind: 'syntax',
        code: 'store.getFreeCapacity(resource?: string): number | null',
      },
      {
        kind: 'params',
        rows: [
          { name: 'resource', type: 'string', required: 'optional', desc: '可选物品参数' },
        ],
      },
      {
        kind: 'returns',
        type: 'number | null',
        desc: '剩余可装整数件数或 `null`',
      },
      {
        kind: 'example',
        caption: '检查在途飞船剩余空间',
        code: `module.exports.loop = function () {
  for (const s of Object.values(Game.ships)) {
    console.log(s.id, '剩余容量:', s.store.getFreeCapacity());
  }
};`,
      },
      {
        kind: 'links',
        items: [
          { label: 'Store', id: 'Store' },
          { label: 'Store.getCapacity', id: 'Store.getCapacity' },
        ],
      },
    ],
  },
  {
    id: 'CompanyInfo',
    title: 'CompanyInfo',
    group: '实体与数据结构',
    kind: '类型',
    summary: 'Game.company 返回的本公司身份与资产负债快照结构',
    keywords: 'CompanyInfo 公司 现金 储蓄 负债 到期 tick debtDueTick',
    blocks: [
      {
        kind: 'prose',
        text: '提供本公司的唯一编号、名称、选定职业、母星 ID 及本 tick 开盘资金状态。',
      },
      {
        kind: 'fields',
        rows: [
          { name: 'id', type: 'string', desc: '本公司唯一 ID' },
          { name: 'name', type: 'string', desc: '公司名称' },
          { name: 'profession', type: 'string', desc: '公司职业赛道 ID' },
          { name: 'homePlanetId', type: 'string', desc: '本公司母星 ID（央行操作必须位于此行星）' },
          { name: 'cash', type: 'number', desc: '本 tick 开盘可用现金（信用点）' },
          { name: 'savings', type: 'number', desc: '本 tick 开盘央行活期储蓄额（信用点）' },
          { name: 'debt', type: 'number', desc: '本 tick 开盘尚未清偿的央行贷款本息总额' },
          { name: 'debtDueTick', type: 'number | null', desc: '贷款到期绝对 tick；无欠款时为 `null`' },
        ],
      },
      {
        kind: 'links',
        items: [
          { label: 'Game.company', id: 'Game.company' },
          { label: 'Game.bank', id: 'Game.bank' },
        ],
      },
    ],
  },
  {
    id: 'CatalogInfo',
    title: 'CatalogInfo',
    group: '实体与数据结构',
    kind: '类型',
    summary: 'Game.catalog 静态世界规则字典结构（物品、建筑、配方及分组索引）',
    keywords: 'CatalogInfo 静态 配置 items buildings recipes recipesByBuilding',
    blocks: [
      {
        kind: 'prose',
        text: '一次性加载并深度冻结的全星系物品、建筑、生产配方及按建筑分类的索引表。',
      },
      {
        kind: 'fields',
        rows: [
          {
            name: 'items',
            type: 'Record<string, { id: string; name: string; role: string; refPrice: number }>',
            desc: '所有物品基础属性与参考指导价',
          },
          {
            name: 'buildings',
            type: 'Record<string, { id: string; name: string; slotsUsed: number; buildTicks: number; cashFeeBase: number; buildCost: Array<{ item: string; qty: number }>; standbyPower: number }>',
            desc: '所有建筑占地槽位、施工耗时、建材与施工基础现金门槛',
          },
          {
            name: 'recipes',
            type: 'Record<string, { id: string; name: string; buildingId: string; enabled: boolean; cycleTicks: number; powerCost: number; laborCost: number; inputs: Array<{ item: string; qty: number }>; outputs: Array<{ item: string; qty: number }> }>',
            desc: '所有配方输入输出、周期、功耗及基础人力成本',
          },
          {
            name: 'recipesByBuilding',
            type: 'Record<string, readonly string[]>',
            desc: '按 `buildingId` 归类的配方 ID 只读数组索引',
          },
        ],
      },
      {
        kind: 'links',
        items: [
          { label: 'Game.catalog', id: 'Game.catalog' },
          { label: '默认世界建筑与配方', id: 'constants/world-catalog' },
        ],
      },
    ],
  },
  {
    id: 'LastTickFeedback',
    title: 'LastTickFeedback',
    group: '实体与数据结构',
    kind: '类型',
    summary: 'Game.lastTick 结构：上回合真实成交流水 fills 与被拒意图列表 rejected',
    keywords: 'LastTickFeedback LastTickFill RejectedIntent fills rejected 拒绝 原因',
    blocks: [
      {
        kind: 'prose',
        text: '由引擎在每次落账结束时自动生成的上回合结算回执，帮助脚本掌握每笔市场真实成交价与极少数跨公司竞态被拒原因。',
      },
      {
        kind: 'fields',
        title: 'Game.lastTick 顶层字段',
        rows: [
          {
            name: 'fills',
            type: 'Array<{ tick: number; stationId: string; itemId: string; side: \'buy\' | \'sell\'; qty: number; price: number; notional: number; fee: number; buyerRefund: number; counterpartyId: string }>',
            desc: '上一 tick 成交的每一笔明细（与 `Game.market.transactions` 相同）',
          },
          {
            name: 'rejected',
            type: 'Array<{ intentIndex: number; action: string; target: string; code: RetCode; reason: string }>',
            desc: '上一 tick 同步返 `OK` 但在落账复核阶段被拒的意图明细（包含可读中文 `reason` 与标准 `code`）',
          },
        ],
      },
      {
        kind: 'links',
        items: [
          { label: 'Game.lastTick', id: 'Game.lastTick' },
          { label: '返回码一览', id: 'constants/return-codes' },
        ],
      },
    ],
  },
  {
    id: 'MarketOrder',
    title: 'MarketOrder',
    group: '实体与数据结构',
    kind: '类型',
    summary: '活跃限价挂单对象结构，由 Game.market.orders / getAllOrders / getOrderById 返回',
    keywords: 'MarketOrder 订单 挂单 结构 price amount totalAmount ownerId',
    blocks: [
      {
        kind: 'prose',
        text: '表示全星系订单簿中一条尚未结束的活跃限价挂单。',
      },
      {
        kind: 'fields',
        rows: [
          { name: 'id', type: 'string', desc: '订单 ID（十进制数字字符串）' },
          { name: 'created', type: 'number', desc: '该订单创建落账时的 tick 序号' },
          { name: 'type', type: '\'buy\' | \'sell\'', desc: '订单方向（`ORDER_BUY` 或 `ORDER_SELL`）' },
          { name: 'resourceType', type: 'string', desc: '交易物品 ID' },
          { name: 'stationId', type: 'string', desc: '所属空间站 ID' },
          { name: 'price', type: 'number', desc: '限价单价（信用点）' },
          { name: 'amount', type: 'number', desc: '当前剩余可成交数量' },
          { name: 'totalAmount', type: 'number', desc: '挂单原始总数量' },
          { name: 'ownerId', type: 'string', desc: '挂单方公司 ID' },
        ],
      },
      {
        kind: 'links',
        items: [
          { label: 'Game.market.orders', id: 'Game.market.orders' },
          { label: 'Game.market.getAllOrders', id: 'Game.market.getAllOrders' },
          { label: 'Game.market.getOrderById', id: 'Game.market.getOrderById' },
        ],
      },
    ],
  },
  {
    id: 'MarketQuote',
    title: 'MarketQuote',
    group: '实体与数据结构',
    kind: '类型',
    summary: '站点物品盘口汇总报价结构，由 Game.market.quote 返回',
    keywords: 'MarketQuote 报价 bestBid bestAsk lastPrice emaFast emaSlow vol50t',
    blocks: [
      {
        kind: 'prose',
        text: '聚合指定空间站单一物品的实时盘口最优报价与均线成交指标。',
      },
      {
        kind: 'fields',
        rows: [
          { name: 'stationId', type: 'string', desc: '空间站 ID' },
          { name: 'resourceType', type: 'string', desc: '物品 ID' },
          { name: 'bestBid', type: 'number | null', desc: '当前买一价（无买单时为 `null`）' },
          { name: 'bestAsk', type: 'number | null', desc: '当前卖一价（无卖单时为 `null`）' },
          { name: 'lastPrice', type: 'number', desc: '最近成交价（若未成交过则回落参考基准价）' },
          { name: 'emaFast', type: 'number', desc: '短期快速成交均价指数均线' },
          { name: 'emaSlow', type: 'number', desc: '长期慢速参考均价指数均线' },
          { name: 'vol50t', type: 'number', desc: '最近 50 个 tick 累计成交总件数' },
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
    summary: '航线估算返回结构（小船基准耗时、基准油耗与航段类型），由 Game.map.calcRoute 返回',
    keywords: 'RouteCost 航线 ticks fuel kind orbital interplanetary',
    blocks: [
      {
        kind: 'prose',
        text: '由 `Game.map.calcRoute(fromId, toId)` 返回的单程航行预估结果。',
      },
      {
        kind: 'fields',
        rows: [
          { name: 'ticks', type: 'number', desc: '小船（`small`）满耐久时的单程航行耗时（tick 数）' },
          { name: 'fuel', type: 'number', desc: '小船（`small`）在当前航段需要的基准 `fuel` 数量' },
          { name: 'kind', type: '\'orbital\' | \'interplanetary\'', desc: '航段类型：`orbital` 为地表 ↔ 轨道站起降，`interplanetary` 为星际航段' },
        ],
      },
      {
        kind: 'note',
        level: 'info',
        text: '在 `orbital` 航段，中/大型船的实际耗时与油耗为小船基准的 **2 / 4 倍**；在 `interplanetary` 航段，耗油固定为当前估算值，仅船体耐久为 0 时使总耗时翻倍。',
      },
      {
        kind: 'links',
        items: [
          { label: 'Game.map.calcRoute', id: 'Game.map.calcRoute' },
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
    summary: '行星表面公开格点数据结构，由 Game.map.getLandPlots 返回',
    keywords: 'PublicLandPlot 地面格点 slotId lat lon terrainName buildingMods status price',
    blocks: [
      {
        kind: 'prose',
        text: '表示某颗行星表面的单个网格地块单元，可用于地面测绘、挑选产能高加成地与评估买卖地价格。',
      },
      {
        kind: 'fields',
        rows: [
          { name: 'slotId', type: 'number', desc: '行星永久位置格点编号（传给 `Game.map.buyPlot`）' },
          { name: 'planetId', type: 'string', desc: '所属行星 ID' },
          { name: 'lat', type: 'number', desc: '纬度' },
          { name: 'lon', type: 'number', desc: '经度' },
          { name: 'terrainName', type: 'string', desc: '地形中文名' },
          { name: 'capacity', type: 'number', desc: '槽位总数' },
          { name: 'usedSlots', type: 'number', desc: '已用槽位' },
          { name: 'buildingMods', type: 'Record<string, number>', desc: '不同建筑效率修正表' },
          { name: 'status', type: '\'city\' | \'unclaimed\' | \'listed\' | \'owned\'', desc: '当前开发状态：`unclaimed` 可买一手、`listed` 可买二手' },
          { name: 'isCity', type: 'boolean', desc: '是否为城市市政保留区' },
          { name: 'cityName', type: 'string | null', desc: '城市片区名称' },
          { name: 'ownerId', type: 'string | null', desc: '当前所有权公司 ID' },
          { name: 'ownerName', type: 'string | null', desc: '当前所有权公司名称' },
          { name: 'isPlayerOwner', type: 'boolean', desc: '是否属于本公司' },
          { name: 'plotId', type: 'string | null', desc: '已购地块的字符串实体 ID' },
          { name: 'listingId', type: 'string | null', desc: '处于 `listed` 挂售状态时的挂牌编号（传给 `Game.market.buyLand`）' },
          { name: 'price', type: 'number | null', desc: '一手地价或二手挂牌要价' },
          { name: 'buildings', type: 'string[]', desc: '地面已有建筑类型 ID 列表' },
        ],
      },
      {
        kind: 'links',
        items: [
          { label: 'Game.map.getLandPlots', id: 'Game.map.getLandPlots' },
          { label: 'Game.map.buyPlot', id: 'Game.map.buyPlot' },
          { label: 'Game.market.buyLand', id: 'Game.market.buyLand' },
        ],
      },
    ],
  },
  {
    id: 'PublicCompanySummary',
    title: 'PublicCompanySummary',
    group: '实体与数据结构',
    kind: '类型',
    summary: '全星系公司公开资产概览结构，由 Game.map.listCompanies 返回',
    keywords: 'PublicCompanySummary 公司 摘要 netLiquid plotsCount buildingsCount shipsBySize',
    blocks: [
      {
        kind: 'prose',
        text: '全星系竞争对手的基础资产统计。',
      },
      {
        kind: 'fields',
        rows: [
          { name: 'id', type: 'string', desc: '公司 ID' },
          { name: 'name', type: 'string', desc: '公司名称' },
          { name: 'isPlayer', type: 'boolean', desc: '是否为人类玩家控制公司' },
          { name: 'homePlanetId', type: 'string', desc: '母星行星 ID' },
          { name: 'netLiquid', type: 'number', desc: '公司净流动资金估值（现金 + 储蓄 - 负债）' },
          { name: 'plotsCount', type: 'number', desc: '持有工业地块数量' },
          { name: 'buildingsCount', type: 'number', desc: '已完工建筑数量' },
          { name: 'shipsCount', type: 'number', desc: '飞船总数' },
          { name: 'shipsBySize', type: '{ small: number; medium: number; large: number }', desc: '各船型数量分布' },
          { name: 'openOrdersCount', type: 'number', desc: '当前全星系活跃挂单数量' },
        ],
      },
      {
        kind: 'links',
        items: [
          { label: 'Game.map.listCompanies', id: 'Game.map.listCompanies' },
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
    summary: '指定公司的公开地块布局、设施分布与活跃挂单详情，由 Game.map.getCompany 返回',
    keywords: 'PublicCompanyDetail 公司 详情 buildingCounts plots openOrders',
    blocks: [
      {
        kind: 'prose',
        text: '在 `PublicCompanySummary` 基础上扩展了各型建筑统计、公开地块坐标及挂单数组。',
      },
      {
        kind: 'fields',
        title: '全部字段（Properties）',
        rows: [
          { name: 'id', type: 'string', desc: '公司 ID' },
          { name: 'name', type: 'string', desc: '公司名称' },
          { name: 'isPlayer', type: 'boolean', desc: '是否为人类玩家公司' },
          { name: 'homePlanetId', type: 'string', desc: '母星行星 ID' },
          { name: 'netLiquid', type: 'number', desc: '公司净流动资金估值' },
          { name: 'plotsCount', type: 'number', desc: '地块总数' },
          { name: 'buildingsCount', type: 'number', desc: '建筑总数' },
          { name: 'shipsCount', type: 'number', desc: '飞船总数' },
          { name: 'shipsBySize', type: '{ small: number; medium: number; large: number }', desc: '按规模分类飞船数量' },
          { name: 'buildingCounts', type: 'Record<string, number>', desc: '按建筑类型汇总的持有数量表' },
          {
            name: 'plots',
            type: 'Array<{ planetId: string; slotId: number; plotId: string | null; lat: number; lon: number; terrainName: string; capacity: number; usedSlots: number; status: string; listingId: string | null; price: number | null; buildings: string[] }>',
            desc: '该公司公开地块及建筑清单',
          },
          { name: 'openOrdersCount', type: 'number', desc: '活跃挂单总数' },
          { name: 'openOrders', type: 'MarketOrder[]', desc: '该公司当前全星系活跃挂单列表' },
        ],
      },
      {
        kind: 'links',
        items: [
          { label: 'Game.map.getCompany', id: 'Game.map.getCompany' },
          { label: 'PublicCompanySummary', id: 'PublicCompanySummary' },
          { label: 'MarketOrder', id: 'MarketOrder' },
        ],
      },
    ],
  },
];

import type { DocEntry } from '../types';

/**
 * 「实体」分组：脚本在 Game 里读到的各类只读快照对象。
 * 它们的字段都是引擎每 tick 生成的，只读；写操作走各自的方法（返回错误码）。
 */
export const ENTITY_ENTRIES: DocEntry[] = [
  {
    id: 'Planet',
    title: 'Planet',
    group: '实体',
    kind: '类型',
    summary: '一颗行星的公开数据，外加本公司在这颗星上的仓库、需求与待售土地。',
    keywords: 'Planet 行星 星球 人口 繁荣 重力 废料 地价 二手地 landListings demands 需求 仓库 银行利率',
    blocks: [
      {
        kind: 'prose',
        text: '`Game.planets[id]` 返回的只读快照。前半截是这颗星的客观情况（人口、繁荣度、地价），后半截是**本公司视角**的资产（两个仓库、各项需求）——刚开的公司这两个仓库通常是空的。',
      },
      {
        kind: 'fields',
        rows: [
          { name: 'id', type: 'string', desc: '星球 id，如 `"P2"`。脚本里所有 id 都是字符串。' },
          { name: 'name', type: 'string', desc: '显示名。' },
          { name: 'wealthTier', type: 'number', desc: '富裕等级 1..5，越高消费能力越强。' },
          { name: 'prosperity', type: 'number', desc: '繁荣度。' },
          { name: 'population', type: 'number', desc: '人口。' },
          { name: 'gravity', type: 'number', desc: '重力。' },
          { name: 'wasteBacklog', type: 'number', desc: '还没处理掉的废料堆积量。' },
          { name: 'primaryLandPrice', type: 'number | null', desc: '一手地单价；`null` 表示这颗星没有一手地可买。' },
          {
            name: 'landListings',
            type: 'Array<{ listingId: string; plotId: string; slotId: number; sellerId: string; askPrice: number; terrainName: string; lat: number; lon: number; capacity: number; usedSlots: number; buildingMods: Record<string, number>; buildings: string[] }>',
            desc: '本星当前全部二手/银行清算挂牌地块（含完整位置、地形、加成与已有建筑）。',
          },
          { name: 'bankRatePct', type: 'number', desc: '本星银行利率（百分数，如 4.5 表示 4.5%）。' },
          { name: 'groundStore', type: 'Store', desc: '本公司在这颗星的地面仓。' },
          { name: 'stationStore', type: 'Store', desc: '本公司在这颗星的轨道站仓。' },
          { name: 'demands', type: 'Record<string, { qty: number }>', desc: '各物品本 tick 的需求量。' },
        ],
      },
      {
        kind: 'note',
        level: 'info',
        text: '`groundStore` 与 `stationStore` 的 `getCapacity()` 恒返回 `null`（星球仓没有容量上限），`getFreeCapacity()` 同理；只有飞船的货舱才有真实容量。',
      },
      {
        kind: 'note',
        level: 'warn',
        text: '`demands` 的每一项**只有 `qty`**，没有 `satisfaction`。旧版 `PROTOCOL.md` 里写的 `{ qty, satisfaction }` 已经过时，照抄会读到 `undefined`。',
      },
      {
        kind: 'prose',
        text: '买地：一手地先通过 `Game.market.getLandPlots(planetId)` 挑 `slotId`，二手地看 `landListings`（带 `listingId`）；下单用 `Game.buyPlot(planetId, { slotId } | { listingId })`。',
      },
      {
        kind: 'example',
        caption: '按需求量找销路，同时检索高矿冶空地与二手地',
        code: "const p = Game.planets['P2'];\n\n// 这颗星最缺什么？按需求量排序取前三\nconst top = Object.entries(p.demands)\n  .sort((a, b) => b[1].qty - a[1].qty)\n  .slice(0, 3);\nconsole.log(p.name, '需求前三', JSON.stringify(top));\n\n// 二手地在售（现带地形、槽位与设施清单）\nfor (const listing of p.landListings) {\n  console.log(listing.slotId, listing.terrainName, listing.askPrice, listing.buildings);\n}",
      },
      {
        kind: 'links',
        items: [
          { label: 'Station', id: 'Station' },
          { label: 'Plot', id: 'Plot' },
          { label: 'Store', id: 'Store' },
        ],
      },
    ],
  },
  {
    id: 'Station',
    title: 'Station',
    group: '实体',
    kind: '类型',
    summary: '轨道站，本质是一个仓库；字典的键集只包含本公司有库存记录的站点。',
    keywords: 'Station 轨道站 ST:HUB ST:P2 store 仓库 库存',
    blocks: [
      {
        kind: 'prose',
        text: '`Game.stations` 是只读字典。注意它的键集**只包含本公司有库存记录的站点**，不是全星系的站点清单。',
      },
      {
        kind: 'fields',
        rows: [
          { name: 'id', type: 'string', desc: '站点 id，形如 `"ST:P2"`、`"ST:HUB"`；飞船的 location 也用这套值。' },
          { name: 'store', type: 'Store', desc: '本站点里本公司的库存。' },
        ],
      },
      {
        kind: 'note',
        level: 'warn',
        text: '新公司可能连 `"ST:HUB"` 都还没有条目。别直接 `Game.stations["ST:HUB"].store`（会 TypeError），先判空。',
      },
      {
        kind: 'example',
        caption: '安全地读 Hub 库存',
        code: "const hub = Game.stations['ST:HUB'];\n\nif (hub) {\n  console.log('Hub 库存', hub.store.getUsedCapacity());\n} else {\n  console.log('还没有 Hub 的库存记录');\n}",
      },
      {
        kind: 'links',
        items: [
          { label: 'Store', id: 'Store' },
          { label: 'Ship', id: 'Ship' },
          { label: 'Planet', id: 'Planet' },
        ],
      },
    ],
  },
  {
    id: 'Plot',
    title: 'Plot',
    group: '实体',
    kind: '类型',
    summary: '自己名下的一块地：地形、格子容量，以及地形对各建筑类型的效率修正。',
    keywords: 'Plot 地块 土地 地形 terrain 格子 容量 buildingMods 建造',
    blocks: [
      {
        kind: 'prose',
        text: '`Game` 里只会出现**自己的**地块，看不到别家的地皮。地块本身没有方法，建造和拆除都走 `Game` 上的全局方法。',
      },
      {
        kind: 'fields',
        rows: [
          { name: 'id', type: 'string', desc: '地块 id。' },
          { name: 'slotId', type: 'number', desc: '行星表面永久位置编号（1..N）。' },
          { name: 'planetId', type: 'string', desc: '所属星球 id。' },
          { name: 'lat', type: 'number', desc: '行星表面纬度（度）。' },
          { name: 'lon', type: 'number', desc: '行星表面经度（度）。' },
          { name: 'terrainName', type: 'string', desc: '地形名。' },
          { name: 'capacity', type: 'number', desc: '地块能放多少格建筑。' },
          { name: 'usedSlots', type: 'number', desc: '已经占用的格数。' },
          {
            name: 'buildingMods',
            type: 'Record<string, number>',
            desc: '地形对各建筑类型的效率修正值；盖厂前先查这张表，别在不利地形上盖亏本厂。',
          },
        ],
      },
      {
        kind: 'note',
        level: 'info',
        text: '建造用 `Game.buildFacility(plotId, buildingType)`，拆除用 `Game.demolishFacility(plotId, buildingId)`。',
      },
      {
        kind: 'note',
        level: 'warn',
        text: '格子用完（`usedSlots >= capacity`）就盖不下新建筑了，先拆再盖。',
      },
      {
        kind: 'links',
        items: [
          { label: 'PublicLandPlot', id: 'PublicLandPlot' },
          { label: 'Building', id: 'Building' },
          { label: 'Planet', id: 'Planet' },
        ],
      },
    ],
  },
  {
    id: 'PublicLandPlot',
    title: 'PublicLandPlot',
    group: '实体',
    kind: '类型',
    summary: '行星表面的公开地理格点（城市、已开发企业地、在售挂牌与未开发空地）。',
    keywords: 'PublicLandPlot slotId lat lon 地块 坐标 地形 加成 归属 挂牌',
    blocks: [
      {
        kind: 'prose',
        text: '通过 `Game.market.getLandPlots(planetId)` 返回的公开地表数组元素。用于先看坐标、地形、加成和归属，再传 `slotId` 或 `listingId` 调用 `Game.buyPlot`。',
      },
      {
        kind: 'fields',
        rows: [
          { name: 'slotId', type: 'number', desc: '永久位置编号（用于购买一手空地）。' },
          { name: 'planetId', type: 'string', desc: '所属星球 id。' },
          { name: 'lat / lon', type: 'number', desc: '行星表面经纬度坐标。' },
          { name: 'terrainName', type: 'string', desc: '地形名称。' },
          { name: 'capacity / usedSlots', type: 'number', desc: '可用建筑槽位数 / 已占槽位数。' },
          { name: 'buildingMods', type: 'Record<string, number>', desc: '各类设施在该位置的效率乘数。' },
          { name: 'status', type: '"city" | "unclaimed" | "listed" | "owned"', desc: '地块公开状态。' },
          { name: 'ownerId / ownerName', type: 'string | null', desc: '当前归属公司（未开发或城市区为 null）。' },
          { name: 'buildings', type: 'string[]', desc: '该位置已公开建造的设施类型 id 列表。' },
          { name: 'listingId', type: 'string | null', desc: '若处于挂牌状态，对应的二手挂牌 id。' },
          { name: 'price', type: 'number | null', desc: '空地为当前一手地价，挂牌为要价，其余为 null。' },
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
    group: '实体',
    kind: '类型',
    summary: '公司公开摘要条目（母星、公开净流动资产、地块/建筑/飞船/挂单规模）。',
    keywords: 'PublicCompanySummary 公司 摘要 排行榜 净流动资产',
    blocks: [
      {
        kind: 'prose',
        text: '由 `Game.market.listCompanies(filter)` 返回的公司公开摘要。不包含职业、现金/存款/负债明细、仓库库存及飞船航线等隐私。',
      },
      {
        kind: 'fields',
        rows: [
          { name: 'id / name', type: 'string', desc: '公司 id 与名称。' },
          { name: 'isPlayer', type: 'boolean', desc: '是否为玩家控制公司。' },
          { name: 'homePlanetId', type: 'string', desc: '所属母星 id。' },
          { name: 'netLiquid', type: 'number', desc: '公开净流动资产。' },
          { name: 'plotsCount / buildingsCount', type: 'number', desc: '名下地块数 / 建筑总数。' },
          { name: 'shipsCount / shipsBySize', type: 'number / { small, medium, large }', desc: '登记飞船总数及各型号数量。' },
          { name: 'openOrdersCount', type: 'number', desc: '当前全星系活跃公开挂单数量。' },
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
    group: '实体',
    kind: '类型',
    summary: '单家公司的完整公开商业情报（含名下地块、设施分布与公开挂单）。',
    keywords: 'PublicCompanyDetail 公司详情 地块 建筑 挂单 净资产',
    blocks: [
      {
        kind: 'prose',
        text: '由 `Game.market.getCompany(companyId)` 返回，继承 `PublicCompanySummary` 的全部字段并附加设施聚合统计、公开地块清单与全部活跃挂单。',
      },
      {
        kind: 'fields',
        rows: [
          { name: 'buildingCounts', type: 'Record<string, number>', desc: '按建筑类型汇总的数量映射。' },
          { name: 'plots', type: 'Array<{ planetId, slotId, plotId, lat, lon, terrainName, capacity, usedSlots, status, listingId, price, buildings }>', desc: '名下全部公开地块与各块地已建建筑类型列表。' },
          { name: 'openOrders', type: 'MarketOrder[]', desc: '该公司在各空间站的全部活跃公开挂单。' },
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
  {
    id: 'Building',
    title: 'Building',
    group: '实体',
    kind: '类型',
    summary: '自己厂里的一栋生产建筑：按配方消耗原料、产出成品，可开机停产、可热换配方。',
    keywords: 'Building 建筑 工厂 生产 配方 recipe 开机 停产 efficiency progress cycleTicks setRecipe setActive',
    blocks: [
      {
        kind: 'prose',
        text: '生产建筑每 tick 推进 `progress`，跑满 `cycleTicks` 就消耗一批 `inputs` 并产出 `outputs`（配方定义见 RecipeInfo）。',
      },
      {
        kind: 'fields',
        rows: [
          { name: 'id', type: 'string', desc: '建筑 id。' },
          { name: 'type', type: 'string', desc: '建筑类型，如 `"mine_smelter"`。' },
          { name: 'plotId', type: 'string', desc: '所在的地块 id。' },
          { name: 'planetId', type: 'string', desc: '所在星球 id。' },
          { name: 'efficiency', type: 'number', desc: '当前效率 = 地块地形修正 × 职业加成，保留两位小数。' },
          { name: 'recipeId', type: 'string', desc: '当前绑定的配方 id。' },
          { name: 'active', type: 'boolean', desc: '是否开机生产。' },
          { name: 'progress', type: 'number', desc: '当前周期已经跑了多少 tick。' },
          { name: 'cycleTicks', type: 'number', desc: '当前配方的总周期 tick。' },
        ],
      },
      {
        kind: 'syntax',
        code: 'building.setRecipe(recipeId: string): number\nbuilding.setActive(active: boolean): number',
      },
      {
        kind: 'params',
        rows: [
          { name: 'recipeId', type: 'string', required: true, desc: '要换上的配方 id（`setRecipe`）。' },
          { name: 'active', type: 'boolean', required: true, desc: 'true 开机，false 停产（`setActive`）。' },
        ],
      },
      {
        kind: 'returns',
        type: 'number',
        desc: '成功返回 `OK`（0），失败返回负数错误码，见下表。',
      },
      {
        kind: 'errors',
        rows: [
          { code: 'ERR_INVALID_ARGS', when: '参数类型不对，例如 `setActive("true")` 传了字符串而不是布尔。' },
          { code: 'ERR_NOT_OWNER', when: '这栋建筑不属于本公司。' },
          { code: 'ERR_NOT_FOUND', when: '配方 id 不存在（拿 `Game.getRecipe()` 先确认）。' },
          { code: 'ERR_INVALID_TARGET', when: '仅 `setRecipe`：这个配方不属于该建筑类型。' },
          { code: 'ERR_FULL', when: '本 tick 的 32 条 Intent 已经用满，这条没能入队。' },
        ],
      },
      {
        kind: 'note',
        level: 'info',
        text: '`setRecipe` 立即改 `recipeId`，但**进度不清零**：当前周期跑满时按**新配方**结算 outputs。停产（`setActive(false)`）只付轻待机电费，比空转便宜。',
      },
      {
        kind: 'note',
        level: 'warn',
        text: '返回 `OK` 只表示 Intent 进了本 tick 的缓冲；这一 tick 里读 `building.recipeId` / `building.active` 还是旧值。',
      },
      {
        kind: 'example',
        caption: '批量把停机的冶炼厂换成新配方并开机',
        code: "const STEEL_RECIPE = 'steel_ingot'; // 换成你配方表里真实存在的 id\n\nfor (const b of Object.values(Game.buildings)) {\n  if (b.type !== 'mine_smelter' || b.active) continue;\n\n  const code = b.setRecipe(STEEL_RECIPE);\n  if (code !== OK) {\n    console.log('换配方失败', b.id, code);\n    continue;\n  }\n  b.setActive(true);\n}",
      },
      {
        kind: 'links',
        items: [
          { label: 'RecipeInfo', id: 'RecipeInfo' },
          { label: 'Plot', id: 'Plot' },
          { label: 'quotas', id: 'quotas' },
          { label: 'execution', id: 'execution' },
        ],
      },
    ],
  },
  {
    id: 'Ship',
    title: 'Ship',
    group: '实体',
    kind: '类型',
    summary: '往返于地面、轨道站与 Hub 之间的运输船：一次派一段单程，可混装多种货。',
    keywords: 'Ship 飞船 运输 dispatch 派船 cargo 载重 durability 耐久 repair 维修 location busyUntil isBusy',
    blocks: [
      {
        kind: 'prose',
        text: '运输单元。一次 `dispatch` 走一段单程（`P2` 地面 ↔ `ST:P2` 轨道站、轨道站 ↔ `ST:HUB`），同一艘船可以混装多种货物。',
      },
      {
        kind: 'fields',
        rows: [
          { name: 'id', type: 'string', desc: '飞船 id。' },
          { name: 'size', type: "'small' | 'medium' | 'large'", desc: '船型。' },
          { name: 'capacity', type: 'number', desc: '货舱总容量（`store.getCapacity()` 也返回它）。' },
          { name: 'durability', type: 'number', desc: '耐久 0..100。' },
          { name: 'location', type: 'string', desc: '当前位置：`"P2"` 地面、`"ST:P2"` 轨道站、`"ST:HUB"` Hub。' },
          { name: 'busyUntil', type: 'number', desc: '上次派船算出的预计到达 tick；**到站后不会清零**，空闲判据只看 `isBusy`。' },
          { name: 'isBusy', type: 'boolean', desc: '是否在途。' },
          { name: 'store', type: 'Store', desc: '货舱。' },
        ],
      },
      {
        kind: 'syntax',
        code: 'ship.dispatch(from: string, to: string, cargo: Record<string, number>): number\nship.repair(): number',
      },
      {
        kind: 'params',
        rows: [
          {
            name: 'from',
            type: 'string',
            required: true,
            desc: '出发地，`"P2"` / `"ST:P2"` / `"ST:HUB"`；必须等于船当前的 location，否则 `ERR_NOT_IN_RANGE`。',
          },
          { name: 'to', type: 'string', required: true, desc: '目的地，取值同上；和 from 相同时只会得到 `ERR_NO_PATH`，不是专门的参数错误。' },
          {
            name: 'cargo',
            type: 'Record<string, number>',
            required: true,
            desc: '混装货物，如 `{ steel: 20, building_mat: 10 }`。总量不能超过货舱**总容量**（不扣舱内已有货物）。',
          },
        ],
      },
      {
        kind: 'returns',
        type: 'number',
        desc: '`dispatch` / `repair` 都是成功返回 `OK`（0），失败返回负错误码。',
      },
      {
        kind: 'errors',
        rows: [
          { code: 'ERR_INVALID_ARGS', when: 'shipId 解析失败、cargo 不是对象或为空、物品未知、数量 ≤ 0 或取整后为 0。未知地点不报这个码（见下两行）。' },
          { code: 'ERR_NOT_OWNER', when: '船不是本公司的。' },
          { code: 'ERR_BUSY', when: '船还在路上（`isBusy` 为 true），到达前不能再派。' },
          { code: 'ERR_NOT_IN_RANGE', when: 'from 与船当前 location 不一致。' },
          { code: 'ERR_NO_PATH', when: 'from 到 to 没有可行航线。' },
          { code: 'ERR_FULL', when: '货物总量超过货舱总容量，或本 tick 的 32 条 Intent 已满。' },
          { code: 'ERR_NOT_ENOUGH_RESOURCES', when: '出发地燃料不足；仅当 catalog 给这条航线配了 fuel_item。' },
        ],
      },
      {
        kind: 'note',
        level: 'info',
        text: '到达后 `location` 变成目的地、`isBusy` 自动变 false，但 `busyUntil` **保留上次到达 tick、不会清零**——不要用 `busyUntil === 0` 判断空闲。',
      },
      {
        kind: 'note',
        level: 'warn',
        text: '本 tick 里刚 `dispatch` 完立刻读 `ship.isBusy` 仍是 false —— 写入要等 Phase 2 落账（见 execution）。',
      },
      {
        kind: 'example',
        caption: '把地面仓的钢运到轨道站，顺便修耐久低的船',
        code: "for (const ship of Object.values(Game.ships)) {\n  if (ship.isBusy) continue;\n\n  if (ship.durability < 40) {\n    const code = ship.repair();\n    if (code !== OK) console.log('修理失败', ship.id, code);\n    continue;\n  }\n\n  if (ship.location !== 'P2') continue;\n\n  const code = ship.dispatch('P2', 'ST:P2', { steel: 20 });\n  if (code !== OK) console.log('派船失败', ship.id, code);\n}",
      },
      {
        kind: 'links',
        items: [
          { label: 'Store', id: 'Store' },
          { label: 'RouteCost', id: 'RouteCost' },
          { label: 'Station', id: 'Station' },
          { label: 'execution', id: 'execution' },
        ],
      },
    ],
  },
  {
    id: 'Store',
    title: 'Store',
    group: '实体',
    kind: '类型',
    summary: '库存容器（星球仓、站仓、飞船货舱共用），只读：读得到量，写不进去。',
    keywords: 'Store 库存 仓库 容量 getCapacity getUsedCapacity getFreeCapacity 货舱',
    blocks: [
      {
        kind: 'prose',
        text: '统一的库存容器。`planet.groundStore`、`planet.stationStore`、`station.store`、`ship.store` 都是它。**只读 Proxy**：写入不会生效，货物只能靠引擎搬。',
      },
      {
        kind: 'syntax',
        code: 'store[item]: number | undefined\nstore.getCapacity(resource?: string): number | null\nstore.getUsedCapacity(resource?: string): number | null\nstore.getFreeCapacity(resource?: string): number | null',
      },
      {
        kind: 'prose',
        text: '下标读 `store[item]`：没持有该物品返回 `0`；物品名非法返回 `undefined`。方法版不一样：`getUsedCapacity(非法物品名)` 返回 `null`，合法但未持有返回 `0`。',
      },
      {
        kind: 'note',
        level: 'info',
        text: '星球仓与站仓的 `getCapacity()` 恒为 `null`（没有容量上限），`getFreeCapacity()` 同理；只有飞船货舱返回真实数值。',
      },
      {
        kind: 'note',
        level: 'warn',
        text: '写 `store[item] = n` 或 `delete store[item]` 返回 `false`：松散模式下静默无效，`"use strict"` 下会抛 TypeError。',
      },
      {
        kind: 'note',
        level: 'danger',
        text: '脚本**不在严格模式**（`require` 用 `new Function` 执行），所以写库存不会报错，只会悄悄什么都没发生——别用它来"清空仓"。',
      },
      {
        kind: 'note',
        level: 'warn',
        text: '`ownKeys` 只列出数量 > 0 的键：`Object.keys(store)` 看不到数量为 0 的物品，"有记录但为 0"和"从没有过"在遍历里没区别。',
      },
      {
        kind: 'example',
        caption: '统计货舱占用并列出明细',
        code: "const ship = Object.values(Game.ships)[0];\nif (!ship) return;\n\nconst store = ship.store;\nconst cap = store.getCapacity();\nconst used = store.getUsedCapacity();\nconsole.log('载重', used, '/', cap);\n\nfor (const item of Object.keys(store)) {\n  const qty = store[item];\n  if (qty > 0) console.log(item, qty);\n}",
      },
      {
        kind: 'links',
        items: [
          { label: 'Planet', id: 'Planet' },
          { label: 'Ship', id: 'Ship' },
          { label: 'Station', id: 'Station' },
        ],
      },
    ],
  },
  {
    id: 'RecipeInfo',
    title: 'RecipeInfo',
    group: '实体',
    kind: '类型',
    summary: '静态配方表的一条：周期、电费、工资、消耗什么、产出什么。',
    keywords: 'RecipeInfo 配方 recipe 生产 投入 产出 inputs outputs cycleTicks powerCost laborCost getRecipe',
    blocks: [
      {
        kind: 'prose',
        text: '由 `Game.getRecipe(recipeId)` 读取的静态配方表条目（查不到返回 `null`）。拿它和 MarketQuote 一起算，就能判断一条配方值不值得开。',
      },
      {
        kind: 'fields',
        rows: [
          { name: 'id', type: 'string', desc: '配方 id。' },
          { name: 'buildingId', type: 'string', desc: '该配方归属的建筑（只有这种建筑能用它）。' },
          { name: 'cycleTicks', type: 'number', desc: '一个生产周期占多少 tick。' },
          { name: 'powerCost', type: 'number', desc: '每周期电费。' },
          { name: 'laborCost', type: 'number', desc: '每周期工资。' },
          { name: 'inputs', type: 'Array<{ item: string; qty: number }>', desc: '每周期消耗的原料。' },
          { name: 'outputs', type: 'Array<{ item: string; qty: number }>', desc: '每周期产出的成品。' },
        ],
      },
      {
        kind: 'note',
        level: 'warn',
        text: '把不属于该建筑的配方塞给 `setRecipe`，会得到 `ERR_INVALID_TARGET`——先对一下 `buildingId`。',
      },
      {
        kind: 'note',
        level: 'info',
        text: '粗算利润：outputs 按当前 quote 估价 − inputs 成本 − `powerCost` − `laborCost`，再除以 `cycleTicks` 得每 tick 收益。',
      },
      {
        kind: 'links',
        items: [
          { label: 'Building', id: 'Building' },
          { label: 'MarketQuote', id: 'MarketQuote' },
        ],
      },
    ],
  },
  {
    id: 'MarketOrder',
    title: 'MarketOrder',
    group: '实体',
    kind: '类型',
    summary: '市场里的一条挂单：方向、物品、站点、价格与剩余数量。',
    keywords: 'MarketOrder 挂单 订单 order buy sell 市场 amount totalAmount price',
    blocks: [
      {
        kind: 'prose',
        text: '`Game.market.orders` 中只包含**本公司**的活跃挂单；要扫全市场，用 `Game.market.getAllOrders(filter)` 按站点、物品、方向筛选。',
      },
      {
        kind: 'fields',
        rows: [
          { name: 'id', type: 'string', desc: '订单 id。' },
          { name: 'created', type: 'number', desc: '创建时的 tick。' },
          { name: 'type', type: "'buy' | 'sell'", desc: '买还是卖。' },
          { name: 'resourceType', type: 'string', desc: '物品 id。' },
          { name: 'stationId', type: 'string', desc: '所在站点 id。' },
          { name: 'price', type: 'number', desc: '挂单价格。' },
          { name: 'amount', type: 'number', desc: '**剩余**数量，成交会变少。' },
          { name: 'totalAmount', type: 'number', desc: '下单时的总量。' },
          { name: 'ownerId', type: 'string', desc: '所属公司的 id。' },
        ],
      },
      {
        kind: 'note',
        level: 'info',
        text: '`amount` 是"还剩多少"，`totalAmount` 才是最初挂的量；算成交进度用 `1 - amount / totalAmount`。',
      },
      {
        kind: 'note',
        level: 'warn',
        text: '本公司全星系活跃挂单上限 64 条，到顶后 `createOrder` 返回 `ERR_FULL`（见 quotas）。',
      },
      {
        kind: 'links',
        items: [
          { label: 'MarketQuote', id: 'MarketQuote' },
          { label: 'quotas', id: 'quotas' },
        ],
      },
    ],
  },
  {
    id: 'MarketQuote',
    title: 'MarketQuote',
    group: '实体',
    kind: '类型',
    summary: '某个站点、某种物品的行情快照：买一卖一、最新价、两条均线和近期成交量。',
    keywords: 'MarketQuote 行情 报价 quote 买一 卖一 bestBid bestAsk ema fast slow vol50t 成交量',
    blocks: [
      {
        kind: 'prose',
        text: '用 `Game.market.quote(stationId, resourceType)` 拿到的一条行情快照。',
      },
      {
        kind: 'fields',
        rows: [
          { name: 'stationId', type: 'string', desc: '站点 id。' },
          { name: 'resourceType', type: 'string', desc: '物品 id。' },
          { name: 'bestBid', type: 'number | null', desc: '最高买价；null 表示买单侧没有挂单。' },
          { name: 'bestAsk', type: 'number | null', desc: '最低卖价；null 表示卖单侧没有挂单。' },
          { name: 'lastPrice', type: 'number', desc: '最近成交价。' },
          { name: 'emaFast', type: 'number', desc: '快指数均线。' },
          { name: 'emaSlow', type: 'number', desc: '慢指数均线。' },
          { name: 'vol50t', type: 'number', desc: '近 50 tick 的成交量，用来判断流动性。' },
        ],
      },
      {
        kind: 'note',
        level: 'info',
        text: '`bestBid` / `bestAsk` 为 `null` 表示那一侧**没有挂单**，不是 0；算价差前先两边都判非空。',
      },
      {
        kind: 'note',
        level: 'info',
        text: '`emaFast` 上穿 `emaSlow` 常拿来当上涨信号；`vol50t` 太小说明盘口薄，别下大单砸自己。',
      },
      {
        kind: 'links',
        items: [
          { label: 'MarketOrder', id: 'MarketOrder' },
          { label: 'RecipeInfo', id: 'RecipeInfo' },
        ],
      },
    ],
  },
  {
    id: 'RouteCost',
    title: 'RouteCost',
    group: '实体',
    kind: '类型',
    summary: '一条航线的成本估算：要走几 tick、烧多少燃料。',
    keywords: 'RouteCost 航线 航程 calcRoute 航耗 fuel ticks 燃料',
    blocks: [
      {
        kind: 'prose',
        text: '由 `Game.market.calcRoute(fromId, toId)` 返回。派船前先用它估成本，再决定这条线划不划算。',
      },
      {
        kind: 'fields',
        rows: [
          { name: 'ticks', type: 'number', desc: '航程 tick 数。' },
          { name: 'fuel', type: 'number', desc: '燃料消耗。' },
        ],
      },
      {
        kind: 'note',
        level: 'warn',
        text: '没有可行航线时 `calcRoute` 返回 `null`（不抛错）——这也正是 `dispatch` 返回 `ERR_NO_PATH` 的来源。',
      },
      {
        kind: 'links',
        items: [
          { label: 'Ship', id: 'Ship' },
        ],
      },
    ],
  },
];

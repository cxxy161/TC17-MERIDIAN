import type { DocEntry } from '../types';

export const CONSTANT_ENTRIES: DocEntry[] = [
  {
    id: 'constants/return-codes',
    title: '返回码一览',
    group: '常量与返回码',
    kind: '常量',
    summary: '所有写操作方法的同步返回码常量（OK 与 ERR_*）及触发矩阵',
    keywords: 'OK ERR_NOT_OWNER ERR_NO_PATH ERR_BUSY ERR_NOT_FOUND ERR_NOT_ENOUGH_RESOURCES ERR_INVALID_TARGET ERR_FULL ERR_NOT_IN_RANGE ERR_INVALID_ARGS ERR_NOT_ENOUGH_CREDITS RetCode 错误码 返回码',
    blocks: [
      {
        kind: 'prose',
        text: '所有写方法同步返回 `RetCode`（底层为整数：`0` 表示 `OK`，负数表示错误码）。返回 `OK` 仅表示请求成功进入本 tick 队列，实际物理执行仍需经过落账阶段复核。',
      },
      {
        kind: 'syntax',
        code: `type RetCode = number;

const OK = 0;
const ERR_NOT_OWNER = -1;
const ERR_NO_PATH = -2;
const ERR_BUSY = -4;
const ERR_NOT_FOUND = -5;
const ERR_NOT_ENOUGH_RESOURCES = -6;
const ERR_INVALID_TARGET = -7;
const ERR_FULL = -8;
const ERR_NOT_IN_RANGE = -9;
const ERR_INVALID_ARGS = -10;
const ERR_NOT_ENOUGH_CREDITS = -14;`,
      },
      {
        kind: 'table',
        title: '返回码常量定义',
        headers: ['常量', '数值', '含义与典型触发原因'],
        rows: [
          ['`OK`', '`0`', '写操作请求已被沙盒受理并写入本 tick 队列（不代表落账一定成功）'],
          ['`ERR_NOT_OWNER`', '`-1`', '目标建筑、飞船或地块不属于本公司'],
          ['`ERR_NO_PATH`', '`-2`', '出发地到目的地之间没有可行航线（包含起点与终点相同的情况）'],
          ['`ERR_BUSY`', '`-4`', '飞船正在航行中（`isBusy === true`），到达前无法再次派船或维修'],
          ['`ERR_NOT_FOUND`', '`-5`', '目标行星、地块格点、挂牌、配方或订单不存在（或不在自己的挂单列表中）'],
          ['`ERR_NOT_ENOUGH_RESOURCES`', '`-6`', '派船时出发地仓库的燃料数量不足'],
          ['`ERR_INVALID_TARGET`', '`-7`', '目标类型不匹配或不可操作：如配方不属于该建筑、建筑类型不存在、站点/物品无效、地块非未开发空地'],
          ['`ERR_FULL`', '`-8`', '本 tick 已用满 32 条写操作配额、活跃挂单已达 64 条上限，或飞船装货总量超过货舱容量'],
          ['`ERR_NOT_IN_RANGE`', '`-9`', '`ship.dispatch` 的 `from` 参数与飞船当前 `location` 不一致'],
          ['`ERR_INVALID_ARGS`', '`-10`', '参数缺失、类型错误、数值非正数或 ID 格式无法解析'],
          ['`ERR_NOT_ENOUGH_CREDITS`', '`-14`', '挂买单时开盘现金不足 `price * totalAmount`'],
        ],
      },
      {
        kind: 'table',
        title: '方法 × 返回码速查矩阵',
        headers: ['方法', '可能返回的错误码', '同步校验要点'],
        rows: [
          ['`Game.buyPlot`', '`ERR_INVALID_ARGS` / `ERR_NOT_FOUND` / `ERR_INVALID_TARGET` / `ERR_FULL`', '校验行星、`slotId` / `listingId` 存在且空地处于 `unclaimed` 状态'],
          ['`Game.buildFacility`', '`ERR_INVALID_ARGS` / `ERR_NOT_OWNER` / `ERR_INVALID_TARGET` / `ERR_FULL`', '校验地块归属与建筑类型存在（建材与施工费在落账校验）'],
          ['`Game.demolishFacility`', '`ERR_INVALID_ARGS` / `ERR_NOT_OWNER` / `ERR_FULL`', '同步仅校验地块归属；建筑是否在该地块上于落账阶段校验'],
          ['`Game.bank`', '`ERR_INVALID_ARGS` / `ERR_FULL`', '校验行星存在、`op` 合法且金额 `> 0`（是否母星及额度在落账校验）'],
          ['`Game.market.createOrder`', '`ERR_INVALID_ARGS` / `ERR_INVALID_TARGET` / `ERR_NOT_ENOUGH_CREDITS` / `ERR_FULL`', '校验方向/价格/数量、站点与物品存在、挂单数及买单现金'],
          ['`Game.market.cancelOrder`', '`ERR_INVALID_ARGS` / `ERR_NOT_FOUND` / `ERR_FULL`', '校验订单 ID 为合法数字且属于本公司活跃挂单'],
          ['`Game.market.deal`', '`ERR_INVALID_ARGS` / `ERR_NOT_FOUND` / `ERR_FULL`', '校验数量为正整数且目标订单在全站订单簿中存在'],
          ['`Building.setRecipe`', '`ERR_INVALID_ARGS` / `ERR_NOT_OWNER` / `ERR_NOT_FOUND` / `ERR_INVALID_TARGET` / `ERR_FULL`', '校验建筑归属、配方存在且 `recipe.buildingId === building.type`'],
          ['`Building.setActive`', '`ERR_INVALID_ARGS` / `ERR_NOT_OWNER` / `ERR_FULL`', '校验 `active` 为布尔值且建筑属于本公司'],
          ['`Ship.dispatch`', '`ERR_INVALID_ARGS` / `ERR_NOT_OWNER` / `ERR_BUSY` / `ERR_NOT_IN_RANGE` / `ERR_NO_PATH` / `ERR_FULL` / `ERR_NOT_ENOUGH_RESOURCES`', '校验船况、位置、航线、货物、载重与出发地燃料（待运货物库存于落账校验）'],
          ['`Ship.repair`', '`ERR_INVALID_ARGS` / `ERR_NOT_OWNER` / `ERR_BUSY` / `ERR_FULL`', '校验飞船归属与空闲状态（耐久上限与维修品库存于落账校验）'],
        ],
      },
      {
        kind: 'links',
        items: [
          { label: '执行与落账机制', id: 'guides/execution' },
          { label: '配额与限制', id: 'guides/limits' },
          { label: '核心经济规则', id: 'guides/economy' },
        ],
      },
    ],
  },
  {
    id: 'constants/order-sides',
    title: 'ORDER_BUY / ORDER_SELL',
    group: '常量与返回码',
    kind: '常量',
    summary: '市场挂单与筛选的方向常量（"buy" 与 "sell"）',
    keywords: 'ORDER_BUY ORDER_SELL buy sell 买单 卖单 方向',
    blocks: [
      {
        kind: 'prose',
        text: '表示市场买卖方向的两个冻结字符串常量，用于 `Game.market.createOrder` 的 `params.type` 以及 `Game.market.getAllOrders` 的 `filter.type`。',
      },
      {
        kind: 'syntax',
        code: `const ORDER_BUY: 'buy' = 'buy';
const ORDER_SELL: 'sell' = 'sell';`,
      },
      {
        kind: 'example',
        caption: '使用方向常量查询卖单并挂买单',
        code: `module.exports.loop = function () {
  const asks = Game.market.getAllOrders({
    stationId: 'ST:HUB',
    resourceType: RESOURCE_STEEL,
    type: ORDER_SELL,
  });
  console.log('Hub 钢材卖单数:', asks.length);

  Game.market.createOrder({
    type: ORDER_BUY,
    resourceType: RESOURCE_STEEL,
    price: 12.5,
    totalAmount: 10,
    stationId: 'ST:HUB',
  });
};`,
      },
      {
        kind: 'links',
        items: [
          { label: 'Game.market.createOrder', id: 'Game.market.createOrder' },
          { label: 'Game.market.getAllOrders', id: 'Game.market.getAllOrders' },
        ],
      },
    ],
  },
  {
    id: 'RESOURCES_ALL',
    title: 'RESOURCES_ALL',
    group: '常量与返回码',
    kind: '常量',
    summary: '当前世界全部物品 ID 的有序只读数组',
    keywords: 'RESOURCES_ALL 物品 列表 全部 遍历',
    blocks: [
      {
        kind: 'prose',
        text: '包含当前世界所有物品 ID 的已排序、已冻结字符串数组。适合用于遍历全物品行情或检查某个字符串是否为合法物品 ID。',
      },
      {
        kind: 'syntax',
        code: 'const RESOURCES_ALL: readonly string[]',
      },
      {
        kind: 'note',
        level: 'info',
        text: '该数组已被 `Object.freeze` 冻结，调用 `push` 等修改操作不会生效。不同世界配置下物品集合可能不同，脚本中建议动态遍历 `RESOURCES_ALL`。',
      },
      {
        kind: 'example',
        caption: '扫描枢纽站全部物品的卖一价',
        code: `module.exports.loop = function () {
  for (const item of RESOURCES_ALL) {
    const q = Game.market.quote('ST:HUB', item);
    if (q && q.bestAsk !== null) {
      console.log(item, '卖一:', q.bestAsk);
    }
  }
};`,
      },
      {
        kind: 'links',
        items: [
          { label: 'RESOURCE_<ID>', id: 'RESOURCE_<ID>' },
          { label: 'Game.market.quote', id: 'Game.market.quote' },
        ],
      },
    ],
  },
  {
    id: 'RESOURCE_<ID>',
    title: 'RESOURCE_<ID>',
    group: '常量与返回码',
    kind: '常量',
    summary: '为每个物品注入的大写全局常量，值为对应的物品 ID 字符串',
    keywords: 'RESOURCE_ 物品常量 RESOURCE_STEEL RESOURCE_FUEL 标识符',
    blocks: [
      {
        kind: 'prose',
        text: '沙盒会在全局命名空间为每种物品注入 `RESOURCE_<ID 大写>` 常量，值为该物品的小写 ID 字符串。当前世界已注册的所有物品常量会在本页下方动态列出，点击即可复制。',
      },
      {
        kind: 'syntax',
        code: `const RESOURCE_STEEL: 'steel' = 'steel';
const RESOURCE_BUILDING_MAT: 'building_mat' = 'building_mat';
// ... 其余物品依当前世界配置动态注入`,
      },
      {
        kind: 'note',
        level: 'warn',
        text: '常量名直接由物品 ID 转大写拼接而成；若自定义世界中的物品 ID 包含 `-` 或 `.`（非合法 JS 标识符），需通过 `globalThis[\'RESOURCE_...\']` 读取或直接使用字符串 ID。',
      },
      {
        kind: 'example',
        caption: '使用物品常量查询行情',
        code: `module.exports.loop = function () {
  const q = Game.market.quote('ST:HUB', RESOURCE_STEEL);
  if (q) {
    console.log('钢材最新价:', q.lastPrice);
  }
};`,
      },
      {
        kind: 'links',
        items: [
          { label: 'RESOURCES_ALL', id: 'RESOURCES_ALL' },
          { label: '默认世界建筑与配方', id: 'constants/world-catalog' },
        ],
      },
    ],
  },
  {
    id: 'constants/world-catalog',
    title: '默认世界建筑与配方',
    group: '常量与返回码',
    kind: '常量',
    summary: '默认起步世界中的建筑类型 ID、建造消耗与全部配方 ID 速查表',
    keywords: '建筑类型 配方 ID mine_smelter power_water_station steel_carbon 建造 周期 耗材',
    blocks: [
      {
        kind: 'prose',
        text: '供脚本直接引用的默认世界建筑类型 ID 与配方 ID 速查表。自定义生产包世界请以游戏内「工厂产线」或「物品详情」面板显示的 ID 为准。',
      },
      {
        kind: 'table',
        title: '建筑类型一览（用于 Game.buildFacility）',
        headers: ['建筑 ID', '名称 / 耗时', '建造成本（另加 80 × cpi 现金）'],
        rows: [
          ['`power_water_station`', '能源水站（6 tick）', '6 × `building_mat`；待机耗电 `0`'],
          ['`recycling_plant`', '生态回收中心（8 tick）', '8 × `building_mat`；待机耗电 `1`'],
          ['`bio_greenhouse`', '生态温室（6 tick）', '6 × `building_mat`；待机耗电 `1`'],
          ['`consumer_workshop`', '生活消费工坊（8 tick）', '8 × `building_mat`；待机耗电 `1`'],
          ['`mine_smelter`', '矿业冶炼厂（8 tick）', '8 × `building_mat`；待机耗电 `1`'],
          ['`infra_factory`', '结构与日用厂（8 tick）', '8 × `building_mat`；待机耗电 `1`'],
          ['`shipyard`', '轨道船坞（12 tick）', '14 × `building_mat`；待机耗电 `2`'],
        ],
      },
      {
        kind: 'table',
        title: '配方一览（用于 building.setRecipe 与 Game.getRecipe）',
        headers: ['配方 ID', '所属建筑（周期 / 电 / 工资）', '输入 → 输出'],
        rows: [
          ['`solar_power`', '`power_water_station`（2t / 0电 / 4.0）', '无原料 → 12 `power`'],
          ['`fuel_power`', '`power_water_station`（2t / 0电 / 4.0）', '1 `fuel` → 28 `power`'],
          ['`extract_water`', '`power_water_station`（2t / 2电 / 4.0）', '无原料 → 10 `water`'],
          ['`split_oxygen`', '`power_water_station`（2t / 4电 / 4.0）', '4 `water` → 10 `oxygen`'],
          ['`synth_fuel`', '`power_water_station`（3t / 4电 / 6.0）', '4 `water` + 1 `bio_fiber` → 6 `fuel`'],
          ['`synth_fuel_elec`', '`power_water_station`（3t / 8电 / 6.0）', '5 `water` → 6 `fuel`'],
          ['`recycle_waste`', '`recycling_plant`（3t / 3电 / 6.0）', '8 `waste` → 6 `disposal_cert` + 3 `water` + 1 `bio_fiber` + 1 `ore`'],
          ['`grow_crop`', '`bio_greenhouse`（3t / 2电 / 6.0）', '4 `water` → 8 `bio_crop`'],
          ['`crack_bio_fiber`', '`bio_greenhouse`（3t / 2电 / 4.0）', '5 `bio_crop` → 6 `bio_fiber`'],
          ['`make_rations`', '`consumer_workshop`（3t / 2电 / 5.0）', '4 `bio_crop` + 3 `water` → 10 `rations`'],
          ['`brew_beverage`', '`consumer_workshop`（4t / 3电 / 8.0）', '4 `bio_crop` + 6 `water` + 1 `steel` → 8 `beverage`'],
          ['`sew_clothing`', '`consumer_workshop`（4t / 3电 / 10.0）', '5 `bio_fiber` + 2 `water` + 1 `daily_goods` → 6 `clothing`'],
          ['`mine_ore`', '`mine_smelter`（2t / 3电 / 6.0）', '无原料 → 10 `ore`'],
          ['`steel_carbon`', '`mine_smelter`（4t / 3电 / 8.0）', '6 `ore` + 3 `bio_fiber` → 6 `steel`'],
          ['`steel_electric`', '`mine_smelter`（4t / 16电 / 8.0）', '6 `ore` → 6 `steel`'],
          ['`cast_building_mat`', '`infra_factory`（4t / 3电 / 8.0）', '5 `ore` + 3 `steel` → 8 `building_mat`'],
          ['`craft_daily_goods`', '`infra_factory`（4t / 3电 / 10.0）', '3 `steel` + 2 `bio_fiber` → 6 `daily_goods`'],
          ['`build_ship_small`', '`shipyard`（10t / 12电 / 30.0）', '12 `steel` + 8 `building_mat` + 6 `daily_goods` → 1 `ship_small`'],
        ],
      },
      {
        kind: 'links',
        items: [
          { label: 'Game.buildFacility', id: 'Game.buildFacility' },
          { label: 'Game.getRecipe', id: 'Game.getRecipe' },
          { label: 'Building.setRecipe', id: 'Building.setRecipe' },
          { label: 'RecipeInfo', id: 'RecipeInfo' },
        ],
      },
    ],
  },
];

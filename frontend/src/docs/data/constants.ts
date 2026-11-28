import type { DocEntry } from '../types';

export const CONSTANT_ENTRIES: DocEntry[] = [
  {
    id: 'constants/return-codes',
    title: '返回码一览',
    group: '常量与返回码',
    kind: '常量',
    summary: 'API v2 同步影账错误码、异步落账回执机制与全方法返回码速查矩阵',
    keywords: 'OK ERR_NOT_OWNER ERR_NO_PATH ERR_BUSY ERR_NOT_FOUND ERR_NOT_ENOUGH_RESOURCES ERR_INVALID_TARGET ERR_FULL ERR_NOT_IN_RANGE ERR_INVALID_ARGS ERR_NOT_ENOUGH_CREDITS RetCode 错误码 返回码 影账 lastTick rejected',
    blocks: [
      {
        kind: 'prose',
        text: '所有写方法均同步返回 `RetCode` 整数状态码：`OK`（`0`）表示写请求已通过本 tick **同步预校验与影账预扣**并成功入队；负数 `ERR_*` 表示请求当场被拒绝，不会占用本 tick 的 `32` 条写操作配额，也不会产生任何副作用。',
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
        kind: 'note',
        level: 'info',
        title: '影账与异步落账回执分工',
        text: '写方法会在本 tick 内部实时维护一份**影子账本**：连续下多笔买单、连续派船或同地块连建时，余额、库存、地块槽位与活跃挂单数都会即时扣减，并在超出时当场返回 `ERR_NOT_ENOUGH_CREDITS` / `ERR_NOT_ENOUGH_RESOURCES` / `ERR_FULL`。只有多公司并发争抢同一挂单/土地或本 tick 银行借贷利息变化等跨公司竞态，才会在落账阶段被拒，并自动写入下一 tick 的 `Game.lastTick.rejected` 与控制台警告。',
      },
      {
        kind: 'table',
        title: '返回码常量定义与触发边界',
        headers: ['常量', '数值', '同步阶段拦截条件（即时返回）', '落账阶段触发场景（Game.lastTick.rejected）'],
        rows: [
          [
            '`OK`',
            '`0`',
            '参数合法、资源/额度预扣成功并入队',
            '仅在全部复核通过后真实落地；否则记录到 `Game.lastTick.rejected`',
          ],
          [
            '`ERR_NOT_OWNER`',
            '`-1`',
            '目标地块、建筑或飞船不在本公司资产列表中',
            '跨系统状态竞争导致所有权变更（如地块在同 tick 被抵押清算）',
          ],
          [
            '`ERR_NO_PATH`',
            '`-2`',
            '`ship.dispatch(to, cargo)` 的当前位置 `ship.location` 与 `to` 之间无可达航线（含起终点相同）',
            '星际航线拓扑校验失败',
          ],
          [
            '`ERR_BUSY`',
            '`-4`',
            '飞船已处于航行中（`ship.isBusy === true`）或本 tick 已被同一脚本派船',
            '同 tick 并发控制冲突导致飞船进入占用状态',
          ],
          [
            '`ERR_NOT_FOUND`',
            '`-5`',
            '行星、空地 `slotId`、挂牌 `listingId`、订单 `orderId` 或配方不存在；同 tick 已撤单/已买走/已拆除',
            '并发对手单已被其他玩家吃光、挂牌地已被抢购或建筑/订单已不存在',
          ],
          [
            '`ERR_NOT_ENOUGH_RESOURCES`',
            '`-6`',
            '卖单库存不足、建厂所需地面建材不足、派船装货或燃料不足、修船维修件不足（均计入本 tick 影账已预扣部分）',
            '跨操作消耗叠加导致结算时真实地面或站点可用库存不足',
          ],
          [
            '`ERR_INVALID_TARGET`',
            '`-7`',
            '目标对象不合法：购买自有二手地/非空地、对自有单 `deal`、出价劣于对手最优价（违背价格优先）、买单托管余额不足、禁止自成交（同站同品正反挂单交叉）、非母星调用央行、配方禁用或建筑类型不匹配、飞船已满耐久维修',
            '价格保护/托管额度在落账前变动、对手挂牌中途撤回、逾期借贷锁定等',
          ],
          [
            '`ERR_FULL`',
            '`-8`',
            '本 tick 脚本写操作已达 `32` 条上限；全星系活跃挂单已达 `64` 条上限；地块空闲槽位不足；飞船混装总件数超过 `ship.capacity`',
            '并发挂单或槽位在落账顺序中被前序结算占满',
          ],
          [
            '`ERR_NOT_IN_RANGE`',
            '`-9`',
            '保留兼容错误码：当前所有核心实体操作均通过实体位置与星图航线自动校验',
            '超出作用范围限制',
          ],
          [
            '`ERR_INVALID_ARGS`',
            '`-10`',
            '参数类型错误、缺失必填字段、数值 `<= 0` 或非有限数、`totalAmount > 10000`、挂单价格超出 `min(refPrice * 100, 1_000_000)` 价格带或精确值舍入后非正数',
            '订单名义金额溢出 `i64` 安全上限或结算价格带动态收窄',
          ],
          [
            '`ERR_NOT_ENOUGH_CREDITS`',
            '`-14`',
            '下买单、吃卖单、买地、建厂现金施工费（`80 × Game.cpi`）、银行存款/取款（可用储蓄不足）或还款可用现金不足，或贷款逾期期间买地',
            '多公司并发或扣费顺序导致落账时现金/储蓄/央行可贷额度不足',
          ],
        ],
      },
      {
        kind: 'table',
        title: 'API v2 全写方法 × 返回码速查矩阵',
        headers: ['方法', '可能同步返回的错误码', '同步校验与影账规则要点'],
        rows: [
          [
            '`Game.map.buyPlot`',
            '`ERR_INVALID_ARGS` / `ERR_NOT_FOUND` / `ERR_INVALID_TARGET` / `ERR_NOT_ENOUGH_CREDITS` / `ERR_FULL`',
            '校验行星与未认领 `slotId`，检查未逾期与一手地价并从影账预扣现金',
          ],
          [
            '`Plot.build`',
            '`ERR_INVALID_ARGS` / `ERR_NOT_OWNER` / `ERR_INVALID_TARGET` / `ERR_FULL` / `ERR_NOT_ENOUGH_CREDITS` / `ERR_NOT_ENOUGH_RESOURCES`',
            '按建筑 `slots_used`、地面 `buildCost` 与 `80 × cpi` 现金同步预扣',
          ],
          [
            '`Building.setRecipe`',
            '`ERR_INVALID_ARGS` / `ERR_NOT_OWNER` / `ERR_NOT_FOUND` / `ERR_INVALID_TARGET` / `ERR_FULL`',
            '校验未在本 tick 被拆除、配方存在启用且属于该建筑类型',
          ],
          [
            '`Building.setActive`',
            '`ERR_INVALID_ARGS` / `ERR_NOT_OWNER` / `ERR_NOT_FOUND` / `ERR_FULL`',
            '校验布尔值及建筑在本 tick 未被拆除',
          ],
          [
            '`Building.demolish`',
            '`ERR_INVALID_ARGS` / `ERR_NOT_OWNER` / `ERR_NOT_FOUND` / `ERR_FULL`',
            '校验建筑与地块归属，并在影账标记已拆以防同 tick 重复指令',
          ],
          [
            '`Ship.dispatch`',
            '`ERR_INVALID_ARGS` / `ERR_NOT_OWNER` / `ERR_BUSY` / `ERR_NO_PATH` / `ERR_FULL` / `ERR_NOT_ENOUGH_RESOURCES`',
            '自动以 `ship.location` 为起点校验航线、货舱余量及出发地货物 + 燃料影账',
          ],
          [
            '`Ship.repair`',
            '`ERR_INVALID_ARGS` / `ERR_NOT_OWNER` / `ERR_BUSY` / `ERR_INVALID_TARGET` / `ERR_NOT_ENOUGH_RESOURCES` / `ERR_FULL`',
            '校验空闲且有损伤、当前所在地具备维修件并预扣 `daily_goods`',
          ],
          [
            '`Game.market.createOrder`',
            '`ERR_INVALID_ARGS` / `ERR_INVALID_TARGET` / `ERR_FULL` / `ERR_NOT_ENOUGH_CREDITS` / `ERR_NOT_ENOUGH_RESOURCES`',
            '校验 10000 上限与价格带、禁止同站交叉自成交、预扣买单现金或卖单库存',
          ],
          [
            '`Game.market.cancelOrder`',
            '`ERR_INVALID_ARGS` / `ERR_NOT_FOUND` / `ERR_FULL`',
            '校验 `orderId` 为本公司活跃单且本 tick 未重复撤单',
          ],
          [
            '`Game.market.deal`',
            '`ERR_INVALID_ARGS` / `ERR_NOT_FOUND` / `ERR_INVALID_TARGET` / `ERR_NOT_ENOUGH_CREDITS` / `ERR_NOT_ENOUGH_RESOURCES` / `ERR_FULL`',
            '校验价格优先、非自有单、价格带与对手剩余量，同步预扣买家现金或卖家货品',
          ],
          [
            '`Game.market.buyLand`',
            '`ERR_INVALID_ARGS` / `ERR_NOT_FOUND` / `ERR_INVALID_TARGET` / `ERR_NOT_ENOUGH_CREDITS` / `ERR_FULL`',
            '校验挂牌存在、非本公司挂牌、未逾期并预扣挂牌要价',
          ],
          [
            '`Game.bank.*`',
            '`ERR_INVALID_ARGS` / `ERR_NOT_FOUND` / `ERR_INVALID_TARGET` / `ERR_NOT_ENOUGH_CREDITS` / `ERR_FULL`',
            '校验在母星操作、金额为正及本 tick 存取借还影账额度',
          ],
        ],
      },
      {
        kind: 'example',
        caption: '标准错误处理与上回合拒绝回执排查',
        code: `module.exports.loop = function () {
  // 1. 优先排查上一 tick 落账阶段被竞态拒绝的请求
  for (const rej of Game.lastTick.rejected) {
    console.warn('[上回合落账拒绝]', rej.action, rej.target, 'code=', rej.code, rej.reason);
  }

  // 2. 同步调用写方法时根据返回码分支决策
  const ship = Object.values(Game.ships).find((s) => !s.isBusy);
  if (!ship) return;

  const rc = ship.dispatch('ST:HUB', { [RESOURCE_STEEL]: 10 });
  if (rc === ERR_NOT_ENOUGH_RESOURCES) {
    console.warn('飞船出发地钢材或燃料不足:', ship.id, ship.location);
  } else if (rc === ERR_FULL) {
    console.warn('货舱空间不足或本 tick 写配额已满');
  } else if (rc !== OK) {
    console.error('派船异常:', ship.id, 'rc=', rc);
  }
};`,
      },
      {
        kind: 'links',
        items: [
          { label: '执行与落账机制', id: 'guides/execution' },
          { label: 'Game.lastTick', id: 'Game.lastTick' },
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
        text: '表示市场买卖方向的两个全局冻结字符串常量，用于 `Game.market.createOrder` 的 `params.type` 以及 `Game.market.getAllOrders` 的 `filter.type`。',
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
    limit: 50,
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
    id: 'constants/money-scale',
    title: 'MONEY_SCALE',
    group: '常量与返回码',
    kind: '常量',
    summary: '账本固定点精度缩放因子（10000，对应最小计价单位 0.0001 信用点）',
    keywords: 'MONEY_SCALE 精度 固定点 金额 四位小数 0.0001',
    blocks: [
      {
        kind: 'prose',
        text: '底层经济账本以 `1 / MONEY_SCALE`（即 `0.0001` 信用点）为最小会计精度单位。脚本传入的价格与金额在落账前会按此精度四舍五入；使用 `Math.round(price * MONEY_SCALE) / MONEY_SCALE` 可对齐最小跳价单位，避免极小正数被舍入为 `0` 后触发 `ERR_INVALID_ARGS`。',
      },
      {
        kind: 'syntax',
        code: 'const MONEY_SCALE: 10000 = 10000;',
      },
      {
        kind: 'example',
        caption: '按固定点精度对齐挂单报价',
        code: `module.exports.loop = function () {
  const rawPrice = 12.34567;
  const tickAligned = Math.round(rawPrice * MONEY_SCALE) / MONEY_SCALE;
  console.log('最小单位:', 1 / MONEY_SCALE, '对齐价格:', tickAligned);
};`,
      },
      {
        kind: 'links',
        items: [
          { label: '返回码一览', id: 'constants/return-codes' },
          { label: 'Game.market.createOrder', id: 'Game.market.createOrder' },
          { label: '核心经济规则', id: 'guides/economy' },
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
        text: '包含当前世界所有物品 ID 的已排序、已冻结字符串数组。适合用于遍历全物品行情或配合 `Game.catalog.items` 构建动态产线与采购策略。',
      },
      {
        kind: 'syntax',
        code: 'const RESOURCES_ALL: readonly string[]',
      },
      {
        kind: 'note',
        level: 'info',
        text: '该数组已被 `Object.freeze` 冻结，调用 `push` 等修改操作不会生效。建议脚本优先遍历 `RESOURCES_ALL` 而非硬编码完整物品表。',
      },
      {
        kind: 'example',
        caption: '扫描枢纽站全部物品的卖一价',
        code: `module.exports.loop = function () {
  for (const item of RESOURCES_ALL) {
    const q = Game.market.quote('ST:HUB', item);
    if (q && q.bestAsk !== null) {
      console.log(item, Game.catalog.items[item].name, '卖一:', q.bestAsk);
    }
  }
};`,
      },
      {
        kind: 'links',
        items: [
          { label: 'RESOURCE_<ID>', id: 'RESOURCE_<ID>' },
          { label: 'Game.catalog', id: 'Game.catalog' },
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
    summary: '默认世界建筑类型、建造成本与配方速查表（页面底部附实时加载的当前世界配置）',
    keywords: '建筑类型 配方 ID mine_smelter power_water_station steel_carbon 建造 周期 耗材 catalog',
    blocks: [
      {
        kind: 'prose',
        text: '下表为默认起步世界的建筑与配方速查；脚本运行时建议直接读取 `Game.catalog` 获取当前世界权威定义。页面打开网络目录数据时，下方还会同步展示实时加载的建筑与配方点击复制卡片。',
      },
      {
        kind: 'table',
        title: '建筑类型一览（用于 plot.build）',
        headers: ['建筑 ID', '名称 / 耗时', '建造成本（另加 80 × Game.cpi 信用点）'],
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
        title: '配方一览（用于 building.setRecipe 与 Game.catalog.recipes）',
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
          ['`build_ship_medium`', '`shipyard`（18t / 24电 / 65.0）', '36 `steel` + 22 `building_mat` + 18 `daily_goods` → 1 `ship_medium`'],
          ['`build_ship_large`', '`shipyard`（28t / 42电 / 140.0）', '100 `steel` + 60 `building_mat` + 50 `daily_goods` → 1 `ship_large`'],
        ],
      },
      {
        kind: 'links',
        items: [
          { label: 'Plot.build', id: 'Plot.build' },
          { label: 'Game.catalog', id: 'Game.catalog' },
          { label: 'Building.setRecipe', id: 'Building.setRecipe' },
        ],
      },
    ],
  },
];

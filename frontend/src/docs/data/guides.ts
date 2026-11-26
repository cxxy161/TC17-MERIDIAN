import type { DocEntry } from '../types';

export const GUIDE_ENTRIES: DocEntry[] = [
  {
    id: 'guides/overview',
    title: 'API 总览',
    group: '上手指南',
    kind: '指南',
    summary: 'Meridian 玩家脚本 API v2 模块架构、领域划分与快速导航索引',
    keywords: '总览 首页 目录 API v2 架构 Game map market bank catalog lastTick',
    blocks: [
      {
        kind: 'prose',
        text: 'Meridian 玩家脚本运行在每个 tick 启动时冻结的只读世界快照之上。API v2 按**只读实体图谱 + 职能域命名空间**重新组织：所有生产建拆直接通过 `Plot.build()`、`Building.setRecipe()`、`Building.demolish()`、`Ship.dispatch(to, cargo)` 等实体方法发起；全局业务按职责划分为 `Game.map`（星图/航线/一手购地/公开情报）、`Game.market`（交易所/二级土地）与 `Game.bank`（母星央行）；所有写操作在本 tick 通过影子账本实时预校验，任何跨公司竞态拒绝都会在下一 tick 的 `Game.lastTick.rejected` 精确回执。',
      },
      {
        kind: 'note',
        level: 'info',
        title: 'API v2 核心改进',
        text: '派船直接调用 `ship.dispatch(to, cargo)` 自动以 `ship.location` 为起点；`Game.sites` 公开全量在建工地；`Game.catalog` 在初始化时一次性加载全部物品/建筑/配方定义；控制台内置沙盒 REPL，可直接求值 `Game` / `Memory` 并提交临时手动操作而不挤占脚本的 32 条配额。',
      },
    ],
  },
  {
    id: 'guides/quickstart',
    title: '快速开始',
    group: '上手指南',
    kind: '指南',
    summary: '脚本入口结构、热重载机制、多模块组织与控制台即时调试',
    keywords: '入门 开始 快速开始 第一个脚本 loop 热重载 require main console',
    blocks: [
      {
        kind: 'prose',
        text: '脚本在游戏内的「脚本编辑器」中编写，入口模块固定为 `main`，必须导出 `module.exports.loop` 函数。点击「保存热重载」后，引擎会从下一个 tick 起每个 tick 自动调用一次 `loop()`。需要拆分代码时，可在编辑器新建扁平模块并用 `require(\'模块名\')` 引入。',
      },
      {
        kind: 'syntax',
        code: 'module.exports.loop = function (): void',
      },
      {
        kind: 'example',
        caption: 'main.js —— API v2 最小可运行巡检脚本',
        code: `module.exports.loop = function () {
  for (const r of Game.lastTick.rejected) {
    console.warn('上回合被拒:', r.action, r.target, r.code, r.reason);
  }

  console.log('tick:', Game.time, '现金:', Game.company.cash, '在建工地:', Object.keys(Game.sites).length);

  // Memory 是唯一的跨 tick 持久化对象
  if (!Memory.startedAt) {
    Memory.startedAt = Game.time;
  }
};`,
      },
      {
        kind: 'note',
        level: 'info',
        title: '实时控制台 REPL',
        text: '游戏内「控制台」支持直接输入 JS 表达式或语句（如 `Game.company`、`Memory.open = null`、或临时调用 `ship.dispatch(...)`），会在真实沙盒环境中执行；通过控制台发起的写操作走独立的手动操作配额，不占用主脚本每 tick 32 条配额。',
      },
      {
        kind: 'links',
        items: [
          { label: '执行与落账机制', id: 'guides/execution' },
          { label: '配额与限制', id: 'guides/limits' },
          { label: 'Game.lastTick', id: 'Game.lastTick' },
          { label: 'Memory', id: 'Memory' },
          { label: 'require', id: 'require' },
        ],
      },
    ],
  },
  {
    id: 'guides/execution',
    title: '执行与落账机制',
    group: '上手指南',
    kind: '指南',
    summary: '只读快照、本 tick 影子账本预校验与下一 tick 落账回执闭环',
    keywords: '快照 只读 两阶段 执行 落账 影账 lastTick rejected fills 冻结',
    blocks: [
      {
        kind: 'prose',
        text: '每个 tick 的世界推进遵循**决策快照 + 确定性洗牌落账**模型：`loop()` 读取本 tick 开始时冻结的只读世界快照，调用写方法时不会立刻改写 `Game` 属性，而是先经过本 tick **影子账本**预校验与资源预扣后入队并返回 `RetCode`；随后世界内核按各公司随机洗牌后的顺序统一复核执行全部写操作，并将真实成交与极少数并发拒绝写回下一 tick 的 `Game.lastTick`。',
      },
      {
        kind: 'table',
        title: '单 tick 执行时序',
        headers: ['阶段', '执行内容', '对脚本可见性'],
        rows: [
          ['1. 物理推进', '推进行星公转、抵达飞船入库、完成工地建造、结算产线生产与城市消费', '生成本 tick 的 `Game` 只读快照及 `Game.lastTick` 回执'],
          ['2. 脚本决策', '调用 `module.exports.loop()`，沙盒影账即时追踪预扣额度并收集最多 32 条写操作', '读取的 `Game` 数值保持开盘快照；同 tick 多次写入会实时扣减影账防超发'],
          ['3. 洗牌落账', '按公司随机洗牌顺序统一扣款扣货、撮合市场成交、结算利息与仓租', '成功成交写入 `lastTick.fills`，被拒意图写入 `lastTick.rejected` 并在下 tick 控制台告警'],
        ],
      },
      {
        kind: 'note',
        level: 'warn',
        title: '影子账本只影响同 tick 返回码，不改写只读快照',
        text: '连续调用两次 `Game.market.createOrder` 时，第二次会自动扣减第一笔预留的资金/库存并在不足时直接返回 `ERR_NOT_ENOUGH_CREDITS` 或 `ERR_NOT_ENOUGH_RESOURCES`；但 `Game.company.cash` 与 `Store` 字段本身在本 tick 结束前仍保持开盘值不变，同时刚创建的挂单要到下一 tick 才会出现在 `Game.market.orders` 中。',
      },
      {
        kind: 'note',
        level: 'info',
        title: '告别静默失败：消费 Game.lastTick.rejected',
        text: '若因跨公司并发抢单、二手地中途成交或价格带变动导致已返回 `OK` 的写操作在落账阶段未生效，引擎不再沉默吞掉——系统会自动在控制台打印一条 `WARN` 日志，并将 `{ intentIndex, action, target, code, reason }` 列表注入下一 tick 的 `Game.lastTick.rejected` 供脚本程序化重试或切换目标。',
      },
      {
        kind: 'links',
        items: [
          { label: 'Game.lastTick', id: 'Game.lastTick' },
          { label: '返回码一览', id: 'constants/return-codes' },
          { label: '配额与限制', id: 'guides/limits' },
          { label: 'Memory', id: 'Memory' },
        ],
      },
    ],
  },
  {
    id: 'guides/limits',
    title: '配额与限制',
    group: '上手指南',
    kind: '指南',
    summary: 'CPU 耗时、内存、写操作数量、活跃挂单、Memory 体积与日志的硬性上限',
    keywords: '限制 配额 上限 10ms 4MB 32 64 128KB 200 超时 熔断 回滚',
    blocks: [
      {
        kind: 'prose',
        text: '沙盒对每家公司每个 tick 强制执行以下硬性资源上限。触发操作数或挂单上限会在调用点返回 `ERR_FULL`；触发 CPU、堆内存或 `Memory` 序列化上限会导致本 tick 脚本提交的写操作与 `Memory` 修改整体回滚。',
      },
      {
        kind: 'table',
        title: '资源与操作上限',
        headers: ['限制项', '上限值', '超出后的行为'],
        rows: [
          ['单 tick CPU 时间', '10 ms（默认，以 `Game.cpu.limit` 为准，仅计玩家代码执行）', '立即中断脚本并重置沙盒实例；本 tick 脚本写操作丢弃，`Memory` 回滚到上一 tick'],
          ['沙盒堆内存', '4 MB（单次调用栈 256 KB）', '触发内存溢出报错并重置沙盒；本 tick 写操作丢弃，`Memory` 回滚'],
          ['脚本单 tick 写操作', '32 条 / 公司', '第 33 条起返回 `ERR_FULL`。控制台 REPL 与页面手动指令使用独立缓冲，不占用此 32 条配额'],
          ['全星系活跃挂单', '64 条 / 公司', '计入本 tick 已新挂未落账单与待撤单后，超出返回 `ERR_FULL`'],
          ['`Memory` 体积', '128 KB（UTF-8）', 'tick 结束序列化超限时整份改动丢弃并报错，同时本 tick 全部写操作一并回滚'],
          ['`console` 日志', '200 行 / tick，1024 字节 / 行', '单行超长按 UTF-8 截断并追加 `...`；超过 200 行追加截断提示并丢弃后续日志'],
          ['盘口与挂单查询限制', '`depth` 最多 5 档；`getAllOrders` 单页默认 200、上限 1000', '超限自动截断至允许上限，防止单次快照序列化撑爆内存'],
        ],
      },
      {
        kind: 'note',
        level: 'warn',
        title: '留足 CPU 安全余量',
        text: '计时仅从运行玩家模块逻辑起算（不含底层快照组装），可通过 `Game.cpu.getUsed()` 实时监控。当耗时接近 `Game.cpu.limit` 时建议提前 `return` 放弃次要巡检，避免触发超时熔断。',
      },
      {
        kind: 'links',
        items: [
          { label: 'Game.cpu', id: 'Game.cpu' },
          { label: 'Memory', id: 'Memory' },
          { label: 'console', id: 'console' },
          { label: '执行与落账机制', id: 'guides/execution' },
        ],
      },
    ],
  },
  {
    id: 'guides/ids',
    title: 'ID 与坐标约定',
    group: '上手指南',
    kind: '指南',
    summary: '恒星系、行星、轨道站、枢纽站、物品与实体 ID 的统一字符串规范',
    keywords: 'id 标识 恒星系 行星 站点 枢纽 字符串 坐标 location stationId planetId',
    blocks: [
      {
        kind: 'prose',
        text: '脚本接口中的所有实体主键与路径 ID（恒星系、行星、空间站、地块、建筑、工地、飞船、挂牌与订单号）**全部为字符串**。唯一例外是行星表面公共网格编号 `slotId` 为数字。',
      },
      {
        kind: 'table',
        title: '常见 ID 格式一览',
        headers: ['实体类型', '格式示例', '说明'],
        rows: [
          ['恒星系（`systemId`）', '`\'S1\'`', '`Game.systems` 的键'],
          ['行星（`planetId`）', '`\'P1\'`、`\'P2\'`', '`Game.planets` 的键，也用作行星地面位置标识（与 `planet.stationId` 配套）'],
          ['空间站（`stationId`）', '`\'ST:P1\'`、`\'ST:P2\'`、`\'ST:HUB\'`', '前缀 `\'ST:\'` 对应轨道站；`\'ST:HUB\'` 为中心枢纽站，全集均在 `Game.stations`'],
          ['物品（`resourceType`）', '`\'steel\'`、`\'building_mat\'`', '小写下划线 ID；同时注入全局常量如 `RESOURCE_STEEL`'],
          ['地块 / 建筑 / 工地 / 飞船 / 订单', '`\'42\'`', '十进制数字字符串，可直接传入 `Game.getObjectById(id)`（订单除外）'],
          ['行星地面网格点（`slotId`）', '`1`、`2`、`3`', '数字型永久坐标，用于 `PublicLandPlot.slotId` 与 `Game.map.buyPlot`'],
        ],
      },
      {
        kind: 'note',
        level: 'warn',
        text: '严禁使用数字与字符串 ID 做严格相等比较：`ship.id === 42` 恒为 `false`。在 `Memory` 中保存实体索引时请直接保存字符串 `id`。',
      },
      {
        kind: 'links',
        items: [
          { label: 'StarSystem', id: 'StarSystem' },
          { label: 'Planet', id: 'Planet' },
          { label: 'Station', id: 'Station' },
          { label: 'Game.getObjectById', id: 'Game.getObjectById' },
        ],
      },
    ],
  },
  {
    id: 'guides/economy',
    title: '核心经济规则',
    group: '上手指南',
    kind: '指南',
    summary: '市场手续费、价格带、枢纽仓租、建造耗时、产线能耗与央行信贷规则',
    keywords: '手续费 仓租 建造 修船 银行 利息 逾期 价格带 即时物品 效率',
    blocks: [
      {
        kind: 'prose',
        text: '所有玩家与自治公司遵循完全一致的底层物理与会计规则。编写自动化交易与生产调度前，请先确认以下核心规则。',
      },
      {
        kind: 'table',
        title: '核心规则汇总',
        headers: ['系统', '生效规则', '脚本注意事项'],
        rows: [
          ['市场交易税', '每笔成交从卖方收入扣除 **0.5%** 交易税（`fee`）', '买方按撮合价支付；若吃单成交价优于买方托管挂单价，差额退回买方并计入 `buyerRefund`'],
          ['挂单限量与价格带', '单笔上限 `10000`；单价上限 `min(参考价 × 100, 1,000,000)` 信用点，精度 `0.0001`', '同步与落账阶段均校验；违背价格带或单笔超限会在同步调用即返回 `ERR_INVALID_ARGS`'],
          ['禁止自成交', '不允许新挂单与自己在同一站点、同一物品上的现存反向挂单价格交叉', '直接返回 `ERR_INVALID_TARGET`；改价前请先 `cancelOrder` 并关注同 tick 不能同向反交叉'],
          ['即时物品交割', '`power` 与 `disposal_cert` 属于即时物品', '在 `ST:P*` 买入自动直达 `P*` 地面仓；卖出时若轨道站缺货，会自动补充扣减 `P*` 地面仓'],
          ['枢纽仓租', '每 `12` 个 tick 对 `ST:HUB` 库存按估值收取 **0.8%** 仓租', '按最近成交价估值；行星地面仓与各行星轨道站（`ST:P*`）免费且无容量上限'],
          ['建造成本与工地', '建造扣取对应行星地面建材（见 `Game.catalog.buildings`）+ `80 × Game.cpi` 施工费', '调用 `plot.build()` 后立即占用 `plot.usedSlots` 并在 `Game.sites` 产生工地记录，倒计时清零后生成建筑'],
          ['生产扣料时机', '工作周期**开始时**一次性扣除原料、电力与工资（`laborCost × Game.cpi`），周期结束产出成品', '地块地形加成体现为 `building.efficiency`，按比例放大成品产出；停产（`active = false`）或待机时每隔一个周期扣除待机电费'],
          ['飞船运输与维修', '地面 ↔ 轨道耗时和油耗受船型（小/中/大为 1/2/4）与重力影响；星际段耗时与船型无关但每次耐久损耗至 1.4 倍', '损坏至 `0` 耐久后飞船速度减半（耗时翻倍）；调用 `ship.repair()` 在当前所在地消耗 `daily_goods`（小/中/大船需 1/2/4 件）'],
          ['母星央行信贷', '仅在 `Game.company.homePlanetId` 存取借还；单笔贷款期限 `360` tick', '当 `Game.company.debt > 0 && Game.time > Game.company.debtDueTick` 时进入逾期：无法买地与再借贷，且所有卖货/卖地进账 **25%** 自动强制还债'],
        ],
      },
      {
        kind: 'links',
        items: [
          { label: 'Game.market.createOrder', id: 'Game.market.createOrder' },
          { label: 'Plot.build', id: 'Plot.build' },
          { label: 'Game.bank', id: 'Game.bank' },
          { label: 'Ship.dispatch', id: 'Ship.dispatch' },
          { label: '默认世界建筑与配方', id: 'constants/world-catalog' },
        ],
      },
    ],
  },
];

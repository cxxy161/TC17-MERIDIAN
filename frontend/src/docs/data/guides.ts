import type { DocEntry } from '../types';

export const GUIDE_ENTRIES: DocEntry[] = [
  {
    id: 'guides/quickstart',
    title: '快速开始',
    group: '上手指南',
    kind: '指南',
    summary: '脚本入口结构、热重载机制与最小可运行示例',
    keywords: '入门 开始 快速开始 第一个脚本 loop 热重载 require main',
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
        caption: 'main.js —— 最小可运行脚本',
        code: `module.exports.loop = function () {
  console.log('当前 tick:', Game.time, '现金:', Game.company.cash);

  // Memory 是唯一的跨 tick 持久化对象；普通全局变量每个 tick 都会重置
  if (!Memory.startedAt) {
    Memory.startedAt = Game.time;
  }
};`,
      },
      {
        kind: 'note',
        level: 'info',
        text: '如果 `loop()` 在某个 tick 抛出未捕获异常，只会中止该 tick 的脚本执行并将错误信息输出到控制台，不会清除已保存的代码或上一 tick 的 `Memory` 数据。',
      },
      {
        kind: 'links',
        items: [
          { label: '执行与落账机制', id: 'guides/execution' },
          { label: '配额与限制', id: 'guides/limits' },
          { label: 'Memory', id: 'Memory' },
          { label: 'console', id: 'console' },
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
    summary: '只读快照与两阶段落账模型：写操作同步入队、下一 tick 统一校验生效',
    keywords: '快照 只读 两阶段 执行 落账 写操作 静默丢弃 冻结 freeze',
    blocks: [
      {
        kind: 'prose',
        text: '每个 tick 的世界模拟分为两个核心阶段：**决策阶段**中，`loop()` 运行在本 tick 开始时冻结的只读世界快照上；所有写操作（下单、派船、建厂、切配方、买卖地块、银行操作）不会立即修改任何状态，而是将操作请求写入本 tick 的队列并同步返回 `RetCode`（`OK` 或负数错误码）。随后在**落账阶段**，引擎按各公司随机洗牌后的顺序逐条复核并执行所有操作。',
      },
      {
        kind: 'table',
        title: '单 tick 执行时序',
        headers: ['阶段', '执行内容', '对脚本可见性'],
        rows: [
          ['1. 物理推进', '推进行星公转、抵达飞船入库、完成建造任务、结算建筑生产与城市消费', '生成本 tick 的只读世界快照'],
          ['2. 脚本决策', '调用 `module.exports.loop()`，读取快照并提交最多 32 条写操作', '本 tick 内读取到的 `Game` 字段保持开盘值不变'],
          ['3. 洗牌落账', '按公司随机洗牌顺序复核写操作并扣款扣货、撮合市场成交、结算利息与仓租', '结果反映在**下一 tick** 的 `Game` 快照中'],
        ],
      },
      {
        kind: 'note',
        level: 'warn',
        title: '同一 tick 内读不到刚写入的结果',
        text: '调用 `createOrder` 后本 tick 内 `Game.market.orders` 不会立刻增加；调用 `ship.dispatch` 后 `ship.isBusy` 仍为 `false`；`Game.company.cash` 也不会实时减少。多笔连续操作请用脚本局部变量自行扣减预算或标记已用实体。',
      },
      {
        kind: 'note',
        level: 'danger',
        title: '返回 OK 不代表最终一定成功',
        text: '落账阶段会再次校验资金、库存、槽位、价格带与竞态条件；若复核不通过，该条写操作会被**静默丢弃**，脚本不会收到回调通知。请在下一 tick 检查 `Game` 中的实际状态确认是否生效。',
      },
      {
        kind: 'note',
        level: 'info',
        title: '对象只读与跨公司顺序',
        text: '`Game` 及其下属所有实体与 `Store` 均已被冻结，向其挂载自定义字段不会生效；持久化状态请写入 `Memory`。此外，不同公司的写操作在落账阶段会进行随机洗牌，不要依赖“我先执行所以先抢到单”。',
      },
      {
        kind: 'links',
        items: [
          { label: '配额与限制', id: 'guides/limits' },
          { label: '返回码一览', id: 'constants/return-codes' },
          { label: 'Memory', id: 'Memory' },
          { label: 'Game.market.createOrder', id: 'Game.market.createOrder' },
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
    keywords: '限制 配额 上限 5ms 4MB 32 64 128KB 200 超时 熔断 回滚',
    blocks: [
      {
        kind: 'prose',
        text: '沙盒对每家公司每个 tick 强制执行以下硬性资源上限。触发部分上限会返回 `ERR_FULL`，而触发 CPU、堆内存或 `Memory` 序列化上限会导致整个 tick 的写入全部回滚。',
      },
      {
        kind: 'table',
        title: '资源与操作上限',
        headers: ['限制项', '上限值', '超出后的行为'],
        rows: [
          ['单 tick CPU 时间', '5 ms（墙钟）', '立即中断脚本；本 tick 全部写操作丢弃，`Memory` 回滚到上一 tick，已打印日志保留'],
          ['沙盒堆内存', '4 MB', '触发内存溢出报错；本 tick 全部写操作丢弃，`Memory` 回滚到上一 tick'],
          ['单 tick 写操作', '32 条 / 公司', '第 33 条起写方法直接返回 `ERR_FULL`。游戏界面上的手动操作也共享这 32 条配额，且排在脚本之后'],
          ['全星系活跃挂单', '64 条 / 公司', '达到上限后 `Game.market.createOrder` 返回 `ERR_FULL`；撤单或成交释放的名额下一 tick 生效'],
          ['`Memory` 体积', '128 KB（UTF-8）', 'tick 结束序列化超限时整份改动丢弃并报错，同时本 tick 全部写操作一并丢弃回滚'],
          ['`console` 日志', '200 行 / tick，1024 字节 / 行', '单行超长按 UTF-8 截断并追加 `...`；超过 200 行追加截断提示并丢弃后续日志'],
          ['盘口深度档数', '5 档', '`Game.market.depth` 最多返回买卖各 5 档快照数据'],
        ],
      },
      {
        kind: 'note',
        level: 'warn',
        title: '留足 CPU 安全余量',
        text: '5 ms 为墙钟时间（包含模块加载与查询接口的数据读取耗时），可通过 `Game.cpu.getUsed()` 实时监控。若发现接近 `Game.cpu.limit`，建议提前 `return` 放弃本 tick 次要任务，避免整 tick 回滚。',
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
    summary: '行星、轨道站、枢纽站、物品与数字实体 ID 的统一字符串规范',
    keywords: 'id 标识 行星 站点 枢纽 字符串 坐标 location stationId planetId',
    blocks: [
      {
        kind: 'prose',
        text: '脚本接口中的所有实体 ID（包括地块、建筑、飞船和订单编号）**全部为字符串**。唯一例外是行星表面的位置编号 `slotId` 为数字类型。',
      },
      {
        kind: 'table',
        title: '常见 ID 格式一览',
        headers: ['实体类型', '格式示例', '说明'],
        rows: [
          ['行星（`planetId`）', '`\'P1\'`、`\'P2\'`', '`Game.planets` 的键，也作为行星地面位置标识使用'],
          ['行星轨道站（`stationId`）', '`\'ST:P1\'`、`\'ST:P2\'`', '前缀 `\'ST:\'` 拼接行星 ID，对应行星近地轨道空间站'],
          ['星系枢纽站（`stationId`）', '`\'ST:HUB\'`', '默认星系中心贸易枢纽站；飞船可在 `ST:P*` 与 `ST:HUB` 之间航行'],
          ['物品（`resourceType`）', '`\'steel\'`、`\'building_mat\'`', '小写下划线 ID；同时提供全局常量如 `RESOURCE_STEEL`'],
          ['飞船 / 地块 / 建筑 / 订单', '`\'42\'`', '十进制数字字符串，如 `ship.id`、`plot.id`、`building.id`、`order.id`'],
          ['地块表面格点（`slotId`）', '`1`、`2`、`3`', '数字型永久格点编号，仅用于 `PublicLandPlot.slotId` 与 `Game.buyPlot`'],
        ],
      },
      {
        kind: 'note',
        level: 'warn',
        text: '不要用数字与字符串 ID 做严格相等比较：`ship.id === 42` 永远为 `false`；同样地，从 `Game.planets` 或 `Game.ships` 索引时，数字键请先转为字符串。',
      },
      {
        kind: 'links',
        items: [
          { label: 'Planet', id: 'Planet' },
          { label: 'Station', id: 'Station' },
          { label: 'Plot', id: 'Plot' },
          { label: 'Ship', id: 'Ship' },
          { label: 'MarketOrder', id: 'MarketOrder' },
        ],
      },
    ],
  },
  {
    id: 'guides/economy',
    title: '核心经济规则',
    group: '上手指南',
    kind: '指南',
    summary: '市场手续费、限价价格带、枢纽仓租、建造费用、修船消耗与银行信贷规则',
    keywords: '手续费 印花税 仓租 建造 费用 修船 银行 利息 逾期 价格带 即时物品',
    blocks: [
      {
        kind: 'prose',
        text: '编写自动化策略时，以下由世界内核强制执行的核心经济与物理规则会直接影响落账结果与脚本盈亏。',
      },
      {
        kind: 'table',
        title: '核心规则汇总',
        headers: ['系统', '生效规则', '脚本注意事项'],
        rows: [
          ['市场交易税', '每笔成交从卖方收入中扣除 **0.5%** 交易费', '买方按挂单价全额支付，卖方实收 `price * qty * 0.995`'],
          ['挂单数量与价格带', '单笔挂单数量上限 `10000`；单价不得超过站点参考价的 **100 倍**（且最高 `1,000,000` 信用点）', '超出数量或价格带限制的下单会在落账阶段被静默拒绝'],
          ['禁止自成交', '不允许新挂单价格与自己在同一站点、同一物品上的反向挂单交叉', '改价前先 `cancelOrder`，下一 tick 再以新价 `createOrder`'],
          ['即时物品交割', '电力（`power`）与垃圾消纳（`disposal_cert`）属于即时物品', '在行星轨道站 `ST:P*` 买入直接进入 `P*` 地面仓；卖出时若轨道站缺货，可自动从 `P*` 地面仓补扣'],
          ['枢纽仓租', '每 `12` 个 tick 对存放在枢纽站（`ST:HUB`）的库存收取估值 **0.8%** 的仓租', '按最近成交价估值；行星地面仓与行星轨道站（`ST:P*`）免费且无容量上限'],
          ['建造施工成本', '建造建筑需在对应行星地面仓扣除建材（如 6~14 个 `building_mat`），并支付 `80 × Game.cpi` 施工费', '建造立即占位（计入 `plot.usedSlots`），需等待数个 tick（如 6/8/12）完工后才出现在 `Game.buildings`'],
          ['生产扣料时机', '周期**开始时**一次性扣除原料、电力与工资（`laborCost × Game.cpi`），周期跑满时产出成品', '建筑效率 `efficiency` 仅放大产出数量；停产（`active = false`）或待机时每隔一个周期扣除轻待机电费'],
          ['飞船运输与维修', '地面 ↔ 轨道耗时和油耗受船型（小/中/大为 1/2/4）与行星重力影响；星际段耐久每次损耗加重至 1.4 倍', '航行至 `ST:HUB` 也需消耗燃料；`ship.repair()` 在当前位置消耗 `daily_goods`（小/中/大船需 1/2/4 件）'],
          ['母星央行信贷', '仅允许在 `Game.company.homePlanetId` 存取借还；单笔贷款期限 `360` tick', '逾期未还时无法买地或再借贷，且所有市场卖货与二手卖地收入的 **25%** 会自动扣缴抵债'],
        ],
      },
      {
        kind: 'links',
        items: [
          { label: 'Game.market.createOrder', id: 'Game.market.createOrder' },
          { label: 'Game.buildFacility', id: 'Game.buildFacility' },
          { label: 'Game.bank', id: 'Game.bank' },
          { label: 'Ship.dispatch', id: 'Ship.dispatch' },
          { label: '默认世界建筑与配方', id: 'constants/world-catalog' },
        ],
      },
    ],
  },
];

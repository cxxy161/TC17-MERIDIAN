# 《Meridian》玩家 JS API v2 架构设计（草案）

> 目标：参考 Screeps 领域分层，消除假 `OK` 静默丢单、假控制台、视野缺失与重复字段。  
> 所有方法/字段均保持 **唯一真相源**，全部实体 `id` 统一为 `string`，金额对外统一为信用点 `number`（内部定点数 1 信用点 = `10000`）。

---

## 0. 核心执行与防静默规则

1. **两阶段执行 + 同 tick 影子预扣（Shadow State）**
   - 沙盒内执行写方法时，除了检查静态参数（母星、启用状态、价格带、价格优先），还会预扣本 tick 已排队的现金、货仓、燃料、地块槽位、飞船忙碌状态与挂单计数；能当场判定的问题同步返回 `ERR_*`，不再吐假 `OK`。
2. **异步并发回执（`Game.lastTick` / `Game.market.transactions`）**
   - 同步返回 `OK` 只代表本地校验通过并已入队；若因跨公司同回合竞争（抢单/抢地）在引擎结算失败，下一回合通过 `Game.lastTick.rejected` 精确返回原因，并同步向控制台输出 `warn`。
3. **真沙盒控制台**
   - 前端 `ConsolePanel` 直连后端 QuickJS 沙盒求值接口，和脚本 `loop()` 共享同一份 `prelude.js`、`Game` 对象与 `Memory`（128 KB 限制）。
4. **配额与隔离**
   - CPU 预算统一读取 `Game.cpu.limit`（默认 `10` ms，UI/文档同步一致）；脚本动作上限 `32` 条/tick，玩家界面手动操作走独立通道不被脚本挤掉；`Game` 每 tick 重建冻结，勿在模块顶层缓存 `Game` 子对象。

---

## 1. 全局入口、常量与容器

| 符号 | 说明 | 输入 / 类型 / 返回值 |
|---|---|---|
| `module.exports.loop()` | 每 tick 自动执行的玩家主入口函数 | 无入参 / 返回 `void` |
| `require(modulePath)` | 加载当前账号下其他模块（支持目录如 `'lib/math'`） | `(modulePath: string) => any`（导出对象） |
| `Memory` | 跨 tick 自动序列化的持久化 JSON 对象（上限 `128 KB`） | `Record<string, any>`（仅存可 JSON 化数据） |
| `console.log / warn / error(...args)` | 输出到游戏内控制台（每 tick 限 200 条、单条 1 KB） | `(...args: any[]) => void` |
| `OK` / `ERR_*` | 写操作同步返回码常量 | `OK = 0`；`ERR_NOT_OWNER(-1)` `ERR_NO_PATH(-2)` `ERR_BUSY(-4)` `ERR_NOT_FOUND(-5)` `ERR_NOT_ENOUGH_RESOURCES(-6)` `ERR_INVALID_TARGET(-7)` `ERR_FULL(-8)` `ERR_NOT_IN_RANGE(-9)` `ERR_INVALID_ARGS(-10)` `ERR_NOT_ENOUGH_CREDITS(-14)` |
| `ORDER_BUY` / `ORDER_SELL` | 限价单方向常量 | `"buy"` / `"sell"` |
| `RESOURCE_<ID>` / `RESOURCES_ALL` | 当前生产包全部物品 ID 常量与只读数组 | `string` / `readonly string[]` |
| `MONEY_SCALE` | 内部定点资金精度缩放因子（1 信用点 = 10000） | `10000` |

### `Store`（通用仓库接口）

| 成员 | 说明 | 输入 -> 输出 |
|---|---|---|
| `store[resourceId]` | 查询某资源数量；合法物品无库存返回 `0`，非法 ID 返回 `undefined` | `(resourceId: string) -> number \| undefined` |
| `store.getUsedCapacity(res?)` | 查询指定资源或全仓已占用总量 | `(res?: string) -> number` |
| `store.getCapacity(res?)` | 查询总容量上限（飞船返回载重上限，无限仓储返回 `null`） | `(res?: string) -> number \| null` |
| `store.getFreeCapacity(res?)` | 查询剩余可用容量（无限仓储返回 `null`） | `(res?: string) -> number \| null` |

---

## 2. `Game` 根状态与实体字典

| 属性 / 方法 | 说明 | 结构 / 签名 |
|---|---|---|
| `Game.time` | 当前世界 tick 序号 | `number` |
| `Game.cpi` | 全星系物价指数（影响工资/建厂基价与央行政策） | `number` |
| `Game.cpu` | 本回合 CPU 算力配额与消耗 | `{ limit: number; getUsed(): number }` |
| `Game.company` | 本公司核心资产摘要 | `{ id, name, profession, homePlanetId, cash, savings, debt, debtDueTick }` |
| `Game.systems` | 全星系恒星系字典（键为 `systemId`） | `Record<string, StarSystem>` |
| `Game.planets` | 全星系行星字典（键为 `planetId`） | `Record<string, Planet>` |
| `Game.stations` | 空间站仓库字典（含自身库存或星系公共站索引，键为 `stationId`） | `Record<string, Station>` |
| `Game.plots` | 本公司名下地块字典（键为 `plotId`） | `Record<string, Plot>` |
| `Game.buildings` | 本公司已完工建筑字典（键为 `buildingId`） | `Record<string, Building>` |
| `Game.sites` | 本公司在建工程字典（建厂未完工前在此可见，键为 `siteId`） | `Record<string, ConstructionSite>` |
| `Game.ships` | 本公司飞船字典（键为 `shipId`） | `Record<string, Ship>` |
| `Game.catalog` | 生产包全量静态规则（只读，与 NPC 同等视野） | `{ items, buildings, recipes, recipesByBuilding }` |
| `Game.lastTick` | 上一 tick 的实际结算回执与拒绝明细 | `{ fills: TradeFill[]; rejected: RejectedIntent[] }` |
| `Game.getObjectById(id)` | 按字符串 ID 检索自身/可见实体（Plot/Building/Site/Ship/Planet/Station） | `(id: string) -> Entity \| null` |

---

## 3. 核心实体对象字段与实例方法

### `StarSystem`（`Game.systems[id]`）
- **说明**：恒星系拓扑与中心空间站索引。
- **字段**：`{ id, name, starClass, luminosity, x, y, hubStationId, planetIds: string[] }`

### `Planet`（`Game.planets[id]`）
- **说明**：单颗行星遥测、地面/轨道库（与 `stations` 共享同一份视图引用）及二手地块挂牌。
- **字段**：`{ id, systemId, stationId, name, wealthTier, prosperity, population, gravity, habitability, wasteBacklog, primaryLandPrice, bankRatePct, groundStore: Store, stationStore: Store, demands: Record<string, { qty: number }>, landListings: LandListing[] }`
- **注**：`LandListing` 为 `{ listingId, plotId, slotId, sellerId, price }`（全处统一使用 `price`）。

### `Station`（`Game.stations[id]`）
- **说明**：空间站自身货物仓。
- **字段**：`{ id, systemId, planetId: string | null, store: Store }`

### `Plot`（`Game.plots[id]`）
- **说明**：本公司拥有的工业地块，直接挂接其上已建建筑与在建工程。
- **字段**：`{ id, slotId, planetId, lat, lon, terrainName, capacity, usedSlots, buildingMods: Record<string, number>, buildings: Building[], sites: ConstructionSite[] }`
- **方法**：
  - `plot.build(buildingType)`：在本块空地建造指定类型建筑。
    - **输入**：`buildingType: string`
    - **输出**：`RetCode`（`OK` / `ERR_INVALID_TARGET` / `ERR_FULL` / `ERR_NOT_ENOUGH_CREDITS` / `ERR_NOT_ENOUGH_RESOURCES`）

### `Building`（`Game.buildings[id]`）
- **说明**：已完工生产建筑，支持热切换配方、启停与拆除。
- **字段**：`{ id, type, plotId, planetId, efficiency, recipeId, active, progress, cycleTicks }`
- **方法**：
  - `building.setRecipe(recipeId)`：切换配方（同步检查配方启用态与建筑类型匹配）。
    - **输入**：`recipeId: string` -> **输出**：`RetCode`
  - `building.setActive(active)`：开机或停产待机。
    - **输入**：`active: boolean` -> **输出**：`RetCode`
  - `building.demolish()`：拆除本建筑释放地块槽位。
    - **输入**：无 -> **输出**：`RetCode`

### `ConstructionSite`（`Game.sites[id]`）
- **说明**：在建中的建筑工地（`plot.build` 提交后次 tick 即在此可见）。
- **字段**：`{ id, plotId, planetId, buildingType, finishTick, ticksRemaining }`

### `Ship`（`Game.ships[id]`）
- **说明**：星际货船，负责星球地面与空间站之间的货物运输。
- **字段**：`{ id, size, capacity, durability, location, busyUntil, isBusy, store: Store }`
- **方法**：
  - `ship.dispatch(to, cargo?)`：从飞船当前位置 `ship.location` 出发执行单程运输（支持省略或 `{}` 空载返航；同步预扣油耗与货物并置忙碌态）。
    - **输入**：`to: string`, `cargo?: Record<string, number>` -> **输出**：`RetCode`
  - `ship.repair()`：停靠休整时消耗维修件恢复耐久至 100。
    - **输入**：无 -> **输出**：`RetCode`

---

## 4. `Game.map`（星图、航线、地理与一手购地）

| 方法 | 一句话说明 | 输入 -> 输出 |
|---|---|---|
| `Game.map.calcRoute(fromId, toId)` | 实时轨道位置估算两点间航程 tick、基准燃料与类型 | `(fromId: string, toId: string) -> { ticks: number; fuel: number; kind: "orbital" \| "interplanetary" } \| null` |
| `Game.map.getLandPlots(planetId)` | 获取指定行星全部格点的公开状态与挂牌价格 | `(planetId: string) -> PublicLandPlot[] \| null` |
| `Game.map.buyPlot(planetId, slotId)` | 购买星球上一手未认领空地（与二手市场买地明确分离） | `(planetId: string, slotId: string) -> RetCode` |
| `Game.map.listCompanies(filter?)` | 分页筛选全星系公司公开商业摘要 | `(filter?: { query?: string; planetId?: string; onlyPlayers?: boolean; offset?: number; limit?: number }) -> PublicCompanySummary[]` |
| `Game.map.getCompany(companyId)` | 查看指定公司公开详情（资产计数、地块、活跃挂单） | `(companyId: string) -> PublicCompanyDetail \| null` |

---

## 5. `Game.market`（交易所盘口、挂单、成交与二手购地）

| 成员 / 方法 | 一句话说明 | 输入 -> 输出 |
|---|---|---|
| `Game.market.orders` | 本公司当前活跃挂单字典（键为 `orderId`） | `Record<string, OwnOrder>` |
| `Game.market.transactions` | 上一 tick 本公司全部实际成交流水（等价于 `Game.lastTick.fills`） | `TradeFill[]`（含 `orderId, itemId, side, qty, price, fee, counterPartyId, tick`） |
| `Game.market.quote(stationId, itemId)` | 查询指定站点某物品买卖一档报价、24h/50t 成交量与 EMA 锚价 | `(stationId: string, itemId: string) -> MarketQuote \| null` |
| `Game.market.depth(stationId, itemId, limit?)` | 查询买卖盘口深度（默认 5 档，与快照实际深度一致） | `(stationId: string, itemId: string, limit?: number) -> { bids: DepthLevel[]; asks: DepthLevel[] }` |
| `Game.market.getAllOrders(filter?)` | 按条件分页查询全星系活跃限价单（支持分页防爆内存） | `(filter?: { stationId?: string; resourceType?: string; type?: "buy" \| "sell"; offset?: number; limit?: number }) -> MarketOrder[]` |
| `Game.market.getOrderById(orderId)` | 按订单 ID 精确查询单张挂单详情 | `(orderId: string) -> MarketOrder \| null` |
| `Game.market.createOrder(params)` | 发布限价买/卖单（同步校验价格带、余额/站仓与 64 单上限） | `({ type: "buy" \| "sell", resourceType: string, price: number, totalAmount: number, stationId: string }) -> RetCode` |
| `Game.market.cancelOrder(orderId)` | 撤销本公司活跃挂单并退回托管资金/库存 | `(orderId: string) -> RetCode` |
| `Game.market.deal(orderId, amount)` | 直接吃单成交（同步校验价格优先规则与资金/库存） | `(orderId: string, amount: number) -> RetCode` |
| `Game.market.buyLand(listingId)` | 在二级市场收购其他公司挂牌出售的工业地块 | `(listingId: string) -> RetCode` |

---

## 6. `Game.bank`（母星央行存取借还）

> 所有接口默认作用于 `Game.company.homePlanetId`；若传入非母星 `planetId`，同步直接返回 `ERR_INVALID_TARGET`。

| 方法 | 一句话说明 | 输入 -> 输出 |
|---|---|---|
| `Game.bank.deposit(amount, planetId?)` | 现金存入母星央行赚取活期利息 | `(amount: number, planetId?: string) -> RetCode` |
| `Game.bank.withdraw(amount, planetId?)` | 从母星央行提取储蓄（受准备金流动性约束） | `(amount: number, planetId?: string) -> RetCode` |
| `Game.bank.borrow(amount, planetId?)` | 向母星央行申请信用贷款（受授信额度约束） | `(amount: number, planetId?: string) -> RetCode` |
| `Game.bank.repay(amount, planetId?)` | 偿还母星央行贷款本息 | `(amount: number, planetId?: string) -> RetCode` |

---

## 7. `Game.catalog`（全量只读静态规则）与 `Game.lastTick`

### `Game.catalog`
- **说明**：启动时冻结注入的当前生产包完整字典，与 NPC 读取同一数据源。
- **字段**：
  - `Game.catalog.items`: `Record<string, { id, name, role, refPrice }>`
  - `Game.catalog.buildings`: `Record<string, { id, name, slotsUsed, buildTicks, cashFeeBase, buildCost: { item, qty }[], standbyPower }>`
  - `Game.catalog.recipes`: `Record<string, { id, name, buildingId, enabled, cycleTicks, laborCost, powerCost, inputs: { item, qty }[], outputs: { item, qty }[] }>`
  - `Game.catalog.recipesByBuilding`: `Record<string, string[]>`

### `Game.lastTick`
- **说明**：上一回合引擎 Phase 2 确定性结算后的真实反馈。
- **字段**：
  - `fills`: `{ tick, stationId, itemId, side, qty, price, notional, fee, buyerRefund, counterpartyId }[]`
  - `rejected`: `{ intentIndex, action, target, code, reason }[]`

---

## 8. 与旧版 v1 的主要变化对照（精简摘要）

| 旧版 v1（待淘汰） | 新版 v2 |
|---|---|
| `Game.buyPlot(pid, { slotId \| listingId })` | 一手购地 `Game.map.buyPlot(pid, slotId)`；二手购地 `Game.market.buyLand(listingId)` |
| `Game.buildFacility(plotId, type)` / `demolishFacility` | 实例方法 `plot.build(type)` / `building.demolish()` |
| 无在建工程、无星系/站 ID、无 `catalog` | 新增 `Game.sites`、`Game.systems`、`planet.stationId`、`Game.catalog`、`Game.getObjectById` |
| 无回执、假 `OK` 后静默丢单 | 同步影子预扣账 + 异步 `Game.lastTick.{ fills, rejected }` + Console 自动告警 |
| `Game.market.calcRoute` / `getLandPlots` / `.credits` | 航线与格点迁入 `Game.map`；删掉冗余 `market.credits`（统一用 `Game.company.cash`） |
| `Game.bank(planetId, op, amount)` | `Game.bank.{ deposit, withdraw, borrow, repay }(amount, planetId?)` |
| `ConsolePanel` 浏览器假 mock | 后端真实 QuickJS + `prelude.js` 沙盒求值 |

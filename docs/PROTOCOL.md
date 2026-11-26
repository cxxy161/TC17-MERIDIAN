# 《Meridian》统一决策协议与玩家 JS API 规范（v2.0）

> 本文档定义 `meridian-core` 与 `meridian-sandbox` 之间的唯一契约：**`WorldSnapshot -> Intent[]`**，以及面向玩家的 **QuickJS 脚本接口 v2（`module.exports.loop` / `Game.{systems,planets,stations,plots,buildings,sites,ships,catalog,lastTick,map,market,bank}` / `Memory` / `Store` / `OK & ERR_*`）**。
> **核心原则**：玩家 JS 脚本与 0 硬编码自由 NPC 站在完全同等的视野与动作约束下运行，物理与会计内核绝对不做决策启发式兜底；玩家侧增加影子账本同步校验与 `lastTick.rejected` 异步拒绝回执。

---

## 一、沙盒执行模型（`2C / 500MB` + `rquickjs`）

1. **入口与多模块**
   - 玩家主入口固定导出：`module.exports.loop = function () { ... }`。
   - 支持玩家维护多份代码模块（例如 `main.js`、`market.js`、`logistics.js`），通过 `require('market')` 加载，从内存文档加载器解析。
   - 控制台交互求值走 `__meridian_eval_console(code)`，在持久 VM 内同步执行；其产生的手动写操作独立计入 `manual_intents`，不挤占主脚本 `32` 条配额。
2. **资源硬隔离**
   - 单玩家 QuickJS Runtime 硬上限：**堆内存 `4 MB`**（调用栈 `256 KB`），单回合执行中断默认 **`10 ms`**（可通过 `MERIDIAN_JS_CPU_LIMIT_MS` 覆盖，`clamp(1, 500)`），超时由 Rust `interrupt_handler` 立即熔断。
   - **按需惰性读取（`Game.map` / `Game.market` 按需查询）**：全星系挂单与公司列表/公开地块按需跨越 FFI 查询；静态 `Game.catalog` 在 VM 创建时加载并深度冻结。
   - **`Memory` 持久化**：独立于玩家全局对象之外的 JSON 树，单玩家上限 **`128 KB`**，每回合结束自动序列化落盘。
   - **`console` 日志收集**：劫持 `globalThis.console.{log,warn,error}`，单回合最多保留 `200` 条、单条最长 `1 KB`，推送给前端控制台面板，超出截断报错。
   - **Action 配额**：单家公司每 tick 脚本最多提交 **`32` 条有效 Intent**（UI 与控制台手动操作独立缓冲）；每位参与者全星系活跃挂单总数上限 **`64` 单**。

---

## 二、全局常量与错误码

返回值约定（写方法同步返回 `OK` 或负数错误码）：

```ts
declare const OK: 0;
declare const ERR_NOT_OWNER: -1;
declare const ERR_NO_PATH: -2;
declare const ERR_BUSY: -4;
declare const ERR_NOT_FOUND: -5;
declare const ERR_NOT_ENOUGH_RESOURCES: -6;
declare const ERR_INVALID_TARGET: -7;
declare const ERR_FULL: -8;
declare const ERR_NOT_IN_RANGE: -9;
declare const ERR_INVALID_ARGS: -10;
declare const ERR_NOT_ENOUGH_CREDITS: -14;

declare const ORDER_BUY: "buy";
declare const ORDER_SELL: "sell";
declare const MONEY_SCALE: 10000;

// 由 data/production.json 启动时动态注入（示例）：
declare const RESOURCE_POWER: "power";
declare const RESOURCE_WATER: "water";
declare const RESOURCE_STEEL: "steel";
declare const RESOURCES_ALL: readonly string[];
```

**约定**：所有写操作方法在 Rust Host 层通过 `ShadowState` 影子账本按与结算内核 1:1 对齐的规则做即时预校验与预扣，通过后写入 Intent 缓冲并返回 `OK`；若跨公司竞态导致引擎 Phase 2 落账阶段复核失败，失败明细会被写入下一 tick 的 `Game.lastTick.rejected` 并在控制台打印 `WARN`。

---

## 三、Player JS API v2（`TypeScript` 契约定义）

此接口与 `docs/API_V2.md`、`frontend/src/panels/ScriptIdePanel.tsx` 的 CodeMirror 6 自动补全及 `frontend/src/docs/data/*.ts`（玩家 API 文档，规范见 [API_DOCS_SPEC.md](file:///home/cxxy168/code/html/Meridian/docs/API_DOCS_SPEC.md)）保持严格同步，并通过 `node scripts/check-api-docs.mjs` 守卫。

```ts
/** 写方法的返回码：0 成功，负数为错误码 */
type RetCode = number;

/** 通用库存容器接口 */
interface Store {
  readonly [resourceType: string]: number | undefined;
  getCapacity(resource?: string): number | null;
  getFreeCapacity(resource?: string): number | null;
  getUsedCapacity(resource?: string): number | null;
}

interface Building {
  readonly id: string;
  readonly type: string;          // 如 "mine_smelter"
  readonly plotId: string;
  readonly planetId: string;
  readonly efficiency: number;    // 地形效率修正
  readonly recipeId: string;      // 当前绑定配方
  readonly active: boolean;       // 是否开机
  readonly progress: number;      // 当前周期已跑 tick
  readonly cycleTicks: number;    // 当前配方总周期

  /** 热切换配方：立即改 recipeId，进度不清零，当前周期结束后按新配方结算 */
  setRecipe(recipeId: string): RetCode;
  /** 开机/停产（停产仅付轻待机电费） */
  setActive(active: boolean): RetCode;
  /** 拆除当前建筑并释放地块槽位 */
  demolish(): RetCode;
}

interface Ship {
  readonly id: string;
  readonly size: "small" | "medium" | "large";
  readonly capacity: number;
  readonly durability: number;    // 0 ~ 100
  readonly location: string;      // "P2"（地面）或 "ST:P2" / "ST:HUB"
  readonly busyUntil: number;     // 上次派船算出的到达 tick；到站后不清零，空闲判据是 isBusy
  readonly isBusy: boolean;
  readonly store: Store;

  /**
   * 从当前 location 装货并派船执行单程运输（支持一船混装多种货物）
   * @param to    "ST:P2" / "P2" / "ST:HUB"
   * @param cargo 例如 { steel: 20, building_mat: 10 }
   */
  dispatch(to: string, cargo?: Record<string, number>): RetCode;
  /** 消耗维修件恢复飞船耐久 */
  repair(): RetCode;
}

interface MarketOrder {
  readonly id: string;
  readonly created: number;
  readonly type: "buy" | "sell";
  readonly resourceType: string;
  readonly stationId: string;
  readonly price: number;
  readonly amount: number;          // 当前剩余数量
  readonly totalAmount: number;
  readonly ownerId: string;
}

interface MarketQuote {
  readonly stationId: string;
  readonly resourceType: string;
  readonly bestBid: number | null;
  readonly bestAsk: number | null;
  readonly lastPrice: number;
  readonly emaFast: number;
  readonly emaSlow: number;
  readonly vol50t: number;
}

interface RouteCost {
  readonly ticks: number;
  readonly fuel: number;
  readonly kind: "orbital" | "interplanetary";
}

interface MarketAPI {
  readonly orders: Record<string, MarketOrder>; // 自己挂在市场中的活跃订单
  readonly transactions: readonly LastTickFill[];

  quote(stationId: string, resourceType: string): MarketQuote | null;
  depth(stationId: string, resourceType: string, limit?: number): {
    bids: Array<{ price: number; qty: number }>;
    asks: Array<{ price: number; qty: number }>;
  };
  getAllOrders(filter?: {
    stationId?: string;
    resourceType?: string;
    type?: "buy" | "sell";
    offset?: number;
    limit?: number;
  }): MarketOrder[];
  getOrderById(orderId: string | number): MarketOrder | null;

  createOrder(params: {
    type: "buy" | "sell";
    resourceType: string;
    price: number;
    totalAmount: number;
    stationId: string;
  }): RetCode;

  cancelOrder(orderId: string | number): RetCode;
  deal(orderId: string | number, amount: number): RetCode;
  buyLand(listingId: string | number): RetCode;
}

interface MapAPI {
  calcRoute(fromId: string, toId: string): RouteCost | null;
  getLandPlots(planetId: string): PublicLandPlot[] | null;
  buyPlot(planetId: string, slotId: number): RetCode;
  listCompanies(filter?: {
    query?: string;
    planetId?: string;
    onlyPlayers?: boolean;
    offset?: number;
    limit?: number;
  }): PublicCompanySummary[];
  getCompany(companyId: string): PublicCompanyDetail | null;
}

interface BankAPI {
  deposit(amount: number, planetId?: string): RetCode;
  withdraw(amount: number, planetId?: string): RetCode;
  borrow(amount: number, planetId?: string): RetCode;
  repay(amount: number, planetId?: string): RetCode;
}

interface PlanetInfo {
  readonly id: string;
  readonly systemId: string;
  readonly stationId: string;
  readonly name: string;
  readonly wealthTier: number;       // 1..5
  readonly prosperity: number;
  readonly population: number;
  readonly gravity: number;
  readonly habitability: number;
  readonly wasteBacklog: number;
  readonly primaryLandPrice: number | null;
  readonly bankRatePct: number;
  readonly groundStore: Store;       // 本公司在该星地面仓库
  readonly stationStore: Store;      // 本公司在该星轨道站仓库
  readonly landListings: Array<{
    listingId: string;
    plotId: string;
    slotId: number;
    sellerId: string;
    price: number;
    terrainName: string;
    lat: number;
    lon: number;
    capacity: number;
    usedSlots: number;
    buildingMods: Record<string, number>;
    buildings: string[];
  }>;
  readonly demands: Record<string, { qty: number }>;
}

interface Plot {
  readonly id: string;
  readonly slotId: number;
  readonly planetId: string;
  readonly lat: number;
  readonly lon: number;
  readonly terrainName: string;
  readonly capacity: number;
  readonly usedSlots: number;
  readonly buildingMods: Record<string, number>;  // 建筑类型 -> 效率乘数
  readonly buildings: readonly Building[];
  readonly sites: readonly ConstructionSite[];
  build(buildingType: string): RetCode;
}

interface PublicLandPlot {
  readonly slotId: number;
  readonly planetId: string;
  readonly lat: number;
  readonly lon: number;
  readonly terrainName: string;
  readonly capacity: number;
  readonly usedSlots: number;
  readonly buildingMods: Record<string, number>;
  readonly status: "city" | "unclaimed" | "listed" | "owned";
  readonly isCity: boolean;
  readonly cityName: string | null;
  readonly ownerId: string | null;
  readonly ownerName: string | null;
  readonly isPlayerOwner: boolean;
  readonly plotId: string | null;
  readonly listingId: string | null;
  readonly price: number | null;
  readonly buildings: string[];
}

interface PublicCompanySummary {
  readonly id: string;
  readonly name: string;
  readonly isPlayer: boolean;
  readonly homePlanetId: string;
  readonly netLiquid: number;       // 公开净流动资产（不暴露现金/存款/负债明细）
  readonly plotsCount: number;
  readonly buildingsCount: number;
  readonly shipsCount: number;
  readonly shipsBySize: { readonly small: number; readonly medium: number; readonly large: number };
  readonly openOrdersCount: number;
}

interface PublicCompanyDetail extends PublicCompanySummary {
  readonly buildingCounts: Record<string, number>;
  readonly plots: Array<{
    readonly planetId: string;
    readonly slotId: number;
    readonly plotId: string | null;
    readonly lat: number;
    readonly lon: number;
    readonly terrainName: string;
    readonly capacity: number;
    readonly usedSlots: number;
    readonly status: "owned" | "listed";
    readonly listingId: string | null;
    readonly price: number | null;
    readonly buildings: string[];
  }>;
  readonly openOrders: MarketOrder[];
}

interface RecipeInfo {
  readonly id: string;
  readonly buildingId: string;
  readonly cycleTicks: number;
  readonly powerCost: number;
  readonly laborCost: number;
  readonly inputs: Array<{ item: string; qty: number }>;
  readonly outputs: Array<{ item: string; qty: number }>;
}

interface GameGlobal {
  readonly time: number;
  readonly cpi: number;
  readonly cpu: {
    readonly limit: number;          // ms 预算（默认 10 ms）
    getUsed(): number;
  };
  readonly company: {
    readonly id: string;
    readonly name: string;
    readonly profession: string;
    readonly homePlanetId: string;
    readonly cash: number;
    readonly savings: number;
    readonly debt: number;
    readonly debtDueTick: number | null;
  };
  readonly systems: Record<string, StarSystem>;
  readonly planets: Record<string, PlanetInfo>;
  readonly stations: Record<string, Station>;
  readonly plots: Record<string, Plot>;
  readonly buildings: Record<string, Building>;
  readonly sites: Record<string, ConstructionSite>;
  readonly ships: Record<string, Ship>;
  readonly catalog: CatalogInfo;
  readonly lastTick: { fills: readonly LastTickFill[]; rejected: readonly RejectedIntent[] };
  readonly map: MapAPI;
  readonly market: MarketAPI;
  readonly bank: BankAPI;
  getObjectById(id: string): Building | Plot | ConstructionSite | Ship | PlanetInfo | Station | StarSystem | null;
}

declare const Game: GameGlobal;
declare let Memory: Record<string, any>;
```

**补充约定（类型里看不出来的硬约束）**

- `OK` / `ERR_*` / `MONEY_SCALE` 常量全部冻结；写方法在同步阶段通过影子账本实时预校验。
- 每公司每 tick 脚本最多 **32** 条写操作（UI 与控制台手动操作独立缓冲），活跃挂单最多 **64** 条。
- 写方法将 Intent 写入本 tick 缓冲；若跨公司竞态导致 Phase 2 复核失败，回执会写入下一 tick 的 `Game.lastTick.rejected`。
- `market.depth` 最多保留 **5** 档；`calcRoute().fuel` 与 `ticks` 按小船 × 满耐久估算（地面 ↔ 轨道起降中/大船油耗为 2×/4×，耐久为 0 时耗时翻倍）。
- 除 `slotId` 与数值型统计字段外，实体 ID 全部为字符串；`Game` 与实体对象全部 `Object.freeze`，跨 tick 状态写入 `Memory`。

---

## 四、Rust 内核统一 `Intent` 枚举与两段式 Tick

无论来自 `meridian-sandbox::js_runner`（玩家 JS）还是 `meridian-sandbox::npc`（0 硬编码自由 NPC），最终都收敛为同一种 Rust `Intent` 枚举：

```rust
pub enum Intent {
    CreateOrder {
        station_id: StationId,
        side: OrderSide,
        item_id: ItemId,
        qty: u32,
        price: Money,
    },
    CancelOrder { order_id: OrderId },
    DealOrder { order_id: OrderId, amount: u32 },
    SetRecipe { building_id: BuildingId, recipe_id: RecipeId },
    ToggleBuilding { building_id: BuildingId, active: bool },
    BuildFacility { plot_id: PlotId, building_type: BuildingTypeId },
    DemolishFacility { plot_id: PlotId, building_id: BuildingId },
    BuyPlot { planet_id: PlanetId, slot_id: Option<SlotId>, listing_id: Option<ListingId> },
    DispatchShip {
        ship_id: ShipId,
        from: LocationId,
        to: LocationId,
        cargo: Vec<(ItemId, u32)>,
    },
    RepairShip { ship_id: ShipId },
    BankOp { planet_id: PlanetId, op: BankOpKind, amount: Money },
}
```

### Tick 执行顺序（确定性 + 防竞态）
1. **Phase 0（物理推进）**：行星公转、在途飞船到达入库、建筑生产批次推进（扣除电力/原料/工资并支付轻待机电费）、星球城市消费与废料产出。
2. **Phase 1（并行只读决策）**：用 `rayon` 跨 2 核并发运行各玩家 QuickJS `loop()` 与各自由 NPC 大脑，产出 `(CompanyId, Vec<Intent>)`（最多每家 32 条）。
3. **Phase 2（确定性洗牌落账）**：单线程按本 tick 伪随机洗牌顺序逐条校验并提交全部 `Intent`（扣占资金/库存、下单、派船、建厂），执行全站稀疏 `CLOB` 撮合（成交扣 `0.5%` 印花税防对敲）、仓租与货币守恒校验。

---

## 五、0 硬编码自由 NPC 大脑如何映射到这套 `Intent[]`

完全剥离旧原型里的 `if overstock * 0.94` 或 `if margin < -0.35` 等手写规则，自由 NPC 与玩家一样只看 `WorldSnapshot` 特征，并输出 4 个动作头：

1. **生产头（每座建筑）**：为名下建筑每个合法 `recipe_id` 提取特征 `[市场估价利润率, 原料现货充裕度, 成品盘口库存比, 现金余量]` → 小网络打分选中 `SetRecipe`；输出开关分决定 `ToggleBuilding`。
2. **交易头（按本星/Hub 活跃关注物品）**：提取 `[价差比, 偏离短均线, 偏离长均线, 自有库存, 现金比例]` → 直接输出 `side (Buy/Sell/Hold)`、`相对参考价偏移 offset ∈ [-0.30, +0.30]`、`仓位比例 frac` → 若与当前挂单偏差大先 `CancelOrder` 再 `CreateOrder`。
3. **物流头（每艘空闲飞船）**：枚举可行短途（`地面 ↔ 轨道站`、`本星轨道站 ↔ Hub`）与待运货物，提取 `[两地价差, 现货量, 航线油耗成本, 货舱占用]` → 打分最高者直接发 `DispatchShip`（按剩余载重顺手拼单装满一船）；耐久过低且有维修件时触发 `RepairShip`。
4. **扩建与金融头**：输入 `[现金比率, 负债率, 利率, 最优可建利润]` → 决定 `BuyPlot`、`BuildFacility` 与 `BankOp`。

> **冷启动与演化**：开局均分在 `env_recycle`、`agri_bio`、`mining_ind` 三个职业诞生并配发各自初始建筑；仅淘汰真实长期资不抵债者，新入场 NPC 从高净资产个体交叉+微变异生成（可在 Phase 3 用 Rust 1 秒跑完万 tick 预筛选出自然分工种子权重）。

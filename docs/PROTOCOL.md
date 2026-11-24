# 《Meridian》统一决策协议与玩家 JS API 规范（v1.0）

> 本文档定义 `meridian-core` 与 `meridian-sandbox` 之间的唯一契约：**`WorldSnapshot -> Intent[]`**，以及面向玩家的 **QuickJS 脚本接口（`module.exports.loop` / `Game` / `Memory` / `Store` / `OK & ERR_*`）**。
> **核心原则**：玩家 JS 脚本与 0 硬编码自由 NPC 站在完全同等的视野与动作约束下运行，物理与会计内核绝对不做决策启发式兜底。

---

## 一、沙盒执行模型（`2C / 500MB` + `rquickjs`）

1. **入口与多模块**
   - 玩家主入口固定导出：`module.exports.loop = function () { ... }`。
   - 支持玩家维护多份代码模块（例如 `main.js`、`market.js`、`logistics.js`），通过 `require('market')` 加载，从内存文档加载器解析。
2. **资源硬隔离**
   - 单玩家 QuickJS Runtime 硬上限：**堆内存 `4 MB`**，单回合执行中断：**`5 ms`**（或等价指令配额），超时由 Rust `interrupt_handler` 立即熔断。
   - **按需惰性读取（Lazy Proxy）**：不把整张星系订单簿与星球详情预先序列化进 JS 堆；`Game.market`、`Game.planets` 等只在脚本真正读取对应属性/调用查询方法时才跨 FFI 抓取轻量快照。
   - **`Memory` 持久化**：独立于玩家全局对象之外的 JSON 树，单玩家上限 **`128 KB`**，每回合结束自动序列化落盘 SQLite WAL。
   - **`console` 日志收集**：劫持 `globalThis.console.{log,warn,error}`，单回合最多保留 `200` 条、单条最长 `1 KB`，推送给前端控制台面板，超出截断报错防刷爆内存。
   - **Action 配额**：单家公司每 tick 最多提交 **`32` 条有效 Intent**（防止垃圾循环挂单拖垮盘口）；每位参与者全星系活跃挂单总数上限 **`64` 单**。

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

// 由 data/production.json 启动时动态注入（示例）：
declare const RESOURCE_POWER: "power";
declare const RESOURCE_WATER: "water";
declare const RESOURCE_STEEL: "steel";
declare const RESOURCES_ALL: readonly string[];
```

**约定**：所有写操作方法在 JS 侧做基础类型与权限检查后，向本回合 Intent 缓冲区写入对应 `Intent` 并**同步返回 `OK` 或负数错误码**；真正物理扣款、撮合与移货在引擎 Phase 2 统一校验确定性落账。

---

## 三、Player JS API（`TypeScript` 契约定义）

此接口同时作为前端 **CodeMirror 6 智能补全（`.d.ts`）** 的唯一来源。
> **2026-11-23 已按 `prelude.js` / `js_runner.rs` 逐条核对**：补上 `Game.cpi` / `Game.plots` / `RetCode` / `landListings`，修正 `demands` 形状与 `quote` 可空性。可交互版本（含错误码矩阵与可运行示例）在游戏左侧「API」窗口或 `/docs/`。

```ts
/** 写方法的返回码：0 成功，负数为错误码 */
type RetCode = number;

/** 通用库存容器接口 */
interface Store {
  readonly [resourceType: string]: number;
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
   * 派船执行单程运输（支持一船混装多种货物）
   * @param from "P2" / "ST:P2" / "ST:HUB"
   * @param to   "ST:P2" / "P2" / "ST:HUB"
   * @param cargo 例如 { steel: 20, building_mat: 10 }
   */
  dispatch(from: string, to: string, cargo: Record<string, number>): RetCode;
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
}

interface MarketAPI {
  readonly credits: number;
  readonly orders: Record<string, MarketOrder>; // 自己挂在市场中的活跃订单

  quote(stationId: string, resourceType: string): MarketQuote | null;
  depth(stationId: string, resourceType: string, limit?: number): {
    bids: Array<{ price: number; qty: number }>;
    asks: Array<{ price: number; qty: number }>;
  };
  getAllOrders(filter?: {
    stationId?: string;
    resourceType?: string;
    type?: "buy" | "sell";
  }): MarketOrder[];

  createOrder(params: {
    type: "buy" | "sell";
    resourceType: string;
    price: number;
    totalAmount: number;
    stationId: string;
  }): RetCode;

  cancelOrder(orderId: string): RetCode;
  deal(orderId: string, amount: number): RetCode;
  calcRoute(fromId: string, toId: string): RouteCost | null;
  getLandPlots(planetId: string): PublicLandPlot[] | null;
}

interface PlanetInfo {
  readonly id: string;
  readonly name: string;
  readonly wealthTier: number;       // 1..5
  readonly prosperity: number;
  readonly population: number;
  readonly gravity: number;
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
    askPrice: number;
    terrainName: string;
    lat: number;
    lon: number;
    capacity: number;
    usedSlots: number;
    buildingMods: Record<string, number>;
    buildings: string[];
  }>;
  readonly demands: Record<string, { qty: number }>;   // 只有 qty（旧版误写成含 satisfaction）
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
  readonly cpi: number;             // 全星系物价指数
  readonly cpu: {
    readonly limit: number;          // ms 预算（如 5）
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
  };
  readonly planets: Record<string, PlanetInfo>;
  readonly plots: Record<string, Plot>;            // 只有自己的地块
  readonly stations: Record<string, { readonly id: string; readonly store: Store }>; // 只含有库存记录的站
  readonly buildings: Record<string, Building>;
  readonly ships: Record<string, Ship>;
  readonly market: MarketAPI;

  /** 查询行星全部公开地块；定向购买一手/二手土地 */
  buyPlot(planetId: string, target: { slotId: number } | { listingId: string | number }): RetCode;
  /** 在指定地块建造或拆除通用建筑 */
  buildFacility(plotId: string, buildingType: string): RetCode;
  demolishFacility(plotId: string, buildingId: string): RetCode;
  /** 银行存取借还 */
  bank(planetId: string, op: "deposit" | "withdraw" | "borrow" | "repay", amount: number): RetCode;
  /** 读取静态配方表 */
  getRecipe(recipeId: string): RecipeInfo | null;
}

declare const Game: GameGlobal;
declare let Memory: Record<string, any>;
```

**补充约定（类型里看不出来的硬约束）**

- `OK` / `ERR_*` 常量全部冻结；写方法只可能返回文档里列出的那些码。
- 每公司每 tick 最多 **32** 条写操作（游戏界面手动操作也占这 32 条，且排在脚本之后），活跃挂单最多 **64** 条。
- 写方法只把 Intent 写进本 tick 缓冲；Phase 2 校验失败会被静默丢弃，脚本拿不到回执。
- `market.depth` 的快照只存 **5** 档；`calcRoute().fuel` 是按小船 × 100 耐久估算的近似值。
- 所有 id 都是字符串；`Game` 与实体对象全部 `Object.freeze`，跨 tick 状态只能写 `Memory`。

---

## 四、Rust 内核统一 `Intent` 枚举与两段式 Tick

无论来自 `meridian-sandbox::js_runner`（玩家 JS）还是 `meridian-sandbox::brain_runner`（0 硬编码自由 NPC），最终都收敛为同一种 Rust `Intent` 枚举：

```rust
pub enum Intent {
    CreateOrder {
        station_id: StationId,
        side: OrderSide,
        item_id: ItemId,
        qty: u32,
        price: f64,
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
    BankOp { planet_id: PlanetId, op: BankOpKind, amount: f64 },
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

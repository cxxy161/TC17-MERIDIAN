# Meridian 脚本 API 文档编写规范

> 本文档是 Meridian 玩家脚本 API 文档（游戏内「API」窗口与独立网页 `/docs/`，数据源位于 `frontend/src/docs/`）的**唯一编写规范**。
> 凡新增、修改或重构脚本 API 及文档，均须严格遵守本规范，并通过 `node scripts/check-api-docs.mjs` 校验。

---

## 一、核心原则

1. **玩家视角**：文档的读者是编写游戏脚本的玩家，不是引擎维护者。只写玩家可观测的行为、契约与游戏规则，绝不泄露后端实现细节、源码路径或历史变更吐槽。
2. **单一事实来源（Single Source of Truth）**：任何概念、规则、字段或方法说明在全站只保留**唯一权威条目**，其余位置一律通过链接引用，禁止把同一段内容复制到多个页面。
3. **输入输出零歧义**：每个方法必须清晰分离**输入（Input）**与**输出（Output）**，写全每一个参数和返回值的 TypeScript 类型；写方法必须写清“同步返回码”与“落账阶段拒绝条件”两套校验。
4. **与代码严格同步**：文档中的字段名、方法签名、默认数值、物品/建筑/配方 ID 必须以 `backend/crates/meridian-sandbox/src/prelude.js`、`js_runner.rs`、`meridian-core` 及 `data/production.json` 的真实行为为准。

---

## 二、目录与信息架构规范

### 2.1 分组结构（6 个正交分组）

| 分组 | 定位 | 典型条目 |
| :--- | :--- | :--- |
| **上手指南** | 新手入门与全局机制（每项机制唯一权威页） | 快速开始、执行与落账机制、配额与限制、ID 与坐标约定、核心经济规则 |
| **全局运行时** | 脚本沙盒内置全局对象与函数 | `Memory`、`console`、`require` |
| **`Game` 接口** | `Game` 根对象、全局属性、全局操作方法与 `Game.market` | `Game`、`Game.time`、`Game.plots`、`Game.buyPlot`、`Game.market` 及其子成员 |
| **实体与数据结构** | 快照实体对象、返回值类型及其**独立实例方法** | `Planet`、`Plot`、`Building`（含 `Building.setRecipe` / `Building.setActive`）、`Ship`（含 `Ship.dispatch` / `Ship.repair`）、`Store`、`MarketOrder` 等 |
| **常量与返回码** | 全局冻结常量与默认世界静态数据速查 | 返回码一览（含 `OK` 与全部 `ERR_*` 映射矩阵）、交易方向常量、`RESOURCES_ALL`、`RESOURCE_<ID>`、默认世界建筑与配方速查 |
| **实战示例** | 可直接粘贴运行的完整闭环脚本 | 开局买地建厂、盯盘与深度、按配方自动补料、地面到轨道站物流 |

### 2.2 结构铁律

- **禁止重复概念页**：不再允许同时存在 `overview/execution` 与 `execution`、`overview/limits` 与 `quotas` 这类双胞胎章节。
- **一方法一条目**：带方法的实体（如 `Building`、`Ship`、`Store`）必须将实例方法拆分为独立子条目（`parent: 'Ship'`），**严禁把多个方法挤在同一个参数表与错误码表里**。
- **属性页与实体页职责分离**：
  - `Game.ships` 等容器属性页：只写签名类型（`readonly Game.ships: Record<string, Ship>`）、键集范围说明与简短遍历示例，通过链接指向 `Ship`。
  - `Ship` 实体页：只写对象的只读字段表与实例方法目录（链接到 `Ship.dispatch`、`Ship.repair`）。
- **禁止一行字水页**：错误码统一收拢在「返回码一览」页（含值、含义、触发条件及“方法 × 返回码”速查矩阵），不再为单个 `ERR_*` 各自生成只有一句话的目录条目；`OK` 与 `ERR_*` 同属返回码体系，放在同一页内。

---

## 三、条目类型与必填区块契约

不同 `kind` 的条目必须按固定顺序包含以下区块，**不得缺项，也不得混用区块语义**：

| 条目类型 | 必填区块（按顺序） | 禁止行为 |
| :--- | :--- | :--- |
| **写方法**（返回 `RetCode`） | `prose` → `syntax` → `params` → `returns` → `errors` → `settlement`（落账拒绝条件） → `example` → `links` | 漏写 `params` / `returns` / 落账拒绝条件；把返回类型写成模糊的 `number` |
| **查询方法**（只读） | `prose` → `syntax` → `params` → `returns`（若返回匿名对象则附字段表） → `example` → `links` | 漏写 `params` / `returns`；漏写返回 `null` 或空数组时的边界条件 |
| **只读属性** | `prose` → `syntax` →（可选 `fields` / `methods`）→ `example` → `note` → `links` | 漏写 `syntax` 类型声明；把方法混写进 `fields` |
| **实体 / 数据类型** | `prose` → `fields` →（若有方法则加 `methods`）→ `note` → `example` → `links` | 把两个字段拼在同一行；只写键名不写类型；把方法参数混进 `fields` |
| **常量** | `prose` → `syntax` → `example` → `links` | 用注释冒充类型声明 |
| **指南章节** | `prose` → `table` / `note` / `example` → `links` | 用 `fields` 冒充普通对照表 |

---

## 四、类型签名与输入/输出硬规范

### 4.1 `syntax` 统一采用标准 TypeScript 语法

全站只允许以下 4 种签名写法，**禁止混用 `→` 箭头伪代码、无类型参数名或直接贴调用示例**：

```ts
// 1. 方法（含完整参数类型与返回类型；写方法统一返回 RetCode）
Game.buyPlot(
  planetId: string,
  target: { slotId: number } | { listingId: string | number }
): RetCode

// 2. 查询方法
Game.market.depth(
  stationId: string,
  resourceType: string,
  limit?: number
): MarketDepth

// 3. 只读属性
readonly Game.plots: Record<string, Plot>

// 4. 常量
const ORDER_BUY: 'buy' = 'buy'
```

### 4.2 五种表格区块严格隔离（不得串用）

| 区块 `kind` | 渲染标题 | 列定义 | 硬性规则 |
| :--- | :--- | :--- | :--- |
| `params` | **输入参数（Input）** | `参数 \| 类型 \| 必填 \| 说明` | 仅用于方法入参；无参方法显式写 `rows: []`（界面渲染为“无输入参数”）；支持 `必填` / `可选` / `二选一` |
| `returns` | **返回值（Output）** | `返回类型` + `说明` +（可选子字段表） | **所有方法必填**；写方法固定 `type: 'RetCode'`；必须说明失败/空值形态（`null`、`[]` 或 `{ bids: [], asks: [] }`） |
| `fields` | **对象字段（Properties）** | `字段 \| 类型 \| 说明` | **一行只允许一个字段**；`name` 禁止出现 `/`、`()`、空格；禁止放方法或配置说明 |
| `methods` | **方法一览（Methods）** | `方法 \| 返回值 \| 说明` | 专用于对象/命名空间概览（`Game`、`Game.market`、`Building`、`Ship`、`Store`）；每行可点击跳转到对应方法条目 |
| `table` | 自定义标题 | 自定义列头（支持行内代码与加粗） | 专用于配额上限、ID 规则、错误码矩阵、静态数据速查等非字段对照表 |

### 4.3 对象入参、互斥参数与嵌套类型的强制写法

1. **对象入参**：
   - 先列出外层参数本身（例如 `filter`，标明 `可选` 或 `必填`），再逐行用点号展开子字段（`filter.stationId`、`filter.resourceType`、`filter.type`）。
   - **禁止**签名写解构 `{ a, b }`、参数表却平铺成 `a`、`b` 导致读者误以为是位置参数。
2. **互斥参数**（如 `Game.buyPlot` 的 `target.slotId` 与 `target.listingId`）：
   - 必填列必须标明 `二选一`（不得都标 `可选`），并明确说明同时传入时的优先级。
3. **禁止无类型嵌套结构**：
   - 严禁出现 `{ bids, asks }`、`Array<{ price, qty }>`、`Array<{ planetId, slotId, ... }>` 这类省略字段类型的写法。
   - 必须写全字段类型（`Array<{ price: number; qty: number }>`）或抽成独立具名类型。
4. **继承类型必须完整可见**：
   - 如 `PublicCompanyDetail` 继承 `PublicCompanySummary`，在文档中应明确列出全部字段（或分成“基础字段”与“扩展字段”清晰展示），避免读者翻两页手动拼接。
5. **返回码语义隔离**：
   - 普通数值用 `number`（如 `Game.time`、`price`、`amount`）。
   - 写方法状态码统一用 `RetCode`（定义：`0` 为 `OK`，负数为 `ERR_*`）。

### 4.4 写方法必须区分“两阶段校验”

Meridian 采用“本 tick 同步入队 + 下一 tick 统一落账”机制，所有写方法必须写清两张清单：
1. **同步错误码（`errors`）**：调用方法时**立刻**返回的负数错误码及触发条件。
2. **落账阶段失败条件（`settlement`）**：调用返回 `OK` 后，在下一 tick 落账校验时仍可能导致该操作被静默丢弃的条件（如现金/库存不足、单笔超上限、价格越界、自成交、非母星央行、地块被抢、贷款逾期等）。

---

## 五、文案风格与禁词红线

### 5.1 禁词与禁止写法黑名单（面向玩家文档严禁出现）

| 类别 | 禁止出现的内容 | 正确替代写法 |
| :--- | :--- | :--- |
| 内部源码路径 | `prelude.js`、`js_runner.rs`、`world.rs`、`docs/PROTOCOL.md` | 直接删除；版本栏只显示 `API v1` |
| 内部变量/字段名 | `run_error`、`build_ticks`、`fuel_item`、`active_batch` | 译为玩家能懂的概念：如“脚本执行错误”“建造周期”“燃料物品” |
| 底层实现术语 | `FFI`、`QuickJS Runtime`、`SQLite WAL`、`Lazy Proxy`、`prelude`、`production pack`、`catalog` | 改为“沙盒环境”“持久化存储”“按需查询”“当前世界配置” |
| 开发者碎碎念/变更日志 | “旧文档写错了”“已移除盲盒买地”“这是当前 API 的已知缺口”“照抄会读到 undefined” | 直接陈述**当前真实规则**，不提历史坑或内部吐槽 |

### 5.2 全站统一术语表

| 统一用词 | 禁止混用的近义词 |
| :--- | :--- |
| `tick` | 回合 |
| `行星` | 星球 |
| `建筑` | 设施、工厂（仅在具体建筑中文名中出现“工厂/冶炼厂”） |
| `信用点` | credits（代码标识符 `Game.market.credits` 除外） |
| `落账阶段` | Phase 2、落地阶段、引擎落地阶段 |
| `挂牌地` / `二手地` | 清算挂牌地、二手/银行挂牌地（统一写成“二手/银行挂牌地”并首次定义即可） |
| `写操作` / `Intent` | 首次在「执行与落账机制」定义为“写操作（Intent）”，后续统一称“写操作” |

### 5.3 标点与链接规范

- **`summary`（条目简介）**：一句话概括，**末尾不加句号**，不依赖上下文独立可读。
- **相关链接（`links`）**：`label` 必须与目标条目的 `title`（或完整 API 路径如 `Game.market.quote`）一致，禁止同一页面在不同地方出现多个别名（如把 `quotas` 分别叫成 `quotas`、`每 tick 配额`、`配额与熔断`）。
- **行内格式**：所有代码标识符、字面量、错误码统一用反引号包裹（如 `` `OK` ``、`` `'ST:HUB'` ``、`` `null` ``）。渲染器必须在 `prose`、`summary`、`params`、`returns`、`fields`、`methods`、`table`、`note` 中统一启用行内格式解析。

---

## 六、示例代码编写规范

1. **真实可运行**：
   - 只使用 `data/production.json` 中真实存在的物品 ID（如 `steel`、`building_mat`、`fuel`、`daily_goods`）、建筑 ID（如 `mine_smelter`）与配方 ID（如 `steel_carbon`、`steel_electric`）。
   - 不使用虚构 ID（如 `steel_ingot`、`refined_metal`）。
   - 行星示例默认统一使用 `Game.company.homePlanetId` 或标准宜居主星 `'P2'`（不硬编码无城市行星 `'P1'` 并误称为母星）。
2. **完整上下文**：
   - 完整脚本示例统一写在 `module.exports.loop = function () { ... };` 内，**禁止在模块顶层裸写 `return;`**。
   - 片段示例不得包含未定义变量或错误业务逻辑（例如不得从空货舱 `ship.store` 读取待运地面货物）。
3. **防御性编写**：
   - 调用可能返回 `null` 的查询方法（`quote`、`calcRoute`、`getRecipe`、`getLandPlots`、`getCompany`）必须先判空再访问属性。
   - 访问 `Game.stations[sid]` 必须先判空。
   - 多写操作循环必须在**内层写入点**严格计数并 `break`，且用局部变量扣减本 tick 预算。

---

## 七、标准条目参考模板

### 模板 1：写方法（对象入参 + 两阶段校验）

```ts
{
  id: 'Game.buyPlot',
  title: 'buyPlot',
  group: 'Game',
  kind: '方法',
  summary: '按位置编号购买一手空地，或按挂牌编号收购二手地块',
  keywords: '买地 地块 土地 plot slotId listingId 一手 二手',
  blocks: [
    {
      kind: 'prose',
      text: '购买指定行星上的一手空地，或收购二手/银行挂牌地块。下单前请先通过 `Game.market.getLandPlots` 查看空地 `slotId`，或从 `planet.landListings` 获取挂牌 `listingId`。',
    },
    {
      kind: 'syntax',
      code: 'Game.buyPlot(\n  planetId: string,\n  target: { slotId: number } | { listingId: string | number }\n): RetCode',
    },
    {
      kind: 'params',
      rows: [
        { name: 'planetId', type: 'string', required: 'required', desc: '目标行星 ID，如 `\'P2\'`' },
        { name: 'target', type: 'object', required: 'required', desc: '购买目标对象，以下两项二选一（同时传入时优先按 `listingId` 处理）' },
        { name: 'target.slotId', type: 'number', required: 'oneOf', desc: '一手空地的位置编号，来自 `getLandPlots(planetId)` 中 `status === \'unclaimed\'` 的条目' },
        { name: 'target.listingId', type: 'string | number', required: 'oneOf', desc: '二手/银行挂牌编号，来自 `planet.landListings[].listingId` 或 `getLandPlots()`' },
      ],
    },
    {
      kind: 'returns',
      type: 'RetCode',
      desc: '返回 `OK` 表示已加入本 tick 写操作队列，否则返回负数错误码',
    },
    {
      kind: 'errors',
      rows: [
        { code: 'ERR_INVALID_ARGS', when: '`planetId` 非字符串、`target` 缺失，或未提供合法的 `slotId` / `listingId`' },
        { code: 'ERR_NOT_FOUND', when: '行星不存在，或指定的 `slotId` / `listingId` 不存在' },
        { code: 'ERR_INVALID_TARGET', when: '按 `slotId` 购买时，目标位置不是未开发空地（城市区、已被占用或处于挂牌状态）' },
        { code: 'ERR_FULL', when: '本 tick 已用满 32 条写操作配额' },
      ],
    },
    {
      kind: 'note',
      level: 'warn',
      title: '落账阶段失败条件',
      text: '以下情况即使同步返回 `OK`，也会在下一 tick 落账时被静默丢弃：存在逾期贷款；现金不足以支付地价；同一 tick 内目标地块被其他公司抢先买走；尝试购买自己挂牌的地块。',
    },
    {
      kind: 'example',
      caption: '挑矿冶加成最高的一手空地并购买',
      code: `module.exports.loop = function () {
  const pid = Game.company.homePlanetId;
  const plots = Game.market.getLandPlots(pid);
  if (!plots) return;

  const best = plots
    .filter((t) => t.status === 'unclaimed' && t.price !== null)
    .sort((a, b) => (b.buildingMods.mine_smelter || 0) - (a.buildingMods.mine_smelter || 0))[0];

  if (best && Game.company.cash >= best.price) {
    const rc = Game.buyPlot(pid, { slotId: best.slotId });
    if (rc !== OK) console.warn('买地失败:', rc);
  }
};`,
    },
    {
      kind: 'links',
      items: [
        { label: 'Game.market.getLandPlots', id: 'Game.market.getLandPlots' },
        { label: 'PublicLandPlot', id: 'PublicLandPlot' },
        { label: 'Game.plots', id: 'Game.plots' },
      ],
    },
  ],
}
```

### 模板 2：查询方法（含完整输出结构）

```ts
{
  id: 'Game.market.depth',
  title: 'depth',
  group: 'Game',
  parent: 'Game.market',
  kind: '方法',
  summary: '查询指定站点与物品的买卖盘口深度（最多 5 档）',
  keywords: '深度 盘口 档位 bids asks depth',
  blocks: [
    {
      kind: 'prose',
      text: '返回指定站点与物品当前买卖盘各档位的价格与挂单总量。',
    },
    {
      kind: 'syntax',
      code: 'Game.market.depth(\n  stationId: string,\n  resourceType: string,\n  limit?: number\n): { bids: Array<{ price: number; qty: number }>; asks: Array<{ price: number; qty: number }> }',
    },
    {
      kind: 'params',
      rows: [
        { name: 'stationId', type: 'string', required: 'required', desc: '站点 ID，如 `\'ST:HUB\'`、`\'ST:P2\'`' },
        { name: 'resourceType', type: 'string', required: 'required', desc: '物品 ID 或 `RESOURCE_*` 常量' },
        { name: 'limit', type: 'number', required: 'optional', desc: '最大返回档数，默认 `10`（参数上限 `50`，但快照实际仅保留前 `5` 档）' },
      ],
    },
    {
      kind: 'returns',
      type: '{ bids: Array<{ price: number; qty: number }>; asks: Array<{ price: number; qty: number }> }',
      desc: '参数非法或无挂单时返回 `{ bids: [], asks: [] }`，不会抛错也不会返回 `null`',
      fields: [
        { name: 'bids', type: 'Array<{ price: number; qty: number }>', desc: '买盘档位，按价格从高到低排序' },
        { name: 'asks', type: 'Array<{ price: number; qty: number }>', desc: '卖盘档位，按价格从低到高排序' },
      ],
    },
    {
      kind: 'example',
      caption: '读取最低卖一档价格与挂单量',
      code: `module.exports.loop = function () {
  const d = Game.market.depth('ST:HUB', RESOURCE_STEEL, 5);
  if (d.asks.length > 0) {
    console.log('卖一价:', d.asks[0].price, '数量:', d.asks[0].qty);
  }
};`,
    },
    {
      kind: 'links',
      items: [
        { label: 'Game.market.quote', id: 'Game.market.quote' },
        { label: 'Game.market.getAllOrders', id: 'Game.market.getAllOrders' },
      ],
    },
  ],
}
```

### 模板 3：带方法的实体类型（属性与方法分离）

```ts
{
  id: 'Ship',
  title: 'Ship',
  group: '实体',
  kind: '类型',
  summary: '公司名下的运输飞船快照对象，位于 Game.ships[shipId]',
  keywords: 'Ship 飞船 运输 货舱 耐久 location isBusy busyUntil',
  blocks: [
    {
      kind: 'prose',
      text: '飞船用于在行星地面、轨道站与星系枢纽之间执行单程货运，一次可混装多种物品。对象本身为只读快照，派船与维修通过实例方法发起。',
    },
    {
      kind: 'fields',
      rows: [
        { name: 'id', type: 'string', desc: '飞船 ID' },
        { name: 'size', type: "'small' | 'medium' | 'large'", desc: '船型（对应容量 40 / 120 / 360 件）' },
        { name: 'capacity', type: 'number', desc: '货舱最大载货件数' },
        { name: 'durability', type: 'number', desc: '当前耐久度（`0..100`）；降至 `0` 时航行耗时翻倍' },
        { name: 'location', type: 'string', desc: '当前所在位置，如 `\'P2\'`、`\'ST:P2\'`、`\'ST:HUB\'`' },
        { name: 'isBusy', type: 'boolean', desc: '是否正在航行中（空闲判断请始终使用此字段）' },
        { name: 'busyUntil', type: 'number', desc: '最近一次航行的预计到达 tick（到站后不清零）' },
        { name: 'store', type: 'Store', desc: '货舱只读库存（仅在途期间有货，到站卸载后清空）' },
      ],
    },
    {
      kind: 'methods',
      rows: [
        {
          signature: 'ship.dispatch(from: string, to: string, cargo: Record<string, number>)',
          returns: 'RetCode',
          desc: '从当前位置装货并派往目的地',
          id: 'Ship.dispatch',
        },
        {
          signature: 'ship.repair()',
          returns: 'RetCode',
          desc: '消耗当前位置的维修品将耐久恢复至 100',
          id: 'Ship.repair',
        },
      ],
    },
    {
      kind: 'links',
      items: [
        { label: 'Ship.dispatch', id: 'Ship.dispatch' },
        { label: 'Ship.repair', id: 'Ship.repair' },
        { label: 'Game.ships', id: 'Game.ships' },
        { label: 'Store', id: 'Store' },
      ],
    },
  ],
}
```

---

## 八、API 变更同步清单与自动化守卫

### 8.1 修改任何玩家脚本 API 时的必查清单

每当新增/修改/删除宿主接口、对象字段或错误码时，必须同步更新以下 4 处：

1. **沙盒暴露层**：`backend/crates/meridian-sandbox/src/prelude.js` 与 `js_runner.rs`（确认序列化字段与 JS 包装层字段一一对应，不漏拷）。
2. **玩家 API 文档**：`frontend/src/docs/data/*.ts`（按本规范更新对应条目、概览表及返回码矩阵）。
3. **IDE 自动补全**：`frontend/src/panels/ScriptIdePanel.tsx`（同步 `API_COMPLETIONS` 签名与错误码）。
4. **内部契约文档**：`docs/PROTOCOL.md`（同步内部架构协议与 `Intent` 定义）。

### 8.2 自动化守卫（`scripts/check-api-docs.mjs`）必须强制校验的规则

1. **唯一性与引用完整**：所有条目 `id` 唯一；`parent`、`links`、`methods[].id` 无悬空引用。
2. **宿主函数全覆盖**：`js_runner.rs` 中注册的所有 `__meridian_*` 宿主函数都有对应文档条目。
3. **方法输入/输出完整**：所有 `kind === '方法'` 的条目必须同时包含 `syntax`、`params`、`returns`；返回 `RetCode` 的写方法必须包含 `errors`。
4. **字段表纯洁性**：`fields` 块的 `name` 不允许包含 `/`、`()` 或空格；实体条目在 `prelude.js` / `js_runner.rs` 中暴露的字段名必须与文档字段表一致。
5. **格式与禁词检查**：
   - `syntax` 中禁止使用 `→` 箭头伪代码；
   - 文档文案禁止包含内部黑名单词（`prelude.js`、`js_runner.rs`、`PROTOCOL.md`、`run_error`、`旧文档`、`已知缺口`、`FFI`、`QuickJS Runtime`、`SQLite WAL` 等）和残留占位符 `§`；
   - 示例代码中的字符串物品/建筑/配方 ID 须校验是否存在于 `data/production.json`。

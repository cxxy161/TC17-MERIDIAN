# Meridian 产线数据 JSON 格式规范（v1.0.0）

> 本文档定义了《Meridian》正式版中用于存储**需求大类、职业方向、物品、通用建筑与生产配方**的统一 JSON 数据格式。
> [recipe_editor.html](file:///home/cxxy168/code/html/Meridian/sim/recipe_editor.html) 生成、校验并导出的 `.json` 文件严格遵循本规范，可直接作为后端引擎与前端图鉴的唯一静态数据源（Data-Driven）。

---

## 1. 设计原则

1. **建筑与配方彻底解耦**：全游戏只保留少量通用功能建筑（约 `10~30` 座），所有产线变化挂载在 `recipes[]` 上；同一座建筑可随时热切换名下任意配方，无需拆厂重建。
2. **三类产物职能清晰**：物品通过 `role` 明确分为 `foundation`（生产基础类）、`factory_consume`（工厂消耗类）、`planet_supply`（星球供给类），外加资本载体 `capital` 与系统副产 `byproduct`（如城市废料）。
3. **横向大类采购，杜绝单点锁死**：星球按 `demand_category` 采购消费，同大类多品可相互替代；允许通过同一产出多条 `Recipe` 实现“碳炉/电炉”等替代工艺。
4. **废料处理正向结算**：城市排出的垃圾作为 `byproduct`（实物占舱位），回收站将其消耗后产出 `disposal_cert`（环保消纳凭证，正价格卖回星球）+ 再生资源副产，避免订单簿出现负数价格。
5. **参考价仅作编辑器分析与开局种子**：`ref_price` **绝不**作为运行时价格上限或硬封顶，真实成交价完全由市场自由竞价形成。

---

## 2. 顶层结构（Root Object）

```json
{
  "schema_version": "1.0.0",
  "meta": {
    "name": "Meridian 起步产线包 (3×5)",
    "author": "Meridian",
    "ticks_per_day": 24,
    "tick_seconds": 60,
    "updated_at": "2026-11-23T00:00:00Z"
  },
  "demand_categories": [],
  "professions": [],
  "items": [],
  "buildings": [],
  "recipes": []
}
```

| 字段 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `schema_version` | `string` | 是 | 语义化版本号，当前固定 `"1.0.0"` |
| `meta` | `object` | 是 | 数据包元信息与时间基准 |
| `demand_categories` | `DemandCategory[]` | 是 | 星球消费/供给大类定义（对应 1~5 层财富） |
| `professions` | `Profession[]` | 是 | 玩家开局方向 & NPC 生态位偏好 |
| `items` | `Item[]` | 是 | 全宇宙物品字典 |
| `buildings` | `BuildingDef[]` | 是 | 通用功能建筑定义 |
| `recipes` | `RecipeDef[]` | 是 | 挂载在建筑下的生产/回收配方 |

---

## 3. 各对象字段规范

### 3.1 `DemandCategory`（星球需求大类）

| 字段 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `id` | `string` | 是 | 唯一 snake_case ID，如 `"env_support"` |
| `name` | `string` | 是 | 中文展示名，如 `"维生与环保"` |
| `wealth_tier` | `integer (1..5)` | 是 | 开始产生该类刚需的星球财富等级（当前固定 1~5 层） |
| `description` | `string` | 否 | 用途说明 |

### 3.2 `Profession`（开局职业 / 主导方向）

| 字段 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `id` | `string` | 是 | 唯一 ID，如 `"env_recycle"` |
| `name` | `string` | 是 | 职业名称，如 `"环境能源与回收"` |
| `demand_category` | `string` | 是 | 主导对应的 `DemandCategory.id` |
| `color` | `string` | 否 | 编辑器与 UI 主题色（HEX，如 `"#38bdf8"`） |
| `description` | `string` | 否 | 玩法简介 |
| `starter_buildings` | `string[]` | 否 | 开局赠送/推荐建筑 ID 列表 |
| `efficiency_bonus` | `Record<string, number>` | 否 | 职业专精产率/耗时加成，如 `{"recycling_plant": 1.15}` |

### 3.3 `Item`（物品定义）

| 字段 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `id` | `string` | 是 | 唯一物品 ID，如 `"rations"`、`"waste"` |
| `name` | `string` | 是 | 显示名，如 `"基础口粮"` |
| `role` | `enum` | 是 | `"foundation"`（生产基础类）\| `"factory_consume"`（工厂消耗类）\| `"planet_supply"`（星球供给类）\| `"capital"`（载具资本品）\| `"byproduct"`（系统/城市废料） |
| `profession` | `string` | 是 | 归属 `Profession.id`（系统废料可用 `"system"`） |
| `demand_category` | `string \| null` | 否 | 当 `role == "planet_supply"` 或城市同时消耗电力/建材时，填入对应 `DemandCategory.id` |
| `wealth_tier` | `integer (1..5)` | 是 | 星球开始需求或解锁的财富层级 |
| `step_depth` | `integer (0..5)` | 是 | 产线深度（`0~1` 为基础高吞吐底座，`2+` 为多步进阶品） |
| `volume` | `number` | 是 | 单位体积（`>= 0.01`，用于飞船货舱与仓储计算） |
| `mass` | `number` | 否 | 单位质量（影响高重星起飞油耗，默认可等于 `volume`） |
| `ref_price` | `number` | 是 | 静态参考估价（`>= 0`；**仅供编辑器毛利测算与初始种子，不限制真实价格波动**） |
| `base_demand_per_1k` | `number` | 否 | 每 `1000` 星球人口每 `tick` 的参考基础需求量（用于编辑器吞吐测算，默认 `0`） |
| `tags` | `string[]` | 否 | 扩展语义标签，如 `["power"]`、`["fuel"]`、`["repair"]`、`["waste"]` |

### 3.4 `BuildingDef`（通用功能建筑）

| 字段 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `id` | `string` | 是 | 唯一建筑 ID，如 `"smelter_foundry"` |
| `name` | `string` | 是 | 建筑名，如 `"冶金高炉"` |
| `profession` | `string` | 是 | 主要归属 `Profession.id` |
| `slots_used` | `integer` | 否 | 占用地块槽位数，默认 `1` |
| `build_ticks` | `integer` | 是 | 建造所需 tick |
| `build_cost` | `ItemQty[]` | 是 | 建造消耗物资清单，如 `[{"item": "building_mat", "qty": 10}]` |
| `standby_power` | `integer` | 否 | 停机待机每周期耗电（`0` 表示可无耗停机） |
| `description` | `string` | 否 | 建筑定位说明 |

### 3.5 `RecipeDef`（生产/回收配方）

| 字段 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `id` | `string` | 是 | 唯一配方 ID，如 `"steel_carbon"` |
| `name` | `string` | 是 | 配方名，如 `"碳还原炼钢"` |
| `building_id` | `string` | 是 | 所属通用建筑 `BuildingDef.id` |
| `tier` | `integer (1..5)` | 是 | 配方解锁财富层级 |
| `cycle_ticks` | `integer` | 是 | 单批生产周期（`>= 1`） |
| `power_cost` | `integer` | 是 | 单批额外电力消耗（`>= 0`；若电力也写入 `inputs` 则避免重复计价，推荐统一填在 `power_cost` 由编辑器自动折算） |
| `labor_cost` | `number` | 是 | 单批基础人工/运维参考现金支出（`>= 0`，流向星球工资池） |
| `inputs` | `ItemQty[]` | 是 | 原料输入数组（可为空 `[]`，如采矿/光伏） |
| `outputs` | `ItemQty[]` | 是 | 产物输出数组（至少 `1` 项，支持主产物+多副产） |
| `enabled` | `boolean` | 否 | 默认 `true`；下线旧配方时置 `false` 而非硬删除 |
| `notes` | `string` | 否 | 工艺说明（如 `"比电炉省电，依赖农业碳"`） |

其中通用子结构 `ItemQty` 为：

```json
{ "item": "steel", "qty": 6 }
```
- `item`: 必须存在于 `items[].id`
- `qty`: 严格正整数 `>= 1`

---

## 4. 数据校验与运行时不变量

后端加载产线配置或编辑器点击“体检”时，必须满足以下约束：

1. **引用完整性**：
   - `professions[].demand_category` ∈ `demand_categories[].id`
   - `items[].profession` ∈ `professions[].id` ∪ `{"system"}`
   - `recipes[].building_id` ∈ `buildings[].id`
   - `recipes[].inputs[].item` 与 `outputs[].item` 与 `buildings[].build_cost[].item` ∈ `items[].id`
2. **可达性（防闭环死锁）**：
   - 从“零前置输入（`inputs == []`）的采集/能源配方 + 系统 `byproduct`（如 `waste`）”出发做正向可达 BFS，所有启用的 `items` 与 `recipes` 必须可达；若出现纯环状不可启动配方（如 A 要 B、B 要 A 且都无入口），判定为 `ERROR`。
3. **无孤立死节点提醒（Warning）**：
   - 任何 `role != "byproduct"` 的物品如果没有至少 1 条启用配方产出，报 `WARNING`；
   - 任何非终局消费品如果既不被 `planet_supply` 消费、也不被任何配方当作 `inputs`/`build_cost`，报 `WARNING`。
4. **2C / 500MB 服务器端加载策略**：
   - 整份 JSON 解析后作为**全进程只读共享字典**驻留内存（几百条配方仅约数百 KB）；
   - 交易所盘口不预先为所有 `stations × items` 初始化完整数组，采用按需创建（Sparse Orderbook）以支撑未来扩展到 `350+` 物品。

---

## 5. 极简起步包完整示例（片段）

```json
{
  "schema_version": "1.0.0",
  "meta": {
    "name": "Meridian 3×5 起步包",
    "author": "Meridian",
    "ticks_per_day": 24,
    "tick_seconds": 60
  },
  "demand_categories": [
    { "id": "env_support", "name": "维生与环保", "wealth_tier": 1 },
    { "id": "daily_life", "name": "饮食与穿着", "wealth_tier": 1 },
    { "id": "infra_tools", "name": "基建与日用", "wealth_tier": 1 }
  ],
  "items": [
    {
      "id": "power",
      "name": "电力",
      "role": "factory_consume",
      "profession": "env_recycle",
      "demand_category": "env_support",
      "wealth_tier": 1,
      "step_depth": 0,
      "volume": 0.1,
      "ref_price": 2.0,
      "base_demand_per_1k": 1.2,
      "tags": ["power"]
    }
  ],
  "recipes": [
    {
      "id": "steel_carbon",
      "name": "碳还原炼钢",
      "building_id": "mine_smelter",
      "tier": 1,
      "cycle_ticks": 4,
      "power_cost": 3,
      "labor_cost": 8.0,
      "inputs": [
        { "item": "ore", "qty": 6 },
        { "item": "bio_fiber", "qty": 3 }
      ],
      "outputs": [
        { "item": "steel", "qty": 6 }
      ],
      "enabled": true
    }
  ]
}
```

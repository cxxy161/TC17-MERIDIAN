# Meridian 前端 UI 可扩展性审计报告

> 目标基线（用户明确要求）：**成千上万个星球/星系 + 成千上万个物品**。
> 当前基线（实测）：3 颗行星（P1/P2/P3）、4 个站点（ST:HUB + ST:P1..P3）、16 个物品、7 种建筑、18 条配方。tick 默认 2000ms。
> 审计范围：`frontend/src`（43 个文件 / 7368 行）全量通读 + 为确认"数据形状"而核对的后端 `engine.rs` / `world.rs` / `snapshot.rs` / `api.rs`。
> 本文所有 `文件:行号` 均逐行实读核对；只读审计，未修改任何代码。

---

## 0. 一句话结论

**这不是"下拉框太多"的问题，而是三层地基同时缺失**：

1. **实体层不存在** —— 面板身份是 4 个裸字符串，实体没有类型、没有名称解析、没有存在性校验、没有索引；
2. **检索层不存在** —— 全站 9 个 `<select>` + 4 面"胶囊按钮墙" + 2 个硬截断 picker，**0 个**支持搜索 / 分面 / 虚拟滚动 / 分页；
3. **层级层不存在** —— 数据模型和 UI 里都没有"星系→行星"、"物品→类别→子类"这两级结构，所以只能用平铺枚举代替导航。

再叠加一个放大器：**全量快照当搜索引擎**——每个 tick 拉一次包含「站点 × 物品」笛卡尔积的 `/api/state`，前端全量重渲染且**全库 0 处 `React.memo`、0 处虚拟化**。

排名第一的危险不是"不可用"，而是**静默错误**：过期 id 会显示成第一颗行星的完整数据（标题还是错的），央行下拉 1000 项里 999 项静默失败且无回执。玩家会基于这些面板下单、建仓。

---

## 1. 体检表：UI 里的隐含假设 vs 产品要求

| 维度 | UI 的隐含假设 | 证据 | 产品要求 | 结论 |
|---|---|---|---|---|
| 行星 | 正好 3 颗，且是手写常量 | `paneRegistry.ts:77-81`（3 条中文名）、`OrbitPanel.tsx:9-13`（3 色）、`Planet3DCanvas.tsx:38-69`（3 套剖面）、`:32-36`（3 条自转天数） | 上万颗且**运行时生成** | 第 4 颗起：名字退化为 `P847`、颜色全变蓝、3D 外观全部复制 P2、自转全部 1.0 天 |
| 站点 | 正好 4 个，写死在客户端 | `meridian.ts:317-322` `STATION_NAMES`（4 条） | 每颗行星一个轨道站（后端已动态生成 `ST:{pid}`，`world.rs:91`） | 999 个市场在行情/盘口/K线里**点不到** |
| 物品 | ≤16 个，可以全部塞进一个原生下拉 | 9 个 `<select>`；`ChartPanel.tsx:1062-1076` 等 | 上千个，且由 production pack 定义 | 下拉要滚 50 屏；⌘K 只暴露前 10 个 |
| 星系 | 不存在这个概念 | `PaneParams` 无 `systemId`；core 全库 grep `galaxy/system_id` 命中 0 | 上千个星系 | 空间导航从根上不可实现 |
| 物品分类 | 不需要 | `role/profession/demand_category/wealth_tier/tags` 在 `types/meridian.ts:19-30` 有定义，**全前台 0 处读取** | 必须分面 | 分面字段数据层已具备，UI 层一个没接 |

---

## 2. 七条根因

### 根因 A｜「实体」在壳层不存在：身份 = 4 个裸字符串

```ts
// layout/paneRegistry.ts:20-25
export interface PaneParams {
  planetId?: string; locationId?: string; stationId?: string; itemId?: string;
}
```

实体在 UI 里不是一个有类型/有生命周期/可校验的对象，而是一个字符串。由此派生 9 个缺陷：

- **A1 无引用完整性**：没有任何地方能判断 `params.planetId` 是否还存在，而它会被 `localStorage` 长期持久化（`workspaces.ts:9-10,113`）。
- **A2 面板把 params 复制进 local state，且 5/8 个面板没有同步 effect**：`TickerPanel.tsx:9`、`FactoryPanel.tsx:11`、`OrderBookPanel.tsx:17-18`、`TreasuryPanel.tsx:12`、`CargoPanel.tsx:17` 都没有 `useEffect(() => ..., [params.x])`（对比 `PlanetPanel.tsx:41-43`、`ChartPanel.tsx:346-349`）。tile 的 params 变了，内容还是旧实体——**同一 tile 复用是万级实体下唯一可行的导航方式**，这条直接堵死。
- **A3 标题是 params 的去规范化缓存**：`splitTree.ts:108-119` 的 `setLeafTitle` 把标题写进持久化树，`SplitLayout.tsx:42-44` / `FloatingWindowsLayer.tsx:52` 优先用它。一旦 `setTitle` 过，标题**永远**不再随 params 重新推导。
- **A4 标题生成器拿不到 catalog**：`paneRegistry.ts:76-131` 是纯函数 switch，物品标题恒为 `K线 · steel @ 枢纽`——1000 个物品时你会同时开着 6 个**标题完全一样**的 K 线窗。
- **A5 一个 id 空间塞两种实体**：站点靠字符串拼 `ST:${planetId}` 扮演"关系"（`CargoPanel.tsx:21,25,68`；`DemandPanel.tsx:29`；`PlanetPanel.tsx:62,211`）。行星命名一变，唯一的地面→轨道钻取链路静默变成空仓库。
- **A6 无深链 / 无历史 / 无最近 / 无收藏 / 无实体索引**：`main.tsx` 无 Router，`api/client.ts` 只有 `getCatalog()` 与 `getState()` 两个全量读接口，**没有任何按 id 查询或搜索的 API**。
- **A7 新增一种实体型面板要同步改 6~7 处**：`PaneKind`(:5-18) → `PANEL_COMPONENTS`(:28-44) → `PANE_CATALOG`(:58-74) → `RAIL_BUTTONS`(\`DesktopShell.tsx:43-59\`) → `EmptyTilePane` 展开(:68-124) → `CommandPalette` 展开(:34-82) → `formatPaneTitle` switch(:82-131)。`PaneMeta` 里**没有** `paramsSchema / entityType / titleFn`。
- **A8 无"当前实体"上下文**：每个面板各自维护局部选择（`PlanetPanel` 的 planetId、`ChartPanel` 的 station+item…），系统里不存在"我当前在看哪颗行星"，所以左侧导航栏只能写死 `P2`（`DesktopShell.tsx:45-53`）。
- **A9 无效 id 无空状态，只有"换成第一个"**：见第 3 节。

### 根因 B｜没有选择器组件：三种枚举习语并存，全部不可扩展

| 习语 | 位置 | N=1000 时 |
|---|---|---|
| 原生 `<select>`（9 处） | 物品：`ChartPanel.tsx:1062-1076`、`OrderBookPanel.tsx:71-84`；建筑/配方：`FactoryPanel.tsx:43-53,115-129`；行星：`TreasuryPanel.tsx:57-67`；目的地：`FleetPanel.tsx:164-174`；站点：`ChartPanel.tsx:1051-1061`、`OrderBookPanel.tsx:57-70` | 1000 个 `<option>`，原生弹层约 20 行可见、**无过滤框**、中文名无法拼音跳转；找「钢材」要滚 50 屏 |
| "胶囊按钮墙"（4 处） | `PlanetPanel.tsx:73-81`、`DemandPanel.tsx:45-56`、`CargoPanel.tsx:48-56`（**2N+1** 个）、`FactoryPanel.tsx:31-39`（**无 wrap 无滚动**，超出被裁掉且不可点） | 头部 `shrink-0` + `flex-wrap` → 1000 个按钮吃掉整个 tile 高度，正文（含 3D 球、库存卡）被压到 0 高；工厂面板则直接溢出不可达 |
| 硬截断 picker（2 处） | `CommandPalette.tsx:86-89`（`slice(0,14)` / `slice(0,16)`）、`:72`（`items.slice(0, 10)`）；`paneComponents.tsx:128-131`（`slice(0,12)` / `slice(0,16)`） | 6000 条候选中 **5988 条永久不可达**。更具体的 bug：`PANE_CATALOG` 恰好 15 条，`slice(0,12)` 让 **script / memory / console 三个面板在空查询下不可见** |

附加缺陷：

- **B1 两份重复且不一致的实体展开逻辑**：`CommandPalette`（每行星 3 条，无 demand）vs `EmptyTilePane`（每行星 4 条，有 demand；每物品 2 条 chart+orderbook，且站点写死 `ST:HUB`）。任何规则改动要改两遍。
- **B2 0 处分面/0 处虚拟化/0 处 memo**：`grep -rn 'React.memo|useVirtual|react-window'` 命中 **0**；9 个 select 全部无搜索框。
- **B3 键盘不可达**：picker 全是裸 `<button>` 列表，无 `role="listbox"` / `aria-activedescendant` / 方向键；3000 个可聚焦按钮让 Tab 导航失效。

### 根因 C｜没有层级：星系→行星、物品→类别→子类都不存在

- **C1 数据模型层就没有星系**：`PlanetId = String`（`types.rs:57`），`PlanetSummary` 只有 `orbit_radius/orbit_angle`（`types/meridian.ts:83-98`），没有 `system_id`；core 全库 grep 0 命中。
- **C2 星图是"一个星系内平铺 N 颗行星"**：`OrbitPanel.tsx:72-91` 每颗行星无条件渲染"轨道圆 + 圆点 + 文字"（≈4N 个 SVG 节点），固定 `viewBox 520×380`，`scaleR` 把 1000 条轨道压进 **130px** 的半径区间（相邻轨道间距 < 0.13px），1000 个 10.5px 标签重叠成一团，点击目标 r=3.5~5px。`OrbitPanel` 甚至不接收 `params`（`:15`），无法表达"我在看哪个星系"。
- **C3 物品在 UI 里没有实体页**：15 个面板里没有 item / recipe / catalog 面板；`RecipeDef.inputs/outputs`（`meridian.ts:48-57`）、`BuildingDef.build_cost/slots_used/description`（`:37-46`）在 `frontend/src` **零消费**。玩家无法回答"钢由哪几条配方产出 / 哪些建筑能产 / 我的哪条产线在吃它"。
- **C4 只有单向钻取**：`PlanetPanel.tsx:203-228` 能从行星开仓库/产线/需求；反过来，仓库看到"ST:P847 有 12 单位钛"时没有任何"回到所属行星"的路径（`CargoPanel.tsx:72` 行内只开 chart）。实体越多，反向导航越必需。
- **C5 顺序由后端 id 字典序决定**：`engine.rs:422` `out.sort_by(|a,b| a.id.cmp(&b.id))` → 按钮顺序是 `P1, P10, P100, P1000, P101, …, P2`，且 `planets[0]` 兜底语义随 id 位宽漂移。

### 根因 D｜实体身份表被硬编码成"正好 3 颗行星 + 4 个站点"

6 张只认识 `P1/P2/P3` 的表，全部是"服务端真值的第二份拷贝"，且永远不会增长：

| # | 常量 | 位置 | 缺失时行为 |
|---|---|---|---|
| D1 | `STATION_NAMES`（4 条） | `meridian.ts:317-322` | 站点名 → 裸 `ST:P847` |
| D2 | `planetLabels`（3 条，第二份拷贝） | `paneRegistry.ts:77-81` | 标题 → `行星 · P847` |
| D3 | `PLANET_COLORS`（3 色） | `OrbitPanel.tsx:9-13` | 全部 `#38bdf8`，星图失去可辨识性 |
| D4 | `PROFILES`（3 套 3D 剖面） | `Planet3DCanvas.tsx:38-69`，`:398` `?? PROFILES.P2` | 1000 颗行星渲染成**同一颗 P2**（同 seed、同群系、同大气色） |
| D5 | `PLANET_ROTATION_DAYS`（3 条） | `Planet3DCanvas.tsx:32-36`，`PlanetPanel.tsx:65` `?? 1.0` | 全部"24 回合/圈"，遥测数字与 3D 转速一起塌成常量 |
| D6 | `defaultParams` / 预设工作区 / 导航栏（`P1 P2 ST:HUB steel`） | `paneRegistry.ts:60-68`、`DesktopShell.tsx:43-59`、`workspaces.ts:20-31,63,73,78` | 换 production pack 后 `steel` 可能不存在 → 空白面板但标题照旧 |

再加：

- **D7 各面板内部 fallback 也写死实体**：`'P2'`（PlanetPanel:39, DemandPanel:9）、`'P1'`（FactoryPanel:11, CargoPanel:17, TreasuryPanel:12）、`'ST:P1'`（FleetPanel:25）、`'steel'`（ChartPanel:340, OrderBookPanel:18）、`'mine_smelter'`（FactoryPanel:12）。
- **D8 `locationLabel` 以裸 id 兜底**（`meridian.ts:324-329`）：把"解析失败"伪装成"正常显示"，问题不会暴露，只会一直错下去。
- **D9 后端也存在物品 id 字面量**：`planet.rs:223-243` 里 `disposal_cert` / `building_mat` 的特判——UI 依赖这两个特殊物品（废料服务 / 建材），但没有任何视觉标记说明"它是特殊物品"。

### 根因 E｜全量快照当搜索引擎（数据层把问题放大一个数量级）

- **E1 每 tick 一次全量 `/api/state`**：`useGameStore.ts:214-243`。响应里含 `planets`（全部）、`market_tickers`（**站点 × 物品** 笛卡尔积，`engine.rs:453-478`）、`leaderboard`、`player_snapshot`；快照里还有 `quotes`/`depths`（**站点 × 物品** 全叉积，`world.rs:1746-1766`）和 `all_orders`（**全服所有挂单**，`world.rs:1762`）。
  - 关键讽刺：`quotes`/`depths` 在 `types/meridian.ts:190-210` 里**根本没有声明**，全前台 0 处使用——成本付了，一个字节没用。
  - 量级：N=1000 行星（≈1001 站点）× M=1000 物品 → `market_tickers` ≈ 10⁶ 行。**每 2 秒一个百万行 JSON**。
- **E2 `quoteHistory` 每 tick 为每个 `(station,item)` key 复制一个 ≤500 长数组**（`useGameStore.ts:24-43`）：S×I 个 key（4000 起），稳态内存 2×10⁶ 个对象（约 60~160MB），而其中只有当前焦点的 1 个 key 会被 `ChartPanel` 用到。
- **E3 两个 picker 每 tick 重建全部实体索引**：`CommandPalette.tsx:82` `[planets, items]`、`paneComponents.tsx:124` `[state, catalog]`——`state` 每 tick 整体替换（`useGameStore.ts:245-273`），所以 useMemo 永久失效。N=1000 时每 tick 分配 3000~6000 个对象；搜索是 O(N) `includes`，无 debounce、无倒排、无分桶。
- **E4 长列表全量 map，无上界**：TickerPanel 1000 个 `<tr>`（`TickerPanel.tsx:52-81`）、TreasuryPanel 1000 张卡（`:88-97`）、CargoPanel 1000 卡 + 1000 个零库存 chip（`:65-98`）、DemandPanel 数百行（`:92-131`）、FleetPanel 1000 个受控 `<input>`（`:182-211`）。
- **E5 每个盯盘面板每 tick 一次 HTTP fanout**：`watchBook` 引用计数（`useGameStore.ts:320-348`）→ `Promise.all` 里每个 key 一个请求（`:232-238`）。并排开 20 个物品的 K 线（这正是"上万物品"下的正常用法）= 每 tick 21 个请求。
- **E6 渲染体内建 Map / 全表 filter**：`TickerPanel.tsx:12-14`、`OrderBookPanel.tsx:29-32`、`DemandPanel.tsx:28-37`、`FleetPanel.tsx:45`；`FactoryPanel.tsx:98-100` 更是在"地块 × 建筑"双层循环里做全量 recipes filter = **O(B×R) 每次渲染**。
- **E7 脚本侧同样全量**：`ConsolePanel.tsx:353-374` 每次求值把 N 条 `const RESOURCE_*` 拼进源码再 `new Function` 编译（10000 物品 → 约 400KB 源码）；`ScriptIdePanel.tsx:65-72` 每次补全在 N 条 option 上过滤。
- **E8 后端 `compute_demands` 是 O(行星 × 物品)**：`planet.rs:223-243`，在每 tick 每个有城市的行星 + 每次 snapshot 请求上各跑一次。

### 根因 F｜壳层是放大器

- **F1 浮窗无上限、无窗口清单、无切换器**：`DesktopShell.tsx:108-128`；层叠偏移写死 `(seq % 6) * 26`（`:111`），**第 7 个窗口起完全重叠**。而"钻取"的唯一实现就是"每次点击新开一个浮窗"（`OrbitPanel.tsx:82`、`PlanetPanel.tsx:205,211,217,223`、`TickerPanel.tsx:68,74`、`DemandPanel.tsx:117,123`、`CargoPanel.tsx:72`）→ 看 30 颗行星 = 30 个窗、25 个完全重叠、无法列举。
- **F2 每个浮窗是一次全量挂载**：`FloatingWindowsLayer.tsx:51-174` 对每个窗口渲染完整 `PaneRenderer`（含图表 canvas、3D 球、`watchBook` 订阅），DOM 与订阅线性累积。

### 根因 G｜数据契约与 UI 契约错位（需要产品/后端决策）

- **G1 物品由 production pack 定义，但前端 8 处把物品 id 当常量**（见 D7）。换 pack 不会报错，只会静默空白。
- **G2 "星系"是后端尚不存在的实体轴**。UI 无法"先做"——必须先定 core 的 `SystemId`/`GalaxyId` 与 `/api` 的分页查询接口，否则前端只能继续做全量枚举。

---

## 3. 专项：三个"静默错误"（比不可用危险）

1. **无效 id 显示成第一颗行星**：`PlanetPanel.tsx:46`、`DemandPanel.tsx:16`、`FactoryPanel.tsx:16` 都是 `find(...) ?? planets[0]`。配合"工作区/localStorage 不校验实体"（`workspaces.ts:93-111`），一次世界重置后 8 个 tile 全部安静地显示 P1 的数据，**标题还写着旧 id**。玩家会据此下单。
2. **央行下拉 999/1000 项静默失败**：`TreasuryPanel.tsx:57-67` 枚举全部行星，但后端 `world.rs:1348-1359` 硬性要求 `home_planet_id == planet_id`；而 intent 只是入队就返回 `{ok:true}`（`client.ts:73-79`），拒绝发生在 2 秒后的 tick，前端从不展示 rejected intents。玩家点"存入"，UI 无任何提示。
3. **无效 id 被伪装成"正常的空"**：`CargoPanel.tsx:23-29` 的 `?? {}` → 无效站点显示"当前仓库暂无存货"（`:63`），与真实空仓完全同形；`OrderBookPanel` 的 `book === undefined` → "暂无买单/暂无卖单"；`ChartPanel` 的 catch 分支伪造空蜡烛（`:465-541`）→ 永远停在"加载市场行情中..."；后端其实明确返回 404 `Unknown station/item`（`api.rs:145-150`）。

---

## 4. 目标形态（改造蓝图）

### 4.1 先补三层地基

1. **实体索引（Entity Index）**：`{type: 'planet'|'station'|'item'|'recipe'|'building', id, name, parent?, facets}`。以 `id → entity` 与 `type → 已排序列表` 两种形态驻留 store；提供 `name(id)` / `exists(type,id)` / `parent(id)`。**这是替换全部 6 张硬编码表的唯一手段**，也是所有标题、兜底、跳转的统一来源。
2. **实体选择器（EntityPicker）**：一个受控组件 = 搜索框（防抖 + 预建小写索引）→ 分面 chips（星系 / 职业 / 需求类别 / wealth_tier）→ 虚拟滚动结果列表 → 键盘导航（↑↓/Enter）→ "最近访问 / 收藏"分组。**一处实现，四处复用**（Chart/OrderBook/Treasury/Fleet/Factory/Cargo/Planet 全部替换）。
3. **层级 + 深链**：`PaneParams` 升级为可判别联合 `{entity, id}` 或 `{query}`（查询意图，如 `{focus:'home'}`）；`PaneMeta` 增加 `entityType` / `titleFn(params, index)`；pane 树序列化进 URL，使"打开 P4821 的遥测"是一个可分享、可前进后退的地址。

### 4.2 再拆数据面

- `/api/state` 拆成「轻量摘要（tick/现金/我的实体计数）」+「按需详情」，删除前端未使用的 `quotes/depths/all_orders`；
- `market_tickers` 改为按站点或按订阅返回，禁止全宇宙笛卡尔积；
- `quoteHistory` 改为只对已打开的 book 采样（当前 `watchBook` 已有引用计数，直接复用）。

### 4.3 落地顺序（建议）

| 优先级 | 动作 | 解决 |
|---|---|---|
| P0 | 实体索引 + `name()/exists()`，删掉 6 张硬编码表与全部 `?? planets[0]` | D1~D8、A4、A9、静默错误 1/3 |
| P0 | 把 4 面胶囊墙 / 9 个 select 换成统一 EntityPicker（含搜索/分面/虚拟滚动） | B1~B3、A8 |
| P1 | `PaneParams` 可判别联合 + `titleFn` 派生标题（不落库）+ 各面板 params 同步 | A1~A4 |
| P1 | `/api/state` 瘦身 + tickers 分页/订阅；`quoteHistory` 收窄 | E1~E5 |
| P2 | 新增「物品目录 / 配方反查」面板，消费 `role/profession/inputs/outputs` | C3、物品无实体页 |
| P2 | 并行导航：tile 复用（含 Tab 组）+ 浮窗清单/上限 + 面包屑 | F1、A6、C4 |
| P3 | 星图 LOD：星系级聚合 → 放大展开行星；行星外观由 seed/后端字段派生 | C1/C2、D4/D5 |

---

## 5. 附录：一次性可摘的低垂果实

- `paneComponents.tsx:128` `slice(0,12)` → 让 console/script/memory 在空查询下不可见，改成"功能窗口"固定分组 + 实体结果独立分区。
- `CommandPalette.tsx:72` `items.slice(0, 10)` → 直接删除，改为"物品按类别分面"。
- `FactoryPanel.tsx:30` 的 `flex items-center gap-1` 缺 `flex-wrap` 且无 `overflow-x-auto` → 1000 个按钮直接溢出不可点。
- `TickerPanel.tsx:12-14` 等 5 处渲染体内建 Map/filter → 抽 `useMemo`，且 tickers 预建 `station → rows` 索引。
- `ChartPanel.tsx:1067-1068` `<option value={itemId}>{itemId}</option>` → 至少显示"未知物品 (id)"。
- `OrderBookPanel.tsx:34-36` 挂载时不调 `setTitle` → 带 itemId 打开时标题就是裸 id。

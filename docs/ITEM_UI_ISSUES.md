# 物品维度 · 具体问题点清单（可执行）

> 范围：物品 / 配方 / 建筑 / 库存 / 行情的 UI 与相关数据面。星系/行星问题已单独记录在 `UI_SCALABILITY_AUDIT.md`，本文不涉及。
> 基线：16 物品 / 7 建筑 / 18 配方 / 3 需求类别 / 4 站点。目标：上千物品、上千站点。
> 全部 `文件:行号` 已逐行核对。

## 0. 诊断

**当前所有物品相关面板都是「位置中心」的**（这个仓库有什么、这个站点有什么、这个行星缺什么），
**缺少「物品中心」的**（这个物品在哪、我持有多少、谁在出价、它由什么做、用来做什么）。

再加上三个共用的缺失：**没有可搜索的物品选择器**、**没有物品实体页**、**catalog 的分面字段零消费**。
==> 于是所有入口只能是"把 catalog 全量枚举进下拉/列表"。

---

## 1. 入口：选物品 / 选建筑 / 选配方（6 条）

| # | 问题 | 证据 | 上千物品时 | 修法 |
|---|---|---|---|---|
| I-01 | K线物品下拉 = 原生 `<select>` 全量枚举，无搜索无分面 | `ChartPanel.tsx:1062-1076` | 1000 个 option，原生弹层约 20 行可见、无过滤框、中文名无法拼音跳转 | 换 `ItemPicker` |
| I-02 | 盘口物品下拉同一模式，且连 catalog 为空的分支都没有 | `OrderBookPanel.tsx:71-84` | 同上；空 catalog 时下拉为空但 value 仍是 `steel` | 换 `ItemPicker` |
| I-03 | 建筑下拉只有名字，`build_cost/slots_used/build_ticks/profession/description` 全不显示 | `FactoryPanel.tsx:43-53`（类型见 `types/meridian.ts:37-46`） | 1000 个建筑 = 1000 个只有名字的选项，玩家无法判断造价/占地/职业加成，选择退化成随机点 | 带计量格的选择器；按 profession 分组 |
| I-04 | 建筑下拉默认值写死 `'mine_smelter'`，且"值不在 options 里"时不报错 | `FactoryPanel.tsx:12`、`:54-65` | 换 pack 后 select 显示空白（Chromium selectedIndex=-1），但点「建造设施」仍把旧 id 发出去 | 默认值从 catalog 派生；提交前校验 |
| I-05 | 配方下拉只有名字，`inputs/outputs/power_cost/labor_cost/cycle_ticks` 全不显示；且 filter 在"地块×建筑"双层循环里做全量扫描 | `FactoryPanel.tsx:98-100`、`:115-129`、`:165-168` | 1000 配方时等于无法决策这条配方吃什么、产什么；O(B×R)=10 万次比较/每次渲染、每 2 秒重做 | 配方按 building 预建 Map；下拉项显示 in→out |
| I-06 | `⌘K` 只把**前 10 个**物品做进搜索索引 | `CommandPalette.tsx:72` `items.slice(0, 10)` | 物品从"能搜"退化为"只有 10 个能搜"，第 11 个起在全局搜索里不存在 | 删掉 slice，改为按类别分组/分面 |

## 2. 命名与身份（5 条）

| # | 问题 | 证据 | 影响 | 修法 |
|---|---|---|---|---|
| I-07 | 物品/建筑/配方标题永不解析 name —— `formatPaneTitle` 是拿不到 catalog 的纯函数 | `paneRegistry.ts:107-116` ps `mine_smelter` | 同时开 6 个 K 线窗，标题全是 `K线 · steel @ 枢纽`，无法区分/无法截图上报 | 注册表加 `titleFn(params, index)`，由实体索引派生 |
| I-08 | 没有单一 `itemName()` 访问器，5 个面板各自 `new Map(catalog.items)` | `TickerPanel.tsx:12`、`OrderBookPanel.tsx:29`、`DemandPanel.tsx:28`、`FleetPanel.tsx:45`、`ChartPanel.tsx:375`（仅此处 memo） | 每 tick 重建 5 次 1000 元素 Map；且解析规则会各自漂移 | 提到 store 的 `catalogIndex`（catalog 引用稳定，memo 一次） |
| I-09 | 各处 `?? id` 兜底把解析失败渲染成"正常" | `TickerPanel.tsx:55`、`OrderBookPanel.tsx:35`、`FactoryPanel.tsx:110,156`、`ChartPanel.tsx:1068` | 上千物品时满屏 `building_mat`/`ST:P847` | 统一 `unknownItem(id)` 空状态 |
| I-10 | 默认物品/站点硬编码：`'steel'` × 4 处、`'ST:HUB'` × 6 处 | `ChartPanel.tsx:339-340`、`OrderBookPanel.tsx:17-18`、`paneRegistry.ts:66-67`、`DesktopShell.tsx:51-52`、`workspaces.ts:26,63,73`、`paneComponents.tsx:114,120` | 换 pack 后默认面板指向不存在的物品 | defaultParams 只带查询意图（如 `{focus:'first-tradable'}`） |
| I-11 | 成交流水显示 `seller_id → buyer_id` 裸公司 id | `OrderBookPanel.tsx:208` | 上千公司时不可读，也无法点进公司 | 走公司名索引 + 可点击 |

## 3. 物品实体缺失（5 条）

| # | 问题 | 证据 | 影响 |
|---|---|---|---|
| I-12 | **没有物品目录 / 物品详情面板** | `paneRegistry.ts:58-74` 15 个 pane 无 item 类 | 无法回答"钢由哪几条配方产出、哪些建筑能产、我的哪条产线在吃它" |
| I-13 | `RecipeDef.inputs/outputs`、`BuildingDef.build_cost`、`ItemDef.profession/demand_category/wealth_tier/tags` 在 `frontend/src` **只存在于类型声明** | `types/meridian.ts:19-57` 全仓无读取点（仅 `CargoPanel` 用 role 上色、`FleetPanel` 用 tags） | 分面数据早就有了，UI 层一个没接 |
| I-14 | `demand_categories` 在 pack 里有，但 `ProductionPack` 类型里**没有这个字段** | `data/production.json` 顶层有 3 条；`types/meridian.ts:60-72` 未声明 | 连"按需求类别分组"的类型都拿不到 |
| I-15 | 缺「物品中心」视图：一个物品在所有地点的库存 + 我的挂单 + 最近行情聚合 | `CargoPanel.tsx` 只能一次看一个 location | 1000 物品 × 多站点时，玩家无法回答"我有多少钢、都堆在哪、在哪个站有挂单" |
| I-16 | 缺跨物品的挂单总览：`ownOrders` 只过滤当前 station+item | `OrderBookPanel.tsx:30-32` | 在 50 个物品上有挂单就再也查不全了，只能逐个开面板 |

## 4. 列表渲染与性能（7 条）

| # | 问题 | 证据 | 上千物品时 |
|---|---|---|---|
| I-17 | 行情表全量 `<tr>`，且 Map/filter 写在渲染体内 | `TickerPanel.tsx:12-14`、`:52-81` | 1000 物品 ≈ 1 万 DOM 节点，每 2 秒重建；且无排序/无"只看有行情"/无分类分面 |
| I-18 | 仓库把 **整个 catalog 渲染两遍**：有货卡 + 零库存 chip | `CargoPanel.tsx:36-42`、`:65-98` | 300 张卡 + 700 个纯噪音 chip，真正要看的库存被挤出首屏 |
| I-19 | 需求表全表平铺 + 每渲染 O(站点×物品) 扫 tickers | `DemandPanel.tsx:28-37`、`:92-131` | 单行星需求可达数百行；`demand_category` 分面完全未用 |
| I-20 | 装货清单按库存每个物品渲染受控 `<input>` | `FleetPanel.tsx:182-211` | 1000 个受控 input，任一按键 diff 1000 个 props；`max-h-40` 里滚 50 屏 |
| I-21 | 控制台每次求值把全部物品拼成 N 条 `const RESOURCE_*` 再 `new Function` | `ConsolePanel.tsx:353-374` | 10000 物品 ≈ 400KB 源码/次编译；且 `id` 含 `-` 或数字开头会 SyntaxError |
| I-22 | 脚本补全把全部物品塞进补全源 | `ScriptIdePanel.tsx:65-72` | 每次按键在 N 条 option 上过滤；且只支持 id→常量，不支持中文名→id 反查 |
| I-23 | 全库 `React.memo` / 虚拟滚动 / `useDeferredValue` 使用数 = **0** | `grep` 命中 0 | 所有面板订阅整个 `state`（每 tick 换引用）→ 100% 强制重渲染 |

## 5. 物品 × 站点 数据面（4 条）

| # | 问题 | 证据 | 量级（1000 站点 × 1000 物品） |
|---|---|---|---|
| I-24 | `market_tickers` = 站点 × 物品笛卡尔积，每 tick 全量下发 | `engine.rs:453-478`、`:703-717`；前端 `useGameStore.ts:231-243` | ≈10⁶ 行/次，每 2 秒一次 |
| I-25 | 快照里 `quotes`/`depths` 是对每个站点×物品的全量报价与深度，**前端类型里根本没声明、0 处使用** | `world.rs:1746-1766`；`types/meridian.ts:190-210` | 成本全付，收益为 0 |
| I-26 | `quoteHistory` 每 tick 为每个 (站点,物品) key 复制 ≤500 长数组 | `useGameStore.ts:24-43` | 10⁶ 级 key × 500 对象的内存与拷贝 |
| I-27 | 每个盯盘面板每 tick 一次 HTTP fanout | `useGameStore.ts:232-238` + `watchBook` `:320-348` | 并排 20 个物品 K 线 = 每 tick 21 个请求 |

## 6. 具体正确性 bug（可直接修）

| # | 问题 | 证据 |
|---|---|---|
| I-28 | **瞬时货物判定前后端不一致**：前端查 `tags.includes('instant')`，后端是 `has_tag('power') \|\| has_tag('waste_service')`；当前 pack 里没有任何物品带 `instant` 标签 → 该过滤**永不命中** | `FleetPanel.tsx:187` vs `schema.rs:337-342`（`power`/1 `disposal_cert` 实为瞬时货物） |
| I-29 | 仓库点物品时用 `ST:${loc}` 猜站点（地面仓 → 该行星轨道站） | `CargoPanel.tsx:21,25,68` |
| I-30 | 盘口挂载时不调 `setTitle`（仅 onChange 调）→ 带 itemId 打开的 tile 标题是裸 id | `OrderBookPanel.tsx:34-36` |
| I-31 | 面板把 params 复制进 `useState` 却无同步 effect（Ticker/Factory/OrderBook/Cargo/Treasury 五个） | `TickerPanel.tsx:9`、`FactoryPanel.tsx:11`、`OrderBookPanel.tsx:17-18`、`CargoPanel.tsx:17`、`TreasuryPanel.tsx:12` |

---

## 7. 建议落地顺序

**P0（一个 PR，只做物品，不碰壳层）**
1. `catalogIndex`（store 派生）：`itemsById`、`itemName(id)`、`buildingsByProfession`、`recipesByBuilding`、`demandCategories`；补 `ProductionPack.demand_categories` 类型。
2. `ItemPicker` 组件：搜索（防抖 + 预建小写/别名索引）+ 分面 chips（需求类别 / role / profession / tags）+ 键盘 + 虚拟滚动。
3. 替换 I-01/02/03/05 四个下拉 + I-06 的 slice。
4. 修 I-28（瞬时货物，直接改成后端同源判定）、I-29、I-30、I-31。
5. 删掉所有 `'steel'`/`'mine_smelter'` 硬编码默认值（I-10）。

**P1**
6. 新增「物品目录」面板（分面 + 虚拟滚动）+ 从目录点开「物品详情」聚合（库存 / 挂单 / 行情 / 配方 in-out / 产线反查）→ 解决 I-12/I-13/I-15。
7. 跨物品挂单总览（I-16）。
8. 行情表 / 仓库 / 需求表加 `useMemo` + 虚拟化 + "只看有行情/有库存"开关（I-17/18/19/23）。
9. 标题改 `titleFn` 派生不落库（I-07）。

**P2**
10. `/api/state` 拆分：`market_tickers` 按站点或按订阅返回，删除前端未用的 `quotes/depths`；`quoteHistory` 只对已打开的 book 采样（I-24~27）。
11. 控制台/补全改为惰性注入（只在用到时注入 `RESOURCE_*`，或改用 `Game.items` 查表）（I-21/22）。

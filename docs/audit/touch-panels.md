# Meridian 触摸适配审计 · C 卷：业务面板与通用组件

> 审计对象：`frontend/src/panels/*`、`frontend/src/auth/AuthScreen.tsx`、`frontend/src/components/SearchSelect.tsx`、
> `frontend/src/components/VirtualList.tsx`、`frontend/src/layout/EntitySearchList.tsx`、`frontend/src/styles/index.css`。
> 只读审计：未修改任何前端源码，未运行 build / dev server。
> 阅读方式：逐文件通读 + 交叉 grep 定位，所有结论均来自实际代码行，未根据文件名推测。

---

## 0. 审计方法与判定标准

### 0.1 已通读的文件（行数）

| 文件 | 行数 | 备注 |
| --- | --- | --- |
| `frontend/src/components/SearchSelect.tsx` | 363 | 全站唯一实体选择器，13 处调用 |
| `frontend/src/components/VirtualList.tsx` | 86 | 全部长列表的滚动容器 |
| `frontend/src/layout/EntitySearchList.tsx` | 147 | 空窗口选择器 + ⌘K |
| `frontend/src/auth/AuthScreen.tsx` | 475 | 登录 / 注册 |
| `frontend/src/panels/TickerPanel.tsx` | 324 | 行情总览 |
| `frontend/src/panels/OrderBookPanel.tsx` | 439 | 盘口 + 下单 |
| `frontend/src/panels/FleetPanel.tsx` | 543 | 舰队与装货发运 |
| `frontend/src/panels/FactoryPanel.tsx` | 365 | 产线与建造 |
| `frontend/src/panels/CargoPanel.tsx` | 319 | 仓库库存 |
| `frontend/src/panels/DemandPanel.tsx` | 322 | 城市需求 |
| `frontend/src/panels/ItemListPanel.tsx` | 265 | 物品目录 |
| `frontend/src/panels/ItemDetailPanel.tsx` | 280 | 物品详情 |
| `frontend/src/panels/TreasuryPanel.tsx` | 278 | 财务与央行 |
| `frontend/src/panels/FileExplorerPanel.tsx` | 550 | 脚本工作区（拖拽 / 树） |
| `frontend/src/panels/ScriptIdePanel.tsx` | 249 | CodeMirror 编辑器 |
| `frontend/src/panels/MemoryPanel.tsx` | 166 | Memory JSON |
| `frontend/src/panels/ConsolePanel.tsx` | 489 | F12 控制台 |
| `frontend/src/panels/SettingsPanel.tsx` | 786 | 账号 / 会话 / 关于 |
| `frontend/src/panels/OrbitPanel.tsx` | 111 | SVG 轨道图 |
| `frontend/src/panels/PlanetPanel.tsx` | 270 | 行星遥测 |
| `frontend/src/panels/RankingPanel.tsx` | 55 | 排行榜 |
| `frontend/src/panels/ApiDocsPanel.tsx` | 29 | 文档外壳 |
| `frontend/src/styles/index.css` | 131 | 全局样式 |
| `frontend/index.html` | 13 | viewport |

### 0.2 辅助定位的 grep（命中数仅统计本卷范围）

```
group-hover|onMouseEnter|onMouseLeave|onContextMenu|onDoubleClick|text-[10px]|text-[11px]   259 处
  ├─ text-[10px] / text-[11px]                                                              254
  ├─ group-hover                                                                              3（FileExplorerPanel.tsx:266,405 / AuthScreen.tsx:447）
  ├─ onMouseEnter                                                                             2（SearchSelect.tsx:333 / EntitySearchList.tsx:123）
  ├─ onContextMenu                                                                            0
  └─ onDoubleClick                                                                            0
title=                                                                                       48 处（frontend/src 全量 67）
pointer: coarse | touch-action | overscroll | onTouch*                                       0 处（frontend/src 内）
@media                                                                                       1 处（docs/docs.css:2 的 @media print）
overflow-x                                                                                   0 处（frontend/src/panels 内）
<SearchSelect                                                                               13 处
```

**这行 grep 结果是本卷最重要的单一事实**：整个前端没有任何 `@media (pointer: coarse)`、没有 `touch-action`、
没有 `overscroll-behavior`、没有一处触摸事件。所有交互都是 `onClick` + `hover:` 假设鼠标。

### 0.3 判定阈值（本文使用的硬指标）

- 命中目标 ≥ 44×44 CSS px（Apple HIG）/ 48dp（Android）；本卷大量目标只有 12–26px。
- 触摸没有 hover、没有右键、没有 title 提示、没有精确光标（手指落点约 ±10px）。
- 输入框字号 < 16px → iOS Safari 聚焦即自动放大页面。
- 拖拽 / 嵌套滚动与页面滚动争抢手势。

> 高度换算基准：`html,body,#root { font-size: 12px }`（`frontend/src/styles/index.css:20`），
> Tailwind 默认 line-height≈1.2–1.5。所以 `text-[10px]` + `py-0` 的实际高度约 **12–16px**，
> `pill-btn`（`index.css:64-67`，font-size 11px / padding 2px 8px）约 **18–21px**，
> `cta-blue/cta-green`（`index.css:84-112`，padding 3px 10px）约 **22–24px**。

---

## 1. 优先级总览

**P0 ＝ 触摸设备上核心循环走不通，或一次误触造成不可逆损失（删脚本、误拆建筑、错价下单）。**
**P1 ＝ 能做完但代价明显（反复误触、被遮挡、发现不了功能）。**
**P2 ＝ 观感与可发现性小问题。**

| 编号 | 严重度 | 玩家最痛的一句 | 位置 |
| --- | --- | --- | --- |
| G1 | **P0** | 点任何一个输入框，整个游戏就放大一次 | 见 G1（20+ 处） |
| G3 | **P0** | 禁用按钮为什么点不动？触摸永远不告诉你 | 见 G3（48 处 title） |
| C-01 | **P0** | 想开 K 线，结果跳进了物品详情 | `TickerPanel.tsx:289-309` |
| C-02 | **P0** | 手指一滑，按错价位就下了一张真单 | `OrderBookPanel.tsx:298-373` |
| C-03 | **P0** | 想暂停产线，结果把建筑拆了 | `FactoryPanel.tsx:225-242` |
| C-06 | **P0** | 手机上永远只能看到一半的舰队 | `FleetPanel.tsx:28, 198, 284-330` |
| C-08 | **P0** | 交易界面只剩一排数字，看不出在交易什么 | `DemandPanel.tsx:9` 等，见 C-08 |
| C-13 | **P0** | 键盘一弹，候选列表正好被盖住 | `SearchSelect.tsx:128-154, 194, 249-259` |
| C-18 | **P0** | 屏幕上什么都看不见，却已经弹出「删除脚本？」 | `FileExplorerPanel.tsx:265-306, 403-426` |
| C-19 | **P0** | 平板上永远无法把脚本放进分类目录 | `FileExplorerPanel.tsx:190-223, 336-370` |
| C-24 | **P0** | 登录时提交按钮躲在键盘后面，还滚不出来 | `AuthScreen.tsx:130-131, 235-257, 434-450` |
| G2 | P1 | 连点两下按钮，页面反而放大了 | 全仓 0 处 `touch-action` |
| G4 | P1 | 右半张表被切掉，怎么滑都滑不出来 | `styles/index.css:9-21` |
| G5 | P1 | 点第 3 只物品，打开的是第 4 只 | 见 G5 表格（9 处行高） |
| G6 | P1 | 想筛「金属」，筛到了「食品」 | 见 G6（6 处 chip 墙） |
| C-04 | P1 | 点「借款」没反应，也不知道为什么 | `TreasuryPanel.tsx:174-205` |
| C-05 | P1 | 在 160px 的小框里滚半天，才找到数量框 | `FleetPanel.tsx:460-515` |
| C-07 | P1 | 修不了船，也看不到缺什么 | `FleetPanel.tsx:395-407` |
| C-09 | P1 | 根本不知道表头能点 | `TickerPanel.tsx:192-201` |
| C-10 | P1 | 换行的行会和下一行叠在一起 | `VirtualList.tsx:59-74` |
| C-11 | P1 | 手指在哪儿滑都不动，或者一下滑过头 | `ItemDetailPanel.tsx:149,160,186,211` |
| C-14 | P1 | 选择站点时点到了隔壁站点 | `SearchSelect.tsx:231,336` |
| C-15 | P1 | 按下的瞬间没有任何"我选的是这条"的反馈 | `SearchSelect.tsx:333` |
| C-20 | P1 | 误触进入重命名后，触屏上无法退出 | `FileExplorerPanel.tsx:248-259, 386-397` |
| C-21 | P1 | 一写代码就放大，光标还被键盘吃掉 | `ScriptIdePanel.tsx:119, 246` |
| C-22 | P1 | 触屏上无法召回上一条命令 | `ConsolePanel.tsx:455-486` |
| C-23 | P1 | 改一行 Memory 要跟放大和键盘搏斗 | `MemoryPanel.tsx:157-161` |
| C-25 | P1 | 想刷新列表，把其他设备全登出了 | `SettingsPanel.tsx:43-47, 664-694` |
| C-27 | P1 | 手机上点不到任何一个行星 | `OrbitPanel.tsx:72-91` |
| C-28 | P1 | 那四个蓝色字原来是能点的？ | `PlanetPanel.tsx:202-227` |
| C-29 | P1 | 想把面板往下滑，结果在转星球 | `PlanetPanel.tsx:94, 258-266` |
| C-12 | P2 | 9px 的中文，屏幕上像一排噪点 | `TickerPanel.tsx:219,240` 等 |
| C-16 | P2 | 底部写着「↑↓ Enter Esc」，手机上没法用 | `SearchSelect.tsx:355-357` |
| C-17 | P2 | 点一下空窗口，键盘就弹出来盖住列表 | `EntitySearchList.tsx:6,76,125` |
| C-26 | P2 | （非触摸项，仅记录版本文案） | `SettingsPanel.tsx:711` |
| C-30 | P2 | 排行榜的公司名被压成竖排单字 | `RankingPanel.tsx:18-51` |

**合计 36 项：P0 共 11 项、P1 共 20 项、P2 共 5 项。** 其中 G1/G3 是两条"改一次、全站受益"的横切项，
建议先做（见第 11 节）。

---

## 2. 横切问题（G 组：跨全部面板）

### G1 【P0】全站输入框字号 11–13px，iOS 聚焦即整页放大

**玩家视角**：在手机上点「搜索物品」、点「单价」、点「密码」——游戏画面"砰"地放大一倍，
面板被裁掉一大半，必须双击或捏合缩回去。每点一次输入框，就要重复一次这个动作。

**位置**（实际生效的字号，全部 < 16px）：

| 位置 | 字号 |
| --- | --- |
| `frontend/src/auth/AuthScreen.tsx:130-131` | `text-[13px]`（昵称/邮箱/密码/确认密码共用 `INPUT_BASE`） |
| `frontend/src/panels/SettingsPanel.tsx:32-33` | `text-[12px]`（昵称、3 个密码框） |
| `frontend/src/components/SearchSelect.tsx:273` | `text-[12px]`（搜索框） |
| `frontend/src/layout/EntitySearchList.tsx:83` | `text-[12px]` |
| `frontend/src/panels/TickerPanel.tsx:217` | `text-[11px]` |
| `frontend/src/panels/CargoPanel.tsx:194` | `text-[11px]` |
| `frontend/src/panels/DemandPanel.tsx:208` | `text-[11px]` |
| `frontend/src/panels/ItemListPanel.tsx:146` | `text-[11px]` |
| `frontend/src/panels/FleetPanel.tsx:273, 447` | `text-[11px]` |
| `frontend/src/panels/TreasuryPanel.tsx:171` | 继承 12px |
| `frontend/src/panels/OrderBookPanel.tsx:349, 360, 368` | `text-[11px]`（下单价/量） |
| `frontend/src/panels/MemoryPanel.tsx:145, 160` | `text-[11px]`（含 128KB JSON 的 textarea） |
| `frontend/src/panels/ScriptIdePanel.tsx:119` | `fontSize: 12px`（CodeMirror contenteditable，同样触发） |
| `frontend/src/panels/FileExplorerPanel.tsx:258, 396, 500` | `text-[11px]`（新建/重命名） |
| `frontend/src/panels/ConsolePanel.tsx:484` | `text-[11px]` |

**触发条件**：iOS Safari 上聚焦任何上述字段。
**修法**：输入类元素统一提到 16px（或 `@media (pointer: coarse)` 下覆盖为 16px），
用 line-height / padding 保持视觉尺寸不变；这是唯一**零风险、一次性**消除整类问题的改动。

### G2 【P1】零触摸适配 + 无 `touch-action: manipulation`

**玩家视角**：连点两下「买入」——第一下没确认上，第二下变成了页面缩放；
手指按住列表想滚动，某些按钮却出现长按菜单的观感。

**位置**：`grep -rn 'pointer: coarse|@media|touch-action|overscroll|onTouch' frontend/src` → **0 命中**
（全仓唯一 `@media` 是 `frontend/src/docs/docs.css:2` 的 `@media print`）；
viewport 声明见 `frontend/index.html:5`（`width=device-width, initial-scale=1.0`，允许缩放）。
**修法**：给 `html` 加 `touch-action: manipulation`（禁双击缩放，保留捏合）；
建立 `@media (pointer: coarse)` 层，统一放大可点目标。

### G3 【P0】`title=` 承担了解释职责，触摸永远看不到（67 处，本卷 48 处）

**玩家视角**：三个按钮是灰的，怎么点都没反应；它为什么不让我点？——答案写在鼠标悬停提示里，
而手指没有"悬停"。

**最要命的 6 处**（提示内容是**唯一**的解释来源，页面上没有任何等价文字）：

| 位置 | title 内容 | 后果 |
| --- | --- | --- |
| `TreasuryPanel.tsx:177,185,193,201` | 「现金不足或存贷已禁用」「央行准备金不足…」 | 4 个银行按钮为什么灰着，触屏玩家永远不知道 |
| `FleetPanel.tsx:399` | 「消耗维修件将耐久恢复到 100%」/ `repairHint` | 修不了船也看不到缺什么 |
| `OrderBookPanel.tsx:303,328` | 「点击填入下单价格」 | 深度行可以点这件事，触屏完全发现不了 |
| `FileExplorerPanel.tsx:371` | 「拖动到文件夹或空白根目录可移动分类」 | 拖拽这个唯一归类方式，连说明都看不到 |
| `TickerPanel.tsx:275` | `${name}（${id}）· ${category}` | 行内名称被截断，全名只存在于 tooltip |
| `SearchSelect.tsx:238` | 当前选中值 | 窄面板里选择器被截断后无补偿 |

**触发条件**：任何触摸设备；`title` 只在鼠标悬停时显示。
**修法**：凡 `title` 里含「为什么不能点 / 怎么操作」的，改成可见文字或 `aria-describedby` 常显；
给 `disabled` 按钮在触屏上直接渲染原因行。

### G4 【P1】`html/body/#root` 永久 `overflow: hidden`，且没有任何横向滚动容器

**玩家视角**：在 iPad 分屏下打开了「城市需求」，右半张表（含 K 线/盘口按钮）被切掉，
无论怎么滑都滑不出来——因为整页禁止滚动。

**位置**：
- `frontend/src/styles/index.css:9-21`：`html, body, #root { width/height:100%; overflow:hidden }`
- `grep -rn 'overflow-x' frontend/src/panels` → **0 命中**：所有"表格"都是 `grid` 固定列，
  宽度不够时压缩列宽而不是滚动（见 C-08）。

**修法**：面板级表格容器给 `overflow-x:auto` + 内容 `min-width`；或改为卡片式重排（`@container` / `md:`）。

### G5 【P1】行高 22–26px 的「整行可点」

**玩家视角**：点第 3 行的物品，打开的常常是第 2 行或第 4 行；越往下点越容易错。

**位置**（行高 → 点击目标）：

| 面板 | 行高 | 位置 |
| --- | --- | --- |
| Ticker | 22px | `TickerPanel.tsx:25, 274` |
| ItemDetail 行情表 | 22px | `ItemDetailPanel.tsx:250, 261` |
| Treasury 金库表 | 24px | `TreasuryPanel.tsx:9, 254` |
| ItemList | 26px | `ItemListPanel.tsx:27, 235` |
| Cargo | 26px | `CargoPanel.tsx:10, 272` |
| Demand | 26px | `DemandPanel.tsx:10, 285` |
| OrderBook 深度行 | ≈15px | `OrderBookPanel.tsx:298-311, 323-336` |
| SearchSelect 候选行 | 24px | `SearchSelect.tsx:39, 336` |
| EntitySearchList 行 | 32px | `layout/EntitySearchList.tsx:6, 125` |

**修法**：`@media (pointer: coarse)` 下行高 ≥44px（行高本身可保留视觉密度，用透明 padding 扩大命中区）。

### G6 【P1】筛选 chip 墙：14–16px 高、间距 4px、一行十几颗

**玩家视角**：想筛「金属」，手指落在「金属」和「食品」中间，筛出了一张空表，
还以为这个站点没有货。

**位置**（同一套 `text-[10px] px-1.5 py-[1px] border rounded-[2px]` 样式，全站 6 处）：
- `TickerPanel.tsx:229-238`（3 个开关）
- `ItemListPanel.tsx:155-207`（类别 + 角色 + 3 个开关，最多 15+ 颗）
- `CargoPanel.tsx:198-233`
- `DemandPanel.tsx:212-258`
- `SearchSelect.tsx:291-306`（分面 chips）
- `layout/EntitySearchList.tsx:91-106`（分组 chips）

**修法**：触屏下改为 `min-height:44px` 的横向滚动的 pill 条，或收进「筛选」抽屉。

---

## 3. 交易与调度面板（玩家最常走的循环）

### C-01 【P0】行情行内「K线 / 盘口」按钮只有 9px，且与整行点击区重叠

**现象**：玩家在行情表里想对某个物品「开 K 线」。那行里有两只小按钮，
但整行本身就是"打开物品详情"的点击区（`onClick` 在行 div 上）。
手指落在按钮边缘 2px 外 → 打开物品详情（面板被替换掉，K 线没开成）；
落在两按钮之间 → 打开了另一个（盘口）。

**位置**：
- 行容器：`frontend/src/panels/TickerPanel.tsx:272-275`（`h-[22px]` + `onClick={openInPlace}` + `title`）
- 行内按钮：`TickerPanel.tsx:289-309`，`className="pill-btn py-0 text-[9px]"` → 实测高度约 **13–15px**、宽度约 28px
- 同样的两按钮在需求表里：`DemandPanel.tsx:302-315`（`pill-btn py-0 px-1.5 text-[10px]`，与上一行同列）

**触发条件**：任何触摸设备；平板横屏也一样（9px 文字在手指导致的 ±10px 落点抖动面前没有容错）。
**修法**：行内操作改为「行尾显式按钮 + 行本身不响应点击」，或点击行后弹出操作选择；
按钮最小 44×44（可用负 margin 保持视觉紧凑）。

### C-02 【P0】盘口下单：输入框 11px、深度行 ≈15px、「提交限价单」紧贴数量框

**现象**：这是游戏里唯一能亏真钱的地方，也是触摸上最危险的地方。
1. 想点「买一价」那一行把价格填进去 —— 那一行只有 `px-1`、11px 文字、行高约 15px，
   而买卖各 10 档上下紧贴，手指基本落在隔壁档位，填进去的是**别的价格**；
2. 价格/数量是两个 11px 的 `type=number` 输入框（`w-20` / `w-16`），
   聚焦会放大页面（G1），放大后再也看不清"提交"按钮；
3. 「提交限价单」就在数量框右边 6px 处（`gap-1.5`），高度约 22–24px，
   调整数量时手指容易蹭到 → **直接成交**。

**位置**：
- 深度行：`frontend/src/panels/OrderBookPanel.tsx:298-312`（买方）、`:323-337`（卖方），
  `className="relative flex justify-between cursor-pointer hover:bg-… px-1"`（无 padding、无行高）
- 价格输入：`OrderBookPanel.tsx:354-361`；数量输入：`:362-369`
- 提交：`OrderBookPanel.tsx:371-373`；侧别 `<select>`：`:346-353`
- 撤单：`OrderBookPanel.tsx:391-396`（`pill-btn py-0 text-[10px]`）
- 深度行"可点"的唯一说明是 tooltip：`:303`、`:328`（+ 页面上 9px 的 `:370`）

**触发条件**：平板/手机下单；即使只是"想看看能不能填价"也会下一张单。
**修法**：`touch-action: manipulation`；输入框 16px；提交按钮与输入框之间加分隔并加二次确认
（"以 12.30 买入 20 件？"）；深度行改为 ≥44px 且点一次只填价格不触发提交。

### C-03 【P0】「拆除」与「运行中/待机」两个 16px 按钮紧邻，且没有二次确认

**现象**：玩家想暂停一条产线（点「运行中」），手指偏了一个按钮宽，
建筑当场被拆（`DemolishFacility` 直接 sendIntent，无确认、无撤销）。

**位置**：`frontend/src/panels/FactoryPanel.tsx:225-242`
（两个 `pill-btn py-0 text-[10px]`，相邻 `gap-1.5`，处于 `ml-auto … shrink-0` 的小组里）；
同一张卡片里还有配方选择器：`:215-224`（`max-w-[180px]`）。
**触发条件**：触摸设备，且卡片高度固定 92px（`:17`）使这些按钮挤在一行右侧。
**修法**：拆除移到卡片菜单或长按，并要求确认对话框；破坏性按钮与邻近按钮保持 ≥24px 间隔。

### C-04 【P1】财务面板：4 个存/取/借/还按钮 22px，禁用原因只在 title

**现象**：玩家点「借款」，没反应；再点，还是没反应。他不知道为什么（准备金不足的说明在 tooltip 里）。
四个按钮依次是 存入 / 取出 / 借款 / 还款——两两语义相反，高度 22–24px、间距 8px。

**位置**：`frontend/src/panels/TreasuryPanel.tsx:174-205`（`cta-blue` / `cta-green` / `pill-btn`）
+ 金额输入 `:165-172`（`type="number"`，继承 12px → 触发 iOS 放大）。
**修法**：按钮 ≥44px、禁用时在按钮下直接渲染原因文字；金额输入 16px + `inputMode="decimal"`。

### C-05 【P1】装货发运：30px 行里的数量输入 + 内外双层滚动

**现象**：在手机上给货物填数量，先要在 160px 高的小列表里滚动（外面还有一层滚动），
再点一个 22px 高的数字框（会放大页面），填完找「确认启航发运」（22px 高、在列表下方）。

**位置**：
- 内层列表：`frontend/src/panels/FleetPanel.tsx:460-515`（`h-[160px] overflow-y-auto`）
- 行：`FleetPanel.tsx:476`（`h-[30px]`）、数量输入 `:498-511`（`w-16 … py-0.5`）
- 外层滚动：`FleetPanel.tsx:332`（`flex-1 min-h-0 overflow-y-auto`）——**嵌套滚动**
- 提交：`FleetPanel.tsx:526-532`（`cta-green`）

**修法**：数量输入 ≥44px 高、`inputMode="numeric"`；去掉内层固定高度，改为整块随外层滚动；
提交按钮 sticky 在面板底部。

### C-06 【P0】舰队卡片：固定 58px 行高 × `sm:grid-cols-2`，手机竖屏第二艘船被覆盖

**现象**：手机竖屏（viewport < 640px）打开舰队，**一半的飞船看不见**：
每行本该放 2 艘，但 `grid-cols-1` 让它们上下叠放，而虚拟列表给每行的盒子只有 58px，
于是第 2 艘船画到了下一行上面，和第 3 艘船叠在一起。玩家只能点到被叠住的那一艘。

**位置**：
- `frontend/src/panels/FleetPanel.tsx:28`（`SHIP_ROW_HEIGHT = 58`）、`:198`（每 2 艘塞进一行）
- `FleetPanel.tsx:294`：`<div className="grid grid-cols-1 sm:grid-cols-2 gap-2 h-full pr-1">`
- 卡片固定高：`FleetPanel.tsx:305`（`h-[52px]`）
- 行盒由 `frontend/src/components/VirtualList.tsx:67-72` 生成：
  `style={{ position:'absolute', top: i*rowHeight, height: rowHeight }}`，**无 `overflow:hidden`**

**触发条件**：viewport 宽度 < 640px（Tailwind `sm` 断点，`frontend/tailwind.config.js` 未改 screens），
即手机竖屏。平板横屏（1024px）正常 —— 所以这个 bug 一定会在真机验收时暴露。
**修法**：行高改为 2×52+gap 的响应式常量，或干脆每行 1 艘（`rowHeight=58` 时只塞 1 个元素）。

### C-07 【P1】修船按钮：`pill-btn text-[10px]` + 原因只在 title

**位置**：`frontend/src/panels/FleetPanel.tsx:395-407`（`title={canRepair ? … : repairHint}`，`:399`）。
**修法**：同 C-04。

---

## 4. 表格 / 列表 / 虚拟列表

### C-08 【P0】固定列宽表格在窄面板把「物品名」压成 0 宽

**现象**：iPad 分屏（每格 ~384px）打开「城市需求」：左半张表全是数字，
物品名一列宽 0，"操作"列的两只小按钮还在——玩家在**看不见物品名**的情况下点「盘口」。

**位置与列宽算术**（`grid-cols-[…]` 的固定像素列 + `gap-1`(4px) + `px-2`(16px)）：

| 面板 | 固定列 | 最小内容宽度 | 位置 |
| --- | --- | --- | --- |
| Demand | 64+100+62+54+92=372 | **≈408px** | `DemandPanel.tsx:9`（`COLS`）、`:261`、`:285` |
| Ticker | 50+50+50+42+44+84=320 | ≈360px | `TickerPanel.tsx:27`、`:243`、`:274` |
| ItemList | 52+50+50+50+44+36=282 | ≈322px | `ItemListPanel.tsx:210`、`:235` |
| Cargo | 58+72+70+86=286 | ≈318px | `CargoPanel.tsx:9`、`:250`、`:272` |
| Treasury | 90+90+52=232 | ≈260px | `TreasuryPanel.tsx:234`、`:254` |
| ItemDetail 行情 | 56×3+50=218 | ≈250px | `ItemDetailPanel.tsx:240`、`:261` |

（`1fr` 在 `grid` 里的默认 `min-width` 是 `auto`，但这里内容都带 `truncate`，
所以窄到一定程度后名称列直接坍缩为 0，而不是撑开滚动条 —— 这就是 G4 的后果。）
**修法**：`grid-cols-[minmax(96px,1fr)_…]` 给名称列保底宽度 + 表格容器 `overflow-x:auto`；
或窄面板切换为"两行卡片"布局。

### C-09 【P1】表头排序：9px 文字、唯一提示是 hover 变色

**现象**：玩家不知道表头能排。鼠标用户看到悬停变蓝会去点；手指没有任何反馈。

**位置**：
- `TickerPanel.tsx:192-201`（`SortHead`，`title="点击按此列排序"` `:196`；表头行 `:243` `text-[9px]`）
- `ItemListPanel.tsx:124-133`（同款，`:128`）、`:210`
- `DemandPanel.tsx:212-233`（排序做成两个 chip，好一些，但仍 14–16px）
**修法**：表头给常显排序箭头 + ≥44px 高；触屏下把排序收进一个显式的「排序」控件。

### C-10 【P1】VirtualList 的固定行高假设桌面宽度

**现象**：某些行在窄屏会换行（标题两行），行盒还是原来的高度，上下行会互相压住。

**位置**：`frontend/src/components/VirtualList.tsx:59-74`
（`total = count * rowHeight`；行 `style={{position:'absolute', top:i*rowHeight, height:rowHeight}}`）。
**已做得对的部分**：滚动用 `onScroll`（`:51-53, 78-79`），触摸惯性滚动是原生行为，这一点没问题。
**修法**：给行盒加 `overflow:hidden` 防重叠（止血），长期改为 `--row-h` CSS 变量并随 `pointer: coarse` 放大。

### C-11 【P1】嵌套滚动：内层 160px 列表 + 外层滚动区

**现象**：手指在外层面板上滑，滑到内层列表区域就变成滑那个小框；滑到框底再滑，
又开始滑外层——玩家无法预判这一次滑动会动哪一层。

**位置**：
- `ItemDetailPanel.tsx:149`（外层 `overflow-y-auto`）+ `:160`、`:186`、`:211`（三个 `max-h-40 overflow-y-auto`）
- `FleetPanel.tsx:284-285`（`max-h-[208px]`）+ `:332`（外层）
- `FleetPanel.tsx:460-461`（`h-[160px]`）+ `:332`
- `SearchSelect.tsx:284`（分面区 `max-h-[92px] overflow-y-auto`）+ `:320-323`（结果列表滚动）
**修法**：触屏下内层取消滚动（`max-height:none`），或加 `overscroll-behavior: contain`。

### C-12 【P2】排序/筛选之外的"信息型"小字

表头、角标、计数普遍 8–9px：`TickerPanel.tsx:219, 240, 278, 280`、`ItemDetailPanel.tsx:117, 138`、
`CargoPanel.tsx:196`、`OrderBookPanel.tsx:182, 285`。手机上 9px 中文几乎不可读。**修法**：触屏下最小 11px。

---

## 5. 选择器与搜索弹层（SearchSelect / EntitySearchList）

### C-13 【P0】弹层按 `window.innerHeight` 定位 + 打开即聚焦 → 候选列表被键盘盖住

**现象**：玩家点开「选择站点」，弹出搜索层，输入法键盘同时升起；
候选列表正好落在键盘后面，只剩上面一两条能看见，而列表本身还在滚——玩家以为"搜不到这个站点"。

**位置**：
- `frontend/src/components/SearchSelect.tsx:128-154`（`reposition` 用 `window.innerHeight` 计算 `maxHeight` 与上下翻转）
- `SearchSelect.tsx:249-259`（`position: fixed` + `overflow-hidden`）——注意 viewport 变了它并不会重新算
  （只有 `resize` 监听 `:181`，而 iOS 弹键盘**不触发** `window.resize`）
- `SearchSelect.tsx:190-198`（`open` 后 `setTimeout(() => inputRef.current?.focus(), 10)` → 必定弹键盘）
- 列表高度：`:314-319`（`Math.min(300, Math.max(120, …))`）

**触发条件**：iOS/Android 上打开任何 SearchSelect（13 处调用，见下）。
**修法**：改用 `window.visualViewport` 的 `resize`/`scroll` 重算，并给列表加 `max-height: 40vh`；
或在触屏上不自动聚焦（让用户主动点输入框）。

### C-14 【P1】选择器触发按钮 17–21px，候选行 24px

**位置**：
- 触发按钮：`SearchSelect.tsx:231`（`size='sm'` → `text-[11px] px-1.5 py-0.5`；`md` → `px-2 py-1`）
  + `:241`（唯一可视反馈是 `hover:border-sky-500/60`）
- 候选行：`SearchSelect.tsx:39`（`ROW_HEIGHT = 26`）、`:336`（`h-[24px]`）
  + `:340`（`text-[11px]`）、`:344`（`text-[10px]`）
- 分面 chips：`SearchSelect.tsx:296-300`（`text-[10px] px-1.5 py-[1px]`）
- 清空按钮：`:276-279`（`X` 图标 12px，无 padding）
**13 处调用**（全部继承上面的尺寸）：`TickerPanel.tsx:138`、`OrderBookPanel.tsx:145,156`、
`CargoPanel.tsx:162`、`DemandPanel.tsx:148`、`FactoryPanel.tsx:164,215,314`、`ItemDetailPanel.tsx:39`、`FleetPanel.tsx:420`。
**修法**：触屏下 `min-height:44px`、候选行 44px；`reason`：26px 行 × 相邻两行中心距 26px，
手指落点抖动 ±10px 时误选率很高，而选中即 commit（`:200-206`，无二次确认）。

### C-15 【P1】`onMouseEnter` 绑定高亮，触摸没有等价物

**位置**：`SearchSelect.tsx:333`（`onMouseEnter={() => setActive(idx)}`）、
`frontend/src/layout/EntitySearchList.tsx:123`（同款）。
**玩家视角**：键盘用户靠 ↑↓ 高亮；触屏用户没有"当前项"概念，而且这两处的 `active` 同时被
`:337` 用来渲染唯一的高亮底色 —— 手指按下的瞬间没有任何"我选中的是这一条"反馈。
**修法**：加 `:active` / `onPointerDown` 高亮；触屏下隐藏键盘提示。

### C-16 【P2】底部提示条写的是键盘操作

**位置**：`SearchSelect.tsx:355-357`（`↑↓ Enter Esc`）。
**玩家视角**：手机上永远看到一条"↑↓ Enter Esc"的无效说明，占掉本就狭窄的弹层高度。
**修法**：`@media (pointer: coarse)` 下隐藏或换成"点选一项"。

### C-17 【P2】EntitySearchList：行 32px + 空窗口面板自动弹键盘

**位置**：`frontend/src/layout/EntitySearchList.tsx:6`（`ROW_HEIGHT = 34`）、`:125`（`h-[32px]`）、
`:131`（子标题 `text-[9px]`）、`:97-101`（分组 chips 14–16px）、
`:76`（`autoFocus` 直接透传）。
**触发链**：`frontend/src/layout/paneComponents.tsx:69-73` 的 `EmptyTilePane` 传了 `autoFocus`，
所以**每次点一个空窗口，键盘立刻升起并遮住列表**——这正好是触屏玩家"新建窗口"的必经之路。
**修法**：`autoFocus` 只在 `pointer:fine` 下生效。

---

## 6. IDE、文件管理、内存与控制台

### C-18 【P0】文件行的操作按钮：`opacity-0 group-hover:opacity-100`，看不见但能点

**现象**：玩家在文件夹行右侧空白处点了一下（那里视觉上什么都没有），弹出「删除文件夹及内部文件？」。
他没想删任何东西，但已经进入了删除确认。如果那一下再偏 12px，就真的删了。

**位置**：
- 文件夹行：`frontend/src/panels/FileExplorerPanel.tsx:265-268`
  （`className="flex items-center gap-0.5 opacity-0 group-hover:opacity-100 shrink-0"`，包裹 `:265-306`）
- 文件夹的 4 个按钮：新建文件 `:269-278`、新建子目录 `:279-288`、重命名 `:289-298`、删除 `:299-305`
  —— 尺寸 `p-0.5` + `w-3 h-3` 图标 = **约 20×20px**，靠 `title` 区分（`:274,284,294,301`）
- 文件行：`FileExplorerPanel.tsx:403-426`（重命名 `:408-417`、删除 `:418-424`）
- 删除确认：`:309-328`（文件夹）、`:429-448`（文件）——"确定/取消"是纯文本（`:315-323`），
  高约 13–16px、彼此相邻 8px

**关键机制**：`opacity:0` **不**移除命中测试。所以触摸设备上这些按钮是"隐形可点"的——
比"完全不可见"更危险。
**修法**：`opacity-0` 的同时加 `pointer-events-none`，`group-hover`/`focus-within` 时才恢复；
触屏下改为行尾常显「⋯」按钮（≥44px）；删除确认的确定/取消改为 ≥44px 按钮。

### C-19 【P0】脚本归类只能 HTML5 拖拽 → 触屏彻底不可用

**现象**：平板上想把自己的脚本拖进 `market/` 目录：按住、拖、松手——什么都没发生。
HTML5 的 `dragstart/dragover/drop` 在 iOS Safari 与多数 Android 浏览器上**不会由触摸触发**。
所以"移动脚本到分类"这个功能在触摸设备上等于不存在（连说明都放在 tooltip 里，G3）。

**位置**：
- 文件夹拖放：`FileExplorerPanel.tsx:190`（`draggable`）、`:191-200`（dragStart/dragEnd）、
  `:201-223`（dragover/drop → `moveDraggedToFolder`）
- 文件拖放：`:340-370`
- 根目录投放区：`:509-537`
- 唯一说明：`:371`（`title={canDragFile ? '拖动到文件夹或空白根目录可移动分类' : …}`）
**修法**：提供非拖拽路径（行内「移动到…」菜单 + 目标目录选择器），或实现长按拖拽（`pointerdown` + 计时器）。

### C-20 【P1】重命名只能 Enter 确认 / Esc 取消，触屏上无法退出

**现象**：误触进入重命名后，软键盘上没有 Esc；输入框没有确定/取消按钮，
也不会在失焦时关闭（没有 `onBlur`）。玩家被困在这个输入框里，只能硬着头皮改名。

**位置**：`FileExplorerPanel.tsx:248-259`（文件夹）、`:386-397`（文件）——
只有 `onKeyDown` 的 `Enter`（提交）与 `Escape`（取消），无按钮、无 blur 处理。
对照：新建流程是有按钮的（`:502-504` 的「确定」），说明这是遗漏而非设计。
**修法**：加「确定 / 取消」两个按钮 + `onBlur` 取消。

### C-21 【P1】CodeMirror 编辑器 12px + 无键盘避让

**现象**：平板上写脚本：一聚焦编辑器整页放大（G1）；软键盘升起后约占半屏，
光标所在行被键盘挡住，面板是 `overflow-hidden` 的固定高度结构，滚不开。

**位置**：
- `frontend/src/panels/ScriptIdePanel.tsx:113-120`（`EditorView.theme({ '&': { fontSize: '12px' } })`）
- `ScriptIdePanel.tsx:246`（`<div ref={editorHostRef} className="flex-1 min-h-0 overflow-hidden" />`）
- 文件 tab：`:193-201`（`pill-btn py-0 text-[10px]`，多个 tab 紧贴 → 点错文件）
- 新建文件输入：`:204-217`（`w-28 text-[10px]`）、`+ 文件`：`:223-225`
- 保存：`:240-242`（`cta-green text-[10px] py-0.5` ≈ 22px）
**修法**：编辑器字号 ≥16px；用 `visualViewport` 高度给编辑器让位（`padding-bottom: keyboardHeight`）；
tab 命中区 ≥44px。

### C-22 【P1】控制台：没有提交按钮，历史只能 ↑↓

**现象**：触屏玩家在 REPL 里敲完命令，不知道要按回车；想再跑一次刚才的命令，
提示写着"↑↓ 翻历史"——手机键盘没有方向键。**上一条命令永远拿不回来**。

**位置**：
- `frontend/src/panels/ConsolePanel.tsx:455-486`（输入框 `text-[11px]` `:484`）
- 只有 `onKeyDown` 的 `Enter` 提交与 `ArrowUp/ArrowDown` 翻历史：`:460-482`
- 占位文案写明键盘操作：`:483`
- `清空`：`:426-428`（`pill-btn py-0 text-[10px]`）
- 展开嵌套对象的小三角：`:213-231`（`px-0.5` + 12px 图标 → 整行点击区约 13–15px）
**修法**：加「执行」按钮 + 历史命令点选列表（最近 5 条 chip）。

### C-23 【P1】Memory：128KB JSON 在 11px 的 textarea 里编辑

**现象**：手机上改一行 Memory：聚焦放大、键盘遮住半屏、`resize-none` 且没有行号，
保存按钮 16px。**好消息**：`resize-none` 已经禁掉了拖拽缩放（`:160`），这点是对的。

**位置**：
- textarea：`frontend/src/panels/MemoryPanel.tsx:157-161`（`text-[11px] … resize-none`）
- 编辑开关 / 写入保存：`:125-132`（`pill-btn py-0 text-[10px]` / `cta-green py-0 px-2 text-[10px]`）
- 树节点展开按钮：`:47-61`（`py-0.5 text-[11px]` → 约 17px 高，嵌套 3 层后每格更小）
- 过滤输入：`:141-146`（`text-[11px]`）
**修法**：textarea 16px + `inputMode` 不适用（JSON），至少给"保存/放弃"固定底栏；
树节点行高 ≥44px。

---

## 7. 账号与设置

### C-24 【P0】登录/注册：13px 输入框 + 垂直居中不可滚动的卡片

**现象**：手机打开游戏第一屏就是登录。点邮箱 → 页面放大；软键盘升起 →
「进入控制台」按钮被键盘完全挡住，而外层 `h-full overflow-hidden` 且卡片是 `items-center` 居中的，
**没有任何滚动可以把按钮露出来**。玩家只能盲按键盘的"完成"再猜。

**位置**：
- `frontend/src/auth/AuthScreen.tsx:130-131`（`INPUT_BASE` → `text-[13px]`）
- `:235`（`relative h-full w-full overflow-hidden`）、`:257`（`relative z-10 flex h-full items-center justify-center px-6 py-8`）
- `:268`（表单卡片）、`:289`（`space-y-3.5 p-5`）
- 提交：`:434-450`（`py-2.5 text-[12px]`，在密码框正下方）
- 密码显隐眼睛：`:353-361`（`absolute right-2.5`，13px 图标，**无 padding** → 目标约 13×13px）
- 「保持登录 14 天」：`:416-431`（可见方框 `h-3 w-3` = 12×12px；真正 input 是 `sr-only`）
- 登录/注册切换：`:271-285`（`py-2.5 text-[11px]` ≈ 36px，勉强可用）
- 开发绕过链接：`:452-465`（`text-[10px]` 下划线文字）

**触屏判定**：眼睛按钮 13px（远小于 44）；记住登录复选框 12px；
输入框 13px（iOS 放大）；提交按钮在键盘下方且不可达。
**修法**：输入 16px；卡片区改 `overflow-y-auto` + `items-start` + 底部留 `env(safe-area-inset-bottom)`；
眼睛按钮加 `p-2.5`（≥44px）；复选框整体做成 ≥44px 的行。

### C-25 【P1】设置页：破坏性按钮 20px、左栏固定 88px

**现象**：想刷新会话列表，手指落在「刷新」右边 4px 的「登出其他所有设备」上——
所有其他设备被登出。按钮之间只有 `gap-2`(8px)。

**位置**：
- 按钮基础样式：`frontend/src/panels/SettingsPanel.tsx:43-47`
  （`SMALL_BTN` / `SMALL_BTN_DANGER`：`px-1.5 py-1 text-[10px]` → **约 20–22px 高**）
- 「吊销」：`:664-678`；「登出其他所有设备」：`:686-694`；「退出登录」：`:596-599`
- 昵称保存：「保存」`:496-505`；提示写 `回车保存 · Esc 撤销`：`:508-517`
- 3 个密码框：`:549-583`（12px）；「更新密码」`:586-589`
- 左侧导航固定 88px、tab `py-[7px] text-[11px]`：`:727`、`:736-746`
  → 手机上 88px 占 24% 宽度，内容区只剩 ~270px
**修法**：破坏性操作全部 ≥44px 且与普通操作拉开距离，加二次确认；
导航改为顶部 tab 或可折叠（< 480px）。

### C-26 【P2】`SettingsPanel` 的"关于"页里 `React 18` 字样与实际一致（`package.json` 为 18.3.1），
不涉及触摸，仅记录：`SettingsPanel.tsx:711`。

---

## 8. 图谱面板（Orbit / Planet / Ranking）

### C-27 【P1】轨道图：行星热区 3.5–5px

**现象**：玩家在平板上看轨道图，想点开某颗行星的遥测。
行星被画成 `r=3.5~5` 的小圆点 + 10.5px 标签，SVG `viewBox="0 0 520 380"` 被缩放进面板
（390px 宽的手机上约 0.75 倍 → 圆点直径 ≈ 2.6–3.8px）。
**手指按下去，几乎必然落空**，而落空没有任何反馈。

**位置**：
- `frontend/src/panels/OrbitPanel.tsx:50`（`<svg viewBox="0 0 520 380" className="w-full h-full">`）
- 行星：`:72-91`（`<circle … r={p.population > 0 ? 5 : 3.5}>`，点击挂在 `<g>` 上 `:79-83`）
- 枢纽站：`:94-106`（菱形 `±4.5px`）
- 唯一按钮「悬浮舰队调度」：`:41-46`（`cta-green text-[10px] py-0.5`）

**修法**：给每个 `<g>` 加一个透明 `<circle r="22~24">` 作为命中层（视觉不变，热区 ×5）。
**补充**：面板会 `select-none`（`:35`），这是对的（避免长按选中文字）。

### C-28 【P1】行星面板：4 个纯文本链接 + 16px 的「购置新地块」

**现象**：面板里"地面仓库 / 轨道站 / 工业产线 / 消费需求"是四个蓝色**纯文字**，
没有边框、没有 padding，唯一"可点"的视觉线索是 `hover:underline`——
触摸设备永远看不到下划线。玩家根本不知道它们是链接，而且相邻两个只隔 10px。

**位置**：
- `frontend/src/panels/PlanetPanel.tsx:202-227`（4 个 `text-sky-300 hover:text-sky-200 hover:underline`，`:205, 211, 217, 223`）
- 购置新地块：`:82-90`（`cta-blue text-[10px] py-0 px-2` ≈ 16px，买地）
- 二手地块「收购」：`:236-251`（`cta-green text-[10px] py-0 px-1.5` ≈ 16px，同样是花钱操作）
- 行星切换 pills：`:72-80`（`pill-btn py-0 text-[10px]`，彼此只隔 4px）

**修法**：链接改按钮（带边框/底），命中区 ≥44px；购买类按钮 ≥44px + 确认。

### C-29 【P1】3D 星球画布嵌在滚动列里：拖拽 = 转球，滚不动面板

**现象**：手机上，行星信息表下面就是 3D 星球（`min-h-[200px]`）。
想把面板往下滑看全信息，手指落在球上 → 变成转动星球（或整页放大），面板不动。

**位置**：`frontend/src/panels/PlanetPanel.tsx:94`（外层 `flex-1 min-h-0 overflow-y-auto`）
+ `:258-266`（`<div className="flex-1 min-h-[200px]"><Planet3DCanvas …/></div>`）。
画布本身的指针处理见 `frontend/src/components/Planet3DCanvas.tsx:616-656`（`onPointerDown` +
`setPointerCapture`，无 `touch-action`），提示文案写的是"左/右键拖动以旋转"（`:608-610`）——
画布细节归 B 卷，此处只记录**它在可滚动列中的手势争抢**。
**修法**：画布容器加 `touch-action: pan-y`（允许纵向滚动、横向交给旋转），
或给画布一个明确的"全屏查看"入口，默认不劫持手势。

### C-30 【P2】排行榜：`w-full` 表格无横向滚动，中文列可压到 1 字宽

**位置**：`frontend/src/panels/RankingPanel.tsx:18-51`（`<table className="w-full text-[11px] mono text-left">`，`:19`），
`sticky top-0` 表头 `:20`（这点是对的，滚动时表头会跟随）。
**玩家视角**：手机上一列 4 个字段，公司名被压成竖排单字，排行榜读不出来。
**修法**：`min-w-[420px]` + 外层 `overflow-x:auto`。

---

## 9. 做对了的地方（避免回退时误改）

- `SearchSelect` 弹层用 `position: fixed` + `zIndex 10000`（`SearchSelect.tsx:250-259`），
  不会被 pane 的 `overflow-hidden` 裁剪——这是全站最正确的一个决定。
- `VirtualList` 用原生 `onScroll`（`:51-53, 78-79`），触摸惯性滚动天然可用。
- `MemoryPanel` 的 textarea 是 `resize-none`（`:160`），没有可拖拽缩放手柄。
- `OrderBookPanel` 的买卖方向用了原生 `<select>`（`:346-353`）——原生控件在触屏上是最稳的。
- 所有面板头部都用了 `flex-wrap`（如 `TickerPanel.tsx:205`、`CargoPanel.tsx:175`），
  窄屏下不会直接把内容挤出面板。
- `OrbitPanel`（`:35`）、`FileExplorerPanel`（`:454`）根部有 `select-none`，避免长按选中。

---

## 10. 与其它分卷的边界（避免重复计数）

- `layout/DesktopShell.tsx`、`layout/FloatingWindowsLayer.tsx`、`layout/SplitLayout.tsx`、
  `layout/CommandPalette.tsx` → **A 卷（task-1）**。
  这里只提一句交叉引用：`SplitLayout.tsx:68-124` 的窗口操作组是 `onMouseEnter` 唤出的，
  而那个齿轮按钮**本身没有 onClick**（`:117-122`）——触摸上必须先"悬停"才能出现按钮，细节见 A 卷。
- `components/Planet3DCanvas.tsx`、`panels/ChartPanel.tsx` → **B 卷（task-2）**。
- 本卷只写了 `PlanetPanel` 中画布的**布局与滚动冲突**（C-29）与 `OrderBook/Ticker` 跳转到 Chart 的按钮尺寸。

---

## 11. 建议的修复顺序（按性价比）

1. **一次性消除 iOS 放大**：所有 input/textarea/contenteditable 触屏字号 ≥16px（G1，~20 处，纯 CSS 可行）。
2. **`touch-action: manipulation` + `@media (pointer: coarse)` 基线层**（G2）：
   在基线层里统一 `min-height:44px`、禁止 `hover:` 作为唯一反馈。
3. **`opacity-0` 配 `pointer-events-none`**（C-18）——一个类名，消除"隐形删除按钮"。
4. **FleetPanel 行高与 1 艘/行对齐**（C-06）——一处常量，修掉手机竖屏的整块错位。
5. **SearchSelect 改用 visualViewport 重算 + 触屏不自动聚焦**（C-13）——13 处调用同时受益。
6. **破坏性操作加确认 + 拉开间距**（C-02 下单、C-03 拆除、C-25 登出、PlanetPanel 购买）。
7. **表格名称列保底宽度 + 容器横向滚动**（C-08 / G4）。
8. **给关键流程补非手势路径**：脚本归类（C-19）、控制台历史（C-22）、重命名退出（C-20）。

---

## 12. 附：三组快速真机回归步骤

**手机竖屏（iPhone 390×844，重点验证 P0）**
1. 打开登录页 → 点邮箱 → 观察是否放大、提交按钮是否被键盘遮住（C-24、G1）。
2. 新建空窗口 → 观察键盘是否自动弹出并遮住选择列表（C-17）。
3. 舰队 → 数一数能看见几艘船（C-06）。
4. 脚本工作区 → 手指在文件行右侧点一下（C-18），再试着把文件拖进目录（C-19）。
5. 盘口 → 点买一价行填价 → 观察填进去的是哪一档（C-02）。

**平板横屏（iPad 1024×768，重点验证「看得见但点不中」）**
1. 分屏两栏 → 需求面板是否还看得到物品名（C-08）。
2. 行情 → 点行尾「K线」，是否打开了物品详情（C-01）。
3. 产线 → 从「运行中」往右偏一点（C-03）。
4. 财务 → 点灰掉的「借款」，是否有任何解释（C-04、G3）。
5. 选择器 → 打开站点选择，键盘升起后还能看到几条候选（C-13）。

**触屏笔电 / 触屏 Windows（重点验证 hover 语义）**
1. 鼠标悬停后不用鼠标，只用手指重复所有 hover 才出现的按钮（C-18、`SplitLayout`）。
2. 双击表头排序（C-09）、双击任何按钮（G2 双击缩放）。

---

_本卷结束。所有 `file:line` 均可用 `read` 直接复核；未对源码做任何修改。_
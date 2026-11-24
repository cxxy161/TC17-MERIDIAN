# Meridian 前端 UI 框架速查（窗口 / 分屏 / 检索 / 样式）

> 面向「给 Meridian 加新窗口 / 新面板 / 新检索」的开发者。2026-11-24 按工作区实读整理；
> 行号会随改动漂移，请以符号名（export 名）为准。这份文档只讲**通用框架**，不介绍具体业务面板的数据含义。

---

## 0. 十条铁律

1. **窗口类型 = `PaneKind`**；项目没有 router，也没有 URL 路由级的深链（独立文档页除外）。
2. 所有面板只有一个挂载点 `PaneRenderer`；`Record<PaneKind, ...>` 是**唯一**的编译期穷尽检查。
3. **`params` 是面板身份**，标题永远由 `(kind, params)` 纯函数推导，不存储。
4. 分割 tile / 悬浮窗 / 空 tile / 命令面板**共用同一个面板组件**，差异只在注入的 `setParams` / `openInPlace`。
5. 新 pane **必须**同时进 `PANE_CATALOG`（否则 ⌘K 与空 tile 静默搜不到）和 `paneTitle`（否则标题变成裸 kind）。
6. 工作区持久化键是 `meridian.split_workspaces.v4`，**不要 bump**：bump 等于清空所有玩家的布局。
7. 全站没有 UI 组件库、没有 markdown 渲染、没有 router、没有前端测试框架；Tailwind + lucide-react 就是全部。
8. 字号刻度只有 `9 / 10 / 11 / 12px`；数字与 id 一律 `.mono`；层高（z-index）有预算，不要随手加 9999。
9. 悬浮窗标题条**整体是拖拽热区**，只豁免 `button`——输入框放进 header 会被拖走。
10. 改完必须 `cd frontend && npm run build`：线上是后端托管 `dist`，不是 vite dev server。

---

## 1. 运行时与构建形态

- 栈：React 18 + TypeScript（`strict` + `noUnusedLocals/Parameters`）+ Vite 6 + Tailwind 3 + Zustand 5 + CodeMirror 6 + lightweight-charts + lucide-react。
- **dockview 是死依赖**：源码里 grep 命中 0，只剩 `styles/index.css` 里一段没人消费的主题变量；窗口系统是自研的 splitTree + 悬浮层。
- 两个 HTML 入口（[vite.config.ts](../frontend/vite.config.ts)）：
  - `frontend/index.html` → 游戏本体；
  - `frontend/docs/index.html` → 独立文档页，构建到 `dist/docs/index.html`，访问 `/docs/`（`/docs` 会被静态服务 307 到 `/docs/`）。
- 构建产物 `frontend/dist` 由 Rust 后端 `ServeDir` 直接托管（[api.rs](../backend/crates/meridian-server/src/api.rs) 的 fallback），**未知路径回落到游戏 index.html**。
- 开发：`npm run dev`（5173）代理 `/api`、`/ws` 到 18420；生产必须 build。
- 无 router：唯一「深链」是文档页的 `#Game.market.createOrder` hash；游戏内深链靠 localStorage 里保存的工作区树。

---

## 2. 窗口系统（核心）

### 2.1 类型地图

定义全部在 [paneRegistry.ts](../frontend/src/layout/paneRegistry.ts)：

| 符号 | 位置 | 职责 |
|---|---|---|
| `PaneKind` | :5 | 19 种窗口类型的联合类型 |
| `PaneParams` | :26 | 面板身份：`planetId/locationId/stationId/itemId/buildingId/recipeId` + 面板私有键（如 `docId`） |
| `PaneProps` | :37 | 面板入参：`params`、`setParams`、`openInPlace`、`openTemp` |
| `TileContent` | :49 | 分屏 tile 的内容 `{kind, params}` |
| `FloatingWindowItem` | :56 | 悬浮窗：`{id, kind, params, x,y,w,h,z}` |
| `PaneMeta` | :69 | 目录元数据：label/description/group/keywords |
| `PANE_CATALOG` | :78 | 全部窗口的注册表（命令面板/空 tile 的索引源） |
| `paneTitle` | :130 | 标题纯函数 |
| `focusDefaults` | :180 | 打开时按当前焦点补默认实体 |

约定：
- `TileContent.title` / `FloatingWindowItem.title` 是 **@deprecated**，只为读旧存档保留；新代码不要写标题。
- 面板不许把实体复制进 local state：要换实体就 `setParams`（[splitTree.ts](../frontend/src/layout/splitTree.ts) 的 `setLeafParams` 有同款注释）。

### 2.2 三种 chrome，一个渲染器

`PaneRenderer`（[paneComponents.tsx](../frontend/src/layout/paneComponents.tsx):48）从 `PANEL_COMPONENTS`（:26）取组件，注入不同的导航实现：

- **分割 tile**：`SplitLayout` → `onSetParams` → `setLeafParams`；`openInPlace` 会**原地换内容**（不新开窗）。
- **悬浮窗**：`FloatingWindowsLayer` → `onSetParams` → `setFloatParams`；`openInPlace` 会替换这个悬浮窗的 `kind+params`。
- **空 tile 选择器**：`EmptyTilePane`（paneComponents:62）→ 实体搜索 → `setLeafContent`。
- **命令面板**：`CommandPalette` → `openTemp`（永远新开悬浮窗）。

所以「新窗口全可达」= 进 `PANEL_COMPONENTS` + `PaneKind` + `PANE_CATALOG`；再加 `RAIL_BUTTONS` 就是第四个入口。其余文件零改动。

### 2.3 打开 / 替换路径

| 目标 | 调用 | 结果 |
|---|---|---|
| 新开悬浮窗 | `openTemp(kind, params)`（DesktopShell:225） | 按 kind 取默认宽高、错位摆放、z 递增，最多 10 个 |
| tile 原地换内容 | `setLeafContent` | 保留 tile 布局，不新开窗 |
| 悬浮窗换内容 | `replaceFloat`（DesktopShell:287 附近） | kind 与 params 一起换 |
| 面板内导航 | `setParams({...})` | 只改身份，不重挂载 |
| 打开时补默认实体 | `focusDefaults` + `fillPaneDefaults`（DesktopShell:104） | 只用实时 world/catalog，不写死 id |

### 2.4 标题与身份

`paneTitle(kind, params, {catalog, world})` 是纯函数：
- 实体类标题从索引取名字（`world.planetName` / `catalog.itemName`）；
- 面板私有参数也参与（例如 `docId` → `API · createOrder`）；
- **不能**依赖 React 或 store，否则标题无法在窗口列表/悬浮窗标题条里同步计算。

### 2.5 持久化

- 工作区（全部 tile 树 + 每个 tile 的 params）存 `localStorage`：`meridian.split_workspaces.v4` / `meridian.active_split_workspace.v4`（[workspaces.ts](../frontend/src/layout/workspaces.ts):10-11）。
- 读取只校验「是数组 + 有 tree」，其余原样信任；所以**加 params 字段是向后兼容的**，不要 bump 版本。
- 预设树（[workspaces.ts](../frontend/src/layout/workspaces.ts):18）只对「从没存过工作区」的新玩家生效，改预设不会影响老玩家。
- 悬浮窗**不持久化**：`floatingWindows` 只是 DesktopShell 的 `useState`，刷新即没。

### 2.6 新增一个 pane 的清单

| 步骤 | 文件 | 说明 |
|---|---|---|
| 1 | `paneRegistry.ts` `PaneKind` | 加联合成员 |
| 2 | `paneRegistry.ts` `PaneParams` | 只有需要深链/持久化的私有参数才加 |
| 3 | `paneRegistry.ts` `PANE_CATALOG` | 加 `{kind,label,description,group,keywords}` —— ⌘K 与空 tile 靠它 |
| 4 | `paneRegistry.ts` `paneTitle` | 加 `case`，否则标题变裸 kind |
| 5 | `paneComponents.tsx` `PANEL_COMPONENTS` | **编译强制**：漏了直接 TS2741 |
| 6 | 新面板文件 | 实现 `React.FC<PaneProps>`，样式抄 SettingsPanel（见 `6.4） |
| 可选 | `DesktopShell.tsx` `RAIL_BUTTONS` | 进左侧 48px 图标栏 |
| 可选 | `DesktopShell.tsx` `openTemp` 尺寸 | 默认 460×380，按需加档位 |
| 可选 | `paneRegistry.ts` `focusDefaults` | 只有实体型面板需要 |

### 2.7 两个静默失效点

1. **漏 `PANE_CATALOG`**：编译通过、rail 能开，但 ⌘K 搜不到、空 tile 搜不到——没有任何报错。
2. **漏 `paneTitle` case**：switch 有 `default: return kind`，标题显示成 `apiDocs` 这种裸字符串，且三处（tile 标题、悬浮窗标题条、窗口列表）一起错。

---

## 3. 分屏与悬浮窗

### 3.1 splitTree（不可变树）

[splitTree.ts](../frontend/src/layout/splitTree.ts) 提供纯函数：`makeLeaf`(:26)、`splitLeaf`(:40)、`closeLeaf`(:57)、`clearLeaf`(:80)、`setLeafContent`(:92)、`setLeafParams`(:111)、`updateSplitRatio`(:136)。

- 树只有两种节点：`leaf`（单个面板）与 `split`（方向 + 比例 + 两个子节点）。
- 所有操作返回新树；`setLeafParams` 做浅合并 + 引用相等判断，无变化返回原引用（避免无谓重渲染）。
- 调整比例只改 `ratio`，不重建节点 id。

### 3.2 SplitLayout

[SplitLayout.tsx](../frontend/src/layout/SplitLayout.tsx)：
- tile 根节点带 `data-tile-id` / `data-empty-tile`（:53-54），这是悬浮窗拖拽停靠的 DOM 探针协议；
- tile 标题条提供水平/垂直分割、关闭、清空（:78-88）；
- 空 tile 显示 `EmptyTilePane`；
- 分割条拖动只更新比例。

### 3.3 FloatingWindowsLayer

[FloatingWindowsLayer.tsx](../frontend/src/layout/FloatingWindowsLayer.tsx)：
- 指针拖拽（`onPointerDown` :140），标题条整条是热区，只对 `button` 豁免；
- 右下角 resize grip（:169-172），最小尺寸 **280×200**（:112-113），位置下限 `x≥48, y≥38`（:77）；
- 层叠：`zIndex: win.z`（:134），DesktopShell 从 40 起自增；
- 拖到 tile 上时会用 `document.elementsFromPoint` 找 `[data-empty-tile="true"]`，松手即停靠（`dockFloatToTile`，DesktopShell:315）；
- 最多 10 个（`MAX_FLOATING_WINDOWS`，DesktopShell:80），超出丢最旧。

### 3.4 尺寸与层级预算

- 默认宽高在 `openTemp`（DesktopShell:225-247）：`apidocs 760×560`、`script 680`、`settings 600`、`chart/orbit 520`、其余 460×380。
- z-index 约定：tile 拖放高亮 20、悬浮窗 40+、窗口列表/命令面板 `z-[9999]`、`SearchSelect` popover 10000。
- 面板内部 sticky 条不要超过 20，弹层不要超过 100（否则会盖住命令面板）。

---

## 4. 数据与状态

### 4.1 两个 store

[useGameStore.ts](../frontend/src/store/useGameStore.ts)（:82 起）：
- `catalog`：`ProductionPack`，只在换包时变；
- `state`：每 tick 全量 `StateResponse`；
- `scripts` / `draftModules` / `scriptDirty`：脚本 IDE；
- `lastFocus`：最近关注的实体（`planetId/locationId/stationId/itemId`）；
- `wsStatus` / `consoleHistory`：连接状态与日志（保留 500 条）；
- `init()` 拉 catalog/state/scripts + 建 WS；`refreshState()` 手动刷新。

[useSessionStore.ts](../frontend/src/store/useSessionStore.ts)：账号、登录态、会话管理；与游戏数据分开，登出会切 `status` 让 `SessionGate` 卸载桌面。

### 4.2 实体索引（性能关键）

- `buildCatalogIndex(pack)`（[catalogIndex.ts](../frontend/src/entities/catalogIndex.ts):101）：名字/角色/职业/分类/facets/瞬时物品判断；用 `useCatalogIndex()` 在 pack 变化时建一次。
- `buildWorldIndex(state)`（[worldIndex.ts](../frontend/src/entities/worldIndex.ts):115）：地点、站点、持仓、报价、行星名；`useWorldIndex()` 每个 tick 重建，但只走稀疏数据。
- 约定：面板不要各自扫原始数组，统一走这两个索引；`useMemo` 的依赖分别锁在 `catalog` 与 `state` 上。

### 4.3 lastFocus

- 实体类 pane 打开时，`fillPaneDefaults` 会用 `focusDefaults` + 当前 `lastFocus` 补实体，避免写死 id。
- `lastFocus` 只应包含 4 个实体键。新增面板私有参数（如 `docId`）时，必须像 [DesktopShell.tsx](../frontend/src/layout/DesktopShell.tsx):86 的 `focusOnly()` 一样过滤，否则会被写进焦点上下文。

### 4.4 性能约定

- 高频面板（行情/K线）自己做增量订阅（`books` / `quoteHistory`），不要每 tick 全量重渲染。
- 长列表一律 `VirtualList`；行高固定，避免测量。
- 面板内部状态（搜索词、排序、折叠）留在 `useState`，**不要**进 `params`（params 是身份，不是视图状态）。

---

## 5. 检索与导航

### 5.1 单一实体索引

[entitySearch.ts](../frontend/src/layout/entitySearch.ts) 的 `useEntitySearch()` 是唯一检索源：
- 功能窗口：遍历 `PANE_CATALOG`（:31）；
- 物品（:43）、行星（:65）、地点（:85）、站点（:97）；
- 每项带 `group`、`badge`、`keywords`、`content: {kind, params}`，点一下就是打开对应 pane。
- **没有上限、没有截断**；新实体类型应该加在这里，而不是每个面板各写一个 `<select>`。

### 5.2 两个消费入口

- `CommandPalette`（[CommandPalette.tsx](../frontend/src/layout/CommandPalette.tsx):17）：⌘K，`openTemp` 打开。
- `EmptyTilePane`：空 tile 里直接选，`setLeafContent` 原地填。

### 5.3 列表与选择器

- `EntitySearchList`（[EntitySearchList.tsx](../frontend/src/layout/EntitySearchList.tsx):22）：分组 + 键盘上下 + 高亮；内部用 `VirtualList`。
- `VirtualList`（[VirtualList.tsx](../frontend/src/components/VirtualList.tsx):20）：固定行高 + overscan，长表必用。
- `SearchSelect`（[SearchSelect.tsx](../frontend/src/components/SearchSelect.tsx):63）：带搜索的下拉；popover 用 `position: fixed` + z 10000，**在悬浮窗里会溢出到全屏最上层**，别把它的内容放进文档导航。

---

## 6. 样式系统

### 6.1 颜色

- 背景：`#161b22`（shell）、`#1b212b`（面板）、`#202732`（列表）、`#0b1017` / `#0e141c`（深色两栏）。
- 边框：`rgba(56,189,248,0.12~0.2)`（天蓝）；分隔线 `border-white/[0.05]` 或 `slate-800`。
- 文本：主 `slate-100/200`、次 `slate-400`、弱 `slate-500/600`。
- 强调：`sky` 主色、`emerald` 正向/成功、`amber` 警告、`rose` 危险。

### 6.2 排版

- 全局 12px；面板正文 11px / 10.5px，元信息 10px，徽标 9px。
- `.mono`（[index.css](../frontend/src/styles/index.css):24）用于数字、id、代码、签名；开启 tabular-nums。
- 数字列用 `.mono` + 右对齐；中文正文用 `leading-relaxed`。

### 6.3 现成类（不要重复造）

- `.pill-btn` / `.pill-btn.active`：胶囊筛选/标签页；
- `.cta-blue` / `.cta-green`：主/次操作按钮；
- `.metric-card`：遥测小卡；
- 滚动条全局 5px，天蓝 22% 透明（:121-131）；
- 图标统一 lucide，尺寸 9–15，颜色继承。

### 6.4 面板骨架范式（按需抄）

- **两栏 + 分节**：`SettingsPanel`（[SettingsPanel.tsx](../frontend/src/panels/SettingsPanel.tsx):225 起）= 88px 竖排 nav + 滚动 section；可复用小组件 `FieldLabel`(:188)、`InfoRow`(:216)、`ErrorBox`(:206)、`SMALL_BTN`(:43)。
- **搜索 + 分面 + 表格**：`ItemListPanel`（[ItemListPanel.tsx](../frontend/src/panels/ItemListPanel.tsx):139 搜索、:164 分类胶囊、:210 列头）。
- **树**：`MemoryPanel` 的递归 JSON 节点 + 过滤剪枝；`FileExplorerPanel` 的目录树 + 拖拽（只读场景别抄拖拽）。
- **流式输出**：`ConsolePanel` 的分级日志、自动滚底、命令历史。
- **文档阅读器**：`DocView` / `ApiDocsPanel`（本次新增）可作为「左目录 + 右正文 + 复制 + hash 深链」的模板。

### 6.5 状态惯例

- 加载：`Loader2` + `animate-spin` + mono 文案（不要骨架屏，项目里没有）。
- 空：居中图标 + 一句说明 + 可选 CTA。
- 错误：`ErrorBox` 风格（rose 边框 + 10px 文本），不要 `alert()`；项目禁止原生弹窗。
- 未选择实体：显示「未选择」，不要偷偷换成第一个实体。

---

## 7. 交互与快捷键

- 全局只有两个：`⌘K / Ctrl+K` 开命令面板、`Escape` 关面板（DesktopShell:183-192）。
- **F12 只是文案**，不是快捷键；控制台面板的「F12」是历史命名。
- 输入框内部不要再绑 ⌘K；Escape 清空输入而不是关窗。
- 面板用自己的 `onKeyDown` 处理方向键/回车，不要挂 window 级监听（会和命令面板抢）。
- 拖拽统一 Pointer Events；不要用 HTML5 drag&drop（现有实现是 pointer capture）。
- 禁止 `window.alert/confirm/prompt`：项目一律用内联 UI。

---

## 8. 构建、托管与验证

### 8.1 构建/托管

- `cd frontend && npm run build` = `tsc -b` + `vite build` → `frontend/dist`。
- 后端 `main.rs` 取 `frontend/dist`，`api.rs` 用 `ServeDir` + `ServeFile(index.html)` 兜底；**dist 是实时读盘**，不需要重启后端。
- 多入口后产物是 `dist/index.html` 与 `dist/docs/index.html`；访问 `/docs/`。
- 未知路径返回游戏 index.html（SPA 兜底），所以「404 页面」其实也是 200。

### 8.2 TypeScript 约束

`strict`、`noUnusedLocals`、`noUnusedParameters`、`noFallthroughCasesInSwitch`、`isolatedModules`、`jsx: react-jsx`：
- 未使用的 import/局部变量会直接让 `npm run build` 失败；
- switch 每个 case 必须 return/break；
- 无 `any` 文化，但类型断言在数据层可接受（如 `as Record<...>`）。

### 8.3 验证手法（可复用）

1. `npx tsc -b`（快）→ `npm run build`。
2. `curl` 查 `/` 与 `/docs/` 的 200 和 assets 是否存在。
3. **无头 Chrome 看渲染结果**：
   `google-chrome --headless=new --disable-gpu --no-sandbox --user-data-dir=DIR --virtual-time-budget=5000 --dump-dom URL`
   可以直接 grep 渲染后的文本，验证「面板真的挂载了」。
4. **CDP 探针**（本次新增文档页验证用过）：起 Chrome 时加 `--remote-debugging-port=9222`，Node 用全局 `WebSocket` 连 `/json/list`，`Runtime.evaluate` 读取 `getBoundingClientRect` / 触发输入 / 点击，验证布局无横向溢出、搜索过滤、hash 跳转。
5. 视觉截图只能人工看（本环境模型不支持图片输入）；布局问题优先用 CDP 量宽度/高度/scrollWidth。

### 8.4 「构建通过但 UI 不对」排查顺序

1. 漏 `PANE_CATALOG` / `paneTitle`（静默）；
2. 浏览器缓存了旧 `dist`（强刷）；
3. 改的是 dev 但线上跑 dist（没 build）；
4. Tailwind 类没被 content glob 扫到（新增目录要加进 `tailwind.config.js`）；
5. z-index / 拖拽热区 / 悬浮窗裁剪。

---

## 9. 坑清单（按严重度）

| 症状 | 原因 | 处理 |
|---|---|---|
| TS2741: missing property | 新增 `PaneKind` 没加 `PANEL_COMPONENTS` | 补映射（这是唯一编译强制点） |
| ⌘K 搜不到新窗口 | 漏 `PANE_CATALOG` | 补注册 |
| 标题显示 `apidocs` | 漏 `paneTitle` case | 补 case（default 返回 kind） |
| 新参数串进焦点 | `touchFocus` 收整个 params | 用 `focusOnly()` 过滤 |
| 搜索框一拖就跑 | 悬浮窗 header 是拖拽热区 | 搜索框放正文/独立行 |
| 弹层盖住 ⌘K | popover z 10000 | 调层级别超过 9999 |
| 刷新后布局全丢 | bump 了 v4 key | 回滚 key，加字段不 bump |
| 文档/列表卡 | 每 tick 全量渲染 | 走索引 + `VirtualList` + 局部订阅 |
| 代码块多个实例 | 每条示例挂 CodeMirror | 用 `pre` + mono，或全局单实例只读 |
| 打印全黑 | 深色背景未覆盖 | 加 `@media print`（参考 docs.css） |
| 中文搜索不准 | 引 lunr 分词 | 用子串 + 权重（`searchDocs`） |
| 构建慢/包大 | 文档数据进主包 | 拆懒加载或标题索引 |

---

## 10. 照抄模板：新增一个「左目录 + 右正文」窗口

以本次的 API 文档为例，最小改动是：

1. `paneRegistry.ts`：`PaneKind` 加 `'apidocs'`、`PaneParams` 加 `docId?`、`PANE_CATALOG` 加一条、`paneTitle` 加 `case`。
2. `paneComponents.tsx`：import + 映射。
3. 新面板：`ApiDocsPanel`（[ApiDocsPanel.tsx](../frontend/src/panels/ApiDocsPanel.tsx)，29 行）= 包一层背景 + 把 `params.docId` 转成 `DocView` 的 `onNavigate`。
4. `DocView` 自己管：搜索、目录、正文、复制、滚动复位。
5. 想要独立网页：加一个 HTML 入口 + 一个 `main.tsx`，复用 `DocView`；hash ↔ docId 的适配放在外层，不要污染阅读器。
6. 想要深链：`params.docId`（游戏内）或 `#docId`（网页），**两套都由外层适配**，DocView 只认 `docId`。

---

## 11. 框架缺口与建议

- **没有 router / URL 深链**：游戏内只能靠 `params` + localStorage；要做「分享某个窗口」得先引入 hash/query 适配层。
- **没有 UI 组件库**：两栏、表格、分组都是手写；建议把 `InfoRow/FieldLabel/CodeBlock` 这类小组件提到 `components` 统一。
- **没有前端测试**：至少可以加 `vitest` 覆盖纯函数（`paneTitle`、`splitTree`、`searchDocs`、`hydrateWorkspaces`）。
- **没有 markdown 渲染**：文档用结构化数据是刻意选择；要渲染 md 需引依赖并处理 XSS。
- **面板注册分散**：`PaneKind` / catalog / title / component / rail 五处手动同步；可在 `PaneMeta` 里补 `titleFn / icon / children`，把注册收敛成一张表。
- **补全与文档三份手写**：`API_COMPLETIONS`、`PROTOCOL.md`、文档数据仍在漂移；已经有 `scripts/check-api-docs.mjs` 守卫宿主函数与链接，下一步可以让补全从文档数据派生。

# Meridian 触摸屏适配审计（总卷）

> 对象：`frontend/`（React 18.3.1 + Vite + Tailwind 的桌面式窗口化交易/编程游戏前端）
> 方式：**纯静态只读审计** —— 逐文件通读 + 全库 grep + 构建产物 CSS 反查 + 依赖源码（lightweight-charts 4.2.1）核对。
> **未运行应用、未在真机复现、未修改任何前端源码。** 所有像素数字由代码常量按公式估算。
> 分卷（原始证据与逐条修法）：
> - [A 卷 · 桌面外壳与窗口管理](./audit/touch-shell.md)（21 条：P0 6 / P1 10 / P2 5）
> - [B 卷 · 3D 星球视口与 K 线图表](./audit/touch-canvas.md)（16 条：P0 3 / P1 4 / P2 9）
> - [C 卷 · 业务面板与通用组件](./audit/touch-panels.md)（36 条：P0 11 / P1 20 / P2 5）

---

## 0. 一句话结论

**这个前端不是"触摸适配做得不好"，而是从来没有为触摸做过设计**：全库 0 处 `touch-action`、0 处 `@media (pointer: coarse)`、0 处触摸事件、0 处 `visualViewport`，所有交互都写在"鼠标 + 悬停 + 精确光标 + 键盘"的前提下。

结果不是一个长尾 bug 列表，而是**三条玩家主线同时断掉**：

1. **管不了窗口** —— 分割/关闭/置空只在 hover 抽屉里出现，触屏上点不出来；
2. **点不准** —— 关键命中区 4.5–27px（根字号 12px 又把 Tailwind 的 rem 尺寸压到 75%），手指 40px；
3. **一碰就炸** —— 双指/双击是整页缩放（布局固定 100% 缩不回）、输入框 11–13px 触发 iOS 放大、软键盘吃掉一半界面。

原始记录 73 条，合并重复后约 **66 条**，其中 **P0 16 条**。全部可归并到 5 条根因（§4）。

---

## 1. 为什么"看起来还行"却处处点不中：12px 根字号

`frontend/src/styles/index.css:9-21` 给 `html, body, #root` 设了 `font-size: 12px`，而 Tailwind 的间距类全部是 rem。构建产物可直接验证：`.h-7{height:1.75rem}`、`.w-5{width:1.25rem}`、`.h-1\.5{height:.375rem}`。

**1rem = 12px，所有 `w-N/h-N` 只有名义值的 75%：**

| 控件 | 写法 | 名义 | 实际 | 相对 44px |
|---|---|---|---|---|
| 左侧导航按钮 | `w-9 h-9` | 36 | **27** | 0.61× |
| 顶栏（含全部按钮） | `h-9` | 36 | **27** | 0.61× |
| tile 帧头（唯一可拖/可点条） | `h-7` | 28 | **21** | 0.48× |
| tile 布局按钮 / 齿轮 | `w-5 h-5` | 20 | **15** | 0.34× |
| 悬浮窗关闭 ✕ | `w-5 h-5` | 20 | **15** | 0.34× |
| 悬浮窗缩放手柄 | `w-3.5 h-3.5` | 14 | **10.5** | 0.24× |
| **分割条** | `h-1.5` / `w-1.5` | 6 | **4.5** | **0.10×** |
| 左栏宽度 | `w-12` | 48 | **36** | — |

> 修法警告：**不要直接把根字号改成 16px**，那会让整张桌面在 1366px 笔记本上溢出。应该给触摸路径显式尺寸（`min-h-11`、44px 热区、`@media (pointer: coarse)` 覆盖），或把关键按钮的命中区用伪元素外扩。

---

## 2. 玩家旅程：30 秒内必撞到的墙

### A. iPad 竖屏（834×1194，最"应该能玩"的设备）

| 步骤 | 玩家想做 | 实际发生 | 证据 |
|---|---|---|---|
| 1 | 看一眼默认布局 | 6 面板塞满，勉强可读；所有按钮 15–27px | `workspaces.ts:62-88` |
| 2 | 把 K 线拉宽 | **找不到分割线**（静止透明 4.5px），手指落在旁边面板的表格/下单控件上 | `SplitLayout.tsx:225-232` |
| 3 | 关掉控制台面板 | 点右上齿轮 **没反应**（只有 onMouseEnter，齿轮无 onClick） | `SplitLayout.tsx:41,68-73,117-122` |
| 4 | 开一个 API 浮窗 | 760×560 能放下；想调大小 → 10.5px 手柄几乎按不到；拖一下容易把窗拖出屏幕 | `DesktopShell.tsx:236-246`；`FloatingWindowsLayer.tsx:112-113` |
| 5 | 点「⌘K 搜索」 | **整页被放大**（输入框 12px），右侧被裁、缩不回去 | `EntitySearchList.tsx:83`；`index.html:5` |
| 6 | 拖星球转个面 | 星球动两下就僵住，整个行星面板在上下滑 | `Planet3DCanvas.tsx:616-618`；`PlanetPanel.tsx:94` |
| 7 | 看某根历史 K 线 | 轻点无反应，要**长按 0.24 秒**才出十字线；出来后又横滑不动了（玩家以为卡死） | `ChartPanel.tsx:721,1048-1062`；lwc `dist:9049,12363` |
| 8 | 改脚本 | CodeMirror 12px 触发放大；软键盘没有 Tab/括号，没有补全条 | `ScriptIdePanel.tsx:119` |
| 9 | 把脚本归类到目录 | 只能 **HTML5 拖拽**（触屏完全不支持），行内按钮又 `opacity-0` 看不见 | `FileExplorerPanel.tsx:190-223,266,405` |

### B. 手机竖屏（390×844）

1. 首屏 = **6 个约 102px 宽的面板**（390 − 36 左栏 − 6 padding，再按 0.3/0.58/0.58 递归切分），表格每列 20px，读不了也点不中（`workspaces.ts:62-88`）。
2. 点左栏「K线」→ 开出来的浮窗**默认 460px 宽**，右半截和右上角 ✕ 直接出屏；拖动只限制左边 ≥48px、上边 ≥38px（`FloatingWindowsLayer.tsx:77`），**可以拖到只剩一条竖边在屏幕里**（`DesktopShell.tsx:236-246`）。
3. 唯一的救回入口是顶栏「1 个窗口」列表：行高 22px、✕ 图标 9px、点外部不关闭（`DesktopShell.tsx:566-594`）。
4. 点搜索/单价/密码 → iOS 放大；软键盘又盖住列表和提交按钮（`SearchSelect.tsx:135,194,273`；`AuthScreen.tsx:235-257`）。
5. 横屏后「控制台 / API」两个入口要在一个 36px 宽、需要内部滚动的左栏里找（`DesktopShell.tsx:495-507`）。
6. 顶栏「回合 / 物价指数 / 现金」在 <768px 被 `hidden md:flex` 整体隐藏 —— 交易游戏里看不到现金（`DesktopShell.tsx:431`）。

---

## 3. 问题清单（按"玩家损失"分层，去重后）

### L1 · 主循环断路：开窗 → 摆布局 → 关窗，第 2、3 步走不通（P0）

| # | 玩家感受 | 证据 |
|---|---|---|
| 1 | 平板上**永远没法分割/关闭/置空**面板：动作只在 hover 抽屉里，齿轮无 onClick；偶发合成了 hover，四个 15px 按钮还挤在 70×20px 里，关闭与分割只隔 1.5px | `SplitLayout.tsx:41,68-74,117-122` |
| 2 | **调不了面板比例**：分割条静止时完全透明、仅 4.5px，命中失败会穿透到面板内容（盘口面板上就是下单区） | `SplitLayout.tsx:225-232` |
| 3 | 拖窗/缩放时**第二根手指让窗口瞬间跳到那边**；被系统打断后监听器残留 → 之后滚列表会带着"幽灵拖拽/幽灵分割" | `FloatingWindowsLayer.tsx:71-96,109-121`；`SplitLayout.tsx:189-200`（无 pointerId / capture / pointercancel；全库仅 `Planet3DCanvas.tsx:621,654` 有） |
| 4 | 关窗 ✕ 15px，紧贴 21px 拖拽带，按偏就变成拖窗 | `FloatingWindowsLayer.tsx:139-156` |
| 5 | 手机上**打开的窗就管不了**：默认宽 > 屏宽、只能往左上拖、无最大化、旋转后坐标不重排（外壳层无 resize/orientationchange 监听） | `DesktopShell.tsx:131-140,236-246`；`FloatingWindowsLayer.tsx:77,112-113` |
| 6 | 「拖入空窗口嵌入」在触屏上事实上不可达：能落位的空 tile 本身只能由 hover 抽屉造出来 | `FloatingWindowsLayer.tsx:25-38`；`SplitLayout.tsx:76-114` |

### L2 · 一次误触 = 不可逆损失（P0）

| # | 玩家感受 | 证据 |
|---|---|---|
| 7 | 想给产线「暂停」，按到了旁边 16px 的「**拆除**」（无二次确认） | `FactoryPanel.tsx:225-242` |
| 8 | 盘口深度行约 15px 高、可点即填价；手指一滑填错价位，再点买入就成了真单 | `OrderBookPanel.tsx:298-311,354-373` |
| 9 | 文件/文件夹行右端有四个 `opacity-0` 的按钮（新建/新建子夹/重命名/**删除**）：**看不见但能点到**，删除会弹确认框让人莫名其妙 | `FileExplorerPanel.tsx:265-306,403-426` |
| 10 | 行情列表每行 22px，行内还嵌 9px 的「K线 / 盘口」按钮：想开 K 线却跳进了物品详情，或反过来 | `TickerPanel.tsx:274,295,305` |
| 11 | 会话列表里每行 22px 的「吊销」紧贴行内容，底部「登出其他所有设备」同为 22px 且无二次确认 | `SettingsPanel.tsx:43-48,620-624,664-694`（C-25） |

### L3 · 关键玩法不可用或极难（P0/P1）

| # | 玩家感受 | 证据 |
|---|---|---|
| 12 | **星球转不动**：canvas 无 `touch-action`，祖先 `PlanetPanel.tsx:94` 是 `overflow-y-auto` → 浏览器把单指手势判成滚动、发 `pointercancel`，旋转静默停止 | `Planet3DCanvas.tsx:616-618,654-656` |
| 13 | **点不中地格**：162 格、手机每格约 20×20px（窄面板 11×11），指腹覆盖 4–16 格；且 `moved < 5px` 才当点击，轻微抖动就判成旋转；未命中无任何反馈 | `Planet3DCanvas.tsx:420,496,593-604,637` |
| 14 | **双指/双击 = 整页放大**，固定 100% 桌面壳放大后无法回流；而星球自己**根本没有缩放**（只有 yaw/pitch，全库无 wheel 处理器） | `index.html:5`；`index.css:9-21`；`Planet3DCanvas.tsx:423-424` |
| 15 | K 线读价依赖长按 240ms，长按后进入"跟踪锁存态"：**横滑不再平移、要再点一下才退出**；平移时顶部读数恒为最新一根（与屏幕蜡烛不符） | `ChartPanel.tsx:721,1048-1062`；lwc `dist:9041-9060,10177-10194,12363` |
| 16 | **软键盘盖住候选列表**：SearchSelect 打开即 focus、按 `window.innerHeight` 定位、无 `visualViewport` 重算；候选行仅 24px | `SearchSelect.tsx:135,194,249-259,336` |
| 17 | 脚本归类只能 HTML5 拖拽（触屏不派发 dragstart），无"移动到…"菜单兜底 | `FileExplorerPanel.tsx:190-223,336-370` |
| 18 | 登录/注册页 `h-full overflow-hidden` 居中且不可滚动：键盘弹起后**提交按钮在键盘后面，滚不出来** | `AuthScreen.tsx:235-257,434-450` |

### L4 · 每步都要多试一次（P1，节选）

- **全站输入框 11–13px → iOS 每次聚焦整页放大**：`AuthScreen` 13px、`SettingsPanel` 12px、`SearchSelect` 12px、`OrderBook`/`Ticker`/`Cargo`/`Fleet`/`Memory`/`Console` 11px、CodeMirror 12px（C 卷 G1，20+ 处）。
- **`title=` 承担禁用原因/操作说明**（全库 67 处，面板范围 48 处："为什么不能借款""这里能拖动"），触摸永远不显示（C 卷 G3）。
- **只有 `:hover` 没有 `:active`**：按下无任何反馈，玩家分不清"没按到"还是"卡了"（`index.css:64-112`）。
- **窄面板里固定列宽表格被裁**：`DemandPanel` 列宽合计 ≈408px，面板 <400px 时名称列被压成 0、右侧列被裁，且**没有任何 `overflow-x-auto`**，滑不出来（`DemandPanel.tsx:9,261,285`；全库 panels 0 处 `overflow-x`）。
- **行高 22–26px** 的列表（Ticker 22 / Treasury 24 / SearchSelect 26 / EntitySearch 34）：点第 3 行打开第 4 行。
- **chip 墙 14–17px**：筛选"金属"筛到"食品"（`TickerPanel.tsx:223-240`、`EntitySearchList.tsx:97`）。
- **碎片化滚动**：ItemDetail 内嵌多个 `overflow-y-auto`（`ItemDetailPanel.tsx:149,160,186,211`），手指在哪个区域滑决定滚谁。
- **图表顶栏 16–18px**、**轨道图热区 3.5–5px**（`OrbitPanel.tsx:72-91`）、**行星面板 4 个可点蓝字无按钮外观**（`PlanetPanel.tsx:202-227`）。
- **图表横甩 → 立刻预取 600 根并整批 `setData`**，视图在手指下跳、低端平板卡顿（`ChartPanel.tsx:723-731,428-473,894-898`）。
- **图表纵向拖动是"死手势"**：库默认吞掉竖向拖动，父容器又不滚动，上下划什么都不会发生（lwc `handleScroll.vertTouchDrag` 默认 true）。
- **Console 只能 Enter/↑↓ 召回历史**，触摸没有替代入口（`ConsolePanel.tsx:455-486`）。

### L5 · 观感与可发现性（P2，节选）

- 9px 中文（`text-[9px]` 全库 75 处）+ 10px（174 处）作为**唯一的功能线索**（左栏 9px 标签、badge、计数）。
- 隐藏面板仍满帧重绘（星球 162 个多边形/帧，`Planet3DCanvas.tsx:466-591`）。
- 画布最小尺寸夹取（`Math.max(180, clientWidth)`）导致窄面板星球被压扁、拾取坐标整体偏移（`Planet3DCanvas.tsx:475-483,637-640`）。
- 提示文案写「左/右键拖动以旋转」——触屏没有右键，且真正的功能（点按选中）一个字没提（`Planet3DCanvas.tsx:608-610`）。
- 长按读数条/表头拉起系统选择与放大镜（无 `select-none`/`-webkit-touch-callout`）。
- 列表滚到边界后把手势传给外壳（无 `overscroll-behavior: contain`）→ 橡皮筋/下拉刷新。
- `h-screen`(`100vh`) 在 iOS 上比可视区高，底部 60–100px 被工具栏盖住（`DesktopShell.tsx:366`）。

---

## 4. 五条根因

| # | 根因 | 说明 | 典型证据 |
|---|---|---|---|
| **R1** | **没有手势内核** | 三处拖拽（窗口移、窗口缩放、分割条）都是"pointerdown 里往 window 挂 pointermove/up"：无 `pointerId` 过滤、无 `setPointerCapture`、无 `pointercancel`、无起拖阈值、无选择抑制、无 `touch-action`。多点触控和系统接管手势在移动端是**主线路径**，不是边界情况 | `FloatingWindowsLayer.tsx:71-121`；`SplitLayout.tsx:189-200`（唯一写对的样板：`Planet3DCanvas.tsx:619-655`） |
| **R2** | **hover 是唯一的"显形"机制** | 布局按钮、分割线着色、行内文件操作、候选高亮全用 `hover:` / `onMouseEnter` / `opacity-0 group-hover`。判据：**把鼠标移开屏幕，还看得见的操作才是触摸可用的操作** | `SplitLayout.tsx:68-122`；`FileExplorerPanel.tsx:266,405`；`SearchSelect.tsx:333` |
| **R3** | **尺寸体系是桌面尺寸，还被根字号压了 25%** | 12px 根字号 + rem 工具类 → 4.5/10.5/15/21/27px；设计值本身也低于 44 | `index.css:9-21`；构建 CSS 的 `.h-7{height:1.75rem}` |
| **R4** | **输入与键盘假设 16px 鼠标环境** | 输入框 11–13px → iOS 强制放大；弹层按 `window.innerHeight` 定位且打开即 focus；固定 `100vh`；无 `viewport-fit`/dvh/visualViewport | `SearchSelect.tsx:135,194,273`；`AuthScreen.tsx:130-131`；`DesktopShell.tsx:366` |
| **R5** | **没有窄屏布局，只有"缩小版桌面"** | 固定分屏 + px 浮窗 + 视口断点；面板可以被切到 100px 宽却仍按桌面排版；无容器查询、无单面板模式、无最小面板尺寸 | `workspaces.ts:62-88`；`DesktopShell.tsx:131-140`；`DemandPanel.tsx:9` |

---

## 5. 修复路线（按"玩家卡点解除"排序，不按改动量）

### 第一档 · 止血（约 1–2 天，主循环就能走通）

1. **手势内核**：抽 `useDragPointer()` —— 存 `pointerId` + `setPointerCapture` + `pointercancel/lostpointercapture` 清理 + 8px 起拖阈值 + 拖拽期间 `body{user-select:none}`；替换窗口拖/窗口缩放/分割条三处。**（覆盖 L1-3/4、P1 多条）**
2. **`touch-action` 显式化**：全局交互控件 `manipulation`（去掉双击缩放与 300ms 延迟）；星球 canvas 与拖拽把手 `none`；滚动容器 `overscroll-behavior: contain`。**（解除星球拖不动 + 双击放大）**
3. **hover → tap**：tile 齿轮加 `onClick` 并 pinned + backdrop 收起；文件行操作按钮改常显（或长按菜单）；`.pill-btn/.cta-*` 补 `:active`。
4. **浮窗视口自适应**：开窗 `w=min(w, innerWidth-24)`；拖动/缩放 clamp 保证帧头始终有 ≥88px 在屏内；监听 `resize/orientationchange` 重排；关窗/缩放手柄提到 44px 命中区。
5. **输入与视口**：所有输入框视觉 16px（小字用 scale 或收紧 padding）；`h-screen` → `100dvh`；`` 加 `viewport-fit=cover`。
6. **危险动作加确认**：产线「拆除」、盘口「提交」二次确认或移出误触邻域。

### 第二档 · 一周内（"能用"变"顺手"）

7. 命中区统一：列表行 ≥40–44px（粗指针媒体查询）、行内按钮 44×44、chip 32px、分割条 20px 热区 + 常显 1px 线。
8. 表格改为可横向滚动容器（`overflow-x-auto` + 每列最小宽），或窄面板切"卡片式"布局（容器查询而非视口断点）。
9. SearchSelect：粗指针下不自动 focus、弹层用 `visualViewport` 重算、候选行 40px、必要时改底部抽屉。
10. K 线：`subscribeClick` 点选锁定读数 + "锁定/跟随最新"状态；补放大/缩小/复位按钮；预取防抖。
11. 星球：拾取改"最近格中心 + 12px 容差"、`pointerType==='touch'` 阈值放大；加 zoom（pinch + 滚轮 + 按钮）、双击复位；文案按设备切换。
12. 登录页去掉居中不可滚动：`overflow-y-auto` + `scrollIntoView` 到焦点输入。
13. 文件归类提供"移动到…"显式入口（拖拽只作桌面增强）。

### 第三档 · 结构性（2–3 天起）

14. **窄屏模式**：<768 切单面板 + 底部 tab bar（替代 17 项竖排 rail）；顶栏数值折叠成可点摘要而非隐藏。
15. 面板最小尺寸 + 自动折叠（`minSize: 240px`，不足时改堆叠）。
16. 性能：不可见面板暂停 rAF、十字线读数用 ref 直写、`overscan` 与惯性滚动调参。

### 验收（iPad 竖屏 768×1024 + Android 横屏各跑一遍）

- [ ] 单指在星球上能连续转 360°，行星面板不跟着滚；点选 10 次命中 ≥8 次
- [ ] 双指/双击在任何地方都不改变页面缩放
- [ ] 齿轮一点即出菜单，能分割、能关闭；分割条一次拖动到位
- [ ] 手机上开出的窗全部在屏内，✕ 可点；旋转后仍可操作
- [ ] 点开「切换物品」：页面不放大，键盘弹起后候选仍完整可见
- [ ] 登录页键盘弹起后仍能点到提交
- [ ] 产线/盘口/文件树：单手指腹无一次误触不可逆操作
- [ ] K 线点某根 → 读数锁定该根；再点空白 → 回到最新

---

## 6. 已核对、确认**不是**问题的点（避免误改）

- **不依赖双击/右键**：全库 `onDoubleClick` 0 命中；`onContextMenu` 仅 `Planet3DCanvas.tsx:619` 且已 `preventDefault`。
- **列表滚动是原生滚动**，未被 `wheel` 劫持（全库无 `onWheel`）；触摸滚动本身可用。
- **分割比例按分数持久化**（`splitTree.ts:136-147`），旋转后比例仍成立（只有浮窗 px 坐标不成立）。
- **命令面板不是键盘独占**：顶栏有可点按钮、点遮罩可关（`CommandPalette.tsx:32-34`）。
- **lightweight-charts 的触摸平移/双指缩放本身是好的**，问题在读价语义（长按锁存）与按钮尺寸。
- **Planet3DCanvas 是全库唯一写对手势的地方**（capture / cancel / contextmenu / 点击-拖拽判别），可作为 R1 的样板。

---

## 7. 口径与未验证项

- 纯静态审计：未运行、未真机复现；"手感"类判断（按空概率、fling 空白行、重绘卡顿）标注为**需实机验证**。
- 像素数字均由代码常量按常见视口估算，非截图测量。
- 图表触屏语义依据 `lightweight-charts@4.2.1` 的 `dist` 与 `typings.d.ts` 默认值；升级 v5 需重新核对。
- 本卷只做汇总与去重；逐条证据与修法见 A/B/C 三卷。

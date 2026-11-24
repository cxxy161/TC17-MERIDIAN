# 触摸适配审计 · 桌面外壳与窗口管理

> 审计对象：Meridian 前端外壳层 —— `frontend/src/layout/DesktopShell.tsx`(602 行)、`FloatingWindowsLayer.tsx`(184)、`SplitLayout.tsx`(249)、`workspaces.ts`(209)、`CommandPalette.tsx`、`paneComponents.tsx`、`paneRegistry.ts`，以及它们直接复用的 `EntitySearchList.tsx` / `VirtualList.tsx` / `styles/index.css` / `index.html`。
> 方法：逐行实读上述文件 + 全库 grep（`touch-action` / `pointerId` / `pointercancel` / `setPointerCapture` / `onContextMenu` / `onDoubleClick` / `resize` 监听）+ 只读反查构建产物 CSS（`dist/assets/DocView-B_Dv2QKL.css`，用于确认 rem→px 的真实换算）。
> **未修改任何源码，未运行 build / dev server。** 文内所有 `文件:行号` 均为实读位置。
> 目标设备：iPad 竖屏 834×1194 / Android 平板 800×1280 / 手机 390×844，单指或双指操作。
> 判定基准：命中区 ≥44×44 CSS px；触摸没有 hover、没有右键、没有精确光标；手势不得与滚动/缩放冲突；输入框 <16px 会触发 iOS 自动放大。

---

## 0. 一句话结论

**外壳层的交互是按「鼠标 + 精确光标 + hover 有反馈」写的：玩家在触摸设备上能"开窗"，但开完就失去了对窗口的控制权 —— 不能分割、不能关闭、不能调整、不能拖动关闭按钮出屏的窗口。**

主循环是「左栏开窗 → 摆成想要的布局 → 用 → 关」，触摸下断在第 2 步（布局操作只在 hover 里展开，且按钮 15×15）和第 3 步（窗口默认 460px 宽，比手机屏还宽；拖拽无边界钳制）。

统计：**P0 6 条 / P1 10 条 / P2 5 条**。全部问题都可归并到 3 条根因（见 §5），其中 2 条是「外壳层单独漏做」，同一仓库里已经写对过（`Planet3DCanvas.tsx:619-655`）。

---

## 1. 先看一组数字：根字号把每一处命中区又压了 25%

`styles/index.css:9-21` 给 `html, body, #root` 设了 **`font-size: 12px`**，而 Tailwind 的间距工具类全部是 rem（构建产物可证：`.h-7{height:1.75rem}`、`.w-3\.5{width:.875rem}`、`.h-1\.5{height:.375rem}`，同文件内 `html,body,#root{...font-size:12px}`）。也就是说 **1rem = 12px，所有 `w-N/h-N` 的实际像素只有名义值的 75%**。

| 控件 | 源码位置 | 类名 | 名义(16px 根) | **实际渲染(12px 根)** | 44px |
|---|---|---|---|---|---|
| 左侧导航按钮（17 个） | `DesktopShell.tsx:501` | `w-9 h-9` | 36×36 | **27×27** | ✗ 0.6× |
| 顶栏（含全部顶栏按钮） | `DesktopShell.tsx:368` | `h-9` | 36 | **27** | ✗ |
| 工作区胶囊 / 「N 个窗口」/「⌘K 搜索」 | `index.css:64-97` | `padding:2px 8px; font-size:11px` | — | **≈22 高** | ✗ 0.5× |
| tile 帧头（唯一可拖/可点的条） | `SplitLayout.tsx:62` | `h-7` | 28 | **21** | ✗ |
| tile 四个布局按钮（分割×2 / 关闭 / 置空） | `SplitLayout.tsx:75,85,95,105` | `w-5 h-5` + `p-0.5 gap-0.5` | 20×20 | **15×15，间距 1.5px** | ✗ 0.34× |
| tile 齿轮（布局菜单入口） | `SplitLayout.tsx:119` | `w-5 h-5` | 20×20 | **15×15** | ✗ 0.34× |
| **分割条（调节两个面板比例）** | `SplitLayout.tsx:229-230` | `h-1.5 w-full` / `w-1.5 h-full` | 6 | **4.5** | ✗ **0.10×** |
| 悬浮窗帧头（拖拽把手） | `FloatingWindowsLayer.tsx:141` | `h-7` | 28 | **21** | ✗ |
| 悬浮窗关闭 ✕ | `FloatingWindowsLayer.tsx:153` | `w-5 h-5` | 20×20 | **15×15** | ✗ 0.34× |
| **悬浮窗缩放手柄** | `FloatingWindowsLayer.tsx:172` | `w-3.5 h-3.5` | 14×14 | **10.5×10.5** | ✗ **0.24×** |
| 窗口列表浮层 / 行 / 行内 ✕ | `DesktopShell.tsx:566,578,593` | `w-64` / `px-2 py-1` / `w-3 h-3` | 256 / — / 12 | **192 宽 / ≈22 行高 / 9 图标** | ✗ |
| 玩家 chip 头像 | `DesktopShell.tsx:469` | `h-5 w-5` | 20 | **15** | ✗ |
| 命令面板 / 空窗口搜索框 | `EntitySearchList.tsx:83` | `text-[12px]` | — | 12（px，不受根字号影响） | — |
| 搜索列表行 | `EntitySearchList.tsx:125` | `h-[32px]` | — | **32**（px 单位） | ✗ |
| 分组筛选 chip | `EntitySearchList.tsx:97` | `text-[10px] py-[1px]` | — | **≈17 高** | ✗ |

**没有一个触摸目标达到 44px；最关键的三个（分割条 4.5、缩放手柄 10.5、布局按钮 15）连一个指腹的 1/3 都不到。**

修法注意：**不要把 `index.css:20` 直接改成 16px** —— 那会把整张桌面布局一起放大 33%，在 1366 宽的笔记本上会溢出。应当反过来：给触屏路径引入显式尺寸（帧头 `h-11`、按钮 `min-w-[44px] min-h-[44px]`、分割条 20px 透明热区），或使用 `@media (pointer: coarse)` 覆盖（全库目前 **0 处** `pointer: coarse` / `hover: hover` 查询）。

---

## 2. P0（触摸下功能不可达或会造成误操作/数据丢失）

### T-01 · 触屏上「分割 / 关闭 / 置空」整组操作点不出来

**玩家视角**：平板上想把一个面板切成两半。每个窗口右上角有个齿轮图标，**用手指点它，什么都不会发生**。四个按钮（上下分割 / 左右分割 / 关闭 / 置空）只在你把**鼠标悬停**上去时才现身；即便在桌面上它们也偏小，换成手指连"目标在哪"都看不见。而在出现之后，它们挤在 70×20px 的一条里，「左右分割」和「关闭」只隔 **1.5px** —— 想分割，经常变成把整个窗口关掉（内容直接没了，无撤销）。

**证据**：
- `SplitLayout.tsx:41` `const [actionsHover, setActionsHover] = useState(false);`
- `SplitLayout.tsx:68-72` 唯一的触发源是 `onMouseEnter` / `onMouseLeave`
- `SplitLayout.tsx:73` `{actionsHover ? ( ...四个按钮... ) : ( ...齿轮... )}`
- `SplitLayout.tsx:117-122` 齿轮按钮只有 `aria-label`，**没有 onClick、没有 onPointerDown、没有 onClick 兜底** → 触摸点击不改变任何状态
- `SplitLayout.tsx:74` 容器 `p-0.5 gap-0.5`（= 1.5px），按钮 `w-5 h-5`（= 15px）
- `SplitLayout.tsx:61` 源码注释写明设计意图：`Single-Pane Header (NO tabs inside tile!)` —— 也就是说**不存在 tab 上的关闭按钮**，关闭入口只在这一个 hover 抽屉里

**触发条件**：任何触摸设备；只要想改变布局或关掉某个面板。

**严重度**：P0（关不掉面板 = 主循环断链；误触「关闭」还会丢内容）

**建议修法**：① 齿轮加 `onClick={() => setActions(true)}`，把 hover 态改成可点击的 pinned 态，并盖一层透明 backdrop 点击外部收起；② 触摸下把四个动作放进一个 ≥44px 行高的弹出菜单（或底部 sheet），「关闭」与「分割」分列并加二次确认；③ 关窗动作保留顶栏窗口列表作为退路（见 T-15）。

---

### T-02 · 分割条只有 4.5px、且静止时完全透明

**玩家视角**：想调一下两个面板的宽度。两个窗口之间**没有任何可见的分割线**（静止时是 `bg-transparent`），只有鼠标划过时才闪一下颜色 —— 手指没有"划过"，所以它在触屏上等于不存在。就算你猜到了位置，4.5px 比指甲还窄，按下去命中的是旁边面板里的按钮或表格行（在盘口面板上就是下单控件旁边）。

**证据**：
- `SplitLayout.tsx:225-232`：`h-1.5 w-full` / `w-1.5 h-full`（= 4.5px）、`bg-transparent`、`hover:bg-sky-400/40`
- 全库无任何扩热区的 `::before` / pseudo 元素或 padding hit-area 包装

**触发条件**：任何触摸设备；想调整左右/上下比例时。

**严重度**：P0（命中不可能 → 功能等价于不存在；且落点穿过到面板内容里，有误操作风险）

**建议修法**：视觉线与热区分离 —— 外层一条 **20–24px 的透明命中区**（`-m-2 p-2` 或伪元素撑开），内部 1px 常显细线（去掉 hover 依赖）；命中区加 `touch-action: none`；命中区设 `pointer-events:auto`，视觉线 `pointer-events:none`。

---

### T-03 · 三处拖拽手势没有 pointerId 归属 / 没有 pointercancel / 没有 pointer capture —— 多点触控下窗口会乱飞，被系统打断后产生"幽灵拖拽"

**玩家视角**：
1. 一根手指按住窗口标题条拖动，另一只手（扶平板/握手机）在屏幕任意处落一下 —— 窗口**瞬间跳到第二根手指的位置**，因为它读到的是"任意 pointermove"。
2. iOS/Android 上，滚动或长按照片/文字会让系统接管手势并发 `pointercancel`，而代码只监听 `pointerup`。**被取消的那次拖拽永远收不了尾**：之后玩家在行情列表里上下滑，屏幕上的分割比例或窗口位置会跟着手指乱变（监听器还挂在 `window` 上，且未校验 pointerId）。

**证据**（三处实现完全同构，均缺三件套）：
- 窗口拖动 `FloatingWindowsLayer.tsx:71-81`：`onPointerMove = (ev) => { const dx = ev.clientX - startX; ... onMove(...) }` —— **没有 `ev.pointerId === startPointerId` 判断**
- 收尾只有 `pointerup`：`FloatingWindowsLayer.tsx:83-93, 95-96`；**没有 `pointercancel`**
- 窗口缩放 `FloatingWindowsLayer.tsx:109-121`：同款
- 分割条拖动 `SplitLayout.tsx:189-200`：同款
- 全库 grep 结果：`setPointerCapture` 只有 `Planet3DCanvas.tsx:621` 一处；`pointercancel` 只有 `Planet3DCanvas.tsx:654` 一处 → **外壳层 0 处**
- 也没有 `{ passive: false }` 或 move 阶段的 `preventDefault`，滚动/缩放抢走手势时无任何防护

**对照（同仓库已写对的样板）**：`Planet3DCanvas.tsx:619-655` —— `onContextMenu` 阻止系统菜单、`setPointerCapture(e.pointerId)`、`onPointerCancel` 复位 `draggingRef.active`、以及 `moved < 5` 的点击/拖拽判别。说明这不是团队规范问题，而是外壳层漏做。

**触发条件**：任何双指接触（扶设备、误触、捏合缩放）；任何被浏览器中断的拖拽。

**严重度**：P0（玩家会看到"窗口自己跑"和"列表一滚布局就变"，且无法解释）

**建议修法**：抽一个 `useDrag(opts)` 小 hook：`onPointerDown` 里存 `pointerId` + `setPointerCapture`，`move/up` 里首行 `if (e.pointerId !== id) return`，同时挂 `pointercancel` 与 `lostpointercapture` 做清理，返回 cancel 句柄；三处替换。加 `touch-action: none` 到拖拽把手（注意：这会禁用该元素上的滚动，对把手是对的）。

---

### T-04 · 悬浮窗关闭按钮 15px，紧贴 21px 的拖拽带，按偏就变成"拖窗"

**玩家视角**：想关掉一个悬浮窗，右上角的 ✕ 只有 15×15，而它左边 3px 之外就是"按住即拖"的帧头。按偏一点点，窗户跟着手走（还会被拖到屏幕外，见 T-05）；按准了才关。标题条上还挤着「临时悬浮 · 拖入空窗口嵌入」的绿徽标（`FloatingWindowsLayer.tsx:146-148`），在窄窗口里会把标题挤没，玩家更难确认自己关的是哪个窗。

**证据**：
- `FloatingWindowsLayer.tsx:139-141`：帧头 `h-7`（=21px）、`cursor-move`、`onPointerDown={handleDragStart}`
- `FloatingWindowsLayer.tsx:60-61`：拖拽只在 `closest('button')` 时跳过 → 按钮之外的全部 21px 高度都是拖拽区，两者边界相邻
- `FloatingWindowsLayer.tsx:150-156`：关闭按钮 `w-5 h-5`（=15px）

**触发条件**：任何触摸设备；关窗时。

**严重度**：P0（高频动作 + 与拖拽相邻 + 误拖后窗口可能出屏）

**建议修法**：触摸下帧头 `min-height: 44px`；关闭按钮独立 44×44 热区并贴右侧边缘 44px 宽（或左上角），与拖拽带之间留 ≥8px 空隙；拖拽只在帧头中段生效。

---

### T-05 · 手机上默认窗宽 460–760px 大于屏幕；拖动/缩放只钳制下限 → 关闭按钮能被拖到屏幕外

**玩家视角**：手机竖屏 390px 宽，点左栏「K线」开出来的悬浮窗默认 **460px 宽**（「API」760px），右半截直接出屏，右上角的 ✕ 跟着一起出屏。想把它拖回来 —— 拖动只限制"左边不小于 48px、上边不小于 38px"（`FloatingWindowsLayer.tsx:77`），你可以把它一路拖到右边只剩 48px，这时整个窗口只剩一条竖边露在屏幕里，关不掉；唯一退路是顶栏「N 个窗口」列表（行高 22px、✕ 9px，见 T-15）。旋转平板后，打开的窗口坐标不会重排，同样可能整体跑到屏幕外（外壳层**没有** `resize` / `orientationchange` 监听）。

**证据**：
- `DesktopShell.tsx:236-246`：宽度硬编码 `760/680/600/520/460`，高度 `560/460/380`，**未参考 `window.innerWidth`**
- `DesktopShell.tsx:131-140` `slotPosition`：只做初始定位钳制（`Math.max(12, ...)`），无 `max-width`
- `FloatingWindowsLayer.tsx:77`：`Math.max(48, origX + dx)` / `Math.max(38, origY + dy)` —— **只有下限，没有 `innerWidth - w` 上限**
- `FloatingWindowsLayer.tsx:112-113`：缩放只有 `Math.max(280, ...)` / `Math.max(200, ...)` 下限
- 全库 grep `addEventListener('resize'` → 仅 `VirtualList.tsx:43`、`SearchSelect.tsx:181`；`orientationchange` **0 命中**

**触发条件**：手机（390–430 宽）必现；平板竖屏 768 宽时 460 < 768 可放下，但缩放/拖动后仍可出屏。

**严重度**：P0（手机上是"打开的第一个窗口就管不了"，而且这类设备正是本次评估目标）

**建议修法**：开窗时 `w = Math.min(w, innerWidth - 24)`、`h = Math.min(h, innerHeight - 56)`；拖动/缩放后统一 clamp 到 `[-w+88, innerWidth-88] × [0, innerHeight-44]`（保证帧头始终有 88px 可抓）；监听 `resize`/`orientationchange` 重排所有浮窗；触屏默认给一个"最大化该窗"按钮。

---

### T-06 · iOS 上点一次搜索框，整个桌面被放大且缩不回去

**玩家视角**：iPad 上点顶栏「⌘K 搜索」（这是触屏上打开面板的主入口），或点「＋新建工作区」在输入框里打字 —— Safari 因为输入框字号 <16px **自动放大整页**。由于 `body` 是 `overflow:hidden` 的固定桌面，放大后右侧内容被裁掉、左右也拖不动，输入框失焦后缩放**不会自动还原**。玩家从此停在一个"只能看到半张桌面、按钮更大但点不到另一半"的状态，只能靠双指捏合手动恢复 —— 这个手势与外壳层自己的拖拽/分割手势互相干扰（见 T-03）。

**证据**：
- `EntitySearchList.tsx:75-84`：`<input ... className="flex-1 bg-transparent outline-none text-[12px] ...">`（12px < 16px）
- `DesktopShell.tsx:393-407`：工作区命名输入框 `text-[11px]`
- `index.html:5`：`<meta name="viewport" content="width=device-width, initial-scale=1.0" />` —— 未设 `maximum-scale`，且未引入 `interactive-widget` 等键盘策略
- `index.css:9-17`：`html, body, #root` 全部 `overflow: hidden` + 100% 高度 → 放大后无滚动可补偿

**触发条件**：iOS Safari（iPadOS 同理）首次聚焦搜索框/命名框。

**严重度**：P0（第一步操作即中招，且状态是持久的、不易自愈）

**建议修法**：这两个输入框（以及所有会获得焦点的输入框）`font-size: 16px`；视觉上若必须是小字，用 `transform: scale(0.75)` + 固定高度，或把「搜索」改成先弹全屏 sheet 再渲染 16px 输入框。不要用 `user-scalable=no` 兜（会伤害可访问性，且 iOS 16+ 已部分忽略）。

---

## 3. P1（能用，但每次都要多试、容易误操作、或功能事实上不可达）

### T-07 · 手机首屏就是 6 个约 100px 宽的面板（默认工作区没有窄屏降级，也没有最小面板尺寸）

**玩家视角**：手机竖屏打开即「01 遥测总览」—— 一屏塞 6 个面板，K线/星图在 100px 宽里渲染，表格每列 20px，什么都读不了。而且因为 T-01，**玩家没法自己关掉多余面板来自救**（关窗按钮在 hover 抽屉里）。

**证据**：`workspaces.ts:62-88`（根 `vertical 0.3` → 右侧再 `0.58` → 再 `0.58`，共 6 个叶子）、`SplitLayout.tsx:204-247`（纯 flexBasis 百分比，无 `minSize` / 无断点降级）、`DesktopShell.tsx:431`（全文件唯一一处响应式：`hidden md:flex` 把顶栏数值藏起来，布局本身不动）。
**实测量级**：390 − 36(左栏, `w-12`) − 6(`p-1`) = 348 宽 → 左支 104px，右支 244px → 再分 141px / 102px。

**修法**：窄屏（<768 / <1024）切到"单面板 + 面板切换条"模式（tile 变成可横滑的页），或给分割树设 `minSize: 240px` 并在不足时自动折叠为堆叠（flex-col）。

**严重度**：P1（平板 768+ 尚可，手机不可用；与 T-01 叠加后完全无法自救）

### T-08 · 拖拽没有"起拖阈值"：指腹 2px 抖动就把窗口挪走（震动即失败）

**证据**：`FloatingWindowsLayer.tsx:74` 的 4px 只用于置 `moved`（决定是否落位/嵌入），而 `:77` 的 `onMove` **无条件执行** → 一次点按只要产生 pointermove 就改坐标。同时这是唯一的"拖动判定"，对指腹来说 4px 也过小；`moved` 语义是"是否算拖到空窗口"，不是"是否进入拖拽"。
**修法**：进入拖拽前需要 `距离 > 8px 或长按 150ms`，未达阈值不调 `onMove`；阈值状态与落位判定分开。

**严重度**：P1

### T-09 · 分割条按下即"吸"到指腹，且没有抓取偏移

**证据**：`SplitLayout.tsx:189-194` 直接 `(ev.clientY - box.top) / box.height` 算比例，没有 `startRatio + Δ`、没有 grab offset、没有阈值。手指（宽 8–10mm）按在 4.5px 的条上，接触点与视觉条相差 4–6px，第一帧比例就会跳；轻微抖动还会让"点一下"变成"改比例"。
**修法**：记录 `grabOffset = pointerPos - dividerPos`，比例用 `(pos - grabOffset)`；加 6px 起拖阈值。

**严重度**：P1

### T-10 · 拖拽过程不抑制文本选择 / 长按 callout（分割条上尤其明显）

**证据**：只有帧头带 `select-none`（`SplitLayout.tsx:62`、`FloatingWindowsLayer.tsx:141`），**分割条没有**（`SplitLayout.tsx:225-232`）；全库 layout 目录 **0 处** `onContextMenu`、**0 处** `-webkit-touch-callout`（唯一 `onContextMenu` 在 `Planet3DCanvas.tsx:619`）。`startDrag` 的 `e.preventDefault()`（`:185`）作用在 pointerdown 上，**不能**阻止 iOS 由 touch 长按触发的选择/callout，那属于 touchstart 层默认行为。
**玩家视角**：拖着分割条横穿行情表，手指沿途把表格文字选中并弹出手柄/菜单，手势被系统接管 → 正好撞上 T-03 的"无 pointercancel → 幽灵拖拽"。
**修法**：拖拽开始时给 `document.body` 加 `user-select:none; -webkit-user-select:none; touch-action:none`，结束时移除；分割条自身也加 `select-none`。

**严重度**：P1

### T-11 · 双击缩放仍然生效（全站 0 处 `touch-action`）

**证据**：构建产物 `dist/assets/DocView-B_Dv2QKL.css` 中 `touch-action` **0 命中**；`index.html:5` 未限制缩放；按钮/帧头/分割条均未声明手势意图。
**玩家视角**：连点左栏两个相邻按钮（"行星"→"仓库"）或连点两次齿轮，浏览器可能判成双击缩放，画面被放大；在 4.5px 的分割条上连续试探更会反复触发。
**修法**：交互控件统一 `touch-action: manipulation`（去掉双击缩放与 300ms 等待，保留滚动），拖拽把手/分割条用 `none`。**不要**用 `user-scalable=no`。

**严重度**：P1

### T-12 · 命令面板固定 440px 高 + 60px 上边距，软键盘弹出后结果区被吃掉

**证据**：`CommandPalette.tsx:34` `pt-20`（= 5rem = 60px）、`:38` `w-[560px] max-w-[94vw] h-[440px]`（高度是固定 px，非 dvh/vh，也无键盘感知）。
**玩家视角**：390×844 竖屏，键盘约占 300px（顶在 ~508px），面板底在 60+440=500px，只剩 8px 余量；一旦叠加 T-06 的整页放大，整个列表被推到键盘后面，玩家输完字看不到结果、也滚不到。
**修法**：`max-height: min(440px, 70dvh)`，用 `visualViewport` 的 `resize` 调整高度；或在窄屏改为全屏 sheet。

**严重度**：P1

### T-13 · 横屏手机上，17 个导航按钮塞在 36px 宽、需要内部滚动的左栏里

**证据**：`DesktopShell.tsx:495` `aside w-12`（=36px）+ `overflow-y-auto`；`:501` 按钮 `w-9 h-9`（=27px）+ `gap-1`（3px）。17×27 + 16×3 = **513px**，横屏可用高度约 363px → 「控制台 / API」永远在滚动区外；在一个只有 36px 宽、无滚动提示的条里用拇指滚动，还容易变成点按钮（打开多余的窗口）。
**修法**：粗指针下改底部 tab bar（横排可滑、每项 ≥44 高），或左栏加宽到 56–64px 并支持吸附/分页。

**严重度**：P1

### T-14 · 「拖入空窗口嵌入」在触屏上事实上不可达（依赖链被 hover 堵死）

**证据**：落位只接受**空** tile（`FloatingWindowsLayer.tsx:32` `el.closest('[data-empty-tile="true"]')`），而空 tile 的两条产生路径 —— 分割新开空窗（`SplitLayout.tsx:76-94`）和「置为空窗口」（`SplitLayout.tsx:105-114`）—— 都在 hover 抽屉里（T-01）。默认预设工作区**没有**空 tile。「:25-38` 的 `elementsFromPoint` 命中判定还要求手指抬起处正好落在空 tile 上，而手指本身就遮住落点。
**修法**：允许拖到**任意** tile 并给"替换/并排"二选一；或提供一个显式的"嵌入到…"菜单（选中窗口 → 列出所有 tile）。

**严重度**：P1

### T-15 · 顶栏「N 个窗口」管理面板：行高 22px、关闭图标 9px、点外部不关闭

**证据**：`DesktopShell.tsx:566` `w-64 top-11`（=192px 宽，33px 顶）；`:578` 行 `px-2 py-1` + `text-[11px]` ≈ 22px 高；`:588-594` 关闭按钮内 `X className="w-3 h-3"`（=9px）；`:565-599` 外层无 backdrop、无 `onPointerDown` 外部收起逻辑（只有 header 里一个 9px 的 ✕）。
**玩家视角**：这是触摸下唯一可靠的"救出跑出屏幕的窗口"入口（见 T-05），但它自己就难用；手指点行与点 ✕ 容易互换 —— 点 ✕ 变切窗口，点行变成关窗。
**修法**：行高 ≥44、✕ 独立 44 宽热区且右对齐、加 backdrop 点击收起、支持左滑关闭。

**严重度**：P1

### T-16 · `h-screen`/`w-screen`（100vh）在移动浏览器被工具栏遮挡

**证据**：`DesktopShell.tsx:366` `h-screen w-screen ... overflow-hidden`；`index.css:9-17` `html,body,#root { height:100%; overflow:hidden }`。
**玩家视角**：iOS Safari 的 `100vh` 是"工具栏收起后"的大视口，页面底部 60–100px 落在工具栏下面 —— 正好是最下面一排面板的帧头与（若在那里的）关闭区；Android 地址栏收放会让整个桌面上下跳。
**修法**：改 `h-[100dvh]`（配 `min-height:100vh` 回退）；或给 `@supports (height: 100dvh)` 分支。

**严重度**：P1

---

## 4. P2（可感知的粗糙，但不阻断操作）

### T-17 · 长按系统菜单未被阻止（风险项，取决于浏览器）
外壳层没有任何 `onContextMenu`。拖动帧头/分割条时长按，Android Chrome / iPadOS 可能弹文本选择或链接菜单打断手势（与 T-03 的「无 pointercancel」叠加会产生幽灵拖拽）。建议给拖拽把手加 `onContextMenu={e => e.preventDefault()}`（`Planet3DCanvas.tsx:619` 已有先例）。

### T-18 · 搜索列表用 hover 驱动"键盘高亮"，触屏上高亮不跟手
`EntitySearchList.tsx:123` `onMouseEnter={() => setActive(idx)}`，而高亮只用于 `Enter` 提交（`:54-66`）。触摸没有 hover，点选走 `onClick` 没问题，但"当前项"的视觉反馈会停在旧位置。建议加 `onPointerEnter` 或点按后同步 `active`。

### T-19 · 「更换窗口内容（置为空窗口）」与「关闭此窗口」视觉上不易区分
四个动作按钮只有 hover 配色（`SplitLayout.tsx:95-114`），图标 15px：`X`（关闭）与 `MoreVertical`（置空）在小尺寸下极易混。触屏上 Bear 建议：置空 =  recycler 语义，应放在二级菜单。

### T-20 · 空态/桥接文字全部 9–11px，触屏阅读成本高
`DesktopShell.tsx:505`（导航 9px 标签）、`EntitySearchList.tsx:85,130-139`（计数 10px、badge 9px）、`FloatingWindowsLayer.tsx:146`（徽标 9px）。触屏上这些是唯一的"这个按钮是干什么的"线索。

### T-21 · 顶栏数值在 <768px 被整体隐藏，玩家看不到现金/回合
`DesktopShell.tsx:431` `hidden md:flex`：手机上看不到「回合 / 物价指数 / 现金 / 在线状态」。触摸适配通常意味着手机也要能玩，交易游戏隐藏现金是硬伤 —— 建议折叠成一行可点的摘要，而不是整体移除。

---

## 5. 三条根因（比单点问题更重要）

**R1 · 手势内核缺失（对应 T-03 / T-08 / T-09 / T-17）**
三处拖拽（窗口移、窗口缩放、分割条）都是同一个反模式：`onPointerDown 里往 window 上挂 pointermove/pointerup`，没有 pointerId 归属、没有 capture、没有 pointercancel、没有阈值、没有选择抑制。多点触控与系统手势接管是移动端的**常态**而非异常，所以这不是"边界情况"，是主线路径。仓库里已有正确样板（`Planet3DCanvas.tsx:619-655`），抽一个 `useDragPointer()` 统一三处即可。

**R2 · hover 是唯一的"显形"机制（对应 T-01 / T-02 / T-14 / T-18）**
布局按钮、分割条着色、搜索行高亮、悬浮窗文件操作全部用 `hover:` 或 `onMouseEnter` 承载"存在感"。触摸下 hover 只会被合成一次（且时机在 click 之后），于是这些 UI 要么看不见、要么要双击、要么把首次点击吃掉。判据很简单：**把鼠标移开屏幕，还能看见的操作才是触摸可用操作**。

**R3 · 尺寸体系是桌面尺寸（对应 §1 表格 / T-04 / T-07 / T-13 / T-15）**
12px 根字号让所有 rem 尺寸再缩 25%，而设计时用的名义值（28/20/14/6）本身就已经低于 44。修复要显式引入触摸尺寸，而不是整体放大根字号。同时没有一处 「<768 布局降级」，默认 6 面板工作区在手机上直接变成 6 条 100px 的缝。

---

## 6. 玩家旅程复现（照着做，30 秒内能撞到）

**A. iPad 竖屏 834×1194**
1. 打开游戏 → 6 面板布局尚可读。
2. 想把手上的「K线」拉宽 → 找不到分割线（静止透明，4.5px）→ 乱点，命中旁边的下单按钮（T-02）。
3. 想关掉「控制台」→ 点右上齿轮无反应（T-01）→ 只能靠猜 hover（触屏无 hover）。
4. 想开「API」→ 点左栏，弹出 760 宽浮窗（可放下）→ 想调整 → 右下 10.5px 手柄几乎按不到（T-04/T-08）→ 误拖出屏（T-05）。
5. 点「⌘K 搜索」→ 页面被放大，右侧被裁，回不去（T-06）。

**B. 手机 390×844**
1. 首屏 6 个 ~102px 面板（T-07）。
2. 点左栏「K线」→ 460px 宽的浮窗，右侧与 ✕ 出屏（T-05）。
3. 想关 → 顶栏「1 个窗口」→ 22px 行 + 9px ✕（T-15）。
4. 点搜索框 → iOS 放大（T-06）。
5. 横屏 → 「控制台/API」按钮要在一个 36px 宽的条里内部滚动才能到（T-13）。

---

## 7. 建议修复顺序（最小改动集，按收益/成本排序）

| 顺序 | 动作 | 覆盖 | 成本 |
|---|---|---|---|
| 1 | 抽 `useDragPointer`（pointerId + setPointerCapture + pointercancel + 阈值 8px），替换 3 处 | T-03, T-08, T-09, T-17 | 半天，单文件 hook + 3 处替换 |
| 2 | 齿轮加 `onClick`，hover 抽屉改成点击 pinned + backdrop；动作按钮 ≥44 | T-01, T-14 | 半天 |
| 3 | 分割条 20px 热区 + 常显 1px 线 + `touch-action:none`；悬浮窗手柄 24–44 + 帧头 44 | T-02, T-04 | 2–3 小时 |
| 4 | 开窗/拖动/缩放 clamp 到视口 + `resize`/`orientationchange` 重排 + 触屏最大化按钮 | T-05, T-16 | 半天 |
| 5 | 输入框 16px（或全屏 sheet）+ 面板 `max-height: min(...,70dvh)` | T-06, T-12 | 2 小时 |
| 6 | `touch-action: manipulation` 全局工具类；去掉 hover 作为唯一状态源 | T-11, R2 | 半天（面广，可分批） |
| 7 | 窄屏降级：<768 单面板 + 底部 tab bar；顶栏数值改为可点折叠 | T-07, T-13, T-21 | 2–3 天 |

前 4 项做完，触摸设备上「开窗 → 摆布局 → 关窗」的主循环就通了；第 7 项之前，手机端只能算"能开、能看一个窗"，不能算可用。

---

## 8. 已核对、确认**没有**问题的点（避免重复排查）

- **不依赖双击 / 右键**：layout 目录内 `onDoubleClick` / `dblclick` **0 命中**；`onContextMenu` 0 命中（全库唯一在 `Planet3DCanvas.tsx:619` 且已 `preventDefault`）。所以不存在"触屏没有右键导致功能丢失"这一类问题。
- **滚动是原生滚动**：`VirtualList.tsx:51-53,77-81` 用原生 `onScroll` + 内部滚动容器，触摸滚动可用，没有被 `wheel` 劫持（全库无 `onWheel`/`deltaY` 命中）。
- **分割比例用分数持久化**：`splitTree.ts:136-147` `ratio` 钳制在 `0.12–0.88` 且以比例存储，旋转设备/改变窗口大小后比例本身仍成立（只有浮窗的 px 坐标不成立，见 T-05）。
- **命令面板不是键盘独占**：`DesktopShell.tsx:459` 有可点击的「⌘K 搜索」按钮；`CommandPalette.tsx:32-34` 点遮罩可关闭，不需要按 Esc。触屏打开面板的入口是通的，问题只在打开之后的尺寸（T-12）。
- **空窗口有搜索式填充**：`paneComponents.tsx:62-76` + `EntitySearchList`，不依赖拖拽也能把面板放进空 tile（虽然空 tile 本身难造出来，见 T-14）。
- **已有正确的触屏手势样板**：`Planet3DCanvas.tsx:619-655`（capture / cancel / contextmenu / 点击-拖拽判别）。

---

## 9. 跨文件观察（不在本文件结论内，交 B 组复核）

- `FileExplorerPanel.tsx:266` 与 `:405`：行内操作按钮 `opacity-0 group-hover:opacity-100` —— 触屏上**永远不可见**（新建/删除/重命名入口），与 T-01 同类根因（R2）。
- `AuthScreen.tsx:416`：仅 `hover:text-slate-400` 的 label，影响低。
- 面板层可能还有 <16px 的输入框（T-06 同类），建议对 `src/panels/**` 做一次 `<input|textarea` 的 font-size 扫描。

---

## 附录：证据核对命令（只读，可复跑）

~~~bash
# 1) 尺寸体系：根字号 12px + Tailwind rem 工具类（构建产物佐证）
grep -o 'html,body,#root{[^}]*}' frontend/dist/assets/DocView-B_Dv2QKL.css
grep -o '\.h-7{[^}]*}'            frontend/dist/assets/DocView-B_Dv2QKL.css
grep -o '\.h-1\.5{[^}]*}'         frontend/dist/assets/DocView-B_Dv2QKL.css
grep -o '\.w-3\.5{[^}]*}'         frontend/dist/assets/DocView-B_Dv2QKL.css

# 2) 手势内核：外壳层 0 处 capture / cancel / pointerId 过滤
grep -rn 'setPointerCapture\|pointercancel\|pointerId' frontend/src
grep -rn 'PointerDown\|PointerMove\|PointerUp' frontend/src/layout

# 3) 触摸意图：全站 0 处 touch-action
grep -rn 'touch-action' frontend/src frontend/dist/assets/*.css

# 4) hover 作为唯一显形机制
grep -rn 'onMouseEnter\|group-hover\|opacity-0' frontend/src

# 5) 视口 / 输入框自动缩放
sed -n '1,8p' frontend/index.html
grep -rn 'text-\[1[0-5]px\]' frontend/src/layout

# 6) 无尺寸重排
grep -rn "addEventListener('resize'\|orientationchange\|visualViewport" frontend/src
~~~

> 备注：本报告只读审计，**未改动任何前端源码**；唯一写入是 `docs/audit/touch-shell.md` 自身。

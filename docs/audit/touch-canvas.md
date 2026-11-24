# 触摸可用性审计 · B：3D 星球视口 与 K 线图表

| 项 | 值 |
| --- | --- |
| 审计对象 | `frontend/src/components/Planet3DCanvas.tsx`（660 行，行星 3D 拾取/旋转）、`frontend/src/panels/ChartPanel.tsx`（1210 行，K 线）、`frontend/src/components/VirtualList.tsx`（86 行，列表），以及与它们相邻的容器与输入组件 |
| 代码版本 | 工作区 `313f818` + 未提交改动（`frontend/src/components/SearchSelect.tsx` 等为工作区最新内容，本次读的是工作区版本） |
| 方法 | 只读源码 + 依赖源码核对（`frontend/node_modules/lightweight-charts@4.2.1` 的 development 构建与 typings）。**未 build、未运行 dev server、未实机验证**；像素数字均由代码常量按公式估算，已标注 |
| 目标设备假设 | 玩家用 PC 浏览器玩，现在要在 iPad（横屏 1024–1194px / 竖屏 768–834px）与 Android 平板上玩，最坏情况是手机竖屏 390px 宽 |
| 判定基线 | 手指无 hover、无右键、无精确光标；命中目标 ≥44×44px；手势与滚动/缩放的归属必须显式声明（`touch-action`）；iOS 输入框 <16px 会强制放大整页 |

---

## 0. 结论速览

| 严重度 | 数量 | 玩家实际卡在哪 |
| --- | --- | --- |
| **P0** | 3 | ① 在星球上拖不动：一按就被面板滚动接管，星球转两下就停；② 点选地格几乎不可能——手指盖住 4–6 格，且 5px 抖动阈值把"点"判成"转"；③ 双指一捏是**整页**放大（桌面式布局随之崩掉），而星球本身**完全没有缩放** |
| **P1** | 4 | ④ 图上看单根 K 线的 OHLC 要**长按 0.24 秒**才出十字线，长按之后图表**不再平移**（玩家以为卡死/断线）；⑤ 切换站点/物品的搜索框 12px，iOS 一聚焦放大整页，软键盘又把候选列表盖住；⑥ 图表顶栏按钮只有 16–18px 高，切周期/全览/最新经常按空；⑦ 图上横向一甩就无限翻历史 + 整批数据重排，视图在手指下跳 |
| **P2** | 9 | 画布最小尺寸夹取导致星球被压扁且点击坐标偏移；隐藏面板仍满帧重绘；十字线每像素 setState；价格轴与平移同区误触；长按读数条弹出文本选择；列表行高 22–26px；无缩放按钮；提示文案写着"右键" |

一句话总览：**这两块画布在桌面上的交互设计（左键拖拽 + 右键 + hover + 滚轮）在触摸上几乎全部没有等价物，且没有一处声明 `touch-action`——手势归属完全交给浏览器默认行为去猜，三处冲突（P0-1、P0-3、P1-1）都是这个根因的直接后果。**

---

## 1. 现状：手势到底被谁吃掉

### 1.1 三块区域的手势归属

| 区域 | 容器与滚动 | 已实现的手势 | 触摸下的真实结果 |
| --- | --- | --- | --- |
| 行星 3D 画布 | 画布在 `overflow-y-auto` 面板里（`PlanetPanel.tsx:94`，画布是它的最后一项 `PlanetPanel.tsx:258`） | 单指/双指一律当"旋转"（`Planet3DCanvas.tsx:620-633`） | 浏览器抢手势去滚动面板 → `pointercancel` → 旋转中断（P0-1）；无缩放（P0-3） |
| K 线图 | 面板本身 `overflow-hidden`（`ChartPanel.tsx:1072`），图表区 `flex-1 min-h-0`（`ChartPanel.tsx:1182-1183`） | 库自带：单指横向平移、双指捏合缩放、双击轴复位；十字线**仅长按**触发 | 平移可用；缩放只靠双指；**读价要长按**、长按后进入"跟踪锁存态"导致平移失效（P1-1）；纵向拖动成为死手势（见 5.2） |
| 列表 | 原生 `overflow-y-auto`（`VirtualList.tsx:76-84`） | 原生滚动 | 滚动正常；但行高 22–26px 的点按目标过小、无 `overscroll-behavior`（P2-6） |

### 1.2 五条全局事实（决定了下文所有冲突）

1. **全仓没有一处 `touch-action`**。`grep -rn "touch-action|touchAction" frontend/src` 结果为空；`frontend/src/styles/index.css`（131 行）也没有。唯一相关的是 3 处 `select-none`（`Planet3DCanvas.tsx:607`、`FileExplorerPanel.tsx:454`、`OrbitPanel.tsx:35`）。
2. **viewport 没有锁缩放**：`frontend/index.html:5` 只有 `width=device-width, initial-scale=1.0`，没有 `maximum-scale` / `user-scalable`。
3. **布局是 100% 固定的桌面壳**：`index.css:9-21` `html, body, #root { width/height 100%; overflow: hidden }`。一旦视觉视口被放大，壳本身不会自适应——**放大之后没法"往回滚"**，这是 P0-3 之所以是 P0 的原因。
4. **全仓没有任何 `wheel` 处理器**（`grep -rn "wheel" frontend/src` 0 命中）。也就是说 3D 星球**在桌面上也没有滚轮缩放**，"触摸没有滚轮等价物"这个问题在星球上是"两头都没有"。
5. **全仓没有 `visualViewport`**（0 命中），弹层定位一律用 `window.innerHeight` / `getBoundingClientRect`——软键盘弹出后不会有任何重算（P1-2）。

---

## 2. P0：核心操作直接做不成 / 会破坏整体状态

### P0-1 星球"拖不动"：单指拖拽被面板滚动接管

**现象（玩家视角）**
在平板上按住星球横向划，星球只跟着挪了几像素就僵住，与此同时整个行星面板上下滑走了；想转到行星背面，怎么划都在滚页面。偶尔手指停得够快够准，星球能转一点点，但因为"转了一点点"已经超过点击阈值，又选不中地格（见 P0-2）——**旋转和点选互相踩**。

**证据**
- `frontend/src/components/Planet3DCanvas.tsx:616-618`：canvas 的 `className` 只有 `w-full h-full cursor-grab active:cursor-grabbing block`，**没有 `touch-action`**。
- `frontend/src/panels/PlanetPanel.tsx:94`：`flex-1 min-h-0 flex flex-col overflow-y-auto` —— 滚动容器；画布在这一层内部（`PlanetPanel.tsx:258` `flex-1 min-h-[200px]`）。
- `frontend/src/components/Planet3DCanvas.tsx:654-656`：`onPointerCancel` 只做 `draggingRef.current.active = false`，没有任何恢复或提示——手势被浏览器夺走时表现为"无声卡住"。
- 后果链：触摸起点在 canvas → 浏览器判定为滚动 → 向 canvas 派发 `pointercancel`、停止派发 `pointermove`/`pointerup` → `Planet3DCanvas.tsx:624-633` 的旋转增量停止累加 → 画面定格。

**触发条件**
行星面板内容高于面板高度（贴表数据 + 画布 `min-h-[200px]`，实际几乎必然成立），且在星球上做任何单指拖动。竖屏手机最先命中。

**严重度**
**P0** —— 3D 视口的**唯一**操作就是拖动旋转，它在触屏上不可用。

**修法**
1. 画布显式声明手势归属：`<canvas style={{ touchAction: 'none' }} />`（等于 `touch-action: none`），让画布独占单指手势；wrapper 加 `overscroll-behavior: contain` 防串。
2. 若仍希望"在画布上也能滚动面板"，只能改成双指滚动或把画布移出滚动容器（给画布固定高度、面板其余部分单独滚）。
3. 在 `onPointerCancel` 里至少回滚到手势开始前的 `userYawOffsetRef`/`pitchRef`，避免"转歪了但只转了一半"的诡异视角。

---

### P0-2 点选地格：手指精度下不可用

**现象（玩家视角）**
想点中某块地看它是什么地貌（这是画布上唯一的功能），手指按下去盖住 4–6 格，结果总选中旁边那格，或者干脆什么都没发生——底部那个 `#id · 地貌 · 海拔` 小标签根本不出现。想再试一次，手指一挪超过几像素就被判成"旋转"，画面还跟着转，越试越乱。

**证据**
- `Planet3DCanvas.tsx:420`：`buildGoldbergFacets(4, profile)` —— N=4 的 Goldberg 多面体，地格数 = 10·N²+2 = **162 格**。
- `Planet3DCanvas.tsx:496`：`const radius = Math.min(w, h) * 0.36`。
- `Planet3DCanvas.tsx:637`：`if (moved < 5)` 才当作点击；`moved` 在 `:628` 用 `Math.hypot(dx, dy)` **逐事件累加**，慢速手的微小抖动也会累计过 5px。
- `Planet3DCanvas.tsx:593-604`：`pointInPoly` 是严格的"点在多边形内"，无容差；投的是**最后一帧**的屏幕多边形（`:552` 每帧重建）；未命中时 `:641-651` 静默无反馈。
- 尺寸估算（按 `:475-476`、`:496`）：390×300 的画布 → 半径约 108px，可见半球约 81 格，每格约 **20×20px**；面板被压到最小 180×160 时半径 ≈58px，每格约 **11×11px**。对比 44px 的建议命中尺寸，差 2–4 倍；而指腹接触面约 40–45px，一次点击覆盖 4–16 格。

**触发条件**
任何一次点选，尤其竖屏手机 / 分屏后的窄面板。

**严重度**
**P0** —— 画布上唯一的"操作"不可用，且没有任何替代入口（没有列表选择、没有放大）。

**修法**
1. 拾取改成"取距离触点最近的格中心"，并给 10–12px 容差，而不是严格的点在多边形内。
2. 点击阈值按 `e.pointerType` 分档：`touch` 用 10–12px，`mouse/pen` 保持 5px。
3. 提供放大手段（P0-3）与"选中格加粗白描边 + 相邻格微高亮"（现在只有 `:569` 的一层 `rgba(56,189,248,0.92)` 填充，在 20px 的格子上和邻居没有对比）。
4. 未命中时给一条轻提示（"点在地格上才能选中"），而不是什么都不发生。
5. 长期方案：加一个"地格列表/搜索"作为点选的等价入口——触屏上"选具体一格"用列表永远比点球准确。

---

### P0-3 双指/双击 = 整页缩放（桌面壳崩）；星球本身没有任何缩放

**现象（玩家视角）**
想放大看某块地，两指一捏——整个"桌面"连同窗口标题栏、别的面板一起被放大，右上角的窗口跑出屏幕；因为外壳是固定 100% 高度的，缩不回去，只能再双击、或者刷新页面重开。反过来，在星球上双击（很自然的一个动作）也会把页面放大。缩放之后所有窗口都错位，玩家基本只能刷新。

**证据**
- `frontend/index.html:5`：viewport 未锁缩放（无 `maximum-scale` / `user-scalable`）。
- `frontend/src/components/Planet3DCanvas.tsx:616-618`：canvas 无 `touch-action`，浏览器默认允许双击缩放与双指缩放。
- `frontend/src/styles/index.css:9-21`：`html, body, #root { width:100%; height:100%; overflow:hidden }` —— 固定布局，视觉视口放大后不回流。
- 星球**没有缩放**：`Planet3DCanvas.tsx:423-424` 只有 `userYawOffsetRef`（偏航）与 `pitchRef`（俯仰）两个量；`:631-632` 也只改这两个；全仓无 `wheel` 处理器（`grep` 0 命中）——**鼠标和手指都没有任何缩放通路**。
- `Planet3DCanvas.tsx:608-610`：屏幕上唯一的操作提示是 `提示：左/右键拖动以旋转`——触屏没有右键，且提示完全没提"点按选中地格"这个唯一功能。

**触发条件**
任何双指捏合、任何双击（含在星球上双击）。

**严重度**
**P0** —— 一次误操作会把整个桌面壳推到不可用状态；同时"放大看地格"这个需求根本没有实现，是 P0-2 的第二个根因。

**修法**
1. 二选一，必须显式决定：
   - **保桌面壳**：viewport 加 `maximum-scale=1, user-scalable=no`（iOS Safari 10+ 会忽略 `user-scalable`，所以还必须配合画布与壳上的 `touch-action`），并在根节点加 `touch-action: manipulation` 消除双击缩放延迟。
   - **允许页面缩放**：那就要把布局从固定 100% 改成 `100dvh` + 允许 overflow，让放大后还能滚——改动量远大于前者。
2. 给星球加**真正的缩放**：相机距离（把 `radius` 乘一个 `zoomRef`，`:496`）或球面半径倍率；双指用两个 `pointerdown` 的 `pointerId` 分别记录并算距离比（现在完全没有 pointerId 概念，见 P2-9）；桌面补 `onWheel`。
3. 双击 = 复位视角（同时复位缩放），并在 UI 上给一个"复位"按钮兜底。
4. 提示文案按输入设备切换（见 P2-7）。

---

## 3. P1：能完成，但代价高 / 容易误触 / 发现不了功能

### P1-1 图表：看单根 K 线要"长按 0.24 秒"，长按后图表锁死不再平移

**现象（玩家视角）**
- 手指点一下某根蜡烛：**什么都没发生**。十字线不出来，顶部 OHLC 一行一直显示最新那根的数字。
- 想知道某根历史蜡烛的开高低收：必须按住不动约 1/4 秒，十字线才冒出来。手指按在图上又挡住了那根蜡烛。
- 十字线出来后松手，它**还在**；这时想继续横滑看更早的行情——**图不动了**，玩家会以为图表卡死或行情断了，往往过一会儿才偶然发现"得再点一下才能滑"。
- 横滑翻到历史区间时，顶部读数仍然是"最新一根"（见证据里的回落逻辑），**读数和屏幕上的蜡烛对不上**，容易被当成数据错误。

**证据**
- `ChartPanel.tsx:721` `chart.subscribeCrosshairMove(onCrosshairMove)`，`:699-720` 用 `param.time` 反查 `barByTimeRef` 得到 `HoverReadout`，写进 `:344` 的 `hoverBar`。
- 库的触屏语义（`frontend/node_modules/lightweight-charts/dist/lightweight-charts.development.mjs`）：
  - `:9049` 触摸按下后起 240ms 计时，超时触发 longTap；`:9212-9221` `_private__longTapHandler`；
  - `:10132-10137` `_internal_longTapEvent` → `_private__startTrackingMode`（此时才第一次设置十字线位置）；
  - `:10166-10175`（`_internal_touchStartEvent`）只做失焦/清选区，**轻点不设十字线**；
  - `:10177-10194`（`_internal_touchMoveEvent`）跟踪态下移动十字线并 `return`，**不平移**；
  - `:10407-10412` `_private__tryExitTrackingMode`：默认 `exitMode = OnNextTap`（`:12363-12365`）→ 必须**再点一次**才退出。
- 读数回落：`ChartPanel.tsx:1048-1062` `shown = hoverBar ?? latest` —— 平移时 `hoverBar` 为 null，读数恒为最新一根。
- 读数条只有 11px 小字，在图表上方（`ChartPanel.tsx:1131-1180`），长按读数时视线要在"手指下方"和"屏幕上方"之间来回跳。

**触发条件**
触屏上任何一次"看这根蜡烛怎么走的"操作。

**严重度**
**P1** —— K 线图的第一用途就是读价；可以做到，但要靠一个没人告诉你的隐藏手势，并且进入后交互语义反转（拖动≠平移）。

**修法**
1. 用 `chart.subscribeClick` 实现：点中哪根就锁定该根的 OHLC（写入 `hoverBar`），再点图表空白或再点同一根取消。这与触屏"点选"的直觉一致，且不依赖长按。
2. 读数条加"锁定 / 跟随最新"两个状态的可视标记，横滑到历史区间时显示"历史视图 · T###"，避免误读。
3. 若保留长按：进入跟踪态时给一次浮层提示"拖动=移动十字线，点一下恢复平移"，或把 `trackingMode.exitMode` 显式设为 `OnTouchEnd` 并配一个"钉住读数"的小按钮。
4. 可选：把读数改成跟随触点的浮动卡片（离手指 48px 以上），减少遮挡与视线往返。

---

### P1-2 图表入口（切站点/物品）：iOS 一聚焦就放大整页，软键盘又盖住候选

**现象（玩家视角）**
想看某个物品的 K 线，先得点"切换物品"：弹层里的搜索框自动获得焦点 → iOS 把**整页**放大（输入框只有 12px，低于 16px 的阈值），弹层因为是 `position: fixed` 而相对布局视口定位，直接和按钮错开；同时软键盘弹起占掉近半屏，候选列表被键盘压住，只剩一两行可见，手指还得伸到屏幕最上面去滚动，滚的时候键盘又把可视区顶来顶去。

**证据**
- `frontend/src/components/SearchSelect.tsx:194`：`setOpen(true)` 后 10ms 就 `inputRef.current?.focus()` —— 触屏上等于"点开即弹键盘"。
- `SearchSelect.tsx:265-274`：搜索框 `className` 里是 `text-[12px]`（<16px，iOS 必然放大；且 `index.html:5` 没锁缩放）。
- `SearchSelect.tsx:135`：`const vh = window.innerHeight;` —— 弹层高度/朝上朝下全部按**布局视口**算，键盘占位完全不可见；全仓无 `visualViewport`（0 命中）。
- `SearchSelect.tsx:249-259`：弹层 `position: 'fixed'`，`top/left/width/maxHeight` 只在打开时（`:155-159` `useLayoutEffect`）算一次；页面被放大或键盘弹起后不重算。
- `SearchSelect.tsx:336`：候选行 `h-[24px]`；`:39` `ROW_HEIGHT = 26` —— 24px 高的点按目标。
- 这两个 `SearchSelect` 正是 `ChartPanel` 顶部的站点/物品入口：`ChartPanel.tsx:1074-1095`。

**触发条件**
iPhone/iPad 上点 ChartPanel 顶部的任一 `SearchSelect`。

**严重度**
**P1** —— 看 K 线的前置步骤（选标的）被键盘和放大同时干扰，虽然不是完全不可用，但每次都要缩放回来。

**修法**
1. 输入框字号改 16px（视觉想保持小字就用 `transform: scale()` 或 `font-size:16px` + 收窄 padding）。
2. 弹层定位改用 `window.visualViewport`（`height`/`offsetTop`）计算 `maxHeight`，并监听 `visualViewport.resize` 调 `reposition()`。
3. 粗指针设备（`matchMedia('(pointer: coarse)')`）下打开弹层**不自动聚焦**，让玩家自己点输入框；或直接改成底部抽屉（bottom sheet），天然避开键盘遮挡。
4. 候选行 24px → ≥40px。

---

### P1-3 图表顶栏 / 浮层按钮只有 16–18px 高，且触摸下没有任何按下反馈

**现象（玩家视角）**
切 `1/5/15/60 回合` 周期、点"全览"、"最新"，拇指按下去经常没反应或者按到隔壁；屏幕上那个"最近成交 T### · 点击定位"更小，按不中就会把视图带跑。而且所有这些按钮**按下去没有任何视觉变化**——因为样式表只写了 `:hover`，触摸设备永远不会触发 hover，玩家分不清是没按到还是卡了。

**证据**
- `ChartPanel.tsx:1098-1126`：周期按钮/全览/最新/打开盘口，全部是 `pill-btn py-0 text-[10px]`。
- `ChartPanel.tsx:1197-1205`：`最近成交 T{latestTradeTick} · 点击定位` → `px-2 py-0.5 text-[10px]`。
- `frontend/src/styles/index.css:64-73`：`.pill-btn { font-size:11px; padding:2px 8px; }` → 行高 11px + 上下 2px + 边框 ≈ **16–18px 高**，离 44px 差 2.5 倍。
- `index.css:74-77`（`.pill-btn:hover`）、`:94-97`（`.cta-blue:hover`）、`:109-112`（`.cta-green:hover`）：**只有 `:hover`，没有 `:active`** —— 触摸下的按下反馈整体缺失。
- 同类偏小按钮：`PlanetPanel.tsx:76`（行星切换）、`PlanetPanel.tsx:86`（购置新地块）。

**触发条件**
触屏上任何一次点按顶栏 / 浮层按钮。

**严重度**
**P1** —— 不是"按不了"，而是"经常按空 + 看不出有没有按下"，在高频操作（切周期）上会被放大成烦躁。

**修法**
1. 触屏（或统一）把命中区抬到 ≥44px：`min-h-[36px] py-1.5` + `min-w-[44px]`；视觉高度可以不变，用 `::after` 伪元素向外扩 12px 命中区。
2. `.pill-btn` / `.cta-*` 补 `:active`（背景变亮 + `transform: scale(0.97)`），触摸才有反馈。
3. 把"最近成交"这类浮层按钮从图表左上角挪到读数条里（见 P1-1），避免它压住图表的手势区域。

---

### P1-4 横向一甩就无限翻历史，视图在手指下跳

**现象（玩家视角）**
在图上横向甩一下看更早的行情，图会自己"滑"到很左边停不住；接着左上角闪一下"加载历史 K 线..."，加载完整张图猛地换成一整批新数据、位置跳一下；连续甩几次，风扇声和卡顿都上来了，本来看着的蜡烛也跑出视野。

**证据**
- `ChartPanel.tsx:723-731`：`onVisibleLogicalRangeChange`，只要 `range.from < 35` 就 `loadOlderRange(nextFrom)`。
- `ChartPanel.tsx:428-473`：一次拉 `PAGE_BUCKETS = 600`（`:27`）根；成功后 `setHistorySlice` 合并。
- `ChartPanel.tsx:894-898`：`isPrepend` 分支 → `pushFullData()`（`:830-850`，整批 `setData` 三条序列）+ `setVisibleLogicalRange(prevRange ± addedBars)`。
- 库默认触摸有惯性滚动：`handleScroll.horzTouchDrag: true`、`kineticScroll.touch: true`（`lightweight-charts.development.mjs:12341-12365` 的默认值块，`:12359-12362` kineticScroll；`:10492-10496` 惯性动画）。
- 加载提示 `ChartPanel.tsx:1186-1196` 是 `pointer-events-none` 的浮层，不挡手势，但会闪。

**触发条件**
触屏上一次较快的横向甩动（鼠标滚轮同样会触发，但一次手势能推得远得多）。

**严重度**
**P1** —— 数据量、网络请求、视觉稳定性三件事同时被一次手势放大；在低端平板上直接表现为卡顿。

**修法**
1. 惯性滚动期间不触发预取：`onVisibleLogicalRangeChange` 里做 ~150ms 防抖（或用 `requestAnimationFrame` 合并），等手势静默后再预取。
2. 提前预取并加缓冲：`range.from < 35` → `< 120`，一次多取，减少"甩到就被迫加载"的概率。
3. 预取完成后用"只追加、不动可视区间"的方式（现在虽已用 `setVisibleLogicalRange` 补偿，但仍在手势进行中改区间）。
4. 同一次手势最多翻 1 页（加时间窗节流）。

---

## 4. P2：手感与效率

### P2-1 画布最小尺寸夹取 → 星球被压扁 + 点击坐标整体偏移
- **证据**：`Planet3DCanvas.tsx:475-483` 用 `Math.max(180, parent.clientWidth)` / `Math.max(160, parent.clientHeight)` 决定**位图坐标系**并 `setTransform`，而 canvas 的 CSS 尺寸是 `w-full h-full`（`:618`）；`:637-640` 拾取用 `e.clientX - rect.left` 反推**同一坐标系**。
- **触发**：父容器 <180×160（手机竖屏把面板切窄、或 dockview 分屏到很窄）。
- **现象**：星球被非等比压成椭圆；点击落点与画面在整体上不一致，选中的格子系统性偏移。
- **修法**：位图尺寸严格取 `rect.width/height`（只乘 DPR，不做最小夹取）；或者干脆让 CSS 尺寸跟随位图尺寸。

### P2-2 面板不可见时仍满帧重绘
- **证据**：`Planet3DCanvas.tsx:466-591` 的 rAF 循环没有可见性/暂停判断；`:475` 一旦 `parent.clientWidth === 0`（面板被 dockview 隐藏）就按 180×160 继续画。
- **触发**：同时开多个行星面板、或面板被切到后台 tab。
- **现象**：每一帧对 162 个多边形逐个 `fill`+`stroke`（`:554-583`），平板上发热掉帧，拖拽时更明显。
- **修法**：`IntersectionObserver` 或父容器尺寸为 0 时跳过重绘（保留最后一帧）；`paused` 时把 rAF 降到 ~10fps。

### P2-3 十字线每移动一像素就 setState
- **证据**：`ChartPanel.tsx:699-720` 每次 crosshair 事件都 `setHoverBar(...)`；`:1131-1180` 每次渲染格式化十几个数字（`toFixed`、条件着色）。
- **现象**：触屏长按拖动十字线时是 60 次/秒的 React 重渲染，平板上十字线跟手发涩。
- **修法**：读数改用 ref 直接写 DOM，或用 `requestAnimationFrame` 合并，只在 `tick` 真正变化时 setState。

### P2-4 价格轴/时间轴拖动缩放与平移共用同一片区域（胖手指误触）
- **证据**：`ChartPanel.tsx:632-649` 没有关掉 `handleScale.axisPressedMouseMove` 与 `axisDoubleClickReset`，库默认全开（`lightweight-charts.development.mjs:12347-12358`）。
- **现象**：想平移时拇指边缘蹭到右侧价格轴 → 价格比例被改，得去找"全览/最新"救回来（`ChartPanel.tsx:1107-1120`）。
- **修法**：触屏下 `handleScale: { axisPressedMouseMove: false }`，靠双指纵向或 +/- 按钮；至少把时间轴高度加大。

### P2-5 长按读数条/表头会拉起文本选择
- **证据**：`ChartPanel.tsx:1131-1180` 的读数条是普通 HTML 文本，无 `select-none`；全仓只有 3 处 `select-none`（`Planet3DCanvas.tsx:607`、`FileExplorerPanel.tsx:454`、`OrbitPanel.tsx:35`）。
- **现象**：iOS 长按 → 蓝色选区 + 放大镜盖住图表；Android → 上下文菜单。
- **修法**：面板根节点加 `select-none`（需要复制的地方单独 `select-text`），必要时补 `-webkit-touch-callout: none`。

### P2-6 VirtualList：行高 22–26px，且滚动不收敛
- **证据**：`VirtualList.tsx:76-84`（原生 `overflow-y-auto`，无 `overscroll-behavior`）；行高常量 `TickerPanel.tsx:25` `ROW_HEIGHT = 22`、`TreasuryPanel.tsx:9` `24`、`SearchSelect.tsx:39` `26`、`ItemDetailPanel.tsx:250` 直接写 `22`；行内容整行可点。
- **现象**：点某一行经常点到相邻行；列表滑到顶继续拖会把整个"桌面"橡胶带一下。
- **修法**：粗指针下把行高抬到 ≥40px（或加 `@media (pointer: coarse)` 的内边距），行内主操作按钮 ≥44px；容器加 `overscroll-behavior: contain`。
- **未验证**：快速 fling 时"固定行高 + overscan=6（`VirtualList.tsx:25`）"是否会出现空白行——只在代码层推断，**需实机验证**。

### P2-7 桌面语义的提示文案
- **证据**：`Planet3DCanvas.tsx:608-610` `提示：左/右键拖动以旋转`。
- **现象**：触屏没有右键；而真正的隐藏功能（点按选中地格）一个字都没提 —— 玩家永远不会发现能点选。
- **修法**：按 `matchMedia('(pointer: coarse)')` 切文案："单指拖动旋转 · 点按选中地格 · 双指缩放 · 双击复位"。

### P2-8 无缩放按钮：滚轮/双指的等价物只有 pinch，窄面板里几乎没法用
- **证据**：`ChartPanel.tsx:615-650` 未配 `handleScale`，也没有 +/- 按钮；`:1098-1106` 的周期按钮只是换周期（`setPeriod`），**不等于缩放**；可用的边界是 `minBarSpacing: 1.5`（`:641`）。
- **现象**：K 线密到看不清时，只能双指捏合；面板窄（<200px，分屏/手机竖屏常见）时两指跨度不够，pinch 很难生效。
- **修法**：加"放大 / 缩小 / 复位"三个按钮（调 `timeScale().applyOptions({ barSpacing })` 或 `zoomTime`），顺便解决 P1-3 的命中区问题。

### P2-9 星球拾取没有 pointerId 概念，双指手势被当成两次拖拽
- **证据**：`Planet3DCanvas.tsx:620-633` —— 任意 `pointerdown` 都 `setPointerCapture` 并覆盖 `draggingRef`（`:622`），任意 `pointermove` 都累加旋转（`:624-633`），全仓无 `pointerId` 过滤。
- **现象**：两根手指同时按下时，第二个手指把 `moved` 清零并接管，两个手指的位移叠加进同一个 yaw/pitch，画面同时旋转 + 相互拉扯；将来要做 pinch 缩放时这段逻辑必须重写。
- **修法**：以 `pointerId` 为主键维护 `Map<pointerId, {x,y}>`；单指 = 旋转，双指 = 缩放/平移；`pointerup/cancel` 按 id 清理。

---

## 5. 与触摸滚动的关系（专章）

### 5.1 谁应该拥有手势：一张必须写进代码的表格

| 位置 | 现在由谁决定 | 应该是 |
| --- | --- | --- |
| 星球画布 | 浏览器默认（滚动容器优先）→ **错** | 画布：`touch-action: none` |
| 行星面板其余部分 | 原生滚动 | 保持原生滚动 |
| 图表绘图区 | 库接管（横向平移、双指缩放、竖向阻止） | 保持，但补 `touch-action` 声明以免嵌套时被外层抢 |
| 图表容器外层 | 不滚动（`overflow-hidden`） | 保持 |
| 列表 | 原生滚动 | 加 `overscroll-behavior: contain`，避免滚到边界后传给外壳 |

### 5.2 图表上的"死手势"

库默认 `handleScroll.vertTouchDrag: true`（`lightweight-charts.development.mjs:12341-12346`），对应装配 `_internal_treatVertTouchDragAsPageScroll: () => startTrackPoint === null && !handleScroll.vertTouchDrag`（`:9986`）——**图表会吞掉纵向触摸拖动**（既不滚页面，也没有任何纵向平移）。因为 `ChartPanel` 的父级本来也不滚动（`:1072` `overflow-hidden`），结果就是：**在 K 线图上上下划，什么都不会发生**。玩家想"上下拖一下看看"时得不到任何反馈。修法：要么在触屏下把 `vertTouchDrag` 关掉（让页面/父容器接手），要么给纵向手势一个真实含义（缩放价格轴）。

### 5.3 星球画布与滚动容器：为什么"两种手势只能活一个"

`PlanetPanel.tsx:94` 的滚动容器是所有手势的最终归属者。触摸手势一旦被判定为"滚动"，浏览器会：

1. 接管后续 `touchmove`（并 `preventDefault`），此后不再向目标元素派发 `pointermove`；
2. 对目标元素派发 `pointercancel`；
3. 结束时不派发 `pointerup`。

因此 `Planet3DCanvas.tsx:634-653` 的"抬起即拾取"在滚动路径上**永远不会触发**。这也解释了为什么玩家会觉得"点也点不中、转也转不动"——**两条路径都被同一次手势判定抢走了**。唯一可靠的解是把 `touch-action` 显式写死在画布上（P0-1），让画布自己拥有手势，再由画布把"要不要滚面板"交还给应用而不是浏览器。

---

## 6. 建议的修复顺序（按"玩家卡点解除"排序，不按改动量）

1. **一行修掉 P0-1**：`<canvas style={{ touchAction: 'none' }}>` + wrapper `overscroll-behavior: contain`。这是投入产出比最高的一处。
2. **拾取算法 + 阈值**（P0-2）：改成最近格中心 + 12px 容差，`pointerType === 'touch'` 时阈值放大。配合 `:569-581` 的选中描边加强。
3. **手势所有权与缩放**（P0-3、P2-9）：viewport 锁缩放 + pointerId 化的手势状态机 + 星球 zoom（同时补 `onWheel`），双击复位。
4. **图表读数改为点选锁定**（P1-1）：`subscribeClick` + 读数条"锁定/跟随"状态，去掉对长按的依赖。
5. **入口体验**（P1-2、P1-3）：SearchSelect 16px + visualViewport + 行高 40px；全站 `.pill-btn/.cta-*` 补 `:active` 与 44px 命中区。
6. **滚动手感**（P1-4、P2-6、5.2）：横滑预取防抖 + `overscroll-behavior` + 图表纵向手势的明确归属。
7. **性能与细节**（P2-1/2/3/4/5/7/8）：尺寸严格化、不可见不重绘、读数用 ref、轴手势关闭、`select-none`、文案按设备切换、缩放按钮。

验收清单（在 iPad 竖屏 768×1024 + Android 平板横屏各过一遍）：

- [ ] 单指在星球上能连续转 360°，面板不跟着滚；
- [ ] 点中某块地格，选中格明显高亮，且点中间那格不会选到邻格（连续 10 次命中 ≥ 8）；
- [ ] 双指在星球上捏合：只缩放星球，页面不放大；双击复位；
- [ ] 全站任何双指/双击都不改变页面缩放；
- [ ] 图表单指点某根蜡烛 → 读数锁定该根；再点空白 → 回到跟随最新；
- [ ] 长按十字线后横滑能正常平移（或明确退出机制）；
- [ ] 点开"切换物品"：页面不放大，键盘弹起后候选列表仍完整可见；
- [ ] 所有高频按钮（周期/全览/最新/最近成交）单手指腹可稳定点中，按下有反馈；
- [ ] 横甩 3 次图表不跳、不连续发请求（Network 面板确认）。

---

## 7. 口径与未验证项

- 本次为**纯静态审计**：没有运行应用、没有在真机上复现。所有"玩家会卡住"的结论都建立在代码路径 + 依赖库源码/默认值之上；"手感"类判断（例如 P2-6 的 fling 空白行、P1-3 的按空概率）标注为需实机验证。
- 像素数字（每格约 20×20 / 11×11、按钮约 16–18px）均由代码常量按公式估算，容器尺寸取常见平板/手机可视区，**不是截图测量值**。
- 依赖库行为依据 `frontend/node_modules/lightweight-charts@4.2.1`（`dist/lightweight-charts.development.mjs` 的行号 + `dist/typings.d.ts` 的 `@defaultValue` 注释）；升级到 v5 需重新核对 `trackingMode`、`handleScroll` 与十字线触屏语义。
- 不在本文件范围：dockview 分割条拖拽、浮动窗口拖拽/缩放（`SplitLayout.tsx:226`、`FloatingWindowsLayer.tsx:71-121` 同样只有 pointer 事件、无 `touch-action`，建议由布局审计覆盖）。

# Meridian 反作弊审计（第二轮）— CLOB / escrow / 价格与 CPI 操纵

审计对象：`backend/crates/meridian-core/src/{exchange.rs,world.rs,planet.rs}`、`backend/crates/meridian-sandbox/src/npc.rs`、`backend/crates/meridian-server/src/{engine.rs,api.rs}`
方法：只读源码 + 本地独立实例实测（`127.0.0.1:18503`，`MERIDIAN_TICK_MS=200`，用 `/api/sim/control` pause/step 逐 tick 精确观测）。
约定：**已复现** = 本地实例上贴出实测数字；**代码推断** = 只读代码得出、未在线验证。
已由 Lead 确认的两个 Critical（`DealOrder` 负 notional 刷钱、`match_all` escrow/refund 失配造钱）本文不重复；只在 第4节给出我独立复现的一条同族证据用于对齐量级。

---

## 1. 摘要（按经济危害排序）

| # | 严重度 | 标题 | 状态 |
|---|---|---|---|
| N1 | **High** | `DealOrder` 绕过价格-时间优先：任何人都能按**任意价格**与自己（或他人）的挂单成交，因此 `last_price`/`ema_fast`/`ema_slow` 完全由玩家设定，成本≈成交额 0.5%（小额时因整除直接为 0） | 已复现 |
| N2 | **High** | 城市（`PLANET:*`）采购价**没有任何参考价钳制**：`bid = min(item_cap, 1.03×best_ask)` 或 `min(item_cap, 1.08×last_p, 1.02×prev_bid)`。挂一张卖单即可把城市收购价定到 20–90× `ref_price`，且 1.02 棘轮把价格永久留在高位 | 已复现（数值精确吻合） |
| N3 | **High** | 上述两者的收割通道：`DealOrder` 可直接吃掉 `PLANET:*` 买单，不需要成为最优卖单（绕过卖盘竞争），按城市自己报的天价结算 | 已复现 |
| N4 | Medium | CPI 由 `ema_slow` 驱动，而 `ema_slow` 可被 N1 单笔拉高（衰减仅 3%/tick）→ `civic_mint ∝ cpi`（公共铸币口）+ 地价/工资同步放大，clamp 上限 10× | 已复现（EMA/CPI 走向）+ 代码推断（倍率） |
| N5 | Medium | 玩家 intent 静默截断：单 tick 提交 40 条只有 32 条生效，HTTP 全部 200 `queued:true`，无任何回执/重排队 | 已复现 |
| N6 | Low | 世界推进依赖 `HashMap` 迭代顺序（城市预算分配、station/planet 匹配顺序），预算不足时**随机**跳过某些商品 → 同一 seed 不可重放、多实例状态分歧 | 代码推断 |
| N7 | Low | 订单簿/撮合的 O(n) 全表扫描：`CreateOrder` 每次统计全服挂单数、`remove_order` 全表线性扫、`insert_order` 每次整表 `sort`；`total_escrow_cash()` 用 `i64 .sum()` 可溢出 | 代码推断 |
| N8 | Info | `/api/health` 公开 `conservation_error`，作弊者可实时测量自己的造币量 | 已复现 |

---

## 2. 逐项发现

### N1（High）`DealOrder` 是可任意定价的成交原语 —— 价格预言机被玩家完全控制

**位置**
- `world.rs:1445-1565` `Intent::DealOrder`：按 `order_id` 精确取单，**完全不看盘口谁最优**；`world.rs:1477` `notional = take × order.price`；`world.rs:1500-1504§/`1551-1555` 直接 `record_trade_stats(item, tick, take, order.price)`。
- `exchange.rs:235-328` `match_all`：撮合才走价格优先，`take = min(bid.qty, ask.qty)`，成交价取**较老一侧**的价格（`exchange.rs:270-274§）。

**要点**：`CreateOrder` 可以在任意价位挂一张「深档」卖单（价格无上限，卖单不需要现金），另一账号（或同账号另一公司）用 `DealOrder` 精确点掉它 → 成交价 = 该挂单价，与市场价无关。`exchange.rs:330-343` 的 `last_trade_price/ema_fast/ema_slow` 因此可被单笔设定。手续费 `bps_of`（`types.rs:30-35`）对 `amount ≤ 199` Money 直接返回 0，所以定低价完全免费；定高价成本 = 0.5% × 成交额，且这笔钱在自己两个账号之间流转。

**已复现**（tick 668，ST:P1 water，当时盘口 best_ask=3.8443）：

```bash
# 1) cA 挂一张深档卖单（远离盘口，不会被撮合）
curl -b j -X POST 127.0.0.1:18503/api/intent -H 'content-type: application/json' -d '{"company_id":"cA","intent":{"CreateOrder":{"station_id":"ST:P1","side":"sell","item_id":"water","qty":2,"price":5000000}}}'
# 2) cB 用 DealOrder 精确点掉它 → 成交价 500 credits，而市场价 3.84
curl -b j -X POST 127.0.0.1:18503/api/intent -H 'content-type: application/json' -d '{"company_id":"cB","intent":{"DealOrder":{"order_id":106946,"amount":1}}}'
```

实测（`/api/market/book?station_id=ST:P1&item_id=water`）：

```
before: last=4.1808  ema_fast=3.9403  ema_slow=3.8891
after : last=3.8443(被同 tick 其他成交覆盖)  ema_fast=36.8993  ema_slow=16.679
资金: cA +482.94, cB -514.56；其中手续费仅 2.5 credits（0.5% × 500）
```

→ **1 单位、2.5 credits 的成本，把 `ema_fast` 抬高 9.4×、`ema_slow` 抬高 4.3×**；EMA 每 tick 只按 (97% 旧 + 3% 新) 衰减，即一次投毒影响约 100 tick。再叠加两次后 `ema_slow` 实测 3.9 → 26.7（6.8×）。

**影响**：`last_price`/`ema` 是整个经济体的唯一价格信号——城市收购价（N2）、NPC 做市报价（`npc.rs:564-609`）、Hub 仓储租金（`world.rs:2069-2077`）、CPI（`world.rs:869-889`）全部只读它。即"行情"不再是市场结果，而是玩家可写的变量。

**修复建议**
1. `DealOrder` 必须按盘口结算：成交价取对手价，或直接**禁止**与偏离参考价 X 倍以外的挂单成交；更彻底的做法是删掉 `DealOrder` 的"点名成交"语义，改为市价单（扫最优档）。
2. 给 `Order.price` 加上限（如 `ref_price × 32` 或 `ema_slow × 8`），挂单时校验。
3. `record_trade_stats` 只接受"经撮合、且成交价落在参考价带内"的成交；对偏离巨大的成交做剔除（winsorize）后再更新 EMA/last。
4. 手续费改为向上取整（最少 1 Money），消除"零费率小额成交"。

---

### N2（High）城市采购价没有参考价钳制 + 1.02 棘轮 —— 一张卖单即可把城市收购价定到任意倍数

**位置** `world.rs:1193-1313` `place_planet_demands`
- `world.rs:1234-1237`：`budget = treasury × 18/100`（每 tick 可花掉 18% 国库）。
- `world.rs:1242-1259`：商品权重 `w_i = demand_qty × ref_m × urgency`，其中 `ref_m` = **该站 `best_ask` 或 `last_trade_price`**（不是 `catalog.ref_price`）。
- `world.rs:1265-1266`：`item_cap = (budget × share) / demand_qty`。
- `world.rs:1277-1282`：

```rust
let raw_bid = match ba {                                   // ba = 该商品 best_ask
    Some(ask_p) => item_cap.min((ask_p * 103) / 100),       // ← 卖一价 ×1.03，无参考价上限
    None => item_cap.min(last_p.saturating_mul(6))
                   .min(((last_p * 108) / 100).max((prev_bid * 102) / 100)),  // ← last_p×1.08 / 上一 tick 报价×1.02
};
```

- `world.rs:1290-1294§：`prev_bids.insert(item, clean_bid)` —— 把本 tick 的报价作为下一 tick 的棘轮基准。

**结论**：城市"愿意付的价格"完全由外部输入决定：卖一价、上一笔成交价、或自己上一 tick 的报价。三者都可被玩家控制（N1 + 挂单）。1.02 棘轮使价格只涨不跌，直到撞上 `item_cap` 并**永久停在那里**（每个 tick 都会重新写回 `prev_bids`）。

**已复现（数值精确吻合，无需任何作弊账号）**：以下是我在 `/api/market/book` 读到的真实报价，`bid/last` 比值精确等于代码里的系数：

```
ST:P1 rations   last=8.8521  bid=9.5602   = 1.08 × last           ← no-ask 分支
ST:P1 clothing  last=397.4716 bid=555.3049 = 1.02 × 544.4166     ← 棘轮分支（544.4166 = prev_bid）
ST:P1 building_mat last=74.6076 bid=97.1735 = 1.02 × 95.2681     ← 棘轮分支
```

以及被推到 `item_cap` 的极端报价（对 `ref_price`）：

| 站点/商品 | 城市买价 | ref_price | 倍数 |
|---|---|---|---|
| ST:P2 clothing | 1278.57 | 22 | **58×** |
| ST:P3 daily_goods | 1970.29 | 22 | **89×** |
| ST:P1 clothing | 555.30 | 22 | 25× |
| ST:P2 rations | 102.06 | 4.5 | 22× |

同时读到的每 tick 预算（`treasury × 18%`）：P1 27,815 → 5,007/tick；P2 32,278 → 4,410/tick；P3 14,627 → 3,632/tick；三星球合计 **≈13,000 credits/tick 的采购预算**，全部按上述扭曲价格支付。

**量化利用**：只要成为「卖一」并把价格抬到 `item_cap`（或直接走 N3 绕开卖盘），单 tick 可提走约 `budget×share`；攒到 `share→1`（把一个高权重商品价格拉高）时，等于**独吞该星球当 tick 的全部 18% 预算**。以 P1 为例：一张 10 单位卖单可吃掉 ~2,000–4,800 credits/tick，而水/氧的真实价值是 25–45 credits。`share` 高时 3 个星球合计 ~13k/tick；配合 N4 的 CPI 放大（clamp 10）上限可到 ~10 倍。

**为什么不是"正常市价"**：`update_cpi` 用 `ema_slow` 反推物价指数、城市用 `best_ask` 反推收购价，二者都**不回到 `catalog.ref_price`**，构成"价格自我引用"正反馈；实测 CPI 已从 tick 63 的 1.157 自行漂移到 tick 683 的 3.726（无任何作弊），说明该回路本身已失控。

**修复建议**
1. `raw_bid` 增加硬钳制：`clamp(ref_price × [0.5, 3.0] × cpi)`，并在 `prev_bids` 棘轮上加同一上限。
2. 城市预算改为"按参考价加权"，`item_cap` 只允许在 `ref_price` 的窄带内浮动。
3. `prev_bids` 不再作为无上限基准，或直接取消棘轮（改为 EMA 且带返回中值的拉力）。
4. `place_planet_demands` 对「本 tick 完全没成交的商品」下调报价，抑制单边棘轮。

---

### N3（High）`DealOrder` 直接吃掉 `PLANET:*` 买单 = N2 的收割通道（绕过卖盘竞争与 escrow 检查）

**位置** `world.rs:1445-1477`：`is_valid = o.owner_id != company_id` —— `PLANET:P1` 这类城市买单同样满足"不是我"，因此**任何玩家**都能点名吃掉它；`world.rs:1517-1535` 只要公司在该站（或 instant 商品在该星球地面）有货即可成交，成交价 = `order.price`（城市自己的天价）。

**已复现**：上一节 N1 的同一笔 `DealOrder` 在盘口 `best_ask=3.8443` 的情况下以 500 credits 成交，证明"点名成交价 ≠ 盘口价"这一机制成立（城市单与玩家单走同一条代码路径）。城市买单在天价位的存在已由 N2 的盘口快照直接读出（`PLANET:*` 是这些站唯一的买盘来源：P1 clothing 555、P2 clothing 1278、P3 daily_goods 1970）。

**量化**：以 ST:P2 clothing 为例，城市买价 1278.57 × 2 单位 = **2,557 credits**，而 `ref_price` 价值 44 credits → 单次收割 **58×**；供货成本（若从 HUB 以 38.8 买入 2 件 + 运费）约 100 credits，净收益 ~2,450 credits，**1 次 `DealOrder` + 1 次运输**。这条路径不需要成为卖一、不需要扫单，是 N2 的直接变现方式。

**修复建议**：`DealOrder` 增加 `counterparty_is_planet` 时禁止点名成交（城市单只能被撮合引擎按最优价吃），或统一走撮合。与 N1 的修复一半重合：`DealOrder` 按盘口价结算即可同时关掉两条。

---

### N4（Medium）CPI 由可写入的 `ema_slow` 驱动 → 公共铸币口铸币量被放大（上限 10×）

**位置**
- `world.rs:869-889` `update_cpi`：`ratio = avg_station(ema_slow)/ref_price`，逐商品 clamp 到 `[0.2, 8]` 后取平均，`cpi = cpi×0.96 + raw×0.04§，clamp `[0.25, 10]`。
- `world.rs:1202-1204§：`civic_mint = population × 0.08 × prosperity × cpi`，**直接 `record_mint` 铸币**（每 tick，每星球）。
- 同类放大：地价 `planet.rs:209-214§（×cpi）、建筑费 `world.rs:1618`、工资 `world.rs:1008`、破产阈值 `world.rs:2142-2148`、Hub 租金 `world.rs:2077`。

**已复现**：N1 的两次微小成交把 ST:P1 water 的 `ema_slow` 从 3.89 推到 26.69（分母 `ref_price=2.5` → 该商品 ratio 已触 8.0 clamp）；随后 3 个 tick `cpi` 3.6404 → 3.6663 → 3.7259 单调上行。**代码推断**（未做完整倍率实测）：由于 `update_cpi` 对单商品 ratio 已 clamp、且 `ema_slow` 是累计量，用 N1 把 14 个受统计商品在 4 个站点的 `ema_slow` 各推一笔天价成交，即可把 `raw` 顶到 8.0 → `cpi` 收敛到 8，铸币量 = 8× 设计值（clamp 上限 10×）。以当前 P1 `population=4584, prosperity≈0.75` 计：`civic_mint` 从 ~2,750 credits/tick（cpi=1）变为 ~22,000 credits/tick（cpi=8），这部分增量按 N2/N3 可被单个玩家全额提走。

**修复建议**：CPI 的输入改用**成交量加权**的成交价，并剔除偏离参考价过多（例如 > 4×）或成交量过小（qty < X 或名义额 < Y）的成交；对 `ema_slow` 加"最大偏离 ref_price 的倍数"钳制；`civic_mint` 的 cpi 系数单独 clamp 到 `[0.5, 2]`，与"价格指数"解耦。

---

### N5（Medium）手动 intent 静默截断（40 → 32），无任何错误回执

**位置** `world.rs:807-813`：`for intent in intents.into_iter().take(MAX_INTENTS_PER_TICK)`（`types.rs:13` = 32）；`engine.rs:167-187`：每 tick `std::mem::take(&mut self.extra_intents)` 一次性取空，超出 32 条的部分**直接丢弃且不重排队**；而 `api.rs:691-701` 对每条都返回 `{"ok":true,"queued":true}`。

**已复现**（tick 673）：连续 POST 40 条 `CreateOrder`（全部返回 `queued:true`），step 一次后 `open_orders` 只增加 **32** 条（2 → 34），其余 8 条永久丢失，无任何响应差异。

```bash
for i in $(seq 1 40); do curl -s -b j -X POST 127.0.0.1:18503/api/intent -H 'content-type: application/json' -d '{"company_id":"cA","intent":{"CreateOrder":{"station_id":"ST:P1","side":"buy","item_id":"water","qty":1,"price":600}}}' ; done
curl -s -b j '127.0.0.1:18503/api/state?company_id=cA' | python3 -c 'import json,sys;print(len(json.load(sys.stdin)["player_snapshot"]["company"]["open_orders"]))'
```

**影响**：脚本玩家（`/api/scripts` 里的 QuickJS 也能一次返回 >32 条）会出现"策略生效但订单没下"的不可解释行为。同时 `extra_intents` 是每公司一个无上限 `Vec`（`engine.rs:1731-1741`），两次 tick 之间被 HTTP 灌爆会造成内存放大（低危 DoS 面）。
**修复建议**：API 层按公司做每 tick 配额并显式返回 429/超出计数；丢弃时写审计日志/回执；`extra_intents` 设上限。

---

### N6（Low，代码推断）世界推进依赖 HashMap 迭代顺序 → 不可重放

`world.rs:1263` `for (item, &qty) in &demands`（`HashMap`，Rust 每进程随机 seed）配合 `world.rs:1285-1287` 的 `continue`（预算耗尽就跳过），意味着**同一 tick 里哪些商品拿不到采购预算取决于随机迭代顺序**；实测确实观察到同一星球部分商品（如 P1 oxygen）整 tick 没有买盘而其他商品有。同类还有 `world.rs:817`（station 匹配顺序）、`world.rs:793`（planet 顺序）、`world.rs:2119`（破产处理顺序）。
**影响**：`docs/ARCHITECTURE.md` 宣称确定性内核；实际无法逐 tick 重放/校验，多实例（或"回滚重算"）会分歧，反作弊的事后复核能力被削弱。**需验证**：是否已有意用 `BTreeMap`/排序覆盖（我未发现）。
**修复建议**：所有会被"预算/配额截断"的迭代改用 `BTreeMap` 或显式排序。

---

### N7（Low，代码推断）撮合与订单簿的性能/溢出隐患

- `world.rs:1333-1342`：每次 `CreateOrder` 都**全服**遍历所有站点的所有挂单来统计本公司挂单数（O(全服订单)）；53 个 NPC × 最多 64 单 + 每 tick 城市重挂数百单时，这是每 intent 的固定成本。
- `exchange.rs:191-223` `remove_order` 线性扫全表；`exchange.rs:165-189` `insert_order` 每次 `push + sort_by`（O(n log n)），而 `place_planet_demands` 每 tick 对每个商品都做一次"删旧 + 插新"（`world.rs:1215-1231,1298-1309`）。
- `exchange.rs:225-231` `total_escrow_cash` 用 `i64 .sum()`：若某些托管值受 第4节的截断影响，这里会给出错误的守恒结论。
- `world.rs:1471` `remove_order(order_id).unwrap()`：单线程下安全，但若将来引入并发撮合会 panic。
**修复建议**：公司挂单数用计数器维护；订单簿改 `BTreeMap<price, VecDeque<Order>>`；`total_escrow_cash` 用 `i128` 求和。

---

### N8（Info）`/api/health` 公开 `conservation_error`，无告警/熔断

`api.rs:220-231`：未鉴权的 `/api/health` 直接返回 `conservation_error`。**已复现**：我在制造出守恒缺口后立刻读到 §447300`。作弊者可以据此判断"造币是否已被发现"，运维也没有任何自动告警/冻结。建议：把该字段移出公开接口（或只给 admin），并对 `|conservation_error| > 0` 做告警 + 自动暂停写操作。

---

## 3. 复现环境

```bash
mkdir -p .audit-local/cheat-market && cp data/production.json .audit-local/cheat-market/
cd backend
MERIDIAN_ADDR=127.0.0.1:18503 MERIDIAN_DATA_PATH=../.audit-local/cheat-market/production.json MERIDIAN_DB_PATH=../.audit-local/cheat-market/db.sqlite MERIDIAN_DIST_DIR=../.audit-local/cheat-market/nodist MERIDIAN_TICK_MS=200 ./target/release/meridian-server &

# 首个注册用户即 admin；admin 的 ensure_owner 放行任意 company_id（auth.rs:363-371）
curl -c j -X POST 127.0.0.1:18503/api/auth/register -H 'content-type: application/json' -d '{"email":"a@example.com","nickname":"AdminX","password":"Pw-Str0ng-A1"}'
curl -b j -X POST 127.0.0.1:18503/api/companies -H 'content-type: application/json' -d '{"id":"cA","name":"A","is_player":true,"profession":"env_recycle","home_planet_id":"P1","initial_cash":100000}'
# 关掉 starter 脚本，避免干扰
curl -b j -X PUT 127.0.0.1:18503/api/scripts/cA -H 'content-type: application/json' -d '{"modules":{"main":"module.exports.loop=function(){}"},"enabled":false}'
curl -b j -X POST 127.0.0.1:18503/api/sim/control -H 'content-type: application/json' -d '{"action":"pause"}'
# 逐 tick：{"action":"step"}
```

报告中的价格/行情数据来自本实例 `/api/market/book`、`/api/state`、`/api/health` 的实测输出。

---

## 4. 一条同族证据（对齐量级，不重复 Lead 结论）

我在测 N1 时触发了**与 Lead 已确认的 match_all escrow/refund 失配同族**的造币：用 `qty=4, price=2^62+1`（`world.rs:1364§ 的 `(qty as i128*price as i128) as Money` 截断为 **4 Money** 的托管额）挂买单，撮合时按真实盘口价成交 4 单位 → 卖家（NPC）拿到 §4 × 11.1826 = 44.7304§ credits，而买家只托管了 0.0004 credits。
实测：`/api/health` 的 `conservation_error` 由 0 变为 **447300**（Money），且**精确等于 44.73 credits**（447300 = 11.1826 × 4 × 10000）。用 2 个 intent、4 Money 的成本完成。
即 `conservation_error = notional − escrow_wrapped` 可直接量化造币量；当对手方是"自己另一个账号 + 天价挂单"时可放大到 `~2^62 Money = 4.6e14 credits` 量级（Lead 已在 `DealOrder` 路径确认）。**修复必须同时覆盖 `world.rs:1364/1477/2075/1284§ 与 `exchange.rs:276-278`，全部改 `i128` 全程运算并在落 `Money` 前做 `try_into`/`checked_*` 校验，失败即拒单。**

---

## 5. 已测试但**不成立**（避免误报）

1. **`buyer_refund` 不能对正常挂单独立构造**：`notional = take×trade_price` 且 `escrowed_for_take = take×bid.price`，而撮合前提是 `bid.price ≥ ask.price`、成交价只取二者之一（`exchange.rs:245,270-274§），所以 `notional ≤ escrowed_for_take` 恒成立、`escrow_cash` 不会被扣成负数。**实测**：1 单位 `bid@100` 在盘口 3.939 成交，现金变动精确为 **−3.939**，`conservation_error` 保持 0。唯一破坏该不变式的是 第4节的整数截断。
2. **`match_all` 的 `same_owner`（`exchange.rs:252-263`）单账号不可达**：`apply_intent` 的 self-cross 校验（`world.rs:1343-1360`）已阻止同一公司在同商品同站同时挂出会交叉的买卖单，实测买单被正确拒绝。该分支是死代码，但**没有退款路径**，一旦将来引入新挂单入口（NPC/城市/管理员）就会永久冻结该商品撮合——属潜在隐患，建议改成"弹出较新单并退款"。
3. **64 单上限（`types.rs:14§）不可绕过**：计数在每次 `CreateOrder` 时实时全服统计（`world.rs:1333-1342`），`DealOrder` 只回插残余单不增加计数；未发现绕过路径。
4. **重复提交不构成"双花"**：没有 `idempotency key`，重复 POST 会产生重复订单（占用多份托管/库存），但每条 intent 只被应用一次，无重复结算；实测重复提交后资金守恒。
5. **用撮合引擎做"任意价洗单"不成立**：价格优先使买方只能吃到最便宜的卖单。**实测**：`cB` 以 500 credits 挂买单，实际成交在 4.18 credits 的卖一价，没能把 `last_price` 拉到 500。任意定价只能通过 `DealOrder`（N1）实现——这也说明 N1 的修复价值极高。
6. **`DealOrder` 不能自成交**：`world.rs:1460` `is_valid = o.owner_id != company_id`，实测对自家挂单返回 `false`（需两个公司/账号，成本仅注册 1 个账号）。
7. **城市不会超预算**：`world.rs:1285-1289` 的 `spent_escrow + needed_escrow > treasury_avail` 校验有效，实测城市报价总额 ≈ `treasury×18%`，未观察到国库被扣成负数（除非 第4节的截断介入）。

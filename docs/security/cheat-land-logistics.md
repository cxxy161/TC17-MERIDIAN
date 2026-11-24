# 反作弊审计（第二轮）— 地块 / 建造 / 船只 / 银行（task-5）

- 审计对象：Meridian（Rust/axum 太空贸易游戏）后端 `backend/crates`
- 审计分支：HEAD `d606dd0`（`world.rs` / `planet.rs` / `logistics.rs` 在该 commit 中**未修改**，故下述问题均为线上版本问题）
- 审计范围：`Intent::{BuyPlot, BuildFacility, DemolishFacility, DispatchShip, RepairShip, BankOp}` 及其在 `world.rs` / `planet.rs` / `logistics.rs` 的实现，含地块/银行/建造任务完成逻辑
- 测试环境：本地实例，**未触碰线上** `http://100.84.136.78:18420`
  ```bash
  mkdir -p .audit-local/cheat-land && cp data/production.json .audit-local/cheat-land/
  cd backend
  MERIDIAN_ADDR=127.0.0.1:18501 MERIDIAN_DATA_PATH=../.audit-local/cheat-land/production.json \
  MERIDIAN_DB_PATH=../.audit-local/cheat-land/db.sqlite MERIDIAN_DIST_DIR=../.audit-local/cheat-land/nodist \
  MERIDIAN_TICK_MS=200 ./target/release/meridian-server
  ```
- 测试手法：首个注册用户为 admin（`api.rs:1029`），admin 的 `ensure_owner` 放行任意 `company_id`（`backend/crates/meridian-server/src/auth.rs`，`ensure_owner`），因此单个会话即可对任意公司提交 intent。**用 `POST /api/sim/control {"action":"pause"}` + `{"action":"step"}` 精确控制 tick**，从而把"同 tick N 个 intent"做成确定性实验。
- 结论标记：**[已复现]** = 本地实测，附请求/响应；**[代码推断]** = 仅读码，未实测。

---

## 0. 摘要（TL;DR）

| # | 结论 | 严重度 | 是否复现 |
|---|------|--------|----------|
| F1 | 银行贷款无任何信用/抵押/额度检查，且玩家永不被清算 → 借出的钱即"永久资本"；全行星银行储备可被任意新公司一次借空 | **High** | 已复现 |
| F2 | 借款直接抽干银行 `reserves`，而取款要求 `reserves >= amount` 且无准备金率限制、无排队兑付 → **一个借款人可永久冻结全服玩家的存款** | **High** | 已复现 |
| F3 | 玩家资不抵债永远不会被清算（`process_npc_bankruptcies` 直接 `continue`），债务永不被追偿；`total_loans` 只增不减并持续推高全服利率 | **High** | 已复现 |
| F4 | 地块购买对玩家无上限（90% 上限只约束 NPC），单个公司可在 2 个 tick 内买空一个行星全部剩余地块，使**该行星再也无法创建新公司/新 NPC**（400 `No unclaimed plots left`） | **Medium** | 已复现 |
| F5 | CPI 驱动的名义通胀：CPI 1.0 → 6.56（约 1800 tick），而地价/建造费按 CPI 计价、`civic_mint` 也按 CPI 放大 → 现金/存款/债务名义价值被稀释约 6.6 倍，**借钱囤货/囤地是无风险正收益**，并放大 F1/F3 | Medium（横切） | 已复现 |
| F6 | 破产 NPC 的地面库存被销毁、BANK 挂单买地不清空 `plot.jobs`（买家白得在建工程）、`spawn_company` 复用法拍地块时不向银行付钱还删楼 | Low | 代码推断 |

> **重要区分**：本文件所有 High 结论**不会**让 `conservation_error` 变化（实测全程为 0）。它们不是"凭空造钱"，而是**把银行/其他玩家的既有货币永久转移到攻击者手里，或把货币冻结成账面条目**。Lead 已确认的两个 Critical 铸币漏洞（`DealOrder` 负 notional、`match_all` escrow/refund 失配）与本文件相互独立，但 F1/F2 会让"铸出来的钱"更容易被洗白与沉淀。

---

## F1 [已复现] 银行贷款 = 无抵押无追偿的免费资本

**代码**
- `backend/crates/meridian-core/src/world.rs:1932-1942`（`BankOpKind::Borrow`）——唯一约束是 `p.bank.reserves < amount`；无净资产检查、无抵押、无信用额度、无负债上限。
- `world.rs:2092-2115`（`accrue_bank_interest`）——利息**只加到 `comp.debt` / `total_loans`，从不从现金扣款**（`comp.debt += intr`，没有 `cash -= intr`），即现金层面的债务成本 = 0。
- `world.rs:2117-2124`（`process_npc_bankruptcies`）——`if comp.is_player { comp.distress_ticks = 0; continue; }`：玩家永不破产，因此债务永不被追偿。
- `world.rs:1896-1906`——`BankOp` 仅要求 `home_planet_id == planet_id`，公司只要在某个行星有 home 就能借该行星银行。

**复现（新公司净资产 100 credits，一次借走 196 倍）**
```bash
# admin 会话；先 pause
curl -b j -X POST 127.0.0.1:18501/api/sim/control -H 'content-type: application/json' -d '{"action":"pause"}'
# 1) 建最小资金新公司（initial_cash 被 clamp 到 [100,100000] 信用点，api.rs:764）
curl -b j -X POST 127.0.0.1:18501/api/companies -H 'content-type: application/json' \
  -d '{"id":"cC","name":"Charlie","is_player":true,"profession":"agri_bio","home_planet_id":"P5","initial_cash":100}'
# 2) 一次借 19629 信用点（= 银行储备 -1）
curl -b j -X POST 127.0.0.1:18501/api/intent -H 'content-type: application/json' \
  -d '{"company_id":"cC","intent":{"BankOp":{"planet_id":"P5","op":"borrow","amount":196291000}}}'
curl -b j -X POST 127.0.0.1:18501/api/sim/control -H 'content-type: application/json' -d '{"action":"step"}'
```
实测（`/api/admin/overview`）：
```
cC: cash 100.00 -> 19728.69  debt 0 -> 19629.10  net_liquid 99.59
P5 bank: reserves 19629.69 -> 28.60   loans 37946.48 -> 57576.37   deposits 0
```
再在**同一 tick** 提交两个"借满储备"的 intent：只成交 1 个（第二个看到已扣减的 `reserves`），说明同 tick 重放不能翻倍；但**跨 tick/跨公司可重复**，直到储备归零。

** laundering 闭环（cA=骡子公司，cB=主号）**
```bash
# cA 从 P3 银行借走 33554 信用点（储备 33854 -> 300）
curl ... -d '{"company_id":"cA","intent":{"BankOp":{"planet_id":"P3","op":"borrow","amount":335541762}}}'
# 洗白：cA 挂 10 ore @1 money 的卖单 -> cB 吃掉；再 cB 挂 10 ore @1e8 money/unit -> cA 吃掉
```
实测：
```
before      cA cash=139996.42 debt=53898.92 net= 86097.51 | cB cash= 69705.66 net= 99705.99
after wash  cA cash= 39996.42 debt=53900.41 net=-13903.99 | cB cash=169205.66 net=199205.99  cons=0
+500 ticks  cA cash= 39996.42 debt=54125.19 net=-14128.76 plots=2 distress=0 | cB net=199205.99
```

**收益量化**
- 单次上限 = 目标行星银行 `reserves` 的 100%（实测 P3 在 tick 2109 为 **230,027 credits**；P2 104,922；全服 5 个银行合计约 40 万）。
- 现金成本 0（利息不进现金）；真实成本只有排行用的 `net_liquid` 参数，而该参数可留在骡子公司（`-18,466`）不影响主号。
- 时间成本：**2 个 intent + 1~2 tick**（`tick_ms=200` 时可秒级完成）。
- 若目标是 100 倍杠杆：新公司 net 100 → 借 196 倍净资产，实测成立。

**修复建议**
1. `Borrow` 增加额度模型：`amount <= f(net_assets)`（如 `min(reserves, 0.5*net_assets)`），并要求 `debt + amount` 有上限。
2. 利息必须从现金扣（`cash -= intr`），不足则转入欠息并触发对玩家生效的清算流程（见 F3）。
3. 玩家不应免于清算：至少允许"债务 > 资产 × 阈值 持续 N tick"时强制法拍地块/船/库存抵债（现成代码已存在于 NPC 分支 `world.rs:2163-2263`，对玩家禁用即可复用之）。
4. `BankOp` 的 `debt` 与 `total_loans` 应做 tick 级一致性断言（本文件未观测到两者背离，但 F3 下无追偿路径）。

---

## F2 [已复现] 一个借款人可永久冻结全服存款

**代码**
- `world.rs:1919-1931`（`Withdraw`）：`if comp.savings < amount || p.bank.reserves < amount { return false; }`——取款只认"库里现在有现金"，**没有存款准备金率、没有兑付队列、没有存款保险**。
- `world.rs:1932-1938`（`Borrow`）：直接把 `reserves` 抽走，无下限保护（可以借到 0）。
- 结果：`savings` 仍计入 `net_liquid`（`world.rs:2572`、`engine.rs:629`），玩家看到自己"有钱"，但永远取不出来。

**复现**
```bash
# cB 存 30000 信用点（= 300_000_000 money）
curl ... -d '{"company_id":"cB","intent":{"BankOp":{"planet_id":"P3","op":"deposit","amount":300000000}}}'
# cA 借走 reserves-300
curl ... -d '{"company_id":"cA","intent":{"BankOp":{"planet_id":"P3","op":"borrow","amount":335541762}}}'
# cB 取款 30000
curl ... -d '{"company_id":"cB","intent":{"BankOp":{"planet_id":"P3","op":"withdraw","amount":300000000}}}'
```
实测：
```
after cB deposit   bank res=33854.18 dep=30000.35   cB cash=69705.66 savings=30000.34
after cA borrow    bank res=  300.00 dep=30000.35   cA cash=139996.42 debt=53768.95
cB withdraw 30000  -> intent rejected（rejected_intents +1）；savings 仍为 30000.34，cash 不变
+260 ticks         无任何变化（不产生利息：reserves < total_deposits 时 savings 停息，world.rs:2102）
```

**影响量化**
- 冻结比例 = 100% 存款（借款额 ≥ 存款额时）。实测 `reserves/total_deposits = 0.99%`。
- 攻击成本 0（借来的钱还在攻击者手上），且**不可逆**：储备只能靠法拍/坏账 NPC 死亡/贸易费缓慢回补。
- 若 `reserves` 被抽到低于 `reserve_floor = 2000*cpi`，NPC 创业贷款通道也同时瘫痪（`world.rs:728-740`：`reserves > reserve_floor + max_loan` 才放贷）。

**修复建议**：取款从"现金兑付"改为"负债兑付"（银行可延迟兑付/打折，或引入 `bank.pending_withdrawals` 队列）；`Borrow` 加准备金率限制（`reserves - amount >= k * total_deposits`）；存款进入 `net_liquid` 时应按可兑付性折价，否则排行榜会误导玩家。

---

## F3 [已复现] 玩家永不破产 → 债务是纯账面条目，且持续抬高全服利率

**代码**
- `world.rs:2119-2124`：`for (cid, comp) in &mut self.companies { if comp.is_player { comp.distress_ticks = 0; continue; } ... }`
- `world.rs:2107-2112`：`comp.debt += intr; p.bank.total_loans += intr;`
- `planet.rs:41-53`（`update_policy`）：`util = total_loans / (reserves + total_deposits)`，`target_bps += (util*300).min(800)` → 死债把全服利率推高。

**复现**：F1 的骡子公司 cA，实测 `net_liquid = -18,466`（`cash 35,802 / debt 54,268 / savings 0`），继续跑 **500 tick**：
```
+200 ticks  cA net=-13999.57 plots=2 distress=0
+500 ticks  cA net=-14128.76 plots=2 distress=0   （无破产、无法拍、无船只扣押）
```
P3 `total_loans`：40,445 → 89,037（约 800 tick），其中相当部分为无法追偿的玩家债务与欠息；`bank_rate_bps` 曾在 tick 330 达到上限 1797（18%）。

**修复建议**：对玩家启用"软清算"（逾期 N tick 后自动卖出地块/船只抵债，或冻结新增借款与下单）；`total_loans` 拆分为 `performing / non_performing`，利率只用 performing 计算，否则利率被坏账永久钉死。

---

## F4 [已复现] 地块垄断 DoS：买空行星土地 = 该行星永久无法创建新公司

**代码**
- `world.rs:1668-1672`：90% 地块上限 `if !self.companies[company_id].is_player && ...`——**只约束 NPC**，玩家买地无上限（原文注释 "human player can still claim the reserved 10% plots"，`invariants.rs:434-437` 也是这么设计的）。
- `planet.rs:394-420`（`claim_surface_tile`）：`slot_id` 指定必须命中 `!is_city && owner.is_none() && plot_id.is_none()`，买空后返回 `None`。
- `world.rs:634-643`（`spawn_company` 新地块路径）：`claim_surface_tile(None, ...)` 返回 `None` → `Err("No unclaimed plots left on '{planet}'")`，新公司创建直接失败；NPC 创业（`engine.rs` `run_npc_startups` → `spawn_company`）同样失败。

**复现（P2 剩余 49 块，用 cB 借来的钱买空）**
```bash
curl ... -d '{"company_id":"cB","intent":{"BankOp":{"planet_id":"P3","op":"borrow","amount":700000000}}}'   # 先借钱（F1）
# 两轮：GET /api/planets/P2/plots 取 status=unclaimed 的 slot_id，每轮 32 个 BuyPlot，然后 step
curl ... -d '{"company_id":"cB","intent":{"BuyPlot":{"planet_id":"P2","slot_id":<sid>,"listing_id":null}}}'
curl -b j -X POST 127.0.0.1:18501/api/companies -H 'content-type: application/json' \
  -d '{"id":"cD","name":"Delta","is_player":true,"profession":"agri_bio","home_planet_id":"P2","initial_cash":50000}'
```
实测：
```
P2 unclaimed before 49, land price 844.65, cB cash 169205.66
cB borrow 70000  -> cash 239205.66 debt 70000.25 ; P3 reserves 230027.32 -> 160027.32
round0: 32 buys -> unclaimed 17, spent 42385.90
round1: 17 buys -> unclaimed  0, spent 33209.50
cB plots 50, cash 163610.26
POST /api/companies {id:cD ... home_planet_id:P2} -> 400 {"body":"No unclaimed plots left on 'P2'"}
conservation_error = 0
```

**影响量化**
- 成本：**75,595 credits / 49 块**（≈ 每块 1,543；含稀缺度涨价后），用借来的钱支付 → 实际自付 0（F1）。
- 时间：**2 个 tick**（32 intent/tick 上限，`types.rs:13` `MAX_INTENTS_PER_TICK=32`）。
- 效果：该行星新玩家无法落地、NPC 无法创业（无新竞争者），且**不可逆**（土地无出售 intent，只能等破产法拍——而玩家不会破产）。
- 若买空全服 5 个行星剩余土地（约 683 块），成本量级 ~1.0e6 credits，而当前货币存量已 5.1e6 credits（`total_minted`），单人可负担。

**修复建议**：给玩家也加每公司地块上限（或按人口/声望配额）；`claim_surface_tile(None)` 失败时 `spawn_company` 应回退到法拍地块/其它行星而不是直接 500；土地需要"未开发税/闲置回收"（`plot` 长期无建筑可被市政收回）。

---

## F5 [已复现] CPI 名义通胀放大 F1/F2/F3（地价/建造费/铸币全部按 CPI 放大）

**代码**
- `world.rs:1201-1205`：`civic_mint = to_money(pop * civic_output_per_capita * prosperity * cpi)`，随 CPI 线性放大并 `record_mint`。
- `world.rs:1277-1282`：行星买单报价 `raw_bid = item_cap.min(last_p*6).min((last_p*108/100).max(prev_bid*102/100))`（**允许 6 倍追价 + 每 tick 2% 抬价**），成交价写入 `last_trade_price`。
- `planet.rs:209-214`：地价 `to_money(320.0 * cpi * prosperity * scarcity * 0.45)`；`world.rs:1618` 建造费 `to_money(80.0 * cpi)`。
- `world.rs:869-889`（`update_cpi`）按各站 `ema_slow / ref_price` 反推 CPI（clamp 0.25~10）。

**实测趋势**
```
tick   56 : cpi 1.04  , P3 地价 441.96
tick  330 : cpi 3.42
tick 1704 : cpi 6.56  , P3 地价 752.78
tick 2109 : cpi 6.56  , P3 地价 773.01 ; total_minted 5,075,030 credits（tick1809）
```
货币存量约每 100 tick 增长 4.5%（`total_minted` 5,075,030 → 5,780,521）。CPI 在 6.5 附近进入平台（未撞 10 的上限），但已经形成**一次性 6.6 倍价格水平跳变**。

**为什么这是"作弊面"而不只是平衡问题**
- 债务、存款是**名义**的：`debt` 不随 CPI 指数化，利息只有 `0.05/8640 ≈ 5.8e-6 / tick`（`planet.rs:33-39`，在 `tick_ms=200` 下 8640 tick ≈ 29 分钟 = "一年"），而价格水平在同期内上涨数个数量级。
- 因此 **"借钱 → 立刻换成货物/地块 → 稍后按新价格卖出"是正期望无风险套利**，即使诚实还款也赚钱；叠加 F1（不必还）与 F3（不会被清算）后等价于免费铸币。
- 地价按 CPI 计入 `primary_land_price`，而玩家买入的地块没有出售途径 → 土地成为**通胀吸收器**（后入场者支付 6.6 倍价格），矛盾在于市政铸币本身又抬高 CPI，属正反馈。

**修复建议**：把 `civic_mint` 与 `primary_land_price` 的 CPI 指数改成"CPI 目标带 + 反馈系数 < 1"（例如 mint 反比于 CPI 偏离），或直接以真实成交均价而非 6 倍追价更新 `last_trade_price`；债务按 CPI 指数化（或利息随 CPI 浮动），否则"借旧钱还新钱"永远占优。

---

## F6 [代码推断] 破产/法拍路径的三处价值泄漏

未实测（本地实例在 1800 tick 后确已出现 BANK 挂单地块：P1 19 / P2 3 / P3 7 / P4 12 / P5 1，但时序不可控，未抓到"在建工程被法拍"的样本）。

1. **在建工程被白送**：`world.rs:1703-1720`（BANK 挂单买地）只迁移 `plot.owner_id` 与 `building_ids`，**不清空 `plot.jobs`**；而 `spawn_company` 的 NPC 复用地块路径会 `pl.jobs.clear()`（`world.rs:627`）。`step_buildings_and_jobs`（`world.rs:929-941`）在工程完工时把建筑给"当时的 plot 所有者"。→ 买家以法拍价（地价+楼×150×cpi 的 65%）继承 NPC 已付过材料与工钱的在建工程。
2. **破产 NPC 地面库存蒸发**：`world.rs:2166-2191` 只回收 `comp.cash` 与 `comp.station_inv`（转成 BANK 88% 卖单），`comp.ground_inv` 随 `companies.remove` 一起丢弃，且 `ledger` 无 `record_burn`。→ 每次 NPC 破产销毁一批实物，属通缩/物品黑洞（不影响货币守恒，故 `conservation_error` 仍为 0，问题因此长期隐形）。
3. **NPC 免费拿地并删楼**：`world.rs:601-633`——`spawn_company`（NPC）优先复用最便宜 BANK 法拍地块，`self.plots.remove` + 删除全部建筑 + **不向银行支付任何 `ask_price`**，也不动 `total_loans/debt_recovery`。→ 银行法拍 Ask 只是"给玩家看的价格"，NPC 侧永久免费回收；同一逻辑下 `LandListing.debt_recovery` 恒为 0（`world.rs:2253`），`world.rs:1694-1696` 的坏账回收分支实际是死代码。

**修复建议**：法拍成交/复用都清空 `jobs` 并退回（或计价）已投入材料；破产时对 `ground_inv` 同样转成 BANK 卖单并 `record_burn`；把 `debt_recovery` 真正写成 `min(ask, debt)` 以便坏账回收可被审计。

---

## 已测试但**未成立**的假设（避免误报）

所有实验都在本地实例（`127.0.0.1:18501`，`tick_ms=200`），用 `pause` + `step` 精确控制单 tick。

| 假设 | 结论 | 证据 |
|------|------|------|
| 同 tick 对同一 `slot_id` 双买可拿两块地/只扣一次钱 | **不成立** | 同 tick 两个 `BuyPlot{P3,slot 1}` → 只成交 1 块（`plots_count 1→2` 仅 +1），`cash 100000 → 99528.21` 只扣 1 次；`planet.rs:394-398` 的 `position()` 过滤条件含 `owner.is_none() && plot_id.is_none()` |
| 同 tick 可超容量刷多栋建筑 | **不成立** | 容量 5 的 plot 99 一次性提交 8 个 `BuildFacility` → `used_slots = 5/5`（jobs 计入 `Plot::used_slots`，`planet.rs:113-116`），只有 5 个被接受；材料正好扣 30（5×6），现金 110398.22→108676.82（5×80×cpi） |
| 拆除→重建循环套利（返材料/返钱） | **不成立** | `DemolishFacility`（`world.rs:1642-1658`）无任何退款：拆 1 栋后 cash/材料完全不变（108215.77→108130.79 只是生产工资），容量从 4 释放到 4 |
| 拆除+同 tick 重建可超容量 | **不成立** | 拆 1 + 同 tick 提交 2 个 Build → 只接受 1 个，`used_slots` 停在 5/5 |
| 拆他人地块/建他人地块/非法建筑类型 | **不成立** | 全部 rejected（`plot.owner_id` 校验 `world.rs:1611`、`1649`） |
| BuyPlot 可买城市地块 / 已占 slot / 出界 slot / 不存在行星 / 不存在 listing / 两者皆空 | **不成立** | 7 个 intent 全 rejected，`cA cash`、`plots_count` 不变（`planet.rs:394-398`、`world.rs:1673-1680`） |
| BANK 法拍地块可重复购买 / 不付钱 | **不成立** | 买 P3 listing 96：`cash -1765.78` 一次，listing 立刻消失，二次购买 rejected；`plots_count` +1；`conservation_error = 0`；跨行星（home P3 买 P2 listing 104）也正确扣款，P2 银行 `reserves +2428.13` 精确等于 `ask_price` |
| 船只 cargo 复制 / 到港重复入账 / 负库存 | **不成立** | `DispatchShip` 后 station 存货 `building_mat 30→24`、到港 ground `190→204`（+6 与 cargo 一致，+8 是当时正在跑的生产批次）；同 tick 两次 dispatch 只成交 1 次（`ore 550→540` 仅 -10）；再跑 3 tick 无二次入账；`add_*_qty` 的 `.max(0)`（`company.rs:61-70`）链路由 `fuel_have/have` 前置校验兜住 |
| 超库存/超容量/未知物品/0 数量/起点不符/非法航线 发货 | **不成立** | 全部 rejected（`world.rs:1768`、`1784-1795`、`1803-1829`） |
| 燃料可被"货舱燃料"重复计算 | **不成立** | station fuel 39 → 28（= 航线 1 + cargo 10），到港 ground fuel +10；`fuel_have < route.fuel + cargo_fuel` 校验正确（`world.rs:1812-1815`） |
| 银行取款/存款可刷出超过存入额 | **不成立** | deposit 1000→`cash -1000 / savings +1000 / reserves +1000 / deposits +1000`；withdraw 反向精确；`conservation_error` 全程 0 |
| 借款额超过储备 | **不成立** | `borrow 50000`（储备 8854）rejected；同 tick 两次借满只成交 1 次 |
| 极端金额导致溢出（`amount = i64::MAX`、0、-1） | **不成立** | borrow/deposit/withdraw/repay 四类 extreme 值全部 rejected，cash/debt 仅随利息变动（`world.rs:1901` 的 `amount <= 0` + 余额校验） |
| 借→存循环可放大可提现金额 | **不成立（但机制值得记录）** | 推导：`borrow A` 使 `reserves -A`、`deposit A` 使 `+A`，循环后 `reserves` 回到原值，`savings = debt = k*A`；最终可提上限仍是 `reserves`，且 `savings - debt = 0` → **净值为 0 且因利息不进现金而净亏**。已按 F2 实测曲线验证（借款后 `reserves=300`，取款一律失败） |
| `RepairShip` 可白修/跨地点修 | **未实测（代码推断安全）** | `world.rs:1868-1894`：要求 `durability < 99.9`、必须持有 `repair_cost` 单位的 `repair_item`（`catalog.repair_item = daily_goods`，`production.json` 的 `tier1_plus/repair` tag）、从船只所在 `location` 的库存扣；实测环境缺 daily_goods 未跑通，结论标记为**需验证** |

---

## 附：可复用的最小 PoC 步骤（curl）

```bash
BASE=127.0.0.1:18501
# 0) admin 注册（首个用户）
curl -s -c j -X POST $BASE/api/auth/register -H 'content-type: application/json' \
  -d '{"email":"a@example.com","nickname":"AdminX","password":"Pw-Str0ng-A1"}'
# 1) 暂停，精确 step
curl -s -b j -X POST $BASE/api/sim/control -H 'content-type: application/json' -d '{"action":"pause"}'
# 2) 建两个测试公司（cash clamp 100k）
curl -s -b j -X POST $BASE/api/companies -H 'content-type: application/json' \
  -d '{"id":"cA","name":"A","is_player":true,"profession":"mining_ind","home_planet_id":"P3","initial_cash":100000}'
# 3) F1/F2：cB 存款 -> cA 借满 -> cB 取款失败
#    （把 300000000 换成 30000*10000；借满用 GET /api/admin/overview 的 bank_reserves-300）
# 4) F4：GET /api/planets/P2/plots 取 unclaimed slot_id，批量 BuyPlot（32/轮）
# 5) 观察：GET /api/admin/overview（companies/planets.bank_*）、GET /api/health（conservation_error）
```

---

## 结论与优先级

1. **先修 F1 + F3**（两者是同一根因：借贷无信用约束、玩家无清算）。这是本文件唯一能"用 2 个 intent 拿走全服银行储备"的路径，且完全不需要 Lead 已发现的 `DealOrder` 溢出。
2. **再修 F2**（准备金率/兑付队列），否则任何玩家借款都会冻结他人资产，且 `net_liquid` 排行榜显示虚高资产。
3. **F4** 是廉价且不可逆的竞争性 DoS（约 7.6 万 credits + 2 tick 杀死一个行星的新公司创建）。
4. **F5** 需要和 task-2/task-7 的物价结论合并看；单看本文件，它把 F1/F3 从"占用银行储备"升级为"无风险真实收益"。
5. **F6** 属价值泄漏/审计盲区，建议顺手修（尤其 `jobs` 未清空与 `ground_inv` 销毁）。

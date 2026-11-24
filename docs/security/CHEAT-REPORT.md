# Meridian 反作弊审计（第二轮）：经济系统漏洞

- 范围：CLOB 交易所 / escrow / 撮合结算 / 银行 / 地块 -> 覆盖 `Intent` 全部 11 个动作
- 方法：源码逐行 + **本地隔离实例**实测（`MERIDIAN_TICK_MS=200`，`sim/control pause/step` 精确控制），线上仅在授权下做过一次 ECON-02 同源验证
- 结论：**两个 Critical 级"造钱"漏洞**、一个 High 级"无限贷款"漏洞；另有 3 个假设经实测**不成立**（避免误报）
- 关联：`cheat-market.md`（撮合/CPI/城市需求）、`cheat-land-logistics.md`（地块/船/银行）、`cheat-sandbox.md`（脚本沙盒）

---

## 0. 修复状态（2026-11-24 晚，见 FIXES.md）

- **CS-01 / CS-02 / CS-03 已修复**：meridian-core 全链路 checked 运算 + escrow/refund 不变量 + 价格带；回归测试 14 项全绿。
- **MK-01 已部分修复**：`DealOrder` 现在禁止跳过更优价对手单（堵住深档投毒/自成交主路径）。
- **顺带修复**：银行贷款已加信用额度、到期日、逾期 25% 扣划、25% 最低准备金（BL-01..03；属于超出原分工的行为变更，可单独回退）。
- **未修**：MK-02/03（城市报价/CPI）、BL-04..06（地块）、SB-01..04、MK-04。
- 修复后旧存档中已损坏的订单会在撮合时被摘除并烧掉残余 escrow；建议直接删档重置。

## 1. 结论总表

| ID | 漏洞 | 严重度 | 状态 | 位置 |
|---|---|---|---|---|
| **CS-01** | 撮合 refund 失配：部分成交时 `buyer_refund` 按 `take × 挂单价` 计算，而实收 escrow 是 `qty × price` 截断后的值 → **凭空造钱**（2 个 intent 造 6.1e14 credits） | **Critical** | 本地已复现，守恒审计暴增 | `exchange.rs:276-278`、`world.rs:1963-1971` |
| **CS-02** | `DealOrder` 负 notional：`take × price` 用 `as Money` 截断成负数，`if cash < notional` 对负数恒假 → 买家现金增加、卖家变成负资产（可转移/洗白，净额守恒） | **Critical** | 线上已复现（u5 +4.61e14 credits） | `world.rs:1477-1489` |
| **CS-03** | 买单 escrow 无范围校验：`(qty × price) as Money` 无上限/溢出检查，只查 `cost<=0` → 用 **2 Money（0.0002 credit）** 的 escrow 挂出 6.1e18 单位价的买单，是 CS-01 的入口 | **High** | 本地已复现 | `world.rs:1362-1371` |
| **CS-04** | 银行借款永不追偿：`BankOp::Borrow` 只要储备够就放款，玩家公司**永不破产**（`world.rs:2120`）、债务只加利息不催收 → 无限期无抵押贷款，可套现买地/买厂/买船 | **High** | 本地已复现（借 5,000 credits 立即到账，债务仅缓慢计息） | `world.rs:1849-1865`、`world.rs:2092-2115` |
| **CS-05** | 城市买单"按卖价 1.03 倍下单"：薄市场里玩家可自行挂高价 ask，城市下一 tick 以 1.03×ask 出价并成交（成交价取先创建方价格，刚好是城市价）→ 可抽干星球财政 | **Medium**（条件性 High） | 机制已确认；需"无敌对 ask"才成立，NPC 做市商通常会自动压价 | `world.rs:1277-1282`、`exchange.rs:270-274` |
| CS-06 | 地块建造 **不可** 超容量（`used_slots = building_ids + jobs`，实测 10 个 BuildFacility 只成 5 个） | — | **实测不成立** | `planet.rs:113-115` |
| CS-07 | 洗售抬价（wash trade）拉 `last_price` → 城市按 last_p 出价 | — | **实测基本不成立**：NPC 每 tick 大量成交会把 last_price 重置为市价；且城市优先按 best_ask 出价 | `exchange.rs:330-343`、`world.rs:1250-1281` |
| CS-08 | NPC 手工挂单会被 NPC 大脑在下一 tick 撤掉/改价（订单 id 每 tick 变）→ 用旧 id 发 `DealOrder` 会静默失败 | 公平性/UX | 实测确认（非作弊，但让"按 id 吃单"不可靠） | `npc.rs` 决策、`exchange.rs:165-189` |
| **BL-01** | 银行贷款无信用/抵押/额度，玩家永不清算 → 新公司净资产 100 可一次借到 19,629（**196×**），借满后转入第二公司，骡子公司 net −18,466 / debt 54,268，跑 500 tick 无破产、资产完好 | **High** | 已复现（`cheat-land-logistics.md` F1） | `world.rs:1932-1942,2092-2124` |
| **BL-02** | 取款只认 `reserves`，借款直接抽干储备 → **一个借款人可永久冻结全服存款**：cB 存 30,000 后取款 260 tick 永久失败，存款仍计入净额 | **High** | 已复现（F2） | `world.rs:1896-1906` |
| **BL-03** | 死债推高全服利率：`total_loans` 40,445→89,037，利率被钉在上限 1797 bps | **High** | 已复现（F3） | `world.rs:2092-2115` |
| **BL-04** | 地块 90% 上限只约束 NPC；玩家用借来的钱 2 tick 买空 P2 全部 49 块（75,595 credits），行星永久无法新建公司/NPC（400 No unclaimed plots left） | **Medium** | 已复现（F4） | `world.rs:1660-1730` |
| **BL-05** | CPI 通胀（1.04→6.56）稀释债务 6.6×，借钱囤地/囤货无风险正收益，放大 BL-01/03 | **Medium** | 已复现（F5） | `world.rs:869-889` |
| **BL-06** | 法拍买地不清 `plot.jobs`（买家白得在建工程）、破产 NPC 库存销毁无 burn、`spawn_company` 免费复用 BANK 地块还删楼、`debt_recovery` 恒 0 使坏账回收成死代码 | **Low** | 代码推断（F6） | `world.rs:2241-2255,613-644` |
| **SB-01** | **校验不对称**：包装 escrow 买单（`qty×price ≡ 1 mod 2^64`）被沙盒的精确 i128 检查拦下，但同一参数经 `POST /api/intent` 入队成功 ⇒ 唯一的正确算术检查在沙盒层，权威 core 反而不设防 | **High** | 已复现（`cheat-sandbox.md` S1） | `js_runner.rs:990-995` vs `world.rs:1362-1370` |
| **SB-02** | NPC 是无上界兑现端：NPC 卖方只要 `best_bid ≥ 0.65×last` 就按该 bid 成交，无价格上限 → 幻影资金 3 tick 换成 33,250 power，NPC 现金灌到 10^14 credits | **High** | 已复现（S2） | `npc.rs` 卖单决策 |
| **SB-03** | 价格/EMA/CPI 污染：单笔 warp 成交把 `ema_slow` 从 8,501 推到 6.7e13 Money，CPI 0.9979→3.75；CPI 是工资/铸币/地价乘数 ⇒ 一次性溢出放大为持续全局通胀 | **Medium** | 已复现（S3） | `exchange.rs:330-343`、`world.rs:869-889` |
| **SB-04** | `conservation_error` 超出 i64 后，`/api/sim/control` step 与 `/api/admin/overview` 在 tokio worker panic（`serde_json::to_value(...).unwrap()`），管理员端点不可用；health/state 仍正常 | **Medium** | 已复现（S4） | `api.rs:598-608`、`engine.rs` |
| **SB-05** | 资源面：`PUT /api/scripts` 无体积/模块数配额（仅 2MB body）、每 tick 每玩家 clone 整个 bundle；`extra_intents` 队列无上限 | **Low** | 代码确认 + 1.9MB 上传复现（S6） | `api.rs:464-512`、`runner.rs:118`、`engine.rs:1471-1481` |
| **MK-01** | `DealOrder` 绕过价格优先，是"任意定价成交"原语：深档卖单标价 500，被直接点掉（盘口 3.84）；成本 2.5 credits 即把 `ema_fast` 抬 9.4×、`ema_slow` 4.3×（衰减 3%/tick，毒效 ~100 tick） | **High** | 已复现（`cheat-market.md` N1） | `world.rs:1445-1565,1477`、`exchange.rs:270-343` |
| **MK-02** | 城市采购价无参考价钳制 + 1.02 棘轮：`min(item_cap, 1.03×best_ask)` / `min(item_cap,1.08×last,1.02×prev)`；线上盘口已出现 P2 clothing 1278（**58×** ref）、P3 daily_goods 1970（**89×** ref）；每 tick 预算 = treasury×18%（P1 5007 / P2 4410 / P3 3632 credits） | **High** | 已复现 + 盘口数值精确吻合 | `world.rs:1193-1313` |
| **MK-03** | CPI 由可被玩家写入的 `ema_slow` 驱动 → `civic_mint ∝ cpi`（上限 10×），铸币量可放大 8–10 倍；地价/工资/建造费同步放大 | **Medium** | 已复现 EMA/CPI 走向 + 代码推断倍率 | `world.rs:869-889,1202-1204` |
| **MK-04** | 手动 intent 静默截断：单 tick 提交 40 条只生效 32 条，HTTP 全部 200 `queued:true`，无回执/不重排 | **Medium** | 已复现（N5） | `world.rs:807-813`、`engine.rs:167-187` |
| **MK-05**（待验证） | `DealOrder` 直接点名吃 `PLANET:*` 买单：代码上 `is_valid` 只查 owner≠self，路径存在；但**实测城市单 id 每 tick 全部轮换**（2 个 step 后 13 张单 id 全变），而 intent 在 `place_planet_demands` 之后才应用 → 拿不到当 tick 新 id，**大概率打不出来**；不能作为已确认收割通道 | 需验证 | 机制代码成立，实际 id 竞态待定 | `world.rs:1445-1477,1193-1313` |
| **MK-06** | 世界推进依赖 `HashMap` 迭代顺序（预算不足时随机 `continue`）+ 订单簿 O(n) 全表扫描；`total_escrow_cash()` 用 `i64 .sum()` 可溢出 | **Low** | 代码推断（N6/N7） | `world.rs:1193-1313`、`exchange.rs:225-231` |

---

## 2. CS-01：撮合退款失配 → 直接造币（最严重）

### 2.1 代码路径

```rust
// exchange.rs:265-288（match_all）
let trade_price = if a.created_tick <= b.created_tick { a.price } else { b.price };
let take = b.qty.min(a.qty);
let notional = (take as i128 * trade_price as i128) as Money;        // 可能截断
let escrowed_for_take = (take as i128 * b.price as i128) as Money;   // ← 用挂单价重算
let buyer_refund = escrowed_for_take - notional;                     // ← 可能巨大正数
b.escrow_cash -= escrowed_for_take;
```

问题：**下单时** escrow 是 `qty × price` 截断后的值（可能很小），**成交时**退款却按 `take × price` 重新算；只要 `take < qty` 且 `take × price` 没溢出，退款就远大于实际托管，直接打给买家（`world.rs:1963-1971`）。

### 2.2 复现（本地，2 个 intent，1 个 tick）

```
P = (2^64 + 2) / 3 = 6148914691236517206   # 满足 3×P ≡ 2 (mod 2^64)

1) cB: CreateOrder buy  power  qty=3  price=P    → 托管计算 3×P 截断 = 2 Money（0.0002 credit）
2) cA: CreateOrder sell power  qty=1  price=1    → 最便宜卖单，保证 take=1
3) step()
```

实测（本地隔离实例）：

```text
before: cB cash = 996,155,190 Money
after : cB cash = 6,148,914,692,232,672,393 Money   (Δ = +6,148,914,691,236,517,203)
        ≈ +614,891,469,123,651 credits（约 6.1e14）
conservation_error Δ = +6,148,914,691,236,565,202
```

**关键点**：`take=1` 时 `1 × P = P` 没有溢出（正数），而实际托管只有 2 → 退款 ≈ P。若一次成交 `take=3`，`3×P` 又回绕成 2，退款≈0；所以攻击者用自己的 **1 单位卖单** 保证部分成交即可，无需依赖 NPC。

### 2.3 影响

- 单公司可同时挂 64 个买单（`MAX_ACTIVE_ORDERS_PER_COMPANY`），每单可造 ~6.1e14 credits；多账号无上限。
- `/api/health` 的 `conservation_error` **不总是报警**：造出来的钱先从托管（负数 escrow）里扣，只要那张负 escrow 的买单还挂在簿上，守恒总量就被"负托管"抵消，`conservation_error` 可能保持 **0**（cheat-sandbox 实测：cI 已 76.8 万亿 credits 而 error=0）；当订单被吃光/撤掉、负托管消失后，error 才暴增。⇒ 不能把 `conservation_error` 当唯一铸币告警，必须加"单笔退款 ≤ escrow""escrow_cash ≥ 0"这类**交易级不变量**。
- 当前 `conservation_error` 只展示、不告警、不暂停撮合；配合 SB-04，它超出 i64 还会把管理端点打挂。
- 与 CS-02 叠加：一个负责造钱（净额变化），一个负责把负资产甩给弃置账号。

### 2.4 修复

1. **下单**：`qty × price` 用 `i64::try_from` + 上限白名单，任何溢出/超限直接拒绝：
```rust
let cost = (qty as i128).checked_mul(price as i128)
    .filter(|v| *v > 0 && *v <= i64::MAX as i128)
    .ok_or("order notional out of range")?;
```
2. **成交**：退款必须基于"实际剩余托管"，而不是用价格重算；并且 `escrowed_for_take` 必须 ≤ `b.escrow_cash`，否则中止撮合并告警：
```rust
let escrowed_for_take = i64::try_from(take as i128 * b.price as i128)
    .map_err(|_| "escrow overflow")?;              // 拒绝，不要 as 截断
if escrowed_for_take < 0 || escrowed_for_take > b.escrow_cash { abort_and_alert(); }
let buyer_refund = escrowed_for_take - notional;    // 两者都非负 -> 不会凭空造钱
```
3. **不变量**：任何挂着的买单必须满足 `escrow_cash == qty * price`（用 checked 乘法校验）；每笔成交审计
`buyer_cash_delta + seller_cash_delta + fee == 0`。
4. **运行时守卫**：`conservation_error != 0` → 自动暂停撮合 + 告警，而不是只回显在 `/api/health`。
5. 价格带：`price` 限制在 `[0.2×, 5×] × ema_slow/ref_price` 之内，异常价直接拒单（同时堵住 CS-05）。

---

## 3. CS-02：`DealOrder` 负 notional（净额转移/洗白）

已在线上复现并写进 `REPORT.md §6`。补充要点：

- 触发：`take × price` 截断成负数 → `cash < notional` 恒假 → `cash -= notional` 增加买家现金，卖家现金等额变负。
- 因为 `world.rs:2120` "Players are NEVER force-bankrupted"，负资产卖家不会被清算/追偿 → 实际上等价于把可消费购买力集中到主账号。
- 与 CS-01 的区别：CS-02 净额守恒（`conservation_error` 仍为 0，**更难发现**），CS-01 会打破守恒。
- 修复与 CS-01 共用一套 checked 乘法 + 价格带 + 结算不变量。

---

## 4. CS-03：买单 escrow 截断（CS-01 的入口）

```rust
// world.rs:1362-1371
let cost = (qty as i128 * price as i128) as Money;
if cost <= 0 || comp.cash < cost { return false; }
comp.cash -= cost;
```

- 只挡 `<= 0`，不挡"截断后是个很小的正数"；这就是 CS-01 能用 2 Money 挂 6.1e18 单价的原因。
- 同类写法还出现在 `place_planet_demands`（`needed_escrow`）、`exchange.rs:304`（`notional` 重算）——全部要换 `i64::try_from`。

---

## 5. CS-04：银行借款永不偿还

```rust
// world.rs:1849-1865
BankOpKind::Borrow => {
    if p.bank.reserves < amount { return false; }
    p.bank.reserves -= amount;
    p.bank.total_loans += amount;
    cash += amount;  debt += amount;
}
```

- 本地实测：cA 连续借款 1,000 / 5,000 credits 均到账；第 3 次 50,000 被拒（储备耗尽）→ **上限就是该星球银行储备**。
- 债务每 tick 计息（实测债务 +约 500 Money/步），但 `process_npc_bankruptcies` 明确跳过玩家（`world.rs:2120`），**没有任何催收/抵押/清算**；可拿现金去买地/建厂/买船，收益归自己，债务永久挂账。
- 量化：单账号可借满本星球储备；正常玩家净流动资产 1 万 credits 量级，等于 **凭空多出一份可投资本金**，且 `net_liquid`（排行榜）才看得见，不影响实际游玩。
- 修复建议：借款要有抵押/额度（如 `debt ≤ 净资产 × 0.5`）、按 tick 强制还款或冻结资产、玩家也纳入破产/追偿流程（至少 `cash` 为负时禁止交易/建造）。

---

## 6. CS-05：城市买单可被高价 ask 抽干（条件性）

```rust
// world.rs:1277-1282
let raw_bid = match ba {
    Some(ask_p) => item_cap.min((ask_p * 103) / 100),   // ← 直接按 best_ask × 1.03
    None => item_cap.min(last_p.saturating_mul(6)).min(...),
};
```

- 若某商品当前 **没有更低的 ask**，玩家挂一个高价 ask 后，下一 tick 城市会以 1.03×ask 出价并与之成交；成交价取"先创建方"的价格（城市 bid 在 0d 创建，早于玩家 intent），即玩家拿到接近自己挂单价的钱。
- 实测：在 power 市场挂 7 单位 @500 credits，城市 bid 只有 2.21（因为 NPC 还有 2.15 的 ask，best_ask 取最低）；把 ask 清空后再挂高价，NPC 会在同 tick 重新挂低价 ask 抢走成交。→ **只要 NPC 做市正常，这条基本打不出来**。
- 真正危险的场景：某星球/某商品 NPC 完全不供应该商品（薄市场），玩家可独享 ask → 抽干该星球财政。需要用 `PRODUCTION.json` 找出"有需求但无 NPC 供给"的商品验证；目前未找到稳定组合。
- 修复：城市出价加"参考价 / 近 N tick 均价的硬上限"（如 `min(ask*1.03, ref*2)`），并限制单玩家单 tick 对同一商品的可成交额。

---

## 7. 已测试但**不成立**的假设（避免误报）

| 假设 | 实测结果 | 原因 |
|---|---|---|
| 同 tick 刷多个 BuildFacility 可超容量建造 | **不成立**：10 个 intent 只成 5 个，`used_slots` 含 `jobs` | `planet.rs:113-115` |
| 洗售 1 单位天价可把 last_price/CPI 拉爆并套利 | **基本不成立**：NPC 每 tick 数十笔成交重置 last_price；城市优先用 best_ask 出价 | NPC 做市 + `world.rs:1250` |
| NPC 公司可被"代理"挂单来操纵市场 | **不成立**：NPC 大脑下一 tick 撤单/改价；订单 id 每 tick 变 | NPC 决策每 tick 重排订单 |
| 双账号对敲（wash trade）可刷排行榜 | 不成立：净额守恒、只损失手续费；`net_liquid` 不变 | 结算数学 |
| `DispatchShip` 重复提交可复制 cargo | 不成立：`is_busy` + 库存扣减 | `world.rs:1700+` |
| 同 tick 同 slot 双买地块 | 不成立：只成交 1 次，第二次 claim 失败 | `planet.rs:394-397` |
| 拆除再建造循环套利 | 不成立：拆除零退款 | `world.rs:1647-1660` |
| 买城市/他人地块、失效 listing、非法 slot | 不成立：全部被拒 | `world.rs:1660-1730` |
| 银行存取/借贷/repay 的精确性与 i64 极值溢出 | 不成立：金额校验与饱和处理正确 | `world.rs:1896-1942` |
| 借存循环放大 | 不成立：净值恒 0 且净亏 | 结算数学 |
| 沙盒限额可绕过（32 intent/5ms/4MB/128KB/日志） | 不成立：全部实测有效，失败 tick 全回滚 | `js_runner.rs:379-393` |
| 脚本直接造"包装 escrow"（`Game.market.createOrder`） | 不成立：沙盒精确 i128 拦住返回 -14；**但同一参数走 REST 可以**（SB-01） | `js_runner.rs:990-995` |
| 崩溃/超时/OOM 留下半成品 intent | 不成立：整 tick 回滚，intents=0 | `js_runner.rs` |
| `Game.bank` 1e300 透支 / 恶意 FFI 参数打崩宿主 | 不成立：reserves 校验拒绝；只抛 JS TypeError | `js_runner.rs` |
| 脚本读他人库存 / 给 NPC 挂脚本 | 不成立：own-only 库存 + `is_player` 门控，NPC 不执行脚本 | `js_runner.rs` |

---

## 8. 交付与复现方法

- 本地隔离环境（本次使用）：
```bash
mkdir -p .audit-local/lead && cp data/production.json .audit-local/lead/
cd backend
MERIDIAN_ADDR=127.0.0.1:18510 MERIDIAN_DATA_PATH=../.audit-local/lead/production.json \
MERIDIAN_DB_PATH=../.audit-local/lead/db.sqlite MERIDIAN_DIST_DIR=../.audit-local/lead/nodist \
MERIDIAN_TICK_MS=200 ./target/release/meridian-server
```
- 首个注册用户是 admin；admin 调 `ensure_owner` 放行任意 company_id，可一个会话操作任意公司（用于 PoC，非漏洞）。
- CS-01 PoC 的核心两条请求见 §2.2，全部是合法 JSON，不需要任何越权。

## 9. 与城市/行情相关的补充（MK 系列）

- **城市报价自我引用**：`update_cpi` 用 `ema_slow` 反推、城市用 `best_ask/last_p` 出价，二者都**不回落到 `catalog.ref_price`** → 价格正反馈。实测（无作弊）CPI 已从 1.157 漂到 3.726，城市买价对 ref 出现 22–89×。
- **收割路线（现实版）**：不是"点名吃城市单"（id 每 tick 轮换，见 MK-05），而是**成为该商品的 best_ask**：对 NPC 不供应的薄商品（如 clothing / daily_goods），城市会按 `1.03×ask` 或棘轮价买入；玩家用 2 个诚实账号把货从 HUB 运来即可按 58–89× ref 卖给城市，单 tick 可吃掉该星球 18% 财政预算。
- **MK-01 的独立危害**：即使不吃城市单，单笔 `DealOrder` 就能把 `ema_slow` 抬高数倍并维持 ~100 tick，进而影响 NPC 报价、Hub 租金、CPI 与地价——这是"行情可被玩家写入"的根问题。
- **修复方向**：`DealOrder` 改为按盘口最优价成交（或直接禁止偏离参考价 >X 的挂单被点名成交）；城市 `raw_bid` 硬钳制到 `ref×[0.5,3]`；CPI 输入按成交量加权并剔除偏离 >4× 的成交；`civic_mint` 的 CPI 系数单独 clamp 到 `[0.5,2]`。

## 10. 修复优先级

1. **P0**：`qty×price` 全链路 checked + 价格带；撮合退款改为"基于实际 escrow + 上限"；`DealOrder` 改为按盘口最优价结算（禁止点名偏离参考价 >X 的挂单）；`conservation_error != 0` 自动暂停 + 告警。
2. **P0（价格信号）**：`Order.price` 上下限（`ref×[0.2,5]`）；城市 `raw_bid` 硬钳制 `ref×[0.5,3]`；CPI 只接受落在参考价带内的成交。
3. **P1**：玩家破产/追偿或借款抵押；订单 escrow 不变量（`escrow == qty*price`）加断言与单测。
4. **P1**：其他 `as Money` 截断统一清理；`tests/invariants.rs` 加 property/fuzz（随机 price/qty/take，断言 notional 与 escrow 非负且守恒）。
5. **P1（银行/地块，来自 BL-01..05）**：借款加信用额度（`debt ≤ 净资产×0.5`）与抵押；取款引入准备金率/排队，禁止借款把 reserves 抽到 0；玩家纳入追偿（`cash<0` 禁交易/建造、强制变卖）；地块购买加每公司上限（与 NPC 一致）；CPI 加硬上限或与名义债挂钩。
6. **P2（沙盒/管理面，来自 SB-01..04）**：REST 与沙盒共用同一套 `checked_mul` + 价格带（消除"沙盒严、核心松"的不对称）；NPC 兑现加价格上限（`bid ≤ N×ref`）；管理端点用 `serde_json::to_value(...).ok()` 替代 unwrap，避免经济异常把管理面打挂。
7. **P2**：订单簿异常检测（价格 >10× 近期 EMA、单账号同 tick 巨额成交、退款 > escrow、escrow != qty×price）落库告警，并自动冻结可疑公司在审。

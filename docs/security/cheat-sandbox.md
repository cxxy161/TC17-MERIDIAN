# Meridian 反作弊审计（第二轮 · task-6）：QuickJS 沙盒 / NPC / 脚本生成意图

> 审计者：cheat-sandbox · 仅本地实例（`127.0.0.1:18502`，`MERIDIAN_TICK_MS=200`，独立 data/db）复现，未触碰线上。
> **去重声明**：Lead 已确认的两个 Critical（`world.rs:1477` DealOrder 负 notional；`exchange.rs:276-278` match_all escrow/refund 失配凭空造钱）本报告**不复述推导**，只在 §4 记录一条与它们互补的新观测（守恒检查失明）以及一条校验不对称结论。本报告的 PoC 全部在本地实例跑出；收尾时测试目录 `.audit-local/cheat-sandbox/` 已按指令删除，命令与数值均写入本文。

## 0. 结论摘要（只列本轮**新**的、可复现项）

| # | 结论 | 严重度 | 状态 |
|---|---|---|---|
| **S1** | **校验不对称**：包装 escrow 买单（`qty×price ≡ 1 mod 2^64`）被**沙盒精确 i128 拦下（-14）**，但同一参数经 `POST /api/intent` 入队成功（escrow=1 Money）⇒ 唯一正确的算术检查在沙盒层，核心权威层不设防。沙盒不是安全边界，反而比 REST 更严 | **High** | **已复现**（两条通道对比） |
| **S2** | **NPC 是无上界兑现端**：NPC 卖方只要 `best_bid ≥ 0.65×last` 就直接以该 bid 价成交，**没有价格上限**。配合 S1/Lead#2，3 个 tick 内把幻影资金换成 **33 250 power** 现货，并把 NPC 现金灌到 **10^14 credits**（初始 8 000） | **High** | **已复现** |
| **S3** | **价格/EMA/CPI 污染**：单笔 warp 成交进入 EMA（3% 权重）后，`power@ST:P1` 的 `ema_slow` 从 8 501 → **6.7×10^13 Money**，CPI 从 **0.9979 → 3.39（30 tick）→ 3.75**；CPI 是工资/市政铸币/地价的乘数 ⇒ 一次性溢出被放大成持续全局通胀 | **Medium** | **已复现** |
| **S4** | **经济越界会打断管理端点**：`conservation_error` 一旦离开 i64 范围，`POST /api/sim/control {"action":"step"}` 与 `/api/admin/overview` **无响应（http=000）并在 tokio worker panic**（`serde_json::to_value(...).unwrap()` 序列化 i128 越界）。health/state/resume 正常，非 admin 仍 403 | **Medium** | **已复现** |
| **S5** | 沙盒限额/隔离实测**有效**（intent 32、5 ms、4 MB、Memory 128 KB、日志 200×1 KB、失败 tick 全回滚、恶意参数只抛 TypeError、NPC 不执行脚本、库存不跨公司） | Info（正面） | **已复现** |
| **S6** | 资源面：`PUT /api/scripts` 无体积/模块数配额（仅 axum 2 MB body），且**每 tick 每玩家 clone 整个 bundle**（`runner.rs:118`）；`extra_intents` 队列无上限 | Low | 代码确认 + 1.9 MB 上传复现 |

---

## 1. S1（High，已复现）沙盒拦住了包装 escrow，REST 没有

**机理**：`js_runner.rs:990-995` 用**不截断的 i128** 算成本；`world.rs:1362-1370` 用同一算式但 `as Money` 截断，只兜底 `cost <= 0`。

```rust
// sandbox: 精确
let cost = qty as i128 * price as i128;
if (h.snapshot.company.cash as i128) < cost { return ERR_NOT_ENOUGH_CREDITS; }

// core: 截断（world.rs:1364）
let cost = (qty as i128 * price as i128) as Money;
if cost <= 0 || comp.cash < cost { return false; }
```

**PoC（取 `274177 × 67280421310721 = 2^64 + 1` ⇒ escrow 截断为 1 Money）**

```bash
# 通道 A（脚本）：被拦
#   Game.market.createOrder({type:"buy", stationId:"ST:P1", resourceType:"power",
#                           price: 6728042131.0721, totalAmount: 274177})  -> -14 ERR_NOT_ENOUGH_CREDITS
# 通道 B（REST）：放行
curl -b j -X POST 127.0.0.1:18502/api/intent -H 'content-type: application/json' \
  -d '{"company_id":"cI","intent":{"CreateOrder":{"station_id":"ST:P1","side":"buy",
       "item_id":"power","qty":274177,"price":67280421310721}}}'
# => {"ok":true,"queued":true}；order.escrow_cash = 1 Money = 0.0001 credit
```

**收益（该买单与更早的便宜卖单交叉，幻影退款 `take×(b.price−trade_price)`，`world.rs:1963-1970` 只加不扣）**：

| tick | `cI` 现金（credits） | 该买单 `escrow_cash`（Money） |
|---|---|---|
| 投单前 | 100 000 | — |
| +1（1 次成交） | **76 787 144 911 422.75** | **-767 871 448 419 258 772** |
| +3 | 76 787 144 911 403.05 | -1 647 226 554 950 382 242 |

成本 0.0001 credit，**≈7.7×10^8 倍**，且每 tick 持续退款（挂单不撤就一直退）。该数值与 Lead 的 #2 同源，此处只作为 S1 的对照实验，**不重复**其漏洞结论。

---

## 2. S2（High，已复现）NPC 没有价格上界，是幻影资金的兑现端

```rust
// npc.rs:564-582
let ask_p = if let Some(bb) = q.best_bid {
    let bb_f = from_money(bb);
    if bb_f >= last_p * 0.65 || bb_f >= ref_p * 0.65 {
        bb_f                     // 直接按买单价卖出，无 max(ref_p*K) 上限
    } else { base_ask }
} else { base_ask };
```

**观测（cI 挂上 S1 的包装买单后，未做任何 NPC 相关操作）**：

- `cI` 在 3 个 tick 内吃到 **33 250 power**（账面 2.37 credits，实际按 6 728 042 131 credits/单位成交）；
- NPC 现金：`npc_00 ≈ 2.05×10^14`、`npc_01 ≈ 2.22×10^14`、`npc_02 ≈ 2.72×10^14` credits（初始 8 000，**≈3.4×10^10 倍**）；
- 盘口：`best_bid = 6.7×10^13 Money`、`best_ask = 4.6×10^18 Money`、`last_price = 6.7×10^13 Money`。

**影响**：NPC 变成「无限买单方」后，攻击者可用正常价格把垃圾货卖给这些有钱 NPC，把铸出的钱洗成可支配资产（NPC 单笔预算 `cash×0.25`、每单 ≤25 单位，`npc.rs:599-601`，上限随现金线性放大）。**修复点**：`ask_p = min(bb_f, max(ref_p*K, last_p*2))`，禁止吃 `> ref_p*K` 的 bid。

---

## 3. S3（Medium，已复现）warp 成交 → EMA → CPI 的全局通胀放大器

- `exchange.rs:330-343`：`next_s = (prev_s*97 + price*3)/100`，单笔 4.6×10^18 Money 进入 3% 权重；
- `world.rs:869-889`：`update_cpi` 用 `ema_slow/ref_price` 逐项 `clamp(0.2,8.0)` 后取均值。

实测：`power@ST:P1` 的 `ema_slow` 8 501 Money → **6.7×10^13 Money**；CPI **0.9979（tick 31）→ 3.39（tick 283）→ 3.75（tick 553）**。CPI 乘在：

- 工厂工资 `to_money(labor_cost * cpi)`（`world.rs:1008`）；
- 市政铸币 `civic_mint = to_money(pop * civic_output_per_capita * prosperity * cpi)` + `record_mint`（`world.rs:1202-1204`）⇒ **按 CPI 线性增发**；
- 地价、建造成本、NPC 扩产阈值、破产线。

即一次溢出（不论走哪条通道）都会经 EMA→CPI→铸币变成持续通胀。**修复**：`update_cpi` 输入去极值（成交量加权/分位数），或把偏离 clamp 收紧到 `(0.5, 2.0)`。

---

## 4. 与 Lead 两个 Critical 的互补观测（不重复结论）

**4.1（Medium，已复现）守恒检查对「幻影退款」失明**：Lead 的 #2 会让 `conservation_error` 暴涨；但走 escrow 失配路径时，幻影退款使 `cash +R` 而同一张单 `escrow_cash` `-R`（`world.rs:760-770` 把 escrow 计入总量），两者抵消：

```text
tick 553: conservation_error = 0
  同时 cI = 76.8 万亿 credits；cC = 461 万亿；npc_00/01/02 = 2.0~2.7×10^14 credits
```

⇒ `/api/health` 的 `conservation_error` **不能作为铸币告警信号**（既能暴涨，也能为 0）。修 escrow 时必须同时断言 `escrow_cash >= 0` 且 `escrow_cash == qty*price`。

**4.2（Medium，已复现）S4 管理端点 panic**：`TickBroadcast.conservation_error` 是 `i128`（`engine.rs:175`），而 `sim/control` 用 `serde_json::to_value(&bcast).unwrap()`（`api.rs:731-740`），`Number` 容不下 i64 之外的 i128：

```text
conservation_error = -18446744073709551616 (-2^64)
POST /api/sim/control {"action":"step"} -> http_code=000（无响应）
server.log: thread 'tokio-rt-worker' panicked at api.rs:602:50:
            called Result::unwrap() on an Err value: Error("number out of range", line: 0, column: 0)  ×20+
```

`/api/health`、`/api/state` 仍 200；非 admin `step` 仍 403；`resume` 与 tick 循环不受影响 ⇒ 非进程级 DoS，而是「管理员操作台静默失效」。修复：`if let Ok(...)` 或把该字段序列化为字符串；tick loop 补 `catch_unwind`。

**4.3** 脚本确实能把 Lead#1（DealOrder 负 notional）**无人值守自动化**：实测两条脚本（卖方 `2^62` 卖 3 单位、买方每 tick 吃最贵卖单）单笔给买方 `+4 611 686 018 427 387 904 Money`（+461 168 601 842 738.79 credits，成本 ≈6 credits 存货、escrow 0）；连做两笔现金回绕到 `-9223372035855156319`（= `(4611686019427007393 + 2^62) mod 2^64`，完全吻合）。**新信息**：现金加法本身也是裸 `i64`（`world.rs:1485,1981`），所以「二阶溢出」把公司打到 `i64::MIN` 附近是可行的；负现金玩家永不破产（`world.rs:2117-2124`），负债壳公司可永久弃置。

---

## 5. S5（Info，正面）沙盒限额与隔离：实测有效（避免误报）

| 项 | 实测结果 |
|---|---|
| `MAX_INTENTS_PER_TICK = 32` | 循环 40 次卖单 → **32 次 0、8 次 -8 ERR_FULL**；`intents` 恰 32；`world.rs:808` 又 `take(32)` 兜底 |
| 5 ms 超时 | `while(true){}` → `error="interrupted"`、`timed_out=true`、`cpu=5.14ms`、**intents=0（整 tick 回滚）** |
| 4 MB 堆 | 大数组分配 → `error="out of memory"`、`oom=true`、intents=0、`cpu=4.46ms` |
| Memory 128 KB | 序列化 178 067 B → 报错丢弃，`memory_json` 保持上一 tick 的 130 008 B |
| console 200 行 × 1 KB | 截断 + `[sandbox] console output truncated` |
| 恶意 FFI 参数 | `deal(-1)`/`deal(1e30)`/`create_order(null,…)` → 仅 JS TypeError，宿主不 panic |
| 私有库存 | 同一 tick 内 `cH` 看到 `power=49`、`cI` 看到 `power=31949`（各自库存） |
| NPC 挂脚本 | `PUT /api/scripts/npc_12` 返回 ok 但 `last_output=null`（`runner.rs:112-122` 只跑 `is_player`） |

---

## 6. S6（Low）资源面

- `put_scripts_handler`（`api.rs:595-643`）无体积/模块数配额；实测上传 **1 900 055 B** `main.js` 成功写库。
- `runner.rs:118` 每 tick 每玩家 `bundle.clone()`：N 账号 × 2 MB/ tick 分配，且位于 rayon 并行区。
- 该大脚本在 VM 内 `out of memory`（`new Function` 编译即撞 4 MB 堆），**不能**用于 CPU 放大（单账号 step 0.013–0.02 s，无明显变化）。
- `queue_manual_intent`（`engine.rs:1731-1741`）无上限、无校验；且**脚本 `enabled=false` 时 REST 意图仍生效**（`runner.rs:167-187` 追加后仍受 core `take(32)` 限制）。

---

## 7. 已测试但**未成立**的假设（避免误报）

| 假设 | 实测/结论 |
|---|---|
| 脚本能造出包装 escrow 买单 | **不成立**：`-14` 被沙盒 i128 校验拦住（REST 才是缺口，见 S1） |
| 脚本能绕过 `MAX_INTENTS_PER_TICK` | **不成立**：32/32 接受、8 次 ERR_FULL，core 二次兜底 |
| 崩溃/超时/OOM 会留下部分 intent | **不成立**：三者都整 tick 回滚，`intents=0` |
| 恶意 FFI 参数能让宿主 panic | **不成立**：只产生 JS TypeError（Underflow/Overflow/类型不符） |
| `Game.bank(..., 1e300)` 可透支（`to_money` 饱和到 `i64::MAX`） | **不成立**：`world.rs:1932-1941` 先查 `bank.reserves < amount`，直接拒 |
| 1.9 MB 脚本可做 CPU 放大 | **不成立**：编译期即 OOM，无 CPU 放大；只剩存储/每 tick clone 成本 |
| 脚本能读其他公司现金/库存 | **不成立**：只暴露公开画像（`netLiquid` 与 REST `/api/companies/{id}` 字段一致）、`groundStore` 为本公司 |
| 玩家能给 NPC 挂脚本夺取 NPC | **不成立**（admin 也只能写库，不会执行） |
| NPC 决策可被 `Math.random()` 预测 | **不成立**：每个 VM 种子不同（同 tick 两公司 `0.0803/0.0876`）；但 NPC 根本不用随机数（见下） |

---

## 8. 需进一步验证（本轮未做，降级）

| 项 | 现状 |
|---|---|
| **NPC 权重可离线复算**（`engine.rs:445` `from_seed(7000+i*97)`、`engine.rs:867` `from_seed(seq*2654435761)`、`engine.rs:849-865` 精英交叉） | 代码层面确认 `decide_npc_intents`（`npc.rs:139-1181`）**无任何随机数**，NPC 行为对同一快照完全确定；「攻击者可借此稳定套利」需写离线模拟器验证命中率 |
| 负 escrow 是否随 world 存档跨重启保留 | 未重启验证（`save_world` 每 40 tick） |
| 多账号 × 大脚本的 tick 延迟曲线 | 属压测，未做 |

---

## 9. 修复建议（按优先级）

**P0**
1. 把校验下沉到权威层：`World::apply_intent` 入口统一做 `price ∈ [1, ref_price×K]`、`checked_mul(qty, price)`，溢出/越界即拒单（当前 `world.rs:1327` 只查 `price > 0`）；
2. 结算/托管全链路 `checked_*`（`world.rs:1364,1477,1485,1559,1981`、`exchange.rs:276-280,304`、`world.rs:1284,2075`）；
3. 不变量：`escrow_cash >= 0 且 == qty*price`、`notional/seller_proceeds >= 0`、`cash ∈ [i64::MIN/4, i64::MAX/4]`。

**P1**
4. NPC 吃单上界（禁止 `> ref_p*K` 的 bid）；
5. `conservation_error` 用 checked 求和 + 非负 escrow 口径，`/api/health` 暴露分项并告警；
6. `to_value(...).unwrap()` 改错误处理 + tick loop `catch_unwind`；
7. CPI 输入去极值；脚本/记忆配额 + `extra_intents` 每 tick 上限。

**P2**
8. NPC 基因组加持久化随机盐；`getAllOrders` 收敛为聚合深度 + 自己订单；PROTOCOL 文档写明「host 前置校验 ≠ 权威校验」。

---

## 10. 复现命令（最小集）

```bash
# 本地实例见文首说明；注册（首个用户是 admin）
curl -c j -X POST 127.0.0.1:18502/api/auth/register -H 'content-type: application/json' \
  -d '{"email":"a@example.com","nickname":"AdminX","password":"Pw-Str0ng-A1"}'
# S1：REST 通道入队包装买单（escrow 截断为 1 Money）
curl -b j -X POST 127.0.0.1:18502/api/intent -H 'content-type: application/json' \
  -d '{"company_id":"cI","intent":{"CreateOrder":{"station_id":"ST:P1","side":"buy",
       "item_id":"power","qty":274177,"price":67280421310721}}}'
curl -b j -X POST 127.0.0.1:18502/api/sim/control -H 'content-type: application/json' -d '{"action":"step"}'
curl -b j "127.0.0.1:18502/api/state?company_id=cI"   # 看 cash 与 open_orders.escrow_cash
# S2：同一脚本两公司对敲（seller 2^62 卖 3 单位；buyer 每 tick deal 最贵卖单）
#     单笔 +461168601842738.79 credits，第二笔现金回绕为 -9223372035855156319
# S3：观察 GET /api/state 的 cpi 与 quotes["ST:P1"]["power"]["ema_slow"]
# S4：conservation_error 离开 i64 后 POST /api/sim/control step -> http=000 + panic 日志
```

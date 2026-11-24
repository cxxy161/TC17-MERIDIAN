# 安全修复记录（2026-11-24）

本次修复覆盖：两个 Critical 经济铸币漏洞及其根因 + P0/P1 网安项。所有改动附回归测试，`cargo test -p meridian-core -p meridian-server` 全绿（core 14 / server lib 10 / server 集成 8）。

## 1. 修复清单

### 1.1 经济（meridian-core）

| ID | 修复 | 位置 |
|---|---|---|
| CS-01 | `match_all` 全链路 checked 运算；强制 `0 ≤ escrowed_for_take ≤ bid.escrow_cash`、`0 ≤ buyer_refund ≤ escrowed_for_take`、`escrow_cash ≥ 0`；违规订单被移除（escrow 归零并记审计日志），**任何情况下退款不得超过实际托管** | `exchange.rs` `match_all`/`evict_top` |
| CS-02 | `DealOrder` 的 `notional` 改 checked，拒绝非正/溢出；买单方向的 resting bid 必须 `escrow_cash ≥ notional`；现金变动走 checked/saturating | `world.rs` `Intent::DealOrder` |
| CS-03 | `CreateOrder` 强制 `qty ≤ 10_000`、`price ∈ [1, ref×100]`（买卖单都校验）、`qty×price` checked；托管走 `debit_cash` | `world.rs` `Intent::CreateOrder` |
| MK-01 部分 | `DealOrder` 现在**不能跳过更优价的对手单**（双向检查），堵住深档自成交/EMA 投毒 | `world.rs` `Intent::DealOrder` |
| 城市 | `place_planet_demands` 的 `needed_escrow`/`spent_escrow` checked；出价夹到价格带；treasury 走 checked 扣减 | `world.rs` |
| 现金 | 新增 `credit_cash`（checked_add，饱和 + 日志）与 `debit_cash`（拒绝负余额）；结算/退款/工资/手续费/银行储备等路径改用它们 | `world.rs` |
| **银行（顺带，超出原始分工）** | 新增信用额度（按净资产/资产估算）、贷款到期 `debt_due_tick`、逾期 25% 销售款自动扣划还债、最低准备金率 25% | `world.rs` `company_credit_limit`/`credit_seller_revenue`/`BankOp`、`company.rs`、`types.rs` |

价格带实现：`types.rs::price_band_max(ref)` = `max(ref,1 credit) × 100`，再夹到 1,000,000 credits 与 `i64::MAX / MAX_ORDER_QTY`。**注意 `ref` 已是 Money，不能再乘 MONEY_SCALE**（初版曾多乘一次导致 100 万倍，已修正并有单测）。

### 1.2 网安（meridian-server）

| 项 | 修复 |
|---|---|
| XFF 信任 | `client_ip(headers, peer)`：仅当直连 peer 命中 `MERIDIAN_TRUSTED_PROXIES` 才采信 XFF 且取**最右**一跳；否则用 peer IP；删除 `"local"` 折叠。`main.rs` 用 `into_make_service_with_connect_info::<SocketAddr>()`；`ClientAddr` 提取器兼容测试 |
| 限流 | per-IP 表硬上限 4096（空闲清理 + LRU 淘汰）；新增按账号登录失败计数（5 次锁 5 分钟，成功清零） |
| argon2 DoS | `HASH_GATE.acquire` 2s 超时 → 503；注册/登录全局在途上限 64 → 429 |
| 中间件 | 2 MiB body limit；并发 256；15s 超时；安全响应头（nosniff / DENY / Referrer-Policy / CSP 含 `'unsafe-eval'`）；HSTS 仅 XFP=https；认证响应 `no-store` |
| CORS | 移除 `CorsLayer::permissive()`，改读 `MERIDIAN_ALLOWED_ORIGINS`；为空不启用；拒绝 `*`；白名单才带 credentials |
| CSRF | 非 GET：Origin 不在白名单且不同源，或 `Sec-Fetch-Site: cross-site` → 403；同源放行 |
| 错误/404 | 31 处 500 改通用文案 + tracing；未知 `/api/*` 返回 JSON 404（非 /api 仍回 SPA） |
| 队列 | `queue_manual_intent` 每公司上限 256，超出 API 429 |
| 部署 | 新增 `deploy/Caddyfile`（TLS/安全头/覆盖写 XFF/XFP）；compose 绑 127.0.0.1、非 root、read_only、cap_drop、mem_limit、healthcheck；`.env.example` 去掉弱默认管理员口令，新增两个变量；`docs/AUTH.md` 同步 |

## 2. 验证结果

单元/集成测试：
```text
meridian-core:  14 passed（含 5 个新增：截断价格、负 notional、refund≤escrow、随机 fuzz、checked 工具）
meridian-server lib: 10 passed（含 8 个新增：XFF 信任矩阵/CIDR/LRU/账号锁定）
meridian-server tests: 8 passed（含 3 个新增：安全头/CSRF/404/413、XFF 伪造仍锁定、intent 队列上限）
```

真实进程冒烟（新二进制 + 临时 DB）：
```text
GET /                    → CSP/XCTO/XFO/Referrer-Policy 齐全
GET /api/nope            → 404 application/json
POST 跨站 Origin         → 403；同源 Origin → 401（进业务）
2.2MB body               → 413
XFF 轮换（未配置可信代） → 401×4 后 429（XFF 被忽略，账号锁定生效）
WS 无 Cookie → 401；有 Cookie → 101
CS-01：qty=3 price=(2^64+2)/3 买单 → 被拒，现金不变
CS-02：price=2^62 卖单          → 被拒（价格带），现金不变
/api/health conservation_error  → 0
```

## 3. 部署动作（必须）

1. 重新构建/发布后端二进制或镜像。
2. `.env`：
   - `MERIDIAN_ADDR=127.0.0.1:18420`
   - `MERIDIAN_TRUSTED_PROXIES=127.0.0.1/32,::1/128`（Caddy 与后端同机时；**漏配会让全体用户共享反代 IP，10 次/分钟锁死登录**）
   - `MERIDIAN_ALLOWED_ORIGINS` 留空（同源部署）或填完整 Origin
   - `MERIDIAN_COOKIE_SECURE=1`（TLS 终结后）
3. 用 `deploy/Caddyfile` 在 80/443 终结 TLS，确认 Caddy **覆盖写** XFF/XFP，后端 18420 不再对公网暴露。
4. compose 加固版需宿主 `mkdir -p data && chown -R 10001:10001 data`（Dockerfile 未在本轮写域内，未加 USER）。

## 4. 行为变化

- 单笔挂单 `qty ≤ 10_000`；价格必须在参考价的 `[1, 100×]` 带内（超出直接拒单）。
- `DealOrder` 变成"按价格优先"的市价单语义，不能点名吃更差价的深档（这是有意的反作弊变更）。
- 未知 `/api/*` 由 200 SPA 变为 404 JSON。
- 触发限流/锁定/HASH_GATE 时分别返回 429/429/503；超大 body 413；请求超时 408。

## 5. 未在本轮修复 / 仍存在

- **TLS 本身**依赖部署（Caddy），应用仍是 HTTP。
- **NET-04**：公开注册、首个注册者自动 admin、Turnstile 构建期 site key 缺失仍未改（建议先占管理员或关闭注册后再公开）。
- CSP 仍保留 `'unsafe-eval'`（ConsolePanel 的 `new Function`）。
- 地块/城市定价（BL-04/05、MK-02/03）未修；银行 BL-01~03 已在核心修复中顺带加固（信用额度/到期/逾期 25% 扣划/最低准备金），属于**超出原始分工的行为变更**，如不需要可单独回退（集中在 `company.rs` + `world.rs` 银行段 + `types.rs` 三个常量）。
- 旧存档中已损坏的订单：匹配时会被摘除并烧掉残余 escrow（一次性负守恒偏差，但不再可能造钱）。建议直接删档重置。

# Meridian 后端应用安全审计报告（认证 / 会话 / 传输 / 存储）

- 审计对象：`/home/cxxy168/code/html/Meridian`（Rust/axum 后端 + React SPA 太空贸易游戏）
- 线上实例：<http://100.84.136.78:18420/>（用户自有，本次审计已获授权）
- 审计范围：后端认证、会话、限流、CSRF、SQL、静态托管、错误处理、管理员鉴权、依赖、部署面
- 审计方式：静态阅读（read/grep/glob）+ 受控线上只读探测（curl GET、失败登录探测，共约 80 个请求；**未创建账号、未触发任何写操作、未做压测/爆破/遍历**）
- 审计时间：2026-11-24（Asia/Tokyo）
- 结论产出：本文件。**未修改任何源码/配置**（唯一写入即本报告）
- 关联文档：`docs/AUTH.md`、`docs/MULTIPLAYER_AUDIT.md`（既有内部审计，本报告在其基础上做"实现 vs 声明"核对）

---

## 一、摘要（按严重度）

| # | 标题 | 严重度 | 状态 | 位置 |
|---|---|---|---|---|
| 1 | `X-Forwarded-For` 完全信任：限流可绕过，且所有无 XFF 用户共享 `local` 桶 → 10 次请求锁死全员登录 | **High** | 已确认（线上实证） | `auth.rs:287-295`、`api.rs:872,954` |
| 2 | argon2 全局串行闸门 + 无并发/超时限制 → 未认证 CPU 与连接队列 DoS | **High** | 已确认（线上实测 110ms/次串行） | `auth.rs:25`、`api.rs:816-839` |
| 3 | 首个注册者自动成为 `admin`（未 seed 则任何人可接管） | **High**（条件性 Critical） | 代码已确认；线上状态**需在线验证** | `api.rs:896-901`、`engine.rs:452-483` |
| 4 | 全站无 TLS、Cookie 无 `Secure`、无 HSTS：会话与口令明文传输 | **High**（条件性，Tailscale 可缓解） | 已确认（线上 HTTP/1.1 明文） | `main.rs:46`、`auth.rs:130-153`、`Dockerfile`、`deploy/` |
| 5 | 改密接口无任何限流/失败计数 → 会话被窃后可无限爆破当前口令 | **Medium** | 已确认（代码） | `api.rs:1108-1153` |
| 6 | 每个已认证请求都写一次 `sessions.last_seen_at`（写放大）；会话无定期清理 | **Medium** | 已确认（代码） | `auth.rs:336`、`storage.rs:989-997,1055-1059` |
| 7 | XFF 直接作为无界 HashMap key（4KB 头被接受、无截断、无淘汰）→ 无界内存增长 | **Medium** | 已确认（代码 + 线上 4KB 头被接受） | `auth.rs:194-246,287-295` |
| 8 | 生产环境 Turnstile 几乎必然失效（前端未注入 site key）→ 注册零人工验证、零邮箱验证 | **Medium** | 强推断（构建链证据 + 线上行为） | `Dockerfile:2-7`、`AuthScreen.tsx:25,99-102`、`auth.rs:252-256` |
| 9 | 玩家脚本无大小/配额上限（仅靠 axum 2MB/请求），无每用户存储配额 | **Medium** | 已确认（代码 + 线上 413 边界） | `api.rs:464-512,519-552`、`Cargo.toml` |
| 10 | 容器以 root 运行、无 HEALTHCHECK、compose 无资源限制/只读根/降权 | **Medium** | 已确认（`Dockerfile` 无 `USER`） | `Dockerfile`、`deploy/docker-compose.yml` |
| 11 | 无安全响应头（CSP/nosniff/frame-options/HSTS）、认证响应无 `Cache-Control: no-store`、CORS `*` | **Medium** | 已确认（线上响应头实测） | `api.rs:56`、`auth.rs:143-160` |
| 12 | 500 错误体直接回显 rusqlite 错误串（约束名/表列名/SQL 片段） | Low | 已确认（代码路径） | `api.rs:322,326,496,548,905-996` 等 |
| 13 | 邮箱/昵称枚举（注册 409 明确区分 `email`/`nickname` 字段） | Low | 已确认（代码 + 自带测试） | `api.rs:888-893` |
| 14 | SPA fallback 吞掉所有未知路径 → `/api/*`、`/.env`、`/.git/config` 一律 200 `index.html` | Low | 已确认（线上实证） | `api.rs:58-64` |
| 15 | Cookie 无 `__Host-` 前缀；同主机其它端口/子域可投毒（cookie tossing） | Low | 代码确认 | `auth.rs:143-153` |
| 16 | WebSocket 不校验 `Origin`、无连接数/消息大小限制、广播每客户端 O(N) 克隆 | Low | 代码确认（Origin 未校验已核实） | `api.rs:667-722` |
| 17 | 登录不轮换/不吊销旧会话（会话固定面很小，无子域场景） | Low | 代码确认 | `api.rs:985-999` |
| 18 | `/admin` 页面级鉴权缺失（数据接口已 admin-only） | Low | 已确认（线上 200） | `api.rs:78-80`、`docs/AUTH.md:71` |
| 19 | DB/WAL 明文落盘、文件权限默认；本地用户可读口令哈希与会话哈希 | Low | 理论（需本机访问） | `storage.rs:113-204`、`deploy/docker-compose.yml:9-10` |
| 20 | `/api/health`、`/api/market/*`、`/api/catalog` 匿名可读（含 tick/conservation_error/companies_count） | Info | 已确认 | `api.rs:34-40,90-101` |
| 21 | `seed_admin_from_env` 在邮箱已被占用时静默跳过，可能造成"永无管理员" | Info | 代码确认 | `engine.rs:462-464` |
| 22 | 依赖 CVE 未核（离线无 RustSec 库）；版本清单见附录 A | Info | 未验证 | `backend/Cargo.lock` |

**正面结论（已核实通过）**：令牌熵与存储方式、argon2id 参数、口令比对常数时间、SQL 全参数化、CSRF 基线（Lax + JSON 强制）、管理员接口逐条鉴权、改密踢其它会话、越权校验（`ensure_owner`）、请求体 2MB 上限、WS 鉴权。详见第五节。

**最需要立刻处理的 4 件事**：①在反代层固定写 `X-Forwarded-For` 并把 `client_ip` 改为取最右一跳（或改用 `ConnectInfo` 真实 peer IP）——一条修复同时解掉 #1 的绕过与全员锁死；②确认 `MERIDIAN_ADMIN_EMAIL`/`MERIDIAN_ADMIN_PASSWORD` 已设置且管理员已存在（否则 #3 就是开服即失守）；③上 TLS 反代并强制 `MERIDIAN_COOKIE_SECURE=1`；④给 `HASH_GATE` 加等待超时 + 全局在途请求上限。

---

## 二、把关键结论分成「已核实」与「推测/需在线验证」

| 类别 | 条目 |
|---|---|
| **已核实（代码 + 线上实证）** | #1（绕过与共享桶均按 `curl` 实测复现）、#2（10 并发 = 1107ms，严格串行）、#4（明文 HTTP、无代理头、无 HSTS）、#5、#6、#7（4KB XFF 返回 401 而非 431，说明被接受）、#9（3MB 体返回 413，确认上限即 2MB）、#10、#11、#12、#13、#14、#18、#20 |
| **强推断（构建链/配置证据）** | #8：`Dockerfile` 前端阶段无 `ARG VITE_TURNSTILE_SITE_KEY`，`npm run build` 时该变量为空 → `AuthScreen.tsx:99` 走"未配置"分支、不发 token；若服务端设了 `MERIDIAN_TURNSTILE_SECRET`，则**所有注册都会 403**。故生产实例要么 Turnstile 关闭（无机器人防护），要么注册完全不可用。 |
| **需在线验证（需 owner 配合或凭据）** | #3：线上 `users` 表是否为空 / 管理员是否已存在（匿名无法枚举，见 `docs/AUTH.md` 无对应接口）；#17 会话固定实际可行性；#19 容器内文件权限。 |
| **理论/低概率** | 静态目录内符号链接被 `ServeDir` 跟随（当前 `dist` 无符号链接，已 `find` 核实）；`X-Forwarded-Proto` 在"反代追加而非覆盖"时被客户端降级（当前无 TLS 部署，尚未成立）；#7 的内存增长速率受 argon2 串行限速（≈9 请求/秒，4KB/条约 36KB/s），属"慢速无界"，真正快的是 #2 的连接队列。 |

---

## 三、逐项发现

### [High-1] `X-Forwarded-For` 完全信任 → 限流可绕过 + 全员共享 `local` 桶导致登出锁死

**位置**：`backend/crates/meridian-server/src/auth.rs:287-295`（`client_ip`）、`auth.rs:206-246`（`AuthLimiter`）、`api.rs:872`（注册）、`api.rs:954`（登录）

**证据代码**

```rust
// auth.rs:287-295
pub fn client_ip(headers: &axum::http::HeaderMap) -> String {
    headers.get("x-forwarded-for")
        .and_then(|v| v.to_str().ok())
        .and_then(|v| v.split(',').next())     // 取最左一跳 = 客户端可任意伪造
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| "local".to_string()) // 无 XFF 时所有人共用 "local" 桶
}
```

**线上实证（已复现）**

```text
# A) 不带头，12 次错误登录 → 第 11 次起被限流（10 次/分的桶）
401 401 401 401 401 401 401 401 401 401 429 429

# B) 每次轮换一个伪造 XFF，12 次错误登录 → 全部放行，零限流
401 401 401 401 401 401 401 401 401 401 401 401
```

线上响应头无任何代理特征（无 `Server:`/`Via:`/`X-Real-IP`），`deploy/` 只有 `docker-compose.yml`，无 Caddy/nginx 配置 → **应用直接暴露在 18420，无人覆写 XFF**。

**影响（双向，都很实用）**

1. **绕过**：攻击者伪造 XFF 即可无限次尝试口令（仅受 argon2 串行 ~9 次/秒限制，约 75 万次/天），对弱口令/撞库几乎无阻力。注册的"每 IP 3 次/小时"同样失效（全站注册桶仍有效，见 #8）。
2. **反向锁死**：普通浏览器**不会**发送 XFF，因此所有真实用户都落在同一个 `"local"` 桶里。任何人（含正常用户手滑）连续 10 次登录请求 → **全站所有用户 1 分钟内无法登录**。攻击者只需 **10 请求/分钟** 就能永久让登录功能不可用。这是"限流反被用作 DoS 放大器"。

**修复建议**

- 部署层：反代（Caddy/nginx）用 `X-Forwarded-For` **覆盖写**（`proxy_set_header X-Forwarded-For $remote_addr;`），且只监听 127.0.0.1 让后端不可直连。
- 代码层：改用 axum `ConnectInfo<SocketAddr>` 取真实 peer IP 作为主键；XFF 只在校验"直连方是可信反代 IP 段"时采信，并取**最右**一跳。
- 分离桶：把"全站级"与"每 IP 级"明确拆分，无 XFF 时不要把所有匿名请求折叠成同一个 key。
- 登录增加"按账号"维度（对同一账号失败计数 + 指数退避/锁定），避免只按 IP 限流。

---

### [High-2] argon2 全局串行闸门 + 无并发/超时限制 → 未认证 CPU 与队列 DoS

**位置**：`auth.rs:24-25`（`HASH_GATE = Semaphore::const_new(1)`）、`api.rs:816-839`（`hash_blocking`/`verify_blocking`）、`api.rs:968`（用户不存在也跑一次哈希）

**证据（线上实测）**

10 个并发登录请求（均为不存在的邮箱）总耗时 **1107ms**，即每次 argon2 约 110ms 且**完全串行**（若并行应为 ~110ms 总数）。2C 机器上这就等于一个核被吃满，且所有后续请求排队。

```text
$ 10 × curl POST /api/auth/login & wait  → wall_ms=1107
```

**影响**

- 攻击者只需发出 HTTP 请求（无需账号），即可让 `HASH_GATE` 队列无限增长：每个排队请求占一个 tokio 任务 + 一条连接；`acquire()` 无超时、无全局在途上限、无 `TimeoutLayer`。10k~50k 并发即可耗掉数百 MB（容器无内存上限，见 #10），并让合法登录/注册/改密全部排队到不可用。
- 与 High-1 叠加：不存在每 IP 限流时，攻击成本仅为"发出请求"。
- 注意这是**用安全机制（串行化防 CPU 打爆）换来的可用性风险**：本意是好的，缺的是"排队边界"。

**修复建议**

- `HASH_GATE.acquire` 加短超时（如 2s），超时直接 429/503，不排队。
- 全局在途登录/注册请求计数上限（如 32），超出即拒绝。
- 加 `tower_http::timeout::TimeoutLayer`（如 10s）与 `tower::limit::ConcurrencyLimitLayer`。
- 给容器加 `mem_limit`/`cpus`（见 #10），把 DoS 限制为"降级"而不是"打挂"。

---

### [High-3] 首个注册者自动成为 `admin`（若未 seed 管理员，任何人可接管）

**位置**：`api.rs:895-905`

```rust
// 首个注册者成为管理员（开服引导）
let role = if eng.store.count_users() == 0 { "admin" } else { "player" };
```

**配套事实**：`engine.rs:452-483` `seed_admin_from_env()` 只有在同时设置 `MERIDIAN_ADMIN_EMAIL` 与 `MERIDIAN_ADMIN_PASSWORD`（≥8）时才建管理员；`deploy/.env.example:3-4` 只是示例值，仓库内**没有**真实 `.env`（`git ls-files` 仅有 `.env.example`）。测试 `tests/server_tests.rs:486-489` 明确断言"首个注册者 `role=admin` 且接管 `player1`" —— 这是**刻意设计**，不是 bug。

**影响**：若线上部署时未设置这两个环境变量（或 DB 曾被清空/重建），则**第一个访问该实例的人**注册即获得：
`POST /api/sim/control`（pause/resume/**speed/reset 世界**）、`POST /api/companies`（建币上限 10 万的玩家公司）、`GET /api/admin/overview`（全部公司现金/库存/订单/基因）。等于完全接管游戏。

**线上状态（需验证）**：`/api/health` 显示 `tick=328, tick_ms=1000`，即世界运行约 5.5 分钟 —— 与"刚部署/刚重置"高度吻合，因此**当前窗口期风险是真实的**。匿名侧无法枚举用户是否已存在（登录对不存在用户与错误口令返回同一 401 且做了等时哈希 `api.rs:966-970`），故无法从外部判定。

**验证方法（owner 执行，任一即可）**
1. 服务端 env：`docker exec meridian env | grep MERIDIAN_ADMIN`（应非空）；启动日志应有 `已创建初始管理员账号 …`（`main.rs:59`）。
2. 数据库：`sqlite3 /app/data/meridian.db "select id,email,role from users;"`（应至少 1 行 `role=admin`）。
3. 已有管理员账号手动登录一次确认 `/api/auth/me` 返回 `role: admin`。

**修复建议**：生产**禁止**无 seed 启动 —— 未设置 `MERIDIAN_ADMIN_EMAIL` 时把首个注册者降级为 `player`（或直接拒绝注册），并在启动日志显式 WARN"未配置初始管理员"。另可加"一次性 bootstrap token/邀请码"。

---

### [High-4] 全站无 TLS、Cookie 无 `Secure`：会话令牌与口令明文

**位置**：`main.rs:46`（默认 `0.0.0.0:18420`，纯 TCP）、`auth.rs:130-141`（`cookie_secure`）、`auth.rs:143-160`（`session_cookie`/`clear_cookie`）、`Dockerfile:29-36`、`deploy/docker-compose.yml:7-8`

**证据**
- 线上：`HTTP/1.1 200 OK`，无 TLS 跳转、无 `Strict-Transport-Security`；响应头无任何反代特征。
- 代码：`cookie_secure()` 仅在 `X-Forwarded-Proto: https` 或 `MERIDIAN_COOKIE_SECURE=1` 时加 `Secure`。线上无代理 → **恒为 false** → `Set-Cookie: meridian_sid=…; Path=/; HttpOnly; SameSite=Lax`（无 Secure）。
- `deploy/` 与 `Dockerfile` 内**没有任何 TLS 终止配置**（无 Caddy/nginx/cert）。

**影响**：`meridian_sid` 与登录口令在链路上明文（HTTP 头/体）。任何能嗅探该路径的一方（同交换机/同 VLAN/宿主机上的其它进程/错误的端口转发）可**直接重放会话**，无需破解。附加细节：`X-Forwarded-Proto` 由请求头决定，一旦将来上反代但反代是"追加"而非"覆盖"，客户端发 `X-Forwarded-Proto: http` 可让服务端**降级去掉 Secure**（`auth.rs:136-140` 用整值比较，`"http, https"` 不等于 `https` → false）。

**缓解情况**：目标地址 `100.84.136.78` 属 `100.64.0.0/10`（CGNAT，Tailscale 常用段），若确实只经 Tailscale/WireGuard 访问，则链路加密由 overlay 提供 —— 因此定级 High 但**条件性**。风险边界是：该端口一旦被端口转发/Funnel/同网段非 Tailscale 主机访问，即成立。

**修复建议**：前置 Caddy/nginx 做 TLS 终止并把后端绑 `127.0.0.1`；设置 `MERIDIAN_COOKIE_SECURE=1`（显式优于探测）；加 HSTS；cookie 改名 `__Host-meridian_sid`（隐含 Secure+Path=/+无 Domain）。

---

### [Medium-5] 改密接口无任何限流/失败计数

**位置**：`api.rs:1108-1153`（`change_password_handler`）—— 对比登录 `api.rs:957` 有 `check_login`，此处**没有**任何 `AuthLimiter` 调用，也没有失败计数。

**影响**：拿到会话（XSS/共享设备/明文嗅探）的攻击者可对 `current_password` 无限爆破：每次 110ms 串行 → 约 9 次/秒、31 万次/天，随后即可用新口令把受害者踢下线并永久接管（`api.rs:1151` 会删掉其它会话，受害者反而被锁出）。同理 `PATCH /api/account` 也无频率限制（仅 30 天昵称冷却）。

**修复建议**：改密失败计数（按 `user_id`）+ 指数退避 + 上限锁定，并记审计日志；改密成功后邮件/通知（当前无）。

### [Medium-6] 每请求都写 `sessions.last_seen_at`（写放大）与过期会话清理不足

**位置**：`auth.rs:336`（`touch_session` 在 `AuthUser` 提取器里，**每个已认证请求**都执行）、`storage.rs:989-997`（`UPDATE sessions SET last_seen_at`）、`storage.rs:1055-1059`（`purge_expired_sessions` 只在`login` 成功时调用，`api.rs:998`）

**影响**：单用户轮询 `/api/state`（前端常态刷新）即产生等量 SQLite 写事务；WAL 持续增长、`synchronous=NORMAL` 下周期性 fsync，且这些写发生在**全局 `GameEngine` Mutex 内**（`api.rs:325`/`326`），与 tick 循环抢占同一把锁 → 已认证用户即可放大磁盘 I/O 并拖慢 tick。`sessions` 表也只在"有人登录成功"时才清理过期行，长期不登录时只增不减（虽被唯一索引限制为每会话一行）。

**修复建议**：`last_seen_at` 改成"距上次更新 > 60s 才写"或写入内存并在 tick 里批量刷；加 `tokio` 定时任务每小时 `purge_expired_sessions`；`AuthUser` 提取器避免在锁内做写操作（先读后放锁，再异步更新）。

### [Medium-7] XFF 直接作无界 HashMap key（无截断/无淘汰）

**位置**：`auth.rs:194-197`（`per_ip: Mutex<HashMap<String, Bucket>>`）、`auth.rs:218-228,234-244`（`entry(format!("reg:{ip}"))` / `format!("login:{ip}")`，只插入从不删除）、`auth.rs:287-295`（不截断长度）

**证据**：线上发送 4000 字节随机 `X-Forwarded-For` 得到 `401`（而非 `431`），说明头部被接受并成为 key；读代码确认没有任何 `retain`/`remove`/`clear`。

**影响**：每个唯一 XFF 永久占一条 `String` + `Bucket`（约 4KB + 开销）。增长速率受 argon2 串行限制（≈9/s → 36KB/s），属"慢速无界泄漏"；若将来把限流前置到哈希之前（推荐优化），则立即变成高速内存耗尽。与 #2 的并发队列叠加时更危险。

**修复建议**：key 先做严格解析（只接受合法 IP/最多 45 字节，非法一律归入 `unknown`），加容量上限 + LRU/定期清理（如每 5 分钟清空空闲桶），或换 `governor`/`tower_governor` 这类有界的限流实现。

### [Medium-8] 生产 Turnstile 几乎必然失效；注册零人工验证、零邮箱验证

**位置**：`auth.rs:252-256`（未配置 secret 直接 `Ok(())` 放行）、`Dockerfile:2-7`（前端构建阶段无 `ARG VITE_TURNSTILE_SITE_KEY`）、`frontend/src/auth/AuthScreen.tsx:25-26,62,99-102`（key 为空则不渲染 widget、不发 token）

**推理链（强推断）**：`npm run build` 时 `VITE_TURNSTILE_SITE_KEY` 为空 → 前端不产生 token。若服务端配置了 `MERIDIAN_TURNSTILE_SECRET`，`verify_turnstile` 会因 `token.trim().is_empty()` 返回 `Err("缺少人机验证令牌")` → **所有注册 403**。因此能正常注册的生产实例，必然是**未启用 Turnstile**。

**影响**：注册唯一门槛是可绕过的 IP 限流（#1）+ 全站桶（容量 5、2 次/分，`auth.rs:199-200`）。即持续可按 ~2 个账号/分钟无限开号（约 2880/天）；每个账号会自动 `provision_player_company`（`api.rs:915`）→ 世界公司数线性增长，而每 tick 快照是 O(N²)（既有审计 `docs/MULTIPLAYER_AUDIT.md:70-72` 已记录）。同时全站桶被恶意耗尽时，**所有真实用户 150 秒内无法注册**。

**修复建议**：若确需开放注册，则真正启用 Turnstile（Dockerfile 加 `ARG/ENV VITE_TURNSTILE_SITE_KEY` + 构建参数）或加邀请码；否则至少加邮箱验证 + 每账号创建速率/总量上限；并给世界公司数设硬上限。

### [Medium-9] 玩家脚本无大小/配额上限

**位置**：`api.rs:464-512`（`put_scripts_handler` 只校验必须含 `main`，无长度校验 —— 对比 `api.rs:519-535` 的 memory 有 128KB 显式上限）、`api.rs:479-485`（模块名归一化但不限个数）、`storage.rs:256-277`（整包 DELETE+INSERT 落盘）

**证据**：3MB 请求体返回 `413`，说明实际边界是 axum 默认 2MB（`DefaultBodyLimit`），不是业务校验；`meridian-sandbox` 只限制了 `max_memory_json_bytes = 128KB`（`types.rs:80`），**没有**脚本字节上限。

**影响**：单个账号可稳定存 ~2MB 脚本（且每次 PUT 重写整包）；结合 #8 的无限开号 → 磁盘可被耗尽（2880 账号/天 × 2MB ≈ 5.7GB/天），且这些脚本每次启动都会被加载执行（冷启动变慢）。属"低成本慢速存储 DoS"，非严重但缺配额。

**修复建议**：服务端强制脚本总字节上限（如 128KB/账号、单模块 64KB、模块数 ≤ 32），并与 `PlayerRunConfig` 里的沙箱限制共用同一常量；给每公司存储配额与总量告警。

### [Medium-10] 容器以 root 运行、无 HEALTHCHECK、compose 无资源/权限收紧

**位置**：`Dockerfile:19-36`（runtime 阶段无 `USER` 指令，`CMD` 直接以 root 跑）、`deploy/docker-compose.yml:1-11`

**证据**：`Dockerfile` 全文无 `USER`；compose 无 `read_only`、`cap_drop`、`security_opt`、`mem_limit`/`cpus`、`healthcheck`。

**影响**：任一 RCE（最高价值面是 `rquickjs` 里跑玩家写的不受信 JS —— 由沙箱专项审计覆盖）默认就是容器内 root，可写 `/app/data`、可读整个文件系统；无内存上限使 #2/#7 的 DoS 直接打死容器；无 healthcheck 使"卡死但仍 200"难以被编排发现。

**修复建议**：`USER 10001` + 只给 `/app/data` 读写；compose 加 `read_only: true` + `tmpfs: /tmp` + `cap_drop: [ALL]` + `security_opt: [no-new-privileges:true]` + `mem_limit`/`cpus` + healthcheck 打 `/api/health`。

### [Medium-11] 安全响应头缺失 + 认证响应可缓存 + CORS 全开

**位置**：`api.rs:56`（`CorsLayer::permissive()`）、全局无任何 `SetResponseHeaderLayer`

**证据（线上响应头）**：```text
access-control-allow-origin: *
access-control-expose-headers: *
access-control-allow-methods: *
access-control-allow-headers: *
（无 X-Content-Type-Options / CSP / X-Frame-Options / Referrer-Policy / HSTS / Cache-Control）
```
预检 `OPTIONS` 返回 `200` 且 `allow-methods: *` / `allow-headers: *`。

**影响与边界**：
- 无 `Access-Control-Allow-Credentials`（`permissive()` 不设），所以跨站 JS **无法**带 Cookie 读已认证接口 —— CSRF/跨站读数据当前不成立（这是它没被定高的原因）。
- 但任意站点可读全部匿名接口（`/api/health`、`/api/market/*`、`/api/catalog`），且 `allow-headers: *` 会让将来任何"把凭据放 header/body"的接口立刻变成跨站可利用；`expose-headers: *` 进一步放松。
- 无 CSP 时，一旦前端出现 XSS（玩家昵称/公司名是跨用户渲染内容，服务端仅校验长度 2–16，`api.rs:860-863`，不限制字符集），可被放大为"任意请求 + 读 `/api/account`"。
- 无 `X-Content-Type-Options: nosniff` 让 `/api/*` 的错误/JSON 响应存在 MIME 嗅探面；`SameSite=Lax` + 无 `frame-ancestors`/`X-Frame-Options` → `/admin` 可被点击劫持（接口仍 admin-only，故 Low）。

**修复建议**：用 `tower_http::set_header` 加 `Content-Security-Policy`（至少 `default-src 'self'`、`frame-ancestors 'none'`）、`X-Content-Type-Options: nosniff`、`Referrer-Policy: no-referrer`、`X-Frame-Options: DENY`；认证类响应加 `Cache-Control: no-store`；CORS 从 `permissive()` 改为白名单 origin（或干脆只给同源 SPA 用，去掉 CORS 层）。

### [Low-12] 500 错误体回显 rusqlite 错误

**位置**：`api.rs:322,326`（`query_candles`/`query_recent_trades` 的 `map_err(|e| (500, e))`）、`api.rs:496,548,905,914,922,996,1149` 等；错误类型是 `(StatusCode, String)` → 直接进响应体（`api.rs:779` 的 `ErrBody` 只在 `ApiError` 路径用）

**影响**：`storage.rs` 全部 `.map_err(|e| e.to_string())`，rusqlite 的 Display 通常形如 `UNIQUE constraint failed: users.email` 或含 SQL 片段。会让攻击者拿到表/列/约束名（辅助后续攻击面推断）。当前多为需触发 DB 错误的边角路径，故 Low。

**修复**：统一错误包装：对外固定文案 + 内部 `tracing::error!` 记录（注意别把口令/令牌打进日志，目前日志是干净的）。

### [Low-13] 邮箱/昵称枚举

**位置**：`api.rs:888-893`（`email_taken` → 409 + `field:"email"`；`nickname_taken` → 409 + `field:"nickname"`）；登录路径已做等时哈希（`api.rs:966-970`，正面）。

**影响**：可批量判定某邮箱是否注册（对游戏站影响有限，但结合 #5 的无限爆破可先枚举再定向）。**修复**：注册统一返回 409 泛化文案，或改为"已发送验证邮件"流程。

### [Low-14] SPA fallback 吞掉所有 404（含 /api/*、.env、.git）

**位置**：`api.rs:58-64`

**线上实证**：`/../../etc/passwd`、`/%2e%2e%2f…`、`/.git/config`、`/.env`、`/data/meridian.db`、`/api/doesnotexist` 全部 `200 text/html 536`（返回 `index.html`）。

**判定**：**不是路径穿越** —— `tower-http` 的 `ServeDir` 拒绝 `..` 组件，随后被 outer fallback 兜到 `index.html`。属"错误语义混淆 + 掩盖 404"：客户端无法区分"API 不存在"和"页面"，监控/探测也会误判。**修复**：给 `/api` 前缀单独 404 JSON，SPA fallback 只对非 `/api` 且有 `Accept: text/html` 的请求生效。

### [Low-15] Cookie 无 `__Host-` 前缀

**位置**：`auth.rs:22`（`COOKIE_NAME = "meridian_sid"`）、`auth.rs:143-160`

**影响**：同主机其它端口/子域可写同名 Domain Cookie → cookie tossing（把攻击者令牌塞进受害者浏览器，形成"会话固定"的弱变体）；`read_cookie` 取第一个匹配项（`auth.rs:109-123`），顺序由浏览器决定。**修复**：改 `__Host-meridian_sid`（强制 Secure+Path=/+无 Domain）+ 支持多值冲突时以最后一个/最严格的为准。

### [Low-16] WebSocket：不校验 Origin、无连接/消息上限、广播 O(N) 克隆

**位置**：`api.rs:667-674`（`ws_handler`，仅 `AuthUser`，无 `Origin` 校验）、`api.rs:691-721`（循环里 `Some(Ok(_)) => {}` 丢弃入站消息但允许大帧）、`api.rs:696-698`（`ev.player_outputs.retain(...)` 发生在**克隆之后**）

**影响**：跨站 WS 劫持（CSWSH）目前被 `SameSite=Lax` 挡住（WS 握手属子资源请求，不随跨站请求发送 Lax Cookie）——但这是"恰好安全"，一旦 cookie 改 `SameSite=None` 或加子域即失守。同一账号可开任意多连接，每连接每 tick 克隆并序列化全部 `player_outputs`（O(连接数×玩家数)）。axum `WebSocketUpgrade` 默认 `max_message_size` 64MB，服务端只丢不处理，仍会分配内存。

**修复**：校验 `Origin` 属于本站；`ws.max_message_size(64*1024)`；每账号连接数上限（如 4）；先按 cid 过滤再序列化（把 retain 提到 clone 之前）。

### [Low-17] 登录不轮换旧会话

**位置**：`api.rs:985-999`

每次登录新建会话，旧会话仍有效（设计上像"多设备共存"）。当前无子域/无固定攻击面，故仅记录。**修复**：可选"登录时吊销同 UA 旧会话"或提供"仅保留当前"开关（已有 `revoke` 接口，前端未强制）。

### [Low-18] `/admin` 页面无页面级鉴权

**位置**：`api.rs:78-80`（`ADMIN_HTML` 直接 `Html` 返回，无 `AdminUser`）；`docs/AUTH.md:71` 已自认。数据接口均 admin-only（已核实），页面本身只是登录表单，故 Low。

### [Low-19] DB/WAL 明文与默认权限

**位置**：`storage.rs:113-204`（`PRAGMA journal_mode=WAL`、明文 `pwd_hash`/`salt`/`token_hash`）、`deploy/docker-compose.yml:9-10`（`./data:/app/data` bind mount）

**影响**：拿到宿主机文件的一方（或容器内任意进程，见 #10）可直接读全部口令哈希（argon2id 缓解）与**会话令牌哈希**（不能直接用于登录，正面）。无静态加密、无文件权限收紧（默认 0644/root）。**修复**：容器内存/文件权限 0600、数据卷单独授权；如需更强，评估 SQLCipher。

### [Info-20] 匿名可读面清单（设计如此，确认无越权）

`GET /api/health`（`api.rs:90-101`：`tick/cpi/paused/tick_ms/conservation_error/companies_count`）、`GET /api/catalog`、`GET /api/market/book`、`GET /api/market/candles`、`GET /admin`、`WS 未认证 401`。这些是"世界公开信息"，不涉账号数据。建议：`/api/health` 拆成 `/healthz`（仅 `{ok}`）与内部 metrics，避免对外暴露经济守恒误差。

### [Info-21] `seed_admin_from_env` 静默跳过

`engine.rs:462-464`：若目标邮箱已被注册（例如从备份恢复 DB、或先被玩家注册），直接 `Ok(None)` 静默返回 → 可能长期没有 `admin`，而只有 `main.rs:59-62` 的启动日志能发现。**修复**：`warn!` 明确提示 + `/api/health` 暴露 `has_admin: bool`（运维用）。

### [Info-22] 依赖版本（离线无 advisory 库，未做 CVE 判定）

见附录 A。要点：`h2` 不在 lock 内（未启用 HTTP/2，规避了 h2 系列 CVE）；`libsqlite3-sys 0.30.1` 为 bundled 编译；`rquickjs 0.9.0` 是玩家可控输入的执行引擎，**最高价值依赖**，其沙箱逃逸不在本报告范围（由沙箱专项负责），但版本跟踪应纳入流程。建议在有网环境跑 `cargo audit`/`cargo deny check advisories` 并接入 CI。

---

## 四、复现命令（全部为只读/失败请求，可安全重放）

```bash
B=http://100.84.136.78:18420

# 0) 线上基本信息 & 头部（含 CORS 全开、无安全头）
curl -sS -D - -o /dev/null "$B/api/health" -H 'Origin: https://evil.example'

# 1) High-1a：XFF 轮换绕过登录限流（对比无头会在第 11 次 429）
for i in $(seq 1 12); do
  curl -sS -o /dev/null -w '%{http_code} ' -X POST "$B/api/auth/login" \
    -H 'Content-Type: application/json' -H "X-Forwarded-For: 203.0.113.$i" \
    --data '{"email":"nobody-probe@example.com","password":"wrongpassword123"}'
done; echo
for i in $(seq 1 12); do
  curl -sS -o /dev/null -w '%{http_code} ' -X POST "$B/api/auth/login" \
    -H 'Content-Type: application/json' \
    --data '{"email":"nobody-probe@example.com","password":"wrongpassword123"}'
done; echo

# 2) High-2：argon2 串行证据（10 并发 ≈ 10×110ms）
start=$(date +%s%N)
for i in $(seq 1 10); do curl -sS -o /dev/null -X POST "$B/api/auth/login" \
  -H 'Content-Type: application/json' -H "X-Forwarded-For: 198.51.100.$i" \
  --data '{"email":"nobody-probe@example.com","password":"wrongpassword123"}' & done; wait
echo "wall_ms=$(( ($(date +%s%N)-start)/1000000 ))"

# 3) CSRF 基线：非 JSON Content-Type 一律 415（跨站表单打不进来）
curl -sS -o /dev/null -w '%{http_code}\n' -X POST "$B/api/auth/login" -H 'Content-Type: text/plain' --data '{"email":"a@b.co","password":"xxxxxxxxxx"}'
curl -sS -o /dev/null -w '%{http_code}\n' -X POST "$B/api/auth/login" -H 'Content-Type: application/x-www-form-urlencoded' --data 'email=a@b.co&password=xxxxxxxxxx'

# 4) GET 不写状态（所有写操作都在 POST/PUT/PATCH）
curl -sS -o /dev/null -w '%{http_code}\n' "$B/api/auth/logout"    # 405
curl -sS -o /dev/null -w '%{http_code}\n' "$B/api/intent"         # 405

# 5) 静态托管：穿越被拒但被 fallback 掩盖为 200 index.html
for p in '/../../etc/passwd' '/%2e%2e%2f%2e%2e%2fetc/passwd' '/.git/config' '/.env' '/api/doesnotexist'; do
  curl -sS --path-as-is -o /dev/null -w "$p -> %{http_code} %{content_type}\n" "$B$p"
done

# 6) 请求体上限（axum 默认 2MB）
python3 -c 'print("{\"email\":\"a@b.co\",\"password\":\"" + "x"*3000000 + "\"}")' > /tmp/big.json
curl -sS -o /dev/null -w '%{http_code}\n' -X POST "$B/api/auth/login" -H 'Content-Type: application/json' --data-binary @/tmp/big.json  # 413

# 7) 未认证访问关键接口（均为 401）
curl -sS -o /dev/null -w '%{http_code}\n' "$B/api/state"
curl -sS -o /dev/null -w '%{http_code}\n' "$B/api/admin/overview"
curl -sS -o /dev/null -w '%{http_code}\n' "$B/ws" -H 'Upgrade: websocket' -H 'Connection: Upgrade' \
  -H 'Sec-WebSocket-Version: 13' -H 'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ=='

# 8) High-3 验证（需 owner 在宿主机执行，勿在外部尝试注册）
docker exec meridian env | grep MERIDIAN_ADMIN
docker exec meridian sqlite3 /app/data/meridian.db "select id,email,role,status from users;"
```

---

## 五、正面项（已核实通过，避免后续回归）

| 项 | 证据 |
|---|---|
| 会话令牌 32 字节 CSPRNG（256 bit）+ 只存 SHA-256 | `auth.rs:97-107`（`rand::rng()` = 0.9 的 `ThreadRng`，ChaCha12 CSPRNG）；`storage.rs:963-987` 按哈希查 |
| 口令哈希 argon2id（v19, m=19MiB, t=2, p=1，与 OWASP 推荐一致）、每用户 16B 随机 salt、常数时间比对 | `auth.rs:47-69,85-94`；argon2 0.5.3 `Argon2::default()`；`docs/AUTH.md:37` 与实现一致 |
| 哈希在 `spawn_blocking`，不阻塞 async worker | `api.rs:816-839` |
| 用户不存在也跑一次哈希（抗账号枚举计时） | `api.rs:966-970` |
| 会话过期**每请求**校验并删除 | `auth.rs:329-332` |
| 登出撤销会话；改密踢掉其它设备 | `api.rs:1016-1019`、`api.rs:1145-1151` |
| 会话吊销有归属校验（无 IDOR） | `api.rs:1191-1198` |
| 管理员接口逐条校验 `AdminUser` | `auth.rs:347-360`；`api.rs:82,578,627` |
| 玩家态接口全部 `ensure_owner`（跨账号 403，管理员放行） | `auth.rs:363-372`；`api.rs:122,441,470,525,565`；测试 `tests/server_tests.rs:524-546` |
| WS 握手要求会话，首帧只给本人快照，广播按 cid 过滤 | `api.rs:667-722`；线上未认证 WS → 401 |
| SQL 全部参数化，无字符串拼接注入面；`format!` 只用于常量列清单 | `storage.rs:86,867,884,896`；其余 `params![]`；无动态 `ORDER BY`/表名；未启用 `load_extension` |
| CSRF 基线：`SameSite=Lax` + axum `Json` 强制 `application/json`（非 JSON → 415）+ 无 GET 写接口 | 线上实测 415/405 见第四节 |
| 请求体默认 2MB 上限（防超大 JSON 内存打爆） | 线上 3MB → 413 |
| 日志不含 token/密码/邮箱（仅启动日志记录初始管理员邮箱） | `grep` 全 crate 仅 `main.rs:59` |

---

## 六、修复优先级建议（按投入产出）

1. **今天**：确认 `MERIDIAN_ADMIN_EMAIL`/`MERIDIAN_ADMIN_PASSWORD` 已设置、`users` 表已有 admin（#3）；把后端绑到 `127.0.0.1` 并前置 TLS 反代、设 `MERIDIAN_COOKIE_SECURE=1`（#4）。
2. **本周**：反代覆盖 `X-Forwarded-For` + `client_ip` 取真实 peer IP 并做有界解析（#1、#7）；`HASH_GATE` 加超时 + 全局在途上限 + `ConcurrencyLimitLayer`（#2）；改密加失败退避/锁定（#5）；加安全响应头与 `no-store`（#11）。
3. **两周内**：容器降权 + 资源限制 + healthcheck（#10）；`touch_session` 节流与定时清理（#6）；脚本配额（#9）；Turnstile/邀请码或公司数上限（#8）；统一错误包装（#12）；`__Host-` cookie + WS Origin 校验（#15、#16）。
4. **持续**：`cargo audit` 入 CI，重点跟踪 `rquickjs`（#22）。

---

## 附录 A · 依赖版本（`backend/Cargo.lock`，2026-11-24）

| crate | 版本 | 备注 |
|---|---|---|
| axum | 0.8.9 | 特征 `ws`；HTTP/2 未启用（lock 内无 `h2`） |
| axum-core | 0.5.6 | |
| tower-http | 0.6.11 | `cors`+`fs`（`ServeDir`/`ServeFile`） |
| hyper / hyper-util | 1.12.0 / 0.1.21 | |
| tokio | 1.54.1 | features full |
| rusqlite / libsqlite3-sys | 0.32.1 / 0.30.1 | bundled SQLite |
| argon2 | 0.5.3 | Argon2id 默认参数 |
| rand | 0.9.5（另有 0.10.4 传递依赖） | `ThreadRng` CSPRNG |
| sha2 | 0.10.9 | 会话令牌哈希 |
| reqwest / rustls | 0.12.28 / 0.23.46 | 仅 Turnstile 出网用 |
| rquickjs | 0.9.0 | 玩家脚本执行引擎（最高风险面，沙箱专项） |
| tower | 0.5.3 | |
| serde_json | 1.0.154 | |

> 离线环境无 `~/.cargo/advisory-db`、无 `cargo-audit`，**本报告不对 CVE 做判定**，仅列版本供有网环境核对。

## 附录 B · 审计范围与未覆盖项

**已覆盖**：`auth.rs`（全文逐行）、`api.rs`（全文逐行）、`main.rs`、`storage.rs`（SQL/账号/会话/持久化段逐行）、`engine.rs`（bootstrap/seed/flush/reset/state_response/admin_overview/broadcast 相关段）、`Dockerfile`、`deploy/*`、`docs/AUTH.md`、`docs/MULTIPLAYER_AUDIT.md`、`Cargo.toml`/`Cargo.lock`、`tests/server_tests.rs`（鉴权用例）、线上只读探测。

**未覆盖（明确交接）**：
- QuickJS 沙箱逃逸 / Game API 越权（`meridian-sandbox`，由沙箱专项负责；本报告只指出它是最高价值攻击面且容器以 root 运行放大了影响）。
- 前端 XSS / 渲染层信任边界（前端专项）。
- 经济一致性/反作弊（`meridian-core`，另一路审计）。
- 线上压测与真实 DoS 验证（按纪律禁止）。

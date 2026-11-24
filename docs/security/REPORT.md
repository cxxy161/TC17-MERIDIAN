# Meridian 安全审计总报告（网络安全 + 反作弊）

- 审计对象：本地源码 `/home/cxxy168/code/html/Meridian` + 线上实例 <http://100.84.136.78:18420/>（用户自有，已明确授权主动测试）
- 审计时间：2026-11-24 21:12–21:35（Asia/Tokyo）
- 参与：Lead + 4 个并行审计单元（后端应用安全 / 线上黑盒 / 前端 / 反作弊与沙盒），各自报告见目录内文件
- 线上版本指纹：`/api/health` 字段、CORS 头、错误文案、`.git` 兜底行为与仓库 HEAD **逐字一致** ⇒ 源码结论可直接适用于线上；线上二进制构建于 19:35，早于工作区里并行进行的 telemetry 特性改动（`telemetry.rs`/`StepTiming`/`SqliteStore.db_path`，非本次审计产生），那些改动不涉及认证与校验路径，不影响本报告结论
- 审计方式：静态逐行阅读 + 受控线上探测（含少量有界利用验证，总量 < 250 请求）；**未修改任何源码/配置**

> 说明：用户中途要求「不用测游戏逻辑 bug，重点是网络安全」。因此本报告以**网络安全**为主线；已确认的经济溢出漏洞按"另案记录"处理（§6），不再扩展测试。
>
> **修复状态（2026-11-24 晚）**：本报告 §3/§4 的 P0/P1 网安项已按优先级修复，两个 Critical 经济漏洞与其根因也已修复；改动、验证与部署动作见 [FIXES.md](FIXES.md)，剩余未修项见其中 §5。

---

## 1. 总体结论

| 维度 | 评价 |
|---|---|
| 认证/授权核心 | **良好**：argon2id+CSPRNG、token 32B 且只存 SHA-256、常数时间比对、SQL 全参数化、`ensure_owner`/`AdminUser` 逐接口鉴权、无 IDOR（实测全 403）、登出即时吊销、无会话固定、登录侧不可枚举、WS 首帧只含本人数据 |
| 传输与边界 | **不达标**：无 TLS、Cookie 无 Secure、无任何安全响应头、无 HSTS；应用直接暴露 18420，无反代 |
| 限流与可用性 | **不达标**：XFF 可伪造 → 限流可绕过；无 XFF 时全员共享 `local` 桶 → 10 请求/分钟锁死全站登录；argon2 串行闸门无排队上限 → 未认证 DoS；写接口无速率限制 |
| 部署与配置 | **偏弱**：容器 root、无资源限制/健康检查、.env 示例弱默认口令、DB/WAL 明文、无 TLS 终止、无 CI 依赖审计 |
| 反作弊/沙盒 | **设计级高风险**：玩家 JS 与服务端同进程执行（RCE 面）；host 绑定绕过 JS 堆限额；经济层存在已确认的溢出漏洞（另案） |

**综合风险：High。** 认证实现本身扎实，风险几乎全部集中在"边界与运维"（TLS、代理头信任、限流、容器、沙箱隔离）。

**修复顺序建议：P0（24h）→ P1（1 周）→ P2（1 月）。** 只改 4 处即可消掉大部分即时风险：
① 上 TLS 反代并强制 `MERIDIAN_COOKIE_SECURE=1`；
② `client_ip` 改为取真实 peer IP / 只信可信代；
③ `HASH_GATE` 加超时 + 全局并发/超时中间件；
④ 关闭"首个注册者=admin"兜底并强制配置管理员。

---

## 2. 风险总表（合并去重）

> 详细证据、PoC、修复代码见各专项报告：`backend-appsec.md`（430 行）、`live-probe.md`（404 行）、`frontend.md`（304 行）、`anti-cheat.md`（262 行）。

| 优先级 | ID | 发现 | 严重度 | 状态 | 位置 |
|---|---|---|---|---|---|
| **P0** | NET-01 | 全站明文 HTTP；Cookie 无 `Secure`（依赖客户端可伪造的 `X-Forwarded-Proto`）；无 HSTS | High（Tailscale/CGNAT 可缓解） | 线上实测 | `main.rs:46`、`auth.rs:130-153`、`Dockerfile`、`deploy/` |
| **P0** | NET-02 | `X-Forwarded-For` 无条件信任（取最左）→ 限流完全绕过；无 XFF 时所有客户端共用 `"local"` 桶 → **10 请求/分钟锁死全站登录** | High | 线上实测（12×401 无 429；10×401 后 429） | `auth.rs:287-295`、`api.rs:872,954` |
| **P0** | NET-03 | argon2 全局 `Semaphore(1)` 且 `acquire()` 无超时、无全局在途上限、无 `TimeoutLayer` → 未认证即可排队耗尽内存/CPU（实测 10 并发严格串行 1107ms） | High | 线上实测 | `auth.rs:25`、`api.rs:816-839` |
| **P0** | NET-04 | 开放注册 + 生产 Turnstile 实际失效（前端 site key 恒空）+ 无邮箱验证；空库时**首个注册者自动 admin**（可 `sim/control reset`、建币公司、看 admin overview） | High（条件性 Critical） | 代码确认；线上已存在管理员、`.env` 默认口令登录实测 401 | `api.rs:896-901`、`engine.rs:452-483`、`AuthScreen.tsx:25-26`、`Dockerfile:2-7` |
| **P0** | SAND-01 | 玩家 QuickJS 在**服务端主进程内**（rayon 线程）执行，与网关同进程同权限；QuickJS/libc 任一内存安全缺陷 = 全服 RCE + 可读 `data/meridian.db`（会话/口令哈希、全玩家 Memory） | High（设计级；可利用 CVE 未验证） | 代码确认 | `runner.rs:129-150`、`js_runner.rs:139` |
| **P1** | API-01 | `POST /api/intent` 无速率限制、`extra_intents` 队列无上限（暂停期持续累积），且全服单把 `Mutex` 与 tick 抢锁 → 单账号内存膨胀 + tick 停摆 | High | 代码确认 | `api.rs:44,560-570`、`engine.rs:1471-1481` |
| **P1** | SAND-02 | host 绑定在 Rust 侧物化**无上限 JSON**（`__meridian_get_all_orders` 空参返回全站挂单），绕过 4MB JS 堆限额，无调用次数上限 | High | 代码确认 | `js_runner.rs:641-669` |
| **P1** | WEB-01 | 零安全响应头：无 CSP / X-Frame-Options / X-Content-Type-Options / Referrer-Policy / HSTS；认证响应无 `Cache-Control: no-store` | Medium | 线上实测 | `api.rs:29-65`（无 header layer）、`frontend/index.html` |
| **P1** | WEB-02 | `CorsLayer::permissive()`：`ACAO/ACAM/ACAH: *`；当前无 `Allow-Credentials` 故不可直接利用，一旦有人加 credentials 立刻数据泄露；WS 升级不校验 Origin | Medium（潜伏 High） | 线上实测 + 代码 | `api.rs:56,667-722` |
| **P1** | NET-05 | XFF 直接作为无界 `HashMap` key（4KB 头被接受、不截断不淘汰）→ 慢速无界内存增长 | Medium | 代码 + 线上 4KB 头被接受 | `auth.rs:194-246` |
| **P1** | API-02 | 每个已认证请求都写一次 `sessions.last_seen_at`（WAL 写放大、在全局锁内）；登录无限创建会话、无每用户会话上限、只在登录时清理过期会话 | Medium | 代码确认 | `auth.rs:336`、`storage.rs:989-997,1055-1059` |
| **P1** | API-03 | 改密接口零限流、无失败计数/账号锁定（~9 次/秒无限爆破 `current_password`）；登录只有可绕过的 IP 限流 | Medium | 代码确认 | `api.rs:1108-1153`、`auth.rs:206-246` |
| **P1** | WEB-03 | 生产 Turnstile 端到端失效（Vite 静态替换未命中 → site key 恒空；Dockerfile 未传 `VITE_TURNSTILE_SITE_KEY`；若服务端配 secret 则所有注册 403） | Medium | dist bundle 证据 | `AuthScreen.tsx:25-26,99-102`、`Dockerfile:1-8` |
| **P1** | DEP-01 | 容器以 root 运行、无 `USER`、无 HEALTHCHECK、无内存/CPU 限制、无只读根/降权 | Medium | 代码确认 | `Dockerfile`、`deploy/docker-compose.yml` |
| **P1** | NET-06 | WS 无单账号/单 IP 连接上限、无消息大小上限；每连接每 tick 全量序列化世界状态（含全量行情）→ CPU/内存线性放大 | Medium | 代码确认 | `api.rs:667-722` |
| **P1** | CFG-01 | `deploy/.env.example` 提供弱默认管理员口令 `change-me-at-least-8-chars`（线上实测该口令 401，未踩坑；但照着示例填就会失守） | Medium | 代码 + 线上实测 | `deploy/.env.example`、`engine.rs:452-483` |
| **P1** | API-04 | 密码策略仅 ≥8 位、无邮箱验证、无泄露口令检查 → 撞库成本低（叠加 NET-02 后无限速） | Medium | 代码确认 | `api.rs:864-870` |
| **P2** | API-05 | 注册 409 明确区分 `email`/`nickname` → 账号枚举（配合 NET-02 可批量探测） | Low–Medium | 线上实测 | `api.rs:888-893` |
| **P2** | API-06 | 500 错误体直接回显 rusqlite 错误串（表列名/约束/SQL 片段） | Low | 代码确认 | `api.rs:322,326,496,548,905+` |
| **P2** | WEB-04 | SPA fallback 吞掉所有未知路径：`/api/nope`、`/.env`、`/.git/HEAD` 一律 200 `index.html`（实测 536B，非真实泄露，但掩盖 404/误导客户端） | Low | 线上实测 | `api.rs:58-64` |
| **P2** | WEB-05 | `/admin`、`/admin.html` 后台页未登录可访问（39,886B；数据接口已 admin-only，实测 403）；`OPTIONS` 行为不一致（静态 405 / API 200），405 响应体为空 | Low | 线上实测 | `api.rs:31-32,78-80` |
| **P2** | API-07 | 登录不轮换/不吊销旧会话；Cookie 无 `__Host-` 前缀（同主机其他端口可投毒） | Low | 代码确认 | `api.rs:985-999`、`auth.rs:143-153` |
| **P2** | WEB-06 | 前端 `ConsolePanel` 用 `new Function` 在主世界执行任意 JS（self-XSS/pastejacking），使严格 CSP 无法落地 | Low | 代码确认 | `ConsolePanel.tsx:392,395` |
| **P2** | OPS-01 | DB/WAL 明文落盘、默认权限；容器内同机用户可读口令哈希与会话哈希 | Low | 代码确认 | `storage.rs:113-204`、`deploy/docker-compose.yml` |
| **P2** | OPS-02 | tick 循环裸 `tokio::spawn` 无监督、无 `catch_unwind` → 一次 panic 模拟永久冻结而 HTTP 仍 200（静默故障、无告警） | Medium | 代码确认 | `main.rs:73-96` |
| **P2** | OPS-03 | 依赖 CVE 未核（离线无 RustSec 库）；建议 CI 加 `cargo audit`/`npm audit` | Info | 未验证 | `backend/Cargo.lock`、`frontend/package-lock.json` |
| **另案** | ECON-01 | 经济层整数截断 + 负 notional 绕过余额校验（已在线上**确认可利用**，按用户要求不深入） | Critical（游戏经济） | 线上已复现 | `world.rs:1477-1489`、`exchange.rs:276-278`、`world.rs:1364` |

---

## 3. P0 详解与修复

### NET-01 明文传输（TLS 缺失）

**证据**：线上 443/HTTPS 握手失败；`curl -D -` 仅 5 个基础头，无 HSTS；`Set-Cookie: meridian_sid=…; Path=/; HttpOnly; SameSite=Lax`（`remember=true` 时加 `Max-Age=1209600`）——**没有 Secure**。根因：`cookie_secure()` 只在 `X-Forwarded-Proto: https` 或环境变量强制时为真，而部署是直连 18420，无代理。

**影响**：同一链路（Tailscale 之外的网络路径、或未来暴露公网）可被动嗅探会话与登录口令；`100.84.136.78` 属 Tailscale CGNAT 段，当前暴露面被 Tailscale 收敛，因此定为"条件性 High"。

**修复**（推荐 Caddy，自动 HTTPS + HTTP/2）：

```caddyfile
# /etc/caddy/Caddyfile
meridian.example.com {
    encode zstd gzip
    header {
        Strict-Transport-Security "max-age=31536000; includeSubDomains"
        X-Content-Type-Options "nosniff"
        X-Frame-Options "DENY"
        Referrer-Policy "strict-origin-when-cross-origin"
        Content-Security-Policy "default-src 'self'; script-src 'self' 'unsafe-eval'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self' wss:; frame-ancestors 'none'; base-uri 'self'; form-action 'self'"
        -Server
    }
    reverse_proxy 127.0.0.1:18420 {
        header_up X-Forwarded-For {remote_host}      # 覆盖写，不追加
        header_up X-Forwarded-Proto {scheme}
    }
}
```

- 后端改绑 `MERIDIAN_ADDR=127.0.0.1:18420`，只让反代可达；
- 容器加 `MERIDIAN_COOKIE_SECURE=1`（显式，不依赖 XFP）；
- `session_cookie()` 改 `__Host-meridian_sid`（需 `Secure; Path=/; 无 Domain`）；
- `docs/AUTH.md` 里"`MERIDIAN_COOKIE_SECURE` 默认 1"与实现不符（实现默认按请求判断），一并更正。

> CSP 里的 `'unsafe-eval'` 是迁就 `ConsolePanel` 的 `new Function`。彻底方案是把玩家脚本编辑器的执行搬到 `Worker`（blob URL）或沙盒 iframe，随后去掉 `'unsafe-eval'`。

### NET-02 XFF 信任 → 限流双向失效

```rust
// auth.rs:287-295（现状）
headers.get("x-forwarded-for")
    .and_then(|v| v.to_str().ok())
    .and_then(|v| v.split(',').next())   // 最左一跳 = 客户端可伪造
    .unwrap_or_else(|| "local".to_string()) // 无 XFF 时所有人共用
```

**实测**：① 轮换伪造 XFF 连发 12 次错误登录 → 12×401，零 429（无限爆破）；② 不带头连发 → 10×401 后 429（**任何匿名者 10 请求/分钟即可让全站登录不可用**）；③ 注册每 IP 3/小时同样被 XFF 绕过（审计期间用 203.0.113.x 成功建了 4 个号）。

**修复**：

```rust
use axum::extract::ConnectInfo;
use std::net::SocketAddr;

/// 可信反代网段（部署时配置）；直连 peer 不在名单内时忽略 XFF。
fn trusted_proxy(ip: IpAddr) -> bool {
    ip.is_loopback() || TRUSTED_PROXY_CIDRS.iter().any(|c| c.contains(&ip))
}

pub fn client_ip(headers: &HeaderMap, peer: SocketAddr) -> String {
    if trusted_proxy(peer.ip()) {
        if let Some(real) = headers.get("x-forwarded-for")
            .and_then(|v| v.to_str().ok())
            .and_then(|v| v.split(',').next_back())   // 取最右（由可信代写入）
        {
            return real.trim().to_string();
        }
    }
    peer.ip().to_string()
}
```

- 反代 `header_up X-Forwarded-For {remote_host}` **覆盖写**；
- 无 XFF 时**不要**折叠成 `"local"`（这是全站锁死的根因），用真实 peer；
- 登录再加"按账号"维度失败计数 + 指数退避（NET-02 与 API-03 一起解）。

### NET-03 argon2 闸门 DoS

```rust
// 现状：无超时 join/排队
let _permit = auth::HASH_GATE.acquire().await.map_err(...)?;

// 修复
let _permit = tokio::time::timeout(Duration::from_secs(2), auth::HASH_GATE.acquire())
    .await
    .map_err(|_| ApiError::new(StatusCode::SERVICE_UNAVAILABLE, "服务器繁忙，请稍后重试"))?
    .map_err(|_| ApiError::new(StatusCode::SERVICE_UNAVAILABLE, "hash gate closed"))?;
```

并加全局中间件（`build_router`）：

```rust
use tower_http::timeout::TimeoutLayer;
use tower::limit::ConcurrencyLimitLayer;
use tower_http::limit::RequestBodyLimitLayer;

.layer(RequestBodyLimitLayer::new(1024 * 1024))        // 认证/写接口 1MB 足够
.layer(ConcurrencyLimitLayer::new(256))
.layer(TimeoutLayer::new(Duration::from_secs(15)))
```

再配 `MERIDIAN_HASH_PARALLEL`（2C 机器建议 1–2）与容器 `mem_limit`，把 DoS 限制为"降级"。

### NET-04 开放注册 / Turnstile 失效 / 首注册者 admin

**事实链**：
1. `api.rs:896-901`：`count_users()==0` → 新用户 `role="admin"`（自带测试也断言此行为）；
2. 生产前端 `VITE_TURNSTILE_SITE_KEY` 静态替换未命中，dist 里恒为 `""`（`AuthScreen.tsx:25-26` 的可选链写法 + Dockerfile 未传参）→ 注册页不渲染验证码、不发 token；
3. 服务端 `verify_turnstile` 在 secret 为空时直接放行；若 secret 已配置而前端不发 token ⇒ **所有注册 403**；
4. 线上管理员已存在（首个注册者为 `role=player` 实测），且 `.env.example` 默认口令实测 **401**（未踩坑）。

**修复**：
- 强制 `MERIDIAN_ADMIN_EMAIL/PASSWORD` 必填（缺失时拒绝启动或禁用注册），删掉"首注册者 admin"兜底；
- 注册改为邀请码/邮件验证/管理员审批三选一（`status='pending'` 已有字段可复用）；
- 构建阶段 `ARG VITE_TURNSTILE_SITE_KEY` 并注入，或改用运行时注入（`/api/config` 下发 site key）；
- 服务端 secret 未配置时**拒绝注册**（fail-closed），而不是静默放行。

### SAND-01 沙盒同进程（设计级）

玩家 JS 由 `SimulationRunner::step_world` 在 `rayon` 线程内执行（`runner.rs:129-150` → `js_runner.rs:139`），与 axum 网关同进程、同 uid、同文件权限。QuickJS（C 实现）或 libc 的任一内存破坏即可升级为整服 RCE 并读取 `data/meridian.db`（含全部会话哈希与玩家 Memory/脚本）。

**缓解（按成本递增）**：
1. 短期：`rquickjs` 跟踪上游 CVE 并固定版本；沙盒线程池加 `catch_unwind`；DB 文件 0600、容器 `--read-only` + `tmpfs`；
2. 中期：玩家脚本执行拆独立 worker 进程（`--network=none`、降权 uid、seccomp、`RLIMIT_AS/CPU`、`NO_NEW_PRIVS`），IPC 只交换 snapshot→intent JSON；
3. 长期：沙盒化 WASM（wasmtime + 资源限额）替代原生 QuickJS 调用。

---

## 4. P1 要点（修复片段）

### WEB-01 安全响应头（后端统一注入，不依赖反代）

```rust
use axum::http::{header, HeaderValue};
use tower_http::set_header::SetResponseHeaderLayer;

fn sec_headers() -> impl tower::Layer<axum::routing::Route> {
    tower::ServiceBuilder::new()
        .layer(SetResponseHeaderLayer::overriding(
            header::X_CONTENT_TYPE_OPTIONS, HeaderValue::from_static("nosniff")))
        .layer(SetResponseHeaderLayer::overriding(
            header::X_FRAME_OPTIONS, HeaderValue::from_static("DENY")))
        .layer(SetResponseHeaderLayer::overriding(
            header::REFERRER_POLICY, HeaderValue::from_static("strict-origin-when-cross-origin")))
        .layer(SetResponseHeaderLayer::overriding(
            header::CONTENT_SECURITY_POLICY,
            HeaderValue::from_static("default-src 'self'; script-src 'self' 'unsafe-eval'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self' wss:; frame-ancestors 'none'; base-uri 'self'; form-action 'self'")))
}
```

认证相关响应补 `Cache-Control: no-store`（`/api/auth/*`、`/api/account`、`/api/state`）。

### WEB-02 CORS 收敛

```rust
// 替换 CorsLayer::permissive()
CorsLayer::new()
    .allow_origin([env_frontend_origin.parse().unwrap()])   // 明确来源，如 https://meridian.example.com
    .allow_methods([Method::GET, Method::POST, Method::PUT, Method::PATCH])
    .allow_headers([header::CONTENT_TYPE, header::COOKIE])
    .allow_credentials(true)                                 // 只有明确 origin 时才能开
```

WS 升级处校验 `Origin` 白名单，否则同源于 Cookie 的 CSWSH 会随 `SameSite` 调整而暴露。

### API-01/02/03 限流与写放大

- `/api/intent`、`PUT /api/scripts`、`PUT /api/memory`、`/api/market/*` 加每账号令牌桶（如 intent 30/s、scripts 3/min）；
- `extra_intents` 每公司上限（如 256），超出直接 429；暂停态同样受限；
- `touch_session` 改为"每 60s 最多写一次"（内存里比较 `last_seen_at`），并把 UPDATE 移出全局引擎锁；
- 每用户会话上限（如 10，登录时淘汰最旧），tick 内顺带清理过期会话；
- 改密加限流（5 次/分/账号）+ 失败计数 + 退避。

### SAND-02 host 绑定限额

`__meridian_get_all_orders` 等返回全量数据前先按 `limit`/`station`/`item` 过滤并限制条数（如 ≤500 行），JSON 序列化设字节上限（如 256KB），超限返回错误而非物化。并给每个 tick 的 host 调用次数计数（如 ≤50），抑制"单脚本刷绑定"。

### DEP-01 容器加固

```yaml
services:
  meridian:
    image: meridian:latest
    user: "10001:10001"
    read_only: true
    tmpfs: ["/tmp"]
    security_opt: ["no-new-privileges:true"]
    cap_drop: ["ALL"]
    mem_limit: 480m
    cpus: 1.8
    healthcheck:
      test: ["CMD", "curl", "-fsS", "http://127.0.0.1:18420/api/health"]
      interval: 30s
    ports: ["127.0.0.1:18420:18420"]   # 只给反代
    volumes: ["./data:/app/data"]
```

`Dockerfile` 增加 `RUN chown -R 10001:10001 /app && USER 10001`、`chmod 700 /app/data`。

---

## 5. 已验证的安全基线（正面，建议保持）

| 项 | 结果 | 证据 |
|---|---|---|
| 口令存储 | argon2id（m=19MiB,t=2,p=1），16B CSPRNG salt，常数时间比对 | `auth.rs:46-94` |
| 会话令牌 | 32B CSPRNG → hex；库内只存 SHA-256；不可从库反推 | `auth.rs:96-107`、`storage.rs:945-987` |
| SQL 注入 | 全参数化（`params!`），`format!` 只拼常数列名 | `storage.rs` 全文 |
| 越权/IDOR | 实测 `/api/state?company_id=u5`、`/api/scripts/u5`、`PUT /api/memory/u5` 全部 **403** | 线上实测 |
| 管理接口 | `/api/admin/overview`、`/api/sim/control` 以玩家身份 **403**；无隐藏调试 intent | 线上实测 + 全仓 grep |
| 会话吊销 | 登出后旧 token 立即 401，另一会话仍 200 | 线上实测 |
| WS 数据隔离 | 未带 Cookie 握手 **401**；带 Cookie 首帧只含本人公司； tick 帧 `player_outputs` 只有本人 | 线上实测（97708B init / 15726B tick） |
| CSRF 基线 | 全部写接口强制 JSON（跨站表单 → 415），Cookie `SameSite=Lax`；无 GET 写操作 | 代码 + 实测 |
| 请求体上限 | 3MB → **413**（axum 默认 2MB） | 线上实测 |
| 登录枚举 | 不存在邮箱与错密码同文案、同状态码，且跑 dummy hash（实测 0.338s vs 0.401s，不可枚举） | `api.rs:966-974` |
| 前端注入 | 无 `dangerouslySetInnerHTML`/`innerHTML`/`postMessage`；dist 无 sourcemap、无密钥/内网地址 | `frontend.md` |
| 静态托管 | `.git`/`.env`/任意路径均 536B index.html（非真实文件，无泄露）；`/docs` 门户无内部接口/密钥 | 线上实测 |

---

## 6. 另案：已确认的经济漏洞（按用户要求不深入）

> 游戏逻辑类，已在线上**成功复现**，仅作记录与修复线索，不再扩展测试。修复与否由你决定；建议随 P0 一起修，因为可被普通玩家利用。

- **根因**：客户端 `Intent` 的 `price: i64` 无上限（`api.rs:554-570` → `apply_intent` 仅查 `price>0`），而结算处 `(take as i128 * order.price as i128) as Money` 未做 checked 转换（`world.rs:1477`、`exchange.rs:276-278`、`world.rs:1364`）。
- **利用**：`price = 2^62`、`take = 3` → `notional = -2^62`（负）；`DealOrder` 的 `if cash < notional` 对负值恒假 → 买家 `cash -= notional` **凭空加钱**。
- **线上实测结果**：u4 挂 3 单位 ore @ 4.6e17 credits，u5 买入后：u5 现金 9,719.93 → **461,168,601,852,458.75 credits**；u4 net_liquid → **-461,168,601,833,018.9**；`/api/health` 的 `conservation_error` 仍为 **0**（净额守恒，现有不变量只查"总量"，看不见这种"一正一负"）；同时 ore 的 `last_price` 被污染为 4.6e17，行情/排行榜失真。
- **为什么负余额不用还**：`world.rs:2117-2124` 明确 *Players are NEVER force-bankrupted*，玩家公司的负现金不会被清算/核销，也没有追偿机制 —— 所以这等价于"无限额度透支给主账号、把不可回收负债留在弃置账号"，是实际上的购买力凭空生成，而不是账面上的守恒。
- **修复**：价格/数量白名单上限（如 `price ≤ 1e6 * MONEY_SCALE`、`qty ≤ 10_000`）；所有 `i128→i64` 用 `i64::try_from(...)` 并在溢出/负值时拒绝；结算前断言 `notional > 0 && escrow_cash >= notional`；对 `conservation_error != 0` 告警并自动暂停撮合；加经济不变量 fuzz（已有 `tests/invariants.rs` 可扩展）。**扩展阅读**：第二轮专项审计见 `CHEAT-REPORT.md`（撮合退款造币、银行无抵押套现、地块垄断、城市报价抽水等 20+ 条）。

---

## 7. 线上实测证据（摘录）

```text
# 响应头（无安全头、无 Server 版本泄漏、无 HSTS）
HTTP/1.1 200 OK
content-type: text/html
accept-ranges: bytes
last-modified: Tue, 24 Nov 2026 12:01:49 GMT
content-length: 536
date: ...

# CORS（任意 Origin）
access-control-allow-origin: *
access-control-expose-headers: *
vary: origin, access-control-request-method, access-control-request-headers

# 限流（不带头，10 次后 429）
401 ×10 → 429
# 伪造 XFF 轮换：12 × 401，无 429

# 认证响应（无 Secure / 持久化时 Max-Age）
set-cookie: meridian_sid=<redacted>; Path=/; HttpOnly; SameSite=Lax
set-cookie: meridian_sid=<redacted>; Path=/; HttpOnly; SameSite=Lax; Max-Age=1209600

# 未登录 / 越权
GET /api/auth/me            → 401
GET /api/state?company_id=u5 (as u4) → 403
GET /api/scripts/u5 (as u4) → 403
PUT /api/memory/u5 (as u4)  → 403
GET /api/admin/overview (as player) → 403
POST /api/sim/control (as player)   → 403

# 登出吊销
logout=200 → old token /api/auth/me = 401；另一会话 = 200

# 路径与兜底
GET /.git/HEAD → 200 536 (index.html fallback)
GET /api/nope  → 200 536 text/html
3MB body       → 413
PUT/DELETE/PATCH/TRACE /api/state → 405

# WebSocket
无 Cookie → HTTP/1.1 401 Unauthorized
有 Cookie → 101；init 97708B company=u4；tick 15726B player_outputs=["u4"]

# .env.example 默认管理员口令
POST /api/auth/login admin@example.com / change-me-at-least-8-chars → 401（未踩坑）

# 注册枚举
重复邮箱 → 409 {"message":"该邮箱已注册","field":"email"}
重复昵称 → 409 {"message":"该昵称已被占用","field":"nickname"}
```

---

## 8. 测试账号与线上状态处置（重要）

本次审计在线上创建了 4 个测试账号（无真实玩家，已获授权）：

| company_id | email | 备注 |
|---|---|---|
| u2 | secaudit_a1@example.com | live-probe 创建（密码见 `live-probe.md` §10） |
| u3 | secaudit_a2@example.com | live-probe 创建（同上） |
| u4 | secaudit_a@example.com | Lead 创建；经济 PoC 中现金变为 **-4.61e17 credits** |
| u5 | secaudit_b@example.com | Lead 创建；经济 PoC 中现金变为 **+4.61e14 credits** |

另外 ECON-01 的 PoC 把 ore 的 last_price 写成了 4.6e17，并让 u4 负资产、u5 登顶排行榜。**建议删档重置**：

```bash
# 停服后删除数据库（含 WAL/SHM），重启会按 production.json 重新生成世界
docker compose -f deploy/docker-compose.yml down
rm -f <MERIDIAN_DB_PATH 所在目录>/meridian.db*
docker compose -f deploy/docker-compose.yml up -d
# 若在宿主机直跑：rm -f backend/data/meridian.db backend/data/meridian.db-wal backend/data/meridian.db-shm
```

重置后请确认：①管理员已由 `MERIDIAN_ADMIN_EMAIL/PASSWORD` 播种且口令非默认；②注册入口已按 NET-04 收紧（否则任何先注册者可拿 admin）。

审计期间生成的临时文件（cookie jar、请求样本）在工作区 `.audit-tmp/`，交付时已删除；仓库改动只有 `docs/security/`（4 份专项报告 + 本报告）。

---

## 9. 复现命令（节选，全部低影响）

```bash
B=http://100.84.136.78:18420

# 安全头 / CORS
curl -sS -D - -o /dev/null $B/
curl -sS -D - -o /dev/null $B/api/health -H 'Origin: https://evil.example'

# 限流绕过（10 次后应 429；加伪造 XFF 则不再 429）
for i in $(seq 1 12); do curl -sS -o /dev/null -w '%{http_code} ' -X POST $B/api/auth/login \
  -H 'content-type: application/json' -d '{"email":"nobody@example.com","password":"wrongpass"}'; done; echo
for i in $(seq 1 12); do curl -sS -o /dev/null -w '%{http_code} ' -X POST $B/api/auth/login \
  -H "x-forwarded-for: 198.51.100.$i" -H 'content-type: application/json' \
  -d '{"email":"nobody@example.com","password":"wrongpass"}'; done; echo

# 安全兜底 / 方法 / body 上限
curl -sS -o /dev/null -w '%{http_code} %{size_download}\n' $B/.git/HEAD
curl -sS -o /dev/null -w '%{http_code}\n' -X TRACE $B/api/state
python3 -c 'print("{\"email\":\""+"a"*3000000+"\"}")' > /tmp/big.json
curl -sS -o /dev/null -w '%{http_code}\n' -X POST $B/api/auth/login -H 'content-type: application/json' --data-binary @/tmp/big.json

# WebSocket 鉴权（无 Cookie 应 401）
curl -sS -i -m 3 -H 'Upgrade: websocket' -H 'Connection: Upgrade' \
  -H 'Sec-WebSocket-Version: 13' -H 'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==' $B/ws | head -3
```

---

## 10. 限制与未覆盖

- **未做**：真实压测（仅 10 并发量级）、QuickJS fuzz/已知 CVE 比对、浏览器内 SameSite/CSRF 实机验证、TLS 配置验证（当前无 TLS）、依赖 CVE 库比对（离线）。
- **需你确认**：线上 `MERIDIAN_ADMIN_EMAIL/PASSWORD` 是否显式设置（若未设，删档重启后第一个注册者即 admin）；`MERIDIAN_TURNSTILE_SECRET` 是否配置（若配置，当前前端会导致注册 403）。
- **工作区异常**：`backend/crates/meridian-sandbox/src/runner.rs`、`meridian-server/src/{engine.rs,lib.rs,storage.rs}` 有**非本次审计**的在途改动（telemetry 特性：`StepTiming`、`telemetry.rs`、`SqliteStore.db_path`，审计结束时仍在持续写入），未触碰、未回滚；它们不在认证/校验路径上，不影响本报告结论。
- 建议把本目录四份专项报告作为附件长期保留，修复后逐条勾对（每条均带 file:line 与复现命令）。

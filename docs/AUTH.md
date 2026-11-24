# 账号与会话（AUTH）

> 对应代码：`backend/crates/meridian-server/src/auth.rs`、`api.rs` 的账号段、`storage.rs` 的 users/sessions 表。
> 前端：`frontend/src/auth/AuthScreen.tsx`、`SessionGate.tsx`、`store/useSessionStore.ts`、`panels/SettingsPanel.tsx`。
> 网关层加固见 `api.rs::build_router`，部署见 `deploy/Caddyfile` 与 `deploy/docker-compose.yml`。

## 一、数据模型

| 表 | 关键列 | 说明 |
|---|---|---|
| `users` | `email`(UNIQUE, NOCASE)、`nickname`(UNIQUE)、`pwd_hash`+`salt`、`role`、`status`、`company_id`(UNIQUE) | 一个账号绑定一家公司 |
| `sessions` | `token_hash`(UNIQUE)、`user_id`、`expires_at`、`last_seen_at`、`user_agent` | 只存 token 的 SHA-256，库里拿不到可用令牌 |

- 首个注册的账号自动获得 `role='admin'`，并**接管预置的 `player1` 公司**（保留开服经济，不必重开世界）。
- 后续账号的公司 id 为 `u<user_id>`，初始 10,000 信用点 + 起始脚本。
- 会话时长：普通 12 小时，「保持登录」14 天。
- **保持登录**：登录页勾选后 Cookie 带 `Max-Age=1209600`（持久化，关浏览器也在）；
  不勾选则是**会话 Cookie**（无 Max-Age，关浏览器即失效），服务端 TTL 仍为 12 小时。

## 二、接口

```
POST /api/auth/register  {email, nickname, password, turnstile_token?}  → 200 {company_id, nickname, email, role} + Set-Cookie
POST /api/auth/login     {email, password, remember?}                   → 同上
POST /api/auth/logout                                                   → {ok:true}
GET  /api/auth/me                                                       → 同上 / 401

GET   /api/account                  → {email, nickname, role, company_id, created_at, nickname_changed_at, sessions[]}
PATCH /api/account                  {nickname}                          → {ok, nickname} | 409/429
POST  /api/account/password         {current_password, new_password}     → {ok}（成功即踢掉其他设备）
POST  /api/account/sessions/revoke  {session_id} 或 {all:true}           → {ok}
```

错误体统一为 `{message, field?, cooldown_until?}`，状态码 400/401/403/404/409/413/408/429/503。
未知的 `/api/*` 路径返回 **JSON 404**（不会兜底成 SPA 的 200 index.html）；
非 `/api` 的未知路径仍回 SPA index.html，静态资源照常由 `ServeDir` 提供。

## 三、安全决策

### 口令与哈希闸门

- **argon2id**，默认参数 m=19 MiB / t=2 / p=1；哈希在 `spawn_blocking` 中执行。
- 全局 `HASH_GATE`（1 个许可）串行化口令哈希；`acquire` 外面包 `tokio::time::timeout(2s)`，
  等待超时直接 **503**（`认证服务繁忙`），未认证请求无法靠排队耗尽资源。
- 注册/登录另有**全局在途上限 64**（`AUTH_INFLIGHT`），超出直接 **429**；
  Turnstile 网络等待与阻塞哈希都算在途。

### Cookie

- 固定 `HttpOnly; SameSite=Lax; Path=/`。
- `Secure` 的规则是**按每个请求**判断：反代带了 `X-Forwarded-Proto: https` 才加；
  裸 HTTP（局域网、内网调试）不加——否则浏览器会丢弃 Cookie，表现为「登录 200 但后续全 401」。
- `MERIDIAN_COOKIE_SECURE=1/0` 可强制覆盖（1=总是 Secure，0=从不）。**默认不是 1**，
  旧版本文档写成「默认 1」与实现不符，已更正。

### 客户端 IP 与限流（原 P0：XFF 伪造 + 全站共享桶）

- `client_ip(headers, Option<ConnectInfo<SocketAddr>>)`：
  - 只有直连 **peer** 落在 `MERIDIAN_TRUSTED_PROXIES`（逗号分隔 CIDR）内时，才采信 `X-Forwarded-For`，
    且只取**最右一跳**（可信反代覆盖写入的那一项）；
  - 否则一律用 peer IP，客户端自带的 XFF 被忽略；
  - 没有任何 `ConnectInfo`（测试/嵌入式调用）时返回 `unknown`，绝不折叠成一个可被利用的“local”真值。
- `main.rs` 用 `into_make_service_with_connect_info::<SocketAddr>()` 注入 peer；反代必须**覆盖写** XFF。
- 限流：全局注册桶（容量 5，2 次/分）+ 每 IP 注册 3 次/小时 + 每 IP 登录 10 次/分；
  每 IP 表硬上限 **4096**，超出先清空闲条目再按 LRU 淘汰并记 `warn` 日志（伪造来源撑不爆内存）。
- **按账号**登录失败计数：同一账号 5 次密码错误锁定 **5 分钟**，登录成功清零；
  换 IP 也不能继续猜。锁定期返回 429 并带 `cooldown_until`。

### CORS 与 CSRF 纵深

- CORS 读取 `MERIDIAN_ALLOWED_ORIGINS`（逗号分隔的完整 Origin）。**为空则不启用跨域**；
  只允许 GET/POST/PUT/PATCH（含 OPTIONS 预检）与 `content-type`；显式拒绝 `*`，
  因此不会出现「`*` + credentials」的非法组合。
- 所有非 GET/HEAD/OPTIONS 请求经过 CSRF 检查：
  - 带 `Origin` 且既不在白名单、也与请求 `Host` 不同源 → **403**（同源写请求放行）；
  - `Sec-Fetch-Site: cross-site` → **403**；
  - 无 `Origin`（curl、同源表单、旧浏览器）放行，仍由 `SameSite=Lax` 兜底。

### 安全响应头（后端统一注入，不依赖反代）

- `X-Content-Type-Options: nosniff`、`X-Frame-Options: DENY`、
  `Referrer-Policy: strict-origin-when-cross-origin`；
- `Content-Security-Policy`：`default-src 'self'`，脚本允许 `'unsafe-eval'`（ConsolePanel 用 `new Function`）
  与 Cloudflare Turnstile 域名；`frame-ancestors 'none'`；
- `Strict-Transport-Security: max-age=31536000; includeSubDomains` **仅当** `X-Forwarded-Proto: https` 时下发；
- `/api/auth/*`、`/api/account*`、`/api/state` 响应带 `Cache-Control: no-store`。

### 网关层保护

- `RequestBodyLimitLayer(2 MiB)`：超限 **413**；
- `ConcurrencyLimitLayer(256)` + `TimeoutLayer(15s)`：排队时间计入超时，超时 **408**；
- 所有 500 只回通用文案（`服务器内部错误，请稍后重试`），SQLite/内部错误细节只进 tracing；
- `/api/intent` 手动指令队列每公司上限 **256** 条，超出 **429**。

### 归属与管理员

- 所有玩家态接口（state/scripts/memory/intent）必须以会话身份为准，跨账号 403；管理员可读任意公司。
- `/api/sim/control`、`/api/companies`、`/api/admin/*` 仅 admin。
- **WebSocket**：握手要求会话 Cookie，首帧只给本人的 `state_response`，tick 广播只保留自己的 `player_outputs`。

## 四、部署与反代（务必按此配）

1. **后端只监听回环**：`MERIDIAN_ADDR=127.0.0.1:18420`（compose 已把端口绑到 `127.0.0.1`）。
2. **前置 Caddy 终结 TLS**：用 `deploy/Caddyfile`（自动 HTTPS、安全头、覆盖写 XFF/XFP）。
3. **配置信任链**：`MERIDIAN_TRUSTED_PROXIES=127.0.0.1/32,::1/128`（Caddy 与后端同机时）。
   直连部署（无反代）留空即可，此时限流按 TCP peer IP 计。
4. **同源部署**：`MERIDIAN_ALLOWED_ORIGINS` 留空；前后端不同域时才填完整 Origin。
5. **容器加固**：`deploy/docker-compose.yml` 已设 `user: 10001:10001`、`read_only`、`cap_drop: ALL`、
   `no-new-privileges`、`mem_limit`、healthcheck。宿主数据目录需可写：
   `mkdir -p data && sudo chown -R 10001:10001 data`。
6. **Cookie Secure**：反代终结 TLS 时建议显式 `MERIDIAN_COOKIE_SECURE=1`，不依赖 XFP 判断。

## 五、环境变量

| 变量 | 默认 | 用途 |
|---|---|---|
| `MERIDIAN_ADDR` | `0.0.0.0:18420` | 监听地址；生产建议 `127.0.0.1:18420` 只给反代 |
| `MERIDIAN_TRUSTED_PROXIES` | 空 | 可信反代 CIDR（逗号分隔）；为空则忽略所有 XFF |
| `MERIDIAN_ALLOWED_ORIGINS` | 空 | CORS/CSRF 白名单（逗号分隔完整 Origin）；为空不启用跨域 |
| `MERIDIAN_COOKIE_SECURE` | 未设置（按请求 XFP 判断） | `1`=总是 Secure，`0`=从不 |
| `MERIDIAN_TURNSTILE_SECRET` | 空 | 配置后注册强制 Cloudflare Turnstile 校验 |
| `MERIDIAN_TURNSTILE_SITE_KEY` | 空 | Turnstile Site Key，通过 `/api/auth/config` 运行时下发给前端 |
| `MERIDIAN_TURNSTILE_SKIP_PEERS` | 空 | 直连免 Turnstile 的来源 peer CIDR（逗号分隔，如 `100.64.0.0/10`） |
| `MERIDIAN_TURNSTILE_SKIP_HOSTS` | 空 | 直连免 Turnstile 的 `Host` 白名单（逗号分隔）；同时配置时与 peer 取交集 |
| `MERIDIAN_ADMIN_EMAIL` / `MERIDIAN_ADMIN_PASSWORD` / `MERIDIAN_ADMIN_NICKNAME` | 空 | 可选：启动时幂等创建初始管理员（不要用弱口令） |

## 六、排障

| 现象 | 原因 | 处理 |
|---|---|---|
| `401 未登录：缺少会话 Cookie` | 浏览器没存/没发 Cookie。常见于：① Cookie 带 `Secure` 但站点跑在 HTTP；② 登录与访问的主机名不同（cookie 按 host 隔离）；③ 反代吞掉 Cookie 头 | 新版本按 `X-Forwarded-Proto` 自动判断；确认反代透传 `Cookie` 与 `X-Forwarded-Proto` |
| 登录 200，但进桌面后立刻报错回登录页 | 后端会话表没有这条 token（换了另一个 DB / 重启时清了库） | 确认启动时 `MERIDIAN_DB_PATH` 指向同一个库 |
| 一直提示「账号服务不可用」 | 跑的是旧后端二进制 | 重新 `cargo build` 并重启进程 |
| 登录突然 429，`cooldown_until` 在未来 | 该账号 5 次密码错误被锁定 5 分钟；或同 IP 登录频率超限 | 等待解锁；确认 `MERIDIAN_TRUSTED_PROXIES` 配置正确（否则所有反代后用户共享同一 peer IP） |
| 登录/注册偶发 503 | argon2 闸门等待超过 2s（CPU 被打满或哈希队列过长） | 降低并发/扩容；检查是否有异常注册洪峰 |
| 写请求 403「跨站请求被拒绝」 | `Origin` 不在 `MERIDIAN_ALLOWED_ORIGINS`，或浏览器发来 `Sec-Fetch-Site: cross-site` | 同源部署留空白名单；跨域部署填完整 Origin |
| 反代后所有人被计成同一个 IP | 未配置 `MERIDIAN_TRUSTED_PROXIES`，后端只看到反代 IP | 填反代所在网段（如 `127.0.0.1/32`），并确保反代覆盖写 XFF |

## 七、已知未做 / 遗留风险

- 未做 CSRF token（依赖 `SameSite=Lax` + Origin/`Sec-Fetch-Site` 校验）；
- 按账号锁定可被用来对**已知邮箱**做 5 分钟 DoS（代价是攻击者也需要制造 5 次失败）；
- 邮箱验证、找回密码、改邮箱、账号注销冷静期仍未做；
- 「首个注册者成为 admin」的开服引导仍在：公开部署前应先由管理员完成注册，或关闭注册入口；
- 管理员页 `/admin` 本身无页面级鉴权（数据接口已 admin-only）；
- `'unsafe-eval'` 是为 ConsolePanel 保留的；彻底方案是把玩家脚本执行搬到 Worker/沙盒 iframe 后收紧 CSP。

# 账号与会话（AUTH）

> 对应代码：`backend/crates/meridian-server/src/auth.rs`、`api.rs` 的账号段、`storage.rs` 的 users/sessions 表。
> 前端：`frontend/src/auth/AuthScreen.tsx`、`SessionGate.tsx`、`store/useSessionStore.ts`、`panels/SettingsPanel.tsx`。

## 一、数据模型

| 表 | 关键列 | 说明 |
|---|---|---|
| `users` | `email`(UNIQUE, NOCASE)、`nickname`(UNIQUE)、`pwd_hash`+`salt`、`role`、`status`、`company_id`(UNIQUE) | 一个账号绑定一家公司 |
| `sessions` | `token_hash`(UNIQUE)、`user_id`、`expires_at`、`last_seen_at`、`user_agent` | 只存 token 的 SHA-256，库里拿不到可用令牌 |

- 首个注册的账号自动获得 `role='admin'`，并**接管预置的 `player1` 公司**（保留开服经济，不必重开世界）。
- 后续账号的公司 id 为 `u<user_id>`，初始 10,000 信用点 + 起始脚本。
- 会话时长：普通 12 小时，「保持登录」14 天。

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

错误体统一为 `{message, field?, cooldown_until?}`，状态码 400/401/403/409/429。

## 三、安全决策

- **口令**：argon2id，默认参数 m=19 MiB / t=2 / p=1；哈希走 `spawn_blocking` 并受 `HASH_GATE`（1 个许可）串行化，2C 机器不会被打爆。
- **Cookie**：`HttpOnly; SameSite=Lax; Path=/`，默认带 `Secure`（`127.0.0.1`/localhost 属安全上下文，本地也能存）。
- **限流**：全站注册令牌桶（容量 5，2 次/分）+ 每 IP 注册 3 次/小时 + 每 IP 登录 10 次/分。内存实现，不需要 Redis。
- **Turnstile**：配置 `MERIDIAN_TURNSTILE_SECRET` 后强制校验（带 remoteip），未配置则跳过（本地开发）。
- **归属校验**：所有玩家态接口（state/scripts/memory/intent）必须以会话身份为准，跨账号 403；管理员可读任意公司。
- **管理员接口**：`/api/sim/control`、`/api/companies`、`/api/admin/overview` 仅 admin。
- **WebSocket**：握手要求会话 Cookie，首帧只给本人的 `state_response`，tick 广播只保留自己的 `player_outputs`（修掉全员 Memory 泄漏）。

## 四、环境变量

| 变量 | 默认 | 用途 |
|---|---|---|
| `MERIDIAN_COOKIE_SECURE` | `1` | 设 `0` 可在纯 HTTP 的非 localhost 环境调试 |
| `MERIDIAN_TURNSTILE_SECRET` | 空 | 配置后启用 Cloudflare Turnstile 服务端校验 |

生产部署务必让反代（Caddy/nginx）覆盖写 `X-Forwarded-For`，限流按该头取客户端 IP。

## 五、已知未做

- 邮箱验证（注册不验证，邮箱仅作联系方式）
- 找回密码 / 改邮箱
- CSRF token（当前依赖 `SameSite=Lax` + 同源 JSON 请求）
- 账号注销的冷静期（`status` 字段已预留）
- 管理员页 `/admin` 的页面级鉴权（数据接口已 admin-only）

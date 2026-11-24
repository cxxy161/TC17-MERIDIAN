# Meridian 线上实例黑盒安全探测报告（live-probe · 网络安全面）

- 目标：`http://100.84.136.78:18420/`（用户自有实例，本次审计已获授权；Lead 追加授权可做**有界**利用验证）
- 测试时间：2026-11-24 21:13–21:30 (Asia/Tokyo)
- 方式：黑盒 HTTP 观测为主 + 源码定位成因（只读，未改任何代码/配置）
- 请求总量：约 90 次，**全串行**，间隔 0.3–0.4s；仅 1 次受控等待实验（65s 空闲）+ 1 次 25s 等待
- 未做：DoS/压测/爆破真实账号/批量 ID 遍历/爬全站；**未做任何游戏经济写操作**
- 标注：**【实测】**=线上直接观测；**【推测】**=代码推导或需进一步验证；**【未测】**=受限未做
- **分工说明**：按 Lead 最新分工，本报告只覆盖①安全响应头 ②CORS ③限流绕过 ④/docs 与 assets 泄漏 ⑤HTTP 方法 ⑥health/错误信息量。
  IDOR/越权、CSRF/Content-Type、Cookie 属性与会话吊销、WebSocket 鉴权、路径穿越、超大 body 由 Lead 覆盖，本文仅在交叉必要时一句话引用（第 8 节列出移交项）。

---

## 0. 结论速览（本报告范围内的可行动项）

| # | 发现 | 严重度 | 依据 | 源码位置 |
|---|---|---|---|---|
| 1 | **限流可被 `X-Forwarded-For` 伪造完全绕过**（登录 10/分、注册 3/小时/IP 全部失效） | **High** | 实测（两组独立复现） | `auth.rs:287-295` |
| 2 | **无 XFF 时全部客户端共用同一限流桶 `"local"`** → 单一来源可打满 10 令牌，令**全站所有玩家登录 429**（自伤式 DoS） | **High** | 实测 + 源码 | `auth.rs:287-295` |
| 3 | 服务为**明文 HTTP**，且无 HSTS（会话 Cookie 因此无法带 `Secure`） | **High** | 实测 | `main.rs:111-115` |
| 4 | **零安全响应头**：CSP / X-Frame-Options / X-Content-Type-Options / Referrer-Policy / Permissions-Policy 全缺 | **Medium** | 实测（4 类路径全量 header dump） | `api.rs:56` 后无 headers 层 |
| 5 | CORS `*` 全开放（`ACAO/ACAM/ACAH/Expose-Headers: *`），但**未回 `Access-Control-Allow-Credentials`** | **Medium**（当前不可直接利用） | 实测（GET/POST/PUT 三组预检） | `api.rs:56 CorsLayer::permissive()` |
| 6 | 注册接口可枚举邮箱/昵称（409 + 字段名），叠加 #1 可批量探测 | **Medium** | 实测 | `api.rs:888-893` |
| 7 | 未知 `/api/*` 与任意路径（含 `.map`/`.git`/`.env`）统一 `200 + index.html` | **Low** | 实测 | `api.rs:60-62` |
| 8 | `/admin`、`/admin.html` 后台页面未登录公开（39,886B） | **Low** | 实测 | `api.rs:27,31-32` |
| 9 | `/api/health` 未鉴权暴露模拟内部指标（tick/cpi/paused/tick_ms/conservation_error/companies_count） | **Info** | 实测 | `api.rs:90-101` |
| 10 | 错误响应泄漏框架内部文案；403 回显用户输入的 `company_id`（text/plain，无 XSS） | **Info** | 实测 | — |

> 一句话：**边界比核心更薄**。传输入口（明文 + 无安全头）、限流（可伪造、可共享自锁）、CORS（全开）是本次黑盒面最实的三个问题；认证/授权核心逻辑不在我的范围，交叉抽测未发现异常。

---

## 1. 安全响应头【实测】

### 1.1 四类路径全量响应头（已滤掉 date/connection/content-length/last-modified 等噪声）

```
### GET /            （SPA index，536B）
HTTP/1.1 200 OK
content-type: text/html
accept-ranges: bytes
last-modified: Tue, 24 Nov 2026 12:01:49 GMT

### GET /docs/        （文档门户）
HTTP/1.1 200 OK
content-type: text/html

### GET /assets/main-BZPKFTsx.js   （876KB 前端主包）
HTTP/1.1 200 OK
content-type: text/javascript

### GET /api/health
HTTP/1.1 200 OK
content-type: application/json
vary: origin, access-control-request-method, access-control-request-headers
access-control-allow-origin: *
access-control-expose-headers: *
```

### 1.2 逐项判定

| 头 | 线上 | 风险 | 严重度 |
|---|---|---|---|
| `Strict-Transport-Security` | **缺失** | 明文部署下无意义，但一旦上 TLS 必须补，否则首次明文请求可被降级 | Medium |
| `Content-Security-Policy` | **缺失** | 无 XSS 的最后一道兜底；对"玩家可写脚本、前端渲染日志/脚本预览"的游戏尤其重要 | Medium |
| `X-Frame-Options` / CSP `frame-ancestors` | **缺失** | 任意站点可 iframe 套嵌 → 点击劫持；`/admin` 后台同样可被套（误触管理按钮） | Medium |
| `X-Content-Type-Options` | **缺失** | 允许 MIME 嗅探；`.js`/`.json` 可被嗅探为 HTML（需配合上传场景才可利用） | Low |
| `Referrer-Policy` | **缺失** | 点击站外链接泄漏完整路径（单页应用，价值低） | Low |
| `Permissions-Policy` | **缺失** | 未禁用 geolocation/camera 等 | Low |
| `Server` / `X-Powered-By` | **均无** | **正面**：未泄漏 axum/版本指纹 | — |
| `content-type` 的 charset | HTML/JS 均无 `charset`（依赖 `<meta charset>`） | Low（纯 HTTP 下 charset 混淆理论可行，未验证） | Info/Low |
| `Cache-Control` | **全站缺失**（静态、API、含 `Set-Cookie` 的登录响应都没有） | 见 1.3 | Low |

### 1.3 缓存头缺口

- 静态资源：仅有 `last-modified` + `accept-ranges`，**无 `Cache-Control`**；对 `main-BZPKFTsx.js` 这类**带哈希文件名**的资源本应 `immutable, max-age=31536000`（性能问题）。
- 登录/注册/登出响应：**无 `Cache-Control: no-store`** → 当前直连无共享缓存，风险为 0；若后续加 CDN/反代且未配置忽略 `Set-Cookie`，会话建立响应可能被缓存（**推测，需代理配置配合**）。
- 有 `Vary: origin, access-control-request-method, access-control-request-headers`（CORS 层带来的），对缓存友好，属加分项。

### 1.4 与源码对照

`main.rs:111-115` 直接 `axum::serve(TcpListener)`，进程内**无 TLS**、无任何 header 注入中间件（`main.rs:46` 默认 `0.0.0.0:18420`）；`deploy/docker-compose.yml` 只做 `18420:18420` 裸端口映射，没有 Caddy/nginx 反代 → 线上"零安全头"是**部署形态**决定的，不是漏配某一项。

**修复**：`tower_http::set_header::SetResponseHeaderLayer` 统一注入（CSP 建议 `default-src 'self'; script-src 'self'; object-src 'none'; frame-ancestors 'none'; base-uri 'none'`），反代补 `X-Frame-Options: DENY`（尤其 `/admin`）、`nosniff`、`Referrer-Policy: same-origin`；TLS 后加 `HSTS: max-age=31536000; includeSubDomains`。

---

## 2. CORS 实测【实测】

### 2.1 预检：POST `/api/auth/me`（读接口）

```
$ curl -X OPTIONS -H 'Origin: http://evil.example' \
       -H 'Access-Control-Request-Method: POST' \
       -H 'Access-Control-Request-Headers: content-type' \
       http://100.84.136.78:18420/api/auth/me
HTTP/1.1 200 OK
vary: origin, access-control-request-method, access-control-request-headers
access-control-allow-methods: *
access-control-allow-headers: *
access-control-allow-origin: *
allow: GET,HEAD
```

### 2.2 预检：PUT `/api/scripts/u2`（写接口）

```
$ curl -X OPTIONS -H 'Origin: https://attacker.example' \
       -H 'Access-Control-Request-Method: PUT' \
       -H 'Access-Control-Request-Headers: content-type' \
       http://100.84.136.78:18420/api/scripts/u2
HTTP/1.1 200 OK
access-control-allow-methods: *
access-control-allow-headers: *
access-control-allow-origin: *
```

### 2.3 简单请求：带 Origin 的普通 GET

```
$ curl -H 'Origin: http://evil.example' http://100.84.136.78:18420/api/health
HTTP/1.1 200 OK
access-control-allow-origin: *
access-control-expose-headers: *
```

### 2.4 判定

| 检查项 | 结果 |
|---|---|
| `Access-Control-Allow-Origin` | `*`（**不是**回显请求方 Origin） |
| `Access-Control-Allow-Methods` | `*`（PUT/DELETE/PATCH 全部放行） |
| `Access-Control-Allow-Headers` | `*` |
| `Access-Control-Expose-Headers` | `*`（响应头对跨域脚本全可读） |
| **`Access-Control-Allow-Credentials`** | **三组请求均未返回（无此头）** |
| 预检是否校验 Origin 白名单 | **否**，任意来源一律 200 + `*` |

### 2.5 可利用性（避免误报）

**当前不可直接利用**：浏览器对带凭据请求（`credentials: 'include'`）强制要求 `ACAO` 为**精确 Origin** 且 `ACAC: true`；服务端两者都不满足（`*` 且无 ACAC），响应被浏览器丢弃。再叠加会话 Cookie 为 `SameSite=Lax`（跨站 `fetch` 不带 Cookie），构成双重阻断。

**仍必须修**：
1. 任何第三方页面可**无凭据**读取公开 API（`/api/health`、`/api/catalog`、`/api/companies/{id}`）——信息聚合零成本；
2. 迁移风险极高：只要有人为"修前端跨域"加 `allow_credentials(true)`，立刻变成**任意站点可读受害者全部登录数据**（`/api/account` 含邮箱与会话列表）；
3. 预检不校验来源，无法充当任何一层防护。

**修复**：`CorsLayer::new().allow_origin([...自有域名...]).allow_methods([GET,POST,PUT,PATCH]).allow_headers([CONTENT_TYPE])`；**禁止** `permissive()`，**禁止** `*` 与 credentials 组合；确需公开 API 给第三方时，单独拆只含 GET 的路由层。

---

## 3. 限流实测与绕过（本报告最重的一组证据）

### 3.1 限流参数（源码）

```rust
// backend/crates/meridian-server/src/auth.rs:199-204
const GLOBAL_REGISTER_CAPACITY: f64 = 5.0;      // 全站注册令牌桶容量 5
const GLOBAL_REGISTER_RATE:     f64 = 2.0/60.0; // 2 次/分钟
const REGISTER_PER_IP_CAPACITY: f64 = 3.0;      // 每 IP 3 次/小时
const REGISTER_PER_IP_WINDOW:   f64 = 3600.0;
const LOGIN_PER_IP_CAPACITY:    f64 = 10.0;     // 每 IP 10 次/分钟
const LOGIN_PER_IP_WINDOW:      f64 = 60.0;
```
限流键来自 `client_ip()`，它**无条件信任请求头**：

```rust
// auth.rs:287-295
pub fn client_ip(headers: &HeaderMap) -> String {
    headers.get("x-forwarded-for")
        .and_then(|v| v.to_str().ok())
        .and_then(|v| v.split(',').next())      // ← 取最左值（客户端可任意写）
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| "local".to_string()) // ← 无 XFF 时全体共用 "local"
}
```

### 3.2 注册限流（3/小时/IP）实测序列

| # | 请求 | 状态 | 证据 |
|---|---|---|---|
| 1 | register `secaudit_a1@example.com`（无 XFF） | `200` | 建号成功，company `u2`，带 Set-Cookie |
| 2 | 同邮箱重复（无 XFF） | `409` | `该邮箱已注册`（**仍消耗配额**：限流在重复检查之前） |
| 3 | 同昵称重复（无 XFF） | `409` | `该昵称已被占用`（**仍消耗配额**） |
| 4 | register `secaudit_a2@...` + `X-Forwarded-For: 203.0.113.77` | **`200`** | **建号成功 company `u3` ← 绕过成立** |
| 5 | register（无 XFF） | `429` | `{"message":"该 IP 注册过于频繁，请稍后再试"}` |
| 6 | register + `X-Forwarded-For: 198.51.100.9` | `429` | `{"message":"全站注册频率已达上限，请稍后再试"}`（全站 5 令牌桶兜底） |

**结论**：第 4 次（伪造 XFF）在"本机 3 次配额已耗尽"（第 5 次 429 证明）的前提下仍 `200` → **per-IP 注册限制对攻击者无意义**；唯一实际约束是全站 5 令牌（2/分钟回填），攻击者只需等待即可持续建号。

### 3.3 登录限流（10/分/IP）绕过实测

| 阶段 | 请求 | 结果 |
|---|---|---|
| A | 第 1 次正确密码（无 XFF） | `200` + Set-Cookie（成功登录） |
| B | 第 2 次不存在邮箱（无 XFF） | `401` `邮箱或密码错误` |
| C | 第 3、4 次错误密码（无 XFF） | `401` |
| D | **第 5 次**（无 XFF） | **`429` `登录尝试过于频繁，请稍后再试`**（见 3.4 观测 A：桶已被他人共享消耗） |
| E | 第 6–11 次（无 XFF） | 多数 `429`，偶有 `401`（令牌按 1 个/6s 回填） |
| F | `X-Forwarded-For: 192.0.2.11 / .12 / .13` 三次错误密码 | **全部 `401`（无视限流）← 绕过确认** |

> 第 F 组是关键利用证据：在"本机已被 429 拦死"的状态下，仅改一个请求头即恢复无限次尝试。结合 3.2，**登录与注册的速率限制都可被单个请求头绕过**。

### 3.4 "无 XFF 时共享 `local` 桶"的实证

**源码**：无 XFF → 键恒为 `"local"`（`auth.rs:294`），与来源 IP 无关 → 所有无 XFF 的客户端（所有玩家浏览器直连、所有 curl 脚本）**共用一个桶**。

**观测 A（被动，实证跨客户端共享）**：21:16 那一轮从"桶应为满"的干净状态连续登录，**第 5 次即 429**（源码容量 10；我的请求间隔 0.35s 只回填 ~0.06 令牌）。即我开工前**已有约 6 个令牌被另一个同样不带 XFF 的客户端消耗**——只能是其他来源共用 `local` 桶。这是"共享"的直接证据。

**观测 B（主动，实证全局 429 窗口）**：空闲 65s 让桶按 10/60s 回填满后重测：
```
#1 21:20:40 -> 401   #6 21:20:44 -> 401
#2 21:20:40 -> 401   #7 21:20:45 -> 401
#3 21:20:41 -> 401   #8 21:20:45 -> 401
#4 21:20:42 -> 401   #9 21:20:46 -> 401
#5 21:20:43 -> 401   #10 21:20:47 -> 401
（10 次恰好用尽容量；此刻桶为空 → 任何其他无 XFF 客户端登录必得 429）
-- 等待 25s 后：401（令牌回填约 4 个，恢复正常）
```
即：**单个来源用 10 次/分钟的登录请求，即可让全站所有玩家（含管理员）的登录在随后 6–60 秒内持续 429**。虽只影响登录/注册（不影响已登录会话与游戏），但属单人可触发的可用性问题；若结合 argon2 串行闸门，影响面更大（见 3.5 推测）。

**观测 C（辅助）**：`X-Forwarded-For:`（空值）也会落到 `"local"`（`filter(|s| !s.is_empty())`），无法通过"清空头"规避共享。

### 3.5 影响评估

- **已实测**：登录限流可绕过 → 在线口令猜解**无速率上限**（仅受 argon2 计算时间与全站 CPU 约束）；注册限流可绕过 → 受全站 5 令牌约束。
- **已实测**：单来源可打满共享桶 → 全站登录 429（可反复触发）。
- **【推测，未压测】**：`HASH_GATE` 是全局并发 1 的信号量（`auth.rs:25`），argon2id 约 20ms/次（`auth.rs:4-5` 注释）；攻击者用伪造 XFF 无限投递登录请求可把哈希队列长期占满，使正常用户登录/注册排队超时——**CPU 侧慢速 DoS**。按纪律**未做压测验证**，列为待验证项。
- **不涉及**：已登录用户的会话与游戏内操作不受该限流影响（bucket 仅用于 login/register）。

### 3.6 修复建议（按优先级）

1. **不要**信任客户端可写的 `X-Forwarded-For` 最左值。要么（a）改用 `ConnectInfo<SocketAddr>` 的真实 peer IP 作限流键；要么（b）仅在 peer 属于可信反代网段时采信 XFF，且**从右往左**取第一个非可信地址。
2. 部署反代（Caddy）并由反代**覆写**（不是追加）`X-Forwarded-For`——源码注释 `auth.rs:286` 已写明该前提，但当前部署没有反代，前提不成立。
3. 登录/注册增加**按账号维度**（邮箱/用户 id）的独立限流与失败退避，避免"换 IP/换头即无限制"。
4. 兜底键不要用常量字符串，应由 `peer_addr` 派生。
5. 注册重复检查前置到限流之前（或对 409 单独小额计数），避免失败的注册吃掉真实用户配额。

---

## 4. /docs 门户与 assets 泄漏评估

| 检查 | 请求 | 结果 | 判定 |
|---|---|---|---|
| `/docs/` | GET | `200`，847B，纯静态 SPA（`<title>Meridian 脚本 API</title>`，加载 `/assets/docs-ueNYiMfs.js`） | 无后端文档暴露 ✅ |
| 文档内容包 `/assets/DocView-DnpY20e6.js` | GET | `200`，257,365B | 见下 |
| 文档内容检索 | grep | `/api/` 命中 **0**；`admin` 命中 **0**；`Bearer`/`sk-` 命中 **0**；`SECRET` 4 处**全是 React 内部字段** `__SECRET_INTERNALS_DO_NOT_USE_OR_YOU_WILL_BE_FIRED`；`password` 2 处是 DOM input type 表 | **未泄漏内部接口/密钥** ✅（Info） |
| 文档暴露的脚本 API | grep | `Game.*` 20+（`Game.market.createOrder/deal/cancelOrder`、`Game.buildFacility`、`Game.buyPlot`、`Game.bank`…），属预期公开的玩家脚本 API | 正常 |
| **sourcemap** | GET `/assets/main-BZPKFTsx.js.map`、`DocView-*.js.map`、`docs-*.js.map` | 三者全 `200` 但 **`size=536`、`content-type: text/html`** = 落回 SPA index.html；主包内 `sourceMappingURL` 命中为空 | **源码映射未暴露** ✅（200 为假成功，见 6.3） |
| 前端主包 `/assets/main-BZPKFTsx.js` | GET | `200`，876,626B | 见下 |
| 主包内接口清单 | grep | `/api/account`、`/api/account/password`、`/api/account/sessions/revoke`、`/api/auth/{login,logout,me,register}`、`/api/catalog`、`/api/companies`、`/api/intent`、`/api/sim/control` 等 | **注意**：公开前端包里出现 `/api/sim/control`（管理端接口名）→ 攻击面枚举成本为零（Info） |
| 主包内密钥检索 | grep | 无 `sk-`/`Bearer`；`MERIDIAN_UI_ERROR` 1 处为 localStorage 键名 | 无硬编码密钥 ✅ |
| 目录列举 | GET `/assets/` | `200` 但返回 536B index.html | 无目录列表 ✅ |
| `.git/config`、`.env` | GET | `200` 536B，**md5 与 `/index.html` 完全相同**（`f257ed5a`） | 非真实文件，未泄漏 ✅ |

**小结**：文档站与静态资源**没有**源码映射、内部接口或密钥泄漏；值得记录的是"管理端 API 路径出现在公开 bundle"（Info）与"不存在的资源都返回 200 HTML"（Low，见 6.3）。

---

## 5. HTTP 方法行为【实测】

| 方法 | 目标 | 状态 | 响应头 | 说明 |
|---|---|---|---|---|
| GET | `/`、`/docs/`、`/api/health` | 200 | 见第 1 节 | 正常 |
| HEAD | `/api/state` | `401` | — | 鉴权在 HEAD 上同样生效 ✅ |
| OPTIONS | `/api/state`、`/api/auth/me`、`/api/scripts/u2` | `200` | `ACAM/ACAH/ACAO: *` + `allow: GET,HEAD` | CORS 层直接短路（第 2 节） |
| OPTIONS | `/`（静态） | `405` | `allow: GET,HEAD` | 静态服务不处理 OPTIONS（与 API 的 200 不一致，Info） |
| PUT | `/api/state` | `405` | `allow: GET,HEAD` | ✅ 未定义方法被正确拒绝 |
| DELETE | `/api/state` | `405` | `allow: GET,HEAD` | ✅ |
| POST | `/api/state` | `405` | `allow: GET,HEAD` | ✅ |
| PATCH | `/api/state` | `405` | `allow: GET,HEAD` | ✅（`/api/account` 是唯一 PATCH 路由，属预期） |
| TRACE | `/` | `405` | `allow: GET,HEAD` | ✅ 无 TRACE 回显（XST 不成立） |
| POST | `/api/sim/control`（无 Cookie，`action:noop-probe`） | `401` | — | 未登录即被拦，未触及业务逻辑 |

**结论**：方法级行为正确，无方法覆盖/绕过；瑕疵是"OPTIONS 在静态路径 405、在 API 路径 200"，以及 405 响应体为空（无错误说明）。

---

## 6. `/api/health` 与错误响应信息量

### 6.1 `/api/health`（未鉴权，`200`）

```json
{"ok":true,"tick":291,"cpi":3.342401300170805,"paused":false,
 "tick_ms":1000,"conservation_error":0,"companies_count":73}
```
- 暴露：世界 tick（可推算运行时长/**重启时刻**）、CPI、是否暂停、模拟步长、经济守恒误差、公司总数。
- 影响：攻击者可无成本监控服务器状态与重启窗口（tick 归零）；也能推断经济规模。属**情报级**泄漏（Info）。
- 源码：`api.rs:67-76 HealthResp` / `api.rs:90-101`；与线上字段、顺序完全一致。
- 建议：拆 `/api/health`（仅 `{"ok":true}`）+ 内网 `/api/admin/health`（详细指标）；或至少去掉 `conservation_error`、`companies_count`。

### 6.2 错误响应信息量

| 场景 | 状态 | 响应体 | 评价 |
|---|---|---|---|
| 未登录 | `401` | `未登录：缺少会话 Cookie`（text/plain, 31B） | 文案精确但**不泄漏账号存在性**，可接受 |
| 会话无效/过期 | `401` | `会话无效或已过期` / `会话已过期` | 区分两种状态（可判断 token 是否"曾经有效"），Info |
| 越权 | `403` | `公司 'u3' 不属于当前账号` | **回显用户输入**的 company_id；响应为 `text/plain; charset=utf-8` → 无 HTML 上下文，**不构成反射 XSS**；可用于确认公司存在（配合已公开的 `/api/companies/{id}` 价值有限） |
| 非管理员 | `403` | `需要管理员权限` | 明确，可接受 |
| 方法不允许 | `405` | **空体** | 无说明，客户端调试困难（Low） |
| 畸形 JSON | `400` | `Failed to parse the request body as JSON: expected ident at line 1 column 2` | **泄漏框架内部文案**（axum/serde），Info；建议统一为 `请求格式错误` |
| 登录失败 | `401` | `{"message":"邮箱或密码错误"}`（不存在邮箱与错误密码**完全一致**） | ✅ 防枚举（Lead 已覆盖，交叉引用） |
| 注册冲突 | `409` | `{"message":"该邮箱已注册","field":"email"}` | ❌ **可枚举**（3.2 已述） |
| 限流 | `429` | 登录/注册不同文案，且区分"per-IP 过于频繁"与"全站已达上限" | 泄漏限流策略细节（Info） |

### 6.3 未知路径：SPA fallback 吞掉 404

```
$ curl -sS -o /tmp/b -w '%{http_code} %{size_download}\n' http://100.84.136.78:18420/api/nonexistent-route-991
200 536                    # body 是 index.html（text/html）
```
- 任何不存在的路径（`/api/*`、`/.git/config`、`/.env`、`*.js.map`、`/assets/`）都返回 `200 + index.html`。
- 影响：① 监控/客户端无法区分"路由不存在"与"成功"，API 错误被静默当成解析失败；② 扫描工具无法据此判断真实路由（对攻击者算轻微阻碍，对运维是噪声）；③ 掩盖真实 404，排障成本高。
- 源码：`api.rs:60-62` `ServeDir::new(dir).fallback(ServeFile::new(index))` 挂最外层，对 `/api/*` 同样生效。
- 建议：`/api/*` 前缀单独挂 JSON 404（`{"error":"not_found"}`），仅非 API 路径走 SPA fallback。

### 6.4 `/admin` 静态页（补充，属④相邻）

- `GET /admin`、`/admin.html` → `200`，**39,886B 完整管理后台 HTML**，未登录即可获取（仅后台 API 有鉴权）。
- 源码：`api.rs:27` `include_str!("../assets/admin.html")`、`api.rs:31-32` 路由无提取器。
- 影响：暴露后台功能清单与调用方式，降低攻击者侦察成本（Low）；`/admin` 也是点击劫持的最佳目标（见 1.2）。
- 建议：给页面加 `AdminUser` 鉴权（或至少登录态），并 `X-Frame-Options: DENY`。

---

## 7. 本范围（①–⑥）可行动清单

| 优先级 | 动作 | 关联 |
|---|---|---|
| **P0** | 限流键改真实 peer IP（或可信反代 + 从右取 XFF）；登录增加按邮箱维度退避；兜底键不用常量 `"local"` | 3.2–3.6 |
| **P0** | 前置 TLS（Caddy/nginx）+ `Secure` Cookie + HSTS；否则任何明文链路上的会话都可被截获 | 1.1–1.4 |
| **P1** | 统一注入安全头（CSP、XFO/frame-ancestors、nosniff、Referrer-Policy）；`/admin` 单独收紧 | 1.2 / 6.4 |
| **P1** | CORS 从 `permissive()` 改显式白名单，禁止 `*` + credentials 组合 | 2.5 |
| **P2** | 注册重复提示统一文案（现为免费账号枚举 API） | 3.2 / 6.2 |
| **P2** | `/api/*` 未匹配路由返回 JSON 404；404/405 带结构化错误体 | 6.3 |
| **P3** | `/api/health` 拆分公开/内部字段；错误文案去框架化；静态资源补 `Cache-Control` | 6.1 / 6.2 / 1.3 |

---

## 8. 未测 / 受限 / 已移交

**已移交 Lead（不在本报告范围，避免重复）**：IDOR/越权、CSRF 与 Content-Type 限制、Cookie 属性与会话吊销、WebSocket 鉴权、路径穿越、超大 body。
（交叉引用保留的最小事实：未登录访问受保护接口一律 401、明显越权 403、登出即失效、`/ws` 无 Cookie 为 401。）

**本节未测**：
- 压测/并发/DoS 验证（含 3.5 的 argon2 队列耗尽，仅推测）；
- 真实玩家账号口令猜解（未对任何真实账号尝试；限流实验只用自有测试账号的错误密码）；
- 批量公司 ID 遍历（仅 1 个对照值 `u3`）；
- CDN/共享缓存场景下的会话响应缓存（当前部署无此组件）；
- 前端存储型 XSS（属前端源码审计，且避免污染线上数据）。

**测试账号残留（需清理或保留作回归）**：

| 邮箱 | 昵称 | company_id | 备注 |
|---|---|---|---|
| `secaudit_a1@example.com` | `sec_audit_1` | `u2` | 密码 `Sx7#tQm2-Vr9pL4z`；1 个普通会话 + 1 个 14 天持久会话（remember 实测用） |
| `secaudit_a2@example.com` | `sec_audit_2` | `u3` | 同上；此账号即"XFF 绕过注册限流"的产物 |

两账号**未做任何游戏内写操作**（无下单/生产/改脚本），仅有系统自动分配的初始公司。

---

## 附：关键复现命令

```bash
B=http://100.84.136.78:18420

# ① 响应头（全量）
curl -sS -D - -o /dev/null "$B/"
curl -sS -D - -o /dev/null "$B/api/health"

# ② CORS：预检（读/写两种）
curl -X OPTIONS -H 'Origin: http://evil.example' \
     -H 'Access-Control-Request-Method: POST' -H 'Access-Control-Request-Headers: content-type' \
     "$B/api/auth/me"
curl -X OPTIONS -H 'Origin: https://attacker.example' \
     -H 'Access-Control-Request-Method: PUT' -H 'Access-Control-Request-Headers: content-type' \
     "$B/api/scripts/u2"

# ③ 限流绕过：注册（per-IP 3/小时）
curl -X POST -H 'Content-Type: application/json' -H 'X-Forwarded-For: 203.0.113.77' \
     -d '{"email":"secaudit_a2@example.com","nickname":"sec_audit_2","password":"Sx7#tQm2-Vr9pL4z"}' \
     "$B/api/auth/register"                       # 200（无 XFF 时应 429）

# ③ 限流绕过：登录（10/分）——429 后换头即恢复
curl -X POST -H 'Content-Type: application/json' \
     -d '{"email":"secaudit_a1@example.com","password":"wrong"}' "$B/api/auth/login"        # 可能 429
curl -X POST -H 'Content-Type: application/json' -H 'X-Forwarded-For: 192.0.2.11' \
     -d '{"email":"secaudit_a1@example.com","password":"wrong"}' "$B/api/auth/login"        # 401

# ④ 门户/资源：sourcemap 与 .git/.env 均落 SPA fallback
curl -sS -o /dev/null -w '%{http_code} %{size_download}\n' "$B/assets/main-BZPKFTsx.js.map"   # 200 536
curl -sS -o /dev/null -w '%{http_code} %{size_download}\n' "$B/.git/config"                   # 200 536
curl -sS -o /dev/null -w '%{http_code} %{size_download}\n' "$B/assets/main-BZPKFTsx.js"       # 200 876626

# ⑤ 方法矩阵
for m in POST PUT DELETE PATCH OPTIONS HEAD TRACE; do
  curl -sS -o /dev/null -w "$m %{http_code}\n" -X "$m" "$B/api/state"
done

# ⑥ 错误信息与 fallback
curl -sS -D - -X POST -H 'Content-Type: application/json' -d 'not-json{' "$B/api/auth/register"
curl -sS -o /dev/null -w '%{http_code} %{size_download}\n' "$B/api/nonexistent-route-991"     # 200 536
```

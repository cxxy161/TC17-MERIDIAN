# Meridian 前端安全审计：XSS / 令牌处理 / CSP / 文档门户

> 审计对象：`frontend/`（React 18 + TypeScript + Vite 6 SPA）、`frontend/docs/`（独立 API 文档页）、
> 前端交付物 `frontend/dist/`，以及后端对静态资源与鉴权 Cookie 的下发方式（仅在与前端相关处引用）。
> 线上实例：`http://100.84.136.78:18420/`（用户自有，本次审计已授权）。审计方式：**只读**，未修改任何源码/配置。
> 审计人：frontend-sec（task-4）｜时间：2026-11-24
> 说明：文中「已确认」= 有源码行号或命令响应直接支撑；「推测」= 依赖运行时/浏览器行为，需在线或动态验证。

---

## 0. 结论摘要

| # | 结论 | 严重度 | 状态 |
|---|---|---|---|
| F-01 | 生产构建里 Turnstile site key 恒为空字符串，注册人机验证在线上实际处于「未配置」状态（构建产物可证） | **Medium** | 已确认（构建产物）；建议在线复核页面表现 |
| F-02 | 全站无任何 CSP（HTML 无 meta、后端无响应头、线上响应头为空），缺少 XSS 纵深防御 | **Medium** | 已确认（源码 + 线上响应头） |
| F-03 | 无 `X-Frame-Options` / `frame-ancestors`，存在点击劫持面（SameSite=Lax 已大幅缓解） | Low | 已确认头缺失；影响为推测 |
| F-04 | 无 `X-Content-Type-Options: nosniff`、`Referrer-Policy`、HSTS | Low | 已确认 |
| F-05 | 游戏内「F12 交互控制台」用 `new Function` 在页面主世界执行任意 JS（自 XSS / pastejacking 面，并使严格 CSP 无法落地） | Low | 已确认 |
| F-06 | WebSocket 升级不做 Origin 校验；全站 `CorsLayer::permissive()`：CSRF/CSWSH 防护完全依赖 `SameSite=Lax` | Low（条件性 High） | 代码已确认；实际利用为推测 |
| F-07 | 会话 Cookie 无 `__Host-` 前缀，线上为明文 HTTP 部署时 `Secure` 不生效 | Low | 已确认 |
| F-08 | 前端仍保留 `currentCompanyId = 'player1'` 兜底默认值 | Info | 已确认（服务端 `ensure_owner` 兜底） |
| F-09 | ErrorBoundary 把 `error.stack` / componentStack 直接渲染到页面与 console | Info | 已确认 |
| F-10 | 面板布局/脚本目录持久化在 localStorage，读取时 `JSON.parse` 不做形状校验 | Info | 已确认 |

**正向结论（未发现的问题，同样是审计产出）**

- **未发现任何 HTML 注入 sink**：全仓库 `dangerouslySetInnerHTML` / `innerHTML` / `outerHTML` / `insertAdjacentHTML` / `document.write` / `<iframe>` / `postMessage` / `javascript:` 均为 **0 处**（grep 见附录 E-6）。所有动态文本（昵称、公司名、脚本代码、日志、错误 message、物品名）都走 React 文本子节点，默认转义。
- **令牌不落前端存储**：会话仅 `HttpOnly; SameSite=Lax` Cookie；`localStorage` 只存 UI 偏好（工作区布局、脚本目录），无 token / 无用户凭据。
- **WS 鉴权不用 query token**：``new WebSocket(`${proto}//${location.host}/ws`)`` 不带任何凭据参数，后端用同一 Cookie 的 `AuthUser` 提取器鉴权，不会出现 token 进访问日志/Referer 的问题。
- **文档门户不可注入**：`/docs/` 的正文数据全部是编译期静态 TS 常量，渲染器为纯 React 元素拼装；`#hash` 只用作 `DOC_BY_ID` 白名单查表，不落 HTML。
- **DEV 直通后门已被 tree-shaken**：生产 bundle 中 `onDevBypass:void 0`，`import.meta.env.DEV` 分支不可达。
- **dist 无 sourcemap、无硬编码密钥/内网地址**。
- **管理能力未打包进 SPA bundle**（`/admin` 是后端内嵌的独立 HTML；`/api/admin/*`、`/api/sim/control`、`POST /api/companies` 均由 `AdminUser` 提取器把关）。

---

## 1. XSS

### 1.1 渲染面盘点（结论：无破例点）

| 用户可控数据 | 渲染位置 | 方式 | 判定 |
|---|---|---|---|
| 昵称 nickname | `frontend/src/layout/DesktopShell.tsx:153`、`frontend/src/panels/SettingsPanel.tsx:431` | React 文本节点 | 安全 |
| 公司名 / 他司公开详情 | `frontend/src/panels/CompanyPanel.tsx:129`、`frontend/src/panels/RankingPanel.tsx:68` | React 文本节点 | 安全 |
| 脚本源码 | CodeMirror 受控值（`panels/ScriptIdePanel.tsx`） | 非 DOM 注入 | 安全 |
| 脚本 console 日志 / 错误 message | `frontend/src/panels/ConsolePanel.tsx:249-282` | `toConsoleValue` → React 节点 | 安全 |
| 服务端错误 message | `frontend/src/auth/AuthScreen.tsx:293`、`panels/SettingsPanel.tsx` ErrorBox | React 文本节点 | 安全 |
| 物品 id/name（catalog，服务端下发） | `frontend/src/docs/DocView.tsx:363-403`、各面板 | React 文本节点 | 安全 |
| URL 参数 | 无渲染点：SPA 无 query 路由；仅 `docs` 用 `location.hash` | 白名单查表 | 安全 |

证据：`grep -rn "dangerouslySetInnerHTML|innerHTML|outerHTML|insertAdjacentHTML" frontend/src` → **0 匹配**；
`grep -rn "postMessage|<iframe|srcdoc|javascript:" frontend/src` → **0 匹配**。
唯一动态 `href` 为 `frontend/src/docs/DocView.tsx:584`：`'/docs/#' + encodeURIComponent(entry.id)`，`entry.id` 来自静态文档常量，且经过 `encodeURIComponent`，无 `javascript:` 注入空间。

### 1.2 F-05 页内任意 JS 执行（ConsolePanel）

```ts
// frontend/src/panels/ConsolePanel.tsx:392
const fn = new Function('Game', 'Memory', 'console', `${preamble}\nreturn (${raw});`);
// frontend/src/panels/ConsolePanel.tsx:395（表达式失败后回退为语句形式）
const stmtFn = new Function('Game', 'Memory', 'console', `${preamble}\n${raw}`);
```

- `raw` 只来自用户自己在输入框敲入的内容（`ConsolePanel.tsx:457-485`），**不存在把他人数据/服务端数据当代码执行的路径**，因此归类为 **self-XSS / pastejacking** 而非存储型 XSS：诱导玩家粘贴一条命令即可在当前会话上下文里 `fetch('/api/intent', …)`、读 `Game`/`Memory`、改 Memory（`ConsolePanel.tsx:399-402` 会把变更 `PUT /api/memory/{company_id}` 回服务端）。
- 连带影响：`new Function` 需要 `'unsafe-eval'`，因此 **只要控制台保留，就不可能落地严格 CSP**（F-02）。
- 注入面复核（共因排查）：preamble 由 catalog 拼字符串（`ConsolePanel.tsx:18-39`），常量名经 `/^[A-Za-z_$][A-Za-z0-9_$]*$/` 过滤、值经 `JSON.stringify` 转义，**未发现可通过服务端 catalog 注入代码**的路径。

**建议**：保留功能但降低杠杆——① 输入框粘贴时二次确认（`onPaste` 拦截 + 提示「该命令将以你的身份执行」）；② 若要上 CSP，把控制台改为「发到服务端沙盒执行后回显」；③ 至少在控制台顶部提示「勿粘贴他人给的命令」。

### 1.3 其余 XSS 相关面

- F-09 ErrorBoundary（`frontend/src/App.tsx:20-34`）把 `error.message`、`error.stack`、`componentStack` 渲染进 DOM 并 `console.error`。渲染是 React 文本节点，**不可注入**；风险仅为信息暴露（内部组件名/构建产物路径），并且抛错时页面会整体替换成堆栈界面（可用性）。建议生产环境只显示错误码 + 折叠详情。
- F-10 `localStorage` 读取：`frontend/src/layout/workspaces.ts:183-196`（`JSON.parse` 后只校验 `Array.isArray` 与 `parsed[0].tree`）、`frontend/src/store/useGameStore.ts:61-72`（`Array.isArray` + 元素类型过滤）。形状校验偏弱，但 localStorage 属同源可写区，能写的前提已经是同源 XSS；判定 **Info**，建议加 schema 校验（zod 或手写 guard）避免脏数据导致渲染异常。

---

## 2. 令牌处理（会话 / WS / 泄漏面）

### 2.1 结论：令牌完全不在 JS 可读范围

| 检查点 | 证据 | 结论 |
|---|---|---|
| 会话载体 | 后端 `backend/crates/meridian-server/src/auth.rs:143-153`：`meridian_sid=…; Path=/; HttpOnly; SameSite=Lax`（可持久化时加 `Max-Age`；`Secure` 由 `auth.rs:130-141` 按 `X-Forwarded-Proto` 或 `MERIDIAN_COOKIE_SECURE` 决定） | 仅 HttpOnly Cookie |
| 前端如何带上 | `frontend/src/api/client.ts:14`、`:39`：`fetch(url,{ credentials:'same-origin' })` | 浏览器自动带 Cookie，JS 不接触 token |
| localStorage/sessionStorage | `frontend/src/layout/workspaces.ts:10-11`（`meridian.split_workspaces.v4`、`meridian.active_split_workspace.v4`）、`frontend/src/store/useGameStore.ts:59`（`meridian.script_folders.v1`） | 只有 UI 偏好，无 token |
| `document.cookie` | `grep -rn "document.cookie"` → 0 | 未使用 |
| WebSocket 鉴权 | `frontend/src/store/useGameStore.ts:176`：``new WebSocket(`${proto}//${window.location.host}/ws`)``；后端 `api.rs:667-674` 用 `user: AuthUser` 提取器 | Cookie 鉴权，**无 query token** |
| `Authorization` / Bearer | grep → 0 | 未使用 |
| token 进 URL | grep `token=` → 0（仅注册体 `turnstile_token` 字段，`client.ts:133`） | 无 |
| token 进 console | 全前端唯一 `console.*` 为 `frontend/src/App.tsx:22` 的错误日志（不含凭据） | 无 |
| `meridian_sid` 是否出现在 bundle | `grep -c meridian_sid frontend/dist/assets/*.js` → 全部 **0** | 未泄漏 |

### 2.2 F-06 WS 无 Origin 校验 + CORS permissive（与后端共因）

- 后端整个 router 加了 `CorsLayer::permissive()`（`backend/crates/meridian-server/src/api.rs:56`），WS 升级处理（`api.rs:667-722`）`grep -i origin` → **0**，即不校验 `Origin`。
- 当前实际风险被 `SameSite=Lax` 压住：跨站页面发起的子资源请求/WS 握手不会携带 Lax Cookie，因此 CSRF 与跨站 WebSocket 劫持（CSWSH）**大概率失败**（这一点属推测，取决于浏览器对 WS 握手的 SameSite 判定）。
- 但这是**单点防护**：一旦为了多端/反代把 Cookie 改成 `SameSite=None`（同时必须加 `Secure`），CSRF 立即成立且没有任何 token/Origin 兜底。历史审计（`docs/MULTIPLAYER_AUDIT.md` P0#1）已记录 permissive CORS，目前仍在。
- **建议**：Cookie 保持 Lax 的同时，给状态变更接口加 Origin/Referer 白名单校验（或双提交 CSRF token）；WS 升级校验 `Origin` 与 `Host` 一致。这条应转后端组确认。

### 2.3 F-07 部署层 Cookie 属性

- 线上为 `http://100.84.136.78:18420/`（明文 HTTP），`cookie_secure()` 在无 `X-Forwarded-Proto: https` 时返回 false → 会话 Cookie **没有 `Secure`**（`auth.rs:130-141`）。当前链路在 Tailscale 内（WireGuard 加密），风险有限；若将来暴露到公网/非加密链路，会话可被中间人窃取。
- Cookie 名为 `meridian_sid`，非 `__Host-` 前缀；`Path=/` 意味着同一 Cookie 也会发给 `/docs/` 等静态路径（无实际危害，仅扩大暴露面）。
- **建议**：上 TLS 反代后设 `MERIDIAN_COOKIE_SECURE=1`；改用 `__Host-meridian_sid`（需 `Secure` + `Path=/` + 无 Domain）。

---

## 3. CSP 与安全响应头（F-02 / F-03 / F-04）

### 3.1 证据

- 入口 HTML 无任何 CSP/meta：`frontend/index.html:1-12`、`frontend/docs/index.html:1-17`（构建产物 `frontend/dist/index.html`、`frontend/dist/docs/index.html` 同样没有）。
- 后端未下发任何安全头：`backend/crates/meridian-server/src/api.rs:29-65` 的 `build_router` 只有 `CorsLayer::permissive()`，无 `SetResponseHeaderLayer`；全仓库 `grep -rIn "Content-Security-Policy|X-Frame-Options|frame-ancestors"`（排除 node_modules/target）→ **0 匹配**；仓库内也没有 nginx/Caddy 配置。
- 线上实测（只读单次请求）：

```
$ curl -s -I --max-time 12 http://100.84.136.78:18420/
HTTP/1.1 200 OK
content-type: text/html
accept-ranges: bytes
last-modified: Tue, 24 Nov 2026 12:01:49 GMT
content-length: 536
date: Tue, 24 Nov 2026 12:14:46 GMT
```

→ 无 `Content-Security-Policy`、无 `X-Frame-Options`、无 `X-Content-Type-Options`、无 `Referrer-Policy`、无 `Strict-Transport-Security`、无 `Permissions-Policy`。

### 3.2 影响与建议策略

- 没有任何 HTML 注入 sink 的当下，缺 CSP 属**纵深防御缺失**（Medium）：本应用包含玩家可写脚本、日志流、跨玩家公开数据（公司名/榜单），一旦将来引入一个 `dangerouslySetInnerHTML` 或第三方小部件，没有第二道防线。
- 落地建议（需先处理 F-05，否则 `'unsafe-eval'` 会吃掉大半收益）。推荐基线（后端 `SetResponseHeaderLayer` 统一加，或反代加）：

```
Content-Security-Policy:
  default-src 'self';
  script-src 'self' https://challenges.cloudflare.com 'unsafe-eval';  /* 'unsafe-eval' 仅因 ConsolePanel，移除后请删掉 */
  style-src 'self' 'unsafe-inline';                                    /* React 内联 style + Tailwind */
  img-src 'self' data: blob:;
  connect-src 'self' ws: wss:;
  frame-ancestors 'none';
  base-uri 'none';
  object-src 'none';
  form-action 'self'
X-Content-Type-Options: nosniff
Referrer-Policy: strict-origin-when-cross-origin
X-Frame-Options: DENY                    /* 兼容老浏览器，与 frame-ancestors 并存 */
Permissions-Policy: geolocation=(), microphone=(), camera=()
```

- 注意：`connect-src` 必须含 `ws:`/`wss:`，否则 `/ws` 会被拦；`script-src` 含 Cloudflare 是因为登录页动态插 `https://challenges.cloudflare.com/turnstile/v0/api.js`（`frontend/src/auth/AuthScreen.tsx:35-49`）。
- 点击劫持（F-03）：加 `frame-ancestors 'none'` 即可；在当前 SameSite=Lax 下已很难借助 iframe 完成已鉴权操作，属加固项。

---

## 4. 文档门户 `/docs/`

**结论：数据全静态、渲染安全、按设计免登录；不构成注入面。**

| 检查点 | 证据 | 结论 |
|---|---|---|
| 数据来源 | `frontend/src/docs/apiDocs.ts:1-40` 由 `docs/data/*.ts` 静态数组拼装；无 fetch 拉取正文 | 静态，无服务端可控正文 |
| 渲染方式 | `frontend/src/docs/DocView.tsx:38-64`（`Inline` 只处理 `code`/`**bold**`，返回 React 元素）、`:100-108`（`<pre>{code}</pre>`） | 纯 React，无 innerHTML |
| hash 处理 | `frontend/src/docs/DocsPage.tsx:12-20` `decodeURIComponent` → `:40-43` `findEntry` 只做 `DOC_BY_ID[id]` 白名单查表（`apiDocs.ts:40-43`） | 任意 hash 只会命中常量或回落默认页 |
| `document.title` | `DocsPage.tsx:49-51`，值来自 `docTitle()`（白名单标题） | 非 HTML 上下文，安全 |
| 唯一外部数据 | `DocsPage.tsx:33-47` `fetch('/api/catalog')` 取物品表，渲染为常量 chip（`DocView.tsx:363-403`） | 文本渲染，安全 |
| 是否绕过登录 | 「无需登录」是设计（`DocsPage.tsx:8` 注释、`frontend/vite.config.ts:5-7` 两个 HTML 入口、后端 `api.rs:58-63` `ServeDir` 静态托管无鉴权层） | 按设计公开 |

线上验证（各 1 次请求）：

```
$ curl -s -o /dev/null -w "%{http_code} %{size_download}\n" http://100.84.136.78:18420/docs/
200 847
$ curl -s -o /dev/null -w "%{http_code} %{size_download}\n" http://100.84.136.78:18420/api/auth/me
401 31
```

→ `/docs/` 未登录可读（设计如此），游戏 API 需登录。
附带一条 Info：`/api/catalog` 无鉴权（`api.rs:103` `catalog_handler` 无 `AuthUser`），文档页正是靠它渲染物品常量；若 catalog 被视为业务情报，需要与后端组确认是否收紧（收紧后文档页的「当前世界物品常量」区块会退化为空，属可接受降级，`DocsPage.tsx:41-43` 已 catch）。

---

## 5. 依赖版本与已知 CVE（离线判断，未联网核验）

`frontend/package.json:12-36` 声明，`package-lock.json` 实际解析：

| 包 | 声明 | 实际锁定 | 离线评估 |
|---|---|---|---|
| react / react-dom | ^18.3.1 | 18.3.1 | 无高危 XSS CVE |
| vite | ^6.0.11 | **6.4.6** | 已越过 2025 年 dev-server 文件读取系列修复线（CVE-2025-30208 / 31125 / 31486 / 32395 / 46565 等修复于 6.2.6～6.3.x），当前版本不命中 |
| esbuild（vite 传递） | — | 0.25.12 | 已越过 GHSA-67mh-4wv8-2f99（dev server 任意源请求）修复线 0.25.0 |
| dockview-react | ^4.11.0 | 4.13.1 | 未召回高危 CVE |
| lightweight-charts | 4.2.1（精确） | 4.2.1 | 未召回高危 CVE |
| zustand | ^5.0.3 | 5.1.0 | 无 |
| @codemirror/view | ^6.36.2 | 6.43.15 | 无 |

注意事项：上表 Vite/esbuild 的 CVE 全部是 **dev server（`vite dev`）** 面，本实例是静态构建产物，生产不暴露 Vite dev server，故即便命中也是 Low；`vite.config.ts:19-31` 的 `/api`、`/ws` 代理只在本地开发时存在。
另一条与供应链相关：登录页从 `https://challenges.cloudflare.com` 动态插入第三方脚本（`AuthScreen.tsx:35-49`），无 SRI、无 nonce（动态插入也无法用静态 SRI），加载失败会静默隐藏验证（`AuthScreen.tsx:81` → `:108-114` 走失败 UI）。Info 级，可接受；建议若上 CSP 就收紧到该域名白名单。

---

## 6. 客户端信任（前端是否做安全判定）

**结论：前端不做任何安全判定，安全边界都在服务端；SPA bundle 内不含管理员能力。**

| 检查点 | 证据 | 结论 |
|---|---|---|
| 公司归属 | 后端 `ensure_owner(&user, &cid)` 出现在 `api.rs:122, 441, 470, 525, 565`（state / scripts get+put / memory / intent） | 服务端校验，前端只传 `company_id` |
| `company_id` 从哪来 | 登录/me 后由 `frontend/src/store/useSessionStore.ts:36-40` 写入；请求参数见 `client.ts:193-195, 230-256` | 前端只是「声明」，由服务端裁决 |
| 管理员接口 | `/api/admin/overview` → `AdminUser`（`api.rs:82-83`）；`/api/sim/control` → `AdminUser`（`api.rs:578-579`）；`POST /api/companies` → `AdminUser`（`api.rs:627-628`） | 服务端强校验 |
| SPA 是否打包管理 UI | `/admin` 是后端 `include_str!("../assets/admin.html")` 的独立页面（`api.rs:27, 78-80`），不在 SPA chunk 中；SPA 里 `grep "admin"` 仅命中 `SettingsPanel.tsx:145` 的 `roleLabel('admin')` | 未通过「仅 UI 隐藏」泄权 |
| `simControl` | `client.ts:258-264` + `useGameStore.ts:393-409` 有实现，但 `grep "simControl("` 在 tsx **无调用点** | 死代码；将来接 UI 也不会绕过服务端 AdminUser |
| 前端式安全判定 | 仅 UX 校验（`AuthScreen.tsx:173-186` 邮箱/密码/昵称格式），未用于授权 | 无「仅前端判定」的安全边界 |

### F-08 残留硬编码兜底

`frontend/src/api/client.ts:106` `let currentCompanyId = 'player1';`、`frontend/src/store/useGameStore.ts:146` `companyId: 'player1'`。
历史上这四处兜底导致过越权（见 `docs/MULTIPLAYER_AUDIT.md`「已关闭」段），现在由 `ensure_owner` 兜住：未登录/身份未就绪时请求 `player1` 只会得到 403/401，**不构成越权**。但建议改为 `''`（空串在 `getState` 会拼出 `company_id=`，被 `api.rs:118-124` 拒绝）或直接不发起请求，避免将来服务端放宽校验时立刻变成真实越权。

---

## 7. 敏感信息暴露（bundle / dist）

| 检查项 | 命令 | 结果 |
|---|---|---|
| 密钥/云凭据 | `grep -o -E "sk-[A-Za-z0-9]{10,}|AKIA[0-9A-Z]{16}|secret[_-]?key|BEGIN (RSA|OPENSSH)" frontend/dist/assets/*.js` | **0 匹配** |
| 内网地址/Tailscale IP | 同上，含 `100\.84\.|localhost:[0-9]+|127\.0\.0\.1:[0-9]+` | **0 匹配**（`vite.config.ts:22-29` 的开发代理地址不会被 Vite 打进 bundle） |
| sourcemap | `ls frontend/dist/assets/*.map` → 无；`grep -c sourceMappingURL` → 全 0 | 未泄漏源码 |
| 会话 Cookie 名 | `grep -c meridian_sid frontend/dist/assets/*.js` → 全 0 | 未泄漏 |
| Turnstile | site key 是**公开**值（设计上要进前端），但实际构建为空（见 F-01）；`secrets` 类变量不出现 | 仅公开值 |
| 构建产物一致性 | 线上 `/` 引用 `assets/main-BZPKFTsx.js`，与本地 `frontend/dist` 同名同尺寸 | 本地 dist 即部署产物，分析可代表线上 |

### F-01（重点）生产构建 Turnstile site key 恒为空 → 注册人机验证实际失效

源码取值的写法：

```ts
// frontend/src/auth/AuthScreen.tsx:25-26
const TURNSTILE_SITE_KEY =
  (import.meta as unknown as { env?: Record<string, string | undefined> }).env?.VITE_TURNSTILE_SITE_KEY ?? '';
```

构建产物里（`frontend/dist/assets/main-BZPKFTsx.js`，即线上同名文件）：

```js
const Yl={}, ql=(Yl==null?void 0:Yl.VITE_TURNSTILE_SITE_KEY)??"";
… sitekey: ql …
```

`Yl` 是空对象 → `ql === ''` → `TURNSTILE_SITE_KEY` 为空。原因两重：

1. **Vite 静态替换未命中**：`define` 只替换字面量 `import.meta.env.VITE_TURNSTILE_SITE_KEY`，本处经过类型断言与可选链，最终被 `esbuild` 折叠成 `{}`，不再是编译期常量；
2. **即使写法正确也依然为空**：`frontend/` 下无 `.env*`，`Dockerfile` 的 frontend 构建阶段（`Dockerfile:1-8`）没有 `ARG`/`ENV` 传 `VITE_TURNSTILE_SITE_KEY`，`deploy/.env.example` 也只列了后端 `MERIDIAN_TURNSTILE_SECRET`。

**影响**：注册表单（`AuthScreen.tsx:410-414`）会走 `AuthScreen.tsx:99-107` 的「TURNSTILE 未配置」占位分支，不会生成 token，`authApi.register` 里 `turnstile_token` 恒为空串；后端 Turnstile 校验本身是可选的（`deploy/.env.example` 注释为 Optional）→ **线上的注册人机验证端到端处于关闭状态**，只剩限流/argon2 并发闸门拦批量注册。
**状态**：已由构建产物确认；页面表现可在线复核（打开注册页看是否显示「TURNSTILE 未配置 / 生产环境必须配置」）。
**建议**：① 改回标准写法 `import.meta.env.VITE_TURNSTILE_SITE_KEY` 并在 `vite-env.d.ts` 里声明 `interface ImportMetaEnv`；② Dockerfile frontend 阶段加 `ARG VITE_TURNSTILE_SITE_KEY` + `ENV`（或 `--build-arg`）；③ 构建期自检：若 `PROD && !VITE_TURNSTILE_SITE_KEY` 直接让构建报警/失败，避免再次静默降级；④ 后端与前端对 Turnstile 的「是否强制」口径对齐（前端已判定为未配置时，后端若仍要求 token 会直接拦住全部注册）。

---

## 8. 修复优先级建议

1. **P1（本周）F-01**：修 Turnstile 取值 + 构建注入 + 构建期断言；确认后端是否强制校验，避免「前端不交 token / 后端要求 token」的死循环。
2. **P1 F-02/F-03/F-04**：后端统一加安全响应头（`SetResponseHeaderLayer` 或在反代加），先发 `nosniff` + `frame-ancestors 'none'` + `Referrer-Policy`，再按上文基线逐步收 CSP（需与 F-05 一起决策）。
3. **P2 F-05**：控制台粘贴确认 + 提示文案；中长期把「浏览器内 eval」改成服务端沙盒回显，以换取严格 CSP。
4. **P2 F-06**：状态变更接口加 Origin/Referer 白名单（或 CSRF token），WS 升级校验 Origin（转后端组）。
5. **P3 F-07**：TLS 后置 `MERIDIAN_COOKIE_SECURE=1`，Cookie 改 `__Host-` 前缀。
6. **P3 F-08/F-09/F-10 + 供应链**：移除 `'player1'` 兜底；生产隐藏堆栈详情；localStorage 加形状校验；CSP 收紧后把 Turnstile 域名列入白名单。

---

## 9. 未覆盖 / 需在线或动态验证的事项

- **浏览器侧行为**：CSP 回归（加头后 `/ws` 是否被断、Turnstile 是否被拦）、点击劫持实际可利用性、pastejacking 成功率——需真实浏览器会话，本次仅做静态与单次 HTTP 取证。
- **F-01 的页面复现**：注册页是否显示「TURNSTILE 未配置」需打开页面确认（构建产物已强证据）。
- **F-06 的实际可利用性**：跨站 WS 升级是否携带 Lax Cookie 取决于浏览器实现；未做实测（避免对线上做请求轰炸）。
- **依赖 CVE**：按任务要求离线判断，未联网扫描（`npm audit` / OSV 会向外部服务发请求）；上表结论以 2025-11 离线知识为限。
- **后端 / 反代层**：`CorsLayer::permissive()`、Turnstile 服务端开关、限流参数、admin.html 暴露面归后端组；本文仅在交叉处引用。
- **源码可读性限制**：`frontend/docs/`、`docs/audit/` 等目录权限为 `drwx------`，本次以当前用户身份读取无阻；若他人复核需注意权限。

---

## 附录：关键命令与响应（可复现）

```
E-1   ls -la frontend/ frontend/src               # 目录结构
E-2   grep -rn "dangerouslySetInnerHTML|innerHTML|outerHTML|insertAdjacentHTML" frontend/src   # 0
E-3   grep -rn "localStorage|sessionStorage|document.cookie" frontend/src                      # 4 文件，均为 UI 偏好
E-4   grep -rn "new WebSocket" frontend/src/store/useGameStore.ts                              # :176，无 token
E-5   grep -rn "Function(" frontend/src                                                        # ConsolePanel:392,395 + 文档字符串
E-6   grep -rn "postMessage|<iframe|srcdoc|javascript:" frontend/src                           # 0
E-7   grep -rIn "Content-Security-Policy|X-Frame-Options|frame-ancestors" . --exclude-dir={node_modules,target,.git}   # 0
E-8   curl -s -I http://100.84.136.78:18420/                                                   # 无任何安全头
E-9   curl -s -o /dev/null -w "%{http_code}" http://100.84.136.78:18420/docs/                  # 200（免登录）
E-10  curl -s -o /dev/null -w "%{http_code}" http://100.84.136.78:18420/api/auth/me           # 401
E-11  grep -o "ql=(Yl==null?void 0:Yl.VITE_TURNSTILE_SITE_KEY)??\"\"" frontend/dist/assets/main-BZPKFTsx.js
E-12  grep -o "onDevBypass:void 0" frontend/dist/assets/main-BZPKFTsx.js                       # 命中 → DEV 直通已消除
E-13  grep -c sourceMappingURL frontend/dist/assets/*.js                                       # 0
E-14  grep -o -E "sk-[A-Za-z0-9]{10,}|AKIA[0-9A-Z]{16}|100\.84\.[0-9]+\.[0-9]+" frontend/dist/assets/*.js   # 0
E-15  grep -c meridian_sid frontend/dist/assets/*.js                                           # 0
E-16  node -e "...package-lock 版本..." frontend/                                              # vite 6.4.6 / esbuild 0.25.12 …
```

> 线上仅执行 3 次只读 GET/HEAD（`/`、`/docs/`、`/api/auth/me`），未做任何写操作、遍历或压测。

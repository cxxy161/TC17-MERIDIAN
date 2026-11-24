# Meridian 安全审计 —— 反作弊 / 沙盒执行面（task-2）

> 审计者：anticheat-core（Team Lead 派发）· 审计对象：`/home/cxxy168/code/html/Meridian`（Rust axum 后端 + React SPA）
> 线上实例：`http://100.84.136.78:18420/`（用户自有，本次审计已授权）
> 审计方式：**只读源码审计 + 仅 GET 的线上探测**。未做压测/爆破/批量注册/ID 遍历，未修改任何源码或配置，本文件是唯一写入物。
> 阶段说明：按 Lead 最新指令，本报告**聚焦网络安全**（沙盒执行面 / 资源耗尽 / panic 影响面 / 反序列化与 DoS / 传输与暴露面）；经济与游戏逻辑类溢出漏洞已由 Lead 在线上确认，本报告只在 §5 作定位记录，不再展开推导。

---

## 0. 结论摘要

| # | 结论 | 严重度 | 状态 |
|---|---|---|---|
| N1 | 玩家 JS 在**服务端进程内**执行（rayon 线程，非独立进程），QuickJS/libc 内存安全缺陷 = 整个游戏服 RCE / 全库泄露 | **High** | 设计级确认；具体 CVE 需专项 fuzz（推测） |
| N2 | 沙盒 host 绑定函数在 **Rust 侧物化无上限 JSON**（`get_all_orders` 等），完全绕过 4MB JS 堆限额，单脚本单 tick 可放大到数十 MB | **High** | 已从代码确认（未实测） |
| N3 | `POST /api/intent` 无速率限制、无队列上限、全局引擎互斥锁 ⇒ 单账号可内存膨胀 + tick 停摆 | **High** | 已从代码确认；量化需在线验证 |
| N4 | 模拟 tick 循环无 panic 隔离 / 无监督重启；一次 panic = 模拟永久冻结，HTTP 仍正常响应（静默故障） | **Medium** | 已从代码确认 |
| N5 | 沙盒 5ms 预算为**墙钟**且只在中解释器内轮询，原生长调用可能越过；预算起点早于绑定构建，大玩家自伤性超时 | **Medium** | 代码确认；绕过程度需在线验证 |
| N6 | WebSocket 无单账号连接数上限，且**每连接每 tick 全量序列化**世界状态（含全部行情）⇒ 连接数线性 CPU 放大 | **Medium** | 已从代码确认 |
| N7 | `X-Forwarded-For` 被无条件信任，而实例直接暴露 18420（deploy 无反向代理）⇒ 注册/登录 IP 限流可被绕过 | **Medium** | 代码 + 部署配置确认；线上验证需发请求（未做） |
| N8 | 传输明文 HTTP、Cookie 无 `Secure`（依赖 `X-Forwarded-Proto`），会话可被同链路嗅探 | **Medium** | 线上确认（curl 直连 18420 成功） |
| N9 | 任意登录用户可读任意公司详情（净资产/挂单/地块），公司 ID 可预测，无限流 ⇒ IDOR + 枚举 | **Low** | 已确认 |
| N10 | `/admin`、`/api/health`、`/api/catalog`、`/api/market/*` 匿名可读；`/admin` 暴露管理台结构 | **Low/Info** | 线上确认（200） |
| N11 | 空库时**首个注册者自动成为 admin**（无邀请码/人工审批） | **Medium** | 已从代码确认（当前实例已非空库） |
| N12 | 管理/调试接口（`/api/sim/control`、`POST /api/companies`）已正确要求 `AdminUser`，**未发现**非 admin 可达路径 | Info（正面） | 已确认 |
| N13 | 沙盒能力面（无文件/网络/时间 host 函数、无 Rust 对象引用外泄、无 loader 注册）**未发现代码级逃逸原语** | Info（正面） | 已确认 |

---

## 1. 沙盒 / 服务端 JS 执行面

### 1.1 能力面审查（逃逸面）——代码级未发现逃逸原语（Info/正面）

玩家脚本由 `rquickjs 0.9`（features: `loader,array-buffer,parallel`，`backend/crates/meridian-sandbox/Cargo.toml:9`）在服务端执行，入口 `run_player_tick`（`js_runner.rs:361-508`）。所有 host 绑定只有三类能力（`js_runner.rs:532-1174`）：

1. **只读快照查询**：`__meridian_quote / __meridian_depth / __meridian_get_all_orders / __meridian_calc_route / __meridian_get_recipe / __meridian_get_land_plots / __meridian_list_companies / __meridian_get_company` —— 全部返回**字符串/数字**，无 Rust 对象、无 `Class`、无外部指针；
2. **Intent 写入**：`__meridian_*` 写方法只做基础校验后 `push_intent`（`js_runner.rs:41-48`）；
3. `__meridian_log`、`__meridian_cpu_used`、`__meridian_get_module`（仅返回**本玩家自己的** bundle 源码，`js_runner.rs:573-582`）。

`require()` 是 prelude 里的纯 JS 实现，用 `new Function(..., source)` 执行玩家自己的模块源码（`prelude.js:143-168`），**与宿主同属一个 JS 上下文，不触及宿主能力**。仓库中未调用 `Runtime::set_loader` / 未注册任何原生模块（全仓 grep `set_loader|Module::declare` 无命中），因此 `import("os")`/`import("std")` 无加载器可用。

⇒ **未发现** `eval/Function/Proxy` 导致越权、文件读取、网络出网或 Rust 引用外泄的代码路径。残留风险见 1.2。

### N1（High / 设计级）QuickJS 与宿主同进程 ⇒ 单点 RCE 面

沙盒**不是**独立进程/沙箱，而是在 `rayon` 工作线程里调用 C 库 QuickJS（`runner.rs:129-150` → `js_runner.rs:139`）。这意味着 QuickJS（C）、libc、乃至"玩家输入的 JS 源码解析器"的任一内存安全缺陷都可直接拿到 **run_player_tick 所在进程**（= 整个 axum 服务端）的代码执行能力：

- 可直接读写 `data/meridian.db`（会话哈希、口令哈希、全体玩家脚本与 Memory）；
- 可绕过所有 `ensure_owner`（`auth.rs:362-372`）与 `AdminUser`（`auth.rs:344-360`）判定；
- 进程内只有 4MB 堆/256KB 栈/5ms 中断三层**逻辑**限额（`js_runner.rs:379-393`），它们对 C 层内存破坏无效。

**区分**：这是架构级风险确认（代码可证：沙盒与网关同进程）；"存在可利用的 QuickJS CVE"属**推测**，需独立 fuzz/版本 CVE 比对才能定级为可复现。
**修复建议（P0）**：
1. 把玩家 JS 执行拆到独立 worker 进程/容器（`--network=none`、只读根、独立 uid、seccomp、`RLIMIT_AS/CPU`、`prctl(NO_NEW_PRIVS)`），通过 IPC 只交换 snapshot→intent 的 JSON；
2. 升级 rquickjs / QuickJS-NG 到最新并跟踪 CVE；
3. 短期降级：给 tick 线程池 + 沙盒线程设 `catch_unwind` 之外，至少用子进程 + 超时 kill 包裹脚本执行。

### N2（High）host 函数在 Rust 侧物化无上限 JSON，绕过 JS 堆限额

JS 堆 4MB 只约束 JS 对象；host 绑定里的 `serde_json::to_string` 分配的是**Rust 堆**，不受该限额约束，且部分接口**不设条数上限**：

- `__meridian_get_all_orders`（`js_runner.rs:641-669`）：`sid`/`item` 传空串即返回**全站全部挂单**，无 `take/limit`；
- `__meridian_get_company`（`js_runner.rs:782-825`）：返回该公司全部挂单 + 全部地块；
- `__meridian_list_companies`（`js_runner.rs:746-781`）：`limit` 上限 1000（可接受，但仍是整包序列化）；
- `__meridian_get_land_plots`（`js_runner.rs:713-745`）：整行星全部 tile + 建筑列表。

利用路径：脚本在 5ms 窗口内循环调用 `Game.market.getAllOrders({})`，每次分配 O(全球挂单数) 的 String，随后 `JSON.parse` 进 4MB 堆（会先 OOM，但 Rust 侧 String 在 GC 前已分配）。以当前实例 75 家公司、每公司上限 64 单估算，单次调用约 1–5MB 量级，一 tick 内数十次调用 = 数十 MB 瞬时 Rust 堆；多账号并发即形成内存压力（2C/500MB 目标机器）。`MAX_INTENTS_PER_TICK`（`types.rs:13`）只限制 Intent 条数，**不限制查询调用次数**。

**修复建议（P1）**：给每个 host 查询加硬上限（orders ≤ 200 条、companies ≤ 100、tiles 只返回半径内）、把查询结果改为**长度受限**再序列化、对单 tick 的 host 调用总字节数记账（例如 1MB/tick/玩家）。

### N3（High）`POST /api/intent` 无速率限制、无队列上限、全局锁争用

- 路由注册：`api.rs:44`；处理器直接把客户端 JSON 反序列化成 `Intent` 后入队（`api.rs:554-570`）；
- `queue_manual_intent` **无限追加**，无长度/速率/去重检查（`engine.rs:1471-1481`）；
- 仅在应用阶段截断：`world.step_tick` 对每公司只取前 32 条（`world.rs:808`、`types.rs:13`），**入队阶段不截断**；
- 队列在下一次 tick 才被 `std::mem::take` 消费（`runner.rs:152-172`）；暂停（`paused`）状态下会一直累积；
- 全服只有一个 `Arc<Mutex<GameEngine>>`，tick 循环与所有 HTTP handler 共享（`main.rs:71-96`、`api.rs` 各 handler），`POST /api/intent` 每次都要抢这把锁。

量化（估算，**未实测**）：axum `Json` 默认请求体上限 2MB；单账号以 10 请求/秒推送 `DispatchShip{cargo:[...]}` 形状的大 Intent，在 tick_ms=1000（线上 `/api/health` 实测 `tick_ms:1000`）的 1 秒窗口内可滞留约 200MB（10×2MB×10s 级，取决于实际吞吐）；同时锁争用会延后 tick（tick 间隔 = step 耗时 + tick_ms，`main.rs:88-93`），形成"越堵越慢"的放大。≥1 个账号即可，无需管理员权限。

**修复建议（P1）**：入队处硬上限（如每公司 ≤ 64 条、每条 `cargo` ≤ 8 种）、按账号令牌桶（如 20 次/秒）、tick 侧独立队列/无锁通道，避免 HTTP 与模拟共享同一把全局锁。

### N4（Medium）panic 无隔离、tick 循环无监督 ⇒ 静默全服冻结

- 后台 tick 是 `tokio::spawn` 的裸循环，**无 JoinHandle 监视、无重启、无 watchdog**（`main.rs:73-96`）；panic 只会结束该任务，进程继续存活并正常响应 HTTP → 表现为"游戏不再推进、但站点一切正常"；
- 全仓无 `catch_unwind`（grep `catch_unwind` 无命中），`SimulationRunner::step_world` 直接 panic 传播（`runner.rs:80-183`，rayon `collect` 会把 worker panic 重抛到调用者）；
- 可 panic 的构造：`std::sync::Mutex::lock().unwrap()`（`js_runner.rs:42,51,489`，一旦 poison 后续每 tick 必 panic）、`build_boot_json` 的 `expect`（`js_runner.rs:1329`）、多处索引 `self.companies[..]`/`self.stations[..]`（`world.rs:1301,1471,1668,1744`）。

**注意**：线上为 `cargo build --release`（`Dockerfile`），整数溢出是**静默回绕**而非 panic —— 这既让 §5 的经济漏洞不报错，也让"溢出即崩"的检测路径失效。
**修复建议（P1）**：`step_once` 外层 `catch_unwind` + 计数告警 + 连续失败自动重启任务；`lock()` 改 `try_lock`/`unwrap_or_else` 重建；关键索引改 `get()`；加 `/api/health` 的 `last_tick_at` 供外部探活。

### N5（Medium）5ms 限额的实现局限

- 限额是**墙钟**：`started_at` 在 Runtime 创建前、绑定安装前就起算（`js_runner.rs:384-393`），而 `install_host_bindings` 内部的 `build_boot_json`（`js_runner.rs:542`，序列化全部行星/地块/挂单）也在预算内 ⇒ 资产越多预算越少，大玩家会**系统性超时**（自伤，非攻击）；
- 中断只由 QuickJS 字节码循环轮询，**单次原生调用**（正则回溯 `(a+)+$`、大 `JSON.parse`、`String.repeat`/`padStart`）是否被及时打断取决于 QuickJS 内部实现 —— 需在线验证（无法在只读审计中安全验证）；4MB 堆/256KB 栈（`js_runner.rs:379-380`）可压制大部分放大；
- 执行结束后先清除中断与内存上限再 drop（`js_runner.rs:469-473`，避免析构期误杀），此处实现正确；
- 现有测试只覆盖死循环/超时回滚与 OOM（`tests/sandbox_tests.rs:135,173`），**无**正则回溯、host 查询放大、`Date/Math.random` 压力用例。

**修复建议（P2）**：预算起点后移到用户代码执行前；给 `Memory` 与 host 查询加独立计量；补 `regex catastrophic backtracking` 回归用例（预期被 5ms 截断，否则升级为 High）。

### 1.4 其它沙盒观察（Info）

- 崩溃/超时/OOM 时 **Memory 与 Intent 一起回滚**（`js_runner.rs:491-497`），行为正确，不存在"部分 Intent 落账"；
- `Memory` 由 `JSON.parse` 注入、`serde_json::to_string` 转义（`js_runner.rs:435`），无注入面；序列化 >128KB 则丢弃本轮改动（`js_runner.rs:453-461`），行为正确；
- `PUT /api/memory/{company_id}` 允许玩家直接写自己的 Memory（`api.rs:519-552`，owner 校验 + 128KB + JSON 合法性），属设计内；但 **Memory 与脚本均为跨会话持久化**，泄露面在于"谁能读到它"：`GET /api/scripts/{company_id}` 会一并返回 `memory_json` 与全部模块源码（`api.rs:436-456`），仅 `ensure_owner`/admin 可读，**未发现跨账号读取路径**（`storage.rs` 的 `load_all_player_memories` 只在启动时调用）。
- 脚本使用 `Date.now()/Math.random()` 会产生非确定性（影响回放/审计一致性），非安全漏洞，建议在文档中标注。

---

## 2. 资源耗尽（HTTP 面）

### N6（Medium）WebSocket 无连接上限 + 每连接全量序列化

- `/ws` 只校验登录（`api.rs:667-674`），**无单账号/单 IP 连接数上限**；
- 每 tick 广播的 `TickBroadcast` 构造时即包含 `planets`（每行星摘要）、`leaderboard`（全公司）、`market_tickers`（站×350 物品）（`engine.rs:1483-1501`）；每个 socket 在 `handle_ws` 里**各自** `serde_json::to_string(&ev)`（`api.rs:693-703`）；
- ⇒ M 条连接 = M 倍序列化 CPU + M 份拷贝。打开数百条 WS 即可让 tick 周期显著劣化（无需高带宽，纯服务端 CPU）。`player_outputs` 已按连接过滤（`api.rs:696-697`），这一点实现正确。

**修复建议（P2）**：每账号 ≤ 2 条 WS、全局 ≤ N 条；广播包预序列化一次（Arc<str>）+ 每连接只做增量裁剪；或/ws 改为客户端拉取。

### 2.2 `/api/memory`、`/api/scripts` 无限速、无配额（Medium/Low）

- `PUT /api/memory` 每请求写 1 次 SQLite（`api.rs:537-549`），无速率限制；
- `PUT /api/scripts` 无条件写库（`api.rs:494-497`），**单模块大小与模块数无上限**（仅受 axum 2MB 请求体），每 tick 都会重新编译执行；
- 影响：磁盘写放大、库文件膨胀、脚本编译计入玩家自己的 5ms 预算（自伤为主），但对多账号是低成本存储型 DoS。
**建议**：脚本总量配额（如 256KB/账号）、写操作令牌桶、`last_saved_at` 节流。

### 2.3 `GET /api/state` 与匿名重型读接口（Low/Medium）

`/api/state`（`api.rs:113-125`）每请求都重算 `leaderboard + planet_summaries + market_tickers + snapshot`（`engine.rs:1451-1469`），全程持全局锁、无缓存、无限流；虽有 AuthUser 门槛，但单账号高频轮询即可持续抢占 tick。匿名侧 `/api/market/book`、`/api/market/candles`（`api.rs:282-425`）同样持锁并查 SQLite（有 clamp，查询范围有界）。
**建议**：state 结果按 tick 缓存（tick 不变就不重算）；对读接口加每 IP 令牌桶与 `Cache-Control`。

### 2.4 限流覆盖不全（Info）

令牌桶只用于注册/登录（`auth.rs:194-250`），其余所有端点**无速率限制**；`/api/intent`、`/api/memory`、`/api/scripts`、`/ws` 是主要缺口（见上）。

### 2.5 启动期载荷增长（Low）

`land_listings` 由 NPC 破产清算产生且**无过期**（`world.rs:2243-2254`），而每个玩家的 bootstrap 载荷都包含全部星球的 `landListings`（`js_runner.rs:1189-1224`），该 JSON 在 4MB JS 堆内被 `json_parse`（`js_runner.rs:542-544`）。长期运行后 bootstrap 变大 → 全体玩家脚本 OOM/超时（游戏进程驱动，非攻击者直接可控）。
**建议**：bootstrap 只下发本行星 + 分页；给 listings 加过期/上限。

---

## 3. 反序列化与输入边界

- `PostIntentReq { company_id, intent: Intent }` 直接反序列化（`api.rs:554-558`）。`Intent` 为外部标签枚举（`types.rs:83-135`），字段类型为 `u32/i64/Vec<(String,u32)>`：serde 会拒绝越界/负数/未知字段类型（返回 422），**但 `price: i64` 无任何上界**（引擎只查 `price > 0`，`world.rs:1327`）——这是 §5 经济漏洞的直接注入通道，同时也意味着"任意 64 位值"会进入所有 i128→Money 转换点。
- `DispatchShip.cargo: Vec<(ItemId,u32)>` 的条数只受请求体 2MB 限制，单 Intent 可携带数万条目；引擎在 `world.rs:1784-1795` 会聚合/校验并因容量不足拒绝，但**反序列化本身**已产生相应内存（队列滞留期放大，见 N3）。
- `PUT /api/memory` 的 JSON 先 `serde_json::from_str::<Value>` 再存（`api.rs:533-535`），有 128KB 上限，无嵌套深度限制（serde_json 默认递归深度上限 128，实际安全）。
- WS 入站消息**被忽略**（`api.rs:716`），无解析面。
- 未发现可导致原型污染或路由注入的字符串拼接：SQL 均为参数化（`storage.rs:867,884,896` 的 `format!` 只拼固定列名）。

---

## 4. 传输、暴露面与访问控制

### N7（Medium）`X-Forwarded-For` 无条件信任 ⇒ 限流绕过

`client_ip` 取 `X-Forwarded-For` 第一段，取不到则回落 `"local"`，**不校验来源**（`auth.rs:287-300`；注释里已写明"生产部署时反代必须覆盖写入该头，避免客户端伪造"）。而 `deploy/docker-compose.yml` 直接把 `18420:18420` 发布到宿主机、未见反向代理；线上 `curl http://100.84.136.78:18420` 直连成功。⇒ 攻击者可任意伪造 XFF 绕过注册（`REGISTER_PER_IP_CAPACITY=3`/小时，`auth.rs:199-205`）与登录（10/分钟，`auth.rs:203-205`）限流，进而：批量注册（每个账号都能调 `/api/intent` 放大 N3）、口令爆破、Turnstile `remoteip` 失真。
**修复建议（P1）**：仅在"来自受信反代的直连"时采信 XFF（如校验 `ConnectInfo` 源地址 ∈ 内网/回环），否则用 `ConnectInfo` 的真实 peer IP；部署侧强制 TLS 反代并只监听 127.0.0.1。

### N8（Medium）明文 HTTP + Cookie 无 Secure

- Cookie 固定 `HttpOnly; SameSite=Lax`，`Secure` 仅在 `MERIDIAN_COOKIE_SECURE=1` 或反代给 `X-Forwarded-Proto: https` 时追加（`auth.rs:130-153`）；
- 实例以明文 `http://100.84.136.78:18420` 对外（实测 200），无 TLS ⇒ 会话 Cookie 在共享网络可被嗅探/中间人劫持，进而接管账号（含记忆/脚本/全部资产）。
**建议（P1）**：前置 TLS（Caddy/nginx），设 `MERIDIAN_COOKIE_SECURE=1`，并把明文端口仅绑回环。

### N9（Low）IDOR：任意登录用户可读任意公司

`GET /api/companies/{company_id}` 只要 `AuthUser`，不校验归属（`api.rs:189-197`，`_user` 未使用），返回 `net_liquid`（净资产）、全部挂单（含 `created_tick`）、全部地块/建筑计数。公司 ID 可预测（`player1`、`u{user_id}`、`npc_evo_{seq}`，`api.rs:906-915`、`engine.rs:686-737`），配合无限流可全量枚举。虽多为"市场中可见信息"的聚合，但净资产与挂单时间戳属于超出公开盘的额外信息（可辅助针对性狙击/画像）。
**建议（P2）**：明确哪些字段公开（当前盘口已公开），`net_liquid`/`created_tick` 仅本人或管理员可见；对枚举加审计与限流。

### N10（Low/Info）匿名可读端点

实测（仅 GET）：

```
GET /api/health          -> 200  121B   {"ok":true,"tick":412,"cpi":3.24,"paused":false,"tick_ms":1000,"conservation_error":0,"companies_count":75}
GET /api/catalog         -> 200  12KB
GET /api/market/book     -> 200  187B
GET /api/market/candles  -> 200  309B
GET /admin               -> 200  39KB   （管理台 HTML 静态页，`api.rs:31-32,78-80`）
GET /api/admin/overview  -> 401
POST /api/intent (GET)   -> 405   （路由存在，方法不允许）
```

`/api/health` 泄露 tick/CPI/公司数/**conservation_error**（可作为"是否有人在铸币"的探测信号，也便于攻击者观测自己的经济利用效果）；`/admin` 公开管理台结构（不含凭据）。**建议**：health 拆分为公开的 `{ok,tick}` 与需鉴权的运维详情；`/admin` 加登录门槛或仅内网。

### N11（Medium）首个注册者自动成为管理员

`api.rs:897-900`：`let role = if eng.store.count_users() == 0 { "admin" } else { "player" }`。新部署/清库后的**抢注窗口**直接把管理员交给第一个注册者（可读任意公司脚本、任意 Memory、`/api/sim/control`、`POST /api/companies`）。当前线上库非空（已有 admin），但恢复/迁移/新实例都会重现。
**建议（P1）**：admin 只能由 `MERIDIAN_ADMIN_EMAIL`/CLI 显式指定；首用户不给 admin，或要求一次性初始化令牌。

### 4.6 正面结论：管理接口鉴权正确

`/api/sim/control`（pause/resume/speed/step/reset）与 `POST /api/companies` 均要求 `AdminUser`（`api.rs:578-582,627-631`；`auth.rs:344-360` 非 admin 一律 403），`/api/admin/overview` 401（实测）。未发现隐藏调试 Intent 或绕过 `is_admin` 的路径。**但**：admin 通过 `ensure_owner` 的放行（`auth.rs:363-365`）可读写任意公司脚本/Memory，属特权设计，需在运维层面视为"高敏账号"。

### 4.7 CSRF / CORS

- 会话 Cookie 为 `SameSite=Lax`，跨站 POST 不带 Cookie ⇒ 跨站 CSRF 受限；但**无 CSRF Token**，若将来为嵌入/跨站场景放宽 SameSite 即失守；
- `CorsLayer::permissive()`（`api.rs:56`）：任意 Origin 可读匿名端点响应；未开启 `allow_credentials`，暂不能带 Cookie 跨站读写，建议改为显式白名单。

---

## 5. 经济类漏洞（Lead 已在线确认，此处仅定位记录，不展开）

按 Lead 指令，以下属游戏逻辑/经济完整性，**已由 Lead 在线上确认**，归属另一条跟踪线，本报告不复述推导：

- `world.rs:1477-1489`（`DealOrder` 买入 resting sell）`notional = (take as i128 * order.price as i128) as Money` 无边界检查，`i128→i64` 截断为负后可绕过 `cash < notional` 并反向增加买家现金；
- `world.rs:1364`（`CreateOrder` 买单 escrow）同款截断，只查 `cost <= 0`；
- `exchange.rs:276-278, 304`（`match_all` 的 `notional/escrowed_for_take/buyer_refund`）同款截断；
- `world.rs:2075`（Hub 仓租估值）同款截断；
- 注入通道：`POST /api/intent` 直接反序列化 `price: i64`，无上界（`api.rs:554-570`、`world.rs:1327`）。

静态复核补充（供后续跟踪，不作为本报告结论）：截断点的**共同根因**是"客户端可控 i64 × u32 在 i128 里相乘后直接 `as Money` 截断 + 缺乏价格带/上界"，修复应在 `apply_intent` 入口统一做 `price ∈ [最小价, ref_price × K]` 与 `checked_mul/checked_add`（溢出即拒单），并给 `escrow_cash ≥ 0`、`cash ≥ i64::MIN/4` 加不变量断言。

---

## 6. 修复优先级（网络与可用性视角）

**P0（立即）**
1. 沙盒进程隔离（N1）+ 关闭明文暴露、强制 TLS（N8）；
2. `X-Forwarded-For` 采信收敛到受信反代（N7）；
3. `/api/intent` 入队上限 + 账号级令牌桶（N3）。

**P1**
4. host 查询硬上限与每 tick 字节预算（N2）；
5. `catch_unwind` + tick watchdog + `last_tick_at` 探活（N4）；
6. 取消"首注册即 admin"（N11）；脚本/记忆写入配额与限流（2.2）；WS 连接数上限 + 预序列化（N6）。

**P2**
7. 5ms 预算起点后移 + 正则回溯回归用例（N5）；`/api/state` 缓存；IDOR 字段收敛与枚举限流（N9）；health/admin 收敛（N10）；CORS 白名单（4.7）。

---

## 7. 未验证 / 需在线验证清单

| 项 | 原因 | 建议验证方式 |
|---|---|---|
| QuickJS 是否存在可利用 CVE（N1） | 需版本比对 + fuzz，只读审计不可判定 | 用 `cargo tree -i rquickjs` 锁定版本后比对 CVE，独立环境跑 fuzz 语料 |
| 正则灾难回溯是否被 5ms 截断（N5） | 线上验证需跑玩家脚本（会占用真实算力） | 线下起本地实例，用测试账号跑 `new RegExp("(a+)+$")` 用例 |
| `/api/intent` 洪泛的实际内存/延迟曲线（N3） | 属压测，本次明令禁止 | 线下单机实例，限时定量（≤30s，单账号） |
| XFF 限流绕过是否在线上生效（N7） | 需构造伪造头并触发注册/登录 | 线下实例：伪造 `X-Forwarded-For` 触发 `429` 阈值对比 |
| `/api/health` 的 `conservation_error` 目前为 0 | 仅一次采样（tick 412） | 持续只读轮询（低频）观察是否非 0 |
| `MERIDIAN_TURNSTILE_SECRET` 是否已配置 | env 未入库（`deploy/.env` 不在仓库） | 询问部署者；未配置则注册无人机校验（`auth.rs:252-256` 直接放行） |

---

## 8. 证据与复现命令（只读，已执行）

```bash
# 线上暴露面（仅 GET）
curl -s -m 8 -w '\n%{http_code} %{size_download}\n' http://100.84.136.78:18420/api/health
curl -s -m 8 -o /dev/null -w '%{http_code}\n' http://100.84.136.78:18420/api/state        # 401 需登录
curl -s -m 8 -o /dev/null -w '%{http_code}\n' http://100.84.136.78:18420/api/admin/overview # 401
curl -s -m 8 -o /dev/null -w '%{http_code}\n' http://100.84.136.78:18420/admin              # 200

# 代码证据（行号见正文）
grep -rn 'catch_unwind' backend/crates/                      # 无命中 → tick 无隔离
grep -rn 'set_loader\|Module::declare' backend/crates/       # 无命中 → 未注册原生模块
grep -n 'as Money' backend/crates/meridian-core/src/*.rs      # 截断点清单（§5）
```

> 说明：本次**未**向线上发送任何 POST/PUT、未创建账号、未提交 Intent、未做任何遍历或压测；所有"需在线验证"项均保持未验证状态。

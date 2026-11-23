# 多玩家 / 反作弊 审计记录

> 状态：**账号/鉴权部分已修复（2026-11-23，见文末「已关闭」），其余仅记录不修**
> 背景：账号系统落地前，先摸清「现在的代码能不能跑多玩家」。结论：模拟核心按 `company_id` 分区、能跑多公司；**但服务端没有身份层**，多开浏览器等于同一个 `player1` 互相覆盖。
> 性质：以下问题属于**反作弊与开服首日风险**，账号系统上线后按优先级逐条处理，不在本次改动范围内。
> 证据全部来自静态阅读（未编译、未跑测试），行号以当前 HEAD 为准。

---

## 已关闭（本次改动）

账号系统落地时一并修掉的条目，细节见 [AUTH.md](AUTH.md)：

- #1~#9 身份与权限：session 中间件（Cookie + users/sessions 表），玩家接口一律以会话身份为准，跨账号 403；admin 接口限 admin。
- #10~#12 数据泄漏：WS 握手要求登录，首帧只给本人快照，tick 广播只保留自己的 `player_outputs`。
- 前端四处 `player1` 兜底：`client.ts` 改为读 `currentCompanyId`（登录后由 store 写入），`api.rs:101/515` 改为会话身份。
- 注册接口无保留地开放的问题：加 Turnstile（可选）+ 全站/每 IP 限流 + argon2 并发闸门。

仍未修（保持记录）：#13~#20 一致性边界与性能上限、reset 只重建 player1、静默失活分支、全局锁、O(N²) 快照。

## 0. 一句话结论

名义 N 人、实际只能安全跑 1 人。经济核心的一致性没有大问题（下单先托管、抢单先 remove、玩家永不破产），
问题集中在**接入层（鉴权 / 广播 / 锁）**和**性能上限（每 tick O(N²) 快照）**。

---

## P0 · 身份与权限（账号系统必须先解决）

| # | 现象 | 证据 | 影响 |
|---|---|---|---|
| 1 | 全站无 auth 中间件，CORS `permissive` | `backend/crates/meridian-server/src/api.rs:23-49` | 身份完全由请求自称 |
| 2 | `/api/state?company_id=` 缺省 `player1` | `api.rs:101` | 传任意 id（含 NPC）即读该公司私产快照 |
| 3 | `PUT /api/scripts/{company_id}` 只查公司存在、不查归属 | `api.rs:313-356` | 可改任意玩家脚本、开关其自动交易（夺舍 / 停摆） |
| 4 | `PUT /api/memory/{company_id}` 直接覆盖他人 Memory | `api.rs:364-394` | 篡改他人策略状态 |
| 5 | `POST /api/intent` 的 `company_id` 来自 body | `api.rs:402-410` | 以他人身份下单、操纵 NPC |
| 6 | `/api/sim/control` 匿名可 pause/speed/**reset** | `api.rs:418-454` | 一个 POST 重置全世界 |
| 7 | reset 只重建 `player1`，其他公司被抹、VM 残留 | `engine.rs:393-404` | 幽灵状态：公司没了、VM 还在跑 |
| 8 | `/api/companies` 匿名建玩家公司，资金走 `record_mint` | `api.rs:456-501`（上限 100k，`api.rs:471`） | 无限开局资金 = 刷钱流水线 |
| 9 | `/api/admin/overview` 匿名可读全部公司现金/库存/订单/genome | `api.rs:68-71`、`engine.rs:498-719` | 竞品情报全裸 |

**修复方向（未实施）**：session 中间件把 `company_id` 从 token 解析；query/path/body 里的身份字段降级为「只能是自己的 id，否则 403」；admin 接口独立角色。

## P0 · 数据泄漏

| # | 现象 | 证据 | 影响 |
|---|---|---|---|
| 10 | WS 首帧恒为 `state_response("player1")`，连接不带身份 | `api.rs:510-519` | 每个连接都拿到 player1 的私产 |
| 11 | tick 广播克隆**全体**玩家输出（含 `memory_json` / 日志） | `engine.rs:749-763`、`types.rs:88-96` | 每个客户端收到全员 Memory；前端只是本地挑自己那条（`useGameStore.ts:207-208`）→ 广播即泄漏 |
| 12 | `TickBroadcast.player_outputs` 每客户端 O(N) 序列化 | 同上 | 玩家数上来后带宽/CPU 线性恶化 |

**修复方向（未实施）**：WS 用登录态/ticket 定 `company_id`；按 company 分频道或每连接只填自己的 output。

## P1 · 一致性边界

| # | 现象 | 证据 | 影响 |
|---|---|---|---|
| 13 | 每 tick 写 Memory，但世界每 10 tick 才落盘 | `engine.rs:286-304` | 崩溃后 Memory 领先世界：脚本记得下过单，世界没有 |
| 14 | 同 tick 各公司 intent **随机洗牌后顺序 apply**，落败只计入 `rejected_intents` 计数 | `world.rs:317-331` | 同资源竞争靠随机定胜负；玩家侧拿不到「为什么被拒」 |
| 15 | `set_player_script` 对未注册 id 静默建默认 VM | `runner.rs:59-63` | 无报错，问题被掩盖 |
| 16 | `is_player` 但无 VM 的公司被静默 `continue` | `runner.rs:107-117` | 玩家公司「隐身失活」，无任何提示 |
| 17 | 对 NPC 公司 PUT 脚本被放行，但永不执行（只跑 `is_player`） | `api.rs:319` + `runner.rs:107-121` | 写了没效果、零报错 |
| 18 | 账本无公司级分账，只有全局 total_minted/burned/fees | `ledger.rs:9-15`、`company.rs:12-25` | 无法做公司资产负债/审计；`trade_history` 带买卖方 id 可事后归因 |

**修复方向（未实施）**：world 与 memory 同 tick 落盘；`TickReport` 按 cid 记录被拒原因并回推前端 console；静默分支改成写 error 进广播。

## P1 · 性能上限（2C/500MB 的硬约束）

| # | 现象 | 证据 | 影响 |
|---|---|---|---|
| 19 | 单把 `tokio::Mutex` 包住整个 `GameEngine`，tick 持锁跑 `step_once`，所有 handler 也持锁 | `main.rs:55-72`、`engine.rs:777` | 玩家 JS 执行期 HTTP 全阻塞，2 人在线就互卡 |
| 20 | 每公司快照重复计算「全站点 × 全物品」报价，并把全市场订单塞进 `orders` | `world.rs:1750-1767`、`runner.rs:100-121` | 每 tick O(N²) 构建 + 序列化 |

**修复方向（未实施）**：拆锁（建快照 → 解锁 → 并行跑 JS → 加锁 apply）；每 tick 构建一次公共 base，N 份快照只填私有段。

## 未验证（上游报告的盲区）

- `js_runner.rs` 只确认每 tick 新建 Runtime 做隔离，**未审 Game API 是否暴露可穿透宿主对象的引用** —— MMO 跑不可信 JS，这是比接口鉴权更致命的攻击面，逃逸一次就是宿主进程。
- `exchange.rs` 撮合内部（价格-时间优先级）未逐行审 `match_all`。
- `npc.rs` 仅 grep 了 Intent 种类，未逐行审是否有越界写玩家资产的路径。
- 前端 30+ 面板未逐个核展示层会不会串别家数据。
- 性能数字全为读码推断，未实测。

## 开服前 Checklist（账号系统落地后按序）

1. [ ] session 中间件 + 清掉四处 `player1` 兜底（`api.rs:101/515`、`client.ts:24/53`、`useGameStore.ts:146`）
2. [ ] WS 带登录态，广播只发自己的 output
3. [ ] scripts / memory / intent 校验归属；NPC 公司拒绝写脚本
4. [ ] admin 接口加角色；reset 同步清 `runner.players` 与 `player_*` 表
5. [ ] 静默失活分支改为显式报错
6. [ ] 拆锁 + 快照复用（玩家数 > 3 之前做完）
7. [ ] 沙盒逃逸专项审计（独立一轮）

# 《Meridian》项目交接全书（HANDOVER）

> 编制日期：2026-11-23 | 适用版本：`main`（基于 `bf3c400` 及其后续服务端/NPC/后台速度修复）  
> 目标：让接手工程师无需翻找聊天记录，即可直接理解架构边界、运行构建、排障数据库与继续迭代。

---

## 1. 项目定位与核心设计原则

《Meridian》是一款结合 **可编程自动化沙盒**、**Prosperous Universe（PrUn）行星工业供应链** 与 **星际交易所 CLOB（中央限价订单簿）** 的轻量化多人/单人异步经济模拟游戏，设计目标是在 `2C / 500MB` 服务器上 24/7 稳定运行。

项目必须长期坚守以下两条**架构铁律**：

1. **零货币误差守恒（`conservation_error == 0`）**
   - 所有资金单位使用定点整数 [`Money = i64`](backend/crates/meridian-core/src/types.rs)（`MONEY_SCALE = 10_000`，即 `1.0000` 信用点），彻底消除浮点误差。
   - 一切资金转移、市场撮合、订单托管、银行存贷与税费均走严格记账通道 [`Ledger`](backend/crates/meridian-core/src/ledger.rs)，系统总流通货币 = 各公司现金 + 各星球国库 + 各星球银行准备金 + 各空间站托管现金，`world.conservation_error()` 必须在每一回合为 `0`。
2. **`meridian-core` 与策略完全解耦；玩家与 NPC 同协议**
   - [`meridian-core`](backend/crates/meridian-core) 只负责确定性物理、产线、订单簿、物流与会计法则，**严禁写任何商业 AI 决策或硬编码套路**。
   - 玩家（QuickJS 沙盒）与演化 NPC（`NpcGenome` 策略）都只能读取只读快照 `WorldSnapshot`，并提交原子 `Intent[]`（每公司每回合上限 `MAX_INTENTS_PER_TICK = 32`、最大挂单数 `MAX_ACTIVE_ORDERS_PER_COMPANY = 64`）。

---

## 2. 仓库目录全景

```text
Meridian/
├── backend/                          # Rust Cargo Workspace (Edition 2024)
│   ├── Cargo.toml
│   ├── data/                         # 运行时默认读取的 SQLite DB 目录（运行 meridian-server 时创建）
│   └── crates/
│       ├── meridian-core/            # 纯确定性经济、物理与会计内核
│       │   ├── src/
│       │   │   ├── types.rs          # Money(i64), Intent, OrderSide, 限制常量
│       │   │   ├── schema.rs         # ProductionCatalog 加载 & 产线无死锁 BFS 校验
│       │   │   ├── ledger.rs         # 货币发行/销毁/工资/税费审计账本
│       │   │   ├── exchange.rs       # 稀疏 CLOB 订单簿与 K 线聚合源数据
│       │   │   ├── logistics.rs      # 星球轨道、航行时间/燃料计算与在途舰队
│       │   │   ├── planet.rs         # 星球人口、城市消费需求、废料排放与银行
│       │   │   ├── company.rs        # 公司资产、仓库、地块、建筑、飞船
│       │   │   ├── snapshot.rs       # 面向玩家/NPC 的只读 WorldSnapshot
│       │   │   └── world.rs          # 核心单步状态机、apply_intent、破产清算
│       │   └── tests/invariants.rs   # 核心物理与货币守恒测试（5 个用例）
│       ├── meridian-sandbox/         # 双端策略执行层（玩家 JS + 演化 NPC）
│       │   ├── src/
│       │   │   ├── js_runner.rs      # rquickjs 沙盒（4MB 堆 / 5ms 超时熔断 / 128KB Memory）
│       │   │   ├── prelude.js        # 暴露给玩家脚本的 API（Game.* / ORDER_* 等）
│       │   │   ├── npc.rs            # 零硬编码 NpcGenome 进化权重策略引擎
│       │   │   ├── runner.rs         # rayon 并行决策与 Intent 提交协调器
│       │   │   └── types.rs
│       │   └── tests/sandbox_tests.rs # JS 沙盒限制 & NPC 市场循环测试（5 个用例）
│       └── meridian-server/          # Axum HTTP/WS 网关 + SQLite WAL + 后台管理页
│           ├── assets/
│           │   └── admin.html        # 独立单文件服务器后台（/admin，通过 include_str! 编译进二进制）
│           ├── src/
│           │   ├── main.rs           # 入口、环境变量解析、tokio Tick 后台驱动循环
│           │   ├── api.rs            # REST API + /ws + /admin + frontend/dist 静态托管
│           │   ├── engine.rs         # GameEngine、初始化队列、进化重生、/api/admin/overview
│           │   └── storage.rs        # rusqlite(WAL) 持久化世界状态、脚本、Memory、基因组、K线、成交记录
│           └── tests/server_tests.rs # HTTP/SQLite/后台控制/1200 tick 长周期回归测试
├── frontend/                         # React 18 + TS + Vite + Tailwind + Zustand + CodeMirror 6 + Lightweight Charts v4
│   ├── package.json
│   └── src/
│       ├── App.tsx & main.tsx
│       ├── api/client.ts             # 前端 REST 封装
│       ├── store/useGameStore.ts     # 全局状态与 /ws 增量同步、行情缓存
│       ├── types/meridian.ts         # 前后端契约 TS 类型与中文映射表
│       ├── utils/consoleFormat.ts    # 控制台对象/JSON 折叠树格式化工具
│       ├── components/
│       │   └── Planet3DCanvas.tsx    # 2D Canvas 手写 3D 戈德堡多面体星球渲染（自转与行星参数同步）
│       ├── layout/                   # 独立自研零锁定布局引擎（支持拆分树 + 自由浮动窗 + 命令面板）
│       │   ├── DesktopShell.tsx      # 顶栏、工作区预设切换、管理员快捷入口隐藏策略
│       │   ├── SplitLayout.tsx       # 递归二分平铺树与拖拽调整
│       │   ├── splitTree.ts          # 平铺树状态运算
│       │   ├── FloatingWindowsLayer.tsx # 可拖拽/缩放浮动窗口层
│       │   ├── CommandPalette.tsx    # Cmd/Ctrl+K 快速打开面板
│       │   ├── paneRegistry.ts       # 15 种业务面板注册表
│       │   ├── paneComponents.tsx
│       │   └── workspaces.ts         # 预设工作区（指挥总览/行情交易/编程IDE/星系物流）
│       └── panels/                   # 15 个功能面板
│           ├── OrbitPanel.tsx        # 开普勒椭圆轨道雷达（行星纯色显示 + 贸易站轨道不重合修正）
│           ├── PlanetPanel.tsx       # 3D 星球预览 + 分项参数列表
│           ├── DemandPanel.tsx       # 独立窗口：行星本回合城市消费挂单需求
│           ├── FactoryPanel.tsx      # 地块、造厂、切换配方、启停控制
│           ├── CargoPanel.tsx        # 地表 / 本星轨道站 / Hub 库存
│           ├── FleetPanel.tsx        # 飞船位置、耐久、装卸、派船、修船
│           ├── TickerPanel.tsx       # 全站行情列表（买一/卖一/最新价）
│           ├── ChartPanel.tsx        # K 线与成交量主图（lightweight-charts 4.2.1，支持历史分页与补齐空格K）
│           ├── OrderBookPanel.tsx    # 买卖五档盘口、近期成交与手工限价下单
│           ├── TreasuryPanel.tsx     # 现金/储蓄/负债与星球央行存贷还款
│           ├── RankingPanel.tsx      # 玩家视角简化排行榜（仅净资产与总资产审计，不含后台敏感明细）
│           ├── FileExplorerPanel.tsx # 类 VS Code 脚本模块树与文件夹管理
│           ├── ScriptIdePanel.tsx    # CodeMirror 6 暗色主题多模块 JS IDE 与热重载
│           ├── MemoryPanel.tsx       # 128KB 持久化 Memory JSON 独立检视/编辑器
│           └── ConsolePanel.tsx      # F12 风格 JS 交互控制台与日志流
├── data/
│   └── production.json               # 全局唯一静态产线配置（Schema v1.0.0：3 星球 / 3 职业 / 16 物品 / 7 建筑 / 18 配方）
├── docs/
│   ├── ARCHITECTURE.md               # 原始分模块架构约束规范
│   ├── PROTOCOL.md                   # 快照与 Intent 协议及 JS API 手册
│   ├── prun_research.md              # Prosperous Universe 机制调研笔记
│   └── HANDOVER.md                   # 本文档
├── scripts/
│   └── cargo.sh                      # Rust 工具链包装脚本
├── sim/                              # 早期 Python 经济验证原型 & production.json 可视化编辑器 (recipe_editor.html)
└── archive/                          # legacy_v0 早期实验代码归档
```

---

## 3. 编译、测试与运行方式

### 3.1 环境与工具链

- **Rust**：通过 [`scripts/cargo.sh`](scripts/cargo.sh) 复用本地自包含工具链（默认 `/home/cxxy168/code/rust/sand/.toolchain`，可用环境变量 `MERIDIAN_RUST_TOOLCHAIN` 覆盖），脚本自动 `cd backend`。
- **Node / Frontend**：使用 Vite + TypeScript（`frontend/package.json`），编译产出到 `frontend/dist/`。后端只负责托管 `frontend/dist/` 静态文件，**运行时零 Node 进程**。

### 3.2 常用命令速查

```bash
# 1. 运行全部 Rust 单元测试与集成测试（core 5 + sandbox 5 + server 3 = 13 passed）
./scripts/cargo.sh test --workspace

# 2. 构建并运行后端服务器（默认监听 0.0.0.0:18420）
./scripts/cargo.sh build -p meridian-server
./scripts/cargo.sh run -p meridian-server

# 3. 前端开发 / 生产构建（改完 frontend/src 后务必执行 build，后端直接读取 frontend/dist）
cd frontend && npm install
cd frontend && npm run dev     # Vite 热更新开发
cd frontend && npm run build   # tsc -b && vite build -> frontend/dist
```

> **注意**：`backend/crates/meridian-server/assets/admin.html` 通过 `include_str!` 在**编译期**嵌入二进制。修改完 `admin.html` 后，必须重新 `./scripts/cargo.sh build -p meridian-server` 并重启 `meridian-server` 进程才会生效。

### 3.3 服务端环境变量

定义在 [`backend/crates/meridian-server/src/main.rs`](backend/crates/meridian-server/src/main.rs)：

| 环境变量 | 默认回退逻辑 | 说明 |
|---|---|---|
| `MERIDIAN_ADDR` | `0.0.0.0:18420` | HTTP / WebSocket 监听地址（历史 commit `8961e4c` 从 `3080` 改为了 `18420`） |
| `MERIDIAN_TICK_MS` | `2000` | 启动默认 Tick 间隔（毫秒）；`0` 表示无人工延迟全速运行 |
| `MERIDIAN_DATA_PATH` | `data/production.json` 或 `../data/production.json` | 静态产线与世界配置 JSON |
| `MERIDIAN_DB_PATH` | `data/meridian.db` 或 `../data/meridian.db` | SQLite WAL 持久化数据库路径（注意：`cargo.sh` 会切进 `backend/`，故默认落在 `backend/data/meridian.db`） |
| `MERIDIAN_DIST_DIR` | `frontend/dist` 或 `../frontend/dist` | 前端静态构建目录 |

---

## 4. 经济、产线与 SQLite 数据模型

### 4.1 静态世界配置（`data/production.json`, Schema `1.0.0`）

- **3 个行星 + 1 个中心交易所**：
  - `P1`（灼热矿星-I）、`P2`（新伊甸-II）、`P3`（凛冬外星-III），各自有轨道贸易站 `ST:P1`、`ST:P2`、`ST:P3`，以及星系中央枢纽 `ST:HUB`。
- **3 大职业与 12 个演化 NPC 生态位**：
  - `env_recycle`（环境能源与回收）：`power_water_station`、`recycling_plant`
  - `agri_bio`（生态农食与轻纺）：`bio_greenhouse`、`consumer_workshop`
  - `mining_ind`（矿业与重工基建）：`mine_smelter`、`infra_factory`、`shipyard`
  - 初始世界包含 1 个玩家公司 `player1`（`Meridian Pioneer`, `mining_ind@P1`）以及 12 个初始 NPC（`env_recycle` 4 个、`agri_bio` 4 个、`mining_ind` 4 个，分布于 `P1/P2/P3`）。
- **16 种物品（重点区分瞬时交付品 vs 实体货物）**：
  - **瞬时物品**：`power`（标签 `power`）与 `disposal_cert`（标签 `waste_service`）。由 [`ProductionCatalog::is_instant_item`](backend/crates/meridian-core/src/schema.rs) 统一判定，直接从所在星球地面库存即时挂单/交割，**无需飞船运输到轨道站**。
  - **实体货物**：`water`, `oxygen`, `fuel`, `waste`, `bio_crop`, `bio_fiber`, `rations`, `beverage`, `clothing`, `ore`, `steel`, `building_mat`, `daily_goods`（兼修船耗材）, `ship_small`。需要通过飞船在星球地面与轨道站、以及 `ST:HUB` 之间运载。

### 4.2 SQLite WAL 表结构（[`storage.rs`](backend/crates/meridian-server/src/storage.rs)）

| 表名 | 用途 | 关键说明 |
|---|---|---|
| `world_state` | 世界完整序列化 JSON 快照（`id = 1`） | 每 10 ticks 及优雅停机时写入；重启后从最新快照恢复世界 |
| `player_scripts` | 玩家多模块 JS 代码 | 主键 `(company_id, module_name)`，修改即持久化并热重载 |
| `player_memory` | 玩家持久化 `Memory`（128KB 上限）与 `enabled` 开关 | 每回合写回最新状态 |
| `npc_genomes` | 存活 NPC 的 `NpcGenome` 权重 JSON | 破产时删除旧基因组，重生时写入交叉变异后的新基因组 |
| `candles` | 各 `(station_id, item_id, bucket_tick)` 的 OHLCV K 线 | 支持按 `period` 聚合及按 `from_tick/to_tick` 全历史分段查询 |
| `trade_history` | 全量成交明细流水 | 索引 `(station_id, item_id, id DESC)`，支撑盘口成交流水与后台审计 |

---

## 5. HTTP / WebSocket 接口一览（[`api.rs`](backend/crates/meridian-server/src/api.rs)）

| 方法与路径 | 用途 | 权限/定位 |
|---|---|---|
| `GET /` & static | 托管 `frontend/dist` 玩家端桌面 | 玩家端 |
| `GET /admin`, `/admin.html` | 独立服务器后台控制台 HTML | **管理员后台** |
| `GET /api/admin/overview` | 账本审计、星球/城市状态、全部玩家+NPC 明细（现金/设施/配方/僵死停滞天数/飞船/基因组）、在途舰队 | **管理员后台** |
| `POST /api/sim/control` | `{ action, tick_ms? }`，支持 `pause` / `resume` / `step` / `speed`（`tick_ms` 允许 `0..=60000`，`0` 为最快速度）/ `reset` | **管理员后台**（含重置与速度控制） |
| `GET /api/health` | 健康检查、`tick`、`conservation_error`、`companies_count` | 公共/监控 |
| `GET /api/catalog` | 返回 `production.json` 完整物品/建筑/配方/职业定义 | 玩家端 & 后台 |
| `GET /api/state?company_id=...` | 当前公司完整视角的 `WorldSnapshot` + 全局市场/行星脱敏摘要 | 玩家端 |
| `GET /api/market/book` | 指定 `station_id` + `item_id` 买卖盘口、成交流水与最新 500 根 K 线 | 玩家端 |
| `GET /api/market/candles` | 按 `station_id`, `item_id`, `period`, `from_tick`, `to_tick` 分页拉取 K 线 | 玩家端 |
| `GET/PUT /api/scripts/{company_id}` | 读取 / 保存并热重载多模块 JS 脚本 | 玩家端 |
| `PUT /api/memory/{company_id}` | 读取/覆盖玩家 `Memory` JSON | 玩家端 |
| `POST /api/intent` | 队列化注入单条人工操作 `Intent`（UI 手动下单/建厂/派船/银行） | 玩家端 |
| `POST /api/companies` | 创建新的玩家公司 | 玩家端 |
| `GET /ws` | WebSocket 实时推送 `init` 与每回合 `TickBroadcast` | 玩家端 & 后台 |

---

## 6. 近期演进与关键 Bug 修复档案（防止踩旧坑）

下面记录了本轮连续迭代中最重要的问题与解决结论，后续改动相关模块时务必参考：

### 6.1 开服市场交易量归零 & Tick ~1000 后停滞死锁（已彻底修复）

在排查线上库 `backend/data/meridian.db` 与长周期模拟时，定位并修复了 4 个叠加死锁：

1. **瞬时物品标签写错导致的卖电死锁（最致命）**
   - **现象**：10 个 NPC 地面囤积上万 `power`（总量 `38,894+`），而 `PLANET:P2` 买单飙升到 `2000–4300+` 却几乎零成交；只有新破产重生的 `npc_evo_113`、`npc_evo_114` 刚出生时用轨道站自带的 `60 power` 成交几笔后立刻停滞。
   - **根因**：`npc.rs` 检查了不存在的 `has_tag("instant")`，而 `production.json` 里是 `"power"` 与 `"waste_service"`。导致 NPC 无法识别自身地面库存里的 `power` 与 `disposal_cert` 去轨道站挂卖。
   - **修复**：抽为共享方法 [`ProductionCatalog::is_instant_item`](backend/crates/meridian-core/src/schema.rs)，`world.rs` 与 `npc.rs` 统一调用。
2. **NPC 重生导致的职业单一种群灭绝**
   - **现象**：早期 `env_recycle` 现金排名靠前，`respawn_evolved_npc()` 长期直接复制存活高分 NPC 的职业，导致 1,000 tick 后 12 个 NPC 全部沦为 `env_recycle`，`agri_bio` 和 `mining_ind` 灭绝为 `0`。
   - **修复**：[`engine.rs`](backend/crates/meridian-server/src/engine.rs) 重生时保留 `NpcGenome` 交叉变异进化，但职业与母星按初始 12 生态位缺口动态补齐（保证 3 职业始终各占 4 席并覆盖 `P1/P2/P3`）。
3. **过期卖单不撤、价格尖刺锁死吃单与意图饥饿**
   - **修复**：[`npc.rs`](backend/crates/meridian-sandbox/src/npc.rs) 新增卖单超时撤单重挂（`age >= 36`）；吃买一价时同时锚定 `ref_price * 0.65` 与 `last_p * 0.65`，不再因一次历史高价尖刺拒绝城邦买单；挂单队列**先卖后买**并预留至少 `6` 个 intent 槽位给物流、修船与银行。
4. **产能滞销负反馈 & 全网燃料补给循环**
   - **修复**：[`npc.rs`](backend/crates/meridian-sandbox/src/npc.rs) 对高库存滞销输出做估值衰减；当公司燃料 `< 24` 时提升燃料配方权重；飞船从空间站返航且地面燃料 `< 8` 时自动顺带运回富余燃料。
- **回归验证结果**（`test_long_horizon_1200_ticks_economy_never_stalls`，全过程 `conservation_error == 0`）：
  - **修复前**：1,200 tick 每 200 tick 成交笔数 `[410, 43, 391, 63, 39, 44]`，职业 `{"env_recycle": 12}`，`power=38894`
  - **修复后**：`[1252, 560, 739, 833, 794, 663]`，职业 `{"env_recycle": 4, "agri_bio": 4, "mining_ind": 4}`，`fuel=326`，`power=349`

### 6.2 后台与玩家前端隔离（`/admin` 独立控制台 + 最快速度选项）

- **前后端边界**：普通玩家界面 [`DesktopShell.tsx`](frontend/src/layout/DesktopShell.tsx) 与 [`RankingPanel.tsx`](frontend/src/panels/RankingPanel.tsx) 已剥离一切模拟暂停/加速/重置按钮和 NPC 隐私详情；所有服务端管理权限收口到独立访问路径 `/admin`（[`admin.html`](backend/crates/meridian-server/assets/admin.html)）。
- **最快速度（`0ms`）模式**：
  - `POST /api/sim/control` 支持 `tick_ms: 0`；[`main.rs`](backend/crates/meridian-server/src/main.rs) 在未暂停且 `tick_ms == 0` 时调用 `tokio::task::yield_now().await` 全速推进；暂停时自动恢复 `50ms` 睡眠防止空转。
  - `admin.html` 顶部新增「最快」按钮，同时通过 `scheduleRefresh()` 对高频 WebSocket 推送做了 200ms 节流与并发互斥保护，防止全速运行时打爆后台刷新请求。

### 6.3 前端视觉与 K 线图表已处理事项

- **K 线图（`ChartPanel.tsx`）**：使用 `lightweight-charts@4.2.1`；支持向服务器拉取完整历史 K 线分页（`/api/market/candles`），在空闲回合持续向当前 `tick` 生成 carry-forward 平盘柱体，去除了默认水印并采用红/绿标准蜡烛配色及自由缩放拖拽。
- **星图与 3D 星球（`OrbitPanel.tsx` / `PlanetPanel.tsx` / `Planet3DCanvas.tsx` / `DemandPanel.tsx`）**：
  - 轨道图去除行星白框、冗杂参数与装饰轨道圈/`+` 徽标，纯色缩点+名称渲染；修正了贸易站与行星公转轨道动力学关系及轨道防重合。
  - 行星页改为 3D 戈德堡球体（自转速度严格同步行星自转周期、`ticks_per_day`、`tick_ms` 与暂停状态）+ 参数列表；城市本回合挂单需求拆分为独立窗口 `DemandPanel`。
- **JS Sandbox 生命周期修复（`js_runner.rs`）**：修复过 QuickJS `Runtime`/`Context` 析构顺序问题，确保 `test_infinite_loop_timeout_rolls_back_intents_and_memory` 等超时熔断测试稳定通过。

---

## 7. 运维注意事项与常见排查手册

1. **旧数据库状态继承问题**
   - 如果长期运行旧版二进制后 `meridian.db` 中已经形成单一种群垄断（如全部 NPC 都已演化成 `env_recycle`），重启新版二进制后需要等到下次破产才会逐步补回失衡职业；若希望直接体验全新平衡生态，可在 `/admin` 点击 **重置星系（Reset）**，或停服删除 `backend/data/meridian.db*` 后重启。
2. **代码与测试未提交/已修改清单检查**
   - 交接前建议用 `git status` 检查是否有未提交的后端代码（例如上述 `0ms` 全速模式、`npc.rs` / `engine.rs` / `schema.rs` 长周期修复和本交接文档），按需 `git commit`。
3. **日常回归清单（发版前必跑）**
   ```bash
   # 前端静态构建与 TS 类型校验
   (cd frontend && npm run build)

   # 后端全量测试（重点确认 test_long_horizon_1200_ticks_economy_never_stalls 通过且 conservation_error == 0）
   ./scripts/cargo.sh test --workspace -- --nocapture

   # 重新编译带最新 admin.html 的服务端可执行文件
   ./scripts/cargo.sh build -p meridian-server
   ```

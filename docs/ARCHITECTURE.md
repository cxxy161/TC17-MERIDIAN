# 《Meridian》正式版工程目录与架构管理规范

> 目标约束：**`2C / 500MB`** 服务器稳定 24/7 运行 · 服务端离线跑玩家 **QuickJS** 脚本 · **单人/少人即可完整游玩（供给星球为主目标）** · **NPC 零硬编码自由决策** · 产线由 **`production.json`（Schema v1.0.0）** 数据驱动。

---

## 一、仓库目录结构

```text
Meridian/
├── .gitignore                 # 忽略 target / node_modules / dist / sim/logs / sqlite runtime
├── backend/                   # 【正式 Rust 后端 Cargo Workspace】
│   ├── Cargo.toml
│   └── crates/
│       ├── meridian-core/     # 纯物理与会计引擎（schema, ledger, exchange, logistics, planet, world）
│       ├── meridian-sandbox/  # 统一 Snapshot -> Intent[] 协议、rquickjs 玩家沙盒、0硬编码自由 NPC
│       └── meridian-server/   # axum HTTP/WS 网关、rusqlite(WAL) 持久化、静态前端托管
├── frontend/                  # 【正式前端 React + TS + Vite + Dockview】（后续初始化）
│   └── (src/layout, src/panels, src/store, src/api)
├── data/                      # 【全局唯一静态配置源】
│   └── production.json        # 由产线编辑器导出，严格遵循 sim/production_schema.md (v1.0.0)
├── docs/                      # 【正式版架构、协议、调研与部署文档】
│   ├── ARCHITECTURE.md        # 本文件
│   └── prun_research.md       # PrUn 经济机制调研参考
├── scripts/                   # 【构建与运行脚本】
│   └── cargo.sh               # 复用局部 Rust 工具链的 Cargo 包装脚本
├── sim/                       # 【v0 Python 验证原型 & 产线编辑工具】
│   ├── production_schema.md   # 产线 JSON Schema v1.0.0 规范
│   ├── recipe_editor.html     # 离线产线可视化编辑与体检器
│   └── ...                    # 早期经济学验证脚本（保留作对照，不与正式核心混杂）
└── archive/                   # 【早期实验代码与旧页面归档】
    └── legacy_v0/             # exp0~exp6、server.py、早期 HTML 探索页面
```

> 注：`sim/` 目录暂保留原位，确保独立运行的产线编辑器工具链路径不变；正式版 Rust 内核稳定后可再按需归档。

---

## 二、模块职责铁律

1. **`meridian-core` 严禁出现任何 AI 或商业决策套路**
   - 只负责确定性物理与会计法则：加载 `production.json`、稀疏订单簿 `CLOB` 撮合、星际运输、行星 5 层财富消费与城市废料排出、账本唯一转账通道（货币守恒审计）。
2. **`meridian-sandbox` 对玩家与 NPC 一视同仁**
   - 玩家 JS（`rquickjs`，限额 `4MB` 堆 + `5ms` 中断强杀 + `128KB` 持久化 Memory）与自由 NPC 大脑**共享同一套只读 `WorldSnapshot` 与原子 `Intent[]` 指令枚举**。
3. **`frontend/` 编译成纯静态产物由后端直出**
   - 技术栈：`React + TypeScript + Vite + Tailwind + Dockview + Zustand + CodeMirror 6 + lightweight-charts`。
   - 打包后的 `frontend/dist/` 由 `meridian-server` 静态托管（或嵌入二进制），**服务端零 Node 进程内存开销**。

---

## 三、Rust 工具链复用方式

当前复用了本机 `/home/cxxy168/code/rust/sand/.toolchain` 中的独立工具链（`rustc 1.99.1` / `cargo 1.99.1`），不污染系统全局目录：

```bash
# 在项目根目录直接通过脚本运行任意 cargo 命令（自动切进 backend/）：
./scripts/cargo.sh check
./scripts/cargo.sh test
./scripts/cargo.sh run -p meridian-server
```

如需覆盖工具链路径，设置环境变量 `MERIDIAN_RUST_TOOLCHAIN` 即可。

---

## 四、已确认的外部依赖规划（下一阶段按需引入）

| 端 | 依赖 | 用途 |
|---|---|---|
| Rust 后端 | `axum`, `tokio` | 轻量异步 HTTP/WebSocket 网关 |
| Rust 后端 | `rquickjs` | 玩家离线 JS 沙盒执行与资源硬熔断 |
| Rust 后端 | `rusqlite` (`bundled`) | SQLite WAL 存储脚本、Memory、K线、存档 |
| Rust 后端 | `serde`, `serde_json` | 加载 `data/production.json` 与协议序列化 |
| Rust 后端 | `rayon` | 2 核并行执行 Snapshot 决策阶段 |
| React 前端 | `dockview-react` | 全屏自由拖拽分屏与浮动多窗口桌面 |
| React 前端 | `zustand` | 高频行情增量按需订阅 |
| React 前端 | `codemirror` | 浏览器内玩家 JS 策略编辑器与提示 |
| React 前端 | `lightweight-charts` | K 线与成交量图表 |

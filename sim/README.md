# 《Meridian》多星球恒星系经济模拟后端与诊断架构（`sim/`）

> **定位**：单恒星系多行星经济核心（`1` 主序星 + `3` 颗差异化类地行星 + `1` 座公转中央枢纽站 `ST:HUB`），无多余渲染，专注于验证多星球供需、跨星轴辐物流、独立星球银行、城市容量升级与真实 CLOB 盘口演化。

---

## 一、模块目录与职责

| 文件 | 职责 |
|---|---|
| [__init__.py](file:///home/cxxy168/code/html/Meridian/sim/__init__.py) | `sim` 包入口 |
| [config.py](file:///home/cxxy168/code/html/Meridian/sim/config.py) | 恒星类型 `STAR_TYPES`、船型 `SHIP_SPECS`、23 种配方 `RECIPES`、星球独占原矿 `PLANET_EXCLUSIVE_ORE`、消费解锁门槛 `TIER_UNLOCK_PROSPERITY`、地形修正 `BIOME_TERRAIN_MODS` 与基础常量 |
| [models.py](file:///home/cxxy168/code/html/Meridian/sim/models.py) | 核心实体：`Order`、`Ship`、`ShipInFlight`、`Building`、`SiteJob`、`Plot`（含海洋/城市/五边形标记）、`LandListing`、`Genome`、`PolicyBrain`（`6 -> 4 tanh` + 在线 `(1+1) ES`） |
| [exchange.py](file:///home/cxxy168/code/html/Meridian/sim/exchange.py) | 双向限价订单簿 `CLOBStation`（Maker-Taker 撮合、物理库存守恒、`BANK` 合单、48T 挂单 TTL 过期、抑制空盘自我抬价的 `signal_price` 与三周期 EMA） |
| [planet.py](file:///home/cxxy168/code/html/Meridian/sim/planet.py) | 星球与银行：`PlanetBank`（各星独立储备与利率）、`Planet`（252 地块生成、海洋不可建、固定城市核心地块垂直扩容、满足度动态窗口平滑繁荣度与迟滞解锁） |
| [npc.py](file:///home/cxxy168/code/html/Meridian/sim/npc.py) | 实体企业 AI `SmartNPC`（全部持地建厂，无纯商行；本地生产 + 母星银行理财 + 跨星 `ST:HUB` 采购/出口/闲船套利） |
| [system.py](file:///home/cxxy168/code/html/Meridian/sim/system.py) | 恒星系总控 `StarSystem`（星体公转与开普勒实时航程 `route_cost`、开局 60 家实业企业、破产全额坏账核销与精英演化初创、每日银行台账对平） |
| [logger.py](file:///home/cxxy168/code/html/Meridian/sim/logger.py) | 滚动 JSONL 日志 `SimLogger`（`trades` / `events` / `snapshots` 自动轮转）及命令行回溯工具 |
| [web.py](file:///home/cxxy168/code/html/Meridian/sim/web.py) | 多星球监控 HTTP 服务（`TelemetrySystem` 聚合四站多周期 K 线与宏观历史，提供 `/api/state`、`/api/speed`、`/api/reset`） |
| [monitor.html](file:///home/cxxy168/code/html/Meridian/sim/monitor.html) | 极简多星球经济诊断前端（四站卡片切换、真实成交价 K 线、17 商品四站实时价差矩阵、企业资产表、6 张宏观诊断图） |
| [verify.py](file:///home/cxxy168/code/html/Meridian/sim/verify.py) | 360 天（8640 ticks）无头快速验证脚本 |

---

## 二、恒星系拓扑与核心机制

### 2.1 星系结构与轴辐航运（Hub-and-Spoke Only）
```
  P1 灼热矿星-I (0.90 AU, 95d)  <--ST:P1-->  \
  P2 新伊甸-II   (1.85 AU, 320d) <--ST:P2-->   === ST:HUB 中央枢纽站 (1.45 AU, 200d 公转)
  P3 凛冬外星-III(2.75 AU, 580d) <--ST:P3-->  /
```
- **禁止行星间直飞**：所有跨星物流必须经由公转中的 `ST:HUB` 中转（`星球轨道站 <-> ST:HUB`）。
- **实时开普勒航程**：`StarSystem.route_cost(sid_a, sid_b)` 每 tick 按公转角度实时计算两点欧氏距离 `dist`，换算为 `ticks = max(3, round(dist * 6.0))` 与 `fuel = max(2, round(dist * 3.0))`。
- **全船型可着陆**：小飞船（载重 30）、中货船（100）、大货轮（320）均可星球降落；地面 $\leftrightarrow$ 轨道按行星重力缩放：`launch_ticks_mult = 0.6 + gravity * 0.7`，`launch_fuel_mult = 0.6 + gravity * 0.8`。

### 2.2 统一货币、独立银行 & 252 地块地理
- **统一货币 + 各星独立 `PlanetBank`**：全星系共用同一种现金单位，但每颗行星有自己独立的 `PlanetBank`（`annual_rate_pct` 上限 `18%`，按本星物价指数、繁荣度与存贷利用率更新）。企业只能使用**母星**银行存款、还贷和贷款。
- **252 格行星地理**（Goldberg 细分 5：`240` 六边形 + `12` 五边形）：
  - `is_ocean = True` 的海洋地块**完全不可建造与交易**；
  - 宜居星（`P2`）固定分配 `city_count = 3` 个城市核心地块（`is_city = True`，不可买卖），初始总容量 `city_count * 3000 = 9000`。当 `population >= city_capacity * 0.85` 且成功采购 `mat >= 2` 时，触发垂直扩容（`city_level += 1`，`city_capacity += city_count * 2500`）。

### 2.3 三星球独有原矿与 23 种配方产业链
| 星球 | 特色定位 | 独占原矿（禁止跨星开采） | 对应精炼产线（T3） | 主要下游消耗 |
|---|---|---|---|---|
| **P1 灼热矿星-I** | `gravity=1.40, mineral=1.65, solar=1.60` | `titanium` 炽钛矿（`TitaniumMine`） | `TitaniumMill` → `ti_alloy` 钛材 | `RoboticsPlant`(T8)、中/大型船坞、`P2` 消费(`≥0.65`) |
| **P2 新伊甸-II** | `宜居主星, city_count=3, ocean=45%` | `silicate` 晶硅矿（`SilicateMine`） | `WaferFab` → `wafer` 晶圆 | `PrecisionLab`(T6)、`ElectronicsFab`(T7)、大型船坞、`P2` 消费(`≥0.75`) |
| **P3 凛冬外星-III** | `gravity=0.55, solar=0.45, mineral=1.10` | `helium3` 氦3冰晶（`HeliumExtractor`） | `CryoPlant` → `cryo_cell` 氦冷芯 | `ElectronicsFab`(T7)、`RoboticsPlant`(T8)、`QuantumCenter`(T10)、大型船坞、`P2` 消费(`≥0.85`) |

- 基础 survival/建设产线（`PowerPlant`、`FuelPlant`、`IronMine`、`FoodFarm`、`Smelter`、`MatFactory`、`RepairPlant`、`SmallYard`）不依赖跨星独占矿，避免早期冷启动死锁；且 `PowerPlant` 在断油时可低效冷启动应急发电。

### 2.4 繁荣度平滑、迟滞锁定与冷启动保护（[planet.py](file:///home/cxxy168/code/html/Meridian/sim/planet.py)）
针对早期出现的“繁荣度暴起暴跌 → 厂还没建完（`BUILD_TICKS=168`）需求就退档归零”的振荡，当前采用四层抑制：
1. **对有界满足度 `avg_sat ∈ [0, 1]` 做动态窗口**：波动平缓时取 `240` ticks（10 天），近期波动 `spread` 增大时动态拉长至最高 `720` ticks（30 天），彻底消除无界积分超调。
2. **慢速死区调节**：窗口均值 `win_sat` 在 `[0.68, 0.80]` 中性死区内繁荣度不动；高于 `0.80` 缓升（单 tick 上限 `+0.0008`），低于 `0.68` 缓降（单 tick 下限 `-0.0005`）。
3. **节拍解锁 + 迟滞门槛**：每 `168` ticks 最多新解锁 1 个高阶品类；解锁后拥有 `480` ticks 保护期，退档线设为 `max(0.25, req_p * 0.80 - 0.05)`。
4. **冷启动爬坡隔离**：新解锁前 `288` ticks 采购量从 `25%` 线性爬坡到 `100%`，期间若市场 0 成交，在 `avg_sat` 计算中仅占 `0.10` 权重，不拖垮已有基础盘。

### 2.5 全实业公司自主跨星策略（[npc.py](file:///home/cxxy168/code/html/Meridian/sim/npc.py)）
已彻底移除无地 `商行`：全部企业（开局 `60` 家：P1 `16`、P2 `30`、P3 `14`）皆持有至少 1 块土地，并主动执行：
- **本地与 Hub 比价采购**：原料/`fuel`/`mat`/`repair_parts`/飞船若本地断货或 `ST:HUB` 含运费更划算，直接在 `ST:HUB` 下 `"pickup"` 单并用自家船运回。
- **主动出口余量**：在满足本星基本供给后，评估外星与 `ST:HUB` 扣除 10% 税及往返油费后的净收益，将余货派船运到 `ST:HUB` 挂卖；所有持仓 `station_inventories` 均持续报价，并在无买单且库存超目标 `50%` 时主动 `×0.96` 折价出清。
- **闲船双向套利**：高 `trader_bias` 企业空闲时扫描 `ST:HUB <-> 本星` 真实有买卖盘且净赚 `> 15` 的价差，回程套利货（`hub_arb_items`）站对站直入母星星站挂卖。
- **防空盘自激 & 防产业自毁**：无卖单时买单只锚定 `last_trade_price`（最高 `1.15x`），无买单时多个卖家禁止互相参考未成交卖单加价；新建/改建工厂强制校验全星系消费档位和上游实体供给，破产全额核销 `bank.total_loans` 并每日与在存企业账面对平。

---

## 三、常用运行与日志查询命令

在项目根目录 `/home/cxxy168/code/html/Meridian` 下执行：

```bash
# 1. 启动多星球经济诊断 Web 服务（默认 http://127.0.0.1:8000，自动写入 sim/logs/）
python3 -m sim.web
python3 -m sim.web --port 8080

# 2. 跑 360 天（8640 ticks）快速无头验证（不写磁盘日志，吞吐约 400-550 ticks/s）
python3 -m sim.verify

# 3. 历史滚动日志回溯查询（无需重跑模拟）
python3 -m sim.logger --kind trades --station ST:P2 --item fuel --from-day 750 --to-day 990 --limit 40
python3 -m sim.logger --kind snapshots --station ST:P2 --item food --from-day 1800 --to-day 2100 --limit 20
python3 -m sim.logger --kind events --from-day 1 --to-day 2100 --limit 40
```

---

## 四、后续架构演进备忘（暂不急做，待规模扩大后实施）

### 4.1 全决策收归大脑（三头结构 + 安全护栏）
- **边界原则**：会计/物理/地理硬约束留在确定性规则层（现金/燃料非负、库存守恒、独占原矿校验、空盘价格锚）；商业策略阈值全部交由进化大脑控制。
- **三头拆分设计**：
  1. **盘口与物流头 `MarketBrain`（按商品调用，`8 -> 5`）**：接管开工率 `a_util`、挂卖偏移 `a_quote`、采购加价意愿 `a_bid_aggr`、出口 Hub 倾向 `a_export`、囤货/套利意愿 `a_arb`。
  2. **公司经营头 `FirmBrain`（按公司调用，`8 -> 5`）**：接管目标杠杆率 `a_lev_target`（替换固定存/借阈值）、扩建与买地冲动 `a_expand`、拆厂忍耐线 `a_demolish`、修/买船紧急度 `a_fleet`、船只任务偏好 `a_dispatch_bias`。
  3. **候选评分头 `ScorerBrain`（动态多选一，`6 -> 1`）**：对每个可建配方或每条待派航线提取标准化特征打分排序，支持配方与星球数量任意扩展而无需改网络维度。
- **演化稳健性**：所有网络输出映射为安全倍率/偏移区间；ES 评估周期拉长至 `72 ~ 168` ticks 并结合真实利润流 + 破产精英（Top 25%）交叉遗传。

### 4.2 多核并发优化路线（Map-Reduce Tick 拆分）
- **不要直接对当前 `decide()` 上 Python `threading`**：受 CPython GIL 限制纯 Python 字节码无法真正多核并行，且同 tick 共享订单簿与银行写操作会产生竞态。
- **推荐演进路径（针对 NPC ≥ 500 或重型大脑时）**：
  1. **Phase 1（只读并发决策）**：tick 初生成盘口与星球只读快照，各 NPC 并发前向计算并只输出只读意图对象 `Intent`（下单、贷款、派船、建厂），零共享写与零锁；
  2. **Phase 2（单线程确定性提交）**：随机洗牌/轮转依次校验提交全部 `Intent` 后运行 `match_all`，兼顾会计守恒与结果可复现；
  3. **算力加速顺序**：优先用 **NumPy 批量张量矩阵乘法**（单次 C 层算完所有大脑，性价比最高） → 规模更大时按 Phase 1 分片走 `ProcessPoolExecutor`、Python `3.13t` 无 GIL 或将撮合/AI 热点下沉至 Rust（PyO3）。

---

## 五、部署选型与玩家离线 JS 沙盒架构（`2C / 500MB` 约束）

### 5.1 核心约束与节拍前提
- **硬件目标**：临时服务器仅 `2 Core`、剩余约 **`500 MB`** 内存，且必须**在服务端 24/7 离线运行玩家 JS 代码**，并预留未来扩多星系的余量。
- **线上节拍**：线上按 `1 ~ 5 秒 / Tick`（1 游戏小时）真实节奏运行（而非 `verify.py` 的 `500+ ticks/s` 压测极限），CPU 占用极低；系统层务必开启 `512 MB zram` 防止峰值 OOM。

### 5.2 玩家离线 JS 沙盒：选型与执行模型
- **引擎选型**：**QuickJS / QuickJS-NG**（不采用一人一 Docker 容器或高内存开销的 Node/V8 Isolate）。
  - 单玩家实例仅约 `0.5 ~ 2 MB`，原生支持硬字节内存上限（如 `4 MB/人`）与中断回调（如 `3 ~ 5 ms` 或指令数上限强杀，防 `while(true)` 死循环）。
- **无常驻 `onTick` 模型**：
  1. 玩家上传 JS 模块并暴露 `onTick(api)` 入口，不维持常驻定时器/连接。
  2. 引擎向沙盒注入本回合允许访问的**只读世界快照** + 玩家持久化 `Memory` JSON（限额 `64 ~ 128 KB`，平时存 SQLite）。
  3. 在内存与时间片护栏内跑完 `onTick`，脚本只输出标准 `Intent` 指令（挂单、撤单、派船、建厂）；由主引擎校验资金、库存与物理守恒后统一落账，更新 `Memory` 写回 SQLite。
  4. **LRU 沙盒池 + 错峰调度**：注册几百个离线玩家时，内存仅保持活跃 LRU Context（如上限 30～50 个），沙盒总内存严格锁死在 `120 ~ 150 MB` 以内。

### 5.3 后端技术栈两阶段路线与省内存改造
1. **近期（玩法迭代期）：Python `sim/` + `quickjs` 扩展 + SQLite**
   - 保留当前 Python 模块化结构快速调玩法与经济平衡，使用 Python `quickjs` C 扩展跑玩家离线 JS。
   - **必做 3 项省内存改造**：
     - 全核心 `@dataclass(slots=True)`（砍掉实例 `__dict__`，节省约 40%～50% 对象内存）；
     - **未开发地块惰性实例化**（星球只存随机种子与已占用地块集合，真正买地时再生成 `Plot` 与 `terrain_mods`）；
     - **K 线、历史快照与日志迁入 SQLite（WAL 模式）**，内存只留当前挂单簿与最新 1～2 根 K 线。
2. **中长期（规则定型 / 世界扩容）：平迁 Rust（`axum` + `rquickjs` + `rusqlite`）**
   - 当经济公式、配方与玩家 API 稳定后，按 `sim/` 现有模块边界一对一迁移至 Rust。
   - 模拟核心预计仅占 **`20 ~ 40 MB`** 内存（无 GC 抖动），配合 `rquickjs` 与 `rayon` 跨 2 核并行执行玩家/NPC 逻辑，可在同规格小机上承载 10 倍以上星系规模。

### 5.4 `2C / 500MB` 内存预算切分
| 组件 | 预算 | 说明 |
|---|---|---|
| 系统余量 & `zram` | ~120 MB | 保障 OS 与突发峰值不触发 OOM Killer |
| 世界引擎 + SQLite(WAL) | ~100–130 MB（Rust 后 ~30 MB） | `slots=True` + 惰性地块 + 1～5s/Tick |
| 网关与管理监控 | ~40 MB | HTTP/WS 鉴权、限流与前端面板 |
| 玩家离线 JS 沙盒池 | ~150 MB | QuickJS（`4 MB/人` + `5 ms/回合` + `128 KB Memory` + LRU 池） |

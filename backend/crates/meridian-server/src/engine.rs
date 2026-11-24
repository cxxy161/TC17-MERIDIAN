//! GameEngine host managing World state, SimulationRunner, SQLite WAL persistence,
//! NPC evolutionary replenishment, and WebSocket tick event broadcasts.

use std::collections::{BTreeMap, HashMap};
use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;
use std::time::{Instant, SystemTime, UNIX_EPOCH};

use meridian_core::{
    from_money, snapshot::StarSystemView, Intent, ProductionCatalog, TickReport, World,
    WorldSnapshot,
};
use meridian_sandbox::{
    NpcGenome, PlayerRunConfig, PlayerRunOutput, PlayerScriptBundle, SimulationRunner,
};
use serde::{Deserialize, Serialize};
use tokio::sync::{broadcast, Mutex};

use crate::storage::SqliteStore;
use crate::telemetry::{EconomySample, TelemetryTracker, TickPhases};

pub const STARTER_PLAYER_JS: &str = r#"// 《Meridian》默认玩家策略脚本
// 提示：支持 module.exports.loop、多模块 require()、Game、Memory、Store Proxy 与 console.log

module.exports.loop = function () {
  Memory.ticksSeen = (Memory.ticksSeen || 0) + 1;

  const myPlanetId = Game.company.homePlanetId;
  const stationId = "ST:" + myPlanetId;
  const p = Game.planets[myPlanetId];
  if (!p) return;

  // 1. 查看地面仓矿石与钢材，满载即派空闲飞船运往轨道站挂单
  const ships = Object.values(Game.ships);
  for (const ship of ships) {
    if (!ship.isBusy && ship.location === myPlanetId) {
      const cargo = {};
      let load = 0;
      for (const item of [RESOURCE_ORE, RESOURCE_STEEL, RESOURCE_BUILDING_MAT, RESOURCE_DISPOSAL_CERT]) {
        const avail = p.groundStore[item] || 0;
        if (avail > 0 && load < ship.capacity) {
          const take = Math.min(avail, ship.capacity - load);
          cargo[item] = take;
          load += take;
        }
      }
      if (load >= 4) {
        ship.dispatch(myPlanetId, stationId, cargo);
      }
    } else if (!ship.isBusy && ship.location === stationId) {
      // 返回地面以便下趟运输
      ship.dispatch(stationId, myPlanetId, { [RESOURCE_ORE]: 1 });
    }
  }

  // 2. 在轨道站以略低于当前卖一或参考均价挂卖单
  const st = Game.stations[stationId];
  if (st) {
    for (const item of [RESOURCE_ORE, RESOURCE_STEEL, RESOURCE_BUILDING_MAT]) {
      const qty = st.store[item] || 0;
      if (qty > 0 && Object.keys(Game.market.orders).length < 40) {
        const q = Game.market.quote(stationId, item);
        const refP = q ? (q.bestAsk ? q.bestAsk * 0.98 : q.lastPrice * 1.02) : 2.5;
        Game.market.createOrder({
          type: ORDER_SELL,
          resourceType: item,
          price: Math.max(0.1, Number(refP.toFixed(3))),
          totalAmount: Math.min(qty, 20),
          stationId,
        });
      }
    }
  }

  if (Game.time % 10 === 0) {
    console.log("Tick", Game.time, "| Cash:", Game.company.cash.toFixed(2), "| CPI:", Game.cpi.toFixed(3));
  }
};
"#;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct LeaderboardRow {
    pub id: String,
    pub name: String,
    pub is_player: bool,
    pub home_planet_id: String,
    pub net_liquid: f64,
    pub plots_count: usize,
    pub buildings_count: usize,
    pub ships_count: usize,
    pub open_orders_count: usize,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PlanetSummary {
    pub id: String,
    #[serde(default)]
    pub system_id: String,
    pub name: String,
    pub archetype: String,
    pub wealth_tier: u8,
    pub prosperity: f64,
    pub population: f64,
    pub treasury: f64,
    pub bank_reserves: f64,
    pub bank_rate_bps: u32,
    pub waste_backlog: u32,
    pub unclaimed_plots: u32,
    pub orbit_radius: f64,
    pub orbit_angle: f64,
    #[serde(default)]
    pub habitability: f64,
    #[serde(default)]
    pub solar_mult: f64,
    #[serde(default)]
    pub mineral_mult: f64,
    #[serde(default)]
    pub water_mult: f64,
    #[serde(default)]
    pub ocean_ratio: f64,
    #[serde(default)]
    pub rotation_days: f64,
    #[serde(default)]
    pub visual_seed: u32,
    #[serde(default)]
    pub city_count: u32,
    #[serde(default)]
    pub city_level: u32,
    #[serde(default)]
    pub city_capacity: f64,
    pub demands: HashMap<String, u32>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MarketTickerRow {
    pub station_id: String,
    pub item_id: String,
    pub best_bid: Option<f64>,
    pub best_ask: Option<f64>,
    pub last_price: f64,
    pub vol_50t: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct StateResponse {
    pub tick: u64,
    pub cpi: f64,
    pub paused: bool,
    pub tick_ms: u64,
    pub conservation_error: i128,
    pub total_minted: f64,
    pub hub_orbit_radius: f64,
    pub hub_orbit_days: f64,
    pub hub_orbit_angle: f64,
    #[serde(default)]
    pub systems: Vec<StarSystemView>,
    pub planets: Vec<PlanetSummary>,
    pub leaderboard: Vec<LeaderboardRow>,
    pub market_tickers: Vec<MarketTickerRow>,
    pub player_snapshot: Option<WorldSnapshot>,
    pub last_player_output: Option<PlayerRunOutput>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TickBroadcast {
    pub kind: &'static str,
    pub tick: u64,
    pub cpi: f64,
    pub paused: bool,
    pub tick_ms: u64,
    pub fills_count: usize,
    pub bankruptcies: Vec<String>,
    pub rejected_intents: usize,
    pub conservation_error: i128,
    pub hub_orbit_radius: f64,
    pub hub_orbit_days: f64,
    pub hub_orbit_angle: f64,
    pub planets: Vec<PlanetSummary>,
    pub leaderboard: Vec<LeaderboardRow>,
    pub player_outputs: HashMap<String, PlayerRunOutput>,
}

pub struct GameEngine {
    pub world: World,
    pub runner: SimulationRunner,
    pub store: SqliteStore,
    pub data_path: PathBuf,
    pub paused: bool,
    pub tick_ms: u64,
    next_npc_seq: u64,
    saved_player_memories: HashMap<String, (String, bool)>,
    world_dirty: bool,
    pub events_tx: broadcast::Sender<TickBroadcast>,
    /// 注册/登录限流器（内存态，进程内单例）
    pub auth: crate::auth::AuthLimiter,
    /// 服务端运行时遥测与经济趋势采样
    pub telemetry: TelemetryTracker,
}

impl Drop for GameEngine {
    fn drop(&mut self) {
        let _ = self.flush_persistence();
    }
}

impl GameEngine {
    pub fn bootstrap(
        data_path: PathBuf,
        mut store: SqliteStore,
        tick_ms: u64,
    ) -> Result<Self, String> {
        let catalog = ProductionCatalog::load_from_file(&data_path)?;
        let mut runner = SimulationRunner::new(PlayerRunConfig::default());

        let (events_tx, _) = broadcast::channel(64);

        if let Some(restored_world) = store.load_world()? {
            let bundles = store.load_all_player_bundles()?;
            let memories = store.load_all_player_memories()?;
            let genomes = store.load_all_npc_genomes()?;

            for (cid, bundle) in bundles {
                runner.set_player_script(cid, bundle);
            }
            let saved_player_memories = memories.clone();
            for (cid, (mem, enabled)) in memories {
                let entry = runner.players.entry(cid).or_default();
                entry.memory_json = mem;
                entry.enabled = enabled;
            }
            for (cid, genome) in genomes {
                runner.register_npc(cid, genome);
            }

            // Ensure default player has a script if spawned without one
            for (cid, comp) in &restored_world.companies {
                if comp.is_player && !runner.players.contains_key(cid) {
                    runner.set_player_script(
                        cid,
                        PlayerScriptBundle::single_main(STARTER_PLAYER_JS),
                    );
                }
            }

            let max_existing_seq = restored_world
                .companies
                .keys()
                .filter_map(|id| id.strip_prefix("npc_evo_")?.parse::<u64>().ok())
                .max()
                .unwrap_or(99);
            let next_npc_seq = (max_existing_seq + 1).max(100);
            let mut engine = Self {
                world: restored_world,
                runner,
                store,
                data_path,
                paused: false,
                tick_ms,
                next_npc_seq,
                saved_player_memories,
                world_dirty: false,
                events_tx,
                auth: crate::auth::AuthLimiter::default(),
                telemetry: TelemetryTracker::default(),
            };
            // Heal cohort if an older DB has fewer than the minimum active NPC floor (respecting 90% plot cap)
            while engine.world.companies.values().filter(|c| !c.is_player).count() < 36 {
                let before = engine.world.companies.len();
                engine.respawn_evolved_npc();
                if engine.world.companies.len() == before {
                    break;
                }
            }
            return Ok(engine);
        }

        let mut world = World::new_generated(catalog, generate_world_seed());
        Self::seed_initial_actors(&mut world, &mut runner, &mut store)?;
        store.save_world(&world)?;

        let mut saved_player_memories = HashMap::new();
        saved_player_memories.insert("player1".to_string(), ("{}".to_string(), true));

        Ok(Self {
            world,
            runner,
            store,
            data_path,
            paused: false,
            tick_ms,
            next_npc_seq: 100,
            saved_player_memories,
            world_dirty: false,
            events_tx,
            auth: crate::auth::AuthLimiter::default(),
            telemetry: TelemetryTracker::default(),
        })
    }

    fn preferred_player_home_planet(world: &World) -> String {
        let mut candidates: Vec<&meridian_core::Planet> = world.planets.values().collect();
        candidates.sort_by(|a, b| {
            let a_avail = (a.unclaimed_plots_remaining > 0) as u8;
            let b_avail = (b.unclaimed_plots_remaining > 0) as u8;
            b_avail
                .cmp(&a_avail)
                .then_with(|| {
                    let ascore = a.mineral_mult * 0.55 + a.habitability * 0.45;
                    let bscore = b.mineral_mult * 0.55 + b.habitability * 0.45;
                    bscore
                        .partial_cmp(&ascore)
                        .unwrap_or(std::cmp::Ordering::Equal)
                })
                .then_with(|| a.id.cmp(&b.id))
        });
        candidates
            .first()
            .map(|p| p.id.clone())
            .unwrap_or_else(|| "P1".to_string())
    }

    fn allocate_initial_npcs(world: &World) -> Vec<(&'static str, String)> {
        let mut planets: Vec<&meridian_core::Planet> = world.planets.values().collect();
        planets.sort_by(|a, b| a.id.cmp(&b.id));
        if planets.is_empty() {
            return Vec::new();
        }

        const TOTAL_NPCS: usize = 48;
        let weights: Vec<f64> = planets
            .iter()
            .map(|p| {
                1.0 + (p.city_count as f64).sqrt() * 1.8
                    + p.habitability * 1.6
                    + p.mineral_mult * 0.65
            })
            .collect();
        let w_sum: f64 = weights.iter().sum::<f64>().max(1.0);
        let caps: Vec<usize> = planets
            .iter()
            .map(|p| world.npc_plot_cap_on(&p.id).max(1) as usize)
            .collect();

        let mut counts: Vec<usize> = weights
            .iter()
            .zip(caps.iter())
            .map(|(w, &cap)| ((TOTAL_NPCS as f64 * (*w / w_sum)).round() as usize).clamp(1, cap))
            .collect();

        let mut cur_total: usize = counts.iter().sum();
        while cur_total < TOTAL_NPCS {
            let mut progressed = false;
            for idx in 0..planets.len() {
                if cur_total >= TOTAL_NPCS {
                    break;
                }
                if counts[idx] < caps[idx] {
                    counts[idx] += 1;
                    cur_total += 1;
                    progressed = true;
                }
            }
            if !progressed {
                break;
            }
        }
        while cur_total > TOTAL_NPCS {
            if let Some((idx, _)) = counts
                .iter()
                .enumerate()
                .filter(|&(_, &c)| c > 1)
                .max_by_key(|&(_, &c)| c)
            {
                counts[idx] -= 1;
                cur_total -= 1;
            } else {
                break;
            }
        }

        let mut cohort = Vec::with_capacity(cur_total);
        for (p, n) in planets.iter().zip(counts.into_iter()) {
            // Profession mix adapts naturally to each generated planet's physics
            let (w_mine, w_env, _w_agri) = if p.city_count >= 4 || p.habitability >= 0.56 {
                (0.28, 0.36, 0.36)
            } else if p.mineral_mult >= 1.25 && p.city_count == 0 {
                (0.56, 0.24, 0.20)
            } else if p.water_mult >= 1.25 && p.city_count == 0 {
                (0.32, 0.40, 0.28)
            } else {
                (0.42, 0.32, 0.26)
            };
            let n_mine = ((n as f64) * w_mine).round() as usize;
            let n_env = ((n as f64) * w_env).round() as usize;
            let mut rem_mine = n_mine.min(n);
            let mut rem_env = n_env.min(n - rem_mine);
            let mut rem_agri = n.saturating_sub(rem_mine + rem_env);
            if n >= 3 && rem_agri == 0 {
                if rem_mine > 1 {
                    rem_mine -= 1;
                } else if rem_env > 1 {
                    rem_env -= 1;
                }
                rem_agri += 1;
            }
            for _ in 0..rem_mine {
                cohort.push(("mining_ind", p.id.clone()));
            }
            for _ in 0..rem_env {
                cohort.push(("env_recycle", p.id.clone()));
            }
            for _ in 0..rem_agri {
                cohort.push(("agri_bio", p.id.clone()));
            }
        }
        cohort
    }

    fn seed_initial_actors(
        world: &mut World,
        runner: &mut SimulationRunner,
        store: &mut SqliteStore,
    ) -> Result<(), String> {
        let player_home = Self::preferred_player_home_planet(world);
        world.spawn_company(
            "player1",
            "Meridian Pioneer",
            true,
            "mining_ind",
            &player_home,
            10_000.0,
        )?;
        let starter_bundle = PlayerScriptBundle::single_main(STARTER_PLAYER_JS);
        runner.set_player_script("player1", starter_bundle.clone());
        store.save_player_bundle("player1", &starter_bundle)?;
        store.save_player_memory("player1", "{}", true)?;

        // Dynamic 48-NPC cohort distributed across all generated planets within 90% plot cap
        let cohort = Self::allocate_initial_npcs(world);
        for (i, (prof, planet)) in cohort.iter().enumerate() {
            let cid = format!("npc_{i:02}");
            let name = Self::generate_npc_name(world, i as u64);
            world.spawn_company(&cid, name, false, prof, planet, 8_000.0)?;
            let genome = NpcGenome::from_seed(7000 + i as u64 * 97);
            store.save_npc_genome(&cid, &genome)?;
            runner.register_npc(cid, genome);
        }

        Ok(())
    }

    /// 按环境变量创建初始管理员（幂等，已存在则跳过）。
    ///
    /// 需要同时设置 `MERIDIAN_ADMIN_EMAIL` 与 `MERIDIAN_ADMIN_PASSWORD`（≥8 位），
    /// 可选 `MERIDIAN_ADMIN_NICKNAME`（默认 Admin）。优先接管未认领的 player1 公司。
    pub fn seed_admin_from_env(&mut self) -> Result<Option<(String, String)>, String> {
        let email = match std::env::var("MERIDIAN_ADMIN_EMAIL") {
            Ok(v) if !v.trim().is_empty() => v.trim().to_lowercase(),
            _ => return Ok(None),
        };
        let password = match std::env::var("MERIDIAN_ADMIN_PASSWORD") {
            Ok(v) if v.chars().count() >= 8 => v,
            Ok(_) => return Err("MERIDIAN_ADMIN_PASSWORD 少于 8 位".to_string()),
            Err(_) => return Ok(None),
        };
        if self.store.email_taken(&email) {
            return Ok(None);
        }
        let nickname = std::env::var("MERIDIAN_ADMIN_NICKNAME")
            .ok()
            .map(|s| s.trim().to_string())
            .filter(|s| (2..=16).contains(&s.chars().count()))
            .unwrap_or_else(|| "Admin".to_string());
        let (salt, hash) = crate::auth::hash_password(&password)?;
        let now = crate::auth::now_secs();
        let user_id = self
            .store
            .create_user(&email, &nickname, &hash, &salt, "admin", "", now)?;
        let company_id = if self.company_is_unclaimed("player1") {
            "player1".to_string()
        } else {
            format!("u{user_id}")
        };
        self.store.set_user_company(user_id, &company_id)?;
        self.provision_player_company(&company_id, &nickname)?;
        Ok(Some((email, company_id)))
    }

    /// 公司是否还没有归属账号（用于「首个注册者接管 player1」）。
    pub fn company_is_unclaimed(&self, company_id: &str) -> bool {
        self.store.user_by_company(company_id).is_none()
    }

    /// 为新注册账号准备公司：已有公司（如 player1）只补齐 VM/存档，否则新建。
    pub fn provision_player_company(
        &mut self,
        company_id: &str,
        nickname: &str,
    ) -> Result<(), String> {
        if self.world.companies.contains_key(company_id) {
            if !self.runner.players.contains_key(company_id) {
                let bundle = PlayerScriptBundle::single_main(STARTER_PLAYER_JS);
                self.store.save_player_bundle(company_id, &bundle)?;
                self.store.save_player_memory(company_id, "{}", true)?;
                self.saved_player_memories
                    .insert(company_id.to_string(), ("{}".to_string(), true));
                self.runner.set_player_script(company_id, bundle);
            }
            return Ok(());
        }
        let home_pid = Self::preferred_player_home_planet(&self.world);
        self.world
            .spawn_company(company_id, nickname, true, "mining_ind", &home_pid, 10_000.0)?;
        self.world_dirty = true;
        let bundle = PlayerScriptBundle::single_main(STARTER_PLAYER_JS);
        self.store.save_player_bundle(company_id, &bundle)?;
        self.store.save_player_memory(company_id, "{}", true)?;
        self.saved_player_memories
            .insert(company_id.to_string(), ("{}".to_string(), true));
        self.runner.set_player_script(company_id, bundle);
        Ok(())
    }

    pub fn mark_player_memory_saved(&mut self, company_id: &str, memory_json: &str, enabled: bool) {
        self.saved_player_memories
            .insert(company_id.to_string(), (memory_json.to_string(), enabled));
    }

    pub fn mark_world_dirty(&mut self) {
        self.world_dirty = true;
    }

    fn collect_dirty_player_memories(&self) -> Vec<(String, String, bool)> {
        let mut dirty = Vec::new();
        for (cid, pvm) in &self.runner.players {
            let is_dirty = match self.saved_player_memories.get(cid) {
                Some((saved_mem, saved_en)) => {
                    *saved_en != pvm.enabled || saved_mem != &pvm.memory_json
                }
                None => true,
            };
            if is_dirty {
                dirty.push((cid.clone(), pvm.memory_json.clone(), pvm.enabled));
            }
        }
        dirty
    }

    /// Flush any dirty player memories and pending world state snapshot cleanly to SQLite.
    pub fn flush_persistence(&mut self) -> Result<(), String> {
        let dirty_memories = self.collect_dirty_player_memories();
        if !self.world_dirty && dirty_memories.is_empty() {
            return Ok(());
        }
        let dirty_refs: Vec<(&str, &str, bool)> = dirty_memories
            .iter()
            .map(|(c, m, e)| (c.as_str(), m.as_str(), *e))
            .collect();
        let world_ref = if self.world_dirty {
            Some(&self.world)
        } else {
            None
        };
        self.store
            .persist_tick_batch(&[], 1, false, &dirty_refs, &[], &[], world_ref)?;
        for (cid, mem, en) in dirty_memories {
            self.saved_player_memories.insert(cid, (mem, en));
        }
        self.world_dirty = false;
        Ok(())
    }

    pub fn step_once(&mut self) -> Result<TickBroadcast, String> {
        let step_t0 = Instant::now();
        let report = self.runner.step_world(&mut self.world);
        self.world_dirty = true;

        // Dynamic market-driven NPC startups every 24 ticks (respecting 90% per-planet land cap)
        let npc_t0 = Instant::now();
        let new_npcs = if self.world.tick % 24 == 0 {
            self.run_npc_startups()
        } else {
            Vec::new()
        };
        let npc_spawn_ms = npc_t0.elapsed().as_secs_f64() * 1000.0;

        let save_world_now = self.world.tick % 40 == 0;
        let prune_history_now = self.world.tick % 25 == 0;
        let dirty_memories = self.collect_dirty_player_memories();
        let dirty_refs: Vec<(&str, &str, bool)> = dirty_memories
            .iter()
            .map(|(c, m, e)| (c.as_str(), m.as_str(), *e))
            .collect();
        let new_npc_refs: Vec<(&str, &NpcGenome)> = new_npcs
            .iter()
            .map(|(c, g)| (c.as_str(), g))
            .collect();

        // Coalesce fills, history pruning, dirty player memories, NPC genome changes, and
        // periodic world snapshots into a single SQLite WAL transaction per tick.
        let persist_t0 = Instant::now();
        self.store.persist_tick_batch(
            &report.fills,
            1,
            prune_history_now,
            &dirty_refs,
            &report.bankruptcies,
            &new_npc_refs,
            if save_world_now { Some(&self.world) } else { None },
        )?;
        let persist_ms = persist_t0.elapsed().as_secs_f64() * 1000.0;

        for (cid, mem, en) in dirty_memories {
            self.saved_player_memories.insert(cid, (mem, en));
        }
        if save_world_now {
            self.world_dirty = false;
        }

        let bcast_t0 = Instant::now();
        let bcast = self.build_broadcast(&report);
        let broadcast_ms = bcast_t0.elapsed().as_secs_f64() * 1000.0;
        let total_ms = step_t0.elapsed().as_secs_f64() * 1000.0;

        let mut player_net = 0.0;
        let mut npc_net = 0.0;
        for c in self.world.companies.values() {
            let nl = from_money(c.cash + c.savings - c.debt);
            if c.is_player {
                player_net += nl;
            } else {
                npc_net += nl;
            }
        }
        let open_orders_count: usize = self
            .world
            .stations
            .values()
            .map(|st| {
                st.bids.values().map(|v| v.len()).sum::<usize>()
                    + st.asks.values().map(|v| v.len()).sum::<usize>()
            })
            .sum();
        let idle_buildings = self
            .world
            .buildings
            .values()
            .filter(|b| b.active && b.idle_ticks > 0)
            .count();
        let fills_qty: u32 = report.fills.iter().map(|f| f.qty).sum();
        let mut timeouts = 0u64;
        let mut ooms = 0u64;
        for out in self.runner.last_player_outputs.values() {
            if out.timed_out {
                timeouts += 1;
            }
            if out.oom {
                ooms += 1;
            }
        }
        let phases = TickPhases {
            snapshot_ms: self.runner.last_timing.snapshot_ms,
            actors_ms: self.runner.last_timing.actors_ms,
            world_tick_ms: self.runner.last_timing.world_tick_ms,
            npc_spawn_ms,
            persist_ms,
            broadcast_ms,
            total_ms,
        };
        let econ = EconomySample {
            tick: self.world.tick,
            cpi: self.world.cpi,
            total_minted: from_money_i128(self.world.ledger.expected_circulation()),
            player_net_liquid: player_net,
            npc_net_liquid: npc_net,
            fills_count: report.fills.len(),
            fills_qty,
            open_orders_count,
            idle_buildings,
            step_total_ms: total_ms,
        };
        self.telemetry.record_tick(
            phases,
            save_world_now,
            self.world.tick,
            timeouts,
            ooms,
            report.rejected_intents,
            econ,
        );

        let _ = self.events_tx.send(bcast.clone());
        Ok(bcast)
    }

    fn respawn_evolved_npc(&mut self) {
        let mut ranked: Vec<(f64, String, String, String)> = self
            .world
            .companies
            .values()
            .filter(|c| !c.is_player)
            .map(|c| {
                let net = from_money(c.cash + c.savings - c.debt);
                (
                    net,
                    c.id.clone(),
                    c.profession.clone(),
                    c.home_planet_id.clone(),
                )
            })
            .collect();
        ranked.sort_by(|a, b| b.0.partial_cmp(&a.0).unwrap_or(std::cmp::Ordering::Equal));

        let mut seq = self.next_npc_seq;
        while self.world.companies.contains_key(&format!("npc_evo_{seq}")) {
            seq += 1;
        }
        self.next_npc_seq = seq + 1;

        // Preserve ecosystem profession & planet niche diversity dynamically across all generated planets
        let target_niches: Vec<(&'static str, String, usize)> = Self::allocate_initial_npcs(&self.world)
            .into_iter()
            .fold(HashMap::<(&'static str, String), usize>::new(), |mut acc, pair| {
                *acc.entry(pair).or_insert(0) += 1;
                acc
            })
            .into_iter()
            .map(|((prof, pid), want)| (prof, pid, want))
            .collect();
        if target_niches.is_empty() {
            return;
        }
        let mut best_idx = (seq as usize) % target_niches.len();
        let mut best_deficit: i32 = i32::MIN;
        for off in 0..target_niches.len() {
            let i = ((seq as usize) + off) % target_niches.len();
            let (p, ref pl, want) = target_niches[i];
            if self.world.npc_plot_count_on(pl) >= self.world.npc_plot_cap_on(pl) {
                continue;
            }
            let have = self
                .world
                .companies
                .values()
                .filter(|c| !c.is_player && c.profession == p && c.home_planet_id == *pl)
                .count() as i32;
            let deficit = want as i32 - have;
            if deficit > best_deficit {
                best_deficit = deficit;
                best_idx = i;
            }
        }
        let (prof, ref planet, _) = target_niches[best_idx];
        if let Some((new_cid, genome)) = self.spawn_evolved_company_on(
            prof,
            planet,
            seq,
            &ranked,
            6_000.0 * self.world.cpi.clamp(0.5, 4.0),
        ) {
            let _ = self.store.save_npc_genome(&new_cid, &genome);
            self.world_dirty = true;
        }
    }

    fn generate_npc_name(world: &World, seq: u64) -> String {
        const ONSETS: [&str; 20] = [
            "b", "c", "d", "f", "g", "h", "j", "k", "l", "m",
            "n", "p", "qu", "r", "s", "t", "v", "w", "x", "z",
        ];
        const VOWELS: [&str; 12] = [
            "a", "e", "i", "o", "u", "ae", "io", "au", "ou", "ei", "ya", "ea",
        ];
        const SUFFIXES: [&str; 16] = [
            "", "x", "n", "r", "s", "k", "v", "th", "ra", "on", "ix", "ar", "el", "or", "is", "um",
        ];
        // M = 20*12*20*12*20*12 = 13,824,000 = 2^11 * 3^3 * 5^3.
        // Multiplier A = 5_743_121 has gcd(A, M) == 1 (coprime to 2, 3, 5), giving an exact
        // 1-to-1 bijection over 13.82M 3-syllable English-like words.
        const SPACE: u64 = 13_824_000;
        const MULT: u64 = 5_743_121;
        let seed_mix = (world.world_seed ^ 0x9E37_79B9_7F4A_7C15) % SPACE;

        for attempt in 0u64..64 {
            let v = seq.wrapping_add(attempt.wrapping_mul(1_048_573));
            let epoch = v / SPACE;
            let perm = ((v % SPACE).wrapping_mul(MULT).wrapping_add(seed_mix)) % SPACE;

            let n = perm as usize;
            let o1 = ONSETS[n % 20];
            let v1 = VOWELS[(n / 20) % 12];
            let o2 = ONSETS[(n / 240) % 20];
            let v2 = VOWELS[(n / 4_800) % 12];
            let o3 = ONSETS[(n / 57_600) % 20];
            let v3 = VOWELS[(n / 1_152_000) % 12];
            let suf = if epoch > 0 || attempt > 0 {
                SUFFIXES[((epoch + attempt) as usize) % SUFFIXES.len()]
            } else {
                ""
            };
            let raw = format!("{o1}{v1}{o2}{v2}{o3}{v3}{suf}");
            let mut chars = raw.chars();
            let candidate = match chars.next() {
                Some(c) => format!("{}{}", c.to_ascii_uppercase(), chars.as_str()),
                None => "Veklari".to_string(),
            };
            if !world
                .companies
                .values()
                .any(|c| c.name.eq_ignore_ascii_case(&candidate))
            {
                return candidate;
            }
        }
        format!("Vek{:x}", seq)
    }

    fn spawn_evolved_company_on(
        &mut self,
        prof: &str,
        planet: &str,
        seq: u64,
        ranked: &[(f64, String, String, String)],
        seed_credits: f64,
    ) -> Option<(String, NpcGenome)> {
        if self.world.npc_plot_count_on(planet) >= self.world.npc_plot_cap_on(planet) {
            return None;
        }
        let new_cid = format!("npc_evo_{seq}");
        let name = Self::generate_npc_name(&self.world, seq);
        if self
            .world
            .spawn_npc_startup(&new_cid, name, prof, planet, seed_credits)
            .is_err()
        {
            return None;
        }
        let same_prof_elites: Vec<&str> = ranked
            .iter()
            .filter(|r| r.2 == prof)
            .map(|r| r.1.as_str())
            .collect();
        let pool: Vec<&str> = if same_prof_elites.len() >= 2 {
            same_prof_elites
        } else {
            ranked.iter().map(|r| r.1.as_str()).collect()
        };
        let genome = if pool.len() >= 2 {
            let elite_len = (pool.len() / 4).max(2).min(pool.len());
            let idx_a = (seq as usize) % elite_len;
            let idx_b = ((seq as usize).wrapping_mul(7) + 1) % elite_len;
            let ga = self
                .runner
                .npc_genomes
                .get(pool[idx_a])
                .cloned()
                .unwrap_or_default();
            let gb = self
                .runner
                .npc_genomes
                .get(pool[idx_b])
                .cloned()
                .unwrap_or_default();
            NpcGenome::crossover_mutate(&ga, &gb, seq.wrapping_mul(1315423911), 0.15)
        } else {
            NpcGenome::from_seed(seq.wrapping_mul(2654435761))
        };
        self.runner.register_npc(new_cid.clone(), genome.clone());
        Some((new_cid, genome))
    }

    /// Market-driven NPC startups on planets with profitable shortages (capped at 90% planet land & <=72 NPCs).
    fn run_npc_startups(&mut self) -> Vec<(String, NpcGenome)> {
        let mut spawned = Vec::new();
        const MAX_GLOBAL_NPCS: usize = 72;
        let mut total_npcs = self
            .world
            .companies
            .values()
            .filter(|c| !c.is_player)
            .count();
        if total_npcs >= MAX_GLOBAL_NPCS {
            return spawned;
        }

        let mut ranked: Vec<(f64, String, String, String)> = self
            .world
            .companies
            .values()
            .filter(|c| !c.is_player)
            .map(|c| {
                let net = from_money(c.cash + c.savings - c.debt);
                (
                    net,
                    c.id.clone(),
                    c.profession.clone(),
                    c.home_planet_id.clone(),
                )
            })
            .collect();
        ranked.sort_by(|a, b| b.0.partial_cmp(&a.0).unwrap_or(std::cmp::Ordering::Equal));

        let cpi = self.world.cpi.max(0.25);
        let profs = ["env_recycle", "agri_bio", "mining_ind"];
        let mut planet_order: Vec<(String, u32, f64)> = self
            .world
            .planets
            .values()
            .map(|p| (p.id.clone(), p.city_count, p.habitability))
            .collect();
        planet_order.sort_by(|a, b| {
            b.1.cmp(&a.1)
                .then_with(|| b.2.partial_cmp(&a.2).unwrap_or(std::cmp::Ordering::Equal))
                .then_with(|| a.0.cmp(&b.0))
        });
        let total_p_weight: f64 = planet_order
            .iter()
            .map(|(_, cc, hab)| 1.0 + (*cc as f64).sqrt() * 1.8 + *hab * 1.6)
            .sum::<f64>()
            .max(1.0);

        for (pid, cc, hab) in &planet_order {
            if total_npcs >= MAX_GLOBAL_NPCS {
                break;
            }
            let Some(p) = self.world.planets.get(pid) else {
                continue;
            };
            let w = 1.0 + (*cc as f64).sqrt() * 1.8 + *hab * 1.6;
            let min_p = ((48.0 * w / total_p_weight).round() as usize).clamp(4, 24);
            let cap_p = ((min_p as f64 * 1.65).ceil() as usize + (p.population / 500.0) as usize)
                .min(42)
                .max(min_p);
            let mut cur_on_p = self
                .world
                .companies
                .values()
                .filter(|c| !c.is_player && c.home_planet_id == *pid)
                .count();
            if cur_on_p >= cap_p {
                continue;
            }

            let sid = p.station_id.clone();
            let hub_sid = self
                .world
                .systems
                .get(&p.system_id)
                .map(|s| s.hub_station_id.clone())
                .unwrap_or_else(|| "ST:HUB".to_string());
            let n_spawn = if cur_on_p < min_p { 2 } else { 1 };

            for _ in 0..n_spawn {
                if total_npcs >= MAX_GLOBAL_NPCS
                    || cur_on_p >= cap_p
                    || self.world.npc_plot_count_on(pid) >= self.world.npc_plot_cap_on(pid)
                {
                    break;
                }
                // Check there is either a BANK listing or unclaimed plot before picking startup
                let has_land = self
                    .world
                    .planets
                    .get(pid)
                    .map(|pl| {
                        pl.unclaimed_plots_remaining > 0
                            || pl.land_listings.iter().any(|l| l.seller_id == "BANK")
                    })
                    .unwrap_or(false);
                if !has_land {
                    break;
                }

                // Evaluate best profession on this planet using current market prices & shortages
                let (best_prof, best_margin) = {
                    let st_opt = self.world.stations.get(&sid);
                    let hub_opt = self.world.stations.get(&hub_sid);
                    let mut best_prof = profs[0];
                    let mut best_score = f64::NEG_INFINITY;
                    let mut best_margin = 0.0;
                    for &pr_id in &profs {
                        let Some(pr_def) = self.world.catalog.professions.get(pr_id) else {
                            continue;
                        };
                        let have_pr = self
                            .world
                            .companies
                            .values()
                            .filter(|c| !c.is_player && c.home_planet_id == *pid && c.profession == pr_id)
                            .count();
                        let mut top_m = -1.0f64;
                        let mut shortage_bonus = 0.0f64;
                        for btype in &pr_def.starter_buildings {
                            let Some(rids) = self.world.catalog.recipes_by_building.get(btype) else {
                                continue;
                            };
                            for rid in rids {
                                let Some(r) = self.world.catalog.recipes.get(rid) else {
                                    continue;
                                };
                                let inputs_ok = r.inputs.iter().all(|inp| {
                                    inp.item == "waste"
                                        || st_opt
                                            .and_then(|s| s.best_ask(&inp.item))
                                            .is_some()
                                        || hub_opt
                                            .and_then(|h| h.best_ask(&inp.item))
                                            .is_some()
                                });
                                if !inputs_ok && !r.inputs.is_empty() {
                                    continue;
                                }
                                let in_c = r.labor_cost * cpi
                                    + r.power_cost as f64
                                        * st_opt
                                            .and_then(|s| {
                                                s.best_ask("power")
                                                    .or_else(|| s.last_trade_price.get("power").copied())
                                            })
                                            .map(from_money)
                                            .unwrap_or(2.0 * cpi)
                                    + r.inputs
                                        .iter()
                                        .map(|inp| {
                                            let p_est = st_opt
                                                .and_then(|s| {
                                                    s.best_ask(&inp.item)
                                                        .or_else(|| s.last_trade_price.get(&inp.item).copied())
                                                })
                                                .map(from_money)
                                                .unwrap_or_else(|| {
                                                    self.world
                                                        .catalog
                                                        .items
                                                        .get(&inp.item)
                                                        .map(|i| i.ref_price * cpi)
                                                        .unwrap_or(2.0 * cpi)
                                                });
                                            inp.qty as f64 * p_est
                                        })
                                        .sum::<f64>();
                                let out_v: f64 = r
                                    .outputs
                                    .iter()
                                    .map(|o| {
                                        let p_est = st_opt
                                            .map(|s| {
                                                let lp = s
                                                    .last_trade_price
                                                    .get(&o.item)
                                                    .copied()
                                                    .map(from_money)
                                                    .unwrap_or(1.0);
                                                let bb = s.best_bid(&o.item).map(from_money).unwrap_or(0.0);
                                                if s.best_ask(&o.item).is_none() && bb > lp {
                                                    shortage_bonus += 0.25;
                                                    bb.min(lp * 4.0)
                                                } else {
                                                    lp.max(bb)
                                                }
                                            })
                                            .unwrap_or(2.0 * cpi);
                                        o.qty as f64 * p_est
                                    })
                                    .sum();
                                let m = ((out_v - in_c) / in_c.max(1.0)).clamp(-1.0, 3.0);
                                if m > top_m {
                                    top_m = m;
                                }
                            }
                        }
                        // Encourage underrepresented professions locally and globally so no monopoly forms
                        let global_have_pr = self
                            .world
                            .companies
                            .values()
                            .filter(|c| !c.is_player && c.profession == pr_id)
                            .count();
                        let global_target = (total_npcs.max(3) as f64) / 3.0;
                        let local_crowding_pen =
                            (have_pr as f64 / (cur_on_p.max(1) as f64 / 3.0)) * 0.25;
                        let global_crowding_pen =
                            (global_have_pr as f64 / global_target.max(1.0)) * 0.55;
                        let global_scarcity_bonus = if global_have_pr < 8 {
                            (8 - global_have_pr) as f64 * 0.25
                        } else {
                            0.0
                        };
                        let score =
                            top_m + shortage_bonus + global_scarcity_bonus - local_crowding_pen - global_crowding_pen;
                        if score > best_score {
                            best_score = score;
                            best_prof = pr_id;
                            best_margin = top_m + global_scarcity_bonus;
                        }
                    }
                    (best_prof, best_margin)
                };

                if cur_on_p >= min_p && best_margin <= 0.12 {
                    break;
                }

                let mut seq = self.next_npc_seq;
                while self.world.companies.contains_key(&format!("npc_evo_{seq}")) {
                    seq += 1;
                }
                self.next_npc_seq = seq + 1;
                let seed_cash = (6_000.0 * cpi).clamp(3_000.0, 12_000.0);
                if let Some(created) =
                    self.spawn_evolved_company_on(best_prof, pid, seq, &ranked, seed_cash)
                {
                    spawned.push(created);
                    cur_on_p += 1;
                    total_npcs += 1;
                } else {
                    break;
                }
            }
        }
        spawned
    }

    pub fn reset_world(&mut self) -> Result<TickBroadcast, String> {
        let catalog = ProductionCatalog::load_from_file(&self.data_path)?;
        self.store.clear_world_and_history()?;
        self.runner.npc_genomes.clear();
        self.runner.extra_intents.clear();
        self.runner.last_player_outputs.clear();

        let mut new_world = World::new_generated(catalog, generate_world_seed());
        Self::seed_initial_actors(&mut new_world, &mut self.runner, &mut self.store)?;
        self.store.save_world(&new_world)?;
        self.world = new_world;
        self.next_npc_seq = 100;
        self.saved_player_memories.clear();
        self.saved_player_memories
            .insert("player1".to_string(), ("{}".to_string(), true));
        self.world_dirty = false;
        self.telemetry.reset_history();

        let empty_rep = TickReport {
            tick: self.world.tick,
            fills: Vec::new(),
            bankruptcies: Vec::new(),
            rejected_intents: 0,
            cpi: self.world.cpi,
        };
        let bcast = self.build_broadcast(&empty_rep);
        let _ = self.events_tx.send(bcast.clone());
        Ok(bcast)
    }

    pub fn primary_hub_station_id(&self) -> String {
        self.world
            .systems
            .get("S1")
            .or_else(|| self.world.systems.values().next())
            .map(|s| s.hub_station_id.clone())
            .unwrap_or_else(|| "ST:HUB".to_string())
    }

    pub fn system_summaries(&self) -> Vec<StarSystemView> {
        let mut out: Vec<StarSystemView> = self
            .world
            .systems
            .values()
            .map(|s| StarSystemView {
                id: s.id.clone(),
                name: s.name.clone(),
                star_class: s.star_class.clone(),
                luminosity: s.luminosity,
                x: s.x,
                y: s.y,
                hub_station_id: s.hub_station_id.clone(),
                hub_orbit_radius: s.hub_orbit_radius,
                hub_orbit_days: s.hub_orbit_days,
                hub_orbit_angle: s.hub_orbit_angle,
            })
            .collect();
        if out.is_empty() {
            out.push(StarSystemView {
                id: "S1".to_string(),
                name: "新伊甸星系".to_string(),
                star_class: "G2V 黄矮星".to_string(),
                luminosity: 1.0,
                x: 0.0,
                y: 0.0,
                hub_station_id: "ST:HUB".to_string(),
                hub_orbit_radius: self.world.hub_orbit_radius,
                hub_orbit_days: self.world.hub_orbit_days,
                hub_orbit_angle: self.world.hub_orbit_angle,
            });
        }
        out.sort_by(|a, b| a.id.cmp(&b.id));
        out
    }

    pub fn planet_summaries(&self) -> Vec<PlanetSummary> {
        let mut out: Vec<PlanetSummary> = self
            .world
            .planets
            .values()
            .map(|p| PlanetSummary {
                id: p.id.clone(),
                system_id: p.system_id.clone(),
                name: p.name.clone(),
                archetype: p.archetype.clone(),
                wealth_tier: p.wealth_tier,
                prosperity: p.prosperity,
                population: p.population,
                treasury: from_money(p.treasury),
                bank_reserves: from_money(p.bank.reserves),
                bank_rate_bps: p.bank.annual_rate_bps,
                waste_backlog: p.waste_backlog,
                unclaimed_plots: p.unclaimed_plots_remaining,
                orbit_radius: p.orbit_radius,
                orbit_angle: p.orbit_angle,
                habitability: p.habitability,
                solar_mult: p.solar_mult,
                mineral_mult: p.mineral_mult,
                water_mult: p.water_mult,
                ocean_ratio: p.ocean_ratio,
                rotation_days: p.rotation_days,
                visual_seed: p.visual_seed,
                city_count: p.city_count,
                city_level: p.city_level,
                city_capacity: p.city_capacity,
                demands: p.last_demands.clone(),
            })
            .collect();
        out.sort_by(|a, b| a.orbit_radius.partial_cmp(&b.orbit_radius).unwrap_or(std::cmp::Ordering::Equal).then_with(|| a.id.cmp(&b.id)));
        out
    }

    pub fn leaderboard(&self) -> Vec<LeaderboardRow> {
        let mut order_counts: HashMap<&str, usize> = HashMap::new();
        for st in self.world.stations.values() {
            for o in st.bids.values().chain(st.asks.values()).flat_map(|v| v.iter()) {
                *order_counts.entry(o.owner_id.as_str()).or_insert(0) += 1;
            }
        }
        let mut rows: Vec<LeaderboardRow> = self
            .world
            .companies
            .values()
            .map(|c| {
                let buildings_count = c
                    .plots
                    .iter()
                    .filter_map(|pid| self.world.plots.get(pid))
                    .map(|pl| pl.building_ids.len())
                    .sum();
                LeaderboardRow {
                    id: c.id.clone(),
                    name: c.name.clone(),
                    is_player: c.is_player,
                    home_planet_id: c.home_planet_id.clone(),
                    net_liquid: from_money(c.cash + c.savings - c.debt),
                    plots_count: c.plots.len(),
                    buildings_count,
                    ships_count: c.ships.len(),
                    open_orders_count: order_counts.get(c.id.as_str()).copied().unwrap_or(0),
                }
            })
            .collect();
        rows.sort_by(|a, b| {
            b.net_liquid
                .partial_cmp(&a.net_liquid)
                .unwrap_or(std::cmp::Ordering::Equal)
                .then_with(|| a.id.cmp(&b.id))
        });
        rows
    }

    pub fn market_tickers(&self) -> Vec<MarketTickerRow> {
        let mut rows = Vec::new();
        for (sid, st) in &self.world.stations {
            for item_id in self.world.catalog.items.keys() {
                let fallback = to_money_f(
                    self.world
                        .catalog
                        .items
                        .get(item_id)
                        .map(|i| i.ref_price)
                        .unwrap_or(1.0),
                );
                let q = st.quote(item_id, fallback);
                rows.push(MarketTickerRow {
                    station_id: sid.clone(),
                    item_id: item_id.clone(),
                    best_bid: q.best_bid.map(from_money),
                    best_ask: q.best_ask.map(from_money),
                    last_price: from_money(q.last_price),
                    vol_50t: q.vol_50t,
                });
            }
        }
        rows.sort_by(|a, b| a.station_id.cmp(&b.station_id).then(a.item_id.cmp(&b.item_id)));
        rows
    }

    pub fn admin_overview(&mut self) -> serde_json::Value {
        let ov_t0 = Instant::now();
        let mut order_counts_by_owner: HashMap<String, usize> = HashMap::new();
        let mut station_stats = serde_json::Map::new();

        for (sid, st) in &self.world.stations {
            let mut bid_count = 0usize;
            let mut ask_count = 0usize;
            for o in st.bids.values().flat_map(|v| v.iter()) {
                bid_count += 1;
                *order_counts_by_owner.entry(o.owner_id.clone()).or_insert(0) += 1;
            }
            for o in st.asks.values().flat_map(|v| v.iter()) {
                ask_count += 1;
                *order_counts_by_owner.entry(o.owner_id.clone()).or_insert(0) += 1;
            }
            station_stats.insert(
                sid.clone(),
                serde_json::json!({
                    "station_id": sid,
                    "bid_orders": bid_count,
                    "ask_orders": ask_count,
                }),
            );
        }

        let mut planets_detail: Vec<serde_json::Value> = self
            .world
            .planets
            .values()
            .map(|p| {
                serde_json::json!({
                    "id": p.id,
                    "system_id": p.system_id,
                    "name": p.name,
                    "archetype": p.archetype,
                    "habitability": p.habitability,
                    "city_count": p.city_count,
                    "orbit_radius": p.orbit_radius,
                    "population": p.population,
                    "wealth_tier": p.wealth_tier,
                    "prosperity": p.prosperity,
                    "treasury": from_money(p.treasury),
                    "bank_reserves": from_money(p.bank.reserves),
                    "bank_deposits": from_money(p.bank.total_deposits),
                    "bank_loans": from_money(p.bank.total_loans),
                    "bank_rate_bps": p.bank.annual_rate_bps,
                    "waste_backlog": p.waste_backlog,
                    "unclaimed_plots": p.unclaimed_plots_remaining,
                    "land_listings_count": p.land_listings.len(),
                    "primary_land_price": from_money(p.primary_land_price(self.world.cpi)),
                    "demands": p.last_demands,
                })
            })
            .collect();
        planets_detail.sort_by(|a, b| {
            a["id"]
                .as_str()
                .unwrap_or("")
                .cmp(b["id"].as_str().unwrap_or(""))
        });

        let companies_detail: Vec<serde_json::Value> = self
            .world
            .companies
            .values()
            .map(|c| {
                let blds: Vec<serde_json::Value> = c
                    .plots
                    .iter()
                    .filter_map(|pid| self.world.plots.get(pid))
                    .flat_map(|pl| pl.building_ids.iter().filter_map(|bid| self.world.buildings.get(bid)))
                    .map(|b| {
                        serde_json::json!({
                            "id": b.id,
                            "planet_id": b.planet_id,
                            "building_type": b.building_type,
                            "recipe_id": b.recipe_id,
                            "active": b.active,
                            "active_batch": b.active_batch,
                            "progress": b.progress,
                            "idle_ticks": b.idle_ticks,
                            "efficiency": b.efficiency,
                        })
                    })
                    .collect();

                let ships: Vec<serde_json::Value> = c
                    .ships
                    .iter()
                    .map(|s| {
                        serde_json::json!({
                            "id": s.id,
                            "size": format!("{:?}", s.size).to_lowercase(),
                            "capacity": s.capacity(),
                            "location": s.location,
                            "durability": s.durability,
                            "busy_until": s.busy_until,
                            "is_busy": s.is_busy(self.world.tick),
                            "cargo": s.cargo,
                        })
                    })
                    .collect();

                let ground_inv: serde_json::Map<String, serde_json::Value> = c
                    .ground_inv
                    .iter()
                    .filter_map(|(pid, m)| {
                        let nz: serde_json::Map<String, serde_json::Value> = m
                            .iter()
                            .filter(|(_, q)| **q > 0)
                            .map(|(k, &q)| (k.clone(), serde_json::json!(q)))
                            .collect();
                        if nz.is_empty() {
                            None
                        } else {
                            Some((pid.clone(), serde_json::Value::Object(nz)))
                        }
                    })
                    .collect();

                let station_inv: serde_json::Map<String, serde_json::Value> = c
                    .station_inv
                    .iter()
                    .filter_map(|(sid, m)| {
                        let nz: serde_json::Map<String, serde_json::Value> = m
                            .iter()
                            .filter(|(_, q)| **q > 0)
                            .map(|(k, &q)| (k.clone(), serde_json::json!(q)))
                            .collect();
                        if nz.is_empty() {
                            None
                        } else {
                            Some((sid.clone(), serde_json::Value::Object(nz)))
                        }
                    })
                    .collect();

                let player_script = if c.is_player {
                    self.runner.players.get(&c.id).map(|pvm| {
                        let out = self.runner.last_player_outputs.get(&c.id);
                        serde_json::json!({
                            "enabled": pvm.enabled,
                            "modules_count": pvm.bundle.modules.len(),
                            "memory_bytes": pvm.memory_json.len(),
                            "logs_count": out.map(|o| o.logs.len()).unwrap_or(0),
                            "cpu_used_ms": out.map(|o| o.cpu_used_ms).unwrap_or(0.0),
                            "error": out.and_then(|o| o.error.clone()),
                            "timed_out": out.map(|o| o.timed_out).unwrap_or(false),
                            "oom": out.map(|o| o.oom).unwrap_or(false),
                        })
                    })
                } else {
                    None
                };

                let npc_genome = if !c.is_player {
                    self.runner.npc_genomes.get(&c.id).cloned()
                } else {
                    None
                };

                serde_json::json!({
                    "id": c.id,
                    "name": c.name,
                    "is_player": c.is_player,
                    "profession": c.profession,
                    "home_planet_id": c.home_planet_id,
                    "cash": from_money(c.cash),
                    "savings": from_money(c.savings),
                    "debt": from_money(c.debt),
                    "net_liquid": from_money(c.cash + c.savings - c.debt),
                    "distress_ticks": c.distress_ticks,
                    "plots_count": c.plots.len(),
                    "open_orders_count": order_counts_by_owner.get(&c.id).copied().unwrap_or(0),
                    "buildings": blds,
                    "ships": ships,
                    "ground_inv": ground_inv,
                    "station_inv": station_inv,
                    "player_script": player_script,
                    "npc_genome": npc_genome,
                })
            })
            .collect();

        let mut companies_sorted = companies_detail;
        companies_sorted.sort_by(|a, b| {
            let va = a["net_liquid"].as_f64().unwrap_or(0.0);
            let vb = b["net_liquid"].as_f64().unwrap_or(0.0);
            vb.partial_cmp(&va).unwrap_or(std::cmp::Ordering::Equal)
        });

        let in_flight: Vec<serde_json::Value> = self
            .world
            .in_flight
            .iter()
            .map(|f| {
                serde_json::json!({
                    "ship_id": f.ship_id,
                    "owner_id": f.owner_id,
                    "from": f.from,
                    "to": f.to,
                    "arrival_tick": f.arrival_tick,
                    "cargo": f.cargo,
                })
            })
            .collect();

        // Macro economy & supply-chain bottleneck telemetry
        let mut total_buildings = 0usize;
        let mut active_buildings = 0usize;
        let mut idle_buildings = 0usize;
        let mut missing_inputs: HashMap<String, usize> = HashMap::new();
        for b in self.world.buildings.values() {
            total_buildings += 1;
            if b.active {
                active_buildings += 1;
                if b.idle_ticks > 0 {
                    idle_buildings += 1;
                    if let (Some(r), Some(comp)) = (
                        self.world.catalog.recipes.get(&b.recipe_id),
                        self.world.companies.get(&b.owner_id),
                    ) {
                        for inp in &r.inputs {
                            if comp.ground_qty(&b.planet_id, &inp.item) < inp.qty {
                                *missing_inputs.entry(inp.item.clone()).or_insert(0) += 1;
                            }
                        }
                        if r.power_cost > 0 && comp.ground_qty(&b.planet_id, "power") < r.power_cost {
                            *missing_inputs.entry("power".to_string()).or_insert(0) += 1;
                        }
                    }
                }
            }
        }
        let mut missing_inputs_top: Vec<serde_json::Value> = missing_inputs
            .into_iter()
            .map(|(item_id, count)| serde_json::json!({ "item_id": item_id, "idle_count": count }))
            .collect();
        missing_inputs_top.sort_by(|a, b| {
            b["idle_count"]
                .as_u64()
                .unwrap_or(0)
                .cmp(&a["idle_count"].as_u64().unwrap_or(0))
        });
        missing_inputs_top.truncate(10);

        let mut prof_npc_counts: BTreeMap<String, usize> = BTreeMap::new();
        let mut player_net_liquid = 0.0;
        let mut npc_net_liquid = 0.0;
        let mut player_count = 0usize;
        let mut npc_count = 0usize;
        for c in self.world.companies.values() {
            let nl = from_money(c.cash + c.savings - c.debt);
            if c.is_player {
                player_count += 1;
                player_net_liquid += nl;
            } else {
                npc_count += 1;
                npc_net_liquid += nl;
                *prof_npc_counts.entry(c.profession.clone()).or_insert(0) += 1;
            }
        }
        let total_developable_plots: u32 = self.world.planets.values().map(|p| p.total_developable_plots).sum();
        let total_unclaimed_plots: u32 = self.world.planets.values().map(|p| p.unclaimed_plots_remaining).sum();
        let total_listed_plots: usize = self.world.planets.values().map(|p| p.land_listings.len()).sum();

        // Player sandbox summary
        let mut active_scripts = 0usize;
        let mut total_cpu_used_ms = 0.0;
        let mut max_script_cpu_ms = 0.0;
        let mut max_script_company: Option<String> = None;
        for (cid, pvm) in &self.runner.players {
            if pvm.enabled {
                active_scripts += 1;
            }
            if let Some(out) = self.runner.last_player_outputs.get(cid) {
                total_cpu_used_ms += out.cpu_used_ms;
                if out.cpu_used_ms > max_script_cpu_ms {
                    max_script_cpu_ms = out.cpu_used_ms;
                    max_script_company = Some(cid.clone());
                }
            }
        }

        // Registered user accounts & active sessions
        let now_s = crate::auth::now_secs();
        let users = self.store.list_all_users();
        let active_sessions = self.store.list_active_sessions(now_s);
        let (ws_total, ws_by_company) = self.telemetry.ws_counts();
        let mut sess_by_user: HashMap<i64, Vec<&crate::storage::SessionRow>> = HashMap::new();
        for s in &active_sessions {
            sess_by_user.entry(s.user_id).or_default().push(s);
        }
        let accounts: Vec<serde_json::Value> = users
            .iter()
            .map(|u| {
                let us = sess_by_user.get(&u.id);
                let sess_count = us.map(|v| v.len()).unwrap_or(0);
                let last_seen = us.and_then(|v| v.iter().map(|s| s.last_seen_at).max());
                let user_agents: Vec<&str> = us
                    .map(|v| v.iter().map(|s| s.user_agent.as_str()).take(3).collect())
                    .unwrap_or_default();
                let comp = self.world.companies.get(&u.company_id);
                let script_enabled = self
                    .runner
                    .players
                    .get(&u.company_id)
                    .map(|p| p.enabled)
                    .unwrap_or(false);
                serde_json::json!({
                    "id": u.id,
                    "email": u.email,
                    "nickname": u.nickname,
                    "role": u.role,
                    "status": u.status,
                    "company_id": u.company_id,
                    "company_name": comp.map(|c| c.name.as_str()).unwrap_or(&u.company_id),
                    "net_liquid": comp.map(|c| from_money(c.cash + c.savings - c.debt)).unwrap_or(0.0),
                    "script_enabled": script_enabled,
                    "created_at": u.created_at,
                    "last_login_at": u.last_login_at,
                    "last_seen_at": last_seen,
                    "active_sessions": sess_count,
                    "ws_connections": ws_by_company.get(&u.company_id).copied().unwrap_or(0),
                    "user_agents": user_agents,
                })
            })
            .collect();

        let (dur_last, dur_avg, dur_p95, dur_max) = self.telemetry.duration_stats_ms();
        let tps = self.telemetry.tps();
        let cpu = self.telemetry.sample_cpu();
        let memory = self.telemetry.sample_memory();
        let storage = self.telemetry.storage_sizes(self.store.db_path.as_deref());
        let recent_trades = self.store.recent_trades(60);
        let overview_gen_ms = ov_t0.elapsed().as_secs_f64() * 1000.0;

        serde_json::json!({
            "tick": self.world.tick,
            "cpi": self.world.cpi,
            "paused": self.paused,
            "tick_ms": self.tick_ms,
            "conservation_error": self.world.conservation_error(),
            "total_minted": from_money_i128(self.world.ledger.expected_circulation()),
            "ledger": {
                "total_minted": from_money_i128(self.world.ledger.total_minted),
                "total_burned": from_money_i128(self.world.ledger.total_burned),
                "total_trade_fees": from_money_i128(self.world.ledger.total_trade_fees),
                "total_storage_fees": from_money_i128(self.world.ledger.total_storage_fees),
                "total_wages_paid": from_money_i128(self.world.ledger.total_wages_paid),
            },
            "runtime": {
                "uptime_secs": self.telemetry.started_at.elapsed().as_secs(),
                "tps": tps,
                "tick_last_ms": dur_last,
                "tick_avg_ms": dur_avg,
                "tick_p95_ms": dur_p95,
                "tick_max_ms": dur_max,
                "phases": self.telemetry.last_phases,
                "cpu": cpu,
                "memory": memory,
                "storage": storage,
                "last_persisted_tick": self.telemetry.last_persisted_tick,
                "last_persisted_ago_secs": self.telemetry.last_persisted_at.elapsed().as_secs(),
                "ws_total": ws_total,
                "ws_by_company": ws_by_company,
                "users_total": users.len(),
                "active_sessions": active_sessions.len(),
                "sandbox": {
                    "active_scripts": active_scripts,
                    "total_cpu_used_ms": total_cpu_used_ms,
                    "max_script_cpu_ms": max_script_cpu_ms,
                    "max_script_company": max_script_company,
                    "total_timeouts": self.telemetry.total_js_timeouts,
                    "total_ooms": self.telemetry.total_js_ooms,
                    "total_rejected_intents": self.telemetry.total_rejected_intents,
                },
                "overview_gen_ms": overview_gen_ms,
            },
            "supply_chain": {
                "player_count": player_count,
                "npc_count": npc_count,
                "player_net_liquid": player_net_liquid,
                "npc_net_liquid": npc_net_liquid,
                "total_buildings": total_buildings,
                "active_buildings": active_buildings,
                "idle_buildings": idle_buildings,
                "missing_inputs_top": missing_inputs_top,
                "profession_npc_counts": prof_npc_counts,
                "total_developable_plots": total_developable_plots,
                "total_unclaimed_plots": total_unclaimed_plots,
                "total_listed_plots": total_listed_plots,
            },
            "economy_history": self.telemetry.economy_history,
            "accounts": accounts,
            "recent_trades": recent_trades,
            "systems": self.system_summaries(),
            "hub_orbit_radius": self.world.hub_orbit_radius,
            "planets": planets_detail,
            "stations": station_stats,
            "companies": companies_sorted,
            "market_tickers": self.market_tickers(),
            "in_flight": in_flight,
        })
    }

    pub fn state_response(&self, company_id: &str) -> StateResponse {
        StateResponse {
            tick: self.world.tick,
            cpi: self.world.cpi,
            paused: self.paused,
            tick_ms: self.tick_ms,
            conservation_error: self.world.conservation_error(),
            total_minted: from_money_i128(self.world.ledger.expected_circulation()),
            hub_orbit_radius: self.world.hub_orbit_radius,
            hub_orbit_days: self.world.hub_orbit_days,
            hub_orbit_angle: self.world.hub_orbit_angle,
            systems: self.system_summaries(),
            planets: self.planet_summaries(),
            leaderboard: self.leaderboard(),
            market_tickers: self.market_tickers(),
            player_snapshot: self.world.snapshot_for(company_id),
            last_player_output: self.runner.last_player_outputs.get(company_id).cloned(),
        }
    }

    pub fn queue_manual_intent(&mut self, company_id: String, intent: Intent) -> Result<(), String> {
        if !self.world.companies.contains_key(&company_id) {
            return Err(format!("Unknown company '{company_id}'"));
        }
        self.runner
            .extra_intents
            .entry(company_id)
            .or_default()
            .push(intent);
        Ok(())
    }

    fn build_broadcast(&self, report: &TickReport) -> TickBroadcast {
        TickBroadcast {
            kind: "tick",
            tick: report.tick,
            cpi: report.cpi,
            paused: self.paused,
            tick_ms: self.tick_ms,
            fills_count: report.fills.len(),
            bankruptcies: report.bankruptcies.clone(),
            rejected_intents: report.rejected_intents,
            conservation_error: self.world.conservation_error(),
            hub_orbit_radius: self.world.hub_orbit_radius,
            hub_orbit_days: self.world.hub_orbit_days,
            hub_orbit_angle: self.world.hub_orbit_angle,
            planets: self.planet_summaries(),
            leaderboard: self.leaderboard(),
            player_outputs: self.runner.last_player_outputs.clone(),
        }
    }
}

static WORLD_SEED_SEQ: AtomicU64 = AtomicU64::new(1);

pub fn generate_world_seed() -> u64 {
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_nanos() as u64)
        .unwrap_or(0x4D45_5249_4449_414E);
    let seq = WORLD_SEED_SEQ.fetch_add(1, Ordering::Relaxed);
    let mut z = nanos ^ seq.wrapping_mul(0x9E37_79B9_7F4A_7C15);
    z = (z ^ (z >> 30)).wrapping_mul(0xBF58_476D_1CE4_E5B9);
    z = (z ^ (z >> 27)).wrapping_mul(0x94D0_49BB_1331_11EB);
    z ^ (z >> 31)
}

#[inline]
fn to_money_f(credits: f64) -> i64 {
    meridian_core::to_money(credits)
}

#[inline]
fn from_money_i128(v: i128) -> f64 {
    v as f64 / meridian_core::MONEY_SCALE as f64
}

pub type SharedEngine = Arc<Mutex<GameEngine>>;

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_npc_names_15000_unique_english_nonsense() {
        let data_path = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("..")
            .join("..")
            .join("..")
            .join("data")
            .join("production.json");
        let cat = ProductionCatalog::load_from_file(&data_path).unwrap();
        let world = World::new_generated(cat, 424242);
        let mut seen = std::collections::HashSet::with_capacity(15_000);
        for seq in 0u64..15_000 {
            let name = GameEngine::generate_npc_name(&world, seq);
            assert!(name.len() >= 4 && name.len() <= 14, "unexpected length: {name}");
            assert!(
                name.chars().all(|c| c.is_ascii_alphabetic()),
                "expected pure English letters, got {name}"
            );
            assert!(seen.insert(name.to_lowercase()), "duplicate NPC name at seq {seq}: {name}");
        }
        assert_eq!(seen.len(), 15_000);
    }
}

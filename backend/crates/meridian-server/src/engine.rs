//! GameEngine host managing World state, SimulationRunner, SQLite WAL persistence,
//! NPC evolutionary replenishment, and WebSocket tick event broadcasts.

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::Arc;

use meridian_core::{from_money, Intent, ProductionCatalog, TickReport, World, WorldSnapshot};
use meridian_sandbox::{
    NpcGenome, PlayerRunConfig, PlayerRunOutput, PlayerScriptBundle, SimulationRunner,
};
use serde::{Deserialize, Serialize};
use tokio::sync::{broadcast, Mutex};

use crate::storage::SqliteStore;

pub const STARTER_PLAYER_JS: &str = r#"// 《Meridian》Screeps 风格默认玩家策略脚本
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
    pub profession: String,
    pub home_planet_id: String,
    pub cash: f64,
    pub savings: f64,
    pub debt: f64,
    pub net_liquid: f64,
    pub plots_count: usize,
    pub ships_count: usize,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PlanetSummary {
    pub id: String,
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
    pub events_tx: broadcast::Sender<TickBroadcast>,
    /// 注册/登录限流器（内存态，进程内单例）
    pub auth: crate::auth::AuthLimiter,
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
                events_tx,
                auth: crate::auth::AuthLimiter::default(),
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

        let mut world = World::new_standard(catalog);
        Self::seed_initial_actors(&mut world, &mut runner, &mut store)?;
        store.save_world(&world)?;

        Ok(Self {
            world,
            runner,
            store,
            data_path,
            paused: false,
            tick_ms,
            next_npc_seq: 100,
            events_tx,
            auth: crate::auth::AuthLimiter::default(),
        })
    }

    fn seed_initial_actors(
        world: &mut World,
        runner: &mut SimulationRunner,
        store: &mut SqliteStore,
    ) -> Result<(), String> {
        // Starter player on P1 (can also spawn extra players via /api/companies)
        world.spawn_company("player1", "Meridian Pioneer", true, "mining_ind", "P1", 10_000.0)?;
        let starter_bundle = PlayerScriptBundle::single_main(STARTER_PLAYER_JS);
        runner.set_player_script("player1", starter_bundle.clone());
        store.save_player_bundle("player1", &starter_bundle)?;
        store.save_player_memory("player1", "{}", true)?;

        // Balanced initial cohort of 48 0-hardcoded NPCs across P1/P2/P3 (90% plot cap safe)
        let mut cohort: Vec<(&str, &str)> = Vec::with_capacity(48);
        // P1 (12): heavy mining/industrial base + local support
        cohort.extend(std::iter::repeat_n(("mining_ind", "P1"), 8));
        cohort.extend(std::iter::repeat_n(("env_recycle", "P1"), 2));
        cohort.extend(std::iter::repeat_n(("agri_bio", "P1"), 2));
        // P2 (24): populous habitable core + all 3 chains
        cohort.extend(std::iter::repeat_n(("env_recycle", "P2"), 9));
        cohort.extend(std::iter::repeat_n(("agri_bio", "P2"), 9));
        cohort.extend(std::iter::repeat_n(("mining_ind", "P2"), 6));
        // P3 (12): outer cold planet fuel/water/mining + agri
        cohort.extend(std::iter::repeat_n(("env_recycle", "P3"), 5));
        cohort.extend(std::iter::repeat_n(("agri_bio", "P3"), 3));
        cohort.extend(std::iter::repeat_n(("mining_ind", "P3"), 4));

        for (i, (prof, planet)) in cohort.iter().enumerate() {
            let cid = format!("npc_{i:02}");
            let name = format!("Autonomous-{prof}-{i:02}");
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
                self.runner.set_player_script(company_id, bundle);
            }
            return Ok(());
        }
        self.world
            .spawn_company(company_id, nickname, true, "mining_ind", "P1", 10_000.0)?;
        let bundle = PlayerScriptBundle::single_main(STARTER_PLAYER_JS);
        self.store.save_player_bundle(company_id, &bundle)?;
        self.store.save_player_memory(company_id, "{}", true)?;
        self.runner.set_player_script(company_id, bundle);
        Ok(())
    }

    pub fn step_once(&mut self) -> Result<TickBroadcast, String> {
        let report = self.runner.step_world(&mut self.world);

        // Persist fills & candles + updated player Memory JSON
        if !report.fills.is_empty() {
            self.store.record_tick_fills(&report.fills, 1)?;
        }
        for (cid, pvm) in &self.runner.players {
            let _ = self
                .store
                .save_player_memory(cid, &pvm.memory_json, pvm.enabled);
        }

        // Remove genomes of bankrupted NPCs (their plots return to BANK land_listings)
        for dead_cid in &report.bankruptcies {
            let _ = self.store.delete_npc_genome(dead_cid);
        }

        // Dynamic market-driven NPC startups every 24 ticks (respecting 90% per-planet land cap)
        if self.world.tick % 24 == 0 {
            self.run_npc_startups();
        }

        if self.world.tick % 10 == 0 {
            self.store.save_world(&self.world)?;
        }

        let bcast = self.build_broadcast(&report);
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

        // Preserve ecosystem profession & planet niche diversity scaled to 48-NPC baseline
        let target_niches: [(&str, &str, usize); 9] = [
            ("env_recycle", "P2", 9),
            ("agri_bio", "P2", 9),
            ("mining_ind", "P2", 6),
            ("mining_ind", "P1", 8),
            ("env_recycle", "P1", 2),
            ("agri_bio", "P1", 2),
            ("env_recycle", "P3", 5),
            ("agri_bio", "P3", 3),
            ("mining_ind", "P3", 4),
        ];
        let mut best_idx = (seq as usize) % target_niches.len();
        let mut best_deficit: i32 = i32::MIN;
        for off in 0..target_niches.len() {
            let i = ((seq as usize) + off) % target_niches.len();
            let (p, pl, want) = target_niches[i];
            if self.world.npc_plot_count_on(pl) >= self.world.npc_plot_cap_on(pl) {
                continue;
            }
            let have = self
                .world
                .companies
                .values()
                .filter(|c| !c.is_player && c.profession == p && c.home_planet_id == pl)
                .count() as i32;
            let deficit = want as i32 - have;
            if deficit > best_deficit {
                best_deficit = deficit;
                best_idx = i;
            }
        }
        let (prof, planet, _) = target_niches[best_idx];
        self.spawn_evolved_company_on(prof, planet, seq, &ranked, 6_000.0 * self.world.cpi.clamp(0.5, 4.0));
    }

    fn spawn_evolved_company_on(
        &mut self,
        prof: &str,
        planet: &str,
        seq: u64,
        ranked: &[(f64, String, String, String)],
        seed_credits: f64,
    ) -> bool {
        if self.world.npc_plot_count_on(planet) >= self.world.npc_plot_cap_on(planet) {
            return false;
        }
        let new_cid = format!("npc_evo_{seq}");
        if self
            .world
            .spawn_npc_startup(&new_cid, format!("Evo-{prof}-{seq}"), prof, planet, seed_credits)
            .is_err()
        {
            return false;
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
        let _ = self.store.save_npc_genome(&new_cid, &genome);
        self.runner.register_npc(new_cid, genome);
        true
    }

    /// Market-driven NPC startups on planets with profitable shortages (capped at 90% planet land & <=72 NPCs).
    fn run_npc_startups(&mut self) {
        const MAX_GLOBAL_NPCS: usize = 72;
        let mut total_npcs = self
            .world
            .companies
            .values()
            .filter(|c| !c.is_player)
            .count();
        if total_npcs >= MAX_GLOBAL_NPCS {
            return;
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
        for pid in ["P2", "P1", "P3"] {
            if total_npcs >= MAX_GLOBAL_NPCS {
                break;
            }
            let Some(p) = self.world.planets.get(pid) else {
                continue;
            };
            let cap_p = match pid {
                "P2" => (24 + (p.population / 350.0) as usize).min(42),
                _ => 18,
            };
            let min_p = match pid {
                "P2" => 20,
                _ => 10,
            };
            let mut cur_on_p = self
                .world
                .companies
                .values()
                .filter(|c| !c.is_player && c.home_planet_id == pid)
                .count();
            if cur_on_p >= cap_p {
                continue;
            }

            let sid = format!("ST:{pid}");
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
                    let hub_opt = self.world.stations.get("ST:HUB");
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
                            .filter(|c| !c.is_player && c.home_planet_id == pid && c.profession == pr_id)
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
                        // Encourage underrepresented professions on the planet so no monopoly forms
                        let crowding_pen = (have_pr as f64 / (cur_on_p.max(1) as f64 / 3.0)) * 0.25;
                        let score = top_m + shortage_bonus - crowding_pen;
                        if score > best_score {
                            best_score = score;
                            best_prof = pr_id;
                            best_margin = top_m;
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
                if self.spawn_evolved_company_on(best_prof, pid, seq, &ranked, seed_cash) {
                    cur_on_p += 1;
                    total_npcs += 1;
                } else {
                    break;
                }
            }
        }
    }

    pub fn reset_world(&mut self) -> Result<TickBroadcast, String> {
        let catalog = ProductionCatalog::load_from_file(&self.data_path)?;
        self.store.clear_world_and_history()?;
        self.runner.npc_genomes.clear();
        self.runner.extra_intents.clear();
        self.runner.last_player_outputs.clear();

        let mut new_world = World::new_standard(catalog);
        Self::seed_initial_actors(&mut new_world, &mut self.runner, &mut self.store)?;
        self.store.save_world(&new_world)?;
        self.world = new_world;
        self.next_npc_seq = 100;

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

    pub fn planet_summaries(&self) -> Vec<PlanetSummary> {
        let mut out: Vec<PlanetSummary> = self
            .world
            .planets
            .values()
            .map(|p| PlanetSummary {
                id: p.id.clone(),
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
                demands: p.last_demands.clone(),
            })
            .collect();
        out.sort_by(|a, b| a.id.cmp(&b.id));
        out
    }

    pub fn leaderboard(&self) -> Vec<LeaderboardRow> {
        let mut rows: Vec<LeaderboardRow> = self
            .world
            .companies
            .values()
            .map(|c| LeaderboardRow {
                id: c.id.clone(),
                name: c.name.clone(),
                is_player: c.is_player,
                profession: c.profession.clone(),
                home_planet_id: c.home_planet_id.clone(),
                cash: from_money(c.cash),
                savings: from_money(c.savings),
                debt: from_money(c.debt),
                net_liquid: from_money(c.cash + c.savings - c.debt),
                plots_count: c.plots.len(),
                ships_count: c.ships.len(),
            })
            .collect();
        rows.sort_by(|a, b| {
            b.net_liquid
                .partial_cmp(&a.net_liquid)
                .unwrap_or(std::cmp::Ordering::Equal)
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

    pub fn admin_overview(&self) -> serde_json::Value {
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
                    "name": p.name,
                    "archetype": p.archetype,
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
            planets: self.planet_summaries(),
            leaderboard: self.leaderboard(),
            player_outputs: self.runner.last_player_outputs.clone(),
        }
    }
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

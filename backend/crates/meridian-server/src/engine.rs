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

            let next_npc_seq = restored_world.companies.len() as u64 + 100;
            return Ok(Self {
                world: restored_world,
                runner,
                store,
                data_path,
                paused: false,
                tick_ms,
                next_npc_seq,
                events_tx,
            });
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

        // Balanced cohort of 12 0-hardcoded NPCs across P1/P2/P3
        let cohort = [
            ("env_recycle", "P2"),
            ("env_recycle", "P2"),
            ("env_recycle", "P2"),
            ("env_recycle", "P3"),
            ("agri_bio", "P2"),
            ("agri_bio", "P2"),
            ("agri_bio", "P2"),
            ("agri_bio", "P3"),
            ("mining_ind", "P1"),
            ("mining_ind", "P1"),
            ("mining_ind", "P3"),
            ("mining_ind", "P2"),
        ];

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

        // Evolutionary NPC replacement when an NPC goes bankrupt
        for dead_cid in &report.bankruptcies {
            let _ = self.store.delete_npc_genome(dead_cid);
            self.respawn_evolved_npc();
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

        let seq = self.next_npc_seq;
        self.next_npc_seq += 1;

        let profs = ["env_recycle", "agri_bio", "mining_ind"];
        let prof = ranked
            .get((seq as usize) % ranked.len().max(1))
            .map(|r| r.2.as_str())
            .unwrap_or(profs[(seq as usize) % profs.len()]);
        let planet = if prof == "agri_bio" || prof == "env_recycle" {
            "P2"
        } else if seq % 2 == 0 {
            "P1"
        } else {
            "P3"
        };

        let new_cid = format!("npc_evo_{seq}");
        if self
            .world
            .spawn_company(&new_cid, format!("Evo-{prof}-{seq}"), false, prof, planet, 8_000.0)
            .is_ok()
        {
            let genome = if ranked.len() >= 2 {
                let ga = self
                    .runner
                    .npc_genomes
                    .get(&ranked[0].1)
                    .cloned()
                    .unwrap_or_default();
                let gb = self
                    .runner
                    .npc_genomes
                    .get(&ranked[1].1)
                    .cloned()
                    .unwrap_or_default();
                NpcGenome::crossover_mutate(&ga, &gb, seq.wrapping_mul(1315423911), 0.15)
            } else {
                NpcGenome::from_seed(seq.wrapping_mul(2654435761))
            };
            let _ = self.store.save_npc_genome(&new_cid, &genome);
            self.runner.register_npc(new_cid, genome);
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

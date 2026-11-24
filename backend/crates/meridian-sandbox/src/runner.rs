//! Parallel `rayon` tick coordinator that snapshots each company, executes Player QuickJS VMs
//! and 0-hardcoded NPC policy brains concurrently, then applies deterministic `World::step_tick`.

use std::collections::HashMap;
use std::sync::Arc;
use std::time::Instant;

use meridian_core::{CompanyId, Intent, ProductionCatalog, TickReport, World};
use rayon::prelude::*;

use crate::js_runner::run_player_tick;
use crate::npc::{decide_npc_intents, NpcGenome};
use crate::types::{PlayerRunConfig, PlayerRunOutput, PlayerScriptBundle};

#[derive(Debug, Clone)]
pub struct PlayerVmState {
    pub bundle: PlayerScriptBundle,
    pub memory_json: String,
    pub enabled: bool,
}

impl Default for PlayerVmState {
    fn default() -> Self {
        Self {
            bundle: PlayerScriptBundle::single_main("module.exports.loop = function () {};"),
            memory_json: "{}".to_string(),
            enabled: true,
        }
    }
}

#[derive(Debug, Clone, Default)]
pub struct StepTiming {
    pub snapshot_ms: f64,
    pub actors_ms: f64,
    pub world_tick_ms: f64,
}

pub struct SimulationRunner {
    pub players: HashMap<CompanyId, PlayerVmState>,
    pub npc_genomes: HashMap<CompanyId, NpcGenome>,
    pub extra_intents: HashMap<CompanyId, Vec<Intent>>,
    pub config: PlayerRunConfig,
    pub last_player_outputs: HashMap<CompanyId, PlayerRunOutput>,
    pub last_timing: StepTiming,
}

impl Default for SimulationRunner {
    fn default() -> Self {
        Self {
            players: HashMap::new(),
            npc_genomes: HashMap::new(),
            extra_intents: HashMap::new(),
            config: PlayerRunConfig::default(),
            last_player_outputs: HashMap::new(),
            last_timing: StepTiming::default(),
        }
    }
}

impl SimulationRunner {
    pub fn new(config: PlayerRunConfig) -> Self {
        Self {
            config,
            ..Default::default()
        }
    }

    pub fn set_player_script(&mut self, company_id: impl Into<CompanyId>, bundle: PlayerScriptBundle) {
        let cid = company_id.into();
        let entry = self.players.entry(cid).or_default();
        entry.bundle = bundle;
    }

    pub fn set_player_memory(&mut self, company_id: impl Into<CompanyId>, memory_json: String) {
        let cid = company_id.into();
        let entry = self.players.entry(cid).or_default();
        entry.memory_json = memory_json;
    }

    pub fn register_npc(&mut self, company_id: impl Into<CompanyId>, genome: NpcGenome) {
        self.npc_genomes.insert(company_id.into(), genome);
    }

    /// Execute one complete tick:
    /// 1. Precompute immutable shared snapshot data once per tick.
    /// 2. Build per-company `WorldSnapshot`s (skipping full order books for NPCs) and run Player
    ///    QuickJS VMs + NPC Brains in parallel via `rayon`.
    /// 3. Update player Memory & console outputs, then step `World::step_tick`.
    pub fn step_world(&mut self, world: &mut World) -> TickReport {
        enum JobSpec<'a> {
            Player {
                cid: CompanyId,
                bundle: Arc<PlayerScriptBundle>,
                memory_json: String,
            },
            Npc {
                cid: CompanyId,
                genome: Option<&'a NpcGenome>,
            },
        }

        let mut cids: Vec<CompanyId> = world.companies.keys().cloned().collect();
        cids.sort();

        let mut has_active_player = false;
        let mut specs = Vec::with_capacity(cids.len());
        for cid in cids {
            let Some(comp) = world.companies.get(&cid) else {
                continue;
            };
            if comp.is_player {
                if let Some(pvm) = self.players.get(&cid) {
                    if pvm.enabled {
                        has_active_player = true;
                        specs.push(JobSpec::Player {
                            cid,
                            bundle: Arc::new(pvm.bundle.clone()),
                            memory_json: pvm.memory_json.clone(),
                        });
                    }
                }
            } else {
                let genome = self.npc_genomes.get(&cid);
                specs.push(JobSpec::Npc { cid, genome });
            }
        }

        let t0 = Instant::now();
        let shared = world.prepare_shared_snapshot();
        let snapshot_ms = t0.elapsed().as_secs_f64() * 1000.0;

        let player_catalog = if has_active_player {
            Some(Arc::new(world.catalog.clone()))
        } else {
            None
        };
        let default_genome = NpcGenome::default();
        let config = &self.config;
        let world_ref: &World = world;

        let t1 = Instant::now();
        let outcomes: Vec<(CompanyId, Vec<Intent>, Option<PlayerRunOutput>)> = specs
            .into_par_iter()
            .filter_map(|spec| match spec {
                JobSpec::Player {
                    cid,
                    bundle,
                    memory_json,
                } => {
                    let snap = Arc::new(world_ref.snapshot_for_with_shared(&cid, &shared, true)?);
                    let cat = Arc::clone(player_catalog.as_ref().unwrap());
                    let out = run_player_tick(snap, cat, bundle, &memory_json, config);
                    let intents = out.intents.clone();
                    Some((cid, intents, Some(out)))
                }
                JobSpec::Npc { cid, genome } => {
                    let snap = world_ref.snapshot_for_with_shared(&cid, &shared, false)?;
                    let g = genome.unwrap_or(&default_genome);
                    let intents = decide_npc_intents(&snap, &world_ref.catalog, g);
                    Some((cid, intents, None))
                }
            })
            .collect();
        let actors_ms = t1.elapsed().as_secs_f64() * 1000.0;

        let mut intents_by_company = Vec::with_capacity(outcomes.len() + self.extra_intents.len());
        let mut extra = std::mem::take(&mut self.extra_intents);
        for (cid, mut intents, maybe_player_out) in outcomes {
            if let Some(pout) = maybe_player_out {
                if let Some(pvm) = self.players.get_mut(&cid) {
                    pvm.memory_json = pout.memory_json.clone();
                }
                self.last_player_outputs.insert(cid.clone(), pout);
            }
            if let Some(mut manual) = extra.remove(&cid) {
                intents.append(&mut manual);
            }
            if !intents.is_empty() {
                intents_by_company.push((cid, intents));
            }
        }
        for (cid, intents) in extra {
            if !intents.is_empty() {
                intents_by_company.push((cid, intents));
            }
        }

        let t2 = Instant::now();
        let report = world.step_tick(intents_by_company);
        let world_tick_ms = t2.elapsed().as_secs_f64() * 1000.0;
        self.last_timing = StepTiming {
            snapshot_ms,
            actors_ms,
            world_tick_ms,
        };

        // Respawn bankrupt NPC slots cleanly or prune dead NPC genomes
        for dead_cid in &report.bankruptcies {
            self.npc_genomes.remove(dead_cid);
        }

        let _ = ProductionCatalog::from_json_str; // keeps catalog type cleanly referenced
        report
    }
}

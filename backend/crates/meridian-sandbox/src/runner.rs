//! Parallel `rayon` tick coordinator that snapshots each company, executes Player QuickJS VMs
//! and 0-hardcoded NPC policy brains concurrently, then applies deterministic `World::step_tick`.

use std::collections::HashMap;
use std::sync::Arc;

use meridian_core::{CompanyId, Intent, ProductionCatalog, TickReport, World, WorldSnapshot};
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

pub struct SimulationRunner {
    pub players: HashMap<CompanyId, PlayerVmState>,
    pub npc_genomes: HashMap<CompanyId, NpcGenome>,
    pub extra_intents: HashMap<CompanyId, Vec<Intent>>,
    pub config: PlayerRunConfig,
    pub last_player_outputs: HashMap<CompanyId, PlayerRunOutput>,
}

impl Default for SimulationRunner {
    fn default() -> Self {
        Self {
            players: HashMap::new(),
            npc_genomes: HashMap::new(),
            extra_intents: HashMap::new(),
            config: PlayerRunConfig::default(),
            last_player_outputs: HashMap::new(),
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
    /// 1. Export read-only `WorldSnapshot` per company (sorted by ID for deterministic order).
    /// 2. Run Player QuickJS VMs and NPC Brains in parallel via `rayon`.
    /// 3. Update player Memory & console outputs, then step `World::step_tick`.
    pub fn step_world(&mut self, world: &mut World) -> TickReport {
        enum JobKind {
            Player {
                cid: CompanyId,
                snap: Arc<WorldSnapshot>,
                bundle: Arc<PlayerScriptBundle>,
                memory_json: String,
            },
            Npc {
                cid: CompanyId,
                snap: Arc<WorldSnapshot>,
                genome: NpcGenome,
            },
        }

        let catalog = Arc::new(world.catalog.clone());
        let mut cids: Vec<CompanyId> = world.companies.keys().cloned().collect();
        cids.sort();

        let mut jobs = Vec::with_capacity(cids.len());
        for cid in cids {
            let Some(comp) = world.companies.get(&cid) else {
                continue;
            };
            let Some(snap) = world.snapshot_for(&cid) else {
                continue;
            };
            let snap = Arc::new(snap);
            if comp.is_player {
                if let Some(pvm) = self.players.get(&cid) {
                    if pvm.enabled {
                        jobs.push(JobKind::Player {
                            cid,
                            snap,
                            bundle: Arc::new(pvm.bundle.clone()),
                            memory_json: pvm.memory_json.clone(),
                        });
                    }
                }
            } else {
                let genome = self.npc_genomes.get(&cid).cloned().unwrap_or_default();
                jobs.push(JobKind::Npc { cid, snap, genome });
            }
        }

        let config = &self.config;
        let outcomes: Vec<(CompanyId, Vec<Intent>, Option<PlayerRunOutput>)> = jobs
            .into_par_iter()
            .map(|job| match job {
                JobKind::Player {
                    cid,
                    snap,
                    bundle,
                    memory_json,
                } => {
                    let out = run_player_tick(
                        snap,
                        Arc::clone(&catalog),
                        bundle,
                        &memory_json,
                        config,
                    );
                    let intents = out.intents.clone();
                    (cid, intents, Some(out))
                }
                JobKind::Npc { cid, snap, genome } => {
                    let intents = decide_npc_intents(&snap, &catalog, &genome);
                    (cid, intents, None)
                }
            })
            .collect();

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

        let report = world.step_tick(intents_by_company);

        // Respawn bankrupt NPC slots cleanly or prune dead NPC genomes
        for dead_cid in &report.bankruptcies {
            self.npc_genomes.remove(dead_cid);
        }

        let _ = ProductionCatalog::from_json_str; // keeps catalog type cleanly referenced
        report
    }
}

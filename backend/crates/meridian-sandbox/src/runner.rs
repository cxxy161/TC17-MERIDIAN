//! Separate `rayon` actor stages that snapshot each company, execute free-play NPC brains and
//! persistent Player QuickJS VMs independently (so NPCs and players are timed separately without
//! contending for CPU during the player budget window), then apply deterministic `World::step_tick`.

use std::collections::HashMap;
use std::fmt;
use std::sync::Arc;
use std::time::Instant;

use meridian_core::{CompanyId, Intent, ProductionCatalog, TickReport, World};
use rayon::prelude::*;

use crate::js_runner::PlayerVmHandle;
use crate::npc::{decide_npc_intents, NpcGenome};
use crate::types::{PlayerRunConfig, PlayerRunOutput, PlayerScriptBundle};

pub struct PlayerVmState {
    pub bundle: PlayerScriptBundle,
    pub memory_json: String,
    pub enabled: bool,
    pub vm: Option<PlayerVmHandle>,
}

impl fmt::Debug for PlayerVmState {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("PlayerVmState")
            .field("modules", &self.bundle.modules.keys().collect::<Vec<_>>())
            .field("memory_len", &self.memory_json.len())
            .field("enabled", &self.enabled)
            .field("has_vm", &self.vm.is_some())
            .finish()
    }
}

impl Default for PlayerVmState {
    fn default() -> Self {
        Self {
            bundle: PlayerScriptBundle::single_main("module.exports.loop = function () {};"),
            memory_json: "{}".to_string(),
            enabled: true,
            vm: None,
        }
    }
}

#[derive(Debug, Clone, Default)]
pub struct StepTiming {
    pub snapshot_ms: f64,
    pub npc_ms: f64,
    pub players_ms: f64,
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
        if entry.bundle.modules != bundle.modules {
            entry.bundle = bundle;
            // Invalidate warm VM so edited scripts recompile on next tick
            entry.vm = None;
        }
    }

    pub fn set_player_memory(&mut self, company_id: impl Into<CompanyId>, memory_json: String) {
        let cid = company_id.into();
        let entry = self.players.entry(cid).or_default();
        if entry.memory_json != memory_json {
            entry.memory_json = memory_json;
            entry.vm = None;
        }
    }

    pub fn set_player_enabled(&mut self, company_id: &str, enabled: bool) {
        if let Some(entry) = self.players.get_mut(company_id) {
            entry.enabled = enabled;
            if !enabled {
                entry.vm = None;
            }
        }
    }

    pub fn register_npc(&mut self, company_id: impl Into<CompanyId>, genome: NpcGenome) {
        self.npc_genomes.insert(company_id.into(), genome);
    }

    /// Execute one complete tick:
    /// 1. Precompute immutable shared snapshot data once per tick.
    /// 2. Run NPC policy brains in parallel (`npc_ms`), then run persistent Player QuickJS VMs
    ///    in a separate parallel pass (`players_ms`) so NPC work never contends with player budgets.
    /// 3. Update player VMs, Memory & console outputs, then step `World::step_tick`.
    pub fn step_world(&mut self, world: &mut World) -> TickReport {
        struct PlayerJob {
            cid: CompanyId,
            bundle: Arc<PlayerScriptBundle>,
            memory_json: String,
            vm: Option<PlayerVmHandle>,
        }
        struct NpcJob<'a> {
            cid: CompanyId,
            genome: Option<&'a NpcGenome>,
        }

        let mut cids: Vec<CompanyId> = world.companies.keys().cloned().collect();
        cids.sort();

        let mut player_jobs = Vec::new();
        let mut npc_jobs = Vec::with_capacity(cids.len());
        for cid in cids {
            let Some(comp) = world.companies.get(&cid) else {
                continue;
            };
            if comp.is_player {
                if let Some(pvm) = self.players.get_mut(&cid) {
                    if pvm.enabled {
                        player_jobs.push(PlayerJob {
                            cid,
                            bundle: Arc::new(pvm.bundle.clone()),
                            memory_json: pvm.memory_json.clone(),
                            vm: pvm.vm.take(),
                        });
                    } else {
                        pvm.vm = None;
                    }
                }
            } else {
                let genome = self.npc_genomes.get(&cid);
                npc_jobs.push(NpcJob { cid, genome });
            }
        }

        let t0 = Instant::now();
        let shared = world.prepare_shared_snapshot();
        let snapshot_ms = t0.elapsed().as_secs_f64() * 1000.0;

        let default_genome = NpcGenome::default();
        let config = &self.config;
        let world_ref: &World = world;

        let t_npc = Instant::now();
        let npc_outcomes: Vec<(CompanyId, Vec<Intent>)> = npc_jobs
            .into_par_iter()
            .filter_map(|job| {
                let snap = world_ref.snapshot_for_with_shared(&job.cid, &shared, false)?;
                let g = job.genome.unwrap_or(&default_genome);
                let intents = decide_npc_intents(&snap, &world_ref.catalog, g);
                Some((job.cid, intents))
            })
            .collect();
        let npc_ms = t_npc.elapsed().as_secs_f64() * 1000.0;

        let players_ms;
        let player_outcomes: Vec<(CompanyId, PlayerRunOutput, Option<PlayerVmHandle>)> =
            if player_jobs.is_empty() {
                players_ms = 0.0;
                Vec::new()
            } else {
                let player_catalog = Arc::new(world.catalog.clone());
                let t_players = Instant::now();
                let res = player_jobs
                    .into_par_iter()
                    .filter_map(|job| {
                        let snap = Arc::new(world_ref.snapshot_for_with_shared(
                            &job.cid,
                            &shared,
                            true,
                        )?);
                        let cat = Arc::clone(&player_catalog);
                        let mut vm_opt = job.vm;
                        let (out, next_vm) = match vm_opt.take() {
                            Some(mut vm) => {
                                let (out, keep) = vm.run_tick(
                                    snap,
                                    cat,
                                    job.bundle,
                                    &job.memory_json,
                                    config,
                                );
                                (out, if keep { Some(vm) } else { None })
                            }
                            None => {
                                match PlayerVmHandle::new(
                                    Arc::clone(&snap),
                                    Arc::clone(&cat),
                                    Arc::clone(&job.bundle),
                                    &job.memory_json,
                                    config,
                                ) {
                                    Ok(mut vm) => {
                                        let (out, keep) = vm.run_tick(
                                            snap,
                                            cat,
                                            job.bundle,
                                            &job.memory_json,
                                            config,
                                        );
                                        (out, if keep { Some(vm) } else { None })
                                    }
                                    Err(err) => {
                                        let oom = err.to_ascii_lowercase().contains("out of memory");
                                        (
                                            PlayerRunOutput {
                                                memory_json: job.memory_json,
                                                error: Some(err),
                                                oom,
                                                ..Default::default()
                                            },
                                            None,
                                        )
                                    }
                                }
                            }
                        };
                        Some((job.cid, out, next_vm))
                    })
                    .collect();
                players_ms = t_players.elapsed().as_secs_f64() * 1000.0;
                res
            };
        let actors_ms = npc_ms + players_ms;

        let mut intents_by_company =
            Vec::with_capacity(npc_outcomes.len() + player_outcomes.len() + self.extra_intents.len());
        let mut extra = std::mem::take(&mut self.extra_intents);

        for (cid, mut intents) in npc_outcomes {
            if let Some(mut manual) = extra.remove(&cid) {
                intents.append(&mut manual);
            }
            if !intents.is_empty() {
                intents_by_company.push((cid, intents));
            }
        }
        for (cid, pout, next_vm) in player_outcomes {
            let mut intents = pout.intents.clone();
            if let Some(pvm) = self.players.get_mut(&cid) {
                pvm.memory_json = pout.memory_json.clone();
                pvm.vm = if pvm.enabled { next_vm } else { None };
            }
            self.last_player_outputs.insert(cid.clone(), pout);
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
        intents_by_company.sort_by(|a, b| a.0.cmp(&b.0));

        let t2 = Instant::now();
        let report = world.step_tick(intents_by_company);
        let world_tick_ms = t2.elapsed().as_secs_f64() * 1000.0;
        self.last_timing = StepTiming {
            snapshot_ms,
            npc_ms,
            players_ms,
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

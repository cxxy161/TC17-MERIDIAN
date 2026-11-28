//! Separate `rayon` actor stages that snapshot each company, execute free-play NPC brains and
//! persistent Player QuickJS VMs independently (so NPCs and players are timed separately without
//! contending for CPU during the player budget window), then apply deterministic `World::step_tick`.

use std::collections::HashMap;
use std::fmt;
use std::sync::Arc;
use std::time::Instant;

use meridian_core::{from_money, CompanyId, Intent, ProductionCatalog, TickReport, World};
use rayon::prelude::*;

use crate::js_runner::PlayerVmHandle;
use crate::npc::{decide_npc_intents_with_memory, NpcGenome, NpcMemory};
use crate::types::{
    ConsoleEntry, ConsoleEvalOutput, ConsoleLevel, JsLastTickFill, LastTickFeedback,
    PlayerRunConfig, PlayerRunOutput, PlayerScriptBundle,
};

pub struct PlayerVmState {
    pub bundle: PlayerScriptBundle,
    pub memory_json: String,
    pub enabled: bool,
    pub vm: Option<PlayerVmHandle>,
    pub cpu_bucket_ms: Option<f64>,
}

impl PlayerVmState {
    pub fn effective_cpu_bucket_ms(&self, config: &PlayerRunConfig) -> f64 {
        let cap = config.cpu_bucket_limit_ms();
        self.cpu_bucket_ms.unwrap_or(cap).clamp(0.0, cap)
    }
}

impl fmt::Debug for PlayerVmState {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("PlayerVmState")
            .field("modules", &self.bundle.modules.keys().collect::<Vec<_>>())
            .field("memory_len", &self.memory_json.len())
            .field("enabled", &self.enabled)
            .field("has_vm", &self.vm.is_some())
            .field("cpu_bucket_ms", &self.cpu_bucket_ms)
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
            cpu_bucket_ms: None,
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
    pub npc_memories: HashMap<CompanyId, NpcMemory>,
    pub extra_intents: HashMap<CompanyId, Vec<Intent>>,
    pub config: PlayerRunConfig,
    pub last_player_outputs: HashMap<CompanyId, PlayerRunOutput>,
    pub last_tick_feedback: HashMap<CompanyId, LastTickFeedback>,
    pub last_timing: StepTiming,
}

impl Default for SimulationRunner {
    fn default() -> Self {
        Self {
            players: HashMap::new(),
            npc_genomes: HashMap::new(),
            npc_memories: HashMap::new(),
            extra_intents: HashMap::new(),
            config: PlayerRunConfig::default(),
            last_player_outputs: HashMap::new(),
            last_tick_feedback: HashMap::new(),
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
        let cid = company_id.into();
        self.npc_genomes.insert(cid.clone(), genome);
        self.npc_memories.entry(cid).or_default();
    }

    pub fn register_npc_with_memory(
        &mut self,
        company_id: impl Into<CompanyId>,
        genome: NpcGenome,
        memory: NpcMemory,
    ) {
        let cid = company_id.into();
        self.npc_genomes.insert(cid.clone(), genome);
        self.npc_memories.insert(cid, memory);
    }

    pub fn eval_console(
        &mut self,
        world: &World,
        company_id: &str,
        code: &str,
    ) -> Result<ConsoleEvalOutput, String> {
        let Some(snap) = world.snapshot_for(company_id) else {
            return Err(format!("company '{company_id}' not found"));
        };
        let snap = Arc::new(snap);
        let cat = Arc::new(world.catalog.clone());
        let feedback = self.last_tick_feedback.get(company_id).cloned();
        let entry = self
            .players
            .entry(company_id.to_string())
            .or_default();
        let cpu_bucket_ms = entry.effective_cpu_bucket_ms(&self.config);
        let bundle = Arc::new(entry.bundle.clone());
        let prev_mem = entry.memory_json.clone();
        let mut vm_opt = entry.vm.take();
        let mut vm = match vm_opt.take() {
            Some(v) => v,
            None => PlayerVmHandle::new(
                Arc::clone(&snap),
                Arc::clone(&cat),
                Arc::clone(&bundle),
                &prev_mem,
                &self.config,
            )?,
        };
        let (out, keep) = vm.eval_console(
            snap,
            cat,
            bundle,
            &prev_mem,
            &self.config,
            cpu_bucket_ms,
            feedback.as_ref(),
            code,
        );
        if keep {
            if out.memory_changed {
                entry.memory_json = out.memory_json.clone();
            }
            if entry.enabled {
                entry.vm = Some(vm);
            }
        }
        Ok(out)
    }

    /// Execute one complete tick:
    /// 1. Precompute immutable shared snapshot data once per tick.
    /// 2. Run NPC policy brains in parallel (`npc_ms`), then run persistent Player QuickJS VMs
    ///    in a separate parallel pass (`players_ms`) so NPC work never contends with player budgets.
    /// 3. Update player VMs, Memory & console outputs, then step `World::step_tick_with_manual`.
    pub fn step_world(&mut self, world: &mut World) -> TickReport {
        struct PlayerJob {
            cid: CompanyId,
            bundle: Arc<PlayerScriptBundle>,
            memory_json: String,
            vm: Option<PlayerVmHandle>,
            cpu_bucket_ms: f64,
            last_tick: Option<LastTickFeedback>,
        }
        struct NpcJob<'a> {
            cid: CompanyId,
            genome: Option<&'a NpcGenome>,
            memory: NpcMemory,
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
                let last_tick = self.last_tick_feedback.get(&cid).cloned();
                let cfg = &self.config;
                if let Some(pvm) = self.players.get_mut(&cid) {
                    if pvm.enabled {
                        let cpu_bucket_ms = pvm.effective_cpu_bucket_ms(cfg);
                        player_jobs.push(PlayerJob {
                            cid,
                            bundle: Arc::new(pvm.bundle.clone()),
                            memory_json: pvm.memory_json.clone(),
                            vm: pvm.vm.take(),
                            cpu_bucket_ms,
                            last_tick,
                        });
                    } else {
                        pvm.vm = None;
                    }
                }
            } else {
                let genome = self.npc_genomes.get(&cid);
                let memory = self.npc_memories.remove(&cid).unwrap_or_default();
                npc_jobs.push(NpcJob { cid, genome, memory });
            }
        }

        let t0 = Instant::now();
        let shared = world.prepare_shared_snapshot();
        let snapshot_ms = t0.elapsed().as_secs_f64() * 1000.0;

        let default_genome = NpcGenome::default();
        let config = &self.config;
        let world_ref: &World = world;

        let t_npc = Instant::now();
        let npc_outcomes: Vec<(CompanyId, Vec<Intent>, NpcMemory)> = npc_jobs
            .into_par_iter()
            .filter_map(|mut job| {
                let snap = world_ref.snapshot_for_with_shared(&job.cid, &shared, false)?;
                let g = job.genome.unwrap_or(&default_genome);
                let intents =
                    decide_npc_intents_with_memory(&snap, &world_ref.catalog, g, &mut job.memory);
                Some((job.cid, intents, job.memory))
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
                                let (out, keep) = vm.run_tick_with_feedback(
                                    snap,
                                    cat,
                                    job.bundle,
                                    &job.memory_json,
                                    config,
                                    job.cpu_bucket_ms,
                                    job.last_tick.as_ref(),
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
                                        let (out, keep) = vm.run_tick_with_feedback(
                                            snap,
                                            cat,
                                            job.bundle,
                                            &job.memory_json,
                                            config,
                                            job.cpu_bucket_ms,
                                            job.last_tick.as_ref(),
                                        );
                                        (out, if keep { Some(vm) } else { None })
                                    }
                                    Err(err) => {
                                        let oom = err.to_ascii_lowercase().contains("out of memory");
                                        (
                                            PlayerRunOutput {
                                                memory_json: job.memory_json,
                                                cpu_bucket_ms: job.cpu_bucket_ms,
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
            Vec::with_capacity(npc_outcomes.len() + player_outcomes.len());
        let extra = std::mem::take(&mut self.extra_intents);
        let mut manual_intents_by_company: Vec<(CompanyId, Vec<Intent>)> = extra
            .into_iter()
            .filter(|(_, v)| !v.is_empty())
            .collect();
        manual_intents_by_company.sort_by(|a, b| a.0.cmp(&b.0));

        for (cid, intents, mem) in npc_outcomes {
            self.npc_memories.insert(cid.clone(), mem);
            if !intents.is_empty() {
                intents_by_company.push((cid, intents));
            }
        }
        for (cid, pout, next_vm) in player_outcomes {
            let intents = pout.intents.clone();
            let cap = self.config.cpu_bucket_limit_ms();
            if let Some(pvm) = self.players.get_mut(&cid) {
                pvm.memory_json = pout.memory_json.clone();
                pvm.vm = if pvm.enabled { next_vm } else { None };
                pvm.cpu_bucket_ms = Some(pout.cpu_bucket_ms.clamp(0.0, cap));
            }
            self.last_player_outputs.insert(cid.clone(), pout);
            if !intents.is_empty() {
                intents_by_company.push((cid, intents));
            }
        }
        intents_by_company.sort_by(|a, b| a.0.cmp(&b.0));

        let t2 = Instant::now();
        let report = world.step_tick_with_manual(intents_by_company, manual_intents_by_company);
        let world_tick_ms = t2.elapsed().as_secs_f64() * 1000.0;
        self.last_timing = StepTiming {
            snapshot_ms,
            npc_ms,
            players_ms,
            actors_ms,
            world_tick_ms,
        };

        // Record per-company last-tick fills and rejected intents for next tick's `Game.lastTick`
        self.last_tick_feedback.clear();
        for fill in &report.fills {
            let price = from_money(fill.price);
            let notional = from_money(fill.notional);
            let fee = from_money(fill.fee);
            let refund = from_money(fill.buyer_refund);
            if let Some(bmem) = self.npc_memories.get_mut(&fill.buyer_id) {
                let inv_before = world
                    .companies
                    .get(&fill.buyer_id)
                    .map(|c| {
                        c.station_qty(&fill.station_id, &fill.item_id)
                            .saturating_sub(fill.qty)
                    })
                    .unwrap_or(0);
                bmem.record_fill(
                    fill.tick,
                    &fill.station_id,
                    &fill.item_id,
                    true,
                    fill.qty,
                    price,
                    inv_before,
                );
            }
            if let Some(smem) = self.npc_memories.get_mut(&fill.seller_id) {
                smem.record_fill(
                    fill.tick,
                    &fill.station_id,
                    &fill.item_id,
                    false,
                    fill.qty,
                    price,
                    0,
                );
            }
            self.last_tick_feedback
                .entry(fill.buyer_id.clone())
                .or_default()
                .fills
                .push(JsLastTickFill {
                    tick: fill.tick,
                    station_id: fill.station_id.clone(),
                    item_id: fill.item_id.clone(),
                    side: "buy".to_string(),
                    qty: fill.qty,
                    price,
                    notional,
                    fee,
                    buyer_refund: refund,
                    counterparty_id: fill.seller_id.clone(),
                });
            self.last_tick_feedback
                .entry(fill.seller_id.clone())
                .or_default()
                .fills
                .push(JsLastTickFill {
                    tick: fill.tick,
                    station_id: fill.station_id.clone(),
                    item_id: fill.item_id.clone(),
                    side: "sell".to_string(),
                    qty: fill.qty,
                    price,
                    notional,
                    fee,
                    buyer_refund: 0.0,
                    counterparty_id: fill.buyer_id.clone(),
                });
        }
        for (cid, rejs) in &report.rejected_by_company {
            let entry = self.last_tick_feedback.entry(cid.clone()).or_default();
            entry.rejected = rejs.clone();
            if let Some(pout) = self.last_player_outputs.get_mut(cid) {
                for r in rejs {
                    pout.logs.push(ConsoleEntry {
                        level: ConsoleLevel::Warn,
                        message: format!(
                            "[engine] tick {} 动作 {}({}) 结算失败 [{}]: {}",
                            report.tick, r.action, r.target, r.code, r.reason
                        ),
                    });
                }
            }
        }

        // Respawn bankrupt NPC slots cleanly or prune dead NPC genomes & memories
        for dead_cid in &report.bankruptcies {
            self.npc_genomes.remove(dead_cid);
            self.npc_memories.remove(dead_cid);
        }

        let _ = ProductionCatalog::from_json_str; // keeps catalog type cleanly referenced
        report
    }
}

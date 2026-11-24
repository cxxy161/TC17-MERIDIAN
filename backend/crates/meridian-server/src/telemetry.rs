//! Server runtime telemetry (CPU, memory, TPS, tick phase latency, SQLite WAL sizes,
//! active WebSocket connections) and macro economy history sampling for `/admin`.

use std::collections::{HashMap, VecDeque};
use std::path::Path;
use std::sync::{Arc, Mutex};
use std::time::Instant;

use serde::Serialize;

#[derive(Debug, Clone, Default, Serialize)]
pub struct TickPhases {
    pub snapshot_ms: f64,
    pub actors_ms: f64,
    pub world_tick_ms: f64,
    pub npc_spawn_ms: f64,
    pub persist_ms: f64,
    pub broadcast_ms: f64,
    pub total_ms: f64,
}

#[derive(Debug, Clone, Serialize)]
pub struct EconomySample {
    pub tick: u64,
    pub cpi: f64,
    pub total_minted: f64,
    pub player_net_liquid: f64,
    pub npc_net_liquid: f64,
    pub fills_count: usize,
    pub fills_qty: u32,
    pub open_orders_count: usize,
    pub idle_buildings: usize,
    pub step_total_ms: f64,
}

#[derive(Debug, Clone, Default, Serialize)]
pub struct ProcCpuSnapshot {
    pub proc_pct_one_core: f64,
    pub proc_pct_all_cores: f64,
    pub host_pct: f64,
    pub cores: usize,
    pub load_1m: f64,
    pub load_5m: f64,
    pub load_15m: f64,
}

#[derive(Debug, Clone, Default, Serialize)]
pub struct MemorySnapshot {
    pub rss_bytes: u64,
    pub hwm_bytes: u64,
    pub vsz_bytes: u64,
    pub host_total_bytes: u64,
    pub host_avail_bytes: u64,
    pub cgroup_current_bytes: Option<u64>,
    pub cgroup_limit_bytes: Option<u64>,
}

#[derive(Debug, Clone, Default, Serialize)]
pub struct StorageSizesSnapshot {
    pub db_bytes: u64,
    pub wal_bytes: u64,
    pub shm_bytes: u64,
}

struct CpuPrev {
    proc_ticks: u64,
    sys_total: u64,
    sys_idle: u64,
    at: Instant,
}

pub struct WsConnGuard {
    map: Arc<Mutex<HashMap<String, usize>>>,
    company_id: String,
}

impl Drop for WsConnGuard {
    fn drop(&mut self) {
        if let Ok(mut guard) = self.map.lock() {
            if let Some(cnt) = guard.get_mut(&self.company_id) {
                if *cnt <= 1 {
                    guard.remove(&self.company_id);
                } else {
                    *cnt -= 1;
                }
            }
        }
    }
}

pub struct TelemetryTracker {
    pub started_at: Instant,
    pub active_ws: Arc<Mutex<HashMap<String, usize>>>,
    recent_tick_times: VecDeque<Instant>,
    recent_tick_durations_ms: VecDeque<f64>,
    pub last_phases: TickPhases,
    pub last_persisted_tick: u64,
    pub last_persisted_at: Instant,
    pub total_js_timeouts: u64,
    pub total_js_ooms: u64,
    pub total_rejected_intents: u64,
    pub economy_history: VecDeque<EconomySample>,
    cpu_prev: Option<CpuPrev>,
}

impl Default for TelemetryTracker {
    fn default() -> Self {
        let now = Instant::now();
        Self {
            started_at: now,
            active_ws: Arc::new(Mutex::new(HashMap::new())),
            recent_tick_times: VecDeque::with_capacity(64),
            recent_tick_durations_ms: VecDeque::with_capacity(128),
            last_phases: TickPhases::default(),
            last_persisted_tick: 0,
            last_persisted_at: now,
            total_js_timeouts: 0,
            total_js_ooms: 0,
            total_rejected_intents: 0,
            economy_history: VecDeque::with_capacity(300),
            cpu_prev: None,
        }
    }
}

impl TelemetryTracker {
    pub fn track_ws(&self, company_id: &str) -> WsConnGuard {
        if let Ok(mut guard) = self.active_ws.lock() {
            *guard.entry(company_id.to_string()).or_insert(0) += 1;
        }
        WsConnGuard {
            map: Arc::clone(&self.active_ws),
            company_id: company_id.to_string(),
        }
    }

    pub fn ws_counts(&self) -> (usize, HashMap<String, usize>) {
        match self.active_ws.lock() {
            Ok(g) => {
                let total = g.values().sum();
                (total, g.clone())
            }
            Err(_) => (0, HashMap::new()),
        }
    }

    pub fn record_tick(
        &mut self,
        phases: TickPhases,
        persisted_world: bool,
        tick: u64,
        timeouts: u64,
        ooms: u64,
        rejected_intents: usize,
        econ: EconomySample,
    ) {
        let now = Instant::now();
        self.recent_tick_times.push_back(now);
        while self.recent_tick_times.len() > 64 {
            self.recent_tick_times.pop_front();
        }
        while self.recent_tick_times.len() > 2 {
            if let Some(front) = self.recent_tick_times.front() {
                if now.duration_since(*front).as_secs_f64() > 15.0 {
                    self.recent_tick_times.pop_front();
                    continue;
                }
            }
            break;
        }

        self.recent_tick_durations_ms.push_back(phases.total_ms);
        while self.recent_tick_durations_ms.len() > 120 {
            self.recent_tick_durations_ms.pop_front();
        }
        self.last_phases = phases;
        if persisted_world {
            self.last_persisted_tick = tick;
            self.last_persisted_at = now;
        }
        self.total_js_timeouts += timeouts;
        self.total_js_ooms += ooms;
        self.total_rejected_intents += rejected_intents as u64;

        self.economy_history.push_back(econ);
        while self.economy_history.len() > 300 {
            self.economy_history.pop_front();
        }
    }

    pub fn reset_history(&mut self) {
        self.economy_history.clear();
        self.recent_tick_times.clear();
        self.recent_tick_durations_ms.clear();
        self.last_phases = TickPhases::default();
        self.last_persisted_tick = 0;
        self.last_persisted_at = Instant::now();
    }

    pub fn tps(&self) -> f64 {
        let len = self.recent_tick_times.len();
        if len < 2 {
            return 0.0;
        }
        let first = *self.recent_tick_times.front().unwrap();
        let last = *self.recent_tick_times.back().unwrap();
        let span_secs = last.duration_since(first).as_secs_f64();
        let since_last_secs = Instant::now().duration_since(last).as_secs_f64();
        // If simulation has been paused/idle longer than the window, report 0
        if since_last_secs > 10.0 && span_secs < since_last_secs {
            return 0.0;
        }
        if span_secs <= 1e-4 {
            return 0.0;
        }
        ((len - 1) as f64) / span_secs
    }

    pub fn duration_stats_ms(&self) -> (f64, f64, f64, f64) {
        if self.recent_tick_durations_ms.is_empty() {
            return (0.0, 0.0, 0.0, 0.0);
        }
        let last = *self.recent_tick_durations_ms.back().unwrap();
        let mut sorted: Vec<f64> = self.recent_tick_durations_ms.iter().copied().collect();
        sorted.sort_by(|a, b| a.partial_cmp(b).unwrap_or(std::cmp::Ordering::Equal));
        let sum: f64 = sorted.iter().sum();
        let avg = sum / sorted.len() as f64;
        let p95_idx = ((sorted.len() as f64 * 0.95).ceil() as usize)
            .saturating_sub(1)
            .min(sorted.len() - 1);
        let p95 = sorted[p95_idx];
        let max = *sorted.last().unwrap();
        (last, avg, p95, max)
    }

    pub fn sample_cpu(&mut self) -> ProcCpuSnapshot {
        let cores = std::thread::available_parallelism()
            .map(|n| n.get())
            .unwrap_or(1)
            .max(1);
        let (load_1m, load_5m, load_15m) = read_loadavg();
        let proc_ticks = read_proc_cpu_ticks().unwrap_or(0);
        let (sys_total, sys_idle) = read_sys_cpu_ticks().unwrap_or((0, 0));
        let now = Instant::now();

        let (mut proc_one, mut proc_all, mut host_pct) = (0.0, 0.0, 0.0);
        if let Some(prev) = &self.cpu_prev {
            let wall_secs = now.duration_since(prev.at).as_secs_f64();
            if wall_secs > 0.05 {
                let d_proc = proc_ticks.saturating_sub(prev.proc_ticks) as f64;
                // Standard Linux USER_HZ is 100 ticks/sec
                let proc_cpu_secs = d_proc / 100.0;
                proc_one = (proc_cpu_secs / wall_secs) * 100.0;
                proc_all = (proc_one / cores as f64).min(100.0);

                let d_total = sys_total.saturating_sub(prev.sys_total);
                let d_idle = sys_idle.saturating_sub(prev.sys_idle);
                if d_total > 0 {
                    host_pct = ((d_total.saturating_sub(d_idle)) as f64 / d_total as f64) * 100.0;
                }
            }
        }
        if self
            .cpu_prev
            .as_ref()
            .map(|p| now.duration_since(p.at).as_secs_f64() >= 0.4)
            .unwrap_or(true)
        {
            self.cpu_prev = Some(CpuPrev {
                proc_ticks,
                sys_total,
                sys_idle,
                at: now,
            });
        }

        ProcCpuSnapshot {
            proc_pct_one_core: proc_one,
            proc_pct_all_cores: proc_all,
            host_pct,
            cores,
            load_1m,
            load_5m,
            load_15m,
        }
    }

    pub fn sample_memory(&self) -> MemorySnapshot {
        let (rss_bytes, hwm_bytes, vsz_bytes) = read_proc_memory();
        let (host_total_bytes, host_avail_bytes) = read_meminfo();
        let (cgroup_current_bytes, cgroup_limit_bytes) = read_cgroup_memory();
        MemorySnapshot {
            rss_bytes,
            hwm_bytes,
            vsz_bytes,
            host_total_bytes,
            host_avail_bytes,
            cgroup_current_bytes,
            cgroup_limit_bytes,
        }
    }

    pub fn storage_sizes(&self, db_path: Option<&Path>) -> StorageSizesSnapshot {
        let Some(p) = db_path else {
            return StorageSizesSnapshot::default();
        };
        let s = p.to_string_lossy();
        StorageSizesSnapshot {
            db_bytes: std::fs::metadata(p).map(|m| m.len()).unwrap_or(0),
            wal_bytes: std::fs::metadata(format!("{s}-wal"))
                .map(|m| m.len())
                .unwrap_or(0),
            shm_bytes: std::fs::metadata(format!("{s}-shm"))
                .map(|m| m.len())
                .unwrap_or(0),
        }
    }
}

fn read_proc_cpu_ticks() -> Option<u64> {
    let text = std::fs::read_to_string("/proc/self/stat").ok()?;
    let rparen = text.rfind(')')?;
    let after = text.get(rparen + 2..)?;
    let fields: Vec<&str> = after.split_whitespace().collect();
    // After `(comm)` and space, field[0] is state (index 2 in full stat), so:
    // utime = full[13] => after[11], stime = full[14] => after[12]
    let utime: u64 = fields.get(11)?.parse().ok()?;
    let stime: u64 = fields.get(12)?.parse().ok()?;
    Some(utime + stime)
}

fn read_sys_cpu_ticks() -> Option<(u64, u64)> {
    let text = std::fs::read_to_string("/proc/stat").ok()?;
    let first = text.lines().next()?;
    let nums: Vec<u64> = first
        .split_whitespace()
        .skip(1)
        .filter_map(|s| s.parse::<u64>().ok())
        .collect();
    if nums.len() < 4 {
        return None;
    }
    let total: u64 = nums.iter().sum();
    let idle = nums[3] + nums.get(4).copied().unwrap_or(0);
    Some((total, idle))
}

fn read_loadavg() -> (f64, f64, f64) {
    let Ok(text) = std::fs::read_to_string("/proc/loadavg") else {
        return (0.0, 0.0, 0.0);
    };
    let mut it = text.split_whitespace();
    let l1 = it.next().and_then(|s| s.parse().ok()).unwrap_or(0.0);
    let l5 = it.next().and_then(|s| s.parse().ok()).unwrap_or(0.0);
    let l15 = it.next().and_then(|s| s.parse().ok()).unwrap_or(0.0);
    (l1, l5, l15)
}

fn read_proc_memory() -> (u64, u64, u64) {
    let Ok(text) = std::fs::read_to_string("/proc/self/status") else {
        return (0, 0, 0);
    };
    let mut rss = 0u64;
    let mut hwm = 0u64;
    let mut vsz = 0u64;
    for line in text.lines() {
        if let Some(rest) = line.strip_prefix("VmRSS:") {
            rss = parse_kb(rest);
        } else if let Some(rest) = line.strip_prefix("VmHWM:") {
            hwm = parse_kb(rest);
        } else if let Some(rest) = line.strip_prefix("VmSize:") {
            vsz = parse_kb(rest);
        }
    }
    (rss, hwm, vsz)
}

fn read_meminfo() -> (u64, u64) {
    let Ok(text) = std::fs::read_to_string("/proc/meminfo") else {
        return (0, 0);
    };
    let mut total = 0u64;
    let mut avail = 0u64;
    for line in text.lines() {
        if let Some(rest) = line.strip_prefix("MemTotal:") {
            total = parse_kb(rest);
        } else if let Some(rest) = line.strip_prefix("MemAvailable:") {
            avail = parse_kb(rest);
        }
    }
    (total, avail)
}

fn read_cgroup_memory() -> (Option<u64>, Option<u64>) {
    // cgroup v2 (Debian 12 / Docker 29+)
    if let Ok(cur_s) = std::fs::read_to_string("/sys/fs/cgroup/memory.current") {
        let cur = cur_s.trim().parse::<u64>().ok();
        let max = std::fs::read_to_string("/sys/fs/cgroup/memory.max")
            .ok()
            .and_then(|s| {
                let t = s.trim();
                if t == "max" {
                    None
                } else {
                    t.parse::<u64>().ok()
                }
            });
        return (cur, max);
    }
    (None, None)
}

fn parse_kb(s: &str) -> u64 {
    s.split_whitespace()
        .next()
        .and_then(|n| n.parse::<u64>().ok())
        .unwrap_or(0)
        .saturating_mul(1024)
}

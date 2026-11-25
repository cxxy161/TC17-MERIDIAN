//! QuickJS (`rquickjs`) sandbox runner exposing the player-script API: `Game`, `Memory`, `Store`,
//! `console`, `require()`, and `OK/ERR_*` constants with strict CPU & heap isolation.

use std::collections::{BTreeMap, HashMap};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::Instant;

use meridian_core::{
    from_money, to_money, BankOpKind, BuildingId, Intent, ListingId, Order, OrderId, OrderSide,
    PlotId, ProductionCatalog, PublicCompanySummary, ShipCountsView, ShipId, WorldSnapshot,
    ERR_BUSY, ERR_FULL, ERR_INVALID_ARGS, ERR_INVALID_TARGET, ERR_NOT_ENOUGH_CREDITS,
    ERR_NOT_ENOUGH_RESOURCES, ERR_NOT_FOUND, ERR_NOT_IN_RANGE, ERR_NOT_OWNER, ERR_NO_PATH,
    MAX_ACTIVE_ORDERS_PER_COMPANY, MAX_INTENTS_PER_TICK, OK,
};
use rquickjs::{CatchResultExt, CaughtError, Context, Function, Runtime};
use serde::Serialize;

use crate::types::{
    ConsoleEntry, ConsoleLevel, PlayerRunConfig, PlayerRunOutput, PlayerScriptBundle,
};

const PRELUDE_JS: &str = include_str!("prelude.js");
const INIT_SAFETY_US: u64 = 50_000;
const REFRESH_SAFETY_US: u64 = 25_000;

fn now_us() -> u64 {
    static EPOCH: OnceLock<Instant> = OnceLock::new();
    let epoch = EPOCH.get_or_init(Instant::now);
    epoch.elapsed().as_micros() as u64
}

struct HostMutable {
    intents: Vec<Intent>,
    logs: Vec<ConsoleEntry>,
    truncated_logs: bool,
    max_console_lines: usize,
    max_console_line_bytes: usize,
}

struct HostTickState {
    snapshot: Arc<WorldSnapshot>,
    catalog: Arc<ProductionCatalog>,
    bundle: Arc<PlayerScriptBundle>,
    user_started_at: Instant,
}

struct HostState {
    tick: Mutex<HostTickState>,
    mutable: Mutex<HostMutable>,
}

impl HostState {
    fn push_intent(&self, intent: Intent) -> i32 {
        let mut guard = self.mutable.lock().unwrap();
        if guard.intents.len() >= MAX_INTENTS_PER_TICK {
            return ERR_FULL;
        }
        guard.intents.push(intent);
        OK
    }

    fn push_log(&self, level: ConsoleLevel, msg: String) {
        let mut guard = self.mutable.lock().unwrap();
        if guard.logs.len() >= guard.max_console_lines {
            if !guard.truncated_logs {
                guard.truncated_logs = true;
                let max_lines = guard.max_console_lines;
                guard.logs.push(ConsoleEntry {
                    level: ConsoleLevel::Warn,
                    message: format!("[sandbox] console output truncated at {max_lines} lines"),
                });
            }
            return;
        }
        let clipped = truncate_utf8(&msg, guard.max_console_line_bytes);
        guard.logs.push(ConsoleEntry {
            level,
            message: clipped,
        });
    }
}

fn truncate_utf8(s: &str, max_bytes: usize) -> String {
    if s.len() <= max_bytes {
        return s.to_string();
    }
    let mut idx = max_bytes;
    while idx > 0 && !s.is_char_boundary(idx) {
        idx -= 1;
    }
    let mut out = s[..idx].to_string();
    out.push_str("...");
    out
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct BootPayload<'a> {
    tick: u64,
    cpi: f64,
    cpu_limit_ms: u64,
    resources: Vec<&'a str>,
    company: BootCompany<'a>,
    planets: Vec<BootPlanet<'a>>,
    stations: HashMap<&'a str, &'a HashMap<String, u32>>,
    plots: Vec<BootPlot<'a>>,
    buildings: Vec<BootBuilding<'a>>,
    ships: Vec<BootShip<'a>>,
    own_orders: Vec<JsOrder<'a>>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct BootCompany<'a> {
    id: &'a str,
    name: &'a str,
    profession: &'a str,
    home_planet_id: &'a str,
    cash: f64,
    savings: f64,
    debt: f64,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct BootLandListing<'a> {
    listing_id: String,
    plot_id: String,
    slot_id: u32,
    seller_id: &'a str,
    ask_price: f64,
    terrain_name: &'a str,
    lat: f64,
    lon: f64,
    capacity: u32,
    used_slots: u32,
    building_mods: &'a HashMap<String, f64>,
    buildings: &'a [String],
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct JsLandPlot<'a> {
    slot_id: u32,
    planet_id: &'a str,
    lat: f64,
    lon: f64,
    terrain_name: &'a str,
    capacity: u32,
    used_slots: u32,
    building_mods: &'a HashMap<String, f64>,
    status: &'a str,
    is_city: bool,
    city_name: Option<&'a str>,
    owner_id: Option<&'a str>,
    owner_name: Option<&'a str>,
    is_player_owner: bool,
    plot_id: Option<String>,
    listing_id: Option<String>,
    price: Option<f64>,
    buildings: &'a [String],
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct JsPublicCompanySummary<'a> {
    id: &'a str,
    name: &'a str,
    is_player: bool,
    home_planet_id: &'a str,
    net_liquid: f64,
    plots_count: usize,
    buildings_count: usize,
    ships_count: usize,
    ships_by_size: &'a ShipCountsView,
    open_orders_count: usize,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct JsPublicCompanyPlot {
    planet_id: String,
    slot_id: u32,
    plot_id: Option<String>,
    lat: f64,
    lon: f64,
    terrain_name: String,
    capacity: u32,
    used_slots: u32,
    status: String,
    listing_id: Option<String>,
    price: Option<f64>,
    buildings: Vec<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct JsPublicCompanyDetail<'a> {
    id: String,
    name: String,
    is_player: bool,
    home_planet_id: String,
    net_liquid: f64,
    plots_count: usize,
    buildings_count: usize,
    ships_count: usize,
    ships_by_size: ShipCountsView,
    building_counts: BTreeMap<String, u32>,
    plots: Vec<JsPublicCompanyPlot>,
    open_orders_count: usize,
    open_orders: Vec<JsOrder<'a>>,
}

fn to_js_order(o: &Order) -> JsOrder<'_> {
    JsOrder {
        id: o.order_id.to_string(),
        created: o.created_tick,
        side: match o.side {
            OrderSide::Buy => "buy",
            OrderSide::Sell => "sell",
        },
        resource_type: &o.item_id,
        station_id: &o.station_id,
        price: from_money(o.price),
        amount: o.qty,
        total_amount: o.total_qty,
        owner_id: &o.owner_id,
    }
}

fn to_js_company_summary(c: &PublicCompanySummary) -> JsPublicCompanySummary<'_> {
    JsPublicCompanySummary {
        id: &c.id,
        name: &c.name,
        is_player: c.is_player,
        home_planet_id: &c.home_planet_id,
        net_liquid: from_money(c.net_liquid),
        plots_count: c.plots_count,
        buildings_count: c.buildings_count,
        ships_count: c.ships_count,
        ships_by_size: &c.ships_by_size,
        open_orders_count: c.open_orders_count,
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct BootPlanet<'a> {
    id: &'a str,
    name: &'a str,
    wealth_tier: u8,
    prosperity: f64,
    population: f64,
    gravity: f64,
    waste_backlog: u32,
    primary_land_price: Option<f64>,
    bank_rate_pct: f64,
    ground_store: &'a HashMap<String, u32>,
    station_store: &'a HashMap<String, u32>,
    demands: &'a HashMap<String, u32>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct BootPlot<'a> {
    id: String,
    slot_id: u32,
    planet_id: &'a str,
    lat: f64,
    lon: f64,
    terrain_name: &'a str,
    capacity: u32,
    used_slots: u32,
    building_mods: &'a HashMap<String, f64>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct BootBuilding<'a> {
    id: String,
    #[serde(rename = "type")]
    building_type: &'a str,
    plot_id: String,
    planet_id: &'a str,
    efficiency: f64,
    recipe_id: &'a str,
    active: bool,
    progress: u32,
    cycle_ticks: u32,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct BootShip<'a> {
    id: String,
    size: &'static str,
    capacity: u32,
    durability: f64,
    location: &'a str,
    busy_until: u64,
    is_busy: bool,
    cargo: &'a HashMap<String, u32>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct JsOrder<'a> {
    id: String,
    created: u64,
    #[serde(rename = "type")]
    side: &'static str,
    resource_type: &'a str,
    station_id: &'a str,
    price: f64,
    amount: u32,
    total_amount: u32,
    owner_id: &'a str,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct JsQuote<'a> {
    station_id: &'a str,
    resource_type: &'a str,
    best_bid: Option<f64>,
    best_ask: Option<f64>,
    last_price: f64,
    ema_fast: f64,
    ema_slow: f64,
    vol50t: u64,
}

#[derive(Serialize)]
struct JsDepthLevel {
    price: f64,
    qty: u32,
}

#[derive(Serialize)]
struct JsDepth {
    bids: Vec<JsDepthLevel>,
    asks: Vec<JsDepthLevel>,
}

#[derive(Serialize)]
struct JsRouteCost {
    ticks: u32,
    fuel: u32,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct JsRecipe<'a> {
    id: &'a str,
    building_id: &'a str,
    cycle_ticks: u32,
    power_cost: u32,
    labor_cost: f64,
    inputs: Vec<JsIo<'a>>,
    outputs: Vec<JsIo<'a>>,
}

#[derive(Serialize)]
struct JsIo<'a> {
    item: &'a str,
    qty: u32,
}

/// Persistent per-player QuickJS VM reused across healthy ticks (`ctx` drops before `rt`).
pub struct PlayerVmHandle {
    ctx: Context,
    rt: Runtime,
    host: Arc<HostState>,
    timed_out_flag: Arc<AtomicBool>,
    deadline_us: Arc<AtomicU64>,
}

impl Drop for PlayerVmHandle {
    fn drop(&mut self) {
        // Clear interrupt handler & memory limit before Context/Runtime drop so GC teardown cannot re-trigger
        self.deadline_us.store(u64::MAX, Ordering::Release);
        self.rt.set_interrupt_handler(None);
        self.rt.set_memory_limit(usize::MAX);
    }
}

impl PlayerVmHandle {
    pub fn new(
        snapshot: Arc<WorldSnapshot>,
        catalog: Arc<ProductionCatalog>,
        bundle: Arc<PlayerScriptBundle>,
        previous_memory_json: &str,
        config: &PlayerRunConfig,
    ) -> Result<Self, String> {
        let rt = Runtime::new().map_err(|e| format!("Failed to initialize QuickJS runtime: {e}"))?;
        rt.set_memory_limit(config.memory_limit_bytes);
        rt.set_max_stack_size(config.stack_size_bytes);

        let timed_out_flag = Arc::new(AtomicBool::new(false));
        let deadline_us = Arc::new(AtomicU64::new(now_us().saturating_add(INIT_SAFETY_US)));
        let timeout_clone = Arc::clone(&timed_out_flag);
        let deadline_clone = Arc::clone(&deadline_us);
        rt.set_interrupt_handler(Some(Box::new(move || {
            let dl = deadline_clone.load(Ordering::Relaxed);
            if now_us() >= dl {
                timeout_clone.store(true, Ordering::Relaxed);
                true
            } else {
                false
            }
        })));

        let ctx = match Context::full(&rt) {
            Ok(c) => c,
            Err(e) => {
                deadline_us.store(u64::MAX, Ordering::Release);
                rt.set_interrupt_handler(None);
                rt.set_memory_limit(usize::MAX);
                return Err(format!("Failed to create QuickJS context: {e}"));
            }
        };

        let host = Arc::new(HostState {
            tick: Mutex::new(HostTickState {
                snapshot,
                catalog,
                bundle,
                user_started_at: Instant::now(),
            }),
            mutable: Mutex::new(HostMutable {
                intents: Vec::new(),
                logs: Vec::new(),
                truncated_logs: false,
                max_console_lines: config.max_console_lines,
                max_console_line_bytes: config.max_console_line_bytes,
            }),
        });

        let mut init_err: Option<String> = None;
        ctx.with(|ctx| {
            if let Err(e) = install_host_bindings(&ctx, Arc::clone(&host)) {
                init_err = Some(format!("Host binding setup error: {e}"));
                return;
            }
            let safe_mem = if previous_memory_json.trim().is_empty() {
                "{}"
            } else {
                previous_memory_json
            };
            let mem_init_script = format!(
                "globalThis.Memory = JSON.parse({});",
                serde_json::to_string(safe_mem).unwrap_or_else(|_| "\"{}\"".to_string())
            );
            if let Err(err) = ctx.eval::<(), _>(mem_init_script).catch(&ctx) {
                init_err = Some(format_caught_error(err));
                return;
            }
            if let Err(err) = ctx.eval::<(), _>(PRELUDE_JS).catch(&ctx) {
                init_err = Some(format_caught_error(err));
            }
        });

        deadline_us.store(u64::MAX, Ordering::Release);
        if let Some(err) = init_err {
            return Err(err);
        }

        Ok(Self {
            ctx,
            rt,
            host,
            timed_out_flag,
            deadline_us,
        })
    }

    /// Execute one tick inside this VM. Returns `(output, keep_vm)`.
    /// When `keep_vm == false` (timeout / OOM / runtime error), caller must drop this VM.
    pub fn run_tick(
        &mut self,
        snapshot: Arc<WorldSnapshot>,
        catalog: Arc<ProductionCatalog>,
        bundle: Arc<PlayerScriptBundle>,
        previous_memory_json: &str,
        config: &PlayerRunConfig,
    ) -> (PlayerRunOutput, bool) {
        self.rt.set_memory_limit(config.memory_limit_bytes);
        self.rt.set_max_stack_size(config.stack_size_bytes);

        {
            let mut tick = self.host.tick.lock().unwrap();
            tick.snapshot = Arc::clone(&snapshot);
            tick.catalog = Arc::clone(&catalog);
            tick.bundle = Arc::clone(&bundle);
            tick.user_started_at = Instant::now();
        }
        {
            let mut mutable = self.host.mutable.lock().unwrap();
            mutable.intents.clear();
            mutable.logs.clear();
            mutable.truncated_logs = false;
            mutable.max_console_lines = config.max_console_lines;
            mutable.max_console_line_bytes = config.max_console_line_bytes;
        }

        let mut run_error: Option<String> = None;
        let mut next_memory_json = previous_memory_json.to_string();
        let mut cpu_used_ms = 0.0;
        let boot_json = build_boot_json(&snapshot, &catalog, config);

        self.ctx.with(|ctx| {
            // Phase 1: refresh per-tick Game snapshot under setup guard (not billed to player CPU budget)
            self.timed_out_flag.store(false, Ordering::Release);
            self.deadline_us
                .store(now_us().saturating_add(REFRESH_SAFETY_US), Ordering::Release);
            let setup_res: Result<(), String> = (|| {
                let boot_val = ctx
                    .json_parse(boot_json)
                    .map_err(|e| format!("Boot JSON parse error: {e}"))?;
                ctx.globals()
                    .set("__MERIDIAN_BOOTSTRAP", boot_val)
                    .map_err(|e| format!("Boot global error: {e}"))?;
                ctx.eval::<(), _>(
                    "globalThis.__sandbox_refresh_game(globalThis.__MERIDIAN_BOOTSTRAP); delete globalThis.__MERIDIAN_BOOTSTRAP;",
                )
                .catch(&ctx)
                .map_err(format_caught_error)
            })();
            self.deadline_us.store(u64::MAX, Ordering::Release);
            if let Err(err) = setup_res {
                run_error = Some(err);
                return;
            }

            // Phase 2: execute player code & serialize Memory strictly within cpu_limit_ms
            let user_started = Instant::now();
            self.host.tick.lock().unwrap().user_started_at = user_started;
            self.timed_out_flag.store(false, Ordering::Release);
            let limit_us = config.cpu_limit_ms.max(1).saturating_mul(1_000);
            self.deadline_us
                .store(now_us().saturating_add(limit_us), Ordering::Release);

            let eval_res = ctx
                .eval::<String, _>("globalThis.__meridian_run_tick()")
                .catch(&ctx);

            cpu_used_ms = user_started.elapsed().as_secs_f64() * 1000.0;
            self.deadline_us.store(u64::MAX, Ordering::Release);

            match eval_res {
                Ok(mem_out) => {
                    if mem_out.len() > config.max_memory_json_bytes {
                        run_error = Some(format!(
                            "Memory serialized size ({} bytes) exceeds limit ({} bytes); Memory changes discarded",
                            mem_out.len(),
                            config.max_memory_json_bytes
                        ));
                    } else {
                        next_memory_json = mem_out;
                    }
                }
                Err(err) => {
                    run_error = Some(format_caught_error(err));
                }
            }
        });

        let timed_out = self.timed_out_flag.load(Ordering::Relaxed);
        let oom = run_error
            .as_deref()
            .map(|s| s.to_ascii_lowercase().contains("out of memory"))
            .unwrap_or(false);

        if timed_out && run_error.is_none() {
            run_error = Some(format!(
                "Script execution timed out after {:.2}ms (limit: {}ms)",
                cpu_used_ms, config.cpu_limit_ms
            ));
        }

        let mut guard = self.host.mutable.lock().unwrap();
        let logs = std::mem::take(&mut guard.logs);
        let healthy = run_error.is_none() && !timed_out && !oom;
        let intents = if !healthy {
            // Atomic rollback on script crash/timeout/OOM so partial broken intents never land
            next_memory_json = previous_memory_json.to_string();
            Vec::new()
        } else {
            std::mem::take(&mut guard.intents)
        };

        let out = PlayerRunOutput {
            intents,
            memory_json: next_memory_json,
            logs,
            cpu_used_ms,
            error: run_error,
            timed_out,
            oom,
        };
        (out, healthy)
    }
}

/// Run a single player company's QuickJS `module.exports.loop()` on a read-only `WorldSnapshot`.
pub fn run_player_tick(
    snapshot: Arc<WorldSnapshot>,
    catalog: Arc<ProductionCatalog>,
    bundle: Arc<PlayerScriptBundle>,
    previous_memory_json: &str,
    config: &PlayerRunConfig,
) -> PlayerRunOutput {
    let mut vm = match PlayerVmHandle::new(
        Arc::clone(&snapshot),
        Arc::clone(&catalog),
        Arc::clone(&bundle),
        previous_memory_json,
        config,
    ) {
        Ok(vm) => vm,
        Err(err) => {
            let oom = err.to_ascii_lowercase().contains("out of memory");
            return PlayerRunOutput {
                memory_json: previous_memory_json.to_string(),
                error: Some(err),
                oom,
                ..Default::default()
            };
        }
    };
    let (out, _keep) = vm.run_tick(snapshot, catalog, bundle, previous_memory_json, config);
    out
}

fn format_caught_error<'js>(err: CaughtError<'js>) -> String {
    match err {
        CaughtError::Exception(ex) => {
            let msg = ex.message().unwrap_or_else(|| "JS Exception".to_string());
            if let Some(stack) = ex.stack() {
                if !stack.is_empty() {
                    return format!("{msg}\n{stack}");
                }
            }
            msg
        }
        CaughtError::Value(val) => {
            if val.is_null() {
                "InternalError: out of memory (QuickJS heap limit reached)".to_string()
            } else {
                format!("Thrown JS value: {:?}", val.type_of())
            }
        }
        CaughtError::Error(e) => format!("{e}"),
    }
}

fn install_host_bindings<'js>(
    ctx: &rquickjs::Ctx<'js>,
    host: Arc<HostState>,
) -> rquickjs::Result<()> {
    let globals = ctx.globals();

    // 1. console log bridge
    {
        let h = Arc::clone(&host);
        globals.set(
            "__meridian_log",
            Function::new(ctx.clone(), move |level: String, msg: String| {
                let lvl = match level.as_str() {
                    "warn" => ConsoleLevel::Warn,
                    "error" => ConsoleLevel::Error,
                    _ => ConsoleLevel::Log,
                };
                h.push_log(lvl, msg);
            })?,
        )?;
    }

    // 2. CPU elapsed helper (measures pure user script time in current tick)
    {
        let h = Arc::clone(&host);
        globals.set(
            "__meridian_cpu_used",
            Function::new(ctx.clone(), move || -> f64 {
                h.tick.lock().unwrap().user_started_at.elapsed().as_secs_f64() * 1000.0
            })?,
        )?;
    }

    // 3. CommonJS module source resolver
    {
        let h = Arc::clone(&host);
        globals.set(
            "__meridian_get_module",
            Function::new(ctx.clone(), move |name: String| -> Option<String> {
                h.tick.lock().unwrap().bundle.resolve(&name).map(|s| s.to_string())
            })?,
        )?;
    }

    // 4. Lazy Market & Catalog FFI lookups
    {
        let h = Arc::clone(&host);
        globals.set(
            "__sandbox_land_listings",
            Function::new(ctx.clone(), move |pid: String| -> String {
                let tick = h.tick.lock().unwrap();
                let Some(p) = tick.snapshot.planets.get(&pid) else {
                    return "[]".to_string();
                };
                let out: Vec<BootLandListing<'_>> = p
                    .land_listings
                    .iter()
                    .map(|l| BootLandListing {
                        listing_id: l.listing_id.to_string(),
                        plot_id: l.plot_id.to_string(),
                        slot_id: l.slot_id,
                        seller_id: &l.seller_id,
                        ask_price: from_money(l.ask_price),
                        terrain_name: &l.terrain_name,
                        lat: l.lat,
                        lon: l.lon,
                        capacity: l.capacity,
                        used_slots: l.used_slots,
                        building_mods: &l.building_mods,
                        buildings: &l.buildings,
                    })
                    .collect();
                serde_json::to_string(&out).unwrap_or_else(|_| "[]".to_string())
            })?,
        )?;
    }
    {
        let h = Arc::clone(&host);
        globals.set(
            "__meridian_quote",
            Function::new(ctx.clone(), move |sid: String, item: String| -> Option<String> {
                let tick = h.tick.lock().unwrap();
                let q = tick.snapshot.quotes.get(&sid)?.get(&item)?;
                let j = JsQuote {
                    station_id: &q.station_id,
                    resource_type: &q.item_id,
                    best_bid: q.best_bid.map(from_money),
                    best_ask: q.best_ask.map(from_money),
                    last_price: from_money(q.last_price),
                    ema_fast: from_money(q.ema_fast),
                    ema_slow: from_money(q.ema_slow),
                    vol50t: q.vol_50t,
                };
                serde_json::to_string(&j).ok()
            })?,
        )?;
    }
    {
        let h = Arc::clone(&host);
        globals.set(
            "__meridian_depth",
            Function::new(
                ctx.clone(),
                move |sid: String, item: String, limit: usize| -> String {
                    let tick = h.tick.lock().unwrap();
                    let depth = match tick.snapshot.depths.get(&sid).and_then(|m| m.get(&item)) {
                        Some((bids, asks)) => JsDepth {
                            bids: bids
                                .iter()
                                .take(limit)
                                .map(|l| JsDepthLevel {
                                    price: from_money(l.price),
                                    qty: l.qty,
                                })
                                .collect(),
                            asks: asks
                                .iter()
                                .take(limit)
                                .map(|l| JsDepthLevel {
                                    price: from_money(l.price),
                                    qty: l.qty,
                                })
                                .collect(),
                        },
                        None => JsDepth {
                            bids: Vec::new(),
                            asks: Vec::new(),
                        },
                    };
                    serde_json::to_string(&depth).unwrap_or_else(|_| "{\"bids\":[],\"asks\":[]}".to_string())
                },
            )?,
        )?;
    }
    {
        let h = Arc::clone(&host);
        globals.set(
            "__meridian_get_all_orders",
            Function::new(
                ctx.clone(),
                move |sid: String, item: String, side_str: String| -> String {
                    let want_side = match side_str.as_str() {
                        "buy" => Some(OrderSide::Buy),
                        "sell" => Some(OrderSide::Sell),
                        "" => None,
                        _ => return "[]".to_string(),
                    };
                    let tick = h.tick.lock().unwrap();
                    let filtered: Vec<JsOrder<'_>> = tick
                        .snapshot
                        .orders
                        .iter()
                        .filter(|o| {
                            (sid.is_empty() || o.station_id == sid)
                                && (item.is_empty() || o.item_id == item)
                                && want_side.map(|s| o.side == s).unwrap_or(true)
                        })
                        .map(to_js_order)
                        .collect();
                    serde_json::to_string(&filtered).unwrap_or_else(|_| "[]".to_string())
                },
            )?,
        )?;
    }
    {
        let h = Arc::clone(&host);
        globals.set(
            "__meridian_calc_route",
            Function::new(ctx.clone(), move |from: String, to: String| -> Option<String> {
                let tick = h.tick.lock().unwrap();
                let (ticks, fuel) = tick.snapshot.route_cost(&from, &to)?;
                serde_json::to_string(&JsRouteCost { ticks, fuel }).ok()
            })?,
        )?;
    }
    {
        let h = Arc::clone(&host);
        globals.set(
            "__meridian_get_recipe",
            Function::new(ctx.clone(), move |recipe_id: String| -> Option<String> {
                let tick = h.tick.lock().unwrap();
                let r = tick.catalog.recipes.get(&recipe_id)?;
                let jr = JsRecipe {
                    id: &r.id,
                    building_id: &r.building_id,
                    cycle_ticks: r.cycle_ticks,
                    power_cost: r.power_cost,
                    labor_cost: r.labor_cost,
                    inputs: r
                        .inputs
                        .iter()
                        .map(|io| JsIo {
                            item: &io.item,
                            qty: io.qty,
                        })
                        .collect(),
                    outputs: r
                        .outputs
                        .iter()
                        .map(|io| JsIo {
                            item: &io.item,
                            qty: io.qty,
                        })
                        .collect(),
                };
                serde_json::to_string(&jr).ok()
            })?,
        )?;
    }
    {
        let h = Arc::clone(&host);
        globals.set(
            "__meridian_get_land_plots",
            Function::new(ctx.clone(), move |pid: String| -> Option<String> {
                let tick = h.tick.lock().unwrap();
                let tiles = tick.snapshot.public_tiles.get(&pid)?;
                let out: Vec<JsLandPlot<'_>> = tiles
                    .iter()
                    .map(|t| JsLandPlot {
                        slot_id: t.slot_id,
                        planet_id: &t.planet_id,
                        lat: t.lat,
                        lon: t.lon,
                        terrain_name: &t.terrain_name,
                        capacity: t.capacity,
                        used_slots: t.used_slots,
                        building_mods: &t.building_mods,
                        status: &t.status,
                        is_city: t.is_city,
                        city_name: t.city_name.as_deref(),
                        owner_id: t.owner_id.as_deref(),
                        owner_name: t.owner_name.as_deref(),
                        is_player_owner: t.is_player_owner,
                        plot_id: t.plot_id.map(|id| id.to_string()),
                        listing_id: t.listing_id.map(|id| id.to_string()),
                        price: t.price.map(from_money),
                        buildings: &t.buildings,
                    })
                    .collect();
                serde_json::to_string(&out).ok()
            })?,
        )?;
    }
    {
        let h = Arc::clone(&host);
        globals.set(
            "__meridian_list_companies",
            Function::new(
                ctx.clone(),
                move |query: String,
                      planet_id: String,
                      only_players: bool,
                      offset: i32,
                      limit: i32|
                      -> String {
                    let q = query.trim().to_ascii_lowercase();
                    let skip = offset.max(0) as usize;
                    let take = limit.clamp(1, 1000) as usize;
                    let tick = h.tick.lock().unwrap();
                    let out: Vec<JsPublicCompanySummary<'_>> = tick
                        .snapshot
                        .public_companies
                        .iter()
                        .filter(|c| {
                            (!only_players || c.is_player)
                                && (planet_id.is_empty() || c.home_planet_id == planet_id)
                                && (q.is_empty()
                                    || c.name.to_ascii_lowercase().contains(&q)
                                    || c.id.to_ascii_lowercase().contains(&q)
                                    || c.home_planet_id.to_ascii_lowercase().contains(&q))
                        })
                        .skip(skip)
                        .take(take)
                        .map(to_js_company_summary)
                        .collect();
                    serde_json::to_string(&out).unwrap_or_else(|_| "[]".to_string())
                },
            )?,
        )?;
    }
    {
        let h = Arc::clone(&host);
        globals.set(
            "__meridian_get_company",
            Function::new(ctx.clone(), move |company_id: String| -> Option<String> {
                let tick = h.tick.lock().unwrap();
                let d = tick.snapshot.public_company_detail(&company_id)?;
                let plots = d
                    .plots
                    .into_iter()
                    .map(|p| JsPublicCompanyPlot {
                        planet_id: p.planet_id,
                        slot_id: p.slot_id,
                        plot_id: p.plot_id.map(|id| id.to_string()),
                        lat: p.lat,
                        lon: p.lon,
                        terrain_name: p.terrain_name,
                        capacity: p.capacity,
                        used_slots: p.used_slots,
                        status: p.status,
                        listing_id: p.listing_id.map(|id| id.to_string()),
                        price: p.price.map(from_money),
                        buildings: p.buildings,
                    })
                    .collect();
                let open_orders = d.open_orders.iter().map(to_js_order).collect();
                let view = JsPublicCompanyDetail {
                    id: d.id,
                    name: d.name,
                    is_player: d.is_player,
                    home_planet_id: d.home_planet_id,
                    net_liquid: from_money(d.net_liquid),
                    plots_count: d.plots_count,
                    buildings_count: d.buildings_count,
                    ships_count: d.ships_count,
                    ships_by_size: d.ships_by_size,
                    building_counts: d.building_counts,
                    plots,
                    open_orders_count: d.open_orders_count,
                    open_orders,
                };
                serde_json::to_string(&view).ok()
            })?,
        )?;
    }

    // 5. Intent emitters with return codes
    {
        let h = Arc::clone(&host);
        globals.set(
            "__meridian_set_recipe",
            Function::new(ctx.clone(), move |bid_str: String, recipe_id: String| -> i32 {
                let Ok(bid) = bid_str.parse::<BuildingId>() else {
                    return ERR_INVALID_ARGS;
                };
                {
                    let tick = h.tick.lock().unwrap();
                    let Some(bld) = tick.snapshot.company.buildings.iter().find(|b| b.id == bid) else {
                        return ERR_NOT_OWNER;
                    };
                    let Some(rdef) = tick.catalog.recipes.get(&recipe_id) else {
                        return ERR_NOT_FOUND;
                    };
                    if rdef.building_id != bld.building_type {
                        return ERR_INVALID_TARGET;
                    }
                }
                h.push_intent(Intent::SetRecipe {
                    building_id: bid,
                    recipe_id,
                })
            })?,
        )?;
    }
    {
        let h = Arc::clone(&host);
        globals.set(
            "__meridian_set_active",
            Function::new(ctx.clone(), move |bid_str: String, active: bool| -> i32 {
                let Ok(bid) = bid_str.parse::<BuildingId>() else {
                    return ERR_INVALID_ARGS;
                };
                {
                    let tick = h.tick.lock().unwrap();
                    if !tick.snapshot.company.buildings.iter().any(|b| b.id == bid) {
                        return ERR_NOT_OWNER;
                    }
                }
                h.push_intent(Intent::ToggleBuilding {
                    building_id: bid,
                    active,
                })
            })?,
        )?;
    }
    {
        let h = Arc::clone(&host);
        globals.set(
            "__meridian_dispatch_ship",
            Function::new(
                ctx.clone(),
                move |sid_str: String, from: String, to: String, cargo_json: String| -> i32 {
                    let Ok(sid) = sid_str.parse::<ShipId>() else {
                        return ERR_INVALID_ARGS;
                    };
                    let Ok(raw_map) = serde_json::from_str::<HashMap<String, f64>>(&cargo_json) else {
                        return ERR_INVALID_ARGS;
                    };
                    if raw_map.is_empty() {
                        return ERR_INVALID_ARGS;
                    }
                    let cargo_vec = {
                        let tick = h.tick.lock().unwrap();
                        let Some(ship) = tick.snapshot.company.ships.iter().find(|s| s.id == sid) else {
                            return ERR_NOT_OWNER;
                        };
                        if ship.is_busy {
                            return ERR_BUSY;
                        }
                        if ship.location != from {
                            return ERR_NOT_IN_RANGE;
                        }
                        let Some((_ticks, fuel_needed)) = tick.snapshot.route_cost(&from, &to) else {
                            return ERR_NO_PATH;
                        };
                        let mut cargo_vec = Vec::with_capacity(raw_map.len());
                        let mut total_qty = 0u32;
                        for (item, qf) in raw_map {
                            if !tick.catalog.items.contains_key(&item) || !qf.is_finite() || qf <= 0.0 {
                                return ERR_INVALID_ARGS;
                            }
                            let qty = qf.floor() as u32;
                            if qty == 0 {
                                return ERR_INVALID_ARGS;
                            }
                            total_qty = total_qty.saturating_add(qty);
                            cargo_vec.push((item, qty));
                        }
                        if total_qty > ship.capacity {
                            return ERR_FULL;
                        }
                        // Quick fuel check against fuel inventory at departure
                        if let Some(fuel_item) = &tick.catalog.fuel_item {
                            let available_fuel = if from.starts_with("ST:") {
                                tick.snapshot
                                    .company
                                    .station_stores
                                    .get(&from)
                                    .and_then(|m| m.get(fuel_item))
                                    .copied()
                                    .unwrap_or(0)
                            } else {
                                tick.snapshot
                                    .planets
                                    .get(&from)
                                    .and_then(|p| p.ground_store.get(fuel_item))
                                    .copied()
                                    .unwrap_or(0)
                            };
                            if available_fuel < fuel_needed {
                                return ERR_NOT_ENOUGH_RESOURCES;
                            }
                        }
                        cargo_vec
                    };
                    h.push_intent(Intent::DispatchShip {
                        ship_id: sid,
                        from,
                        to,
                        cargo: cargo_vec,
                    })
                },
            )?,
        )?;
    }
    {
        let h = Arc::clone(&host);
        globals.set(
            "__meridian_repair_ship",
            Function::new(ctx.clone(), move |sid_str: String| -> i32 {
                let Ok(sid) = sid_str.parse::<ShipId>() else {
                    return ERR_INVALID_ARGS;
                };
                {
                    let tick = h.tick.lock().unwrap();
                    let Some(ship) = tick.snapshot.company.ships.iter().find(|s| s.id == sid) else {
                        return ERR_NOT_OWNER;
                    };
                    if ship.is_busy {
                        return ERR_BUSY;
                    }
                }
                h.push_intent(Intent::RepairShip { ship_id: sid })
            })?,
        )?;
    }
    {
        let h = Arc::clone(&host);
        globals.set(
            "__meridian_create_order",
            Function::new(
                ctx.clone(),
                move |station_id: String, side_str: String, item_id: String, qty: u32, price_f: f64| -> i32 {
                    if qty == 0 || !price_f.is_finite() || price_f <= 0.0 {
                        return ERR_INVALID_ARGS;
                    }
                    let side = match side_str.as_str() {
                        "buy" => OrderSide::Buy,
                        "sell" => OrderSide::Sell,
                        _ => return ERR_INVALID_ARGS,
                    };
                    let price = to_money(price_f);
                    if price <= 0 {
                        return ERR_INVALID_ARGS;
                    }
                    {
                        let tick = h.tick.lock().unwrap();
                        if !tick.catalog.items.contains_key(&item_id) || !tick.snapshot.quotes.contains_key(&station_id) {
                            return ERR_INVALID_TARGET;
                        }
                        if tick.snapshot.company.open_orders.len() >= MAX_ACTIVE_ORDERS_PER_COMPANY {
                            return ERR_FULL;
                        }
                        if side == OrderSide::Buy {
                            let cost = qty as i128 * price as i128;
                            if (tick.snapshot.company.cash as i128) < cost {
                                return ERR_NOT_ENOUGH_CREDITS;
                            }
                        }
                    }
                    h.push_intent(Intent::CreateOrder {
                        station_id,
                        side,
                        item_id,
                        qty,
                        price,
                    })
                },
            )?,
        )?;
    }
    {
        let h = Arc::clone(&host);
        globals.set(
            "__meridian_cancel_order",
            Function::new(ctx.clone(), move |oid_str: String| -> i32 {
                let Ok(oid) = oid_str.parse::<OrderId>() else {
                    return ERR_INVALID_ARGS;
                };
                {
                    let tick = h.tick.lock().unwrap();
                    if !tick
                        .snapshot
                        .company
                        .open_orders
                        .iter()
                        .any(|o| o.order_id == oid)
                    {
                        return ERR_NOT_FOUND;
                    }
                }
                h.push_intent(Intent::CancelOrder { order_id: oid })
            })?,
        )?;
    }
    {
        let h = Arc::clone(&host);
        globals.set(
            "__meridian_deal_order",
            Function::new(ctx.clone(), move |oid_str: String, amount: u32| -> i32 {
                if amount == 0 {
                    return ERR_INVALID_ARGS;
                }
                let Ok(oid) = oid_str.parse::<OrderId>() else {
                    return ERR_INVALID_ARGS;
                };
                {
                    let tick = h.tick.lock().unwrap();
                    if !tick.snapshot.orders.iter().any(|o| o.order_id == oid) {
                        return ERR_NOT_FOUND;
                    }
                }
                h.push_intent(Intent::DealOrder {
                    order_id: oid,
                    amount,
                })
            })?,
        )?;
    }
    {
        let h = Arc::clone(&host);
        globals.set(
            "__meridian_buy_plot",
            Function::new(
                ctx.clone(),
                move |pid: String, mode: String, id_str: String| -> i32 {
                    let intent = {
                        let tick = h.tick.lock().unwrap();
                        let Some(p_view) = tick.snapshot.planets.get(&pid) else {
                            return ERR_NOT_FOUND;
                        };
                        match mode.as_str() {
                            "listing" => {
                                let Ok(lid) = id_str.parse::<ListingId>() else {
                                    return ERR_INVALID_ARGS;
                                };
                                if !p_view.land_listings.iter().any(|l| l.listing_id == lid) {
                                    return ERR_NOT_FOUND;
                                }
                                Intent::BuyPlot {
                                    planet_id: pid,
                                    slot_id: None,
                                    listing_id: Some(lid),
                                }
                            }
                            "slot" => {
                                let Ok(sid) = id_str.parse::<u32>() else {
                                    return ERR_INVALID_ARGS;
                                };
                                let Some(tiles) = tick.snapshot.public_tiles.get(&pid) else {
                                    return ERR_NOT_FOUND;
                                };
                                let Some(tile) = tiles.iter().find(|t| t.slot_id == sid) else {
                                    return ERR_NOT_FOUND;
                                };
                                if tile.status != "unclaimed" {
                                    return ERR_INVALID_TARGET;
                                }
                                Intent::BuyPlot {
                                    planet_id: pid,
                                    slot_id: Some(sid),
                                    listing_id: None,
                                }
                            }
                            _ => return ERR_INVALID_ARGS,
                        }
                    };
                    h.push_intent(intent)
                },
            )?,
        )?;
    }
    {
        let h = Arc::clone(&host);
        globals.set(
            "__meridian_build_facility",
            Function::new(ctx.clone(), move |plot_str: String, btype: String| -> i32 {
                let Ok(plot_id) = plot_str.parse::<PlotId>() else {
                    return ERR_INVALID_ARGS;
                };
                {
                    let tick = h.tick.lock().unwrap();
                    if !tick.snapshot.company.plots.iter().any(|p| p.id == plot_id) {
                        return ERR_NOT_OWNER;
                    }
                    if !tick.catalog.buildings.contains_key(&btype) {
                        return ERR_INVALID_TARGET;
                    }
                }
                h.push_intent(Intent::BuildFacility {
                    plot_id,
                    building_type: btype,
                })
            })?,
        )?;
    }
    {
        let h = Arc::clone(&host);
        globals.set(
            "__meridian_demolish_facility",
            Function::new(
                ctx.clone(),
                move |plot_str: String, bid_str: String| -> i32 {
                    let (Ok(plot_id), Ok(building_id)) =
                        (plot_str.parse::<PlotId>(), bid_str.parse::<BuildingId>())
                    else {
                        return ERR_INVALID_ARGS;
                    };
                    {
                        let tick = h.tick.lock().unwrap();
                        if !tick.snapshot.company.plots.iter().any(|p| p.id == plot_id) {
                            return ERR_NOT_OWNER;
                        }
                    }
                    h.push_intent(Intent::DemolishFacility {
                        plot_id,
                        building_id,
                    })
                },
            )?,
        )?;
    }
    {
        let h = Arc::clone(&host);
        globals.set(
            "__meridian_bank",
            Function::new(
                ctx.clone(),
                move |pid: String, op_str: String, amount_f: f64| -> i32 {
                    if !price_positive(amount_f) {
                        return ERR_INVALID_ARGS;
                    }
                    let op = match op_str.as_str() {
                        "deposit" => BankOpKind::Deposit,
                        "withdraw" => BankOpKind::Withdraw,
                        "borrow" => BankOpKind::Borrow,
                        "repay" => BankOpKind::Repay,
                        _ => return ERR_INVALID_ARGS,
                    };
                    let amount = to_money(amount_f);
                    if amount <= 0 {
                        return ERR_INVALID_ARGS;
                    }
                    {
                        let tick = h.tick.lock().unwrap();
                        if !tick.snapshot.planets.contains_key(&pid) {
                            return ERR_INVALID_ARGS;
                        }
                    }
                    h.push_intent(Intent::BankOp {
                        planet_id: pid,
                        op,
                        amount,
                    })
                },
            )?,
        )?;
    }

    Ok(())
}

#[inline]
fn price_positive(v: f64) -> bool {
    v.is_finite() && v > 0.0
}

fn build_boot_json(
    snap: &WorldSnapshot,
    catalog: &ProductionCatalog,
    config: &PlayerRunConfig,
) -> String {
    let mut resources: Vec<&str> = catalog.items.keys().map(|s| s.as_str()).collect();
    resources.sort_unstable();

    let planets: Vec<BootPlanet<'_>> = snap
        .planets
        .values()
        .map(|p| BootPlanet {
            id: &p.id,
            name: &p.name,
            wealth_tier: p.wealth_tier,
            prosperity: p.prosperity,
            population: p.population,
            gravity: p.gravity,
            waste_backlog: p.waste_backlog,
            primary_land_price: p.primary_land_price.map(from_money),
            bank_rate_pct: p.bank_rate_bps as f64 / 100.0,
            ground_store: &p.ground_store,
            station_store: &p.station_store,
            demands: &p.demands,
        })
        .collect();

    let stations: HashMap<&str, &HashMap<String, u32>> = snap
        .company
        .station_stores
        .iter()
        .map(|(k, v)| (k.as_str(), v))
        .collect();

    let plots: Vec<BootPlot<'_>> = snap
        .company
        .plots
        .iter()
        .map(|pl| BootPlot {
            id: pl.id.to_string(),
            slot_id: pl.slot_id,
            planet_id: &pl.planet_id,
            lat: pl.lat,
            lon: pl.lon,
            terrain_name: &pl.terrain_name,
            capacity: pl.capacity,
            used_slots: pl.used_slots,
            building_mods: &pl.building_mods,
        })
        .collect();

    let buildings: Vec<BootBuilding<'_>> = snap
        .company
        .buildings
        .iter()
        .map(|b| BootBuilding {
            id: b.id.to_string(),
            building_type: &b.building_type,
            plot_id: b.plot_id.to_string(),
            planet_id: &b.planet_id,
            efficiency: b.efficiency,
            recipe_id: &b.recipe_id,
            active: b.active,
            progress: b.progress,
            cycle_ticks: b.cycle_ticks,
        })
        .collect();

    let ships: Vec<BootShip<'_>> = snap
        .company
        .ships
        .iter()
        .map(|s| BootShip {
            id: s.id.to_string(),
            size: match s.size {
                meridian_core::ShipSize::Small => "small",
                meridian_core::ShipSize::Medium => "medium",
                meridian_core::ShipSize::Large => "large",
            },
            capacity: s.capacity,
            durability: s.durability,
            location: &s.location,
            busy_until: s.busy_until,
            is_busy: s.is_busy,
            cargo: &s.cargo,
        })
        .collect();

    let own_orders: Vec<JsOrder<'_>> = snap
        .company
        .open_orders
        .iter()
        .map(|o| JsOrder {
            id: o.order_id.to_string(),
            created: o.created_tick,
            side: match o.side {
                OrderSide::Buy => "buy",
                OrderSide::Sell => "sell",
            },
            resource_type: &o.item_id,
            station_id: &o.station_id,
            price: from_money(o.price),
            amount: o.qty,
            total_amount: o.total_qty,
            owner_id: &o.owner_id,
        })
        .collect();

    let payload = BootPayload {
        tick: snap.tick,
        cpi: snap.cpi,
        cpu_limit_ms: config.cpu_limit_ms,
        resources,
        company: BootCompany {
            id: &snap.company.id,
            name: &snap.company.name,
            profession: &snap.company.profession,
            home_planet_id: &snap.company.home_planet_id,
            cash: from_money(snap.company.cash),
            savings: from_money(snap.company.savings),
            debt: from_money(snap.company.debt),
        },
        planets,
        stations,
        plots,
        buildings,
        ships,
        own_orders,
    };

    serde_json::to_string(&payload).expect("BootPayload serialization should never fail")
}

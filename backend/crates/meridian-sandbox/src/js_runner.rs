//! QuickJS (`rquickjs`) sandbox runner exposing the player-script API v2: `Game`, `Memory`,
//! `Store`, `console`, `require()`, `OK/ERR_*`, `MONEY_SCALE`, per-tick shadow ledger checks,
//! and real sandbox Console REPL evaluation with strict CPU & heap isolation.

use std::collections::{BTreeMap, HashMap, HashSet};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::Instant;

use meridian_core::{
    checked_notional, from_money, price_in_band, to_money, BankOpKind, BuildingId, Intent,
    ListingId, Money, Order, OrderId, OrderSide, PlotId, ProductionCatalog, PublicCompanySummary,
    ShipCountsView, ShipId, WorldSnapshot, ERR_BUSY, ERR_FULL, ERR_INVALID_ARGS,
    ERR_INVALID_TARGET, ERR_NOT_ENOUGH_CREDITS, ERR_NOT_ENOUGH_RESOURCES, ERR_NOT_FOUND,
    ERR_NOT_OWNER, ERR_NO_PATH, MAX_ACTIVE_ORDERS_PER_COMPANY, MAX_INTENTS_PER_TICK,
    MAX_ORDER_QTY, OK,
};
use rquickjs::{CatchResultExt, CaughtError, Context, Function, Runtime};
use serde::Serialize;

use crate::types::{
    ConsoleEntry, ConsoleEvalOutput, ConsoleLevel, LastTickFeedback, PlayerRunConfig,
    PlayerRunOutput, PlayerScriptBundle,
};

const PRELUDE_JS: &str = include_str!("prelude.js");
const INIT_SAFETY_US: u64 = 50_000;
const REFRESH_SAFETY_US: u64 = 25_000;

fn now_us() -> u64 {
    static EPOCH: OnceLock<Instant> = OnceLock::new();
    let epoch = EPOCH.get_or_init(Instant::now);
    epoch.elapsed().as_micros() as u64
}

/// Per-tick shadow reservations preventing fake `OK` responses when a script queues
/// multiple actions against the same cash, cargo, fuel, plot slots, ship, or order limit.
#[derive(Default)]
struct ShadowState {
    cash_spent: Money,
    open_orders_created: usize,
    cancelled_orders: HashSet<OrderId>,
    dealt_taken: HashMap<OrderId, u32>,
    station_inv_spent: HashMap<(String, String), u32>,
    ground_inv_spent: HashMap<(String, String), u32>,
    plot_extra_slots: HashMap<PlotId, u32>,
    demolished_buildings: HashSet<BuildingId>,
    busy_ships: HashSet<ShipId>,
    repaired_ships: HashSet<ShipId>,
    claimed_slots: HashSet<(String, u32)>,
    bought_listings: HashSet<ListingId>,
    bank_savings_spent: Money,
    bank_debt_added: Money,
    bank_debt_repaid: Money,
}

impl ShadowState {
    fn reset(&mut self) {
        *self = Self::default();
    }

    fn available_cash(&self, snap: &WorldSnapshot) -> Money {
        snap.company.cash.saturating_sub(self.cash_spent)
    }

    fn available_station_qty(&self, snap: &WorldSnapshot, sid: &str, item: &str) -> u32 {
        let base = snap
            .company
            .station_stores
            .get(sid)
            .and_then(|m| m.get(item))
            .copied()
            .unwrap_or(0);
        let spent = self
            .station_inv_spent
            .get(&(sid.to_string(), item.to_string()))
            .copied()
            .unwrap_or(0);
        base.saturating_sub(spent)
    }

    fn available_ground_qty(&self, snap: &WorldSnapshot, pid: &str, item: &str) -> u32 {
        let base = snap
            .planets
            .get(pid)
            .and_then(|p| p.ground_store.get(item))
            .copied()
            .unwrap_or(0);
        let spent = self
            .ground_inv_spent
            .get(&(pid.to_string(), item.to_string()))
            .copied()
            .unwrap_or(0);
        base.saturating_sub(spent)
    }

    fn spend_station_qty(&mut self, sid: &str, item: &str, qty: u32) {
        if qty > 0 {
            *self
                .station_inv_spent
                .entry((sid.to_string(), item.to_string()))
                .or_insert(0) += qty;
        }
    }

    fn spend_ground_qty(&mut self, pid: &str, item: &str, qty: u32) {
        if qty > 0 {
            *self
                .ground_inv_spent
                .entry((pid.to_string(), item.to_string()))
                .or_insert(0) += qty;
        }
    }
}

struct HostMutable {
    intents: Vec<Intent>,
    shadow: ShadowState,
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
    fn push_intent_locked(guard: &mut HostMutable, intent: Intent) -> i32 {
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
    systems: Vec<BootSystem<'a>>,
    planets: Vec<BootPlanet<'a>>,
    stations: Vec<BootStation<'a>>,
    plots: Vec<BootPlot<'a>>,
    buildings: Vec<BootBuilding<'a>>,
    sites: Vec<BootSite<'a>>,
    ships: Vec<BootShip<'a>>,
    own_orders: Vec<JsOrder<'a>>,
    last_tick: &'a LastTickFeedback,
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
    debt_due_tick: Option<u64>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct BootSystem<'a> {
    id: &'a str,
    name: &'a str,
    star_class: &'a str,
    luminosity: f64,
    x: f64,
    y: f64,
    hub_station_id: &'a str,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct BootStation<'a> {
    id: &'a str,
    system_id: &'a str,
    planet_id: Option<&'a str>,
    store: Option<&'a HashMap<String, u32>>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct BootLandListing<'a> {
    listing_id: String,
    plot_id: String,
    slot_id: u32,
    seller_id: &'a str,
    price: f64,
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
    system_id: &'a str,
    station_id: String,
    name: &'a str,
    wealth_tier: u8,
    prosperity: f64,
    population: f64,
    gravity: f64,
    habitability: f64,
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
struct BootSite<'a> {
    id: String,
    plot_id: String,
    planet_id: &'a str,
    building_type: &'a str,
    finish_tick: u64,
    ticks_remaining: u64,
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
    kind: &'static str,
}

#[derive(Serialize)]
struct JsIo<'a> {
    item: &'a str,
    qty: u32,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct JsCatalogItem<'a> {
    id: &'a str,
    name: &'a str,
    role: &'static str,
    ref_price: f64,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct JsCatalogBuilding<'a> {
    id: &'a str,
    name: &'a str,
    slots_used: u32,
    build_ticks: u32,
    cash_fee_base: f64,
    build_cost: Vec<JsIo<'a>>,
    standby_power: u32,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct JsCatalogRecipe<'a> {
    id: &'a str,
    name: &'a str,
    building_id: &'a str,
    enabled: bool,
    cycle_ticks: u32,
    power_cost: u32,
    labor_cost: f64,
    inputs: Vec<JsIo<'a>>,
    outputs: Vec<JsIo<'a>>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct JsCatalogBundle<'a> {
    items: BTreeMap<&'a str, JsCatalogItem<'a>>,
    buildings: BTreeMap<&'a str, JsCatalogBuilding<'a>>,
    recipes: BTreeMap<&'a str, JsCatalogRecipe<'a>>,
    recipes_by_building: &'a HashMap<String, Vec<String>>,
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
                shadow: ShadowState::default(),
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

    fn refresh_tick_state(
        &mut self,
        snapshot: Arc<WorldSnapshot>,
        catalog: Arc<ProductionCatalog>,
        bundle: Arc<PlayerScriptBundle>,
        config: &PlayerRunConfig,
        last_tick: Option<&LastTickFeedback>,
    ) -> Result<(), String> {
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
            mutable.shadow.reset();
            mutable.logs.clear();
            mutable.truncated_logs = false;
            mutable.max_console_lines = config.max_console_lines;
            mutable.max_console_line_bytes = config.max_console_line_bytes;
        }

        let empty_feedback = LastTickFeedback::default();
        let feedback = last_tick.unwrap_or(&empty_feedback);
        let boot_json = build_boot_json(&snapshot, &catalog, config, feedback);

        let mut err_out = None;
        self.ctx.with(|ctx| {
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
                err_out = Some(err);
            }
        });
        match err_out {
            Some(e) => Err(e),
            None => Ok(()),
        }
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
        self.run_tick_with_feedback(
            snapshot,
            catalog,
            bundle,
            previous_memory_json,
            config,
            None,
        )
    }

    pub fn run_tick_with_feedback(
        &mut self,
        snapshot: Arc<WorldSnapshot>,
        catalog: Arc<ProductionCatalog>,
        bundle: Arc<PlayerScriptBundle>,
        previous_memory_json: &str,
        config: &PlayerRunConfig,
        last_tick: Option<&LastTickFeedback>,
    ) -> (PlayerRunOutput, bool) {
        if let Err(err) =
            self.refresh_tick_state(snapshot, catalog, bundle, config, last_tick)
        {
            let oom = err.to_ascii_lowercase().contains("out of memory");
            return (
                PlayerRunOutput {
                    memory_json: previous_memory_json.to_string(),
                    error: Some(err),
                    oom,
                    ..Default::default()
                },
                false,
            );
        }

        let mut run_error: Option<String> = None;
        let mut next_memory_json = previous_memory_json.to_string();
        let mut cpu_used_ms = 0.0;

        self.ctx.with(|ctx| {
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

    /// Evaluate an interactive Console REPL expression/statement inside the exact same
    /// QuickJS + `prelude.js` sandbox environment as `module.exports.loop()`.
    pub fn eval_console(
        &mut self,
        snapshot: Arc<WorldSnapshot>,
        catalog: Arc<ProductionCatalog>,
        bundle: Arc<PlayerScriptBundle>,
        previous_memory_json: &str,
        config: &PlayerRunConfig,
        last_tick: Option<&LastTickFeedback>,
        code: &str,
    ) -> (ConsoleEvalOutput, bool) {
        if let Err(err) =
            self.refresh_tick_state(snapshot, catalog, bundle, config, last_tick)
        {
            let oom = err.to_ascii_lowercase().contains("out of memory");
            return (
                ConsoleEvalOutput {
                    memory_json: previous_memory_json.to_string(),
                    error: Some(err),
                    oom,
                    ..Default::default()
                },
                false,
            );
        }

        let mut run_error: Option<String> = None;
        let mut next_memory_json = previous_memory_json.to_string();
        let mut result_json = "{\"kind\":\"undefined\"}".to_string();
        let mut cpu_used_ms = 0.0;

        self.ctx.with(|ctx| {
            let user_started = Instant::now();
            self.host.tick.lock().unwrap().user_started_at = user_started;
            self.timed_out_flag.store(false, Ordering::Release);
            let limit_us = config.cpu_limit_ms.max(10).saturating_mul(1_000);
            self.deadline_us
                .store(now_us().saturating_add(limit_us), Ordering::Release);

            let call = format!(
                "globalThis.__meridian_eval_console({})",
                serde_json::to_string(code).unwrap_or_else(|_| "\"\"".to_string())
            );
            let eval_res = ctx.eval::<String, _>(call).catch(&ctx);

            cpu_used_ms = user_started.elapsed().as_secs_f64() * 1000.0;
            self.deadline_us.store(u64::MAX, Ordering::Release);

            match eval_res {
                Ok(raw_json) => {
                    #[derive(serde::Deserialize)]
                    #[serde(rename_all = "camelCase")]
                    struct ConsoleRaw {
                        result: serde_json::Value,
                        memory_json: String,
                    }
                    match serde_json::from_str::<ConsoleRaw>(&raw_json) {
                        Ok(parsed) => {
                            result_json = serde_json::to_string(&parsed.result)
                                .unwrap_or_else(|_| "{\"kind\":\"undefined\"}".to_string());
                            if parsed.memory_json.len() > config.max_memory_json_bytes {
                                run_error = Some(format!(
                                    "Memory serialized size ({} bytes) exceeds limit ({} bytes); Memory changes discarded",
                                    parsed.memory_json.len(),
                                    config.max_memory_json_bytes
                                ));
                            } else {
                                next_memory_json = parsed.memory_json;
                            }
                        }
                        Err(e) => {
                            run_error = Some(format!("Console response parse error: {e}"));
                        }
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
                "Console eval timed out after {:.2}ms",
                cpu_used_ms
            ));
        }

        let mut guard = self.host.mutable.lock().unwrap();
        let logs = std::mem::take(&mut guard.logs);
        let healthy = run_error.is_none() && !timed_out && !oom;
        let (intents, memory_changed) = if !healthy {
            next_memory_json = previous_memory_json.to_string();
            (Vec::new(), false)
        } else {
            let ch = next_memory_json != previous_memory_json;
            (std::mem::take(&mut guard.intents), ch)
        };

        let out = ConsoleEvalOutput {
            result_json,
            logs,
            intents,
            memory_json: next_memory_json,
            memory_changed,
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

fn ref_price_in_snapshot(snap: &WorldSnapshot, catalog: &ProductionCatalog, sid: &str, item: &str) -> Money {
    if let Some(q) = snap.quotes.get(sid).and_then(|m| m.get(item)) {
        if q.last_price > 0 {
            return q.last_price;
        }
    }
    catalog
        .items
        .get(item)
        .map(|it| to_money(it.ref_price.max(0.01)))
        .unwrap_or(10_000)
}

fn primary_land_price_for(snap: &WorldSnapshot, pid: &str) -> Option<Money> {
    snap.planets.get(pid).and_then(|p| p.primary_land_price)
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

    // 2. CPU elapsed helper
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

    // 4. Static Catalog & Market/Map FFI lookups
    {
        let h = Arc::clone(&host);
        globals.set(
            "__meridian_get_catalog",
            Function::new(ctx.clone(), move || -> String {
                let tick = h.tick.lock().unwrap();
                let cat = &tick.catalog;
                let items: BTreeMap<&str, JsCatalogItem<'_>> = cat
                    .items
                    .iter()
                    .map(|(id, it)| {
                        let role = match it.role {
                            meridian_core::ItemRole::Foundation => "foundation",
                            meridian_core::ItemRole::FactoryConsume => "factory_consume",
                            meridian_core::ItemRole::PlanetSupply => "planet_supply",
                            meridian_core::ItemRole::Capital => "capital",
                            meridian_core::ItemRole::Byproduct => "byproduct",
                        };
                        (
                            id.as_str(),
                            JsCatalogItem {
                                id: &it.id,
                                name: &it.name,
                                role,
                                ref_price: it.ref_price,
                            },
                        )
                    })
                    .collect();
                let buildings: BTreeMap<&str, JsCatalogBuilding<'_>> = cat
                    .buildings
                    .iter()
                    .map(|(id, b)| {
                        (
                            id.as_str(),
                            JsCatalogBuilding {
                                id: &b.id,
                                name: &b.name,
                                slots_used: b.slots_used,
                                build_ticks: b.build_ticks,
                                cash_fee_base: 80.0,
                                build_cost: b
                                    .build_cost
                                    .iter()
                                    .map(|c| JsIo { item: &c.item, qty: c.qty })
                                    .collect(),
                                standby_power: b.standby_power,
                            },
                        )
                    })
                    .collect();
                let recipes: BTreeMap<&str, JsCatalogRecipe<'_>> = cat
                    .recipes
                    .iter()
                    .map(|(id, r)| {
                        (
                            id.as_str(),
                            JsCatalogRecipe {
                                id: &r.id,
                                name: &r.name,
                                building_id: &r.building_id,
                                enabled: r.enabled,
                                cycle_ticks: r.cycle_ticks,
                                power_cost: r.power_cost,
                                labor_cost: r.labor_cost,
                                inputs: r
                                    .inputs
                                    .iter()
                                    .map(|io| JsIo { item: &io.item, qty: io.qty })
                                    .collect(),
                                outputs: r
                                    .outputs
                                    .iter()
                                    .map(|io| JsIo { item: &io.item, qty: io.qty })
                                    .collect(),
                            },
                        )
                    })
                    .collect();
                let bundle = JsCatalogBundle {
                    items,
                    buildings,
                    recipes,
                    recipes_by_building: &cat.recipes_by_building,
                };
                serde_json::to_string(&bundle).unwrap_or_else(|_| "{}".to_string())
            })?,
        )?;
    }
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
                        price: from_money(l.ask_price),
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
                    serde_json::to_string(&depth)
                        .unwrap_or_else(|_| "{\"bids\":[],\"asks\":[]}".to_string())
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
                move |sid: String, item: String, side_str: String, offset: i32, limit: i32| -> String {
                    let want_side = match side_str.as_str() {
                        "buy" => Some(OrderSide::Buy),
                        "sell" => Some(OrderSide::Sell),
                        "" => None,
                        _ => return "[]".to_string(),
                    };
                    let skip = offset.max(0) as usize;
                    let take = limit.clamp(1, 1000) as usize;
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
                        .skip(skip)
                        .take(take)
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
            "__meridian_get_order_by_id",
            Function::new(ctx.clone(), move |oid_str: String| -> Option<String> {
                let oid = oid_str.parse::<OrderId>().ok()?;
                let tick = h.tick.lock().unwrap();
                let o = tick.snapshot.orders.iter().find(|o| o.order_id == oid)?;
                serde_json::to_string(&to_js_order(o)).ok()
            })?,
        )?;
    }
    {
        let h = Arc::clone(&host);
        globals.set(
            "__meridian_calc_route",
            Function::new(ctx.clone(), move |from: String, to: String| -> Option<String> {
                let tick = h.tick.lock().unwrap();
                let (ticks, fuel) = tick.snapshot.route_cost(&from, &to)?;
                let is_orbital = tick
                    .snapshot
                    .planets
                    .get(&from)
                    .is_some_and(|p| {
                        let sid = if p.station_id.is_empty() {
                            format!("ST:{}", p.id)
                        } else {
                            p.station_id.clone()
                        };
                        to == sid
                    })
                    || tick.snapshot.planets.get(&to).is_some_and(|p| {
                        let sid = if p.station_id.is_empty() {
                            format!("ST:{}", p.id)
                        } else {
                            p.station_id.clone()
                        };
                        from == sid
                    });
                let kind = if is_orbital {
                    "orbital"
                } else {
                    "interplanetary"
                };
                serde_json::to_string(&JsRouteCost { ticks, fuel, kind }).ok()
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

    // 5. Intent emitters with shadow ledger reservations & full settlement alignment
    {
        let h = Arc::clone(&host);
        globals.set(
            "__meridian_set_recipe",
            Function::new(ctx.clone(), move |bid_str: String, recipe_id: String| -> i32 {
                let Ok(bid) = bid_str.parse::<BuildingId>() else {
                    return ERR_INVALID_ARGS;
                };
                let tick = h.tick.lock().unwrap();
                let mut guard = h.mutable.lock().unwrap();
                let Some(bld) = tick.snapshot.company.buildings.iter().find(|b| b.id == bid) else {
                    return ERR_NOT_OWNER;
                };
                if guard.shadow.demolished_buildings.contains(&bid) {
                    return ERR_NOT_FOUND;
                }
                let Some(rdef) = tick.catalog.recipes.get(&recipe_id) else {
                    return ERR_NOT_FOUND;
                };
                if !rdef.enabled || rdef.building_id != bld.building_type {
                    return ERR_INVALID_TARGET;
                }
                HostState::push_intent_locked(
                    &mut guard,
                    Intent::SetRecipe {
                        building_id: bid,
                        recipe_id,
                    },
                )
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
                let tick = h.tick.lock().unwrap();
                let mut guard = h.mutable.lock().unwrap();
                if !tick.snapshot.company.buildings.iter().any(|b| b.id == bid) {
                    return ERR_NOT_OWNER;
                }
                if guard.shadow.demolished_buildings.contains(&bid) {
                    return ERR_NOT_FOUND;
                }
                HostState::push_intent_locked(
                    &mut guard,
                    Intent::ToggleBuilding {
                        building_id: bid,
                        active,
                    },
                )
            })?,
        )?;
    }
    {
        let h = Arc::clone(&host);
        globals.set(
            "__meridian_dispatch_ship",
            Function::new(
                ctx.clone(),
                move |sid_str: String, to: String, cargo_json: String| -> i32 {
                    let Ok(sid) = sid_str.parse::<ShipId>() else {
                        return ERR_INVALID_ARGS;
                    };
                    let Ok(raw_map) = serde_json::from_str::<HashMap<String, f64>>(&cargo_json) else {
                        return ERR_INVALID_ARGS;
                    };
                    let tick = h.tick.lock().unwrap();
                    let mut guard = h.mutable.lock().unwrap();
                    let Some(ship) = tick.snapshot.company.ships.iter().find(|s| s.id == sid) else {
                        return ERR_NOT_OWNER;
                    };
                    if ship.is_busy || guard.shadow.busy_ships.contains(&sid) {
                        return ERR_BUSY;
                    }
                    let from = ship.location.clone();
                    let Some((_ticks, fuel_needed)) = tick.snapshot.route_cost(&from, &to) else {
                        return ERR_NO_PATH;
                    };

                    let mut clean_map: HashMap<String, u32> = HashMap::new();
                    let mut total_qty = 0u32;
                    for (item, qf) in raw_map {
                        if !tick.catalog.items.contains_key(&item) || !qf.is_finite() || qf <= 0.0 {
                            return ERR_INVALID_ARGS;
                        }
                        let qty = qf.floor() as u32;
                        if qty == 0 {
                            return ERR_INVALID_ARGS;
                        }
                        *clean_map.entry(item).or_insert(0) += qty;
                        total_qty = total_qty.saturating_add(qty);
                    }
                    if total_qty > ship.capacity {
                        return ERR_FULL;
                    }

                    let fuel_item = tick
                        .catalog
                        .fuel_item
                        .clone()
                        .unwrap_or_else(|| "fuel".to_string());
                    let is_st = from.starts_with("ST:");
                    let fuel_avail = if is_st {
                        guard.shadow.available_station_qty(&tick.snapshot, &from, &fuel_item)
                    } else {
                        guard.shadow.available_ground_qty(&tick.snapshot, &from, &fuel_item)
                    };
                    let cargo_fuel = clean_map.get(&fuel_item).copied().unwrap_or(0);
                    if fuel_avail < fuel_needed + cargo_fuel {
                        return ERR_NOT_ENOUGH_RESOURCES;
                    }
                    for (it, &q) in &clean_map {
                        if it == &fuel_item {
                            continue;
                        }
                        let have = if is_st {
                            guard.shadow.available_station_qty(&tick.snapshot, &from, it)
                        } else {
                            guard.shadow.available_ground_qty(&tick.snapshot, &from, it)
                        };
                        if have < q {
                            return ERR_NOT_ENOUGH_RESOURCES;
                        }
                    }

                    let cargo_vec: Vec<(String, u32)> = clean_map.clone().into_iter().collect();
                    let code = HostState::push_intent_locked(
                        &mut guard,
                        Intent::DispatchShip {
                            ship_id: sid,
                            from: from.clone(),
                            to,
                            cargo: cargo_vec,
                        },
                    );
                    if code == OK {
                        guard.shadow.busy_ships.insert(sid);
                        if is_st {
                            guard.shadow.spend_station_qty(&from, &fuel_item, fuel_needed);
                            for (it, q) in clean_map {
                                guard.shadow.spend_station_qty(&from, &it, q);
                            }
                        } else {
                            guard.shadow.spend_ground_qty(&from, &fuel_item, fuel_needed);
                            for (it, q) in clean_map {
                                guard.shadow.spend_ground_qty(&from, &it, q);
                            }
                        }
                    }
                    code
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
                let tick = h.tick.lock().unwrap();
                let mut guard = h.mutable.lock().unwrap();
                let Some(repair_item) = tick.catalog.repair_item.clone() else {
                    return ERR_INVALID_TARGET;
                };
                let Some(ship) = tick.snapshot.company.ships.iter().find(|s| s.id == sid) else {
                    return ERR_NOT_OWNER;
                };
                if ship.is_busy || guard.shadow.busy_ships.contains(&sid) {
                    return ERR_BUSY;
                }
                if ship.durability >= 99.9 || guard.shadow.repaired_ships.contains(&sid) {
                    return ERR_INVALID_TARGET;
                }
                let need = ship.size.repair_cost();
                let loc = ship.location.clone();
                let have = if loc.starts_with("ST:") {
                    guard.shadow.available_station_qty(&tick.snapshot, &loc, &repair_item)
                } else {
                    guard.shadow.available_ground_qty(&tick.snapshot, &loc, &repair_item)
                };
                if have < need {
                    return ERR_NOT_ENOUGH_RESOURCES;
                }
                let code = HostState::push_intent_locked(&mut guard, Intent::RepairShip { ship_id: sid });
                if code == OK {
                    guard.shadow.repaired_ships.insert(sid);
                    if loc.starts_with("ST:") {
                        guard.shadow.spend_station_qty(&loc, &repair_item, need);
                    } else {
                        guard.shadow.spend_ground_qty(&loc, &repair_item, need);
                    }
                }
                code
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
                    if qty == 0 || qty > MAX_ORDER_QTY || !price_f.is_finite() || price_f <= 0.0 {
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
                    let Some(notional) = checked_notional(qty, price) else {
                        return ERR_INVALID_ARGS;
                    };

                    let tick = h.tick.lock().unwrap();
                    let mut guard = h.mutable.lock().unwrap();
                    if !tick.catalog.items.contains_key(&item_id) || !tick.snapshot.quotes.contains_key(&station_id) {
                        return ERR_INVALID_TARGET;
                    }
                    let ref_price = ref_price_in_snapshot(&tick.snapshot, &tick.catalog, &station_id, &item_id);
                    if !price_in_band(price, ref_price) {
                        return ERR_INVALID_ARGS;
                    }
                    let open_cnt = tick
                        .snapshot
                        .company
                        .open_orders
                        .iter()
                        .filter(|o| !guard.shadow.cancelled_orders.contains(&o.order_id))
                        .count()
                        + guard.shadow.open_orders_created;
                    if open_cnt >= MAX_ACTIVE_ORDERS_PER_COMPANY {
                        return ERR_FULL;
                    }
                    // Self-cross guard matching settlement logic
                    let self_cross = tick.snapshot.company.open_orders.iter().any(|o| {
                        !guard.shadow.cancelled_orders.contains(&o.order_id)
                            && o.station_id == station_id
                            && o.item_id == item_id
                            && match side {
                                OrderSide::Buy => o.side == OrderSide::Sell && price >= o.price,
                                OrderSide::Sell => o.side == OrderSide::Buy && price <= o.price,
                            }
                    });
                    if self_cross {
                        return ERR_INVALID_TARGET;
                    }

                    let mut sell_from_station = 0u32;
                    let mut sell_from_ground: Option<(String, u32)> = None;
                    if side == OrderSide::Buy {
                        if guard.shadow.available_cash(&tick.snapshot) < notional {
                            return ERR_NOT_ENOUGH_CREDITS;
                        }
                    } else {
                        let st_have = guard.shadow.available_station_qty(&tick.snapshot, &station_id, &item_id);
                        if st_have >= qty {
                            sell_from_station = qty;
                        } else if tick.catalog.is_instant_item(&item_id) {
                            if let Some(pid) = station_id.strip_prefix("ST:") {
                                let g_have = guard.shadow.available_ground_qty(&tick.snapshot, pid, &item_id);
                                if st_have + g_have < qty {
                                    return ERR_NOT_ENOUGH_RESOURCES;
                                }
                                sell_from_station = st_have;
                                sell_from_ground = Some((pid.to_string(), qty - st_have));
                            } else {
                                return ERR_NOT_ENOUGH_RESOURCES;
                            }
                        } else {
                            return ERR_NOT_ENOUGH_RESOURCES;
                        }
                    }

                    let code = HostState::push_intent_locked(
                        &mut guard,
                        Intent::CreateOrder {
                            station_id: station_id.clone(),
                            side,
                            item_id: item_id.clone(),
                            qty,
                            price,
                        },
                    );
                    if code == OK {
                        guard.shadow.open_orders_created += 1;
                        if side == OrderSide::Buy {
                            guard.shadow.cash_spent = guard.shadow.cash_spent.saturating_add(notional);
                        } else {
                            guard.shadow.spend_station_qty(&station_id, &item_id, sell_from_station);
                            if let Some((pid, g_qty)) = sell_from_ground {
                                guard.shadow.spend_ground_qty(&pid, &item_id, g_qty);
                            }
                        }
                    }
                    code
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
                let tick = h.tick.lock().unwrap();
                let mut guard = h.mutable.lock().unwrap();
                if guard.shadow.cancelled_orders.contains(&oid)
                    || !tick.snapshot.company.open_orders.iter().any(|o| o.order_id == oid)
                {
                    return ERR_NOT_FOUND;
                }
                let code = HostState::push_intent_locked(&mut guard, Intent::CancelOrder { order_id: oid });
                if code == OK {
                    guard.shadow.cancelled_orders.insert(oid);
                }
                code
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
                let tick = h.tick.lock().unwrap();
                let mut guard = h.mutable.lock().unwrap();
                let Some(order) = tick.snapshot.orders.iter().find(|o| o.order_id == oid) else {
                    return ERR_NOT_FOUND;
                };
                if order.owner_id == tick.snapshot.company.id {
                    return ERR_INVALID_TARGET;
                }
                let already_taken = guard.shadow.dealt_taken.get(&oid).copied().unwrap_or(0);
                let rem_qty = order.qty.saturating_sub(already_taken);
                if rem_qty == 0 {
                    return ERR_NOT_FOUND;
                }
                let take = amount.min(rem_qty).min(MAX_ORDER_QTY);
                if take == 0 {
                    return ERR_INVALID_ARGS;
                }
                // Price priority check matching settlement kernel
                let self_id = &tick.snapshot.company.id;
                let has_better = tick.snapshot.orders.iter().any(|o| {
                    o.station_id == order.station_id
                        && o.item_id == order.item_id
                        && o.side == order.side
                        && o.owner_id != *self_id
                        && o.qty > guard.shadow.dealt_taken.get(&o.order_id).copied().unwrap_or(0)
                        && match order.side {
                            OrderSide::Sell => o.price < order.price,
                            OrderSide::Buy => o.price > order.price,
                        }
                });
                if has_better {
                    return ERR_INVALID_TARGET;
                }
                let ref_price =
                    ref_price_in_snapshot(&tick.snapshot, &tick.catalog, &order.station_id, &order.item_id);
                let Some(notional) = checked_notional(take, order.price) else {
                    return ERR_INVALID_ARGS;
                };
                if !price_in_band(order.price, ref_price) {
                    return ERR_INVALID_TARGET;
                }

                let mut sell_from_station = 0u32;
                let mut sell_from_ground: Option<(String, u32)> = None;
                match order.side {
                    OrderSide::Sell => {
                        if guard.shadow.available_cash(&tick.snapshot) < notional {
                            return ERR_NOT_ENOUGH_CREDITS;
                        }
                    }
                    OrderSide::Buy => {
                        let already_notional = checked_notional(already_taken, order.price).unwrap_or(0);
                        if order.escrow_cash.saturating_sub(already_notional) < notional {
                            return ERR_INVALID_TARGET;
                        }
                        let st_have = guard.shadow.available_station_qty(
                            &tick.snapshot,
                            &order.station_id,
                            &order.item_id,
                        );
                        if st_have >= take {
                            sell_from_station = take;
                        } else if tick.catalog.is_instant_item(&order.item_id) {
                            if let Some(pid) = order.station_id.strip_prefix("ST:") {
                                let g_have = guard.shadow.available_ground_qty(
                                    &tick.snapshot,
                                    pid,
                                    &order.item_id,
                                );
                                if st_have + g_have < take {
                                    return ERR_NOT_ENOUGH_RESOURCES;
                                }
                                sell_from_station = st_have;
                                sell_from_ground = Some((pid.to_string(), take - st_have));
                            } else {
                                return ERR_NOT_ENOUGH_RESOURCES;
                            }
                        } else {
                            return ERR_NOT_ENOUGH_RESOURCES;
                        }
                    }
                }

                let code = HostState::push_intent_locked(
                    &mut guard,
                    Intent::DealOrder {
                        order_id: oid,
                        amount,
                    },
                );
                if code == OK {
                    *guard.shadow.dealt_taken.entry(oid).or_insert(0) += take;
                    if order.side == OrderSide::Sell {
                        guard.shadow.cash_spent = guard.shadow.cash_spent.saturating_add(notional);
                    } else {
                        guard.shadow.spend_station_qty(&order.station_id, &order.item_id, sell_from_station);
                        if let Some((pid, g_qty)) = sell_from_ground {
                            guard.shadow.spend_ground_qty(&pid, &order.item_id, g_qty);
                        }
                    }
                }
                code
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
                    let tick = h.tick.lock().unwrap();
                    let mut guard = h.mutable.lock().unwrap();
                    if let Some(due) = tick.snapshot.company.debt_due_tick {
                        if tick.snapshot.company.debt > 0 && tick.snapshot.tick > due {
                            return ERR_NOT_ENOUGH_CREDITS;
                        }
                    }

                    match mode.as_str() {
                        "listing" => {
                            let Ok(lid) = id_str.parse::<ListingId>() else {
                                return ERR_INVALID_ARGS;
                            };
                            if guard.shadow.bought_listings.contains(&lid) {
                                return ERR_NOT_FOUND;
                            }
                            let mut found: Option<(String, Money, &str)> = None;
                            for (planet_id, p_view) in &tick.snapshot.planets {
                                if !pid.is_empty() && planet_id != &pid {
                                    continue;
                                }
                                if let Some(lst) = p_view.land_listings.iter().find(|l| l.listing_id == lid) {
                                    found = Some((planet_id.clone(), lst.ask_price, lst.seller_id.as_str()));
                                    break;
                                }
                            }
                            let Some((target_pid, ask_price, seller_id)) = found else {
                                return ERR_NOT_FOUND;
                            };
                            if seller_id == tick.snapshot.company.id {
                                return ERR_INVALID_TARGET;
                            }
                            if guard.shadow.available_cash(&tick.snapshot) < ask_price {
                                return ERR_NOT_ENOUGH_CREDITS;
                            }
                            let code = HostState::push_intent_locked(
                                &mut guard,
                                Intent::BuyPlot {
                                    planet_id: target_pid,
                                    slot_id: None,
                                    listing_id: Some(lid),
                                },
                            );
                            if code == OK {
                                guard.shadow.bought_listings.insert(lid);
                                guard.shadow.cash_spent = guard.shadow.cash_spent.saturating_add(ask_price);
                            }
                            code
                        }
                        "slot" => {
                            if !tick.snapshot.planets.contains_key(&pid) {
                                return ERR_NOT_FOUND;
                            }
                            let Ok(sid) = id_str.parse::<u32>() else {
                                return ERR_INVALID_ARGS;
                            };
                            if guard.shadow.claimed_slots.contains(&(pid.clone(), sid)) {
                                return ERR_INVALID_TARGET;
                            }
                            let Some(tiles) = tick.snapshot.public_tiles.get(&pid) else {
                                return ERR_NOT_FOUND;
                            };
                            let Some(tile) = tiles.iter().find(|t| t.slot_id == sid) else {
                                return ERR_NOT_FOUND;
                            };
                            if tile.status != "unclaimed" {
                                return ERR_INVALID_TARGET;
                            }
                            let price = primary_land_price_for(&tick.snapshot, &pid).unwrap_or(0);
                            if guard.shadow.available_cash(&tick.snapshot) < price {
                                return ERR_NOT_ENOUGH_CREDITS;
                            }
                            let code = HostState::push_intent_locked(
                                &mut guard,
                                Intent::BuyPlot {
                                    planet_id: pid.clone(),
                                    slot_id: Some(sid),
                                    listing_id: None,
                                },
                            );
                            if code == OK {
                                guard.shadow.claimed_slots.insert((pid, sid));
                                guard.shadow.cash_spent = guard.shadow.cash_spent.saturating_add(price);
                            }
                            code
                        }
                        _ => ERR_INVALID_ARGS,
                    }
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
                let tick = h.tick.lock().unwrap();
                let mut guard = h.mutable.lock().unwrap();
                let Some(plot) = tick.snapshot.company.plots.iter().find(|p| p.id == plot_id) else {
                    return ERR_NOT_OWNER;
                };
                let Some(bdef) = tick.catalog.buildings.get(&btype) else {
                    return ERR_INVALID_TARGET;
                };
                let extra_slots = guard.shadow.plot_extra_slots.get(&plot_id).copied().unwrap_or(0);
                if plot.used_slots + extra_slots + bdef.slots_used > plot.capacity {
                    return ERR_FULL;
                }
                let cash_fee = to_money(80.0 * tick.snapshot.cpi);
                if guard.shadow.available_cash(&tick.snapshot) < cash_fee {
                    return ERR_NOT_ENOUGH_CREDITS;
                }
                let pid = plot.planet_id.clone();
                for req in &bdef.build_cost {
                    if guard.shadow.available_ground_qty(&tick.snapshot, &pid, &req.item) < req.qty {
                        return ERR_NOT_ENOUGH_RESOURCES;
                    }
                }
                let code = HostState::push_intent_locked(
                    &mut guard,
                    Intent::BuildFacility {
                        plot_id,
                        building_type: btype,
                    },
                );
                if code == OK {
                    *guard.shadow.plot_extra_slots.entry(plot_id).or_insert(0) += bdef.slots_used;
                    guard.shadow.cash_spent = guard.shadow.cash_spent.saturating_add(cash_fee);
                    for req in &bdef.build_cost {
                        guard.shadow.spend_ground_qty(&pid, &req.item, req.qty);
                    }
                }
                code
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
                    let tick = h.tick.lock().unwrap();
                    let mut guard = h.mutable.lock().unwrap();
                    if !tick.snapshot.company.plots.iter().any(|p| p.id == plot_id) {
                        return ERR_NOT_OWNER;
                    }
                    if guard.shadow.demolished_buildings.contains(&building_id)
                        || !tick
                            .snapshot
                            .company
                            .buildings
                            .iter()
                            .any(|b| b.id == building_id && b.plot_id == plot_id)
                    {
                        return ERR_NOT_FOUND;
                    }
                    let code = HostState::push_intent_locked(
                        &mut guard,
                        Intent::DemolishFacility {
                            plot_id,
                            building_id,
                        },
                    );
                    if code == OK {
                        guard.shadow.demolished_buildings.insert(building_id);
                    }
                    code
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
                    let tick = h.tick.lock().unwrap();
                    let mut guard = h.mutable.lock().unwrap();
                    if !tick.snapshot.planets.contains_key(&pid) {
                        return ERR_NOT_FOUND;
                    }
                    if tick.snapshot.company.home_planet_id != pid {
                        return ERR_INVALID_TARGET;
                    }
                    match op {
                        BankOpKind::Deposit => {
                            if guard.shadow.available_cash(&tick.snapshot) < amount {
                                return ERR_NOT_ENOUGH_CREDITS;
                            }
                        }
                        BankOpKind::Withdraw => {
                            let avail_savings = tick
                                .snapshot
                                .company
                                .savings
                                .saturating_sub(guard.shadow.bank_savings_spent);
                            if avail_savings < amount {
                                return ERR_NOT_ENOUGH_CREDITS;
                            }
                        }
                        BankOpKind::Borrow => {
                            if let Some(due) = tick.snapshot.company.debt_due_tick {
                                if tick.snapshot.company.debt > 0 && tick.snapshot.tick > due {
                                    return ERR_INVALID_TARGET;
                                }
                            }
                            if tick
                                .snapshot
                                .company
                                .debt
                                .saturating_add(guard.shadow.bank_debt_added)
                                .checked_add(amount)
                                .is_none()
                            {
                                return ERR_INVALID_ARGS;
                            }
                        }
                        BankOpKind::Repay => {
                            let rem_debt = tick
                                .snapshot
                                .company
                                .debt
                                .saturating_sub(guard.shadow.bank_debt_repaid);
                            let repay = amount.min(rem_debt);
                            if repay <= 0 || guard.shadow.available_cash(&tick.snapshot) < repay {
                                return ERR_NOT_ENOUGH_CREDITS;
                            }
                        }
                    }

                    let code = HostState::push_intent_locked(
                        &mut guard,
                        Intent::BankOp {
                            planet_id: pid,
                            op,
                            amount,
                        },
                    );
                    if code == OK {
                        match op {
                            BankOpKind::Deposit => {
                                guard.shadow.cash_spent = guard.shadow.cash_spent.saturating_add(amount);
                            }
                            BankOpKind::Withdraw => {
                                guard.shadow.bank_savings_spent =
                                    guard.shadow.bank_savings_spent.saturating_add(amount);
                            }
                            BankOpKind::Borrow => {
                                guard.shadow.bank_debt_added =
                                    guard.shadow.bank_debt_added.saturating_add(amount);
                            }
                            BankOpKind::Repay => {
                                let rem_debt = tick
                                    .snapshot
                                    .company
                                    .debt
                                    .saturating_sub(guard.shadow.bank_debt_repaid);
                                let repay = amount.min(rem_debt);
                                guard.shadow.bank_debt_repaid =
                                    guard.shadow.bank_debt_repaid.saturating_add(repay);
                                guard.shadow.cash_spent = guard.shadow.cash_spent.saturating_add(repay);
                            }
                        }
                    }
                    code
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
    last_tick: &LastTickFeedback,
) -> String {
    let mut resources: Vec<&str> = catalog.items.keys().map(|s| s.as_str()).collect();
    resources.sort_unstable();

    let mut systems: Vec<BootSystem<'_>> = snap
        .systems
        .values()
        .map(|s| BootSystem {
            id: &s.id,
            name: &s.name,
            star_class: &s.star_class,
            luminosity: s.luminosity,
            x: s.x,
            y: s.y,
            hub_station_id: &s.hub_station_id,
        })
        .collect();
    systems.sort_by(|a, b| a.id.cmp(b.id));

    let mut planets: Vec<BootPlanet<'_>> = snap
        .planets
        .values()
        .map(|p| {
            let sid = if p.station_id.is_empty() {
                format!("ST:{}", p.id)
            } else {
                p.station_id.clone()
            };
            BootPlanet {
                id: &p.id,
                system_id: &p.system_id,
                station_id: sid,
                name: &p.name,
                wealth_tier: p.wealth_tier,
                prosperity: p.prosperity,
                population: p.population,
                gravity: p.gravity,
                habitability: p.habitability,
                waste_backlog: p.waste_backlog,
                primary_land_price: p.primary_land_price.map(from_money),
                bank_rate_pct: p.bank_rate_bps as f64 / 100.0,
                ground_store: &p.ground_store,
                station_store: &p.station_store,
                demands: &p.demands,
            }
        })
        .collect();
    planets.sort_by(|a, b| a.id.cmp(b.id));

    let mut station_ids: Vec<&str> = snap
        .station_systems
        .keys()
        .map(|s| s.as_str())
        .chain(snap.company.station_stores.keys().map(|s| s.as_str()))
        .collect();
    station_ids.sort_unstable();
    station_ids.dedup();

    let stations: Vec<BootStation<'_>> = station_ids
        .into_iter()
        .map(|sid| {
            let (sys_id, pid_opt) = snap
                .station_systems
                .get(sid)
                .map(|(s, p)| (s.as_str(), p.as_deref()))
                .unwrap_or(("S1", None));
            BootStation {
                id: sid,
                system_id: sys_id,
                planet_id: pid_opt,
                store: snap.company.station_stores.get(sid),
            }
        })
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

    let sites: Vec<BootSite<'_>> = snap
        .company
        .sites
        .iter()
        .map(|st| BootSite {
            id: st.id.to_string(),
            plot_id: st.plot_id.to_string(),
            planet_id: &st.planet_id,
            building_type: &st.building_type,
            finish_tick: st.finish_tick,
            ticks_remaining: st.ticks_remaining,
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
        .map(to_js_order)
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
            debt_due_tick: snap.company.debt_due_tick,
        },
        systems,
        planets,
        stations,
        plots,
        buildings,
        sites,
        ships,
        own_orders,
        last_tick,
    };

    serde_json::to_string(&payload).expect("BootPayload serialization should never fail")
}

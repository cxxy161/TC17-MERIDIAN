//! Heterogeneous, memory-driven NPC market & production policy.
//!
//! Architecture:
//! - Slow innate personality (`NpcStyle` inside `NpcGenome`): preserves behavioral diversity
//!   (conservative vs aggressive, discounter vs high-margin, industrialist vs trader).
//! - Fast living memory (`NpcMemory`): tracks weighted-average inventory `cost_basis`, per-station
//!   subjective `PriceBelief` intervals updated from real fills & missed orders, online profit EMA,
//!   order cooldowns, and chronic building loss counters for active industry switching (`DemolishFacility`).
//! - Backward-compatible `decide_npc_intents(snap, catalog, genome)` wrapper remains intact alongside
//!   `decide_npc_intents_with_memory(snap, catalog, genome, memory)`.

use std::collections::{HashMap, HashSet};

use meridian_core::{
    from_money, price_band_max, to_money, BankOpKind, Intent, ItemRole, OrderSide,
    ProductionCatalog, WorldSnapshot, MAX_ACTIVE_ORDERS_PER_COMPANY, MAX_INTENTS_PER_TICK,
    MAX_ORDER_QTY,
};
use serde::{Deserialize, Serialize};

/// Stable innate personality traits distinguishing NPC archetypes across market regimes.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct NpcStyle {
    /// [-1.0, 1.0]: conservative liquidity-holder (-1) vs aggressive leverager/expander (+1).
    pub risk_appetite: f64,
    /// [0.65, 1.75]: scales inventory buffer size before glut production shutoff.
    pub hoard_mult: f64,
    /// [-0.12, 0.20]: fast-turnover discounter (-0.12) vs patient high-margin seller (+0.20).
    pub markup_bias: f64,
    /// [-1.0, 1.0]: production-focused (-1) vs interplanetary arbitrageur (+1).
    pub trade_focus: f64,
    /// [0.12, 0.45]: fraction of liquid wealth kept as cash cushion before expanding.
    pub cash_reserve_ratio: f64,
}

impl Default for NpcStyle {
    fn default() -> Self {
        Self {
            risk_appetite: 0.0,
            hoard_mult: 1.0,
            markup_bias: 0.04,
            trade_focus: 0.0,
            cash_reserve_ratio: 0.22,
        }
    }
}

/// Compact evolvable weights & personality fingerprint for an NPC company.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct NpcGenome {
    /// [margin, input_avail, output_stock_ratio, cash_ratio, bias]
    pub prod_w: [f64; 5],
    /// [active_margin, cash_ratio, bias] -> ToggleBuilding threshold
    pub active_w: [f64; 3],
    /// Buy score weights: [spread, ema_fast_dev, ema_slow_dev, inv_ratio, cash_ratio, bias]
    pub buy_w: [f64; 6],
    /// Sell score weights: [spread, ema_fast_dev, ema_slow_dev, inv_ratio, cash_ratio, bias]
    pub sell_w: [f64; 6],
    /// Price offset weights: [ema_fast_dev, spread, inv_ratio, bias]
    pub price_off_w: [f64; 4],
    /// Logistics route+cargo score: [price_diff, avail_ratio, fuel_ratio, bias]
    pub logi_w: [f64; 4],
    /// Ship repair trigger: [durability_norm, repair_stock_ratio, bias]
    pub repair_w: [f64; 3],
    /// Expansion trigger: [cash_ratio, free_slot_ratio, avg_margin, bias]
    pub expand_w: [f64; 4],
    /// Bank op scoring: [cash_ratio, debt_ratio, rate_norm, bias]
    pub bank_w: [f64; 4],
    /// Persistent innate personality archetype (defaults cleanly for legacy DB genomes).
    #[serde(default)]
    pub style: NpcStyle,
}

impl Default for NpcGenome {
    fn default() -> Self {
        Self::from_seed(42)
    }
}

struct SplitMix64(u64);
impl SplitMix64 {
    fn next_u64(&mut self) -> u64 {
        self.0 = self.0.wrapping_add(0x9e3779b97f4a7c15);
        let mut z = self.0;
        z = (z ^ (z >> 30)).wrapping_mul(0xbf58476d1ce4e5b9);
        z = (z ^ (z >> 27)).wrapping_mul(0x94d049bb133111eb);
        z ^ (z >> 31)
    }
    fn next_unit(&mut self) -> f64 {
        (self.next_u64() >> 11) as f64 / ((1u64 << 53) as f64)
    }
    fn next_signed(&mut self, scale: f64) -> f64 {
        (self.next_unit() * 2.0 - 1.0) * scale
    }
}

impl NpcGenome {
    pub fn from_seed(seed: u64) -> Self {
        let mut rng = SplitMix64(seed ^ 0xA5A5_5A5A_1234_5678);
        let risk_appetite = rng.next_signed(0.95);
        let hoard_mult = (0.70 + rng.next_unit() * 1.0).clamp(0.65, 1.75);
        let markup_bias = (-0.10 + rng.next_unit() * 0.28).clamp(-0.12, 0.20);
        let trade_focus = rng.next_signed(0.95);
        let cash_reserve_ratio = (0.28 - risk_appetite * 0.12).clamp(0.12, 0.45);
        let mut j = |s: f64| rng.next_signed(s);
        Self {
            prod_w: [
                1.20 + j(0.35),
                0.65 + j(0.30),
                -0.45 + j(0.25),
                0.10 + j(0.20),
                0.15 + j(0.15),
            ],
            active_w: [1.10 + j(0.35), 0.15 + j(0.20), 0.35 + j(0.15)],
            buy_w: [
                0.15 + j(0.25),
                -0.30 + j(0.25),
                -0.25 + j(0.25),
                -0.85 + j(0.30),
                0.45 + j(0.25),
                0.15 + j(0.20),
            ],
            sell_w: [
                0.10 + j(0.25),
                0.25 + j(0.25),
                0.20 + j(0.25),
                0.95 + j(0.30),
                -0.30 + j(0.25),
                0.35 + j(0.20),
            ],
            price_off_w: [0.20 + j(0.25), 0.10 + j(0.20), -0.40 + j(0.25), j(0.12)],
            logi_w: [
                0.95 + j(0.35),
                0.65 + j(0.30),
                -0.35 + j(0.25),
                0.30 + j(0.20),
            ],
            repair_w: [0.85 + j(0.25), 0.40 + j(0.25), 0.10 + j(0.15)],
            expand_w: [
                0.50 + j(0.30),
                0.40 + j(0.25),
                0.85 + j(0.30),
                0.15 + j(0.20),
            ],
            bank_w: [
                0.30 + j(0.25),
                0.60 + j(0.25),
                -0.40 + j(0.25),
                j(0.15),
            ],
            style: NpcStyle {
                risk_appetite,
                hoard_mult,
                markup_bias,
                trade_focus,
                cash_reserve_ratio,
            },
        }
    }

    pub fn crossover_mutate(a: &Self, b: &Self, seed: u64, sigma: f64) -> Self {
        let mut rng = SplitMix64(seed ^ 0xDEAD_BEEF_CAFE_0001);
        let mut mix = |va: f64, vb: f64| -> f64 {
            let pick = if rng.next_u64() & 1 == 0 { va } else { vb };
            (pick + rng.next_signed(sigma)).clamp(-4.0, 4.0)
        };
        let mut mix_arr = |aa: &[f64], bb: &[f64], out: &mut [f64]| {
            for i in 0..out.len() {
                out[i] = mix(aa[i], bb[i]);
            }
        };
        let mut child = a.clone();
        mix_arr(&a.prod_w, &b.prod_w, &mut child.prod_w);
        mix_arr(&a.active_w, &b.active_w, &mut child.active_w);
        mix_arr(&a.buy_w, &b.buy_w, &mut child.buy_w);
        mix_arr(&a.sell_w, &b.sell_w, &mut child.sell_w);
        mix_arr(&a.price_off_w, &b.price_off_w, &mut child.price_off_w);
        mix_arr(&a.logi_w, &b.logi_w, &mut child.logi_w);
        mix_arr(&a.repair_w, &b.repair_w, &mut child.repair_w);
        mix_arr(&a.expand_w, &b.expand_w, &mut child.expand_w);
        mix_arr(&a.bank_w, &b.bank_w, &mut child.bank_w);
        child.style = NpcStyle {
            risk_appetite: mix(a.style.risk_appetite, b.style.risk_appetite).clamp(-1.0, 1.0),
            hoard_mult: mix(a.style.hoard_mult, b.style.hoard_mult).clamp(0.65, 1.75),
            markup_bias: mix(a.style.markup_bias, b.style.markup_bias).clamp(-0.12, 0.20),
            trade_focus: mix(a.style.trade_focus, b.style.trade_focus).clamp(-1.0, 1.0),
            cash_reserve_ratio: mix(a.style.cash_reserve_ratio, b.style.cash_reserve_ratio)
                .clamp(0.12, 0.45),
        };
        child
    }

    /// Quantized personality quadrant key used for diverse niche preservation in evolution.
    pub fn niche_bucket(&self) -> (u8, u8) {
        let risk_bin = if self.style.risk_appetite < -0.25 {
            0
        } else if self.style.risk_appetite > 0.25 {
            2
        } else {
            1
        };
        let trade_bin = if self.style.trade_focus < -0.25 {
            0
        } else if self.style.trade_focus > 0.25 {
            2
        } else {
            1
        };
        (risk_bin, trade_bin)
    }
}

/// Subjective price belief interval + adaptive trading margin per `(station, item)`.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PriceBelief {
    pub low: f64,
    pub high: f64,
    pub confidence: f64,
    pub ask_margin: f64,
    pub bid_margin: f64,
    pub last_update_tick: u64,
}

impl PriceBelief {
    pub fn new(anchor: f64, tick: u64) -> Self {
        let a = anchor.max(0.05);
        Self {
            low: a * 0.78,
            high: a * 1.25,
            confidence: 0.25,
            ask_margin: 0.10,
            bid_margin: 0.02,
            last_update_tick: tick,
        }
    }

    pub fn mid(&self) -> f64 {
        ((self.low + self.high) * 0.5).max(0.02)
    }
}

/// Private per-NPC persistent memory updated from real trade fills, production costs, and net cash flow.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct NpcMemory {
    /// Weighted-average unit cost basis per item (credits).
    pub cost_basis: HashMap<String, f64>,
    /// Subjective price beliefs keyed by `"{station_id}|{item_id}"`.
    pub beliefs: HashMap<String, PriceBelief>,
    /// Last tick an order for `"{station_id}|{item_id}"` was cancelled/replaced (anti-thrash cooldown).
    pub order_cooldown_tick: HashMap<String, u64>,
    /// Consecutive ticks each building stayed unprofitable or glutted (`building_id -> ticks`).
    pub building_loss_ticks: HashMap<u64, u32>,
    /// Online adaptation telemetry.
    pub prev_net_liquid: f64,
    pub has_prev_net_liquid: bool,
    pub last_adapt_tick: u64,
    pub profit_ema: f64,
    pub online_margin_adj: f64,
    pub online_risk_adj: f64,
}

fn belief_key(station_id: &str, item_id: &str) -> String {
    format!("{station_id}|{item_id}")
}

impl NpcMemory {
    pub fn record_fill(
        &mut self,
        tick: u64,
        station_id: &str,
        item_id: &str,
        is_buy: bool,
        qty: u32,
        unit_price: f64,
        inv_before: u32,
    ) {
        if qty == 0 || !unit_price.is_finite() || unit_price <= 0.0 {
            return;
        }
        if is_buy {
            let prev_cost = self.cost_basis.get(item_id).copied().unwrap_or(unit_price);
            let prev_w = (inv_before as f64).min(200.0).max(0.0);
            let add_w = qty as f64;
            let blended = (prev_cost * prev_w + unit_price * add_w) / (prev_w + add_w).max(1.0);
            self.cost_basis.insert(item_id.to_string(), blended.max(0.01));
        }

        let key = belief_key(station_id, item_id);
        let b = self
            .beliefs
            .entry(key)
            .or_insert_with(|| PriceBelief::new(unit_price, tick));
        let mid = b.mid();
        let new_mid = mid * 0.65 + unit_price * 0.35;
        b.confidence = (b.confidence + 0.14).clamp(0.05, 1.0);
        let half_width = (new_mid * (0.35 * (1.0 - b.confidence * 0.75))).max(new_mid * 0.05);
        b.low = (new_mid - half_width).max(0.01);
        b.high = (new_mid + half_width).max(b.low * 1.04);
        if is_buy {
            // Trade succeeded as buyer -> probe slightly tighter bid next time
            b.bid_margin = (b.bid_margin - 0.015).clamp(-0.28, 0.30);
        } else {
            // Trade succeeded as seller -> probe slightly firmer margin next time
            b.ask_margin = (b.ask_margin + 0.020).clamp(-0.35, 0.65);
        }
        b.last_update_tick = tick;
    }

    pub fn update_production_cost(&mut self, item_id: &str, unit_cost: f64) {
        if !unit_cost.is_finite() || unit_cost <= 0.0 {
            return;
        }
        let next = match self.cost_basis.get(item_id) {
            Some(&prev) => prev * 0.70 + unit_cost * 0.30,
            None => unit_cost,
        };
        self.cost_basis.insert(item_id.to_string(), next.max(0.01));
    }

    pub fn on_order_missed(
        &mut self,
        tick: u64,
        station_id: &str,
        item_id: &str,
        is_buy: bool,
        mkt_anchor: f64,
        desperation: f64,
    ) {
        let key = belief_key(station_id, item_id);
        let b = self
            .beliefs
            .entry(key)
            .or_insert_with(|| PriceBelief::new(mkt_anchor, tick));
        b.confidence = (b.confidence * 0.84).max(0.05);
        let center = (b.mid() * 0.65 + mkt_anchor.max(0.02) * 0.35).max(0.02);
        let half = (center * (0.38 * (1.0 - b.confidence * 0.55))).max(center * 0.08);
        b.low = (center - half).max(0.01);
        b.high = (center + half).max(b.low * 1.06);
        if is_buy {
            b.bid_margin = (b.bid_margin + 0.030).clamp(-0.28, 0.30);
        } else {
            b.ask_margin = (b.ask_margin - (0.045 + 0.06 * desperation)).clamp(-0.35, 0.65);
        }
        b.last_update_tick = tick;
    }

    pub fn observe_financials(&mut self, tick: u64, net_liquid: f64, cpi: f64) {
        if !self.has_prev_net_liquid {
            self.prev_net_liquid = net_liquid;
            self.has_prev_net_liquid = true;
            self.last_adapt_tick = tick;
            return;
        }
        if tick.saturating_sub(self.last_adapt_tick) < 24 {
            return;
        }
        let delta = net_liquid - self.prev_net_liquid;
        self.prev_net_liquid = net_liquid;
        self.last_adapt_tick = tick;
        self.profit_ema = self.profit_ema * 0.78 + delta * 0.22;

        let c = cpi.max(0.25);
        if self.profit_ema < -20.0 * c {
            // Losing cash -> trim profit target slightly to clear stock & tighten expansion risk
            self.online_margin_adj = (self.online_margin_adj - 0.018).clamp(-0.18, 0.12);
            self.online_risk_adj = (self.online_risk_adj - 0.06).clamp(-0.45, 0.25);
        } else if self.profit_ema > 30.0 * c {
            self.online_margin_adj = (self.online_margin_adj + 0.010).clamp(-0.18, 0.12);
            self.online_risk_adj = (self.online_risk_adj + 0.03).clamp(-0.45, 0.25);
        } else {
            self.online_margin_adj *= 0.96;
            self.online_risk_adj *= 0.96;
        }
    }
}

#[inline]
fn dot(w: &[f64], x: &[f64]) -> f64 {
    w.iter().zip(x.iter()).map(|(wi, xi)| wi * xi).sum()
}

/// Stateless backward-compatible entry point (wraps `decide_npc_intents_with_memory`).
pub fn decide_npc_intents(
    snap: &WorldSnapshot,
    catalog: &ProductionCatalog,
    genome: &NpcGenome,
) -> Vec<Intent> {
    let mut scratch = NpcMemory::default();
    decide_npc_intents_with_memory(snap, catalog, genome, &mut scratch)
}

/// Produce up to `MAX_INTENTS_PER_TICK` Intents for an NPC from `WorldSnapshot` + `NpcGenome` + `NpcMemory`.
pub fn decide_npc_intents_with_memory(
    snap: &WorldSnapshot,
    catalog: &ProductionCatalog,
    genome: &NpcGenome,
    mem: &mut NpcMemory,
) -> Vec<Intent> {
    const ORDER_COOLDOWN_TICKS: u64 = 36;
    const MISSED_REVIEW_AGE: u64 = 48;

    let mut intents = Vec::new();
    let cpi = snap.cpi.max(0.25);
    let home_pid = &snap.company.home_planet_id;
    let home_sid = format!("ST:{home_pid}");
    let home_hub = snap.home_hub_id().to_string();
    let cash_f = from_money(snap.company.cash).max(0.0);
    let savings_f = from_money(snap.company.savings).max(0.0);
    let debt_f = from_money(snap.company.debt).max(0.0);
    let net_liquid_f = cash_f + savings_f - debt_f;
    mem.observe_financials(snap.tick, net_liquid_f, cpi);

    // Prune loss counters for demolished buildings
    let live_bids: HashSet<u64> = snap.company.buildings.iter().map(|b| b.id).collect();
    mem.building_loss_ticks.retain(|bid, _| live_bids.contains(bid));

    let eff_risk = (genome.style.risk_appetite + mem.online_risk_adj).clamp(-1.0, 1.0);
    let eff_hoard = genome.style.hoard_mult.clamp(0.65, 1.75);
    let eff_markup = (genome.style.markup_bias + mem.online_margin_adj).clamp(-0.20, 0.25);
    let safety_cash_floor = ((180.0 + snap.company.buildings.len() as f64 * 45.0) * cpi)
        .max(net_liquid_f.max(0.0) * genome.style.cash_reserve_ratio);
    let cash_desperation = if cash_f < safety_cash_floor * 0.55 {
        1.0 - (cash_f / (safety_cash_floor * 0.55).max(1.0)).clamp(0.0, 1.0)
    } else {
        0.0
    };

    let scale_cash = (cash_f / (1000.0 * cpi)).clamp(0.0, 2.0);
    let debt_ratio = (debt_f / (cash_f + savings_f + 500.0 * cpi)).clamp(0.0, 4.0);

    let ref_item_price = |item_id: &str| -> f64 {
        catalog
            .items
            .get(item_id)
            .map(|i| i.ref_price * cpi)
            .unwrap_or(1.0)
            .max(0.05)
    };

    let est_input_cost = |station: &str, item_id: &str| -> f64 {
        if let Some(q) = snap.quotes.get(station).and_then(|m| m.get(item_id)) {
            if let Some(ask) = q.best_ask {
                return from_money(ask).max(0.01);
            }
            return from_money(q.last_price).max(0.01);
        }
        ref_item_price(item_id)
    };

    // System habitable/planet stations for cross-planet sales discovery
    let home_sys = snap
        .planets
        .get(home_pid)
        .map(|p| p.system_id.clone())
        .unwrap_or_else(|| "S1".to_string());
    let mut system_planet_stations: Vec<String> = snap
        .planets
        .values()
        .filter(|p| p.system_id == home_sys)
        .map(|p| p.station_id.clone())
        .collect();
    system_planet_stations.sort();

    // Estimate realistic realizable sale price at `station` OR directly reachable planet stations
    let est_output_value = |station: &str, item_id: &str| -> f64 {
        let q_opt = snap.quotes.get(station).and_then(|m| m.get(item_id));
        let ref_p = ref_item_price(item_id);
        let last_p = q_opt
            .map(|q| from_money(q.last_price))
            .unwrap_or(ref_p)
            .max(0.01);
        let mut val = last_p.min(ref_p * 6.0);
        if let Some(q) = q_opt {
            if let Some(bb) = q.best_bid {
                let bb_f = from_money(bb);
                val = val.max(bb_f.min(ref_p * 8.0).min(last_p * 2.5));
            }
        }
        if !catalog.is_instant_item(item_id) {
            for p_sid in &system_planet_stations {
                if p_sid == station {
                    continue;
                }
                if let Some(pq) = snap.quotes.get(p_sid).and_then(|m| m.get(item_id)) {
                    if let Some(pbb) = pq.best_bid {
                        let pbb_f = from_money(pbb);
                        let p_last = from_money(pq.last_price).max(ref_p);
                        val = val.max(pbb_f.min(ref_p * 8.0).min(p_last * 2.5) * 0.85);
                    }
                }
            }
            if let Some(hq) = snap.quotes.get(home_hub.as_str()).and_then(|m| m.get(item_id)) {
                if let Some(hbb) = hq.best_bid {
                    let h_last = from_money(hq.last_price).max(ref_p);
                    val = val.max(from_money(hbb).min(ref_p * 8.0).min(h_last * 2.5) * 0.88);
                }
            }
        }
        val.max(0.01)
    };

    let fuel_item = catalog.fuel_item.as_deref();
    let repair_item = catalog.repair_item.as_deref();

    let company_fuel: u32 = fuel_item
        .map(|fit| {
            let g: u32 = snap
                .planets
                .values()
                .filter_map(|p| p.ground_store.get(fit))
                .sum();
            let s: u32 = snap
                .company
                .station_stores
                .values()
                .filter_map(|m| m.get(fit))
                .sum();
            g + s
        })
        .unwrap_or(24);

    // Sum total company inventory of an item across ground & all stations
    let company_total_stock = |item_id: &str| -> u32 {
        let g: u32 = snap
            .planets
            .values()
            .filter_map(|p| p.ground_store.get(item_id))
            .sum();
        let s: u32 = snap
            .company
            .station_stores
            .values()
            .filter_map(|m| m.get(item_id))
            .sum();
        g + s
    };

    // Detect if ANY reachable market has an active Bid for `item_id`
    let has_active_market_bid = |station: &str, item_id: &str| -> bool {
        if snap
            .quotes
            .get(station)
            .and_then(|m| m.get(item_id))
            .and_then(|q| q.best_bid)
            .is_some()
        {
            return true;
        }
        if !catalog.is_instant_item(item_id) {
            if system_planet_stations.iter().any(|ps| {
                snap.quotes
                    .get(ps)
                    .and_then(|m| m.get(item_id))
                    .and_then(|q| q.best_bid)
                    .is_some()
            }) {
                return true;
            }
            if snap
                .quotes
                .get(home_hub.as_str())
                .and_then(|m| m.get(item_id))
                .and_then(|q| q.best_bid)
                .is_some()
            {
                return true;
            }
        }
        false
    };

    // 1. Production Head + Glut Circuit Breaker + Active Industry Switching (DemolishFacility)
    let mut avg_margin_sum = 0.0;
    let mut avg_margin_cnt = 0usize;
    let mut needed_items: HashMap<String, u32> = HashMap::new();
    let mut est_ground_consumed: HashMap<(String, String), u32> = HashMap::new();
    let mut est_wages_this_tick = 0.0f64;
    let mut produced_items: HashSet<String> = HashSet::new();
    let mut item_max_willing_pay: HashMap<String, f64> = HashMap::new();
    let mut demolish_candidate: Option<(u64, u64)> = None; // (plot_id, building_id)

    let active_site_plots: HashSet<u64> = snap.company.sites.iter().map(|s| s.plot_id).collect();
    let mut building_counts_by_type: HashMap<&str, usize> = HashMap::new();
    for b in &snap.company.buildings {
        *building_counts_by_type.entry(b.building_type.as_str()).or_insert(0) += 1;
    }

    for bld in &snap.company.buildings {
        let Some(valid_recipes) = catalog.recipes_by_building.get(&bld.building_type) else {
            continue;
        };
        let b_sid = format!("ST:{}", bld.planet_id);
        let p_ground = snap.planets.get(&bld.planet_id).map(|p| &p.ground_store);
        let p_st = snap.company.station_stores.get(&b_sid);
        let hub_st = snap.company.station_stores.get(home_hub.as_str());

        let mut best_rid: Option<&str> = None;
        let mut best_score = f64::NEG_INFINITY;
        let mut best_margin = 0.0;
        let mut best_all_glutted = false;
        let mut best_unit_costs: Vec<(String, f64)> = Vec::new();

        for rid in valid_recipes {
            let Some(r) = catalog.recipes.get(rid) else {
                continue;
            };
            if !r.enabled {
                continue;
            }
            let mut in_cost = r.labor_cost * cpi;
            if r.power_cost > 0 {
                in_cost += r.power_cost as f64 * est_input_cost(&b_sid, "power");
            }
            let mut min_cov = 1.0f64;
            let mut missing_inputs = 0usize;
            for inp in &r.inputs {
                let unit_in = mem
                    .cost_basis
                    .get(&inp.item)
                    .copied()
                    .filter(|&c| c > 0.0)
                    .unwrap_or_else(|| est_input_cost(&b_sid, &inp.item));
                in_cost += inp.qty as f64 * unit_in;
                if inp.item == "waste" {
                    let own_w = p_ground.and_then(|g| g.get("waste")).copied().unwrap_or(0);
                    let city_w = snap
                        .planets
                        .get(&bld.planet_id)
                        .map(|p| p.waste_backlog)
                        .unwrap_or(0);
                    if own_w + city_w < inp.qty {
                        missing_inputs += 1;
                        min_cov = 0.0;
                    } else {
                        min_cov = min_cov.min(
                            ((own_w + city_w) as f64 / (inp.qty.max(1) as f64 * 2.0)).clamp(0.2, 1.0),
                        );
                    }
                    continue;
                }
                let is_inp_instant = catalog.is_instant_item(&inp.item);
                let have_g = p_ground.and_then(|g| g.get(&inp.item)).copied().unwrap_or(0);
                let have_s = if is_inp_instant {
                    0
                } else {
                    p_st.and_then(|s| s.get(&inp.item)).copied().unwrap_or(0)
                        + hub_st.and_then(|s| s.get(&inp.item)).copied().unwrap_or(0)
                };
                let local_ask = snap
                    .quotes
                    .get(&b_sid)
                    .and_then(|m| m.get(&inp.item))
                    .and_then(|q| q.best_ask)
                    .is_some();
                let hub_ask = !is_inp_instant
                    && snap
                        .quotes
                        .get(home_hub.as_str())
                        .and_then(|m| m.get(&inp.item))
                        .and_then(|q| q.best_ask)
                        .is_some();
                let market_ok = local_ask || hub_ask;
                let have_tot = have_g + have_s;
                let cov = if market_ok {
                    (have_tot as f64 / inp.qty.max(1) as f64).max(0.6)
                } else {
                    if have_tot < inp.qty {
                        missing_inputs += 1;
                    }
                    have_tot as f64 / inp.qty.max(1) as f64
                };
                min_cov = min_cov.min(cov.clamp(0.0, 2.0));
            }
            if r.power_cost > 0 {
                let pwr_have = p_ground.and_then(|g| g.get("power")).copied().unwrap_or(0);
                let pwr_ask = snap
                    .quotes
                    .get(&b_sid)
                    .and_then(|m| m.get("power"))
                    .and_then(|q| q.best_ask)
                    .is_some();
                let pwr_cov = if pwr_ask {
                    (pwr_have as f64 / r.power_cost.max(1) as f64).max(0.6)
                } else {
                    if pwr_have < r.power_cost {
                        missing_inputs += 1;
                    }
                    pwr_have as f64 / r.power_cost.max(1) as f64
                };
                min_cov = min_cov.min(pwr_cov.clamp(0.0, 2.0));
            }

            let mut out_val = 0.0;
            let mut out_stock_ratio = 0.0;
            let mut all_outputs_glutted = !r.outputs.is_empty();
            let mut total_out_units = 0.0;

            for out in &r.outputs {
                let mut p = est_output_value(&b_sid, &out.item);
                let tot_have = company_total_stock(&out.item);
                let local_have = p_ground.and_then(|g| g.get(&out.item)).copied().unwrap_or(0)
                    + p_st.and_then(|s| s.get(&out.item)).copied().unwrap_or(0);
                let sat_thresh = (out.qty.max(1) as f64) * 32.0 * eff_hoard;
                let hard_glut_cap = sat_thresh * 1.45;
                let has_bid = has_active_market_bid(&b_sid, &out.item);
                let is_fuel_low =
                    Some(out.item.as_str()) == fuel_item && company_fuel < 24;

                if !(is_fuel_low || (has_bid && (local_have as f64) < hard_glut_cap))
                    && (tot_have as f64) >= hard_glut_cap
                {
                    // Glutted output without buyers keeps accumulating waste/cost -> turn off!
                } else {
                    all_outputs_glutted = false;
                }

                if Some(out.item.as_str()) == fuel_item {
                    if company_fuel < 16 {
                        p *= 3.5 + (16 - company_fuel) as f64 * 0.20;
                    } else if company_fuel < 28 {
                        p *= 1.0 + (28 - company_fuel) as f64 * 0.06;
                    }
                } else if !catalog.is_instant_item(&out.item)
                    && company_fuel < 8
                    && local_have >= out.qty.max(1) * 8
                {
                    p *= 0.15;
                } else if (tot_have as f64) > sat_thresh {
                    let excess_ratio = sat_thresh / (tot_have as f64);
                    p *= excess_ratio.clamp(0.05, 1.0);
                }

                let qty_eff = out.qty as f64 * bld.efficiency;
                out_val += qty_eff * p;
                total_out_units += qty_eff;
                let stock_contrib = if is_fuel_low {
                    0.0
                } else {
                    (tot_have as f64 / sat_thresh).clamp(0.0, 5.0)
                };
                out_stock_ratio += stock_contrib;
            }

            let margin = ((out_val - in_cost) / in_cost.max(1.0)).clamp(-1.0, 3.0);
            let out_stock = out_stock_ratio / r.outputs.len().max(1) as f64;
            let mut score = dot(&genome.prod_w, &[margin, min_cov, out_stock, scale_cash, 1.0]);
            if missing_inputs > 0 {
                score -= 4.0 * (missing_inputs as f64);
            }
            if all_outputs_glutted {
                score -= 6.0;
            }
            if score > best_score {
                best_score = score;
                best_rid = Some(rid.as_str());
                best_margin = margin;
                best_all_glutted = all_outputs_glutted;
                best_unit_costs.clear();
                let unit_cost = in_cost / total_out_units.max(1.0);
                for out in &r.outputs {
                    if out.item != "waste" {
                        best_unit_costs.push((out.item.clone(), unit_cost));
                    }
                }
            }
        }

        avg_margin_sum += best_margin;
        avg_margin_cnt += 1;

        let chosen_rid = best_rid.unwrap_or(bld.recipe_id.as_str());
        let act_score = dot(&genome.active_w, &[best_margin, scale_cash, 1.0]);
        let want_active = !best_all_glutted && act_score > 0.0 && best_margin > -0.10;

        // Track chronic unprofitability / glut for active industry switching
        let loss_count = {
            let loss_counter = mem.building_loss_ticks.entry(bld.id).or_insert(0);
            if best_all_glutted || best_margin < -0.05 {
                *loss_counter = loss_counter.saturating_add(1);
            } else if want_active && best_margin > 0.02 {
                *loss_counter = loss_counter.saturating_sub(2);
            }
            *loss_counter
        };

        if want_active {
            for (it, uc) in &best_unit_costs {
                mem.update_production_cost(it, *uc);
            }
        }

        // Consider demolishing chronically unprofitable/glutted facility to switch industries
        if demolish_candidate.is_none()
            && loss_count >= 96
            && !active_site_plots.contains(&bld.plot_id)
            && snap.company.buildings.len() >= 2
            && cash_f > 90.0 * cpi
        {
            let keep_critical = (bld.building_type == "power_water_station"
                && building_counts_by_type.get("power_water_station").copied().unwrap_or(0) <= 1)
                || (company_fuel < 12 && bld.building_type == "power_water_station");
            if !keep_critical {
                if let Some(plot_v) = snap.company.plots.iter().find(|p| p.id == bld.plot_id) {
                    let salvage_mats = catalog
                        .buildings
                        .get(&bld.building_type)
                        .map(|bd| {
                            bd.build_cost
                                .iter()
                                .map(|q| (q.item.clone(), q.qty / 2))
                                .collect::<HashMap<_, _>>()
                        })
                        .unwrap_or_default();
                    let empty_reserved = HashMap::new();
                    let freed_slots = catalog
                        .buildings
                        .get(&bld.building_type)
                        .map(|bd| bd.slots_used)
                        .unwrap_or(1);
                    let best_alt = best_buildable_facility(
                        snap,
                        catalog,
                        plot_v,
                        freed_slots,
                        &salvage_mats,
                        &empty_reserved,
                        &est_input_cost,
                        &est_output_value,
                        &company_total_stock,
                        eff_hoard,
                    );
                    if let Some((_, alt_margin)) = best_alt {
                        if alt_margin >= 0.22 && alt_margin > best_margin + 0.25 {
                            demolish_candidate = Some((bld.plot_id, bld.id));
                        }
                    }
                }
            }
        }

        if chosen_rid != bld.recipe_id && intents.len() < MAX_INTENTS_PER_TICK {
            intents.push(Intent::SetRecipe {
                building_id: bld.id,
                recipe_id: chosen_rid.to_string(),
            });
        }
        if want_active != bld.active && intents.len() < MAX_INTENTS_PER_TICK {
            intents.push(Intent::ToggleBuilding {
                building_id: bld.id,
                active: want_active,
            });
        }

        // Step 0c (`step_buildings_and_jobs`) runs BEFORE `SetRecipe`/`ToggleBuilding`, so reserve
        // ground materials & wages consumed by the CURRENT active recipe (or standby power).
        if bld.active && (bld.progress == 0 || bld.progress + 1 >= bld.cycle_ticks.max(1)) {
            if let Some(cur_rec) = catalog.recipes.get(&bld.recipe_id) {
                est_wages_this_tick += cur_rec.labor_cost * cpi;
                if cur_rec.power_cost > 0 {
                    *est_ground_consumed
                        .entry((bld.planet_id.clone(), "power".to_string()))
                        .or_insert(0) += cur_rec.power_cost;
                }
                for inp in &cur_rec.inputs {
                    if inp.item != "waste" {
                        *est_ground_consumed
                            .entry((bld.planet_id.clone(), inp.item.clone()))
                            .or_insert(0) += inp.qty;
                    }
                }
            }
        }
        if !bld.active || bld.progress == 0 {
            if let Some(bdef) = catalog.buildings.get(&bld.building_type) {
                if bdef.standby_power > 0 {
                    *est_ground_consumed
                        .entry((bld.planet_id.clone(), "power".to_string()))
                        .or_insert(0) += bdef.standby_power;
                }
            }
        }

        if want_active {
            if let Some(rec) = catalog.recipes.get(chosen_rid) {
                let mut rec_out_val = 0.0;
                for out in &rec.outputs {
                    produced_items.insert(out.item.clone());
                    rec_out_val += out.qty as f64 * bld.efficiency * est_output_value(&b_sid, &out.item);
                }
                if rec.power_cost > 0 {
                    *needed_items.entry("power".to_string()).or_insert(0) += rec.power_cost * 3;
                    let pwr_cap = (rec_out_val / rec.power_cost.max(1) as f64) * 0.65;
                    let e = item_max_willing_pay.entry("power".to_string()).or_insert(0.0);
                    *e = e.max(pwr_cap);
                }
                for inp in &rec.inputs {
                    if inp.item != "waste" {
                        *needed_items.entry(inp.item.clone()).or_insert(0) += inp.qty * 3;
                        let in_cap = ((rec_out_val - rec.labor_cost * cpi).max(0.1)
                            / inp.qty.max(1) as f64)
                            * 0.85;
                        let e = item_max_willing_pay.entry(inp.item.clone()).or_insert(0.0);
                        *e = e.max(in_cap);
                    }
                }
            }
        }
    }

    let demolish_plot_id = demolish_candidate.map(|(pid, _)| pid);
    if let Some((plot_id, building_id)) = demolish_candidate {
        if intents.len() < MAX_INTENTS_PER_TICK {
            intents.push(Intent::DemolishFacility { plot_id, building_id });
            mem.building_loss_ticks.remove(&building_id);
        }
    }

    // Reserve building_mat demand when company has free capacity and healthy cash to build
    let has_free_plot_slots = snap
        .company
        .plots
        .iter()
        .any(|p| p.used_slots < p.capacity);
    if has_free_plot_slots
        && snap.company.sites.is_empty()
        && cash_f > safety_cash_floor * 1.1
        && catalog.items.contains_key("building_mat")
    {
        let home_g_bmat = snap
            .planets
            .get(home_pid)
            .and_then(|p| p.ground_store.get("building_mat"))
            .copied()
            .unwrap_or(0);
        if home_g_bmat < 10 {
            let e = needed_items.entry("building_mat".to_string()).or_insert(0);
            *e = (*e).max(10);
        }
    }

    if let Some(fit) = fuel_item {
        *needed_items.entry(fit.to_string()).or_insert(0) += 20;
    }

    // Track ships needing urgent repair parts at their current station
    let mut urgent_repair_at_station: HashMap<String, u32> = HashMap::new();
    if let Some(rit) = repair_item {
        let mut total_rep_need = 0u32;
        for ship in &snap.company.ships {
            if ship.durability < 80.0 {
                let need = ship.size.repair_cost();
                total_rep_need += need;
                if ship.location.starts_with("ST:") {
                    let st_rep = snap
                        .company
                        .station_stores
                        .get(&ship.location)
                        .and_then(|m| m.get(rit))
                        .copied()
                        .unwrap_or(0);
                    if st_rep < need {
                        let e = urgent_repair_at_station
                            .entry(ship.location.clone())
                            .or_insert(0);
                        *e = (*e).max(need - st_rep);
                    }
                }
            }
        }
        if total_rep_need > 0 {
            *needed_items.entry(rit.to_string()).or_insert(0) += total_rep_need.max(4);
        }
    }

    // 2. Market Head: real cost + subjective price belief, zero order thrashing & zero Hub spam
    let mut own_orders_by_key: HashMap<(String, String), Vec<_>> = HashMap::new();
    for o in &snap.company.open_orders {
        own_orders_by_key
            .entry((o.station_id.clone(), o.item_id.clone()))
            .or_default()
            .push(o);
    }

    let mut active_orders_left =
        MAX_ACTIVE_ORDERS_PER_COMPANY.saturating_sub(snap.company.open_orders.len());
    let market_intent_cap = MAX_INTENTS_PER_TICK.saturating_sub(6);
    let mut cancelled_order_ids: HashSet<u64> = HashSet::new();

    let mut docked_fuel_reserve: HashMap<String, u32> = HashMap::new();
    let mut docked_export_cap: HashMap<String, u32> = HashMap::new();
    for ship in &snap.company.ships {
        if !ship.is_busy && ship.location.starts_with("ST:") {
            *docked_fuel_reserve.entry(ship.location.clone()).or_insert(0) += 6;
            *docked_export_cap.entry(ship.location.clone()).or_insert(0) += ship.capacity;
        }
    }

    // Cancel strictly duplicate or unneeded Buy orders; do NOT blindly expire orders every 24/36T
    for ((sid, item_id), olist) in &own_orders_by_key {
        if intents.len() >= market_intent_cap {
            break;
        }
        if olist.len() > 1 {
            // Consolidate legacy duplicate orders down to 1
            for o in olist.iter().skip(1) {
                if intents.len() >= market_intent_cap {
                    break;
                }
                intents.push(Intent::CancelOrder { order_id: o.order_id });
                cancelled_order_ids.insert(o.order_id);
                active_orders_left += 1;
            }
        }
        let o = olist[0];
        let age = snap.tick.saturating_sub(o.created_tick);
        let is_urgent_rep = Some(item_id.as_str()) == repair_item
            && urgent_repair_at_station.contains_key(sid);
        let is_unneeded_buy = o.side == OrderSide::Buy
            && !needed_items.contains_key(item_id)
            && !is_urgent_rep
            && age >= 18;
        let q_opt = snap.quotes.get(sid).and_then(|m| m.get(item_id));
        let band_base_m = q_opt
            .map(|q| {
                if q.last_price > 0 {
                    q.last_price
                } else {
                    to_money(ref_item_price(item_id))
                }
            })
            .unwrap_or_else(|| to_money(ref_item_price(item_id)));
        let band_cap_f = from_money(price_band_max(band_base_m));
        let is_out_of_band = from_money(o.price) > band_cap_f * 0.95;
        if (is_unneeded_buy || is_out_of_band) && !cancelled_order_ids.contains(&o.order_id) {
            intents.push(Intent::CancelOrder { order_id: o.order_id });
            cancelled_order_ids.insert(o.order_id);
            active_orders_left += 1;
        }
    }

    // Watch home station, any station where we hold inventory, all reachable system planet stations
    // (for cross-planet selling), any station with a stranded damaged ship, plus Hub if relevant.
    let mut watched_set: HashSet<String> = HashSet::new();
    watched_set.insert(home_sid.clone());
    watched_set.insert(home_hub.clone());
    for sid in snap.company.station_stores.keys() {
        watched_set.insert(sid.clone());
    }
    for sid in &system_planet_stations {
        watched_set.insert(sid.clone());
    }
    for sid in urgent_repair_at_station.keys() {
        watched_set.insert(sid.clone());
    }
    let mut watched_stations: Vec<String> = watched_set.into_iter().collect();
    watched_stations.sort();

    let mut item_ids: Vec<&String> = catalog.items.keys().collect();
    item_ids.sort();

    let total_owned_item = |item_id: &str| -> u32 {
        let g = snap
            .planets
            .get(home_pid)
            .and_then(|p| p.ground_store.get(item_id))
            .copied()
            .unwrap_or(0);
        if catalog.is_instant_item(item_id) {
            return g;
        }
        let st_sum: u32 = snap
            .company
            .station_stores
            .values()
            .filter_map(|m| m.get(item_id))
            .sum();
        g + st_sum
    };

    let mut desired_orders: Vec<(String, String, OrderSide, u32, f64, f64)> = Vec::new();

    for sid in &watched_stations {
        let Some(station_quotes) = snap.quotes.get(sid) else {
            continue;
        };
        let st_inv = snap.company.station_stores.get(sid);
        let g_inv = sid
            .strip_prefix("ST:")
            .and_then(|pid| snap.planets.get(pid))
            .map(|p| &p.ground_store);

        for item_id in &item_ids {
            let Some(q) = station_quotes.get(*item_id) else {
                continue;
            };
            let is_instant = catalog.is_instant_item(*item_id);
            if is_instant && sid != &home_sid {
                continue;
            }
            let last_p = from_money(q.last_price).max(0.01);
            let ref_p = ref_item_price(item_id);
            let fast_dev = ((last_p - from_money(q.ema_fast)) / last_p).clamp(-0.5, 0.5);
            let slow_dev = ((last_p - from_money(q.ema_slow)) / last_p).clamp(-0.5, 0.5);
            let spread = match (q.best_bid, q.best_ask) {
                (Some(b), Some(a)) if a > b => (from_money(a - b) / last_p).clamp(0.0, 1.0),
                _ => 0.25,
            };

            let raw_st_qty = st_inv.and_then(|m| m.get(*item_id)).copied().unwrap_or(0);
            let raw_g_qty = if is_instant {
                let g_raw = g_inv.and_then(|m| m.get(*item_id)).copied().unwrap_or(0);
                let pid_str = sid.strip_prefix("ST:").unwrap_or(home_pid.as_str());
                let used = est_ground_consumed
                    .get(&(pid_str.to_string(), (*item_id).clone()))
                    .copied()
                    .unwrap_or(0);
                g_raw.saturating_sub(used)
            } else {
                0
            };
            let total_avail = raw_st_qty + raw_g_qty;
            let self_keep = if sid == &home_sid {
                let k = needed_items.get(*item_id).copied().unwrap_or(0);
                if Some((*item_id).as_str()) == fuel_item {
                    let home_g_fuel = g_inv.and_then(|m| m.get(*item_id)).copied().unwrap_or(0);
                    let dock_res = docked_fuel_reserve.get(sid).copied().unwrap_or(0);
                    if home_g_fuel >= 25 {
                        dock_res.max(8)
                    } else {
                        k.max(12).max(dock_res)
                    }
                } else {
                    k
                }
            } else if Some((*item_id).as_str()) == fuel_item {
                docked_fuel_reserve.get(sid).copied().unwrap_or(0).max(6)
            } else {
                0
            };
            let ship_cap_here = docked_export_cap.get(sid).copied().unwrap_or(0);
            let export_reserve = if ship_cap_here > 0
                && !is_instant
                && raw_st_qty > self_keep
                && Some((*item_id).as_str()) != fuel_item
            {
                let local_bid_f = q.best_bid.map(from_money).unwrap_or(0.0);
                let fuel_unit_c = est_input_cost(sid, fuel_item.unwrap_or("fuel"));
                let has_better_export = system_planet_stations.iter().any(|other_sid| {
                    if other_sid == sid {
                        return false;
                    }
                    let Some((_, req_f)) = snap.route_cost(sid, other_sid) else {
                        return false;
                    };
                    let avail_q = (raw_st_qty - self_keep).min(ship_cap_here) as f64;
                    let trip_f = req_f as f64 * fuel_unit_c * 2.0;
                    snap.quotes
                        .get(other_sid)
                        .and_then(|m| m.get(*item_id))
                        .and_then(|oq| oq.best_bid)
                        .is_some_and(|ob| {
                            let ob_f = from_money(ob);
                            ob_f > local_bid_f.max(ref_p * 0.7) * 1.12
                                && ob_f * avail_q > trip_f * 2.2 + local_bid_f * avail_q
                        })
                });
                if has_better_export {
                    (raw_st_qty - self_keep).min(ship_cap_here)
                } else {
                    0
                }
            } else {
                0
            };

            let sellable_qty = total_avail
                .saturating_sub(if Some((*item_id).as_str()) == fuel_item {
                    self_keep.max(6)
                } else {
                    self_keep / 2
                })
                .saturating_sub(export_reserve);
            let inv_ratio = (sellable_qty as f64 / 20.0).clamp(0.0, 2.0);
            let feats = [spread, fast_dev, slow_dev, inv_ratio, scale_cash, 1.0];
            let b_score = dot(&genome.buy_w, &feats);
            let s_score = dot(&genome.sell_w, &[spread, fast_dev, slow_dev, inv_ratio, scale_cash, 1.0]);

            // Desperation factor for discounting stalled/glutted stock or relieving cash crunch
            let tot_stock = company_total_stock(item_id);
            let stock_glut = ((tot_stock as f64 / (60.0 * eff_hoard)) - 0.8).clamp(0.0, 1.0);
            let desperation = cash_desperation.max(stock_glut * 0.75);

            // Update missed-order belief once an old open order has sat past `MISSED_REVIEW_AGE`
            let key = belief_key(sid, item_id);
            let open_list = own_orders_by_key.get(&(sid.clone(), (*item_id).clone()));
            if let Some(olist) = open_list {
                if let Some(o) = olist.first() {
                    let age = snap.tick.saturating_sub(o.created_tick);
                    let last_cd = mem.order_cooldown_tick.get(&key).copied().unwrap_or(0);
                    if age >= MISSED_REVIEW_AGE && snap.tick.saturating_sub(last_cd) >= MISSED_REVIEW_AGE {
                        mem.on_order_missed(
                            snap.tick,
                            sid,
                            item_id,
                            o.side == OrderSide::Buy,
                            last_p.min(ref_p * 4.0),
                            desperation,
                        );
                    }
                }
            }

            let belief = mem
                .beliefs
                .entry(key)
                .or_insert_with(|| PriceBelief::new(last_p.min(ref_p * 4.0), snap.tick))
                .clone();

            let need_target = needed_items.get(*item_id).copied().unwrap_or(0);
            let urgent_rep_here = if Some((*item_id).as_str()) == repair_item {
                urgent_repair_at_station.get(sid).copied().unwrap_or(0)
            } else {
                0
            };

            let owned_for_buy = if Some((*item_id).as_str()) == fuel_item {
                let g_fuel = snap
                    .planets
                    .get(home_pid)
                    .and_then(|p| p.ground_store.get(*item_id))
                    .copied()
                    .unwrap_or(0);
                let ship_stranded_at_home_st = sid == &home_sid
                    && snap
                        .company
                        .ships
                        .iter()
                        .any(|s| !s.is_busy && s.location == home_sid)
                    && raw_st_qty < 4;
                if ship_stranded_at_home_st {
                    raw_st_qty
                } else if g_fuel < 12 && sid == &home_sid {
                    g_fuel
                } else {
                    total_owned_item(item_id)
                }
            } else {
                total_owned_item(item_id)
            };
            let eff_need = if Some((*item_id).as_str()) == fuel_item
                && sid == &home_sid
                && snap
                    .company
                    .ships
                    .iter()
                    .any(|s| !s.is_busy && s.location == home_sid)
                && raw_st_qty < 4
            {
                need_target.max(6)
            } else {
                need_target
            };
            let deficit = eff_need.saturating_sub(owned_for_buy).max(urgent_rep_here);

            let want_local_buy = (sid == &home_sid && deficit > 0) || urgent_rep_here > 0;
            let want_hub_buy = sid == &home_hub
                && deficit > 0
                && !is_instant
                && snap
                    .quotes
                    .get(&home_sid)
                    .and_then(|m| m.get(*item_id))
                    .and_then(|lq| lq.best_ask)
                    .is_none()
                && q.best_ask.is_some();

            // Merchants with strong trade_focus may opportunistically buy underpriced physical goods to export
            // (never buy ships via arbitrage since bought ships turn into Fleet vessels rather than cargo).
            let is_ship_item = matches!(
                (*item_id).as_str(),
                "ship_small" | "ship_medium" | "ship_large"
            );
            let want_arb_buy = !want_local_buy
                && !want_hub_buy
                && !is_instant
                && !is_ship_item
                && genome.style.trade_focus > 0.20
                && sellable_qty == 0
                && cash_f > safety_cash_floor * 1.25
                && q.best_ask.is_some_and(|ba| {
                    let ba_f = from_money(ba);
                    ba_f <= ref_p * 1.6
                        && est_output_value(sid, item_id) >= ba_f * 1.25
                });

            let band_base_m = if q.last_price > 0 {
                q.last_price
            } else {
                to_money(ref_p)
            };
            let band_cap_f = from_money(price_band_max(band_base_m));

            let (want_side, qty, target_price_f) = if sellable_qty > 0
                && (s_score > 0.10 || produced_items.contains(*item_id) || raw_st_qty >= 4)
            {
                // Real cost floor + subjective belief + personal markup - desperation liquidation discount
                let cost_anchor = mem
                    .cost_basis
                    .get(*item_id)
                    .copied()
                    .unwrap_or_else(|| ref_p * 0.85);
                let market_anchor = belief
                    .mid()
                    .min(ref_p * 8.0)
                    .min(last_p.max(ref_p) * 2.5);
                let ask_mult = (1.0 + belief.ask_margin + eff_markup - desperation * 0.42).clamp(0.45, 2.2);
                let desired_ask = (cost_anchor.max(market_anchor * 0.6) * ask_mult)
                    .min(band_cap_f * 0.90)
                    .max(0.02 * cpi);

                let ask_p = if let Some(bb) = q.best_bid {
                    let bb_f = from_money(bb);
                    let floor_accept = cost_anchor * (1.0 - desperation * 0.35);
                    if bb_f >= desired_ask * 0.94 || (desperation > 0.25 && bb_f >= floor_accept * 0.85)
                    {
                        bb_f
                    } else {
                        desired_ask
                    }
                } else {
                    desired_ask
                };
                let frac = ((s_score.max(0.40) + desperation * 0.5) / 1.8).clamp(0.35, 1.0);
                let q_sell = ((sellable_qty as f64 * frac).round() as u32)
                    .clamp(1, sellable_qty.min(MAX_ORDER_QTY));
                (Some(OrderSide::Sell), q_sell, ask_p.clamp(0.02, band_cap_f * 0.95))
            } else if (want_local_buy || want_hub_buy || want_arb_buy)
                && (b_score > -0.65 || urgent_rep_here > 0)
                && cash_f > ref_p.min(last_p) * 1.2
            {
                // Cap willing buy price strictly by downstream economics & sane ref multiple (no bid spirals!)
                let econ_cap = item_max_willing_pay
                    .get(*item_id)
                    .copied()
                    .unwrap_or_else(|| ref_p * 2.5);
                let hard_bid_cap = econ_cap
                    .max(ref_p * 1.4)
                    .min(ref_p * 8.0)
                    .min(last_p.max(ref_p) * 2.4)
                    .min(band_cap_f * 0.80);

                let bid_p = if let Some(ba) = q.best_ask {
                    let ba_f = from_money(ba);
                    if ba_f <= hard_bid_cap {
                        (ba_f * 1.01).min(hard_bid_cap).max(0.02)
                    } else {
                        hard_bid_cap.max(0.02)
                    }
                } else {
                    let base = last_p.min(ref_p * 2.0).max(belief.mid() * 0.85);
                    (base * (1.0 + belief.bid_margin).clamp(0.65, 1.35))
                        .min(hard_bid_cap)
                        .max(0.02)
                };

                let spend_frac = if urgent_rep_here > 0 { 0.40 } else { 0.22 };
                let budget = cash_f * spend_frac;
                let max_aff = (budget / bid_p).floor().clamp(0.0, u32::MAX as f64) as u32;
                let want_q = if urgent_rep_here > 0 {
                    urgent_rep_here.max(deficit)
                } else if want_arb_buy {
                    6
                } else {
                    deficit
                };
                let q_buy = want_q.min(25).min(max_aff);
                if q_buy > 0 {
                    (Some(OrderSide::Buy), q_buy, bid_p)
                } else {
                    (None, 0, 0.0)
                }
            } else {
                (None, 0, 0.0)
            };

            if let Some(side) = want_side {
                desired_orders.push((sid.clone(), (*item_id).clone(), side, qty, target_price_f, band_cap_f));
            }
        }
    }

    // Prioritize Sell orders and urgent ship-repair Buy orders first
    desired_orders.sort_by_key(|d| match d.2 {
        OrderSide::Sell => 0u8,
        OrderSide::Buy => {
            if Some(d.1.as_str()) == repair_item && urgent_repair_at_station.contains_key(&d.0) {
                0u8
            } else {
                1u8
            }
        }
    });

    let mut st_sold_this_tick: HashMap<(String, String), u32> = HashMap::new();
    let mut g_sold_instant_this_tick: HashMap<(String, String), u32> = HashMap::new();
    let mut cash_rem_f = (cash_f - est_wages_this_tick).max(0.0) * 0.98;

    for (sid, item_id, side, qty, target_price_f, band_cap_f) in desired_orders {
        if intents.len() >= market_intent_cap {
            break;
        }
        let target_price = to_money(target_price_f);
        let key = belief_key(&sid, &item_id);
        let existing = own_orders_by_key.get(&(sid.clone(), item_id.clone()));
        let mut skip_create = false;
        let last_cd = mem.order_cooldown_tick.get(&key).copied().unwrap_or(0);
        let cooldown_ok = snap.tick.saturating_sub(last_cd) >= ORDER_COOLDOWN_TICKS;

        if let Some(olist) = existing {
            if let Some(o) = olist.first() {
                if cancelled_order_ids.contains(&o.order_id) {
                    // Already cancelled earlier this tick (e.g. side_flip from unneeded buy)
                } else {
                    let cur_p = from_money(o.price).max(0.01);
                    let price_diff = (cur_p - target_price_f).abs() / cur_p.max(target_price_f).max(0.01);
                    let age = snap.tick.saturating_sub(o.created_tick);
                    let side_flip = o.side != side;
                    let out_of_band = cur_p > band_cap_f * 0.96;
                    let should_reprice = price_diff > 0.18 && age >= ORDER_COOLDOWN_TICKS && cooldown_ok;
                    if side_flip || out_of_band || should_reprice {
                        if intents.len() < market_intent_cap {
                            intents.push(Intent::CancelOrder { order_id: o.order_id });
                            cancelled_order_ids.insert(o.order_id);
                            active_orders_left += 1;
                            mem.order_cooldown_tick.insert(key.clone(), snap.tick);
                        } else {
                            skip_create = true;
                        }
                    } else {
                        skip_create = true;
                    }
                }
            }
        }
        if !skip_create && intents.len() < market_intent_cap && active_orders_left > 0 {
            let mut exec_qty = qty;
            if side == OrderSide::Buy {
                let max_aff_rem =
                    (cash_rem_f / target_price_f.max(0.01)).floor().clamp(0.0, u32::MAX as f64) as u32;
                exec_qty = exec_qty.min(max_aff_rem);
                if exec_qty == 0 {
                    continue;
                }
                cash_rem_f = (cash_rem_f - exec_qty as f64 * target_price_f).max(0.0);
            } else {
                let st_have = snap
                    .company
                    .station_stores
                    .get(&sid)
                    .and_then(|m| m.get(&item_id))
                    .copied()
                    .unwrap_or(0);
                let used_st = exec_qty.min(st_have);
                if used_st > 0 {
                    *st_sold_this_tick
                        .entry((sid.clone(), item_id.clone()))
                        .or_insert(0) += used_st;
                }
                if used_st < exec_qty && catalog.is_instant_item(&item_id) {
                    if let Some(pid) = sid.strip_prefix("ST:") {
                        *g_sold_instant_this_tick
                            .entry((pid.to_string(), item_id.clone()))
                            .or_insert(0) += exec_qty - used_st;
                    }
                }
            }
            intents.push(Intent::CreateOrder {
                station_id: sid,
                side,
                item_id,
                qty: exec_qty,
                price: target_price,
            });
            mem.order_cooldown_tick.insert(key, snap.tick);
            active_orders_left -= 1;
        }
    }

    // 3. Logistics Head: ship repair priority, direct planet-to-planet trade, NO blind Hub dumping
    let candidate_nodes: Vec<String> = {
        let mut nodes = vec![home_pid.clone(), home_sid.clone(), home_hub.clone()];
        for (pid, pv) in &snap.planets {
            if pid != home_pid && pv.system_id == home_sys {
                nodes.push(format!("ST:{pid}"));
            }
        }
        nodes
    };

    let mut loc_used_this_tick: HashMap<(String, String), u32> = HashMap::new();
    for ((sid, it), &q) in &st_sold_this_tick {
        *loc_used_this_tick.entry((sid.clone(), it.clone())).or_insert(0) += q;
    }
    for ((pid, it), &q) in &est_ground_consumed {
        *loc_used_this_tick.entry((pid.clone(), it.clone())).or_insert(0) += q;
    }
    for ((pid, it), &q) in &g_sold_instant_this_tick {
        *loc_used_this_tick.entry((pid.clone(), it.clone())).or_insert(0) += q;
    }

    for ship in &snap.company.ships {
        if intents.len() >= MAX_INTENTS_PER_TICK || ship.is_busy {
            continue;
        }
        let loc_is_st = ship.location.starts_with("ST:");
        let loc_store = if loc_is_st {
            snap.company.station_stores.get(&ship.location)
        } else {
            snap.planets.get(&ship.location).map(|p| &p.ground_store)
        };
        let avail_at_loc = |it: &str, raw: u32| -> u32 {
            let used = loc_used_this_tick
                .get(&(ship.location.clone(), it.to_string()))
                .copied()
                .unwrap_or(0);
            raw.saturating_sub(used)
        };

        let rep_need = ship.size.repair_cost();
        let rep_qty = repair_item
            .and_then(|rit| loc_store.and_then(|s| s.get(rit)).copied().map(|r| avail_at_loc(rit, r)))
            .unwrap_or(0);
        let rep_score = dot(
            &genome.repair_w,
            &[
                1.0 - (ship.durability / 100.0).clamp(0.0, 1.0),
                (rep_qty as f64 / rep_need.max(1) as f64).clamp(0.0, 1.0),
                1.0,
            ],
        );
        if ship.durability < 80.0 && rep_qty >= rep_need && (rep_score > 0.15 || ship.durability < 45.0)
        {
            if let Some(rit) = repair_item {
                *loc_used_this_tick
                    .entry((ship.location.clone(), rit.to_string()))
                    .or_insert(0) += rep_need;
            }
            intents.push(Intent::RepairShip { ship_id: ship.id });
            continue;
        }
        let Some(src_store) = loc_store else {
            continue;
        };
        let fuel_have = match fuel_item {
            Some(fit) => src_store
                .get(fit)
                .copied()
                .map(|r| avail_at_loc(fit, r))
                .unwrap_or(0),
            None => u32::MAX,
        };
        let adj_fuel_req = |base_f: u32, from: &str, to: &str| -> u32 {
            let is_surface_hop =
                from.strip_prefix("ST:") == Some(to) || to.strip_prefix("ST:") == Some(from);
            if is_surface_hop {
                base_f.saturating_mul(ship.size.launch_fuel())
            } else {
                // +1 fuel buffer against step 0a Keplerian orbit drift
                base_f.saturating_add(1)
            }
        };

        // Run emergency repair_shuttle BEFORE the < 20% freeze so ships at 12..20% durability
        // can still make one hop home to pick up local repair parts instead of locking forever.
        let mut repair_shuttle: Option<(&str, u32, Vec<(String, u32)>)> = None;
        if ship.durability < 55.0 && ship.durability > 10.0 {
            if let Some(rit) = repair_item {
                let home_g_rep = snap
                    .planets
                    .get(home_pid)
                    .and_then(|p| p.ground_store.get(rit))
                    .copied()
                    .unwrap_or(0);
                let home_st_rep = snap
                    .company
                    .station_stores
                    .get(&home_sid)
                    .and_then(|m| m.get(rit))
                    .copied()
                    .unwrap_or(0);
                if ship.location != *home_pid && home_g_rep >= rep_need {
                    if let Some((_, bf)) = snap.route_cost(&ship.location, home_pid) {
                        let f = adj_fuel_req(bf, &ship.location, home_pid);
                        let extra_f = if !loc_is_st && fuel_have > f + 1 { 1 } else { 0 };
                        if fuel_have >= f + extra_f {
                            let pack = fuel_item
                                .filter(|_| extra_f > 0)
                                .map(|fit| vec![(fit.to_string(), extra_f)])
                                .unwrap_or_default();
                            repair_shuttle = Some((home_pid.as_str(), f, pack));
                        }
                    }
                } else if ship.location == *home_pid && home_st_rep >= rep_need {
                    if let Some((_, bf)) = snap.route_cost(&ship.location, &home_sid) {
                        let f = adj_fuel_req(bf, &ship.location, &home_sid);
                        let ret_f = snap
                            .route_cost(&home_sid, home_pid)
                            .map(|r| adj_fuel_req(r.1, &home_sid, home_pid))
                            .unwrap_or(2);
                        let extra_f = if fuel_have > f + ret_f { ret_f } else if fuel_have > f + 1 { 1 } else { 0 };
                        if fuel_have >= f + extra_f {
                            let pack = fuel_item
                                .filter(|_| extra_f > 0)
                                .map(|fit| vec![(fit.to_string(), extra_f)])
                                .unwrap_or_default();
                            repair_shuttle = Some((home_sid.as_str(), f, pack));
                        }
                    }
                }
            }
        }
        if let Some((dest, req_f, cargo)) = repair_shuttle {
            if let Some(fit) = fuel_item {
                let cargo_f: u32 = cargo
                    .iter()
                    .filter(|(k, _)| k == fit)
                    .map(|(_, q)| *q)
                    .sum();
                *loc_used_this_tick
                    .entry((ship.location.clone(), fit.to_string()))
                    .or_insert(0) += req_f + cargo_f;
            }
            intents.push(Intent::DispatchShip {
                ship_id: ship.id,
                from: ship.location.clone(),
                to: dest.to_string(),
                cargo,
            });
            continue;
        }

        // Severely damaged ship without reachable parts: stay put to avoid marooning at 0% durability
        if ship.durability < 20.0 {
            continue;
        }

        let mut best_route: Option<(&str, f64, u32, Vec<(String, u32)>)> = None;
        for dest in &candidate_nodes {
            if dest == &ship.location {
                continue;
            }
            let Some((ticks, base_fuel_req)) = snap.route_cost(&ship.location, dest) else {
                continue;
            };
            let fuel_req = adj_fuel_req(base_fuel_req, &ship.location, dest);
            let home_land_f = if ship.location == home_sid && dest == &home_hub {
                snap.route_cost(&home_sid, home_pid)
                    .map(|r| adj_fuel_req(r.1, &home_sid, home_pid))
                    .unwrap_or(2)
            } else {
                0
            };
            if fuel_have < fuel_req + home_land_f {
                continue;
            }

            let src_sid = if loc_is_st {
                ship.location.clone()
            } else {
                format!("ST:{}", ship.location)
            };
            let dst_is_st = dest.starts_with("ST:");
            let dst_sid = if dst_is_st {
                dest.clone()
            } else {
                format!("ST:{dest}")
            };

            let mut scored_cargo: Vec<(String, u32, f64)> = Vec::new();
            let mut rem_cap = ship.capacity;
            let mut pack: Vec<(String, u32)> = Vec::new();
            let mut total_score = 0.0;

            let mut reserved_return_fuel = 0u32;
            if let Some(fit) = fuel_item {
                if !loc_is_st && dst_is_st {
                    let dst_fuel = snap
                        .company
                        .station_stores
                        .get(dest)
                        .and_then(|m| m.get(fit))
                        .copied()
                        .unwrap_or(0);
                    let target_ret = (fuel_req * 3).max(4).min(8);
                    if dst_fuel < target_ret && fuel_have > fuel_req {
                        let spare = (target_ret - dst_fuel)
                            .min(fuel_have - fuel_req)
                            .min(rem_cap / 2);
                        if spare > 0 {
                            reserved_return_fuel = spare;
                            rem_cap -= spare;
                            pack.push((fit.to_string(), spare));
                        }
                    }
                } else if loc_is_st && dest == &home_hub {
                    let ret_fuel = snap
                        .route_cost(&home_hub, &home_sid)
                        .map(|r| r.1)
                        .unwrap_or(fuel_req);
                    let hub_fuel = snap
                        .company
                        .station_stores
                        .get(&home_hub)
                        .and_then(|m| m.get(fit))
                        .copied()
                        .unwrap_or(0);
                    if hub_fuel < ret_fuel {
                        let need_ret = ret_fuel - hub_fuel;
                        if fuel_have < fuel_req + need_ret {
                            continue;
                        }
                        let spare = need_ret.min(rem_cap / 2);
                        if spare > 0 {
                            reserved_return_fuel = spare;
                            rem_cap -= spare;
                            pack.push((fit.to_string(), spare));
                        }
                    }
                } else if loc_is_st && dest == home_pid {
                    let home_g_fuel = snap
                        .planets
                        .get(home_pid)
                        .and_then(|p| p.ground_store.get(fit))
                        .copied()
                        .unwrap_or(0);
                    if home_g_fuel < 2 && fuel_have < fuel_req + 3 {
                        continue;
                    }
                    if home_g_fuel < 10 && fuel_have > fuel_req {
                        let spare = (10 - home_g_fuel)
                            .min(fuel_have - fuel_req)
                            .min(rem_cap / 2);
                        if spare > 0 {
                            reserved_return_fuel = spare;
                            rem_cap -= spare;
                            pack.push((fit.to_string(), spare));
                        }
                    }
                }
            }

            for (item_id, &raw_have) in src_store {
                let have = avail_at_loc(item_id, raw_have);
                if have == 0 || catalog.is_instant_item(item_id) {
                    continue;
                }
                let avail_take = if Some(item_id.as_str()) == fuel_item {
                    have.saturating_sub(fuel_req + reserved_return_fuel)
                } else {
                    have
                };
                if avail_take == 0 {
                    continue;
                }

                let is_needed_home = needed_items.contains_key(item_id);
                let is_consumer_good = catalog
                    .items
                    .get(item_id)
                    .is_some_and(|i| i.role == ItemRole::PlanetSupply);
                let p_src = est_input_cost(&src_sid, item_id);
                let dst_bid = snap
                    .quotes
                    .get(&dst_sid)
                    .and_then(|m| m.get(item_id))
                    .and_then(|q| q.best_bid)
                    .map(from_money);
                let p_dst = dst_bid.unwrap_or_else(|| est_output_value(&dst_sid, item_id));
                let mut price_diff = ((p_dst - p_src) / p_src.max(0.01)).clamp(-1.0, 2.0);

                if dest == home_pid && is_needed_home {
                    price_diff = price_diff.max(1.25);
                } else if !loc_is_st && dest == &home_sid {
                    let keep_here = needed_items.get(item_id).copied().unwrap_or(0);
                    if avail_take > keep_here {
                        let st_backlog = snap
                            .company
                            .station_stores
                            .get(&home_sid)
                            .and_then(|m| m.get(item_id))
                            .copied()
                            .unwrap_or(0);
                        price_diff = price_diff.max(0.85);
                        if dst_bid.is_some() {
                            price_diff = (price_diff + 0.55).min(2.5);
                        } else if st_backlog >= 60 {
                            price_diff = (price_diff - 0.45).max(0.15);
                        }
                    } else {
                        continue;
                    }
                } else if dest == &home_hub && loc_is_st {
                    // NEVER dump zero-bid consumer goods onto ST:HUB!
                    if is_needed_home {
                        continue;
                    }
                    let hub_bid_ok = dst_bid.is_some_and(|hb| hb >= p_src * 1.12);
                    if is_consumer_good && !hub_bid_ok {
                        continue;
                    }
                    if !hub_bid_ok {
                        continue;
                    }
                    price_diff = price_diff.max(0.70);
                } else if dst_is_st && dest != &home_sid {
                    // Direct interplanetary sale only when destination planet station actually bids above cost+fuel!
                    if is_needed_home && ship.location == home_sid {
                        continue;
                    }
                    let fuel_unit_c = est_input_cost(&src_sid, fuel_item.unwrap_or("fuel"));
                    let trip_fuel_cost = fuel_req as f64 * fuel_unit_c * 2.0;
                    let expected_gross = dst_bid.unwrap_or(0.0) * avail_take.min(ship.capacity) as f64;
                    if dst_bid.is_none_or(|b| b < p_src * 1.08) || expected_gross < trip_fuel_cost * 2.0 {
                        continue;
                    }
                    price_diff = price_diff.max(0.90);
                }

                let avail_r = (avail_take as f64 / ship.capacity.max(1) as f64).clamp(0.0, 1.0);
                let fuel_r = (fuel_req as f64 / (ticks.max(1) as f64 * 10.0)).clamp(0.0, 1.0);
                let s = dot(&genome.logi_w, &[price_diff, avail_r, fuel_r, 1.0]);
                if s > 0.25 {
                    let cap_take = if !loc_is_st && dest == &home_sid {
                        let keep_here = needed_items.get(item_id).copied().unwrap_or(0);
                        if is_needed_home {
                            avail_take.saturating_sub(keep_here)
                        } else {
                            avail_take
                        }
                    } else {
                        avail_take
                    };
                    if cap_take > 0 {
                        scored_cargo.push((item_id.clone(), cap_take, s));
                    }
                }
            }

            scored_cargo
                .sort_by(|a, b| b.2.partial_cmp(&a.2).unwrap_or(std::cmp::Ordering::Equal));
            let mut non_fuel_added = false;
            for (it, max_q, s) in scored_cargo {
                if rem_cap == 0 {
                    break;
                }
                let take = max_q.min(rem_cap);
                if take > 0 {
                    rem_cap -= take;
                    total_score += s * (take as f64 / ship.capacity.max(1) as f64);
                    if Some(it.as_str()) == fuel_item && reserved_return_fuel > 0 {
                        if let Some(existing) = pack.iter_mut().find(|(k, _)| k == &it) {
                            existing.1 += take;
                        } else {
                            pack.push((it, take));
                        }
                    } else {
                        pack.push((it, take));
                    }
                    non_fuel_added = true;
                }
            }

            if non_fuel_added
                && !pack.is_empty()
                && best_route
                    .as_ref()
                    .map(|br| total_score > br.1)
                    .unwrap_or(true)
            {
                best_route = Some((dest.as_str(), total_score, fuel_req, pack));
            } else if best_route.is_none() {
                if let Some(fit) = fuel_item {
                    let has_needed_at = |sid_key: &str| -> bool {
                        snap.company
                            .station_stores
                            .get(sid_key)
                            .map(|m| {
                                m.iter().any(|(it, &q)| {
                                    q > 0 && !catalog.is_instant_item(it) && needed_items.contains_key(it)
                                })
                            })
                            .unwrap_or(false)
                    };
                    if loc_is_st && dest == home_pid {
                        let ground_backlog: u32 = snap
                            .planets
                            .get(home_pid)
                            .map(|p| {
                                p.ground_store
                                    .iter()
                                    .filter(|&(ref it, &q)| {
                                        let keep = needed_items.get(it.as_str()).copied().unwrap_or(0);
                                        q > keep
                                            && Some(it.as_str()) != fuel_item
                                            && !catalog.is_instant_item(it.as_str())
                                    })
                                    .map(|(it, &q)| q - needed_items.get(it.as_str()).copied().unwrap_or(0))
                                    .sum()
                            })
                            .unwrap_or(0);
                        let home_g_fuel = snap
                            .planets
                            .get(home_pid)
                            .and_then(|p| p.ground_store.get(fit))
                            .copied()
                            .unwrap_or(0);
                        if (ground_backlog >= 2 || home_g_fuel < 8)
                            && fuel_have >= fuel_req + 1
                            && ship.capacity >= 1
                        {
                            let spare_fuel = if home_g_fuel < 8 && fuel_have >= fuel_req + 2 {
                                (fuel_have - fuel_req - 1).min(8).min(ship.capacity)
                            } else {
                                1
                            };
                            best_route = Some((
                                dest.as_str(),
                                0.35,
                                fuel_req,
                                vec![(fit.to_string(), spare_fuel)],
                            ));
                        }
                    } else if (!loc_is_st
                        && dest == &home_sid
                        && (has_needed_at(&home_sid) || has_needed_at(&home_hub)))
                        || (ship.location == home_sid && dest == &home_hub && has_needed_at(&home_hub))
                    {
                        if fuel_have >= fuel_req * 2 + 1 && ship.capacity >= 1 {
                            best_route =
                                Some((dest.as_str(), 0.30, fuel_req, vec![(fit.to_string(), 1)]));
                        }
                    } else if ship.location == home_hub
                        && dest == &home_sid
                        && fuel_have >= fuel_req + 1
                        && ship.capacity >= 1
                    {
                        let ret_land = snap
                            .route_cost(&home_sid, home_pid)
                            .map(|r| adj_fuel_req(r.1, &home_sid, home_pid))
                            .unwrap_or(2);
                        let carry_f = if fuel_have >= fuel_req + ret_land + 1 {
                            (ret_land + 1).min(ship.capacity)
                        } else {
                            1
                        };
                        best_route =
                            Some((dest.as_str(), 0.25, fuel_req, vec![(fit.to_string(), carry_f)]));
                    }
                }
            }
        }

        if let Some((dest, _score, req_f, cargo)) = best_route {
            if let Some(fit) = fuel_item {
                *loc_used_this_tick
                    .entry((ship.location.clone(), fit.to_string()))
                    .or_insert(0) += req_f;
            }
            for (it, q) in &cargo {
                *loc_used_this_tick
                    .entry((ship.location.clone(), it.clone()))
                    .or_insert(0) += *q;
            }
            intents.push(Intent::DispatchShip {
                ship_id: ship.id,
                from: ship.location.clone(),
                to: dest.to_string(),
                cargo,
            });
        }
    }

    // 4. Expansion & Bank Head (economic friction / ROI-gated instead of fixed hard building/plot caps)
    if intents.len() < MAX_INTENTS_PER_TICK {
        let free_slots: u32 = snap
            .company
            .plots
            .iter()
            .map(|p| p.capacity.saturating_sub(p.used_slots))
            .sum();
        let total_cap: u32 = snap.company.plots.iter().map(|p| p.capacity).sum();
        let free_ratio = if total_cap > 0 {
            free_slots as f64 / total_cap as f64
        } else {
            0.0
        };
        let avg_margin = if avg_margin_cnt > 0 {
            avg_margin_sum / avg_margin_cnt as f64
        } else {
            0.0
        };
        let exp_score = dot(&genome.expand_w, &[scale_cash, free_ratio, avg_margin, 1.0])
            + eff_risk * 0.25
            - genome.style.trade_focus.max(0.0) * 0.20;
        let bld_cnt = snap.company.buildings.len();
        let min_exp_cash = safety_cash_floor + (bld_cnt as f64 + 1.0) * 220.0 * cpi;
        let has_building_site_in_progress = !snap.company.sites.is_empty();

        if !has_building_site_in_progress
            && exp_score > 0.55
            && avg_margin > 0.05
            && cash_f > min_exp_cash
        {
            if let Some(target_plot) = snap
                .company
                .plots
                .iter()
                .find(|p| p.used_slots < p.capacity && Some(p.id) != demolish_plot_id)
            {
                let empty_map = HashMap::new();
                let mut reserved_mats: HashMap<String, u32> = HashMap::new();
                for ((loc, it), &q) in &loc_used_this_tick {
                    if loc == &target_plot.planet_id {
                        *reserved_mats.entry(it.clone()).or_insert(0) += q;
                    }
                }
                let best_btype = best_buildable_facility(
                    snap,
                    catalog,
                    target_plot,
                    0,
                    &empty_map,
                    &reserved_mats,
                    &est_input_cost,
                    &est_output_value,
                    &company_total_stock,
                    eff_hoard,
                )
                .filter(|(_, m)| *m > 0.08)
                .map(|(bt, _)| bt);

                if let Some(btype) = best_btype {
                    intents.push(Intent::BuildFacility {
                        plot_id: target_plot.id,
                        building_type: btype,
                    });
                }
            } else if snap.company.plots.len() < 5 {
                if let Some(p_view) = snap.planets.get(home_pid) {
                    let prim_price = p_view.primary_land_price;
                    let best_listing = p_view
                        .land_listings
                        .iter()
                        .filter(|l| prim_price.is_some() || l.seller_id == "BANK")
                        .min_by_key(|l| l.ask_price);
                    // Rank unclaimed slots purely by average terrain quality + capacity (no profession lock!)
                    let best_unclaimed_slot = snap
                        .public_tiles
                        .get(home_pid)
                        .and_then(|tiles| {
                            tiles
                                .iter()
                                .filter(|t| t.status == "unclaimed")
                                .max_by(|a, b| {
                                    let score = |t: &meridian_core::PublicLandTileView| -> f64 {
                                        let avg_mod = if t.building_mods.is_empty() {
                                            1.0
                                        } else {
                                            t.building_mods.values().sum::<f64>()
                                                / t.building_mods.len() as f64
                                        };
                                        avg_mod + (t.capacity as f64) * 0.08
                                    };
                                    score(a)
                                        .partial_cmp(&score(b))
                                        .unwrap_or(std::cmp::Ordering::Equal)
                                })
                                .map(|t| t.slot_id)
                        });
                    let (target_slot, target_lid, land_p) =
                        match (best_listing, prim_price, best_unclaimed_slot) {
                            (Some(lst), Some(pp), _) if lst.ask_price <= pp => {
                                (None, Some(lst.listing_id), Some(lst.ask_price))
                            }
                            (Some(lst), None, _) => (None, Some(lst.listing_id), Some(lst.ask_price)),
                            (_, Some(pp), Some(sid)) => (Some(sid), None, Some(pp)),
                            (Some(lst), _, None) => (None, Some(lst.listing_id), Some(lst.ask_price)),
                            _ => (None, None, None),
                        };
                    // Account for ongoing multi-plot land tax burden before buying extra land
                    let extra_plot_hurdle = (snap.company.plots.len() as f64) * 450.0 * cpi;
                    if let Some(cost) = land_p {
                        if snap.company.cash > cost + to_money(safety_cash_floor + extra_plot_hurdle) {
                            intents.push(Intent::BuyPlot {
                                planet_id: home_pid.clone(),
                                slot_id: target_slot,
                                listing_id: target_lid,
                            });
                        }
                    }
                }
            }
        }
    }

    if intents.len() < MAX_INTENTS_PER_TICK {
        let rate_bps = snap
            .planets
            .get(home_pid)
            .map(|p| p.bank_rate_bps)
            .unwrap_or(500);
        let rate_norm = (rate_bps as f64 / 50.0).clamp(0.0, 2.0);
        let bank_s = dot(&genome.bank_w, &[scale_cash, debt_ratio, rate_norm, 1.0]);
        let debt_overdue = snap
            .company
            .debt_due_tick
            .is_some_and(|due| snap.tick >= due);
        if debt_f > 10.0 && cash_f > safety_cash_floor * 1.15 && (bank_s > 0.45 || rate_bps > 900) {
            let pay = ((cash_f - safety_cash_floor) * 0.45).min(debt_f);
            if pay > 5.0 * cpi {
                intents.push(Intent::BankOp {
                    planet_id: home_pid.clone(),
                    op: BankOpKind::Repay,
                    amount: to_money(pay),
                });
            }
        } else if bank_s > 0.80 && cash_f > safety_cash_floor * 2.2 {
            intents.push(Intent::BankOp {
                planet_id: home_pid.clone(),
                op: BankOpKind::Deposit,
                amount: to_money((cash_f - safety_cash_floor * 1.5) * 0.25),
            });
        } else if (bank_s < -0.60 || cash_f < safety_cash_floor * 0.7) && savings_f > 10.0 {
            intents.push(Intent::BankOp {
                planet_id: home_pid.clone(),
                op: BankOpKind::Withdraw,
                amount: to_money(savings_f * 0.5),
            });
        } else if debt_f < 5.0 * cpi
            && !debt_overdue
            && cash_f < safety_cash_floor * 0.45
            && eff_risk > 0.10
            && rate_bps < 1100
        {
            let borrow_amt = (safety_cash_floor * 0.6).min(600.0 * cpi);
            if borrow_amt > 25.0 * cpi {
                intents.push(Intent::BankOp {
                    planet_id: home_pid.clone(),
                    op: BankOpKind::Borrow,
                    amount: to_money(borrow_amt),
                });
            }
        }
    }

    intents.truncate(MAX_INTENTS_PER_TICK);
    intents
}

#[allow(clippy::too_many_arguments)]
fn best_buildable_facility<F1, F2, F3>(
    snap: &WorldSnapshot,
    catalog: &ProductionCatalog,
    target_plot: &meridian_core::snapshot::PlotView,
    freed_slots: u32,
    salvage_bonus: &HashMap<String, u32>,
    reserved_mats: &HashMap<String, u32>,
    est_input_cost: &F1,
    est_output_value: &F2,
    company_total_stock: &F3,
    eff_hoard: f64,
) -> Option<(String, f64)>
where
    F1: Fn(&str, &str) -> f64,
    F2: Fn(&str, &str) -> f64,
    F3: Fn(&str) -> u32,
{
    let p_ground = snap
        .planets
        .get(&target_plot.planet_id)
        .map(|p| &p.ground_store);
    let p_sid = format!("ST:{}", target_plot.planet_id);
    let mut build_ids: Vec<&String> = catalog.buildings.keys().collect();
    build_ids.sort();

    build_ids
        .into_iter()
        .filter(|bt| {
            let bdef = &catalog.buildings[*bt];
            let slots_ok =
                target_plot.used_slots.saturating_sub(freed_slots) + bdef.slots_used <= target_plot.capacity;
            let has_mats = bdef.build_cost.iter().all(|req| {
                let raw_g = p_ground.and_then(|m| m.get(&req.item)).copied().unwrap_or(0);
                let res = reserved_mats.get(&req.item).copied().unwrap_or(0);
                let g = raw_g.saturating_sub(res);
                let salv = salvage_bonus.get(&req.item).copied().unwrap_or(0);
                g + salv >= req.qty
            });
            let mod_val = target_plot.building_mods.get(*bt).copied().unwrap_or(1.0);
            slots_ok && mod_val > 0.0 && has_mats
        })
        .filter_map(|bt| {
            let eff = target_plot.building_mods.get(bt).copied().unwrap_or(1.0);
            let city_waste = snap
                .planets
                .get(&target_plot.planet_id)
                .map(|p| p.waste_backlog)
                .unwrap_or(0);
            let own_bt_cnt = snap
                .company
                .buildings
                .iter()
                .filter(|b| b.planet_id == target_plot.planet_id && b.building_type == *bt)
                .count() as u32;
            let best_rec_margin = catalog
                .recipes_by_building
                .get(bt)
                .into_iter()
                .flatten()
                .filter_map(|rid| catalog.recipes.get(rid))
                .filter(|r| r.enabled)
                .map(|r| {
                    let mut waste_req = 0u32;
                    let runnable = r.inputs.iter().all(|inp| {
                        if inp.item == "waste" {
                            waste_req += inp.qty;
                            city_waste >= inp.qty.saturating_mul(3).saturating_mul(own_bt_cnt + 1)
                        } else {
                            p_ground.and_then(|g| g.get(&inp.item)).copied().unwrap_or(0)
                                >= inp.qty
                                || snap
                                    .quotes
                                    .get(&p_sid)
                                    .and_then(|m| m.get(&inp.item))
                                    .and_then(|q| q.best_ask)
                                    .is_some()
                        }
                    });
                    let waste_util = if waste_req > 0 {
                        (city_waste as f64 / (waste_req as f64 * 4.0 * (own_bt_cnt as f64 + 1.0)))
                            .clamp(0.0, 1.0)
                    } else {
                        1.0
                    };
                    let mut out_v = 0.0;
                    let mut all_glutted = !r.outputs.is_empty();
                    for o in &r.outputs {
                        let sat = o.qty.max(1) as f64 * 32.0 * eff_hoard;
                        let tot = company_total_stock(&o.item) as f64;
                        if tot < sat * 1.1 {
                            all_glutted = false;
                        }
                        let disc = if tot > sat { (sat / tot).clamp(0.1, 1.0) } else { 1.0 };
                        out_v += o.qty as f64 * eff * est_output_value(&p_sid, &o.item) * disc;
                    }
                    out_v *= waste_util;
                    let in_v: f64 = r.labor_cost * snap.cpi.max(0.25)
                        + r.power_cost as f64 * est_input_cost(&p_sid, "power")
                        + r.inputs
                            .iter()
                            .filter(|i| i.item != "waste")
                            .map(|i| i.qty as f64 * est_input_cost(&p_sid, &i.item))
                            .sum::<f64>();
                    let m = (out_v - in_v) / in_v.max(1.0);
                    if !runnable {
                        m - 5.0
                    } else if all_glutted {
                        -2.0
                    } else {
                        m
                    }
                })
                .fold(f64::NEG_INFINITY, f64::max);
            if best_rec_margin > -0.5 {
                Some(((*bt).clone(), best_rec_margin))
            } else {
                None
            }
        })
        .max_by(|a, b| a.1.partial_cmp(&b.1).unwrap_or(std::cmp::Ordering::Equal))
}

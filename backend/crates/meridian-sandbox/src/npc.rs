//! Zero-hardcoded free-play NPC decision policy driven by evolvable `NpcGenome` weights
//! and read-only `WorldSnapshot` + `ProductionCatalog` features.

use std::collections::{HashMap, HashSet};

use meridian_core::{
    from_money, to_money, BankOpKind, Intent, OrderSide, ProductionCatalog, WorldSnapshot,
    MAX_ACTIVE_ORDERS_PER_COMPANY, MAX_INTENTS_PER_TICK,
};
use serde::{Deserialize, Serialize};

/// Compact evolvable weights for all 4 NPC policy heads.
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
    /// Price offset weights: [ema_fast_dev, spread, inv_ratio, bias] -> tanh * 0.25
    pub price_off_w: [f64; 4],
    /// Logistics route+cargo score: [price_diff, avail_ratio, fuel_ratio, bias]
    pub logi_w: [f64; 4],
    /// Ship repair trigger: [durability_norm, repair_stock_ratio, bias]
    pub repair_w: [f64; 3],
    /// Expansion trigger: [cash_ratio, free_slot_ratio, avg_margin, bias]
    pub expand_w: [f64; 4],
    /// Bank op scoring: [cash_ratio, debt_ratio, rate_norm, bias]
    pub bank_w: [f64; 4],
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
    fn next_signed(&mut self, scale: f64) -> f64 {
        let u = (self.next_u64() >> 11) as f64 / ((1u64 << 53) as f64);
        (u * 2.0 - 1.0) * scale
    }
}

impl NpcGenome {
    pub fn from_seed(seed: u64) -> Self {
        let mut rng = SplitMix64(seed ^ 0xA5A5_5A5A_1234_5678);
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
        child
    }
}

#[inline]
fn dot(w: &[f64], x: &[f64]) -> f64 {
    w.iter().zip(x.iter()).map(|(wi, xi)| wi * xi).sum()
}

/// Produce up to `MAX_INTENTS_PER_TICK` Intents for an NPC from `WorldSnapshot` + `NpcGenome`.
pub fn decide_npc_intents(
    snap: &WorldSnapshot,
    catalog: &ProductionCatalog,
    genome: &NpcGenome,
) -> Vec<Intent> {
    let mut intents = Vec::new();
    let home_pid = &snap.company.home_planet_id;
    let home_sid = format!("ST:{home_pid}");
    let home_hub = snap.home_hub_id().to_string();
    let cash_f = from_money(snap.company.cash).max(0.0);
    let savings_f = from_money(snap.company.savings).max(0.0);
    let debt_f = from_money(snap.company.debt).max(0.0);
    let scale_cash = (cash_f / (1000.0 * snap.cpi.max(0.25))).clamp(0.0, 2.0);
    let debt_ratio = (debt_f / (cash_f + savings_f + 500.0 * snap.cpi.max(0.25))).clamp(0.0, 4.0);

    let ref_item_price = |item_id: &str| -> f64 {
        catalog
            .items
            .get(item_id)
            .map(|i| i.ref_price * snap.cpi)
            .unwrap_or(1.0)
            .max(0.01)
    };

    // Market valuation that sees both resting asks and resting bids (without runaway city bid spikes)
    let est_input_cost = |station: &str, item_id: &str| -> f64 {
        if let Some(q) = snap.quotes.get(station).and_then(|m| m.get(item_id)) {
            if let Some(ask) = q.best_ask {
                return from_money(ask).max(0.01);
            }
            return from_money(q.last_price).max(0.01);
        }
        ref_item_price(item_id)
    };

    let est_output_value = |station: &str, item_id: &str| -> f64 {
        let q_opt = snap.quotes.get(station).and_then(|m| m.get(item_id));
        let last_p = q_opt
            .map(|q| from_money(q.last_price))
            .unwrap_or_else(|| ref_item_price(item_id))
            .max(0.01);
        let mut val = last_p;
        if let Some(q) = q_opt {
            if let Some(bb) = q.best_bid {
                let bb_f = from_money(bb);
                val = val.max(bb_f.min(last_p * 5.0));
            }
        }
        if !catalog.is_instant_item(item_id) {
            if let Some(hq) = snap.quotes.get(home_hub.as_str()).and_then(|m| m.get(item_id)) {
                if let Some(hbb) = hq.best_bid {
                    let h_last = from_money(hq.last_price).max(0.01);
                    val = val.max(from_money(hbb).min(h_last * 5.0) * 0.90);
                }
            }
        }
        val.max(0.01)
    };

    // 1. Production Head: pick highest-scoring recipe & active state per building
    let company_fuel: u32 = catalog
        .fuel_item
        .as_deref()
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
    let mut avg_margin_sum = 0.0;
    let mut avg_margin_cnt = 0usize;
    let mut needed_items: HashMap<String, u32> = HashMap::new();
    let mut produced_items: HashSet<String> = HashSet::new();

    for bld in &snap.company.buildings {
        let Some(valid_recipes) = catalog.recipes_by_building.get(&bld.building_type) else {
            continue;
        };
        let b_sid = format!("ST:{}", bld.planet_id);
        let p_ground = snap.planets.get(&bld.planet_id).map(|p| &p.ground_store);
        let p_st = snap.company.station_stores.get(&b_sid);

        let mut best_rid: Option<&str> = None;
        let mut best_score = f64::NEG_INFINITY;
        let mut best_margin = 0.0;

        for rid in valid_recipes {
            let Some(r) = catalog.recipes.get(rid) else {
                continue;
            };
            let hub_st = snap.company.station_stores.get(home_hub.as_str());
            let mut in_cost = r.labor_cost * snap.cpi;
            if r.power_cost > 0 {
                in_cost += r.power_cost as f64 * est_input_cost(&b_sid, "power");
            }
            let mut min_cov = 1.0f64;
            let mut missing_inputs = 0usize;
            for inp in &r.inputs {
                in_cost += inp.qty as f64 * est_input_cost(&b_sid, &inp.item);
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
            for out in &r.outputs {
                let mut p = est_output_value(&b_sid, &out.item);
                let have = p_ground.and_then(|g| g.get(&out.item)).copied().unwrap_or(0)
                    + p_st.and_then(|s| s.get(&out.item)).copied().unwrap_or(0);
                let sat_thresh = out.qty.max(1) as f64 * 25.0;
                if Some(out.item.as_str()) == catalog.fuel_item.as_deref() {
                    if company_fuel < 16 {
                        p *= 4.0 + (16 - company_fuel) as f64 * 0.25;
                    } else if company_fuel < 28 {
                        p *= 1.0 + (28 - company_fuel) as f64 * 0.08;
                    }
                } else if !catalog.is_instant_item(&out.item)
                    && company_fuel < 8
                    && have >= out.qty.max(1) * 8
                {
                    // Non-instant ground output cannot leave the planet without fuel
                    p *= 0.15;
                } else if (have as f64) > sat_thresh {
                    p *= (sat_thresh / have as f64).clamp(0.15, 1.0);
                }
                out_val += out.qty as f64 * bld.efficiency * p;
                let stock_contrib =
                    if Some(out.item.as_str()) == catalog.fuel_item.as_deref() && company_fuel < 18 {
                        0.0
                    } else {
                        (have as f64 / sat_thresh).clamp(0.0, 4.0)
                    };
                out_stock_ratio += stock_contrib;
            }
            let margin = ((out_val - in_cost) / in_cost.max(1.0)).clamp(-1.0, 3.0);
            let out_stock = out_stock_ratio / r.outputs.len().max(1) as f64;
            let mut score = dot(&genome.prod_w, &[margin, min_cov, out_stock, scale_cash, 1.0]);
            if missing_inputs > 0 {
                score -= 4.0 * (missing_inputs as f64);
            }
            if score > best_score {
                best_score = score;
                best_rid = Some(rid.as_str());
                best_margin = margin;
            }
        }

        avg_margin_sum += best_margin;
        avg_margin_cnt += 1;

        let chosen_rid = best_rid.unwrap_or(bld.recipe_id.as_str());
        if chosen_rid != bld.recipe_id && intents.len() < MAX_INTENTS_PER_TICK {
            intents.push(Intent::SetRecipe {
                building_id: bld.id,
                recipe_id: chosen_rid.to_string(),
            });
        }
        let act_score = dot(&genome.active_w, &[best_margin, scale_cash, 1.0]);
        let want_active = act_score > 0.0;
        if want_active != bld.active && intents.len() < MAX_INTENTS_PER_TICK {
            intents.push(Intent::ToggleBuilding {
                building_id: bld.id,
                active: want_active,
            });
        }

        if want_active {
            if let Some(rec) = catalog.recipes.get(chosen_rid) {
                for out in &rec.outputs {
                    produced_items.insert(out.item.clone());
                }
                if rec.power_cost > 0 {
                    *needed_items.entry("power".to_string()).or_insert(0) += rec.power_cost * 3;
                }
                for inp in &rec.inputs {
                    if inp.item != "waste" {
                        *needed_items.entry(inp.item.clone()).or_insert(0) += inp.qty * 3;
                    }
                }
            }
        }
    }

    let fuel_item = catalog.fuel_item.as_deref();
    let repair_item = catalog.repair_item.as_deref();
    if let Some(fit) = fuel_item {
        *needed_items.entry(fit.to_string()).or_insert(0) += 20;
    }
    if let Some(rit) = repair_item {
        if snap.company.ships.iter().any(|s| s.durability < 92.0) {
            *needed_items.entry(rit.to_string()).or_insert(0) += 4;
        }
    }

    // 2. Market Head: evaluate watched stations (home station & Hub)
    let mut own_orders_by_key: HashMap<(String, String), Vec<_>> = HashMap::new();
    for o in &snap.company.open_orders {
        own_orders_by_key
            .entry((o.station_id.clone(), o.item_id.clone()))
            .or_default()
            .push(o);
    }

    let mut active_orders_left =
        MAX_ACTIVE_ORDERS_PER_COMPANY.saturating_sub(snap.company.open_orders.len());
    // Reserve intents for Logistics, Expansion, and Bank heads so shipping never starves.
    let market_intent_cap = MAX_INTENTS_PER_TICK.saturating_sub(6);

    // Cancel stale orders or unneeded Buy orders so escrowed cash & slots are never deadlocked
    for o in &snap.company.open_orders {
        if intents.len() >= market_intent_cap {
            break;
        }
        let age = snap.tick.saturating_sub(o.created_tick);
        let is_unneeded_buy = o.side == OrderSide::Buy
            && !needed_items.contains_key(&o.item_id)
            && age >= 12;
        if (o.side == OrderSide::Buy && age >= 24)
            || (o.side == OrderSide::Sell && age >= 36)
            || is_unneeded_buy
        {
            intents.push(Intent::CancelOrder {
                order_id: o.order_id,
            });
            active_orders_left += 1;
        }
    }

    let watched_stations = [home_sid.as_str(), home_hub.as_str()];
    let mut item_ids: Vec<&String> = catalog.items.keys().collect();
    item_ids.sort();

    // Total usable company stock per item (instant inputs must sit on ground)
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
        let st_h = snap
            .company
            .station_stores
            .get(&home_sid)
            .and_then(|m| m.get(item_id))
            .copied()
            .unwrap_or(0);
        let st_hub = snap
            .company
            .station_stores
            .get(home_hub.as_str())
            .and_then(|m| m.get(item_id))
            .copied()
            .unwrap_or(0);
        g + st_h + st_hub
    };

    let mut desired_orders: Vec<(&str, &String, OrderSide, u32, f64)> = Vec::new();
    for sid in watched_stations {
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
                g_inv.and_then(|m| m.get(*item_id)).copied().unwrap_or(0)
            } else {
                0
            };
            let total_avail = raw_st_qty + raw_g_qty;
            let self_keep = if sid == home_sid {
                let k = needed_items.get(*item_id).copied().unwrap_or(0);
                if Some((*item_id).as_str()) == fuel_item {
                    k.max(12)
                } else {
                    k
                }
            } else {
                0
            };
            let sellable_qty = total_avail.saturating_sub(if Some((*item_id).as_str()) == fuel_item {
                self_keep.max(6)
            } else {
                self_keep / 2
            });
            let inv_ratio = (sellable_qty as f64 / 20.0).clamp(0.0, 2.0);

            let feats = [spread, fast_dev, slow_dev, inv_ratio, scale_cash, 1.0];
            let b_score = dot(&genome.buy_w, &feats);
            let s_score = dot(&genome.sell_w, &feats);
            let off =
                (dot(&genome.price_off_w, &[fast_dev, spread, inv_ratio, 1.0]).tanh()) * 0.25;

            let need_target = needed_items.get(*item_id).copied().unwrap_or(0);
            let owned_for_buy = if Some((*item_id).as_str()) == fuel_item {
                let g_fuel = snap
                    .planets
                    .get(home_pid)
                    .and_then(|p| p.ground_store.get(*item_id))
                    .copied()
                    .unwrap_or(0);
                let ship_stranded_at_home_st = sid == home_sid
                    && snap
                        .company
                        .ships
                        .iter()
                        .any(|s| !s.is_busy && s.location == home_sid)
                    && raw_st_qty < 4;
                if ship_stranded_at_home_st {
                    raw_st_qty
                } else if g_fuel < 12 && sid == home_sid {
                    // Don't let orbital fuel prevent buying fuel when ground is running low
                    g_fuel
                } else {
                    total_owned_item(item_id)
                }
            } else {
                total_owned_item(item_id)
            };
            let need_target = if Some((*item_id).as_str()) == fuel_item
                && sid == home_sid
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
            let deficit = need_target.saturating_sub(owned_for_buy);
            let want_local_buy = sid == home_sid && deficit > 0;
            let want_hub_buy = sid == home_hub.as_str()
                && deficit > 0
                && !is_instant
                && snap
                    .quotes
                    .get(&home_sid)
                    .and_then(|m| m.get(*item_id))
                    .and_then(|lq| lq.best_ask)
                    .is_none()
                && q.best_ask.is_some();

            // Decide Sell vs Needed-Buy vs Hold
            let (want_side, qty, target_price_f) = if sellable_qty > 0
                && (s_score > 0.15 || produced_items.contains(*item_id) || raw_st_qty >= 8)
            {
                let anchor_p = last_p.min(ref_p * 6.0).max(ref_p * 0.5);
                let base_ask = (anchor_p * (1.0 + off)).max(0.02);
                let ask_p = if let Some(bb) = q.best_bid {
                    let bb_f = from_money(bb);
                    if bb_f >= last_p * 0.65 || bb_f >= ref_p * 0.65 {
                        // Cross resting Buy orders (including PLANET:* consumption bids)
                        bb_f
                    } else {
                        base_ask
                    }
                } else {
                    base_ask
                };
                let frac = (s_score.max(0.35) / 2.2).clamp(0.25, 0.9);
                let q_sell = ((sellable_qty as f64 * frac).round() as u32).clamp(1, sellable_qty);
                (Some(OrderSide::Sell), q_sell, ask_p.max(0.02))
            } else if (want_local_buy || want_hub_buy)
                && b_score > -0.60
                && cash_f > ref_p.min(last_p) * 1.5
            {
                let bid_p = if let Some(ba) = q.best_ask {
                    let ba_f = from_money(ba);
                    if ba_f <= last_p.max(ref_p) * 3.0 {
                        (ba_f * 1.01).max(0.02)
                    } else {
                        (last_p.min(ref_p * 2.0) * 1.15).max(0.02)
                    }
                } else {
                    let comp_bid = q.best_bid.map(from_money).unwrap_or(last_p);
                    let anchor = last_p.max(comp_bid.min(last_p * 2.2) * 1.02);
                    (anchor * (1.03 + off.max(0.0))).min(last_p * 2.4).max(0.02)
                };
                let budget = cash_f * 0.25;
                let max_aff = (budget / bid_p).floor() as u32;
                let q_buy = deficit.min(25).min(max_aff);
                if q_buy > 0 {
                    (Some(OrderSide::Buy), q_buy, bid_p)
                } else {
                    (None, 0, 0.0)
                }
            } else {
                (None, 0, 0.0)
            };

            if let Some(side) = want_side {
                desired_orders.push((sid, *item_id, side, qty, target_price_f));
            }
        }
    }

    // Prioritize Sell orders before Buy orders so inventory liquidation is never starved.
    desired_orders.sort_by_key(|d| match d.2 {
        OrderSide::Sell => 0u8,
        OrderSide::Buy => 1u8,
    });

    for (sid, item_id, side, qty, target_price_f) in desired_orders {
        if intents.len() >= market_intent_cap {
            break;
        }
        let target_price = to_money(target_price_f);
        let existing = own_orders_by_key.get(&(sid.to_string(), item_id.clone()));
        let mut skip_create = false;
        if let Some(olist) = existing {
            for o in olist {
                let price_diff = ((from_money(o.price) - target_price_f).abs()
                    / target_price_f.max(0.01))
                    > 0.08;
                if o.side != side || price_diff {
                    if intents.len() < market_intent_cap {
                        intents.push(Intent::CancelOrder {
                            order_id: o.order_id,
                        });
                        active_orders_left += 1;
                    }
                } else {
                    skip_create = true;
                }
            }
        }
        if !skip_create && intents.len() < market_intent_cap && active_orders_left > 0 {
            intents.push(Intent::CreateOrder {
                station_id: sid.to_string(),
                side,
                item_id: item_id.clone(),
                qty,
                price: target_price,
            });
            active_orders_left -= 1;
        }
    }

    // 3. Logistics Head: two-way shipping with return-fuel protection
    let candidate_nodes: Vec<String> = {
        let mut nodes = vec![home_pid.clone(), home_sid.clone(), home_hub.clone()];
        for (pid, pv) in &snap.planets {
            if pid != home_pid
                && snap
                    .planets
                    .get(home_pid)
                    .is_none_or(|hp| pv.system_id == hp.system_id)
            {
                nodes.push(format!("ST:{pid}"));
            }
        }
        nodes
    };

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

        let rep_qty = repair_item
            .and_then(|rit| loc_store.and_then(|s| s.get(rit)).copied())
            .unwrap_or(0);
        let rep_score = dot(
            &genome.repair_w,
            &[
                1.0 - (ship.durability / 100.0).clamp(0.0, 1.0),
                (rep_qty as f64 / 5.0).clamp(0.0, 1.0),
                1.0,
            ],
        );
        if ship.durability < 90.0 && rep_qty > 0 && rep_score > 0.25 {
            intents.push(Intent::RepairShip { ship_id: ship.id });
            continue;
        }

        let Some(src_store) = loc_store else {
            continue;
        };
        let fuel_have = fuel_item
            .and_then(|fit| src_store.get(fit).copied())
            .unwrap_or(u32::MAX);

        let mut best_route: Option<(&str, f64, Vec<(String, u32)>)> = None;
        for dest in &candidate_nodes {
            if dest == &ship.location {
                continue;
            }
            let Some((ticks, fuel_req)) = snap.route_cost(&ship.location, dest) else {
                continue;
            };
            if fuel_have < fuel_req {
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

            // Reserve return fuel in cargo when flying up to orbit, to ST:HUB, OR down to fuel-poor ground
            // so ships never get marooned at any node.
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
                            // Do not strand ship at Hub without fuel to return home
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
                        // Stay at orbital station to receive purchased fuel rather than stranding on empty ground
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

            for (item_id, &have) in src_store {
                if have == 0 {
                    continue;
                }
                if catalog.is_instant_item(item_id) {
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

                let p_src = est_input_cost(&src_sid, item_id);
                let p_dst = est_output_value(&dst_sid, item_id);
                let mut price_diff = ((p_dst - p_src) / p_src.max(0.01)).clamp(-1.0, 2.0);

                // Pull needed factory inputs back down to home ground
                let is_needed_home = needed_items.contains_key(item_id);
                if dest == home_pid && is_needed_home {
                    price_diff = price_diff.max(1.2);
                } else if !loc_is_st && dest == &home_sid {
                    // Push all surplus ground inventory (not needed as inputs) up to home station for sale
                    let keep_here = needed_items.get(item_id).copied().unwrap_or(0);
                    if avail_take > keep_here {
                        price_diff = price_diff.max(0.95);
                    }
                } else if dest == &home_hub && loc_is_st {
                    if is_needed_home {
                        // Don't export critical local factory inputs to Hub
                        continue;
                    }
                    // Export unsold local surplus or profitable arbitrage from home station to Hub
                    let local_bid_ok = snap
                        .quotes
                        .get(&home_sid)
                        .and_then(|m| m.get(item_id))
                        .and_then(|q| q.best_bid)
                        .map(|bb| from_money(bb) >= p_src * 0.90)
                        .unwrap_or(false);
                    let hub_arb_ok = snap
                        .quotes
                        .get(&home_hub)
                        .and_then(|m| m.get(item_id))
                        .and_then(|q| q.best_bid)
                        .map(|hbb| from_money(hbb) >= p_src * 1.15)
                        .unwrap_or(false);
                    if (!local_bid_ok || hub_arb_ok) && avail_take >= 6 {
                        price_diff = price_diff.max(0.65);
                    }
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
                best_route = Some((dest.as_str(), total_score, pack));
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
                                    .map(|(it, &q)| {
                                        q - needed_items.get(it.as_str()).copied().unwrap_or(0)
                                    })
                                    .sum()
                            })
                            .unwrap_or(0);
                        let home_g_fuel = snap
                            .planets
                            .get(home_pid)
                            .and_then(|p| p.ground_store.get(fit))
                            .copied()
                            .unwrap_or(0);
                        if (ground_backlog >= 2 || home_g_fuel < 8) && fuel_have >= fuel_req + 1 {
                            let spare_fuel = if home_g_fuel < 8 && fuel_have >= fuel_req + 2 {
                                (fuel_have - fuel_req - 1).min(8).min(ship.capacity)
                            } else {
                                1
                            };
                            best_route =
                                Some((dest.as_str(), 0.35, vec![(fit.to_string(), spare_fuel)]));
                        }
                    } else if (!loc_is_st && dest == &home_sid && (has_needed_at(&home_sid) || has_needed_at(&home_hub)))
                        || (ship.location == home_sid && dest == &home_hub && has_needed_at(&home_hub))
                    {
                        if fuel_have >= fuel_req * 2 + 1 {
                            best_route = Some((dest.as_str(), 0.30, vec![(fit.to_string(), 1)]));
                        }
                    } else if ship.location == home_hub && dest == &home_sid && fuel_have >= fuel_req + 1 {
                        best_route = Some((dest.as_str(), 0.25, vec![(fit.to_string(), 1)]));
                    }
                }
            }
        }

        if let Some((dest, _score, cargo)) = best_route {
            intents.push(Intent::DispatchShip {
                ship_id: ship.id,
                from: ship.location.clone(),
                to: dest.to_string(),
                cargo,
            });
        }
    }

    // 4. Expansion & Bank Head
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
        let exp_score = dot(&genome.expand_w, &[scale_cash, free_ratio, avg_margin, 1.0]);
        let bld_cnt = snap.company.buildings.len();
        let min_exp_cash = (bld_cnt as f64 + 1.0) * 350.0 * snap.cpi;
        if exp_score > 0.65 && avg_margin > 0.05 && cash_f > min_exp_cash && bld_cnt < 6 {
            if let Some(target_plot) = snap.company.plots.iter().find(|p| p.used_slots < p.capacity)
            {
                let p_ground = snap
                    .planets
                    .get(&target_plot.planet_id)
                    .map(|p| &p.ground_store);
                let mut type_counts: HashMap<&str, usize> = HashMap::new();
                for b in &snap.company.buildings {
                    *type_counts.entry(b.building_type.as_str()).or_insert(0) += 1;
                }
                let p_sid = format!("ST:{}", target_plot.planet_id);
                let prof_bonuses = catalog
                    .professions
                    .get(&snap.company.profession)
                    .map(|pr| &pr.efficiency_bonus);
                let mut build_ids: Vec<&String> = catalog.buildings.keys().collect();
                build_ids.sort();
                let best_btype = build_ids
                    .into_iter()
                    .filter(|bt| {
                        let bdef = &catalog.buildings[*bt];
                        let has_mats = bdef.build_cost.iter().all(|req| {
                            p_ground
                                .and_then(|g| g.get(&req.item))
                                .copied()
                                .unwrap_or(0)
                                >= req.qty
                        });
                        let mod_val = target_plot.building_mods.get(*bt).copied().unwrap_or(1.0);
                        let same_cnt = type_counts.get(bt.as_str()).copied().unwrap_or(0);
                        mod_val > 0.0
                            && has_mats
                            && same_cnt < 2
                            && (same_cnt == 0 || cash_f > 1200.0 * snap.cpi)
                    })
                    .filter_map(|bt| {
                        let mod_val = target_plot.building_mods.get(bt).copied().unwrap_or(1.0);
                        let prof_b = prof_bonuses.and_then(|m| m.get(bt)).copied().unwrap_or(1.0);
                        let eff = mod_val * prof_b;
                        let best_rec_score = catalog
                            .recipes_by_building
                            .get(bt)
                            .into_iter()
                            .flatten()
                            .filter_map(|rid| catalog.recipes.get(rid))
                            .map(|r| {
                                let runnable = r.inputs.iter().all(|inp| {
                                    p_ground.and_then(|g| g.get(&inp.item)).copied().unwrap_or(0)
                                        >= inp.qty
                                        || snap
                                            .quotes
                                            .get(&p_sid)
                                            .and_then(|m| m.get(&inp.item))
                                            .and_then(|q| q.best_ask)
                                            .is_some()
                                });
                                let out_v: f64 = r
                                    .outputs
                                    .iter()
                                    .map(|o| o.qty as f64 * eff * est_output_value(&p_sid, &o.item))
                                    .sum();
                                let in_v: f64 = r.labor_cost * snap.cpi
                                    + r.power_cost as f64 * est_input_cost(&p_sid, "power")
                                    + r.inputs
                                        .iter()
                                        .map(|i| i.qty as f64 * est_input_cost(&p_sid, &i.item))
                                        .sum::<f64>();
                                let m = (out_v - in_v) / in_v.max(1.0);
                                if runnable { m } else { m - 5.0 }
                            })
                            .fold(f64::NEG_INFINITY, f64::max);
                        if best_rec_score > -0.5 {
                            Some((bt, best_rec_score + (prof_b - 1.0) * 2.0))
                        } else {
                            None
                        }
                    })
                    .max_by(|a, b| a.1.partial_cmp(&b.1).unwrap_or(std::cmp::Ordering::Equal))
                    .map(|(bt, _)| bt);

                if let Some(btype) = best_btype {
                    intents.push(Intent::BuildFacility {
                        plot_id: target_plot.id,
                        building_type: btype.clone(),
                    });
                }
            } else if snap.company.plots.len() < 4 {
                if let Some(p_view) = snap.planets.get(home_pid) {
                    let best_listing = p_view
                        .land_listings
                        .iter()
                        .min_by_key(|l| l.ask_price);
                    let prim_price = p_view.primary_land_price;
                    let best_unclaimed_slot = snap
                        .public_tiles
                        .get(home_pid)
                        .and_then(|tiles| {
                            tiles
                                .iter()
                                .filter(|t| t.status == "unclaimed")
                                .max_by(|a, b| {
                                    let score = |t: &meridian_core::PublicLandTileView| -> f64 {
                                        let pref_m = match snap.company.profession.as_str() {
                                            "mining_ind" => t.building_mods.get("mine_smelter").copied().unwrap_or(1.0),
                                            "env_recycle" => t.building_mods.get("power_water_station").copied().unwrap_or(1.0),
                                            "agri_bio" => t.building_mods.get("bio_greenhouse").copied().unwrap_or(1.0),
                                            _ => 1.0,
                                        };
                                        pref_m + (t.capacity as f64) * 0.08
                                    };
                                    score(a)
                                        .partial_cmp(&score(b))
                                        .unwrap_or(std::cmp::Ordering::Equal)
                                })
                                .map(|t| t.slot_id)
                        });
                    let (target_slot, target_lid, land_p) = match (best_listing, prim_price, best_unclaimed_slot) {
                        (Some(lst), Some(pp), _) if lst.ask_price <= pp => {
                            (None, Some(lst.listing_id), Some(lst.ask_price))
                        }
                        (Some(lst), None, _) => (None, Some(lst.listing_id), Some(lst.ask_price)),
                        (_, Some(pp), Some(sid)) => (Some(sid), None, Some(pp)),
                        (Some(lst), _, None) => (None, Some(lst.listing_id), Some(lst.ask_price)),
                        _ => (None, None, None),
                    };
                    if let Some(cost) = land_p {
                        if snap.company.cash > cost + to_money(400.0 * snap.cpi) {
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
        let rate_norm = snap
            .planets
            .get(home_pid)
            .map(|p| (p.bank_rate_bps as f64 / 50.0).clamp(0.0, 2.0))
            .unwrap_or(0.5);
        let bank_s = dot(&genome.bank_w, &[scale_cash, debt_ratio, rate_norm, 1.0]);
        if bank_s > 0.75 && cash_f > 600.0 * snap.cpi {
            if debt_f > 10.0 {
                intents.push(Intent::BankOp {
                    planet_id: home_pid.clone(),
                    op: BankOpKind::Repay,
                    amount: to_money((cash_f * 0.25).min(debt_f)),
                });
            } else {
                intents.push(Intent::BankOp {
                    planet_id: home_pid.clone(),
                    op: BankOpKind::Deposit,
                    amount: to_money(cash_f * 0.15),
                });
            }
        } else if bank_s < -0.75 && savings_f > 10.0 {
            intents.push(Intent::BankOp {
                planet_id: home_pid.clone(),
                op: BankOpKind::Withdraw,
                amount: to_money(savings_f * 0.5),
            });
        }
    }

    intents.truncate(MAX_INTENTS_PER_TICK);
    intents
}

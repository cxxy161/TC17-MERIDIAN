//! Zero-hardcoded free-play NPC decision policy driven solely by evolvable `NpcGenome` weights
//! and read-only `WorldSnapshot` + `ProductionCatalog` features.

use std::collections::{HashMap, HashSet};

use meridian_core::{
    from_money, to_money, BankOpKind, Intent, OrderSide, ProductionCatalog, WorldSnapshot,
    MAX_ACTIVE_ORDERS_PER_COMPANY, MAX_INTENTS_PER_TICK,
};
use serde::{Deserialize, Serialize};

/// Compact evolvable weights for all 4 NPC policy heads (zero hardcoded strategy rules).
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
    /// Price offset weights: [ema_fast_dev, spread, inv_ratio, bias] -> tanh * 0.30
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
        let mut s = || rng.next_signed(1.0);
        Self {
            prod_w: [s(), s(), s(), s(), s() * 0.2],
            active_w: [s(), s(), s() * 0.2],
            buy_w: [s(), s(), s(), s(), s(), s() * 0.3],
            sell_w: [s(), s(), s(), s(), s(), s() * 0.3],
            price_off_w: [s(), s(), s(), s() * 0.15],
            logi_w: [s(), s(), s(), s() * 0.2],
            repair_w: [s(), s(), s() * 0.2],
            expand_w: [s(), s(), s(), s() * 0.3],
            bank_w: [s(), s(), s(), s() * 0.2],
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
    let cash_f = from_money(snap.company.cash).max(0.0);
    let savings_f = from_money(snap.company.savings).max(0.0);
    let debt_f = from_money(snap.company.debt).max(0.0);
    let scale_cash = (cash_f / (1000.0 * snap.cpi.max(0.25))).clamp(0.0, 2.0);
    let debt_ratio = (debt_f / (cash_f + savings_f + 500.0 * snap.cpi.max(0.25))).clamp(0.0, 4.0);

    let est_item_price = |station: &str, item_id: &str| -> f64 {
        snap.quotes
            .get(station)
            .and_then(|m| m.get(item_id))
            .map(|q| from_money(q.last_price))
            .or_else(|| catalog.items.get(item_id).map(|i| i.ref_price * snap.cpi))
            .unwrap_or(1.0)
            .max(0.01)
    };

    // 1. Production Head: pick highest-scoring recipe & active state per building
    let mut avg_margin_sum = 0.0;
    let mut avg_margin_cnt = 0usize;

    for bld in &snap.company.buildings {
        if intents.len() >= MAX_INTENTS_PER_TICK {
            break;
        }
        let Some(valid_recipes) = catalog.recipes_by_building.get(&bld.building_type) else {
            continue;
        };
        let b_sid = format!("ST:{}", bld.planet_id);
        let p_ground = snap.planets.get(&bld.planet_id).map(|p| &p.ground_store);

        let mut best_rid: Option<&str> = None;
        let mut best_score = f64::NEG_INFINITY;
        let mut best_margin = 0.0;

        for rid in valid_recipes {
            let Some(r) = catalog.recipes.get(rid) else {
                continue;
            };
            let mut in_cost = r.labor_cost * snap.cpi;
            if r.power_cost > 0 {
                in_cost += r.power_cost as f64 * est_item_price(&b_sid, "power");
            }
            let mut min_cov = 1.0f64;
            for inp in &r.inputs {
                in_cost += inp.qty as f64 * est_item_price(&b_sid, &inp.item);
                let have = p_ground.and_then(|g| g.get(&inp.item)).copied().unwrap_or(0) as f64;
                min_cov = min_cov.min((have / inp.qty.max(1) as f64).clamp(0.0, 2.0));
            }
            let mut out_val = 0.0;
            let mut out_stock_ratio = 0.0;
            for out in &r.outputs {
                let p = est_item_price(&b_sid, &out.item);
                out_val += out.qty as f64 * bld.efficiency * p;
                let have = p_ground.and_then(|g| g.get(&out.item)).copied().unwrap_or(0) as f64;
                out_stock_ratio += (have / (out.qty.max(1) as f64 * 20.0)).clamp(0.0, 2.0);
            }
            let margin = ((out_val - in_cost) / in_cost.max(1.0)).clamp(-1.0, 3.0);
            let out_stock = out_stock_ratio / r.outputs.len().max(1) as f64;
            let score = dot(&genome.prod_w, &[margin, min_cov, out_stock, scale_cash, 1.0]);
            if score > best_score {
                best_score = score;
                best_rid = Some(rid.as_str());
                best_margin = margin;
            }
        }

        avg_margin_sum += best_margin;
        avg_margin_cnt += 1;

        if let Some(target_rid) = best_rid {
            if target_rid != bld.recipe_id && intents.len() < MAX_INTENTS_PER_TICK {
                intents.push(Intent::SetRecipe {
                    building_id: bld.id,
                    recipe_id: target_rid.to_string(),
                });
            }
        }
        let act_score = dot(&genome.active_w, &[best_margin, scale_cash, 1.0]);
        let want_active = act_score > 0.0;
        if want_active != bld.active && intents.len() < MAX_INTENTS_PER_TICK {
            intents.push(Intent::ToggleBuilding {
                building_id: bld.id,
                active: want_active,
            });
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

    let watched_stations = [home_sid.as_str(), "ST:HUB"];
    let mut item_ids: Vec<&String> = catalog.items.keys().collect();
    item_ids.sort();

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
            if intents.len() >= MAX_INTENTS_PER_TICK || active_orders_left == 0 {
                break;
            }
            let Some(q) = station_quotes.get(*item_id) else {
                continue;
            };
            let last_p = from_money(q.last_price).max(0.01);
            let fast_dev = ((last_p - from_money(q.ema_fast)) / last_p).clamp(-0.5, 0.5);
            let slow_dev = ((last_p - from_money(q.ema_slow)) / last_p).clamp(-0.5, 0.5);
            let spread = match (q.best_bid, q.best_ask) {
                (Some(b), Some(a)) if a > b => {
                    (from_money(a - b) / last_p).clamp(0.0, 1.0)
                }
                _ => 0.25,
            };
            let inv_qty = st_inv.and_then(|m| m.get(*item_id)).copied().unwrap_or(0)
                + if catalog
                    .items
                    .get(*item_id)
                    .map(|i| i.has_tag("instant"))
                    .unwrap_or(false)
                {
                    g_inv.and_then(|m| m.get(*item_id)).copied().unwrap_or(0)
                } else {
                    0
                };
            let inv_ratio = (inv_qty as f64 / 30.0).clamp(0.0, 2.0);

            let feats = [spread, fast_dev, slow_dev, inv_ratio, scale_cash, 1.0];
            let b_score = dot(&genome.buy_w, &feats);
            let s_score = dot(&genome.sell_w, &feats);

            let off = (dot(&genome.price_off_w, &[fast_dev, spread, inv_ratio, 1.0]).tanh()) * 0.30;
            let target_price_f = (last_p * (1.0 + off)).max(0.02);
            let target_price = to_money(target_price_f);

            let existing = own_orders_by_key.get(&(sid.to_string(), (*item_id).clone()));

            // Decide Buy vs Sell vs Hold purely from policy head winner above 0.5 threshold
            let (want_side, qty) = if s_score > b_score && s_score > 0.45 && inv_qty > 0 {
                let q = ((inv_qty as f64 * (s_score / 3.0).clamp(0.15, 0.8)).round() as u32)
                    .clamp(1, inv_qty);
                (Some(OrderSide::Sell), q)
            } else if b_score > s_score && b_score > 0.45 && cash_f > target_price_f * 2.0 {
                let budget = cash_f * (b_score / 6.0).clamp(0.03, 0.20);
                let q = ((budget / target_price_f).floor() as u32).clamp(1, 25);
                (Some(OrderSide::Buy), q)
            } else {
                (None, 0)
            };

            if let Some(side) = want_side {
                let mut skip_create = false;
                if let Some(olist) = existing {
                    for o in olist {
                        let price_diff = ((from_money(o.price) - target_price_f).abs()
                            / target_price_f.max(0.01))
                            > 0.08;
                        if o.side != side || price_diff {
                            if intents.len() < MAX_INTENTS_PER_TICK {
                                intents.push(Intent::CancelOrder {
                                    order_id: o.order_id,
                                });
                            }
                        } else {
                            skip_create = true;
                        }
                    }
                }
                if !skip_create && intents.len() < MAX_INTENTS_PER_TICK && active_orders_left > 0 {
                    intents.push(Intent::CreateOrder {
                        station_id: sid.to_string(),
                        side,
                        item_id: (*item_id).clone(),
                        qty,
                        price: target_price,
                    });
                    active_orders_left -= 1;
                }
            }
        }
    }

    // 3. Logistics Head: evaluate idle ships across valid routes & physical items
    let repair_item = catalog.repair_item.as_deref();
    let fuel_item = catalog.fuel_item.as_deref();
    let candidate_nodes: Vec<String> = {
        let mut nodes = vec![home_pid.clone(), home_sid.clone(), "ST:HUB".to_string()];
        for pid in snap.planets.keys() {
            if pid != home_pid {
                nodes.push(format!("ST:{pid}"));
            }
        }
        nodes
    };

    for ship in &snap.company.ships {
        if intents.len() >= MAX_INTENTS_PER_TICK || ship.is_busy {
            continue;
        }
        let loc_store = if ship.location.starts_with("ST:") {
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
            let src_sid = if ship.location.starts_with("ST:") {
                ship.location.clone()
            } else {
                format!("ST:{}", ship.location)
            };
            let dst_sid = if dest.starts_with("ST:") {
                dest.clone()
            } else {
                format!("ST:{dest}")
            };

            let mut scored_cargo: Vec<(String, u32, f64)> = Vec::new();
            for (item_id, &have) in src_store {
                if have == 0 {
                    continue;
                }
                if catalog
                    .items
                    .get(item_id)
                    .map(|i| i.has_tag("instant"))
                    .unwrap_or(false)
                {
                    continue;
                }
                let avail_take = if Some(item_id.as_str()) == fuel_item {
                    have.saturating_sub(fuel_req)
                } else {
                    have
                };
                if avail_take == 0 {
                    continue;
                }
                let p_src = est_item_price(&src_sid, item_id);
                let p_dst = est_item_price(&dst_sid, item_id);
                let price_diff = ((p_dst - p_src) / p_src.max(0.01)).clamp(-1.0, 2.0);
                let avail_r = (avail_take as f64 / ship.capacity.max(1) as f64).clamp(0.0, 1.0);
                let fuel_r = (fuel_req as f64 / (ticks.max(1) as f64 * 10.0)).clamp(0.0, 1.0);
                let s = dot(&genome.logi_w, &[price_diff, avail_r, fuel_r, 1.0]);
                if s > 0.25 {
                    scored_cargo.push((item_id.clone(), avail_take, s));
                }
            }
            scored_cargo.sort_by(|a, b| b.2.partial_cmp(&a.2).unwrap_or(std::cmp::Ordering::Equal));
            let mut rem_cap = ship.capacity;
            let mut pack = Vec::new();
            let mut total_score = 0.0;
            for (it, max_q, s) in scored_cargo {
                if rem_cap == 0 {
                    break;
                }
                let take = max_q.min(rem_cap);
                if take > 0 {
                    rem_cap -= take;
                    total_score += s * (take as f64 / ship.capacity.max(1) as f64);
                    pack.push((it, take));
                }
            }
            if !pack.is_empty()
                && best_route
                    .as_ref()
                    .map(|br| total_score > br.1)
                    .unwrap_or(true)
            {
                best_route = Some((dest.as_str(), total_score, pack));
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
        if exp_score > 0.65 {
            if let Some(target_plot) = snap.company.plots.iter().find(|p| p.used_slots < p.capacity) {
                let p_ground = snap
                    .planets
                    .get(&target_plot.planet_id)
                    .map(|p| &p.ground_store);
                let owned_types: HashSet<&str> = snap
                    .company
                    .buildings
                    .iter()
                    .map(|b| b.building_type.as_str())
                    .collect();
                let mut build_ids: Vec<&String> = catalog.buildings.keys().collect();
                build_ids.sort();
                if let Some(btype) = build_ids.into_iter().find(|bt| {
                    let bdef = &catalog.buildings[*bt];
                    let has_mats = bdef.build_cost.iter().all(|req| {
                        p_ground
                            .and_then(|g| g.get(&req.item))
                            .copied()
                            .unwrap_or(0)
                            >= req.qty
                    });
                    has_mats && (!owned_types.contains(bt.as_str()) || cash_f > 400.0 * snap.cpi)
                }) {
                    intents.push(Intent::BuildFacility {
                        plot_id: target_plot.id,
                        building_type: btype.clone(),
                    });
                }
            } else if let Some(land_p) = snap
                .planets
                .get(home_pid)
                .and_then(|p| p.primary_land_price)
            {
                if snap.company.cash > land_p + to_money(200.0 * snap.cpi) {
                    intents.push(Intent::BuyPlot {
                        planet_id: home_pid.clone(),
                        listing_id: None,
                    });
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

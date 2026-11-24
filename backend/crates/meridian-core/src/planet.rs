//! Planet geography (lazy plot instantiation), 5-tier planetary wealth & demands, waste emission, and PlanetBank.

use std::collections::{HashMap, VecDeque};

use serde::{Deserialize, Serialize};

use crate::schema::ProductionCatalog;
use crate::types::{
    BuildingId, BuildingTypeId, CompanyId, ItemId, ListingId, Money, PlanetId, PlotId, RecipeId,
    StationId, to_money,
};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PlanetBank {
    pub planet_id: PlanetId,
    pub annual_rate_bps: u32,
    pub reserves: Money,
    pub total_deposits: Money,
    pub total_loans: Money,
}

impl PlanetBank {
    pub fn new(planet_id: impl Into<PlanetId>, reserves: Money) -> Self {
        Self {
            planet_id: planet_id.into(),
            annual_rate_bps: 500, // 5.0%
            reserves,
            total_deposits: 0,
            total_loans: 0,
        }
    }

    pub fn loan_tick_rate(&self) -> f64 {
        (self.annual_rate_bps as f64 / 10_000.0) / 8640.0
    }

    pub fn deposit_tick_rate(&self) -> f64 {
        self.loan_tick_rate() * 0.5
    }

    pub fn update_policy(&mut self, prosperity: f64, avg_price_ratio: f64) {
        let mut target_bps =
            300.0 + (avg_price_ratio - 1.0).max(0.0) * 600.0 + (prosperity - 1.0).max(0.0) * 300.0;
        if prosperity < 0.6 {
            target_bps = target_bps.min(200.0);
        }
        let backing = (self.reserves + self.total_deposits).max(1) as f64;
        let util = (self.total_loans as f64 / backing).clamp(0.0, 2.0);
        target_bps += (util * 300.0).min(800.0);
        let clamped = target_bps.clamp(50.0, 1800.0);
        let blended = self.annual_rate_bps as f64 * 0.85 + clamped * 0.15;
        self.annual_rate_bps = blended.round() as u32;
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct BuildingInstance {
    pub id: BuildingId,
    pub owner_id: CompanyId,
    pub plot_id: PlotId,
    pub planet_id: PlanetId,
    pub building_type: BuildingTypeId,
    pub efficiency: f64,
    pub recipe_id: RecipeId,
    pub active: bool,
    pub progress: u32,
    pub active_batch: bool,
    pub standby_ticks: u32,
    #[serde(default)]
    pub idle_ticks: u32,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SiteJob {
    pub action: String, // "build" or "demolish"
    pub building_type: BuildingTypeId,
    pub finish_tick: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Plot {
    pub id: PlotId,
    pub planet_id: PlanetId,
    pub owner_id: Option<CompanyId>,
    pub terrain_name: String,
    pub building_mods: HashMap<BuildingTypeId, f64>,
    pub capacity: u32,
    pub building_ids: Vec<BuildingId>,
    pub jobs: Vec<SiteJob>,
}

impl Plot {
    pub fn used_slots(&self) -> u32 {
        (self.building_ids.len() + self.jobs.len()) as u32
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct LandListing {
    pub listing_id: ListingId,
    pub plot_id: PlotId,
    pub seller_id: String, // company id or "BANK"
    pub ask_price: Money,
    pub listed_tick: u64,
    pub debt_recovery: Money,
}

fn default_system_id() -> String {
    "S1".to_string()
}

fn default_rotation_days() -> f64 {
    6.0
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct StarSystem {
    pub id: String,
    pub name: String,
    pub star_class: String,
    pub luminosity: f64,
    pub x: f64,
    pub y: f64,
    pub hub_station_id: StationId,
    pub hub_orbit_radius: f64,
    pub hub_orbit_days: f64,
    pub hub_orbit_angle: f64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Planet {
    pub id: PlanetId,
    #[serde(default = "default_system_id")]
    pub system_id: String,
    pub name: String,
    pub archetype: String,
    pub station_id: StationId,
    pub orbit_radius: f64,
    pub orbit_period_days: f64,
    pub orbit_angle: f64,
    #[serde(default = "default_rotation_days")]
    pub rotation_days: f64,
    #[serde(default)]
    pub visual_seed: u32,
    pub gravity: f64,
    pub solar_mult: f64,
    pub mineral_mult: f64,
    pub water_mult: f64,
    pub ocean_ratio: f64,
    #[serde(default)]
    pub habitability: f64,

    pub city_count: u32,
    pub city_level: u32,
    pub city_capacity: f64,
    pub population: f64,
    pub wealth_tier: u8,
    pub prosperity: f64,
    pub prosperity_window: VecDeque<f64>,

    pub treasury: Money,
    pub civic_output_per_capita: f64,
    pub waste_backlog: u32,
    pub bank: PlanetBank,

    /// Lazy plot pool: only claimed/listed plots allocate Plot structs.
    pub total_developable_plots: u32,
    pub unclaimed_plots_remaining: u32,
    pub next_local_plot_seq: u32,
    pub land_listings: Vec<LandListing>,

    pub last_demands: HashMap<ItemId, u32>,
    pub last_bought: HashMap<ItemId, u32>,
    pub bought_this_tick: HashMap<ItemId, u32>,
    pub prev_bids: HashMap<ItemId, Money>,
}

impl Planet {
    pub fn launch_ticks_mult(&self) -> f64 {
        0.6 + self.gravity * 0.7
    }

    pub fn launch_fuel_mult(&self) -> f64 {
        0.6 + self.gravity * 0.8
    }

    pub fn primary_land_price(&self, cpi: f64) -> Money {
        let avail = self.unclaimed_plots_remaining.max(1) as f64;
        let scarcity = (self.total_developable_plots as f64 / avail.max(15.0)).clamp(0.8, 4.0);
        let prosp_mult = self.prosperity.clamp(0.5, 3.0);
        to_money(320.0 * cpi.max(0.4) * prosp_mult * scarcity * 0.45)
    }

    /// Deterministically materialize one unclaimed plot on demand (saves ~90% plot RAM).
    pub fn materialize_primary_plot(&mut self, global_plot_id: PlotId, catalog: &ProductionCatalog) -> Option<Plot> {
        if self.unclaimed_plots_remaining == 0 {
            return None;
        }
        self.unclaimed_plots_remaining -= 1;
        let seq = self.next_local_plot_seq;
        self.next_local_plot_seq += 1;

        let terrain_name = match (self.archetype.as_str(), seq % 3) {
            ("矿业岩星", 0) => "高山矿脉",
            ("矿业岩星", 1) => "硅岩戈壁",
            ("矿业岩星", _) => "赤铁裂谷",
            ("宜居主星", 0) => "温带平原",
            ("宜居主星", 1) => "工业平原",
            ("宜居主星", _) => "河谷湿地",
            (_, 0) => "冰原冻土",
            (_, 1) => "晶矿台地",
            _ => "低重平谷",
        }
        .to_string();

        // Deterministic slight efficiency spread around planet specialty multipliers
        let jitter = 0.92 + ((seq.wrapping_mul(2654435761) % 17) as f64) * 0.01;
        let mut building_mods = HashMap::new();
        for (bid, _bdef) in &catalog.buildings {
            let mult = match bid.as_str() {
                "power_water_station" => {
                    if self.solar_mult >= 1.2 || self.water_mult >= 1.2 {
                        (self.solar_mult.max(self.water_mult) * 0.85 * jitter).clamp(0.75, 1.8)
                    } else {
                        jitter
                    }
                }
                "bio_greenhouse" | "consumer_workshop" => {
                    if self.city_count > 0 {
                        (1.25 * jitter).clamp(0.8, 1.6)
                    } else {
                        (0.80 * jitter).clamp(0.6, 1.2)
                    }
                }
                "mine_smelter" => (self.mineral_mult * jitter).clamp(0.7, 1.8),
                _ => jitter.clamp(0.85, 1.25),
            };
            building_mods.insert(bid.clone(), (mult * 100.0).round() / 100.0);
        }

        Some(Plot {
            id: global_plot_id,
            planet_id: self.id.clone(),
            owner_id: None,
            terrain_name,
            building_mods,
            capacity: 5,
            building_ids: Vec::new(),
            jobs: Vec::new(),
        })
    }

    pub fn compute_demands(&self, catalog: &ProductionCatalog) -> HashMap<ItemId, u32> {
        let mut demands = HashMap::new();
        if self.city_count == 0 || self.population <= 0.0 {
            return demands;
        }
        // Harsher inhabited colonies require slightly more life-support supplies per capita.
        let hab = if self.habitability > 0.0 {
            self.habitability.clamp(0.05, 1.0)
        } else {
            0.85
        };
        let env_mult = 1.0 + (1.0 - hab).max(0.0) * 0.35;
        for it in catalog.items.values() {
            if it.wealth_tier <= self.wealth_tier && it.base_demand_per_1k > 0.0 {
                let mut qty = ((self.population / 1000.0) * it.base_demand_per_1k * env_mult)
                    .round() as u32;
                if it.id == "disposal_cert" {
                    // Waste accumulation boosts disposal certificate demand
                    let extra = (self.waste_backlog / 12).min(qty.saturating_mul(2) + 4);
                    qty = qty.saturating_add(extra);
                }
                demands.insert(it.id.clone(), qty.max(1));
            }
        }
        if self.population >= self.city_capacity * 0.82 && catalog.items.contains_key("building_mat") {
            let e = demands.entry("building_mat".to_string()).or_insert(0);
            *e += (self.city_level * 2).max(2);
        }
        demands
    }

    pub fn finish_city_tick(&mut self, demands: &HashMap<ItemId, u32>, catalog: &ProductionCatalog) {
        if self.city_count == 0 || demands.is_empty() {
            return;
        }
        let mut sat_sum: f64 = 0.0;
        let mut w_sum: f64 = 0.0;
        let mut new_waste = 0u32;
        let mut cleared_waste = 0u32;

        for (item_id, &want) in demands {
            let got = *self.bought_this_tick.get(item_id).unwrap_or(&0);
            let sat = (got as f64 / want.max(1) as f64).min(1.0);
            sat_sum += sat;
            w_sum += 1.0;

            if item_id == "disposal_cert" {
                cleared_waste += got;
            } else if let Some(it) = catalog.items.get(item_id) {
                if it.role == crate::schema::ItemRole::PlanetSupply {
                    // Every 2 units of physical consumer supplies consumed emits ~1 unit of city waste
                    new_waste += (got + 1) / 2;
                }
            }
        }

        self.waste_backlog = self.waste_backlog.saturating_add(new_waste).saturating_sub(cleared_waste);
        let avg_sat = sat_sum / w_sum.max(1.0);
        self.prosperity_window.push_back(avg_sat);
        while self.prosperity_window.len() > 240 {
            self.prosperity_window.pop_front();
        }
        let win_sat = self.prosperity_window.iter().sum::<f64>() / self.prosperity_window.len().max(1) as f64;

        let delta = if win_sat > 0.78 {
            ((win_sat - 0.78) * 0.004).min(0.0008)
        } else if win_sat < 0.62 {
            ((win_sat - 0.62) * 0.002).max(-0.0004)
        } else {
            0.0
        };
        self.prosperity = (self.prosperity + delta).clamp(0.30, 5.0);

        // 5-tier wealth graduation with gentle hysteresis (never locks below Tier 1)
        let target_tier = if self.prosperity >= 3.0 {
            5
        } else if self.prosperity >= 2.2 {
            4
        } else if self.prosperity >= 1.6 {
            3
        } else if self.prosperity >= 1.15 {
            2
        } else {
            1
        };
        if target_tier > self.wealth_tier {
            self.wealth_tier = self.wealth_tier.saturating_add(1).min(5);
        } else if target_tier < self.wealth_tier && self.prosperity < (target_tier as f64 * 0.55) {
            self.wealth_tier = self.wealth_tier.saturating_sub(1).max(1);
        }

        // City capacity vertical upgrade
        let mat_bought = *self.bought_this_tick.get("building_mat").unwrap_or(&0);
        if self.population >= self.city_capacity * 0.85 && mat_bought >= 2 {
            self.city_level += 1;
            self.city_capacity += (self.city_count * 1000) as f64;
        }

        if self.prosperity_window.len() >= 120 {
            if self.prosperity > 0.85 {
                let grown = self.population * (1.0 + 0.00018 * (self.prosperity - 0.75));
                self.population = grown.min(self.city_capacity);
            } else if self.prosperity < 0.50 {
                self.population = (self.population * 0.99994).max(500.0);
            }
        }
    }
}

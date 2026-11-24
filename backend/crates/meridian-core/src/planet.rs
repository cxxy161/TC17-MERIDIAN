//! Planet geography (lazy plot instantiation), 5-tier planetary wealth & demands, waste emission, and PlanetBank.

use std::collections::{HashMap, VecDeque};

use serde::{Deserialize, Serialize};

use crate::schema::ProductionCatalog;
use crate::types::{
    BuildingId, BuildingTypeId, CompanyId, ItemId, ListingId, Money, PlanetId, PlotId, RecipeId,
    SlotId, StationId, to_money,
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
    #[serde(default)]
    pub slot_id: SlotId,
    pub planet_id: PlanetId,
    #[serde(default)]
    pub lat: f64,
    #[serde(default)]
    pub lon: f64,
    pub owner_id: Option<CompanyId>,
    pub terrain_name: String,
    pub building_mods: HashMap<BuildingTypeId, f64>,
    pub capacity: u32,
    pub building_ids: Vec<BuildingId>,
    pub jobs: Vec<SiteJob>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SurfaceTile {
    pub slot_id: SlotId,
    pub lat: f64,
    pub lon: f64,
    pub terrain_name: String,
    pub capacity: u32,
    pub building_mods: HashMap<BuildingTypeId, f64>,
    pub is_city: bool,
    pub city_name: Option<String>,
    pub owner_id: Option<CompanyId>,
    pub plot_id: Option<PlotId>,
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

    /// Pre-generated planetary surface tiles (cities + all developable positions).
    pub total_developable_plots: u32,
    pub unclaimed_plots_remaining: u32,
    pub next_local_plot_seq: u32,
    #[serde(default)]
    pub surface_tiles: Vec<SurfaceTile>,
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

    /// Deterministically populate the entire planetary surface grid (`city_count` cities +
    /// `total_developable_plots` buildable positions) with coordinates, terrain, and multipliers.
    pub fn build_surface_tiles(&mut self, catalog: &ProductionCatalog) {
        let total = (self.city_count + self.total_developable_plots) as usize;
        if total == 0 {
            self.surface_tiles.clear();
            self.unclaimed_plots_remaining = 0;
            return;
        }
        let seed_u = (self.visual_seed as u64).wrapping_mul(0x9E37_79B9_7F4A_7C15) ^ 0x517C_C1B7_2722_0A95;
        let golden_angle = std::f64::consts::PI * (3.0 - 5.0_f64.sqrt());
        let mut raw_coords: Vec<(f64, f64, u64)> = Vec::with_capacity(total);
        for i in 0..total {
            let frac = (i as f64 + 0.5) / (total as f64);
            let y = 1.0 - 2.0 * frac;
            let lat = (y.asin().to_degrees() * 0.90 * 10.0).round() / 10.0;
            let theta = (i as f64) * golden_angle + ((seed_u & 0xFF) as f64) * 0.03;
            let mut lon = ((theta.to_degrees() + 180.0).rem_euclid(360.0)) - 180.0;
            lon = (lon * 10.0).round() / 10.0;
            let mut h = seed_u ^ ((i as u64 + 1).wrapping_mul(0xBF58_476D_1CE4_E5B9));
            h = (h ^ (h >> 30)).wrapping_mul(0x94D0_49BB_1331_11EB);
            h ^= h >> 31;
            raw_coords.push((lat, lon, h));
        }

        // Assign cities to lowest-latitude (most temperate) slots
        let mut city_indices: Vec<usize> = (0..total).collect();
        city_indices.sort_by(|&a, &b| {
            raw_coords[a]
                .0
                .abs()
                .partial_cmp(&raw_coords[b].0.abs())
                .unwrap_or(std::cmp::Ordering::Equal)
        });
        let city_set: std::collections::HashSet<usize> = city_indices
            .into_iter()
            .take(self.city_count as usize)
            .collect();
        let city_suffixes = [
            "中央城", "港湾市", "星港区", "晨光镇", "东谷市",
            "新穹顶", "海湾城", "绿洲市", "北岭区", "环带城",
        ];

        let mut tiles = Vec::with_capacity(total);
        let mut city_seq = 0usize;
        for (idx, (lat, lon, h)) in raw_coords.into_iter().enumerate() {
            let slot_id = (idx + 1) as SlotId;
            let is_city = city_set.contains(&idx);
            let u0 = ((h & 0xFFFF) as f64) / 65535.0;
            let u1 = (((h >> 16) & 0xFFFF) as f64) / 65535.0;
            let abs_lat = lat.abs();

            let (terrain_name, spec_mine, spec_pw, spec_bio, spec_cap) = if is_city {
                ("城市规划区", 0.0, 0.0, 0.0, 0u32)
            } else if self.solar_mult > 1.55 && self.ocean_ratio < 0.15 {
                match h % 4 {
                    0 => ("玄武岩矿脉", 1.38, 0.95, 0.72, 4),
                    1 => ("赤铁深裂谷", 1.45, 0.85, 0.68, 3),
                    2 => ("阳坡硅原", 1.05, 1.40, 0.75, 5),
                    _ => ("焦土台地", 1.15, 1.22, 0.78, 4),
                }
            } else if self.habitability >= 0.56 {
                if abs_lat >= 52.0 {
                    if u0 > 0.5 {
                        ("寒岭矿区", 1.28, 0.92, 0.86, 4)
                    } else {
                        ("高纬冻原", 1.02, 1.25, 0.92, 5)
                    }
                } else if self.ocean_ratio >= 0.35 && u0 > 0.55 {
                    ("沿海冲积平原", 0.88, 1.22, 1.35, 6)
                } else if u1 > 0.68 {
                    ("金属山脊", 1.34, 0.95, 0.90, 3)
                } else if u1 < 0.33 {
                    ("温带河谷", 0.92, 1.08, 1.36, 5)
                } else {
                    ("工业平谷", 1.10, 1.12, 1.12, 5)
                }
            } else if self.solar_mult < 0.60 {
                match h % 4 {
                    0 => ("冰川储水原", 0.92, 1.36, 0.82, 5),
                    1 => ("深冻晶脉", 1.32, 0.95, 0.75, 4),
                    2 => ("玄冰台地", 1.10, 1.12, 0.80, 4),
                    _ => ("裂隙低谷", 1.20, 1.02, 0.85, 5),
                }
            } else {
                match h % 4 {
                    0 => ("红岩矿谷", 1.32, 0.95, 0.84, 4),
                    1 => ("风蚀高地", 1.12, 1.26, 0.88, 4),
                    2 => ("绿洲盆地", 0.90, 1.12, 1.24, 5),
                    _ => ("砾石平原", 1.05, 1.08, 0.96, 6),
                }
            };

            let jitter = 0.92 + u0 * 0.18;
            let lat_solar_factor = (1.12 - (abs_lat / 90.0) * 0.28).clamp(0.82, 1.14);
            let mut building_mods = HashMap::new();
            if !is_city {
                for bid in catalog.buildings.keys() {
                    let raw_mult = match bid.as_str() {
                        "power_water_station" => {
                            let base = self.solar_mult.max(self.water_mult) * 0.88;
                            base.max(0.85) * spec_pw * lat_solar_factor * jitter
                        }
                        "bio_greenhouse" | "consumer_workshop" => {
                            let city_bonus = if self.city_count > 0 { 1.12 } else { 0.82 };
                            city_bonus * spec_bio * jitter
                        }
                        "mine_smelter" => self.mineral_mult * spec_mine * jitter,
                        _ => (0.94 + u1 * 0.22) * (if spec_cap >= 5 { 1.05 } else { 0.96 }),
                    };
                    building_mods.insert(bid.clone(), (raw_mult.clamp(0.65, 1.95) * 100.0).round() / 100.0);
                }
            }

            let city_name = if is_city {
                let base = self.name.split('-').next().unwrap_or(&self.name);
                let suf = city_suffixes[city_seq % city_suffixes.len()];
                city_seq += 1;
                Some(format!("{base}{suf}"))
            } else {
                None
            };

            tiles.push(SurfaceTile {
                slot_id,
                lat,
                lon,
                terrain_name: terrain_name.to_string(),
                capacity: spec_cap,
                building_mods,
                is_city,
                city_name,
                owner_id: None,
                plot_id: None,
            });
        }
        self.surface_tiles = tiles;
        self.recompute_unclaimed_count();
    }

    pub fn recompute_unclaimed_count(&mut self) {
        self.unclaimed_plots_remaining = self
            .surface_tiles
            .iter()
            .filter(|t| !t.is_city && t.owner_id.is_none() && t.plot_id.is_none())
            .count() as u32;
    }

    pub fn unclaimed_slot_ids(&self) -> Vec<SlotId> {
        self.surface_tiles
            .iter()
            .filter(|t| !t.is_city && t.owner_id.is_none() && t.plot_id.is_none())
            .map(|t| t.slot_id)
            .collect()
    }

    pub fn set_tile_owner(&mut self, slot_id: SlotId, owner_id: Option<CompanyId>, plot_id: Option<PlotId>) {
        if let Some(tile) = self.surface_tiles.iter_mut().find(|t| t.slot_id == slot_id) {
            tile.owner_id = owner_id;
            if plot_id.is_some() {
                tile.plot_id = plot_id;
            }
        }
        self.recompute_unclaimed_count();
    }

    /// Claim either an explicit `slot_id` or (for internal/NPC spawns) the best matching unclaimed tile.
    pub fn claim_surface_tile(
        &mut self,
        slot_id: Option<SlotId>,
        preferred_prof: Option<&str>,
        global_plot_id: PlotId,
        owner_id: Option<CompanyId>,
        catalog: &ProductionCatalog,
    ) -> Option<Plot> {
        if self.surface_tiles.is_empty() && self.total_developable_plots > 0 {
            self.build_surface_tiles(catalog);
        }
        let target_idx = if let Some(sid) = slot_id {
            self.surface_tiles
                .iter()
                .position(|t| t.slot_id == sid && !t.is_city && t.owner_id.is_none() && t.plot_id.is_none())?
        } else {
            let best = self
                .surface_tiles
                .iter()
                .enumerate()
                .filter(|(_, t)| !t.is_city && t.owner_id.is_none() && t.plot_id.is_none())
                .max_by(|(ia, ta), (ib, tb)| {
                    let score = |t: &SurfaceTile| -> f64 {
                        let pref_mod = match preferred_prof {
                            Some("mining_ind") => t.building_mods.get("mine_smelter").copied().unwrap_or(1.0),
                            Some("env_recycle") => t.building_mods.get("power_water_station").copied().unwrap_or(1.0),
                            Some("agri_bio") => t.building_mods.get("bio_greenhouse").copied().unwrap_or(1.0),
                            _ => t.building_mods.values().sum::<f64>() / t.building_mods.len().max(1) as f64,
                        };
                        pref_mod + (t.capacity as f64) * 0.08
                    };
                    score(ta)
                        .partial_cmp(&score(tb))
                        .unwrap_or(std::cmp::Ordering::Equal)
                        .then_with(|| ib.cmp(ia))
                })?;
            best.0
        };

        let tile = &mut self.surface_tiles[target_idx];
        tile.owner_id = owner_id.clone();
        tile.plot_id = Some(global_plot_id);
        let plot = Plot {
            id: global_plot_id,
            slot_id: tile.slot_id,
            planet_id: self.id.clone(),
            lat: tile.lat,
            lon: tile.lon,
            owner_id,
            terrain_name: tile.terrain_name.clone(),
            building_mods: tile.building_mods.clone(),
            capacity: tile.capacity,
            building_ids: Vec::new(),
            jobs: Vec::new(),
        };
        self.recompute_unclaimed_count();
        Some(plot)
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

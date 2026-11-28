//! Deterministic Two-Phase World simulation kernel.

use std::collections::{BTreeMap, HashMap, VecDeque};
use std::sync::Arc;

use serde::{Deserialize, Serialize};

use crate::company::Company;
use crate::exchange::{CLOBStation, Order, TradeFill};
use crate::ledger::MoneyLedger;
use crate::logistics::{compute_route_in_systems, RouteKind, Ship, ShipInFlight, ShipSize};
use crate::planet::{BuildingInstance, LandListing, Planet, PlanetBank, Plot, SiteJob, StarSystem};
use crate::schema::{ItemRole, ProductionCatalog};
use crate::snapshot::{
    BuildingView, LandListingView, PlanetView, PlotView, PublicCompanyDetail,
    PublicCompanyPlotView, PublicCompanySummary, PublicLandTileView, SelfView, SharedSnapshot,
    ShipCountsView, ShipView, SiteView, StarSystemView, WorldSnapshot,
};
use crate::types::{
    bps_of, checked_notional, from_money, price_band_max, price_in_band, to_money, BankOpKind,
    BuildingId, CompanyId, Intent, ItemId, ListingId, Money, OrderId, OrderSide, PlanetId, PlotId,
    RejectedIntent, RetCode, ShipId, SlotId, StationId, BANK_MIN_RESERVE_BPS, ERR_BUSY, ERR_FULL,
    ERR_INVALID_ARGS, ERR_INVALID_TARGET, ERR_NOT_ENOUGH_CREDITS, ERR_NOT_ENOUGH_RESOURCES,
    ERR_NOT_FOUND, ERR_NOT_IN_RANGE, ERR_NOT_OWNER, ERR_NO_PATH, LOAN_TERM_TICKS,
    MAX_ACTIVE_ORDERS_PER_COMPANY, MAX_INTENTS_PER_TICK, MAX_ORDER_QTY, MONEY_SCALE,
    OVERDUE_GARNISH_BPS,
};

/// Saturating cash credit. Fixed-point `Money` is i64; overflowing it would wrap into a negative
/// balance (or silently mint), so clamp instead and leave an auditable trace (core has no tracing).
fn credit_cash(target: &mut Money, amount: Money) {
    if amount <= 0 {
        return;
    }
    match target.checked_add(amount) {
        Some(next) => *target = next,
        None => {
            eprintln!(
                "[meridian-core] cash credit overflow: {target} + {amount}; clamping to i64::MAX"
            );
            *target = Money::MAX;
        }
    }
}

/// Checked cash debit that never wraps and never produces a negative balance.
/// Returns `false` (leaving `target` untouched) when the payer cannot afford `amount`.
fn debit_cash(target: &mut Money, amount: Money) -> bool {
    if amount <= 0 {
        return true;
    }
    match target.checked_sub(amount) {
        Some(next) if next >= 0 => {
            *target = next;
            true
        }
        _ => false,
    }
}

struct SplitMix(u64);

impl SplitMix {
    fn new(seed: u64) -> Self {
        let s = seed ^ 0x9E37_79B9_7F4A_7C15;
        Self(if s == 0 { 0xD1B5_4A32_D192_ED03 } else { s })
    }

    fn next_u64(&mut self) -> u64 {
        self.0 = self.0.wrapping_add(0x9E37_79B9_7F4A_7C15);
        let mut z = self.0;
        z = (z ^ (z >> 30)).wrapping_mul(0xBF58_476D_1CE4_E5B9);
        z = (z ^ (z >> 27)).wrapping_mul(0x94D0_49BB_1331_11EB);
        z ^ (z >> 31)
    }

    fn next_f64(&mut self) -> f64 {
        ((self.next_u64() >> 11) as f64) / ((1u64 << 53) as f64)
    }
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct TickReport {
    pub tick: u64,
    pub fills: Vec<TradeFill>,
    pub bankruptcies: Vec<CompanyId>,
    pub rejected_intents: usize,
    #[serde(default)]
    pub rejected_by_company: HashMap<CompanyId, Vec<RejectedIntent>>,
    pub cpi: f64,
}

#[derive(Clone, Serialize, Deserialize)]
pub struct World {
    pub catalog: ProductionCatalog,
    pub tick: u64,
    pub cpi: f64,
    #[serde(default)]
    pub world_seed: u64,
    #[serde(default)]
    pub systems: HashMap<String, StarSystem>,
    pub hub_orbit_radius: f64,
    pub hub_orbit_days: f64,
    pub hub_orbit_angle: f64,

    pub planets: HashMap<PlanetId, Planet>,
    pub stations: HashMap<StationId, CLOBStation>,
    pub companies: HashMap<CompanyId, Company>,
    pub plots: HashMap<PlotId, Plot>,
    pub buildings: HashMap<BuildingId, BuildingInstance>,
    pub in_flight: Vec<ShipInFlight>,
    pub ledger: MoneyLedger,

    next_order_id: OrderId,
    next_plot_id: PlotId,
    next_building_id: BuildingId,
    next_ship_id: ShipId,
    next_listing_id: ListingId,
    rng_state: u64,
}

impl World {
    pub fn new_standard(catalog: ProductionCatalog) -> Self {
        let mut ledger = MoneyLedger::default();
        let mut stations = HashMap::new();
        let mut hub = CLOBStation::new("ST:HUB");
        for it in catalog.items.values() {
            hub.seed_reference_price(&it.id, to_money(it.ref_price.max(0.01)));
        }
        stations.insert("ST:HUB".to_string(), hub);

        let mut systems = HashMap::new();
        systems.insert(
            "S1".to_string(),
            StarSystem {
                id: "S1".to_string(),
                name: "新伊甸星系".to_string(),
                star_class: "G2V 黄矮星".to_string(),
                luminosity: 1.0,
                x: 0.0,
                y: 0.0,
                hub_station_id: "ST:HUB".to_string(),
                hub_orbit_radius: 1.45,
                hub_orbit_days: 200.0,
                hub_orbit_angle: 0.0,
            },
        );

        let planet_specs = vec![
            (
                "P1", "灼热矿星-I", "矿业岩星", 0.90, 95.0, 0.5, 2.6, 101_u32, 1.40, 1.60, 1.65,
                0.65, 0.05, 0.28, 0, 0.0, 20000.0, 30000.0,
            ),
            (
                "P2", "新伊甸-II", "宜居主星", 1.85, 320.0, 2.1, 4.2, 202_u32, 1.00, 1.00, 0.85,
                1.35, 0.45, 0.92, 3, 4500.0, 35000.0, 60000.0,
            ),
            (
                "P3", "凛冬外星-III", "寒冷低重星", 2.75, 580.0, 4.4, 8.9, 303_u32, 0.55, 0.45, 1.05,
                1.65, 0.25, 0.34, 0, 0.0, 20000.0, 30000.0,
            ),
        ];

        let mut planets = HashMap::new();
        for (
            pid, name, arch, orb_r, orb_d, orb_a, rot_d, v_seed, grav, solar, mineral, water,
            ocean, hab, cities, pop, treasury_f, reserves_f,
        ) in planet_specs
        {
            let treasury = to_money(treasury_f);
            let reserves = to_money(reserves_f);
            ledger.record_mint(treasury + reserves);

            let sid = format!("ST:{pid}");
            let mut st = CLOBStation::new(&sid);
            for it in catalog.items.values() {
                st.seed_reference_price(&it.id, to_money(it.ref_price.max(0.01)));
            }
            stations.insert(sid.clone(), st);

            let total_plots = ((252.0 * (1.0 - ocean)) as u32).saturating_sub(cities);
            let mut pw = VecDeque::with_capacity(240);
            pw.push_back(0.82);

            let mut pl_obj = Planet {
                id: pid.to_string(),
                system_id: "S1".to_string(),
                name: name.to_string(),
                archetype: arch.to_string(),
                station_id: sid,
                orbit_radius: orb_r,
                orbit_period_days: orb_d,
                orbit_angle: orb_a,
                rotation_days: rot_d,
                visual_seed: v_seed,
                gravity: grav,
                solar_mult: solar,
                mineral_mult: mineral,
                water_mult: water,
                ocean_ratio: ocean,
                habitability: hab,
                city_count: cities,
                city_level: 1,
                city_capacity: (cities * 3000) as f64,
                population: pop,
                wealth_tier: 1,
                prosperity: 0.85,
                prosperity_window: pw,
                treasury,
                civic_output_per_capita: 0.08,
                waste_backlog: 0,
                bank: PlanetBank::new(pid, reserves),
                total_developable_plots: total_plots,
                unclaimed_plots_remaining: total_plots,
                next_local_plot_seq: 1,
                surface_tiles: Vec::new(),
                land_listings: Vec::new(),
                last_demands: HashMap::new(),
                last_bought: HashMap::new(),
                bought_this_tick: HashMap::new(),
                prev_bids: HashMap::new(),
            };
            pl_obj.build_surface_tiles(&catalog);
            planets.insert(pid.to_string(), pl_obj);
        }

        Self {
            catalog,
            tick: 0,
            cpi: 1.0,
            world_seed: 0,
            systems,
            hub_orbit_radius: 1.45,
            hub_orbit_days: 200.0,
            hub_orbit_angle: 0.0,
            planets,
            stations,
            companies: HashMap::new(),
            plots: HashMap::new(),
            buildings: HashMap::new(),
            in_flight: Vec::new(),
            ledger,
            next_order_id: 1,
            next_plot_id: 1,
            next_building_id: 1,
            next_ship_id: 1,
            next_listing_id: 1,
            rng_state: 0x9E37_79B9_7F4A_7C15,
        }
    }

    /// Generate a procedural single-system (`S1`) world with `2..=5` planets, physical
    /// habitability driving `0..=10` cities, and ~10,000 initial urban residents (no forced utopia).
    pub fn new_generated(catalog: ProductionCatalog, seed: u64) -> Self {
        let mut rng = SplitMix::new(seed);
        let next_u64 = |r: &mut SplitMix| r.next_u64();
        let rand_f64 = |r: &mut SplitMix| r.next_f64();

        let mut ledger = MoneyLedger::default();
        let mut stations = HashMap::new();
        let mut hub = CLOBStation::new("ST:HUB");
        for it in catalog.items.values() {
            hub.seed_reference_price(&it.id, to_money(it.ref_price.max(0.01)));
        }
        stations.insert("ST:HUB".to_string(), hub);

        let star_classes = [
            ("F7V 黄白矮星", 1.24),
            ("G2V 黄矮星", 1.00),
            ("G8V 暖黄星", 0.88),
            ("K1V 橙矮星", 0.78),
        ];
        let star_names = [
            "天苑四", "南门二", "天仓五", "波江座ε", "蛇夫座70", "孔雀座δ", "天龙座σ", "轩辕增九",
        ];
        let (star_class, lum_base) = star_classes[(next_u64(&mut rng) as usize) % star_classes.len()];
        let luminosity = (lum_base * (0.90 + rand_f64(&mut rng) * 0.22)).clamp(0.68, 1.40);
        let star_name = star_names[(next_u64(&mut rng) as usize) % star_names.len()];
        let hub_orbit_radius = 1.20 + rand_f64(&mut rng) * 0.65;
        let hub_orbit_days = 160.0 + rand_f64(&mut rng) * 110.0;

        let mut systems = HashMap::new();
        systems.insert(
            "S1".to_string(),
            StarSystem {
                id: "S1".to_string(),
                name: format!("{star_name}星系"),
                star_class: star_class.to_string(),
                luminosity,
                x: 0.0,
                y: 0.0,
                hub_station_id: "ST:HUB".to_string(),
                hub_orbit_radius,
                hub_orbit_days,
                hub_orbit_angle: 0.0,
            },
        );

        let planet_count = 2 + ((next_u64(&mut rng) % 4) as usize); // 2..=5 planets
        let roman = ["I", "II", "III", "IV", "V", "VI", "VII", "VIII", "IX"];
        let name_pool = [
            "炽岩", "赤砂", "金晖", "晨曦", "新伊甸", "翠微", "苍岚", "青冥",
            "望舒", "霜华", "寒渊", "冥冰", "玄石", "星港", "碧落", "流火",
        ];
        // Pick distinct planet base names using partial Fisher-Yates indices
        let mut pool_idx: Vec<usize> = (0..name_pool.len()).collect();
        for i in (1..pool_idx.len()).rev() {
            let j = (next_u64(&mut rng) as usize) % (i + 1);
            pool_idx.swap(i, j);
        }

        struct DraftPlanet {
            pid: String,
            name: String,
            archetype: String,
            orbit_radius: f64,
            orbit_period_days: f64,
            orbit_angle: f64,
            rotation_days: f64,
            visual_seed: u32,
            gravity: f64,
            solar_mult: f64,
            mineral_mult: f64,
            water_mult: f64,
            ocean_ratio: f64,
            habitability: f64,
            city_count: u32,
        }

        let mut drafts = Vec::with_capacity(planet_count);
        let mut orbit_r = 0.56 + rand_f64(&mut rng) * 0.44;
        let star_mass_sqrt = luminosity.powf(0.22);

        for i in 0..planet_count {
            let pid = format!("P{}", i + 1);
            if i > 0 {
                let step = 0.28 + rand_f64(&mut rng) * 0.32;
                orbit_r += step;
            }
            let orbit_period_days =
                ((orbit_r.powf(1.5) * 145.0 / star_mass_sqrt).clamp(55.0, 1400.0) * 10.0).round()
                    / 10.0;
            let orbit_angle = rand_f64(&mut rng) * std::f64::consts::TAU;
            let rotation_days = (1.2 + rand_f64(&mut rng) * 14.5).clamp(1.2, 16.0);
            let visual_seed = (next_u64(&mut rng) & 0xFFFF_FFFF) as u32;

            let insolation = luminosity / (orbit_r * orbit_r);
            let solar_mult = (insolation.powf(0.52)).clamp(0.32, 2.25);

            // Gravity tends higher for rocky/super-earth planets, varied cleanly across orbits
            let gravity = (0.52 + rand_f64(&mut rng) * 1.05).clamp(0.45, 1.70);

            // Mineral richness tends higher closer to the star and on denser worlds
            let inner_metal_bonus = (1.15 - orbit_r * 0.16).clamp(0.75, 1.25);
            let mineral_mult = ((0.62 + rand_f64(&mut rng) * 1.10) * inner_metal_bonus).clamp(0.55, 1.95);

            // Water availability: scorching inner orbits bake off volatiles; temperate/outer keep more
            let temp_water_factor = if insolation > 2.2 {
                0.30 + rand_f64(&mut rng) * 0.35
            } else if insolation > 0.42 {
                0.82 + rand_f64(&mut rng) * 0.72
            } else {
                0.90 + rand_f64(&mut rng) * 0.75
            };
            let water_mult = temp_water_factor.clamp(0.25, 1.85);
            let raw_ocean = if insolation > 2.2 {
                rand_f64(&mut rng) * 0.06
            } else if insolation >= 0.42 {
                0.14 + (water_mult - 0.65).max(0.0) * 0.45 + rand_f64(&mut rng) * 0.16
            } else {
                0.06 + rand_f64(&mut rng) * 0.30
            };
            let ocean_ratio = raw_ocean.clamp(0.02, 0.72);

            // Physical habitability (0..=1) from thermal band, gravity, and surface volatiles
            let thermal_log_diff = insolation.max(0.08).ln().abs();
            let temp_score = (1.0 - thermal_log_diff / 1.55).clamp(0.0, 1.0);
            let grav_score = (1.0 - (gravity - 0.98).abs() / 0.95).clamp(0.10, 1.0);
            let water_score = if water_mult < 0.5 {
                (water_mult / 0.5) * 0.45
            } else {
                (1.0 - (ocean_ratio - 0.42).abs() / 0.58).clamp(0.25, 1.0)
            };
            let habitability =
                ((0.48 * temp_score + 0.28 * water_score + 0.24 * grav_score) * 1.12)
                    .clamp(0.05, 0.98);

            // City count 0..=10 smoothly driven by habitability (0 for extreme < 0.38)
            let city_count = if habitability < 0.38 {
                0
            } else {
                let t = ((habitability - 0.38) / 0.56).clamp(0.0, 1.0);
                (1.0 + 9.0 * t.powf(1.15)).round().clamp(1.0, 10.0) as u32
            };

            let archetype = if insolation > 2.2 && city_count == 0 {
                "熔岩矿星"
            } else if insolation > 1.7 {
                if city_count > 0 { "炙热绿洲星" } else { "灼热岩星" }
            } else if habitability >= 0.75 && ocean_ratio >= 0.52 {
                "海洋宜居星"
            } else if habitability >= 0.72 {
                "温带宜居星"
            } else if city_count > 0 && insolation < 0.55 {
                "冷温开拓星"
            } else if city_count > 0 {
                "边疆殖民星"
            } else if insolation < 0.45 {
                "极寒低重星"
            } else {
                "贫瘠岩星"
            };

            let pname = format!("{}-{}", name_pool[pool_idx[i]], roman[i]);
            drafts.push(DraftPlanet {
                pid,
                name: pname,
                archetype: archetype.to_string(),
                orbit_radius: (orbit_r * 100.0).round() / 100.0,
                orbit_period_days,
                orbit_angle,
                rotation_days,
                visual_seed,
                gravity: (gravity * 100.0).round() / 100.0,
                solar_mult: (solar_mult * 100.0).round() / 100.0,
                mineral_mult: (mineral_mult * 100.0).round() / 100.0,
                water_mult: (water_mult * 100.0).round() / 100.0,
                ocean_ratio: (ocean_ratio * 100.0).round() / 100.0,
                habitability: (habitability * 1000.0).round() / 1000.0,
                city_count,
            });
        }

        // Distribute ~10,000 initial urban population proportionally across inhabited planets.
        let pop_weights: Vec<f64> = drafts
            .iter()
            .map(|d| {
                if d.city_count > 0 {
                    (d.city_count as f64) * d.habitability.powf(1.25)
                } else {
                    0.0
                }
            })
            .collect();
        let total_weight: f64 = pop_weights.iter().sum();

        let mut planets = HashMap::with_capacity(planet_count);
        for (idx, d) in drafts.into_iter().enumerate() {
            let pop = if total_weight > 0.0 && d.city_count > 0 {
                (10_000.0 * (pop_weights[idx] / total_weight)).round().max(300.0)
            } else {
                0.0
            };
            let city_capacity = if d.city_count > 0 {
                (pop * 1.35).max((d.city_count * 1200) as f64).round()
            } else {
                0.0
            };
            let treasury_f = 18_000.0 + pop * 3.8 + d.mineral_mult * 2_000.0;
            let reserves_f = 26_000.0 + pop * 6.0;
            let treasury = to_money(treasury_f);
            let reserves = to_money(reserves_f);
            ledger.record_mint(treasury + reserves);

            let sid = format!("ST:{}", d.pid);
            let mut st = CLOBStation::new(&sid);
            for it in catalog.items.values() {
                st.seed_reference_price(&it.id, to_money(it.ref_price.max(0.01)));
            }
            stations.insert(sid.clone(), st);

            let total_plots = ((252.0 * (1.0 - d.ocean_ratio)) as u32)
                .saturating_sub(d.city_count)
                .max(48);
            let mut pw = VecDeque::with_capacity(240);
            pw.push_back((0.76 + d.habitability * 0.14).clamp(0.65, 0.92));

            let mut pl_obj = Planet {
                id: d.pid.clone(),
                system_id: "S1".to_string(),
                name: d.name,
                archetype: d.archetype,
                station_id: sid,
                orbit_radius: d.orbit_radius,
                orbit_period_days: d.orbit_period_days,
                orbit_angle: d.orbit_angle,
                rotation_days: d.rotation_days,
                visual_seed: d.visual_seed,
                gravity: d.gravity,
                solar_mult: d.solar_mult,
                mineral_mult: d.mineral_mult,
                water_mult: d.water_mult,
                ocean_ratio: d.ocean_ratio,
                habitability: d.habitability,
                city_count: d.city_count,
                city_level: if d.city_count > 0 { 1 } else { 0 },
                city_capacity,
                population: pop,
                wealth_tier: 1,
                prosperity: (0.78 + d.habitability * 0.12).clamp(0.70, 0.92),
                prosperity_window: pw,
                treasury,
                civic_output_per_capita: 0.08,
                waste_backlog: 0,
                bank: PlanetBank::new(&d.pid, reserves),
                total_developable_plots: total_plots,
                unclaimed_plots_remaining: total_plots,
                next_local_plot_seq: 1,
                surface_tiles: Vec::new(),
                land_listings: Vec::new(),
                last_demands: HashMap::new(),
                last_bought: HashMap::new(),
                bought_this_tick: HashMap::new(),
                prev_bids: HashMap::new(),
            };
            pl_obj.build_surface_tiles(&catalog);
            planets.insert(d.pid.clone(), pl_obj);
        }

        let rng_state = next_u64(&mut rng) | 1;
        Self {
            catalog,
            tick: 0,
            cpi: 1.0,
            world_seed: seed,
            systems,
            hub_orbit_radius,
            hub_orbit_days,
            hub_orbit_angle: 0.0,
            planets,
            stations,
            companies: HashMap::new(),
            plots: HashMap::new(),
            buildings: HashMap::new(),
            in_flight: Vec::new(),
            ledger,
            next_order_id: 1,
            next_plot_id: 1,
            next_building_id: 1,
            next_ship_id: 1,
            next_listing_id: 1,
            rng_state,
        }
    }

    pub fn system_by_hub(&self, station_id: &str) -> Option<String> {
        if let Some(sys) = self.systems.values().find(|s| s.hub_station_id == station_id) {
            return Some(sys.id.clone());
        }
        if station_id == "ST:HUB" {
            return Some("S1".to_string());
        }
        None
    }

    /// Best planet to settle BANK reserve flows for any station (local planet if orbital,
    /// otherwise primary/most-populous planet in the hub's system).
    pub fn default_bank_planet_id(&self, station_id: &str) -> Option<PlanetId> {
        if let Some(pid) = station_id.strip_prefix("ST:") {
            if self.planets.contains_key(pid) {
                return Some(pid.to_string());
            }
        }
        let sys_id = self.system_by_hub(station_id);
        let mut candidates: Vec<&Planet> = self
            .planets
            .values()
            .filter(|p| sys_id.as_deref().is_none_or(|sid| p.system_id == sid))
            .collect();
        if candidates.is_empty() {
            candidates = self.planets.values().collect();
        }
        candidates.sort_by(|a, b| {
            b.population
                .partial_cmp(&a.population)
                .unwrap_or(std::cmp::Ordering::Equal)
                .then_with(|| a.id.cmp(&b.id))
        });
        candidates.first().map(|p| p.id.clone())
    }

    fn next_rand(&mut self) -> u64 {
        let mut x = self.rng_state;
        x ^= x << 13;
        x ^= x >> 7;
        x ^= x << 17;
        self.rng_state = x;
        x
    }

    /// Count how many developable plots on `planet_id` are currently held by NPCs or BANK foreclosures.
    pub fn npc_plot_count_on(&self, planet_id: &str) -> u32 {
        let bank_plot_ids: std::collections::HashSet<PlotId> = self
            .planets
            .get(planet_id)
            .map(|p| {
                p.land_listings
                    .iter()
                    .filter(|l| l.seller_id == "BANK")
                    .map(|l| l.plot_id)
                    .collect()
            })
            .unwrap_or_default();
        self.plots
            .values()
            .filter(|pl| {
                pl.planet_id == planet_id
                    && (pl.owner_id.as_deref().is_some_and(|oid| {
                        self.companies.get(oid).is_some_and(|c| !c.is_player)
                    }) || (pl.owner_id.is_none() && bank_plot_ids.contains(&pl.id)))
            })
            .count() as u32
    }

    /// Strict 90% ceiling of a planet's developable plots available to all NPCs combined.
    pub fn npc_plot_cap_on(&self, planet_id: &str) -> u32 {
        self.planets
            .get(planet_id)
            .map(|p| (p.total_developable_plots * 9) / 10)
            .unwrap_or(0)
    }

    /// Spawn a player or NPC company with starter plot, profession buildings, ship, and starting cash.
    pub fn spawn_company(
        &mut self,
        id: impl Into<CompanyId>,
        name: impl Into<String>,
        is_player: bool,
        profession: &str,
        home_planet_id: &str,
        initial_cash_credits: f64,
    ) -> Result<(), String> {
        let cid: CompanyId = id.into();
        if self.companies.contains_key(&cid) {
            return Err(format!("Company '{cid}' already exists"));
        }
        let prof = self
            .catalog
            .professions
            .get(profession)
            .ok_or_else(|| format!("Unknown profession '{profession}'"))?
            .clone();
        if !self.planets.contains_key(home_planet_id) {
            return Err(format!("Unknown planet '{home_planet_id}'"));
        }

        // Reuse cheapest BANK-foreclosed secondhand plot first for NPCs so bankruptcies recycle land.
        let bank_listing_idx = if !is_player {
            self.planets[home_planet_id]
                .land_listings
                .iter()
                .enumerate()
                .filter(|(_, l)| l.seller_id == "BANK")
                .min_by_key(|(_, l)| l.ask_price)
                .map(|(i, _)| i)
        } else {
            None
        };

        if !is_player && bank_listing_idx.is_none() {
            let planet = &self.planets[home_planet_id];
            let reserved_player_plots = (planet.total_developable_plots / 10).max(1);
            if self.npc_plot_count_on(home_planet_id) >= self.npc_plot_cap_on(home_planet_id)
                || planet.unclaimed_plots_remaining <= reserved_player_plots
            {
                return Err(format!("NPC 90% plot cap reached on '{home_planet_id}'"));
            }
        }

        let (plot_id, mut plot) = if let Some(idx) = bank_listing_idx {
            let lst = self
                .planets
                .get_mut(home_planet_id)
                .unwrap()
                .land_listings
                .remove(idx);
            let mut pl = self
                .plots
                .remove(&lst.plot_id)
                .ok_or_else(|| format!("Listed plot {} missing", lst.plot_id))?;
            for old_bid in pl.building_ids.drain(..) {
                self.buildings.remove(&old_bid);
            }
            pl.jobs.clear();
            pl.owner_id = Some(cid.clone());
            self.planets
                .get_mut(home_planet_id)
                .unwrap()
                .set_tile_owner(pl.slot_id, Some(cid.clone()), Some(pl.id));
            (pl.id, pl)
        } else {
            let pid_new = self.next_plot_id;
            self.next_plot_id += 1;
            let pl = self
                .planets
                .get_mut(home_planet_id)
                .unwrap()
                .claim_surface_tile(None, Some(profession), pid_new, Some(cid.clone()), &self.catalog)
                .ok_or_else(|| format!("No unclaimed plots left on '{home_planet_id}'"))?;
            (pid_new, pl)
        };

        let initial_cash = to_money(initial_cash_credits.max(0.0));
        self.ledger.record_mint(initial_cash);

        let mut comp = Company::new(
            cid.clone(),
            name,
            is_player,
            profession,
            home_planet_id,
            initial_cash,
        );
        comp.plots.push(plot_id);

        // Starter ship & working supplies
        let ship_id = self.next_ship_id;
        self.next_ship_id += 1;
        comp.ships.push(Ship {
            id: ship_id,
            owner_id: cid.clone(),
            size: ShipSize::Small,
            durability: 100.0,
            location: home_planet_id.to_string(),
            busy_until: 0,
            cargo: HashMap::new(),
        });
        comp.add_ground_qty(home_planet_id, "power", 60);
        comp.add_ground_qty(home_planet_id, "fuel", 30);

        for btype in &prof.starter_buildings {
            if plot.used_slots() >= plot.capacity {
                break;
            }
            if let Some(default_recipe) = self
                .catalog
                .recipes_by_building
                .get(btype)
                .and_then(|v| v.first())
                .cloned()
            {
                let bid = self.next_building_id;
                self.next_building_id += 1;
                let base_mod = *plot.building_mods.get(btype).unwrap_or(&1.0);
                let eff = (base_mod * 100.0).round() / 100.0;

                self.buildings.insert(
                    bid,
                    BuildingInstance {
                        id: bid,
                        owner_id: cid.clone(),
                        plot_id,
                        planet_id: home_planet_id.to_string(),
                        building_type: btype.clone(),
                        efficiency: eff,
                        recipe_id: default_recipe,
                        active: true,
                        progress: 0,
                        active_batch: false,
                        standby_ticks: 0,
                        idle_ticks: 0,
                    },
                );
                plot.building_ids.push(bid);
            }
        }

        self.plots.insert(plot_id, plot);
        self.companies.insert(cid, comp);
        Ok(())
    }

    pub const PLAYER_STARTER_CASH: f64 = 3_500.0;

    /// Returns generous starter ground inventory `(item_id, qty)` tailored to a chosen starting profession.
    /// Zero factories are granted; supplies comfortably cover building 3–4 initial facilities, multi-cycle runs, and first ship dispatches.
    pub fn starter_supplies_for_profession(profession: &str) -> Vec<(&'static str, u32)> {
        match profession {
            "env_recycle" => vec![
                ("building_mat", 28),
                ("power", 120),
                ("water", 120),
                ("fuel", 60),
                ("oxygen", 60),
                ("bio_fiber", 20),
            ],
            "agri_bio" => vec![
                ("building_mat", 28),
                ("power", 100),
                ("water", 100),
                ("fuel", 45),
                ("bio_crop", 60),
                ("bio_fiber", 30),
                ("rations", 60),
                ("beverage", 25),
            ],
            "mining_ind" | _ => vec![
                ("building_mat", 28),
                ("power", 100),
                ("fuel", 45),
                ("ore", 80),
                ("steel", 45),
                ("bio_fiber", 25),
                ("daily_goods", 20),
            ],
        }
    }

    /// Spawn a player company from onboarding choices: exact chosen planet + unclaimed tile slot,
    /// zero starter buildings, 1 small ship, starter cash, and profession-specific ground supplies.
    pub fn spawn_player_custom(
        &mut self,
        id: impl Into<CompanyId>,
        name: impl Into<String>,
        profession: &str,
        home_planet_id: &str,
        slot_id: SlotId,
        initial_cash_credits: f64,
        supplies: &[(&str, u32)],
    ) -> Result<PlotId, String> {
        let cid: CompanyId = id.into();
        if self.companies.contains_key(&cid) {
            return Err(format!("Company '{cid}' already exists"));
        }
        if !self.catalog.professions.contains_key(profession) {
            return Err(format!("Unknown profession '{profession}'"));
        }
        if !self.planets.contains_key(home_planet_id) {
            return Err(format!("Unknown planet '{home_planet_id}'"));
        }

        let plot_id = self.next_plot_id;
        let plot = self
            .planets
            .get_mut(home_planet_id)
            .unwrap()
            .claim_surface_tile(
                Some(slot_id),
                Some(profession),
                plot_id,
                Some(cid.clone()),
                &self.catalog,
            )
            .ok_or_else(|| format!("格点 #{slot_id} 已被占用或不可开发，请重新选择"))?;
        self.next_plot_id += 1;

        let initial_cash = to_money(initial_cash_credits.max(0.0));
        self.ledger.record_mint(initial_cash);

        let mut comp = Company::new(
            cid.clone(),
            name,
            true,
            profession,
            home_planet_id,
            initial_cash,
        );
        comp.plots.push(plot_id);

        let ship_id = self.next_ship_id;
        self.next_ship_id += 1;
        comp.ships.push(Ship {
            id: ship_id,
            owner_id: cid.clone(),
            size: ShipSize::Small,
            durability: 100.0,
            location: home_planet_id.to_string(),
            busy_until: 0,
            cargo: HashMap::new(),
        });

        for (item_id, qty) in supplies {
            if *qty > 0 && self.catalog.items.contains_key(*item_id) {
                comp.add_ground_qty(home_planet_id, item_id, *qty as i64);
            }
        }

        self.plots.insert(plot_id, plot);
        self.companies.insert(cid, comp);
        Ok(plot_id)
    }

    /// Cleanly removes an un-onboarded placeholder company (releasing its plot & burning its cash in ledger)
    /// so a player onboarding onto `player1` preserves exact currency and tile conservation.
    pub fn reclaim_placeholder_company(&mut self, company_id: &str) -> Result<(), String> {
        let Some(comp) = self.companies.remove(company_id) else {
            return Ok(());
        };
        let mut total_cash = comp.cash;
        // Cancel open orders across all stations and include escrowed buy cash before burning
        for st in self.stations.values_mut() {
            let own_order_ids: Vec<OrderId> = st
                .bids
                .values()
                .chain(st.asks.values())
                .flat_map(|v| v.iter())
                .filter(|o| o.owner_id == company_id)
                .map(|o| o.order_id)
                .collect();
            for oid in own_order_ids {
                if let Some(o) = st.remove_order(oid) {
                    if matches!(o.side, OrderSide::Buy) {
                        total_cash = total_cash.saturating_add(o.escrow_cash);
                    }
                }
            }
        }
        if let Some(p) = self.planets.get_mut(&comp.home_planet_id) {
            p.bank.total_deposits = p.bank.total_deposits.saturating_sub(comp.savings);
            p.bank.total_loans = p.bank.total_loans.saturating_sub(comp.debt);
            let deposit_burned = comp.savings.min(p.bank.reserves);
            if deposit_burned > 0 {
                p.bank.reserves -= deposit_burned;
                total_cash = total_cash.saturating_add(deposit_burned);
            }
        }
        self.ledger.record_burn(total_cash);
        self.in_flight.retain(|f| f.owner_id != company_id);

        for pid in comp.plots {
            if let Some(pl) = self.plots.remove(&pid) {
                for bid in pl.building_ids {
                    self.buildings.remove(&bid);
                }
                if let Some(planet) = self.planets.get_mut(&pl.planet_id) {
                    planet.set_tile_owner(pl.slot_id, None, None);
                    planet.recompute_unclaimed_count();
                }
            }
        }
        Ok(())
    }

    /// Spawn a market-driven startup NPC backed partly by a PlanetBank loan (preserving conservation).
    pub fn spawn_npc_startup(
        &mut self,
        id: impl Into<CompanyId>,
        name: impl Into<String>,
        profession: &str,
        home_planet_id: &str,
        total_seed_credits: f64,
    ) -> Result<(), String> {
        let cid: CompanyId = id.into();
        let seed_total = to_money(total_seed_credits.max(1_000.0));
        let max_loan = seed_total / 2;
        let reserve_floor = to_money(2_000.0 * self.cpi.max(0.5));
        let loan = self
            .planets
            .get(home_planet_id)
            .map(|p| {
                if p.bank.reserves > reserve_floor + max_loan {
                    max_loan
                } else {
                    0
                }
            })
            .unwrap_or(0);
        let mint_credits = from_money(seed_total - loan);
        self.spawn_company(cid.clone(), name, false, profession, home_planet_id, mint_credits)?;
        if loan > 0 {
            if let Some(p) = self.planets.get_mut(home_planet_id) {
                p.bank.reserves -= loan;
                p.bank.total_loans += loan;
            }
            if let Some(c) = self.companies.get_mut(&cid) {
                c.cash += loan;
                c.debt += loan;
            }
        }
        Ok(())
    }

    pub fn is_instant_item(&self, item_id: &str) -> bool {
        self.catalog.is_instant_item(item_id)
    }

    /// Unit-price reference for a book: last trade price on that station, else catalog ref price
    /// (with a 1-credit floor). Used to bound admissible limit prices and reject minting exploits.
    fn reference_price_for(&self, station_id: &str, item_id: &str) -> Money {
        let fallback = self
            .catalog
            .items
            .get(item_id)
            .map(|it| to_money(it.ref_price.max(0.01)))
            .unwrap_or(MONEY_SCALE);
        self.stations
            .get(station_id)
            .and_then(|st| st.last_trade_price.get(item_id).copied())
            .unwrap_or(fallback)
    }

    /// Credit limit for a company's home-planet bank borrowing:
    /// starter base floor (`2,000 * cpi`) or 50% of asset valuation (excluding borrowed cash),
    /// preventing 100-credit fresh accounts from borrowing 196x their equity.
    pub fn company_credit_limit(&self, company_id: &str) -> Money {
        let base = to_money(2_000.0 * self.cpi);
        let Some(comp) = self.companies.get(company_id) else {
            return base;
        };
        let land_px = self
            .planets
            .get(&comp.home_planet_id)
            .map(|p| from_money(p.primary_land_price(self.cpi)))
            .unwrap_or(1_500.0);
        let bld_count: usize = comp
            .plots
            .iter()
            .filter_map(|pid| self.plots.get(pid))
            .map(|pl| pl.building_ids.len())
            .sum();
        let fixed_assets = to_money(
            (comp.plots.len() as f64) * land_px * 0.5
                + (bld_count as f64) * 140.0 * self.cpi * 0.4
                + (comp.ships.len() as f64) * 260.0 * self.cpi * 0.5,
        );
        let unencumbered_liquid =
            ((comp.savings * 4) / 5).saturating_add(comp.cash.saturating_sub(comp.debt) / 2);
        base.max(fixed_assets.saturating_add(unencumbered_liquid))
    }

    /// Credit revenue to a company seller; if their loan is past `debt_due_tick`, automatically
    /// garnish 25% (`OVERDUE_GARNISH_BPS`) directly to the home planet's bank reserves to pay down debt.
    fn credit_seller_revenue(&mut self, seller_id: &str, proceeds: Money, tick: u64) {
        if proceeds <= 0 {
            return;
        }
        let (home_pid, garnish) = {
            let Some(comp) = self.companies.get(seller_id) else {
                return;
            };
            if comp.is_debt_overdue(tick) {
                (
                    Some(comp.home_planet_id.clone()),
                    bps_of(proceeds, OVERDUE_GARNISH_BPS).min(comp.debt),
                )
            } else {
                (None, 0)
            }
        };
        let net = proceeds.saturating_sub(garnish);
        if let Some(comp) = self.companies.get_mut(seller_id) {
            credit_cash(&mut comp.cash, net);
            if garnish > 0 {
                comp.debt = comp.debt.saturating_sub(garnish);
                if comp.debt == 0 {
                    comp.debt_due_tick = None;
                }
            }
        }
        if garnish > 0 {
            if let Some(pid) = home_pid {
                if let Some(p) = self.planets.get_mut(&pid) {
                    credit_cash(&mut p.bank.reserves, garnish);
                    p.bank.total_loans = p.bank.total_loans.saturating_sub(garnish);
                }
            }
        }
    }

    pub fn total_currency_in_system(&self) -> i128 {
        let comp_cash: i128 = self.companies.values().map(|c| c.cash as i128).sum();
        let planet_treasury: i128 = self.planets.values().map(|p| p.treasury as i128).sum();
        let bank_reserves: i128 = self.planets.values().map(|p| p.bank.reserves as i128).sum();
        let escrows: i128 = self
            .stations
            .values()
            .map(|s| s.total_escrow_cash() as i128)
            .sum();
        comp_cash + planet_treasury + bank_reserves + escrows
    }

    pub fn conservation_error(&self) -> i128 {
        self.total_currency_in_system() - self.ledger.expected_circulation()
    }

    fn describe_intent(intent: &Intent) -> (&'static str, String) {
        match intent {
            Intent::CreateOrder { station_id, side, item_id, qty, .. } => (
                "createOrder",
                format!("{side:?}:{item_id}@{station_id} x{qty}"),
            ),
            Intent::CancelOrder { order_id } => ("cancelOrder", format!("order:{order_id}")),
            Intent::DealOrder { order_id, amount } => ("deal", format!("order:{order_id} x{amount}")),
            Intent::SetRecipe { building_id, recipe_id } => (
                "setRecipe",
                format!("building:{building_id}->{recipe_id}"),
            ),
            Intent::ToggleBuilding { building_id, active } => (
                "setActive",
                format!("building:{building_id}={active}"),
            ),
            Intent::BuildFacility { plot_id, building_type } => (
                "build",
                format!("plot:{plot_id}:{building_type}"),
            ),
            Intent::DemolishFacility { plot_id, building_id } => (
                "demolish",
                format!("plot:{plot_id}:building:{building_id}"),
            ),
            Intent::BuyPlot { planet_id, slot_id, listing_id } => match (listing_id, slot_id) {
                (Some(lid), _) => ("buyLand", format!("listing:{lid}@{planet_id}")),
                (None, Some(sid)) => ("buyPlot", format!("slot:{sid}@{planet_id}")),
                (None, None) => ("buyPlot", planet_id.clone()),
            },
            Intent::DispatchShip { ship_id, to, .. } => (
                "dispatch",
                format!("ship:{ship_id}->{to}"),
            ),
            Intent::RepairShip { ship_id } => ("repair", format!("ship:{ship_id}")),
            Intent::BankOp { planet_id, op, .. } => ("bank", format!("{op:?}@{planet_id}")),
        }
    }

    pub fn step_tick(&mut self, intents_by_company: Vec<(CompanyId, Vec<Intent>)>) -> TickReport {
        self.step_tick_with_manual(intents_by_company, Vec::new())
    }

    /// Execute one deterministic tick with separate script (`MAX_INTENTS_PER_TICK` capped) and
    /// manual UI/console intent batches so script loops cannot silently crowd out manual actions.
    pub fn step_tick_with_manual(
        &mut self,
        intents_by_company: Vec<(CompanyId, Vec<Intent>)>,
        manual_intents_by_company: Vec<(CompanyId, Vec<Intent>)>,
    ) -> TickReport {
        self.tick += 1;
        let t = self.tick;
        let mut rejected_intents = 0usize;
        let mut rejected_by_company: HashMap<CompanyId, Vec<RejectedIntent>> = HashMap::new();

        // 0a. Advance orbits & update CPI
        self.advance_orbits();
        self.update_cpi();

        // 0b. Land arriving ships
        self.land_arriving_ships(t);

        // 0c. Step construction jobs & building production/standby
        self.step_buildings_and_jobs(t);

        // 0d. Rotate per-tick city purchase counters cleanly BEFORE player/NPC DealOrder fills
        for p in self.planets.values_mut() {
            p.last_bought = std::mem::take(&mut p.bought_this_tick);
        }

        // 1a. Apply manual UI / console intents first (never crowded out by script quota)
        for (cid, manual) in manual_intents_by_company {
            for (idx, intent) in manual.into_iter().enumerate() {
                let (action, target) = Self::describe_intent(&intent);
                if let Err((code, reason)) = self.apply_intent_detailed(&cid, intent, t) {
                    rejected_intents += 1;
                    rejected_by_company.entry(cid.clone()).or_default().push(RejectedIntent {
                        intent_index: idx,
                        action: format!("manual:{action}"),
                        target,
                        code,
                        reason: reason.to_string(),
                    });
                }
            }
        }

        // 1b. Shuffle & apply external decision Intents (player JS + free-play NPCs)
        let mut batches = intents_by_company;
        if batches.len() > 1 {
            for i in (1..batches.len()).rev() {
                let j = (self.next_rand() as usize) % (i + 1);
                batches.swap(i, j);
            }
        }
        for (cid, intents) in batches {
            for (idx, intent) in intents.into_iter().take(MAX_INTENTS_PER_TICK).enumerate() {
                let (action, target) = Self::describe_intent(&intent);
                if let Err((code, reason)) = self.apply_intent_detailed(&cid, intent, t) {
                    rejected_intents += 1;
                    rejected_by_company.entry(cid.clone()).or_default().push(RejectedIntent {
                        intent_index: idx,
                        action: action.to_string(),
                        target,
                        code,
                        reason: reason.to_string(),
                    });
                }
            }
        }

        // 1c. Refresh planet civic issuance & city Buy orders AFTER 1a/1b so players/NPCs can
        // reliably fill resting PLANET:* bids via `DealOrder` instead of getting `-5` every tick.
        let mut planet_demands: HashMap<PlanetId, HashMap<ItemId, u32>> = HashMap::new();
        let pids: Vec<PlanetId> = self.planets.keys().cloned().collect();
        for pid in pids {
            let demands = self.place_planet_demands(&pid, t);
            planet_demands.insert(pid, demands);
        }

        // 2. Match CLOB stations & settle cash, station fees (0.5%), and physical goods
        let mut all_fills = Vec::new();
        let sids: Vec<StationId> = self.stations.keys().cloned().collect();
        for sid in sids {
            let (fills, evicted) = self
                .stations
                .get_mut(&sid)
                .unwrap()
                .match_all_with_evictions(t);
            for ev in evicted {
                self.refund_evicted_order(ev);
            }
            for fill in &fills {
                self.settle_trade_fill(fill);
            }
            all_fills.extend(fills);
        }

        // 3. Finish planet growth/waste, light Hub rent, bank interest, NPC-only bankruptcy
        for (pid, demands) in &planet_demands {
            if let Some(p) = self.planets.get_mut(pid) {
                p.finish_city_tick(demands, &self.catalog);
                p.bank.update_policy(p.prosperity, self.cpi);
            }
        }
        if t % 12 == 0 {
            self.charge_hub_storage_rent();
        }
        self.accrue_bank_interest();
        let bankruptcies = self.process_npc_bankruptcies(t);
        if t % 24 == 0 {
            self.process_bank_liquidations(t);
        }
        if t % 12 == 0 {
            self.rebalance_bank_and_liquidity();
        }

        TickReport {
            tick: t,
            fills: all_fills,
            bankruptcies,
            rejected_intents,
            rejected_by_company,
            cpi: self.cpi,
        }
    }

    fn advance_orbits(&mut self) {
        let dt_days = 1.0 / self.catalog.pack.meta.ticks_per_day.max(1) as f64;
        self.hub_orbit_angle =
            (self.hub_orbit_angle + std::f64::consts::TAU * dt_days / self.hub_orbit_days)
                % std::f64::consts::TAU;
        for sys in self.systems.values_mut() {
            sys.hub_orbit_angle = (sys.hub_orbit_angle
                + std::f64::consts::TAU * dt_days / sys.hub_orbit_days.max(1.0))
                % std::f64::consts::TAU;
        }
        if let Some(s1) = self.systems.get("S1") {
            self.hub_orbit_angle = s1.hub_orbit_angle;
            self.hub_orbit_radius = s1.hub_orbit_radius;
            self.hub_orbit_days = s1.hub_orbit_days;
        }
        for p in self.planets.values_mut() {
            p.orbit_angle = (p.orbit_angle + std::f64::consts::TAU * dt_days / p.orbit_period_days)
                % std::f64::consts::TAU;
        }
    }

    fn update_cpi(&mut self) {
        let mut ratio_sum = 0.0;
        let mut cnt = 0usize;
        for it in self.catalog.items.values() {
            if it.ref_price <= 0.0 || it.role == ItemRole::Byproduct || it.role == ItemRole::Capital {
                continue;
            }
            let mut px_sum = 0.0;
            for st in self.stations.values() {
                let p = *st.ema_slow.get(&it.id).unwrap_or(&to_money(it.ref_price));
                px_sum += from_money(p);
            }
            let avg_p = px_sum / self.stations.len().max(1) as f64;
            ratio_sum += (avg_p / it.ref_price).clamp(0.4, 4.0);
            cnt += 1;
        }
        if cnt > 0 {
            let raw = ratio_sum / cnt as f64;
            self.cpi = (self.cpi * 0.96 + raw * 0.04).clamp(0.25, 10.0);
        }
    }

    fn land_arriving_ships(&mut self, tick: u64) {
        let mut remaining = Vec::with_capacity(self.in_flight.len());
        let in_flight = std::mem::take(&mut self.in_flight);
        for flight in in_flight {
            if flight.arrival_tick <= tick {
                if let Some(comp) = self.companies.get_mut(&flight.owner_id) {
                    if let Some(ship) = comp.ships.iter_mut().find(|s| s.id == flight.ship_id) {
                        ship.location = flight.to.clone();
                        ship.cargo.clear();
                    }
                    if flight.to.starts_with("ST:") {
                        for (item, qty) in flight.cargo {
                            comp.add_station_qty(&flight.to, &item, qty as i64);
                        }
                    } else {
                        for (item, qty) in flight.cargo {
                            comp.add_ground_qty(&flight.to, &item, qty as i64);
                        }
                    }
                }
            } else {
                remaining.push(flight);
            }
        }
        self.in_flight = remaining;
    }

    fn step_buildings_and_jobs(&mut self, tick: u64) {
        let plot_ids: Vec<PlotId> = self.plots.keys().cloned().collect();
        for pid in plot_ids {
            let jobs = {
                let plot = self.plots.get_mut(&pid).unwrap();
                std::mem::take(&mut plot.jobs)
            };
            let mut still = Vec::new();
            for job in jobs {
                if job.finish_tick <= tick {
                    if job.action == "build" {
                        let (owner_id, planet_id, eff) = {
                            let plot = &self.plots[&pid];
                            let ow = plot.owner_id.clone().unwrap_or_default();
                            let bmod = *plot.building_mods.get(&job.building_type).unwrap_or(&1.0);
                            (ow, plot.planet_id.clone(), (bmod * 100.0).round() / 100.0)
                        };
                        if !owner_id.is_empty() {
                            if let Some(def_recipe) = self
                                .catalog
                                .recipes_by_building
                                .get(&job.building_type)
                                .and_then(|v| v.first())
                                .cloned()
                            {
                                let bid = self.next_building_id;
                                self.next_building_id += 1;
                                self.buildings.insert(
                                    bid,
                                    BuildingInstance {
                                        id: bid,
                                        owner_id,
                                        plot_id: pid,
                                        planet_id,
                                        building_type: job.building_type,
                                        efficiency: eff,
                                        recipe_id: def_recipe,
                                        active: true,
                                        progress: 0,
                                        active_batch: false,
                                        standby_ticks: 0,
                                        idle_ticks: 0,
                                    },
                                );
                                self.plots.get_mut(&pid).unwrap().building_ids.push(bid);
                            }
                        }
                    }
                } else {
                    still.push(job);
                }
            }
            self.plots.get_mut(&pid).unwrap().jobs = still;
        }

        let bids: Vec<BuildingId> = self.buildings.keys().cloned().collect();
        for bid in bids {
            let b = self.buildings.get(&bid).unwrap().clone();
            let Some(recipe) = self.catalog.recipes.get(&b.recipe_id).cloned() else {
                continue;
            };
            let Some(bdef) = self.catalog.buildings.get(&b.building_type).cloned() else {
                continue;
            };

            let mut updated = b.clone();
            if updated.active_batch {
                updated.progress += 1;
                if updated.progress >= recipe.cycle_ticks {
                    // Produce outputs cleanly
                    for out in &recipe.outputs {
                        let out_qty = ((out.qty as f64) * updated.efficiency).round().max(1.0) as u32;
                        if let Some(comp) = self.companies.get_mut(&updated.owner_id) {
                            comp.add_ground_qty(&updated.planet_id, &out.item, out_qty as i64);
                        }
                    }
                    updated.active_batch = false;
                    updated.progress = 0;
                }
            }

            if !updated.active_batch {
                if updated.active {
                    let wage = to_money(recipe.labor_cost * self.cpi);
                    let can_pay_and_consume = {
                        let comp = match self.companies.get(&updated.owner_id) {
                            Some(c) => c,
                            None => continue,
                        };
                        let has_cash = comp.cash >= wage;
                        let has_pwr = recipe.power_cost == 0
                            || comp.ground_qty(&updated.planet_id, "power") >= recipe.power_cost;
                        let has_inputs = recipe.inputs.iter().all(|inp| {
                            if inp.item == "waste" {
                                let own_w = comp.ground_qty(&updated.planet_id, "waste");
                                let city_w = self
                                    .planets
                                    .get(&updated.planet_id)
                                    .map(|p| p.waste_backlog)
                                    .unwrap_or(0);
                                own_w + city_w >= inp.qty
                            } else {
                                comp.ground_qty(&updated.planet_id, &inp.item) >= inp.qty
                            }
                        });
                        has_cash && has_pwr && has_inputs
                    };

                    if can_pay_and_consume {
                        if wage > 0 {
                            self.companies.get_mut(&updated.owner_id).unwrap().cash -= wage;
                            self.pay_wages(&updated.planet_id, wage);
                        }
                        if recipe.power_cost > 0 {
                            self.companies.get_mut(&updated.owner_id).unwrap().add_ground_qty(
                                &updated.planet_id,
                                "power",
                                -(recipe.power_cost as i64),
                            );
                        }
                        for inp in &recipe.inputs {
                            if inp.item == "waste" {
                                let comp = self.companies.get_mut(&updated.owner_id).unwrap();
                                let own_w = comp.ground_qty(&updated.planet_id, "waste");
                                let take_own = own_w.min(inp.qty);
                                if take_own > 0 {
                                    comp.add_ground_qty(&updated.planet_id, "waste", -(take_own as i64));
                                }
                                let rem = inp.qty - take_own;
                                if rem > 0 {
                                    if let Some(p) = self.planets.get_mut(&updated.planet_id) {
                                        p.waste_backlog = p.waste_backlog.saturating_sub(rem);
                                    }
                                }
                            } else {
                                self.companies.get_mut(&updated.owner_id).unwrap().add_ground_qty(
                                    &updated.planet_id,
                                    &inp.item,
                                    -(inp.qty as i64),
                                );
                            }
                        }
                        updated.active_batch = true;
                        updated.progress = 0;
                        updated.standby_ticks = 0;
                        updated.idle_ticks = 0;
                    } else {
                        updated.idle_ticks = updated.idle_ticks.saturating_add(1);
                        Self::consume_light_standby(&mut updated, &bdef, &recipe, &mut self.companies);
                    }
                } else {
                    updated.idle_ticks = updated.idle_ticks.saturating_add(1);
                    Self::consume_light_standby(&mut updated, &bdef, &recipe, &mut self.companies);
                }
            } else {
                updated.idle_ticks = 0;
            }

            self.buildings.insert(bid, updated);
        }
    }

    fn consume_light_standby(
        b: &mut BuildingInstance,
        bdef: &crate::schema::BuildingDef,
        recipe: &crate::schema::RecipeDef,
        companies: &mut HashMap<CompanyId, Company>,
    ) {
        if bdef.standby_power == 0 {
            return;
        }
        b.standby_ticks += 1;
        if b.standby_ticks >= recipe.cycle_ticks {
            b.standby_ticks = 0;
            if let Some(comp) = companies.get_mut(&b.owner_id) {
                let have = comp.ground_qty(&b.planet_id, "power");
                let take = have.min(bdef.standby_power);
                if take > 0 {
                    comp.add_ground_qty(&b.planet_id, "power", -(take as i64));
                }
            }
        }
    }

    fn pay_wages(&mut self, planet_id: &str, amount: Money) {
        if amount <= 0 {
            return;
        }
        self.ledger.total_wages_paid += amount as i128;
        let is_city = self
            .planets
            .get(planet_id)
            .map(|p| p.city_count > 0)
            .unwrap_or(false);
        if is_city {
            self.planets.get_mut(planet_id).unwrap().treasury += amount;
            return;
        }
        // Mining outposts keep 35% locally and remit 65% to habitable city planets
        let local = (amount * 35) / 100;
        let remit = amount - local;
        if let Some(p) = self.planets.get_mut(planet_id) {
            p.treasury += local;
        }
        self.credit_habitable_cities(remit);
    }

    fn credit_habitable_cities(&mut self, amount: Money) {
        self.credit_habitable_cities_for_system(None, amount);
    }

    fn credit_habitable_cities_for_system(&mut self, system_id: Option<&str>, amount: Money) {
        if amount <= 0 {
            return;
        }
        let mut cities: Vec<(PlanetId, f64)> = self
            .planets
            .values()
            .filter(|p| {
                p.city_count > 0
                    && p.population > 0.0
                    && system_id.is_none_or(|sid| p.system_id == sid)
            })
            .map(|p| (p.id.clone(), p.population))
            .collect();
        if cities.is_empty() && system_id.is_some() {
            cities = self
                .planets
                .values()
                .filter(|p| p.city_count > 0 && p.population > 0.0)
                .map(|p| (p.id.clone(), p.population))
                .collect();
        }
        let tot_pop: f64 = cities.iter().map(|(_, pop)| *pop).sum();
        if tot_pop <= 0.0 {
            // Even in extreme uninhabited seeds (0 cities everywhere), remit to first planet's
            // treasury so currency conservation holds strictly (`conservation_error == 0`).
            let fallback_pid = system_id
                .and_then(|sid| {
                    self.planets
                        .values()
                        .filter(|p| p.system_id == sid)
                        .map(|p| p.id.clone())
                        .min()
                })
                .or_else(|| self.planets.keys().min().cloned());
            if let Some(pid) = fallback_pid {
                if let Some(p) = self.planets.get_mut(&pid) {
                    credit_cash(&mut p.treasury, amount);
                }
            }
            return;
        }
        cities.sort_by(|a, b| a.0.cmp(&b.0));
        let mut distributed = 0;
        for (idx, (pid, pop)) in cities.iter().enumerate() {
            let share = if idx + 1 == cities.len() {
                amount - distributed
            } else {
                ((amount as f64) * (pop / tot_pop)).round() as Money
            };
            distributed += share;
            if let Some(p) = self.planets.get_mut(pid) {
                credit_cash(&mut p.treasury, share);
            }
        }
    }

    fn place_planet_demands(&mut self, planet_id: &str, tick: u64) -> HashMap<ItemId, u32> {
        let can_run = self
            .planets
            .get(planet_id)
            .is_some_and(|p| p.city_count > 0 && p.population > 0.0);
        if !can_run {
            return HashMap::new();
        }

        // Refund previous PLANET:* buy orders on this station FIRST so treasury reflects true liquid cash
        let sid = format!("ST:{planet_id}");
        let planet_owner = format!("PLANET:{planet_id}");
        let prev_ids: Vec<OrderId> = self
            .stations
            .get(&sid)
            .map(|st| {
                st.bids
                    .values()
                    .flat_map(|v| v.iter())
                    .filter(|o| o.owner_id == planet_owner)
                    .map(|o| o.order_id)
                    .collect()
            })
            .unwrap_or_default();
        for oid in prev_ids {
            if let Some(removed) = self.stations.get_mut(&sid).unwrap().remove_order(oid) {
                let p = self.planets.get_mut(planet_id).unwrap();
                credit_cash(&mut p.treasury, removed.escrow_cash);
            }
        }

        // Reality-aligned monetary loop: cities normally run on wages, taxes, storage rent, and bank
        // excess remittances rather than unconditional printing. Only drip an emergency subsistence
        // backstop when BOTH local treasury is below operational floor AND global circulation isn't bloated.
        let total_pop: f64 = self.planets.values().map(|pl| pl.population).sum();
        let active_companies = self.companies.len() as f64;
        let civic_cpi = self.cpi.clamp(0.5, 3.0);
        let max_comfortable_money = to_money(
            ((total_pop * 18.0 + active_companies * 12_000.0) * civic_cpi).max(300_000.0),
        ) as i128;
        let total_circ = self.total_currency_in_system();

        let demands = {
            let Some(p) = self.planets.get_mut(planet_id) else {
                return HashMap::new();
            };
            let treasury_floor = to_money((p.population * 2.2 * civic_cpi).max(2_500.0 * civic_cpi));
            if p.treasury < treasury_floor && total_circ < max_comfortable_money {
                let normal_drip =
                    to_money(p.population * p.civic_output_per_capita * p.prosperity * civic_cpi);
                let gap_drip = ((treasury_floor - p.treasury) / 4).max(1);
                let civic_mint = normal_drip.min(gap_drip).max(0);
                if civic_mint > 0 {
                    p.treasury += civic_mint;
                    self.ledger.record_mint(civic_mint);
                }
            }
            p.compute_demands(&self.catalog)
        };
        if demands.is_empty() {
            return demands;
        }

        // Independent per-item budget allocation (Engel's Law): share weights use structural
        // catalog baselines & necessity priorities rather than live runaway `ema_slow` prices,
        // so one spiked good (e.g. disposal_cert) can NEVER starve food/water/oxygen/power.
        let budget = {
            let p = &self.planets[planet_id];
            (p.treasury * 18) / 100
        };
        if budget <= 0 {
            return demands;
        }

        let hab = self.planets[planet_id].habitability;
        let env_mult = 1.0
            + (1.0 - if hab > 0.0 { hab.clamp(0.05, 1.0) } else { 0.85 }).max(0.0) * 0.35;
        let pop = self.planets[planet_id].population;

        let mut weights: HashMap<ItemId, f64> = HashMap::new();
        for (item, &qty) in &demands {
            let p = &self.planets[planet_id];
            let prev_q = *p.last_demands.get(item).unwrap_or(&qty);
            let prev_got = *p.last_bought.get(item).unwrap_or(&0);
            let prev_sat = (prev_got as f64 / prev_q.max(1) as f64).min(1.0);
            let urgency = 1.0 + 0.35 * (1.0 - prev_sat);

            let it_def = self.catalog.items.get(item);
            let base_ref = it_def.map(|i| i.ref_price).unwrap_or(4.0).max(0.5) * self.cpi;
            let priority = match it_def {
                Some(it) if it.has_tag("basic_survival") || it.has_tag("power") => 2.5,
                Some(it) if it.id == "disposal_cert" || it.has_tag("waste_service") => 0.70,
                Some(it) if it.wealth_tier <= 1 => 1.0,
                Some(_) => 0.85,
                None => 1.0,
            };
            let normal_q = it_def
                .map(|i| ((pop / 1000.0) * i.base_demand_per_1k * env_mult).round().max(1.0))
                .unwrap_or(qty as f64);
            let share_qty = (qty as f64).min(normal_q * 1.6);

            weights.insert(
                item.clone(),
                (share_qty * base_ref * priority * urgency).max(0.05),
            );
        }
        let total_w: f64 = weights.values().sum::<f64>().max(0.1);

        let mut spent_escrow: Money = 0;
        let treasury_avail = self.planets[planet_id].treasury;
        for (item, &qty) in &demands {
            let already_bought = *self.planets[planet_id]
                .bought_this_tick
                .get(item)
                .unwrap_or(&0);
            let rem_qty = qty.saturating_sub(already_bought);
            if rem_qty == 0 {
                continue;
            }
            let share = weights[item] / total_w;
            let full_item_budget = ((budget as f64) * share) as Money;
            let item_budget = (full_item_budget.saturating_mul(rem_qty as Money)) / (qty.max(1) as Money);
            if item_budget <= 0 {
                continue;
            }
            let item_cap = item_budget / (rem_qty.max(1) as Money);

            let st = &self.stations[&sid];
            let ba = st.best_ask(item);
            let last_p = *st
                .last_trade_price
                .get(item)
                .unwrap_or(&to_money(self.catalog.items[item].ref_price));
            let slow_p = *st.ema_slow.get(item).unwrap_or(&last_p);
            let prev_bid = *self.planets[planet_id].prev_bids.get(item).unwrap_or(&slow_p);
            // Smooth upward city procurement ramp (+8%/tick above prev_bid/slow EMA): lets real
            // shortages bid prices upward naturally while blocking 1-tick 50x thin-book spikes.
            let ramp_cap = prev_bid
                .max(slow_p)
                .saturating_mul(108)
                .saturating_div(100)
                .max(to_money(0.05 * self.cpi));
            let band_cap = price_band_max(self.reference_price_for(&sid, item));

            let (order_qty, raw_bid) = if let Some(ask_p) = ba {
                let admissible_ask = ask_p.min(ramp_cap).min(band_cap);
                if item_cap >= admissible_ask {
                    (rem_qty, ask_p.saturating_mul(103) / 100)
                } else if item_budget >= admissible_ask && admissible_ask > 0 {
                    // Within this item's isolated budget, buy as many units as affordable
                    let afford_q = (item_budget / admissible_ask)
                        .min(rem_qty as Money)
                        .clamp(0, u32::MAX as Money) as u32;
                    if afford_q == 0 {
                        continue;
                    }
                    (afford_q, admissible_ask)
                } else {
                    if item_cap <= 0 {
                        continue;
                    }
                    (rem_qty, item_cap)
                }
            } else {
                if item_cap <= 0 {
                    continue;
                }
                let b = item_cap
                    .min(last_p.saturating_mul(6))
                    .min((last_p.saturating_mul(108) / 100).max(prev_bid.saturating_mul(102) / 100))
                    .min(ramp_cap);
                (rem_qty, b)
            };

            let clean_bid = raw_bid
                .min(ramp_cap)
                .min(band_cap)
                .max(to_money(0.02 * self.cpi));
            // Checked qty*price: never let planet escrow wrap into a negative/free treasury.
            let Some(needed_escrow) = checked_notional(order_qty, clean_bid) else {
                continue;
            };
            if needed_escrow > item_budget {
                continue;
            }
            let Some(new_spent) = spent_escrow.checked_add(needed_escrow) else {
                continue;
            };
            if needed_escrow <= 0 || new_spent > treasury_avail {
                continue;
            }
            spent_escrow = new_spent;
            if !debit_cash(&mut self.planets.get_mut(planet_id).unwrap().treasury, needed_escrow) {
                continue;
            }
            self.planets
                .get_mut(planet_id)
                .unwrap()
                .prev_bids
                .insert(item.clone(), clean_bid);

            let oid = self.next_order_id;
            self.next_order_id += 1;
            self.stations.get_mut(&sid).unwrap().insert_order(Order {
                order_id: oid,
                owner_id: planet_owner.clone(),
                side: OrderSide::Buy,
                station_id: sid.clone(),
                item_id: item.clone(),
                qty: order_qty,
                total_qty: order_qty,
                price: clean_bid,
                escrow_cash: needed_escrow,
                created_tick: tick,
            });
        }
        self.planets.get_mut(planet_id).unwrap().last_demands = demands.clone();
        demands
    }

    pub fn apply_intent(&mut self, company_id: &str, intent: Intent, tick: u64) -> bool {
        self.apply_intent_detailed(company_id, intent, tick).is_ok()
    }

    pub fn apply_intent_detailed(
        &mut self,
        company_id: &str,
        intent: Intent,
        tick: u64,
    ) -> Result<(), (RetCode, &'static str)> {
        if !self.companies.contains_key(company_id) {
            return Err((ERR_NOT_OWNER, "company not found"));
        }
        match intent {
            Intent::CreateOrder {
                station_id,
                side,
                item_id,
                qty,
                price,
            } => {
                if qty == 0
                    || qty > MAX_ORDER_QTY
                    || price <= 0
                    || !self.catalog.items.contains_key(&item_id)
                {
                    return Err((ERR_INVALID_ARGS, "invalid qty, price, or item_id"));
                }
                if !self.stations.contains_key(&station_id) {
                    return Err((ERR_NOT_FOUND, "station not found"));
                }
                let ref_price = self.reference_price_for(&station_id, &item_id);
                // Unit price band: [1, ref_price * 100 * MONEY_SCALE]. Sell orders lock no cash but
                // a sky-high ask would still poison DealOrder/escrow settlement, so validate both.
                if !price_in_band(price, ref_price) {
                    return Err((ERR_INVALID_ARGS, "price outside admissible 100x band"));
                }
                // Checked qty*price: reject instead of letting `(qty * price) as Money` truncate.
                let Some(notional) = checked_notional(qty, price) else {
                    return Err((ERR_INVALID_ARGS, "order notional overflow"));
                };
                let active_orders: usize = self
                    .stations
                    .values()
                    .flat_map(|st| st.bids.values().chain(st.asks.values()))
                    .flat_map(|v| v.iter())
                    .filter(|o| o.owner_id == company_id)
                    .count();
                if active_orders >= MAX_ACTIVE_ORDERS_PER_COMPANY {
                    return Err((ERR_FULL, "active order limit (64) reached"));
                }
                // Prevent self-crossing on the same book
                let self_cross = match side {
                    OrderSide::Buy => self.stations[&station_id]
                        .asks
                        .get(&item_id)
                        .and_then(|v| v.iter().find(|o| o.owner_id == company_id))
                        .map(|o| price >= o.price)
                        .unwrap_or(false),
                    OrderSide::Sell => self.stations[&station_id]
                        .bids
                        .get(&item_id)
                        .and_then(|v| v.iter().find(|o| o.owner_id == company_id))
                        .map(|o| price <= o.price)
                        .unwrap_or(false),
                };
                if self_cross {
                    return Err((ERR_INVALID_TARGET, "would self-cross own resting order"));
                }

                let escrow_cash = match side {
                    OrderSide::Buy => {
                        let comp = self.companies.get_mut(company_id).unwrap();
                        if !debit_cash(&mut comp.cash, notional) {
                            return Err((ERR_NOT_ENOUGH_CREDITS, "insufficient cash for buy escrow"));
                        }
                        notional
                    }
                    OrderSide::Sell => {
                        let instant = self.is_instant_item(&item_id);
                        let comp = self.companies.get_mut(company_id).unwrap();
                        let st_have = comp.station_qty(&station_id, &item_id);
                        if st_have >= qty {
                            comp.add_station_qty(&station_id, &item_id, -(qty as i64));
                        } else if instant {
                            if let Some(pid) = station_id.strip_prefix("ST:") {
                                let g_have = comp.ground_qty(pid, &item_id);
                                if st_have + g_have < qty {
                                    return Err((ERR_NOT_ENOUGH_RESOURCES, "insufficient instant inventory"));
                                }
                                comp.add_station_qty(&station_id, &item_id, -(st_have as i64));
                                comp.add_ground_qty(pid, &item_id, -((qty - st_have) as i64));
                            } else {
                                return Err((ERR_NOT_ENOUGH_RESOURCES, "insufficient station inventory"));
                            }
                        } else {
                            return Err((ERR_NOT_ENOUGH_RESOURCES, "insufficient station inventory"));
                        }
                        0
                    }
                };

                let oid = self.next_order_id;
                self.next_order_id += 1;
                self.stations.get_mut(&station_id).unwrap().insert_order(Order {
                    order_id: oid,
                    owner_id: company_id.to_string(),
                    side,
                    station_id,
                    item_id,
                    qty,
                    total_qty: qty,
                    price,
                    escrow_cash,
                    created_tick: tick,
                });
                Ok(())
            }

            Intent::CancelOrder { order_id } => {
                let mut found = None;
                for st in self.stations.values_mut() {
                    if let Some(o) = st.remove_order(order_id) {
                        if o.owner_id == company_id {
                            found = Some(o);
                        } else {
                            // Put back untouched if caller doesn't own it
                            st.insert_order(o);
                            return Err((ERR_NOT_OWNER, "order belongs to another company"));
                        }
                        break;
                    }
                }
                let Some(order) = found else {
                    return Err((ERR_NOT_FOUND, "order no longer open"));
                };
                match order.side {
                    OrderSide::Buy => {
                        let comp = self.companies.get_mut(company_id).unwrap();
                        credit_cash(&mut comp.cash, order.escrow_cash);
                    }
                    OrderSide::Sell => {
                        self.companies.get_mut(company_id).unwrap().add_station_qty(
                            &order.station_id,
                            &order.item_id,
                            order.qty as i64,
                        );
                    }
                }
                Ok(())
            }

            Intent::DealOrder { order_id, amount } => {
                if amount == 0 {
                    return Err((ERR_INVALID_ARGS, "amount must be positive"));
                }
                let mut target_sid = None;
                let mut target_meta = None;
                for (sid, st) in &self.stations {
                    for o in st
                        .bids
                        .values()
                        .chain(st.asks.values())
                        .flat_map(|v| v.iter())
                    {
                        if o.order_id == order_id {
                            target_sid = Some(sid.clone());
                            target_meta = Some((o.owner_id != company_id, o.side, o.item_id.clone(), o.price));
                            break;
                        }
                    }
                }
                let (Some(sid), Some((not_self, side, item_id, target_price))) = (target_sid, target_meta) else {
                    return Err((ERR_NOT_FOUND, "order already filled or cancelled"));
                };
                if !not_self {
                    return Err((ERR_INVALID_TARGET, "cannot deal own order"));
                }
                // Enforce CLOB price priority: DealOrder cannot skip better-priced resting counterparty
                // orders (closes deep-book wash-trade / EMA-poisoning attacks).
                {
                    let st = &self.stations[&sid];
                    let has_better_counterparty = match side {
                        OrderSide::Sell => st
                            .asks
                            .get(&item_id)
                            .map(|v| v.iter().any(|o| o.owner_id != company_id && o.price < target_price))
                            .unwrap_or(false),
                        OrderSide::Buy => st
                            .bids
                            .get(&item_id)
                            .map(|v| v.iter().any(|o| o.owner_id != company_id && o.price > target_price))
                            .unwrap_or(false),
                    };
                    if has_better_counterparty {
                        return Err((ERR_INVALID_TARGET, "better-priced order exists ahead in book"));
                    }
                }
                let order = self.stations.get_mut(&sid).unwrap().remove_order(order_id).unwrap();
                let take = amount.min(order.qty).min(MAX_ORDER_QTY);
                if take == 0 {
                    self.stations.get_mut(&sid).unwrap().insert_order(order);
                    return Err((ERR_NOT_FOUND, "order has zero remaining qty"));
                }
                // Checked notional + mandatory price band on the resting order. A negative or
                // truncated `(take * price) as Money` must never reach the cash ledger.
                let ref_price = self.reference_price_for(&sid, &order.item_id);
                let Some(notional) = checked_notional(take, order.price) else {
                    self.stations.get_mut(&sid).unwrap().insert_order(order);
                    return Err((ERR_INVALID_ARGS, "deal notional overflow"));
                };
                if notional <= 0 || !price_in_band(order.price, ref_price) {
                    self.stations.get_mut(&sid).unwrap().insert_order(order);
                    return Err((ERR_INVALID_TARGET, "target order price outside admissible band"));
                }
                match order.side {
                    OrderSide::Sell => {
                        // Caller buys from resting Sell order
                        let comp = self.companies.get_mut(company_id).unwrap();
                        if !debit_cash(&mut comp.cash, notional) {
                            self.stations.get_mut(&sid).unwrap().insert_order(order);
                            return Err((ERR_NOT_ENOUGH_CREDITS, "insufficient cash for deal"));
                        }
                        let fee = bps_of(notional, self.stations[&sid].fee_bps);
                        let fill = TradeFill {
                            tick,
                            station_id: sid.clone(),
                            item_id: order.item_id.clone(),
                            qty: take,
                            price: order.price,
                            notional,
                            fee,
                            seller_proceeds: notional.saturating_sub(fee),
                            buyer_refund: 0,
                            buyer_id: company_id.to_string(),
                            seller_id: order.owner_id.clone(),
                        };
                        self.stations
                            .get_mut(&sid)
                            .unwrap()
                            .record_trade_stats(&order.item_id, tick, take, order.price);
                        self.settle_trade_fill(&fill);
                        if order.qty > take {
                            let mut rem = order;
                            rem.qty -= take;
                            self.stations.get_mut(&sid).unwrap().insert_order(rem);
                        }
                        Ok(())
                    }
                    OrderSide::Buy => {
                        // Caller sells into resting Buy order. The resting bid must have escrowed
                        // at least the fill notional, otherwise `escrow_cash -= notional` would go
                        // negative (and the buyer would be credited cash it never locked).
                        if order.escrow_cash < notional {
                            eprintln!(
                                "[meridian-core] rejecting DealOrder into under-escrowed bid {}: escrow={} notional={}",
                                order.order_id, order.escrow_cash, notional
                            );
                            self.stations.get_mut(&sid).unwrap().insert_order(order);
                            return Err((ERR_INVALID_TARGET, "target bid under-escrowed"));
                        }
                        let instant = self.is_instant_item(&order.item_id);
                        let comp = self.companies.get_mut(company_id).unwrap();
                        let st_have = comp.station_qty(&sid, &order.item_id);
                        if st_have >= take {
                            comp.add_station_qty(&sid, &order.item_id, -(take as i64));
                        } else if instant {
                            if let Some(pid) = sid.strip_prefix("ST:") {
                                let g_have = comp.ground_qty(pid, &order.item_id);
                                if st_have + g_have < take {
                                    self.stations.get_mut(&sid).unwrap().insert_order(order);
                                    return Err((ERR_NOT_ENOUGH_RESOURCES, "insufficient instant inventory for deal"));
                                }
                                comp.add_station_qty(&sid, &order.item_id, -(st_have as i64));
                                comp.add_ground_qty(pid, &order.item_id, -((take - st_have) as i64));
                            } else {
                                self.stations.get_mut(&sid).unwrap().insert_order(order);
                                return Err((ERR_NOT_ENOUGH_RESOURCES, "insufficient station inventory for deal"));
                            }
                        } else {
                            self.stations.get_mut(&sid).unwrap().insert_order(order);
                            return Err((ERR_NOT_ENOUGH_RESOURCES, "insufficient station inventory for deal"));
                        }

                        let fee = bps_of(notional, self.stations[&sid].fee_bps);
                        let residual_escrow = order.escrow_cash - notional;
                        // Full fill: any leftover escrow (normally zero) is refunded rather than
                        // silently destroyed; partial fill keeps it locked for the remainder.
                        let buyer_refund = if order.qty > take {
                            0
                        } else {
                            residual_escrow
                        };
                        let fill = TradeFill {
                            tick,
                            station_id: sid.clone(),
                            item_id: order.item_id.clone(),
                            qty: take,
                            price: order.price,
                            notional,
                            fee,
                            seller_proceeds: notional.saturating_sub(fee),
                            buyer_refund,
                            buyer_id: order.owner_id.clone(),
                            seller_id: company_id.to_string(),
                        };
                        self.stations
                            .get_mut(&sid)
                            .unwrap()
                            .record_trade_stats(&order.item_id, tick, take, order.price);
                        self.settle_trade_fill(&fill);
                        if order.qty > take {
                            let mut rem = order;
                            rem.qty -= take;
                            rem.escrow_cash = residual_escrow;
                            self.stations.get_mut(&sid).unwrap().insert_order(rem);
                        }
                        Ok(())
                    }
                }
            }

            Intent::SetRecipe {
                building_id,
                recipe_id,
            } => {
                let Some(b) = self.buildings.get(&building_id) else {
                    return Err((ERR_NOT_FOUND, "building not found"));
                };
                if b.owner_id != company_id {
                    return Err((ERR_NOT_OWNER, "building owned by another company"));
                }
                let Some(rec) = self.catalog.recipes.get(&recipe_id) else {
                    return Err((ERR_INVALID_ARGS, "recipe does not exist"));
                };
                if !rec.enabled || rec.building_id != b.building_type {
                    return Err((ERR_INVALID_TARGET, "recipe disabled or incompatible with building"));
                }
                self.buildings.get_mut(&building_id).unwrap().recipe_id = recipe_id;
                Ok(())
            }

            Intent::ToggleBuilding {
                building_id,
                active,
            } => {
                let Some(b) = self.buildings.get_mut(&building_id) else {
                    return Err((ERR_NOT_FOUND, "building not found"));
                };
                if b.owner_id != company_id {
                    return Err((ERR_NOT_OWNER, "building owned by another company"));
                }
                b.active = active;
                Ok(())
            }

            Intent::BuildFacility {
                plot_id,
                building_type,
            } => {
                let Some(bdef) = self.catalog.buildings.get(&building_type).cloned() else {
                    return Err((ERR_INVALID_ARGS, "unknown building type"));
                };
                let Some(plot) = self.plots.get(&plot_id) else {
                    return Err((ERR_NOT_FOUND, "plot not found"));
                };
                if plot.owner_id.as_deref() != Some(company_id) {
                    return Err((ERR_NOT_OWNER, "plot owned by another company"));
                }
                if plot.used_slots() + bdef.slots_used > plot.capacity {
                    return Err((ERR_FULL, "plot capacity exceeded"));
                }
                let pid = plot.planet_id.clone();
                let cash_fee = to_money(80.0 * self.cpi);
                let comp = self.companies.get(company_id).unwrap();
                if comp.cash < cash_fee {
                    return Err((ERR_NOT_ENOUGH_CREDITS, "insufficient cash for construction fee"));
                }
                for req in &bdef.build_cost {
                    if comp.ground_qty(&pid, &req.item) < req.qty {
                        return Err((ERR_NOT_ENOUGH_RESOURCES, "insufficient ground materials for build"));
                    }
                }
                let comp = self.companies.get_mut(company_id).unwrap();
                comp.cash -= cash_fee;
                for req in &bdef.build_cost {
                    comp.add_ground_qty(&pid, &req.item, -(req.qty as i64));
                }
                self.pay_wages(&pid, cash_fee);
                let job_id = self.next_building_id;
                self.next_building_id += 1;
                self.plots.get_mut(&plot_id).unwrap().jobs.push(SiteJob {
                    id: job_id,
                    action: "build".to_string(),
                    building_type,
                    finish_tick: tick + bdef.build_ticks as u64,
                });
                Ok(())
            }

            Intent::DemolishFacility {
                plot_id,
                building_id,
            } => {
                let Some(plot) = self.plots.get_mut(&plot_id) else {
                    return Err((ERR_NOT_FOUND, "plot not found"));
                };
                if plot.owner_id.as_deref() != Some(company_id) {
                    return Err((ERR_NOT_OWNER, "plot owned by another company"));
                }
                let Some(pos) = plot.building_ids.iter().position(|&id| id == building_id) else {
                    return Err((ERR_NOT_FOUND, "building not on plot"));
                };
                plot.building_ids.remove(pos);
                if let Some(removed) = self.buildings.remove(&building_id) {
                    if let Some(bdef) = self.catalog.buildings.get(&removed.building_type) {
                        if let Some(comp) = self.companies.get_mut(company_id) {
                            for req in &bdef.build_cost {
                                let salvage = req.qty / 2;
                                if salvage > 0 {
                                    comp.add_ground_qty(&removed.planet_id, &req.item, salvage as i64);
                                }
                            }
                        }
                    }
                }
                Ok(())
            }

            Intent::BuyPlot {
                planet_id,
                slot_id,
                listing_id,
            } => {
                if !self.planets.contains_key(&planet_id) {
                    return Err((ERR_NOT_FOUND, "planet not found"));
                }
                // Players CAN monopolize a planet using earned money, but cannot expand land while
                // in overdue loan default.
                if self.companies[company_id].is_debt_overdue(tick) {
                    return Err((ERR_NOT_ENOUGH_CREDITS, "loan overdue blocks land purchase"));
                }
                if !self.companies[company_id].is_player {
                    let buying_bank_listing = listing_id.is_some_and(|lid| {
                        self.planets[&planet_id]
                            .land_listings
                            .iter()
                            .any(|l| l.listing_id == lid && l.seller_id == "BANK")
                    });
                    if !buying_bank_listing {
                        let reserved_player_plots =
                            (self.planets[&planet_id].total_developable_plots / 10).max(1);
                        let cap_hit = self.npc_plot_count_on(&planet_id)
                            >= self.npc_plot_cap_on(&planet_id);
                        let virgin_reserve_hit = listing_id.is_none()
                            && self.planets[&planet_id].unclaimed_plots_remaining
                                <= reserved_player_plots;
                        if cap_hit || virgin_reserve_hit {
                            return Err((ERR_FULL, "NPC planet plot cap reached"));
                        }
                    }
                }
                if let Some(lid) = listing_id {
                    let pos = self.planets[&planet_id]
                        .land_listings
                        .iter()
                        .position(|l| l.listing_id == lid);
                    let Some(idx) = pos else {
                        return Err((ERR_NOT_FOUND, "land listing already sold or cancelled"));
                    };
                    let lst = &self.planets[&planet_id].land_listings[idx];
                    if lst.seller_id == company_id {
                        return Err((ERR_INVALID_TARGET, "cannot buy own land listing"));
                    }
                    if self.companies[company_id].cash < lst.ask_price {
                        return Err((ERR_NOT_ENOUGH_CREDITS, "insufficient cash for land listing"));
                    }
                    let lst = self
                        .planets
                        .get_mut(&planet_id)
                        .unwrap()
                        .land_listings
                        .remove(idx);
                    if !debit_cash(&mut self.companies.get_mut(company_id).unwrap().cash, lst.ask_price) {
                        return Err((ERR_NOT_ENOUGH_CREDITS, "insufficient cash for land listing"));
                    }
                    if lst.seller_id == "BANK" {
                        let p = self.planets.get_mut(&planet_id).unwrap();
                        let pay_debt = lst.debt_recovery.min(lst.ask_price);
                        p.bank.total_loans = p.bank.total_loans.saturating_sub(pay_debt);
                        credit_cash(&mut p.bank.reserves, lst.ask_price);
                    } else if self.companies.contains_key(&lst.seller_id) {
                        self.credit_seller_revenue(&lst.seller_id, lst.ask_price, tick);
                    } else {
                        credit_cash(&mut self.planets.get_mut(&planet_id).unwrap().treasury, lst.ask_price);
                    }
                    let mut bought_slot: Option<SlotId> = None;
                    if let Some(pl) = self.plots.get_mut(&lst.plot_id) {
                        pl.owner_id = Some(company_id.to_string());
                        pl.jobs.clear(); // Cancel unfinished seller construction on ownership transfer (BL-06)
                        bought_slot = Some(pl.slot_id);
                        for &bid in &pl.building_ids {
                            if let Some(b) = self.buildings.get_mut(&bid) {
                                b.owner_id = company_id.to_string();
                                b.active_batch = false;
                                b.progress = 0;
                                b.idle_ticks = 0;
                            }
                        }
                    }
                    if let Some(sid) = bought_slot {
                        self.planets
                            .get_mut(&planet_id)
                            .unwrap()
                            .set_tile_owner(sid, Some(company_id.to_string()), Some(lst.plot_id));
                    }
                    self.companies.get_mut(company_id).unwrap().plots.push(lst.plot_id);
                    Ok(())
                } else if let Some(sid) = slot_id {
                    let price = self.planets[&planet_id].primary_land_price(self.cpi);
                    if self.companies[company_id].cash < price {
                        return Err((ERR_NOT_ENOUGH_CREDITS, "insufficient cash for primary plot"));
                    }
                    let plot_id = self.next_plot_id;
                    let Some(plot) = self
                        .planets
                        .get_mut(&planet_id)
                        .unwrap()
                        .claim_surface_tile(
                            Some(sid),
                            None,
                            plot_id,
                            Some(company_id.to_string()),
                            &self.catalog,
                        )
                    else {
                        return Err((ERR_NOT_FOUND, "land slot unavailable or already claimed"));
                    };
                    self.next_plot_id += 1;
                    self.companies.get_mut(company_id).unwrap().cash -= price;
                    self.planets.get_mut(&planet_id).unwrap().treasury += price;
                    self.plots.insert(plot_id, plot);
                    self.companies.get_mut(company_id).unwrap().plots.push(plot_id);
                    Ok(())
                } else {
                    Err((ERR_INVALID_ARGS, "missing slot_id or listing_id"))
                }
            }

            Intent::DispatchShip {
                ship_id,
                from,
                to,
                cargo,
            } => {
                let Some(ship_snap) = self.companies[company_id]
                    .ships
                    .iter()
                    .find(|s| s.id == ship_id)
                    .cloned()
                else {
                    return Err((ERR_NOT_OWNER, "ship not found or not owned"));
                };
                if ship_snap.is_busy(tick) {
                    return Err((ERR_BUSY, "ship is in flight"));
                }
                if ship_snap.location != from {
                    return Err((ERR_NOT_IN_RANGE, "ship location changed before dispatch"));
                }
                let Some(route) = compute_route_in_systems(
                    &from,
                    &to,
                    ship_snap.size,
                    ship_snap.durability,
                    &self.planets,
                    &self.systems,
                    self.hub_orbit_radius,
                    self.hub_orbit_angle,
                ) else {
                    return Err((ERR_NO_PATH, "no route between locations"));
                };
                // Aggregate total requested cargo & validate non-zero quantities + capacity
                let mut clean_cargo: HashMap<ItemId, u32> = HashMap::new();
                let mut total_units = 0u32;
                for (it, qty) in cargo {
                    if qty == 0 || !self.catalog.items.contains_key(&it) {
                        return Err((ERR_INVALID_ARGS, "invalid cargo item or zero qty"));
                    }
                    *clean_cargo.entry(it).or_insert(0) += qty;
                    total_units = total_units.saturating_add(qty);
                }
                if total_units > ship_snap.capacity() {
                    return Err((ERR_FULL, "cargo exceeds ship capacity"));
                }

                let fuel_item = self
                    .catalog
                    .fuel_item
                    .clone()
                    .unwrap_or_else(|| "fuel".to_string());

                // Verify company has fuel + cargo at `from`
                {
                    let comp = &self.companies[company_id];
                    let is_st = from.starts_with("ST:");
                    let fuel_have = if is_st {
                        comp.station_qty(&from, &fuel_item)
                    } else {
                        comp.ground_qty(&from, &fuel_item)
                    };
                    let cargo_fuel = *clean_cargo.get(&fuel_item).unwrap_or(&0);
                    if fuel_have < route.fuel + cargo_fuel {
                        return Err((ERR_NOT_ENOUGH_RESOURCES, "insufficient fuel at origin"));
                    }
                    for (it, &q) in &clean_cargo {
                        if it == &fuel_item {
                            continue;
                        }
                        let have = if is_st {
                            comp.station_qty(&from, it)
                        } else {
                            comp.ground_qty(&from, it)
                        };
                        if have < q {
                            return Err((ERR_NOT_ENOUGH_RESOURCES, "insufficient cargo at origin"));
                        }
                    }
                }

                // Deduct cargo & fuel, launch ship
                let is_st = from.starts_with("ST:");
                let comp = self.companies.get_mut(company_id).unwrap();
                if is_st {
                    comp.add_station_qty(&from, &fuel_item, -(route.fuel as i64));
                    for (it, &q) in &clean_cargo {
                        comp.add_station_qty(&from, it, -(q as i64));
                    }
                } else {
                    comp.add_ground_qty(&from, &fuel_item, -(route.fuel as i64));
                    for (it, &q) in &clean_cargo {
                        comp.add_ground_qty(&from, it, -(q as i64));
                    }
                }

                let wear_mult = if route.kind == RouteKind::Interplanetary {
                    1.4
                } else {
                    1.0
                };
                if let Some(ship) = comp.ships.iter_mut().find(|s| s.id == ship_id) {
                    ship.busy_until = tick + route.ticks as u64;
                    ship.durability = (ship.durability - ship.size.wear_per_trip() * wear_mult).max(0.0);
                    ship.cargo = clean_cargo.clone();
                }

                self.in_flight.push(ShipInFlight {
                    ship_id,
                    owner_id: company_id.to_string(),
                    from,
                    to,
                    cargo: clean_cargo.into_iter().collect(),
                    launch_tick: tick,
                    arrival_tick: tick + route.ticks as u64,
                });
                Ok(())
            }

            Intent::RepairShip { ship_id } => {
                let Some(repair_item) = self.catalog.repair_item.clone() else {
                    return Err((ERR_INVALID_TARGET, "repair item not configured in catalog"));
                };
                let comp = self.companies.get_mut(company_id).unwrap();
                let Some(idx) = comp.ships.iter().position(|s| s.id == ship_id) else {
                    return Err((ERR_NOT_OWNER, "ship not found"));
                };
                if comp.ships[idx].is_busy(tick) {
                    return Err((ERR_BUSY, "ship is in flight"));
                }
                if comp.ships[idx].durability >= 99.9 {
                    return Err((ERR_INVALID_TARGET, "ship already at full durability"));
                }
                let loc = comp.ships[idx].location.clone();
                let need = comp.ships[idx].size.repair_cost();
                if loc.starts_with("ST:") {
                    if comp.station_qty(&loc, &repair_item) < need {
                        return Err((ERR_NOT_ENOUGH_RESOURCES, "insufficient repair parts at station"));
                    }
                    comp.add_station_qty(&loc, &repair_item, -(need as i64));
                } else {
                    if comp.ground_qty(&loc, &repair_item) < need {
                        return Err((ERR_NOT_ENOUGH_RESOURCES, "insufficient repair parts on ground"));
                    }
                    comp.add_ground_qty(&loc, &repair_item, -(need as i64));
                }
                comp.ships[idx].durability = 100.0;
                Ok(())
            }

            Intent::BankOp {
                planet_id,
                op,
                amount,
            } => {
                if amount <= 0 || !self.planets.contains_key(&planet_id) {
                    return Err((ERR_INVALID_ARGS, "invalid bank amount or planet"));
                }
                if self.companies[company_id].home_planet_id != planet_id {
                    return Err((ERR_INVALID_TARGET, "banking only permitted on home planet"));
                }
                match op {
                    BankOpKind::Deposit => {
                        if self.companies[company_id].cash < amount {
                            return Err((ERR_NOT_ENOUGH_CREDITS, "insufficient cash for deposit"));
                        }
                        self.companies.get_mut(company_id).unwrap().cash -= amount;
                        self.companies.get_mut(company_id).unwrap().savings += amount;
                        let p = self.planets.get_mut(&planet_id).unwrap();
                        p.bank.reserves += amount;
                        p.bank.total_deposits += amount;
                        Ok(())
                    }
                    BankOpKind::Withdraw => {
                        let comp = &self.companies[company_id];
                        let p = &self.planets[&planet_id];
                        if comp.savings < amount {
                            return Err((ERR_NOT_ENOUGH_CREDITS, "insufficient savings balance"));
                        }
                        if p.bank.reserves < amount {
                            return Err((ERR_NOT_ENOUGH_RESOURCES, "bank reserves too low"));
                        }
                        self.companies.get_mut(company_id).unwrap().savings -= amount;
                        self.companies.get_mut(company_id).unwrap().cash += amount;
                        let p = self.planets.get_mut(&planet_id).unwrap();
                        p.bank.reserves -= amount;
                        p.bank.total_deposits -= amount;
                        Ok(())
                    }
                    BankOpKind::Borrow => {
                        let credit_limit = self.company_credit_limit(company_id);
                        let comp = &self.companies[company_id];
                        if comp.is_debt_overdue(tick) {
                            return Err((ERR_INVALID_TARGET, "overdue debt blocks new borrowing"));
                        }
                        let Some(next_debt) = comp.debt.checked_add(amount) else {
                            return Err((ERR_INVALID_ARGS, "loan amount overflow"));
                        };
                        if next_debt > credit_limit {
                            return Err((ERR_FULL, "credit limit exceeded"));
                        }
                        let p = &self.planets[&planet_id];
                        let min_reserves = bps_of(p.bank.total_deposits, BANK_MIN_RESERVE_BPS);
                        let lendable = p.bank.reserves.saturating_sub(min_reserves);
                        if lendable < amount {
                            return Err((ERR_NOT_ENOUGH_RESOURCES, "bank lendable liquidity insufficient"));
                        }
                        let p_mut = self.planets.get_mut(&planet_id).unwrap();
                        p_mut.bank.reserves -= amount;
                        p_mut.bank.total_loans = p_mut.bank.total_loans.saturating_add(amount);
                        let c_mut = self.companies.get_mut(company_id).unwrap();
                        credit_cash(&mut c_mut.cash, amount);
                        c_mut.debt = next_debt;
                        if c_mut.debt_due_tick.is_none() {
                            c_mut.debt_due_tick = Some(tick + LOAN_TERM_TICKS);
                        }
                        Ok(())
                    }
                    BankOpKind::Repay => {
                        let comp = &self.companies[company_id];
                        let repay = amount.min(comp.debt);
                        if repay <= 0 || comp.cash < repay {
                            return Err((ERR_NOT_ENOUGH_CREDITS, "no debt or insufficient cash to repay"));
                        }
                        let c_mut = self.companies.get_mut(company_id).unwrap();
                        c_mut.cash -= repay;
                        c_mut.debt -= repay;
                        if c_mut.debt == 0 {
                            c_mut.debt_due_tick = None;
                        }
                        let p = self.planets.get_mut(&planet_id).unwrap();
                        p.bank.total_loans = p.bank.total_loans.saturating_sub(repay);
                        credit_cash(&mut p.bank.reserves, repay);
                        Ok(())
                    }
                }
            }
        }
    }

    fn refund_evicted_order(&mut self, order: Order) {
        match order.side {
            OrderSide::Buy => {
                if order.escrow_cash <= 0 {
                    return;
                }
                if let Some(pid) = order.owner_id.strip_prefix("PLANET:") {
                    if let Some(p) = self.planets.get_mut(pid) {
                        credit_cash(&mut p.treasury, order.escrow_cash);
                    }
                } else if let Some(c) = self.companies.get_mut(&order.owner_id) {
                    credit_cash(&mut c.cash, order.escrow_cash);
                }
            }
            OrderSide::Sell => {
                if order.qty == 0 {
                    return;
                }
                if let Some(c) = self.companies.get_mut(&order.owner_id) {
                    c.add_station_qty(&order.station_id, &order.item_id, order.qty as i64);
                }
            }
        }
    }

    fn settle_trade_fill(&mut self, fill: &TradeFill) {
        // 1. Refund excess buy escrow (price improvement), checked against i64 wrap-around.
        if fill.buyer_refund > 0 {
            if let Some(pid) = fill.buyer_id.strip_prefix("PLANET:") {
                if let Some(p) = self.planets.get_mut(pid) {
                    credit_cash(&mut p.treasury, fill.buyer_refund);
                }
            } else if let Some(b) = self.companies.get_mut(&fill.buyer_id) {
                credit_cash(&mut b.cash, fill.buyer_refund);
            }
        }

        // 2. Credit seller proceeds (with 25% overdue loan garnishment when applicable)
        if fill.seller_id == "BANK" {
            if let Some(bank_pid) = self.default_bank_planet_id(&fill.station_id) {
                if let Some(p) = self.planets.get_mut(&bank_pid) {
                    credit_cash(&mut p.bank.reserves, fill.seller_proceeds);
                }
            }
        } else {
            self.credit_seller_revenue(&fill.seller_id, fill.seller_proceeds, fill.tick);
        }

        // 3. Credit trade station fee (0.5%) to station planet treasury (Hub -> system habitable cities)
        self.ledger.total_trade_fees += fill.fee as i128;
        if let Some(sys_id) = self.system_by_hub(&fill.station_id) {
            self.credit_habitable_cities_for_system(Some(&sys_id), fill.fee);
        } else if let Some(pid) = fill.station_id.strip_prefix("ST:") {
            if let Some(p) = self.planets.get_mut(pid) {
                credit_cash(&mut p.treasury, fill.fee);
            } else {
                self.credit_habitable_cities(fill.fee);
            }
        }

        // 4. Deliver goods to buyer
        if let Some(pid) = fill.buyer_id.strip_prefix("PLANET:") {
            if let Some(p) = self.planets.get_mut(pid) {
                let qty = p.bought_this_tick.entry(fill.item_id.clone()).or_insert(0);
                *qty = qty.saturating_add(fill.qty);
            }
        } else {
            let instant = self.is_instant_item(&fill.item_id);
            let is_ship = fill.item_id == "ship_small"
                || fill.item_id == "ship_medium"
                || fill.item_id == "ship_large";
            if is_ship {
                let sz = match fill.item_id.as_str() {
                    "ship_large" => ShipSize::Large,
                    "ship_medium" => ShipSize::Medium,
                    _ => ShipSize::Small,
                };
                for _ in 0..fill.qty {
                    let sid_ship = self.next_ship_id;
                    self.next_ship_id += 1;
                    if let Some(b) = self.companies.get_mut(&fill.buyer_id) {
                        b.ships.push(Ship {
                            id: sid_ship,
                            owner_id: fill.buyer_id.clone(),
                            size: sz,
                            durability: 100.0,
                            location: fill.station_id.clone(),
                            busy_until: 0,
                            cargo: HashMap::new(),
                        });
                    }
                }
            } else if instant {
                if let Some(pid) = fill.station_id.strip_prefix("ST:") {
                    if self.planets.contains_key(pid) {
                        if let Some(b) = self.companies.get_mut(&fill.buyer_id) {
                            b.add_ground_qty(pid, &fill.item_id, fill.qty as i64);
                        }
                        return;
                    }
                }
                if let Some(b) = self.companies.get_mut(&fill.buyer_id) {
                    b.add_station_qty(&fill.station_id, &fill.item_id, fill.qty as i64);
                }
            } else if let Some(b) = self.companies.get_mut(&fill.buyer_id) {
                b.add_station_qty(&fill.station_id, &fill.item_id, fill.qty as i64);
            }
        }
    }

    fn charge_hub_storage_rent(&mut self) {
        let mut hub_pairs: Vec<(Option<String>, StationId)> = self
            .systems
            .values()
            .map(|s| (Some(s.id.clone()), s.hub_station_id.clone()))
            .collect();
        if hub_pairs.is_empty() && self.stations.contains_key("ST:HUB") {
            hub_pairs.push((Some("S1".to_string()), "ST:HUB".to_string()));
        }

        for (sys_id, hub_sid) in hub_pairs {
            let Some(hub) = self.stations.get(&hub_sid) else {
                continue;
            };
            let mut rent_collected = 0;
            for comp in self.companies.values_mut() {
                let Some(inv) = comp.station_inv.get(&hub_sid) else {
                    continue;
                };
                let mut due = 0;
                for (it, &qty) in inv {
                    if qty == 0 {
                        continue;
                    }
                    let px = *hub
                        .last_trade_price
                        .get(it)
                        .unwrap_or(&to_money(
                            self.catalog.items.get(it).map(|x| x.ref_price).unwrap_or(1.0),
                        ));
                    let val = (qty as i128 * px as i128) as Money;
                    // Light 0.8% Hub storage rent every 12 ticks (~1.6%/day)
                    due += bps_of(val, 80);
                }
                let paid = comp.cash.min(due);
                if paid > 0 {
                    comp.cash -= paid;
                    rent_collected += paid;
                }
            }
            if rent_collected > 0 {
                self.ledger.total_storage_fees += rent_collected as i128;
                self.credit_habitable_cities_for_system(sys_id.as_deref(), rent_collected);
            }
        }
    }

    fn accrue_bank_interest(&mut self) {
        // Savings & loan interest accrue strictly via bank reserves when paid/backed
        for comp in self.companies.values_mut() {
            let Some(p) = self.planets.get_mut(&comp.home_planet_id) else {
                continue;
            };
            if comp.savings > 0 {
                let intr = ((comp.savings as f64) * p.bank.deposit_tick_rate()).round() as Money;
                // Only accrue savings interest backed by excess bank reserves;
                // reserves themselves are transferred to cash upon Withdraw.
                if intr > 0 && p.bank.reserves >= p.bank.total_deposits.saturating_add(intr) {
                    p.bank.total_deposits += intr;
                    comp.savings += intr;
                }
            }
            if comp.debt > 0 {
                let intr = ((comp.debt as f64) * p.bank.loan_tick_rate()).round() as Money;
                if intr > 0 {
                    comp.debt += intr;
                    p.bank.total_loans += intr;
                }
            }
        }
    }

    fn process_npc_bankruptcies(&mut self, tick: u64) -> Vec<CompanyId> {
        let mut dead = Vec::new();
        for (cid, comp) in &mut self.companies {
            // Players are NEVER force-bankrupted!
            if comp.is_player {
                comp.distress_ticks = 0;
                continue;
            }
            let Some(home_p) = self.planets.get(&comp.home_planet_id) else {
                continue;
            };
            let blds: Vec<&BuildingInstance> = comp
                .plots
                .iter()
                .filter_map(|pid| self.plots.get(pid))
                .flat_map(|pl| pl.building_ids.iter().filter_map(|bid| self.buildings.get(bid)))
                .collect();
            let bld_count = blds.len();
            let est_assets = to_money(
                (comp.plots.len() as f64) * from_money(home_p.primary_land_price(self.cpi)) * 0.8
                    + (bld_count as f64) * 140.0 * self.cpi
                    + (comp.ships.len() as f64) * 260.0 * self.cpi,
            ) + comp.cash
                + comp.savings;

            let liquid = comp.cash + comp.savings;
            let insolvent = liquid < to_money(50.0 * self.cpi) && comp.debt > (est_assets * 3) / 4;
            let all_stalled = bld_count > 0
                && blds
                    .iter()
                    .all(|b| !b.active_batch && b.idle_ticks >= 96);
            let stalled_broke = liquid < to_money(75.0 * self.cpi) && all_stalled;
            let deep_zombie_240 = bld_count > 0
                && liquid < to_money(450.0 * self.cpi)
                && blds
                    .iter()
                    .all(|b| !b.active_batch && b.idle_ticks >= 240);
            let deep_zombie_960 = bld_count > 0
                && blds
                    .iter()
                    .all(|b| !b.active_batch && b.idle_ticks >= 960);
            if insolvent || stalled_broke || deep_zombie_240 || deep_zombie_960 {
                comp.distress_ticks += 1;
            } else {
                comp.distress_ticks = 0;
            }
            if (insolvent && comp.distress_ticks >= 36) || comp.distress_ticks >= 72 {
                dead.push(cid.clone());
            }
        }

        for cid in &dead {
            let comp = self.companies.remove(cid).unwrap();
            // Cancel open orders & return escrowed cash cleanly before reclaiming company
            let mut returned_cash = comp.cash;
            let mut confiscated_station_inv = comp.station_inv.clone();
            for (sid, st) in &mut self.stations {
                let ids: Vec<OrderId> = st
                    .bids
                    .values()
                    .chain(st.asks.values())
                    .flat_map(|v| v.iter())
                    .filter(|o| o.owner_id == *cid)
                    .map(|o| o.order_id)
                    .collect();
                for oid in ids {
                    if let Some(o) = st.remove_order(oid) {
                        match o.side {
                            OrderSide::Buy => {
                                returned_cash = returned_cash.saturating_add(o.escrow_cash)
                            }
                            OrderSide::Sell => {
                                let q = confiscated_station_inv
                                    .entry(sid.clone())
                                    .or_default()
                                    .entry(o.item_id)
                                    .or_insert(0);
                                *q = q.saturating_add(o.qty);
                            }
                        }
                    }
                }
            }

            if let Some(home_p) = self.planets.get_mut(&comp.home_planet_id) {
                home_p.bank.total_loans = home_p.bank.total_loans.saturating_sub(comp.debt);
                home_p.bank.total_deposits = home_p.bank.total_deposits.saturating_sub(comp.savings);
                // Settle remaining cash back to bank reserves (zero currency destruction!)
                credit_cash(&mut home_p.bank.reserves, returned_cash);
            }

            // Confiscated station inventory becomes BANK liquidation asks
            for (sid, items_map) in confiscated_station_inv {
                if let Some(st) = self.stations.get_mut(&sid) {
                    for (item_id, qty) in items_map {
                        if qty == 0 {
                            continue;
                        }
                        let last_p = *st
                            .last_trade_price
                            .get(&item_id)
                            .unwrap_or(&to_money(1.0));
                        let ask_p =
                            (last_p.saturating_mul(88) / 100).max(to_money(0.1 * self.cpi));
                        let oid = self.next_order_id;
                        self.next_order_id += 1;
                        st.insert_order(Order {
                            order_id: oid,
                            owner_id: "BANK".to_string(),
                            side: OrderSide::Sell,
                            station_id: sid.clone(),
                            item_id,
                            qty,
                            total_qty: qty,
                            price: ask_p,
                            escrow_cash: 0,
                            created_tick: tick,
                        });
                    }
                }
            }

            // Drop in-flight ships belonging to dead NPC & list plots for BANK auction
            self.in_flight.retain(|f| f.owner_id != *cid);
            let land_base = self.planets[&comp.home_planet_id].primary_land_price(self.cpi);
            for pl_id in comp.plots {
                let mut released_slot: Option<SlotId> = None;
                if let Some(pl) = self.plots.get_mut(&pl_id) {
                    pl.owner_id = None;
                    released_slot = Some(pl.slot_id);
                    let blds = pl.building_ids.len() as f64;
                    let ask_p = to_money((from_money(land_base) + blds * 150.0 * self.cpi) * 0.65)
                        .max(to_money(50.0 * self.cpi));
                    let lid = self.next_listing_id;
                    self.next_listing_id += 1;
                    self.planets
                        .get_mut(&comp.home_planet_id)
                        .unwrap()
                        .land_listings
                        .push(LandListing {
                            listing_id: lid,
                            plot_id: pl_id,
                            seller_id: "BANK".to_string(),
                            ask_price: ask_p,
                            listed_tick: tick,
                            debt_recovery: 0,
                        });
                }
                if let Some(sid) = released_slot {
                    self.planets
                        .get_mut(&comp.home_planet_id)
                        .unwrap()
                        .set_tile_owner(sid, None, Some(pl_id));
                }
            }
        }
        dead
    }

    /// Periodically markdown unsold BANK foreclosures & confiscated inventory; reclaim long-abandoned
    /// foreclosed land back into the undeveloped land pool (demolishing ruined idle factories)
    /// and write off persistently unsellable BANK liquidation asks.
    fn process_bank_liquidations(&mut self, tick: u64) {
        const LAND_MARKDOWN_INTERVAL: u64 = 120;
        const LAND_RECLAIM_AGE: u64 = 1_440;
        const GOOD_MARKDOWN_INTERVAL: u64 = 48;
        const GOOD_EXPIRE_AGE: u64 = 720;

        let pids: Vec<PlanetId> = self.planets.keys().cloned().collect();
        for pid in pids {
            let (land_base, reclaim_ids): (Money, Vec<PlotId>) = {
                let Some(p) = self.planets.get_mut(&pid) else {
                    continue;
                };
                let land_base = p.primary_land_price(self.cpi);
                let floor_price = (land_base / 5).max(to_money(10.0 * self.cpi));
                let mut reclaim = Vec::new();
                p.land_listings.retain_mut(|lst| {
                    if lst.seller_id != "BANK" {
                        return true;
                    }
                    let age = tick.saturating_sub(lst.listed_tick);
                    if age >= LAND_RECLAIM_AGE {
                        reclaim.push(lst.plot_id);
                        return false;
                    }
                    if age >= LAND_MARKDOWN_INTERVAL && tick % LAND_MARKDOWN_INTERVAL == 0 {
                        lst.ask_price = (lst.ask_price.saturating_mul(85) / 100).max(floor_price);
                    }
                    true
                });
                (land_base, reclaim)
            };
            let _ = land_base;

            for pl_id in reclaim_ids {
                if let Some(pl) = self.plots.remove(&pl_id) {
                    for old_bid in pl.building_ids {
                        self.buildings.remove(&old_bid);
                    }
                    if let Some(p) = self.planets.get_mut(&pid) {
                        p.release_tile(pl.slot_id);
                    }
                }
            }
        }

        // Discount unsold BANK confiscated inventory asks over time; expire chronically unsellable dust.
        if tick % GOOD_MARKDOWN_INTERVAL == 0 {
            let floor_px = to_money(0.05 * self.cpi).max(1);
            for st in self.stations.values_mut() {
                for asks in st.asks.values_mut() {
                    let mut dirty = false;
                    asks.retain_mut(|o| {
                        if o.owner_id != "BANK" {
                            return true;
                        }
                        let age = tick.saturating_sub(o.created_tick);
                        if age >= GOOD_EXPIRE_AGE {
                            dirty = true;
                            return false;
                        }
                        if age >= GOOD_MARKDOWN_INTERVAL {
                            o.price = (o.price.saturating_mul(82) / 100).max(floor_px);
                            dirty = true;
                        }
                        true
                    });
                    if dirty {
                        asks.sort_by(|a, b| {
                            a.price
                                .cmp(&b.price)
                                .then_with(|| a.created_tick.cmp(&b.created_tick))
                                .then_with(|| a.order_id.cmp(&b.order_id))
                        });
                    }
                }
                st.asks.retain(|_, v| !v.is_empty());
            }
        }
    }

    /// Reality-aligned fiscal recycling & central-bank balance sheet contraction (runs daily / 24T):
    /// 1) Light progressive multi-plot & excess idle-cash maintenance tax remitted to city treasuries
    ///    (startups & companies under 40k * cpi with 1 plot pay 0, preventing dead cash hoarding);
    /// 2) Remit excess bank reserves above safe deposit+lending cushions back to fiscally tight cities;
    /// 3) Contract (burn via ledger) bloated reserves above 2x safe reserve so money never balloons infinitely.
    fn rebalance_bank_and_liquidity(&mut self) {
        let cpi_hold = self.cpi.clamp(0.25, 10.0);
        let high_cash_floor = to_money(25_000.0 * cpi_hold);
        let small_cash_shield = to_money(1_500.0 * cpi_hold);
        let mut tax_remittances: Vec<(PlanetId, Money)> = Vec::new();

        for comp in self.companies.values_mut() {
            let op_floor = to_money((4_000.0 + comp.plots.len() as f64 * 1_600.0) * cpi_hold);
            let mut cash_fee = if comp.cash > op_floor {
                bps_of(comp.cash - op_floor, 45)
            } else {
                0
            };
            if comp.cash > high_cash_floor {
                cash_fee = cash_fee.saturating_add(bps_of(comp.cash - high_cash_floor, 55));
            }
            let extra_plots = comp.plots.len().saturating_sub(1) as f64;
            let land_tax = if extra_plots > 0.0 && comp.cash > small_cash_shield {
                to_money(extra_plots * 10.0 * cpi_hold)
            } else {
                0
            };
            let due = cash_fee.saturating_add(land_tax);
            let paid = comp.cash.min(due);
            if paid > 0 {
                comp.cash -= paid;
                tax_remittances.push((comp.home_planet_id.clone(), paid));
            }
        }

        for (pid, amt) in tax_remittances {
            let sys_opt = self
                .planets
                .get(&pid)
                .filter(|p| p.city_count == 0)
                .map(|p| p.system_id.clone());
            if let Some(sys_id) = sys_opt {
                self.credit_habitable_cities_for_system(Some(&sys_id), amt);
            } else if let Some(p) = self.planets.get_mut(&pid) {
                credit_cash(&mut p.treasury, amt);
            } else {
                self.credit_habitable_cities(amt);
            }
        }

        let bank_cpi = self.cpi.clamp(0.5, 4.0);
        let outpost_treasury_cap = to_money(2_000.0 * bank_cpi);
        let pids: Vec<PlanetId> = self.planets.keys().cloned().collect();
        for pid in pids {
            // Sweep trapped fees/taxes on uninhabited outposts into system habitable cities
            let outpost_treasury_sweep = if let Some(p) = self.planets.get_mut(&pid) {
                if p.city_count == 0 && p.treasury > outpost_treasury_cap {
                    let sweep = p.treasury - outpost_treasury_cap;
                    p.treasury -= sweep;
                    Some((p.system_id.clone(), sweep))
                } else {
                    None
                }
            } else {
                None
            };
            if let Some((sys_id, sweep)) = outpost_treasury_sweep {
                self.credit_habitable_cities_for_system(Some(&sys_id), sweep);
            }
            let mut outpost_remit: Option<(String, Money)> = None;
            {
                let Some(p) = self.planets.get_mut(&pid) else {
                    continue;
                };
                let op_cushion = if p.city_count > 0 {
                    to_money((p.population * 3.5).max(15_000.0) * bank_cpi)
                        .max(p.bank.total_loans / 2)
                } else {
                    to_money(15_000.0 * bank_cpi)
                };
                let safe_reserve = p.bank.total_deposits.saturating_add(op_cushion);

                if p.bank.reserves > safe_reserve {
                    let excess = p.bank.reserves - safe_reserve;
                    if p.city_count > 0 {
                        let treasury_target =
                            to_money((p.population * 9.0).max(24_000.0) * bank_cpi);
                        if p.treasury < treasury_target {
                            let remit = (excess / 4).min(treasury_target - p.treasury);
                            if remit > 0 {
                                p.bank.reserves -= remit;
                                credit_cash(&mut p.treasury, remit);
                            }
                        }
                    } else {
                        let cand = excess / 8;
                        if cand > 0 {
                            outpost_remit = Some((p.system_id.clone(), cand));
                        }
                    }
                }
            }

            if let Some((sys_id, cand)) = outpost_remit {
                let sys_shortfall: Money = self
                    .planets
                    .values()
                    .filter(|pl| pl.system_id == sys_id && pl.city_count > 0 && pl.population > 0.0)
                    .map(|pl| {
                        let target = to_money((pl.population * 9.0).max(24_000.0) * bank_cpi);
                        target.saturating_sub(pl.treasury)
                    })
                    .sum();
                let remit = cand.min(sys_shortfall);
                if remit > 0 {
                    let debited = if let Some(p) = self.planets.get_mut(&pid) {
                        if p.bank.reserves >= remit {
                            p.bank.reserves -= remit;
                            true
                        } else {
                            false
                        }
                    } else {
                        false
                    };
                    if debited {
                        self.credit_habitable_cities_for_system(Some(&sys_id), remit);
                    }
                }
            }

            if let Some(p) = self.planets.get_mut(&pid) {
                let op_cushion = if p.city_count > 0 {
                    to_money((p.population * 3.5).max(15_000.0) * bank_cpi)
                        .max(p.bank.total_loans / 2)
                } else {
                    to_money(15_000.0 * bank_cpi)
                };
                let safe_reserve = p.bank.total_deposits.saturating_add(op_cushion);
                let bloat_ceiling = safe_reserve.saturating_mul(2);
                if p.bank.reserves > bloat_ceiling {
                    let contract = (p.bank.reserves - bloat_ceiling) / 10;
                    if contract > 0 {
                        p.bank.reserves -= contract;
                        self.ledger.record_burn(contract);
                    }
                }
            }
        }
    }

    /// Precompute immutable per-tick shared snapshot state once across all companies.
    pub fn prepare_shared_snapshot(&self) -> SharedSnapshot {
        let mut open_orders_by_owner: HashMap<CompanyId, Vec<Order>> = HashMap::new();
        let mut all_orders = Vec::new();
        let mut quotes: HashMap<StationId, HashMap<ItemId, _>> =
            HashMap::with_capacity(self.stations.len());
        let mut depths: HashMap<StationId, HashMap<ItemId, _>> =
            HashMap::with_capacity(self.stations.len());
        for (sid, st) in &self.stations {
            let mut sq = HashMap::with_capacity(self.catalog.items.len());
            let mut sd = HashMap::new();
            for it in self.catalog.items.values() {
                sq.insert(it.id.clone(), st.quote(&it.id, to_money(it.ref_price)));
                if st.bids.contains_key(&it.id) || st.asks.contains_key(&it.id) {
                    sd.insert(it.id.clone(), st.depth(&it.id, 5));
                }
            }
            quotes.insert(sid.clone(), sq);
            depths.insert(sid.clone(), sd);
            for o in st.bids.values().chain(st.asks.values()).flat_map(|v| v.iter()) {
                all_orders.push(o.clone());
                open_orders_by_owner
                    .entry(o.owner_id.clone())
                    .or_default()
                    .push(o.clone());
            }
        }

        let mut systems_view: HashMap<String, StarSystemView> =
            HashMap::with_capacity(self.systems.len());
        for (sid, s) in &self.systems {
            systems_view.insert(
                sid.clone(),
                StarSystemView {
                    id: s.id.clone(),
                    name: s.name.clone(),
                    star_class: s.star_class.clone(),
                    luminosity: s.luminosity,
                    x: s.x,
                    y: s.y,
                    hub_station_id: s.hub_station_id.clone(),
                    hub_orbit_radius: s.hub_orbit_radius,
                    hub_orbit_days: s.hub_orbit_days,
                    hub_orbit_angle: s.hub_orbit_angle,
                },
            );
        }
        if systems_view.is_empty() && self.stations.contains_key("ST:HUB") {
            systems_view.insert(
                "S1".to_string(),
                StarSystemView {
                    id: "S1".to_string(),
                    name: "新伊甸星系".to_string(),
                    star_class: "G2V 黄矮星".to_string(),
                    luminosity: 1.0,
                    x: 0.0,
                    y: 0.0,
                    hub_station_id: "ST:HUB".to_string(),
                    hub_orbit_radius: self.hub_orbit_radius,
                    hub_orbit_days: self.hub_orbit_days,
                    hub_orbit_angle: self.hub_orbit_angle,
                },
            );
        }

        let mut planet_templates = Vec::with_capacity(self.planets.len());
        let mut public_tiles_by_planet = HashMap::with_capacity(self.planets.len());
        for (pid, p) in &self.planets {
            let demands = p.compute_demands(&self.catalog);
            let primary_px = if p.unclaimed_plots_remaining > 0 {
                Some(p.primary_land_price(self.cpi))
            } else {
                None
            };
            let listing_by_plot: HashMap<PlotId, &LandListing> = p
                .land_listings
                .iter()
                .map(|l| (l.plot_id, l))
                .collect();

            let mut tiles_view = Vec::with_capacity(p.surface_tiles.len());
            for t in &p.surface_tiles {
                let listing = t.plot_id.and_then(|plid| listing_by_plot.get(&plid).copied());
                let pl_opt = t.plot_id.and_then(|plid| self.plots.get(&plid));
                let used_slots = pl_opt.map(|pl| pl.used_slots()).unwrap_or(0);
                let buildings: Vec<String> = pl_opt
                    .map(|pl| {
                        pl.building_ids
                            .iter()
                            .filter_map(|bid| self.buildings.get(bid).map(|b| b.building_type.clone()))
                            .collect()
                    })
                    .unwrap_or_default();
                let status = if t.is_city {
                    "city"
                } else if listing.is_some() {
                    "listed"
                } else if t.owner_id.is_some() {
                    "owned"
                } else {
                    "unclaimed"
                };
                let (owner_name, is_player_owner) = if let Some(oid) = &t.owner_id {
                    if let Some(c) = self.companies.get(oid) {
                        (Some(c.name.clone()), c.is_player)
                    } else {
                        (Some(oid.clone()), false)
                    }
                } else {
                    (None, false)
                };
                let price = match status {
                    "unclaimed" => primary_px,
                    "listed" => listing.map(|l| l.ask_price),
                    _ => None,
                };
                tiles_view.push(PublicLandTileView {
                    slot_id: t.slot_id,
                    planet_id: p.id.clone(),
                    lat: t.lat,
                    lon: t.lon,
                    terrain_name: t.terrain_name.clone(),
                    capacity: t.capacity,
                    used_slots,
                    building_mods: t.building_mods.clone(),
                    status: status.to_string(),
                    is_city: t.is_city,
                    city_name: t.city_name.clone(),
                    owner_id: t.owner_id.clone(),
                    owner_name,
                    is_player_owner,
                    plot_id: t.plot_id,
                    listing_id: listing.map(|l| l.listing_id),
                    price,
                    buildings,
                });
            }
            public_tiles_by_planet.insert(pid.clone(), tiles_view);

            let land_listings: Vec<LandListingView> = p
                .land_listings
                .iter()
                .map(|l| {
                    let pl_opt = self.plots.get(&l.plot_id);
                    let buildings: Vec<String> = pl_opt
                        .map(|pl| {
                            pl.building_ids
                                .iter()
                                .filter_map(|bid| self.buildings.get(bid).map(|b| b.building_type.clone()))
                                .collect()
                        })
                        .unwrap_or_default();
                    LandListingView {
                        listing_id: l.listing_id,
                        plot_id: l.plot_id,
                        slot_id: pl_opt.map(|pl| pl.slot_id).unwrap_or(0),
                        seller_id: l.seller_id.clone(),
                        ask_price: l.ask_price,
                        terrain_name: pl_opt.map(|pl| pl.terrain_name.clone()).unwrap_or_default(),
                        lat: pl_opt.map(|pl| pl.lat).unwrap_or(0.0),
                        lon: pl_opt.map(|pl| pl.lon).unwrap_or(0.0),
                        capacity: pl_opt.map(|pl| pl.capacity).unwrap_or(0),
                        used_slots: pl_opt.map(|pl| pl.used_slots()).unwrap_or(0),
                        building_mods: pl_opt.map(|pl| pl.building_mods.clone()).unwrap_or_default(),
                        buildings,
                    }
                })
                .collect();

            let view = PlanetView {
                id: p.id.clone(),
                system_id: p.system_id.clone(),
                station_id: p.station_id.clone(),
                name: p.name.clone(),
                wealth_tier: p.wealth_tier,
                prosperity: p.prosperity,
                population: p.population,
                gravity: p.gravity,
                habitability: p.habitability,
                waste_backlog: p.waste_backlog,
                primary_land_price: primary_px,
                land_listings: Arc::new(land_listings),
                bank_rate_bps: p.bank.annual_rate_bps,
                ground_store: HashMap::new(),
                station_store: HashMap::new(),
                demands,
            };
            planet_templates.push((pid.clone(), p.station_id.clone(), view));
        }

        let mut routes: HashMap<String, HashMap<String, (u32, u32)>> = HashMap::new();
        for (pid, p) in &self.planets {
            let sid = p.station_id.as_str();
            let hub_id = systems_view
                .get(&p.system_id)
                .map(|s| s.hub_station_id.as_str())
                .unwrap_or("ST:HUB");
            for (a, b) in [
                (pid.as_str(), sid),
                (sid, pid.as_str()),
                (sid, hub_id),
                (hub_id, sid),
            ] {
                if let Some(r) = compute_route_in_systems(
                    a,
                    b,
                    ShipSize::Small,
                    100.0,
                    &self.planets,
                    &self.systems,
                    self.hub_orbit_radius,
                    self.hub_orbit_angle,
                ) {
                    routes
                        .entry(a.to_string())
                        .or_default()
                        .insert(b.to_string(), (r.ticks, r.fuel));
                }
            }
        }
        // Direct same-system interplanetary orbital routes (ST:P* <-> ST:P*)
        for (pid_a, pa) in &self.planets {
            for (pid_b, pb) in &self.planets {
                if pid_a == pid_b || pa.system_id != pb.system_id {
                    continue;
                }
                if let Some(r) = compute_route_in_systems(
                    &pa.station_id,
                    &pb.station_id,
                    ShipSize::Small,
                    100.0,
                    &self.planets,
                    &self.systems,
                    self.hub_orbit_radius,
                    self.hub_orbit_angle,
                ) {
                    routes
                        .entry(pa.station_id.clone())
                        .or_default()
                        .insert(pb.station_id.clone(), (r.ticks, r.fuel));
                }
            }
        }
        // Precompute Hub-to-Hub routes when multiple systems exist
        let hubs: Vec<String> = systems_view
            .values()
            .map(|s| s.hub_station_id.clone())
            .collect();
        for i in 0..hubs.len() {
            for j in 0..hubs.len() {
                if i == j {
                    continue;
                }
                if let Some(r) = compute_route_in_systems(
                    &hubs[i],
                    &hubs[j],
                    ShipSize::Small,
                    100.0,
                    &self.planets,
                    &self.systems,
                    self.hub_orbit_radius,
                    self.hub_orbit_angle,
                ) {
                    routes
                        .entry(hubs[i].clone())
                        .or_default()
                        .insert(hubs[j].clone(), (r.ticks, r.fuel));
                }
            }
        }

        let mut public_companies: Vec<PublicCompanySummary> = self
            .companies
            .values()
            .map(|c| {
                let orders_cnt = open_orders_by_owner
                    .get(&c.id)
                    .map(|v| v.len())
                    .unwrap_or(0);
                self.public_company_summary_for(c, orders_cnt)
            })
            .collect();
        public_companies.sort_by(|a, b| {
            b.net_liquid
                .cmp(&a.net_liquid)
                .then_with(|| a.id.cmp(&b.id))
        });

        let mut station_systems: HashMap<StationId, (String, Option<PlanetId>)> =
            HashMap::with_capacity(self.stations.len());
        for p in self.planets.values() {
            station_systems.insert(p.station_id.clone(), (p.system_id.clone(), Some(p.id.clone())));
        }
        for sys in &systems_view {
            station_systems
                .entry(sys.1.hub_station_id.clone())
                .or_insert_with(|| (sys.0.clone(), None));
        }
        for sid in self.stations.keys() {
            station_systems
                .entry(sid.clone())
                .or_insert_with(|| ("S1".to_string(), None));
        }

        SharedSnapshot {
            quotes: Arc::new(quotes),
            depths: Arc::new(depths),
            all_orders: Arc::new(all_orders),
            open_orders_by_owner,
            systems: Arc::new(systems_view),
            station_systems: Arc::new(station_systems),
            planet_templates,
            public_tiles_by_planet: Arc::new(public_tiles_by_planet),
            public_companies: Arc::new(public_companies),
            routes: Arc::new(routes),
            empty_depths: Arc::new(HashMap::new()),
            empty_orders: Arc::new(Vec::new()),
            empty_companies: Arc::new(Vec::new()),
        }
    }

    fn ship_counts_for(ships: &[Ship]) -> ShipCountsView {
        let mut counts = ShipCountsView::default();
        for s in ships {
            match s.size {
                ShipSize::Small => counts.small += 1,
                ShipSize::Medium => counts.medium += 1,
                ShipSize::Large => counts.large += 1,
            }
        }
        counts
    }

    fn public_company_summary_for(
        &self,
        comp: &Company,
        open_orders_count: usize,
    ) -> PublicCompanySummary {
        let buildings_count: usize = comp
            .plots
            .iter()
            .filter_map(|pid| self.plots.get(pid))
            .map(|pl| pl.building_ids.len())
            .sum();
        PublicCompanySummary {
            id: comp.id.clone(),
            name: comp.name.clone(),
            is_player: comp.is_player,
            home_planet_id: comp.home_planet_id.clone(),
            net_liquid: comp.cash + comp.savings - comp.debt,
            plots_count: comp.plots.len(),
            buildings_count,
            ships_count: comp.ships.len(),
            ships_by_size: Self::ship_counts_for(&comp.ships),
            open_orders_count,
        }
    }

    /// Return public intelligence profile for a single company (used by `/api/companies/{id}`).
    /// Excludes private cash/savings/debt breakdown, inventories, active recipes, and ship routes.
    pub fn public_company_detail(&self, company_id: &str) -> Option<PublicCompanyDetail> {
        let comp = self.companies.get(company_id)?;
        let mut building_counts: BTreeMap<String, u32> = BTreeMap::new();
        let mut plots: Vec<PublicCompanyPlotView> = Vec::with_capacity(comp.plots.len());
        let mut buildings_count = 0usize;

        for pid in &comp.plots {
            let Some(pl) = self.plots.get(pid) else {
                continue;
            };
            let listing = self
                .planets
                .get(&pl.planet_id)
                .and_then(|p| p.land_listings.iter().find(|l| l.plot_id == pl.id));
            let mut btypes: Vec<String> = Vec::with_capacity(pl.building_ids.len());
            for bid in &pl.building_ids {
                if let Some(b) = self.buildings.get(bid) {
                    btypes.push(b.building_type.clone());
                    *building_counts.entry(b.building_type.clone()).or_insert(0) += 1;
                    buildings_count += 1;
                }
            }
            let status = if listing.is_some() { "listed" } else { "owned" };
            plots.push(PublicCompanyPlotView {
                planet_id: pl.planet_id.clone(),
                slot_id: pl.slot_id,
                plot_id: Some(pl.id),
                lat: pl.lat,
                lon: pl.lon,
                terrain_name: pl.terrain_name.clone(),
                capacity: pl.capacity,
                used_slots: pl.used_slots(),
                status: status.to_string(),
                listing_id: listing.map(|l| l.listing_id),
                price: listing.map(|l| l.ask_price),
                buildings: btypes,
            });
        }
        plots.sort_by(|a, b| {
            a.planet_id
                .cmp(&b.planet_id)
                .then_with(|| a.slot_id.cmp(&b.slot_id))
        });

        let mut open_orders: Vec<Order> = Vec::new();
        for st in self.stations.values() {
            for o in st.bids.values().chain(st.asks.values()).flat_map(|v| v.iter()) {
                if o.owner_id == company_id {
                    open_orders.push(o.clone());
                }
            }
        }
        open_orders.sort_by(|a, b| {
            a.station_id
                .cmp(&b.station_id)
                .then_with(|| a.item_id.cmp(&b.item_id))
                .then_with(|| a.order_id.cmp(&b.order_id))
        });

        Some(PublicCompanyDetail {
            id: comp.id.clone(),
            name: comp.name.clone(),
            is_player: comp.is_player,
            home_planet_id: comp.home_planet_id.clone(),
            net_liquid: comp.cash + comp.savings - comp.debt,
            plots_count: plots.len(),
            buildings_count,
            ships_count: comp.ships.len(),
            ships_by_size: Self::ship_counts_for(&comp.ships),
            building_counts,
            plots,
            open_orders_count: open_orders.len(),
            open_orders,
        })
    }

    /// Return all public surface tiles on `planet_id` (used by `/api/planets/{id}/plots`).
    pub fn planet_public_tiles(&self, planet_id: &str) -> Option<Vec<PublicLandTileView>> {
        let p = self.planets.get(planet_id)?;
        let primary_px = if p.unclaimed_plots_remaining > 0 {
            Some(p.primary_land_price(self.cpi))
        } else {
            None
        };
        let listing_by_plot: HashMap<PlotId, &LandListing> = p
            .land_listings
            .iter()
            .map(|l| (l.plot_id, l))
            .collect();
        let tiles_view = p
            .surface_tiles
            .iter()
            .map(|t| {
                let listing = t.plot_id.and_then(|plid| listing_by_plot.get(&plid).copied());
                let pl_opt = t.plot_id.and_then(|plid| self.plots.get(&plid));
                let used_slots = pl_opt.map(|pl| pl.used_slots()).unwrap_or(0);
                let buildings: Vec<String> = pl_opt
                    .map(|pl| {
                        pl.building_ids
                            .iter()
                            .filter_map(|bid| self.buildings.get(bid).map(|b| b.building_type.clone()))
                            .collect()
                    })
                    .unwrap_or_default();
                let status = if t.is_city {
                    "city"
                } else if listing.is_some() {
                    "listed"
                } else if t.owner_id.is_some() {
                    "owned"
                } else {
                    "unclaimed"
                };
                let (owner_name, is_player_owner) = if let Some(oid) = &t.owner_id {
                    if let Some(c) = self.companies.get(oid) {
                        (Some(c.name.clone()), c.is_player)
                    } else {
                        (Some(oid.clone()), false)
                    }
                } else {
                    (None, false)
                };
                let price = match status {
                    "unclaimed" => primary_px,
                    "listed" => listing.map(|l| l.ask_price),
                    _ => None,
                };
                PublicLandTileView {
                    slot_id: t.slot_id,
                    planet_id: p.id.clone(),
                    lat: t.lat,
                    lon: t.lon,
                    terrain_name: t.terrain_name.clone(),
                    capacity: t.capacity,
                    used_slots,
                    building_mods: t.building_mods.clone(),
                    status: status.to_string(),
                    is_city: t.is_city,
                    city_name: t.city_name.clone(),
                    owner_id: t.owner_id.clone(),
                    owner_name,
                    is_player_owner,
                    plot_id: t.plot_id,
                    listing_id: listing.map(|l| l.listing_id),
                    price,
                    buildings,
                }
            })
            .collect();
        Some(tiles_view)
    }

    pub fn snapshot_for(&self, company_id: &str) -> Option<WorldSnapshot> {
        if !self.companies.contains_key(company_id) {
            return None;
        }
        let shared = self.prepare_shared_snapshot();
        self.snapshot_for_with_shared(company_id, &shared, true)
    }

    pub fn snapshot_for_with_shared(
        &self,
        company_id: &str,
        shared: &SharedSnapshot,
        include_full_book: bool,
    ) -> Option<WorldSnapshot> {
        let comp = self.companies.get(company_id)?;
        let mut plots = Vec::with_capacity(comp.plots.len());
        let mut buildings = Vec::new();
        let mut sites = Vec::new();
        for pid in &comp.plots {
            let Some(pl) = self.plots.get(pid) else {
                continue;
            };
            plots.push(PlotView {
                id: pl.id,
                slot_id: pl.slot_id,
                planet_id: pl.planet_id.clone(),
                lat: pl.lat,
                lon: pl.lon,
                terrain_name: pl.terrain_name.clone(),
                capacity: pl.capacity,
                used_slots: pl.used_slots(),
                building_mods: pl.building_mods.clone(),
            });
            for (idx, job) in pl.jobs.iter().enumerate() {
                if job.action == "build" {
                    let site_id = if job.id > 0 {
                        job.id
                    } else {
                        pl.id * 1_000_000 + idx as u64 + 1
                    };
                    sites.push(SiteView {
                        id: site_id,
                        plot_id: pl.id,
                        planet_id: pl.planet_id.clone(),
                        building_type: job.building_type.clone(),
                        finish_tick: job.finish_tick,
                        ticks_remaining: job.finish_tick.saturating_sub(self.tick),
                    });
                }
            }
            for bid in &pl.building_ids {
                let Some(b) = self.buildings.get(bid) else {
                    continue;
                };
                let recipe_opt = self.catalog.recipes.get(&b.recipe_id);
                let cycle_ticks = recipe_opt.map(|r| r.cycle_ticks).unwrap_or(1);
                let stall_reason = if !b.active {
                    Some("已手动待机".to_string())
                } else if !b.active_batch {
                    if let Some(r) = recipe_opt {
                        let wage = to_money(r.labor_cost * self.cpi);
                        if comp.cash < wage {
                            Some(format!("现金不足支付人工（需 {:.2} Cr）", from_money(wage)))
                        } else if r.power_cost > 0
                            && comp.ground_qty(&b.planet_id, "power") < r.power_cost
                        {
                            Some(format!(
                                "地面电力不足（{}/{}）",
                                comp.ground_qty(&b.planet_id, "power"),
                                r.power_cost
                            ))
                        } else {
                            let mut missing = None;
                            for inp in &r.inputs {
                                let have = if inp.item == "waste" {
                                    comp.ground_qty(&b.planet_id, "waste")
                                        + self
                                            .planets
                                            .get(&b.planet_id)
                                            .map(|p| p.waste_backlog)
                                            .unwrap_or(0)
                                } else {
                                    comp.ground_qty(&b.planet_id, &inp.item)
                                };
                                if have < inp.qty {
                                    let iname = self
                                        .catalog
                                        .items
                                        .get(&inp.item)
                                        .map(|it| it.name.as_str())
                                        .unwrap_or(inp.item.as_str());
                                    missing = Some(format!("缺少 {iname}（{have}/{}）", inp.qty));
                                    break;
                                }
                            }
                            missing
                        }
                    } else {
                        Some("未配置有效配方".to_string())
                    }
                } else {
                    None
                };
                buildings.push(BuildingView {
                    id: b.id,
                    building_type: b.building_type.clone(),
                    plot_id: b.plot_id,
                    planet_id: b.planet_id.clone(),
                    efficiency: b.efficiency,
                    recipe_id: b.recipe_id.clone(),
                    active: b.active,
                    progress: b.progress,
                    cycle_ticks,
                    idle_ticks: b.idle_ticks,
                    stall_reason,
                });
            }
        }
        let ships: Vec<ShipView> = comp
            .ships
            .iter()
            .map(|s| ShipView {
                id: s.id,
                size: s.size,
                capacity: s.capacity(),
                durability: s.durability,
                location: s.location.clone(),
                busy_until: s.busy_until,
                is_busy: s.is_busy(self.tick),
                cargo: s.cargo.clone(),
            })
            .collect();

        let open_orders = shared
            .open_orders_by_owner
            .get(company_id)
            .cloned()
            .unwrap_or_default();
        let (depths, orders, public_companies) = if include_full_book {
            (
                Arc::clone(&shared.depths),
                Arc::clone(&shared.all_orders),
                Arc::clone(&shared.public_companies),
            )
        } else {
            (
                Arc::clone(&shared.empty_depths),
                Arc::clone(&shared.empty_orders),
                Arc::clone(&shared.empty_companies),
            )
        };

        let mut planets_view = HashMap::with_capacity(shared.planet_templates.len());
        for (pid, sid, tmpl) in &shared.planet_templates {
            let mut pv = tmpl.clone();
            if !comp.is_player {
                if let Some(p) = self.planets.get(pid) {
                    let reserved = (p.total_developable_plots / 10).max(1);
                    if p.unclaimed_plots_remaining <= reserved
                        || self.npc_plot_count_on(pid) >= self.npc_plot_cap_on(pid)
                    {
                        pv.primary_land_price = None;
                    }
                }
            }
            if let Some(g) = comp.ground_inv.get(pid) {
                pv.ground_store = g.clone();
            }
            if let Some(s) = comp.station_inv.get(sid) {
                pv.station_store = s.clone();
            }
            planets_view.insert(pid.clone(), pv);
        }

        Some(WorldSnapshot {
            tick: self.tick,
            cpi: self.cpi,
            company: SelfView {
                id: comp.id.clone(),
                name: comp.name.clone(),
                profession: comp.profession.clone(),
                home_planet_id: comp.home_planet_id.clone(),
                cash: comp.cash,
                savings: comp.savings,
                debt: comp.debt,
                debt_due_tick: comp.debt_due_tick,
                plots,
                buildings,
                sites,
                ships,
                station_stores: comp.station_inv.clone(),
                open_orders,
            },
            systems: Arc::clone(&shared.systems),
            station_systems: Arc::clone(&shared.station_systems),
            planets: planets_view,
            quotes: Arc::clone(&shared.quotes),
            depths,
            orders,
            routes: Arc::clone(&shared.routes),
            public_tiles: Arc::clone(&shared.public_tiles_by_planet),
            public_companies,
        })
    }
}

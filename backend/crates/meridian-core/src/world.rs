//! Deterministic Two-Phase World simulation kernel.

use std::collections::{HashMap, VecDeque};

use serde::{Deserialize, Serialize};

use crate::company::Company;
use crate::exchange::{CLOBStation, Order, TradeFill};
use crate::ledger::MoneyLedger;
use crate::logistics::{compute_route, RouteKind, Ship, ShipInFlight, ShipSize};
use crate::planet::{BuildingInstance, LandListing, Planet, PlanetBank, Plot, SiteJob};
use crate::schema::{ItemRole, ProductionCatalog};
use crate::snapshot::{
    BuildingView, LandListingView, PlanetView, PlotView, SelfView, ShipView, WorldSnapshot,
};
use crate::types::{
    bps_of, from_money, to_money, BankOpKind, BuildingId, CompanyId, Intent, ItemId, ListingId,
    Money, OrderId, OrderSide, PlanetId, PlotId, ShipId, StationId,
    MAX_ACTIVE_ORDERS_PER_COMPANY, MAX_INTENTS_PER_TICK,
};

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct TickReport {
    pub tick: u64,
    pub fills: Vec<TradeFill>,
    pub bankruptcies: Vec<CompanyId>,
    pub rejected_intents: usize,
    pub cpi: f64,
}

#[derive(Clone, Serialize, Deserialize)]
pub struct World {
    pub catalog: ProductionCatalog,
    pub tick: u64,
    pub cpi: f64,
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

        let planet_specs = vec![
            (
                "P1", "灼热矿星-I", "矿业岩星", 0.90, 95.0, 0.5, 1.40, 1.60, 1.65, 0.65, 0.05, 0,
                0.0, 20000.0, 30000.0,
            ),
            (
                "P2", "新伊甸-II", "宜居主星", 1.85, 320.0, 2.1, 1.00, 1.00, 0.85, 1.35, 0.45, 3,
                4500.0, 35000.0, 60000.0,
            ),
            (
                "P3", "凛冬外星-III", "寒冷低重星", 2.75, 580.0, 4.4, 0.55, 0.45, 1.05, 1.65, 0.25, 0,
                0.0, 20000.0, 30000.0,
            ),
        ];

        let mut planets = HashMap::new();
        for (
            pid, name, arch, orb_r, orb_d, orb_a, grav, solar, mineral, water, ocean, cities, pop,
            treasury_f, reserves_f,
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

            planets.insert(
                pid.to_string(),
                Planet {
                    id: pid.to_string(),
                    name: name.to_string(),
                    archetype: arch.to_string(),
                    station_id: sid,
                    orbit_radius: orb_r,
                    orbit_period_days: orb_d,
                    orbit_angle: orb_a,
                    gravity: grav,
                    solar_mult: solar,
                    mineral_mult: mineral,
                    water_mult: water,
                    ocean_ratio: ocean,
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
                    land_listings: Vec::new(),
                    last_demands: HashMap::new(),
                    last_bought: HashMap::new(),
                    bought_this_tick: HashMap::new(),
                    prev_bids: HashMap::new(),
                },
            );
        }

        Self {
            catalog,
            tick: 0,
            cpi: 1.0,
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

    fn next_rand(&mut self) -> u64 {
        let mut x = self.rng_state;
        x ^= x << 13;
        x ^= x >> 7;
        x ^= x << 17;
        self.rng_state = x;
        x
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

        let plot_id = self.next_plot_id;
        self.next_plot_id += 1;
        let mut plot = self
            .planets
            .get_mut(home_planet_id)
            .ok_or_else(|| format!("Unknown planet '{home_planet_id}'"))?
            .materialize_primary_plot(plot_id, &self.catalog)
            .ok_or_else(|| format!("No unclaimed plots left on '{home_planet_id}'"))?;
        plot.owner_id = Some(cid.clone());

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
                let prof_bonus = *prof.efficiency_bonus.get(btype).unwrap_or(&1.0);
                let eff = (base_mod * prof_bonus * 100.0).round() / 100.0;

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

    pub fn is_instant_item(&self, item_id: &str) -> bool {
        self.catalog
            .items
            .get(item_id)
            .map(|it| it.has_tag("power") || it.has_tag("waste_service"))
            .unwrap_or(false)
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

    pub fn step_tick(&mut self, intents_by_company: Vec<(CompanyId, Vec<Intent>)>) -> TickReport {
        self.tick += 1;
        let t = self.tick;
        let mut rejected_intents = 0usize;

        // 0a. Advance orbits & update CPI
        self.advance_orbits();
        self.update_cpi();

        // 0b. Land arriving ships
        self.land_arriving_ships(t);

        // 0c. Step construction jobs & building production/standby
        self.step_buildings_and_jobs(t);

        // 0d. Planet civic issuance & city Buy orders
        let mut planet_demands: HashMap<PlanetId, HashMap<ItemId, u32>> = HashMap::new();
        let pids: Vec<PlanetId> = self.planets.keys().cloned().collect();
        for pid in pids {
            let demands = self.place_planet_demands(&pid, t);
            planet_demands.insert(pid, demands);
        }

        // 1. Shuffle & apply external decision Intents (player JS + free-play NPCs)
        let mut batches = intents_by_company;
        if batches.len() > 1 {
            for i in (1..batches.len()).rev() {
                let j = (self.next_rand() as usize) % (i + 1);
                batches.swap(i, j);
            }
        }
        for (cid, intents) in batches {
            for intent in intents.into_iter().take(MAX_INTENTS_PER_TICK) {
                if !self.apply_intent(&cid, intent, t) {
                    rejected_intents += 1;
                }
            }
        }

        // 2. Match CLOB stations & settle cash, station fees (0.5%), and physical goods
        let mut all_fills = Vec::new();
        let sids: Vec<StationId> = self.stations.keys().cloned().collect();
        for sid in sids {
            let fills = self.stations.get_mut(&sid).unwrap().match_all(t);
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

        TickReport {
            tick: t,
            fills: all_fills,
            bankruptcies,
            rejected_intents,
            cpi: self.cpi,
        }
    }

    fn advance_orbits(&mut self) {
        let dt_days = 1.0 / self.catalog.pack.meta.ticks_per_day.max(1) as f64;
        self.hub_orbit_angle =
            (self.hub_orbit_angle + std::f64::consts::TAU * dt_days / self.hub_orbit_days)
                % std::f64::consts::TAU;
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
            ratio_sum += (avg_p / it.ref_price).clamp(0.2, 8.0);
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
                            let prof_b = self
                                .companies
                                .get(&ow)
                                .and_then(|c| self.catalog.professions.get(&c.profession))
                                .and_then(|p| p.efficiency_bonus.get(&job.building_type))
                                .copied()
                                .unwrap_or(1.0);
                            (ow, plot.planet_id.clone(), (bmod * prof_b * 100.0).round() / 100.0)
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
        if amount <= 0 {
            return;
        }
        let cities: Vec<(PlanetId, f64)> = self
            .planets
            .values()
            .filter(|p| p.city_count > 0 && p.population > 0.0)
            .map(|p| (p.id.clone(), p.population))
            .collect();
        let tot_pop: f64 = cities.iter().map(|(_, pop)| *pop).sum();
        if tot_pop <= 0.0 {
            return;
        }
        let mut distributed = 0;
        for (idx, (pid, pop)) in cities.iter().enumerate() {
            let share = if idx + 1 == cities.len() {
                amount - distributed
            } else {
                ((amount as f64) * (pop / tot_pop)).round() as Money
            };
            distributed += share;
            if let Some(p) = self.planets.get_mut(pid) {
                p.treasury += share;
            }
        }
    }

    fn place_planet_demands(&mut self, planet_id: &str, tick: u64) -> HashMap<ItemId, u32> {
        let demands = {
            let Some(p) = self.planets.get_mut(planet_id) else {
                return HashMap::new();
            };
            if p.city_count == 0 || p.population <= 0.0 {
                return HashMap::new();
            }
            // Restored steady civic money faucet (#8 fix) scaled gently by CPI
            let civic_mint = to_money(p.population * p.civic_output_per_capita * p.prosperity * self.cpi);
            p.treasury += civic_mint;
            self.ledger.record_mint(civic_mint);
            p.last_bought = std::mem::take(&mut p.bought_this_tick);
            p.compute_demands(&self.catalog)
        };
        if demands.is_empty() {
            return demands;
        }

        // Cancel previous PLANET:* buy orders on this station and refund their remaining escrow cleanly
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
                self.planets.get_mut(planet_id).unwrap().treasury += removed.escrow_cash;
            }
        }

        // Wallet-constrained budget allocation (NO hardcoded BASE_PRICES cap!)
        let budget = {
            let p = &self.planets[planet_id];
            (p.treasury * 18) / 100
        };
        if budget <= 0 {
            return demands;
        }

        let mut weights: HashMap<ItemId, f64> = HashMap::new();
        for (item, &qty) in &demands {
            let p = &self.planets[planet_id];
            let prev_q = *p.last_demands.get(item).unwrap_or(&qty);
            let prev_got = *p.last_bought.get(item).unwrap_or(&0);
            let prev_sat = (prev_got as f64 / prev_q.max(1) as f64).min(1.0);
            let urgency = 1.0 + 1.5 * (1.0 - prev_sat);
            let st = &self.stations[&sid];
            let ref_m = st
                .best_ask(item)
                .or_else(|| st.last_trade_price.get(item).copied())
                .unwrap_or_else(|| to_money(self.catalog.items[item].ref_price));
            weights.insert(
                item.clone(),
                (qty as f64 * from_money(ref_m).max(0.05 * self.cpi) * urgency).max(0.05),
            );
        }
        let total_w: f64 = weights.values().sum::<f64>().max(0.1);

        let mut spent_escrow = 0;
        let treasury_avail = self.planets[planet_id].treasury;
        for (item, &qty) in &demands {
            let share = weights[item] / total_w;
            let item_budget = ((budget as f64) * share) as Money;
            let item_cap = item_budget / (qty.max(1) as Money);
            if item_cap <= 0 {
                continue;
            }
            let st = &self.stations[&sid];
            let ba = st.best_ask(item);
            let last_p = *st
                .last_trade_price
                .get(item)
                .unwrap_or(&to_money(self.catalog.items[item].ref_price));
            let prev_bid = *self.planets[planet_id].prev_bids.get(item).unwrap_or(&last_p);
            let raw_bid = match ba {
                Some(ask_p) => item_cap.min((ask_p * 103) / 100),
                None => item_cap
                    .min(last_p.saturating_mul(6))
                    .min(((last_p * 108) / 100).max((prev_bid * 102) / 100)),
            };
            let clean_bid = raw_bid.max(to_money(0.02 * self.cpi));
            let needed_escrow = (qty as i128 * clean_bid as i128) as Money;
            if needed_escrow <= 0 || spent_escrow + needed_escrow > treasury_avail {
                continue;
            }
            spent_escrow += needed_escrow;
            self.planets.get_mut(planet_id).unwrap().treasury -= needed_escrow;
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
                qty,
                total_qty: qty,
                price: clean_bid,
                escrow_cash: needed_escrow,
                created_tick: tick,
            });
        }
        self.planets.get_mut(planet_id).unwrap().last_demands = demands.clone();
        demands
    }

    pub fn apply_intent(&mut self, company_id: &str, intent: Intent, tick: u64) -> bool {
        if !self.companies.contains_key(company_id) {
            return false;
        }
        match intent {
            Intent::CreateOrder {
                station_id,
                side,
                item_id,
                qty,
                price,
            } => {
                if qty == 0 || price <= 0 || !self.catalog.items.contains_key(&item_id) {
                    return false;
                }
                if !self.stations.contains_key(&station_id) {
                    return false;
                }
                let active_orders: usize = self
                    .stations
                    .values()
                    .flat_map(|st| st.bids.values().chain(st.asks.values()))
                    .flat_map(|v| v.iter())
                    .filter(|o| o.owner_id == company_id)
                    .count();
                if active_orders >= MAX_ACTIVE_ORDERS_PER_COMPANY {
                    return false;
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
                    return false;
                }

                let escrow_cash = match side {
                    OrderSide::Buy => {
                        let cost = (qty as i128 * price as i128) as Money;
                        let comp = self.companies.get_mut(company_id).unwrap();
                        if cost <= 0 || comp.cash < cost {
                            return false;
                        }
                        comp.cash -= cost;
                        cost
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
                                    return false;
                                }
                                comp.add_station_qty(&station_id, &item_id, -(st_have as i64));
                                comp.add_ground_qty(pid, &item_id, -((qty - st_have) as i64));
                            } else {
                                return false;
                            }
                        } else {
                            return false;
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
                true
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
                            return false;
                        }
                        break;
                    }
                }
                let Some(order) = found else {
                    return false;
                };
                match order.side {
                    OrderSide::Buy => {
                        self.companies.get_mut(company_id).unwrap().cash += order.escrow_cash;
                    }
                    OrderSide::Sell => {
                        self.companies.get_mut(company_id).unwrap().add_station_qty(
                            &order.station_id,
                            &order.item_id,
                            order.qty as i64,
                        );
                    }
                }
                true
            }

            Intent::DealOrder { order_id, amount } => {
                if amount == 0 {
                    return false;
                }
                let mut target_sid = None;
                let mut is_valid = false;
                for (sid, st) in &self.stations {
                    for o in st
                        .bids
                        .values()
                        .chain(st.asks.values())
                        .flat_map(|v| v.iter())
                    {
                        if o.order_id == order_id {
                            target_sid = Some(sid.clone());
                            is_valid = o.owner_id != company_id;
                            break;
                        }
                    }
                }
                let Some(sid) = target_sid else {
                    return false;
                };
                if !is_valid {
                    return false;
                }
                let order = self.stations.get_mut(&sid).unwrap().remove_order(order_id).unwrap();
                let take = amount.min(order.qty);
                if take == 0 {
                    self.stations.get_mut(&sid).unwrap().insert_order(order);
                    return false;
                }
                let notional = (take as i128 * order.price as i128) as Money;
                match order.side {
                    OrderSide::Sell => {
                        // Caller buys from resting Sell order
                        if self.companies[company_id].cash < notional {
                            self.stations.get_mut(&sid).unwrap().insert_order(order);
                            return false;
                        }
                        self.companies.get_mut(company_id).unwrap().cash -= notional;
                        let fee = bps_of(notional, self.stations[&sid].fee_bps);
                        let fill = TradeFill {
                            tick,
                            station_id: sid.clone(),
                            item_id: order.item_id.clone(),
                            qty: take,
                            price: order.price,
                            notional,
                            fee,
                            seller_proceeds: notional - fee,
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
                        true
                    }
                    OrderSide::Buy => {
                        // Caller sells into resting Buy order
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
                                    return false;
                                }
                                comp.add_station_qty(&sid, &order.item_id, -(st_have as i64));
                                comp.add_ground_qty(pid, &order.item_id, -((take - st_have) as i64));
                            } else {
                                self.stations.get_mut(&sid).unwrap().insert_order(order);
                                return false;
                            }
                        } else {
                            self.stations.get_mut(&sid).unwrap().insert_order(order);
                            return false;
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
                            seller_proceeds: notional - fee,
                            buyer_refund: 0,
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
                            rem.escrow_cash -= notional;
                            self.stations.get_mut(&sid).unwrap().insert_order(rem);
                        }
                        true
                    }
                }
            }

            Intent::SetRecipe {
                building_id,
                recipe_id,
            } => {
                let Some(b) = self.buildings.get(&building_id) else {
                    return false;
                };
                if b.owner_id != company_id {
                    return false;
                }
                let Some(rec) = self.catalog.recipes.get(&recipe_id) else {
                    return false;
                };
                if !rec.enabled || rec.building_id != b.building_type {
                    return false;
                }
                self.buildings.get_mut(&building_id).unwrap().recipe_id = recipe_id;
                true
            }

            Intent::ToggleBuilding {
                building_id,
                active,
            } => {
                let Some(b) = self.buildings.get_mut(&building_id) else {
                    return false;
                };
                if b.owner_id != company_id {
                    return false;
                }
                b.active = active;
                true
            }

            Intent::BuildFacility {
                plot_id,
                building_type,
            } => {
                let Some(bdef) = self.catalog.buildings.get(&building_type).cloned() else {
                    return false;
                };
                let Some(plot) = self.plots.get(&plot_id) else {
                    return false;
                };
                if plot.owner_id.as_deref() != Some(company_id) {
                    return false;
                }
                if plot.used_slots() + bdef.slots_used > plot.capacity {
                    return false;
                }
                let pid = plot.planet_id.clone();
                let cash_fee = to_money(80.0 * self.cpi);
                let comp = self.companies.get(company_id).unwrap();
                if comp.cash < cash_fee {
                    return false;
                }
                for req in &bdef.build_cost {
                    if comp.ground_qty(&pid, &req.item) < req.qty {
                        return false;
                    }
                }
                let comp = self.companies.get_mut(company_id).unwrap();
                comp.cash -= cash_fee;
                for req in &bdef.build_cost {
                    comp.add_ground_qty(&pid, &req.item, -(req.qty as i64));
                }
                self.pay_wages(&pid, cash_fee);
                self.plots.get_mut(&plot_id).unwrap().jobs.push(SiteJob {
                    action: "build".to_string(),
                    building_type,
                    finish_tick: tick + bdef.build_ticks as u64,
                });
                true
            }

            Intent::DemolishFacility {
                plot_id,
                building_id,
            } => {
                let Some(plot) = self.plots.get_mut(&plot_id) else {
                    return false;
                };
                if plot.owner_id.as_deref() != Some(company_id) {
                    return false;
                }
                let Some(pos) = plot.building_ids.iter().position(|&id| id == building_id) else {
                    return false;
                };
                plot.building_ids.remove(pos);
                self.buildings.remove(&building_id);
                true
            }

            Intent::BuyPlot {
                planet_id,
                listing_id,
            } => {
                if !self.planets.contains_key(&planet_id) {
                    return false;
                }
                if let Some(lid) = listing_id {
                    let pos = self.planets[&planet_id]
                        .land_listings
                        .iter()
                        .position(|l| l.listing_id == lid);
                    let Some(idx) = pos else {
                        return false;
                    };
                    let lst = &self.planets[&planet_id].land_listings[idx];
                    if lst.seller_id == company_id || self.companies[company_id].cash < lst.ask_price {
                        return false;
                    }
                    let lst = self
                        .planets
                        .get_mut(&planet_id)
                        .unwrap()
                        .land_listings
                        .remove(idx);
                    self.companies.get_mut(company_id).unwrap().cash -= lst.ask_price;
                    if lst.seller_id == "BANK" {
                        let p = self.planets.get_mut(&planet_id).unwrap();
                        let pay_debt = lst.debt_recovery.min(lst.ask_price);
                        p.bank.total_loans = p.bank.total_loans.saturating_sub(pay_debt);
                        p.bank.reserves += lst.ask_price;
                    } else if let Some(seller) = self.companies.get_mut(&lst.seller_id) {
                        seller.cash += lst.ask_price;
                    } else {
                        self.planets.get_mut(&planet_id).unwrap().treasury += lst.ask_price;
                    }
                    if let Some(pl) = self.plots.get_mut(&lst.plot_id) {
                        pl.owner_id = Some(company_id.to_string());
                        for &bid in &pl.building_ids {
                            if let Some(b) = self.buildings.get_mut(&bid) {
                                b.owner_id = company_id.to_string();
                                b.active_batch = false;
                                b.progress = 0;
                                b.idle_ticks = 0;
                            }
                        }
                    }
                    self.companies.get_mut(company_id).unwrap().plots.push(lst.plot_id);
                    true
                } else {
                    let price = self.planets[&planet_id].primary_land_price(self.cpi);
                    if self.companies[company_id].cash < price
                        || self.planets[&planet_id].unclaimed_plots_remaining == 0
                    {
                        return false;
                    }
                    let plot_id = self.next_plot_id;
                    self.next_plot_id += 1;
                    let mut plot = self
                        .planets
                        .get_mut(&planet_id)
                        .unwrap()
                        .materialize_primary_plot(plot_id, &self.catalog)
                        .unwrap();
                    plot.owner_id = Some(company_id.to_string());
                    self.companies.get_mut(company_id).unwrap().cash -= price;
                    self.planets.get_mut(&planet_id).unwrap().treasury += price;
                    self.plots.insert(plot_id, plot);
                    self.companies.get_mut(company_id).unwrap().plots.push(plot_id);
                    true
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
                    return false;
                };
                if ship_snap.is_busy(tick) || ship_snap.location != from || cargo.is_empty() {
                    return false;
                }
                let Some(route) = compute_route(
                    &from,
                    &to,
                    ship_snap.size,
                    ship_snap.durability,
                    &self.planets,
                    self.hub_orbit_radius,
                    self.hub_orbit_angle,
                ) else {
                    return false;
                };
                // Aggregate total requested cargo & validate non-zero quantities + capacity
                let mut clean_cargo: HashMap<ItemId, u32> = HashMap::new();
                let mut total_units = 0u32;
                for (it, qty) in cargo {
                    if qty == 0 || !self.catalog.items.contains_key(&it) {
                        return false;
                    }
                    *clean_cargo.entry(it).or_insert(0) += qty;
                    total_units = total_units.saturating_add(qty);
                }
                if total_units == 0 || total_units > ship_snap.capacity() {
                    return false;
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
                        return false;
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
                            return false;
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
                    arrival_tick: tick + route.ticks as u64,
                });
                true
            }

            Intent::RepairShip { ship_id } => {
                let Some(repair_item) = self.catalog.repair_item.clone() else {
                    return false;
                };
                let comp = self.companies.get_mut(company_id).unwrap();
                let Some(idx) = comp.ships.iter().position(|s| s.id == ship_id) else {
                    return false;
                };
                if comp.ships[idx].is_busy(tick) || comp.ships[idx].durability >= 99.9 {
                    return false;
                }
                let loc = comp.ships[idx].location.clone();
                let need = comp.ships[idx].size.repair_cost();
                if loc.starts_with("ST:") {
                    if comp.station_qty(&loc, &repair_item) < need {
                        return false;
                    }
                    comp.add_station_qty(&loc, &repair_item, -(need as i64));
                } else {
                    if comp.ground_qty(&loc, &repair_item) < need {
                        return false;
                    }
                    comp.add_ground_qty(&loc, &repair_item, -(need as i64));
                }
                comp.ships[idx].durability = 100.0;
                true
            }

            Intent::BankOp {
                planet_id,
                op,
                amount,
            } => {
                if amount <= 0 || !self.planets.contains_key(&planet_id) {
                    return false;
                }
                if self.companies[company_id].home_planet_id != planet_id {
                    return false;
                }
                match op {
                    BankOpKind::Deposit => {
                        if self.companies[company_id].cash < amount {
                            return false;
                        }
                        self.companies.get_mut(company_id).unwrap().cash -= amount;
                        self.companies.get_mut(company_id).unwrap().savings += amount;
                        let p = self.planets.get_mut(&planet_id).unwrap();
                        p.bank.reserves += amount;
                        p.bank.total_deposits += amount;
                        true
                    }
                    BankOpKind::Withdraw => {
                        let comp = &self.companies[company_id];
                        let p = &self.planets[&planet_id];
                        if comp.savings < amount || p.bank.reserves < amount {
                            return false;
                        }
                        self.companies.get_mut(company_id).unwrap().savings -= amount;
                        self.companies.get_mut(company_id).unwrap().cash += amount;
                        let p = self.planets.get_mut(&planet_id).unwrap();
                        p.bank.reserves -= amount;
                        p.bank.total_deposits -= amount;
                        true
                    }
                    BankOpKind::Borrow => {
                        let p = &self.planets[&planet_id];
                        if p.bank.reserves < amount {
                            return false;
                        }
                        self.planets.get_mut(&planet_id).unwrap().bank.reserves -= amount;
                        self.planets.get_mut(&planet_id).unwrap().bank.total_loans += amount;
                        self.companies.get_mut(company_id).unwrap().cash += amount;
                        self.companies.get_mut(company_id).unwrap().debt += amount;
                        true
                    }
                    BankOpKind::Repay => {
                        let comp = &self.companies[company_id];
                        let repay = amount.min(comp.debt);
                        if repay <= 0 || comp.cash < repay {
                            return false;
                        }
                        self.companies.get_mut(company_id).unwrap().cash -= repay;
                        self.companies.get_mut(company_id).unwrap().debt -= repay;
                        let p = self.planets.get_mut(&planet_id).unwrap();
                        p.bank.total_loans = p.bank.total_loans.saturating_sub(repay);
                        p.bank.reserves += repay;
                        true
                    }
                }
            }
        }
    }

    fn settle_trade_fill(&mut self, fill: &TradeFill) {
        // 1. Refund excess buy escrow (price improvement)
        if fill.buyer_refund > 0 {
            if let Some(pid) = fill.buyer_id.strip_prefix("PLANET:") {
                if let Some(p) = self.planets.get_mut(pid) {
                    p.treasury += fill.buyer_refund;
                }
            } else if let Some(b) = self.companies.get_mut(&fill.buyer_id) {
                b.cash += fill.buyer_refund;
            }
        }

        // 2. Credit seller proceeds
        if fill.seller_id == "BANK" {
            let pid = fill.station_id.strip_prefix("ST:").unwrap_or("P2");
            let bank_pid = if self.planets.contains_key(pid) { pid } else { "P2" };
            if let Some(p) = self.planets.get_mut(bank_pid) {
                p.bank.reserves += fill.seller_proceeds;
            }
        } else if let Some(s) = self.companies.get_mut(&fill.seller_id) {
            s.cash += fill.seller_proceeds;
        }

        // 3. Credit trade station fee (0.5%) to station planet treasury (Hub -> habitable cities)
        self.ledger.total_trade_fees += fill.fee as i128;
        if let Some(pid) = fill.station_id.strip_prefix("ST:") {
            if pid == "HUB" {
                self.credit_habitable_cities(fill.fee);
            } else if let Some(p) = self.planets.get_mut(pid) {
                p.treasury += fill.fee;
            }
        }

        // 4. Deliver goods to buyer
        if let Some(pid) = fill.buyer_id.strip_prefix("PLANET:") {
            if let Some(p) = self.planets.get_mut(pid) {
                *p.bought_this_tick.entry(fill.item_id.clone()).or_insert(0) += fill.qty;
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
        let mut rent_collected = 0;
        let hub = &self.stations["ST:HUB"];
        for comp in self.companies.values_mut() {
            let Some(inv) = comp.station_inv.get("ST:HUB") else {
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
                    .unwrap_or(&to_money(self.catalog.items.get(it).map(|x| x.ref_price).unwrap_or(1.0)));
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
            self.credit_habitable_cities(rent_collected);
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
            let insolvent = liquid < to_money(30.0 * self.cpi) && comp.debt > est_assets;
            let all_stalled = bld_count > 0
                && blds
                    .iter()
                    .all(|b| !b.active_batch && b.idle_ticks >= 120);
            let stalled_broke = liquid < to_money(45.0 * self.cpi) && all_stalled;
            let deep_zombie = bld_count > 0
                && blds
                    .iter()
                    .all(|b| !b.active_batch && b.idle_ticks >= 360);
            if insolvent || stalled_broke || deep_zombie {
                comp.distress_ticks += 1;
            } else {
                comp.distress_ticks = 0;
            }
            if (insolvent && comp.distress_ticks >= 48) || comp.distress_ticks >= 96 {
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
                            OrderSide::Buy => returned_cash += o.escrow_cash,
                            OrderSide::Sell => {
                                *confiscated_station_inv
                                    .entry(sid.clone())
                                    .or_default()
                                    .entry(o.item_id)
                                    .or_insert(0) += o.qty;
                            }
                        }
                    }
                }
            }

            if let Some(home_p) = self.planets.get_mut(&comp.home_planet_id) {
                home_p.bank.total_loans = home_p.bank.total_loans.saturating_sub(comp.debt);
                home_p.bank.total_deposits = home_p.bank.total_deposits.saturating_sub(comp.savings);
                // Settle remaining cash back to bank reserves (zero currency destruction!)
                home_p.bank.reserves += returned_cash;
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
                        let ask_p = ((last_p * 88) / 100).max(to_money(0.1 * self.cpi));
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
                if let Some(pl) = self.plots.get_mut(&pl_id) {
                    pl.owner_id = None;
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
            }
        }
        dead
    }

    pub fn snapshot_for(&self, company_id: &str) -> Option<WorldSnapshot> {
        let comp = self.companies.get(company_id)?;
        let plots: Vec<PlotView> = comp
            .plots
            .iter()
            .filter_map(|pid| self.plots.get(pid))
            .map(|pl| PlotView {
                id: pl.id,
                planet_id: pl.planet_id.clone(),
                terrain_name: pl.terrain_name.clone(),
                capacity: pl.capacity,
                used_slots: pl.used_slots(),
                building_mods: pl.building_mods.clone(),
            })
            .collect();
        let buildings: Vec<BuildingView> = self
            .buildings
            .values()
            .filter(|b| b.owner_id == company_id)
            .map(|b| BuildingView {
                id: b.id,
                building_type: b.building_type.clone(),
                plot_id: b.plot_id,
                planet_id: b.planet_id.clone(),
                efficiency: b.efficiency,
                recipe_id: b.recipe_id.clone(),
                active: b.active,
                progress: b.progress,
                cycle_ticks: self
                    .catalog
                    .recipes
                    .get(&b.recipe_id)
                    .map(|r| r.cycle_ticks)
                    .unwrap_or(1),
            })
            .collect();
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

        let mut open_orders = Vec::new();
        let mut all_orders = Vec::new();
        let mut quotes: HashMap<StationId, HashMap<ItemId, _>> = HashMap::new();
        let mut depths: HashMap<StationId, HashMap<ItemId, _>> = HashMap::new();
        for (sid, st) in &self.stations {
            let mut sq = HashMap::new();
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
                if o.owner_id == company_id {
                    open_orders.push(o.clone());
                }
            }
        }

        let mut planets_view = HashMap::new();
        for (pid, p) in &self.planets {
            let demands = p.compute_demands(&self.catalog);
            planets_view.insert(
                pid.clone(),
                PlanetView {
                    id: p.id.clone(),
                    name: p.name.clone(),
                    wealth_tier: p.wealth_tier,
                    prosperity: p.prosperity,
                    population: p.population,
                    gravity: p.gravity,
                    waste_backlog: p.waste_backlog,
                    primary_land_price: if p.unclaimed_plots_remaining > 0 {
                        Some(p.primary_land_price(self.cpi))
                    } else {
                        None
                    },
                    land_listings: p
                        .land_listings
                        .iter()
                        .take(8)
                        .map(|l| LandListingView {
                            listing_id: l.listing_id,
                            plot_id: l.plot_id,
                            ask_price: l.ask_price,
                        })
                        .collect(),
                    bank_rate_bps: p.bank.annual_rate_bps,
                    ground_store: comp.ground_inv.get(pid).cloned().unwrap_or_default(),
                    station_store: comp.station_inv.get(&p.station_id).cloned().unwrap_or_default(),
                    demands,
                },
            );
        }

        let mut routes: HashMap<String, HashMap<String, (u32, u32)>> = HashMap::new();
        for pid in self.planets.keys() {
            let sid = format!("ST:{pid}");
            for (a, b) in [
                (pid.as_str(), sid.as_str()),
                (sid.as_str(), pid.as_str()),
                (sid.as_str(), "ST:HUB"),
                ("ST:HUB", sid.as_str()),
            ] {
                if let Some(r) = compute_route(
                    a,
                    b,
                    ShipSize::Small,
                    100.0,
                    &self.planets,
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
                plots,
                buildings,
                ships,
                station_stores: comp.station_inv.clone(),
                open_orders,
            },
            planets: planets_view,
            quotes,
            depths,
            orders: all_orders,
            routes,
        })
    }
}

//! Read-only WorldSnapshot exported identically to QuickJS Game API and free-play NPC brains.

use std::collections::{BTreeMap, HashMap};

use serde::{Deserialize, Serialize};

use crate::exchange::{DepthLevel, MarketQuote, Order};
use crate::logistics::ShipSize;
use crate::types::{
    BuildingId, BuildingTypeId, CompanyId, ItemId, ListingId, Money, PlanetId, PlotId,
    ProfessionId, RecipeId, SlotId, StationId,
};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct BuildingView {
    pub id: BuildingId,
    pub building_type: BuildingTypeId,
    pub plot_id: PlotId,
    pub planet_id: PlanetId,
    pub efficiency: f64,
    pub recipe_id: RecipeId,
    pub active: bool,
    pub progress: u32,
    pub cycle_ticks: u32,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PlotView {
    pub id: PlotId,
    pub slot_id: SlotId,
    pub planet_id: PlanetId,
    pub lat: f64,
    pub lon: f64,
    pub terrain_name: String,
    pub capacity: u32,
    pub used_slots: u32,
    pub building_mods: HashMap<BuildingTypeId, f64>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ShipView {
    pub id: u64,
    pub size: ShipSize,
    pub capacity: u32,
    pub durability: f64,
    pub location: String,
    pub busy_until: u64,
    pub is_busy: bool,
    pub cargo: HashMap<ItemId, u32>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct LandListingView {
    pub listing_id: ListingId,
    pub plot_id: PlotId,
    pub slot_id: SlotId,
    pub seller_id: String,
    pub ask_price: Money,
    pub terrain_name: String,
    pub lat: f64,
    pub lon: f64,
    pub capacity: u32,
    pub used_slots: u32,
    pub building_mods: HashMap<BuildingTypeId, f64>,
    pub buildings: Vec<BuildingTypeId>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PublicLandTileView {
    pub slot_id: SlotId,
    pub planet_id: PlanetId,
    pub lat: f64,
    pub lon: f64,
    pub terrain_name: String,
    pub capacity: u32,
    pub used_slots: u32,
    pub building_mods: HashMap<BuildingTypeId, f64>,
    pub status: String, // "city" | "unclaimed" | "listed" | "owned"
    pub is_city: bool,
    pub city_name: Option<String>,
    pub owner_id: Option<CompanyId>,
    pub owner_name: Option<String>,
    pub is_player_owner: bool,
    pub plot_id: Option<PlotId>,
    pub listing_id: Option<ListingId>,
    pub price: Option<Money>,
    pub buildings: Vec<BuildingTypeId>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct StarSystemView {
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

fn default_snapshot_system_id() -> String {
    "S1".to_string()
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PlanetView {
    pub id: PlanetId,
    #[serde(default = "default_snapshot_system_id")]
    pub system_id: String,
    pub name: String,
    pub wealth_tier: u8,
    pub prosperity: f64,
    pub population: f64,
    pub gravity: f64,
    #[serde(default)]
    pub habitability: f64,
    pub waste_backlog: u32,
    pub primary_land_price: Option<Money>,
    pub land_listings: Vec<LandListingView>,
    pub bank_rate_bps: u32,
    pub ground_store: HashMap<ItemId, u32>,
    pub station_store: HashMap<ItemId, u32>,
    pub demands: HashMap<ItemId, u32>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SelfView {
    pub id: CompanyId,
    pub name: String,
    pub profession: ProfessionId,
    pub home_planet_id: PlanetId,
    pub cash: Money,
    pub savings: Money,
    pub debt: Money,
    pub plots: Vec<PlotView>,
    pub buildings: Vec<BuildingView>,
    pub ships: Vec<ShipView>,
    pub station_stores: HashMap<StationId, HashMap<ItemId, u32>>,
    pub open_orders: Vec<Order>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct ShipCountsView {
    pub small: u32,
    pub medium: u32,
    pub large: u32,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PublicCompanySummary {
    pub id: CompanyId,
    pub name: String,
    pub is_player: bool,
    pub home_planet_id: PlanetId,
    pub net_liquid: Money,
    pub plots_count: usize,
    pub buildings_count: usize,
    pub ships_count: usize,
    pub ships_by_size: ShipCountsView,
    pub open_orders_count: usize,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PublicCompanyPlotView {
    pub planet_id: PlanetId,
    pub slot_id: SlotId,
    pub plot_id: Option<PlotId>,
    pub lat: f64,
    pub lon: f64,
    pub terrain_name: String,
    pub capacity: u32,
    pub used_slots: u32,
    pub status: String, // "owned" | "listed"
    pub listing_id: Option<ListingId>,
    pub price: Option<Money>,
    pub buildings: Vec<BuildingTypeId>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PublicCompanyDetail {
    pub id: CompanyId,
    pub name: String,
    pub is_player: bool,
    pub home_planet_id: PlanetId,
    pub net_liquid: Money,
    pub plots_count: usize,
    pub buildings_count: usize,
    pub ships_count: usize,
    pub ships_by_size: ShipCountsView,
    pub building_counts: BTreeMap<BuildingTypeId, u32>,
    pub plots: Vec<PublicCompanyPlotView>,
    pub open_orders_count: usize,
    pub open_orders: Vec<Order>,
}

#[derive(Debug, Clone)]
pub struct SharedSnapshot {
    pub quotes: HashMap<StationId, HashMap<ItemId, MarketQuote>>,
    pub depths: HashMap<StationId, HashMap<ItemId, (Vec<DepthLevel>, Vec<DepthLevel>)>>,
    pub all_orders: Vec<Order>,
    pub open_orders_by_owner: HashMap<CompanyId, Vec<Order>>,
    pub systems: HashMap<String, StarSystemView>,
    pub planet_templates: Vec<(PlanetId, StationId, PlanetView)>,
    pub public_tiles_by_planet: HashMap<PlanetId, Vec<PublicLandTileView>>,
    pub public_companies: Vec<PublicCompanySummary>,
    pub routes: HashMap<String, HashMap<String, (u32, u32)>>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct WorldSnapshot {
    pub tick: u64,
    pub cpi: f64,
    pub company: SelfView,
    #[serde(default)]
    pub systems: HashMap<String, StarSystemView>,
    pub planets: HashMap<PlanetId, PlanetView>,
    pub quotes: HashMap<StationId, HashMap<ItemId, MarketQuote>>,
    pub depths: HashMap<StationId, HashMap<ItemId, (Vec<DepthLevel>, Vec<DepthLevel>)>>,
    pub orders: Vec<Order>,
    pub routes: HashMap<String, HashMap<String, (u32, u32)>>,
    #[serde(default, skip_serializing)]
    pub public_tiles: HashMap<PlanetId, Vec<PublicLandTileView>>,
    #[serde(default, skip_serializing)]
    pub public_companies: Vec<PublicCompanySummary>,
}

impl WorldSnapshot {
    pub fn route_cost(&self, from: &str, to: &str) -> Option<(u32, u32)> {
        self.routes.get(from).and_then(|m| m.get(to)).copied()
    }

    /// Assemble public intelligence detail for `company_id` from snapshot public views.
    /// Intentionally excludes private financials (`cash`/`savings`/`debt`), inventories,
    /// active recipes/idle state, and live ship routes/cargo.
    pub fn public_company_detail(&self, company_id: &str) -> Option<PublicCompanyDetail> {
        let summary = self.public_companies.iter().find(|c| c.id == company_id)?;
        let mut plots: Vec<PublicCompanyPlotView> = self
            .public_tiles
            .values()
            .flat_map(|tiles| tiles.iter())
            .filter(|t| t.owner_id.as_deref() == Some(company_id))
            .map(|t| PublicCompanyPlotView {
                planet_id: t.planet_id.clone(),
                slot_id: t.slot_id,
                plot_id: t.plot_id,
                lat: t.lat,
                lon: t.lon,
                terrain_name: t.terrain_name.clone(),
                capacity: t.capacity,
                used_slots: t.used_slots,
                status: t.status.clone(),
                listing_id: t.listing_id,
                price: t.price,
                buildings: t.buildings.clone(),
            })
            .collect();
        plots.sort_by(|a, b| {
            a.planet_id
                .cmp(&b.planet_id)
                .then_with(|| a.slot_id.cmp(&b.slot_id))
        });

        let mut building_counts: BTreeMap<BuildingTypeId, u32> = BTreeMap::new();
        for p in &plots {
            for b in &p.buildings {
                *building_counts.entry(b.clone()).or_insert(0) += 1;
            }
        }

        let mut open_orders: Vec<Order> = self
            .orders
            .iter()
            .filter(|o| o.owner_id == company_id)
            .cloned()
            .collect();
        open_orders.sort_by(|a, b| {
            a.station_id
                .cmp(&b.station_id)
                .then_with(|| a.item_id.cmp(&b.item_id))
                .then_with(|| a.order_id.cmp(&b.order_id))
        });

        Some(PublicCompanyDetail {
            id: summary.id.clone(),
            name: summary.name.clone(),
            is_player: summary.is_player,
            home_planet_id: summary.home_planet_id.clone(),
            net_liquid: summary.net_liquid,
            plots_count: summary.plots_count,
            buildings_count: summary.buildings_count,
            ships_count: summary.ships_count,
            ships_by_size: summary.ships_by_size.clone(),
            building_counts,
            plots,
            open_orders_count: open_orders.len(),
            open_orders,
        })
    }

    /// Resolve the trade hub station serving a given planet (or the company's home planet).
    pub fn hub_for_planet(&self, planet_id: &str) -> &str {
        if let Some(p) = self.planets.get(planet_id) {
            if let Some(sys) = self.systems.get(&p.system_id) {
                return sys.hub_station_id.as_str();
            }
        }
        self.systems
            .values()
            .next()
            .map(|s| s.hub_station_id.as_str())
            .unwrap_or("ST:HUB")
    }

    /// Resolve the company's home system trade hub station (defaults to `ST:HUB`).
    pub fn home_hub_id(&self) -> &str {
        self.hub_for_planet(&self.company.home_planet_id)
    }
}

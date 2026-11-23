//! Read-only WorldSnapshot exported identically to QuickJS Game API and free-play NPC brains.

use std::collections::HashMap;

use serde::{Deserialize, Serialize};

use crate::exchange::{DepthLevel, MarketQuote, Order};
use crate::logistics::ShipSize;
use crate::types::{
    BuildingId, BuildingTypeId, CompanyId, ItemId, ListingId, Money, PlanetId, PlotId,
    ProfessionId, RecipeId, StationId,
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
    pub planet_id: PlanetId,
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
    pub ask_price: Money,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PlanetView {
    pub id: PlanetId,
    pub name: String,
    pub wealth_tier: u8,
    pub prosperity: f64,
    pub population: f64,
    pub gravity: f64,
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

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct WorldSnapshot {
    pub tick: u64,
    pub cpi: f64,
    pub company: SelfView,
    pub planets: HashMap<PlanetId, PlanetView>,
    pub quotes: HashMap<StationId, HashMap<ItemId, MarketQuote>>,
    pub depths: HashMap<StationId, HashMap<ItemId, (Vec<DepthLevel>, Vec<DepthLevel>)>>,
    pub orders: Vec<Order>,
    pub routes: HashMap<String, HashMap<String, (u32, u32)>>,
}

impl WorldSnapshot {
    pub fn route_cost(&self, from: &str, to: &str) -> Option<(u32, u32)> {
        self.routes.get(from).and_then(|m| m.get(to)).copied()
    }
}

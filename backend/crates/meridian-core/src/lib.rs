//! Meridian pure physical & accounting world kernel.
//! Strictly forbidden: hardcoded NPC strategy or heuristics.

pub mod company;
pub mod exchange;
pub mod ledger;
pub mod logistics;
pub mod planet;
pub mod schema;
pub mod snapshot;
pub mod types;
pub mod world;

pub use company::Company;
pub use exchange::{CLOBStation, DepthLevel, MarketQuote, Order, TradeFill};
pub use ledger::MoneyLedger;
pub use logistics::{compute_route, RouteKind, RouteSpec, Ship, ShipInFlight, ShipSize};
pub use planet::{BuildingInstance, LandListing, Planet, PlanetBank, Plot, SiteJob};
pub use schema::{
    BuildingDef, DemandCategoryDef, ItemDef, ItemQty, ItemRole, ProductionCatalog, ProductionPack,
    ProfessionDef, RecipeDef,
};
pub use snapshot::{SharedSnapshot, WorldSnapshot};
pub use types::*;
pub use world::{TickReport, World};

pub fn engine_version() -> &'static str {
    env!("CARGO_PKG_VERSION")
}

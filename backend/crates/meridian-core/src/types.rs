//! Core primitives, fixed-point money, player-script return codes, and unified Intents.

use serde::{Deserialize, Serialize};

/// Fixed-point currency unit: 10_000 == 1.0000 credit (eliminates floating-point ledger drift).
pub type Money = i64;
pub const MONEY_SCALE: i64 = 10_000;

/// Trade station fee in basis points (50 bps = 0.50%).
pub const TRADE_FEE_BPS: u32 = 50;

/// Safety limits matching docs/PROTOCOL.md.
pub const MAX_INTENTS_PER_TICK: usize = 32;
pub const MAX_ACTIVE_ORDERS_PER_COMPANY: usize = 64;

#[inline]
pub fn to_money(credits: f64) -> Money {
    if !credits.is_finite() {
        return 0;
    }
    (credits * MONEY_SCALE as f64).round() as Money
}

#[inline]
pub fn from_money(m: Money) -> f64 {
    m as f64 / MONEY_SCALE as f64
}

#[inline]
pub fn bps_of(amount: Money, bps: u32) -> Money {
    if amount <= 0 || bps == 0 {
        return 0;
    }
    ((amount as i128 * bps as i128) / 10_000) as Money
}

/// 玩家脚本写方法的返回码：0 成功，负数为错误码。
pub type RetCode = i32;
pub const OK: RetCode = 0;
pub const ERR_NOT_OWNER: RetCode = -1;
pub const ERR_NO_PATH: RetCode = -2;
pub const ERR_BUSY: RetCode = -4;
pub const ERR_NOT_FOUND: RetCode = -5;
pub const ERR_NOT_ENOUGH_RESOURCES: RetCode = -6;
pub const ERR_INVALID_TARGET: RetCode = -7;
pub const ERR_FULL: RetCode = -8;
pub const ERR_NOT_IN_RANGE: RetCode = -9;
pub const ERR_INVALID_ARGS: RetCode = -10;
pub const ERR_NOT_ENOUGH_CREDITS: RetCode = -14;

pub type ItemId = String;
pub type BuildingTypeId = String;
pub type RecipeId = String;
pub type ProfessionId = String;
pub type PlanetId = String;
pub type StationId = String;
pub type LocationId = String;
pub type CompanyId = String;
pub type OrderId = u64;
pub type PlotId = u64;
pub type SlotId = u32;
pub type BuildingId = u64;
pub type ShipId = u64;
pub type ListingId = u64;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum OrderSide {
    Buy,
    Sell,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum BankOpKind {
    Deposit,
    Withdraw,
    Borrow,
    Repay,
}

/// Unified action protocol shared identically by QuickJS players and free-play NPCs.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub enum Intent {
    CreateOrder {
        station_id: StationId,
        side: OrderSide,
        item_id: ItemId,
        qty: u32,
        /// Limit unit price in fixed-point Money.
        price: Money,
    },
    CancelOrder {
        order_id: OrderId,
    },
    DealOrder {
        order_id: OrderId,
        amount: u32,
    },
    SetRecipe {
        building_id: BuildingId,
        recipe_id: RecipeId,
    },
    ToggleBuilding {
        building_id: BuildingId,
        active: bool,
    },
    BuildFacility {
        plot_id: PlotId,
        building_type: BuildingTypeId,
    },
    DemolishFacility {
        plot_id: PlotId,
        building_id: BuildingId,
    },
    BuyPlot {
        planet_id: PlanetId,
        slot_id: Option<SlotId>,
        listing_id: Option<ListingId>,
    },
    DispatchShip {
        ship_id: ShipId,
        from: LocationId,
        to: LocationId,
        cargo: Vec<(ItemId, u32)>,
    },
    RepairShip {
        ship_id: ShipId,
    },
    BankOp {
        planet_id: PlanetId,
        op: BankOpKind,
        amount: Money,
    },
}

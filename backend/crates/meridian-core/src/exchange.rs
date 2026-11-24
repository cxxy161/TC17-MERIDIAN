//! Sparse CLOB exchange station with price-time priority, fixed-point escrow, and trade station fees.

use std::collections::{HashMap, VecDeque};

use serde::{Deserialize, Serialize};

use crate::types::{
    bps_of, checked_notional, price_in_band, ItemId, Money, OrderId, OrderSide, StationId,
    TRADE_FEE_BPS,
};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Order {
    pub order_id: OrderId,
    pub owner_id: String,
    pub side: OrderSide,
    pub station_id: StationId,
    pub item_id: ItemId,
    pub qty: u32,
    pub total_qty: u32,
    pub price: Money,
    /// Locked cash for Buy orders (always equals qty * price).
    pub escrow_cash: Money,
    pub created_tick: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MarketQuote {
    pub station_id: StationId,
    pub item_id: ItemId,
    pub best_bid: Option<Money>,
    pub best_ask: Option<Money>,
    pub last_price: Money,
    pub ema_fast: Money,
    pub ema_slow: Money,
    pub vol_50t: u64,
    pub total_vol: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DepthLevel {
    pub price: Money,
    pub qty: u32,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TradeFill {
    pub tick: u64,
    pub station_id: StationId,
    pub item_id: ItemId,
    pub qty: u32,
    pub price: Money,
    pub notional: Money,
    pub fee: Money,
    pub seller_proceeds: Money,
    pub buyer_refund: Money,
    pub buyer_id: String,
    pub seller_id: String,
}

/// Sparse Central Limit Order Book for a single station (planet orbit or Hub).
/// Empty books are removed rather than pre-allocated for 350+ items.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CLOBStation {
    pub station_id: StationId,
    pub bids: HashMap<ItemId, Vec<Order>>,
    pub asks: HashMap<ItemId, Vec<Order>>,
    pub last_trade_price: HashMap<ItemId, Money>,
    pub ema_fast: HashMap<ItemId, Money>,
    pub ema_slow: HashMap<ItemId, Money>,
    vol_window: HashMap<ItemId, VecDeque<(u64, u32)>>,
    pub vol_50t: HashMap<ItemId, u64>,
    pub total_vol: HashMap<ItemId, u64>,
    pub fee_bps: u32,
}

impl CLOBStation {
    pub fn new(station_id: impl Into<StationId>) -> Self {
        Self {
            station_id: station_id.into(),
            bids: HashMap::new(),
            asks: HashMap::new(),
            last_trade_price: HashMap::new(),
            ema_fast: HashMap::new(),
            ema_slow: HashMap::new(),
            vol_window: HashMap::new(),
            vol_50t: HashMap::new(),
            total_vol: HashMap::new(),
            fee_bps: TRADE_FEE_BPS,
        }
    }

    pub fn seed_reference_price(&mut self, item_id: &str, ref_price: Money) {
        self.last_trade_price
            .entry(item_id.to_string())
            .or_insert(ref_price);
        self.ema_fast
            .entry(item_id.to_string())
            .or_insert(ref_price);
        self.ema_slow
            .entry(item_id.to_string())
            .or_insert(ref_price);
    }

    pub fn best_bid(&self, item_id: &str) -> Option<Money> {
        self.bids
            .get(item_id)
            .and_then(|v| v.first())
            .map(|o| o.price)
    }

    pub fn best_ask(&self, item_id: &str) -> Option<Money> {
        self.asks
            .get(item_id)
            .and_then(|v| v.first())
            .map(|o| o.price)
    }

    pub fn quote(&self, item_id: &str, fallback_ref: Money) -> MarketQuote {
        let last_p = *self.last_trade_price.get(item_id).unwrap_or(&fallback_ref);
        MarketQuote {
            station_id: self.station_id.clone(),
            item_id: item_id.to_string(),
            best_bid: self.best_bid(item_id),
            best_ask: self.best_ask(item_id),
            last_price: last_p,
            ema_fast: *self.ema_fast.get(item_id).unwrap_or(&last_p),
            ema_slow: *self.ema_slow.get(item_id).unwrap_or(&last_p),
            vol_50t: *self.vol_50t.get(item_id).unwrap_or(&0),
            total_vol: *self.total_vol.get(item_id).unwrap_or(&0),
        }
    }

    pub fn depth(&self, item_id: &str, limit: usize) -> (Vec<DepthLevel>, Vec<DepthLevel>) {
        let mut bid_levels: Vec<DepthLevel> = Vec::new();
        if let Some(bids) = self.bids.get(item_id) {
            for o in bids {
                if let Some(last) = bid_levels.last_mut().filter(|l| l.price == o.price) {
                    last.qty += o.qty;
                } else if bid_levels.len() < limit {
                    bid_levels.push(DepthLevel {
                        price: o.price,
                        qty: o.qty,
                    });
                } else {
                    break;
                }
            }
        }
        let mut ask_levels: Vec<DepthLevel> = Vec::new();
        if let Some(asks) = self.asks.get(item_id) {
            for o in asks {
                if let Some(last) = ask_levels.last_mut().filter(|l| l.price == o.price) {
                    last.qty += o.qty;
                } else if ask_levels.len() < limit {
                    ask_levels.push(DepthLevel {
                        price: o.price,
                        qty: o.qty,
                    });
                } else {
                    break;
                }
            }
        }
        (bid_levels, ask_levels)
    }

    pub fn insert_order(&mut self, order: Order) {
        let item_id = order.item_id.clone();
        match order.side {
            OrderSide::Buy => {
                let list = self.bids.entry(item_id).or_default();
                list.push(order);
                list.sort_by(|a, b| {
                    b.price
                        .cmp(&a.price)
                        .then_with(|| a.created_tick.cmp(&b.created_tick))
                        .then_with(|| a.order_id.cmp(&b.order_id))
                });
            }
            OrderSide::Sell => {
                let list = self.asks.entry(item_id).or_default();
                list.push(order);
                list.sort_by(|a, b| {
                    a.price
                        .cmp(&b.price)
                        .then_with(|| a.created_tick.cmp(&b.created_tick))
                        .then_with(|| a.order_id.cmp(&b.order_id))
                });
            }
        }
    }

    pub fn remove_order(&mut self, order_id: OrderId) -> Option<Order> {
        let mut removed = None;
        let mut empty_bid_keys = Vec::new();
        for (k, list) in &mut self.bids {
            if let Some(pos) = list.iter().position(|o| o.order_id == order_id) {
                removed = Some(list.remove(pos));
                if list.is_empty() {
                    empty_bid_keys.push(k.clone());
                }
                break;
            }
        }
        for k in empty_bid_keys {
            self.bids.remove(&k);
        }
        if removed.is_some() {
            return removed;
        }
        let mut empty_ask_keys = Vec::new();
        for (k, list) in &mut self.asks {
            if let Some(pos) = list.iter().position(|o| o.order_id == order_id) {
                removed = Some(list.remove(pos));
                if list.is_empty() {
                    empty_ask_keys.push(k.clone());
                }
                break;
            }
        }
        for k in empty_ask_keys {
            self.asks.remove(&k);
        }
        removed
    }

    pub fn total_escrow_cash(&self) -> Money {
        self.bids
            .values()
            .flat_map(|v| v.iter())
            .map(|o| o.escrow_cash)
            .sum()
    }

    /// Reference unit price used to bound admissible limit prices on this book.
    fn reference_price(&self, item_id: &str) -> Money {
        self.last_trade_price.get(item_id).copied().unwrap_or(0)
    }

    /// Evict a corrupt top-of-book order and zero its escrow so that it can never be refunded as
    /// phantom money (escrow truncation bug: `(qty * price) as Money` could lock less than the
    /// nominal notional). Dropping the residual escrow only ever burns already-locked cash of the
    /// offending order; it can never create a refund larger than what was actually escrowed.
    fn evict_top(&mut self, item: &str, side: OrderSide) -> bool {
        let removed = match side {
            OrderSide::Buy => self
                .bids
                .get_mut(item)
                .and_then(|v| if v.is_empty() { None } else { Some(v.remove(0)) }),
            OrderSide::Sell => self
                .asks
                .get_mut(item)
                .and_then(|v| if v.is_empty() { None } else { Some(v.remove(0)) }),
        };
        let Some(mut order) = removed else {
            return false;
        };
        let dropped_escrow = order.escrow_cash;
        order.escrow_cash = 0;
        eprintln!(
            "[meridian-core] evicting corrupt {} order {} on {} (price={}, qty={}, dropped_escrow={})",
            match side {
                OrderSide::Buy => "bid",
                OrderSide::Sell => "ask",
            },
            order.order_id,
            item,
            order.price,
            order.qty,
            dropped_escrow
        );
        let empty = match side {
            OrderSide::Buy => self.bids.get(item).map(|v| v.is_empty()).unwrap_or(true),
            OrderSide::Sell => self.asks.get(item).map(|v| v.is_empty()).unwrap_or(true),
        };
        if empty {
            match side {
                OrderSide::Buy => {
                    self.bids.remove(item);
                }
                OrderSide::Sell => {
                    self.asks.remove(item);
                }
            }
        }
        true
    }

    /// Match crossing bids and asks across all items present on this station.
    /// Does NOT expire orders automatically (#18 removed). Collects station fee_bps.
    ///
    /// Every notional is computed with 128-bit checked math and every escrow invariant is verified
    /// *before* mutating the book: `0 <= escrowed_for_take <= bid.escrow_cash` and
    /// `0 <= buyer_refund <= escrowed_for_take`. Corrupt resting orders are evicted instead of
    /// allowing a fill that mints cash.
    pub fn match_all(&mut self, tick: u64) -> Vec<TradeFill> {
        let mut fills = Vec::new();
        let item_keys: Vec<ItemId> = self.bids.keys().cloned().collect();

        for item in item_keys {
            loop {
                let (bid_price, bid_qty, bid_escrow, bid_tick, ask_price, ask_qty, ask_tick) = match (
                    self.bids.get(&item).and_then(|v| v.first()),
                    self.asks.get(&item).and_then(|v| v.first()),
                ) {
                    (Some(b), Some(a)) => (
                        b.price,
                        b.qty,
                        b.escrow_cash,
                        b.created_tick,
                        a.price,
                        a.qty,
                        a.created_tick,
                    ),
                    _ => break,
                };

                // Self-wash guard: block crossing in place, never silently drop escrow.
                let same_owner = {
                    let b = &self.bids[&item][0];
                    let a = &self.asks[&item][0];
                    b.owner_id == a.owner_id
                };
                if same_owner {
                    break;
                }

                if bid_price < ask_price {
                    break;
                }

                let ref_price = self.reference_price(&item);

                // Bid-side invariants: sane price band and non-negative escrow.
                if bid_qty == 0 || bid_escrow < 0 || !price_in_band(bid_price, ref_price) {
                    if !self.evict_top(&item, OrderSide::Buy) {
                        break;
                    }
                    continue;
                }
                if ask_qty == 0 || !price_in_band(ask_price, ref_price) {
                    if !self.evict_top(&item, OrderSide::Sell) {
                        break;
                    }
                    continue;
                }

                let take = bid_qty.min(ask_qty);
                let trade_price = if ask_tick <= bid_tick {
                    ask_price
                } else {
                    bid_price
                };

                // All three amounts are checked; any failure evicts the offending bid.
                let Some(escrowed_for_take) = checked_notional(take, bid_price) else {
                    if !self.evict_top(&item, OrderSide::Buy) {
                        break;
                    }
                    continue;
                };
                let Some(notional) = checked_notional(take, trade_price) else {
                    if !self.evict_top(&item, OrderSide::Buy) {
                        break;
                    }
                    continue;
                };
                let Some(new_bid_escrow) = bid_escrow.checked_sub(escrowed_for_take) else {
                    if !self.evict_top(&item, OrderSide::Buy) {
                        break;
                    }
                    continue;
                };
                let buyer_refund = escrowed_for_take - notional;

                // Hard invariants: never refund more than was escrowed, never go negative, and
                // never pay out more than the ask actually asked for.
                if escrowed_for_take > bid_escrow
                    || new_bid_escrow < 0
                    || notional <= 0
                    || buyer_refund < 0
                    || buyer_refund > escrowed_for_take
                {
                    if !self.evict_top(&item, OrderSide::Buy) {
                        break;
                    }
                    continue;
                }

                let (buyer_id, seller_id) = {
                    let bids = self.bids.get_mut(&item).unwrap();
                    let asks = self.asks.get_mut(&item).unwrap();
                    let b = &mut bids[0];
                    let a = &mut asks[0];
                    b.qty -= take;
                    b.escrow_cash = new_bid_escrow;
                    a.qty -= take;
                    debug_assert!(b.escrow_cash >= 0);
                    (b.owner_id.clone(), a.owner_id.clone())
                };

                if self.bids.get(&item).map(|v| v[0].qty == 0).unwrap_or(false) {
                    self.bids.get_mut(&item).unwrap().remove(0);
                }
                if self.asks.get(&item).map(|v| v[0].qty == 0).unwrap_or(false) {
                    self.asks.get_mut(&item).unwrap().remove(0);
                }
                if self.bids.get(&item).map(|v| v.is_empty()).unwrap_or(false) {
                    self.bids.remove(&item);
                }
                if self.asks.get(&item).map(|v| v.is_empty()).unwrap_or(false) {
                    self.asks.remove(&item);
                }

                let fee = bps_of(notional, self.fee_bps);
                let seller_proceeds = notional - fee;

                self.record_trade_stats(&item, tick, take, trade_price);
                fills.push(TradeFill {
                    tick,
                    station_id: self.station_id.clone(),
                    item_id: item.clone(),
                    qty: take,
                    price: trade_price,
                    notional,
                    fee,
                    seller_proceeds,
                    buyer_refund,
                    buyer_id,
                    seller_id,
                });
            }
        }

        // Roll 50T volume windows cleanly
        self.prune_50t_windows(tick);
        fills
    }

    pub fn record_trade_stats(&mut self, item: &str, tick: u64, qty: u32, price: Money) {
        self.last_trade_price.insert(item.to_string(), price);
        let has_history = self.total_vol.get(item).copied().unwrap_or(0) > 0;
        let prev_f = *self.ema_fast.get(item).unwrap_or(&price);
        let prev_s = *self.ema_slow.get(item).unwrap_or(&price);
        // Damp single-trade price shocks entering EMA (+/-10% around slow EMA) so thin
        // outlier fills cannot instantly warp CPI or city anchors, while sustained scarcity still trends.
        let ema_input = if has_history && prev_s > 0 {
            let lo = (prev_s.saturating_mul(90) / 100).max(1);
            let hi = (prev_s.saturating_mul(110) / 100).max(prev_s.saturating_add(1));
            price.clamp(lo, hi)
        } else {
            price
        };
        let next_f = ((prev_f as i128 * 85 + ema_input as i128 * 15) / 100) as Money;
        let next_s = ((prev_s as i128 * 97 + ema_input as i128 * 3) / 100) as Money;
        self.ema_fast.insert(item.to_string(), next_f.max(1));
        self.ema_slow.insert(item.to_string(), next_s.max(1));

        let win = self.vol_window.entry(item.to_string()).or_default();
        win.push_back((tick, qty));
        *self.vol_50t.entry(item.to_string()).or_insert(0) += qty as u64;
        *self.total_vol.entry(item.to_string()).or_insert(0) += qty as u64;
    }

    pub fn prune_50t_windows(&mut self, tick: u64) {
        let cutoff = tick.saturating_sub(50);
        for (item, win) in &mut self.vol_window {
            while let Some(&(t, q)) = win.front() {
                if t <= cutoff {
                    win.pop_front();
                    if let Some(v) = self.vol_50t.get_mut(item) {
                        *v = v.saturating_sub(q as u64);
                    }
                } else {
                    break;
                }
            }
        }
    }
}

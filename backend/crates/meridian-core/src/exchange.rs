//! Sparse CLOB exchange station with price-time priority, fixed-point escrow, and trade station fees.

use std::collections::{HashMap, VecDeque};

use serde::{Deserialize, Serialize};

use crate::types::{bps_of, ItemId, Money, OrderId, OrderSide, StationId, TRADE_FEE_BPS};

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

    /// Match crossing bids and asks across all items present on this station.
    /// Does NOT expire orders automatically (#18 removed). Collects station fee_bps.
    pub fn match_all(&mut self, tick: u64) -> Vec<TradeFill> {
        let mut fills = Vec::new();
        let item_keys: Vec<ItemId> = self.bids.keys().cloned().collect();

        for item in item_keys {
            loop {
                let can_cross = match (
                    self.bids.get(&item).and_then(|v| v.first()),
                    self.asks.get(&item).and_then(|v| v.first()),
                ) {
                    (Some(b), Some(a)) => b.price >= a.price,
                    _ => false,
                };
                if !can_cross {
                    break;
                }

                // Skip self-wash: if same owner holds both top orders, cancel the newer one cleanly
                let same_owner = {
                    let b = &self.bids[&item][0];
                    let a = &self.asks[&item][0];
                    b.owner_id == a.owner_id
                };
                if same_owner {
                    // Pop newer order out of matching? Wait: returning its escrow is caller's duty;
                    // better to block crossing in place or pop nothing without refund!
                    // Break matching for this item if top bid == top ask owner (prevent zero-refund silent drop).
                    break;
                }

                let (trade_price, take, buyer_id, seller_id, buyer_refund) = {
                    let bids = self.bids.get_mut(&item).unwrap();
                    let asks = self.asks.get_mut(&item).unwrap();
                    let b = &mut bids[0];
                    let a = &mut asks[0];
                    let trade_price = if a.created_tick <= b.created_tick {
                        a.price
                    } else {
                        b.price
                    };
                    let take = b.qty.min(a.qty);
                    let notional = (take as i128 * trade_price as i128) as Money;
                    let escrowed_for_take = (take as i128 * b.price as i128) as Money;
                    let buyer_refund = escrowed_for_take - notional;
                    b.qty -= take;
                    b.escrow_cash -= escrowed_for_take;
                    a.qty -= take;
                    (
                        trade_price,
                        take,
                        b.owner_id.clone(),
                        a.owner_id.clone(),
                        buyer_refund,
                    )
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

                let notional = (take as i128 * trade_price as i128) as Money;
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
        let prev_f = *self.ema_fast.get(item).unwrap_or(&price);
        let prev_s = *self.ema_slow.get(item).unwrap_or(&price);
        let next_f = ((prev_f as i128 * 85 + price as i128 * 15) / 100) as Money;
        let next_s = ((prev_s as i128 * 97 + price as i128 * 3) / 100) as Money;
        self.ema_fast.insert(item.to_string(), next_f);
        self.ema_slow.insert(item.to_string(), next_s);

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

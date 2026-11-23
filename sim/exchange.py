"""Two-way Central Limit Order Book (CLOB) exchange used by both orbital stations and the system hub."""

from collections import deque

from sim.config import BASE_INVENTORY, BASE_PRICES, ITEM_TO_SHIP_SIZE
from sim.models import Order, new_ship


class CLOBStation:
    """Two-way limit order book with physical inventory conservation and multi-horizon EMAs."""

    def __init__(self, station_id: str, seed_scale: float = 1.0) -> None:
        self.station_id = station_id
        self.inventory: dict[str, int] = {k: max(1, int(v * seed_scale)) for k, v in BASE_INVENTORY.items()}
        self.target_inventory: dict[str, int] = dict(self.inventory)
        self.bids: dict[str, list[Order]] = {k: [] for k in BASE_PRICES}
        self.asks: dict[str, list[Order]] = {k: [] for k in BASE_PRICES}
        self.last_trade_price: dict[str, float] = dict(BASE_PRICES)
        self.ema_fast: dict[str, float] = dict(BASE_PRICES)
        self.ema_med: dict[str, float] = dict(BASE_PRICES)
        self.ema_slow: dict[str, float] = dict(BASE_PRICES)
        self._vol_buckets: deque[dict[str, int]] = deque(maxlen=50)
        self._cur_vol: dict[str, int] = {}
        self.vol_50t: dict[str, int] = {k: 0 for k in BASE_PRICES}
        self.total_vol: dict[str, int] = {k: 0 for k in BASE_PRICES}
        self._next_oid = 1

        for item, qty in self.inventory.items():
            self.place_order("SYSTEM", "sell", item, qty, BASE_PRICES[item], 0, purpose="station")

    def best_bid(self, item: str) -> float | None:
        return self.bids[item][0].price if self.bids.get(item) else None

    def best_ask(self, item: str) -> float | None:
        return self.asks[item][0].price if self.asks.get(item) else None

    def signal_price(self, item: str) -> float:
        bb = self.best_bid(item)
        ba = self.best_ask(item)
        last_p = self.last_trade_price[item]
        if bb is not None and ba is not None:
            capped_ba = min(ba, max(bb, last_p) * 1.35)
            return round((bb + capped_ba) / 2.0, 4)
        if bb is not None:
            # Cap unfilled-bid pull so stockouts cannot ratchet signal_price exponentially
            return round(min(max(bb, last_p), last_p * 1.15), 4)
        if ba is not None:
            # Unsold asks can push signal_price down cleanly, but cannot inflate it without buyers
            return round(min(ba, last_p * 1.05), 4)
        return round(last_p, 4)

    def get_ma(self, item: str, lookback_mix: float) -> float:
        if lookback_mix < 0.5:
            t = lookback_mix * 2.0
            return self.ema_fast[item] * (1.0 - t) + self.ema_med[item] * t
        t = (lookback_mix - 0.5) * 2.0
        return self.ema_med[item] * (1.0 - t) + self.ema_slow[item] * t

    def place_order(
        self, owner_id: str, side: str, item: str, qty: int, price: float, tick: int, purpose: str = "station"
    ) -> None:
        if qty <= 0:
            return
        clean_p = max(0.01, round(price, 4))
        oid = self._next_oid
        self._next_oid += 1
        order = Order(oid, owner_id, side, item, qty, clean_p, tick, purpose)
        if side == "buy":
            self.bids[item] = [o for o in self.bids[item] if not (o.owner_id == owner_id and o.purpose == purpose)]
            self.bids[item].append(order)
            self.bids[item].sort(key=lambda o: (-o.price, o.tick, o.order_id))
        else:
            if owner_id == "BANK":
                prev_bank = [o for o in self.asks[item] if o.owner_id == "BANK"]
                if prev_bank:
                    qty += sum(o.qty for o in prev_bank)
                    clean_p = min(clean_p, *(o.price for o in prev_bank))
                    order = Order(oid, owner_id, side, item, qty, clean_p, tick, purpose)
            self.asks[item] = [o for o in self.asks[item] if o.owner_id != owner_id]
            self.asks[item].append(order)
            self.asks[item].sort(key=lambda o: (o.price, o.tick, o.order_id))

    def cancel_owner_orders(self, owner_id: str) -> None:
        for item in self.bids:
            self.bids[item] = [o for o in self.bids[item] if o.owner_id != owner_id]
            self.asks[item] = [o for o in self.asks[item] if o.owner_id != owner_id]

    def match_all(self, npcs: dict, planet, bank, tick: int | None = None, logger=None) -> int:
        trades = 0
        sid = self.station_id
        for item in self.bids:
            if tick is not None:
                cutoff = tick - 48
                self.bids[item] = [o for o in self.bids[item] if o.tick >= cutoff or o.owner_id.startswith("PLANET:")]
                self.asks[item] = [o for o in self.asks[item] if o.tick >= cutoff or o.owner_id in ("SYSTEM", "BANK")]
            bids = self.bids[item]
            asks = self.asks[item]
            while bids and asks and bids[0].price >= asks[0].price:
                b = bids[0]
                a = asks[0]
                if b.owner_id == a.owner_id:
                    if b.tick < a.tick:
                        bids.pop(0)
                    else:
                        asks.pop(0)
                    continue

                trade_price = a.price if a.tick <= b.tick else b.price

                if b.owner_id.startswith("PLANET:"):
                    buyer_cash = planet.wealth if planet else 0.0
                elif b.owner_id in npcs:
                    buyer_cash = npcs[b.owner_id].cash
                else:
                    bids.pop(0)
                    continue

                if a.owner_id in ("SYSTEM", "BANK"):
                    seller_avail = a.qty
                elif a.owner_id in npcs:
                    seller_avail = min(a.qty, npcs[a.owner_id].get_st_inv(sid, item))
                else:
                    asks.pop(0)
                    continue

                can_afford = int(buyer_cash // trade_price)
                phys_avail = self.inventory.get(item, 0)
                take = min(b.qty, a.qty, can_afford, seller_avail, phys_avail)
                if take <= 0:
                    if can_afford <= 0:
                        bids.pop(0)
                    else:
                        asks.pop(0)
                    continue

                cost = take * trade_price
                tax_rate = planet.tax_rate if planet else 0.02
                tax = cost * tax_rate

                if b.owner_id.startswith("PLANET:") and planet is not None:
                    planet.wealth -= cost - tax
                    self.inventory[item] -= take
                    planet.bought_this_tick[item] = planet.bought_this_tick.get(item, 0) + take
                else:
                    buyer = npcs[b.owner_id]
                    buyer.cash -= cost
                    if planet is not None:
                        planet.wealth += tax
                    else:
                        bank.reserves += tax

                    if b.purpose == "station":
                        buyer.add_st_inv(sid, item, take)
                        if item not in buyer.traded_items:
                            buyer.traded_items.append(item)
                    elif b.purpose == "ship":
                        self.inventory[item] -= take
                        buyer.fleet.append(new_ship(ITEM_TO_SHIP_SIZE[item]))
                    elif b.purpose == "ground":
                        self.inventory[item] -= take
                        buyer.inventory[item] = buyer.inventory.get(item, 0) + take
                    else:  # "pickup"
                        buyer.add_st_pickup(sid, item, take)

                if a.owner_id == "BANK":
                    bank.reserves += cost - tax
                elif a.owner_id in npcs:
                    seller = npcs[a.owner_id]
                    seller.cash += cost - tax
                    seller.add_st_inv(sid, item, -take)

                self.last_trade_price[item] = trade_price
                trades += 1
                self._cur_vol[item] = self._cur_vol.get(item, 0) + take
                self.vol_50t[item] = self.vol_50t.get(item, 0) + take
                self.total_vol[item] = self.total_vol.get(item, 0) + take
                if logger is not None:
                    maker = "ask" if a.tick <= b.tick else "bid"
                    logger.log_trade(
                        tick if tick is not None else max(a.tick, b.tick),
                        sid, item, take, trade_price,
                        b.owner_id, a.owner_id, a.price, b.price, maker, b.purpose,
                    )
                b.qty -= take
                a.qty -= take
                if b.qty == 0:
                    bids.pop(0)
                if a.qty == 0:
                    asks.pop(0)
        return trades

    def update_mas(self) -> None:
        if len(self._vol_buckets) == 50:
            old = self._vol_buckets.popleft()
            for k, v in old.items():
                self.vol_50t[k] = max(0, self.vol_50t.get(k, 0) - v)
        self._vol_buckets.append(self._cur_vol)
        self._cur_vol = {}

        for item in self.last_trade_price:
            sig = self.signal_price(item)
            self.ema_fast[item] = self.ema_fast[item] * 0.85 + sig * 0.15
            self.ema_med[item] = self.ema_med[item] * 0.972 + sig * 0.028
            self.ema_slow[item] = self.ema_slow[item] * 0.9945 + sig * 0.0055

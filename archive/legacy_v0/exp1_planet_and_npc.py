"""Experiment 1: Single Planet + Orbital Station + 1 Food-Producing NPC (168 Ticks = 7 Days)."""

from dataclasses import dataclass, field


@dataclass
class SellOrder:
    seller_id: str
    qty: int
    price: float


@dataclass
class ShipInFlight:
    owner_id: str
    item: str
    qty: int
    arrival_tick: int


@dataclass
class OrbitalStation:
    inventory: dict[str, int] = field(default_factory=lambda: {"food": 100})
    reference_price: dict[str, float] = field(default_factory=lambda: {"food": 10.0})
    sell_orders: dict[str, list[SellOrder]] = field(default_factory=lambda: {"food": []})
    target_inventory: dict[str, int] = field(default_factory=lambda: {"food": 150})
    last_trade_price: dict[str, float] = field(default_factory=lambda: {"food": 10.0})

    def post_sell_order(self, seller_id: str, item: str, qty: int, price: float) -> None:
        if qty <= 0:
            return
        self.sell_orders.setdefault(item, []).append(SellOrder(seller_id, qty, price))
        # Price-time priority: sort by price ascending
        self.sell_orders[item].sort(key=lambda o: o.price)

    def update_reference_price(self, item: str) -> None:
        inv = self.inventory.get(item, 0)
        target = self.target_inventory.get(item, 100)
        ref = self.reference_price.get(item, 10.0)
        last_p = self.last_trade_price.get(item, ref)

        # Pull toward last trade price + inventory imbalance
        imbalance = (target - inv) / max(1, target)
        new_ref = ref * 0.8 + last_p * 0.2
        new_ref *= 1.0 + 0.05 * max(-0.5, min(0.5, imbalance))
        self.reference_price[item] = max(1.0, new_ref)


@dataclass
class NPCFarm:
    npc_id: str = "NPC-Farm-1"
    cash: float = 1000.0
    inventory: dict[str, int] = field(default_factory=lambda: {"food": 40})
    station_inventory: dict[str, int] = field(default_factory=lambda: {"food": 0})
    production_rate: int = 12
    production_cost: float = 4.0
    ship_capacity: int = 50
    ship_busy_until: int = 0
    decision_interval: int = 5
    launch_ticks: int = 2
    launch_cost: float = 5.0

    def produce(self) -> None:
        # Stop-loss: do not overproduce if local warehouse is full
        if self.inventory["food"] >= 100:
            return
        # Produce up to capacity if NPC can afford production cost
        affordable = int(self.cash // self.production_cost)
        qty = min(self.production_rate, affordable)
        if qty > 0:
            self.cash -= qty * self.production_cost
            self.inventory["food"] += qty

    def decide(self, tick: int, station: OrbitalStation, in_flight: list[ShipInFlight]) -> None:
        if tick % self.decision_interval != 0:
            return

        # 1. Ship food to orbital station if ship is idle and enough stock
        if tick >= self.ship_busy_until and self.inventory["food"] >= 30 and self.cash >= self.launch_cost:
            send_qty = min(self.ship_capacity, self.inventory["food"])
            self.inventory["food"] -= send_qty
            self.cash -= self.launch_cost
            self.ship_busy_until = tick + self.launch_ticks
            in_flight.append(ShipInFlight(self.npc_id, "food", send_qty, tick + self.launch_ticks))

        # 2. Post sell order for goods already at the orbital station
        at_station = self.station_inventory.get("food", 0)
        # Subtract already listed qty
        listed = sum(o.qty for o in station.sell_orders["food"] if o.seller_id == self.npc_id)
        unlisted = at_station - listed
        if unlisted > 0:
            ref = station.reference_price["food"]
            # Discount slightly if holding lots of stock at station
            excess_ratio = max(0.0, (at_station - 50) / 100.0)
            ask_price = max(self.production_cost * 1.1, ref * (1.0 - 0.1 * min(0.5, excess_ratio)))
            station.post_sell_order(self.npc_id, "food", unlisted, round(ask_price, 2))


@dataclass
class Planet:
    population: float = 1000.0
    wealth: float = 5000.0
    prosperity: float = 1.0
    base_output_per_capita: float = 0.05
    tax_rate: float = 0.10

    def step(self, station: OrbitalStation, npcs: dict[str, NPCFarm]) -> float:
        # Step 1: Population base output (scaled by prosperity)
        income = self.population * self.base_output_per_capita * self.prosperity
        self.wealth += income

        # Step 2: Calculate food demand & dynamic max willingness-to-pay
        demand_qty = max(1, int(self.population * 0.01))
        inv = station.inventory.get("food", 0)
        ref_price = station.reference_price.get("food", 10.0)

        # Dynamic bidding: pay up to 2.5x reference price when station inventory is low or planet is hungry
        scarcity = max(0.0, (100 - inv) / 100.0)
        hunger = max(0.0, 1.2 - self.prosperity)
        max_bid = ref_price * (1.0 + 1.5 * max(scarcity, hunger))

        bought = 0
        orders = station.sell_orders.get("food", [])
        remaining_orders: list[SellOrder] = []

        for order in orders:
            if bought >= demand_qty:
                remaining_orders.append(order)
                continue
            if order.price > max_bid:
                remaining_orders.append(order)
                continue

            can_afford = int(self.wealth // order.price)
            take = min(demand_qty - bought, order.qty, can_afford, station.inventory["food"])
            if take > 0:
                cost = take * order.price
                tax = cost * self.tax_rate
                self.wealth -= cost
                self.wealth += tax  # Planet collects tax
                station.inventory["food"] -= take
                station.last_trade_price["food"] = order.price

                seller = npcs[order.seller_id]
                seller.cash += cost - tax
                seller.station_inventory["food"] -= take

                bought += take
                if take < order.qty:
                    remaining_orders.append(SellOrder(order.seller_id, order.qty - take, order.price))
            else:
                remaining_orders.append(order)

        station.sell_orders["food"] = remaining_orders

        # Step 3: Update prosperity (soft floor at 0.2)
        satisfaction = bought / demand_qty if demand_qty > 0 else 1.0
        self.prosperity += (satisfaction - 0.8) * 0.05
        self.prosperity = max(0.2, min(2.0, self.prosperity))

        # Step 4: Slow population adjustment
        if self.prosperity > 1.0:
            self.population *= 1.0005
        elif self.prosperity < 0.6:
            self.population *= 0.9995

        return satisfaction


def run_simulation(ticks: int = 168) -> None:
    station = OrbitalStation()
    planet = Planet()
    npc = NPCFarm()
    npcs = {npc.npc_id: npc}
    in_flight: list[ShipInFlight] = []

    print(
        f"{'Tick':>4} | {'Pop':>7} | {'Wealth':>8} | {'Prosp':>5} | {'Sat':>4} | "
        f"{'RefP':>5} | {'StInv':>5} | {'NPCCash':>8} | {'NPCInv':>6}"
    )
    print("-" * 78)

    for t in range(1, ticks + 1):
        # 1. NPC production
        npc.produce()

        # 2. Advance transport edges
        still_flying: list[ShipInFlight] = []
        for flight in in_flight:
            if flight.arrival_tick <= t:
                station.inventory[flight.item] = station.inventory.get(flight.item, 0) + flight.qty
                npcs[flight.owner_id].station_inventory[flight.item] += flight.qty
            else:
                still_flying.append(flight)
        in_flight = still_flying

        # 3. NPC decision & sell orders
        npc.decide(t, station, in_flight)

        # 4 & 5. Planet buys from station
        sat = planet.step(station, npcs)

        # 6. Update reference price
        station.update_reference_price("food")

        if t == 1 or t % 24 == 0:
            print(
                f"{t:4d} | {planet.population:7.1f} | {planet.wealth:8.1f} | "
                f"{planet.prosperity:5.2f} | {sat:4.2f} | {station.reference_price['food']:5.2f} | "
                f"{station.inventory['food']:5d} | {npc.cash:8.1f} | {npc.inventory['food']:6d}"
            )


if __name__ == "__main__":
    run_simulation()

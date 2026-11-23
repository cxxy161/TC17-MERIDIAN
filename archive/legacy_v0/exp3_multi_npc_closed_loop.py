"""Experiment 3: 3 Lines (Fuel, Food, Steel) + 5 NPCs with Closed-Loop Control."""

from dataclasses import dataclass, field


@dataclass
class SellOrder:
    seller_id: str
    qty: int
    price: float


@dataclass
class ShipInFlight:
    owner_id: str
    direction: str  # "to_station" or "to_npc"
    item: str
    qty: int
    arrival_tick: int


@dataclass
class OrbitalStation:
    inventory: dict[str, int] = field(
        default_factory=lambda: {"fuel": 120, "food": 120, "iron": 80, "steel": 50}
    )
    reference_price: dict[str, float] = field(
        default_factory=lambda: {"fuel": 6.0, "food": 10.0, "iron": 8.0, "steel": 26.0}
    )
    sell_orders: dict[str, list[SellOrder]] = field(
        default_factory=lambda: {"fuel": [], "food": [], "iron": [], "steel": []}
    )
    target_inventory: dict[str, int] = field(
        default_factory=lambda: {"fuel": 120, "food": 150, "iron": 100, "steel": 80}
    )
    last_trade_price: dict[str, float] = field(
        default_factory=lambda: {"fuel": 6.0, "food": 10.0, "iron": 8.0, "steel": 26.0}
    )

    def post_sell_order(self, seller_id: str, item: str, qty: int, price: float) -> None:
        if qty <= 0:
            return
        self.sell_orders.setdefault(item, []).append(SellOrder(seller_id, qty, price))
        self.sell_orders[item].sort(key=lambda o: o.price)

    def update_reference_prices(self) -> None:
        for item, ref in self.reference_price.items():
            inv = self.inventory.get(item, 0)
            target = self.target_inventory.get(item, 100)
            last_p = self.last_trade_price.get(item, ref)
            imbalance = (target - inv) / max(1, target)
            new_ref = ref * 0.8 + last_p * 0.2
            new_ref *= 1.0 + 0.05 * max(-0.5, min(0.5, imbalance))
            self.reference_price[item] = max(1.0, new_ref)


@dataclass
class ClosedLoopNPC:
    npc_id: str
    output_item: str
    max_rate: int
    unit_cost: float
    input_item: str | None = None
    input_ratio: int = 0
    cash: float = 1200.0
    inventory: dict[str, int] = field(default_factory=dict)
    station_inventory: dict[str, int] = field(default_factory=dict)
    ship_capacity: int = 45
    ship_busy_until: int = 0
    launch_ticks: int = 2
    fuel_per_trip: int = 2
    decision_interval: int = 5

    # Closed-loop control states
    utilization: float = 0.8
    price_bias: float = 1.0
    last_listed_qty: int = 0

    def produce(self) -> None:
        rate = int(round(self.max_rate * self.utilization))
        if rate <= 0:
            return
        by_cash = int(self.cash // self.unit_cost)
        qty = min(rate, by_cash)
        if self.input_item and self.input_ratio > 0:
            avail_in = self.inventory.get(self.input_item, 0)
            qty = min(qty, avail_in // self.input_ratio)
            if qty > 0:
                self.inventory[self.input_item] = avail_in - qty * self.input_ratio
        if qty > 0:
            self.cash -= qty * self.unit_cost
            self.inventory[self.output_item] = self.inventory.get(self.output_item, 0) + qty

    def _buy_from_station(
        self,
        item: str,
        want: int,
        station: OrbitalStation,
        npcs: dict[str, "ClosedLoopNPC"],
        planet: "Planet",
    ) -> int:
        bought = 0
        remaining: list[SellOrder] = []
        for order in station.sell_orders.get(item, []):
            if bought >= want:
                remaining.append(order)
                continue
            can_afford = int(self.cash // order.price)
            take = min(want - bought, order.qty, can_afford, station.inventory.get(item, 0))
            if take > 0:
                cost = take * order.price
                tax = cost * planet.tax_rate
                self.cash -= cost
                planet.wealth += tax
                station.inventory[item] -= take
                station.last_trade_price[item] = order.price

                seller = npcs[order.seller_id]
                seller.cash += cost - tax
                seller.station_inventory[item] -= take
                bought += take
                if take < order.qty:
                    remaining.append(SellOrder(order.seller_id, order.qty - take, order.price))
            else:
                remaining.append(order)
        station.sell_orders[item] = remaining
        return bought

    def decide(
        self,
        tick: int,
        station: OrbitalStation,
        in_flight: list[ShipInFlight],
        npcs: dict[str, "ClosedLoopNPC"],
        planet: "Planet",
    ) -> None:
        if tick % self.decision_interval != 0:
            return

        # --- Closed-loop 1: Adjust price_bias based on sell-through ---
        at_station = self.station_inventory.get(self.output_item, 0)
        still_listed = sum(o.qty for o in station.sell_orders[self.output_item] if o.seller_id == self.npc_id)
        if self.last_listed_qty > 0:
            sell_through = 1.0 - (still_listed / self.last_listed_qty)
            if sell_through > 0.8:
                self.price_bias = min(1.25, self.price_bias + 0.03)
            elif sell_through < 0.3:
                self.price_bias = max(0.80, self.price_bias - 0.04)

        # --- Closed-loop 2: Adjust utilization based on profit margin & stock ---
        ref_out = station.reference_price[self.output_item]
        in_cost = (
            station.reference_price[self.input_item] * self.input_ratio
            if self.input_item
            else 0.0
        )
        total_unit_cost = self.unit_cost + in_cost
        margin = (ref_out - total_unit_cost) / max(0.1, total_unit_cost)
        local_stock = self.inventory.get(self.output_item, 0)

        target_util = self.utilization + 0.25 * (margin - 0.15)
        if local_stock > self.max_rate * 8:
            target_util -= 0.2
        self.utilization = max(0.0, min(1.0, target_util))

        # --- Buy fuel if needed ---
        if self.output_item != "fuel" and self.inventory.get("fuel", 0) < 6:
            got_fuel = self._buy_from_station("fuel", 10, station, npcs, planet)
            self.inventory["fuel"] = self.inventory.get("fuel", 0) + got_fuel

        # --- Buy production input if needed ---
        if self.input_item and tick >= self.ship_busy_until:
            in_stock = self.inventory.get(self.input_item, 0)
            if in_stock < 30 and self.inventory.get("fuel", 0) >= self.fuel_per_trip:
                got_in = self._buy_from_station(self.input_item, 35 - in_stock, station, npcs, planet)
                if got_in > 0:
                    self.inventory["fuel"] -= self.fuel_per_trip
                    self.ship_busy_until = tick + self.launch_ticks
                    in_flight.append(
                        ShipInFlight(self.npc_id, "to_npc", self.input_item, got_in, tick + self.launch_ticks)
                    )

        # --- Ship output to station ---
        if tick >= self.ship_busy_until and local_stock >= 15:
            has_fuel = self.output_item == "fuel" or self.inventory.get("fuel", 0) >= self.fuel_per_trip
            if has_fuel:
                send_qty = min(self.ship_capacity, local_stock)
                self.inventory[self.output_item] -= send_qty
                if self.output_item != "fuel":
                    self.inventory["fuel"] -= self.fuel_per_trip
                self.ship_busy_until = tick + self.launch_ticks
                in_flight.append(
                    ShipInFlight(self.npc_id, "to_station", self.output_item, send_qty, tick + self.launch_ticks)
                )

        # --- Post sell orders ---
        unlisted = at_station - still_listed
        if unlisted > 0:
            ask = max(total_unit_cost * 1.05, ref_out * self.price_bias)
            station.post_sell_order(self.npc_id, self.output_item, unlisted, round(ask, 2))
            self.last_listed_qty = still_listed + unlisted
        else:
            self.last_listed_qty = still_listed


@dataclass
class Planet:
    population: float = 1000.0
    wealth: float = 6000.0
    prosperity: float = 1.0
    base_output_per_capita: float = 0.20
    tax_rate: float = 0.10

    def step(self, station: OrbitalStation, npcs: dict[str, ClosedLoopNPC]) -> float:
        self.wealth += self.population * self.base_output_per_capita * self.prosperity

        demands = {
            "food": max(1, int(self.population * 0.01)),
            "steel": max(1, int(self.population * 0.004)),
        }
        sats: list[float] = []

        for item, qty in demands.items():
            inv = station.inventory.get(item, 0)
            ref = station.reference_price.get(item, 10.0)
            scarcity = max(0.0, (100 - inv) / 100.0)
            hunger = max(0.0, 1.2 - self.prosperity)
            max_bid = ref * (1.0 + 1.5 * max(scarcity, hunger))

            bought = 0
            remaining: list[SellOrder] = []
            for order in station.sell_orders.get(item, []):
                if bought >= qty or order.price > max_bid:
                    remaining.append(order)
                    continue
                can_afford = int(self.wealth // order.price)
                take = min(qty - bought, order.qty, can_afford, station.inventory[item])
                if take > 0:
                    cost = take * order.price
                    tax = cost * self.tax_rate
                    self.wealth -= cost
                    self.wealth += tax
                    station.inventory[item] -= take
                    station.last_trade_price[item] = order.price

                    seller = npcs[order.seller_id]
                    seller.cash += cost - tax
                    seller.station_inventory[item] -= take
                    bought += take
                    if take < order.qty:
                        remaining.append(SellOrder(order.seller_id, order.qty - take, order.price))
                else:
                    remaining.append(order)
            station.sell_orders[item] = remaining
            sats.append(bought / qty)

        avg_sat = sum(sats) / len(sats)
        self.prosperity += (avg_sat - 0.8) * 0.05
        self.prosperity = max(0.2, min(2.0, self.prosperity))
        if self.prosperity > 1.0:
            self.population *= 1.0005
        elif self.prosperity < 0.6:
            self.population *= 0.9995
        return avg_sat


def run_simulation(ticks: int = 168) -> None:
    station = OrbitalStation()
    planet = Planet()
    npcs = {
        "NPC-Fuel": ClosedLoopNPC("NPC-Fuel", "fuel", max_rate=6, unit_cost=2.5, inventory={"fuel": 30}),
        "NPC-Farm-1": ClosedLoopNPC("NPC-Farm-1", "food", max_rate=7, unit_cost=4.0, inventory={"food": 30, "fuel": 10}),
        "NPC-Farm-2": ClosedLoopNPC("NPC-Farm-2", "food", max_rate=6, unit_cost=4.5, inventory={"food": 25, "fuel": 10}),
        "NPC-Mine": ClosedLoopNPC("NPC-Mine", "iron", max_rate=12, unit_cost=3.0, inventory={"iron": 40, "fuel": 10}),
        "NPC-Smelter": ClosedLoopNPC(
            "NPC-Smelter", "steel", max_rate=5, unit_cost=4.0, input_item="iron", input_ratio=2,
            inventory={"iron": 30, "steel": 15, "fuel": 10},
        ),
    }
    in_flight: list[ShipInFlight] = []

    print(f"{'Tick':>4} | {'Pop':>6} | {'Prosp':>5} | {'Sat':>4} | {'FuelP':>5} | {'FoodP':>5} | {'IronP':>5} | {'SteelP':>6}")
    print("-" * 62)

    for t in range(1, ticks + 1):
        for npc in npcs.values():
            npc.produce()

        still_flying: list[ShipInFlight] = []
        for flight in in_flight:
            if flight.arrival_tick <= t:
                if flight.direction == "to_station":
                    station.inventory[flight.item] = station.inventory.get(flight.item, 0) + flight.qty
                    npcs[flight.owner_id].station_inventory[flight.item] = (
                        npcs[flight.owner_id].station_inventory.get(flight.item, 0) + flight.qty
                    )
                else:
                    npcs[flight.owner_id].inventory[flight.item] = (
                        npcs[flight.owner_id].inventory.get(flight.item, 0) + flight.qty
                    )
            else:
                still_flying.append(flight)
        in_flight = still_flying

        for npc in npcs.values():
            npc.decide(t, station, in_flight, npcs, planet)

        sat = planet.step(station, npcs)
        station.update_reference_prices()

        if t == 1 or t % 24 == 0:
            p = station.reference_price
            print(
                f"{t:4d} | {planet.population:6.1f} | {planet.prosperity:5.2f} | {sat:4.2f} | "
                f"{p['fuel']:5.2f} | {p['food']:5.2f} | {p['iron']:5.2f} | {p['steel']:6.2f}"
            )

    print("\n--- Final NPC States (Day 7) ---")
    for npc in npcs.values():
        print(
            f"{npc.npc_id:<12} | Cash: {npc.cash:7.1f} | Util: {npc.utilization:4.2f} | "
            f"PriceBias: {npc.price_bias:4.2f}"
        )


if __name__ == "__main__":
    run_simulation()

"""Experiment 2: Iron -> Steel production chain on a single planet (168 Ticks = 7 Days)."""

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
    inventory: dict[str, int] = field(default_factory=lambda: {"iron": 60, "steel": 40})
    reference_price: dict[str, float] = field(default_factory=lambda: {"iron": 8.0, "steel": 25.0})
    sell_orders: dict[str, list[SellOrder]] = field(default_factory=lambda: {"iron": [], "steel": []})
    target_inventory: dict[str, int] = field(default_factory=lambda: {"iron": 120, "steel": 80})
    last_trade_price: dict[str, float] = field(default_factory=lambda: {"iron": 8.0, "steel": 25.0})

    def post_sell_order(self, seller_id: str, item: str, qty: int, price: float) -> None:
        if qty <= 0:
            return
        self.sell_orders.setdefault(item, []).append(SellOrder(seller_id, qty, price))
        self.sell_orders[item].sort(key=lambda o: o.price)

    def update_reference_price(self, item: str) -> None:
        inv = self.inventory.get(item, 0)
        target = self.target_inventory.get(item, 100)
        ref = self.reference_price.get(item, 10.0)
        last_p = self.last_trade_price.get(item, ref)

        imbalance = (target - inv) / max(1, target)
        new_ref = ref * 0.8 + last_p * 0.2
        new_ref *= 1.0 + 0.05 * max(-0.5, min(0.5, imbalance))
        self.reference_price[item] = max(1.0, new_ref)


@dataclass
class NPCMine:
    npc_id: str = "NPC-Mine"
    cash: float = 1000.0
    inventory: dict[str, int] = field(default_factory=lambda: {"iron": 40})
    station_inventory: dict[str, int] = field(default_factory=lambda: {"iron": 0})
    production_rate: int = 16
    production_cost: float = 3.0
    ship_capacity: int = 50
    ship_busy_until: int = 0
    decision_interval: int = 5
    launch_ticks: int = 2
    launch_cost: float = 5.0

    def produce(self) -> None:
        if self.inventory["iron"] >= 120:
            return
        affordable = int(self.cash // self.production_cost)
        qty = min(self.production_rate, affordable)
        if qty > 0:
            self.cash -= qty * self.production_cost
            self.inventory["iron"] += qty

    def decide(self, tick: int, station: OrbitalStation, in_flight: list[ShipInFlight]) -> None:
        if tick % self.decision_interval != 0:
            return
        if tick >= self.ship_busy_until and self.inventory["iron"] >= 30 and self.cash >= self.launch_cost:
            send_qty = min(self.ship_capacity, self.inventory["iron"])
            self.inventory["iron"] -= send_qty
            self.cash -= self.launch_cost
            self.ship_busy_until = tick + self.launch_ticks
            in_flight.append(ShipInFlight(self.npc_id, "to_station", "iron", send_qty, tick + self.launch_ticks))

        at_station = self.station_inventory.get("iron", 0)
        listed = sum(o.qty for o in station.sell_orders["iron"] if o.seller_id == self.npc_id)
        unlisted = at_station - listed
        if unlisted > 0:
            ref = station.reference_price["iron"]
            excess = max(0.0, (at_station - 40) / 100.0)
            ask_price = max(self.production_cost * 1.15, ref * (1.0 - 0.1 * min(0.5, excess)))
            station.post_sell_order(self.npc_id, "iron", unlisted, round(ask_price, 2))


@dataclass
class NPCSmelter:
    npc_id: str = "NPC-Smelter"
    cash: float = 1500.0
    inventory: dict[str, int] = field(default_factory=lambda: {"iron": 30, "steel": 10})
    station_inventory: dict[str, int] = field(default_factory=lambda: {"steel": 0})
    iron_per_steel: int = 2
    max_steel_per_tick: int = 6
    smelt_cost: float = 4.0
    ship_capacity: int = 40
    ship_busy_until: int = 0
    decision_interval: int = 5
    launch_ticks: int = 2
    launch_cost: float = 5.0

    def produce(self) -> None:
        if self.inventory["steel"] >= 60:
            return
        by_iron = self.inventory["iron"] // self.iron_per_steel
        by_cash = int(self.cash // self.smelt_cost)
        qty = min(self.max_steel_per_tick, by_iron, by_cash)
        if qty > 0:
            self.inventory["iron"] -= qty * self.iron_per_steel
            self.cash -= qty * self.smelt_cost
            self.inventory["steel"] += qty

    def decide(
        self,
        tick: int,
        station: OrbitalStation,
        in_flight: list[ShipInFlight],
        npcs: dict[str, object],
        planet: "Planet",
    ) -> None:
        if tick % self.decision_interval != 0:
            return

        # 1. Buy iron from station if local stock is low
        if self.inventory["iron"] < 40 and tick >= self.ship_busy_until:
            want = 40 - self.inventory["iron"]
            bought = 0
            remaining: list[SellOrder] = []
            for order in station.sell_orders["iron"]:
                if bought >= want:
                    remaining.append(order)
                    continue
                can_afford = int((self.cash - self.launch_cost) // order.price)
                take = min(want - bought, order.qty, max(0, can_afford), station.inventory["iron"])
                if take > 0:
                    cost = take * order.price
                    tax = cost * planet.tax_rate
                    self.cash -= cost
                    planet.wealth += tax
                    station.inventory["iron"] -= take
                    station.last_trade_price["iron"] = order.price

                    seller = npcs[order.seller_id]
                    seller.cash += cost - tax
                    seller.station_inventory["iron"] -= take
                    bought += take
                    if take < order.qty:
                        remaining.append(SellOrder(order.seller_id, order.qty - take, order.price))
                else:
                    remaining.append(order)
            station.sell_orders["iron"] = remaining

            if bought > 0:
                self.cash -= self.launch_cost
                self.ship_busy_until = tick + self.launch_ticks
                in_flight.append(ShipInFlight(self.npc_id, "to_npc", "iron", bought, tick + self.launch_ticks))

        # 2. Ship steel to station if ship is idle
        if tick >= self.ship_busy_until and self.inventory["steel"] >= 15 and self.cash >= self.launch_cost:
            send_qty = min(self.ship_capacity, self.inventory["steel"])
            self.inventory["steel"] -= send_qty
            self.cash -= self.launch_cost
            self.ship_busy_until = tick + self.launch_ticks
            in_flight.append(ShipInFlight(self.npc_id, "to_station", "steel", send_qty, tick + self.launch_ticks))

        # 3. Post sell orders for steel at station
        at_station = self.station_inventory.get("steel", 0)
        listed = sum(o.qty for o in station.sell_orders["steel"] if o.seller_id == self.npc_id)
        unlisted = at_station - listed
        if unlisted > 0:
            ref = station.reference_price["steel"]
            min_price = (station.reference_price["iron"] * self.iron_per_steel + self.smelt_cost) * 1.1
            excess = max(0.0, (at_station - 20) / 60.0)
            ask_price = max(min_price, ref * (1.0 - 0.1 * min(0.5, excess)))
            station.post_sell_order(self.npc_id, "steel", unlisted, round(ask_price, 2))


@dataclass
class Planet:
    population: float = 1000.0
    wealth: float = 5000.0
    prosperity: float = 1.0
    base_output_per_capita: float = 0.12
    tax_rate: float = 0.10

    def step(self, station: OrbitalStation, npcs: dict[str, object]) -> float:
        income = self.population * self.base_output_per_capita * self.prosperity
        self.wealth += income

        demand_qty = max(1, int(self.population * 0.004))  # ~4 steel/tick
        inv = station.inventory.get("steel", 0)
        ref_price = station.reference_price.get("steel", 25.0)

        scarcity = max(0.0, (80 - inv) / 80.0)
        hunger = max(0.0, 1.2 - self.prosperity)
        max_bid = ref_price * (1.0 + 1.5 * max(scarcity, hunger))

        bought = 0
        remaining: list[SellOrder] = []
        for order in station.sell_orders.get("steel", []):
            if bought >= demand_qty or order.price > max_bid:
                remaining.append(order)
                continue
            can_afford = int(self.wealth // order.price)
            take = min(demand_qty - bought, order.qty, can_afford, station.inventory["steel"])
            if take > 0:
                cost = take * order.price
                tax = cost * self.tax_rate
                self.wealth -= cost
                self.wealth += tax
                station.inventory["steel"] -= take
                station.last_trade_price["steel"] = order.price

                seller = npcs[order.seller_id]
                seller.cash += cost - tax
                seller.station_inventory["steel"] -= take
                bought += take
                if take < order.qty:
                    remaining.append(SellOrder(order.seller_id, order.qty - take, order.price))
            else:
                remaining.append(order)

        station.sell_orders["steel"] = remaining

        satisfaction = bought / demand_qty if demand_qty > 0 else 1.0
        self.prosperity += (satisfaction - 0.8) * 0.05
        self.prosperity = max(0.2, min(2.0, self.prosperity))

        if self.prosperity > 1.0:
            self.population *= 1.0005
        elif self.prosperity < 0.6:
            self.population *= 0.9995

        return satisfaction


def run_simulation(ticks: int = 168) -> None:
    station = OrbitalStation()
    planet = Planet()
    mine = NPCMine()
    smelter = NPCSmelter()
    npcs: dict[str, object] = {mine.npc_id: mine, smelter.npc_id: smelter}
    in_flight: list[ShipInFlight] = []

    print(
        f"{'Tick':>4} | {'Pop':>6} | {'Prosp':>5} | {'Sat':>4} | "
        f"{'IronP':>5} | {'SteelP':>6} | {'Mine$':>7} | {'Smelt$':>7}"
    )
    print("-" * 66)

    for t in range(1, ticks + 1):
        mine.produce()
        smelter.produce()

        still_flying: list[ShipInFlight] = []
        for flight in in_flight:
            if flight.arrival_tick <= t:
                if flight.direction == "to_station":
                    station.inventory[flight.item] = station.inventory.get(flight.item, 0) + flight.qty
                    npcs[flight.owner_id].station_inventory[flight.item] += flight.qty
                else:
                    npcs[flight.owner_id].inventory[flight.item] += flight.qty
            else:
                still_flying.append(flight)
        in_flight = still_flying

        mine.decide(t, station, in_flight)
        smelter.decide(t, station, in_flight, npcs, planet)

        sat = planet.step(station, npcs)
        station.update_reference_price("iron")
        station.update_reference_price("steel")

        if t == 1 or t % 24 == 0:
            print(
                f"{t:4d} | {planet.population:6.1f} | {planet.prosperity:5.2f} | {sat:4.2f} | "
                f"{station.reference_price['iron']:5.2f} | {station.reference_price['steel']:6.2f} | "
                f"{mine.cash:7.1f} | {smelter.cash:7.1f}"
            )


if __name__ == "__main__":
    run_simulation()

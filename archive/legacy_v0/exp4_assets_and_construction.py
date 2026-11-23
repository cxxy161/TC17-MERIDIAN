"""Experiment 4: 5 Assets, 2-Step Chains, Processing Cycles & Building Construction (360 Ticks = 15 Days)."""

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
class BuildingSpec:
    kind: str
    output_item: str
    output_qty: int
    cycle_ticks: int
    cycle_cost: float
    input_item: str | None = None
    input_qty: int = 0


SPECS: dict[str, BuildingSpec] = {
    "OilWell": BuildingSpec("OilWell", "crude", 10, cycle_ticks=2, cycle_cost=15.0),
    "Refinery": BuildingSpec("Refinery", "fuel", 8, cycle_ticks=3, cycle_cost=12.0, input_item="crude", input_qty=12),
    "IronMine": BuildingSpec("IronMine", "iron", 12, cycle_ticks=2, cycle_cost=18.0),
    "Smelter": BuildingSpec("Smelter", "steel", 6, cycle_ticks=4, cycle_cost=16.0, input_item="iron", input_qty=12),
    "MatFactory": BuildingSpec("MatFactory", "mat", 4, cycle_ticks=4, cycle_cost=16.0, input_item="steel", input_qty=8),
    "Farm": BuildingSpec("Farm", "food", 15, cycle_ticks=3, cycle_cost=30.0),
}


@dataclass
class Building:
    spec: BuildingSpec
    progress: int = 0
    active_batch: bool = False


@dataclass
class ConstructionJob:
    kind: str
    finish_tick: int


@dataclass
class OrbitalStation:
    inventory: dict[str, int] = field(
        default_factory=lambda: {"crude": 60, "fuel": 100, "iron": 80, "steel": 50, "mat": 30, "food": 120}
    )
    reference_price: dict[str, float] = field(
        default_factory=lambda: {"crude": 3.0, "fuel": 8.0, "iron": 3.5, "steel": 14.0, "mat": 36.0, "food": 6.0}
    )
    sell_orders: dict[str, list[SellOrder]] = field(
        default_factory=lambda: {"crude": [], "fuel": [], "iron": [], "steel": [], "mat": [], "food": []}
    )
    target_inventory: dict[str, int] = field(
        default_factory=lambda: {"crude": 80, "fuel": 120, "iron": 100, "steel": 80, "mat": 40, "food": 150}
    )
    last_trade_price: dict[str, float] = field(
        default_factory=lambda: {"crude": 3.0, "fuel": 8.0, "iron": 3.5, "steel": 14.0, "mat": 36.0, "food": 6.0}
    )

    def post_sell_order(self, seller_id: str, item: str, qty: int, price: float) -> None:
        if qty <= 0:
            return
        self.sell_orders.setdefault(item, []).append(SellOrder(seller_id, qty, price))
        self.sell_orders[item].sort(key=lambda o: o.price)

    def update_reference_prices(self) -> None:
        for item, ref in self.reference_price.items():
            inv = self.inventory.get(item, 0)
            target = self.target_inventory.get(item, 80)
            last_p = self.last_trade_price.get(item, ref)
            imbalance = (target - inv) / max(1, target)
            new_ref = ref * 0.8 + last_p * 0.2
            new_ref *= 1.0 + 0.05 * max(-0.5, min(0.5, imbalance))
            self.reference_price[item] = max(1.0, new_ref)


@dataclass
class AssetNPC:
    npc_id: str
    primary_kind: str
    cash: float = 1500.0
    inventory: dict[str, int] = field(default_factory=dict)
    station_inventory: dict[str, int] = field(default_factory=dict)
    plot_capacity: int = 5
    buildings: list[Building] = field(default_factory=list)
    constructions: list[ConstructionJob] = field(default_factory=list)

    ship_capacity: int = 45
    ship_busy_until: int = 0
    launch_ticks: int = 2
    fuel_per_trip: int = 2
    decision_interval: int = 5

    utilization: float = 0.85
    price_bias: float = 1.0
    last_listed_qty: int = 0

    def __post_init__(self) -> None:
        if not self.buildings:
            self.buildings.append(Building(SPECS[self.primary_kind]))

    def used_slots(self) -> int:
        return len(self.buildings) + len(self.constructions)

    def step_production_and_build(self, tick: int) -> int:
        built_count = 0
        # 1. Finish constructions
        still_building: list[ConstructionJob] = []
        for job in self.constructions:
            if job.finish_tick <= tick:
                self.buildings.append(Building(SPECS[job.kind]))
                built_count += 1
            else:
                still_building.append(job)
        self.constructions = still_building

        # 2. Step each building's processing cycle
        for b in self.buildings:
            spec = b.spec
            if b.active_batch:
                b.progress += 1
                if b.progress >= spec.cycle_ticks:
                    self.inventory[spec.output_item] = self.inventory.get(spec.output_item, 0) + spec.output_qty
                    b.active_batch = False
                    b.progress = 0
            if not b.active_batch and self.utilization > 0.2:
                if self.cash >= spec.cycle_cost:
                    has_in = (
                        spec.input_item is None
                        or self.inventory.get(spec.input_item, 0) >= spec.input_qty
                    )
                    if has_in:
                        self.cash -= spec.cycle_cost
                        if spec.input_item:
                            self.inventory[spec.input_item] -= spec.input_qty
                        b.active_batch = True
                        b.progress = 0
        return built_count

    def _buy_from_station(
        self,
        item: str,
        want: int,
        station: OrbitalStation,
        npcs: dict[str, "AssetNPC"],
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
        npcs: dict[str, "AssetNPC"],
        planet: "Planet",
    ) -> None:
        if tick % self.decision_interval != 0:
            return

        spec = SPECS[self.primary_kind]
        out_item = spec.output_item

        # 1. Price & utilization closed-loop
        at_station = self.station_inventory.get(out_item, 0)
        still_listed = sum(o.qty for o in station.sell_orders[out_item] if o.seller_id == self.npc_id)
        if self.last_listed_qty > 0:
            sell_through = 1.0 - (still_listed / self.last_listed_qty)
            if sell_through > 0.8:
                self.price_bias = min(1.25, self.price_bias + 0.03)
            elif sell_through < 0.3:
                self.price_bias = max(0.80, self.price_bias - 0.04)

        ref_out = station.reference_price[out_item]
        in_cost = (
            (station.reference_price[spec.input_item] * spec.input_qty) / spec.output_qty
            if spec.input_item
            else 0.0
        )
        unit_cost = (spec.cycle_cost / spec.output_qty) + in_cost
        margin = (ref_out - unit_cost) / max(0.1, unit_cost)
        local_stock = self.inventory.get(out_item, 0)

        target_util = self.utilization + 0.25 * (margin - 0.15)
        if local_stock > spec.output_qty * 6:
            target_util -= 0.25
        self.utilization = max(0.0, min(1.0, target_util))

        # 2. Buy fuel if needed
        if out_item != "fuel" and self.inventory.get("fuel", 0) < 6:
            got_fuel = self._buy_from_station("fuel", 10, station, npcs, planet)
            self.inventory["fuel"] = self.inventory.get("fuel", 0) + got_fuel

        # 3. Expansion: build a new building if profitable & slots available
        mat_needed = 15
        build_cash_cost = 100.0
        if (
            self.used_slots() < self.plot_capacity
            and self.utilization > 0.75
            and margin > 0.20
            and self.cash > build_cash_cost + mat_needed * station.reference_price["mat"] + 200
        ):
            if self.inventory.get("mat", 0) < mat_needed:
                got_mat = self._buy_from_station("mat", mat_needed - self.inventory.get("mat", 0), station, npcs, planet)
                self.inventory["mat"] = self.inventory.get("mat", 0) + got_mat
            if self.inventory.get("mat", 0) >= mat_needed and self.cash >= build_cash_cost:
                self.inventory["mat"] -= mat_needed
                self.cash -= build_cash_cost
                self.constructions.append(ConstructionJob(self.primary_kind, tick + 12))

        # 4. Buy production input
        if spec.input_item and tick >= self.ship_busy_until:
            in_stock = self.inventory.get(spec.input_item, 0)
            if in_stock < spec.input_qty * 3 and self.inventory.get("fuel", 0) >= self.fuel_per_trip:
                got_in = self._buy_from_station(spec.input_item, spec.input_qty * 4 - in_stock, station, npcs, planet)
                if got_in > 0:
                    self.inventory["fuel"] -= self.fuel_per_trip
                    self.ship_busy_until = tick + self.launch_ticks
                    in_flight.append(
                        ShipInFlight(self.npc_id, "to_npc", spec.input_item, got_in, tick + self.launch_ticks)
                    )

        # 5. Ship output to station
        if tick >= self.ship_busy_until and local_stock >= spec.output_qty:
            has_fuel = out_item == "fuel" or self.inventory.get("fuel", 0) >= self.fuel_per_trip
            if has_fuel:
                send_qty = min(self.ship_capacity, local_stock)
                self.inventory[out_item] -= send_qty
                if out_item != "fuel":
                    self.inventory["fuel"] -= self.fuel_per_trip
                self.ship_busy_until = tick + self.launch_ticks
                in_flight.append(
                    ShipInFlight(self.npc_id, "to_station", out_item, send_qty, tick + self.launch_ticks)
                )

        # 6. Post sell orders
        unlisted = at_station - still_listed
        if unlisted > 0:
            ask = max(unit_cost * 1.05, ref_out * self.price_bias)
            station.post_sell_order(self.npc_id, out_item, unlisted, round(ask, 2))
            self.last_listed_qty = still_listed + unlisted
        else:
            self.last_listed_qty = still_listed


@dataclass
class Planet:
    population: float = 1000.0
    wealth: float = 8000.0
    prosperity: float = 1.0
    base_output_per_capita: float = 0.25
    tax_rate: float = 0.10

    def step(self, station: OrbitalStation, npcs: dict[str, AssetNPC]) -> float:
        self.wealth += self.population * self.base_output_per_capita * self.prosperity
        demands = {
            "food": max(1, int(self.population * 0.008)),
            "steel": max(1, int(self.population * 0.003)),
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
        return avg_sat


def run_simulation(ticks: int = 360) -> None:
    station = OrbitalStation()
    planet = Planet()
    npcs = {
        "NPC-OilWell": AssetNPC("NPC-OilWell", "OilWell", inventory={"crude": 20, "fuel": 10}),
        "NPC-Refinery": AssetNPC("NPC-Refinery", "Refinery", inventory={"crude": 24, "fuel": 10}),
        "NPC-Mine": AssetNPC("NPC-Mine", "IronMine", inventory={"iron": 24, "fuel": 10}),
        "NPC-Smelter": AssetNPC("NPC-Smelter", "Smelter", inventory={"iron": 24, "steel": 10, "fuel": 10}),
        "NPC-MatFact": AssetNPC("NPC-MatFact", "MatFactory", inventory={"steel": 16, "mat": 10, "fuel": 10}),
        "NPC-Farm": AssetNPC("NPC-Farm", "Farm", inventory={"food": 30, "fuel": 10}),
    }
    in_flight: list[ShipInFlight] = []
    total_built = 0

    print(f"{'Tick':>4} | {'Prosp':>5} | {'Sat':>4} | {'FuelP':>5} | {'FoodP':>5} | {'SteelP':>6} | {'MatP':>5} | {'Built':>5}")
    print("-" * 60)

    for t in range(1, ticks + 1):
        for npc in npcs.values():
            total_built += npc.step_production_and_build(t)

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

        if t == 1 or t % 48 == 0:
            p = station.reference_price
            print(
                f"{t:4d} | {planet.prosperity:5.2f} | {sat:4.2f} | "
                f"{p['fuel']:5.2f} | {p['food']:5.2f} | {p['steel']:6.2f} | {p['mat']:5.2f} | {total_built:5d}"
            )

    print("\n--- Final NPC Assets (Day 15) ---")
    for npc in npcs.values():
        print(
            f"{npc.npc_id:<13} | Cash: {npc.cash:7.1f} | Buildings: {len(npc.buildings)}/5 | Util: {npc.utilization:4.2f}"
        )


if __name__ == "__main__":
    run_simulation()

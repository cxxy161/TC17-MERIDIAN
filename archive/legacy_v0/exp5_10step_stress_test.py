"""Experiment 5: 10-Step Fuel & Steel Chains, Zero Intermediate Seed Inventory, Self-Selecting NPCs."""

import random
from dataclasses import dataclass, field


@dataclass
class SellOrder:
    seller_id: str
    qty: int
    price: float


@dataclass
class ShipInFlight:
    owner_id: str
    direction: str
    item: str
    qty: int
    arrival_tick: int


@dataclass
class Recipe:
    kind: str
    output_item: str
    output_qty: int
    cycle_ticks: int
    cycle_cost: float
    input_item: str | None = None
    input_qty: int = 0


def build_recipes() -> dict[str, Recipe]:
    recipes: dict[str, Recipe] = {}
    # 10-step Steel chain: iron_1 -> iron_2 -> ... -> iron_10
    for i in range(1, 11):
        kind = f"IronStep{i}"
        out_item = f"iron_{i}"
        in_item = f"iron_{i-1}" if i > 1 else None
        recipes[kind] = Recipe(
            kind=kind,
            output_item=out_item,
            output_qty=10,
            cycle_ticks=2,
            cycle_cost=10.0,
            input_item=in_item,
            input_qty=10 if in_item else 0,
        )
    # 10-step Fuel chain: fuel_1 -> fuel_2 -> ... -> fuel_10
    for i in range(1, 11):
        kind = f"FuelStep{i}"
        out_item = f"fuel_{i}"
        in_item = f"fuel_{i-1}" if i > 1 else None
        recipes[kind] = Recipe(
            kind=kind,
            output_item=out_item,
            output_qty=10,
            cycle_ticks=2,
            cycle_cost=8.0,
            input_item=in_item,
            input_qty=10 if in_item else 0,
        )
    recipes["FoodFarm"] = Recipe("FoodFarm", "food", 15, cycle_ticks=3, cycle_cost=25.0)
    recipes["MatFactory"] = Recipe("MatFactory", "mat", 5, cycle_ticks=3, cycle_cost=15.0, input_item="iron_10", input_qty=10)
    return recipes


RECIPES = build_recipes()


@dataclass
class Building:
    recipe: Recipe
    progress: int = 0
    active_batch: bool = False
    utilization: float = 1.0


@dataclass
class ConstructionJob:
    kind: str
    finish_tick: int


@dataclass
class OrbitalStation:
    inventory: dict[str, int] = field(default_factory=dict)
    reference_price: dict[str, float] = field(default_factory=dict)
    sell_orders: dict[str, list[SellOrder]] = field(default_factory=dict)
    last_trade_price: dict[str, float] = field(default_factory=dict)

    def __post_init__(self) -> None:
        # Seed inventory for all items so 10-step chains can ignite at Tick 1
        for r in RECIPES.values():
            self.inventory.setdefault(r.output_item, 40)
            self.sell_orders.setdefault(r.output_item, [])
            # Initial reference price scales with step depth
            if r.output_item.startswith("iron_"):
                step = int(r.output_item.split("_")[1])
                p = 2.0 * step
            elif r.output_item.startswith("fuel_"):
                step = int(r.output_item.split("_")[1])
                p = 1.8 * step
            elif r.output_item == "mat":
                p = 45.0
            else:
                p = 6.0
            self.reference_price.setdefault(r.output_item, p)
            self.last_trade_price.setdefault(r.output_item, p)
            self.sell_orders[r.output_item].append(SellOrder("SYSTEM", 40, p))
        self.inventory["mat"] = 60
        self.sell_orders["mat"] = [SellOrder("SYSTEM", 60, 45.0)]

    def post_sell_order(self, seller_id: str, item: str, qty: int, price: float) -> None:
        if qty <= 0:
            return
        self.sell_orders[item].append(SellOrder(seller_id, qty, price))
        self.sell_orders[item].sort(key=lambda o: o.price)

    def update_reference_prices(self) -> None:
        for item, ref in self.reference_price.items():
            inv = self.inventory.get(item, 0)
            target = 60
            last_p = self.last_trade_price.get(item, ref)
            imbalance = (target - inv) / target
            new_ref = ref * 0.85 + last_p * 0.15
            new_ref *= 1.0 + 0.04 * max(-0.5, min(0.5, imbalance))
            self.reference_price[item] = max(1.0, new_ref)


@dataclass
class SelfSelectingNPC:
    npc_id: str
    initial_kind: str
    cash: float = 2000.0
    inventory: dict[str, int] = field(default_factory=lambda: {"fuel_10": 12})
    station_inventory: dict[str, int] = field(default_factory=dict)
    plot_capacity: int = 5
    buildings: list[Building] = field(default_factory=list)
    constructions: list[ConstructionJob] = field(default_factory=list)
    ship_busy_until: int = 0
    launch_ticks: int = 2
    fuel_per_trip: int = 1
    decision_interval: int = 5

    def __post_init__(self) -> None:
        if not self.buildings:
            self.buildings.append(Building(RECIPES[self.initial_kind]))

    def used_slots(self) -> int:
        return len(self.buildings) + len(self.constructions)

    def step_production_and_build(self, tick: int, logs: list[str]) -> None:
        still_building: list[ConstructionJob] = []
        for job in self.constructions:
            if job.finish_tick <= tick:
                self.buildings.append(Building(RECIPES[job.kind]))
                logs.append(f"[T{tick:03d}] {self.npc_id} 建成 {job.kind} (建筑数 {len(self.buildings)}/5)")
            else:
                still_building.append(job)
        self.constructions = still_building

        for b in self.buildings:
            r = b.recipe
            if b.active_batch:
                b.progress += 1
                if b.progress >= r.cycle_ticks:
                    self.inventory[r.output_item] = self.inventory.get(r.output_item, 0) + r.output_qty
                    b.active_batch = False
                    b.progress = 0
            if not b.active_batch and b.utilization > 0.2:
                if self.cash >= r.cycle_cost:
                    has_in = r.input_item is None or self.inventory.get(r.input_item, 0) >= r.input_qty
                    if has_in:
                        self.cash -= r.cycle_cost
                        if r.input_item:
                            self.inventory[r.input_item] -= r.input_qty
                        b.active_batch = True
                        b.progress = 0

    def _buy_from_station(
        self,
        item: str,
        want: int,
        station: OrbitalStation,
        npcs: dict[str, "SelfSelectingNPC"],
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
                if order.seller_id != "SYSTEM":
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

    def _recipe_margin(self, r: Recipe, station: OrbitalStation) -> float:
        ref_out = station.reference_price[r.output_item]
        in_cost = (station.reference_price[r.input_item] * r.input_qty / r.output_qty) if r.input_item else 0.0
        unit_cost = (r.cycle_cost / r.output_qty) + in_cost
        return (ref_out - unit_cost) / max(0.1, unit_cost)

    def decide(
        self,
        tick: int,
        station: OrbitalStation,
        in_flight: list[ShipInFlight],
        npcs: dict[str, "SelfSelectingNPC"],
        planet: "Planet",
        logs: list[str],
    ) -> None:
        if tick % self.decision_interval != 0:
            return

        # 1. Self-regulate each building's utilization
        for b in self.buildings:
            margin = self._recipe_margin(b.recipe, station)
            local_stock = self.inventory.get(b.recipe.output_item, 0)
            target_u = b.utilization + 0.25 * (margin - 0.10)
            if local_stock > b.recipe.output_qty * 5:
                target_u -= 0.3
            b.utilization = max(0.0, min(1.0, target_u))

        # 2. Self-select: pick a high-margin recipe with randomness to avoid herding
        if self.used_slots() < self.plot_capacity and self.cash > 600:
            profitable = [r for r in RECIPES.values() if self._recipe_margin(r, station) > 0.15]
            if profitable and station.inventory.get("mat", 0) >= 10:
                best_r = max(profitable, key=lambda r: self._recipe_margin(r, station) * random.uniform(0.4, 1.6))
                if self.inventory.get("mat", 0) < 10:
                    got = self._buy_from_station("mat", 10 - self.inventory.get("mat", 0), station, npcs, planet)
                    self.inventory["mat"] = self.inventory.get("mat", 0) + got
                if self.inventory.get("mat", 0) >= 10 and self.cash >= 100:
                    self.inventory["mat"] -= 10
                    self.cash -= 100
                    self.constructions.append(ConstructionJob(best_r.kind, tick + 10))
                    logs.append(f"[T{tick:03d}] {self.npc_id} 自选扩建 -> {best_r.kind} (预期利润率 {self._recipe_margin(best_r, station):.0%})")

        # 3. Buy fuel_10 if low
        if self.inventory.get("fuel_10", 0) < 4:
            got_f = self._buy_from_station("fuel_10", 8, station, npcs, planet)
            self.inventory["fuel_10"] = self.inventory.get("fuel_10", 0) + got_f

        # 4. Buy inputs for buildings
        if tick >= self.ship_busy_until and self.inventory.get("fuel_10", 0) >= self.fuel_per_trip:
            for b in self.buildings:
                in_item = b.recipe.input_item
                if in_item and self.inventory.get(in_item, 0) < b.recipe.input_qty * 2:
                    got_in = self._buy_from_station(in_item, b.recipe.input_qty * 3, station, npcs, planet)
                    if got_in > 0:
                        self.inventory["fuel_10"] -= self.fuel_per_trip
                        self.ship_busy_until = tick + self.launch_ticks
                        in_flight.append(ShipInFlight(self.npc_id, "to_npc", in_item, got_in, tick + self.launch_ticks))
                        break

        # 5. Ship outputs to station
        if tick >= self.ship_busy_until and self.inventory.get("fuel_10", 0) >= self.fuel_per_trip:
            for b in self.buildings:
                out_item = b.recipe.output_item
                stock = self.inventory.get(out_item, 0)
                if stock >= b.recipe.output_qty:
                    send_qty = min(40, stock)
                    self.inventory[out_item] -= send_qty
                    self.inventory["fuel_10"] -= self.fuel_per_trip
                    self.ship_busy_until = tick + self.launch_ticks
                    in_flight.append(ShipInFlight(self.npc_id, "to_station", out_item, send_qty, tick + self.launch_ticks))
                    break

        # 6. Post sell orders
        for b in self.buildings:
            out_item = b.recipe.output_item
            at_st = self.station_inventory.get(out_item, 0)
            listed = sum(o.qty for o in station.sell_orders[out_item] if o.seller_id == self.npc_id)
            unlisted = at_st - listed
            if unlisted > 0:
                ref = station.reference_price[out_item]
                in_c = (station.reference_price[b.recipe.input_item] * b.recipe.input_qty / b.recipe.output_qty) if b.recipe.input_item else 0.0
                unit_c = (b.recipe.cycle_cost / b.recipe.output_qty) + in_c
                ask = max(unit_c * 1.05, ref * 0.95)
                station.post_sell_order(self.npc_id, out_item, unlisted, round(ask, 2))


@dataclass
class Planet:
    population: float = 1000.0
    wealth: float = 10000.0
    prosperity: float = 1.0
    base_output_per_capita: float = 0.35
    tax_rate: float = 0.10

    def step(self, station: OrbitalStation, npcs: dict[str, SelfSelectingNPC]) -> float:
        self.wealth += self.population * self.base_output_per_capita * self.prosperity
        demands = {"food": 8, "iron_10": 3}
        sats: list[float] = []
        for item, qty in demands.items():
            ref = station.reference_price[item]
            max_bid = ref * (1.0 + 1.5 * max(0.0, 1.2 - self.prosperity))
            bought = 0
            remaining: list[SellOrder] = []
            for order in station.sell_orders.get(item, []):
                if bought >= qty or order.price > max_bid:
                    remaining.append(order)
                    continue
                can_afford = int(self.wealth // order.price)
                take = min(qty - bought, order.qty, can_afford, station.inventory.get(item, 0))
                if take > 0:
                    cost = take * order.price
                    tax = cost * self.tax_rate
                    self.wealth -= cost - tax
                    station.inventory[item] -= take
                    station.last_trade_price[item] = order.price
                    if order.seller_id != "SYSTEM":
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
        self.prosperity = max(0.2, min(2.0, self.prosperity + (avg_sat - 0.8) * 0.05))
        return avg_sat


def run_simulation(ticks: int = 720) -> None:
    random.seed(42)
    station = OrbitalStation()
    planet = Planet()
    # 12 NPCs: start with basic steps + food + mat, let them self-select the rest!
    init_kinds = [
        "IronStep1", "IronStep2", "IronStep3", "IronStep4",
        "FuelStep1", "FuelStep2", "FuelStep3", "FuelStep4",
        "FoodFarm", "MatFactory", "IronStep5", "FuelStep5",
    ]
    npcs = {f"NPC-{i+1}": SelfSelectingNPC(f"NPC-{i+1}", k) for i, k in enumerate(init_kinds)}
    in_flight: list[ShipInFlight] = []
    logs: list[str] = []
    seen_items: set[str] = set()

    print(f"{'Tick':>4} | {'Prosp':>5} | {'Sat':>4} | {'FoodP':>5} | {'Iron10P':>7} | {'Fuel10P':>7} | {'ActiveItems':>11}")
    print("-" * 64)

    for t in range(1, ticks + 1):
        for npc in npcs.values():
            npc.step_production_and_build(t, logs)

        still_flying: list[ShipInFlight] = []
        for flight in in_flight:
            if flight.arrival_tick <= t:
                if flight.direction == "to_station":
                    station.inventory[flight.item] = station.inventory.get(flight.item, 0) + flight.qty
                    npcs[flight.owner_id].station_inventory[flight.item] = (
                        npcs[flight.owner_id].station_inventory.get(flight.item, 0) + flight.qty
                    )
                    if flight.item not in seen_items:
                        seen_items.add(flight.item)
                        logs.append(f"[T{t:03d}] 首次到货贸易站: {flight.item} (由 {flight.owner_id} 运送)")
                else:
                    npcs[flight.owner_id].inventory[flight.item] = (
                        npcs[flight.owner_id].inventory.get(flight.item, 0) + flight.qty
                    )
            else:
                still_flying.append(flight)
        in_flight = still_flying

        for npc in npcs.values():
            npc.decide(t, station, in_flight, npcs, planet, logs)

        sat = planet.step(station, npcs)
        station.update_reference_prices()

        if t == 1 or t % 72 == 0:
            p = station.reference_price
            print(
                f"{t:4d} | {planet.prosperity:5.2f} | {sat:4.2f} | "
                f"{p['food']:5.2f} | {p['iron_10']:7.2f} | {p['fuel_10']:7.2f} | {len(seen_items):>11d}"
            )

    print("\n--- 全部关键事件日志 ---")
    for line in logs:
        print(line)

    print("\n--- 第 10 天末 12 家 NPC 资产明细 ---")
    for npc in npcs.values():
        b_list = [b.recipe.kind for b in npc.buildings]
        fuel_left = npc.inventory.get("fuel_10", 0)
        print(f"{npc.npc_id:<6} | Cash: {npc.cash:7.1f} | Fuel10: {fuel_left:2d} | Buildings: {b_list}")


if __name__ == "__main__":
    run_simulation()

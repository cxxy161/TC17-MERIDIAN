"""Experiment 6: Real CLOB (Central Limit Order Book) Exchange + 10-Step Chains."""

import random
from dataclasses import dataclass, field


@dataclass
class Order:
    order_id: int
    owner_id: str
    side: str  # "buy" or "sell"
    item: str
    qty: int
    price: float
    tick: int


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
    for i in range(1, 11):
        kind = f"IronStep{i}"
        out_item = f"iron_{i}"
        in_item = f"iron_{i-1}" if i > 1 else None
        recipes[kind] = Recipe(kind, out_item, 10, cycle_ticks=2, cycle_cost=10.0, input_item=in_item, input_qty=10 if in_item else 0)
    for i in range(1, 11):
        kind = f"FuelStep{i}"
        out_item = f"fuel_{i}"
        in_item = f"fuel_{i-1}" if i > 1 else None
        recipes[kind] = Recipe(kind, out_item, 10, cycle_ticks=2, cycle_cost=8.0, input_item=in_item, input_qty=10 if in_item else 0)
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


class CLOBExchange:
    """Real Central Limit Order Book: no artificial reference_price."""

    def __init__(self) -> None:
        self.bids: dict[str, list[Order]] = {}
        self.asks: dict[str, list[Order]] = {}
        self.inventory: dict[str, int] = {}
        self.last_price: dict[str, float] = {}
        self._next_id = 1

        for r in RECIPES.values():
            item = r.output_item
            self.bids[item] = []
            self.asks[item] = []
            if item.startswith("iron_"):
                p = 2.0 * int(item.split("_")[1])
            elif item.startswith("fuel_"):
                p = 1.8 * int(item.split("_")[1])
            elif item == "mat":
                p = 45.0
            else:
                p = 6.0
            self.last_price[item] = p
            self.inventory[item] = 40
            self.place_order("SYSTEM", "sell", item, 40, p, 0)
        self.inventory["mat"] = 80
        self.asks["mat"] = [Order(self._gen_id(), "SYSTEM", "sell", "mat", 80, 45.0, 0)]

    def _gen_id(self) -> int:
        oid = self._next_id
        self._next_id += 1
        return oid

    def best_bid(self, item: str) -> float | None:
        return self.bids[item][0].price if self.bids.get(item) else None

    def best_ask(self, item: str) -> float | None:
        return self.asks[item][0].price if self.asks.get(item) else None

    def market_signal(self, item: str) -> float:
        """Objective price signal from the order book."""
        bb = self.best_bid(item)
        ba = self.best_ask(item)
        if bb is not None and ba is not None:
            return (bb + ba) / 2.0
        if bb is not None:
            return max(bb, self.last_price[item])
        if ba is not None:
            return ba
        return self.last_price[item]

    def place_order(self, owner_id: str, side: str, item: str, qty: int, price: float, tick: int) -> None:
        if qty <= 0 or price <= 0:
            return
        order = Order(self._gen_id(), owner_id, side, item, qty, round(price, 2), tick)
        if side == "buy":
            # Keep at most 1 active bid per owner per item to avoid stale book bloat
            self.bids[item] = [o for o in self.bids[item] if o.owner_id != owner_id]
            self.bids[item].append(order)
            self.bids[item].sort(key=lambda o: (-o.price, o.tick, o.order_id))
        else:
            self.asks[item].append(order)
            self.asks[item].sort(key=lambda o: (o.price, o.tick, o.order_id))

    def match(self, item: str, actors: dict[str, object], planet: "Planet") -> None:
        bids = self.bids[item]
        asks = self.asks[item]
        while bids and asks and bids[0].price >= asks[0].price:
            b = bids[0]
            a = asks[0]
            trade_price = a.price if a.tick <= b.tick else b.price
            buyer = planet if b.owner_id == "PLANET" else actors[b.owner_id]
            seller = None if a.owner_id == "SYSTEM" else actors[a.owner_id]

            buyer_cash = buyer.wealth if b.owner_id == "PLANET" else buyer.cash
            can_afford = int(buyer_cash // trade_price)
            qty = min(b.qty, a.qty, can_afford, self.inventory.get(item, 0))
            if qty <= 0:
                if can_afford <= 0:
                    bids.pop(0)
                else:
                    asks.pop(0)
                continue

            cost = qty * trade_price
            tax = cost * planet.tax_rate
            if b.owner_id == "PLANET":
                planet.wealth -= cost - tax
                planet.bought_this_tick[item] = planet.bought_this_tick.get(item, 0) + qty
            else:
                buyer.cash -= cost
                planet.wealth += tax
                buyer.station_inventory[item] = buyer.station_inventory.get(item, 0) + qty

            if seller is not None:
                seller.cash += cost - tax
                seller.station_inventory[item] -= qty

            self.inventory[item] -= qty
            self.last_price[item] = trade_price

            b.qty -= qty
            a.qty -= qty
            if b.qty == 0:
                bids.pop(0)
            if a.qty == 0:
                asks.pop(0)


@dataclass
class CLOBNPC:
    npc_id: str
    initial_kind: str
    cash: float = 2000.0
    inventory: dict[str, int] = field(default_factory=lambda: {"fuel_10": 15})
    station_inventory: dict[str, int] = field(default_factory=dict)
    plot_capacity: int = 5
    buildings: list[Building] = field(default_factory=list)
    constructions: list[ConstructionJob] = field(default_factory=list)
    ship_busy_until: int = 0
    launch_ticks: int = 2
    fuel_per_trip: int = 1
    decision_interval: int = 5
    bid_escalation: dict[str, float] = field(default_factory=dict)

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
                logs.append(f"[T{tick:03d}] {self.npc_id} 建成 {job.kind} (建筑 {len(self.buildings)}/5)")
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

    def _recipe_margin(self, r: Recipe, ex: CLOBExchange) -> float:
        sell_p = ex.market_signal(r.output_item)
        in_p = (ex.market_signal(r.input_item) * r.input_qty / r.output_qty) if r.input_item else 0.0
        unit_cost = (r.cycle_cost / r.output_qty) + in_p
        return (sell_p - unit_cost) / max(0.1, unit_cost)

    def _place_escalating_bid(self, ex: CLOBExchange, item: str, qty: int, tick: int) -> None:
        esc = self.bid_escalation.get(item, 1.0)
        base = ex.best_ask(item) or ex.market_signal(item)
        bid_p = min(self.cash / max(1, qty), base * esc)
        ex.place_order(self.npc_id, "buy", item, qty, bid_p, tick)
        # If no ask available, escalate bid next time
        if ex.best_ask(item) is None or ex.best_ask(item) > bid_p:
            self.bid_escalation[item] = min(5.0, esc * 1.25)
        else:
            self.bid_escalation[item] = 1.0

    def decide(self, tick: int, ex: CLOBExchange, in_flight: list[ShipInFlight], logs: list[str]) -> None:
        if tick % self.decision_interval != 0:
            return

        # 1. Self-regulate utilization
        for b in self.buildings:
            margin = self._recipe_margin(b.recipe, ex)
            local_stock = self.inventory.get(b.recipe.output_item, 0)
            target_u = b.utilization + 0.25 * (margin - 0.10)
            if local_stock > b.recipe.output_qty * 5:
                target_u -= 0.3
            b.utilization = max(0.0, min(1.0, target_u))

        # 2. Self-select: pick high-margin recipe with randomness
        if self.used_slots() < self.plot_capacity and self.cash > 600:
            profitable = [r for r in RECIPES.values() if self._recipe_margin(r, ex) > 0.15]
            if profitable:
                best_r = max(profitable, key=lambda r: self._recipe_margin(r, ex) * random.uniform(0.5, 1.5))
                mat_at_st = self.station_inventory.get("mat", 0)
                if mat_at_st >= 10 and self.cash >= 100:
                    self.station_inventory["mat"] -= 10
                    self.cash -= 100
                    self.constructions.append(ConstructionJob(best_r.kind, tick + 10))
                    logs.append(f"[T{tick:03d}] {self.npc_id} 自选扩建 -> {best_r.kind} (利润率 {self._recipe_margin(best_r, ex):.0%})")
                elif mat_at_st < 10:
                    self._place_escalating_bid(ex, "mat", 10 - mat_at_st, tick)

        # 3. Bid for fuel_10 if low
        if self.inventory.get("fuel_10", 0) < 4:
            if self.station_inventory.get("fuel_10", 0) > 0 and tick >= self.ship_busy_until:
                take = min(10, self.station_inventory["fuel_10"])
                self.station_inventory["fuel_10"] -= take
                self.inventory["fuel_10"] = self.inventory.get("fuel_10", 0) + take
            else:
                self._place_escalating_bid(ex, "fuel_10", 8, tick)

        # 4. Bid/bring inputs
        for b in self.buildings:
            in_item = b.recipe.input_item
            if not in_item:
                continue
            st_in = self.station_inventory.get(in_item, 0)
            if st_in > 0 and tick >= self.ship_busy_until and self.inventory.get("fuel_10", 0) >= self.fuel_per_trip:
                take = min(30, st_in)
                self.station_inventory[in_item] -= take
                self.inventory["fuel_10"] -= self.fuel_per_trip
                self.ship_busy_until = tick + self.launch_ticks
                in_flight.append(ShipInFlight(self.npc_id, "to_npc", in_item, take, tick + self.launch_ticks))
                break
            elif self.inventory.get(in_item, 0) < b.recipe.input_qty * 2:
                self._place_escalating_bid(ex, in_item, b.recipe.input_qty * 2, tick)

        # 5. Ship outputs to exchange
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

        # 6. Post limit sell orders
        for b in self.buildings:
            out_item = b.recipe.output_item
            at_st = self.station_inventory.get(out_item, 0)
            listed = sum(o.qty for o in ex.asks[out_item] if o.owner_id == self.npc_id)
            unlisted = at_st - listed
            if unlisted > 0:
                sig = ex.market_signal(out_item)
                in_c = (ex.market_signal(b.recipe.input_item) * b.recipe.input_qty / b.recipe.output_qty) if b.recipe.input_item else 0.0
                unit_c = (b.recipe.cycle_cost / b.recipe.output_qty) + in_c
                ask = max(unit_c * 1.05, sig * 0.98)
                ex.place_order(self.npc_id, "sell", out_item, unlisted, ask, tick)


@dataclass
class Planet:
    population: float = 1000.0
    wealth: float = 10000.0
    prosperity: float = 1.0
    base_output_per_capita: float = 0.35
    tax_rate: float = 0.10
    bought_this_tick: dict[str, int] = field(default_factory=dict)

    def place_bids(self, tick: int, ex: CLOBExchange) -> None:
        self.wealth += self.population * self.base_output_per_capita * self.prosperity
        self.bought_this_tick.clear()
        demands = {"food": 8, "iron_10": 3}
        for item, qty in demands.items():
            sig = ex.market_signal(item)
            hunger = max(0.0, 1.2 - self.prosperity)
            bid_p = sig * (1.05 + 1.2 * hunger)
            ex.place_order("PLANET", "buy", item, qty, bid_p, tick)

    def update_prosperity(self) -> float:
        demands = {"food": 8, "iron_10": 3}
        sats = [min(1.0, self.bought_this_tick.get(k, 0) / q) for k, q in demands.items()]
        avg_sat = sum(sats) / len(sats)
        self.prosperity = max(0.2, min(2.0, self.prosperity + (avg_sat - 0.8) * 0.05))
        return avg_sat


def run_simulation(ticks: int = 240) -> None:
    random.seed(42)
    ex = CLOBExchange()
    planet = Planet()
    init_kinds = [
        "IronStep1", "IronStep2", "IronStep3", "IronStep4",
        "FuelStep1", "FuelStep2", "FuelStep3", "FuelStep4",
        "FoodFarm", "MatFactory", "IronStep5", "FuelStep5",
    ]
    npcs = {f"NPC-{i+1}": CLOBNPC(f"NPC-{i+1}", k) for i, k in enumerate(init_kinds)}
    in_flight: list[ShipInFlight] = []
    logs: list[str] = []

    print(f"{'Tick':>4} | {'Prosp':>5} | {'Sat':>4} | {'FoodSig':>7} | {'Iron10Sig':>9} | {'Fuel10Sig':>9}")
    print("-" * 54)

    for t in range(1, ticks + 1):
        for npc in npcs.values():
            npc.step_production_and_build(t, logs)

        still_flying: list[ShipInFlight] = []
        for f in in_flight:
            if f.arrival_tick <= t:
                if f.direction == "to_station":
                    ex.inventory[f.item] = ex.inventory.get(f.item, 0) + f.qty
                    npcs[f.owner_id].station_inventory[f.item] = npcs[f.owner_id].station_inventory.get(f.item, 0) + f.qty
                else:
                    npcs[f.owner_id].inventory[f.item] = npcs[f.owner_id].inventory.get(f.item, 0) + f.qty
            else:
                still_flying.append(f)
        in_flight = still_flying

        for npc in npcs.values():
            npc.decide(t, ex, in_flight, logs)

        planet.place_bids(t, ex)
        for item in ex.bids:
            ex.match(item, npcs, planet)
        sat = planet.update_prosperity()

        if t == 1 or t % 48 == 0:
            print(
                f"{t:4d} | {planet.prosperity:5.2f} | {sat:4.2f} | "
                f"{ex.market_signal('food'):7.2f} | {ex.market_signal('iron_10'):9.2f} | {ex.market_signal('fuel_10'):9.2f}"
            )

    print("\n--- 关键事件日志 ---")
    for line in logs[:25]:
        print(line)
    if len(logs) > 25:
        print(f"... (共 {len(logs)} 条事件)")


if __name__ == "__main__":
    run_simulation()

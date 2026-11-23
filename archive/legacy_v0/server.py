"""Meridian Backend: True Two-Way CLOB Exchange, Neuroevolution, 10-Tier DAG, 3 Ship Classes & Bank."""

import json
import math
import random
import threading
import time
from collections import deque
from dataclasses import dataclass, field
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, urlparse


@dataclass
class Order:
    order_id: int
    owner_id: str
    side: str  # "buy" or "sell"
    item: str
    qty: int
    price: float
    tick: int
    purpose: str = "station"  # "consume", "ground", "pickup", "station", "ship"


@dataclass
class ShipSpec:
    size: str
    item_key: str
    cn_name: str
    capacity: int
    launch_ticks: int
    fuel_per_trip: int
    repair_parts: int
    wear_per_trip: float


SHIP_SPECS: dict[str, ShipSpec] = {
    "small": ShipSpec("small", "ship_small", "小飞船", capacity=30, launch_ticks=1, fuel_per_trip=1, repair_parts=1, wear_per_trip=8.0),
    "medium": ShipSpec("medium", "ship_medium", "中货船", capacity=100, launch_ticks=2, fuel_per_trip=2, repair_parts=3, wear_per_trip=6.0),
    "large": ShipSpec("large", "ship_large", "大货轮", capacity=320, launch_ticks=4, fuel_per_trip=4, repair_parts=8, wear_per_trip=5.0),
}
ITEM_TO_SHIP_SIZE: dict[str, str] = {s.item_key: s.size for s in SHIP_SPECS.values()}
INSTANT_GROUND_ITEMS = {"power", "fuel", "mat", "repair_parts"}


@dataclass
class Ship:
    ship_id: int
    size: str
    durability: float = 100.0
    busy_until: int = 0

    @property
    def spec(self) -> ShipSpec:
        return SHIP_SPECS[self.size]


@dataclass
class ShipInFlight:
    owner_id: str
    ship_id: int
    direction: str  # "to_station" or "to_npc"
    item: str
    qty: int
    arrival_tick: int


@dataclass
class Recipe:
    kind: str
    cn_name: str
    output_item: str
    output_qty: int
    cycle_ticks: int
    power_cost: int
    cash_cost: float
    inputs: dict[str, int] = field(default_factory=dict)
    tier: int = 0


RECIPES: dict[str, Recipe] = {
    "PowerPlant": Recipe("PowerPlant", "发电厂", "power", 24, cycle_ticks=2, power_cost=0, cash_cost=12.0, inputs={"fuel": 2}),
    "FuelPlant": Recipe("FuelPlant", "燃油厂", "fuel", 10, cycle_ticks=2, power_cost=4, cash_cost=10.0),
    "IronMine": Recipe("IronMine", "铁矿场", "iron", 12, cycle_ticks=2, power_cost=5, cash_cost=16.0),
    "RepairPlant": Recipe("RepairPlant", "维修件厂", "repair_parts", 6, cycle_ticks=3, power_cost=5, cash_cost=12.0, inputs={"steel": 2, "parts": 1}),
    "FoodFarm": Recipe("FoodFarm", "农场(T1)", "food", 14, cycle_ticks=3, power_cost=5, cash_cost=22.0, tier=1),
    "Smelter": Recipe("Smelter", "炼钢厂(T2)", "steel", 6, cycle_ticks=4, power_cost=8, cash_cost=16.0, inputs={"iron": 10}, tier=2),
    "MatFactory": Recipe("MatFactory", "建材厂(T3)", "mat", 5, cycle_ticks=4, power_cost=7, cash_cost=14.0, inputs={"steel": 5, "iron": 4}, tier=3),
    "AlloyPlant": Recipe("AlloyPlant", "合金厂(T4)", "alloy", 5, cycle_ticks=5, power_cost=10, cash_cost=18.0, inputs={"steel": 5, "fuel": 3}, tier=4),
    "PartsPlant": Recipe("PartsPlant", "机械厂(T5)", "parts", 4, cycle_ticks=5, power_cost=10, cash_cost=20.0, inputs={"alloy": 4, "steel": 3}, tier=5),
    "PrecisionLab": Recipe("PrecisionLab", "精密厂(T6)", "precision", 3, cycle_ticks=6, power_cost=12, cash_cost=24.0, inputs={"parts": 4, "alloy": 3}, tier=6),
    "ElectronicsFab": Recipe("ElectronicsFab", "电子厂(T7)", "electronics", 3, cycle_ticks=6, power_cost=14, cash_cost=28.0, inputs={"precision": 3, "mat": 3, "fuel": 2}, tier=7),
    "RoboticsPlant": Recipe("RoboticsPlant", "机器人厂(T8)", "robotics", 2, cycle_ticks=8, power_cost=18, cash_cost=36.0, inputs={"electronics": 3, "precision": 2, "parts": 3}, tier=8),
    "BiomedLab": Recipe("BiomedLab", "生物所(T9)", "biomed", 2, cycle_ticks=8, power_cost=16, cash_cost=34.0, inputs={"food": 8, "electronics": 2, "fuel": 3}, tier=9),
    "QuantumCenter": Recipe("QuantumCenter", "尖端中心(T10)", "quantum", 1, cycle_ticks=10, power_cost=24, cash_cost=50.0, inputs={"robotics": 2, "biomed": 2, "precision": 3}, tier=10),
    "SmallYard": Recipe("SmallYard", "小型船坞", "ship_small", 1, cycle_ticks=12, power_cost=12, cash_cost=40.0, inputs={"steel": 8, "parts": 2}),
    "MediumYard": Recipe("MediumYard", "中型船坞", "ship_medium", 1, cycle_ticks=20, power_cost=20, cash_cost=80.0, inputs={"steel": 15, "alloy": 6, "parts": 4, "electronics": 2}),
    "LargeYard": Recipe("LargeYard", "大型船坞", "ship_large", 1, cycle_ticks=32, power_cost=30, cash_cost=140.0, inputs={"steel": 30, "alloy": 15, "precision": 10, "electronics": 5}),
}

TIER_UNLOCK_PROSPERITY: dict[str, tuple[float, float]] = {
    "food": (0.2, 0.008),
    "steel": (0.2, 0.003),
    "mat": (0.8, 0.002),
    "alloy": (1.2, 0.0015),
    "parts": (1.6, 0.0012),
    "precision": (2.2, 0.0008),
    "electronics": (3.0, 0.0006),
    "robotics": (4.0, 0.0004),
    "biomed": (5.2, 0.00035),
    "quantum": (6.5, 0.0002),
}

ITEM_CN: dict[str, str] = {
    "food": "粮食(T1)", "steel": "钢铁(T2)", "mat": "建材(T3)", "alloy": "合金(T4)",
    "parts": "机械(T5)", "precision": "精密(T6)", "electronics": "电子(T7)", "robotics": "机器人(T8)",
    "biomed": "医药(T9)", "quantum": "量子(T10)", "power": "电力", "fuel": "燃油",
    "iron": "铁矿", "repair_parts": "维修件", "ship_small": "小飞船", "ship_medium": "中货船",
    "ship_large": "大货轮", "bank_rate": "银行利率",
}

BASE_PRICES: dict[str, float] = {
    "power": 2.5, "fuel": 5.0, "iron": 5.0, "repair_parts": 32.0,
    "food": 8.0, "steel": 18.0, "mat": 32.0, "alloy": 48.0, "parts": 85.0,
    "precision": 160.0, "electronics": 300.0, "robotics": 620.0, "biomed": 520.0, "quantum": 1450.0,
    "ship_small": 420.0, "ship_medium": 1600.0, "ship_large": 4500.0,
}

BASE_INVENTORY: dict[str, int] = {
    "power": 800, "fuel": 400, "iron": 400, "repair_parts": 150,
    "food": 500, "steel": 260, "mat": 180, "alloy": 120, "parts": 90,
    "precision": 60, "electronics": 40, "robotics": 20, "biomed": 20, "quantum": 10,
    "ship_small": 12, "ship_medium": 6, "ship_large": 2,
}

TERRAIN_RANGES: dict[str, dict[str, tuple[float, float]]] = {
    "平原": {"FoodFarm": (1.15, 1.50), "IronMine": (0.55, 0.85), "PowerPlant": (0.85, 1.15), "BiomedLab": (1.10, 1.35)},
    "山地": {"IronMine": (1.20, 1.55), "FoodFarm": (0.45, 0.75), "PowerPlant": (0.80, 1.10), "AlloyPlant": (1.05, 1.25)},
    "荒漠": {"PowerPlant": (1.25, 1.65), "FoodFarm": (0.35, 0.65), "FuelPlant": (1.00, 1.30), "QuantumCenter": (1.05, 1.30)},
    "工业带": {"Smelter": (1.15, 1.45), "MatFactory": (1.15, 1.45), "PartsPlant": (1.10, 1.40), "ElectronicsFab": (1.10, 1.35), "SmallYard": (1.10, 1.35)},
}


def generate_terrain() -> tuple[str, dict[str, float]]:
    name = random.choice(list(TERRAIN_RANGES.keys()))
    specific = TERRAIN_RANGES[name]
    mods = {kind: round(random.uniform(*specific.get(kind, (0.90, 1.15))), 2) for kind in RECIPES}
    return name, mods


@dataclass
class Genome:
    lookback_mix: float
    decision_interval: int
    max_leverage: float
    trader_bias: float

    @classmethod
    def random(cls) -> "Genome":
        return cls(
            lookback_mix=random.uniform(0.0, 1.0),
            decision_interval=random.randint(2, 10),
            max_leverage=random.uniform(0.1, 1.4),
            trader_bias=random.uniform(0.0, 1.0),
        )

    @classmethod
    def crossover(cls, a: "Genome", b: "Genome") -> "Genome":
        mix = (a.lookback_mix if random.random() < 0.5 else b.lookback_mix) + random.gauss(0, 0.08)
        di = (a.decision_interval if random.random() < 0.5 else b.decision_interval) + random.choice([-1, 0, 0, 1])
        lev = (a.max_leverage if random.random() < 0.5 else b.max_leverage) + random.gauss(0, 0.10)
        tb = (a.trader_bias if random.random() < 0.5 else b.trader_bias) + random.gauss(0, 0.10)
        return cls(
            lookback_mix=max(0.0, min(1.0, mix)),
            decision_interval=max(2, min(10, di)),
            max_leverage=max(0.0, min(1.5, lev)),
            trader_bias=max(0.0, min(1.0, tb)),
        )


@dataclass
class PolicyBrain:
    w: list[list[float]]
    b: list[float]
    probe_dw: list[list[float]] | None = None
    probe_db: list[float] | None = None
    last_eval_nw: float = 0.0
    avg_reward: float = 0.0

    @classmethod
    def random(cls) -> "PolicyBrain":
        w = [[random.gauss(0.0, 0.25) for _ in range(6)] for _ in range(4)]
        w[0][1] += 0.5
        w[0][2] += 1.2
        w[3][2] += 0.8
        b = [random.gauss(0.25, 0.2), random.gauss(0.0, 0.2), random.gauss(0.0, 0.25), random.gauss(0.0, 0.2)]
        return cls(w=w, b=b)

    @classmethod
    def crossover(cls, pa: "PolicyBrain", pb: "PolicyBrain") -> "PolicyBrain":
        w = []
        for r in range(4):
            row = []
            for c in range(6):
                val = pa.w[r][c] if random.random() < 0.5 else pb.w[r][c]
                row.append(max(-2.5, min(2.5, val + random.gauss(0, 0.12))))
            w.append(row)
        b = []
        for r in range(4):
            val = pa.b[r] if random.random() < 0.5 else pb.b[r]
            b.append(max(-1.5, min(1.5, val + random.gauss(0, 0.08))))
        return cls(w=w, b=b)

    def forward(self, state: list[float]) -> tuple[float, float, float, float]:
        outs = []
        for r in range(4):
            acc = self.b[r]
            row = self.w[r]
            for c in range(6):
                acc += row[c] * state[c]
            outs.append(math.tanh(max(-6.0, min(6.0, acc))))
        return outs[0], outs[1], outs[2], outs[3]

    def online_es_step(self, cur_nw: float) -> None:
        if self.last_eval_nw <= 0:
            self.last_eval_nw = max(100.0, cur_nw)
        else:
            reward = (cur_nw - self.last_eval_nw) / max(200.0, self.last_eval_nw)
            self.last_eval_nw = cur_nw
            if self.probe_dw is not None and self.probe_db is not None:
                if reward < self.avg_reward - 0.002:
                    for r in range(4):
                        self.b[r] -= self.probe_db[r]
                        for c in range(6):
                            self.w[r][c] -= self.probe_dw[r][c]
            self.avg_reward = self.avg_reward * 0.8 + reward * 0.2

        dw = [[random.gauss(0.0, 0.04) for _ in range(6)] for _ in range(4)]
        db = [random.gauss(0.0, 0.03) for _ in range(4)]
        for r in range(4):
            self.b[r] = max(-1.5, min(1.5, self.b[r] + db[r]))
            for c in range(6):
                self.w[r][c] = max(-2.5, min(2.5, self.w[r][c] + dw[r][c]))
        self.probe_dw = dw
        self.probe_db = db


@dataclass
class Building:
    recipe: Recipe
    efficiency: float = 1.0
    progress: int = 0
    active_batch: bool = False
    utilization: float = 0.8
    idle_ticks: int = 0


@dataclass
class SiteJob:
    action: str
    kind: str
    finish_tick: int


@dataclass
class Plot:
    plot_id: int
    terrain_name: str
    terrain_mods: dict[str, float]
    capacity: int = 5
    buildings: list[Building] = field(default_factory=list)
    jobs: list[SiteJob] = field(default_factory=list)

    def used_slots(self) -> int:
        return len(self.buildings) + len(self.jobs)


@dataclass
class LandListing:
    plot: Plot
    seller_id: str
    ask_price: float
    listed_tick: int
    debt_recovery: float = 0.0


class CLOBStation:
    """True Two-Way Central Limit Order Book (Bids + Asks, Maker-Taker matching, NO artificial reference_price)."""

    def __init__(self) -> None:
        self.inventory: dict[str, int] = dict(BASE_INVENTORY)
        self.target_inventory: dict[str, int] = dict(BASE_INVENTORY)
        self.bids: dict[str, list[Order]] = {k: [] for k in BASE_PRICES}
        self.asks: dict[str, list[Order]] = {k: [] for k in BASE_PRICES}
        self.last_trade_price: dict[str, float] = dict(BASE_PRICES)
        self.ema_fast: dict[str, float] = dict(BASE_PRICES)
        self.ema_med: dict[str, float] = dict(BASE_PRICES)
        self.ema_slow: dict[str, float] = dict(BASE_PRICES)
        self._next_oid = 1

        for item, qty in self.inventory.items():
            self.place_order("SYSTEM", "sell", item, qty, BASE_PRICES[item], 0, purpose="station")

    def best_bid(self, item: str) -> float | None:
        return self.bids[item][0].price if self.bids.get(item) else None

    def best_ask(self, item: str) -> float | None:
        return self.asks[item][0].price if self.asks.get(item) else None

    def signal_price(self, item: str) -> float:
        """Pure order-book price signal: Mid-Price if two-sided, else best quote / last trade."""
        bb = self.best_bid(item)
        ba = self.best_ask(item)
        if bb is not None and ba is not None:
            return round((bb + ba) / 2.0, 4)
        if bb is not None:
            return round(max(bb, self.last_trade_price[item]), 4)
        if ba is not None:
            return round(ba, 4)
        return round(self.last_trade_price[item], 4)

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
            # Replace owner's existing bid for this item+purpose to keep book clean
            self.bids[item] = [o for o in self.bids[item] if not (o.owner_id == owner_id and o.purpose == purpose)]
            self.bids[item].append(order)
            self.bids[item].sort(key=lambda o: (-o.price, o.tick, o.order_id))
        else:
            self.asks[item] = [o for o in self.asks[item] if o.owner_id != owner_id]
            self.asks[item].append(order)
            self.asks[item].sort(key=lambda o: (o.price, o.tick, o.order_id))

    def cancel_owner_orders(self, owner_id: str) -> None:
        for item in self.bids:
            self.bids[item] = [o for o in self.bids[item] if o.owner_id != owner_id]
            self.asks[item] = [o for o in self.asks[item] if o.owner_id != owner_id]

    def match_all(self, planet: "Planet", bank: "PlanetBank") -> None:
        for item in self.bids:
            bids = self.bids[item]
            asks = self.asks[item]
            while bids and asks and bids[0].price >= asks[0].price:
                b = bids[0]
                a = asks[0]
                if b.owner_id == a.owner_id:
                    # Prevent wash trading: cancel older self-order
                    if b.tick < a.tick:
                        bids.pop(0)
                    else:
                        asks.pop(0)
                    continue

                trade_price = a.price if a.tick <= b.tick else b.price

                # Validate buyer
                if b.owner_id == "PLANET":
                    buyer_cash = planet.wealth
                elif b.owner_id in npcs:
                    buyer_cash = npcs[b.owner_id].cash
                else:
                    bids.pop(0)
                    continue

                # Validate seller backing
                if a.owner_id in ("SYSTEM", "BANK"):
                    seller_avail = a.qty
                elif a.owner_id in npcs:
                    seller_avail = min(a.qty, npcs[a.owner_id].station_inventory.get(item, 0))
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
                tax = cost * planet.tax_rate

                # Settle cash & inventory by purpose
                if b.owner_id == "PLANET":
                    planet.wealth -= cost - tax
                    self.inventory[item] -= take
                    planet.bought_this_tick[item] = planet.bought_this_tick.get(item, 0) + take
                else:
                    buyer = npcs[b.owner_id]
                    buyer.cash -= cost
                    planet.wealth += tax
                    if b.purpose == "station":
                        # Speculator holds at station: physical st.inventory unchanged!
                        buyer.station_inventory[item] = buyer.station_inventory.get(item, 0) + take
                        if item not in buyer.traded_items:
                            buyer.traded_items.append(item)
                        buyer.last_action = f"买单成交 {ITEM_CN[item]}×{take}"
                    elif b.purpose == "ship":
                        self.inventory[item] -= take
                        size = ITEM_TO_SHIP_SIZE[item]
                        for _ in range(take):
                            buyer.fleet.append(new_ship(size))
                        buyer.last_action = f"购入{SHIP_SPECS[size].cn_name}"
                    elif b.purpose == "ground":
                        self.inventory[item] -= take
                        buyer.inventory[item] = buyer.inventory.get(item, 0) + take
                    else:  # "pickup": bought industrial input waiting at station for ship haul
                        buyer.station_pickup[item] = buyer.station_pickup.get(item, 0) + take

                if a.owner_id == "BANK":
                    bank.reserves += cost - tax
                elif a.owner_id in npcs:
                    seller = npcs[a.owner_id]
                    seller.cash += cost - tax
                    seller.station_inventory[item] = max(0, seller.station_inventory.get(item, 0) - take)

                self.last_trade_price[item] = trade_price
                b.qty -= take
                a.qty -= take
                if b.qty == 0:
                    bids.pop(0)
                if a.qty == 0:
                    asks.pop(0)

    def update_mas(self) -> None:
        for item in self.last_trade_price:
            sig = self.signal_price(item)
            self.ema_fast[item] = self.ema_fast[item] * 0.85 + sig * 0.15
            self.ema_med[item] = self.ema_med[item] * 0.972 + sig * 0.028
            self.ema_slow[item] = self.ema_slow[item] * 0.9945 + sig * 0.0055


@dataclass
class PlanetBank:
    annual_rate_pct: float = 5.0
    reserves: float = 80000.0
    total_deposits: float = 0.0
    total_loans: float = 0.0

    def loan_tick_rate(self) -> float:
        return (self.annual_rate_pct / 100.0) / 8640.0

    def deposit_tick_rate(self) -> float:
        return self.loan_tick_rate() * 0.5

    def update_policy(self, planet: "Planet", st: CLOBStation) -> None:
        price_index = (
            st.signal_price("food") / 8.0
            + st.signal_price("steel") / 18.0
            + st.signal_price("power") / 2.5
        ) / 3.0
        target_rate = 3.0 + max(0.0, price_index - 1.0) * 6.0 + max(0.0, planet.prosperity - 1.0) * 3.0
        if planet.prosperity < 0.6:
            target_rate = min(target_rate, 2.0)
        util = self.total_loans / max(1.0, self.reserves + self.total_deposits)
        target_rate += util * 4.0
        target_rate = max(0.5, min(30.0, target_rate))
        self.annual_rate_pct = round(self.annual_rate_pct * 0.85 + target_rate * 0.15, 4)


BUILD_TICKS = 168
DEMOLISH_TICKS = 168
LAND_FEE_RATE = 0.15


def recipe_profit_per_tick(r: Recipe, st: CLOBStation, eff: float) -> tuple[float, float]:
    out_qty = max(1, int(round(r.output_qty * eff)))
    sell_p = st.signal_price(r.output_item)
    in_c = sum(st.signal_price(k) * q for k, q in r.inputs.items())
    pwr_c = st.signal_price("power") * r.power_cost
    cycle_total_cost = r.cash_cost + pwr_c + in_c
    unit_c = cycle_total_cost / out_qty
    margin = (sell_p - unit_c) / max(0.05, unit_c)
    profit_per_tick = (sell_p * out_qty - cycle_total_cost) / r.cycle_ticks
    return margin, profit_per_tick


def evaluate_plot_roi(plot: Plot, ask_price: float, st: CLOBStation) -> float:
    existing_profit = 0.0
    for b in plot.buildings:
        _, p_tick = recipe_profit_per_tick(b.recipe, st, b.efficiency)
        existing_profit += max(0.0, p_tick)
    free_slots = plot.capacity - plot.used_slots()
    best_r_profit = max(
        (recipe_profit_per_tick(r, st, plot.terrain_mods.get(r.kind, 1.0))[1] for r in RECIPES.values()),
        default=0.0,
    )
    mat_build_cost = 10.0 * st.signal_price("mat") + 100.0
    potential_profit = free_slots * max(0.0, best_r_profit * 80.0 - mat_build_cost * 0.5)
    return existing_profit * 120.0 + potential_profit - ask_price


@dataclass
class SmartNPC:
    npc_id: str
    genome: Genome = field(default_factory=Genome.random)
    brain: PolicyBrain = field(default_factory=PolicyBrain.random)
    generation: int = 1
    plots: list[Plot] = field(default_factory=list)
    fleet: list[Ship] = field(default_factory=list)
    cash: float = 2200.0
    savings: float = 0.0
    debt: float = 0.0
    inventory: dict[str, int] = field(default_factory=lambda: {"fuel": 15, "power": 30, "repair_parts": 3})
    station_inventory: dict[str, int] = field(default_factory=dict)
    station_pickup: dict[str, int] = field(default_factory=dict)
    distress_ticks: int = 0
    last_action: str = "初始化"
    traded_items: list[str] = field(default_factory=list)

    def __post_init__(self) -> None:
        if not self.fleet:
            self.fleet.append(new_ship("small"))

    def emergent_profile(self) -> str:
        horizon = "短线" if self.genome.lookback_mix < 0.35 else ("长线" if self.genome.lookback_mix > 0.65 else "中线")
        lev = "高杠" if self.genome.max_leverage > 0.95 else ("稳健" if self.genome.max_leverage < 0.45 else "适中")
        role = "囤货商" if self.genome.trader_bias > 0.62 else ("产销派" if self.genome.trader_bias < 0.35 else "混合派")
        return f"G{self.generation}·{horizon}·{lev}·{role}"

    def all_buildings(self) -> list[tuple[Plot, Building]]:
        return [(p, b) for p in self.plots for b in p.buildings]

    def total_buildings(self) -> int:
        return sum(len(p.buildings) for p in self.plots)

    def total_capacity(self) -> int:
        return sum(p.capacity for p in self.plots)

    def live_net_worth(self, planet: "Planet", st: CLOBStation) -> float:
        land_val = len(self.plots) * planet.primary_land_price()
        mat_price = st.signal_price("mat")
        factory_val = self.total_buildings() * (10.0 * mat_price + 100.0)
        fleet_val = sum(st.signal_price(s.spec.item_key) * (s.durability / 100.0) for s in self.fleet)
        inv_val = sum(qty * st.signal_price(item) for item, qty in self.inventory.items())
        st_inv_val = sum(qty * st.signal_price(item) for item, qty in self.station_inventory.items())
        pk_val = sum(qty * st.signal_price(item) for item, qty in self.station_pickup.items())
        return self.cash + self.savings - self.debt + land_val + factory_val + fleet_val + inv_val + st_inv_val + pk_val

    def estimated_asset_value(self, planet: "Planet") -> float:
        land_v = planet.primary_land_price() * 0.8
        return len(self.plots) * land_v + self.total_buildings() * 180.0 + len(self.fleet) * 250.0 + self.cash + self.savings

    def apply_bank_and_overhead(self, bank: PlanetBank, planet: "Planet") -> None:
        if self.savings > 0:
            interest = self.savings * bank.deposit_tick_rate()
            self.savings += interest
            bank.total_deposits += interest
        if self.debt > 0:
            interest = self.debt * bank.loan_tick_rate()
            self.debt += interest
            bank.total_loans += interest
        k = len(self.plots)
        if k > 1:
            overhead = 12.0 * ((k - 1) ** 1.4)
            pay = min(self.cash, overhead)
            self.cash -= pay
            planet.wealth += pay

    def step_production_and_jobs(self, tick: int, st: CLOBStation) -> None:
        for plot in self.plots:
            still_jobs: list[SiteJob] = []
            for job in plot.jobs:
                if job.finish_tick <= tick:
                    if job.action == "build":
                        eff = plot.terrain_mods.get(job.kind, 1.0)
                        plot.buildings.append(Building(RECIPES[job.kind], efficiency=eff))
                        self.last_action = f"建成{RECIPES[job.kind].cn_name}"
                    else:
                        self.last_action = f"拆完{RECIPES[job.kind].cn_name}"
                else:
                    still_jobs.append(job)
            plot.jobs = still_jobs

            for b in plot.buildings:
                r = b.recipe
                b.idle_ticks = b.idle_ticks + 1 if b.utilization <= 0.05 else 0
                if b.active_batch:
                    b.progress += 1
                    if b.progress >= r.cycle_ticks:
                        out_qty = max(1, int(round(r.output_qty * b.efficiency)))
                        if r.output_item == "power" or r.output_item in ITEM_TO_SHIP_SIZE:
                            st.inventory[r.output_item] = st.inventory.get(r.output_item, 0) + out_qty
                            self.station_inventory[r.output_item] = self.station_inventory.get(r.output_item, 0) + out_qty
                        else:
                            self.inventory[r.output_item] = self.inventory.get(r.output_item, 0) + out_qty
                        b.active_batch = False
                        b.progress = 0

                if not b.active_batch and b.utilization > 0.15:
                    has_pwr = self.inventory.get("power", 0) >= r.power_cost
                    has_in = all(self.inventory.get(k, 0) >= q for k, q in r.inputs.items())
                    if has_pwr and has_in and self.cash >= r.cash_cost:
                        self.cash -= r.cash_cost
                        self.inventory["power"] -= r.power_cost
                        for k, q in r.inputs.items():
                            self.inventory[k] -= q
                        b.active_batch = True
                        b.progress = 0
                    elif r.kind == "PowerPlant" and not b.active_batch and self.cash >= r.cash_cost:
                        self.cash -= r.cash_cost
                        b.active_batch = True
                        b.progress = 0

    def _recipe_margin(self, r: Recipe, st: CLOBStation, plot: Plot | None = None) -> float:
        eff = plot.terrain_mods.get(r.kind, 1.0) if plot else 1.0
        margin, _ = recipe_profit_per_tick(r, st, eff)
        return margin

    def _build_state(self, item: str, margin: float, st: CLOBStation, bank: PlanetBank, nw: float) -> list[float]:
        ma = max(0.05, st.get_ma(item, self.genome.lookback_mix))
        cur_p = st.signal_price(item)
        price_z = max(-1.0, min(1.0, ((cur_p - ma) / ma) * 3.0))
        target_inv = max(4, st.target_inventory.get(item, 100))
        scarcity = max(-1.0, min(1.0, (target_inv - st.inventory.get(item, 0)) / target_inv))
        m_norm = max(-1.0, min(1.0, margin))
        cash_r = max(-1.0, min(1.0, (self.cash / max(200.0, nw)) * 2.0 - 1.0))
        debt_r = max(-1.0, min(1.0, (self.debt / max(200.0, nw)) * 2.0 - 1.0))
        rate_s = max(-1.0, min(1.0, (bank.annual_rate_pct - 8.0) / 10.0))
        return [price_z, scarcity, m_norm, cash_r, debt_r, rate_s]

    def _place_bid(self, tick: int, st: CLOBStation, item: str, want: int, max_price: float, purpose: str) -> None:
        if want <= 0 or self.cash < 1.0:
            return
        affordable = int((self.cash * 0.6) // max(0.05, max_price))
        qty = min(want, affordable)
        if qty > 0:
            st.place_order(self.npc_id, "buy", item, qty, max_price, tick, purpose=purpose)

    def _manage_bank(self, st: CLOBStation, bank: PlanetBank, nw: float) -> None:
        if self.debt > 0 and self.cash > 500:
            repay = min(self.debt, self.cash - 350)
            if repay > 0:
                self.cash -= repay
                self.debt -= repay
                bank.total_loans -= repay
                bank.reserves += repay
                self.last_action = f"还贷{repay:.0f}"

        if self.cash < 250 and self.savings > 0:
            wd = min(self.savings, 450 - self.cash)
            self.savings -= wd
            self.cash += wd
            bank.total_deposits -= wd
            self.last_action = f"取款{wd:.0f}"

        deposit_thresh = 2000.0 + (1.0 - self.genome.max_leverage) * 1500.0
        if self.cash > deposit_thresh and self.debt == 0:
            dep = (self.cash - deposit_thresh) * 0.5
            self.cash -= dep
            self.savings += dep
            bank.total_deposits += dep
            self.last_action = f"存款{dep:.0f}"

        max_debt = max(400.0, nw * self.genome.max_leverage)
        rate_ok = bank.annual_rate_pct < (8.0 + self.genome.max_leverage * 10.0)
        if self.cash < 280 and self.debt < max_debt and rate_ok and bank.reserves > 500:
            best_m = max((self._recipe_margin(r, st, p) for p in self.plots for r in RECIPES.values()), default=0.0)
            if best_m > 0.20 or self.genome.trader_bias > 0.65:
                loan = min(700.0, max_debt - self.debt, bank.reserves * 0.1)
                if loan >= 150:
                    self.cash += loan
                    self.debt += loan
                    bank.total_loans += loan
                    bank.reserves -= loan
                    self.last_action = f"贷款{loan:.0f}"

    def _maintain_and_trade_fleet(self, tick: int, st: CLOBStation) -> None:
        for ship in self.fleet:
            if ship.durability <= 35.0:
                need = ship.spec.repair_parts
                if self.inventory.get("repair_parts", 0) < need:
                    bid_p = (st.best_ask("repair_parts") or st.signal_price("repair_parts")) * 1.05
                    self._place_bid(tick, st, "repair_parts", need * 2, bid_p, "ground")
                if self.inventory.get("repair_parts", 0) >= need:
                    self.inventory["repair_parts"] -= need
                    ship.durability = 100.0
                    self.last_action = f"维修{ship.spec.cn_name}"

        idle_ships = [s for s in self.fleet if tick >= s.busy_until and s.durability > 0]
        local_backlog = sum(q for k, q in self.inventory.items() if k not in ("power", "fuel", "repair_parts"))
        if not idle_ships and local_backlog > 60 and len(self.fleet) < 5:
            target_size = "small" if (self.genome.decision_interval <= 3 or self.cash < 1800) else ("large" if self.cash > 5200 and local_backlog > 250 else "medium")
            item_key = SHIP_SPECS[target_size].item_key
            ask = st.best_ask(item_key)
            if ask and self.cash > ask + 300:
                self._place_bid(tick, st, item_key, 1, ask, "ship")

        if len(self.fleet) > 1 and self.cash < 200 and self.debt > 400:
            sell_ship = min(self.fleet, key=lambda s: s.spec.capacity)
            if tick >= sell_ship.busy_until:
                self.fleet.remove(sell_ship)
                item_key = sell_ship.spec.item_key
                st.inventory[item_key] = st.inventory.get(item_key, 0) + 1
                self.station_inventory[item_key] = self.station_inventory.get(item_key, 0) + 1
                ask_p = round(st.signal_price(item_key) * max(0.4, sell_ship.durability / 100.0) * 0.9, 4)
                st.place_order(self.npc_id, "sell", item_key, 1, ask_p, tick)
                self.last_action = f"挂卖{sell_ship.spec.cn_name}"

    def _two_sided_market_making(self, tick: int, st: CLOBStation, bank: PlanetBank, nw: float) -> float:
        """True two-way market making: place limit BUY walls below MA and SELL orders above MA!"""
        if self.genome.trader_bias < 0.30:
            return 0.0

        best_item = None
        best_score = -1.0
        for item in ("food", "steel", "iron", "fuel", "mat", "power"):
            ma = st.get_ma(item, self.genome.lookback_mix)
            sig = st.signal_price(item)
            disc = (ma - sig) / max(0.05, ma)
            score = disc + self.genome.trader_bias * 0.2
            if score > best_score:
                best_score = score
                best_item = item

        expand_signal = 0.0
        if best_item and self.cash > 350:
            state = self._build_state(best_item, best_score, st, bank, nw)
            _, a_quote, a_trade, a_expand = self.brain.forward(state)
            expand_signal = a_expand
            ma = st.get_ma(best_item, self.genome.lookback_mix)
            # Place a limit buy bid below MA (creates real bid depth / support wall!)
            bid_factor = max(0.75, min(0.99, 0.92 + a_quote * 0.05))
            bid_p = round(ma * bid_factor, 4)
            budget = min(self.cash * 0.25, 500.0)
            want = max(1, min(35, int(budget // max(0.05, bid_p))))
            self._place_bid(tick, st, best_item, want, bid_p, "station")
            if a_trade < 0.1:
                self.last_action = f"买托{ITEM_CN[best_item]}@{bid_p:.4f}"
        return expand_signal

    def decide(self, tick: int, st: CLOBStation, bank: PlanetBank, planet: "Planet") -> None:
        if tick % 24 == 0:
            self.brain.online_es_step(self.live_net_worth(planet, st))

        if tick % self.genome.decision_interval != 0:
            return

        nw = self.live_net_worth(planet, st)
        self._manage_bank(st, bank, nw)
        self._maintain_and_trade_fleet(tick, st)
        spec_expand = self._two_sided_market_making(tick, st, bank, nw)

        # 1. Production utilization
        avg_expand = spec_expand
        n_bld = 0
        for plot in self.plots:
            for b in plot.buildings:
                margin = self._recipe_margin(b.recipe, st, plot)
                state = self._build_state(b.recipe.output_item, margin, st, bank, nw)
                a_util, _, _, a_exp = self.brain.forward(state)
                avg_expand += a_exp
                n_bld += 1
                target_u = (a_util + 1.0) * 0.5
                if margin < -0.15:
                    target_u = min(target_u, 0.1)
                stock = self.inventory.get(b.recipe.output_item, 0)
                if b.recipe.output_item != "power" and stock > b.recipe.output_qty * 6:
                    target_u -= 0.35
                b.utilization = max(0.0, min(1.0, target_u))

        expand_drive = avg_expand / max(1, n_bld)

        # 2. Voluntary plot sale under stress
        if len(self.plots) > 1 and self.cash < 200 and self.debt > 500:
            worst_plot = min(self.plots, key=lambda p: evaluate_plot_roi(p, 0.0, st))
            if sum(b.idle_ticks for b in worst_plot.buildings) >= 15 or len(worst_plot.buildings) <= 1:
                self.plots.remove(worst_plot)
                est_val = max(120.0, planet.primary_land_price() * 0.85 + len(worst_plot.buildings) * 140.0)
                land_listings.append(LandListing(worst_plot, self.npc_id, round(est_val, 1), tick))
                self.last_action = f"挂卖地块#{worst_plot.plot_id}"

        # 3. Demolish inside full plot (1 week)
        for plot in self.plots:
            if plot.used_slots() >= plot.capacity and self.cash > 450:
                best_r = max(RECIPES.values(), key=lambda r: self._recipe_margin(r, st, plot))
                best_m = self._recipe_margin(best_r, st, plot)
                for idx, b in enumerate(plot.buildings):
                    cur_m = self._recipe_margin(b.recipe, st, plot)
                    if b.idle_ticks >= 40 and best_m > cur_m + 0.30 and self.total_buildings() > 1:
                        removed = plot.buildings.pop(idx)
                        plot.jobs.append(SiteJob("demolish", removed.recipe.kind, tick + DEMOLISH_TICKS))
                        self.last_action = f"拆{removed.recipe.cn_name}(1周)"
                        break

        # 4. Build inside available slot
        free_plots = [p for p in self.plots if p.used_slots() < p.capacity]
        if free_plots and self.cash > 450 and expand_drive > -0.25:
            target_plot = free_plots[0]
            profitable = [
                r for r in RECIPES.values()
                if self._recipe_margin(r, st, target_plot) > 0.10
                and (r.output_item not in TIER_UNLOCK_PROSPERITY or planet.prosperity >= TIER_UNLOCK_PROSPERITY[r.output_item][0] - 0.3)
            ]
            if profitable:
                best_r = max(profitable, key=lambda r: self._recipe_margin(r, st, target_plot) * random.uniform(0.6, 1.4))
                if self.inventory.get("mat", 0) < 10:
                    bid_p = (st.best_ask("mat") or st.signal_price("mat")) * 1.04
                    self._place_bid(tick, st, "mat", 10 - self.inventory.get("mat", 0), bid_p, "ground")
                if self.inventory.get("mat", 0) >= 10 and self.cash >= 100:
                    self.inventory["mat"] -= 10
                    self.cash -= 100
                    target_plot.jobs.append(SiteJob("build", best_r.kind, tick + BUILD_TICKS))
                    self.last_action = f"建{best_r.cn_name}(1周)"

        # 5. Plot expansion
        if not free_plots and self.cash > 1400 and len(self.plots) < 6 and expand_drive > 0.05:
            overhead_120t = 12.0 * (len(self.plots) ** 1.4) * 120.0
            bought_plot = buy_best_plot_for_npc(self, st, planet, bank, overhead_120t)
            if bought_plot:
                self.last_action = bought_plot

        # 6. Limit bids for power, fuel, and production inputs!
        need_pwr = sum(b.recipe.power_cost for _, b in self.all_buildings()) * 3
        if need_pwr > 0 and self.inventory.get("power", 0) < need_pwr:
            bid_p = (st.best_ask("power") or st.signal_price("power")) * 1.05
            self._place_bid(tick, st, "power", need_pwr - self.inventory.get("power", 0), bid_p, "ground")

        if self.inventory.get("fuel", 0) < 8:
            bid_p = (st.best_ask("fuel") or st.signal_price("fuel")) * 1.05
            self._place_bid(tick, st, "fuel", 12, bid_p, "ground")

        for _, b in self.all_buildings():
            for in_item, req_qty in b.recipe.inputs.items():
                total_have = self.inventory.get(in_item, 0) + self.station_pickup.get(in_item, 0)
                if total_have < req_qty * 3:
                    dest = "ground" if in_item in INSTANT_GROUND_ITEMS else "pickup"
                    bid_p = (st.best_ask(in_item) or st.signal_price(in_item)) * 1.04
                    self._place_bid(tick, st, in_item, req_qty * 3 - total_have, bid_p, dest)

        # 7. Dispatch ships (limping slow mode at 0% durability)
        ready_ships = [s for s in self.fleet if tick >= s.busy_until]
        for ship in ready_ships:
            if self.inventory.get("fuel", 0) < ship.spec.fuel_per_trip:
                break
            eff_cap = ship.spec.capacity if ship.durability > 0 else max(5, ship.spec.capacity // 2)
            eff_ticks = ship.spec.launch_ticks if ship.durability > 0 else ship.spec.launch_ticks * 2
            dispatched = False

            # Haul purchased inputs from station_pickup to ground
            for in_item, pk_qty in list(self.station_pickup.items()):
                if pk_qty > 0:
                    take = min(eff_cap, pk_qty, st.inventory.get(in_item, 0))
                    if take > 0:
                        self.station_pickup[in_item] -= take
                        st.inventory[in_item] -= take
                        self.inventory["fuel"] -= ship.spec.fuel_per_trip
                        ship.busy_until = tick + eff_ticks
                        ship.durability = max(0.0, ship.durability - ship.spec.wear_per_trip)
                        in_flight.append(ShipInFlight(self.npc_id, ship.ship_id, "to_npc", in_item, take, tick + eff_ticks))
                        self.last_action = f"{ship.spec.cn_name}运{ITEM_CN[in_item]}×{take}"
                        dispatched = True
                        break
            if dispatched:
                continue

            # Ship physical outputs to station
            for _, b in self.all_buildings():
                out_item = b.recipe.output_item
                if out_item == "power" or out_item in ITEM_TO_SHIP_SIZE:
                    continue
                stock = self.inventory.get(out_item, 0)
                if stock >= b.recipe.output_qty:
                    send_qty = min(eff_cap, stock)
                    self.inventory[out_item] -= send_qty
                    self.inventory["fuel"] -= ship.spec.fuel_per_trip
                    ship.busy_until = tick + eff_ticks
                    ship.durability = max(0.0, ship.durability - ship.spec.wear_per_trip)
                    in_flight.append(ShipInFlight(self.npc_id, ship.ship_id, "to_station", out_item, send_qty, tick + eff_ticks))
                    self.last_action = f"{ship.spec.cn_name}发{ITEM_CN[out_item]}×{send_qty}"
                    break

        # 8. Two-way sell quoting around book mid/best_ask
        quote_items: dict[str, float] = {}
        for _, b in self.all_buildings():
            out_item = b.recipe.output_item
            if out_item not in quote_items:
                out_qty = max(1, int(round(b.recipe.output_qty * b.efficiency)))
                pwr_c = st.signal_price("power") * b.recipe.power_cost
                in_c = sum(st.signal_price(k) * q for k, q in b.recipe.inputs.items())
                quote_items[out_item] = (b.recipe.cash_cost + pwr_c + in_c) / out_qty

        for t_item in self.traded_items:
            if t_item not in quote_items:
                quote_items[t_item] = st.get_ma(t_item, self.genome.lookback_mix) * 0.94

        for out_item, unit_c in quote_items.items():
            at_st = self.station_inventory.get(out_item, 0)
            if at_st <= 0:
                st.asks[out_item] = [o for o in st.asks[out_item] if o.owner_id != self.npc_id]
                continue

            ma = st.get_ma(out_item, self.genome.lookback_mix)
            sig = st.signal_price(out_item)
            margin = (sig - unit_c) / max(0.05, unit_c)
            state = self._build_state(out_item, margin, st, bank, nw)
            _, a_quote, a_trade, _ = self.brain.forward(state)

            if self.genome.trader_bias > 0.50 and a_trade < -0.25 and sig < ma * 0.96:
                ask = round(max(unit_c * 1.02, ma * 1.04), 4)
            else:
                bb = st.best_bid(out_item)
                ba = st.best_ask(out_item)
                ref_quote = (bb + ba) / 2.0 if (bb and ba) else (ba or bb or sig)
                ask = round(max(unit_c * 1.01, ref_quote * (1.0 + a_quote * 0.06)), 4)

            st.place_order(self.npc_id, "sell", out_item, at_st, ask, tick, purpose="station")
            self.last_action = f"卖{ITEM_CN[out_item]}@{ask:.4f}"


@dataclass
class Planet:
    population: float = 6000.0
    wealth: float = 40000.0
    prosperity: float = 1.0
    prosperity_window: deque[float] = field(default_factory=lambda: deque(maxlen=720))
    base_output_per_capita: float = 0.28
    tax_rate: float = 0.10
    demand_wave: float = 1.0
    total_plots: int = 180
    bought_this_tick: dict[str, int] = field(default_factory=dict)
    prev_bids: dict[str, float] = field(default_factory=dict)

    def primary_land_price(self) -> float:
        avail = max(1, len(planet_land_pool))
        return round(400.0 * max(0.5, min(3.0, self.prosperity)) * (self.total_plots / max(20, avail)) * 0.4, 2)

    def unlocked_tier(self) -> int:
        t_max = 1
        for item, (req_p, _) in TIER_UNLOCK_PROSPERITY.items():
            if self.prosperity >= req_p:
                for r in RECIPES.values():
                    if r.output_item == item:
                        t_max = max(t_max, r.tier)
        return t_max

    def place_demands(self, tick: int, st: CLOBStation) -> dict[str, int]:
        if tick % 24 == 0:
            self.demand_wave = max(0.7, min(1.4, self.demand_wave + random.uniform(-0.12, 0.12)))

        self.wealth += self.population * self.base_output_per_capita * self.prosperity
        self.bought_this_tick.clear()

        demands: dict[str, int] = {"power": max(1, int(self.population * 0.004 * self.demand_wave))}
        for item, (req_p, per_cap) in TIER_UNLOCK_PROSPERITY.items():
            if self.prosperity >= req_p:
                demands[item] = max(1, int(self.population * per_cap * self.demand_wave))

        total_units = sum(demands.values())
        per_unit_cap = (self.wealth * 0.12) / max(1, total_units)

        for item, qty in demands.items():
            ba = st.best_ask(item)
            last_p = st.last_trade_price[item]
            if ba is not None:
                # Willing to cross the spread slightly when inventory is low or hungry
                scarcity = max(0.0, 1.2 - self.prosperity)
                bid_p = min(per_unit_cap, ba * (1.02 + 0.3 * scarcity))
            else:
                # No asks available: smoothly escalate previous bid by +3% (bounded by budget!)
                prev = self.prev_bids.get(item, last_p)
                bid_p = min(per_unit_cap, prev * 1.03)
            self.prev_bids[item] = max(0.05, bid_p)
            st.place_order("PLANET", "buy", item, qty, bid_p, tick, purpose="consume")

        return demands

    def finish_tick(self, demands: dict[str, int], bank: PlanetBank) -> float:
        if self.wealth > 80000 and bank.reserves < 150000:
            transfer = (self.wealth - 80000) * 0.2
            self.wealth -= transfer
            bank.reserves += transfer

        sats = [min(1.0, self.bought_this_tick.get(item, 0) / max(1, qty)) for item, qty in demands.items()]
        avg_sat = sum(sats) / max(1, len(sats))
        self.prosperity = max(0.2, self.prosperity + (avg_sat - 0.85) * 0.03)
        self.prosperity_window.append(self.prosperity)
        if len(self.prosperity_window) >= 720:
            win_avg = sum(self.prosperity_window) / len(self.prosperity_window)
            if win_avg > 1.05:
                self.population *= 1.0 + 0.00015 * (win_avg - 1.0)
            elif win_avg < 0.65:
                self.population = max(500.0, self.population * 0.9999)
        return avg_sat


def buy_best_plot_for_npc(
    buyer: SmartNPC, st: CLOBStation, planet: Planet, bank: PlanetBank, overhead_penalty: float
) -> str | None:
    global land_trades_count
    best_choice: tuple[float, str, int] | None = None

    for idx, lst in enumerate(land_listings):
        total_cost = lst.ask_price * (1.0 + LAND_FEE_RATE)
        if lst.seller_id == buyer.npc_id or buyer.cash < total_cost + 250:
            continue
        roi = evaluate_plot_roi(lst.plot, total_cost, st) - overhead_penalty
        if roi > 0 and (best_choice is None or roi > best_choice[0]):
            best_choice = (roi, "listing", idx)

    primary_p = planet.primary_land_price()
    primary_total = primary_p * (1.0 + LAND_FEE_RATE)
    if planet_land_pool and buyer.cash >= primary_total + 300:
        for idx, plot in enumerate(planet_land_pool[:12]):
            roi = evaluate_plot_roi(plot, primary_total, st) - overhead_penalty
            if roi > 0 and (best_choice is None or roi > best_choice[0]):
                best_choice = (roi, "primary", idx)

    if best_choice is None:
        return None

    _, src, idx = best_choice
    if src == "listing":
        lst = land_listings.pop(idx)
        fee = lst.ask_price * LAND_FEE_RATE
        buyer.cash -= lst.ask_price + fee
        planet.wealth += fee
        if lst.seller_id == "BANK":
            pay_debt = min(lst.debt_recovery, lst.ask_price)
            bank.total_loans = max(0.0, bank.total_loans - pay_debt)
            bank.reserves += lst.ask_price
        elif lst.seller_id in npcs:
            npcs[lst.seller_id].cash += lst.ask_price
        buyer.plots.append(lst.plot)
        land_trades_count += 1
        tag = "拍法拍地" if lst.seller_id == "BANK" else "收购地块"
        return f"{tag}#{lst.plot.plot_id}"
    else:
        plot = planet_land_pool.pop(idx)
        fee = primary_p * LAND_FEE_RATE
        buyer.cash -= primary_p + fee
        planet.wealth += primary_p + fee
        buyer.plots.append(plot)
        land_trades_count += 1
        return f"购地#{plot.plot_id}"


def process_bankruptcies_and_startups(tick: int, st: CLOBStation, planet: Planet, bank: PlanetBank) -> None:
    global next_npc_num, bankruptcies_count, startups_count, in_flight

    for lst in land_listings:
        if tick - lst.listed_tick >= 48:
            lst.ask_price = max(120.0, round(lst.ask_price * 0.9, 1))
            lst.listed_tick = tick

    dead_ids: list[str] = []
    for nid, npc in npcs.items():
        liquid = npc.cash + npc.savings
        if liquid < 40 and npc.debt > 200:
            npc.distress_ticks += 1
        else:
            npc.distress_ticks = 0
        if (npc.distress_ticks >= 36 and npc.debt > npc.estimated_asset_value(planet) * 0.75) or npc.distress_ticks >= 120:
            dead_ids.append(nid)

    for nid in dead_ids:
        npc = npcs.pop(nid)
        bankruptcies_count += 1
        st.cancel_owner_orders(nid)
        for item, qty in npc.station_inventory.items():
            if qty > 0:
                st.place_order("BANK", "sell", item, qty, st.signal_price(item) * 0.88, tick)
        for item, qty in npc.station_pickup.items():
            if qty > 0:
                st.place_order("BANK", "sell", item, qty, st.signal_price(item) * 0.88, tick)
        in_flight = [f for f in in_flight if f.owner_id != nid]

        for p in npc.plots:
            est = (planet.primary_land_price() + len(p.buildings) * 180.0) * 0.65
            land_listings.append(LandListing(p, "BANK", round(est, 1), tick, debt_recovery=npc.debt / max(1, len(npc.plots))))

    if tick % 24 == 0:
        max_npcs = 35 + int(planet.population / 200)
        if len(npcs) < max_npcs and (land_listings or planet_land_pool):
            candidates = [
                r for r in RECIPES.values()
                if r.output_item not in TIER_UNLOCK_PROSPERITY or planet.prosperity >= TIER_UNLOCK_PROSPERITY[r.output_item][0] - 0.3
            ]
            best_r = max(candidates, key=lambda r: recipe_profit_per_tick(r, st, 1.0)[0])
            best_m, _ = recipe_profit_per_tick(best_r, st, 1.0)
            if best_m <= 0.10:
                return

            best_src: tuple[float, str, int] | None = None
            for idx, lst in enumerate(land_listings):
                if lst.ask_price <= 1100:
                    roi = evaluate_plot_roi(lst.plot, lst.ask_price, st)
                    if best_src is None or roi > best_src[0]:
                        best_src = (roi, "listing", idx)
            primary_p = planet.primary_land_price()
            for idx, plot in enumerate(planet_land_pool[:12]):
                roi = evaluate_plot_roi(plot, primary_p, st)
                if best_src is None or roi > best_src[0]:
                    best_src = (roi, "primary", idx)

            if best_src is None:
                return
            _, src, idx = best_src
            if src == "listing":
                lst = land_listings.pop(idx)
                new_plot = lst.plot
                buy_cost = lst.ask_price
                if lst.seller_id == "BANK":
                    bank.total_loans = max(0.0, bank.total_loans - min(lst.debt_recovery, buy_cost))
                    bank.reserves += buy_cost
                elif lst.seller_id in npcs:
                    npcs[lst.seller_id].cash += buy_cost
            else:
                new_plot = planet_land_pool.pop(idx)
                buy_cost = primary_p
                planet.wealth += buy_cost

            if len(npcs) >= 4:
                ranked = sorted(npcs.values(), key=lambda n: -n.live_net_worth(planet, st))
                elite = ranked[:max(2, len(ranked) // 4)]
                p1, p2 = random.sample(elite, 2)
                child_genome = Genome.crossover(p1.genome, p2.genome)
                child_brain = PolicyBrain.crossover(p1.brain, p2.brain)
                child_gen = max(p1.generation, p2.generation) + 1
            else:
                child_genome = Genome.random()
                child_brain = PolicyBrain.random()
                child_gen = 1

            loan = 700.0 if bank.reserves > 1000 else 0.0
            if loan > 0:
                bank.reserves -= loan
                bank.total_loans += loan
            seed_cash = max(450.0, 800.0 + loan - buy_cost)
            if not new_plot.buildings:
                eff = new_plot.terrain_mods.get(best_r.kind, 1.0)
                new_plot.buildings.append(Building(best_r, efficiency=eff))
            nid = f"企业-{next_npc_num:02d}"
            next_npc_num += 1
            npcs[nid] = SmartNPC(
                nid,
                genome=child_genome,
                brain=child_brain,
                generation=child_gen,
                plots=[new_plot],
                cash=seed_cash,
                debt=loan,
                last_action=f"G{child_gen}新创({best_r.cn_name})",
            )
            startups_count += 1


_ship_seq = 1


def new_ship(size: str) -> Ship:
    global _ship_seq
    s = Ship(_ship_seq, size)
    _ship_seq += 1
    return s


STATE_LOCK = threading.Lock()
TIMEFRAMES = (1, 5, 24, 168)

station = CLOBStation()
planet = Planet()
bank = PlanetBank()
INITIAL_KINDS = ["PowerPlant", "FuelPlant", "FoodFarm", "IronMine", "Smelter", "MatFactory", "AlloyPlant", "PartsPlant", "RepairPlant", "SmallYard"]

planet_land_pool: list[Plot] = []
for pid in range(1, planet.total_plots + 1):
    t_name, t_mods = generate_terrain()
    planet_land_pool.append(Plot(pid, t_name, t_mods))

land_listings: list[LandListing] = []
npcs: dict[str, SmartNPC] = {}
for i in range(50):
    nid = f"企业-{i+1:02d}"
    plot = planet_land_pool.pop(0)
    kind = INITIAL_KINDS[i % len(INITIAL_KINDS)]
    plot.buildings.append(Building(RECIPES[kind], efficiency=plot.terrain_mods.get(kind, 1.0)))
    npcs[nid] = SmartNPC(nid, genome=Genome.random(), brain=PolicyBrain.random(), generation=1, plots=[plot])

next_npc_num = 51
bankruptcies_count = 0
startups_count = 0
land_trades_count = 0

in_flight: list[ShipInFlight] = []
tick_count = 0
sim_speed = 10

ALL_ITEMS = tuple(BASE_PRICES.keys()) + ("bank_rate",)
candles: dict[int, dict[str, list[dict[str, float]]]] = {tf: {k: [] for k in ALL_ITEMS} for tf in TIMEFRAMES}
current_bar: dict[int, dict[str, dict[str, float] | None]] = {tf: {k: None for k in ALL_ITEMS} for tf in TIMEFRAMES}
macro_history: list[dict[str, float | int]] = []


def step_one_tick() -> None:
    global tick_count, in_flight
    tick_count += 1
    t = tick_count

    for npc in list(npcs.values()):
        npc.apply_bank_and_overhead(bank, planet)
        npc.step_production_and_jobs(t, station)

    still_flying: list[ShipInFlight] = []
    for f in in_flight:
        if f.arrival_tick <= t:
            if f.owner_id in npcs:
                if f.direction == "to_station":
                    station.inventory[f.item] = station.inventory.get(f.item, 0) + f.qty
                    npcs[f.owner_id].station_inventory[f.item] = npcs[f.owner_id].station_inventory.get(f.item, 0) + f.qty
                else:
                    npcs[f.owner_id].inventory[f.item] = npcs[f.owner_id].inventory.get(f.item, 0) + f.qty
        else:
            still_flying.append(f)
    in_flight = still_flying

    for npc in list(npcs.values()):
        npc.decide(t, station, bank, planet)

    demands = planet.place_demands(t, station)
    station.match_all(planet, bank)
    planet.finish_tick(demands, bank)
    station.update_mas()
    bank.update_policy(planet, station)
    process_bankruptcies_and_startups(t, station, planet, bank)

    for item in ALL_ITEMS:
        p = bank.annual_rate_pct if item == "bank_rate" else station.signal_price(item)
        for tf in TIMEFRAMES:
            bar = current_bar[tf][item]
            if bar is None:
                current_bar[tf][item] = {"t": t, "o": p, "h": p, "l": p, "c": p}
            else:
                bar["h"] = max(bar["h"], p)
                bar["l"] = min(bar["l"], p)
                bar["c"] = p
            if t % tf == 0:
                candles[tf][item].append(current_bar[tf][item])  # type: ignore[arg-type]
                del candles[tf][item][:-5000]
                current_bar[tf][item] = None

    if t % 5 == 0:
        macro_history.append({
            "t": t,
            "pop": round(planet.population, 1),
            "prosp": round(planet.prosperity, 2),
            "loans": round(bank.total_loans, 1),
            "deps": round(bank.total_deposits, 1),
            "wealth": round(planet.wealth, 1),
            "npcs": len(npcs),
            "bankrupt": bankruptcies_count,
            "startups": startups_count,
            "land_p": planet.primary_land_price(),
            "land_avail": len(planet_land_pool) + len(land_listings),
        })
        del macro_history[:-5000]


def sim_loop() -> None:
    acc = 0.0
    last_time = time.monotonic()
    while True:
        time.sleep(0.02)
        now = time.monotonic()
        dt = min(0.25, now - last_time)
        last_time = now
        with STATE_LOCK:
            acc += dt * sim_speed
            steps = min(50, int(acc))
            acc -= steps
            for _ in range(steps):
                step_one_tick()


def format_fleet(fleet: list[Ship]) -> str:
    counts = {"small": 0, "medium": 0, "large": 0}
    for s in fleet:
        counts[s.size] = counts.get(s.size, 0) + 1
    parts = []
    if counts["small"]:
        parts.append(f"{counts['small']}小")
    if counts["medium"]:
        parts.append(f"{counts['medium']}中")
    if counts["large"]:
        parts.append(f"{counts['large']}大")
    avg_dur = sum(s.durability for s in fleet) / max(1, len(fleet))
    return f"{'+'.join(parts)}({avg_dur:.0f}%)"


class Handler(BaseHTTPRequestHandler):
    def log_message(self, format: str, *args: object) -> None:
        return

    def do_GET(self) -> None:
        parsed = urlparse(self.path)
        if parsed.path == "/" or parsed.path == "/index.html":
            html = Path(__file__).with_name("index.html").read_bytes()
            self.send_response(200)
            self.send_header("Content-Type", "text/html; charset=utf-8")
            self.end_headers()
            self.wfile.write(html)
        elif parsed.path == "/api/speed":
            global sim_speed
            qs = parse_qs(parsed.query)
            try:
                v = int(qs.get("v", [str(sim_speed)])[0])
                with STATE_LOCK:
                    sim_speed = max(1, min(1000, v))
            except ValueError:
                pass
            data = json.dumps({"speed": sim_speed}).encode("utf-8")
            self.send_response(200)
            self.send_header("Content-Type", "application/json; charset=utf-8")
            self.end_headers()
            self.wfile.write(data)
        elif parsed.path == "/api/state":
            qs = parse_qs(parsed.query)
            req_item = qs.get("item", ["food"])[0]
            if req_item not in ALL_ITEMS:
                req_item = "food"
            req_tf = int(qs.get("tf", ["5"])[0])
            if req_tf not in TIMEFRAMES:
                req_tf = 5
            since_t = int(qs.get("since", ["-1"])[0])
            macro_since = int(qs.get("macro_since", ["-1"])[0])
            with STATE_LOCK:
                cur_b = current_bar[req_tf][req_item]
                all_bars = candles[req_tf][req_item] + ([cur_b] if cur_b else [])
                bars = [b for b in all_bars if b["t"] >= since_t] if since_t >= 0 else all_bars
                macros = [m for m in macro_history if int(m["t"]) > macro_since] if macro_since >= 0 else macro_history
                prices = {k: station.signal_price(k) for k in BASE_PRICES}
                prices["bank_rate"] = round(bank.annual_rate_pct, 4)

                factory_dist = {RECIPES[k].cn_name: 0 for k in RECIPES}
                n_cnt = max(1, len(npcs))
                avg_trader = sum(n.genome.trader_bias for n in npcs.values()) / n_cnt
                avg_lev = sum(n.genome.max_leverage for n in npcs.values()) / n_cnt
                avg_horizon = sum(n.genome.lookback_mix for n in npcs.values()) / n_cnt
                max_gen = max((n.generation for n in npcs.values()), default=1)
                for n in npcs.values():
                    for _, b in n.all_buildings():
                        fcn = b.recipe.cn_name
                        factory_dist[fcn] = factory_dist.get(fcn, 0) + 1

                genome_stats = {
                    "最高进化世代": max_gen,
                    "平均商贩囤货基因(%)": round(avg_trader * 100, 1),
                    "平均杠杆容忍(%)": round(avg_lev * 100, 1),
                    "平均长线视界(%)": round(avg_horizon * 100, 1),
                }

                payload = {
                    "tick": tick_count,
                    "speed": sim_speed,
                    "item": req_item,
                    "item_cn": ITEM_CN.get(req_item, req_item),
                    "tf": req_tf,
                    "planet": {
                        "population": round(planet.population, 1),
                        "wealth": round(planet.wealth, 1),
                        "prosperity": round(planet.prosperity, 2),
                        "unlocked_tier": planet.unlocked_tier(),
                        "land_avail": len(planet_land_pool) + len(land_listings),
                        "land_price": planet.primary_land_price(),
                    },
                    "lifecycle": {
                        "npc_count": len(npcs),
                        "bankruptcies": bankruptcies_count,
                        "startups": startups_count,
                        "land_trades": land_trades_count,
                    },
                    "bank": {
                        "rate": round(bank.annual_rate_pct, 2),
                        "reserves": round(bank.reserves, 1),
                        "deposits": round(bank.total_deposits, 1),
                        "loans": round(bank.total_loans, 1),
                    },
                    "prices": prices,
                    "bars": bars,
                    "macros": macros,
                    "dist": {"factories": factory_dist, "genomes": genome_stats},
                    "npcs": sorted(
                        [
                            {
                                "id": n.npc_id,
                                "terrains": "/".join(p.terrain_name for p in n.plots),
                                "plots_count": len(n.plots),
                                "profile": n.emergent_profile(),
                                "fleet": format_fleet(n.fleet),
                                "net_worth": round(n.live_net_worth(planet, station), 1),
                                "cash": round(n.cash, 1),
                                "savings": round(n.savings, 1),
                                "debt": round(n.debt, 1),
                                "factories": ", ".join(f"{b.recipe.cn_name}({b.efficiency})" for _, b in n.all_buildings()),
                                "slots": f"{n.total_buildings()}/{n.total_capacity()}",
                                "action": n.last_action,
                            }
                            for n in npcs.values()
                        ],
                        key=lambda x: -x["net_worth"],
                    ),
                }
            data = json.dumps(payload, ensure_ascii=False).encode("utf-8")
            self.send_response(200)
            self.send_header("Content-Type", "application/json; charset=utf-8")
            self.end_headers()
            self.wfile.write(data)
        else:
            self.send_error(404)


if __name__ == "__main__":
    threading.Thread(target=sim_loop, daemon=True).start()
    print("Meridian server running at http://127.0.0.1:8000 (Two-Way CLOB + Neuroevolution)")
    ThreadingHTTPServer(("127.0.0.1", 8000), Handler).serve_forever()

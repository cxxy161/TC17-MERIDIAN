"""Planet (252-tile geography, oceans, vertical city upgrades) and per-planet PlanetBank."""

import random
from collections import deque
from dataclasses import dataclass, field

from sim.config import BIOME_TERRAIN_MODS, PLANET_EXCLUSIVE_ORE, PLANET_TILE_COUNT, RECIPES, TIER_UNLOCK_PROSPERITY
from sim.exchange import CLOBStation
from sim.models import LandListing, Plot


@dataclass
class PlanetBank:
    """Independent central/commercial bank belonging to a single planet."""

    planet_id: str
    annual_rate_pct: float = 5.0
    reserves: float = 40000.0
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
        target_rate += min(8.0, util * 3.0)
        target_rate = max(0.5, min(18.0, target_rate))
        self.annual_rate_pct = round(self.annual_rate_pct * 0.85 + target_rate * 0.15, 4)


@dataclass
class Planet:
    planet_id: str
    name: str
    archetype: str
    orbit_radius: float
    orbit_period_days: int
    orbit_angle: float
    gravity: float
    solar_mult: float
    mineral_mult: float
    ocean_ratio: float
    biome_weights: dict[str, float]
    unique_ore: str = ""
    city_count: int = 0
    population: float = 0.0
    city_level: int = 1
    city_capacity: float = 0.0
    wealth: float = 20000.0
    prosperity: float = 1.0
    instant_prosperity: float = 1.0
    prosperity_window: deque[float] = field(default_factory=lambda: deque(maxlen=720))
    unlocked_items: dict[str, int] = field(default_factory=dict)
    last_tier_unlock_tick: int = -360
    base_output_per_capita: float = 0.28
    tax_rate: float = 0.10
    demand_wave: float = 1.0

    station: CLOBStation = field(init=False)
    bank: PlanetBank = field(init=False)
    land_pool: list[Plot] = field(default_factory=list)
    land_listings: list[LandListing] = field(default_factory=list)
    bought_this_tick: dict[str, int] = field(default_factory=dict)
    prev_bids: dict[str, float] = field(default_factory=dict)
    last_demands: dict[str, int] = field(default_factory=dict)
    last_bought: dict[str, int] = field(default_factory=dict)
    total_developable_plots: int = 0
    cpi: float = 1.0
    pending_remittances: float = 0.0

    def __post_init__(self) -> None:
        self.station = CLOBStation(f"ST:{self.planet_id}", seed_scale=1.0 if self.city_count > 0 else 0.5)
        self.bank = PlanetBank(self.planet_id, reserves=60000.0 if self.city_count > 0 else 30000.0)
        self.city_capacity = self.city_count * 3000.0
        self.prosperity_window.append(0.82)
        if self.city_count > 0:
            for item, (req_p, _) in TIER_UNLOCK_PROSPERITY.items():
                if self.prosperity >= req_p:
                    self.unlocked_items[item] = -360
        self._generate_252_tiles()

    def _generate_252_tiles(self) -> None:
        biomes = list(self.biome_weights.keys())
        weights = list(self.biome_weights.values())
        land_plots: list[Plot] = []

        for pid in range(1, PLANET_TILE_COUNT + 1):
            is_pent = pid <= 12
            is_ocean = random.random() < self.ocean_ratio
            b_name = "海洋" if is_ocean else random.choices(biomes, weights=weights, k=1)[0]
            mods: dict[str, float] = {}
            spec = BIOME_TERRAIN_MODS.get(b_name, {})
            for kind in RECIPES:
                if kind in PLANET_EXCLUSIVE_ORE and PLANET_EXCLUSIVE_ORE[kind] != self.unique_ore:
                    mods[kind] = 0.0
                    continue
                lo, hi = spec.get(kind, (0.90, 1.15))
                val = random.uniform(lo, hi)
                if kind in ("IronMine", "TitaniumMine", "SilicateMine", "HeliumExtractor"):
                    val *= self.mineral_mult
                elif kind == "PowerPlant":
                    val *= self.solar_mult
                mods[kind] = round(val, 2)
            plot = Plot(pid, self.planet_id, b_name, mods, is_ocean=is_ocean, is_pentagon=is_pent)
            if not is_ocean:
                land_plots.append(plot)

        # Assign fixed city tiles on habitable planets (unpurchasable, vertical expansion only)
        if self.city_count > 0 and land_plots:
            random.shuffle(land_plots)
            for _ in range(min(self.city_count, len(land_plots))):
                c_plot = land_plots.pop(0)
                c_plot.is_city = True
                c_plot.terrain_name = "城市核心"

        self.land_pool = land_plots
        self.total_developable_plots = max(1, len(land_plots))

    def can_build_recipe(self, kind: str) -> bool:
        req = PLANET_EXCLUSIVE_ORE.get(kind)
        return req is None or req == self.unique_ore

    def launch_ticks_mult(self) -> float:
        return 0.6 + self.gravity * 0.7

    def launch_fuel_mult(self) -> float:
        return 0.6 + self.gravity * 0.8

    def primary_land_price(self) -> float:
        avail = max(1, len(self.land_pool))
        return round(380.0 * self.cpi * max(0.5, min(3.0, self.prosperity)) * (self.total_developable_plots / max(15, avail)) * 0.4, 2)

    def _sync_unlocked_tiers(self, tick: int) -> None:
        """Unlock at most one tier per build cycle with hysteresis & cooldown protection."""
        if self.city_count == 0:
            return
        unlocked_one = False
        for item, (req_p, _) in TIER_UNLOCK_PROSPERITY.items():
            if item in self.unlocked_items:
                age = tick - self.unlocked_items[item]
                downgrade_req = max(0.25, req_p * 0.80 - 0.05)
                if req_p > 0.25 and age >= 480 and self.prosperity < downgrade_req:
                    del self.unlocked_items[item]
            elif not unlocked_one and (tick - self.last_tier_unlock_tick) >= 168 and self.prosperity >= req_p:
                self.unlocked_items[item] = tick
                self.last_tier_unlock_tick = tick
                unlocked_one = True

    def unlocked_tier(self) -> int:
        if self.city_count == 0:
            return 0
        t_max = 1
        for item in self.unlocked_items:
            for r in RECIPES.values():
                if r.output_item == item:
                    t_max = max(t_max, r.tier)
        return t_max

    def place_demands(self, tick: int) -> dict[str, int]:
        if self.city_count == 0 or self.population <= 0:
            return {}

        if tick % 24 == 0:
            self.demand_wave = max(0.7, min(1.4, self.demand_wave + random.uniform(-0.12, 0.12)))

        self._sync_unlocked_tiers(tick)
        # Main consumer purchasing power comes from factory wages & rents; keep only a minor civic subsistence trickle
        self.wealth += self.population * 0.03 * self.prosperity * self.cpi
        self.last_bought = dict(self.bought_this_tick)
        self.bought_this_tick.clear()

        demands: dict[str, int] = {"power": max(1, int(self.population * 0.004 * self.demand_wave))}
        for item, unlock_tick in self.unlocked_items.items():
            _, per_cap = TIER_UNLOCK_PROSPERITY[item]
            age = max(0, tick - unlock_tick)
            ramp = min(1.0, 0.25 + 0.75 * (age / 288.0))
            demands[item] = max(1, int(self.population * per_cap * self.demand_wave * ramp))

        # City vertical upgrade demand: extra mat & steel when population nears city_capacity
        if self.population >= self.city_capacity * 0.82:
            demands["mat"] = demands.get("mat", 0) + max(2, int(self.city_level * 2))
            demands["steel"] = demands.get("steel", 0) + max(2, int(self.city_level * 2))

        # Wallet-constrained budgeting (no hardcoded price ceiling; shortage raises item budget share)
        budget = max(0.0, self.wealth * 0.16)
        item_weights: dict[str, float] = {}
        for item, qty in demands.items():
            prev_q = self.last_demands.get(item, qty)
            prev_sat = min(1.0, self.last_bought.get(item, 0) / max(1, prev_q))
            urgency = 1.0 + 1.5 * (1.0 - prev_sat)
            ba = self.station.best_ask(item)
            ref_p = ba if ba is not None else max(self.station.last_trade_price[item], 0.05 * self.cpi)
            item_weights[item] = max(0.05, qty * ref_p * urgency)
        total_weight = max(0.1, sum(item_weights.values()))

        for item, qty in demands.items():
            item_cap = (budget * (item_weights[item] / total_weight)) / max(1, qty)
            ba = self.station.best_ask(item)
            last_p = self.station.last_trade_price[item]
            if ba is not None:
                bid_p = min(item_cap, ba * 1.03)
            else:
                prev = self.prev_bids.get(item, last_p)
                bid_p = min(item_cap, max(last_p * 1.08, prev * 1.02))
            bid_p = max(0.02 * self.cpi, bid_p)
            self.prev_bids[item] = bid_p
            self.station.place_order(f"PLANET:{self.planet_id}", "buy", item, qty, bid_p, tick, purpose="consume")

        self.last_demands = dict(demands)
        return demands

    def finish_tick(self, demands: dict[str, int], tick: int = 0) -> float:
        # Keep liquidity circulating: non-city planets route excess tax/land wealth to local bank reserves;
        # habitable planets recycle fiscal surplus using CPI-scaled thresholds.
        c = self.cpi
        if self.city_count == 0 and self.wealth > 12000.0 * c:
            transfer = (self.wealth - 12000.0 * c) * 0.25
            self.wealth -= transfer
            self.bank.reserves += transfer
        elif self.city_count > 0 and self.wealth > 160000.0 * c and self.bank.reserves < 60000.0 * c:
            transfer = (self.wealth - 160000.0 * c) * 0.15
            self.wealth -= transfer
            self.bank.reserves += transfer
        elif self.city_count > 0 and self.bank.reserves > 220000.0 * c and self.wealth < 100000.0 * c:
            # Return excess idle bank capital back into active city demand
            dividend = (self.bank.reserves - 220000.0 * c) * 0.05
            self.bank.reserves -= dividend
            self.wealth += dividend

        if not demands:
            return 1.0

        sat_sum = 0.0
        w_sum = 0.0
        mature_shortage = False
        for item, qty in demands.items():
            bought = self.bought_this_tick.get(item, 0)
            sat = min(1.0, bought / max(1, qty))
            in_cold_start = (
                item in self.unlocked_items
                and (tick - self.unlocked_items[item]) < 288
            )
            if not in_cold_start and sat < 0.45:
                mature_shortage = True
            w = 0.10 if (in_cold_start and bought == 0) else 1.0
            sat_sum += sat * w
            w_sum += w
        avg_sat = sat_sum / max(0.1, w_sum)

        # Store bounded satisfaction ratio in window (prevents integrator windup!)
        self.prosperity_window.append(avg_sat)
        self.instant_prosperity = max(0.2, self.prosperity * (0.75 + 0.45 * avg_sat))

        # Dynamic window over satisfaction: 240 ticks (10d) when calm, up to 720 ticks (30d) when volatile
        win_list = list(self.prosperity_window)
        recent = win_list[-168:]
        spread = (max(recent) - min(recent)) if recent else 0.0
        eff_win = int(min(720, max(240, 240 + max(0.0, spread - 0.15) * 1200.0)))
        eff_slice = win_list[-eff_win:]
        win_sat = sum(eff_slice) / len(eff_slice)

        # Macro prosperity moves gradually with neutral deadband [0.68, 0.80]
        if win_sat > 0.80 and (not mature_shortage or win_sat > 0.86):
            rate = 0.004 if not mature_shortage else 0.0015
            delta = min(0.0008, (win_sat - 0.80) * rate)
        elif win_sat < 0.68:
            delta = max(-0.0005, (win_sat - 0.68) * 0.0025)
        else:
            delta = 0.0
        self.prosperity = max(0.2, self.prosperity + delta)

        # Vertical city upgrade when mat & steel bought while near capacity
        if self.population >= self.city_capacity * 0.85 and self.bought_this_tick.get("mat", 0) >= 2:
            self.city_level += 1
            self.city_capacity += self.city_count * 2500.0

        if len(win_list) >= 240:
            if self.prosperity > 0.85:
                grown = self.population * (1.0 + 0.00018 * (self.prosperity - 0.75))
                self.population = min(self.city_capacity, grown)
            elif self.prosperity < 0.55:
                self.population = max(500.0, self.population * 0.99992)
        return avg_sat

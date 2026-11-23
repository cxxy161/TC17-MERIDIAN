"""Full-brain controlled companies (MarketBrain + FirmBrain + ScorerBrain) & interplanetary Hub logistics."""

import random
from dataclasses import dataclass, field

from sim.config import (
    BASE_PRICES,
    BUILD_TICKS,
    DEMOLISH_TICKS,
    INSTANT_GROUND_ITEMS,
    ITEM_CN,
    ITEM_TO_SHIP_SIZE,
    LAND_FEE_RATE,
    RECIPES,
    SHIP_SPECS,
    Recipe,
)
from sim.exchange import CLOBStation
from sim.models import Building, Genome, LandListing, Plot, PolicyBrain, Ship, ShipInFlight, SiteJob, new_ship
from sim.planet import Planet, PlanetBank


def effective_item_value(
    item: str, st: CLOBStation, cpi: float = 1.0, hub: CLOBStation | None = None, depth: int = 0
) -> float:
    """Market value of an item; when extinct (0 inv & no asks), derive value from bids/downstream/CPI."""
    sig = st.signal_price(item)
    if st.inventory.get(item, 0) > 0 or st.best_ask(item) is not None:
        return sig
    best = max(sig, st.best_bid(item) or 0.0, BASE_PRICES.get(item, 10.0) * cpi)
    if hub is not None:
        best = max(best, hub.best_bid(item) or 0.0)
    if depth < 1:
        pwr_c_unit = st.signal_price("power")
        for dr in RECIPES.values():
            req_q = dr.inputs.get(item, 0)
            if req_q <= 0:
                continue
            out_v = effective_item_value(dr.output_item, st, cpi, hub, depth + 1)
            other_in = sum(
                (st.signal_price(k) if (st.inventory.get(k, 0) > 0 or st.best_ask(k) is not None) else BASE_PRICES.get(k, 10.0) * cpi) * q
                for k, q in dr.inputs.items()
                if k != item
            )
            gross_margin = dr.output_qty * out_v - pwr_c_unit * dr.power_cost - other_in - dr.cash_cost * cpi
            implied = gross_margin / req_q
            if implied > best:
                best = implied
    return best


def recipe_profit_per_tick(
    r: Recipe, st: CLOBStation, eff: float, sell_override: float | None = None, cpi: float = 1.0, hub: CLOBStation | None = None
) -> tuple[float, float]:
    out_qty = max(1, int(round(r.output_qty * eff)))
    sell_p = sell_override if sell_override is not None else effective_item_value(r.output_item, st, cpi, hub)
    in_c = sum(st.signal_price(k) * q for k, q in r.inputs.items())
    pwr_c = st.signal_price("power") * r.power_cost
    cycle_total_cost = r.cash_cost * cpi + pwr_c + in_c
    unit_c = cycle_total_cost / out_qty
    margin = (sell_p - unit_c) / max(0.05 * cpi, unit_c)
    profit_per_tick = (sell_p * out_qty - cycle_total_cost) / r.cycle_ticks
    return margin, profit_per_tick


def evaluate_plot_roi(plot: Plot, ask_price: float, st: CLOBStation, cpi: float = 1.0, hub: CLOBStation | None = None) -> float:
    existing_profit = 0.0
    for b in plot.buildings:
        _, p_tick = recipe_profit_per_tick(b.recipe, st, b.efficiency, None, cpi, hub)
        existing_profit += max(0.0, p_tick)
    free_slots = plot.capacity - plot.used_slots()
    best_r_profit = max(
        (
            recipe_profit_per_tick(r, st, plot.terrain_mods.get(r.kind, 1.0), None, cpi, hub)[1]
            for r in RECIPES.values()
            if plot.terrain_mods.get(r.kind, 1.0) > 0.0
        ),
        default=0.0,
    )
    mat_build_cost = 10.0 * st.signal_price("mat") + 100.0 * cpi
    potential_profit = free_slots * max(0.0, best_r_profit * 80.0 - mat_build_cost * 0.5)
    return existing_profit * 120.0 + potential_profit - ask_price


@dataclass(slots=True)
class SmartNPC:
    npc_id: str
    home_planet_id: str
    genome: Genome = field(default_factory=Genome.random)
    brain: PolicyBrain = field(default_factory=PolicyBrain.random)
    generation: int = 1
    plots: list[Plot] = field(default_factory=list)
    fleet: list[Ship] = field(default_factory=list)
    cash: float = 2200.0
    savings: float = 0.0
    debt: float = 0.0
    inventory: dict[str, int] = field(default_factory=lambda: {"fuel": 24, "power": 30, "repair_parts": 3})
    station_inventories: dict[str, dict[str, int]] = field(default_factory=dict)
    station_pickups: dict[str, dict[str, int]] = field(default_factory=dict)
    distress_ticks: int = 0
    last_action: str = "初始化"
    traded_items: list[str] = field(default_factory=list)
    hub_arb_items: dict[str, int] = field(default_factory=dict)
    ship_home_station: dict[int, str] = field(default_factory=dict)
    # Live emergent telemetry from neural outputs (for monitor UI)
    brain_lev: float = 0.75
    brain_expand: float = 0.0
    brain_arb: float = 0.0
    brain_lookback: float = 0.5

    def __post_init__(self) -> None:
        if not self.fleet:
            # Initial ship size reflects brain fleet bias before any market history exists
            sz = "medium" if self.brain.firm.b[3] > 0.15 else "small"
            s = new_ship(sz)
            self.fleet.append(s)
            self.ship_home_station[s.ship_id] = f"ST:{self.home_planet_id}"

    def get_st_inv(self, sid: str, item: str) -> int:
        return self.station_inventories.get(sid, {}).get(item, 0)

    def add_st_inv(self, sid: str, item: str, delta: int) -> None:
        d = self.station_inventories.setdefault(sid, {})
        d[item] = max(0, d.get(item, 0) + delta)

    def get_st_pickup(self, sid: str, item: str) -> int:
        return self.station_pickups.get(sid, {}).get(item, 0)

    def add_st_pickup(self, sid: str, item: str, delta: int) -> None:
        d = self.station_pickups.setdefault(sid, {})
        d[item] = max(0, d.get(item, 0) + delta)

    def all_buildings(self) -> list[tuple[Plot, Building]]:
        return [(p, b) for p in self.plots for b in p.buildings]

    def total_buildings(self) -> int:
        return sum(len(p.buildings) for p in self.plots)

    def live_net_worth(self, planet: Planet, stations: dict[str, CLOBStation]) -> float:
        st = planet.station
        land_val = len(self.plots) * planet.primary_land_price()
        mat_price = st.signal_price("mat")
        factory_val = self.total_buildings() * (10.0 * mat_price + 100.0 * planet.cpi)
        fleet_val = sum(st.signal_price(s.spec.item_key) * (s.durability / 100.0) for s in self.fleet)
        inv_val = sum(qty * st.signal_price(item) for item, qty in self.inventory.items())
        st_val = 0.0
        for sid, d in self.station_inventories.items():
            s_obj = stations.get(sid, st)
            st_val += sum(q * s_obj.signal_price(it) for it, q in d.items())
        for sid, d in self.station_pickups.items():
            s_obj = stations.get(sid, st)
            st_val += sum(q * s_obj.signal_price(it) for it, q in d.items())
        return self.cash + self.savings - self.debt + land_val + factory_val + fleet_val + inv_val + st_val

    def estimated_asset_value(self, planet: Planet) -> float:
        c = planet.cpi
        return len(self.plots) * planet.primary_land_price() * 0.8 + self.total_buildings() * 180.0 * c + len(self.fleet) * 300.0 * c + self.cash + self.savings

    def apply_bank_and_overhead(self, planet: Planet) -> None:
        bank = planet.bank
        if self.savings > 0:
            interest = self.savings * bank.deposit_tick_rate()
            self.savings += interest
            bank.total_deposits += interest
        if self.debt > 0:
            interest = self.debt * bank.loan_tick_rate()
            self.debt += interest
            bank.total_loans += interest
        k = len(self.plots)
        b_cnt = self.total_buildings()
        overhead = (0.25 + 0.10 * b_cnt + (12.0 * ((k - 1) ** 1.4) if k > 1 else 0.0)) * planet.cpi
        pay = min(self.cash, overhead)
        if pay > 0:
            self.cash -= pay
            self._pay_wages(planet, pay)

    @staticmethod
    def _pay_wages(planet: Planet, amount: float) -> None:
        if amount <= 0:
            return
        if planet.city_count > 0:
            planet.wealth += amount
        else:
            planet.wealth += amount * 0.35
            planet.pending_remittances += amount * 0.65

    def _consume_standby(self, b: Building, planet: Planet, wage: float) -> None:
        r = b.recipe
        sp = r.standby_power_cost
        if sp > 0:
            if self.inventory.get("power", 0) >= sp:
                self.inventory["power"] -= sp
                b.cold_ticks = 0
            else:
                b.cold_ticks += r.cycle_ticks
                b.efficiency = max(0.55, round(b.efficiency * 0.994, 3))
        standby_wage = round(wage * 0.15, 4)
        paid = min(self.cash, standby_wage)
        if paid > 0:
            self.cash -= paid
            self._pay_wages(planet, paid)

    def step_production_and_jobs(self, tick: int, planet: Planet) -> None:
        st = planet.station
        cpi = planet.cpi
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
                wage = round(r.cash_cost * cpi, 4)
                if b.state_cooldown > 0:
                    b.state_cooldown -= 1

                if b.active_batch:
                    b.progress += 1
                    if b.progress >= r.cycle_ticks:
                        out_qty = max(1, int(round(r.output_qty * b.efficiency)))
                        if r.output_item == "power" or r.output_item in ITEM_TO_SHIP_SIZE:
                            st.inventory[r.output_item] = st.inventory.get(r.output_item, 0) + out_qty
                            self.add_st_inv(st.station_id, r.output_item, out_qty)
                        else:
                            self.inventory[r.output_item] = self.inventory.get(r.output_item, 0) + out_qty
                        b.active_batch = False
                        b.progress = 0

                if b.state == "idle":
                    b.standby_ticks += 1
                    if b.standby_ticks >= r.cycle_ticks:
                        b.standby_ticks = 0
                        self._consume_standby(b, planet, wage)
                    if b.target_active and b.state_cooldown == 0:
                        init_fee = round(wage * 0.5, 4)
                        init_pwr = r.standby_power_cost
                        if self.cash >= init_fee and self.inventory.get("power", 0) >= init_pwr:
                            self.cash -= init_fee
                            self._pay_wages(planet, init_fee)
                            if init_pwr > 0:
                                self.inventory["power"] -= init_pwr
                            b.state = "starting"
                            b.warmup_progress = 0
                            b.state_cooldown = 4
                elif b.state == "starting":
                    if not b.target_active and b.state_cooldown == 0:
                        b.state = "idle"
                        b.warmup_progress = 0
                        b.state_cooldown = 4
                    else:
                        warm_ok = True
                        if b.warmup_progress % r.cycle_ticks == 0:
                            sp = r.standby_power_cost
                            w_cost = round(wage * 0.45, 4)
                            if (sp == 0 or self.inventory.get("power", 0) >= sp) and self.cash >= w_cost:
                                if sp > 0:
                                    self.inventory["power"] -= sp
                                self.cash -= w_cost
                                self._pay_wages(planet, w_cost)
                            else:
                                warm_ok = False
                        if warm_ok:
                            b.warmup_progress += 1
                            if b.warmup_progress >= r.startup_ticks:
                                b.state = "running"
                                b.warmup_progress = 0
                                b.standby_ticks = 0
                                b.cold_ticks = 0
                                b.state_cooldown = 6
                else:  # b.state == "running"
                    if not b.active_batch and not b.target_active and b.state_cooldown == 0:
                        shut_fee = min(self.cash, round(wage * 0.25, 4))
                        if shut_fee > 0:
                            self.cash -= shut_fee
                            self._pay_wages(planet, shut_fee)
                        b.state = "idle"
                        b.standby_ticks = 0
                        b.state_cooldown = 6
                    elif not b.active_batch and b.target_active:
                        has_pwr = self.inventory.get("power", 0) >= r.power_cost
                        has_in = all(self.inventory.get(k, 0) >= q for k, q in r.inputs.items())
                        if has_pwr and has_in and self.cash >= wage:
                            self.cash -= wage
                            self._pay_wages(planet, wage)
                            self.inventory["power"] -= r.power_cost
                            for k, q in r.inputs.items():
                                self.inventory[k] -= q
                            b.active_batch = True
                            b.progress = 0
                            b.standby_ticks = 0
                        elif r.kind == "PowerPlant" and self.cash >= wage:
                            self.cash -= wage
                            self._pay_wages(planet, wage)
                            b.active_batch = True
                            b.progress = 0
                            b.standby_ticks = 0
                        else:
                            b.standby_ticks += 1
                            if b.standby_ticks >= r.cycle_ticks:
                                b.standby_ticks = 0
                                self._consume_standby(b, planet, wage)
                    elif not b.active_batch:
                        b.standby_ticks += 1
                        if b.standby_ticks >= r.cycle_ticks:
                            b.standby_ticks = 0
                            self._consume_standby(b, planet, wage)

                b.idle_ticks = 0 if (b.active_batch or b.state == "starting") else (b.idle_ticks + 1)

    def _market_state(
        self,
        item: str,
        margin: float,
        st: CLOBStation,
        hub: CLOBStation,
        bank: PlanetBank,
        nw: float,
        lookback: float,
        own_qty: int = 0,
    ) -> list[float]:
        ma = max(0.05, st.get_ma(item, lookback))
        cur_p = st.signal_price(item)
        price_z = max(-1.0, min(1.0, ((cur_p - ma) / ma) * 3.0))
        target_inv = max(4, st.target_inventory.get(item, 100))
        scarcity = max(-1.0, min(1.0, (target_inv - st.inventory.get(item, 0)) / target_inv))
        m_norm = max(-1.0, min(1.0, margin))
        hub_p = hub.signal_price(item)
        hub_spread = max(-1.0, min(1.0, (hub_p - cur_p) / max(0.2, cur_p)))
        own_stock_r = max(-1.0, min(1.0, (own_qty / 60.0) * 2.0 - 1.0))
        cash_r = max(-1.0, min(1.0, (self.cash / max(200.0, nw)) * 2.0 - 1.0))
        debt_r = max(-1.0, min(1.0, (self.debt / max(200.0, nw)) * 2.0 - 1.0))
        rate_s = max(-1.0, min(1.0, (bank.annual_rate_pct - 8.0) / 10.0))
        return [price_z, scarcity, m_norm, hub_spread, own_stock_r, cash_r, debt_r, rate_s]

    def _scarcity_bid_price(self, st: CLOBStation, item: str, mult: float = 1.04) -> float:
        """Hit real asks when available; on empty asks, anchor strictly to last_trade_price."""
        ba = st.best_ask(item)
        if ba is not None:
            return ba * mult
        last_p = st.last_trade_price[item]
        return min(last_p * 1.15, max(last_p * mult, st.ema_med[item] * 1.12))

    def _place_bid(self, tick: int, st: CLOBStation, item: str, want: int, max_price: float, purpose: str) -> None:
        if want <= 0 or self.cash < 1.0:
            return
        affordable = int((self.cash * 0.6) // max(0.05, max_price))
        qty = min(want, affordable)
        if qty > 0:
            st.place_order(self.npc_id, "buy", item, qty, max_price, tick, purpose=purpose)

    def _manage_bank(self, planet: Planet, nw: float, lev_target: float, best_m: float) -> None:
        bank = planet.bank
        c = planet.cpi
        b_cnt = max(1, self.total_buildings())
        cash_floor = max(200.0 + max(0.0, 1.5 - lev_target) * 160.0, 80.0 * b_cnt) * c
        if self.debt > 0 and self.cash > cash_floor + 120.0 * c:
            repay = min(self.debt, self.cash - cash_floor)
            if repay > 0:
                self.cash -= repay
                self.debt -= repay
                bank.total_loans = max(0.0, bank.total_loans - repay)
                bank.reserves += repay
                self.last_action = f"还贷{repay:.0f}"

        if self.cash < cash_floor and self.savings > 0:
            wd = min(self.savings, cash_floor + 150.0 * c - self.cash)
            if wd > 0:
                self.savings -= wd
                self.cash += wd
                bank.total_deposits = max(0.0, bank.total_deposits - wd)
                self.last_action = f"取款{wd:.0f}"

        deposit_thresh = max(1400.0 + max(0.0, 1.5 - lev_target) * 1300.0, 220.0 * b_cnt) * c
        if self.cash > deposit_thresh and self.debt == 0:
            dep = (self.cash - deposit_thresh) * 0.5
            self.cash -= dep
            self.savings += dep
            bank.total_deposits += dep
            self.last_action = f"存款{dep:.0f}"

        max_debt = max(400.0 * c, nw * lev_target)
        rate_ok = bank.annual_rate_pct < (7.0 + lev_target * 8.0)
        if self.cash < cash_floor and self.debt < max_debt and rate_ok and bank.reserves > 500.0 * c and best_m > 0.08:
            loan = min(700.0 * c, max_debt - self.debt, bank.reserves * 0.1)
            if loan >= 120.0 * c:
                self.cash += loan
                self.debt += loan
                bank.total_loans += loan
                bank.reserves -= loan
                self.last_action = f"贷款{loan:.0f}"

    def _buy_supply(
        self,
        tick: int,
        planet: Planet,
        hub: CLOBStation,
        item: str,
        want: int,
        ship_unit_cost: float,
        local_purpose: str,
        bid_mult: float,
        hub_tol: float,
    ) -> None:
        st = planet.station
        if item == "power":
            self._place_bid(tick, st, item, want, self._scarcity_bid_price(st, item, bid_mult), "ground")
            return

        local_ask = st.best_ask(item)
        hub_ask = hub.best_ask(item)
        if hub_ask is not None and (local_ask is None or hub_ask + ship_unit_cost < local_ask * hub_tol):
            self._place_bid(tick, hub, item, want, hub_ask * bid_mult, "pickup")
            return
        if local_ask is not None:
            self._place_bid(tick, st, item, want, local_ask * bid_mult, local_purpose)
            return

        self._place_bid(tick, st, item, want, self._scarcity_bid_price(st, item, bid_mult), local_purpose)
        if item in ("titanium", "silicate", "helium3", "ti_alloy", "wafer", "cryo_cell"):
            self._place_bid(tick, hub, item, want, self._scarcity_bid_price(hub, item, bid_mult), "pickup")

    def _quote_station(
        self,
        tick: int,
        st: CLOBStation,
        hub: CLOBStation,
        bank: PlanetBank,
        nw: float,
        lookback: float,
        quote_items: dict[str, float],
        cpi: float = 1.0,
    ) -> None:
        sid = st.station_id
        is_hub = sid == "ST:HUB"
        for out_item, unit_c in quote_items.items():
            at_st = self.get_st_inv(sid, out_item)
            if at_st <= 0:
                st.asks[out_item] = [o for o in st.asks[out_item] if o.owner_id != self.npc_id]
                continue
            ma = st.get_ma(out_item, lookback)
            sig = st.signal_price(out_item)
            margin = (sig - unit_c) / max(0.05 * cpi, unit_c)
            m_state = self._market_state(out_item, margin, st, hub, bank, nw, lookback, at_st)
            _, a_quote, _, _, a_arb = self.brain.forward_market(m_state)

            target_inv = st.target_inventory.get(out_item, 40)
            st_inv = st.inventory.get(out_item, 0)
            overstock = st_inv > target_inv * 0.75
            deep_glut = st_inv > target_inv * 2.5
            glutted = overstock or (is_hub and at_st > 30)
            # Hub storage rent forces liquidation; local stations avoid destructive deflationary spirals
            min_floor = unit_c * (0.65 if is_hub and at_st > 40 else (0.96 if glutted else 1.01))

            if a_arb > 0.35 and sig < ma * 0.94 and not glutted:
                ask = round(max(min_floor, ma * (1.02 + max(0.0, a_quote) * 0.05)), 4)
            else:
                bb = st.best_bid(out_item)
                other_ba = next((o.price for o in st.asks[out_item] if o.owner_id != self.npc_id), None)
                last_p = st.last_trade_price[out_item]
                if bb is not None and other_ba is not None:
                    cap_hi = max(bb * (1.08 if glutted else 1.25), min_floor * 1.15)
                    ref_quote = (bb + min(other_ba, cap_hi)) / 2.0
                    if deep_glut or (is_hub and glutted):
                        ref_quote = min(ref_quote, bb * (0.94 if deep_glut else 1.03))
                    ask = round(max(min_floor, ref_quote * (1.0 + a_quote * 0.06)), 4)
                elif bb is not None:
                    ref_quote = min(bb * (0.94 if deep_glut else 1.0), max(last_p * 1.15, unit_c * 1.25))
                    ask = round(max(min_floor, ref_quote * (1.0 + a_quote * 0.06)), 4)
                else:
                    base_ref = min(other_ba, last_p) if other_ba is not None else last_p
                    disc = ((0.90 if is_hub else 0.95) + (a_quote + 1.0) * 0.015) if glutted else 1.0
                    ask = round(max(min_floor, base_ref * disc * (1.0 + min(0.0, a_quote) * 0.04)), 4)

            st.place_order(self.npc_id, "sell", out_item, at_st, ask, tick, purpose="station")
            if is_hub:
                self.last_action = f"Hub挂卖{ITEM_CN[out_item]}@{ask:.2f}"
            else:
                self.last_action = f"卖{ITEM_CN[out_item]}@{ask:.4f}"

    def decide(self, tick: int, system) -> None:
        planet = system.planets[self.home_planet_id]
        st = planet.station
        hub = system.hub_station

        if tick % 72 == 0:
            blds = self.all_buildings()
            idle_r = sum(1 for _, b in blds if b.idle_ticks >= 24) / max(1, len(blds))
            self.brain.online_es_step(self.live_net_worth(planet, system.stations), idle_r)

        if tick % self.genome.decision_interval != 0:
            return

        cpi = planet.cpi
        nw = self.live_net_worth(planet, system.stations)
        route_t, route_fuel = system.route_cost(st.station_id, hub.station_id)
        t_mult = planet.launch_ticks_mult()
        f_mult = planet.launch_fuel_mult()
        fuel_ref_p = min(s.signal_price("fuel") for s in system.stations.values())
        max_cap = max((s.spec.capacity for s in self.fleet), default=30)
        ship_unit_cost = (route_fuel * fuel_ref_p) / max(10, max_cap)

        # --- 1. FirmBrain (8 -> 6): company-level policy parameters ---
        ready_ships = [s for s in self.fleet if tick >= s.busy_until]
        local_backlog = sum(q for k, q in self.inventory.items() if k not in ("power", "fuel", "repair_parts"))
        blds = self.all_buildings()
        avg_idle_t = sum(b.idle_ticks for _, b in blds) / max(1, len(blds))

        sys_max_tier = max((p_o.unlocked_tier() for p_o in system.planets.values()), default=2)
        allowed_recipes = [
            r for r in RECIPES.values()
            if planet.can_build_recipe(r.kind) and (r.tier == 0 or r.tier <= sys_max_tier + 1)
        ]
        if not allowed_recipes:
            allowed_recipes = [r for r in RECIPES.values() if planet.can_build_recipe(r.kind) and r.tier <= 3]

        def _inputs_available(r: Recipe) -> bool:
            return all(
                (st.best_ask(k) is not None or hub.best_ask(k) is not None or st.inventory.get(k, 0) >= q * 2)
                for k, q in r.inputs.items()
            )

        def _export_sell_p(r: Recipe) -> float:
            out = r.output_item
            lp = effective_item_value(out, st, cpi, hub)
            if out == "power" or out in ITEM_TO_SHIP_SIZE:
                return lp
            ext = max(
                [hub.best_bid(out) or 0.0]
                + [p2.station.best_bid(out) or 0.0 for pid2, p2 in system.planets.items() if pid2 != self.home_planet_id]
            )
            return max(lp, ext * 0.90 - ship_unit_cost * 1.5)

        viable_recipes = [r for r in allowed_recipes if _inputs_available(r)]
        best_build_m = max(
            (
                recipe_profit_per_tick(r, st, max((p.terrain_mods.get(r.kind, 1.0) for p in self.plots), default=1.0), _export_sell_p(r), cpi, hub)[0]
                for r in viable_recipes
            ),
            default=0.0,
        )

        firm_state = [
            max(-1.0, min(1.0, (self.cash / max(200.0, nw)) * 2.0 - 1.0)),
            max(-1.0, min(1.0, (self.debt / max(200.0, nw)) * 2.0 - 1.0)),
            max(-1.0, min(1.0, (self.savings / max(200.0, nw)) * 2.0 - 1.0)),
            max(-1.0, min(1.0, (planet.bank.annual_rate_pct - 8.0) / 10.0)),
            (len(ready_ships) / max(1, len(self.fleet))) * 2.0 - 1.0,
            max(-1.0, min(1.0, (local_backlog / 120.0) * 2.0 - 1.0)),
            max(-1.0, min(1.0, best_build_m)),
            max(-1.0, min(1.0, (avg_idle_t / 80.0) * 2.0 - 1.0)),
        ]
        a_lev, a_expand, a_demolish, a_fleet, a_dispatch, a_lookback = self.brain.forward_firm(firm_state)

        lev_target = 0.05 + (a_lev + 1.0) * 0.725
        lookback = (a_lookback + 1.0) * 0.5
        demolish_idle_req = int(32 + (1.0 - a_demolish) * 64)
        demolish_gain_req = max(0.12, 0.32 - a_demolish * 0.16)
        repair_dur_thresh = 25.0 + (a_fleet + 1.0) * 15.0
        ship_backlog_thresh = int(85 - a_fleet * 45)

        self.brain_lev = round(lev_target, 3)
        self.brain_expand = round(a_expand, 3)
        self.brain_lookback = round(lookback, 3)

        self._manage_bank(planet, nw, lev_target, best_build_m)

        # --- 2. Fleet repair & expansion driven by FirmBrain ---
        for ship in self.fleet:
            if ship.durability <= repair_dur_thresh:
                need = ship.spec.repair_parts
                if self.inventory.get("repair_parts", 0) < need:
                    bid_mult = 1.04 + (a_fleet + 1.0) * 0.015
                    self._buy_supply(tick, planet, hub, "repair_parts", need * 2, ship_unit_cost, "ground", bid_mult, 0.94)
                if self.inventory.get("repair_parts", 0) >= need:
                    self.inventory["repair_parts"] -= need
                    ship.durability = 100.0
                    self.last_action = f"维修{ship.spec.cn_name}"

        idle_ok_ships = [s for s in ready_ships if s.durability > 0]
        hub_pending = sum(self.station_pickups.get("ST:HUB", {}).values())
        if not idle_ok_ships and (local_backlog > ship_backlog_thresh or hub_pending > 10) and len(self.fleet) < 6:
            target_size = (
                "large" if (a_fleet > 0.35 and self.cash > 4800.0 * cpi and local_backlog > 200)
                else ("medium" if (a_fleet > -0.15 and self.cash > 1600.0 * cpi) else "small")
            )
            item_key = SHIP_SPECS[target_size].item_key
            st_ask, hub_ask = st.best_ask(item_key), hub.best_ask(item_key)
            if st_ask and self.cash > st_ask + 300.0 * cpi:
                self._place_bid(tick, st, item_key, 1, st_ask, "ship")
            elif hub_ask and self.cash > hub_ask + 300.0 * cpi:
                self._place_bid(tick, hub, item_key, 1, hub_ask, "ship")

        # --- 3. Production utilization & Speculative support driven by MarketBrain ---
        arb_samples: list[float] = []
        market_cache: dict[str, tuple[float, float, float, float, float]] = {}

        def _get_market_out(item: str, margin: float = 0.0, own_q: int = 0) -> tuple[float, float, float, float, float]:
            if item not in market_cache:
                ms = self._market_state(item, margin, st, hub, planet.bank, nw, lookback, own_q)
                market_cache[item] = self.brain.forward_market(ms)
            return market_cache[item]

        for _, b in blds:
            out_item = b.recipe.output_item
            margin, _ = recipe_profit_per_tick(b.recipe, st, b.efficiency, None, cpi, hub)
            own_q = self.inventory.get(out_item, 0) + self.get_st_inv(st.station_id, out_item)
            a_util, _, _, _, a_arb = _get_market_out(out_item, margin, own_q)
            arb_samples.append(a_arb)
            target_u = (a_util + 1.0) * 0.5
            # Hysteresis switching: account for standby costs & startup response delay
            if b.state == "running":
                if margin < -0.35 or (a_util < -0.55 and margin < -0.10):
                    b.target_active = False
                    target_u = min(target_u, 0.10)
                else:
                    b.target_active = True
            elif b.state == "idle":
                if margin > 0.04 and a_util > -0.25 and _inputs_available(b.recipe) and self.cash >= b.recipe.cash_cost * cpi * 1.5:
                    b.target_active = True
                else:
                    b.target_active = False
                    target_u = 0.0
            else:  # "starting"
                b.target_active = margin >= -0.45
            b.utilization = max(0.0, min(1.0, b.utilization * 0.65 + target_u * 0.35))

        if arb_samples:
            self.brain_arb = round(sum(arb_samples) / len(arb_samples), 3)

        # Speculative support wall driven by MarketBrain a_arb
        if self.cash > 400.0 * cpi:
            best_dip = max(
                ("food", "steel", "iron", "fuel", "mat", "power"),
                key=lambda it: (st.get_ma(it, lookback) - st.signal_price(it)) / max(0.05 * cpi, st.signal_price(it)),
            )
            _, _, a_bid, _, a_arb = _get_market_out(best_dip, 0.1, self.get_st_inv(st.station_id, best_dip))
            self.brain_arb = round(a_arb, 3)
            ma = st.get_ma(best_dip, lookback)
            dip_thresh = 0.96 - max(0.0, a_arb) * 0.03
            if a_arb > 0.15 and st.signal_price(best_dip) < ma * dip_thresh:
                bid_p = round(ma * (0.91 + max(0.0, a_bid) * 0.03), 4)
                want = max(1, min(30, int((self.cash * (0.08 + a_arb * 0.14)) // max(0.05 * cpi, bid_p))))
                self._place_bid(tick, st, best_dip, want, bid_p, "station")

        # --- 4. Demolish / Build / Expand using ScorerBrain ---
        def _score_recipe(r: Recipe, plot: Plot) -> float:
            eff = plot.terrain_mods.get(r.kind, 1.0)
            loc_m, _ = recipe_profit_per_tick(r, st, eff, None, cpi, hub)
            ext_m, _ = recipe_profit_per_tick(r, st, eff, _export_sell_p(r), cpi, hub)
            in_slack = 1.0 if not r.inputs else min(
                (st.inventory.get(k, 0) + hub.inventory.get(k, 0)) / max(1, q * 10)
                for k, q in r.inputs.items()
            )
            feats = [
                max(-1.0, min(1.0, loc_m)),
                max(-1.0, min(1.0, ext_m - loc_m)),
                max(-1.0, min(1.0, (eff - 1.0) * 2.0)),
                (r.tier / 10.0) * 2.0 - 1.0,
                max(-1.0, min(1.0, in_slack * 2.0 - 1.0)),
                max(-1.0, min(1.0, 1.0 - (r.cash_cost / 50.0))),
            ]
            return self.brain.score_candidate(feats) + random.uniform(-0.02, 0.02)

        for plot in self.plots:
            if plot.used_slots() >= plot.capacity and self.cash > 450.0 * cpi:
                viable = [r for r in viable_recipes if plot.terrain_mods.get(r.kind, 1.0) > 0.0]
                if not viable:
                    continue
                best_r = max(viable, key=lambda r: _score_recipe(r, plot))
                best_m, _ = recipe_profit_per_tick(best_r, st, plot.terrain_mods.get(best_r.kind, 1.0), _export_sell_p(best_r), cpi, hub)
                for idx, b in enumerate(plot.buildings):
                    if b.recipe.kind == "PowerPlant" and st.inventory.get("power", 0) < 120:
                        continue
                    min_idle = max(demolish_idle_req, 150) if b.recipe.kind in (
                        "IronMine", "TitaniumMine", "SilicateMine", "HeliumExtractor", "FoodFarm", "FuelPlant"
                    ) else demolish_idle_req
                    cur_m, _ = recipe_profit_per_tick(b.recipe, st, b.efficiency, None, cpi, hub)
                    if b.idle_ticks >= min_idle and best_m > cur_m + demolish_gain_req and self.total_buildings() > 1:
                        removed = plot.buildings.pop(idx)
                        plot.jobs.append(SiteJob("demolish", removed.recipe.kind, tick + DEMOLISH_TICKS))
                        self.last_action = f"拆{removed.recipe.cn_name}"
                        break

        free_plots = [p for p in self.plots if p.used_slots() < p.capacity]
        build_cash_fee = round(100.0 * cpi, 2)
        if free_plots and self.cash > 450.0 * cpi and a_expand > -0.25:
            target_plot = free_plots[0]
            candidates = [
                r for r in viable_recipes
                if target_plot.terrain_mods.get(r.kind, 1.0) > 0.0
                and recipe_profit_per_tick(r, st, target_plot.terrain_mods.get(r.kind, 1.0), _export_sell_p(r), cpi, hub)[0] > 0.08
            ]
            if candidates:
                best_r = max(candidates, key=lambda r: _score_recipe(r, target_plot))
                if self.inventory.get("mat", 0) < 10:
                    _, _, a_bid_m, _, _ = _get_market_out("mat", 0.0, self.inventory.get("mat", 0))
                    self._buy_supply(
                        tick, planet, hub, "mat", 10 - self.inventory.get("mat", 0),
                        ship_unit_cost, "ground", 1.02 + (a_bid_m + 1.0) * 0.02, 0.94 + a_bid_m * 0.04,
                    )
                if self.inventory.get("mat", 0) >= 10 and self.cash >= build_cash_fee:
                    self.inventory["mat"] -= 10
                    self.cash -= build_cash_fee
                    self._pay_wages(planet, build_cash_fee)
                    target_plot.jobs.append(SiteJob("build", best_r.kind, tick + BUILD_TICKS))
                    self.last_action = f"建{best_r.cn_name}"

        land_cash_req = (1100.0 + max(0.0, 1.0 - a_expand) * 500.0) * cpi
        if not free_plots and self.cash > land_cash_req and len(self.plots) < 5 and a_expand > 0.0:
            overhead_120t = 12.0 * cpi * (len(self.plots) ** 1.4) * 120.0
            bought_plot = buy_best_plot_for_npc(self, planet, overhead_120t, system)
            if bought_plot:
                self.last_action = bought_plot

        # --- 5. Inputs & fuel procurement driven by MarketBrain ---
        need_pwr = sum(max(b.recipe.power_cost * 3, b.recipe.standby_power_cost * 4) for _, b in blds)
        if need_pwr > 0 and self.inventory.get("power", 0) < need_pwr:
            _, _, a_bid_p, _, _ = _get_market_out("power", 0.0, self.inventory.get("power", 0))
            self._place_bid(tick, st, "power", need_pwr - self.inventory.get("power", 0), self._scarcity_bid_price(st, "power", 1.02 + (a_bid_p + 1.0) * 0.025), "ground")

        if self.inventory.get("fuel", 0) < max(10, route_fuel + 6):
            _, _, a_bid_f, _, _ = _get_market_out("fuel", 0.0, self.inventory.get("fuel", 0))
            self._buy_supply(tick, planet, hub, "fuel", max(14, route_fuel + 10), ship_unit_cost, "ground", 1.02 + (a_bid_f + 1.0) * 0.025, 0.94 + a_bid_f * 0.04)

        for _, b in blds:
            for in_item, req_qty in b.recipe.inputs.items():
                total_have = self.inventory.get(in_item, 0) + self.get_st_pickup(st.station_id, in_item) + self.get_st_pickup("ST:HUB", in_item)
                if total_have < req_qty * 3:
                    dest = "ground" if in_item in INSTANT_GROUND_ITEMS else "pickup"
                    _, _, a_bid_i, _, _ = _get_market_out(in_item, 0.0, total_have)
                    self._buy_supply(
                        tick, planet, hub, in_item, req_qty * 3 - total_have,
                        ship_unit_cost, dest, 1.02 + (a_bid_i + 1.0) * 0.02, 0.94 + a_bid_i * 0.04,
                    )

        # --- 6. ScorerBrain Ship Dispatch (scores Hub import / local pickup / Hub export / local upload) ---
        for ship in ready_ships:
            eff_cap = ship.spec.capacity if ship.durability > 0 else max(5, ship.spec.capacity // 2)
            launch_t = max(1, int(round(ship.spec.launch_ticks * t_mult)))
            launch_fuel = max(1, int(round(ship.spec.fuel_per_trip * f_mult)))
            if ship.durability <= 0:
                launch_t *= 2

            jobs: list[tuple[float, str, dict]] = []

            # 6a. Hub pickups (arb resale -> station; factory inputs -> ground)
            for item, pk_qty in self.station_pickups.get("ST:HUB", {}).items():
                if pk_qty <= 0 or hub.inventory.get(item, 0) <= 0:
                    continue
                arb_q = self.hub_arb_items.get(item, 0)
                is_arb = arb_q > 0
                f_need = route_fuel if is_arb else (launch_fuel + route_fuel)
                if self.inventory.get("fuel", 0) < f_need:
                    continue
                take = min(eff_cap, pk_qty, hub.inventory.get(item, 0))
                if is_arb:
                    take = min(take, arb_q)
                if take <= 0:
                    continue
                sc = self.brain.score_candidate([
                    0.8, 0.9, 1.0 - f_need / 25.0, 0.4, max(-1.0, min(1.0, a_dispatch)), (take / max(1, eff_cap)) * 2.0 - 1.0
                ])
                jobs.append((sc, "hub_import", {"item": item, "take": take, "is_arb": is_arb, "f_need": f_need}))

            # 6b. Local station pickups -> ground
            if self.inventory.get("fuel", 0) >= launch_fuel:
                for in_item, pk_qty in self.station_pickups.get(st.station_id, {}).items():
                    if pk_qty > 0 and st.inventory.get(in_item, 0) > 0:
                        take = min(eff_cap, pk_qty, st.inventory.get(in_item, 0))
                        sc = self.brain.score_candidate([
                            0.7, 0.85, 1.0 - launch_fuel / 12.0, 0.8, max(-1.0, min(1.0, -a_dispatch)), (take / max(1, eff_cap)) * 2.0 - 1.0
                        ])
                        jobs.append((sc, "local_pickup", {"item": in_item, "take": take}))

            # 6c. Hub exports (driven by MarketBrain a_export + FirmBrain a_dispatch)
            if self.inventory.get("fuel", 0) >= route_fuel + launch_fuel:
                cand_items = set(self.station_inventories.get(st.station_id, {}).keys()) | {b.recipe.output_item for _, b in blds}
                for item in cand_items:
                    if item == "power" or item in ITEM_TO_SHIP_SIZE:
                        continue
                    at_st = min(self.get_st_inv(st.station_id, item), st.inventory.get(item, 0))
                    on_gnd = self.inventory.get(item, 0) if item not in ("fuel", "repair_parts") else max(0, self.inventory.get(item, 0) - 24)
                    if at_st >= 4:
                        avail, src_kind = at_st, "station"
                    elif on_gnd >= 4 and (st.inventory.get(item, 0) >= 16 or hub.best_bid(item) is not None):
                        avail, src_kind = on_gnd, "ground"
                    else:
                        continue
                    take = min(eff_cap, avail)
                    f_need = route_fuel if src_kind == "station" else (route_fuel + launch_fuel)
                    if item == "fuel" and src_kind == "ground" and self.inventory.get("fuel", 0) < take + f_need:
                        continue
                    hub_bid = hub.best_bid(item)
                    if hub_bid is None and hub.inventory.get(item, 0) >= 120:
                        continue
                    other_best = max((p2.station.best_bid(item) or 0.0) for pid2, p2 in system.planets.items() if pid2 != self.home_planet_id)
                    est_sell = hub_bid if hub_bid is not None else max(hub.signal_price(item), other_best * 0.85 - ship_unit_cost)
                    local_ref = max(st.signal_price(item), st.best_bid(item) or 0.0)
                    net_gain = (est_sell * 0.90 - local_ref) * take - f_need * fuel_ref_p
                    _, _, _, a_export, _ = _get_market_out(item, 0.0, avail)
                    if net_gain + a_export * 25.0 * cpi > 8.0 * cpi:
                        sc = self.brain.score_candidate([
                            max(-1.0, min(1.0, net_gain / 200.0)), a_export, 1.0 - f_need / 25.0, 0.3, a_dispatch, (take / max(1, eff_cap)) * 2.0 - 1.0
                        ])
                        jobs.append((sc, "hub_export", {"item": item, "take": take, "src_kind": src_kind, "f_need": f_need}))

            # 6d. Local ground -> home station upload
            if self.inventory.get("fuel", 0) >= launch_fuel:
                for _, b in blds:
                    out_item = b.recipe.output_item
                    if out_item == "power" or out_item in ITEM_TO_SHIP_SIZE:
                        continue
                    stock = self.inventory.get(out_item, 0)
                    avail_send = stock - launch_fuel if out_item == "fuel" else stock
                    if avail_send >= b.recipe.output_qty:
                        take = min(eff_cap, avail_send)
                        sc = self.brain.score_candidate([
                            0.55, 0.6, 1.0 - launch_fuel / 12.0, 0.9, -a_dispatch, (take / max(1, eff_cap)) * 2.0 - 1.0
                        ])
                        jobs.append((sc, "local_upload", {"item": out_item, "take": take}))

            if jobs:
                _, kind, info = max(jobs, key=lambda x: x[0])
                item, take = info["item"], info["take"]
                r_t = route_t if ship.durability > 0 else route_t * 2
                if kind == "hub_import":
                    self.add_st_pickup("ST:HUB", item, -take)
                    hub.inventory[item] -= take
                    self.inventory["fuel"] = max(0, self.inventory.get("fuel", 0) - info["f_need"])
                    eff_t = r_t if info["is_arb"] else (launch_t + r_t)
                    if info["is_arb"]:
                        self.hub_arb_items[item] = max(0, self.hub_arb_items.get(item, 0) - take)
                        if item not in self.traded_items:
                            self.traded_items.append(item)
                        dst_target, direction = st.station_id, "interplanetary"
                        self.last_action = f"{ship.spec.cn_name}跨星运回卖{ITEM_CN[item]}×{take}"
                    else:
                        dst_target, direction = self.npc_id, "interplanetary_import"
                        self.last_action = f"{ship.spec.cn_name}从Hub运回{ITEM_CN[item]}×{take}"
                    ship.busy_until = tick + eff_t
                    ship.durability = max(0.0, ship.durability - ship.spec.wear_per_trip * 1.4)
                    system.in_flight.append(ShipInFlight(self.npc_id, ship.ship_id, "ST:HUB", dst_target, direction, item, take, tick + eff_t))
                elif kind == "local_pickup":
                    self.add_st_pickup(st.station_id, item, -take)
                    st.inventory[item] -= take
                    self.inventory["fuel"] = max(0, self.inventory.get("fuel", 0) - launch_fuel)
                    ship.busy_until = tick + launch_t
                    ship.durability = max(0.0, ship.durability - ship.spec.wear_per_trip)
                    system.in_flight.append(ShipInFlight(self.npc_id, ship.ship_id, st.station_id, self.npc_id, "to_npc", item, take, tick + launch_t))
                    self.last_action = f"{ship.spec.cn_name}运{ITEM_CN[item]}×{take}"
                elif kind == "hub_export":
                    if info["src_kind"] == "station":
                        self.add_st_inv(st.station_id, item, -take)
                        st.inventory[item] -= take
                        t_need, src_sid = r_t, st.station_id
                    else:
                        self.inventory[item] -= take
                        t_need, src_sid = launch_t + r_t, self.npc_id
                    self.inventory["fuel"] = max(0, self.inventory.get("fuel", 0) - info["f_need"])
                    ship.busy_until = tick + t_need
                    ship.durability = max(0.0, ship.durability - ship.spec.wear_per_trip * 1.4)
                    system.in_flight.append(ShipInFlight(self.npc_id, ship.ship_id, src_sid, "ST:HUB", "interplanetary", item, take, tick + t_need))
                    self.last_action = f"{ship.spec.cn_name}出口Hub:{ITEM_CN[item]}×{take}"
                else:  # local_upload
                    self.inventory[item] -= take
                    self.inventory["fuel"] = max(0, self.inventory.get("fuel", 0) - launch_fuel)
                    ship.busy_until = tick + launch_t
                    ship.durability = max(0.0, ship.durability - ship.spec.wear_per_trip)
                    system.in_flight.append(ShipInFlight(self.npc_id, ship.ship_id, self.npc_id, st.station_id, "to_station", item, take, tick + launch_t))
                    self.last_action = f"{ship.spec.cn_name}发{ITEM_CN[item]}×{take}"
                continue

            # 6e. Idle ship opportunistic Hub <-> Home arbitrage gated by MarketBrain a_arb
            if self.cash > 200.0 * cpi and self.inventory.get("fuel", 0) >= route_fuel + 4:
                best_arb = None
                for item in ("iron", "titanium", "silicate", "helium3", "fuel", "ti_alloy", "wafer", "cryo_cell", "steel", "food", "mat", "repair_parts"):
                    _, _, a_bid_a, _, a_arb_i = _get_market_out(item, 0.1, self.get_st_inv(st.station_id, item))
                    if a_arb_i < -0.15:
                        continue
                    for s1, s2, purp in ((hub, st, "pickup"), (st, hub, "station")):
                        ask1, bb2 = s1.best_ask(item), s2.best_bid(item)
                        if ask1 is None or bb2 is None:
                            continue
                        qty = min(eff_cap, int((self.cash * (0.20 + max(0.0, a_arb_i) * 0.20)) // max(0.1 * cpi, ask1)), s1.inventory.get(item, 0))
                        if qty < 3:
                            continue
                        net = (bb2 * 0.9 - ask1) * qty - route_fuel * fuel_ref_p - 8.0 * cpi
                        if net > (15.0 - max(0.0, a_arb_i) * 10.0) * cpi and (best_arb is None or net > best_arb[0]):
                            best_arb = (net, s1, purp, item, ask1 * (1.01 + max(0.0, a_bid_a) * 0.02), qty)
                if best_arb is not None:
                    _, s1, purp, item, buy_p, qty = best_arb
                    if s1.station_id == "ST:HUB":
                        self.hub_arb_items[item] = self.hub_arb_items.get(item, 0) + qty
                    self._place_bid(tick, s1, item, qty, buy_p, purp)
                    self.last_action = f"套利抢购{ITEM_CN[item]}×{qty}"

        # --- 7. Sell quoting on BOTH home station & System Hub driven by MarketBrain ---
        quote_items: dict[str, float] = {}
        for _, b in blds:
            out_item = b.recipe.output_item
            if out_item not in quote_items:
                out_qty = max(1, int(round(b.recipe.output_qty * b.efficiency)))
                pwr_c = st.signal_price("power") * b.recipe.power_cost
                in_c = sum(st.signal_price(k) * q for k, q in b.recipe.inputs.items())
                quote_items[out_item] = (b.recipe.cash_cost * cpi + pwr_c + in_c) / out_qty

        for t_item in self.traded_items:
            if t_item not in quote_items:
                quote_items[t_item] = st.get_ma(t_item, lookback) * 0.94

        for s_item, s_qty in self.station_inventories.get(st.station_id, {}).items():
            if s_qty > 0 and s_item not in quote_items:
                quote_items[s_item] = st.get_ma(s_item, lookback) * 0.90

        self._quote_station(tick, st, hub, planet.bank, nw, lookback, quote_items, cpi)

        hub_inv = self.station_inventories.get("ST:HUB", {})
        if any(q > 0 for q in hub_inv.values()):
            hub_quotes = {}
            for it, q in hub_inv.items():
                if q <= 0:
                    continue
                if q > 30 or hub.inventory.get(it, 0) > hub.target_inventory.get(it, 40):
                    # Glutted on Hub: anchor to lower of local cost or Hub MA so storage rent doesn't trap unsold stock
                    hub_quotes[it] = min(quote_items.get(it, hub.get_ma(it, lookback)) + ship_unit_cost, hub.get_ma(it, lookback) * 0.88)
                else:
                    hub_quotes[it] = quote_items.get(it, hub.get_ma(it, lookback) * 0.92) + ship_unit_cost
            self._quote_station(tick, hub, hub, planet.bank, nw, lookback, hub_quotes, cpi)


def buy_best_plot_for_npc(buyer: SmartNPC, planet: Planet, overhead_penalty: float, system) -> str | None:
    st = planet.station
    cpi = planet.cpi
    best_choice: tuple[float, str, int] | None = None

    for idx, lst in enumerate(planet.land_listings):
        total_cost = lst.ask_price * (1.0 + LAND_FEE_RATE)
        if lst.seller_id == buyer.npc_id or buyer.cash < total_cost + 250.0 * cpi:
            continue
        roi = evaluate_plot_roi(lst.plot, total_cost, st, cpi, system.hub_station) - overhead_penalty
        if roi > 0 and (best_choice is None or roi > best_choice[0]):
            best_choice = (roi, "listing", idx)

    primary_p = planet.primary_land_price()
    primary_total = primary_p * (1.0 + LAND_FEE_RATE)
    if planet.land_pool and buyer.cash >= primary_total + 300.0 * cpi:
        for idx, plot in enumerate(planet.land_pool[:12]):
            roi = evaluate_plot_roi(plot, primary_total, st, cpi, system.hub_station) - overhead_penalty
            if roi > 0 and (best_choice is None or roi > best_choice[0]):
                best_choice = (roi, "primary", idx)

    if best_choice is None:
        return None

    _, src, idx = best_choice
    if src == "listing":
        lst = planet.land_listings.pop(idx)
        fee = lst.ask_price * LAND_FEE_RATE
        buyer.cash -= lst.ask_price + fee
        planet.wealth += fee
        if lst.seller_id == "BANK":
            pay_debt = min(lst.debt_recovery, lst.ask_price)
            planet.bank.total_loans = max(0.0, planet.bank.total_loans - pay_debt)
            planet.bank.reserves += lst.ask_price
        elif lst.seller_id in system.npcs:
            system.npcs[lst.seller_id].cash += lst.ask_price
        lst.plot.refurbish()
        buyer.plots.append(lst.plot)
        system.land_trades_count += 1
        return f"竞买二手地#{lst.plot.plot_id}"

    plot = planet.land_pool.pop(idx)
    fee = primary_p * LAND_FEE_RATE
    buyer.cash -= primary_p + fee
    planet.wealth += primary_p + fee
    buyer.plots.append(plot)
    system.land_trades_count += 1
    return f"买一手地#{plot.plot_id}"

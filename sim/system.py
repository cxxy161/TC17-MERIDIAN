"""StarSystem orchestrator: 1 Main-Sequence Star + 3 Terrestrial Planets + 1 Orbiting Hub Station."""

import math
import random
from pathlib import Path

from sim.config import BASE_PRICES, RECIPES, STAR_TYPES
from sim.exchange import CLOBStation
from sim.logger import SimLogger
from sim.models import Building, Genome, LandListing, PolicyBrain, ShipInFlight
from sim.npc import SmartNPC, effective_item_value, evaluate_plot_roi, recipe_profit_per_tick
from sim.planet import Planet


class StarSystem:
    def __init__(self, star_key: str = "G", log_dir: str | Path | None = None) -> None:
        self.star_key = star_key
        self.star = STAR_TYPES[star_key]
        self.tick = 0
        self.logger = SimLogger(log_dir, clear=True) if log_dir is not None else None

        # Orbiting System Hub Station (at 1.45 AU, 200-day orbit)
        self.hub_orbit_radius = 1.45
        self.hub_orbit_days = 200
        self.hub_orbit_angle = 0.0
        self.hub_station = CLOBStation("ST:HUB", seed_scale=1.5)

        # 3 diverse Terrestrial Planets
        self.planets: dict[str, Planet] = {
            "P1": Planet(
                planet_id="P1", name="灼热矿星-I", archetype="矿业岩星",
                orbit_radius=0.90, orbit_period_days=95, orbit_angle=0.5,
                gravity=1.40, solar_mult=1.6 * self.star.solar_mult, mineral_mult=1.65,
                ocean_ratio=0.05, biome_weights={"高山矿脉": 0.55, "荒漠戈壁": 0.45},
                unique_ore="titanium", city_count=0, population=0.0, tax_rate=0.03,
            ),
            "P2": Planet(
                planet_id="P2", name="新伊甸-II", archetype="宜居主星",
                orbit_radius=1.85, orbit_period_days=320, orbit_angle=2.1,
                gravity=1.00, solar_mult=1.0 * self.star.solar_mult, mineral_mult=0.85,
                ocean_ratio=0.45, biome_weights={"温带平原": 0.40, "工业平原": 0.30, "热带雨林": 0.15, "高山矿脉": 0.15},
                unique_ore="silicate", city_count=3, population=6500.0, prosperity=0.55, tax_rate=0.10,
            ),
            "P3": Planet(
                planet_id="P3", name="凛冬外星-III", archetype="寒冷低重星",
                orbit_radius=2.75, orbit_period_days=580, orbit_angle=4.4,
                gravity=0.55, solar_mult=0.45 * self.star.solar_mult, mineral_mult=1.10,
                ocean_ratio=0.25, biome_weights={"冻土冰原": 0.55, "高山矿脉": 0.25, "工业平原": 0.20},
                unique_ore="helium3", city_count=0, population=0.0, tax_rate=0.04,
            ),
        }

        self.stations: dict[str, CLOBStation] = {self.hub_station.station_id: self.hub_station}
        for p in self.planets.values():
            self.stations[p.station.station_id] = p.station

        self.npcs: dict[str, SmartNPC] = {}
        self.in_flight: list[ShipInFlight] = []
        self.next_npc_num = 1
        self.bankruptcies_count = 0
        self.startups_count = 0
        self.land_trades_count = 0
        self.interplanetary_trades = 0
        self.price_index = 1.0

        self._seed_initial_npcs()

    def _seed_initial_npcs(self) -> None:
        # P1 (Hot Mining Planet - Titanium exclusive): 16 land-owning companies
        self._spawn_planet_npcs(
            "P1",
            ["IronMine", "IronMine", "IronMine", "TitaniumMine", "TitaniumMine", "TitaniumMill", "PowerPlant", "FuelPlant", "Smelter", "SmallYard"],
            count=16,
        )
        # P2 (Habitable Main Planet - Silicate exclusive): 30 land-owning companies
        self._spawn_planet_npcs(
            "P2",
            ["FoodFarm", "FoodFarm", "FoodFarm", "IronMine", "SilicateMine", "SilicateMine", "WaferFab", "PowerPlant", "FuelPlant", "Smelter", "Smelter", "MatFactory", "TitaniumMill", "CryoPlant", "AlloyPlant", "PartsPlant", "RepairPlant", "SmallYard"],
            count=30,
        )
        # P3 (Cold Low-G Planet - Helium3 exclusive): 14 land-owning companies
        self._spawn_planet_npcs(
            "P3",
            ["HeliumExtractor", "HeliumExtractor", "CryoPlant", "FuelPlant", "FuelPlant", "PowerPlant", "IronMine", "AlloyPlant", "SmallYard"],
            count=14,
        )

    def _spawn_planet_npcs(self, pid: str, kinds: list[str], count: int) -> None:
        p = self.planets[pid]
        for i in range(count):
            if not p.land_pool:
                break
            plot = p.land_pool.pop(0)
            kind = kinds[i % len(kinds)]
            plot.buildings.append(Building(RECIPES[kind], efficiency=plot.terrain_mods.get(kind, 1.0)))
            nid = f"企业-{self.next_npc_num:02d}"
            self.next_npc_num += 1
            self.npcs[nid] = SmartNPC(nid, home_planet_id=pid, plots=[plot])

    def _station_coords(self, sid: str) -> tuple[float, float]:
        if sid == self.hub_station.station_id:
            return (
                math.cos(self.hub_orbit_angle) * self.hub_orbit_radius,
                math.sin(self.hub_orbit_angle) * self.hub_orbit_radius,
            )
        pid = sid.split(":")[1]
        p = self.planets[pid]
        return (
            math.cos(p.orbit_angle) * p.orbit_radius,
            math.sin(p.orbit_angle) * p.orbit_radius,
        )

    def route_cost(self, sid_a: str, sid_b: str) -> tuple[int, int]:
        """Real-time Keplerian orbital distance converted to (travel_ticks, fuel_needed)."""
        ax, ay = self._station_coords(sid_a)
        bx, by = self._station_coords(sid_b)
        dist = math.hypot(ax - bx, ay - by)
        ticks = max(3, int(round(dist * 6.0)))
        fuel = max(2, int(round(dist * 3.0)))
        return ticks, fuel

    def _advance_orbits(self) -> None:
        dt_days = 1.0 / 24.0
        self.hub_orbit_angle = (self.hub_orbit_angle + (math.tau * dt_days) / self.hub_orbit_days) % math.tau
        for p in self.planets.values():
            p.orbit_angle = (p.orbit_angle + (math.tau * dt_days) / p.orbit_period_days) % math.tau

    def _update_price_index(self) -> float:
        basket = ("power", "food", "fuel", "iron", "steel")
        ratios = []
        n_st = max(1, len(self.stations))
        for it in basket:
            base = max(0.05, BASE_PRICES[it])
            avg_p = sum(st.signal_price(it) for st in self.stations.values()) / n_st
            ratios.append(max(0.2, avg_p / base))
        raw = sum(ratios) / len(ratios)
        self.price_index = max(0.25, self.price_index * 0.96 + raw * 0.04)
        for p in self.planets.values():
            p.cpi = self.price_index
        return self.price_index

    def _settle_wage_remittances(self) -> None:
        remit = 0.0
        for p in self.planets.values():
            if p.pending_remittances > 0:
                remit += p.pending_remittances
                p.pending_remittances = 0.0
        if remit <= 0:
            return
        cities = [p for p in self.planets.values() if p.city_count > 0 and p.population > 0]
        if not cities:
            return
        tot_pop = sum(p.population for p in cities)
        for p in cities:
            p.wealth += remit * (p.population / tot_pop)

    def _charge_storage_rent(self) -> None:
        cpi = self.price_index
        cities = [p for p in self.planets.values() if p.city_count > 0 and p.population > 0]
        tot_pop = sum(p.population for p in cities) if cities else 0.0
        hub_rent_pool = 0.0
        for npc in self.npcs.values():
            if npc.cash <= 0.5:
                continue
            for sid, inv in npc.station_inventories.items():
                st = self.stations.get(sid)
                if st is None:
                    continue
                is_hub = sid == "ST:HUB"
                free_buf = 0 if is_hub else 16
                rate = 0.014 if is_hub else 0.003
                due = 0.0
                for it, q in inv.items():
                    billable = q - free_buf
                    if billable > 0:
                        px = max(0.05 * cpi, st.signal_price(it))
                        due += billable * px * rate
                if due <= 0:
                    continue
                paid = min(npc.cash, due)
                if paid <= 0:
                    continue
                npc.cash -= paid
                if is_hub:
                    hub_rent_pool += paid
                else:
                    pid = sid.split(":", 1)[1]
                    if pid in self.planets:
                        self.planets[pid].wealth += paid
        if hub_rent_pool > 0 and tot_pop > 0:
            for p in cities:
                p.wealth += hub_rent_pool * (p.population / tot_pop)

    def _process_lifecycle(self) -> None:
        cpi = self.price_index
        for p in self.planets.values():
            for lst in p.land_listings:
                if self.tick - lst.listed_tick >= 48:
                    lst.ask_price = max(120.0 * cpi, round(lst.ask_price * 0.9, 1))
                    lst.listed_tick = self.tick
        if self.tick % 48 == 0:
            for st in self.stations.values():
                for item, asks in st.asks.items():
                    bb = st.best_bid(item)
                    changed = False
                    for o in asks:
                        if o.owner_id == "BANK" and o.tick <= self.tick - 48 and (bb is None or o.price > bb * 1.02):
                            o.price = max(0.15 * cpi, round(o.price * 0.90, 4))
                            o.tick = self.tick
                            changed = True
                    if changed:
                        asks.sort(key=lambda o: (o.price, o.tick, o.order_id))

        dead_ids: list[str] = []
        for nid, npc in self.npcs.items():
            home_p = self.planets[npc.home_planet_id]
            liquid = npc.cash + npc.savings
            has_blds = npc.total_buildings() > 0
            all_stalled = has_blds and all(b.idle_ticks >= 96 and not b.active_batch for _, b in npc.all_buildings())
            deep_zombie = has_blds and all(b.idle_ticks >= 240 and not b.active_batch for _, b in npc.all_buildings())
            insolvent = liquid < 60.0 * cpi and npc.debt > max(200.0 * cpi, npc.estimated_asset_value(home_p) * 0.75)
            stalled_broke = liquid < 45.0 * cpi and all_stalled
            if insolvent or stalled_broke or deep_zombie:
                npc.distress_ticks += 1
            else:
                npc.distress_ticks = 0
            if (npc.distress_ticks >= 36 and insolvent) or npc.distress_ticks >= 96:
                dead_ids.append(nid)

        for nid in dead_ids:
            npc = self.npcs.pop(nid)
            self.bankruptcies_count += 1
            home_p = self.planets[npc.home_planet_id]
            if npc.debt > 0:
                home_p.bank.total_loans = max(0.0, home_p.bank.total_loans - npc.debt)
            if npc.savings > 0:
                home_p.bank.total_deposits = max(0.0, home_p.bank.total_deposits - npc.savings)
            rem_liquid = npc.cash + npc.savings
            if npc.debt > 0 and rem_liquid > 0:
                repay = min(npc.debt, rem_liquid)
                home_p.bank.reserves += repay
                rem_liquid -= repay
            if rem_liquid > 0:
                home_p.wealth += rem_liquid
            if self.logger is not None:
                self.logger.log_event(self.tick, "BANKRUPTCY", npc=nid, planet=npc.home_planet_id, debt=round(npc.debt, 1))
            for st in self.stations.values():
                st.cancel_owner_orders(nid)
            for sid, d in npc.station_inventories.items():
                st = self.stations[sid]
                for item, qty in d.items():
                    if qty > 0:
                        st.place_order("BANK", "sell", item, qty, st.signal_price(item) * 0.88, self.tick)
            for sid, d in npc.station_pickups.items():
                st = self.stations[sid]
                for item, qty in d.items():
                    if qty > 0:
                        st.place_order("BANK", "sell", item, qty, st.signal_price(item) * 0.88, self.tick)
            self.in_flight = [f for f in self.in_flight if f.owner_id != nid]
            for pl in npc.plots:
                est = (home_p.primary_land_price() + len(pl.buildings) * 180.0 * cpi) * 0.65
                home_p.land_listings.append(LandListing(pl, "BANK", round(est, 1), self.tick, debt_recovery=0.0))

        # Startups on planets with high margins (every NPC owns land; no landless traders)
        if self.tick % 24 == 0:
            for pid, p in self.planets.items():
                cur_on_p = sum(1 for n in self.npcs.values() if n.home_planet_id == pid)
                min_p = 10 if p.city_count == 0 else 18
                cap_p = 18 + int(p.population / 250)
                n_spawn = 2 if cur_on_p < min_p else 1
                for _ in range(n_spawn):
                    if not (p.land_listings or p.land_pool) or cur_on_p >= cap_p:
                        break
                    sys_tier = max((po.unlocked_tier() for po in self.planets.values()), default=2)
                    allowed = [
                        r for r in RECIPES.values()
                        if p.can_build_recipe(r.kind) and (r.tier == 0 or r.tier <= sys_tier + 1)
                        and all(
                            (p.station.best_ask(k) is not None or self.hub_station.best_ask(k) is not None or p.station.inventory.get(k, 0) >= q * 2)
                            for k, q in r.inputs.items()
                        )
                    ]
                    if not allowed:
                        allowed = [r for r in RECIPES.values() if p.can_build_recipe(r.kind) and r.tier <= 2 and not r.inputs]

                    def _startup_sell(r) -> float:
                        out = r.output_item
                        lp = effective_item_value(out, p.station, cpi, self.hub_station)
                        if out == "power" or out in ("ship_small", "ship_medium", "ship_large"):
                            return lp
                        ext = max([self.hub_station.best_bid(out) or 0.0] + [po.station.best_bid(out) or 0.0 for pid2, po in self.planets.items() if pid2 != pid])
                        return max(lp, ext * 0.85)

                    if p.station.best_ask("power") is None and p.station.inventory.get("power", 0) < 40:
                        best_r = RECIPES["PowerPlant"]
                        best_m = 1.0
                    else:
                        best_r = max(allowed, key=lambda r: recipe_profit_per_tick(r, p.station, 1.0, _startup_sell(r), cpi, self.hub_station)[0])
                        best_m, _ = recipe_profit_per_tick(best_r, p.station, 1.0, _startup_sell(best_r), cpi, self.hub_station)
                    if best_m <= 0.12 and cur_on_p >= min_p:
                        break
                    if cur_on_p < min_p and best_m <= 0.12:
                        ore_kind = {"titanium": "TitaniumMine", "silicate": "SilicateMine", "helium3": "HeliumExtractor"}.get(p.unique_ore, "IronMine")
                        best_r = RECIPES[ore_kind] if p.city_count == 0 else RECIPES["FoodFarm"]

                    best_src = None
                    for idx, lst in enumerate(p.land_listings):
                        if lst.ask_price <= 1100.0 * cpi:
                            roi = evaluate_plot_roi(lst.plot, lst.ask_price, p.station, cpi, self.hub_station)
                            if best_src is None or roi > best_src[0]:
                                best_src = (roi, "listing", idx)
                    prim_p = p.primary_land_price()
                    for idx, plot in enumerate(p.land_pool[:10]):
                        roi = evaluate_plot_roi(plot, prim_p, p.station, cpi, self.hub_station)
                        if best_src is None or roi > best_src[0]:
                            best_src = (roi, "primary", idx)
                    if best_src is None:
                        break

                    _, src, idx = best_src
                    if src == "listing":
                        lst = p.land_listings.pop(idx)
                        new_plot = lst.plot
                        buy_cost = lst.ask_price
                        if lst.seller_id == "BANK":
                            p.bank.total_loans = max(0.0, p.bank.total_loans - min(lst.debt_recovery, buy_cost))
                            p.bank.reserves += buy_cost
                        elif lst.seller_id in self.npcs:
                            self.npcs[lst.seller_id].cash += buy_cost
                    else:
                        new_plot = p.land_pool.pop(idx)
                        buy_cost = prim_p
                        p.wealth += buy_cost

                    new_plot.refurbish()
                    peers = list(self.npcs.values())
                    if len(peers) >= 4:
                        ranked = sorted(peers, key=lambda n: -n.live_net_worth(self.planets[n.home_planet_id], self.stations))
                        elite = ranked[:max(2, len(ranked) // 4)]
                        p1, p2 = random.sample(elite, 2)
                        c_gen = Genome.crossover(p1.genome, p2.genome)
                        c_br = PolicyBrain.crossover(p1.brain, p2.brain)
                        gen = max(p1.generation, p2.generation) + 1
                    else:
                        c_gen, c_br, gen = Genome.random(), PolicyBrain.random(), 1

                    loan = 800.0 * cpi if p.bank.reserves > 1000.0 * cpi else 0.0
                    if loan > 0:
                        p.bank.reserves -= loan
                        p.bank.total_loans += loan
                    seed_cash = max(750.0 * cpi, 1000.0 * cpi + loan - buy_cost)
                    if not new_plot.buildings:
                        new_plot.buildings.append(Building(best_r, efficiency=new_plot.terrain_mods.get(best_r.kind, 1.0)))
                    nid = f"企业-{self.next_npc_num:02d}"
                    self.next_npc_num += 1
                    self.npcs[nid] = SmartNPC(
                        nid, home_planet_id=pid, genome=c_gen, brain=c_br,
                        generation=gen, plots=[new_plot], cash=seed_cash, debt=loan,
                        last_action=f"G{gen}@{pid}新创({best_r.cn_name})",
                    )
                    self.startups_count += 1
                    cur_on_p += 1
                    if self.logger is not None:
                        self.logger.log_event(self.tick, "STARTUP", npc=nid, planet=pid, recipe=best_r.kind, gen=gen)

    def step_one_tick(self) -> None:
        self.tick += 1
        t = self.tick
        self._advance_orbits()
        self._update_price_index()

        # 1. Interest, overhead, production wages & storage rent
        for npc in list(self.npcs.values()):
            home_p = self.planets[npc.home_planet_id]
            npc.apply_bank_and_overhead(home_p)
            npc.step_production_and_jobs(t, home_p)
        self._settle_wage_remittances()
        if t % 12 == 0:
            self._charge_storage_rent()

        # 2. Advance in-flight ships (ground<->station AND interplanetary planet<->hub)
        still_flying: list[ShipInFlight] = []
        for f in self.in_flight:
            if f.arrival_tick <= t:
                if f.owner_id in self.npcs:
                    npc = self.npcs[f.owner_id]
                    if f.direction == "to_station":
                        st = self.stations[f.dst_station_id]
                        st.inventory[f.item] = st.inventory.get(f.item, 0) + f.qty
                        npc.add_st_inv(f.dst_station_id, f.item, f.qty)
                    elif f.direction == "to_npc":
                        npc.inventory[f.item] = npc.inventory.get(f.item, 0) + f.qty
                    elif f.direction == "interplanetary_import":
                        npc.inventory[f.item] = npc.inventory.get(f.item, 0) + f.qty
                        self.interplanetary_trades += 1
                    else:  # "interplanetary" (export to station / Hub)
                        st = self.stations[f.dst_station_id]
                        st.inventory[f.item] = st.inventory.get(f.item, 0) + f.qty
                        npc.add_st_inv(f.dst_station_id, f.item, f.qty)
                        self.interplanetary_trades += 1
            else:
                still_flying.append(f)
        self.in_flight = still_flying

        # 3. Company decisions (production + active Hub import/export)
        for npc in list(self.npcs.values()):
            npc.decide(t, self)

        # 4. Planet demands & matching across all 3 planet stations + hub station
        planet_demands: dict[str, dict[str, int]] = {}
        for pid, p in self.planets.items():
            prev_lv, prev_tier = p.city_level, p.unlocked_tier()
            planet_demands[pid] = p.place_demands(t)
            p.station.match_all(self.npcs, p, p.bank, tick=t, logger=self.logger)
            p.finish_tick(planet_demands[pid], t)
            p.station.update_mas()
            p.bank.update_policy(p, p.station)
            if self.logger is not None:
                if p.city_level != prev_lv:
                    self.logger.log_event(t, "CITY_UPGRADE", planet=pid, level=p.city_level, cap=p.city_capacity)
                cur_tier = p.unlocked_tier()
                if cur_tier != prev_tier:
                    self.logger.log_event(t, "TIER_CHANGE", planet=pid, prev=prev_tier, curr=cur_tier, prosp=round(p.prosperity, 3))

        # Match Hub Station (uses P2's central reserve bank for minor tax/bank settlement)
        self.hub_station.match_all(self.npcs, None, self.planets["P2"].bank, tick=t, logger=self.logger)
        self.hub_station.update_mas()

        # 5. Bankruptcies & startups + strict bank accounting parity
        self._process_lifecycle()
        if t % 24 == 0:
            for pid, p in self.planets.items():
                p.bank.total_loans = sum(n.debt for n in self.npcs.values() if n.home_planet_id == pid)
                p.bank.total_deposits = sum(n.savings for n in self.npcs.values() if n.home_planet_id == pid)

        if self.logger is not None and t % 24 == 0:
            self.logger.log_snapshot(self)

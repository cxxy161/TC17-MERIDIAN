"""Multi-planet Meridian economy monitor HTTP server (`python3 -m sim.web`)."""

import argparse
import json
import threading
import time
from collections import deque
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, urlparse

from sim.config import BASE_PRICES, ITEM_CN, RECIPES, STAR_TYPES
from sim.models import Ship
from sim.system import StarSystem

ALL_ITEMS = list(BASE_PRICES.keys()) + ["bank_rate"]
TIMEFRAMES = [1, 5, 24, 168]
COMPARE_ITEMS = list(BASE_PRICES.keys())


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
    if not parts:
        return "0船"
    avg_dur = sum(s.durability for s in fleet) / len(fleet)
    return f"{'+'.join(parts)}({avg_dur:.0f}%)"


class TelemetrySystem:
    """Wraps StarSystem with per-station OHLC candles and macro history."""

    def __init__(self, star_key: str = "G") -> None:
        self.lock = threading.Lock()
        self.sim_speed = 10
        self.paused = False
        self.reset(star_key)

    def reset(self, star_key: str = "G") -> None:
        if star_key not in STAR_TYPES:
            star_key = "G"
        old_sys = getattr(self, "system", None)
        if old_sys is not None and old_sys.logger is not None:
            old_sys.logger.close()
        self.system = StarSystem(star_key, log_dir=Path(__file__).with_name("logs"))
        self.station_ids = list(self.system.stations.keys())
        self.candles: dict[str, dict[int, dict[str, deque[dict]]]] = {
            sid: {tf: {it: deque(maxlen=600) for it in ALL_ITEMS} for tf in TIMEFRAMES}
            for sid in self.station_ids
        }
        self.current_bar: dict[str, dict[int, dict[str, dict | None]]] = {
            sid: {tf: {it: None for it in ALL_ITEMS} for tf in TIMEFRAMES}
            for sid in self.station_ids
        }
        self.macro_history: deque[dict] = deque(maxlen=2500)
        self._record_tick_telemetry()

    def _station_price(self, sid: str, item: str) -> float:
        if item == "bank_rate":
            if sid == "ST:HUB":
                return round(self.system.planets["P2"].bank.annual_rate_pct, 4)
            pid = sid.split(":")[1]
            return round(self.system.planets[pid].bank.annual_rate_pct, 4)
        return round(self.system.stations[sid].last_trade_price[item], 4)

    def _record_tick_telemetry(self) -> None:
        t = self.system.tick
        for sid in self.station_ids:
            for item in ALL_ITEMS:
                val = self._station_price(sid, item)
                for tf in TIMEFRAMES:
                    bucket_t = (t // tf) * tf
                    cur = self.current_bar[sid][tf][item]
                    if cur is None or cur["t"] != bucket_t:
                        if cur is not None:
                            self.candles[sid][tf][item].append(cur)
                        self.current_bar[sid][tf][item] = {
                            "t": bucket_t, "o": val, "h": val, "l": val, "c": val,
                        }
                    else:
                        if val > cur["h"]:
                            cur["h"] = val
                        if val < cur["l"]:
                            cur["l"] = val
                        cur["c"] = val

        if t == 0 or t % 12 == 0:
            p_snap = {}
            for pid, p in self.system.planets.items():
                p_snap[pid] = {
                    "pop": round(p.population, 1),
                    "prosp": round(p.prosperity, 3),
                    "inst_prosp": round(p.instant_prosperity, 3),
                    "rate": round(p.bank.annual_rate_pct, 2),
                    "loans": round(p.bank.total_loans, 1),
                    "deps": round(p.bank.total_deposits, 1),
                    "wealth": round(p.wealth, 1),
                    "land_p": p.primary_land_price(),
                    "land_avail": len(p.land_pool) + len(p.land_listings),
                }
            self.macro_history.append({
                "t": t,
                "npcs": len(self.system.npcs),
                "bankrupt": self.system.bankruptcies_count,
                "startups": self.system.startups_count,
                "hub_trips": self.system.interplanetary_trades,
                "planets": p_snap,
            })

    def step_once(self) -> None:
        self.system.step_one_tick()
        self._record_tick_telemetry()

    def build_state_payload(
        self,
        req_station: str,
        req_item: str,
        req_tf: int,
        since_t: int,
        macro_since: int,
        npc_filter: str,
    ) -> dict:
        sys = self.system
        if req_station not in sys.stations:
            req_station = "ST:P2"
        if req_item not in ALL_ITEMS:
            req_item = "food"
        if req_tf not in TIMEFRAMES:
            req_tf = 5

        cur_b = self.current_bar[req_station][req_tf][req_item]
        all_bars = list(self.candles[req_station][req_tf][req_item]) + ([cur_b] if cur_b else [])
        bars = [b for b in all_bars if b["t"] >= since_t] if since_t >= 0 else all_bars
        macros = [m for m in self.macro_history if m["t"] > macro_since] if macro_since >= 0 else list(self.macro_history)

        prices = {k: self._station_price(req_station, k) for k in ALL_ITEMS}

        # Overview for each planet + hub
        planets_info = {}
        for pid, p in sys.planets.items():
            d_hub, f_hub = sys.route_cost(p.station.station_id, sys.hub_station.station_id)
            p_npcs = [n for n in sys.npcs.values() if n.home_planet_id == pid]
            planets_info[pid] = {
                "planet_id": pid,
                "station_id": p.station.station_id,
                "name": p.name,
                "archetype": p.archetype,
                "unique_ore": p.unique_ore,
                "unique_ore_cn": ITEM_CN.get(p.unique_ore, p.unique_ore),
                "gravity": p.gravity,
                "solar_mult": round(p.solar_mult, 2),
                "mineral_mult": round(p.mineral_mult, 2),
                "population": round(p.population, 1),
                "city_level": p.city_level,
                "city_capacity": round(p.city_capacity, 0),
                "wealth": round(p.wealth, 1),
                "prosperity": round(p.prosperity, 2),
                "instant_prosperity": round(p.instant_prosperity, 2),
                "unlocked_tier": p.unlocked_tier(),
                "land_avail": len(p.land_pool) + len(p.land_listings),
                "land_total": p.total_developable_plots,
                "land_price": p.primary_land_price(),
                "hub_ticks": d_hub,
                "hub_fuel": f_hub,
                "producer_count": len(p_npcs),
                "vol_50t": sum(p.station.vol_50t.values()),
                "bank": {
                    "rate": round(p.bank.annual_rate_pct, 2),
                    "reserves": round(p.bank.reserves, 1),
                    "deposits": round(p.bank.total_deposits, 1),
                    "loans": round(p.bank.total_loans, 1),
                },
            }

        # Cross-planet comparison matrix (price + station inventory + 50T rolling volume)
        matrix = []
        for it in COMPARE_ITEMS:
            row = {
                "item": it,
                "cn": ITEM_CN.get(it, it),
                "stations": {},
                "vol50_total": 0,
            }
            for sid in ("ST:P1", "ST:HUB", "ST:P2", "ST:P3"):
                st = sys.stations[sid]
                v50 = st.vol_50t.get(it, 0)
                row["stations"][sid] = {
                    "price": round(st.signal_price(it), 4),
                    "inv": st.inventory.get(it, 0),
                    "vol50": v50,
                }
                row["vol50_total"] += v50
            matrix.append(row)

        # Industry distribution (for selected station's planet, or system-wide if ST:HUB)
        target_pid = req_station.split(":")[1] if req_station != "ST:HUB" else None
        factory_dist = {RECIPES[k].cn_name: 0 for k in RECIPES}
        filtered_npcs = []
        for n in sys.npcs.values():
            if target_pid is None or n.home_planet_id == target_pid:
                for _, b in n.all_buildings():
                    fcn = b.recipe.cn_name
                    factory_dist[fcn] = factory_dist.get(fcn, 0) + 1
            if npc_filter == "ALL" or npc_filter == n.home_planet_id:
                filtered_npcs.append(n)

        n_cnt = max(1, len(sys.npcs))
        genome_stats = {
            "最高进化世代": max((n.generation for n in sys.npcs.values()), default=1),
            "大脑套利均值": round(sum(n.brain_arb for n in sys.npcs.values()) / n_cnt * 100, 1),
            "大脑杠杆倍率(%)": round(sum(n.brain_lev for n in sys.npcs.values()) / n_cnt * 100, 1),
            "大脑均线视界(%)": round(sum(n.brain_lookback for n in sys.npcs.values()) / n_cnt * 100, 1),
            "大脑扩建冲动": round(sum(n.brain_expand for n in sys.npcs.values()) / n_cnt * 100, 1),
        }

        npc_rows = []
        for n in filtered_npcs:
            hp = sys.planets[n.home_planet_id]
            cap = sum(p.capacity for p in n.plots)
            npc_rows.append({
                "id": n.npc_id,
                "home_planet": n.home_planet_id,
                "terrains": "/".join(p.terrain_name for p in n.plots),
                "plots_count": len(n.plots),
                "fleet": format_fleet(n.fleet),
                "net_worth": round(n.live_net_worth(hp, sys.stations), 1),
                "cash": round(n.cash, 1),
                "savings": round(n.savings, 1),
                "debt": round(n.debt, 1),
                "factories": ", ".join(
                    f"{b.recipe.cn_name}({b.efficiency})[{'启' + str(b.warmup_progress) + '/' + str(b.recipe.startup_ticks) if b.state == 'starting' else ('停' if b.state == 'idle' else '运')}]"
                    for _, b in n.all_buildings()
                ),
                "slots": f"{n.total_buildings()}/{cap}" if cap > 0 else "无地",
                "action": n.last_action,
            })
        npc_rows.sort(key=lambda x: -x["net_worth"])

        return {
            "tick": sys.tick,
            "speed": self.sim_speed,
            "paused": self.paused,
            "star_key": sys.star_key,
            "star_name": f"{sys.star.code} {sys.star.name}",
            "station": req_station,
            "item": req_item,
            "item_cn": "银行利率%" if req_item == "bank_rate" else ITEM_CN.get(req_item, req_item),
            "tf": req_tf,
            "planets": planets_info,
            "lifecycle": {
                "npc_count": len(sys.npcs),
                "bankruptcies": sys.bankruptcies_count,
                "startups": sys.startups_count,
                "land_trades": sys.land_trades_count,
                "hub_trips": sys.interplanetary_trades,
                "hub_vol_50t": sum(sys.hub_station.vol_50t.values()),
                "in_flight": len(sys.in_flight),
                "price_index": round(sys.price_index, 4),
            },
            "prices": prices,
            "volumes_50t": dict(sys.stations[req_station].vol_50t),
            "total_volumes": dict(sys.stations[req_station].total_vol),
            "bars": bars,
            "macros": macros,
            "matrix": matrix,
            "dist": {"factories": factory_dist, "genomes": genome_stats},
            "npcs": npc_rows,
        }


RUNNER = TelemetrySystem("G")


def sim_loop() -> None:
    acc = 0.0
    last_time = time.monotonic()
    while True:
        time.sleep(0.02)
        now = time.monotonic()
        dt = min(0.25, now - last_time)
        last_time = now
        with RUNNER.lock:
            if RUNNER.paused:
                acc = 0.0
                continue
            acc += dt * RUNNER.sim_speed
            steps = min(50, int(acc))
            acc -= steps
            for _ in range(steps):
                RUNNER.step_once()


class Handler(BaseHTTPRequestHandler):
    def log_message(self, format: str, *args: object) -> None:
        return

    def _send_json(self, obj: dict) -> None:
        data = json.dumps(obj, ensure_ascii=False).encode("utf-8")
        self.send_response(200)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.end_headers()
        self.wfile.write(data)

    def do_GET(self) -> None:
        parsed = urlparse(self.path)
        if parsed.path in ("/", "/index.html", "/monitor.html"):
            html = Path(__file__).with_name("monitor.html").read_bytes()
            self.send_response(200)
            self.send_header("Content-Type", "text/html; charset=utf-8")
            self.end_headers()
            self.wfile.write(html)
        elif parsed.path == "/api/speed":
            qs = parse_qs(parsed.query)
            with RUNNER.lock:
                if "pause" in qs:
                    RUNNER.paused = qs["pause"][0] == "1"
                if "v" in qs:
                    try:
                        v = int(qs["v"][0])
                        RUNNER.sim_speed = max(1, min(1000, v))
                        RUNNER.paused = False
                    except ValueError:
                        pass
                res = {"speed": RUNNER.sim_speed, "paused": RUNNER.paused}
            self._send_json(res)
        elif parsed.path == "/api/reset":
            qs = parse_qs(parsed.query)
            star_key = qs.get("star", [RUNNER.system.star_key])[0]
            with RUNNER.lock:
                RUNNER.reset(star_key)
                res = {"ok": True, "star": RUNNER.system.star_key}
            self._send_json(res)
        elif parsed.path == "/api/state":
            qs = parse_qs(parsed.query)
            req_station = qs.get("station", ["ST:P2"])[0]
            req_item = qs.get("item", ["food"])[0]
            try:
                req_tf = int(qs.get("tf", ["5"])[0])
            except ValueError:
                req_tf = 5
            try:
                since_t = int(qs.get("since", ["-1"])[0])
            except ValueError:
                since_t = -1
            try:
                macro_since = int(qs.get("macro_since", ["-1"])[0])
            except ValueError:
                macro_since = -1
            npc_filter = qs.get("npc_filter", ["ALL"])[0]
            with RUNNER.lock:
                payload = RUNNER.build_state_payload(
                    req_station, req_item, req_tf, since_t, macro_since, npc_filter
                )
            self._send_json(payload)
        else:
            self.send_error(404)


def main() -> None:
    parser = argparse.ArgumentParser(description="Meridian Multi-Planet Economy Monitor")
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=8000)
    args = parser.parse_args()

    threading.Thread(target=sim_loop, daemon=True).start()
    print(f"Meridian Multi-Planet Monitor running at http://{args.host}:{args.port}")
    ThreadingHTTPServer((args.host, args.port), Handler).serve_forever()


if __name__ == "__main__":
    main()

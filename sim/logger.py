"""Rolling JSONL telemetry logger & post-mortem CLI query tool for Meridian sim."""

import argparse
import json
from pathlib import Path

LOG_ITEMS = (
    "iron", "titanium", "silicate", "helium3", "fuel", "power",
    "food", "steel", "mat", "ti_alloy", "wafer", "cryo_cell",
    "alloy", "parts", "repair_parts",
)


class SimLogger:
    """Writes rolling JSONL logs (trades, events, daily snapshots) without hurting sim speed."""

    def __init__(self, log_dir: Path | str, clear: bool = False) -> None:
        self.log_dir = Path(log_dir)
        self.log_dir.mkdir(parents=True, exist_ok=True)
        self.paths = {
            "trades": self.log_dir / "trades.jsonl",
            "events": self.log_dir / "events.jsonl",
            "snapshots": self.log_dir / "snapshots.jsonl",
        }
        self.max_bytes = {
            "trades": 8 * 1024 * 1024,
            "events": 4 * 1024 * 1024,
            "snapshots": 4 * 1024 * 1024,
        }
        if clear:
            for p in self.paths.values():
                p.write_text("", encoding="utf-8")
                prev = p.with_suffix(".prev.jsonl")
                if prev.exists():
                    prev.unlink()
        self._handles = {k: open(p, "a", encoding="utf-8", buffering=65536) for k, p in self.paths.items()}
        self._writes = 0

    def close(self) -> None:
        for h in self._handles.values():
            try:
                h.flush()
                h.close()
            except OSError:
                pass
        self._handles.clear()

    def _rotate_if_needed(self, kind: str) -> None:
        p = self.paths[kind]
        if p.exists() and p.stat().st_size >= self.max_bytes[kind]:
            self._handles[kind].flush()
            self._handles[kind].close()
            prev = p.with_suffix(".prev.jsonl")
            if prev.exists():
                prev.unlink()
            p.rename(prev)
            self._handles[kind] = open(p, "a", encoding="utf-8", buffering=65536)

    def _emit(self, kind: str, record: dict) -> None:
        h = self._handles.get(kind)
        if h is None:
            return
        h.write(json.dumps(record, ensure_ascii=False) + "\n")
        self._writes += 1
        if self._writes % 100 == 0:
            h.flush()
            self._rotate_if_needed(kind)

    def flush(self) -> None:
        for kind, h in self._handles.items():
            h.flush()
            self._rotate_if_needed(kind)

    def log_trade(
        self,
        tick: int,
        sid: str,
        item: str,
        qty: int,
        price: float,
        buyer: str,
        seller: str,
        a_price: float,
        b_price: float,
        maker_side: str,
        purpose: str,
    ) -> None:
        self._emit("trades", {
            "t": tick, "d": tick // 24 + 1, "sid": sid, "item": item,
            "qty": qty, "px": round(price, 4),
            "buyer": buyer, "seller": seller,
            "ap": round(a_price, 4), "bp": round(b_price, 4),
            "maker": maker_side, "purp": purpose,
        })

    def log_event(self, tick: int, kind: str, **data: object) -> None:
        self._emit("events", {"t": tick, "d": tick // 24 + 1, "event": kind, **data})

    def log_snapshot(self, system) -> None:
        t = system.tick
        planets_snap = {}
        for pid, p in system.planets.items():
            planets_snap[pid] = {
                "pop": round(p.population, 1),
                "prosp": round(p.prosperity, 3),
                "inst": round(p.instant_prosperity, 3),
                "tier": p.unlocked_tier(),
                "lv": p.city_level,
                "rate": round(p.bank.annual_rate_pct, 2),
                "land": len(p.land_pool) + len(p.land_listings),
            }
        markets = {}
        for sid, st in system.stations.items():
            markets[sid] = {
                it: {
                    "s": st.signal_price(it),
                    "l": round(st.last_trade_price[it], 4),
                    "i": st.inventory.get(it, 0),
                    "bb": st.best_bid(it),
                    "ba": st.best_ask(it),
                }
                for it in LOG_ITEMS
            }
        self._emit("snapshots", {
            "t": t, "d": t // 24 + 1,
            "npcs": len(system.npcs),
            "hub_trips": system.interplanetary_trades,
            "in_flight": len(system.in_flight),
            "planets": planets_snap,
            "markets": markets,
        })
        self.flush()


def query_logs(
    log_dir: Path,
    kind: str = "trades",
    station: str | None = None,
    item: str | None = None,
    from_day: int = 1,
    to_day: int = 999999,
    limit: int = 40,
) -> list[dict]:
    files = [log_dir / f"{kind}.prev.jsonl", log_dir / f"{kind}.jsonl"]
    out: list[dict] = []
    for f in files:
        if not f.exists():
            continue
        with open(f, "r", encoding="utf-8") as fh:
            for line in fh:
                if not line.strip():
                    continue
                rec = json.loads(line)
                d = rec.get("d", 0)
                if d < from_day or d > to_day:
                    continue
                if kind == "trades":
                    if station and rec.get("sid") != station:
                        continue
                    if item and rec.get("item") != item:
                        continue
                out.append(rec)
    return out[-limit:]


def main() -> None:
    parser = argparse.ArgumentParser(description="Query Meridian rolling simulation logs")
    parser.add_argument("--dir", default="sim/logs")
    parser.add_argument("--kind", choices=["trades", "events", "snapshots"], default="trades")
    parser.add_argument("--station", default=None)
    parser.add_argument("--item", default=None)
    parser.add_argument("--from-day", type=int, default=1)
    parser.add_argument("--to-day", type=int, default=999999)
    parser.add_argument("--limit", type=int, default=30)
    args = parser.parse_args()

    rows = query_logs(
        Path(args.dir),
        kind=args.kind,
        station=args.station,
        item=args.item,
        from_day=args.from_day,
        to_day=args.to_day,
        limit=args.limit,
    )
    for r in rows:
        if args.kind == "snapshots" and args.station and args.item:
            m = r["markets"].get(args.station, {}).get(args.item, {})
            print(f"D{r['d']:4d}(t={r['t']:6d}) {args.station}:{args.item} -> {m}")
        else:
            print(json.dumps(r, ensure_ascii=False))


if __name__ == "__main__":
    main()

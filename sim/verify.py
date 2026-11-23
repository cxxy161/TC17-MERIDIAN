"""360-day multi-planet StarSystem verification runner."""

import time

from sim.system import StarSystem


def main(ticks: int = 8640) -> None:
    sys = StarSystem("G")
    t0 = time.monotonic()

    for t in range(1, ticks + 1):
        sys.step_one_tick()
        if t % 1440 == 0:
            p1, p2, p3 = sys.planets["P1"], sys.planets["P2"], sys.planets["P3"]
            d1_hub, _ = sys.route_cost("ST:P1", "ST:HUB")
            d2_hub, _ = sys.route_cost("ST:P2", "ST:HUB")
            print(
                f"Day {t//24:3d} | P2 Pop:{p2.population:6.0f}(Lv{p2.city_level}) Prosp:{p2.prosperity:4.2f}(i:{p2.instant_prosperity:4.2f}) T{p2.unlocked_tier()} | "
                f"Rates(P1/P2/P3): {p1.bank.annual_rate_pct:4.1f}%/{p2.bank.annual_rate_pct:4.1f}%/{p3.bank.annual_rate_pct:4.1f}% | "
                f"OrbDist(P1/P2->Hub): {d1_hub:2d}T/{d2_hub:2d}T | "
                f"HubTrips:{sys.interplanetary_trades:4d} | NPCs:{len(sys.npcs):2d} (B:{sys.bankruptcies_count} S:{sys.startups_count})"
            )

    dt = time.monotonic() - t0
    print(f"\nCompleted {ticks} ticks (360 days) in {dt:.2f}s ({ticks/dt:.0f} ticks/s)")
    print("Final Iron Prices (P1 Mine vs Hub vs P2 Main):",
          sys.planets["P1"].station.signal_price("iron"),
          sys.hub_station.signal_price("iron"),
          sys.planets["P2"].station.signal_price("iron"))
    print("Final Fuel Prices (P3 Cold vs Hub vs P2 Main):",
          sys.planets["P3"].station.signal_price("fuel"),
          sys.hub_station.signal_price("fuel"),
          sys.planets["P2"].station.signal_price("fuel"))
    print("Unique Ores @ Hub (titanium / silicate / helium3):",
          sys.hub_station.signal_price("titanium"),
          sys.hub_station.signal_price("silicate"),
          sys.hub_station.signal_price("helium3"))
    print("Unique Products @ P2 (ti_alloy / wafer / cryo_cell):",
          sys.planets["P2"].station.signal_price("ti_alloy"),
          sys.planets["P2"].station.signal_price("wafer"),
          sys.planets["P2"].station.signal_price("cryo_cell"))


if __name__ == "__main__":
    main()

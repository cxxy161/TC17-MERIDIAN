"""Experiment 0: Single Planet + Orbital Station (no NPCs)."""

from dataclasses import dataclass, field


@dataclass
class OrbitalStation:
    inventory: dict[str, int] = field(default_factory=dict)
    reference_price: dict[str, float] = field(default_factory=dict)


@dataclass
class Planet:
    population: float = 1000.0
    wealth: float = 5000.0
    prosperity: float = 1.0
    base_output_per_capita: float = 0.05

    def get_demand(self) -> dict[str, int]:
        """Tiered demand based on prosperity."""
        demand = {"food": max(1, int(self.population * 0.01))}
        if self.prosperity >= 1.2:
            demand["luxury"] = max(1, int(self.population * 0.002))
        return demand

    def step(self, station: OrbitalStation) -> dict[str, float]:
        # Step 1: Population base output
        income = self.population * self.base_output_per_capita * self.prosperity
        self.wealth += income

        # Step 2: Calculate demand & buy from station
        total_demand = self.get_demand()
        satisfactions: list[float] = []

        for item, qty in total_demand.items():
            price = station.reference_price.get(item, 10.0)
            available = station.inventory.get(item, 0)
            affordable = int(self.wealth // price) if price > 0 else qty
            actual_buy = min(qty, affordable, available)

            self.wealth -= actual_buy * price
            station.inventory[item] = available - actual_buy
            satisfactions.append(actual_buy / qty if qty > 0 else 1.0)

        # Step 3: Update prosperity
        avg_satisfaction = sum(satisfactions) / len(satisfactions) if satisfactions else 1.0
        self.prosperity += (avg_satisfaction - 0.8) * 0.05
        self.prosperity = max(0.1, min(2.0, self.prosperity))

        # Step 4: Update population
        if self.prosperity > 1.0:
            self.population *= 1.001
        elif self.prosperity < 0.6:
            self.population *= 0.999

        return {
            "income": income,
            "avg_satisfaction": avg_satisfaction,
        }


def run_simulation(ticks: int = 120) -> None:
    station = OrbitalStation(
        inventory={"food": 500, "luxury": 30},
        reference_price={"food": 10.0, "luxury": 50.0},
    )
    planet = Planet()

    print(f"{'Tick':>4} | {'Pop':>8} | {'Wealth':>9} | {'Prosp':>6} | {'Sat':>5} | {'FoodInv':>7} | {'LuxInv':>6}")
    print("-" * 62)

    for t in range(1, ticks + 1):
        metrics = planet.step(station)
        if t == 1 or t % 10 == 0 or station.inventory["food"] == 0 and t % 10 == 1:
            print(
                f"{t:4d} | {planet.population:8.1f} | {planet.wealth:9.1f} | "
                f"{planet.prosperity:6.3f} | {metrics['avg_satisfaction']:5.2f} | "
                f"{station.inventory['food']:7d} | {station.inventory['luxury']:6d}"
            )


if __name__ == "__main__":
    run_simulation()

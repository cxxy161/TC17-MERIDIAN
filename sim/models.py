"""Core domain models: orders, ships, buildings, plots, land listings, and multi-head neuroevolution brains."""

import math
import random
from dataclasses import dataclass, field

from sim.config import SHIP_SPECS, Recipe


@dataclass(slots=True)
class Order:
    order_id: int
    owner_id: str
    side: str  # "buy" or "sell"
    item: str
    qty: int
    price: float
    tick: int
    purpose: str = "station"  # "consume", "ground", "pickup", "station", "ship"


@dataclass(slots=True)
class Ship:
    ship_id: int
    size: str
    durability: float = 100.0
    busy_until: int = 0

    @property
    def spec(self):
        return SHIP_SPECS[self.size]


@dataclass(slots=True)
class ShipInFlight:
    owner_id: str
    ship_id: int
    src_station_id: str
    dst_station_id: str
    direction: str  # "to_station", "to_npc", "interplanetary", "interplanetary_import"
    item: str
    qty: int
    arrival_tick: int


@dataclass(slots=True)
class Building:
    recipe: Recipe
    efficiency: float = 1.0
    progress: int = 0
    active_batch: bool = False
    utilization: float = 0.8
    idle_ticks: int = 0
    state: str = "running"  # "running", "starting", "idle"
    target_active: bool = True
    warmup_progress: int = 0
    state_cooldown: int = 0
    standby_ticks: int = 0
    cold_ticks: int = 0


@dataclass(slots=True)
class SiteJob:
    action: str  # "build" or "demolish"
    kind: str
    finish_tick: int


@dataclass(slots=True)
class Plot:
    plot_id: int
    planet_id: str
    terrain_name: str
    terrain_mods: dict[str, float]
    is_ocean: bool = False
    is_city: bool = False
    is_pentagon: bool = False
    capacity: int = 5
    buildings: list[Building] = field(default_factory=list)
    jobs: list[SiteJob] = field(default_factory=list)

    def used_slots(self) -> int:
        return len(self.buildings) + len(self.jobs)

    def is_developable(self) -> bool:
        return not self.is_ocean and not self.is_city

    def refurbish(self) -> None:
        """Reset inherited building state and timers when ownership changes."""
        for b in self.buildings:
            b.active_batch = False
            b.progress = 0
            b.idle_ticks = 0
            b.state = "running"
            b.target_active = True
            b.warmup_progress = 0
            b.state_cooldown = 0
            b.standby_ticks = 0
            b.cold_ticks = 0
            base_eff = self.terrain_mods.get(b.recipe.kind, 1.0)
            b.efficiency = max(b.efficiency, round(base_eff * 0.85, 2))


@dataclass(slots=True)
class LandListing:
    plot: Plot
    seller_id: str
    ask_price: float
    listed_tick: int
    debt_recovery: float = 0.0


@dataclass(slots=True)
class Genome:
    """Minimal scheduling cadence genome; all strategic behavior lives in PolicyBrain."""

    decision_interval: int

    @classmethod
    def random(cls) -> "Genome":
        return cls(decision_interval=random.randint(2, 10))

    @classmethod
    def crossover(cls, a: "Genome", b: "Genome") -> "Genome":
        di = (a.decision_interval if random.random() < 0.5 else b.decision_interval) + random.choice([-1, 0, 0, 1])
        return cls(decision_interval=max(2, min(10, di)))


@dataclass(slots=True)
class LinearHead:
    """Compact linear + tanh layer shared by MarketBrain, FirmBrain, and ScorerBrain."""

    in_dim: int
    out_dim: int
    w: list[list[float]]
    b: list[float]
    probe_dw: list[list[float]] | None = None
    probe_db: list[float] | None = None

    @classmethod
    def random(cls, in_dim: int, out_dim: int, w_std: float = 0.28) -> "LinearHead":
        w = [[random.gauss(0.0, w_std) for _ in range(in_dim)] for _ in range(out_dim)]
        b = [random.gauss(0.0, 0.22) for _ in range(out_dim)]
        return cls(in_dim=in_dim, out_dim=out_dim, w=w, b=b)

    @classmethod
    def crossover(cls, pa: "LinearHead", pb: "LinearHead") -> "LinearHead":
        w = [
            [
                max(-2.5, min(2.5, (pa.w[r][c] if random.random() < 0.5 else pb.w[r][c]) + random.gauss(0.0, 0.12)))
                for c in range(pa.in_dim)
            ]
            for r in range(pa.out_dim)
        ]
        b = [
            max(-1.5, min(1.5, (pa.b[r] if random.random() < 0.5 else pb.b[r]) + random.gauss(0.0, 0.08)))
            for r in range(pa.out_dim)
        ]
        return cls(in_dim=pa.in_dim, out_dim=pa.out_dim, w=w, b=b)

    def forward(self, x: list[float]) -> list[float]:
        outs: list[float] = []
        for r in range(self.out_dim):
            acc = self.b[r]
            row = self.w[r]
            for c in range(self.in_dim):
                acc += row[c] * x[c]
            outs.append(math.tanh(max(-6.0, min(6.0, acc))))
        return outs

    def forward_scalar(self, x: list[float]) -> float:
        acc = self.b[0]
        row = self.w[0]
        for c in range(self.in_dim):
            acc += row[c] * x[c]
        return acc

    def apply_probe(self, w_std: float = 0.04, b_std: float = 0.03) -> None:
        dw = [[random.gauss(0.0, w_std) for _ in range(self.in_dim)] for _ in range(self.out_dim)]
        db = [random.gauss(0.0, b_std) for _ in range(self.out_dim)]
        for r in range(self.out_dim):
            self.b[r] = max(-1.5, min(1.5, self.b[r] + db[r]))
            for c in range(self.in_dim):
                self.w[r][c] = max(-2.5, min(2.5, self.w[r][c] + dw[r][c]))
        self.probe_dw = dw
        self.probe_db = db

    def revert_probe(self) -> None:
        if self.probe_dw is None or self.probe_db is None:
            return
        for r in range(self.out_dim):
            self.b[r] = max(-1.5, min(1.5, self.b[r] - self.probe_db[r]))
            for c in range(self.in_dim):
                self.w[r][c] = max(-2.5, min(2.5, self.w[r][c] - self.probe_dw[r][c]))
        self.probe_dw = None
        self.probe_db = None


@dataclass(slots=True)
class PolicyBrain:
    """Three-head full-decision neural controller (MarketBrain + FirmBrain + ScorerBrain) evolved via Online (1+1) ES."""

    market: LinearHead  # 8 -> 5: [util, quote, bid_aggr, hub_export, arb]
    firm: LinearHead    # 8 -> 6: [leverage, expand, demolish, fleet, dispatch_hub, lookback]
    scorer: LinearHead  # 6 -> 1: dynamic recipe & ship-job ranker
    last_eval_nw: float = 0.0
    avg_reward: float = 0.0

    @classmethod
    def random(cls) -> "PolicyBrain":
        mkt = LinearHead.random(8, 5, w_std=0.25)
        mkt.w[0][1] += 0.45  # scarcity -> util
        mkt.w[0][2] += 1.15  # margin -> util
        mkt.w[0][4] -= 0.45  # high stock -> lower util
        mkt.b[0] += 0.25
        mkt.w[1][1] += 0.30  # scarcity -> ask quote
        mkt.w[1][4] -= 0.35  # high stock -> discount ask
        mkt.w[2][1] += 0.30  # scarcity -> bid aggr
        mkt.w[2][5] += 0.30  # cash -> bid aggr
        mkt.w[3][3] += 0.90  # hub_spread -> export
        mkt.w[3][4] += 0.40  # stock -> export
        mkt.w[4][3] += 0.60  # hub_spread -> arb
        mkt.w[4][5] += 0.35  # cash -> arb
        mkt.w[4][0] -= 0.35  # dip below MA -> spec buy

        firm = LinearHead.random(8, 6, w_std=0.25)
        firm.w[0][6] += 0.50  # best_build_margin -> leverage appetite
        firm.w[0][3] -= 0.55  # bank rate -> lower leverage
        firm.w[1][0] += 0.45  # cash -> expand
        firm.w[1][6] += 0.85  # build margin -> expand
        firm.b[1] += 0.15
        firm.w[2][7] += 0.75  # idle factories -> demolish
        firm.w[3][5] += 0.75  # backlog -> fleet repair/buy
        firm.w[4][4] += 0.40  # idle ships -> hub dispatch

        scorer = LinearHead.random(6, 1, w_std=0.25)
        scorer.w[0][0] += 1.20  # primary margin / net_gain
        scorer.w[0][1] += 0.60  # hub bonus / urgency
        scorer.w[0][2] += 0.50  # terrain eff / fuel efficiency
        scorer.w[0][4] += 0.40  # input slack / capacity match

        return cls(market=mkt, firm=firm, scorer=scorer)

    @classmethod
    def crossover(cls, pa: "PolicyBrain", pb: "PolicyBrain") -> "PolicyBrain":
        return cls(
            market=LinearHead.crossover(pa.market, pb.market),
            firm=LinearHead.crossover(pa.firm, pb.firm),
            scorer=LinearHead.crossover(pa.scorer, pb.scorer),
        )

    def forward_market(self, state: list[float]) -> tuple[float, float, float, float, float]:
        o = self.market.forward(state)
        return o[0], o[1], o[2], o[3], o[4]

    def forward_firm(self, state: list[float]) -> tuple[float, float, float, float, float, float]:
        o = self.firm.forward(state)
        return o[0], o[1], o[2], o[3], o[4], o[5]

    def score_candidate(self, features: list[float]) -> float:
        return self.scorer.forward_scalar(features)

    def online_es_step(self, cur_nw: float, idle_ratio: float = 0.0) -> None:
        if self.last_eval_nw <= 0:
            self.last_eval_nw = max(100.0, cur_nw)
        else:
            reward = (cur_nw - self.last_eval_nw) / max(200.0, self.last_eval_nw) - idle_ratio * 0.015
            self.last_eval_nw = cur_nw
            if reward < self.avg_reward - 0.002:
                self.market.revert_probe()
                self.firm.revert_probe()
                self.scorer.revert_probe()
            self.avg_reward = self.avg_reward * 0.8 + reward * 0.2

        self.market.apply_probe()
        self.firm.apply_probe()
        self.scorer.apply_probe()


_ship_seq = 1


def new_ship(size: str) -> Ship:
    global _ship_seq
    s = Ship(ship_id=_ship_seq, size=size)
    _ship_seq += 1
    return s

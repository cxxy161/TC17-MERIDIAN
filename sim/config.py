"""Static configuration tables: stars, recipes, ships, terrains, and constants."""

from dataclasses import dataclass, field


@dataclass(frozen=True)
class StarSpec:
    code: str
    name: str
    solar_mult: float
    wear_mult: float
    hz_range: tuple[float, float]


STAR_TYPES: dict[str, StarSpec] = {
    "O": StarSpec("O型", "蓝主序星", solar_mult=2.4, wear_mult=1.8, hz_range=(3.2, 4.4)),
    "B": StarSpec("B型", "蓝白主序星", solar_mult=1.8, wear_mult=1.4, hz_range=(2.7, 3.8)),
    "A": StarSpec("A型", "白主序星", solar_mult=1.4, wear_mult=1.15, hz_range=(2.2, 3.2)),
    "F": StarSpec("F型", "黄白主序星", solar_mult=1.15, wear_mult=1.0, hz_range=(1.9, 2.8)),
    "G": StarSpec("G型", "黄矮主序星", solar_mult=1.0, wear_mult=1.0, hz_range=(1.6, 2.4)),
    "K": StarSpec("K型", "橙主序星", solar_mult=0.65, wear_mult=0.9, hz_range=(1.2, 1.9)),
    "M": StarSpec("M型", "红矮主序星", solar_mult=0.30, wear_mult=1.1, hz_range=(0.85, 1.4)),
}


@dataclass(frozen=True)
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
INSTANT_GROUND_ITEMS: set[str] = {"power", "fuel", "mat", "repair_parts"}


@dataclass(frozen=True)
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

    @property
    def startup_ticks(self) -> int:
        return max(3, min(14, self.cycle_ticks + self.tier))

    @property
    def standby_power_cost(self) -> int:
        if self.power_cost <= 0:
            return 0
        return max(1, round(self.power_cost * 0.25))


PLANET_EXCLUSIVE_ORE: dict[str, str] = {
    "TitaniumMine": "titanium",
    "SilicateMine": "silicate",
    "HeliumExtractor": "helium3",
}

RECIPES: dict[str, Recipe] = {
    "PowerPlant": Recipe("PowerPlant", "发电厂", "power", 24, cycle_ticks=2, power_cost=0, cash_cost=12.0, inputs={"fuel": 2}),
    "FuelPlant": Recipe("FuelPlant", "燃油厂", "fuel", 10, cycle_ticks=2, power_cost=4, cash_cost=10.0),
    "IronMine": Recipe("IronMine", "铁矿场", "iron", 12, cycle_ticks=2, power_cost=5, cash_cost=16.0),
    "TitaniumMine": Recipe("TitaniumMine", "钛矿场(P1)", "titanium", 10, cycle_ticks=2, power_cost=6, cash_cost=18.0),
    "SilicateMine": Recipe("SilicateMine", "晶硅矿场(P2)", "silicate", 10, cycle_ticks=2, power_cost=5, cash_cost=16.0),
    "HeliumExtractor": Recipe("HeliumExtractor", "氦3采集站(P3)", "helium3", 10, cycle_ticks=2, power_cost=5, cash_cost=18.0),
    "RepairPlant": Recipe("RepairPlant", "维修件厂", "repair_parts", 6, cycle_ticks=3, power_cost=5, cash_cost=12.0, inputs={"steel": 2, "parts": 1}),
    "FoodFarm": Recipe("FoodFarm", "农场(T1)", "food", 14, cycle_ticks=3, power_cost=5, cash_cost=22.0, tier=1),
    "Smelter": Recipe("Smelter", "炼钢厂(T2)", "steel", 6, cycle_ticks=4, power_cost=8, cash_cost=16.0, inputs={"iron": 10}, tier=2),
    "MatFactory": Recipe("MatFactory", "建材厂(T3)", "mat", 5, cycle_ticks=4, power_cost=7, cash_cost=14.0, inputs={"steel": 5, "iron": 4}, tier=3),
    "TitaniumMill": Recipe("TitaniumMill", "钛材厂(T3)", "ti_alloy", 5, cycle_ticks=4, power_cost=8, cash_cost=16.0, inputs={"titanium": 6, "fuel": 2}, tier=3),
    "WaferFab": Recipe("WaferFab", "晶圆厂(T3)", "wafer", 5, cycle_ticks=4, power_cost=8, cash_cost=16.0, inputs={"silicate": 6, "steel": 2}, tier=3),
    "CryoPlant": Recipe("CryoPlant", "氦冷芯厂(T3)", "cryo_cell", 5, cycle_ticks=4, power_cost=8, cash_cost=18.0, inputs={"helium3": 6, "iron": 3}, tier=3),
    "AlloyPlant": Recipe("AlloyPlant", "合金厂(T4)", "alloy", 5, cycle_ticks=5, power_cost=10, cash_cost=18.0, inputs={"steel": 5, "fuel": 3}, tier=4),
    "PartsPlant": Recipe("PartsPlant", "机械厂(T5)", "parts", 4, cycle_ticks=5, power_cost=10, cash_cost=20.0, inputs={"alloy": 4, "steel": 3}, tier=5),
    "PrecisionLab": Recipe("PrecisionLab", "精密厂(T6)", "precision", 3, cycle_ticks=6, power_cost=12, cash_cost=24.0, inputs={"parts": 3, "alloy": 2, "wafer": 2}, tier=6),
    "ElectronicsFab": Recipe("ElectronicsFab", "电子厂(T7)", "electronics", 3, cycle_ticks=6, power_cost=14, cash_cost=28.0, inputs={"precision": 2, "wafer": 3, "cryo_cell": 2}, tier=7),
    "RoboticsPlant": Recipe("RoboticsPlant", "机器人厂(T8)", "robotics", 2, cycle_ticks=8, power_cost=18, cash_cost=36.0, inputs={"electronics": 2, "ti_alloy": 3, "parts": 2}, tier=8),
    "BiomedLab": Recipe("BiomedLab", "生物所(T9)", "biomed", 2, cycle_ticks=8, power_cost=16, cash_cost=34.0, inputs={"food": 8, "electronics": 2, "fuel": 3}, tier=9),
    "QuantumCenter": Recipe("QuantumCenter", "尖端中心(T10)", "quantum", 1, cycle_ticks=10, power_cost=24, cash_cost=50.0, inputs={"robotics": 2, "biomed": 2, "cryo_cell": 3}, tier=10),
    "SmallYard": Recipe("SmallYard", "小型船坞", "ship_small", 1, cycle_ticks=12, power_cost=12, cash_cost=40.0, inputs={"steel": 8, "parts": 2}),
    "MediumYard": Recipe("MediumYard", "中型船坞", "ship_medium", 1, cycle_ticks=20, power_cost=20, cash_cost=80.0, inputs={"steel": 12, "ti_alloy": 5, "parts": 4, "electronics": 2}),
    "LargeYard": Recipe("LargeYard", "大型船坞", "ship_large", 1, cycle_ticks=32, power_cost=30, cash_cost=140.0, inputs={"steel": 24, "ti_alloy": 10, "wafer": 6, "cryo_cell": 6}),
}

TIER_UNLOCK_PROSPERITY: dict[str, tuple[float, float]] = {
    "food": (0.2, 0.008),
    "steel": (0.2, 0.003),
    "ti_alloy": (0.65, 0.0018),
    "wafer": (0.75, 0.0016),
    "mat": (0.8, 0.002),
    "cryo_cell": (0.85, 0.0014),
    "alloy": (1.2, 0.0015),
    "parts": (1.6, 0.0012),
    "precision": (2.2, 0.0008),
    "electronics": (3.0, 0.0006),
    "robotics": (4.0, 0.0004),
    "biomed": (5.2, 0.00035),
    "quantum": (6.5, 0.0002),
}

ITEM_CN: dict[str, str] = {
    "food": "粮食(T1)", "steel": "钢铁(T2)", "mat": "建材(T3)",
    "ti_alloy": "钛材(T3)", "wafer": "晶圆(T3)", "cryo_cell": "氦冷芯(T3)",
    "alloy": "合金(T4)", "parts": "机械(T5)", "precision": "精密(T6)", "electronics": "电子(T7)",
    "robotics": "机器人(T8)", "biomed": "医药(T9)", "quantum": "量子(T10)",
    "power": "电力", "fuel": "燃油", "iron": "铁矿",
    "titanium": "炽钛矿", "silicate": "晶硅矿", "helium3": "氦3冰晶",
    "repair_parts": "维修件", "ship_small": "小飞船", "ship_medium": "中货船", "ship_large": "大货轮",
}

BASE_PRICES: dict[str, float] = {
    "power": 2.5, "fuel": 5.0, "iron": 5.0,
    "titanium": 7.0, "silicate": 6.5, "helium3": 8.0,
    "repair_parts": 32.0,
    "food": 8.0, "steel": 18.0, "mat": 32.0,
    "ti_alloy": 28.0, "wafer": 34.0, "cryo_cell": 38.0,
    "alloy": 48.0, "parts": 85.0,
    "precision": 160.0, "electronics": 300.0, "robotics": 620.0, "biomed": 520.0, "quantum": 1450.0,
    "ship_small": 420.0, "ship_medium": 1600.0, "ship_large": 4500.0,
}

BASE_INVENTORY: dict[str, int] = {
    "power": 500, "fuel": 250, "iron": 250,
    "titanium": 60, "silicate": 60, "helium3": 60,
    "repair_parts": 100,
    "food": 350, "steel": 180, "mat": 120,
    "ti_alloy": 30, "wafer": 30, "cryo_cell": 30,
    "alloy": 80, "parts": 60,
    "precision": 40, "electronics": 25, "robotics": 12, "biomed": 12, "quantum": 6,
    "ship_small": 8, "ship_medium": 4, "ship_large": 2,
}

BIOME_TERRAIN_MODS: dict[str, dict[str, tuple[float, float]]] = {
    "温带平原": {"FoodFarm": (1.20, 1.55), "IronMine": (0.50, 0.80), "PowerPlant": (0.85, 1.15), "BiomedLab": (1.10, 1.35), "SilicateMine": (1.10, 1.40)},
    "热带雨林": {"FoodFarm": (1.10, 1.40), "BiomedLab": (1.20, 1.50), "PowerPlant": (0.70, 0.95), "IronMine": (0.65, 0.90), "SilicateMine": (1.00, 1.25)},
    "荒漠戈壁": {"PowerPlant": (1.30, 1.70), "FoodFarm": (0.25, 0.55), "FuelPlant": (1.05, 1.35), "TitaniumMine": (1.15, 1.50), "SilicateMine": (1.15, 1.45)},
    "高山矿脉": {"IronMine": (1.25, 1.65), "TitaniumMine": (1.25, 1.65), "TitaniumMill": (1.15, 1.40), "FoodFarm": (0.35, 0.65), "Smelter": (1.05, 1.25), "AlloyPlant": (1.10, 1.35)},
    "冻土冰原": {"HeliumExtractor": (1.25, 1.65), "CryoPlant": (1.15, 1.45), "QuantumCenter": (1.20, 1.55), "PowerPlant": (0.75, 1.00), "FoodFarm": (0.30, 0.60), "FuelPlant": (1.10, 1.40)},
    "工业平原": {"Smelter": (1.15, 1.45), "MatFactory": (1.15, 1.45), "WaferFab": (1.15, 1.45), "PartsPlant": (1.15, 1.40), "ElectronicsFab": (1.10, 1.35), "SmallYard": (1.15, 1.40)},
}

PLANET_TILE_COUNT = 252  # Goldberg subdivision 5 (240 hexagons + 12 pentagons)
BUILD_TICKS = 168
DEMOLISH_TICKS = 168
LAND_FEE_RATE = 0.15

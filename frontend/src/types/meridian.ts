export const MONEY_SCALE = 10_000;

export function moneyToCredits(m: number | null | undefined): number {
  if (m === null || m === undefined || !Number.isFinite(m)) return 0;
  return m / MONEY_SCALE;
}

export function creditsToMoney(c: number): number {
  if (!Number.isFinite(c)) return 0;
  return Math.round(c * MONEY_SCALE);
}

export interface ItemDef {
  id: string;
  name: string;
  role: 'foundation' | 'factory_consume' | 'planet_supply' | 'capital' | 'byproduct';
  profession: string;
  demand_category: string | null;
  wealth_tier: number;
  volume: number;
  ref_price: number;
  base_demand_per_1k: number;
  tags: string[];
}

export interface ItemQty {
  item: string;
  qty: number;
}

export interface BuildingDef {
  id: string;
  name: string;
  profession: string;
  slots_used: number;
  build_ticks: number;
  standby_power: number;
  build_cost: ItemQty[];
  description: string;
}

export interface RecipeDef {
  id: string;
  name: string;
  building_id: string;
  cycle_ticks: number;
  power_cost: number;
  labor_cost: number;
  inputs: ItemQty[];
  outputs: ItemQty[];
}

export interface ProfessionDef {
  id: string;
  name: string;
  demand_category: string;
  color: string;
  description: string;
  starter_buildings: string[];
  efficiency_bonus: Record<string, number>;
}

export interface ProductionPack {
  schema_version: string;
  meta: {
    name: string;
    author: string;
    ticks_per_day: number;
    tick_seconds: number;
  };
  items: ItemDef[];
  buildings: BuildingDef[];
  recipes: RecipeDef[];
  professions: ProfessionDef[];
}

export interface PlanetSummary {
  id: string;
  name: string;
  archetype: string;
  wealth_tier: number;
  prosperity: number;
  population: number;
  treasury: number;
  bank_reserves: number;
  bank_rate_bps: number;
  waste_backlog: number;
  unclaimed_plots: number;
  orbit_radius: number;
  orbit_angle: number;
  demands: Record<string, number>;
}

export interface LeaderboardRow {
  id: string;
  name: string;
  is_player: boolean;
  profession: string;
  home_planet_id: string;
  cash: number;
  savings: number;
  debt: number;
  net_liquid: number;
  plots_count: number;
  ships_count: number;
}

export interface MarketTickerRow {
  station_id: string;
  item_id: string;
  best_bid: number | null;
  best_ask: number | null;
  last_price: number;
  vol_50t: number;
}

export interface BuildingView {
  id: number;
  building_type: string;
  plot_id: number;
  planet_id: string;
  efficiency: number;
  recipe_id: string;
  active: boolean;
  progress: number;
  cycle_ticks: number;
}

export interface PlotView {
  id: number;
  planet_id: string;
  terrain_name: string;
  capacity: number;
  used_slots: number;
  building_mods: Record<string, number>;
}

export interface ShipView {
  id: number;
  size: 'small' | 'medium' | 'large';
  capacity: number;
  durability: number;
  location: string;
  busy_until: number;
  is_busy: boolean;
  cargo: Record<string, number>;
}

export interface LandListingView {
  listing_id: number;
  plot_id: number;
  ask_price: number;
}

export interface PlanetView {
  id: string;
  name: string;
  wealth_tier: number;
  prosperity: number;
  population: number;
  gravity: number;
  waste_backlog: number;
  primary_land_price: number | null;
  land_listings: LandListingView[];
  bank_rate_bps: number;
  ground_store: Record<string, number>;
  station_store: Record<string, number>;
  demands: Record<string, number>;
}

export interface OrderSnapshot {
  order_id: number;
  owner_id: string;
  side: 'buy' | 'sell';
  station_id: string;
  item_id: string;
  qty: number;
  total_qty: number;
  price: number;
  escrow_cash: number;
  created_tick: number;
}

export interface WorldSnapshot {
  tick: number;
  cpi: number;
  company: {
    id: string;
    name: string;
    profession: string;
    home_planet_id: string;
    cash: number;
    savings: number;
    debt: number;
    plots: PlotView[];
    buildings: BuildingView[];
    ships: ShipView[];
    station_stores: Record<string, Record<string, number>>;
    open_orders: OrderSnapshot[];
  };
  planets: Record<string, PlanetView>;
  orders: OrderSnapshot[];
  routes: Record<string, Record<string, [number, number]>>;
}

export interface ConsoleEntry {
  level: 'log' | 'warn' | 'error';
  message: string;
}

export interface PlayerRunOutput {
  intents: unknown[];
  memory_json: string;
  logs: ConsoleEntry[];
  cpu_used_ms: number;
  error: string | null;
  timed_out: boolean;
  oom: boolean;
}

export interface StateResponse {
  tick: number;
  cpi: number;
  paused: boolean;
  tick_ms: number;
  conservation_error: number;
  total_minted: number;
  planets: PlanetSummary[];
  leaderboard: LeaderboardRow[];
  market_tickers: MarketTickerRow[];
  player_snapshot: WorldSnapshot | null;
  last_player_output: PlayerRunOutput | null;
}

export interface CandleRow {
  bucket_tick: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

export interface TradeRow {
  tick: number;
  station_id: string;
  item_id: string;
  qty: number;
  price: number;
  fee: number;
  buyer_id: string;
  seller_id: string;
}

export interface MarketBookResp {
  station_id: string;
  item_id: string;
  best_bid: number | null;
  best_ask: number | null;
  last_price: number;
  ema_fast: number;
  ema_slow: number;
  vol_50t: number;
  bids: Array<{ price: number; qty: number }>;
  asks: Array<{ price: number; qty: number }>;
  candles: CandleRow[];
  recent_trades: TradeRow[];
}

export interface ScriptsResp {
  company_id: string;
  enabled: boolean;
  modules: Record<string, string>;
  memory_json: string;
  last_output: PlayerRunOutput | null;
}

export type IntentPayload =
  | { CreateOrder: { station_id: string; side: 'buy' | 'sell'; item_id: string; qty: number; price: number } }
  | { CancelOrder: { order_id: number } }
  | { DealOrder: { order_id: number; amount: number } }
  | { SetRecipe: { building_id: number; recipe_id: string } }
  | { ToggleBuilding: { building_id: number; active: boolean } }
  | { BuildFacility: { plot_id: number; building_type: string } }
  | { DemolishFacility: { plot_id: number; building_id: number } }
  | { BuyPlot: { planet_id: string; listing_id: number | null } }
  | { DispatchShip: { ship_id: number; from: string; to: string; cargo: Array<[string, number]> } }
  | { RepairShip: { ship_id: number } }
  | { BankOp: { planet_id: string; op: 'deposit' | 'withdraw' | 'borrow' | 'repay'; amount: number } };

export const STATION_NAMES: Record<string, string> = {
  'ST:P1': '灼热矿星轨道站',
  'ST:P2': '新伊甸轨道站',
  'ST:P3': '凛冬外星轨道站',
  'ST:HUB': '中心贸易枢纽站',
};

export function locationLabel(loc: string, planets?: PlanetSummary[]): string {
  if (STATION_NAMES[loc]) return STATION_NAMES[loc];
  const p = planets?.find((x) => x.id === loc);
  if (p) return `${p.name}地表`;
  return loc;
}

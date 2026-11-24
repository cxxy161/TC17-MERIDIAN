export const MONEY_SCALE = 10_000;

/**
 * Pure-code play mode: hides manual intent forms/buttons in observation panels while
 * preserving manual intent handlers cleanly for potential future re-enable.
 */
export const READ_ONLY_OBSERVATION_MODE = true;

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

export interface DemandCategoryDef {
  id: string;
  name: string;
  wealth_tier: number;
  description: string;
}

export interface ProductionPack {
  schema_version: string;
  meta: {
    name: string;
    author: string;
    ticks_per_day: number;
    tick_seconds: number;
  };
  /** Optional: newer packs declare the demand category dictionary here. */
  demand_categories?: DemandCategoryDef[];
  items: ItemDef[];
  buildings: BuildingDef[];
  recipes: RecipeDef[];
  professions: ProfessionDef[];
}

export interface StarSystemView {
  id: string;
  name: string;
  star_class: string;
  luminosity: number;
  x: number;
  y: number;
  hub_station_id: string;
  hub_orbit_radius: number;
  hub_orbit_days: number;
  hub_orbit_angle: number;
}

export interface PlanetSummary {
  id: string;
  system_id?: string;
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
  habitability?: number;
  solar_mult?: number;
  mineral_mult?: number;
  water_mult?: number;
  ocean_ratio?: number;
  rotation_days?: number;
  visual_seed?: number;
  city_count?: number;
  city_level?: number;
  city_capacity?: number;
  demands: Record<string, number>;
}

export interface LeaderboardRow {
  id: string;
  name: string;
  is_player: boolean;
  home_planet_id: string;
  net_liquid: number;
  plots_count: number;
  buildings_count: number;
  ships_count: number;
  open_orders_count: number;
}

export interface ShipCountsView {
  small: number;
  medium: number;
  large: number;
}

export interface PublicCompanyPlot {
  planet_id: string;
  slot_id: number;
  plot_id: number | null;
  lat: number;
  lon: number;
  terrain_name: string;
  capacity: number;
  used_slots: number;
  status: 'owned' | 'listed';
  listing_id: number | null;
  price: number | null;
  buildings: string[];
}

export interface PublicCompanyDetail {
  id: string;
  name: string;
  is_player: boolean;
  home_planet_id: string;
  net_liquid: number;
  plots_count: number;
  buildings_count: number;
  ships_count: number;
  ships_by_size: ShipCountsView;
  building_counts: Record<string, number>;
  plots: PublicCompanyPlot[];
  open_orders_count: number;
  open_orders: Array<{
    order_id: number;
    owner_id: string;
    station_id: string;
    item_id: string;
    side: 'buy' | 'sell';
    price: number;
    qty: number;
    total_qty: number;
    created_tick: number;
  }>;
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
  slot_id: number;
  planet_id: string;
  lat: number;
  lon: number;
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
  slot_id: number;
  seller_id: string;
  ask_price: number;
  terrain_name: string;
  lat: number;
  lon: number;
  capacity: number;
  used_slots: number;
  building_mods: Record<string, number>;
  buildings: string[];
}

export interface PublicLandTile {
  slot_id: number;
  planet_id: string;
  lat: number;
  lon: number;
  terrain_name: string;
  capacity: number;
  used_slots: number;
  building_mods: Record<string, number>;
  status: 'city' | 'unclaimed' | 'listed' | 'owned';
  is_city: boolean;
  city_name: string | null;
  owner_id: string | null;
  owner_name: string | null;
  is_player_owner: boolean;
  is_mine: boolean;
  plot_id: number | null;
  listing_id: number | null;
  price: number | null;
  buildings: string[];
}

export interface PlanetPlotsResp {
  planet: {
    id: string;
    name: string;
    archetype: string;
    habitability: number;
    city_count: number;
    primary_land_price: number | null;
    total_developable_plots: number;
    unclaimed_plots: number;
    npc_plot_count: number;
    npc_plot_cap: number;
  };
  tiles: PublicLandTile[];
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
  hub_orbit_radius?: number;
  hub_orbit_days?: number;
  hub_orbit_angle?: number;
  systems?: StarSystemView[];
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

export interface MarketCandlesResp {
  station_id: string;
  item_id: string;
  period: number;
  current_tick: number;
  from_bucket: number;
  to_bucket: number;
  ref_price: number;
  last_price: number;
  ema_fast: number;
  ema_slow: number;
  best_bid: number | null;
  best_ask: number | null;
  prev_close: number | null;
  earliest_trade_tick: number | null;
  latest_trade_tick: number | null;
  total_trade_ticks: number;
  candles: CandleRow[];
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
  | { BuyPlot: { planet_id: string; slot_id: number | null; listing_id: number | null } }
  | { DispatchShip: { ship_id: number; from: string; to: string; cargo: Array<[string, number]> } }
  | { RepairShip: { ship_id: number } }
  | { BankOp: { planet_id: string; op: 'deposit' | 'withdraw' | 'borrow' | 'repay'; amount: number } };

/**
 * The single hub station is the only entity in this game whose identity is not derived from a
 * planet. Everything else is derived, so the UI never carries a hand-maintained entity table
 * (which is what broke as soon as the world grew past three hand-authored planets).
 */
export const HUB_STATION_ID = 'ST:HUB';
export const HUB_STATION_LABEL = '中心贸易枢纽站';
export const HUB_ORBIT_RADIUS = 1.45;

/** Backend convention: every planet has exactly one orbital station named `ST:<planetId>`. */
export function stationIdForPlanet(planetId: string): string {
  return `ST:${planetId}`;
}

export function planetIdForStation(stationId: string): string | null {
  return stationId.startsWith('ST:') ? stationId.slice(3) : null;
}

export function isStationId(loc: string): boolean {
  return loc.startsWith('ST:');
}

export function stationLabel(stationId: string, planets?: PlanetSummary[]): string {
  if (stationId === HUB_STATION_ID) return HUB_STATION_LABEL;
  const pid = planetIdForStation(stationId);
  const planet = pid ? planets?.find((p) => p.id === pid) : undefined;
  if (planet) return `${planet.name}轨道站`;
  return stationId;
}

/**
 * Human label for any trade/stock location. Unknown ids are returned verbatim so callers can
 * detect them via {@link locationExists} and render an explicit "unknown" state instead of
 * silently pretending the location is empty.
 */
export function locationLabel(loc: string, planets?: PlanetSummary[]): string {
  if (isStationId(loc)) return stationLabel(loc, planets);
  const p = planets?.find((x) => x.id === loc);
  if (p) return `${p.name}地表`;
  return loc;
}

export function locationExists(loc: string, planets?: PlanetSummary[]): boolean {
  if (loc === HUB_STATION_ID) return true;
  if (isStationId(loc)) {
    const pid = planetIdForStation(loc);
    return !!pid && !!planets?.some((p) => p.id === pid);
  }
  return !!planets?.some((p) => p.id === loc);
}

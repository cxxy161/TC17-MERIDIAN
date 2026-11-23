import type {
  MarketTickerRow,
  OrderSnapshot,
  PlanetSummary,
  ShipView,
  StateResponse,
} from '../types/meridian';
import {
  HUB_STATION_ID,
  HUB_STATION_LABEL,
  isStationId,
  planetIdForStation,
  stationIdForPlanet,
} from '../types/meridian';

export interface LocationInfo {
  id: string;
  label: string;
  kind: 'planet' | 'station';
  planetId: string | null;
  /** Station only: whether it is the single central hub. */
  isHub?: boolean;
}

export interface HoldingSlice {
  location: string;
  label: string;
  qty: number;
}

export interface ItemHolding {
  total: number;
  byLocation: HoldingSlice[];
  inTransit: number;
}

export interface StationQuoteRow {
  stationId: string;
  row: MarketTickerRow;
}

export interface WorldIndex {
  ready: boolean;
  tick: number;
  planets: PlanetSummary[];
  planetById: Map<string, PlanetSummary>;
  locations: LocationInfo[];
  locationById: Map<string, LocationInfo>;
  stations: LocationInfo[];
  homePlanetId: string | null;
  planet(id: string | null | undefined): PlanetSummary | undefined;
  planetName(id: string | null | undefined): string;
  locationLabel(id: string | null | undefined): string;
  locationExists(id: string | null | undefined): boolean;
  stationLabel(id: string | null | undefined): string;
  /** itemId -> aggregated holdings across every owned location (+ ships in transit). */
  holdings: Map<string, ItemHolding>;
  holding(itemId: string): ItemHolding | undefined;
  totalHeld(itemId: string): number;
  openOrders: OrderSnapshot[];
  openOrdersByItem: Map<string, OrderSnapshot[]>;
  tickerByStation: Map<string, MarketTickerRow[]>;
  /** itemId -> every station that currently quotes it. */
  quotesByItem: Map<string, StationQuoteRow[]>;
  ticker(stationId: string, itemId: string): MarketTickerRow | undefined;
  ships: ShipView[];
  busyShips: number;
}

const EMPTY: WorldIndex = {
  ready: false,
  tick: 0,
  planets: [],
  planetById: new Map(),
  locations: [],
  locationById: new Map(),
  stations: [],
  homePlanetId: null,
  planet: () => undefined,
  planetName: (id) => (id ? id : '—'),
  locationLabel: (id) => (id ? id : '—'),
  locationExists: () => false,
  stationLabel: (id) => (id ? id : '—'),
  holdings: new Map(),
  holding: () => undefined,
  totalHeld: () => 0,
  openOrders: [],
  openOrdersByItem: new Map(),
  tickerByStation: new Map(),
  quotesByItem: new Map(),
  ticker: () => undefined,
  ships: [],
  busyShips: 0,
};

function addHolding(
  map: Map<string, ItemHolding>,
  itemId: string,
  location: string,
  label: string,
  qty: number,
): void {
  if (!qty) return;
  let h = map.get(itemId);
  if (!h) {
    h = { total: 0, byLocation: [], inTransit: 0 };
    map.set(itemId, h);
  }
  const existing = h.byLocation.find((s) => s.location === location);
  if (existing) existing.qty += qty;
  else h.byLocation.push({ location, label, qty });
  h.total += qty;
}

export function buildWorldIndex(state: StateResponse | null): WorldIndex {
  if (!state) return EMPTY;

  const planets = state.planets ?? [];
  const planetById = new Map(planets.map((p) => [p.id, p]));
  const snap = state.player_snapshot;

  const stationIds = new Set<string>([HUB_STATION_ID]);
  for (const p of planets) stationIds.add(stationIdForPlanet(p.id));
  if (snap) for (const sid of Object.keys(snap.company.station_stores ?? {})) stationIds.add(sid);

  const stations: LocationInfo[] = [...stationIds]
    .map((id) => {
      const pid = planetIdForStation(id);
      const planet = pid ? planetById.get(pid) : undefined;
      return {
        id,
        label: id === HUB_STATION_ID ? HUB_STATION_LABEL : planet ? `${planet.name}轨道站` : id,
        kind: 'station' as const,
        planetId: pid,
        isHub: id === HUB_STATION_ID,
      };
    })
    .sort((a, b) => (a.isHub === b.isHub ? a.label.localeCompare(b.label, 'zh-Hans-CN') : a.isHub ? -1 : 1));

  const locations: LocationInfo[] = [
    ...planets.map((p) => ({
      id: p.id,
      label: `${p.name}地表`,
      kind: 'planet' as const,
      planetId: p.id,
    })),
    ...stations,
  ];
  const locationById = new Map(locations.map((l) => [l.id, l]));

  // Sparse aggregation: iterate only the entries that actually exist, never L×I.
  const holdings = new Map<string, ItemHolding>();
  let ships: ShipView[] = [];
  let openOrders: OrderSnapshot[] = [];

  if (snap) {
    for (const [sid, store] of Object.entries(snap.company.station_stores ?? {})) {
      const label = locationById.get(sid)?.label ?? sid;
      for (const [itemId, qty] of Object.entries(store ?? {})) {
        addHolding(holdings, itemId, sid, label, qty);
      }
    }
    for (const [pid, view] of Object.entries(snap.planets ?? {})) {
      const label = locationById.get(pid)?.label ?? pid;
      for (const [itemId, qty] of Object.entries(view?.ground_store ?? {})) {
        addHolding(holdings, itemId, pid, label, qty);
      }
    }
    ships = snap.company.ships ?? [];
    for (const ship of ships) {
      for (const [itemId, qty] of Object.entries(ship.cargo ?? {})) {
        if (!qty) continue;
        let h = holdings.get(itemId);
        if (!h) {
          h = { total: 0, byLocation: [], inTransit: 0 };
          holdings.set(itemId, h);
        }
        h.total += qty;
        h.inTransit += qty;
      }
    }
    for (const h of holdings.values()) {
      h.byLocation.sort((a, b) => b.qty - a.qty);
    }
    openOrders = snap.company.open_orders ?? [];
  }

  const openOrdersByItem = new Map<string, OrderSnapshot[]>();
  for (const o of openOrders) {
    const list = openOrdersByItem.get(o.item_id);
    if (list) list.push(o);
    else openOrdersByItem.set(o.item_id, [o]);
  }

  const tickerByStation = new Map<string, MarketTickerRow[]>();
  const quotesByItem = new Map<string, StationQuoteRow[]>();
  const tickerByKey = new Map<string, MarketTickerRow>();
  for (const row of state.market_tickers ?? []) {
    const list = tickerByStation.get(row.station_id);
    if (list) list.push(row);
    else tickerByStation.set(row.station_id, [row]);
    const q = quotesByItem.get(row.item_id);
    if (q) q.push({ stationId: row.station_id, row });
    else quotesByItem.set(row.item_id, [{ stationId: row.station_id, row }]);
    tickerByKey.set(`${row.station_id}::${row.item_id}`, row);
  }

  const index: WorldIndex = {
    ready: true,
    tick: state.tick,
    planets,
    planetById,
    locations,
    locationById,
    stations,
    homePlanetId: snap?.company.home_planet_id ?? planets[0]?.id ?? null,
    planet: (id) => (id ? planetById.get(id) : undefined),
    planetName: (id) => (id ? planetById.get(id)?.name ?? id : '—'),
    locationLabel: (id) => {
      if (!id) return '—';
      return locationById.get(id)?.label ?? (isStationId(id) ? id : id);
    },
    locationExists: (id) => (id ? locationById.has(id) : false),
    stationLabel: (id) => {
      if (!id) return '—';
      return locationById.get(id)?.label ?? id;
    },
    holdings,
    holding: (itemId) => holdings.get(itemId),
    totalHeld: (itemId) => holdings.get(itemId)?.total ?? 0,
    openOrders,
    openOrdersByItem,
    tickerByStation,
    quotesByItem,
    ticker: (stationId, itemId) => tickerByKey.get(`${stationId}::${itemId}`),
    ships,
    busyShips: ships.filter((s) => s.is_busy).length,
  };

  return index;
}

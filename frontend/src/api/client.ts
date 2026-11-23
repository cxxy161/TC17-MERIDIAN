import type {
  IntentPayload,
  MarketBookResp,
  MarketCandlesResp,
  ProductionPack,
  ScriptsResp,
  StateResponse,
} from '../types/meridian';

async function jsonFetch<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, init);
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`${res.status} ${text || res.statusText}`);
  }
  return res.json() as Promise<T>;
}

export const api = {
  getCatalog(): Promise<ProductionPack> {
    return jsonFetch('/api/catalog');
  },

  getState(companyId = 'player1'): Promise<StateResponse> {
    return jsonFetch(`/api/state?company_id=${encodeURIComponent(companyId)}`);
  },

  getMarketBook(stationId: string, itemId: string): Promise<MarketBookResp> {
    return jsonFetch(
      `/api/market/book?station_id=${encodeURIComponent(stationId)}&item_id=${encodeURIComponent(itemId)}&limit=20&candle_limit=500`,
    );
  },

  getMarketCandles(
    stationId: string,
    itemId: string,
    opts?: { period?: number; fromTick?: number; toTick?: number },
  ): Promise<MarketCandlesResp> {
    const qs = new URLSearchParams({
      station_id: stationId,
      item_id: itemId,
      period: String(Math.max(1, Math.floor(opts?.period ?? 1))),
    });
    if (opts?.fromTick !== undefined) {
      qs.set('from_tick', String(Math.max(0, Math.floor(opts.fromTick))));
    }
    if (opts?.toTick !== undefined) {
      qs.set('to_tick', String(Math.max(0, Math.floor(opts.toTick))));
    }
    return jsonFetch(`/api/market/candles?${qs.toString()}`);
  },

  getScripts(companyId = 'player1'): Promise<ScriptsResp> {
    return jsonFetch(`/api/scripts/${encodeURIComponent(companyId)}`);
  },

  saveScripts(companyId: string, modules: Record<string, string>, enabled?: boolean): Promise<{ ok: boolean }> {
    return jsonFetch(`/api/scripts/${encodeURIComponent(companyId)}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ modules, enabled }),
    });
  },

  saveMemory(companyId: string, memoryJson: string): Promise<{ ok: boolean }> {
    return jsonFetch(`/api/memory/${encodeURIComponent(companyId)}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ memory_json: memoryJson }),
    });
  },

  sendIntent(companyId: string, intent: IntentPayload): Promise<{ ok: boolean }> {
    return jsonFetch('/api/intent', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ company_id: companyId, intent }),
    });
  },

  simControl(action: 'pause' | 'resume' | 'step' | 'speed' | 'reset', tickMs?: number): Promise<unknown> {
    return jsonFetch('/api/sim/control', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action, tick_ms: tickMs }),
    });
  },

  createCompany(req: {
    id: string;
    name: string;
    is_player: boolean;
    profession: string;
    home_planet_id: string;
    initial_cash?: number;
  }): Promise<{ ok: boolean; id: string }> {
    return jsonFetch('/api/companies', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(req),
    });
  },
};

import type {
  ConsoleEvalResp,
  IntentPayload,
  MarketBookResp,
  MarketCandlesResp,
  PlanetPlotsResp,
  ProductionPack,
  PublicCompanyDetail,
  ScriptsResp,
  SendIntentResp,
  StateResponse,
} from '../types/meridian';

async function jsonFetch<T>(url: string, init?: RequestInit): Promise<T> {
  // 会话是 HttpOnly Cookie，所有请求都要带上，否则后端只能看到匿名请求
  const res = await fetch(url, { credentials: 'same-origin', ...init });
  if (!res.ok) {
    const text = await res.text();
    // 会话失效（过期/被吊销/后端重启）时统一回到登录页，而不是卡在报错的桌面上
    if (res.status === 401) unauthorizedHandler?.();
    throw new Error(`${res.status} ${text || res.statusText}`);
  }
  return res.json() as Promise<T>;
}

/** 带状态码与响应体上抛的错误，供登录/注册表单做字段级提示 */
export class ApiError extends Error {
  readonly status: number;
  readonly payload: unknown;

  constructor(status: number, payload: unknown, message?: string) {
    super(message ?? `HTTP ${status}`);
    this.name = 'ApiError';
    this.status = status;
    this.payload = payload;
  }
}

async function jsonRequest<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, {
    credentials: 'same-origin',
    ...init,
  });
  const text = await res.text();
  let payload: unknown = null;
  if (text) {
    try {
      payload = JSON.parse(text) as unknown;
    } catch {
      payload = text;
    }
  }
  if (!res.ok) throw new ApiError(res.status, payload);
  return payload as T;
}

export interface SessionUser {
  company_id: string;
  nickname: string;
  email: string;
  role: string;
  needs_onboarding?: boolean;
}

export interface OnboardingSupply {
  item_id: string;
  item_name: string;
  qty: number;
}

export interface OnboardingProfession {
  id: string;
  name: string;
  demand_category: string;
  color: string;
  description: string;
  starter_cash: number;
  starter_supplies: OnboardingSupply[];
}

export interface OnboardingTile {
  slot_id: number;
  lat: number;
  lon: number;
  terrain_name: string;
  capacity: number;
  building_mods: Record<string, number>;
}

export interface OnboardingPlanetDemand {
  item_id: string;
  item_name: string;
  qty: number;
}

export interface OnboardingSystem {
  id: string;
  name: string;
  star_class: string;
  luminosity: number;
  hub_station_id: string;
  hub_orbit_radius: number;
  hub_orbit_days: number;
  hub_orbit_angle: number;
}

export interface OnboardingPlanet {
  id: string;
  system_id: string;
  name: string;
  archetype: string;
  wealth_tier: number;
  prosperity: number;
  population: number;
  gravity: number;
  habitability: number;
  orbit_radius: number;
  orbit_angle: number;
  rotation_days: number;
  visual_seed: number;
  solar_mult: number;
  mineral_mult: number;
  water_mult: number;
  ocean_ratio: number;
  city_count: number;
  city_level: number;
  city_capacity: number;
  treasury: number;
  bank_reserves: number;
  bank_rate_bps: number;
  resident_count: number;
  launch_cost: [number, number] | null;
  hub_cost: [number, number] | null;
  demands: OnboardingPlanetDemand[];
  unclaimed_count: number;
  tiles: OnboardingTile[];
}

export interface OnboardingOptions {
  starter_cash: number;
  tick: number;
  tick_ms: number;
  ticks_per_day: number;
  system: OnboardingSystem;
  professions: OnboardingProfession[];
  planets: OnboardingPlanet[];
}

export interface AccountSession {
  /** 后端为 i64，跨语言保持宽松：调用方不要假设它是字符串 */
  id: string | number;
  created_at: string | number;
  last_seen_at: string | number;
  current: boolean;
  user_agent: string;
}

export interface AccountInfo {
  email: string;
  nickname: string;
  role: string;
  company_id: string;
  created_at: string | number;
  nickname_changed_at: string | number | null;
  sessions: AccountSession[];
}

/**
 * 401 兜底：会话过期/被吊销时，任何走 accountApi 的请求都会在这里通知上层把全局会话
 * 切回 anon，SessionGate 随之下线回到登录页。注册由 useSessionStore 完成 —— client 不反向
 * import store（避免循环依赖）。
 */
let unauthorizedHandler: (() => void) | null = null;

export function setUnauthorizedHandler(fn: (() => void) | null): void {
  unauthorizedHandler = fn;
}

/** 已登录态下的账号请求：401 统一触发会话失效处理后再上抛，供调用方决定是否提示。 */
async function accountRequest<T>(url: string, init?: RequestInit): Promise<T> {
  try {
    return await jsonRequest<T>(url, init);
  } catch (err) {
    if (err instanceof ApiError && err.status === 401) unauthorizedHandler?.();
    throw err;
  }
}

/**
 * 当前登录玩家。后端会话层落地后，所有玩家态请求都应以它为唯一身份来源，
 * 不再接受前端传入的 company_id（那是历史硬编码，见 docs/MULTIPLAYER_AUDIT.md）。
 */
let currentCompanyId = 'player1';

export function setCurrentCompany(id: string): void {
  currentCompanyId = id;
}

export function getCurrentCompany(): string {
  return currentCompanyId;
}

export interface AuthConfig {
  turnstile_site_key: string;
  turnstile_required: boolean;
  turnstile_bypassed?: boolean;
}

export const authApi = {
  config(): Promise<AuthConfig> {
    return jsonRequest<AuthConfig>('/api/auth/config');
  },

  me(): Promise<SessionUser> {
    return jsonRequest<SessionUser>('/api/auth/me');
  },

  login(body: { email: string; password: string; remember?: boolean }): Promise<SessionUser> {
    return jsonRequest<SessionUser>('/api/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
  },

  register(body: {
    email: string;
    nickname: string;
    password: string;
    turnstile_token?: string;
    defer_onboarding?: boolean;
  }): Promise<SessionUser> {
    return jsonRequest<SessionUser>('/api/auth/register', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
  },

  onboardingOptions(): Promise<OnboardingOptions> {
    return accountRequest<OnboardingOptions>('/api/onboarding/options');
  },

  submitOnboarding(body: {
    company_name: string;
    profession: string;
    planet_id: string;
    slot_id: number;
  }): Promise<SessionUser> {
    return accountRequest<SessionUser>('/api/onboarding/setup', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
  },

  logout(): Promise<{ ok: boolean }> {
    return jsonRequest<{ ok: boolean }>('/api/auth/logout', { method: 'POST' });
  },
};

/**
 * 个人设置页用的账号接口。除 me() 外都走 accountRequest：401 会先把会话置为失效，
 * 否则设置页会停在一个已过期会话上继续报错。
 */
export const accountApi = {
  /** me() 是会话探测，401 属于正常分支（未登录），不触发失效处理，避免与 bootstrap 重复登出。 */
  me(): Promise<SessionUser> {
    return jsonRequest<SessionUser>('/api/auth/me');
  },

  get(): Promise<AccountInfo> {
    return accountRequest<AccountInfo>('/api/account');
  },

  updateNickname(nickname: string): Promise<{ ok: boolean; nickname: string }> {
    return accountRequest<{ ok: boolean; nickname: string }>('/api/account', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ nickname }),
    });
  },

  changePassword(currentPassword: string, newPassword: string): Promise<{ ok: boolean }> {
    return accountRequest<{ ok: boolean }>('/api/account/password', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ current_password: currentPassword, new_password: newPassword }),
    });
  },

  revokeSessions(
    target: { session_id: string | number } | { all: true },
  ): Promise<{ ok: boolean }> {
    return accountRequest<{ ok: boolean }>('/api/account/sessions/revoke', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(target),
    });
  },

  getLayouts(): Promise<{ bundle: unknown | null; updated_at: number | null }> {
    return accountRequest<{ bundle: unknown | null; updated_at: number | null }>('/api/account/layouts');
  },

  saveLayouts(bundle: unknown): Promise<{ ok: boolean; updated_at: number }> {
    return accountRequest<{ ok: boolean; updated_at: number }>('/api/account/layouts', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ bundle }),
    });
  },
};

export const api = {
  getCatalog(): Promise<ProductionPack> {
    return jsonFetch('/api/catalog');
  },

  getState(companyId = currentCompanyId): Promise<StateResponse> {
    return jsonFetch(`/api/state?company_id=${encodeURIComponent(companyId)}`);
  },

  getPlanetPlots(planetId: string): Promise<PlanetPlotsResp> {
    return jsonFetch(`/api/planets/${encodeURIComponent(planetId)}/plots`);
  },

  getCompanyDetail(companyId: string): Promise<PublicCompanyDetail> {
    return jsonFetch(`/api/companies/${encodeURIComponent(companyId)}`);
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

  getScripts(companyId = currentCompanyId): Promise<ScriptsResp> {
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

  evalConsole(companyId: string, code: string): Promise<ConsoleEvalResp> {
    return jsonFetch('/api/console/eval', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ company_id: companyId, code }),
    });
  },

  sendIntent(companyId: string, intent: IntentPayload): Promise<SendIntentResp> {
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

import { create } from 'zustand';
import { api } from '../api/client';
import type { ConsoleValue } from '../utils/consoleFormat';
import type {
  IntentPayload,
  MarketBookResp,
  ProductionPack,
  ScriptsResp,
  StateResponse,
} from '../types/meridian';

export interface LogHistoryLine {
  tick: number;
  level: 'log' | 'warn' | 'error' | 'system' | 'input' | 'result';
  message: string;
  values?: ConsoleValue[];
}

export interface QuoteSample {
  tick: number;
  price: number;
}

export interface FocusState {
  planetId?: string;
  locationId?: string;
  stationId?: string;
  itemId?: string;
}

/**
 * Only the books someone is actually watching get a price series. Previously every station/item
 * pair in the world accumulated 500 samples, which is O(stations × items × 500) of retained memory
 * for data no panel ever read.
 */
function mergeQuoteHistory(
  prev: Record<string, QuoteSample[]>,
  state: StateResponse,
  watched?: Record<string, unknown>,
): Record<string, QuoteSample[]> {
  const next: Record<string, QuoteSample[]> = watched ? {} : { ...prev };
  const t = state.tick;
  for (const row of state.market_tickers ?? []) {
    const key = `${row.station_id}::${row.item_id}`;
    if (watched && !(key in watched)) continue;
    const arr = next[key] ?? [];
    const last = arr[arr.length - 1];
    if (!last || t < last.tick) {
      next[key] = [{ tick: t, price: row.last_price }];
    } else if (last.tick < t) {
      next[key] = [...arr, { tick: t, price: row.last_price }].slice(-500);
    } else if (last.price !== row.last_price) {
      next[key] = [...arr.slice(0, -1), { tick: t, price: row.last_price }];
    }
  }
  return next;
}

const FOLDERS_STORAGE_KEY = 'meridian.script_folders.v1';
const DRAFT_STORAGE_PREFIX = 'meridian.script_draft.v1.';

interface StoredScriptDraft {
  modules: Record<string, string>;
  activeModule?: string;
}

function loadScriptDraft(companyId: string): StoredScriptDraft | null {
  try {
    const raw = window.localStorage.getItem(`${DRAFT_STORAGE_PREFIX}${companyId}`);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== 'object') return null;
    const obj = parsed as { modules?: unknown; activeModule?: unknown };
    if (!obj.modules || typeof obj.modules !== 'object' || Array.isArray(obj.modules)) return null;
    const cleanMods: Record<string, string> = {};
    for (const [k, v] of Object.entries(obj.modules)) {
      if (typeof v === 'string') cleanMods[k] = v;
    }
    if (Object.keys(cleanMods).length === 0) return null;
    return {
      modules: cleanMods,
      activeModule: typeof obj.activeModule === 'string' ? obj.activeModule : undefined,
    };
  } catch {
    return null;
  }
}

function saveScriptDraft(companyId: string, modules: Record<string, string>, activeModule: string): void {
  try {
    window.localStorage.setItem(
      `${DRAFT_STORAGE_PREFIX}${companyId}`,
      JSON.stringify({ modules, activeModule, savedAt: Date.now() }),
    );
  } catch {
    // ignore quota errors
  }
}

function clearScriptDraft(companyId: string): void {
  try {
    window.localStorage.removeItem(`${DRAFT_STORAGE_PREFIX}${companyId}`);
  } catch {
    // ignore
  }
}

function modulesEqual(a: Record<string, string>, b: Record<string, string>): boolean {
  const ka = Object.keys(a);
  const kb = Object.keys(b);
  if (ka.length !== kb.length) return false;
  for (const k of ka) {
    if (a[k] !== b[k]) return false;
  }
  return true;
}

function resolveInitialDraftState(
  companyId: string,
  serverMods: Record<string, string>,
  currentActive: string,
): { draftModules: Record<string, string>; scriptDirty: boolean; activeScriptModule: string } {
  const stored = loadScriptDraft(companyId);
  if (stored && !modulesEqual(stored.modules, serverMods)) {
    const active =
      stored.activeModule && stored.modules[stored.activeModule] !== undefined
        ? stored.activeModule
        : stored.modules[currentActive] !== undefined
          ? currentActive
          : stored.modules.main !== undefined
            ? 'main'
            : Object.keys(stored.modules)[0] ?? 'main';
    return { draftModules: stored.modules, scriptDirty: true, activeScriptModule: active };
  }
  if (stored) {
    clearScriptDraft(companyId);
  }
  const active =
    serverMods[currentActive] !== undefined
      ? currentActive
      : serverMods.main !== undefined
        ? 'main'
        : Object.keys(serverMods)[0] ?? 'main';
  return { draftModules: serverMods, scriptDirty: false, activeScriptModule: active };
}

function loadFolders(): string[] {
  try {
    const raw = window.localStorage.getItem(FOLDERS_STORAGE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) return parsed.filter((x) => typeof x === 'string');
    }
  } catch {
    // ignore
  }
  return [];
}

function saveFolders(folders: string[]): void {
  try {
    window.localStorage.setItem(FOLDERS_STORAGE_KEY, JSON.stringify(folders));
  } catch {
    // ignore
  }
}

interface GameStore {
  catalog: ProductionPack | null;
  state: StateResponse | null;
  scripts: ScriptsResp | null;
  draftModules: Record<string, string>;
  activeScriptModule: string;
  scriptDirty: boolean;
  scriptFolders: string[];
  books: Record<string, MarketBookResp>;
  quoteHistory: Record<string, QuoteSample[]>;
  watchedBooks: Record<string, { stationId: string; itemId: string; refs: number }>;
  companyId: string;
  /** Last entity the player interacted with, used to open new panes without hardcoded defaults. */
  lastFocus: FocusState;
  touchFocus: (patch: FocusState) => void;
  wsStatus: 'connecting' | 'connected' | 'disconnected';
  consoleHistory: LogHistoryLine[];
  lastError: string | null;

  init: () => Promise<void>;
  refreshState: () => Promise<void>;
  refreshScripts: () => Promise<void>;
  watchBook: (stationId: string, itemId: string) => () => void;
  fetchBook: (stationId: string, itemId: string) => Promise<void>;
  sendIntent: (intent: IntentPayload) => Promise<void>;
  simControl: (action: 'pause' | 'resume' | 'step' | 'speed' | 'reset', tickMs?: number) => Promise<void>;
  saveScripts: (modules: Record<string, string>, enabled?: boolean) => Promise<void>;
  saveDraftScripts: () => Promise<void>;
  discardDraftScripts: () => void;
  saveMemory: (memoryJson: string) => Promise<void>;
  setActiveScriptModule: (name: string) => void;
  updateDraftModule: (name: string, code: string) => void;
  createDraftModule: (name: string, code?: string) => void;
  renameDraftModule: (oldName: string, newName: string) => void;
  deleteDraftModule: (name: string) => void;
  createScriptFolder: (folderPath: string) => void;
  renameScriptFolder: (oldPath: string, newPath: string) => void;
  deleteScriptFolder: (folderPath: string) => void;
  appendConsoleLines: (lines: LogHistoryLine[]) => void;
  clearConsole: () => void;
  setCompanyId: (cid: string) => void;
  clearError: () => void;
}

let wsInstance: WebSocket | null = null;
let reconnectTimer: number | null = null;
let tickSyncInFlight = false;
let tickSyncPending = false;
let bookSeqCounter = 0;
let bookRotation = 0;
/** Upper bound of book refreshes started in a single tick. */
const MAX_BOOK_FETCH_PER_TICK = 6;
const latestBookSeq: Record<string, number> = {};

export const useGameStore = create<GameStore>((set, get) => ({
  catalog: null,
  state: null,
  scripts: null,
  draftModules: {},
  activeScriptModule: 'main',
  scriptDirty: false,
  scriptFolders: loadFolders(),
  books: {},
  quoteHistory: {},
  watchedBooks: {},
  companyId: 'player1',
  lastFocus: {},
  wsStatus: 'connecting',
  consoleHistory: [],
  lastError: null,

  init: async () => {
    try {
      const [catalog, state, scripts] = await Promise.all([
        api.getCatalog(),
        api.getState(get().companyId),
        api.getScripts(get().companyId).catch(() => null),
      ]);
      const mods = scripts?.modules ?? {};
      set((prev) => {
        if (prev.scriptDirty) {
          return {
            catalog,
            state,
            scripts,
            quoteHistory: mergeQuoteHistory(prev.quoteHistory, state, prev.watchedBooks),
            lastError: null,
          };
        }
        const resolved = resolveInitialDraftState(prev.companyId, mods, prev.activeScriptModule);
        return {
          catalog,
          state,
          scripts,
          quoteHistory: mergeQuoteHistory(prev.quoteHistory, state, prev.watchedBooks),
          draftModules: resolved.draftModules,
          scriptDirty: resolved.scriptDirty,
          activeScriptModule: resolved.activeScriptModule,
          lastError: null,
        };
      });
    } catch (e) {
      set({ lastError: e instanceof Error ? e.message : String(e) });
    }

    const connectWs = () => {
      if (wsInstance && wsInstance.readyState <= WebSocket.OPEN) return;
      const proto = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
      const ws = new WebSocket(`${proto}//${window.location.host}/ws`);
      wsInstance = ws;
      set({ wsStatus: 'connecting' });

      ws.onopen = () => set({ wsStatus: 'connected' });
      ws.onclose = () => {
        set({ wsStatus: 'disconnected' });
        if (reconnectTimer) window.clearTimeout(reconnectTimer);
        reconnectTimer = window.setTimeout(connectWs, 2000);
      };
      ws.onerror = () => set({ wsStatus: 'disconnected' });
      ws.onmessage = async (ev) => {
        try {
          const msg = JSON.parse(ev.data as string);
          if (msg.kind === 'init' && msg.state) {
            const initState = msg.state as StateResponse;
            set((prev) => {
              const rolledBack = prev.state !== null && initState.tick < prev.state.tick;
              return {
                state: initState,
                books: rolledBack ? {} : prev.books,
                quoteHistory: mergeQuoteHistory(
                  rolledBack ? {} : prev.quoteHistory,
                  initState,
                  prev.watchedBooks,
                ),
              };
            });
            return;
          }
          if (msg.kind === 'tick') {
            const cid = get().companyId;
            const playerOut = msg.player_outputs?.[cid];
            const additions: LogHistoryLine[] = [];
            if (playerOut?.logs) {
              for (const l of playerOut.logs) {
                additions.push({ tick: msg.tick, level: l.level, message: l.message });
              }
            }
            if (playerOut?.error) {
              additions.push({ tick: msg.tick, level: 'error', message: playerOut.error });
            }

            if (additions.length > 0) {
              set((prev) => ({
                consoleHistory: [...prev.consoleHistory, ...additions].slice(-500),
              }));
            }

            if (tickSyncInFlight) {
              tickSyncPending = true;
              return;
            }
            tickSyncInFlight = true;
            try {
              do {
                tickSyncPending = false;
                const companyId = get().companyId;
                // Cap the per-tick fanout: one HTTP request per watched book per tick does not
                // scale past a handful of panes, so rotate through the watched set instead.
                const allWatched = Object.values(get().watchedBooks);
                const budget = MAX_BOOK_FETCH_PER_TICK;
                const offset = allWatched.length > budget ? bookRotation++ % allWatched.length : 0;
                const watched =
                  allWatched.length <= budget
                    ? allWatched
                    : [...allWatched.slice(offset), ...allWatched.slice(0, offset)].slice(0, budget);
                const bookSeqs = watched.map((w) => {
                  const key = `${w.stationId}::${w.itemId}`;
                  const seq = ++bookSeqCounter;
                  latestBookSeq[key] = seq;
                  return { ...w, key, seq };
                });

                const [nextState, bookResults] = await Promise.all([
                  api.getState(companyId).catch(() => null),
                  Promise.all(
                    bookSeqs.map(async (entry) => {
                      try {
                        const book = await api.getMarketBook(entry.stationId, entry.itemId);
                        return { key: entry.key, seq: entry.seq, book };
                      } catch {
                        return null;
                      }
                    }),
                  ),
                ]);

                set((prev) => {
                  const rolledBack =
                    nextState !== null && prev.state !== null && nextState.tick < prev.state.tick;
                  const nextBooks = rolledBack ? {} : { ...prev.books };
                  for (const res of bookResults) {
                    if (res && latestBookSeq[res.key] === res.seq) {
                      nextBooks[res.key] = res.book;
                    }
                  }
                  if (!nextState) {
                    return { books: nextBooks };
                  }
                  return {
                    state: nextState,
                    books: nextBooks,
                    quoteHistory: mergeQuoteHistory(
                      rolledBack ? {} : prev.quoteHistory,
                      nextState,
                      prev.watchedBooks,
                    ),
                    scripts:
                      prev.scripts && nextState.last_player_output
                        ? {
                            ...prev.scripts,
                            memory_json: nextState.last_player_output.memory_json,
                            last_output: nextState.last_player_output,
                          }
                        : prev.scripts,
                  };
                });
              } while (tickSyncPending);
            } finally {
              tickSyncInFlight = false;
            }
          }
        } catch {
          // ignore malformed frames
        }
      };
    };

    connectWs();
  },

  refreshState: async () => {
    try {
      const state = await api.getState(get().companyId);
      set((prev) => ({
        state,
        quoteHistory: mergeQuoteHistory(prev.quoteHistory, state, prev.watchedBooks),
        scripts:
          prev.scripts && state.last_player_output
            ? {
                ...prev.scripts,
                memory_json: state.last_player_output.memory_json,
                last_output: state.last_player_output,
              }
            : prev.scripts,
      }));
    } catch (e) {
      set({ lastError: e instanceof Error ? e.message : String(e) });
    }
  },

  refreshScripts: async () => {
    try {
      const cid = get().companyId;
      const scripts = await api.getScripts(cid);
      set((prev) => {
        if (prev.scriptDirty) return { scripts };
        const resolved = resolveInitialDraftState(cid, scripts.modules, prev.activeScriptModule);
        return {
          scripts,
          draftModules: resolved.draftModules,
          scriptDirty: resolved.scriptDirty,
          activeScriptModule: resolved.activeScriptModule,
        };
      });
    } catch (e) {
      set({ lastError: e instanceof Error ? e.message : String(e) });
    }
  },

  watchBook: (stationId, itemId) => {
    const key = `${stationId}::${itemId}`;
    set((prev) => {
      const cur = prev.watchedBooks[key];
      return {
        watchedBooks: {
          ...prev.watchedBooks,
          [key]: { stationId, itemId, refs: (cur?.refs ?? 0) + 1 },
        },
      };
    });
    void get().fetchBook(stationId, itemId);
    return () => {
      set((prev) => {
        const cur = prev.watchedBooks[key];
        if (!cur || cur.refs <= 1) {
          const next = { ...prev.watchedBooks };
          delete next[key];
          return { watchedBooks: next };
        }
        return {
          watchedBooks: {
            ...prev.watchedBooks,
            [key]: { ...cur, refs: cur.refs - 1 },
          },
        };
      });
    };
  },

  fetchBook: async (stationId, itemId) => {
    const key = `${stationId}::${itemId}`;
    const seq = ++bookSeqCounter;
    latestBookSeq[key] = seq;
    try {
      const book = await api.getMarketBook(stationId, itemId);
      if (latestBookSeq[key] !== seq) return;
      set((prev) => ({
        books: { ...prev.books, [key]: book },
      }));
    } catch (e) {
      set({ lastError: e instanceof Error ? e.message : String(e) });
    }
  },

  sendIntent: async (intent) => {
    try {
      await api.sendIntent(get().companyId, intent);
    } catch (e) {
      set({ lastError: e instanceof Error ? e.message : String(e) });
    }
  },

  simControl: async (action, tickMs) => {
    try {
      await api.simControl(action, tickMs);
      if (action === 'reset') {
        for (const k of Object.keys(latestBookSeq)) delete latestBookSeq[k];
        set({ scriptDirty: false, consoleHistory: [], books: {}, quoteHistory: {} });
        await get().refreshState();
        await get().refreshScripts();
      } else {
        await get().refreshState();
      }
      const watched = Object.values(get().watchedBooks);
      await Promise.all(watched.map((w) => get().fetchBook(w.stationId, w.itemId)));
    } catch (e) {
      set({ lastError: e instanceof Error ? e.message : String(e) });
    }
  },

  saveScripts: async (modules, enabled) => {
    try {
      const cid = get().companyId;
      await api.saveScripts(cid, modules, enabled);
      clearScriptDraft(cid);
      set({ scriptDirty: false, draftModules: modules });
      await get().refreshScripts();
    } catch (e) {
      set({ lastError: e instanceof Error ? e.message : String(e) });
    }
  },

  saveDraftScripts: async () => {
    const { draftModules, scripts } = get();
    const toSave = Object.keys(draftModules).length > 0 ? draftModules : (scripts?.modules ?? {});
    await get().saveScripts(toSave, scripts?.enabled ?? true);
  },

  discardDraftScripts: () => {
    const { companyId, scripts, activeScriptModule } = get();
    clearScriptDraft(companyId);
    const serverMods = scripts?.modules ?? { main: '' };
    const nextActive =
      serverMods[activeScriptModule] !== undefined
        ? activeScriptModule
        : serverMods.main !== undefined
          ? 'main'
          : Object.keys(serverMods)[0] ?? 'main';
    set({
      draftModules: serverMods,
      scriptDirty: false,
      activeScriptModule: nextActive,
    });
  },

  saveMemory: async (memoryJson) => {
    try {
      await api.saveMemory(get().companyId, memoryJson);
      await get().refreshScripts();
    } catch (e) {
      set({ lastError: e instanceof Error ? e.message : String(e) });
    }
  },

  setActiveScriptModule: (name) =>
    set((prev) => {
      if (prev.scriptDirty) {
        saveScriptDraft(prev.companyId, prev.draftModules, name);
      }
      return { activeScriptModule: name };
    }),

  updateDraftModule: (name, code) =>
    set((prev) => {
      const base =
        Object.keys(prev.draftModules).length > 0
          ? prev.draftModules
          : (prev.scripts?.modules ?? {});
      const next = { ...base, [name]: code };
      const dirty = !modulesEqual(next, prev.scripts?.modules ?? {});
      if (dirty) saveScriptDraft(prev.companyId, next, name);
      else clearScriptDraft(prev.companyId);
      return {
        draftModules: next,
        scriptDirty: dirty,
      };
    }),

  createDraftModule: (name, code) => {
    const clean = name.trim().replace(/^\/+|\/+$/g, '').replace(/\.js$/, '');
    if (!clean) return;
    set((prev) => {
      const base =
        Object.keys(prev.draftModules).length > 0
          ? prev.draftModules
          : (prev.scripts?.modules ?? {});
      const next = {
        ...base,
        [clean]: base[clean] ?? code ?? `// 模块 ${clean}.js\nexports.run = function () {\n  \n};\n`,
      };
      saveScriptDraft(prev.companyId, next, clean);
      return {
        draftModules: next,
        activeScriptModule: clean,
        scriptDirty: true,
      };
    });
  },

  renameDraftModule: (oldName, newName) => {
    const clean = newName.trim().replace(/^\/+|\/+$/g, '').replace(/\.js$/, '');
    if (!clean || clean === oldName) return;
    set((prev) => {
      const base =
        Object.keys(prev.draftModules).length > 0
          ? prev.draftModules
          : (prev.scripts?.modules ?? {});
      if (!(oldName in base) || clean in base) return prev;
      const next = { ...base };
      next[clean] = next[oldName];
      delete next[oldName];
      const nextActive = prev.activeScriptModule === oldName ? clean : prev.activeScriptModule;
      const dirty = !modulesEqual(next, prev.scripts?.modules ?? {});
      if (dirty) saveScriptDraft(prev.companyId, next, nextActive);
      else clearScriptDraft(prev.companyId);
      return {
        draftModules: next,
        activeScriptModule: nextActive,
        scriptDirty: dirty,
      };
    });
  },

  deleteDraftModule: (name) => {
    if (name === 'main') return;
    set((prev) => {
      const base =
        Object.keys(prev.draftModules).length > 0
          ? prev.draftModules
          : (prev.scripts?.modules ?? {});
      if (!(name in base)) return prev;
      const next = { ...base };
      delete next[name];
      const nextActive =
        prev.activeScriptModule === name
          ? (next.main !== undefined ? 'main' : Object.keys(next)[0] ?? 'main')
          : prev.activeScriptModule;
      const dirty = !modulesEqual(next, prev.scripts?.modules ?? {});
      if (dirty) saveScriptDraft(prev.companyId, next, nextActive);
      else clearScriptDraft(prev.companyId);
      return {
        draftModules: next,
        activeScriptModule: nextActive,
        scriptDirty: dirty,
      };
    });
  },

  createScriptFolder: (folderPath) => {
    const clean = folderPath.trim().replace(/^\/+|\/+$/g, '');
    if (!clean) return;
    set((prev) => {
      if (prev.scriptFolders.includes(clean)) return prev;
      const next = [...prev.scriptFolders, clean];
      saveFolders(next);
      return { scriptFolders: next };
    });
  },

  renameScriptFolder: (oldPath, newPath) => {
    const cleanOld = oldPath.trim().replace(/^\/+|\/+$/g, '');
    const cleanNew = newPath.trim().replace(/^\/+|\/+$/g, '');
    if (
      !cleanOld ||
      !cleanNew ||
      cleanOld === cleanNew ||
      cleanNew.startsWith(`${cleanOld}/`)
    ) {
      return;
    }
    set((prev) => {
      const nextMods: Record<string, string> = {};
      const prefix = `${cleanOld}/`;
      for (const [k, v] of Object.entries(prev.draftModules)) {
        if (k.startsWith(prefix)) {
          nextMods[`${cleanNew}/${k.slice(prefix.length)}`] = v;
        } else {
          nextMods[k] = v;
        }
      }
      const nextFoldersSet = new Set(
        prev.scriptFolders.map((f) => {
          if (f === cleanOld) return cleanNew;
          if (f.startsWith(prefix)) return `${cleanNew}/${f.slice(prefix.length)}`;
          return f;
        }),
      );
      nextFoldersSet.add(cleanNew);
      const nextFolders = Array.from(nextFoldersSet);
      saveFolders(nextFolders);
      const nextActive = prev.activeScriptModule.startsWith(prefix)
        ? `${cleanNew}/${prev.activeScriptModule.slice(prefix.length)}`
        : prev.activeScriptModule;
      const dirty = !modulesEqual(nextMods, prev.scripts?.modules ?? {});
      if (dirty) saveScriptDraft(prev.companyId, nextMods, nextActive);
      else clearScriptDraft(prev.companyId);
      return {
        draftModules: nextMods,
        scriptFolders: nextFolders,
        activeScriptModule: nextActive,
        scriptDirty: dirty,
      };
    });
  },

  deleteScriptFolder: (folderPath) => {
    const clean = folderPath.trim().replace(/^\/+|\/+$/g, '');
    if (!clean) return;
    set((prev) => {
      const prefix = `${clean}/`;
      const nextMods: Record<string, string> = {};
      for (const [k, v] of Object.entries(prev.draftModules)) {
        if (!k.startsWith(prefix)) {
          nextMods[k] = v;
        }
      }
      const nextFolders = prev.scriptFolders.filter((f) => f !== clean && !f.startsWith(prefix));
      saveFolders(nextFolders);
      const nextActive = prev.activeScriptModule.startsWith(prefix)
        ? (nextMods.main !== undefined ? 'main' : Object.keys(nextMods)[0] ?? 'main')
        : prev.activeScriptModule;
      const dirty = !modulesEqual(nextMods, prev.scripts?.modules ?? {});
      if (dirty) saveScriptDraft(prev.companyId, nextMods, nextActive);
      else clearScriptDraft(prev.companyId);
      return {
        draftModules: nextMods,
        scriptFolders: nextFolders,
        activeScriptModule: nextActive,
        scriptDirty: dirty,
      };
    });
  },

  appendConsoleLines: (lines) =>
    set((prev) => ({
      consoleHistory: [...prev.consoleHistory, ...lines].slice(-500),
    })),

  clearConsole: () => set({ consoleHistory: [] }),
  touchFocus: (patch) =>
    set((prev) => {
      const next = { ...prev.lastFocus };
      let changed = false;
      for (const [k, v] of Object.entries(patch) as Array<[keyof FocusState, string | undefined]>) {
        if (v && next[k] !== v) {
          next[k] = v;
          changed = true;
        }
      }
      return changed ? { lastFocus: next } : {};
    }),

  setCompanyId: (cid) => {
    set({ companyId: cid });
    void get().refreshState();
    void get().refreshScripts();
  },
  clearError: () => set({ lastError: null }),
}));

import { create } from 'zustand';
import { api } from '../api/client';
import type {
  IntentPayload,
  MarketBookResp,
  ProductionPack,
  ScriptsResp,
  StateResponse,
} from '../types/meridian';

export interface LogHistoryLine {
  tick: number;
  level: 'log' | 'warn' | 'error' | 'system';
  message: string;
}

interface GameStore {
  catalog: ProductionPack | null;
  state: StateResponse | null;
  scripts: ScriptsResp | null;
  books: Record<string, MarketBookResp>;
  watchedBooks: Record<string, { stationId: string; itemId: string; refs: number }>;
  companyId: string;
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
  saveMemory: (memoryJson: string) => Promise<void>;
  clearConsole: () => void;
  setCompanyId: (cid: string) => void;
  clearError: () => void;
}

let wsInstance: WebSocket | null = null;
let reconnectTimer: number | null = null;

export const useGameStore = create<GameStore>((set, get) => ({
  catalog: null,
  state: null,
  scripts: null,
  books: {},
  watchedBooks: {},
  companyId: 'player1',
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
      set({ catalog, state, scripts, lastError: null });
    } catch (e) {
      set({ lastError: e instanceof Error ? e.message : String(e) });
    }

    // Connect live WebSocket
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
            set({ state: msg.state as StateResponse });
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
            if (msg.fills_count > 0) {
              additions.push({
                tick: msg.tick,
                level: 'system',
                message: `本回合撮合成交 ${msg.fills_count} 笔 · 货币误差 Δ=${msg.conservation_error}`,
              });
            }
            if (Array.isArray(msg.bankruptcies) && msg.bankruptcies.length > 0) {
              additions.push({
                tick: msg.tick,
                level: 'warn',
                message: `NPC 清算重演：${msg.bankruptcies.join(', ')}`,
              });
            }

            if (additions.length > 0) {
              set((prev) => ({
                consoleHistory: [...prev.consoleHistory, ...additions].slice(-400),
              }));
            }

            // Refresh full snapshot + watched orderbooks cleanly
            await get().refreshState();
            const watched = Object.values(get().watchedBooks);
            await Promise.all(watched.map((w) => get().fetchBook(w.stationId, w.itemId)));
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
      set({ state });
    } catch (e) {
      set({ lastError: e instanceof Error ? e.message : String(e) });
    }
  },

  refreshScripts: async () => {
    try {
      const scripts = await api.getScripts(get().companyId);
      set({ scripts });
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
    try {
      const book = await api.getMarketBook(stationId, itemId);
      const key = `${stationId}::${itemId}`;
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
      set((prev) => ({
        consoleHistory: [
          ...prev.consoleHistory,
          {
            tick: prev.state?.tick ?? 0,
            level: 'system' as const,
            message: `已提交手动指令，将在下一回合执行`,
          },
        ].slice(-400),
      }));
    } catch (e) {
      set({ lastError: e instanceof Error ? e.message : String(e) });
    }
  },

  simControl: async (action, tickMs) => {
    try {
      await api.simControl(action, tickMs);
      await get().refreshState();
      if (action === 'reset') {
        await get().refreshScripts();
        set({ consoleHistory: [], books: {} });
      }
      const watched = Object.values(get().watchedBooks);
      await Promise.all(watched.map((w) => get().fetchBook(w.stationId, w.itemId)));
    } catch (e) {
      set({ lastError: e instanceof Error ? e.message : String(e) });
    }
  },

  saveScripts: async (modules, enabled) => {
    try {
      await api.saveScripts(get().companyId, modules, enabled);
      await get().refreshScripts();
    } catch (e) {
      set({ lastError: e instanceof Error ? e.message : String(e) });
    }
  },

  saveMemory: async (memoryJson) => {
    try {
      await api.saveMemory(get().companyId, memoryJson);
      await get().refreshScripts();
    } catch (e) {
      set({ lastError: e instanceof Error ? e.message : String(e) });
    }
  },

  clearConsole: () => set({ consoleHistory: [] }),
  setCompanyId: (cid) => {
    set({ companyId: cid });
    void get().refreshState();
    void get().refreshScripts();
  },
  clearError: () => set({ lastError: null }),
}));

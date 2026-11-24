import { create } from 'zustand';
import {
  ApiError,
  authApi,
  setCurrentCompany,
  setUnauthorizedHandler,
  type SessionUser,
} from '../api/client';
import { useGameStore } from './useGameStore';

export type SessionStatus = 'checking' | 'anon' | 'authed';

/**
 * bootstrap 的结果。SessionGate 需要区分「后端未实现鉴权」与「已登录」，才能决定是否放出
 * DEV 直通入口，所以这里把判定带回去，而不是只留一个二值 status。
 */
export type BootstrapResult =
  | { status: 'authed' }
  | { status: 'anon'; authImplemented: boolean };

interface SessionStore {
  status: SessionStatus;
  user: SessionUser | null;
  /** 启动时探测 /api/auth/me。幂等，可重复调用。 */
  bootstrap: () => Promise<BootstrapResult>;
  setUser: (user: SessionUser) => void;
  /** 登出：尽力通知后端清 cookie，然后无条件把本地会话置为 anon。 */
  logout: () => Promise<void>;
}

/**
 * 会话身份的唯一入口：把公司 id 同步给 api 层（currentCompanyId）和游戏 store。
 * 之前 useGameStore 自己写死 'player1'，多账号下会出现
 * 「公司 'player1' 不属于当前账号」的 403。
 */
function applyIdentity(user: SessionUser | null): void {
  const companyId = user?.company_id ?? '';
  setCurrentCompany(companyId);
  useGameStore.getState().setCompanyId(companyId);
}

export const useSessionStore = create<SessionStore>((set) => ({
  status: 'checking',
  user: null,

  bootstrap: async () => {
    try {
      const me = await authApi.me();
      // 后端 SPA fallback 会把未知路由回成 index.html + 200，必须验形状，不能只看状态码
      if (!me || typeof me.company_id !== 'string' || me.company_id === '') {
        throw new ApiError(404, null, 'auth endpoint not implemented');
      }
      applyIdentity(me);
      set({ status: 'authed', user: me });
      return { status: 'authed' };
    } catch (err) {
      set({ status: 'anon', user: null });
      // 与原 SessionGate 一致：只有拿到 401（接口存在但未登录）才算「后端已实现鉴权」；
      // 404 / 连不上后端都保持未实现，从而在 DEV 下仍放出本地直通入口。
      return { status: 'anon', authImplemented: err instanceof ApiError && err.status === 401 };
    }
  },

  setUser: (user) => {
    applyIdentity(user);
    set({ status: 'authed', user });
  },

  logout: async () => {
    try {
      await authApi.logout();
    } catch {
      // 会话可能已经失效（401）或网络断了 —— 本地依旧要退出，不留半登录态
    }
    applyIdentity(null);
    set({ status: 'anon', user: null });
  },
}));

/**
 * 任何 accountApi 请求返回 401（会话过期 / 被其他设备吊销）都走这里：把 store 切回 anon，
 * SessionGate 随即卸载桌面回到 AuthScreen。已在 anon 时不重复登出。
 */
setUnauthorizedHandler(() => {
  const { status, logout } = useSessionStore.getState();
  if (status === 'anon') return;
  void logout();
});

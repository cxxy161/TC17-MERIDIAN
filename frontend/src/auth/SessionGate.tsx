import React, { useCallback, useEffect, useState } from 'react';
import { Loader2 } from 'lucide-react';
import { setCurrentCompany } from '../api/client';
import { useSessionStore } from '../store/useSessionStore';
import { AuthScreen } from './AuthScreen';

/**
 * 会话闸门：启动时探测登录态，未登录渲染 AuthScreen，已登录才挂载游戏桌面。
 * 会话状态（user/status）只存在 useSessionStore 里 —— 这里不再自己持有，
 * 登出或任意接口 401 让 store 切到 anon 时，桌面会自动卸载回到登录页。
 */
export const SessionGate: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const status = useSessionStore((s) => s.status);
  const bootstrap = useSessionStore((s) => s.bootstrap);
  const setUser = useSessionStore((s) => s.setUser);

  const [serverUp, setServerUp] = useState(false);
  // 默认按「未实现」处理：后端下线或路由缺失时给出明确提示，而不是静默失败
  const [authImplemented, setAuthImplemented] = useState(false);
  // DEV 直通只是本组件的渲染开关，不往 store 里塞假会话
  const [devEntered, setDevEntered] = useState(false);

  useEffect(() => {
    let alive = true;
    void (async () => {
      const up = await fetch('/api/health', { credentials: 'same-origin' })
        .then((r) => r.ok)
        .catch(() => false);
      if (!alive) return;
      setServerUp(up);

      const result = await bootstrap();
      if (!alive) return;
      setAuthImplemented(result.status === 'authed' ? true : result.authImplemented);
    })();
    return () => {
      alive = false;
    };
  }, [bootstrap]);

  const devBypass = useCallback(() => {
    setCurrentCompany('player1');
    setDevEntered(true);
  }, []);

  if (status === 'authed' || devEntered) return <>{children}</>;

  if (status === 'checking') {
    return (
      <div className="flex h-full w-full items-center justify-center bg-[#060a10]">
        <div className="flex items-center gap-2 font-mono text-[11px] tracking-[0.2em] text-slate-500">
          <Loader2 size={13} className="animate-spin text-sky-400/70" />
          正在校验会话
        </div>
      </div>
    );
  }

  return (
    <AuthScreen
      serverUp={serverUp}
      authImplemented={authImplemented}
      onAuthed={setUser}
      onDevBypass={import.meta.env.DEV && !authImplemented ? devBypass : undefined}
    />
  );
};

export default SessionGate;

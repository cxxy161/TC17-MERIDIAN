import React, { useEffect, useRef, useState } from 'react';
import {
  AlertTriangle,
  ArrowRight,
  Eye,
  EyeOff,
  Loader2,
  Lock,
  Mail,
  ShieldCheck,
  User,
} from 'lucide-react';
import { ApiError, authApi, setCurrentCompany, type SessionUser } from '../api/client';

type Mode = 'login' | 'register';

export interface AuthScreenProps {
  /** 后端 /api/health 是否可达 */
  serverUp: boolean;
  /** 后端是否已实现 /api/auth/*（未实现时给出明显提示，便于前后端分头开发） */
  authImplemented: boolean;
  /** 仅 DEV 且后端未实现鉴权时出现 */
  onDevBypass?: () => void;
  onAuthed: (user: SessionUser) => void;
}

const TURNSTILE_SITE_KEY =
  (import.meta as unknown as { env?: Record<string, string | undefined> }).env?.VITE_TURNSTILE_SITE_KEY ?? '';

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const NICKNAME_RE = /^[^\s].*[^\s]$|^[^\s]$/;

/* ---------------------------------------------------------------- Turnstile */

let turnstileLoader: Promise<void> | null = null;

function loadTurnstile(): Promise<void> {
  if ((window as { turnstile?: unknown }).turnstile) return Promise.resolve();
  if (!turnstileLoader) {
    turnstileLoader = new Promise<void>((resolve, reject) => {
      const el = document.createElement('script');
      el.src = 'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit';
      el.async = true;
      el.defer = true;
      el.onload = () => resolve();
      el.onerror = () => reject(new Error('turnstile script failed to load'));
      document.head.appendChild(el);
    });
  }
  return turnstileLoader;
}

const TurnstileWidget: React.FC<{ onToken: (token: string) => void; resetSignal: number }> = ({
  onToken,
  resetSignal,
}) => {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const widgetId = useRef<string | null>(null);
  const [failed, setFailed] = useState(false);
  const tokenRef = useRef(onToken);
  tokenRef.current = onToken;

  useEffect(() => {
    if (!TURNSTILE_SITE_KEY) return;
    let cancelled = false;
    loadTurnstile()
      .then(() => {
        if (cancelled || !hostRef.current) return;
        const ts = (window as { turnstile?: any }).turnstile;
        if (!ts?.render) return;
        widgetId.current = ts.render(hostRef.current, {
          sitekey: TURNSTILE_SITE_KEY,
          theme: 'dark',
          size: 'flexible',
          callback: (token: string) => tokenRef.current(token),
          'expired-callback': () => tokenRef.current(''),
          'error-callback': () => {
            tokenRef.current('');
            setFailed(true);
          },
        });
      })
      .catch(() => setFailed(true));
    return () => {
      cancelled = true;
      const ts = (window as { turnstile?: any }).turnstile;
      if (ts?.remove && widgetId.current) ts.remove(widgetId.current);
      widgetId.current = null;
    };
  }, []);

  useEffect(() => {
    if (resetSignal === 0) return;
    const ts = (window as { turnstile?: any }).turnstile;
    if (ts?.reset && widgetId.current) {
      ts.reset(widgetId.current);
      tokenRef.current('');
    }
  }, [resetSignal]);

  if (!TURNSTILE_SITE_KEY) {
    return (
      <div className="border border-dashed border-[rgba(56,189,248,0.18)] px-3 py-3 text-[10px] leading-relaxed text-slate-500">
        TURNSTILE 未配置<span className="text-slate-600">（VITE_TURNSTILE_SITE_KEY）</span>
        <br />
        本地开发跳过人机验证，生产环境必须配置。
      </div>
    );
  }
  if (failed) {
    return (
      <div className="flex items-center gap-2 border border-rose-500/40 bg-rose-500/10 px-3 py-2 text-[11px] text-rose-300">
        <AlertTriangle size={13} /> 人机验证加载失败，请刷新页面重试
      </div>
    );
  }
  return <div ref={hostRef} className="min-h-[65px]" />;
};

/* ------------------------------------------------------------------ helpers */

function passwordScore(pwd: string): number {
  if (!pwd) return 0;
  let s = 0;
  if (pwd.length >= 8) s += 1;
  if (pwd.length >= 12) s += 1;
  if (/[A-Za-z]/.test(pwd) && /\d/.test(pwd)) s += 1;
  if (/[^A-Za-z0-9]/.test(pwd)) s += 1;
  return Math.min(4, s);
}

const INPUT_BASE =
  'w-full rounded-[2px] border bg-[#080d13] py-2 pl-9 pr-9 text-[13px] text-slate-100 outline-none transition-colors placeholder:text-slate-600';

function inputClass(invalid: boolean): string {
  return `${INPUT_BASE} ${
    invalid
      ? 'border-rose-500/60 focus:border-rose-400'
      : 'border-[rgba(56,189,248,0.18)] focus:border-sky-400/70 focus:bg-[#0a1119]'
  }`;
}

const FieldError: React.FC<{ msg?: string }> = ({ msg }) =>
  msg ? <div className="mt-1 text-[10px] text-rose-400">{msg}</div> : null;

/* --------------------------------------------------------------- AuthScreen */

export const AuthScreen: React.FC<AuthScreenProps> = ({ serverUp, authImplemented, onDevBypass, onAuthed }) => {
  const [mode, setMode] = useState<Mode>('login');
  const [email, setEmail] = useState('');
  const [nickname, setNickname] = useState('');
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [remember, setRemember] = useState(true);
  const [showPwd, setShowPwd] = useState(false);
  const [busy, setBusy] = useState(false);
  const [banner, setBanner] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [ttToken, setTtToken] = useState('');
  const [ttReset, setTtReset] = useState(0);

  const isRegister = mode === 'register';
  const score = passwordScore(password);

  const switchMode = (next: Mode) => {
    if (next === mode) return;
    setMode(next);
    setBanner(null);
    setFieldErrors({});
    setPassword('');
    setConfirm('');
    setShowPwd(false);
  };

  const validate = (): Record<string, string> => {
    const errs: Record<string, string> = {};
    if (!EMAIL_RE.test(email.trim())) errs.email = '请输入有效邮箱地址';
    if (isRegister) {
      const nick = nickname.trim();
      if (nick.length < 2 || nick.length > 16) errs.nickname = '昵称需 2–16 个字符';
      else if (!NICKNAME_RE.test(nick)) errs.nickname = '昵称首尾不能是空格';
      if (password.length < 8) errs.password = '密码至少 8 位';
      if (confirm !== password) errs.confirm = '两次输入的密码不一致';
    } else {
      if (!password) errs.password = '请输入密码';
    }
    return errs;
  };

  const onSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (busy) return;
    setBanner(null);
    const errs = validate();
    if (Object.keys(errs).length > 0) {
      setFieldErrors(errs);
      return;
    }
    setFieldErrors({});
    setBusy(true);
    try {
      const user = isRegister
        ? await authApi.register({
            email: email.trim(),
            nickname: nickname.trim(),
            password,
            turnstile_token: ttToken,
          })
        : await authApi.login({ email: email.trim(), password, remember });
      setCurrentCompany(user.company_id);
      onAuthed(user);
    } catch (err) {
      if (err instanceof ApiError) {
        const payload = err.payload as { field?: string; message?: string; error?: string } | null;
        const message = payload?.message ?? payload?.error ?? '请求失败，请稍后重试';
        if (payload?.field) {
          setFieldErrors({ [payload.field]: message });
        } else if (err.status === 401) {
          setBanner('邮箱或密码错误');
        } else if (err.status === 429) {
          setBanner('请求过于频繁，请稍后再试');
        } else if (err.status === 404) {
          setBanner('后端尚未实现 /api/auth/*，请先落地会话接口');
        } else {
          setBanner(message);
        }
        if (isRegister) setTtReset((n) => n + 1);
      } else {
        setBanner('无法连接服务器，请检查网络或后端状态');
      }
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="relative h-full w-full overflow-hidden bg-[#060a10]">
      {/* 背景：径向光晕 + 网格 */}
      <div
        className="pointer-events-none absolute inset-0"
        style={{
          background:
            'radial-gradient(900px 520px at 18% 12%, rgba(56,189,248,0.10), transparent 62%),' +
            'radial-gradient(760px 460px at 88% 88%, rgba(16,185,129,0.08), transparent 60%)',
        }}
      />
      <div
        className="pointer-events-none absolute inset-0 opacity-[0.35]"
        style={{
          backgroundImage:
            'linear-gradient(rgba(56,189,248,0.055) 1px, transparent 1px),' +
            'linear-gradient(90deg, rgba(56,189,248,0.055) 1px, transparent 1px)',
          backgroundSize: '48px 48px',
          maskImage: 'radial-gradient(circle at 50% 40%, black, transparent 78%)',
          WebkitMaskImage: 'radial-gradient(circle at 50% 40%, black, transparent 78%)',
        }}
      />

      <div className="relative z-10 flex h-full items-center justify-center px-6 py-8">
        <div className="grid w-full max-w-[860px] items-center gap-12 md:grid-cols-[1fr_360px]">
          {/* 品牌栏 */}
          <div className="hidden select-none md:block">
            <div className="mb-4 flex items-center gap-2 text-[10px] tracking-[0.32em] text-sky-400/80">
              <span className="inline-block h-1.5 w-1.5 animate-pulse rounded-full bg-emerald-400" />
              GATEWAY ONLINE
            </div>
            <h1 className="text-[34px] font-semibold tracking-[0.30em] text-slate-100">MERIDIAN</h1>
            <div className="mt-2 text-[11px] tracking-[0.18em] text-slate-500">
              星际供应链 · 实时经济模拟
            </div>

            <div className="mt-8 h-px w-full bg-gradient-to-r from-[rgba(56,189,248,0.35)] to-transparent" />

            <dl className="mt-6 space-y-2 font-mono text-[10.5px] text-slate-500">
              <div className="flex justify-between border-b border-white/[0.04] pb-1.5">
                <dt>ENGINE</dt>
                <dd className="text-slate-300">DETERMINISTIC TICK LOOP</dd>
              </div>
              <div className="flex justify-between border-b border-white/[0.04] pb-1.5">
                <dt>SANDBOX</dt>
                <dd className="text-slate-300">QUICKJS · 4 MB HEAP · 5 MS KILL</dd>
              </div>
              <div className="flex justify-between border-b border-white/[0.04] pb-1.5">
                <dt>NPC</dt>
                <dd className="text-slate-300">FREE-PLAY INTENT PARITY</dd>
              </div>
              <div className="flex justify-between">
                <dt>UPTIME TARGET</dt>
                <dd className="text-emerald-400/90">24 / 7 · 2C · 500 MB</dd>
              </div>
            </dl>
          </div>

          {/* 表单卡片 */}
          <div className="w-full border border-[rgba(56,189,248,0.20)] bg-[#0b1017]/92 shadow-[0_24px_60px_-24px_rgba(0,0,0,0.9)] backdrop-blur-sm">
            <div className="flex border-b border-[rgba(56,189,248,0.14)]">
              {(['login', 'register'] as const).map((m) => (
                <button
                  key={m}
                  type="button"
                  onClick={() => switchMode(m)}
                  className={`relative flex-1 py-2.5 text-[11px] tracking-[0.22em] transition-colors ${
                    mode === m
                      ? 'bg-[#0f1722] text-sky-300'
                      : 'text-slate-500 hover:bg-white/[0.02] hover:text-slate-300'
                  }`}
                >
                  {m === 'login' ? '登 录' : '注 册'}
                  {mode === m && (
                    <span className="absolute inset-x-0 bottom-0 h-px bg-sky-400/70" />
                  )}
                </button>
              ))}
            </div>

            <form onSubmit={onSubmit} className="space-y-3.5 p-5">
              {banner && (
                <div className="flex items-start gap-2 border border-rose-500/40 bg-rose-500/10 px-2.5 py-2 text-[11px] leading-relaxed text-rose-300">
                  <AlertTriangle size={13} className="mt-0.5 shrink-0" />
                  <span>{banner}</span>
                </div>
              )}

              {isRegister && (
                <div>
                  <label htmlFor="nickname" className="mb-1 block text-[10px] tracking-[0.18em] text-slate-500">
                    指挥官昵称
                  </label>
                  <div className="relative">
                    <User size={13} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-slate-600" />
                    <input
                      id="nickname"
                      value={nickname}
                      onChange={(e) => setNickname(e.target.value)}
                      autoComplete="nickname"
                      maxLength={16}
                      placeholder="2–16 字符"
                      className={inputClass(Boolean(fieldErrors.nickname))}
                    />
                  </div>
                  <FieldError msg={fieldErrors.nickname} />
                </div>
              )}

              <div>
                <label htmlFor="email" className="mb-1 block text-[10px] tracking-[0.18em] text-slate-500">
                  邮箱
                </label>
                <div className="relative">
                  <Mail size={13} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-slate-600" />
                  <input
                    id="email"
                    type="email"
                    value={email}
                    onChange={(e) => setEmail(e.target.value)}
                    autoComplete="username"
                    spellCheck={false}
                    placeholder="pilot@meridian.space"
                    className={inputClass(Boolean(fieldErrors.email))}
                  />
                </div>
                <FieldError msg={fieldErrors.email} />
              </div>

              <div>
                <label htmlFor="password" className="mb-1 block text-[10px] tracking-[0.18em] text-slate-500">
                  密码
                </label>
                <div className="relative">
                  <Lock size={13} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-slate-600" />
                  <input
                    id="password"
                    type={showPwd ? 'text' : 'password'}
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    autoComplete={isRegister ? 'new-password' : 'current-password'}
                    placeholder={isRegister ? '至少 8 位' : '••••••••'}
                    className={inputClass(Boolean(fieldErrors.password))}
                  />
                  <button
                    type="button"
                    tabIndex={-1}
                    onClick={() => setShowPwd((v) => !v)}
                    className="absolute right-2.5 top-1/2 -translate-y-1/2 text-slate-600 transition-colors hover:text-sky-400"
                    aria-label={showPwd ? '隐藏密码' : '显示密码'}
                  >
                    {showPwd ? <EyeOff size={13} /> : <Eye size={13} />}
                  </button>
                </div>
                {isRegister && password.length > 0 && (
                  <div className="mt-1.5 flex items-center gap-2">
                    <div className="flex h-[3px] flex-1 gap-1">
                      {[0, 1, 2, 3].map((i) => (
                        <span
                          key={i}
                          className={`h-full flex-1 transition-colors ${
                            i < score
                              ? score <= 1
                                ? 'bg-rose-500/80'
                                : score === 2
                                  ? 'bg-amber-400/80'
                                  : 'bg-emerald-400/80'
                              : 'bg-white/10'
                          }`}
                        />
                      ))}
                    </div>
                    <span className="text-[10px] text-slate-500">
                      {['弱', '弱', '一般', '良好', '强'][score]}
                    </span>
                  </div>
                )}
                <FieldError msg={fieldErrors.password} />
              </div>

              {isRegister && (
                <div>
                  <label htmlFor="confirm" className="mb-1 block text-[10px] tracking-[0.18em] text-slate-500">
                    确认密码
                  </label>
                  <div className="relative">
                    <ShieldCheck size={13} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-slate-600" />
                    <input
                      id="confirm"
                      type={showPwd ? 'text' : 'password'}
                      value={confirm}
                      onChange={(e) => setConfirm(e.target.value)}
                      autoComplete="new-password"
                      placeholder="再输入一次"
                      className={inputClass(Boolean(fieldErrors.confirm))}
                    />
                  </div>
                  <FieldError msg={fieldErrors.confirm} />
                </div>
              )}

              {isRegister ? (
                <TurnstileWidget
                  onToken={(t) => setTtToken(t)}
                  resetSignal={ttReset}
                />
              ) : (
                <label className="flex cursor-pointer select-none items-center gap-2 text-[11px] text-slate-500 hover:text-slate-400">
                  <span
                    className={`flex h-3 w-3 items-center justify-center border ${
                      remember ? 'border-sky-400/70 bg-sky-400/20' : 'border-slate-600'
                    }`}
                  >
                    {remember && <span className="h-1.5 w-1.5 bg-sky-300" />}
                  </span>
                  <input
                    type="checkbox"
                    checked={remember}
                    onChange={(e) => setRemember(e.target.checked)}
                    className="sr-only"
                  />
                  保持登录 14 天
                </label>
              )}

              <button
                type="submit"
                disabled={busy}
                className="group flex w-full items-center justify-center gap-2 bg-sky-500 py-2.5 text-[12px] font-semibold tracking-[0.18em] text-[#04121f] transition-colors hover:bg-sky-400 disabled:cursor-not-allowed disabled:bg-sky-500/40 disabled:text-[#041a26]/70"
              >
                {busy ? (
                  <>
                    <Loader2 size={14} className="animate-spin" />
                    {isRegister ? '创建中' : '验证中'}
                  </>
                ) : (
                  <>
                    {isRegister ? '创建账号' : '进入控制台'}
                    <ArrowRight size={14} className="transition-transform group-hover:translate-x-0.5" />
                  </>
                )}
              </button>

              {!authImplemented && (
                <div className="border border-amber-500/25 bg-amber-500/[0.06] px-2.5 py-2 text-[10px] leading-relaxed text-amber-300/80">
                  后端尚未实现 <span className="font-mono">/api/auth/*</span>
                  ，表单提交会失败。
                  {onDevBypass && (
                    <button
                      type="button"
                      onClick={onDevBypass}
                      className="ml-1 underline decoration-dotted underline-offset-2 hover:text-amber-200"
                    >
                      本地预览：直接进入
                    </button>
                  )}
                </div>
              )}
            </form>

            <div className="flex items-center justify-between border-t border-[rgba(56,189,248,0.10)] px-5 py-2 text-[10px] text-slate-600">
              <span className="font-mono tracking-wider">
                {serverUp ? (
                  <span className="text-emerald-400/70">● 网关可达</span>
                ) : (
                  <span className="text-rose-400/70">● 网关不可达</span>
                )}
              </span>
              <span className="font-mono">v0.1.0</span>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
};

export default AuthScreen;

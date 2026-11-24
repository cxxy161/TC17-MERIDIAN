import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  AlertTriangle,
  Check,
  KeyRound,
  Loader2,
  LogOut,
  Monitor,
  RefreshCw,
  User,
  type LucideIcon,
} from 'lucide-react';
import { ApiError, accountApi, type AccountInfo } from '../api/client';
import type { PaneProps } from '../layout/paneRegistry';
import { useSessionStore } from '../store/useSessionStore';

type Tab = 'account' | 'sessions';

const TABS: Array<{ id: Tab; label: string; icon: LucideIcon }> = [
  { id: 'account', label: '账号', icon: User },
  { id: 'sessions', label: '会话', icon: Monitor },
];

/* ------------------------------------------------------------------ styles */

const INPUT_BASE =
  'w-full rounded-[2px] border bg-[#080d13] px-2 py-1.5 text-[12px] text-slate-100 outline-none transition-colors placeholder:text-slate-600 disabled:opacity-60';

function inputClass(invalid: boolean): string {
  return `${INPUT_BASE} ${
    invalid
      ? 'border-rose-500/60 focus:border-rose-400'
      : 'border-[rgba(56,189,248,0.18)] focus:border-sky-400/70 focus:bg-[#0a1119]'
  }`;
}

const SMALL_BTN =
  'inline-flex shrink-0 items-center gap-1 rounded-[2px] border border-[rgba(56,189,248,0.28)] bg-[rgba(56,189,248,0.06)] px-1.5 py-1 text-[10px] text-sky-200/90 transition-colors hover:border-sky-400/60 hover:bg-sky-500/15 hover:text-sky-100 disabled:cursor-not-allowed disabled:border-slate-700 disabled:bg-transparent disabled:text-slate-600';

const SMALL_BTN_DANGER =
  'inline-flex shrink-0 items-center gap-1 rounded-[2px] border border-rose-500/35 bg-rose-500/[0.06] px-1.5 py-1 text-[10px] text-rose-300/90 transition-colors hover:border-rose-400/60 hover:bg-rose-500/15 hover:text-rose-200 disabled:cursor-not-allowed disabled:border-slate-700 disabled:bg-transparent disabled:text-slate-600';

/* ----------------------------------------------------------------- helpers */

function payloadObject(err: unknown): Record<string, unknown> | null {
  if (!(err instanceof ApiError)) return null;
  const p = err.payload;
  return p !== null && typeof p === 'object' ? (p as Record<string, unknown>) : null;
}

/** 后端错误形状固定为 {message, field?}，兜底时按状态码给中文说明。 */
function errMessage(err: unknown): string {
  const msg = payloadObject(err)?.message;
  if (typeof msg === 'string' && msg.trim() !== '') return msg;
  if (err instanceof ApiError) {
    if (err.status === 400) return '请求参数不合法';
    if (err.status === 403) return '没有权限执行该操作';
    if (err.status === 409) return '该值已被占用，请换一个';
    if (err.status === 429) return '操作过于频繁，请稍后再试';
    return `请求失败（HTTP ${err.status}）`;
  }
  return '无法连接服务器，请检查网络或后端状态';
}

function errField(err: unknown): string | null {
  const field = payloadObject(err)?.field;
  return typeof field === 'string' ? field : null;
}

/** cooldown_until 可能是 ISO 字符串，也可能是秒/毫秒时间戳；统一换算成剩余毫秒。 */
function cooldownMs(raw: unknown): number | null {
  if (typeof raw === 'number' && Number.isFinite(raw)) {
    const target = raw < 1e12 ? raw * 1000 : raw;
    return Math.max(0, target - Date.now());
  }
  if (typeof raw === 'string' && raw.trim() !== '') {
    const parsed = Date.parse(raw);
    if (!Number.isNaN(parsed)) return Math.max(0, parsed - Date.now());
    const asNumber = Number(raw);
    if (Number.isFinite(asNumber)) return cooldownMs(asNumber);
  }
  return null;
}

function humanizeCooldown(ms: number): string {
  if (ms <= 0) return '现在可以修改';
  const minutes = Math.ceil(ms / 60000);
  if (minutes < 60) return `约 ${minutes} 分钟后可再次修改`;
  const hours = Math.ceil(ms / 3600000);
  if (hours < 48) return `约 ${hours} 小时后可再次修改`;
  return `约 ${Math.ceil(ms / 86400000)} 天后可再次修改`;
}

function fmtTime(value: string | number | null | undefined): string {
  if (value === null || value === undefined || value === '') return '—';
  let t: number;
  if (typeof value === 'number') {
    // 后端返回 Unix 秒；兼容毫秒
    t = value > 1e12 ? value : value * 1000;
  } else {
    t = Date.parse(value);
    if (Number.isNaN(t)) {
      const n = Number(value);
      if (!Number.isFinite(n)) return value;
      t = n > 1e12 ? n : n * 1000;
    }
  }
  return new Date(t).toLocaleString(undefined, {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  });
}

/** user_agent 只用来给人一个可读的设备名，不追求完整解析。 */
function uaLabel(ua: string): string {
  if (!ua) return '未知设备';
  const os = /Windows/i.test(ua)
    ? 'Windows'
    : /Mac OS X|Macintosh/i.test(ua)
      ? 'macOS'
      : /Android/i.test(ua)
        ? 'Android'
        : /iPhone|iPad|iPod/i.test(ua)
          ? 'iOS'
          : /Linux/i.test(ua)
            ? 'Linux'
            : '未知系统';
  const browser = /Edg\//.test(ua)
    ? 'Edge'
    : /Firefox\//.test(ua)
      ? 'Firefox'
      : /Chrome\//.test(ua)
        ? 'Chrome'
        : /Safari\//.test(ua)
          ? 'Safari'
          : '浏览器';
  return `${browser} · ${os}`;
}

function roleLabel(role: string | null | undefined): string {
  switch (role) {
    case 'admin':
      return '管理员';
    case 'player':
      return '玩家';
    case 'dev':
      return '开发';
    default:
      return role && role.trim() !== '' ? role : '未标注';
  }
}

/** 2 秒「已保存」微提示。定时器在卸载时清掉，避免在已卸载组件上 setState。 */
function useSavedFlag(): [boolean, () => void] {
  const [on, setOn] = useState(false);
  const timer = useRef<number | null>(null);

  const fire = useCallback(() => {
    setOn(true);
    if (timer.current !== null) window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => {
      timer.current = null;
      setOn(false);
    }, 2000);
  }, []);

  useEffect(
    () => () => {
      if (timer.current !== null) window.clearTimeout(timer.current);
    },
    [],
  );

  return [on, fire];
}

/* -------------------------------------------------------------- small parts */

const FieldLabel: React.FC<{ children: React.ReactNode; right?: React.ReactNode }> = ({
  children,
  right,
}) => (
  <div className="flex items-center justify-between gap-2">
    <span className="mono text-[10px] tracking-[0.14em] text-slate-500">{children}</span>
    {right}
  </div>
);

const SavedTag: React.FC<{ show: boolean; label?: string }> = ({ show, label = '已保存' }) =>
  show ? (
    <span className="inline-flex shrink-0 items-center gap-1 text-[10px] text-emerald-400">
      <Check size={11} />
      {label}
    </span>
  ) : null;

const ErrorBox: React.FC<{ text: string }> = ({ text }) => (
  <div className="flex items-start gap-1.5 border border-rose-500/35 bg-rose-500/[0.07] px-2 py-1.5 text-[10px] leading-relaxed text-rose-300">
    <AlertTriangle size={11} className="mt-0.5 shrink-0" />
    <span>{text}</span>
  </div>
);

const FieldErrorLine: React.FC<{ text?: string | null }> = ({ text }) =>
  text ? <div className="mt-1 text-[10px] text-rose-400">{text}</div> : null;

/* ------------------------------------------------------------ SettingsPanel */

export const SettingsPanel: React.FC<PaneProps> = () => {
  const user = useSessionStore((s) => s.user);
  const setUser = useSessionStore((s) => s.setUser);
  const logout = useSessionStore((s) => s.logout);

  const [tab, setTab] = useState<Tab>('account');
  const [account, setAccount] = useState<AccountInfo | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);

  const [nickDraft, setNickDraft] = useState('');
  const [nickBusy, setNickBusy] = useState(false);
  const [nickError, setNickError] = useState<string | null>(null);
  const [nickCooldownUntil, setNickCooldownUntil] = useState(0);
  const [cooldownLeft, setCooldownLeft] = useState(0);

  const [curPwd, setCurPwd] = useState('');
  const [newPwd, setNewPwd] = useState('');
  const [confirmPwd, setConfirmPwd] = useState('');
  const [pwdBusy, setPwdBusy] = useState(false);
  const [pwdErrors, setPwdErrors] = useState<Record<string, string>>({});
  const [pwdError, setPwdError] = useState<string | null>(null);

  const [revoking, setRevoking] = useState<string | number | null>(null);
  const [revokeAllBusy, setRevokeAllBusy] = useState(false);
  const [sessionsError, setSessionsError] = useState<string | null>(null);

  const [nickSaved, flashNickSaved] = useSavedFlag();
  const [pwdSaved, flashPwdSaved] = useSavedFlag();
  const [revokeSaved, flashRevokeSaved] = useSavedFlag();

  const mountedRef = useRef(true);
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const fetchAccount = useCallback(async (opts?: { hydrateDraft?: boolean }) => {
    setLoading(true);
    setLoadError(null);
    try {
      const data = await accountApi.get();
      if (!mountedRef.current) return;
      // 后端 SPA fallback 会把未知路由回成 index.html + 200，必须验形状
      if (!data || typeof data.email !== 'string' || typeof data.nickname !== 'string') {
        setAccount(null);
        setLoadError('后端未返回账号数据（接口可能尚未实现或后端版本过旧）');
        return;
      }
      setAccount(data);
      if (opts?.hydrateDraft !== false) setNickDraft(data.nickname);
    } catch (err) {
      if (!mountedRef.current) return;
      // 401 已由 store 处理（会退回登录页），这里不再叠加错误提示
      if (err instanceof ApiError && err.status === 401) return;
      setLoadError(errMessage(err));
    } finally {
      if (mountedRef.current) setLoading(false);
    }
  }, []);

  useEffect(() => {
    void fetchAccount();
  }, [fetchAccount]);

  // 昵称冷却：只有 429 带 cooldown_until 时才启动，归零后解除保存禁用
  useEffect(() => {
    if (nickCooldownUntil === 0) {
      setCooldownLeft(0);
      return undefined;
    }
    const tick = () => {
      const left = Math.max(0, nickCooldownUntil - Date.now());
      setCooldownLeft(left);
      if (left === 0) setNickCooldownUntil(0);
    };
    tick();
    const id = window.setInterval(tick, 1000);
    return () => window.clearInterval(id);
  }, [nickCooldownUntil]);

  const nickTrimmed = nickDraft.trim();
  const nickDirty = account !== null && nickTrimmed !== account.nickname;
  const sessions = account?.sessions ?? [];
  const otherSessions = sessions.filter((s) => !s.current);

  const saveNickname = async () => {
    if (!account || nickBusy || cooldownLeft > 0) return;
    const next = nickDraft.trim();
    if (next.length < 2 || next.length > 16) {
      setNickError('昵称需 2–16 个字符');
      return;
    }
    if (next === account.nickname) {
      setNickDraft(next);
      setNickError(null);
      return;
    }
    setNickBusy(true);
    setNickError(null);
    try {
      const res = await accountApi.updateNickname(next);
      if (!mountedRef.current) return;
      const applied =
        res && typeof res.nickname === 'string' && res.nickname !== '' ? res.nickname : next;
      setAccount({ ...account, nickname: applied, nickname_changed_at: new Date().toISOString() });
      setNickDraft(applied);
      // header chip 读 store，不同步这里就会显示旧昵称
      const currentUser = useSessionStore.getState().user;
      if (currentUser) setUser({ ...currentUser, nickname: applied });
      flashNickSaved();
    } catch (err) {
      if (!mountedRef.current) return;
      if (err instanceof ApiError && err.status === 401) return;
      const cooldown =
        err instanceof ApiError && err.status === 429
          ? cooldownMs(payloadObject(err)?.cooldown_until)
          : null;
      const base = errMessage(err);
      // cooldown 为 0 表示「已经到点」或格式无法识别，此时只显示后端原文
      if (cooldown !== null && cooldown > 0) {
        setNickCooldownUntil(Date.now() + cooldown);
        setNickError(`${base}（${humanizeCooldown(cooldown)}）`);
      } else {
        setNickError(base);
      }
    } finally {
      if (mountedRef.current) setNickBusy(false);
    }
  };

  const submitPassword = async () => {
    if (pwdBusy) return;
    const errs: Record<string, string> = {};
    if (!curPwd) errs.current_password = '请输入当前密码';
    if (newPwd.length < 8) errs.new_password = '新密码至少 8 位';
    if (newPwd !== '' && confirmPwd !== newPwd) errs.confirm = '两次输入的新密码不一致';
    if (curPwd !== '' && newPwd !== '' && curPwd === newPwd) {
      errs.new_password = '新密码不能与当前密码相同';
    }
    if (Object.keys(errs).length > 0) {
      setPwdErrors(errs);
      setPwdError(null);
      return;
    }
    setPwdErrors({});
    setPwdError(null);
    setPwdBusy(true);
    try {
      await accountApi.changePassword(curPwd, newPwd);
      if (!mountedRef.current) return;
      setCurPwd('');
      setNewPwd('');
      setConfirmPwd('');
      flashPwdSaved();
      // 改密可能影响其他会话，顺手刷新列表（但不覆盖正在编辑的昵称草稿）
      void fetchAccount({ hydrateDraft: false });
    } catch (err) {
      if (!mountedRef.current) return;
      if (err instanceof ApiError && err.status === 401) {
        // 401 由 store 触发登出；当前设备重新登录即可，不再额外提示
        return;
      }
      const field = errField(err);
      if (field) setPwdErrors({ [field]: errMessage(err) });
      else setPwdError(errMessage(err));
    } finally {
      if (mountedRef.current) setPwdBusy(false);
    }
  };

  const revokeSession = async (id: string | number) => {
    setRevoking(id);
    setSessionsError(null);
    try {
      await accountApi.revokeSessions({ session_id: id });
      if (!mountedRef.current) return;
      flashRevokeSaved();
      await fetchAccount({ hydrateDraft: false });
    } catch (err) {
      if (!mountedRef.current) return;
      if (err instanceof ApiError && err.status === 401) return;
      setSessionsError(errMessage(err));
    } finally {
      if (mountedRef.current) setRevoking(null);
    }
  };

  const revokeAllSessions = async () => {
    setRevokeAllBusy(true);
    setSessionsError(null);
    try {
      await accountApi.revokeSessions({ all: true });
      if (!mountedRef.current) return;
      flashRevokeSaved();
      await fetchAccount({ hydrateDraft: false });
    } catch (err) {
      if (!mountedRef.current) return;
      if (err instanceof ApiError && err.status === 401) return;
      setSessionsError(errMessage(err));
    } finally {
      if (mountedRef.current) setRevokeAllBusy(false);
    }
  };

  /* ------------------------------------------------------------- rendering */

  const renderAccount = () => (
    <div className="space-y-3">
      <div className="flex items-start justify-between gap-2 border-b border-[rgba(56,189,248,0.18)] pb-2">
        <div className="min-w-0">
          <div className="mono text-[10px] tracking-[0.22em] text-slate-500">ACCOUNT</div>
          <div className="mt-0.5 truncate text-[13px] text-slate-100">
            {account?.nickname ?? user?.nickname ?? '—'}
          </div>
        </div>
        <span className="mono shrink-0 border border-[rgba(56,189,248,0.25)] px-1.5 py-0.5 text-[9px] text-sky-300/80">
          {roleLabel(account?.role ?? user?.role)}
        </span>
      </div>

      <div>
        <FieldLabel
          right={
            <span className="mono border border-amber-400/25 px-1 py-px text-[9px] text-amber-300/70">
              未验证
            </span>
          }
        >
          邮箱
        </FieldLabel>
        <div className="mono mt-1 break-all text-[12px] text-slate-200">
          {account?.email ?? user?.email ?? '—'}
        </div>
      </div>

      <div>
        <FieldLabel
          right={
            <span className="mono text-[9px] text-slate-600">{nickTrimmed.length}/16</span>
          }
        >
          昵称
        </FieldLabel>
        <div className="mt-1 flex items-center gap-1.5">
          <input
            value={nickDraft}
            onChange={(e) => {
              setNickDraft(e.target.value);
              if (nickError) setNickError(null);
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault();
                void saveNickname();
              } else if (e.key === 'Escape') {
                setNickDraft(account?.nickname ?? '');
                setNickError(null);
              }
            }}
            maxLength={16}
            aria-label="昵称"
            spellCheck={false}
            placeholder="2–16 个字符"
            className={inputClass(Boolean(nickError))}
          />
          {nickSaved ? (
            <SavedTag show />
          ) : (
            <button
              type="button"
              onClick={() => void saveNickname()}
              disabled={!nickDirty || nickBusy || cooldownLeft > 0}
              className={SMALL_BTN}
            >
              {nickBusy ? <Loader2 size={11} className="animate-spin" /> : null}
              保存
            </button>
          )}
        </div>
        <FieldErrorLine text={nickError} />
        <div className="mono mt-1 flex items-center justify-between gap-2 text-[9px] text-slate-600">
          <span>上次修改：{fmtTime(account?.nickname_changed_at)}</span>
          <span className="text-amber-400/70">
            {cooldownLeft > 0
              ? `冷却中 · ${humanizeCooldown(cooldownLeft)}`
              : nickDirty
                ? '回车保存 · Esc 撤销'
                : ''}
          </span>
        </div>
      </div>

      <div className="grid grid-cols-2 gap-x-3 gap-y-2">
        <div className="min-w-0">
          <FieldLabel>COMPANY_ID</FieldLabel>
          <div className="mono mt-1 break-all text-[11px] text-sky-200/85">
            {account?.company_id ?? user?.company_id ?? '—'}
          </div>
        </div>
        <div className="min-w-0">
          <FieldLabel>注册时间</FieldLabel>
          <div className="mono mt-1 text-[11px] text-slate-400">{fmtTime(account?.created_at)}</div>
        </div>
      </div>

      <div className="border-t border-[rgba(56,189,248,0.14)] pt-3">
        <div className="flex items-center gap-1.5">
          <KeyRound size={12} className="shrink-0 text-slate-500" />
          <span className="mono text-[10px] tracking-[0.18em] text-slate-500">修改密码</span>
          <span className="ml-auto">
            <SavedTag show={pwdSaved} />
          </span>
        </div>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            void submitPassword();
          }}
          className="mt-2 space-y-2"
        >
          <div>
            <input
              type="password"
              value={curPwd}
              onChange={(e) => setCurPwd(e.target.value)}
              autoComplete="current-password"
              placeholder="当前密码"
              aria-label="当前密码"
              className={inputClass(Boolean(pwdErrors.current_password))}
            />
            <FieldErrorLine text={pwdErrors.current_password} />
          </div>
          <div>
            <input
              type="password"
              value={newPwd}
              onChange={(e) => setNewPwd(e.target.value)}
              autoComplete="new-password"
              placeholder="新密码（至少 8 位）"
              aria-label="新密码"
              className={inputClass(Boolean(pwdErrors.new_password))}
            />
            <FieldErrorLine text={pwdErrors.new_password} />
          </div>
          <div>
            <input
              type="password"
              value={confirmPwd}
              onChange={(e) => setConfirmPwd(e.target.value)}
              autoComplete="new-password"
              placeholder="确认新密码"
              aria-label="确认新密码"
              className={inputClass(Boolean(pwdErrors.confirm))}
            />
            <FieldErrorLine text={pwdErrors.confirm} />
          </div>
          {pwdError && <ErrorBox text={pwdError} />}
          <div className="flex items-center justify-between gap-2">
            <button type="submit" disabled={pwdBusy} className={SMALL_BTN}>
              {pwdBusy ? <Loader2 size={11} className="animate-spin" /> : <KeyRound size={11} />}
              更新密码
            </button>
            <span className="mono text-[9px] text-slate-600">建议混合大小写与数字</span>
          </div>
        </form>
      </div>

      <div className="border-t border-white/[0.05] pt-3">
        <button type="button" onClick={() => void logout()} className={SMALL_BTN_DANGER}>
          <LogOut size={11} />
          退出登录
        </button>
        <div className="mono mt-1.5 text-[9px] leading-relaxed text-slate-600">
          退出后回到登录页，本设备的会话 cookie 会被清除。
        </div>
      </div>
    </div>
  );

  const renderSessions = () => (
    <div className="space-y-2.5">
      <div className="flex items-center justify-between gap-2 border-b border-[rgba(56,189,248,0.18)] pb-2">
        <span className="mono text-[10px] tracking-[0.22em] text-slate-500">
          SESSIONS · {sessions.length}
        </span>
        <div className="flex items-center gap-2">
          <SavedTag show={revokeSaved} />
          <button
            type="button"
            onClick={() => void fetchAccount({ hydrateDraft: false })}
            className={SMALL_BTN}
          >
            <RefreshCw size={11} />
            刷新
          </button>
        </div>
      </div>

      {sessionsError && <ErrorBox text={sessionsError} />}

      {sessions.length === 0 ? (
        <div className="border border-dashed border-[rgba(56,189,248,0.18)] px-2.5 py-3 text-[10px] text-slate-500">
          没有活跃会话记录。
        </div>
      ) : (
        <div className="space-y-1.5">
          {sessions.map((s) => (
            <div
              key={s.id}
              className={`border px-2.5 py-2 ${
                s.current
                  ? 'border-emerald-500/30 bg-emerald-500/[0.05]'
                  : 'border-[rgba(56,189,248,0.18)] bg-[#0d141c]'
              }`}
            >
              <div className="flex items-start justify-between gap-2">
                <div className="min-w-0">
                  <div className="flex items-center gap-1.5">
                    <Monitor
                      size={11}
                      className={`shrink-0 ${s.current ? 'text-emerald-300' : 'text-slate-500'}`}
                    />
                    <span className="truncate text-[11px] text-slate-200">
                      {uaLabel(s.user_agent)}
                    </span>
                    {s.current && (
                      <span className="mono shrink-0 border border-emerald-500/40 bg-emerald-500/10 px-1 py-px text-[8px] tracking-[0.12em] text-emerald-300">
                        CURRENT
                      </span>
                    )}
                  </div>
                  <div className="mono mt-1 text-[9px] text-slate-500">
                    最近活跃 {fmtTime(s.last_seen_at)} · 登录于 {fmtTime(s.created_at)}
                  </div>
                  <div className="mono mt-0.5 break-all text-[9px] text-slate-600">{s.id}</div>
                </div>
                {!s.current && (
                  <button
                    type="button"
                    onClick={() => void revokeSession(s.id)}
                    disabled={revoking !== null || revokeAllBusy}
                    className={SMALL_BTN_DANGER}
                  >
                    {revoking === s.id ? (
                      <Loader2 size={11} className="animate-spin" />
                    ) : (
                      <LogOut size={11} />
                    )}
                    吊销
                  </button>
                )}
              </div>
            </div>
          ))}
        </div>
      )}

      <div className="border-t border-white/[0.05] pt-2.5">
        <button
          type="button"
          onClick={() => void revokeAllSessions()}
          disabled={otherSessions.length === 0 || revokeAllBusy || revoking !== null}
          className={SMALL_BTN_DANGER}
        >
          {revokeAllBusy ? <Loader2 size={11} className="animate-spin" /> : <LogOut size={11} />}
          登出其他所有设备
        </button>
        <div className="mono mt-1.5 text-[9px] leading-relaxed text-slate-600">
          被吊销的设备需要重新登录；本设备（CURRENT）不受影响。
        </div>
      </div>
    </div>
  );

  const gateError = loadError !== null && account === null;

  return (
    <div className="flex h-full min-h-0 w-full bg-[#0b1017] text-slate-200">
      <nav className="flex w-[88px] shrink-0 flex-col border-r border-[rgba(56,189,248,0.18)] bg-[#0e141c] py-1">
        {TABS.map((t) => {
          const Icon = t.icon;
          const active = tab === t.id;
          return (
            <button
              key={t.id}
              type="button"
              onClick={() => setTab(t.id)}
              className={`relative flex items-center gap-1.5 px-2.5 py-[7px] text-left text-[11px] transition-colors ${
                active
                  ? 'bg-[#151d28] text-sky-300'
                  : 'text-slate-500 hover:bg-white/[0.02] hover:text-slate-300'
              }`}
            >
              {active && <span className="absolute inset-y-0 left-0 w-[2px] bg-sky-400/80" />}
              <Icon size={12} className="shrink-0" />
              <span className="mono truncate tracking-[0.06em]">{t.label}</span>
            </button>
          );
        })}
      </nav>

      <section className="min-h-0 min-w-0 flex-1 overflow-y-auto px-3 py-2.5">
        {gateError ? (
          <div className="space-y-2">
            <ErrorBox text={loadError ?? ''} />
            <div className="flex items-center gap-2">
              <button type="button" onClick={() => void fetchAccount()} className={SMALL_BTN}>
                <RefreshCw size={11} />
                重试
              </button>
              <button type="button" onClick={() => void logout()} className={SMALL_BTN_DANGER}>
                <LogOut size={11} />
                退出登录
              </button>
            </div>
          </div>
        ) : loading && account === null ? (
          <div className="mono flex items-center justify-center gap-2 py-10 text-[11px] text-slate-500">
            <Loader2 size={13} className="animate-spin text-sky-400/70" />
            正在读取账号信息
          </div>
        ) : tab === 'account' ? (
          renderAccount()
        ) : (
          renderSessions()
        )}
      </section>
    </div>
  );
};

export default SettingsPanel;

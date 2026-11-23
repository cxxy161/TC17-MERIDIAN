import React, { useMemo, useState } from 'react';
import { Search } from 'lucide-react';
import { useGameStore } from '../store/useGameStore';
import type { PaneProps } from '../layout/paneRegistry';
import { useWorldIndex } from '../entities/hooks';
import { VirtualList } from '../components/VirtualList';
import { creditsToMoney, moneyToCredits, READ_ONLY_OBSERVATION_MODE } from '../types/meridian';

const VAULT_ROW_HEIGHT = 24;

const fmtCredits = (v: number | null | undefined): string =>
  v === null || v === undefined || !Number.isFinite(v) ? '—' : Math.round(v).toLocaleString();

export const TreasuryPanel: React.FC<PaneProps> = ({ params, setParams }) => {
  const state = useGameStore((s) => s.state);
  const sendIntent = useGameStore((s) => s.sendIntent);
  const world = useWorldIndex();

  const comp = state?.player_snapshot?.company;
  const cash = moneyToCredits(comp?.cash);
  const savings = moneyToCredits(comp?.savings);
  const debt = moneyToCredits(comp?.debt);
  const net = cash + savings - debt;

  /**
   * The backend hard-rejects every bank op whose planet is not the company's home planet
   * (meridian-core/src/world.rs: `home_planet_id != planet_id`). So the counter is fixed to the
   * home planet — never a 1000-entry planet dropdown.
   */
  const home = world.homePlanetId;
  const homePlanet = world.planet(home);
  const homeName = home ? world.planetName(home) : '未知（世界数据未就绪）';

  /** `params.planetId` may be stale/foreign (e.g. restored from another planet's focus). */
  const requested = params.planetId ?? null;
  const requestedExists = requested !== null && world.planet(requested) !== undefined;
  /** Ready when the world knows the home planet and the param either points at it or is absent. */
  const bankReady =
    home !== null && homePlanet !== undefined && (requested === null || (requestedExists && requested === home));
  const bankIntentPlanetId = bankReady ? home : null;

  const [amountStr, setAmountStr] = useState<string>('500');
  const [vaultQuery, setVaultQuery] = useState('');

  const amount = Number(amountStr);
  const amountValid = Number.isFinite(amount) && amount > 0;
  const reserves = homePlanet?.bank_reserves ?? 0;

  const canDeposit = bankReady && amountValid && cash >= amount;
  const canWithdraw = bankReady && amountValid && savings >= amount && reserves >= amount;
  const canBorrow = bankReady && amountValid && reserves >= amount;
  const canRepay = bankReady && amountValid && debt > 0 && cash >= Math.min(amount, debt);

  const amountIssue = !amountValid
    ? '金额需为正数'
    : !bankReady
      ? '存贷已禁用：见上方母星提示'
      : null;

  const execBank = (op: 'deposit' | 'withdraw' | 'borrow' | 'repay') => {
    if (!bankIntentPlanetId) return;
    if (!amountValid) return;
    void sendIntent({ BankOp: { planet_id: bankIntentPlanetId, op, amount: creditsToMoney(amount) } });
  };

  const vaultRows = useMemo(() => {
    const q = vaultQuery.trim().toLowerCase();
    return world.planets
      .filter((p) => !q || p.name.toLowerCase().includes(q) || p.id.toLowerCase().includes(q))
      .map((p) => ({
        id: p.id,
        name: p.name,
        treasury: p.treasury,
        reserves: p.bank_reserves,
        rate: p.bank_rate_bps / 100,
        isHome: p.id === home,
      }));
  }, [world.planets, vaultQuery, home]);

  return (
    <div className="h-full flex flex-col bg-[#202732] text-slate-200 overflow-hidden">
      <div className="px-3 py-1.5 border-b border-sky-500/10 bg-[#232a36] flex items-center justify-between gap-2 text-[11px] shrink-0 flex-wrap">
        <span className="font-medium">公司财务与母星央行</span>
        <span className="text-[10px] text-emerald-400">玩家永不强制破产保护生效中</span>
      </div>

      <div className="flex-1 min-h-0 flex flex-col p-3 gap-3">
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 mono shrink-0">
          <div className="metric-card">
            <div className="text-[10px] text-slate-500">可用现金</div>
            <div className="text-[14px] font-semibold text-emerald-400 mt-0.5">{cash.toFixed(2)}</div>
          </div>
          <div className="metric-card">
            <div className="text-[10px] text-slate-500">银行存款</div>
            <div className="text-[14px] font-semibold text-sky-400 mt-0.5">{savings.toFixed(2)}</div>
          </div>
          <div className="metric-card">
            <div className="text-[10px] text-slate-500">银行贷款</div>
            <div className="text-[14px] font-semibold text-rose-400 mt-0.5">{debt.toFixed(2)}</div>
          </div>
          <div className="metric-card">
            <div className="text-[10px] text-slate-500">净流动资产</div>
            <div className="text-[14px] font-semibold text-slate-100 mt-0.5">{net.toFixed(2)}</div>
          </div>
        </div>

        <div className="border border-sky-500/20 bg-[#1b212b] p-3 rounded-sm space-y-2.5 shrink-0">
          <div className="flex items-start justify-between gap-3 text-[11px]">
            <div className="min-w-0">
              <div className="text-slate-300 truncate">
                母星央行：<span className="text-sky-300 font-semibold">{homeName}</span>
              </div>
              <div className="text-[10px] text-slate-500 mt-0.5">
                后端硬性校验：只有母星受理本星企业存贷，其余行星一律拒绝
              </div>
            </div>
            <div className="mono text-[10px] text-slate-400 shrink-0 text-right">
              <div>
                年化{' '}
                <strong className="text-emerald-400">
                  {homePlanet ? (homePlanet.bank_rate_bps / 100).toFixed(1) : '—'}%
                </strong>
              </div>
              <div>
                母星准备金 <strong className="text-sky-300">{fmtCredits(reserves)}</strong>
              </div>
            </div>
          </div>

          {home === null && (
            <div className="text-[10px] text-rose-300">
              世界数据尚未就绪：未取得母星 id，存贷已禁用。
            </div>
          )}
          {home !== null && !homePlanet && (
            <div className="text-[10px] text-rose-300">
              母星 id（{home}）在世界数据中不存在，存贷已禁用。
            </div>
          )}
          {home !== null && requested !== null && !requestedExists && (
            <div className="text-[10px] text-rose-300 flex items-center gap-2 flex-wrap">
              <span>未知行星（{requested}）：世界中没有该行星，存贷已禁用。</span>
              <button onClick={() => setParams({ planetId: home })} className="pill-btn py-0 text-[10px]">
                定位母星
              </button>
            </div>
          )}
          {home !== null && requested !== null && requestedExists && requested !== home && (
            <div className="text-[10px] text-amber-300/90 flex items-center gap-2 flex-wrap">
              <span>
                当前面板指向 {world.planetName(requested)}（非母星），后端会拒绝该行星的存贷。
              </span>
              <button onClick={() => setParams({ planetId: home })} className="pill-btn py-0 text-[10px]">
                切到母星
              </button>
            </div>
          )}

          {!READ_ONLY_OBSERVATION_MODE && (
            <>
              <div className="flex flex-wrap items-center gap-2">
                <label className="text-[10px] text-slate-500" htmlFor="treasury-amount">
                  金额
                </label>
                <input
                  id="treasury-amount"
                  type="number"
                  min={1}
                  value={amountStr}
                  onChange={(e) => setAmountStr(e.target.value)}
                  className="w-28 bg-[#191f27] border border-slate-700 px-2 py-1 mono text-right rounded-sm"
                />
                <span className="text-[9px] text-slate-500 mono">Cr</span>
                <button
                  onClick={() => execBank('deposit')}
                  disabled={!canDeposit}
                  title={canDeposit ? '把现金存入母星央行' : '现金不足或存贷已禁用'}
                  className="cta-blue disabled:opacity-40"
                >
                  存入
                </button>
                <button
                  onClick={() => execBank('withdraw')}
                  disabled={!canWithdraw}
                  title={canWithdraw ? '从母星央行取出存款' : '存款或央行准备金不足'}
                  className="pill-btn disabled:opacity-40"
                >
                  取出
                </button>
                <button
                  onClick={() => execBank('borrow')}
                  disabled={!canBorrow}
                  title={canBorrow ? '向母星央行借款' : '央行准备金不足或存贷已禁用'}
                  className="cta-green disabled:opacity-40"
                >
                  借款
                </button>
                <button
                  onClick={() => execBank('repay')}
                  disabled={!canRepay}
                  title={canRepay ? '偿还银行贷款（最多还清全部负债）' : '无负债或现金不足'}
                  className="pill-btn disabled:opacity-40"
                >
                  还款
                </button>
              </div>
              <div className="flex flex-wrap gap-x-3 gap-y-1 text-[10px] text-slate-500 mono">
                <span>现金 {cash.toFixed(2)}</span>
                <span>储蓄 {savings.toFixed(2)}</span>
                <span>负债 {debt.toFixed(2)}</span>
                {amountIssue && <span className="text-amber-300/90">{amountIssue}</span>}
              </div>
            </>
          )}
        </div>

        <div className="flex-1 min-h-0 flex flex-col gap-1">
          <div className="flex items-center justify-between gap-2 shrink-0">
            <span className="text-[10px] text-slate-400">
              全星系各行星金库与央行准备金 · 共 {world.planets.length} 颗
            </span>
            <div className="flex items-center gap-1.5 px-2 py-0.5 bg-[#1b212b] border border-slate-700 rounded-sm w-56">
              <Search className="w-3 h-3 text-sky-400 shrink-0" />
              <input
                value={vaultQuery}
                onChange={(e) => setVaultQuery(e.target.value)}
                placeholder="搜索行星名 / id…"
                className="flex-1 min-w-0 bg-transparent outline-none text-[11px] text-slate-100 placeholder:text-slate-600"
              />
              <span className="text-[9px] mono text-slate-500 shrink-0">{vaultRows.length}</span>
            </div>
          </div>

          <div className="grid grid-cols-[1fr_90px_90px_52px] gap-1 px-2 py-0.5 text-[9px] text-slate-500 border-b border-slate-800/80 shrink-0">
            <span>行星</span>
            <span className="text-right">金库</span>
            <span className="text-right">准备金</span>
            <span className="text-right">年化</span>
          </div>

          <VirtualList
            className="flex-1 min-h-0 overflow-y-auto"
            count={vaultRows.length}
            rowHeight={VAULT_ROW_HEIGHT}
            emptyState={
              <div className="px-3 py-6 text-center text-[11px] text-slate-500">
                {world.planets.length === 0 ? '世界数据尚未就绪' : '没有匹配的行星'}
              </div>
            }
            renderRow={(idx) => {
              const r = vaultRows[idx];
              return (
                <div
                  className={`h-[24px] grid grid-cols-[1fr_90px_90px_52px] gap-1 items-center px-2 text-[11px] border-b border-slate-800/40 ${
                    r.isHome ? 'bg-sky-500/5' : ''
                  }`}
                >
                  <span className="truncate text-slate-200 flex items-center gap-1" title={r.id}>
                    <span className="truncate">{r.name}</span>
                    {r.isHome && (
                      <span className="text-[8px] px-1 bg-sky-500/20 text-sky-300 rounded-[2px] shrink-0">
                        母星
                      </span>
                    )}
                    <span className="text-[9px] text-slate-600 mono shrink-0">{r.id}</span>
                  </span>
                  <span className="text-right mono text-sky-300">{fmtCredits(r.treasury)}</span>
                  <span className="text-right mono text-emerald-400">{fmtCredits(r.reserves)}</span>
                  <span className="text-right mono text-slate-400">{r.rate.toFixed(1)}%</span>
                </div>
              );
            }}
          />
        </div>
      </div>
    </div>
  );
};

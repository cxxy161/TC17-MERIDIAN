import React, { useState } from 'react';
import type { IDockviewPanelProps } from 'dockview-react';
import { useGameStore } from '../store/useGameStore';
import type { PaneParams } from '../layout/paneRegistry';
import { creditsToMoney, moneyToCredits } from '../types/meridian';

export const TreasuryPanel: React.FC<IDockviewPanelProps<PaneParams>> = ({ params }) => {
  const state = useGameStore((s) => s.state);
  const sendIntent = useGameStore((s) => s.sendIntent);
  const comp = state?.player_snapshot?.company;
  const planets = state?.planets ?? [];

  const [planetId, setPlanetId] = useState<string>(params.planetId || comp?.home_planet_id || 'P1');
  const [amountStr, setAmountStr] = useState<string>('500');

  const cash = moneyToCredits(comp?.cash);
  const savings = moneyToCredits(comp?.savings);
  const debt = moneyToCredits(comp?.debt);
  const net = cash + savings - debt;

  const execBank = (op: 'deposit' | 'withdraw' | 'borrow' | 'repay') => {
    const amt = Number(amountStr);
    if (!Number.isFinite(amt) || amt <= 0) return;
    void sendIntent({ BankOp: { planet_id: planetId, op, amount: creditsToMoney(amt) } });
  };

  return (
    <div className="h-full flex flex-col bg-[#0b1119] text-slate-200 overflow-hidden">
      <div className="px-3 py-1.5 border-b border-sky-500/10 bg-[#0a111a] flex items-center justify-between text-[11px]">
        <span className="font-medium">公司财务与行星央行</span>
        <span className="text-[10px] text-emerald-400">玩家永不强制破产保护生效中</span>
      </div>

      <div className="flex-1 overflow-y-auto p-3 space-y-3">
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 mono">
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

        <div className="border border-sky-500/20 bg-[#080d14] p-3 rounded-sm space-y-2.5">
          <div className="flex items-center justify-between text-[11px]">
            <span className="text-slate-300">母星央行柜台（仅可在母星办理存贷）</span>
            <select
              value={planetId}
              onChange={(e) => setPlanetId(e.target.value)}
              className="bg-[#0e1724] border border-slate-700 px-2 py-0.5 rounded-sm"
            >
              {planets.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name} ({(p.bank_rate_bps / 100).toFixed(1)}%)
                </option>
              ))}
            </select>
          </div>

          <div className="flex items-center gap-2">
            <input
              type="number"
              min="1"
              value={amountStr}
              onChange={(e) => setAmountStr(e.target.value)}
              className="w-32 bg-[#070b11] border border-slate-700 px-2 py-1 mono text-right rounded-sm"
            />
            <button onClick={() => execBank('deposit')} className="cta-blue">存入</button>
            <button onClick={() => execBank('withdraw')} className="pill-btn">取出</button>
            <button onClick={() => execBank('borrow')} className="cta-green">借款</button>
            <button onClick={() => execBank('repay')} className="pill-btn">还款</button>
          </div>
        </div>

        <div className="space-y-1.5">
          <div className="text-[10px] text-slate-400">全星系各行星金库与央行准备金</div>
          {planets.map((p) => (
            <div key={p.id} className="metric-card flex items-center justify-between text-[11px] mono">
              <span className="font-sans text-slate-200">{p.name}</span>
              <span className="text-slate-400">
                金库 <strong className="text-sky-300">{Math.round(p.treasury).toLocaleString()}</strong> · 准备金{' '}
                <strong className="text-emerald-400">{Math.round(p.bank_reserves).toLocaleString()}</strong> · 年化{' '}
                {(p.bank_rate_bps / 100).toFixed(1)}%
              </span>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
};

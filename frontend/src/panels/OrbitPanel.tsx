import React from 'react';
import type { IDockviewPanelProps } from 'dockview-react';
import { useGameStore } from '../store/useGameStore';
import { openPane, type PaneParams } from '../layout/paneRegistry';

export const OrbitPanel: React.FC<IDockviewPanelProps<PaneParams>> = ({ containerApi }) => {
  const state = useGameStore((s) => s.state);
  const planets = state?.planets ?? [];
  const ships = state?.player_snapshot?.company.ships ?? [];
  const routes = state?.player_snapshot?.routes ?? {};

  const cx = 260;
  const cy = 190;
  const maxR = Math.max(...planets.map((p) => p.orbit_radius), 2.8);
  const scaleR = (r: number) => 38 + (r / maxR) * 130;

  const planetColors: Record<string, string> = {
    P1: '#3b82f6',
    P2: '#10b981',
    P3: '#38bdf8',
  };

  return (
    <div className="h-full flex flex-col bg-[#070b11] text-slate-200 select-none">
      <div className="px-3 py-1.5 border-b border-sky-500/10 flex items-center justify-between text-[11px] bg-[#0a111a]">
        <span className="text-slate-400">
          点击任意行星可打开或对比其遥测面板 · 在途飞船{' '}
          <strong className="text-emerald-400 mono">{ships.filter((s) => s.is_busy).length}</strong> 艘
        </span>
        <button
          onClick={() => openPane(containerApi, 'fleet', {}, { floating: true })}
          className="cta-green text-[10px] py-0.5 px-2"
        >
          悬浮舰队调度
        </button>
      </div>

      <div className="flex-1 min-h-0 relative">
        <svg viewBox="0 0 520 380" className="w-full h-full">
          <defs>
            <radialGradient id="orbitStarGlow" cx="50%" cy="50%" r="50%">
              <stop offset="0%" stopColor="#7dd3fc" stopOpacity="0.95" />
              <stop offset="45%" stopColor="#10b981" stopOpacity="0.22" />
              <stop offset="100%" stopColor="#070b11" stopOpacity="0" />
            </radialGradient>
          </defs>

          <circle cx={cx} cy={cy} r={170} fill="none" stroke="rgba(56,189,248,0.12)" strokeDasharray="2 4" />
          <line x1={cx} y1={14} x2={cx} y2={366} stroke="rgba(148,163,184,0.08)" />
          <line x1={76} y1={cy} x2={444} y2={cy} stroke="rgba(148,163,184,0.08)" />
          <text x={250} y={16} fill="#475569" fontSize="9" className="mono">000°</text>
          <text x={448} y={193} fill="#475569" fontSize="9" className="mono">090°</text>
          <text x={250} y={376} fill="#475569" fontSize="9" className="mono">180°</text>
          <text x={52} y={193} fill="#475569" fontSize="9" className="mono">270°</text>

          <circle cx={cx} cy={cy} r={34} fill="url(#orbitStarGlow)" />
          <circle cx={cx} cy={cy} r={5} fill="#bae6fd" />

          {/* Hub Station */}
          {(() => {
            const tick = state?.tick ?? 0;
            const hubAngle = (tick * 0.015) % (Math.PI * 2);
            const hr = scaleR(1.85);
            const hx = cx + hr * Math.cos(hubAngle + 1.2);
            const hy = cy + hr * Math.sin(hubAngle + 1.2);
            return (
              <g
                className="cursor-pointer"
                onClick={() => openPane(containerApi, 'cargo', { locationId: 'ST:HUB' })}
              >
                <circle cx={cx} cy={cy} r={hr} fill="none" stroke="rgba(56,189,248,0.22)" strokeDasharray="4 4" />
                <polygon
                  points={`${hx},${hy - 7} ${hx + 7},${hy} ${hx},${hy + 7} ${hx - 7},${hy}`}
                  fill="#0b1119"
                  stroke="#38bdf8"
                  strokeWidth="1.6"
                />
                <text x={hx + 11} y={hy + 3} fill="#7dd3fc" fontSize="11" fontWeight="600">
                  中心贸易枢纽
                </text>
              </g>
            );
          })()}

          {/* Planets */}
          {planets.map((p) => {
            const pr = scaleR(p.orbit_radius);
            const px = cx + pr * Math.cos(p.orbit_angle);
            const py = cy + pr * Math.sin(p.orbit_angle);
            const col = planetColors[p.id] ?? '#38bdf8';
            const rCost = routes[p.id]?.[`ST:${p.id}`];

            return (
              <g
                key={p.id}
                className="cursor-pointer"
                onClick={() => openPane(containerApi, 'planet', { planetId: p.id })}
              >
                <circle cx={cx} cy={cy} r={pr} fill="none" stroke="rgba(16,185,129,0.22)" />
                <circle cx={px} cy={py} r={p.population > 0 ? 8 : 6} fill={col} stroke="#e2e8f0" strokeWidth="1.2" />
                <text x={px + 11} y={py - 1} fill="#e2e8f0" fontSize="11" fontWeight="500">
                  {p.name}
                </text>
                <text x={px + 11} y={py + 11} fill="#64748b" fontSize="9" className="mono">
                  {p.population > 0 ? `人口 ${Math.round(p.population)}` : p.archetype}
                  {rCost ? ` · 登轨 ${rCost[0]}回合` : ''}
                </text>
              </g>
            );
          })}
        </svg>
      </div>
    </div>
  );
};

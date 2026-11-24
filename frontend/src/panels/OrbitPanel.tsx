import React from 'react';
import { useGameStore } from '../store/useGameStore';
import type { PaneProps } from '../layout/paneRegistry';
import type { PlanetSummary } from '../types/meridian';

const PLANET_COLORS: Record<string, string> = {
  P1: '#e07b42',
  P2: '#3b82f6',
  P3: '#7dd3fc',
};

function planetOrbitColor(p: PlanetSummary): string {
  if (p.habitability !== undefined && p.solar_mult !== undefined) {
    if (p.habitability >= 0.72) return (p.ocean_ratio ?? 0) >= 0.5 ? '#38bdf8' : '#3b82f6';
    if (p.habitability >= 0.34) return '#34d399';
    if (p.solar_mult >= 1.35) return '#e07b42';
    return '#7dd3fc';
  }
  return PLANET_COLORS[p.id] ?? '#38bdf8';
}

export const OrbitPanel: React.FC<PaneProps> = ({ openTemp }) => {
  const state = useGameStore((s) => s.state);
  const catalog = useGameStore((s) => s.catalog);
  const planets = state?.planets ?? [];
  const ships = state?.player_snapshot?.company.ships ?? [];
  const primarySys = state?.systems?.[0];
  const hubStationId = primarySys?.hub_station_id ?? 'ST:HUB';
  const hubOrbitRadius = state?.hub_orbit_radius ?? primarySys?.hub_orbit_radius ?? 1.45;
  const hubOrbitDays = state?.hub_orbit_days ?? primarySys?.hub_orbit_days ?? 200.0;

  const cx = 260;
  const cy = 190;
  const maxR = Math.max(...planets.map((p) => p.orbit_radius), hubOrbitRadius + 0.4, 2.8);
  const scaleR = (r: number) => 38 + (r / maxR) * 130;

  const tick = state?.tick ?? 0;
  const ticksPerDay = catalog?.meta.ticks_per_day || 24;
  const hubAngle =
    state?.hub_orbit_angle ??
    primarySys?.hub_orbit_angle ??
    ((tick * Math.PI * 2) / (ticksPerDay * hubOrbitDays)) % (Math.PI * 2);
  const hr = scaleR(hubOrbitRadius);
  const hx = cx + hr * Math.cos(hubAngle);
  const hy = cy + hr * Math.sin(hubAngle);

  return (
    <div className="h-full flex flex-col bg-[#191f27] text-slate-200 select-none">
      <div className="px-3 py-1.5 border-b border-sky-500/10 flex items-center justify-between text-[11px] bg-[#232a36]">
        <span className="text-slate-400">
          点击星体查看遥测 · 在途飞船{' '}
          <strong className="text-emerald-400 mono">{ships.filter((s) => s.is_busy).length}</strong> 艘
        </span>
        <button
          onClick={() => openTemp('fleet', {})}
          className="cta-green text-[10px] py-0.5 px-2 whitespace-nowrap shrink-0"
        >
          悬浮舰队调度
        </button>
      </div>

      <div className="flex-1 min-h-0 relative">
        <svg viewBox="0 0 520 380" className="w-full h-full">
          <defs>
            <radialGradient id="orbitStarGlow" cx="50%" cy="50%" r="50%">
              <stop offset="0%" stopColor="#fde68a" stopOpacity="0.95" />
              <stop offset="42%" stopColor="#f59e0b" stopOpacity="0.22" />
              <stop offset="100%" stopColor="#191f27" stopOpacity="0" />
            </radialGradient>
          </defs>

          <circle cx={cx} cy={cy} r={172} fill="none" stroke="rgba(148,163,184,0.10)" strokeDasharray="2 4" />
          <line x1={cx} y1={14} x2={cx} y2={366} stroke="rgba(148,163,184,0.07)" />
          <line x1={76} y1={cy} x2={444} y2={cy} stroke="rgba(148,163,184,0.07)" />
          <text x={250} y={16} fill="#475569" fontSize="9" className="mono">000°</text>
          <text x={448} y={193} fill="#475569" fontSize="9" className="mono">090°</text>
          <text x={250} y={376} fill="#475569" fontSize="9" className="mono">180°</text>
          <text x={52} y={193} fill="#475569" fontSize="9" className="mono">270°</text>

          {/* Central Star */}
          <circle cx={cx} cy={cy} r={30} fill="url(#orbitStarGlow)" />
          <circle cx={cx} cy={cy} r={5} fill="#fef08a" />

          {/* Planet Orbits & Solid Minimal Planets */}
          {planets.map((p) => {
            const pr = scaleR(p.orbit_radius);
            const px = cx + pr * Math.cos(p.orbit_angle);
            const py = cy + pr * Math.sin(p.orbit_angle);
            const col = planetOrbitColor(p);

            return (
              <g
                key={p.id}
                className="cursor-pointer"
                onClick={() => openTemp('planet', { planetId: p.id })}
              >
                <circle cx={cx} cy={cy} r={pr} fill="none" stroke="rgba(148,163,184,0.22)" />
                <circle cx={px} cy={py} r={p.population > 0 ? 5 : 3.5} fill={col} />
                <text x={px + 8} y={py + 3} fill="#e2e8f0" fontSize="10.5" fontWeight="500">
                  {p.name}
                </text>
              </g>
            );
          })}

          {/* Central Trade Hub Station */}
          <g
            className="cursor-pointer"
            onClick={() => openTemp('cargo', { locationId: hubStationId })}
          >
            <circle cx={cx} cy={cy} r={hr} fill="none" stroke="rgba(56,189,248,0.28)" strokeDasharray="3 4" />
            <polygon
              points={`${hx},${hy - 4.5} ${hx + 4.5},${hy} ${hx},${hy + 4.5} ${hx - 4.5},${hy}`}
              fill="#38bdf8"
            />
            <text x={hx + 8} y={hy + 3} fill="#7dd3fc" fontSize="10.5" fontWeight="500">
              中心贸易枢纽
            </text>
          </g>
        </svg>
      </div>
    </div>
  );
};

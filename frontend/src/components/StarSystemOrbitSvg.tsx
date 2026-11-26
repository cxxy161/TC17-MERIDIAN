import React from 'react';

export interface OrbitPlanetDatum {
  id: string;
  name: string;
  orbit_radius: number;
  orbit_angle: number;
  population: number;
  habitability?: number;
  solar_mult?: number;
  ocean_ratio?: number;
  unclaimed_count?: number;
  unclaimed_plots?: number;
}

export interface StarSystemOrbitSvgProps {
  planets: OrbitPlanetDatum[];
  hubOrbitRadius?: number;
  hubOrbitDays?: number;
  hubOrbitAngle?: number;
  tick?: number;
  ticksPerDay?: number;
  selectedPlanetId?: string;
  onSelectPlanet?: (planetId: string) => void;
  onSelectHub?: () => void;
  className?: string;
}

const PLANET_COLORS: Record<string, string> = {
  P1: '#e07b42',
  P2: '#3b82f6',
  P3: '#7dd3fc',
};

export function planetOrbitColor(p: OrbitPlanetDatum): string {
  if (p.habitability !== undefined && p.solar_mult !== undefined) {
    if (p.habitability >= 0.72) return (p.ocean_ratio ?? 0) >= 0.5 ? '#38bdf8' : '#3b82f6';
    if (p.habitability >= 0.34) return '#34d399';
    if (p.solar_mult >= 1.35) return '#e07b42';
    return '#7dd3fc';
  }
  return PLANET_COLORS[p.id] ?? '#38bdf8';
}

export const StarSystemOrbitSvg: React.FC<StarSystemOrbitSvgProps> = ({
  planets,
  hubOrbitRadius = 1.45,
  hubOrbitDays = 200.0,
  hubOrbitAngle,
  tick = 0,
  ticksPerDay = 24,
  selectedPlanetId,
  onSelectPlanet,
  onSelectHub,
  className = 'w-full h-full',
}) => {
  const cx = 260;
  const cy = 190;
  const maxR = Math.max(...planets.map((p) => p.orbit_radius), hubOrbitRadius + 0.4, 2.8);
  const scaleR = (r: number) => 38 + (r / maxR) * 130;

  const angle =
    hubOrbitAngle ??
    ((tick * Math.PI * 2) / (Math.max(1, ticksPerDay) * Math.max(1, hubOrbitDays))) %
      (Math.PI * 2);
  const hr = scaleR(hubOrbitRadius);
  const hx = cx + hr * Math.cos(angle);
  const hy = cy + hr * Math.sin(angle);

  return (
    <svg viewBox="0 0 520 380" className={className}>
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

      {/* Planet Orbits & Planets */}
      {planets.map((p) => {
        const pr = scaleR(p.orbit_radius);
        const px = cx + pr * Math.cos(p.orbit_angle);
        const py = cy + pr * Math.sin(p.orbit_angle);
        const col = planetOrbitColor(p);
        const isSel = selectedPlanetId === p.id;
        const r = p.population > 0 ? 5.5 : 4;

        return (
          <g
            key={p.id}
            className={onSelectPlanet ? 'cursor-pointer' : undefined}
            onClick={() => onSelectPlanet?.(p.id)}
          >
            <circle
              cx={cx}
              cy={cy}
              r={pr}
              fill="none"
              stroke={isSel ? 'rgba(56,189,248,0.48)' : 'rgba(148,163,184,0.22)'}
              strokeWidth={isSel ? 1.5 : 1}
            />
            {isSel && (
              <circle
                cx={px}
                cy={py}
                r={r + 6}
                fill="rgba(56,189,248,0.14)"
                stroke="#38bdf8"
                strokeWidth={1.3}
                strokeDasharray="2.5 2"
              />
            )}
            <circle cx={px} cy={py} r={12} fill="transparent" />
            <circle cx={px} cy={py} r={r} fill={col} />
            <text
              x={px + 9}
              y={py + 3}
              fill={isSel ? '#7dd3fc' : '#e2e8f0'}
              fontSize="10.5"
              fontWeight={isSel ? '700' : '500'}
            >
              {p.name}
            </text>
          </g>
        );
      })}

      {/* Central Trade Hub Station */}
      <g
        className={onSelectHub ? 'cursor-pointer' : undefined}
        onClick={() => onSelectHub?.()}
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
  );
};

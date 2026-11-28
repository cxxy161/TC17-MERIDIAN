import React, { useEffect, useMemo, useRef } from 'react';
import type { VisibleFlight } from '../types/meridian';
import { SmoothTickClock } from '../utils/smoothClock';

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
  hubStationId?: string;
  tick?: number;
  ticksPerDay?: number;
  paused?: boolean;
  tickMs?: number;
  flights?: VisibleFlight[];
  selectedPlanetId?: string;
  onSelectPlanet?: (planetId: string) => void;
  onSelectHub?: () => void;
  onSelectMyShip?: (shipId: number) => void;
  className?: string;
}

const OWN_SHIP_PATHS: Record<VisibleFlight['size'], string> = {
  small: 'M 4.4 0 L -3.2 -2.2 L -1.8 0 L -3.2 2.2 Z',
  medium: 'M 5.4 0 L -3.6 -2.8 L -2.0 0 L -3.6 2.8 Z',
  large: 'M 6.5 0 L -4.0 -3.4 L -2.2 0 L -4.0 3.4 Z',
};

const FOREIGN_SHIP_PATH = 'M 2.8 0 L 0 -1.4 L -2.2 0 L 0 1.4 Z';

function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

function isLocalPlanetShuttle(f: VisibleFlight): boolean {
  const fromPid = f.from.startsWith('ST:') ? f.from.slice(3) : f.from;
  const toPid = f.to.startsWith('ST:') ? f.to.slice(3) : f.to;
  return fromPid === toPid;
}

interface FlightCurveEval {
  x: number;
  y: number;
  deg: number;
  trailD: string;
  laneD: string;
}

function evalFlightInSystem(
  flight: VisibleFlight,
  t: number,
  nodeCoords: Map<string, [number, number]>,
  hubCoords: [number, number],
  hubStationId: string,
): FlightCurveEval | null {
  const resolveEndpoint = (loc: string): [number, number] | null => {
    if (loc === hubStationId || loc === 'ST:HUB' || loc.startsWith('ST:HUB:')) {
      return hubCoords;
    }
    const pid = loc.startsWith('ST:') ? loc.slice(3) : loc;
    return nodeCoords.get(pid) ?? null;
  };

  const p0 = resolveEndpoint(flight.from);
  const p1 = resolveEndpoint(flight.to);
  if (!p0 || !p1) return null;

  const [x0, y0] = p0;
  const [x1, y1] = p1;
  const dx = x1 - x0;
  const dy = y1 - y0;
  const dist = Math.hypot(dx, dy) || 1;
  const bend = Math.min(26, dist * 0.16);
  const cx = (x0 + x1) * 0.5 + (-dy / dist) * bend;
  const cy = (y0 + y1) * 0.5 + (dx / dist) * bend;

  const quadPt = (u: number): [number, number] => {
    const inv = 1 - u;
    return [
      inv * inv * x0 + 2 * inv * u * cx + u * u * x1,
      inv * inv * y0 + 2 * inv * u * cy + u * u * y1,
    ];
  };

  const [x, y] = quadPt(t);
  const tx = 2 * (1 - t) * (cx - x0) + 2 * t * (x1 - cx);
  const ty = 2 * (1 - t) * (cy - y0) + 2 * t * (y1 - cy);
  const deg = (Math.atan2(ty, tx) * 180) / Math.PI;

  const tTail = Math.max(0, t - 0.13);
  const [tx0, ty0] = quadPt(tTail);
  const [txm, tym] = quadPt((tTail + t) * 0.5);

  return {
    x,
    y,
    deg,
    trailD: `M ${tx0.toFixed(1)} ${ty0.toFixed(1)} Q ${txm.toFixed(1)} ${tym.toFixed(1)} ${x.toFixed(1)} ${y.toFixed(1)}`,
    laneD: `M ${x0.toFixed(1)} ${y0.toFixed(1)} Q ${cx.toFixed(1)} ${cy.toFixed(1)} ${x1.toFixed(1)} ${y1.toFixed(1)}`,
  };
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
  hubStationId = 'ST:HUB',
  tick = 0,
  ticksPerDay = 24,
  paused = false,
  tickMs = 2000,
  flights = [],
  selectedPlanetId,
  onSelectPlanet,
  onSelectHub,
  onSelectMyShip,
  className = 'w-full h-full',
}) => {
  const cx = 260;
  const cy = 190;
  const maxR = Math.max(...planets.map((p) => p.orbit_radius), hubOrbitRadius + 0.4, 2.8);
  const scaleR = (r: number) => 38 + (r / maxR) * 130;

  const omegaHub = (Math.PI * 2) / (Math.max(1, ticksPerDay) * Math.max(1, hubOrbitDays));
  const baseHubAngle = hubOrbitAngle ?? (tick * omegaHub) % (Math.PI * 2);
  const hr = scaleR(hubOrbitRadius);

  const nodeCoords = useMemo(() => {
    const map = new Map<string, [number, number]>();
    for (const p of planets) {
      const pr = scaleR(p.orbit_radius);
      map.set(p.id, [cx + pr * Math.cos(p.orbit_angle), cy + pr * Math.sin(p.orbit_angle)]);
    }
    return map;
  }, [planets, maxR]);

  // System map only renders interplanetary / hub transfer traffic; local P* <-> ST:P* belongs on Planet3DCanvas.
  const systemFlights = useMemo(
    () => flights.filter((f) => !isLocalPlanetShuttle(f)),
    [flights],
  );

  const clockRef = useRef<SmoothTickClock>(new SmoothTickClock());
  clockRef.current.sync(tick, tickMs, paused);

  const simRef = useRef({
    tick,
    baseHubAngle,
    omegaHub,
    hr,
    hubStationId,
    nodeCoords,
    flights: systemFlights,
  });
  simRef.current = {
    tick,
    baseHubAngle,
    omegaHub,
    hr,
    hubStationId,
    nodeCoords,
    flights: systemFlights,
  };

  const hubMarkerRef = useRef<SVGGElement | null>(null);
  const hubLabelRef = useRef<SVGTextElement | null>(null);
  const shipRefs = useRef<Map<number, SVGGElement>>(new Map());
  const trailRefs = useRef<Map<number, SVGPathElement>>(new Map());
  const laneRefs = useRef<Map<number, SVGPathElement>>(new Map());

  const applyFrameFor = (curTick: number) => {
    const sim = simRef.current;
    const hubAng = sim.baseHubAngle + (curTick - sim.tick) * sim.omegaHub;
    const hx = cx + sim.hr * Math.cos(hubAng);
    const hy = cy + sim.hr * Math.sin(hubAng);

    if (hubMarkerRef.current) {
      hubMarkerRef.current.setAttribute('transform', `translate(${hx.toFixed(2)}, ${hy.toFixed(2)})`);
    }
    if (hubLabelRef.current) {
      hubLabelRef.current.setAttribute('x', (hx + 8).toFixed(2));
      hubLabelRef.current.setAttribute('y', (hy + 3).toFixed(2));
    }

    const hubCoords: [number, number] = [hx, hy];
    for (const f of sim.flights) {
      const span = Math.max(1, f.arrival_tick - f.launch_tick);
      const t = clamp01((curTick - f.launch_tick) / span);
      const ev = evalFlightInSystem(f, t, sim.nodeCoords, hubCoords, sim.hubStationId);
      if (!ev) continue;
      const gEl = shipRefs.current.get(f.key);
      if (gEl) {
        gEl.setAttribute(
          'transform',
          `translate(${ev.x.toFixed(2)}, ${ev.y.toFixed(2)}) rotate(${ev.deg.toFixed(1)})`,
        );
      }
      const tEl = trailRefs.current.get(f.key);
      if (tEl) {
        tEl.setAttribute('d', ev.trailD);
      }
      const lEl = laneRefs.current.get(f.key);
      if (lEl && ev.laneD) {
        lEl.setAttribute('d', ev.laneD);
      }
    }
  };

  useEffect(() => {
    let raf = 0;
    const step = () => {
      const visualTick = clockRef.current.advance();
      applyFrameFor(visualTick);
      raf = window.requestAnimationFrame(step);
    };
    raf = window.requestAnimationFrame(step);
    return () => window.cancelAnimationFrame(raf);
  }, []);

  const labelHaloStyle: React.CSSProperties = {
    paintOrder: 'stroke',
    stroke: '#191f27',
    strokeWidth: 3,
    strokeLinejoin: 'round',
  };

  return (
    <svg viewBox="0 0 520 380" className={`${className} select-none`}>
      <defs>
        <radialGradient id="orbitStarGlow" cx="50%" cy="50%" r="50%">
          <stop offset="0%" stopColor="#fde68a" stopOpacity="0.95" />
          <stop offset="42%" stopColor="#f59e0b" stopOpacity="0.22" />
          <stop offset="100%" stopColor="#191f27" stopOpacity="0" />
        </radialGradient>
      </defs>

      {/* Layer 1: Grid & Orbits */}
      <circle cx={cx} cy={cy} r={172} fill="none" stroke="rgba(148,163,184,0.10)" strokeDasharray="2 4" />
      <line x1={cx} y1={14} x2={cx} y2={366} stroke="rgba(148,163,184,0.07)" />
      <line x1={76} y1={cy} x2={444} y2={cy} stroke="rgba(148,163,184,0.07)" />
      <text x={250} y={16} fill="#475569" fontSize="9" className="mono">000°</text>
      <text x={448} y={193} fill="#475569" fontSize="9" className="mono">090°</text>
      <text x={250} y={376} fill="#475569" fontSize="9" className="mono">180°</text>
      <text x={52} y={193} fill="#475569" fontSize="9" className="mono">270°</text>

      <circle cx={cx} cy={cy} r={30} fill="url(#orbitStarGlow)" />
      <circle cx={cx} cy={cy} r={5} fill="#fef08a" />

      {planets.map((p) => {
        const pr = scaleR(p.orbit_radius);
        const isSel = selectedPlanetId === p.id;
        return (
          <circle
            key={`orbit-${p.id}`}
            cx={cx}
            cy={cy}
            r={pr}
            fill="none"
            stroke={isSel ? 'rgba(56,189,248,0.48)' : 'rgba(148,163,184,0.22)'}
            strokeWidth={isSel ? 1.5 : 1}
          />
        );
      })}
      <circle cx={cx} cy={cy} r={hr} fill="none" stroke="rgba(56,189,248,0.26)" strokeDasharray="3 4" />

      {/* Layer 2: Interplanetary Geometric Ship Traffic (below planets & labels) */}
      <g>
        {systemFlights.map((f) => {
          if (!f.is_mine) {
            return (
              <g key={f.key} className="pointer-events-none">
                <path
                  ref={(el) => {
                    if (el) trailRefs.current.set(f.key, el);
                    else trailRefs.current.delete(f.key);
                  }}
                  fill="none"
                  stroke="rgba(148,163,184,0.22)"
                  strokeWidth={0.9}
                  strokeLinecap="round"
                />
                <g
                  ref={(el) => {
                    if (el) {
                      shipRefs.current.set(f.key, el);
                      applyFrameFor(clockRef.current.current());
                    } else {
                      shipRefs.current.delete(f.key);
                    }
                  }}
                >
                  <path d={FOREIGN_SHIP_PATH} fill="rgba(148,163,184,0.65)" />
                </g>
              </g>
            );
          }
          return (
            <g
              key={f.key}
              className={onSelectMyShip && f.ship_id !== undefined ? 'cursor-pointer' : undefined}
              onClick={() => {
                if (f.ship_id !== undefined) onSelectMyShip?.(f.ship_id);
              }}
            >
              <path
                ref={(el) => {
                  if (el) laneRefs.current.set(f.key, el);
                  else laneRefs.current.delete(f.key);
                }}
                fill="none"
                stroke="rgba(34,211,238,0.16)"
                strokeWidth={0.8}
                strokeDasharray="2.5 3"
              />
              <path
                ref={(el) => {
                  if (el) trailRefs.current.set(f.key, el);
                  else trailRefs.current.delete(f.key);
                }}
                fill="none"
                stroke="rgba(34,211,238,0.62)"
                strokeWidth={1.3}
                strokeLinecap="round"
              />
              <g
                ref={(el) => {
                  if (el) {
                    shipRefs.current.set(f.key, el);
                    applyFrameFor(clockRef.current.current());
                  } else {
                    shipRefs.current.delete(f.key);
                  }
                }}
              >
                <circle r={14} fill="transparent" />
                <circle r={5.5} fill="rgba(34,211,238,0.14)" />
                <path
                  d={OWN_SHIP_PATHS[f.size]}
                  fill="#22d3ee"
                  stroke="#cffafe"
                  strokeWidth={0.6}
                />
                <title>
                  {`#${f.ship_id ?? '?'} · ${f.from} → ${f.to} (剩余 ${Math.max(0, f.arrival_tick - tick)} 回合)`}
                </title>
              </g>
            </g>
          );
        })}
      </g>

      {/* Layer 3: Planet & Hub Nodes */}
      {planets.map((p) => {
        const pr = scaleR(p.orbit_radius);
        const px = cx + pr * Math.cos(p.orbit_angle);
        const py = cy + pr * Math.sin(p.orbit_angle);
        const col = planetOrbitColor(p);
        const isSel = selectedPlanetId === p.id;
        const r = p.population > 0 ? 5.5 : 4;

        return (
          <g
            key={`node-${p.id}`}
            className={onSelectPlanet ? 'cursor-pointer' : undefined}
            onClick={() => onSelectPlanet?.(p.id)}
          >
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
            <circle cx={px} cy={py} r={22} fill="transparent" />
            <circle cx={px} cy={py} r={r} fill={col} />
          </g>
        );
      })}

      <g
        ref={(el) => {
          hubMarkerRef.current = el;
          if (el) applyFrameFor(clockRef.current.current());
        }}
        className={onSelectHub ? 'cursor-pointer' : undefined}
        onClick={() => onSelectHub?.()}
      >
        <circle r={20} fill="transparent" />
        <polygon points="0,-4.5 4.5,0 0,4.5 -4.5,0" fill="#38bdf8" />
      </g>

      {/* Layer 4: Crisp Text Labels always on top with dark halo */}
      {planets.map((p) => {
        const pr = scaleR(p.orbit_radius);
        const px = cx + pr * Math.cos(p.orbit_angle);
        const py = cy + pr * Math.sin(p.orbit_angle);
        const isSel = selectedPlanetId === p.id;
        return (
          <text
            key={`lbl-${p.id}`}
            x={px + 9}
            y={py + 3}
            fill={isSel ? '#7dd3fc' : '#e2e8f0'}
            fontSize="10.5"
            fontWeight={isSel ? '700' : '500'}
            style={labelHaloStyle}
            className={onSelectPlanet ? 'cursor-pointer' : undefined}
            onClick={() => onSelectPlanet?.(p.id)}
          >
            {p.name}
          </text>
        );
      })}

      <text
        ref={(el) => {
          hubLabelRef.current = el;
          if (el) applyFrameFor(clockRef.current.current());
        }}
        fill="#7dd3fc"
        fontSize="10.5"
        fontWeight="500"
        style={labelHaloStyle}
        className={onSelectHub ? 'cursor-pointer' : undefined}
        onClick={() => onSelectHub?.()}
      >
        中心贸易枢纽
      </text>
    </svg>
  );
};

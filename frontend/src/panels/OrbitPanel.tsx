import React from 'react';
import { useGameStore } from '../store/useGameStore';
import type { PaneProps } from '../layout/paneRegistry';
import { StarSystemOrbitSvg } from '../components/StarSystemOrbitSvg';

export const OrbitPanel: React.FC<PaneProps> = ({ openTemp }) => {
  const state = useGameStore((s) => s.state);
  const catalog = useGameStore((s) => s.catalog);
  const planets = state?.planets ?? [];
  const ships = state?.player_snapshot?.company.ships ?? [];
  const flights = state?.visible_flights ?? [];
  const primarySys = state?.systems?.[0];
  const hubStationId = primarySys?.hub_station_id ?? 'ST:HUB';
  const hubOrbitRadius = state?.hub_orbit_radius ?? primarySys?.hub_orbit_radius ?? 1.45;
  const hubOrbitDays = state?.hub_orbit_days ?? primarySys?.hub_orbit_days ?? 200.0;
  const hubOrbitAngle = state?.hub_orbit_angle ?? primarySys?.hub_orbit_angle;
  const tick = state?.tick ?? 0;
  const paused = state?.paused ?? false;
  const tickMs = state?.tick_ms ?? 2000;
  const ticksPerDay = catalog?.meta.ticks_per_day || 24;

  return (
    <div className="h-full flex flex-col bg-[#191f27] text-slate-200">
      <div className="px-3 py-1.5 border-b border-sky-500/10 flex items-center justify-between text-[11px] bg-[#232a36]">
        <span className="text-slate-400">
          点击星体查看遥测 · 在途飞船{' '}
          <strong className="text-cyan-300 mono">{ships.filter((s) => s.is_busy).length}</strong> 艘
          <span className="text-slate-600 mx-1">/</span>
          全星系 <span className="text-slate-300 mono">{flights.length}</span> 艘
        </span>
        <button
          onClick={() => openTemp('fleet', {})}
          className="cta-green text-[10px] py-0.5 px-2 whitespace-nowrap shrink-0"
        >
          悬浮舰队调度
        </button>
      </div>

      <div className="flex-1 min-h-0 relative">
        <StarSystemOrbitSvg
          planets={planets}
          hubOrbitRadius={hubOrbitRadius}
          hubOrbitDays={hubOrbitDays}
          hubOrbitAngle={hubOrbitAngle}
          hubStationId={hubStationId}
          tick={tick}
          ticksPerDay={ticksPerDay}
          paused={paused}
          tickMs={tickMs}
          flights={flights}
          onSelectPlanet={(pid) => openTemp('planet', { planetId: pid })}
          onSelectHub={() => openTemp('cargo', { locationId: hubStationId })}
          onSelectMyShip={() => openTemp('fleet', {})}
        />
      </div>
    </div>
  );
};

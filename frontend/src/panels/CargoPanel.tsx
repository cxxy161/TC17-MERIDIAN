import React, { useState } from 'react';
import type { IDockviewPanelProps } from 'dockview-react';
import { useGameStore } from '../store/useGameStore';
import { openPane, type PaneParams } from '../layout/paneRegistry';
import { locationLabel } from '../types/meridian';

const ROLE_META: Record<string, { label: string; color: string }> = {
  foundation: { label: '能源基础', color: '#38bdf8' },
  factory_consume: { label: '工业材料', color: '#3b82f6' },
  planet_supply: { label: '城市消费', color: '#10b981' },
  capital: { label: '资本设备', color: '#2dd4bf' },
  byproduct: { label: '环保副产', color: '#34d399' },
};

export const CargoPanel: React.FC<IDockviewPanelProps<PaneParams>> = ({ params, api, containerApi }) => {
  const state = useGameStore((s) => s.state);
  const catalog = useGameStore((s) => s.catalog);
  const [loc, setLoc] = useState<string>(params.locationId || 'P1');

  const planets = state?.planets ?? [];
  const snap = state?.player_snapshot;
  const allLocations = [...planets.map((p) => p.id), ...planets.map((p) => `ST:${p.id}`), 'ST:HUB'];

  const storeMap: Record<string, number> = (() => {
    if (!snap) return {};
    if (loc.startsWith('ST:')) {
      return snap.company.station_stores[loc] ?? {};
    }
    return snap.planets[loc]?.ground_store ?? {};
  })();

  const switchLoc = (next: string) => {
    setLoc(next);
    api.setTitle(`仓库 · ${locationLabel(next, planets)}`);
  };

  const items = (catalog?.items ?? []).map((def) => ({
    def,
    qty: storeMap[def.id] ?? 0,
  }));

  const stocked = items.filter((x) => x.qty > 0);
  const empty = items.filter((x) => x.qty === 0);

  return (
    <div className="h-full flex flex-col bg-[#0b1119] text-slate-200 overflow-hidden">
      <div className="px-3 py-1.5 border-b border-sky-500/10 bg-[#0a111a] flex items-center justify-between gap-2 shrink-0 flex-wrap">
        <div className="flex items-center gap-1 flex-wrap">
          {allLocations.map((l) => (
            <button
              key={l}
              onClick={() => switchLoc(l)}
              className={`pill-btn py-0 text-[10px] ${loc === l ? 'active' : ''}`}
            >
              {locationLabel(l, planets)}
            </button>
          ))}
        </div>
        <span className="text-[10px] mono text-emerald-400">有货 {stocked.length} 项</span>
      </div>

      <div className="flex-1 overflow-y-auto p-3 space-y-3">
        {stocked.length === 0 ? (
          <div className="metric-card py-6 text-center text-slate-500">当前仓库暂无存货</div>
        ) : (
          <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-2">
            {stocked.map(({ def, qty }) => {
              const rm = ROLE_META[def.role] ?? { label: '物资', color: '#38bdf8' };
              const targetStation = loc.startsWith('ST:') ? loc : `ST:${loc}`;
              return (
                <div
                  key={def.id}
                  onClick={() => openPane(containerApi, 'chart', { stationId: targetStation, itemId: def.id })}
                  className="bg-[#0e1622] border border-slate-800 hover:border-emerald-400/50 rounded-sm px-2.5 py-2 flex items-center justify-between cursor-pointer"
                  style={{ borderLeft: `2px solid ${rm.color}` }}
                >
                  <div className="min-w-0">
                    <div className="text-[12px] font-medium text-slate-100 truncate">{def.name}</div>
                    <div className="text-[10px] text-slate-500">{rm.label}</div>
                  </div>
                  <div className="mono text-[14px] font-semibold text-slate-100 ml-2">{qty}</div>
                </div>
              );
            })}
          </div>
        )}

        {empty.length > 0 && (
          <div className="pt-2 border-t border-slate-800/70">
            <div className="text-[10px] text-slate-500 mb-1.5">零库存品类</div>
            <div className="flex flex-wrap gap-1.5">
              {empty.map(({ def }) => (
                <span key={def.id} className="px-2 py-0.5 bg-[#090e15] border border-slate-800/80 text-[10px] text-slate-500">
                  {def.name}
                </span>
              ))}
            </div>
          </div>
        )}
      </div>
    </div>
  );
};

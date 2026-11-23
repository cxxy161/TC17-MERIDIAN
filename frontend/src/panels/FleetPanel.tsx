import React, { useMemo, useState } from 'react';
import { useGameStore } from '../store/useGameStore';
import type { PaneProps } from '../layout/paneRegistry';
import { locationLabel } from '../types/meridian';

const SHIP_SIZE_NAMES: Record<string, string> = {
  small: '小型货船',
  medium: '中型货船',
  large: '大型货船',
};

export const FleetPanel: React.FC<PaneProps> = () => {
  const state = useGameStore((s) => s.state);
  const catalog = useGameStore((s) => s.catalog);
  const sendIntent = useGameStore((s) => s.sendIntent);

  const planets = state?.planets ?? [];
  const snap = state?.player_snapshot;
  const ships = snap?.company.ships ?? [];
  const routes = snap?.routes ?? {};
  const tick = state?.tick ?? 0;

  const [selectedShipId, setSelectedShipId] = useState<number | null>(null);
  const activeShip = ships.find((s) => s.id === selectedShipId) ?? ships[0];
  const [dest, setDest] = useState<string>('ST:P1');
  const [cargoDraft, setCargoDraft] = useState<Record<string, number>>({});

  const validDests = useMemo(() => {
    if (!activeShip) return [];
    const map = routes[activeShip.location] ?? {};
    return Object.keys(map);
  }, [activeShip, routes]);

  const effectiveDest = validDests.includes(dest) ? dest : (validDests[0] ?? '');
  const routeSpec = activeShip ? routes[activeShip.location]?.[effectiveDest] : undefined;

  const sourceInv: Record<string, number> = useMemo(() => {
    if (!activeShip || !snap) return {};
    if (activeShip.location.startsWith('ST:')) {
      return snap.company.station_stores[activeShip.location] ?? {};
    }
    return snap.planets[activeShip.location]?.ground_store ?? {};
  }, [activeShip, snap]);

  const itemMap = new Map((catalog?.items ?? []).map((it) => [it.id, it]));
  const totalSelected = Object.values(cargoDraft).reduce((a, b) => a + (b || 0), 0);

  const handleDispatch = () => {
    if (!activeShip || !effectiveDest) return;
    const cargoList: Array<[string, number]> = Object.entries(cargoDraft)
      .filter(([, q]) => q > 0)
      .map(([k, q]) => [k, Math.floor(q)]);
    if (cargoList.length === 0) return;
    void sendIntent({
      DispatchShip: {
        ship_id: activeShip.id,
        from: activeShip.location,
        to: effectiveDest,
        cargo: cargoList,
      },
    });
    setCargoDraft({});
  };

  return (
    <div className="h-full flex flex-col bg-[#0b1119] text-slate-200 overflow-hidden">
      <div className="px-3 py-1.5 border-b border-sky-500/10 bg-[#0a111a] flex items-center justify-between text-[11px] shrink-0">
        <span className="font-medium">旗下舰队（共 {ships.length} 艘）</span>
        <span className="text-[10px] text-slate-400">支持一船多货物混装发运</span>
      </div>

      <div className="flex-1 overflow-y-auto p-3 space-y-3">
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
          {ships.map((ship) => {
            const isSel = activeShip?.id === ship.id;
            const eta = ship.is_busy ? Math.max(0, ship.busy_until - tick) : 0;
            return (
              <div
                key={ship.id}
                onClick={() => {
                  setSelectedShipId(ship.id);
                  setCargoDraft({});
                }}
                className={`metric-card cursor-pointer space-y-1 ${
                  isSel ? 'border-sky-400/70 bg-sky-500/5' : 'hover:border-slate-600'
                }`}
              >
                <div className="flex items-center justify-between">
                  <span className="font-semibold text-sky-300">
                    {SHIP_SIZE_NAMES[ship.size] ?? ship.size}-{ship.id}
                  </span>
                  <span className={`mono text-[10px] ${ship.is_busy ? 'text-amber-300' : 'text-emerald-400'}`}>
                    {ship.is_busy ? `航行中（剩余 ${eta} 回合）` : '待命'}
                  </span>
                </div>
                <div className="flex justify-between text-[11px] text-slate-400 mono">
                  <span>{locationLabel(ship.location, planets)}</span>
                  <span>
                    耐久 {ship.durability.toFixed(0)}% · 载重 {ship.capacity}
                  </span>
                </div>
                {ship.durability < 95 && !ship.is_busy && (
                  <button
                    onClick={(e) => {
                      e.stopPropagation();
                      void sendIntent({ RepairShip: { ship_id: ship.id } });
                    }}
                    className="pill-btn py-0 text-[10px] text-emerald-300"
                  >
                    消耗维修件修复
                  </button>
                )}
              </div>
            );
          })}
        </div>

        {/* Dispatch Builder */}
        {activeShip && (
          <div className="border border-sky-500/20 bg-[#080d14] p-3 rounded-sm space-y-2.5">
            <div className="flex items-center justify-between text-[11px] pb-1.5 border-b border-slate-800">
              <span className="font-semibold text-slate-100">
                装货启航 · {SHIP_SIZE_NAMES[activeShip.size]}-{activeShip.id}
              </span>
              <span className="mono text-[10px] text-sky-300">
                已装 {totalSelected} / {activeShip.capacity}
              </span>
            </div>

            {activeShip.is_busy ? (
              <div className="text-[11px] text-amber-300/90 py-2">
                飞船正在航行前往 {locationLabel(activeShip.location, planets)}，抵达后方可再次调度。
              </div>
            ) : (
              <>
                <div className="flex items-center gap-2 text-[11px]">
                  <span className="text-slate-400">起点：</span>
                  <span className="text-slate-200">{locationLabel(activeShip.location, planets)}</span>
                  <span className="text-slate-500">→ 终点：</span>
                  <select
                    value={effectiveDest}
                    onChange={(e) => setDest(e.target.value)}
                    className="bg-[#0e1724] border border-slate-700 px-2 py-0.5 rounded-sm text-[11px]"
                  >
                    {validDests.map((d) => (
                      <option key={d} value={d}>
                        {locationLabel(d, planets)}
                      </option>
                    ))}
                  </select>
                  {routeSpec && (
                    <span className="mono text-[10px] text-emerald-400 ml-auto">
                      耗时 {routeSpec[0]} 回合 · 油耗 {routeSpec[1]} 燃料
                    </span>
                  )}
                </div>

                <div className="grid grid-cols-2 gap-1.5 max-h-40 overflow-y-auto">
                  {Object.entries(sourceInv)
                    .filter(([, q]) => q > 0)
                    .map(([itemId, have]) => {
                      const def = itemMap.get(itemId);
                      const isInstant = def?.tags.includes('instant');
                      if (isInstant) return null;
                      return (
                        <div key={itemId} className="metric-card flex items-center justify-between gap-2 text-[11px]">
                          <span className="truncate">
                            {def?.name ?? itemId}{' '}
                            <span className="mono text-[10px] text-slate-500">({have})</span>
                          </span>
                          <input
                            type="number"
                            min={0}
                            max={Math.min(have, activeShip.capacity)}
                            value={cargoDraft[itemId] ?? 0}
                            onChange={(e) =>
                              setCargoDraft((prev) => ({
                                ...prev,
                                [itemId]: Math.max(0, Math.min(have, Number(e.target.value) || 0)),
                              }))
                            }
                            className="w-14 bg-[#070b11] border border-slate-700 px-1 py-0.5 text-right mono rounded-sm"
                          />
                        </div>
                      );
                    })}
                </div>

                <div className="flex justify-end">
                  <button
                    disabled={totalSelected <= 0 || totalSelected > activeShip.capacity}
                    onClick={handleDispatch}
                    className="cta-green disabled:opacity-40"
                  >
                    确认启航发运
                  </button>
                </div>
              </>
            )}
          </div>
        )}
      </div>
    </div>
  );
};

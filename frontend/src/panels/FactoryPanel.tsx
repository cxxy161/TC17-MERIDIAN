import React, { useState } from 'react';
import { useGameStore } from '../store/useGameStore';
import type { PaneProps } from '../layout/paneRegistry';

export const FactoryPanel: React.FC<PaneProps> = ({ params, setTitle }) => {
  const state = useGameStore((s) => s.state);
  const catalog = useGameStore((s) => s.catalog);
  const sendIntent = useGameStore((s) => s.sendIntent);

  const [planetId, setPlanetId] = useState<string>(params.planetId || 'P1');
  const [buildType, setBuildType] = useState<string>('mine_smelter');

  const planets = state?.planets ?? [];
  const company = state?.player_snapshot?.company;
  const plots = (company?.plots ?? []).filter((pl) => pl.planet_id === planetId);
  const buildings = company?.buildings ?? [];
  const buildingMap = new Map((catalog?.buildings ?? []).map((b) => [b.id, b]));
  const recipeMap = new Map((catalog?.recipes ?? []).map((r) => [r.id, r]));

  const switchPlanet = (pid: string) => {
    setPlanetId(pid);
    const p = planets.find((x) => x.id === pid);
    setTitle(`产线 · ${p?.name ?? pid}`);
  };

  return (
    <div className="h-full flex flex-col bg-[#0b1119] text-slate-200 overflow-hidden">
      <div className="px-3 py-1.5 border-b border-sky-500/10 bg-[#0a111a] flex items-center justify-between gap-2 shrink-0">
        <div className="flex items-center gap-1">
          {planets.map((p) => (
            <button
              key={p.id}
              onClick={() => switchPlanet(p.id)}
              className={`pill-btn py-0 text-[10px] ${p.id === planetId ? 'active' : ''}`}
            >
              {p.name}
            </button>
          ))}
        </div>
        <div className="flex items-center gap-1.5">
          <select
            value={buildType}
            onChange={(e) => setBuildType(e.target.value)}
            className="bg-[#0e1724] border border-slate-700 text-[11px] px-1.5 py-0.5 rounded-sm"
          >
            {(catalog?.buildings ?? []).map((b) => (
              <option key={b.id} value={b.id}>
                {b.name}
              </option>
            ))}
          </select>
          <button
            disabled={plots.length === 0}
            onClick={() => {
              const target = plots.find((pl) => pl.used_slots < pl.capacity) ?? plots[0];
              if (target) {
                void sendIntent({ BuildFacility: { plot_id: target.id, building_type: buildType } });
              }
            }}
            className="cta-blue text-[10px] py-0.5 px-2 disabled:opacity-40"
          >
            建造设施
          </button>
        </div>
      </div>

      <div className="flex-1 overflow-y-auto p-3 space-y-3">
        {plots.length === 0 ? (
          <div className="metric-card text-center py-6 text-slate-500">
            当前公司在该星球尚未拥有地块，请先在行星遥测面板购置地块。
          </div>
        ) : (
          plots.map((pl) => {
            const plotBuildings = buildings.filter((b) => b.plot_id === pl.id);
            return (
              <div key={pl.id} className="space-y-2 border border-slate-800/80 bg-[#080d14] p-2.5 rounded-sm">
                <div className="flex items-center justify-between text-[11px] pb-1.5 border-b border-slate-800/70">
                  <span className="font-semibold text-sky-300">
                    地块 #{pl.id} · {pl.terrain_name}
                  </span>
                  <span className="mono text-slate-400">
                    槽位 {pl.used_slots} / {pl.capacity}
                  </span>
                </div>

                {plotBuildings.length === 0 ? (
                  <div className="text-[11px] text-slate-500 py-2">暂无已建成建筑（建造中或空地）</div>
                ) : (
                  <div className="space-y-2">
                    {plotBuildings.map((b) => {
                      const bDef = buildingMap.get(b.building_type);
                      const rDef = recipeMap.get(b.recipe_id);
                      const validRecipes = (catalog?.recipes ?? []).filter(
                        (r) => r.building_id === b.building_type,
                      );
                      const pct = b.cycle_ticks > 0 ? Math.min(100, Math.round((b.progress / b.cycle_ticks) * 100)) : 0;
                      return (
                        <div key={b.id} className="metric-card space-y-1.5">
                          <div className="flex items-center justify-between gap-2">
                            <div className="flex items-center gap-2 min-w-0">
                              <span
                                className={`w-1 h-4 ${b.active ? 'bg-emerald-400' : 'bg-slate-600'}`}
                              />
                              <span className="font-medium text-slate-100 truncate">
                                {bDef?.name ?? b.building_type} #{b.id}
                              </span>
                            </div>
                            <div className="flex items-center gap-1.5 shrink-0">
                              <select
                                value={b.recipe_id}
                                onChange={(e) =>
                                  void sendIntent({
                                    SetRecipe: { building_id: b.id, recipe_id: e.target.value },
                                  })
                                }
                                className="bg-[#091019] border border-sky-500/30 text-sky-300 text-[10px] px-1.5 py-0.5 rounded-sm"
                              >
                                {validRecipes.map((vr) => (
                                  <option key={vr.id} value={vr.id}>
                                    {vr.name}
                                  </option>
                                ))}
                              </select>
                              <button
                                onClick={() =>
                                  void sendIntent({
                                    ToggleBuilding: { building_id: b.id, active: !b.active },
                                  })
                                }
                                className={`pill-btn py-0 text-[10px] ${
                                  b.active ? 'text-emerald-400 border-emerald-500/40' : 'text-slate-400'
                                }`}
                              >
                                {b.active ? '运行中' : '已待机'}
                              </button>
                              <button
                                onClick={() =>
                                  void sendIntent({
                                    DemolishFacility: { plot_id: pl.id, building_id: b.id },
                                  })
                                }
                                className="pill-btn py-0 text-[10px] text-rose-400 hover:border-rose-400"
                              >
                                拆除
                              </button>
                            </div>
                          </div>

                          <div className="flex justify-between text-[10px] text-slate-400 mono">
                            <span>
                              当前配方：{rDef?.name ?? b.recipe_id} · {b.progress}/{b.cycle_ticks} 回合 ({pct}%)
                            </span>
                            <span>地形效率 {b.efficiency.toFixed(2)}x</span>
                          </div>
                          <div className="h-1 bg-slate-800">
                            <div
                              className={`h-full ${b.active ? 'bg-gradient-to-r from-sky-400 to-emerald-400' : 'bg-slate-600'}`}
                              style={{ width: `${pct}%` }}
                            />
                          </div>
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>
            );
          })
        )}
      </div>
    </div>
  );
};

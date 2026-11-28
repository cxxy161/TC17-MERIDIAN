import React, { useMemo } from 'react';
import { AlertTriangle } from 'lucide-react';
import type { PaneProps } from '../layout/paneRegistry';
import { useCatalogIndex, useWorldIndex } from '../entities/hooks';
import { useGameStore } from '../store/useGameStore';
import { SearchSelect, type PickerOption } from '../components/SearchSelect';
import { VirtualList } from '../components/VirtualList';
import type { BuildingDef, BuildingView, PlotView, RecipeDef, SiteView } from '../types/meridian';
import { READ_ONLY_OBSERVATION_MODE } from '../types/meridian';

/**
 * Virtualization note: a plot card holds a variable number of buildings, so "one row per plot"
 * cannot have a fixed height. Instead the list is flattened to *building rows*, *construction site
 * rows*, plus one *buildable slot row* per plot with free capacity — all sharing ROW_HEIGHT.
 */
const ROW_HEIGHT = 92;

type FactoryRow =
  | { kind: 'building'; plot: PlotView; building: BuildingView }
  | { kind: 'site'; plot: PlotView; site: SiteView }
  | { kind: 'slot'; plot: PlotView };

/**
 * Factory lines for exactly ONE planet, chosen through a searchable picker.
 *
 * The old version built a planet pill-button wall, hard-coded one furnace id as the build type,
 * and re-filtered the whole recipe catalog inside every building render (O(B×R) per tick). The
 * planet and the pending build type live in `params`; the building/recipe pickers are the shared
 * `SearchSelect`; recipes come from the prebuilt `recipesByBuilding` index.
 */
export const FactoryPanel: React.FC<PaneProps> = ({ params, setParams, openTemp }) => {
  const catalog = useCatalogIndex();
  const world = useWorldIndex();
  const state = useGameStore((s) => s.state);
  const sendIntent = useGameStore((s) => s.sendIntent);

  const writable = !READ_ONLY_OBSERVATION_MODE;
  const planetId = params.planetId;
  const planet = world.planet(planetId);

  // Pending build type is an entity id, so it lives in params — never in useState. Defaulting to
  // the first catalog building is the documented default; an invalid deep-linked id is flagged.
  const buildTypeParam = params.buildingId;
  const buildTypeDef = buildTypeParam ? catalog.building(buildTypeParam) : undefined;
  const buildTypeInvalid = !!buildTypeParam && !buildTypeDef;
  const buildType = buildTypeDef?.id ?? catalog.buildings[0]?.id ?? null;
  const buildDef = buildType ? catalog.building(buildType) : undefined;

  const planetOptions = useMemo<PickerOption[]>(
    () =>
      world.planets.map((p) => ({
        id: p.id,
        label: p.name,
        sub: `人口 ${Math.round(p.population).toLocaleString()} · 繁荣 ${p.prosperity.toFixed(2)}x · ${p.id}`,
        keywords: `${p.id} ${p.name} ${p.archetype}`,
        facets: { tier: String(p.wealth_tier) },
      })),
    [world.planets],
  );

  const planetFacets = useMemo(
    () => {
      const counts = new Map<number, number>();
      for (const p of world.planets) counts.set(p.wealth_tier, (counts.get(p.wealth_tier) ?? 0) + 1);
      return [
        {
          key: 'tier',
          label: '财富',
          values: [...counts.entries()]
            .sort((a, b) => a[0] - b[0])
            .map(([tier, count]) => ({ id: String(tier), label: `${tier} 级`, count })),
        },
      ];
    },
    [world.planets],
  );

  const buildingOptions = useMemo<PickerOption[]>(
    () =>
      catalog.buildings.map((b) => {
        const cost = b.build_cost.map((c) => `${catalog.itemName(c.item)}×${c.qty}`).join(' + ') || '免费';
        return {
          id: b.id,
          label: b.name,
          sub: `造价 ${cost} · ${b.slots_used} 槽位 · ${b.build_ticks} 回合 · ${catalog.professionName(b.profession)}`,
          keywords: `${b.id} ${b.profession} ${b.description} ${cost}`,
          facets: { profession: b.profession },
        };
      }),
    [catalog],
  );

  /** buildingId -> its recipes, prebuilt once instead of filtering the catalog per building row. */
  const recipeOptionsByBuilding = useMemo(() => {
    const map = new Map<string, PickerOption[]>();
    for (const [buildingId, recipes] of catalog.recipesByBuilding) {
      map.set(
        buildingId,
        recipes.map((r: RecipeDef) => {
          const ins = r.inputs.map((i) => `${catalog.itemName(i.item)}×${i.qty}`).join(' + ') || '—';
          const outs = r.outputs.map((o) => `${catalog.itemName(o.item)}×${o.qty}`).join(' + ') || '—';
          return {
            id: r.id,
            label: r.name,
            sub: `${ins} → ${outs}`,
            keywords: `${r.id} ${r.cycle_ticks}回合`,
          };
        }),
      );
    }
    return map;
  }, [catalog]);

  /** Plots owned on this planet, and their buildings, both derived once per state change. */
  const plots = useMemo(
    () =>
      (state?.player_snapshot?.company.plots ?? [])
        .filter((pl) => pl.planet_id === planetId)
        .sort((a, b) => a.id - b.id),
    [state, planetId],
  );

  const buildingsByPlot = useMemo(() => {
    const map = new Map<number, BuildingView[]>();
    for (const b of state?.player_snapshot?.company.buildings ?? []) {
      if (b.planet_id !== planetId) continue;
      const list = map.get(b.plot_id);
      if (list) list.push(b);
      else map.set(b.plot_id, [b]);
    }
    return map;
  }, [state, planetId]);

  const sitesByPlot = useMemo(() => {
    const map = new Map<number, SiteView[]>();
    for (const s of state?.player_snapshot?.company.sites ?? []) {
      if (s.planet_id !== planetId) continue;
      const list = map.get(s.plot_id);
      if (list) list.push(s);
      else map.set(s.plot_id, [s]);
    }
    return map;
  }, [state, planetId]);

  const rows = useMemo<FactoryRow[]>(() => {
    const out: FactoryRow[] = [];
    for (const plot of plots) {
      const list = buildingsByPlot.get(plot.id) ?? [];
      for (const building of list) out.push({ kind: 'building', plot, building });
      const sites = sitesByPlot.get(plot.id) ?? [];
      for (const site of sites) out.push({ kind: 'site', plot, site });
      if (plot.used_slots < plot.capacity) out.push({ kind: 'slot', plot });
    }
    return out;
  }, [plots, buildingsByPlot, sitesByPlot]);

  const stats = useMemo(() => {
    let buildingCount = 0;
    let activeCount = 0;
    let siteCount = 0;
    for (const list of buildingsByPlot.values()) {
      buildingCount += list.length;
      activeCount += list.filter((b) => b.active).length;
    }
    for (const sites of sitesByPlot.values()) {
      siteCount += sites.length;
    }
    return { buildingCount, activeCount, siteCount };
  }, [buildingsByPlot, sitesByPlot]);

  const costText = (def: BuildingDef): string =>
    def.build_cost.map((c) => `${catalog.itemName(c.item)}×${c.qty}`).join(' + ') || '免费';

  const recipeIo = (r: RecipeDef): string => {
    const ins = r.inputs.map((i) => `${catalog.itemName(i.item)}×${i.qty}`).join(' + ') || '—';
    const outs = r.outputs.map((o) => `${catalog.itemName(o.item)}×${o.qty}`).join(' + ') || '—';
    return `${ins} → ${outs}`;
  };

  const planetPicker = (
    <SearchSelect
      options={planetOptions}
      value={planetId}
      onChange={(id) => setParams({ planetId: id })}
      facets={planetFacets}
      placeholder="搜索行星 / 编号…"
      emptyLabel="选择行星"
      className="max-w-[200px]"
    />
  );

  if (!planet) {
    return (
      <div className="h-full flex flex-col bg-[#202732] text-slate-200 overflow-hidden">
        <div className="px-2.5 py-1.5 border-b border-sky-500/10 bg-[#232a36] flex items-center gap-2 shrink-0 flex-wrap">
          {planetPicker}
          <span className="text-[11px] text-amber-300">
            {!world.ready
              ? '正在同步行星数据…'
              : planetId
                ? `行星「${planetId}」不存在（可能来自已移除的行星）`
                : '未选择行星'}
          </span>
        </div>
        <div className="flex-1 flex flex-col items-center justify-center gap-2 text-[11px] text-slate-500 px-4 text-center">
          <AlertTriangle className="w-5 h-5 text-amber-400/70" />
          <span>从上方选择器选一颗行星，查看该星球的地块与产线。</span>
        </div>
      </div>
    );
  }

  const renderBuilding = (plot: PlotView, b: BuildingView) => {
    const pct = b.cycle_ticks > 0 ? Math.min(100, Math.round((b.progress / b.cycle_ticks) * 100)) : 0;
    const recipeOptions = recipeOptionsByBuilding.get(b.building_type) ?? [];
    const recipeDef = catalog.recipe(b.recipe_id);

    return (
      <div className="h-full border border-slate-800/80 bg-[#1b212b] rounded-sm px-2 py-1 flex flex-col justify-center gap-1">
        <div className="flex items-center gap-2 min-w-0">
          <span className={`w-1 h-4 shrink-0 ${b.active ? 'bg-emerald-400' : 'bg-slate-600'}`} />
          <span className="text-[11px] font-medium text-slate-100 truncate">
            {catalog.buildingName(b.building_type)}{' '}
            <span className="text-[9px] mono text-slate-500">#{b.id}</span>
          </span>
          <span className="text-[9px] mono text-slate-500 truncate">
            地块 #{plot.id} · {plot.terrain_name}
          </span>
          <div className="ml-auto flex items-center gap-1.5 shrink-0">
            {writable ? (
              <>
                <SearchSelect
                  options={recipeOptions}
                  value={b.recipe_id}
                  onChange={(recipeId) =>
                    void sendIntent({ SetRecipe: { building_id: b.id, recipe_id: recipeId } })
                  }
                  placeholder="搜索配方…"
                  emptyLabel={catalog.recipeName(b.recipe_id)}
                  className="max-w-[180px]"
                />
                <button
                  onClick={() =>
                    void sendIntent({ ToggleBuilding: { building_id: b.id, active: !b.active } })
                  }
                  className={`pill-btn py-0 text-[10px] ${
                    b.active ? 'text-emerald-400 border-emerald-500/40' : 'text-slate-400'
                  }`}
                >
                  {b.active ? '运行中' : '已待机'}
                </button>
                <button
                  onClick={() =>
                    void sendIntent({ DemolishFacility: { plot_id: plot.id, building_id: b.id } })
                  }
                  className="pill-btn py-0 text-[10px] text-rose-400 hover:border-rose-400"
                >
                  拆除
                </button>
              </>
            ) : (
              <span className="text-[10px] px-1.5 py-0.5 bg-[#222935] border border-sky-500/25 text-sky-300">
                {catalog.recipeName(b.recipe_id)}
              </span>
            )}
          </div>
        </div>

        <div className="flex justify-between gap-2 text-[10px] text-slate-400 mono min-w-0">
          <span className="truncate">
            当前配方：{catalog.recipeName(b.recipe_id)} · {b.progress}/{b.cycle_ticks} 回合 ({pct}%)
          </span>
          <span className="shrink-0">地形效率 {b.efficiency.toFixed(2)}x</span>
        </div>

        {recipeDef && <div className="text-[9px] text-slate-500 truncate">{recipeIo(recipeDef)}</div>}

        <div className="h-1 bg-slate-800">
          <div
            className={`h-full ${b.active ? 'bg-gradient-to-r from-sky-400 to-emerald-400' : 'bg-slate-600'}`}
            style={{ width: `${pct}%` }}
          />
        </div>
      </div>
    );
  };

  const renderSite = (plot: PlotView, site: SiteView) => {
    const def = catalog.building(site.building_type);
    const totalTicks = def?.build_ticks ?? Math.max(1, site.ticks_remaining);
    const doneTicks = Math.max(0, totalTicks - site.ticks_remaining);
    const pct = totalTicks > 0 ? Math.min(100, Math.round((doneTicks / totalTicks) * 100)) : 0;
    const eff = plot.building_mods[site.building_type] ?? 1;

    return (
      <div className="h-full border border-amber-500/35 bg-[#1b212b] rounded-sm px-2 py-1 flex flex-col justify-center gap-1">
        <div className="flex items-center gap-2 min-w-0">
          <span className="w-1 h-4 shrink-0 bg-amber-400" />
          <span className="text-[11px] font-medium text-amber-200 truncate">
            建造中 · {catalog.buildingName(site.building_type)}{' '}
            <span className="text-[9px] mono text-slate-500">工地 #{site.id}</span>
          </span>
          <span className="text-[9px] mono text-slate-500 truncate">
            地块 #{plot.id} · {plot.terrain_name}
          </span>
          <span className="ml-auto text-[10px] mono px-1.5 py-0.5 rounded-sm border border-amber-500/35 bg-amber-500/10 text-amber-200 shrink-0">
            预计 T#{site.finish_tick} 完工
          </span>
        </div>

        <div className="flex justify-between gap-2 text-[10px] text-slate-300 mono min-w-0">
          <span className="truncate">
            施工进度：{doneTicks}/{totalTicks} 回合 ({pct}%) · 还剩 {site.ticks_remaining} 回合
          </span>
          <span className="shrink-0 text-slate-400">地形效率 {eff.toFixed(2)}x</span>
        </div>

        <div className="text-[9px] text-slate-500 truncate">
          已占用 {def?.slots_used ?? 1} 槽位 · 完工后自动切换为运行中设施
        </div>

        <div className="h-1 bg-slate-800 rounded-full overflow-hidden">
          <div
            className="h-full bg-gradient-to-r from-amber-400 to-sky-400 transition-all"
            style={{ width: `${pct}%` }}
          />
        </div>
      </div>
    );
  };

  const renderSlot = (plot: PlotView) => (
    <div className="h-full border border-dashed border-slate-700/80 bg-[#1b212b]/60 rounded-sm px-2 py-1 flex flex-col justify-center gap-1">
      <div className="flex items-center gap-2 min-w-0">
        <span className="text-[11px] text-slate-300 truncate">
          地块 #{plot.id} · {plot.terrain_name}
        </span>
        <span className="text-[9px] mono text-slate-500 shrink-0">
          空地 · 槽位 {plot.used_slots}/{plot.capacity}
        </span>
        <div className="ml-auto shrink-0">
          {writable ? (
            <button
              disabled={!buildType}
              onClick={() => {
                if (buildType) {
                  void sendIntent({
                    BuildFacility: { plot_id: plot.id, building_type: buildType },
                  });
                }
              }}
              className="cta-blue text-[10px] py-0.5 px-2 disabled:opacity-40"
            >
              建造 {buildType ? catalog.buildingName(buildType) : ''}
            </button>
          ) : (
            <span className="text-[9px] text-slate-500">纯代码观察模式：请在脚本中建造</span>
          )}
        </div>
      </div>
      <span className="text-[9px] text-slate-500 truncate">
        {buildDef
          ? `造价 ${costText(buildDef)} · 占 ${buildDef.slots_used} 槽位 · ${buildDef.build_ticks} 回合 · ${catalog.professionName(buildDef.profession)}`
          : '在顶部选择要建造的建筑类型'}
      </span>
    </div>
  );

  return (
    <div className="h-full flex flex-col bg-[#202732] text-slate-200 overflow-hidden">
      <div className="px-2 py-1.5 border-b border-sky-500/10 bg-[#232a36] flex items-center gap-2 shrink-0 flex-wrap">
        {planetPicker}
        <span className="text-[10px] mono text-slate-500">{planet.archetype}</span>
        <span className="w-px h-3.5 bg-slate-700" />
        <SearchSelect
          options={buildingOptions}
          value={buildType}
          onChange={(id) => setParams({ buildingId: id })}
          facets={[{ key: 'profession', label: '职业', values: catalog.facets.profession }]}
          placeholder="搜索建筑 / 职业 / 造价…"
          emptyLabel="选择建造类型"
          className="max-w-[190px]"
        />
        {buildDef && (
          <span className="text-[9px] text-slate-500 truncate max-w-[240px] hidden sm:inline">
            {costText(buildDef)} · {buildDef.slots_used} 槽 · {buildDef.build_ticks} 回合 ·{' '}
            {catalog.professionName(buildDef.profession)}
          </span>
        )}
        {buildTypeInvalid && (
          <span className="text-[9px] text-amber-300 whitespace-nowrap">
            建筑类型「{buildTypeParam}」不存在，已回退默认
          </span>
        )}
        <span className="ml-auto text-[10px] mono text-slate-400 whitespace-nowrap">
          地块 {plots.length} · 建筑 {stats.buildingCount} · 运行 {stats.activeCount}/{stats.buildingCount}
          {stats.siteCount > 0 ? ` · 在建 ${stats.siteCount}` : ''}
        </span>
      </div>

      <div className="px-2 py-1 bg-[#252e3b] border-b border-slate-800/80 flex items-center justify-between text-[9px] text-slate-500 shrink-0">
        <span>每行一栋设施或建造中工地；虚线行为该地块的剩余槽位，可直接建造所选类型</span>
        <span>回合 {world.tick} · {planet.population > 0 ? `人口 ${Math.round(planet.population).toLocaleString()}` : '无人'}</span>
      </div>

      <VirtualList
        className="flex-1 min-h-0 overflow-y-auto"
        count={rows.length}
        rowHeight={ROW_HEIGHT}
        emptyState={
          <div className="metric-card text-center py-6 text-slate-500 text-[11px] space-y-2">
            <div>当前公司在该星球尚未拥有地块，请先购买工业用地。</div>
            <button
              onClick={() => openTemp('land', { planetId: planet.id })}
              className="cta-blue text-[10px] py-0.5 px-2.5"
            >
              前往地块浏览购地
            </button>
          </div>
        }
        renderRow={(idx) => {
          const row = rows[idx];
          // The row wrapper owns the gutter; absolute rows must not receive flow margins.
          return (
            <div className="h-full px-2 pt-1">
              {row.kind === 'building'
                ? renderBuilding(row.plot, row.building)
                : row.kind === 'site'
                  ? renderSite(row.plot, row.site)
                  : renderSlot(row.plot)}
            </div>
          );
        }}
      />
    </div>
  );
};

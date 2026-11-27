import React, { useMemo, useState } from 'react';
import { ArrowRight, ExternalLink, Search, X } from 'lucide-react';
import type { PaneProps } from '../layout/paneRegistry';
import { useCatalogIndex } from '../entities/hooks';
import type { RecipeDef } from '../types/meridian';

type RouteFilter = 'all' | 'zero_input' | 'cross_sector';

interface RecipeEconomics {
  inputCost: number;
  powerEst: number;
  outputValue: number;
  grossMargin: number;
  marginPerTick: number;
}

export const ProductionCatalogPanel: React.FC<PaneProps> = ({ params, setParams, openTemp }) => {
  const catalog = useCatalogIndex();
  const [query, setQuery] = useState('');
  const [profFilter, setProfFilter] = useState<string>('all');
  const [routeFilter, setRouteFilter] = useState<RouteFilter>('all');

  const selectedBuildingId = params.buildingId ?? null;
  const selectedItemId = params.itemId ?? null;

  const powerRefPrice = catalog.item('power')?.ref_price ?? 1.0;

  const buildingList = useMemo(() => {
    return catalog.buildings.filter((b) => profFilter === 'all' || b.profession === profFilter);
  }, [catalog.buildings, profFilter]);

  const isCrossSector = (recipe: RecipeDef): boolean => {
    const b = catalog.building(recipe.building_id);
    if (!b) return false;
    return recipe.inputs.some((inp) => {
      const it = catalog.item(inp.item);
      return it && it.profession !== b.profession;
    });
  };

  const recipeEconomics = (recipe: RecipeDef): RecipeEconomics => {
    const inputCost = recipe.inputs.reduce(
      (sum, inp) => sum + inp.qty * (catalog.item(inp.item)?.ref_price ?? 0),
      0,
    );
    const powerEst = recipe.power_cost * powerRefPrice;
    const outputValue = recipe.outputs.reduce(
      (sum, out) => sum + out.qty * (catalog.item(out.item)?.ref_price ?? 0),
      0,
    );
    const grossMargin = outputValue - inputCost - powerEst - recipe.labor_cost;
    const marginPerTick = recipe.cycle_ticks > 0 ? grossMargin / recipe.cycle_ticks : grossMargin;
    return { inputCost, powerEst, outputValue, grossMargin, marginPerTick };
  };

  const filteredRecipes = useMemo(() => {
    const q = query.trim().toLowerCase();
    return catalog.recipes.filter((r) => {
      const b = catalog.building(r.building_id);
      if (selectedBuildingId && r.building_id !== selectedBuildingId) return false;
      if (profFilter !== 'all' && b?.profession !== profFilter) return false;
      if (routeFilter === 'zero_input' && r.inputs.length > 0) return false;
      if (routeFilter === 'cross_sector' && !isCrossSector(r)) return false;
      if (selectedItemId) {
        const hitItem =
          r.inputs.some((i) => i.item === selectedItemId) ||
          r.outputs.some((o) => o.item === selectedItemId);
        if (!hitItem) return false;
      }
      if (!q) return true;
      const inNames = r.inputs.map((i) => `${catalog.itemName(i.item)} ${i.item}`).join(' ');
      const outNames = r.outputs.map((o) => `${catalog.itemName(o.item)} ${o.item}`).join(' ');
      return (
        r.name.toLowerCase().includes(q) ||
        r.id.toLowerCase().includes(q) ||
        (b?.name ?? '').toLowerCase().includes(q) ||
        r.building_id.toLowerCase().includes(q) ||
        inNames.toLowerCase().includes(q) ||
        outNames.toLowerCase().includes(q)
      );
    });
  }, [catalog, query, selectedBuildingId, profFilter, routeFilter, selectedItemId]);

  if (!catalog.ready) {
    return <div className="p-4 text-[11px] text-slate-400">正在加载静态产线图鉴…</div>;
  }

  return (
    <div className="h-full flex flex-col bg-[#1b212b] text-slate-200 overflow-hidden">
      {/* Top filter bar */}
      <div className="px-2.5 py-1.5 border-b border-sky-500/15 bg-[#232a36] flex items-center gap-2 flex-wrap shrink-0">
        <div className="flex items-center gap-1.5 bg-[#161c24] border border-slate-700/80 rounded-sm px-2 py-0.5 min-w-[180px] flex-1 max-w-[300px]">
          <Search className="w-3.5 h-3.5 text-sky-400 shrink-0" />
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="搜配方 / 工厂 / 物品名或 id..."
            className="flex-1 min-w-0 bg-transparent outline-none text-[11px] text-slate-200 placeholder:text-slate-600"
          />
          {query && (
            <button
              type="button"
              onClick={() => setQuery('')}
              className="text-slate-500 hover:text-slate-200"
              title="清空搜索"
            >
              <X className="w-3 h-3" />
            </button>
          )}
        </div>

        <div className="flex items-center gap-1 flex-wrap">
          <button
            type="button"
            onClick={() => setProfFilter('all')}
            className={`pill-btn py-0 text-[10px] ${profFilter === 'all' ? 'active' : ''}`}
          >
            全部行业
          </button>
          {catalog.professions.map((p) => (
            <button
              key={p.id}
              type="button"
              onClick={() => {
                setProfFilter(p.id);
                if (selectedBuildingId && catalog.building(selectedBuildingId)?.profession !== p.id) {
                  setParams({ buildingId: undefined });
                }
              }}
              className={`pill-btn py-0 text-[10px] inline-flex items-center gap-1 ${
                profFilter === p.id ? 'active' : ''
              }`}
            >
              <span className="w-1.5 h-1.5 rounded-full shrink-0" style={{ backgroundColor: p.color }} />
              {p.name}
            </button>
          ))}
        </div>

        <div className="flex items-center gap-1 ml-auto flex-wrap">
          {([
            ['all', '全部路线'],
            ['zero_input', '零原料起步'],
            ['cross_sector', '跨行业耦合'],
          ] as Array<[RouteFilter, string]>).map(([k, lbl]) => (
            <button
              key={k}
              type="button"
              onClick={() => setRouteFilter(k)}
              className={`pill-btn py-0 text-[10px] ${routeFilter === k ? 'active' : ''}`}
            >
              {lbl}
            </button>
          ))}
        </div>
      </div>

      {/* Active item filter banner when player clicks an input/output chip */}
      {selectedItemId && (
        <div className="px-2.5 py-1 border-b border-sky-500/20 bg-sky-500/10 flex items-center justify-between gap-2 text-[10.5px] shrink-0">
          <span className="text-sky-200">
            物品关联过滤：
            <strong className="ml-1 text-white">{catalog.itemName(selectedItemId)}</strong>
            <span className="mono ml-1 text-sky-400">({selectedItemId})</span>
            <span className="ml-2 text-slate-400">共 {filteredRecipes.length} 条相关配方</span>
          </span>
          <div className="flex items-center gap-2 shrink-0">
            <button
              type="button"
              onClick={() => openTemp('item', { itemId: selectedItemId })}
              className="inline-flex items-center gap-1 text-sky-300 hover:text-sky-200 hover:underline"
            >
              <ExternalLink className="w-3 h-3" />
              物品详情
            </button>
            <button
              type="button"
              onClick={() => setParams({ itemId: undefined })}
              className="pill-btn py-0 text-[10px]"
            >
              清除物品过滤
            </button>
          </div>
        </div>
      )}

      {/* Main split: Building list (left) + Recipe cards (right) */}
      <div className="flex-1 min-h-0 flex flex-col md:flex-row overflow-hidden">
        {/* Left: Facilities directory */}
        <aside className="md:w-[270px] shrink-0 border-b md:border-b-0 md:border-r border-slate-800 bg-[#191f27] overflow-y-auto p-2 space-y-1.5 max-h-[210px] md:max-h-none">
          <button
            type="button"
            onClick={() => setParams({ buildingId: undefined })}
            className={`w-full text-left px-2.5 py-1.5 rounded-[2px] border text-[11px] flex items-center justify-between transition-colors ${
              !selectedBuildingId
                ? 'border-sky-400 bg-[#1b2432] text-sky-200 font-medium'
                : 'border-slate-800 bg-[#1e2530] text-slate-300 hover:border-slate-600'
            }`}
          >
            <span>全部工厂设施 ({buildingList.length})</span>
            <span className="mono text-[10px] text-slate-400">{catalog.recipes.length} 配方</span>
          </button>

          {buildingList.map((b) => {
            const prof = catalog.professionById.get(b.profession);
            const active = selectedBuildingId === b.id;
            const bRecipes = catalog.recipesByBuilding.get(b.id) ?? [];
            const costText = b.build_cost
              .map((c) => `${catalog.itemName(c.item)}×${c.qty}`)
              .join(' ');
            return (
              <button
                key={b.id}
                type="button"
                onClick={() => setParams({ buildingId: active ? undefined : b.id })}
                className={`w-full text-left px-2.5 py-2 rounded-[2px] border transition-colors ${
                  active
                    ? 'border-sky-400 bg-[#1b2432] shadow-[0_0_0_1px_rgba(56,189,248,0.2)]'
                    : 'border-slate-800 bg-[#1e2530] hover:border-slate-600'
                }`}
              >
                <div className="flex items-center justify-between gap-1.5">
                  <span className="inline-flex items-center gap-1.5 min-w-0">
                    <span
                      className="w-2 h-2 rounded-full shrink-0"
                      style={{ backgroundColor: prof?.color ?? '#38bdf8' }}
                    />
                    <span className="text-[11.5px] font-semibold text-slate-100 truncate">
                      {b.name}
                    </span>
                  </span>
                  <span className="mono text-[9.5px] text-sky-400 shrink-0">{bRecipes.length} 条</span>
                </div>

                <div className="mono text-[9.5px] text-slate-500 mt-0.5">{b.id}</div>

                <div className="mono mt-1.5 flex flex-wrap gap-x-2 gap-y-0.5 text-[10px] text-slate-300">
                  <span>造价 <strong className="text-amber-200 font-normal">{costText}</strong></span>
                  <span className="text-slate-500">·</span>
                  <span>{b.build_ticks}回合</span>
                  <span className="text-slate-500">·</span>
                  <span>{b.slots_used}槽</span>
                  <span className="text-slate-500">·</span>
                  <span>待机{b.standby_power}电</span>
                </div>

                <p className="mt-1 text-[10px] text-slate-400 leading-snug line-clamp-2">
                  {b.description}
                </p>
              </button>
            );
          })}
        </aside>

        {/* Right: Recipes catalog */}
        <section className="flex-1 min-h-0 overflow-y-auto p-2.5 space-y-2">
          {filteredRecipes.length === 0 ? (
            <div className="h-32 flex items-center justify-center text-[11px] text-slate-500">
              当前筛选条件下没有匹配的生产配方
            </div>
          ) : (
            filteredRecipes.map((r) => {
              const b = catalog.building(r.building_id);
              const prof = b ? catalog.professionById.get(b.profession) : undefined;
              const econ = recipeEconomics(r);
              const notes = (r as RecipeDef & { notes?: string }).notes;
              const cross = isCrossSector(r);
              return (
                <div
                  key={r.id}
                  className="rounded-[2px] border border-slate-700/70 bg-[#202732] px-3 py-2 space-y-2"
                >
                  {/* Card header */}
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <div className="flex flex-wrap items-center gap-2 min-w-0">
                      <span
                        className="w-2 h-2 rounded-full shrink-0"
                        style={{ backgroundColor: prof?.color ?? '#38bdf8' }}
                      />
                      <span className="text-[12px] font-semibold text-slate-100">{r.name}</span>
                      <span className="mono text-[10px] text-slate-500">{r.id}</span>
                      {b && (
                        <button
                          type="button"
                          onClick={() => setParams({ buildingId: b.id })}
                          className="rounded-[2px] border border-sky-500/25 bg-[#161c24] px-1.5 py-[1px] text-[10px] text-sky-300 hover:border-sky-400"
                          title="只看该工厂的全部配方"
                        >
                          {b.name}
                        </button>
                      )}
                      {r.inputs.length === 0 && (
                        <span className="rounded-[2px] border border-emerald-500/35 bg-emerald-500/10 px-1.5 py-[1px] text-[9.5px] text-emerald-300">
                          零原料
                        </span>
                      )}
                      {cross && (
                        <span className="rounded-[2px] border border-amber-500/35 bg-amber-500/10 px-1.5 py-[1px] text-[9.5px] text-amber-200">
                          跨行业
                        </span>
                      )}
                    </div>

                    <div className="mono flex items-center gap-2 text-[10px] text-slate-300 shrink-0">
                      <span>周期 <strong className="text-sky-300">{r.cycle_ticks}t</strong></span>
                      <span className="text-slate-600">·</span>
                      <span>耗电 <strong className="text-amber-300">{r.power_cost}</strong></span>
                      <span className="text-slate-600">·</span>
                      <span>人工 <strong className="text-slate-200">{r.labor_cost.toFixed(0)}</strong></span>
                    </div>
                  </div>

                  {/* Inputs -> Outputs visual pipeline */}
                  <div className="flex flex-wrap items-center gap-2 bg-[#181e27] border border-slate-800/90 rounded-[2px] px-2.5 py-1.5">
                    {/* Inputs */}
                    <div className="flex flex-wrap items-center gap-1.5 flex-1 min-w-[140px]">
                      {r.inputs.length === 0 ? (
                        <span className="text-[10px] text-emerald-300/80">无需前置原料（直采 / 直发）</span>
                      ) : (
                        r.inputs.map((inp) => {
                          const instant = catalog.isInstant(inp.item);
                          const isSel = selectedItemId === inp.item;
                          return (
                            <button
                              key={inp.item}
                              type="button"
                              onClick={() => setParams({ itemId: isSel ? undefined : inp.item })}
                              className={`mono inline-flex items-center gap-1 rounded-[2px] border px-1.5 py-0.5 text-[10.5px] transition-colors ${
                                isSel
                                  ? 'border-sky-400 bg-sky-500/20 text-white'
                                  : 'border-slate-700 bg-[#202732] text-slate-200 hover:border-sky-500/50'
                              }`}
                              title="点击按此物品筛选上下游配方"
                            >
                              <span>{catalog.itemName(inp.item)}</span>
                              <strong className="text-amber-300">×{inp.qty}</strong>
                              {instant && (
                                <span className="text-[8.5px] px-1 rounded-[1px] bg-sky-500/20 text-sky-300">
                                  瞬时
                                </span>
                              )}
                            </button>
                          );
                        })
                      )}
                    </div>

                    <ArrowRight className="w-3.5 h-3.5 text-sky-400 shrink-0" />

                    {/* Outputs */}
                    <div className="flex flex-wrap items-center gap-1.5 flex-1 min-w-[140px] justify-end">
                      {r.outputs.map((out) => {
                        const instant = catalog.isInstant(out.item);
                        const isSel = selectedItemId === out.item;
                        return (
                          <button
                            key={out.item}
                            type="button"
                            onClick={() => setParams({ itemId: isSel ? undefined : out.item })}
                            className={`mono inline-flex items-center gap-1 rounded-[2px] border px-1.5 py-0.5 text-[10.5px] transition-colors ${
                              isSel
                                ? 'border-emerald-400 bg-emerald-500/20 text-white'
                                : 'border-emerald-500/35 bg-emerald-500/10 text-emerald-100 hover:border-emerald-400'
                            }`}
                            title="点击按此物品筛选上下游配方"
                          >
                            <span>{catalog.itemName(out.item)}</span>
                            <strong className="text-emerald-300">×{out.qty}</strong>
                            {instant && (
                              <span className="text-[8.5px] px-1 rounded-[1px] bg-sky-500/25 text-sky-200">
                                瞬时
                              </span>
                            )}
                          </button>
                        );
                      })}
                    </div>
                  </div>

                  {/* Footer notes + static reference valuation */}
                  <div className="flex flex-wrap items-center justify-between gap-2 text-[10px] text-slate-400">
                    <span>{notes || prof?.name || '标准生产路线'}</span>
                    <span className="mono">
                      静态参考估值：投 {econ.inputCost.toFixed(1)} + 电 {econ.powerEst.toFixed(1)} + 工{' '}
                      {r.labor_cost.toFixed(0)} → 产 {econ.outputValue.toFixed(1)}（
                      <span className={econ.grossMargin >= 0 ? 'text-emerald-300' : 'text-amber-300'}>
                        {econ.grossMargin >= 0 ? '+' : ''}
                        {econ.grossMargin.toFixed(1)}/周期 · {econ.marginPerTick >= 0 ? '+' : ''}
                        {econ.marginPerTick.toFixed(2)}/t
                      </span>
                      ）
                    </span>
                  </div>
                </div>
              );
            })
          )}
        </section>
      </div>
    </div>
  );
};

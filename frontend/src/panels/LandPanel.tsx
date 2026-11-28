import React, { useEffect, useMemo, useState } from 'react';
import { Search } from 'lucide-react';
import type { PaneProps } from '../layout/paneRegistry';
import { api } from '../api/client';
import { useCatalogIndex, useWorldIndex } from '../entities/hooks';
import { useGameStore } from '../store/useGameStore';
import { SearchSelect, type PickerOption } from '../components/SearchSelect';
import {
  moneyToCredits,
  READ_ONLY_OBSERVATION_MODE,
  type PlanetPlotsResp,
  type PublicLandTile,
} from '../types/meridian';

type StatusFilter = 'all' | 'unclaimed' | 'listed' | 'owned' | 'mine' | 'city';
type SortMode = 'slot' | 'mine_smelter' | 'power_water_station' | 'bio_greenhouse' | 'capacity' | 'price';

function modColor(v: number): string {
  if (v >= 1.3) return 'text-emerald-300';
  if (v >= 1.0) return 'text-sky-200';
  return 'text-amber-300/80';
}

function statusLabel(t: PublicLandTile): { text: string; cls: string } {
  if (t.is_city) return { text: '城市区', cls: 'bg-amber-500/20 text-amber-200 border-amber-400/40' };
  if (t.is_mine) return { text: '我方', cls: 'bg-sky-500/25 text-sky-200 border-sky-400/50' };
  if (t.status === 'listed') return { text: '在售挂牌', cls: 'bg-emerald-500/20 text-emerald-200 border-emerald-400/45' };
  if (t.status === 'owned') return { text: '已开发', cls: 'bg-violet-500/20 text-violet-200 border-violet-400/40' };
  return { text: '未开发空地', cls: 'bg-slate-700/60 text-slate-300 border-slate-600/70' };
}

export const LandPanel: React.FC<PaneProps> = ({ params, setParams, openTemp }) => {
  const world = useWorldIndex();
  const catalog = useCatalogIndex();
  const tick = useGameStore((s) => s.state?.tick ?? 0);
  const homePlanetId = useGameStore((s) => s.state?.player_snapshot?.company.home_planet_id);
  const cash = moneyToCredits(useGameStore((s) => s.state?.player_snapshot?.company.cash));
  const sendIntent = useGameStore((s) => s.sendIntent);

  const activePlanetId = params.planetId || homePlanetId || world.planets[0]?.id || '';
  const [data, setData] = useState<PlanetPlotsResp | null>(null);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [filter, setFilter] = useState<StatusFilter>('all');
  const [sortBy, setSortBy] = useState<SortMode>('slot');
  const [query, setQuery] = useState('');
  const [selectedSlotId, setSelectedSlotId] = useState<number | null>(params.slotId ?? null);

  useEffect(() => {
    if (params.slotId !== undefined) setSelectedSlotId(params.slotId);
  }, [params.slotId]);

  useEffect(() => {
    if (!activePlanetId) return;
    let cancelled = false;
    setLoading((prev) => prev || !data || data.planet.id !== activePlanetId);
    api
      .getPlanetPlots(activePlanetId)
      .then((resp) => {
        if (cancelled) return;
        setData(resp);
        setErr(null);
        setLoading(false);
      })
      .catch((e) => {
        if (cancelled) return;
        setErr(e instanceof Error ? e.message : String(e));
        setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [activePlanetId, tick]);

  const planetOptions = useMemo<PickerOption[]>(
    () =>
      world.planets.map((p) => ({
        id: p.id,
        label: `${p.name} (${p.id})`,
        sub: `${p.archetype} · 余地 ${p.unclaimed_plots}`,
        keywords: `${p.id} ${p.name} ${p.archetype}`,
      })),
    [world.planets],
  );

  const tiles = data?.tiles ?? [];

  const counts = useMemo(() => {
    let unclaimed = 0;
    let listed = 0;
    let owned = 0;
    let mine = 0;
    let city = 0;
    for (const t of tiles) {
      if (t.is_city) city += 1;
      else if (t.status === 'unclaimed') unclaimed += 1;
      else if (t.status === 'listed') listed += 1;
      else owned += 1;
      if (t.is_mine) mine += 1;
    }
    return { all: tiles.length, unclaimed, listed, owned, mine, city };
  }, [tiles]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    const list = tiles.filter((t) => {
      if (filter === 'unclaimed' && t.status !== 'unclaimed') return false;
      if (filter === 'listed' && t.status !== 'listed') return false;
      if (filter === 'owned' && t.status !== 'owned' && t.status !== 'listed') return false;
      if (filter === 'mine' && !t.is_mine) return false;
      if (filter === 'city' && !t.is_city) return false;
      if (!q) return true;
      return (
        String(t.slot_id).includes(q) ||
        t.terrain_name.toLowerCase().includes(q) ||
        (t.owner_name ?? '').toLowerCase().includes(q) ||
        (t.owner_id ?? '').toLowerCase().includes(q) ||
        (t.city_name ?? '').toLowerCase().includes(q) ||
        t.buildings.some((b) => b.toLowerCase().includes(q))
      );
    });

    list.sort((a, b) => {
      if (sortBy === 'capacity') return b.capacity - a.capacity || a.slot_id - b.slot_id;
      if (sortBy === 'price') {
        const pa = a.price ?? Number.POSITIVE_INFINITY;
        const pb = b.price ?? Number.POSITIVE_INFINITY;
        return pa - pb || a.slot_id - b.slot_id;
      }
      if (sortBy === 'mine_smelter' || sortBy === 'power_water_station' || sortBy === 'bio_greenhouse') {
        const ma = a.building_mods[sortBy] ?? 0;
        const mb = b.building_mods[sortBy] ?? 0;
        return mb - ma || a.slot_id - b.slot_id;
      }
      return a.slot_id - b.slot_id;
    });
    return list;
  }, [tiles, filter, sortBy, query]);

  const selectedTile = useMemo(() => {
    if (selectedSlotId !== null) {
      const hit = tiles.find((t) => t.slot_id === selectedSlotId);
      if (hit) return hit;
    }
    return filtered[0] ?? tiles[0] ?? null;
  }, [tiles, filtered, selectedSlotId]);

  const pInfo = data?.planet;
  const selectedStatus = selectedTile ? statusLabel(selectedTile) : null;
  const selectedMods = selectedTile
    ? Object.entries(selectedTile.building_mods).sort((a, b) => b[1] - a[1])
    : [];

  return (
    <div className="h-full flex flex-col bg-[#1b212b] text-slate-200 overflow-hidden">
      {/* Header: Planet Selector & Quota Strip */}
      <div className="px-2.5 py-1.5 border-b border-sky-500/15 bg-[#232a36] flex items-center gap-2 shrink-0 flex-wrap">
        <SearchSelect
          options={planetOptions}
          value={activePlanetId}
          onChange={(id) => {
            setSelectedSlotId(null);
            setParams({ planetId: id, slotId: undefined });
          }}
          placeholder="选择行星..."
          emptyLabel="选择行星"
          className="max-w-[210px]"
        />
        {pInfo && (
          <div className="flex items-center gap-2 text-[10.5px] mono text-slate-300 flex-wrap">
            <span>
              可选 <b className="text-sky-300">{pInfo.unclaimed_plots}</b>/{pInfo.total_developable_plots}
            </span>
            <span className="text-slate-600">·</span>
            <span>
              一手价{' '}
              <b className="text-emerald-300">
                {pInfo.primary_land_price !== null ? pInfo.primary_land_price.toFixed(1) : '售罄'}
              </b>
            </span>
            <span className="text-slate-600">·</span>
            <span>
              NPC占{' '}
              <b className={pInfo.npc_plot_count >= pInfo.npc_plot_cap ? 'text-amber-300' : 'text-slate-200'}>
                {pInfo.npc_plot_count}/{pInfo.npc_plot_cap}
              </b>
            </span>
            <span className="text-slate-600">·</span>
            <span>
              挂牌 <b className="text-emerald-300">{counts.listed}</b>
            </span>
          </div>
        )}
        {activePlanetId && (
          <button
            onClick={() => openTemp('planet', { planetId: activePlanetId })}
            className="ml-auto text-[10px] text-sky-300 hover:underline shrink-0"
          >
            回行星遥测
          </button>
        )}
      </div>

      {/* Filters & Sorting Toolbar */}
      <div className="px-2.5 py-1 border-b border-slate-800 flex items-center gap-1.5 flex-wrap bg-[#202732] shrink-0">
        {([
          ['all', `全部(${counts.all})`],
          ['unclaimed', `空地(${counts.unclaimed})`],
          ['listed', `挂牌(${counts.listed})`],
          ['owned', `已占(${counts.owned + counts.listed})`],
          ['mine', `我方(${counts.mine})`],
          ['city', `城市(${counts.city})`],
        ] as Array<[StatusFilter, string]>).map(([k, lbl]) => (
          <button
            key={k}
            onClick={() => setFilter(k)}
            className={`pill-btn py-0 text-[10px] ${filter === k ? 'active' : ''}`}
          >
            {lbl}
          </button>
        ))}

        <div className="flex items-center gap-1 px-1.5 py-0.5 bg-[#161c24] border border-slate-700 rounded-sm flex-1 min-w-[110px]">
          <Search className="w-3 h-3 text-slate-400 shrink-0" />
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="搜 #slot / 地形 / 公司..."
            className="flex-1 min-w-0 bg-transparent outline-none text-[10.5px] text-slate-200 placeholder:text-slate-600"
          />
        </div>

        <select
          value={sortBy}
          onChange={(e) => setSortBy(e.target.value as SortMode)}
          className="bg-[#161c24] border border-slate-700 rounded-sm px-1.5 py-0.5 text-[10px] text-slate-200 outline-none"
        >
          <option value="slot">按编号 #slotId</option>
          <option value="mine_smelter">矿冶加成 ↓</option>
          <option value="power_water_station">能水加成 ↓</option>
          <option value="bio_greenhouse">农业加成 ↓</option>
          <option value="capacity">槽位数 ↓</option>
          <option value="price">价格 ↑</option>
        </select>
      </div>

      {/* Main Split: Clean Tile List + Structured Detail Inspector */}
      <div className="flex-1 min-h-0 flex flex-col overflow-hidden">
        {loading && tiles.length === 0 ? (
          <div className="p-4 text-[11px] text-slate-400">正在加载星表地块数据...</div>
        ) : err ? (
          <div className="p-4 text-[11px] text-rose-400">加载地块失败：{err}</div>
        ) : (
          <div className="flex-1 min-h-0 overflow-y-auto overscroll-contain divide-y divide-slate-800/80 text-[10.5px]">
            {filtered.map((t) => {
              const st = statusLabel(t);
              const isSel = selectedTile?.slot_id === t.slot_id;
              const mineM = t.building_mods.mine_smelter ?? 1.0;
              const pwM = t.building_mods.power_water_station ?? 1.0;
              const bioM = t.building_mods.bio_greenhouse ?? 1.0;
              const isDeveloped = t.status === 'owned' || t.status === 'listed';
              return (
                <div
                  key={t.slot_id}
                  onClick={() => {
                    setSelectedSlotId(t.slot_id);
                    setParams({ planetId: activePlanetId, slotId: t.slot_id });
                  }}
                  className={`px-2.5 py-1.5 touch-row flex items-center gap-2 cursor-pointer transition-colors ${
                    isSel ? 'bg-sky-500/15' : 'hover:bg-slate-800/50'
                  }`}
                >
                  <span className="mono text-sky-300 w-9 shrink-0">#{t.slot_id}</span>
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-1.5 flex-wrap">
                      <span className={`px-1 py-[0.5px] text-[9px] border rounded-[2px] ${st.cls}`}>
                        {st.text}
                      </span>
                      <span className="text-slate-100 font-medium truncate">
                        {t.city_name ? `${t.city_name} · ` : ''}{t.terrain_name}
                      </span>
                      <span className="mono text-[9.5px] text-slate-500">
                        ({t.lat.toFixed(0)}°, {t.lon.toFixed(0)}°)
                      </span>
                      {isDeveloped && t.owner_name && (
                        <span className="text-[9.5px] text-sky-300/90 truncate max-w-[160px]">
                          · {t.owner_name}
                        </span>
                      )}
                    </div>
                    {!t.is_city && (
                      <div className="flex items-center gap-2.5 text-[9.5px] mono text-slate-400 mt-0.5 flex-wrap">
                        <span>矿 <b className={modColor(mineM)}>{mineM.toFixed(2)}x</b></span>
                        <span>能 <b className={modColor(pwM)}>{pwM.toFixed(2)}x</b></span>
                        <span>农 <b className={modColor(bioM)}>{bioM.toFixed(2)}x</b></span>
                      </div>
                    )}
                  </div>
                  {!t.is_city && (
                    <div className="text-right mono shrink-0">
                      {t.price !== null ? (
                        <div className="text-emerald-300">{t.price.toFixed(1)}</div>
                      ) : (
                        <div className="text-slate-600">--</div>
                      )}
                      {t.listing_id !== null && (
                        <div className="text-[9px] text-emerald-400/80">L#{t.listing_id}</div>
                      )}
                    </div>
                  )}
                </div>
              );
            })}
            {filtered.length === 0 && (
              <div className="p-4 text-center text-slate-500">没有符合筛选条件的地块</div>
            )}
          </div>
        )}

        {/* Structured Selected Tile Detail Inspector */}
        {selectedTile && selectedStatus && (
          <div className="border-t border-sky-500/25 bg-[#151a22] shrink-0 text-[10.5px]">
            <div className="px-2.5 py-1 bg-[#1e2530] border-b border-slate-800 flex items-center justify-between gap-2">
              <div className="flex items-center gap-2 mono">
                <b className="text-sky-300">地块详情 #{selectedTile.slot_id}</b>
                <span className={`px-1 py-[0.5px] text-[9px] border rounded-[2px] ${selectedStatus.cls}`}>
                  {selectedStatus.text}
                </span>
                <span className="text-slate-200">{selectedTile.city_name ?? selectedTile.terrain_name}</span>
              </div>
              <span className="mono text-[9.5px] text-slate-400">
                坐标 ({selectedTile.lat.toFixed(1)}°, {selectedTile.lon.toFixed(1)}°)
              </span>
            </div>

            <div className="divide-y divide-slate-800/80">
              <div className="flex">
                <div className="w-[26%] min-w-[74px] bg-[#244465]/55 px-2 py-[3px] text-slate-300 border-r border-slate-800 shrink-0">
                  编号 / 归属
                </div>
                <div className="flex-1 min-w-0 px-2 py-[3px] text-right mono text-slate-200 truncate">
                  slotId <b className="text-sky-300">{selectedTile.slot_id}</b>
                  {selectedTile.plot_id !== null && (
                    <span className="text-slate-400"> · Plot #{selectedTile.plot_id}</span>
                  )}
                  {selectedTile.listing_id !== null && (
                    <span className="text-emerald-300"> · listingId {selectedTile.listing_id}</span>
                  )}
                  <span className="text-slate-500 mx-1.5">·</span>
                  <span>
                    {selectedTile.is_city ? (
                      selectedTile.city_name ?? '城市区'
                    ) : selectedTile.owner_id ? (
                      <button
                        type="button"
                        onClick={() => openTemp('company', { companyId: selectedTile.owner_id! })}
                        className="text-sky-300 hover:text-sky-200 underline decoration-sky-500/40 underline-offset-2"
                        title="点击查看公司公开详情"
                      >
                        {selectedTile.owner_name ?? selectedTile.owner_id}
                      </button>
                    ) : selectedTile.status === 'listed' ? (
                      '银行/挂牌待售'
                    ) : (
                      '公有未开发'
                    )}
                  </span>
                </div>
              </div>

              {selectedTile.is_city ? (
                <div className="flex">
                  <div className="w-[26%] min-w-[74px] bg-[#244465]/55 px-2 py-[3px] text-slate-300 border-r border-slate-800 shrink-0">
                    规划性质
                  </div>
                  <div className="flex-1 min-w-0 px-2 py-[3px] text-right text-amber-200/90 truncate">
                    原生城市规划区（非工业用地，不可购买或建造设施）
                  </div>
                </div>
              ) : (
                <>
                  <div className="flex">
                    <div className="w-[26%] min-w-[74px] bg-[#244465]/55 px-2 py-[3px] text-slate-300 border-r border-slate-800 shrink-0">
                      槽位 / 价格
                    </div>
                    <div className="flex-1 min-w-0 px-2 py-[3px] text-right mono text-slate-200 truncate">
                      <span>
                        已用 <b className="text-sky-300">{selectedTile.used_slots}</b> / {selectedTile.capacity} 槽
                      </span>
                      <span className="text-slate-500 mx-1.5">·</span>
                      <span>
                        {selectedTile.price !== null ? (
                          <>
                            {selectedTile.status === 'listed' ? '挂牌价' : '一手地价'}{' '}
                            <b className="text-emerald-300">{selectedTile.price.toFixed(1)}</b>
                          </>
                        ) : (
                          <span className="text-slate-500">非挂牌状态</span>
                        )}
                      </span>
                    </div>
                  </div>

                  <div className="flex items-stretch">
                    <div className="w-[26%] min-w-[74px] bg-[#244465]/55 px-2 py-[3px] text-slate-300 border-r border-slate-800 flex items-center shrink-0">
                      已有建筑
                    </div>
                    <div className="flex-1 min-w-0 px-2 py-[3px] text-right text-slate-200">
                      {selectedTile.buildings.length > 0 ? (
                        <span className="mono text-sky-200">
                          {selectedTile.buildings.map((b) => catalog.buildingName(b)).join(' · ')}
                        </span>
                      ) : (
                        <span className="text-slate-500">暂无建筑</span>
                      )}
                    </div>
                  </div>

                  <div className="flex items-stretch">
                    <div className="w-[26%] min-w-[74px] bg-[#244465]/55 px-2 py-[3px] text-slate-300 border-r border-slate-800 flex items-center shrink-0">
                      设施倍率
                    </div>
                    <div className="flex-1 min-w-0 px-2 py-[3px] text-right mono flex flex-wrap justify-end gap-x-2.5 gap-y-0.5">
                      {selectedMods.map(([bid, m]) => (
                        <span key={bid} className="text-slate-400">
                          {catalog.buildingName(bid)}{' '}
                          <b className={modColor(m)}>{m.toFixed(2)}x</b>
                        </span>
                      ))}
                    </div>
                  </div>

                  {!READ_ONLY_OBSERVATION_MODE && (
                    <div className="px-2.5 py-1.5 bg-[#1a2029] flex items-center justify-between gap-2 flex-wrap">
                      <span className="text-[10px] mono text-slate-400">
                        可用现金 <b className="text-emerald-300">{cash.toFixed(1)} Cr</b>
                        {selectedTile.price !== null && cash < selectedTile.price && (selectedTile.status === 'unclaimed' || (selectedTile.status === 'listed' && !selectedTile.is_mine)) && (
                          <span className="ml-2 text-amber-300">· 可用现金不足</span>
                        )}
                      </span>
                      <div className="flex items-center gap-1.5">
                        {selectedTile.status === 'unclaimed' && (
                          <button
                            type="button"
                            disabled={selectedTile.price !== null && cash < selectedTile.price}
                            onClick={() =>
                              void sendIntent({
                                BuyPlot: {
                                  planet_id: activePlanetId,
                                  slot_id: selectedTile.slot_id,
                                  listing_id: null,
                                },
                              })
                            }
                            title={
                              selectedTile.price !== null && cash < selectedTile.price
                                ? '可用现金不足'
                                : '购买该一手未开发工业用地'
                            }
                            className="cta-green py-0.5 px-2.5 text-[10.5px] disabled:opacity-40"
                          >
                            购买一手空地
                            {selectedTile.price !== null ? ` (${selectedTile.price.toFixed(1)} Cr)` : ''}
                          </button>
                        )}
                        {selectedTile.status === 'listed' &&
                          !selectedTile.is_mine &&
                          selectedTile.listing_id !== null && (
                            <button
                              type="button"
                              disabled={selectedTile.price !== null && cash < selectedTile.price}
                              onClick={() =>
                                void sendIntent({
                                  BuyPlot: {
                                    planet_id: activePlanetId,
                                    slot_id: null,
                                    listing_id: selectedTile.listing_id,
                                  },
                                })
                              }
                              title={
                                selectedTile.price !== null && cash < selectedTile.price
                                  ? '可用现金不足'
                                  : '购买该二手挂牌工业用地'
                              }
                              className="cta-blue py-0.5 px-2.5 text-[10.5px] disabled:opacity-40"
                            >
                              购买挂牌地块
                              {selectedTile.price !== null ? ` (${selectedTile.price.toFixed(1)} Cr)` : ''}
                            </button>
                          )}
                        {selectedTile.is_mine && (
                          <button
                            type="button"
                            onClick={() => openTemp('factory', { planetId: activePlanetId })}
                            className="pill-btn py-0.5 px-2 text-[10.5px] text-sky-300 border-sky-500/40"
                          >
                            在工厂管理打开
                          </button>
                        )}
                      </div>
                    </div>
                  )}
                </>
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  );
};

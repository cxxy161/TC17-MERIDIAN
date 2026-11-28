import React, { useEffect, useMemo, useState } from 'react';
import type { PaneProps } from '../layout/paneRegistry';
import { api } from '../api/client';
import { useCatalogIndex, useWorldIndex } from '../entities/hooks';
import { useGameStore } from '../store/useGameStore';
import { SearchSelect, type PickerFacet, type PickerOption } from '../components/SearchSelect';
import type { PublicCompanyDetail } from '../types/meridian';

export const CompanyPanel: React.FC<PaneProps> = ({ params, setParams, openTemp }) => {
  const state = useGameStore((s) => s.state);
  const world = useWorldIndex();
  const catalog = useCatalogIndex();
  const tick = state?.tick ?? 0;
  const leaderboard = state?.leaderboard ?? [];
  const selfId = state?.player_snapshot?.company.id;

  const activeCompanyId = params.companyId || selfId || leaderboard[0]?.id || '';
  const [detail, setDetail] = useState<PublicCompanyDetail | null>(null);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    if (!activeCompanyId) return;
    let cancelled = false;
    setLoading((prev) => prev || !detail || detail.id !== activeCompanyId);
    api
      .getCompanyDetail(activeCompanyId)
      .then((resp) => {
        if (cancelled) return;
        setDetail(resp);
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
  }, [activeCompanyId, tick]);

  const companyOptions = useMemo<PickerOption[]>(
    () =>
      leaderboard.map((c, idx) => ({
        id: c.id,
        label: c.name,
        sub: `#${idx + 1} · ${world.planetName(c.home_planet_id)} · 净流动 ${c.net_liquid.toLocaleString(undefined, { maximumFractionDigits: 1 })} · 地块 ${c.plots_count ?? 0} · 飞船 ${c.ships_count ?? 0} · 挂单 ${c.open_orders_count ?? 0}`,
        keywords: `${c.id} ${c.name} ${c.home_planet_id} ${world.planetName(c.home_planet_id)} ${c.is_player ? '玩家 player' : 'npc'}`,
        badge: c.is_player ? '玩家' : 'NPC',
        facets: { kind: c.is_player ? 'player' : 'npc' },
      })),
    [leaderboard, world],
  );

  const facets = useMemo<PickerFacet[]>(() => {
    let players = 0;
    let npcs = 0;
    for (const c of leaderboard) {
      if (c.is_player) players += 1;
      else npcs += 1;
    }
    return [
      {
        key: 'kind',
        label: '身份',
        values: [
          { id: 'player', label: '玩家公司', count: players },
          { id: 'npc', label: 'NPC 公司', count: npcs },
        ],
      },
    ];
  }, [leaderboard]);

  const buildingEntries = useMemo(
    () =>
      Object.entries(detail?.building_counts ?? {}).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])),
    [detail?.building_counts],
  );

  return (
    <div className="h-full flex flex-col bg-[#1b212b] text-slate-200 overflow-hidden">
      {/* Top Search Bar */}
      <div className="px-2.5 py-1.5 border-b border-sky-500/15 bg-[#202732] flex items-center justify-between gap-2 shrink-0">
        <div className="flex items-center gap-2 min-w-0 flex-1">
          <div className="w-72 max-w-full">
            <SearchSelect
              options={companyOptions}
              facets={facets}
              value={activeCompanyId}
              onChange={(cid) => setParams({ companyId: cid })}
              placeholder="搜索公司名称 / ID / 母星…"
              emptyLabel="选择或搜索公司"
            />
          </div>
          {detail && (
            <div className="flex items-center gap-1.5 text-[10.5px] min-w-0 truncate">
              <span
                className={`px-1.5 py-0.5 text-[9.5px] border rounded-[2px] shrink-0 ${
                  detail.is_player
                    ? 'bg-emerald-500/20 text-emerald-300 border-emerald-500/35'
                    : 'bg-slate-700/60 text-slate-300 border-slate-600/70'
                }`}
              >
                {detail.is_player ? '玩家' : 'NPC'}
              </span>
              <span className="mono text-slate-400 truncate">{detail.id}</span>
            </div>
          )}
        </div>
        <span className="text-[10px] text-slate-400 shrink-0">仅公开商业情报</span>
      </div>

      {err && <div className="px-3 py-1.5 bg-rose-500/15 text-rose-300 text-[11px] shrink-0">加载失败：{err}</div>}
      {loading && !detail && (
        <div className="flex-1 flex items-center justify-center text-slate-500 text-xs">正在加载公司公开情报…</div>
      )}

      {detail && (
        <div className="flex-1 min-h-0 overflow-y-auto divide-y divide-slate-800/80">
          {/* Public Overview KV Table */}
          <div className="bg-[#151a22] text-[11px] divide-y divide-slate-800/80">
            <div className="flex">
              <div className="w-[28%] min-w-[92px] bg-[#244465]/55 px-2.5 py-1 text-slate-300 border-r border-slate-800 shrink-0">
                公司 / 母星
              </div>
              <div className="flex-1 min-w-0 px-2.5 py-1 text-right flex items-center justify-end gap-2 truncate">
                <b className="text-slate-100 truncate">{detail.name}</b>
                <span className="text-slate-500">·</span>
                <button
                  type="button"
                  onClick={() => openTemp('planet', { planetId: detail.home_planet_id })}
                  className="text-sky-300 hover:text-sky-200 underline decoration-sky-500/40 underline-offset-2 shrink-0"
                >
                  {world.planetName(detail.home_planet_id)} ({detail.home_planet_id})
                </button>
              </div>
            </div>

            <div className="flex">
              <div className="w-[28%] min-w-[92px] bg-[#244465]/55 px-2.5 py-1 text-slate-300 border-r border-slate-800 shrink-0">
                公开净流动资产
              </div>
              <div className="flex-1 min-w-0 px-2.5 py-1 text-right mono font-semibold text-sky-300">
                {detail.net_liquid.toLocaleString(undefined, { maximumFractionDigits: 1 })}
              </div>
            </div>

            <div className="flex">
              <div className="w-[28%] min-w-[92px] bg-[#244465]/55 px-2.5 py-1 text-slate-300 border-r border-slate-800 shrink-0">
                公开资产规模
              </div>
              <div className="flex-1 min-w-0 px-2.5 py-1 text-right mono text-slate-200 truncate">
                地块 <b className="text-sky-300">{detail.plots_count}</b>
                <span className="text-slate-500 mx-1.5">·</span>
                建筑 <b className="text-sky-300">{detail.buildings_count}</b>
                <span className="text-slate-500 mx-1.5">·</span>
                飞船 <b className="text-sky-300">{detail.ships_count}</b>
                <span className="text-slate-500 mx-1.5">·</span>
                挂单 <b className="text-amber-300">{detail.open_orders_count}</b>
              </div>
            </div>

            <div className="flex">
              <div className="w-[28%] min-w-[92px] bg-[#244465]/55 px-2.5 py-1 text-slate-300 border-r border-slate-800 shrink-0">
                舰队构成
              </div>
              <div className="flex-1 min-w-0 px-2.5 py-1 text-right mono text-slate-300 truncate">
                {detail.ships_count > 0 ? (
                  <>
                    小型 <b className="text-slate-100">{detail.ships_by_size.small}</b>
                    <span className="text-slate-500 mx-1.5">·</span>
                    中型 <b className="text-slate-100">{detail.ships_by_size.medium}</b>
                    <span className="text-slate-500 mx-1.5">·</span>
                    大型 <b className="text-slate-100">{detail.ships_by_size.large}</b>
                  </>
                ) : (
                  <span className="text-slate-500">暂无登记飞船</span>
                )}
              </div>
            </div>
          </div>

          {/* Building Type Summary */}
          <div className="px-2.5 py-2 bg-[#1c222c]">
            <div className="text-[10px] text-slate-400 mb-1.5 flex items-center justify-between">
              <span>已建设施分布（共 {detail.buildings_count} 座）</span>
              <span className="text-slate-500">不含配方与工况隐私</span>
            </div>
            {buildingEntries.length > 0 ? (
              <div className="flex flex-wrap gap-1.5">
                {buildingEntries.map(([btype, count]) => (
                  <span
                    key={btype}
                    className="px-1.5 py-0.5 text-[10.5px] mono bg-[#232b37] border border-slate-700/70 rounded-[2px] text-slate-200"
                  >
                    {catalog.buildingName(btype)} <b className="text-sky-300">×{count}</b>
                  </span>
                ))}
              </div>
            ) : (
              <div className="text-[10.5px] text-slate-500">暂无已建设施</div>
            )}
          </div>

          {/* Owned Plots List */}
          <div>
            <div className="px-2.5 py-1.5 bg-[#202732] border-b border-slate-800 flex items-center justify-between text-[10.5px]">
              <span className="font-medium text-slate-300">名下地块（{detail.plots.length} 块）</span>
              <span className="text-[10px] text-slate-500">点击条目定位到对应行星地块</span>
            </div>
            {detail.plots.length === 0 ? (
              <div className="px-3 py-3 text-[11px] text-slate-500">名下暂无地块</div>
            ) : (
              <table className="w-full text-[10.5px] mono text-left">
                <thead className="bg-[#1e2530] text-slate-500 text-[9.5px]">
                  <tr>
                    <th className="px-2.5 py-1 font-normal">行星 / slotId</th>
                    <th className="px-2 py-1 font-normal">地形与坐标</th>
                    <th className="px-2 py-1 font-normal text-right">槽位</th>
                    <th className="px-2.5 py-1 font-normal">设施</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-800/60">
                  {detail.plots.map((p) => (
                    <tr
                      key={`${p.planet_id}-${p.slot_id}`}
                      onClick={() => openTemp('land', { planetId: p.planet_id, slotId: p.slot_id })}
                      className="cursor-pointer hover:bg-sky-500/10"
                    >
                      <td className="px-2.5 py-1 font-sans">
                        <span className="text-sky-300">{world.planetName(p.planet_id)}</span>
                        <span className="mono text-slate-400 ml-1">#{p.slot_id}</span>
                        {p.status === 'listed' && p.price !== null && (
                          <span className="ml-1.5 px-1 text-[9px] bg-emerald-500/20 text-emerald-300 border border-emerald-500/35 rounded-[2px]">
                            挂牌 {p.price.toFixed(0)}
                          </span>
                        )}
                      </td>
                      <td className="px-2 py-1 text-slate-400 font-sans">
                        {p.terrain_name}{' '}
                        <span className="mono text-[9.5px] text-slate-500">
                          ({p.lat.toFixed(0)}°, {p.lon.toFixed(0)}°)
                        </span>
                      </td>
                      <td className="px-2 py-1 text-right text-slate-300">
                        {p.used_slots}/{p.capacity}
                      </td>
                      <td className="px-2.5 py-1 font-sans text-slate-300 truncate max-w-[180px]">
                        {p.buildings.length > 0
                          ? p.buildings.map((b) => catalog.buildingName(b)).join(' · ')
                          : '空地'}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>

          {/* Public Open Market Orders */}
          <div>
            <div className="px-2.5 py-1.5 bg-[#202732] border-b border-slate-800 flex items-center justify-between text-[10.5px]">
              <span className="font-medium text-slate-300">公开挂单（{detail.open_orders.length} 笔）</span>
              <span className="text-[10px] text-slate-500">点击跳转盘口</span>
            </div>
            {detail.open_orders.length === 0 ? (
              <div className="px-3 py-3 text-[11px] text-slate-500">当前无公开活跃挂单</div>
            ) : (
              <table className="w-full text-[10.5px] mono text-left">
                <thead className="bg-[#1e2530] text-slate-500 text-[9.5px]">
                  <tr>
                    <th className="px-2.5 py-1 font-normal">空间站</th>
                    <th className="px-2 py-1 font-normal">方向</th>
                    <th className="px-2 py-1 font-normal">物品</th>
                    <th className="px-2 py-1 font-normal text-right">价格</th>
                    <th className="px-2.5 py-1 font-normal text-right">余量 / 总量</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-800/60">
                  {detail.open_orders.map((o) => (
                    <tr
                      key={o.order_id}
                      onClick={() =>
                        openTemp('orderbook', { stationId: o.station_id, itemId: o.item_id })
                      }
                      className="cursor-pointer hover:bg-sky-500/10"
                    >
                      <td className="px-2.5 py-1 font-sans text-slate-300">
                        {world.stationLabel(o.station_id)}
                      </td>
                      <td className="px-2 py-1">
                        <span
                          className={`px-1 py-0 text-[9px] border rounded-[2px] ${
                            o.side === 'buy'
                              ? 'bg-emerald-500/15 text-emerald-300 border-emerald-500/35'
                              : 'bg-rose-500/15 text-rose-300 border-rose-500/35'
                          }`}
                        >
                          {o.side === 'buy' ? '买单' : '卖单'}
                        </span>
                      </td>
                      <td className="px-2 py-1 font-sans text-sky-300">
                        {catalog.itemName(o.item_id)}
                      </td>
                      <td className="px-2 py-1 text-right text-slate-200">{o.price.toFixed(2)}</td>
                      <td className="px-2.5 py-1 text-right text-slate-300">
                        {o.qty} / {o.total_qty}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        </div>
      )}
    </div>
  );
};

import React, { useEffect, useMemo, useState } from 'react';
import { Search } from 'lucide-react';
import type { ShipView } from '../types/meridian';
import { READ_ONLY_OBSERVATION_MODE } from '../types/meridian';
import type { PaneProps } from '../layout/paneRegistry';
import { useGameStore } from '../store/useGameStore';
import { useCatalogIndex, useWorldIndex } from '../entities/hooks';
import { SearchSelect, type PickerOption } from '../components/SearchSelect';
import { VirtualList } from '../components/VirtualList';

const SHIP_SIZE_NAMES: Record<string, string> = {
  small: '小型货船',
  medium: '中型货船',
  large: '大型货船',
};

/**
 * Repair item cost per hull size. Mirrors `ShipSize::repair_cost` in
 * backend/crates/meridian-core/src/logistics.rs so the button can be disabled up-front instead of
 * letting the intent be rejected silently two ticks later.
 */
const REPAIR_UNITS: Record<ShipView['size'], number> = {
  small: 1,
  medium: 2,
  large: 4,
};

const SHIP_ROW_HEIGHT = 58;

const shipLabel = (ship: ShipView): string => `${SHIP_SIZE_NAMES[ship.size] ?? ship.size}-${ship.id}`;

function computeShipRouteSpec(
  from: string,
  to: string,
  ship: ShipView,
  baseSpec: [number, number],
  planets?: Record<string, { gravity: number }>,
): [number, number] {
  const [baseTicks, baseFuel] = baseSpec;
  const pid =
    to.startsWith('ST:') && from === to.slice(3)
      ? from
      : from.startsWith('ST:') && to === from.slice(3)
        ? to
        : null;
  let ticks = baseTicks;
  let fuel = baseFuel;
  if (pid && planets?.[pid]) {
    const scale = ship.size === 'large' ? 4 : ship.size === 'medium' ? 2 : 1;
    const g = planets[pid].gravity;
    ticks = Math.max(1, Math.round(scale * (0.6 + g * 0.7)));
    fuel = Math.max(1, Math.round(scale * (0.6 + g * 0.8)));
  }
  if (ship.durability <= 0) {
    ticks *= 2;
  }
  return [ticks, fuel];
}

interface StockRow {
  id: string;
  /** How many units of this item sit at the ship's current location. */
  have: number;
  /** Units the ship can actually take (stock minus the route's own fuel draw, capped by capacity). */
  max: number;
  /** Clamped, controlled draft quantity. */
  qty: number;
}

export const FleetPanel: React.FC<PaneProps> = ({ openTemp }) => {
  const state = useGameStore((s) => s.state);
  const sendIntent = useGameStore((s) => s.sendIntent);
  const catalog = useCatalogIndex();
  const world = useWorldIndex();

  const ships = world.ships;
  const routes = state?.player_snapshot?.routes ?? {};

  /**
   * Ship choice is view state, not pane identity: PaneParams has no shipId and the fleet pane's
   * identity is the company's whole fleet. `null` means "nothing picked yet" (show the first
   * hull); an id that no longer exists surfaces an explicit warning instead of silently swapping
   * in another ship's data.
   */
  const [selectedShipId, setSelectedShipId] = useState<number | null>(null);
  const [shipQuery, setShipQuery] = useState('');
  /** Destination is a per-dispatch choice too; it is revalidated against the live route table. */
  const [destId, setDestId] = useState<string | null>(null);
  const [cargoQuery, setCargoQuery] = useState('');
  const [cargoDraft, setCargoDraft] = useState<Record<string, number>>({});

  const activeShip = useMemo<ShipView | null>(() => {
    if (selectedShipId !== null) return ships.find((s) => s.id === selectedShipId) ?? null;
    return ships[0] ?? null;
  }, [ships, selectedShipId]);

  const selectionLost = selectedShipId !== null && activeShip === null;
  const capacity = activeShip?.capacity ?? 0;
  const durability = activeShip?.durability ?? 0;

  /** Fuel / repair items are identified by the same tags the backend uses, never by a hardcoded id. */
  const fuelItemId = useMemo(
    () => catalog.items.find((it) => (it.tags ?? []).includes('fuel'))?.id ?? null,
    [catalog],
  );
  const repairItemId = useMemo(
    () => catalog.items.find((it) => (it.tags ?? []).includes('repair'))?.id ?? null,
    [catalog],
  );

  const destOptions = useMemo<PickerOption[]>(() => {
    if (!activeShip) return [];
    const table = routes[activeShip.location] ?? {};
    const planetMap = state?.player_snapshot?.planets;
    const opts: PickerOption[] = Object.entries(table).map(([dest, baseSpec]) => {
      const [ticks, fuel] = computeShipRouteSpec(
        activeShip.location,
        dest,
        activeShip,
        baseSpec,
        planetMap,
      );
      const known = world.locationExists(dest);
      return {
        id: dest,
        label: known ? world.locationLabel(dest) : `未知地点（${dest}）`,
        sub: known ? `耗时 ${ticks} 回合 · 油耗 ${fuel}` : '航线表引用了未知地点',
        keywords: dest,
        disabled: !known,
      };
    });
    opts.sort((a, b) => a.label.localeCompare(b.label, 'zh-Hans-CN'));
    return opts;
  }, [activeShip, routes, state?.player_snapshot?.planets, world]);

  /**
   * No hardcoded default destination: the previous implementation started at `ST:P1` forever.
   * The first legal route of the selected ship is the fallback, and an explicit pick is kept only
   * while it is still reachable from that ship's current location.
   */
  const usableDests = useMemo(() => destOptions.filter((o) => !o.disabled), [destOptions]);

  const effectiveDest = useMemo(() => {
    if (destId && usableDests.some((o) => o.id === destId)) return destId;
    return usableDests[0]?.id ?? '';
  }, [usableDests, destId]);

  const baseRouteSpec =
    activeShip && effectiveDest ? routes[activeShip.location]?.[effectiveDest] : undefined;
  const routeSpec = useMemo<[number, number] | undefined>(() => {
    if (!activeShip || !effectiveDest || !baseRouteSpec) return undefined;
    return computeShipRouteSpec(
      activeShip.location,
      effectiveDest,
      activeShip,
      baseRouteSpec,
      state?.player_snapshot?.planets,
    );
  }, [activeShip, effectiveDest, baseRouteSpec, state?.player_snapshot?.planets]);
  const routeFuel = routeSpec?.[1] ?? 0;

  /** Sparse read: only items that actually exist at the ship's location, straight from worldIndex. */
  const sourceInv = useMemo(() => {
    if (!activeShip) return [] as Array<{ id: string; have: number; name: string }>;
    const loc = activeShip.location;
    const rows: Array<{ id: string; have: number; name: string }> = [];
    for (const [itemId, holding] of world.holdings) {
      const slice = holding.byLocation.find((s) => s.location === loc);
      if (slice && slice.qty > 0) rows.push({ id: itemId, have: slice.qty, name: catalog.itemName(itemId) });
    }
    rows.sort((a, b) => a.name.localeCompare(b.name, 'zh-Hans-CN'));
    return rows;
  }, [activeShip, world.holdings, catalog]);

  const instantRows = useMemo(
    () => sourceInv.filter((s) => catalog.isInstant(s.id)),
    [sourceInv, catalog],
  );

  /**
   * Every shippable item at the current location, with the draft quantity clamped to what the hull
   * could actually load. The fuel item's usable stock is reduced by the route's own fuel draw: the
   * backend deducts `route.fuel` from the same store on top of any fuel loaded as cargo.
   */
  const cargoPlan = useMemo<StockRow[]>(() => {
    if (!activeShip) return [];
    const rows: StockRow[] = [];
    for (const s of sourceInv) {
      // Unknown ids can linger in a store after a pack swap; the backend rejects them, so they are
      // never offered as cargo (isShippable() would otherwise treat an unknown id as shippable).
      if (!catalog.item(s.id) || !catalog.isShippable(s.id)) continue;
      const fuelDraw = s.id === fuelItemId ? routeFuel : 0;
      const max = Math.min(Math.max(0, s.have - fuelDraw), capacity);
      if (max <= 0) continue;
      const raw = cargoDraft[s.id] ?? 0;
      const qty = Number.isFinite(raw) ? Math.min(Math.max(0, Math.floor(raw)), max) : 0;
      rows.push({ id: s.id, have: s.have, max, qty });
    }
    return rows;
  }, [activeShip, sourceInv, catalog, fuelItemId, routeFuel, capacity, cargoDraft]);

  const cargoRows = useMemo(() => {
    const q = cargoQuery.trim().toLowerCase();
    if (!q) return cargoPlan;
    return cargoPlan.filter((r) => {
      const def = catalog.item(r.id);
      return (
        catalog.itemName(r.id).toLowerCase().includes(q) ||
        r.id.toLowerCase().includes(q) ||
        (def?.tags ?? []).some((t) => t.toLowerCase().includes(q))
      );
    });
  }, [cargoPlan, cargoQuery, catalog]);

  const totalSelected = useMemo(() => cargoPlan.reduce((acc, r) => acc + r.qty, 0), [cargoPlan]);
  const selectedKinds = useMemo(() => cargoPlan.filter((r) => r.qty > 0).length, [cargoPlan]);

  const fuelHave = fuelItemId ? sourceInv.find((s) => s.id === fuelItemId)?.have ?? 0 : 0;
  const repairNeed = activeShip ? REPAIR_UNITS[activeShip.size] ?? 0 : 0;
  const repairHave = repairItemId ? sourceInv.find((s) => s.id === repairItemId)?.have ?? 0 : 0;

  const filteredShips = useMemo(() => {
    const q = shipQuery.trim().toLowerCase();
    if (!q) return ships;
    return ships.filter((s) => {
      const label = shipLabel(s).toLowerCase();
      const locLabel = world.locationLabel(s.location).toLowerCase();
      const status = s.is_busy ? '航行中' : '待命';
      return (
        label.includes(q) ||
        s.location.toLowerCase().includes(q) ||
        locLabel.includes(q) ||
        status.includes(q) ||
        (SHIP_SIZE_NAMES[s.size] ?? '').includes(q)
      );
    });
  }, [ships, shipQuery, world]);

  const [isNarrow, setIsNarrow] = useState<boolean>(() =>
    typeof window !== 'undefined' ? window.matchMedia('(max-width: 639px)').matches : false,
  );
  useEffect(() => {
    const mq = window.matchMedia('(max-width: 639px)');
    const sync = () => setIsNarrow(mq.matches);
    sync();
    mq.addEventListener('change', sync);
    return () => mq.removeEventListener('change', sync);
  }, []);

  /** Two hull cards per virtual row on sm+, one per row on narrow viewports to avoid card overlap. */
  const shipRows = useMemo(() => {
    const step = isNarrow ? 1 : 2;
    const rows: ShipView[][] = [];
    for (let i = 0; i < filteredShips.length; i += step) rows.push(filteredShips.slice(i, i + step));
    return rows;
  }, [filteredShips, isNarrow]);

  const dispatchIssue = useMemo<string | null>(() => {
    if (!activeShip) return '未选择飞船';
    if (activeShip.is_busy) return '飞船航行中，抵达后才能调度';
    if (usableDests.length === 0) return '当前位置没有可用航线';
    if (!effectiveDest) return '没有有效目的地';
    if (totalSelected > capacity) return `超出载重（${totalSelected}/${capacity}）`;
    if (!fuelItemId && routeFuel > 0) return '生产包未声明 fuel 标签物品，无法校验燃料储备';
    if (fuelHave < routeFuel) return `起点燃料不足：需 ${routeFuel}，现有 ${fuelHave}`;
    return null;
  }, [activeShip, usableDests.length, effectiveDest, totalSelected, capacity, fuelItemId, routeFuel, fuelHave]);

  const canRepair =
    !!activeShip &&
    !activeShip.is_busy &&
    durability < 99.9 &&
    repairNeed > 0 &&
    repairHave >= repairNeed;

  const repairHint = !activeShip
    ? ''
    : repairNeed <= 0
      ? '无法确定维修件消耗（未知船型）'
      : repairItemId === null
        ? '生产包未声明 repair 标签物品'
        : `起点维修件不足：需 ${repairNeed}，现有 ${repairHave}`;

  const handleDispatch = () => {
    if (dispatchIssue || !activeShip || !effectiveDest) return;
    const cargo = cargoPlan
      .filter((r) => r.qty > 0)
      .map((r): [string, number] => [r.id, r.qty]);
    void sendIntent({
      DispatchShip: {
        ship_id: activeShip.id,
        from: activeShip.location,
        to: effectiveDest,
        cargo,
      },
    });
    setCargoDraft({});
  };

  const handleRepair = () => {
    if (!activeShip || !canRepair) return;
    void sendIntent({ RepairShip: { ship_id: activeShip.id } });
  };

  const activeEta = activeShip && activeShip.is_busy ? Math.max(0, activeShip.busy_until - world.tick) : 0;
  const loadedUnits = activeShip
    ? Object.values(activeShip.cargo ?? {}).reduce((acc, q) => acc + (q || 0), 0)
    : 0;

  return (
    <div className="h-full flex flex-col bg-[#202732] text-slate-200 overflow-hidden">
      <div className="px-3 py-1.5 border-b border-sky-500/10 bg-[#232a36] flex items-center justify-between gap-2 text-[11px] shrink-0 flex-wrap">
        <span className="font-medium">
          旗下舰队（共 {ships.length} 艘 · 航行中 {world.busyShips}）
        </span>
        <span className="text-[10px] text-slate-400">支持一船多货物混装发运</span>
      </div>

      <div className="flex-1 min-h-0 flex flex-col p-3 gap-2.5">
        <div className="shrink-0 flex items-center gap-2 flex-wrap">
          <div className="flex items-center gap-1.5 px-2 py-0.5 bg-[#1b212b] border border-slate-700 rounded-sm flex-1 min-w-[140px]">
            <Search className="w-3 h-3 text-sky-400 shrink-0" />
            <input
              value={shipQuery}
              onChange={(e) => setShipQuery(e.target.value)}
              placeholder="搜索飞船编号 / 船型 / 位置 / 状态…"
              className="flex-1 min-w-0 bg-transparent outline-none text-[11px] text-slate-100 placeholder:text-slate-600"
            />
            <span className="text-[9px] mono text-slate-500 shrink-0">{filteredShips.length}</span>
          </div>
          {selectionLost && (
            <span className="text-[10px] text-rose-300">
              所选飞船已不在舰队中（可能已出售或损毁），请重新选择
            </span>
          )}
        </div>

        <VirtualList
          className="shrink-0 max-h-[208px] overflow-y-auto"
          count={shipRows.length}
          rowHeight={SHIP_ROW_HEIGHT}
          emptyState={
            <div className="metric-card py-4 text-center text-[11px] text-slate-500">
              {ships.length === 0 ? '舰队为空：先在船坞购入飞船' : '没有匹配的飞船'}
            </div>
          }
          renderRow={(idx) => (
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-2 h-full pr-1">
              {shipRows[idx].map((ship) => {
                const isSel = activeShip?.id === ship.id;
                const eta = ship.is_busy ? Math.max(0, ship.busy_until - world.tick) : 0;
                return (
                  <div
                    key={ship.id}
                    onClick={() => {
                      setSelectedShipId(ship.id);
                      setCargoDraft({});
                    }}
                    className={`metric-card h-[52px] flex flex-col justify-center gap-0.5 cursor-pointer ${
                      isSel ? 'border-sky-400/70 bg-sky-500/5' : 'hover:border-slate-600'
                    }`}
                  >
                    <div className="flex items-center justify-between gap-1">
                      <span className="font-semibold text-sky-300 truncate">{shipLabel(ship)}</span>
                      <span
                        className={`mono text-[10px] shrink-0 ${
                          ship.is_busy ? 'text-amber-300' : 'text-emerald-400'
                        }`}
                      >
                        {ship.is_busy ? `航行中 · 剩 ${eta} 回合` : '待命'}
                      </span>
                    </div>
                    <div className="flex justify-between gap-1 text-[11px] text-slate-400 mono">
                      <span className="truncate">{world.locationLabel(ship.location)}</span>
                      <span className="shrink-0">
                        耐久 {ship.durability.toFixed(0)}% · 载重 {ship.capacity}
                      </span>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        />

        <div className="flex-1 min-h-0 overflow-y-auto">
          {!activeShip ? (
            <div className="metric-card py-6 text-center text-[11px] text-slate-500">
              {ships.length === 0 ? '舰队为空：先在船坞购入飞船' : '选择上方任意飞船以查看货舱与调度'}
            </div>
          ) : READ_ONLY_OBSERVATION_MODE ? (
            <div className="border border-sky-500/20 bg-[#1b212b] p-3 rounded-sm space-y-2">
              <div className="flex items-center justify-between gap-2 text-[11px] pb-1.5 border-b border-slate-800">
                <span className="font-semibold text-slate-100">飞船详情 · {shipLabel(activeShip)}</span>
                <span className="mono text-[10px] text-sky-300">
                  {activeShip.is_busy ? `航行中 · 剩 ${activeEta} 回合 · 起点 ` : '待命 · 位于 '}
                  {world.locationLabel(activeShip.location)}
                </span>
              </div>
              <div className="flex flex-wrap gap-x-4 gap-y-1 text-[11px] mono text-slate-400">
                <span>
                  耐久{' '}
                  <strong className={durability < 30 ? 'text-rose-300' : 'text-slate-200'}>
                    {durability.toFixed(1)}%
                  </strong>
                </span>
                <span>
                  载重 <strong className="text-slate-200">{capacity}</strong>
                </span>
                <span>
                  货舱占用 <strong className="text-emerald-300">{loadedUnits}</strong>
                </span>
              </div>
              {Object.keys(activeShip.cargo ?? {}).length === 0 ? (
                <div className="text-[11px] text-slate-500">当前货舱空载</div>
              ) : (
                <div className="flex flex-wrap gap-1.5">
                  {Object.entries(activeShip.cargo).map(([itemId, qty]) => (
                    <button
                      key={itemId}
                      onClick={() => openTemp('item', { itemId })}
                      title="查看物品详情"
                      className="px-2 py-0.5 bg-[#252e3b] border border-slate-800 hover:border-sky-400/50 rounded-sm text-[10px] text-slate-300"
                    >
                      {catalog.itemName(itemId)}
                      <span className="mono text-emerald-400 ml-1">{qty}</span>
                    </button>
                  ))}
                </div>
              )}
              <div className="text-[10px] text-slate-500">
                纯代码观察模式：派船与修船请通过脚本 `ship.dispatch(...)` / `ship.repair()` 调用。
              </div>
            </div>
          ) : (
            <div className="border border-sky-500/20 bg-[#1b212b] p-3 rounded-sm space-y-2.5">
              <div className="flex items-center justify-between gap-2 text-[11px] pb-1.5 border-b border-slate-800">
                <span className="font-semibold text-slate-100">装货启航 · {shipLabel(activeShip)}</span>
                <span className="mono text-[10px] text-sky-300">
                  已装 {totalSelected} / {capacity}
                </span>
              </div>

              <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px]">
                <span className="text-slate-400">耐久</span>
                <strong className={durability < 30 ? 'text-rose-300' : 'text-slate-200'}>
                  {durability.toFixed(1)}%
                </strong>
                {!activeShip.is_busy && durability < 99.9 && (
                  <button
                    onClick={handleRepair}
                    disabled={!canRepair}
                    title={canRepair ? '消耗维修件将耐久恢复到 100%' : repairHint}
                    className="pill-btn py-0 text-[10px] text-emerald-300 disabled:opacity-40"
                  >
                    消耗维修件修复（需 {repairNeed || '?'}）
                  </button>
                )}
                {!activeShip.is_busy && durability < 99.9 && !canRepair && (
                  <span className="text-[10px] text-amber-300/80">{repairHint}</span>
                )}
              </div>

              {activeShip.is_busy ? (
                <div className="text-[11px] text-amber-300/90 py-2">
                  飞船正在航行（剩余 {activeEta} 回合），抵达目的地卸货后方可再次调度。
                </div>
              ) : (
                <>
                  <div className="flex flex-wrap items-center gap-2 text-[11px]">
                    <span className="text-slate-400">起点</span>
                    <span className="text-slate-200">{world.locationLabel(activeShip.location)}</span>
                    <span className="text-slate-500">→ 终点</span>
                    <SearchSelect
                      options={destOptions}
                      value={effectiveDest || null}
                      onChange={setDestId}
                      placeholder="搜索目的地…"
                      emptyLabel={usableDests.length > 0 ? '选择目的地' : '无可用航线'}
                      disabled={usableDests.length === 0}
                    />
                    {routeSpec ? (
                      <span
                        className="mono text-[10px] text-emerald-400 ml-auto"
                        title="按当前飞船船型、起降重力与耐久计算"
                      >
                        耗时 {routeSpec[0]} 回合 · 油耗 {routeSpec[1]} 燃料
                      </span>
                    ) : (
                      <span className="text-[10px] text-rose-300 ml-auto">当前位置没有可用航线</span>
                    )}
                  </div>

                  <div className="flex flex-wrap items-center gap-2">
                    <div className="flex items-center gap-1.5 px-2 py-0.5 bg-[#1b212b] border border-slate-700 rounded-sm flex-1 min-w-[140px]">
                      <Search className="w-3 h-3 text-sky-400 shrink-0" />
                      <input
                        value={cargoQuery}
                        onChange={(e) => setCargoQuery(e.target.value)}
                        placeholder="搜索可装船货物（名称 / id / 标签）…"
                        className="flex-1 min-w-0 bg-transparent outline-none text-[11px] text-slate-100 placeholder:text-slate-600"
                      />
                      <span className="text-[9px] mono text-slate-500 shrink-0">
                        {cargoRows.length}/{cargoPlan.length}
                      </span>
                    </div>
                    <span className="text-[10px] text-slate-500">
                      {instantRows.length > 0
                        ? `另有 ${instantRows.length} 类瞬时货物（就地挂单/交割，不需要装船）`
                        : '起点的可装船货物均已列出'}
                    </span>
                  </div>

                  {cargoRows.length === 0 ? (
                    <div className="px-3 py-4 text-center text-[11px] text-slate-500 border border-slate-800/70 rounded-sm">
                      {cargoPlan.length === 0
                        ? '起点没有可装船货物（瞬时货物不可装船）'
                        : '没有匹配的可装船货物'}
                    </div>
                  ) : (
                    <div className="border border-slate-800/70 rounded-sm divide-y divide-slate-800/40">
                      {cargoRows.map((r) => {
                        const def = catalog.item(r.id);
                        const isFuel = r.id === fuelItemId;
                        return (
                          <div key={r.id} className="min-h-[34px] touch-row flex items-center gap-2 px-2 py-1 text-[11px]">
                            <button
                              onClick={() => openTemp('item', { itemId: r.id })}
                              title="查看物品详情"
                              className="flex-1 min-w-0 text-left truncate text-slate-200 hover:text-sky-300"
                            >
                              {catalog.itemName(r.id)}
                              <span className="mono text-[10px] text-slate-500 ml-1">({r.have})</span>
                              {isFuel && routeFuel > 0 && (
                                <span className="text-[9px] text-amber-300/80 ml-1">
                                  含航线油耗 -{routeFuel}
                                </span>
                              )}
                              {def && (
                                <span className="text-[9px] text-slate-600 ml-1">
                                  {catalog.roleLabel(def.role)}
                                </span>
                              )}
                            </button>
                            <span className="mono text-[10px] text-slate-500 shrink-0 w-14 text-right">
                              可装 {r.max}
                            </span>
                            <input
                              type="number"
                              inputMode="numeric"
                              min={0}
                              max={r.max}
                              value={r.qty}
                              onChange={(e) => {
                                const raw = Number(e.target.value);
                                const v = Number.isFinite(raw)
                                  ? Math.max(0, Math.min(r.max, Math.floor(raw)))
                                  : 0;
                                setCargoDraft((prev) => ({ ...prev, [r.id]: v }));
                              }}
                              className="w-16 shrink-0 bg-[#191f27] border border-slate-700 px-1.5 py-1 text-right mono rounded-sm"
                            />
                          </div>
                        );
                      })}
                    </div>
                  )}

                  <div className="sticky bottom-0 bg-[#1b212b]/95 backdrop-blur-sm flex flex-wrap items-center justify-between gap-2 pt-2 pb-1 border-t border-slate-800">
                    <div className="text-[10px] text-slate-500 mono">
                      已选 {selectedKinds} 类 / {totalSelected} 件
                      {cargoRows.length !== cargoPlan.length && '（搜索只过滤显示，已填数量保留）'}
                    </div>
                    <div className="flex items-center gap-2">
                      {dispatchIssue && (
                        <span className="text-[10px] text-amber-300/90">{dispatchIssue}</span>
                      )}
                      <button
                        disabled={!!dispatchIssue}
                        onClick={handleDispatch}
                        className="cta-green disabled:opacity-40"
                      >
                        {totalSelected > 0 ? '确认启航发运' : '空船启航'}
                      </button>
                    </div>
                  </div>
                </>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
};

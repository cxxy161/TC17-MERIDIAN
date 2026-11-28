import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  AlertTriangle,
  CheckCircle2,
  ChevronLeft,
  ChevronRight,
  Compass,
  Maximize2,
  Minimize2,
  Rocket,
  X,
  Zap,
} from 'lucide-react';
import { useGameStore } from '../store/useGameStore';
import { useCatalogIndex, useWorldIndex } from '../entities/hooks';
import type { PaneKind, PaneParams } from '../layout/paneRegistry';
import { FloatingWindowFrame } from '../layout/FloatingWindowFrame';
import { moneyToCredits } from '../types/meridian';

interface TutorialOverlayProps {
  activeWorkspaceId: string;
  zIndex?: number;
  onBringToFront?: () => void;
  onSwitchWorkspace: (wsId: string) => void;
  onOpenTemp: (kind: PaneKind, params?: PaneParams) => void;
}

interface ProfessionGuide {
  buildingId: string;
  recipeId: string;
  targetItemId: string;
  fallbackBuildingName: string;
  fallbackRecipeName: string;
  fallbackItemName: string;
  slotsText: string;
  recipeSummary: string;
  tip: string;
  supplyWarning: string;
}

const PROFESSION_GUIDES: Record<string, ProfessionGuide> = {
  env_recycle: {
    buildingId: 'power_water_station',
    recipeId: 'extract_water',
    targetItemId: 'water',
    fallbackBuildingName: '能源水站',
    fallbackRecipeName: '冰水冷凝提取',
    fallbackItemName: '净水',
    slotsText: '占 1 槽位 · 建造 6 回合 · 耗建材 ×6',
    recipeSummary: '0 原料消耗，每 2 回合耗电 2 → 产出 净水 ×10',
    tip: '能源水站待机 0 耗电；若地面电力吃紧，也可随时切为「光伏直发电力」零成本产电。',
    supplyWarning:
      '后续电解制氧、合成推进燃料都要持续消耗「净水」；做高效率合成燃料或生态回收处理，还会跨行吃农业的「生物纤维」与「城市废料」。',
  },
  agri_bio: {
    buildingId: 'bio_greenhouse',
    recipeId: 'grow_crop',
    targetItemId: 'bio_crop',
    fallbackBuildingName: '生态温室',
    fallbackRecipeName: '水培作物培育',
    fallbackItemName: '生物作物',
    slotsText: '占 1 槽位 · 建造 6 回合 · 耗建材 ×6',
    recipeSummary: '每 3 回合耗电 2 + 净水 4 → 产出 生物作物 ×8（开局地面已配 100 净水）',
    tip: '生态温室待机耗电 1，长期不用记得点「已待机」或换配方，避免白白漏电。',
    supplyWarning:
      '「水培作物培育」自身就吃「净水」；后续进军「生活消费工坊」做口粮、营养饮料与基础衣物，还会消耗大量净水、生物纤维以及重工的「金属钢材」「日用品」。',
  },
  mining_ind: {
    buildingId: 'mine_smelter',
    recipeId: 'mine_ore',
    targetItemId: 'ore',
    fallbackBuildingName: '矿业冶炼厂',
    fallbackRecipeName: '深井矿石开采',
    fallbackItemName: '基础矿石',
    slotsText: '占 1 槽位 · 建造 8 回合 · 耗建材 ×8',
    recipeSummary: '0 原料消耗，每 2 回合耗电 3 → 产出 基础矿石 ×10',
    tip: '矿业冶炼厂同时支持采矿与炼钢，后续可直接切配方不必重造。',
    supplyWarning:
      '后续高效「碳还原炼钢」需向农业买「生物纤维」（否则「纯电弧炉炼钢」单轮耗电高达 16）；再往下造结构建材、日用品与小货船，都需要持续消耗矿石与钢材。',
  },
};

const STEP_IDS = [
  'intro',
  'produce',
  'ship_orbit',
  'trade_orbit',
  'power_supply',
  'bank_land',
  'script_intro',
] as const;
type StepId = (typeof STEP_IDS)[number];

const DEFAULT_WIDTH = 460;
const DEFAULT_HEIGHT = 470;

function initialRect(): { x: number; y: number; w: number; h: number } {
  const w = Math.min(DEFAULT_WIDTH, Math.max(350, window.innerWidth - 32));
  const h = Math.min(DEFAULT_HEIGHT, Math.max(300, window.innerHeight - 64));
  return {
    x: Math.max(56, window.innerWidth - w - 16),
    y: Math.max(44, window.innerHeight - h - 16),
    w,
    h,
  };
}

export const TutorialOverlay: React.FC<TutorialOverlayProps> = ({
  activeWorkspaceId,
  zIndex = 60,
  onBringToFront,
  onSwitchWorkspace,
  onOpenTemp,
}) => {
  const tutorialOpen = useGameStore((s) => s.tutorialOpen);
  const tutorialStep = useGameStore((s) => s.tutorialStep);
  const tutorialTraded = useGameStore((s) => s.tutorialTraded);
  const state = useGameStore((s) => s.state);
  const closeTutorial = useGameStore((s) => s.closeTutorial);
  const setTutorialStep = useGameStore((s) => s.setTutorialStep);
  const setTutorialHighlight = useGameStore((s) => s.setTutorialHighlight);

  const catalog = useCatalogIndex();
  const world = useWorldIndex();

  const [rect, setRect] = useState<{ x: number; y: number; w: number; h: number }>(() =>
    initialRect(),
  );
  const [collapsed, setCollapsed] = useState(false);
  const [confirmClose, setConfirmClose] = useState(false);

  useEffect(() => {
    if (tutorialOpen) {
      setConfirmClose(false);
      setCollapsed(false);
    }
  }, [tutorialOpen]);

  const comp = state?.player_snapshot?.company;
  const profId = comp?.profession ?? 'mining_ind';
  const guide = PROFESSION_GUIDES[profId] ?? PROFESSION_GUIDES.mining_ind;
  const profName = catalog.professions.find((p) => p.id === profId)?.name ?? profId;

  const buildingName = catalog.building(guide.buildingId)?.name ?? guide.fallbackBuildingName;
  const recipeName = catalog.recipe(guide.recipeId)?.name ?? guide.fallbackRecipeName;
  const itemName = catalog.item(guide.targetItemId)?.name ?? guide.fallbackItemName;

  const homePid = comp?.home_planet_id ?? world.planets[0]?.id ?? 'P1';
  const homeName = world.planetName(homePid);
  const homeStationId = `ST:${homePid}`;

  const homeGround = state?.player_snapshot?.planets?.[homePid]?.ground_store ?? {};
  const curTargetQty = homeGround[guide.targetItemId] ?? 0;
  const groundPower = homeGround.power ?? 0;
  const groundFuel = homeGround.fuel ?? 0;
  const groundMat = homeGround.building_mat ?? 0;
  const orbitTargetQty = comp?.station_stores?.[homeStationId]?.[guide.targetItemId] ?? 0;

  const hasTargetBuilding = useMemo(
    () => (comp?.buildings ?? []).some((b) => b.building_type === guide.buildingId),
    [comp, guide.buildingId],
  );
  const targetSite = useMemo(
    () => (comp?.sites ?? []).find((s) => s.building_type === guide.buildingId) ?? null,
    [comp, guide.buildingId],
  );

  // Track real production: either ground qty grew while owning the recommended building, or a cycle wrapped
  const minQtyRef = useRef<number | null>(null);
  const prevProgressRef = useRef<Record<number, { progress: number; recipeId: string }>>({});
  const [producedDone, setProducedDone] = useState(false);

  useEffect(() => {
    minQtyRef.current = null;
    prevProgressRef.current = {};
    setProducedDone(false);
  }, [comp?.id, guide.buildingId, guide.targetItemId]);

  useEffect(() => {
    if (!comp) return;
    if (minQtyRef.current === null || curTargetQty < minQtyRef.current) {
      minQtyRef.current = curTargetQty;
    }

    let cycleWrapped = false;
    const nextMap: Record<number, { progress: number; recipeId: string }> = {};
    for (const b of comp.buildings) {
      if (b.building_type === guide.buildingId) {
        const prev = prevProgressRef.current[b.id];
        if (
          b.active &&
          prev &&
          prev.recipeId === b.recipe_id &&
          prev.progress > 0 &&
          b.progress < prev.progress
        ) {
          cycleWrapped = true;
        }
      }
      nextMap[b.id] = { progress: b.progress, recipeId: b.recipe_id };
    }
    prevProgressRef.current = nextMap;

    const grew = minQtyRef.current !== null && curTargetQty > minQtyRef.current;
    if (hasTargetBuilding && (grew || cycleWrapped)) {
      setProducedDone(true);
    }
  }, [comp, curTargetQty, guide.buildingId, hasTargetBuilding]);

  const shipInTransit = useMemo(() => (comp?.ships ?? []).some((s) => s.is_busy), [comp]);

  // Step 3 (ship_orbit) completes once cargo has landed on near-earth orbit or a ship has docked at ST:homePid
  const shipOrbitArrived = useMemo(() => {
    if (!comp) return false;
    if (orbitTargetQty > 0) return true;
    return comp.ships.some((s) => !s.is_busy && s.location === homeStationId);
  }, [comp, orbitTargetQty, homeStationId]);

  // Step 4 (trade_orbit) completes when an order is created / dealt or an open order exists
  const tradeDone = useMemo(
    () => tutorialTraded || (comp?.open_orders.length ?? 0) > 0,
    [tutorialTraded, comp],
  );

  const safeIdx = Math.max(0, Math.min(STEP_IDS.length - 1, tutorialStep));
  const stepId: StepId = STEP_IDS[safeIdx];

  const isStepDone = (idx: number): boolean => {
    const sid = STEP_IDS[idx];
    if (sid === 'produce') return producedDone;
    if (sid === 'ship_orbit') return shipOrbitArrived;
    if (sid === 'trade_orbit') return tradeDone;
    return false;
  };

  // Sync UI spotlight target
  const highlightTarget = useMemo(() => {
    if (stepId === 'intro') {
      return activeWorkspaceId === 'ws-overview' ? 'pane:planet' : 'ws:ws-overview';
    }
    if (stepId === 'produce') {
      return activeWorkspaceId === 'ws-overview' ? 'pane:factory' : 'ws:ws-overview';
    }
    if (stepId === 'ship_orbit') {
      return activeWorkspaceId === 'ws-overview' ? 'pane:fleet' : 'ws:ws-overview';
    }
    if (stepId === 'trade_orbit') {
      return activeWorkspaceId === 'ws-market' ? 'pane:orderbook' : 'ws:ws-market';
    }
    if (stepId === 'power_supply') {
      return activeWorkspaceId === 'ws-market' ? 'pane:orderbook' : 'rail:orderbook';
    }
    if (stepId === 'bank_land') {
      return 'rail:treasury';
    }
    return activeWorkspaceId === 'ws-script' ? 'pane:script' : 'ws:ws-script';
  }, [stepId, activeWorkspaceId]);

  useEffect(() => {
    if (!tutorialOpen) {
      setTutorialHighlight(null);
      return;
    }
    setTutorialHighlight(highlightTarget);
  }, [tutorialOpen, highlightTarget, setTutorialHighlight]);

  useEffect(() => {
    return () => setTutorialHighlight(null);
  }, [setTutorialHighlight]);

  // Auto-advance only when an auto-tracked step flips false -> true while user stays on it
  const currentStepAutoDone = isStepDone(safeIdx);
  const prevAutoRef = useRef<{ idx: number; done: boolean }>({
    idx: safeIdx,
    done: currentStepAutoDone,
  });
  useEffect(() => {
    if (!tutorialOpen) return;
    const prev = prevAutoRef.current;
    if (
      prev.idx === safeIdx &&
      !prev.done &&
      currentStepAutoDone &&
      safeIdx < STEP_IDS.length - 1
    ) {
      const timer = window.setTimeout(() => {
        setTutorialStep(safeIdx + 1);
      }, 700);
      prevAutoRef.current = { idx: safeIdx, done: currentStepAutoDone };
      return () => window.clearTimeout(timer);
    }
    prevAutoRef.current = { idx: safeIdx, done: currentStepAutoDone };
  }, [tutorialOpen, safeIdx, currentStepAutoDone, setTutorialStep]);

  if (!tutorialOpen) return null;

  const plotsCount = comp?.plots.length ?? 0;
  const totalSlots = (comp?.plots ?? []).reduce((acc, p) => acc + p.capacity, 0);
  const usedSlots = (comp?.plots ?? []).reduce((acc, p) => acc + p.used_slots, 0);
  const freeSlots = Math.max(0, totalSlots - usedSlots);
  const cashCredits = moneyToCredits(comp?.cash);
  const savingsCredits = moneyToCredits(comp?.savings);
  const debtCredits = moneyToCredits(comp?.debt);
  const shipsCount = comp?.ships.length ?? 0;
  const primaryShip = comp?.ships[0];

  const STEP_TITLES: Record<StepId, string> = {
    intro: '1 / 7 · 《子午线》游戏玩法介绍',
    produce: `2 / 7 · 建造「${buildingName}」产出「${itemName}」`,
    ship_orbit: `3 / 7 · 把「${itemName}」运往近地轨道站（${homeStationId}）`,
    trade_orbit: `4 / 7 · 在近地轨道站挂单或吃单买卖`,
    power_supply: '5 / 7 · 记得买电，以及以后扩产要买原料',
    bank_land: '6 / 7 · 认识中央银行与地块系统',
    script_intro: '7 / 7 · 自动化抛砖引玉：用几行代码托管公司',
  };

  const requestClose = () => {
    setCollapsed(false);
    setConfirmClose(true);
    onBringToFront?.();
  };

  if (collapsed) {
    return (
      <div
        data-floating-win="true"
        onPointerDown={() => onBringToFront?.()}
        style={{ zIndex }}
        className="fixed bottom-3 right-3 flex items-center gap-2 rounded-[3px] border border-sky-400/60 bg-[#212834]/95 px-2.5 py-1.5 text-[11px] text-sky-100 shadow-[0_14px_40px_rgba(0,0,0,0.75)] backdrop-blur-sm"
      >
        <Compass className="w-3.5 h-3.5 text-sky-400 shrink-0" />
        <span className="font-medium truncate max-w-[270px]">{STEP_TITLES[stepId]}</span>
        <button
          type="button"
          onClick={() => setCollapsed(false)}
          className="pill-btn py-0 px-1.5 text-[10px] text-sky-200 border-sky-500/40"
          title="展开引导窗口"
        >
          <Maximize2 className="w-3 h-3" />
        </button>
        <button
          type="button"
          onClick={requestClose}
          className="text-slate-400 hover:text-rose-300"
          title="关闭引导"
        >
          <X className="w-3.5 h-3.5" />
        </button>
      </div>
    );
  }

  return (
    <FloatingWindowFrame
      x={rect.x}
      y={rect.y}
      w={rect.w}
      h={rect.h}
      z={zIndex}
      minW={350}
      minH={300}
      title={
        <span className="inline-flex items-center gap-1.5">
          <Compass className="w-3.5 h-3.5 text-sky-300 shrink-0" />
          <span>{STEP_TITLES[stepId]}</span>
        </span>
      }
      badge={
        <span className="text-[9px] px-1 py-0 bg-sky-500/15 text-sky-300 border border-sky-500/30 shrink-0">
          悬浮引导 · {profName}
        </span>
      }
      headerExtra={
        <button
          type="button"
          onClick={() => setCollapsed(true)}
          className="w-5 h-5 flex items-center justify-center text-slate-400 hover:text-sky-200 hover:bg-sky-500/15 rounded-[2px]"
          title="收起为底角胶囊"
        >
          <Minimize2 className="w-3 h-3" />
        </button>
      }
      onFocus={onBringToFront}
      onMove={(nx, ny) => setRect((prev) => ({ ...prev, x: nx, y: ny }))}
      onResize={(nw, nh) => setRect((prev) => ({ ...prev, w: nw, h: nh }))}
      onClose={requestClose}
      closeTitle="关闭新手引导（需确认）"
    >
      {/* Progress segments */}
      <div className="flex items-center gap-1 px-3 pt-2 shrink-0 bg-[#202732]">
        {STEP_IDS.map((sid, idx) => {
          const done = isStepDone(idx) || idx < safeIdx;
          const active = idx === safeIdx;
          return (
            <button
              key={sid}
              type="button"
              onClick={() => setTutorialStep(idx)}
              title={STEP_TITLES[sid]}
              className={`h-1.5 flex-1 rounded-full transition-colors ${
                active ? 'bg-sky-400' : done ? 'bg-emerald-400/80' : 'bg-slate-700 hover:bg-slate-600'
              }`}
            />
          );
        })}
      </div>

      {/* Scrollable Body */}
      <div className="flex-1 min-h-0 overflow-y-auto px-3 py-2.5 space-y-2.5 text-[11px] leading-relaxed bg-[#202732] text-slate-200">
        {stepId === 'intro' && (
          <>
            <p className="text-slate-200">
              在《子午线（Meridian）》里，你是一家星际商业公司的掌舵人。你将从 <strong>{homeName}</strong>{' '}
              起步，走完一条完整商业链路，并与同星系数十家 AI 竞争对手同台竞逐：
            </p>

            <div className="rounded-sm border border-sky-500/25 bg-[#1b212b] px-2.5 py-2 text-[10px] text-sky-200 text-center mono">
              地面建厂产货 → 飞船运上近地轨道站 → 交易所买卖变现 → 央行存贷与扩地 → 脚本托管
            </div>

            <div className="space-y-1.5 text-[10px]">
              <div className="rounded-sm border border-slate-700/70 bg-[#191f27] px-2.5 py-1.5">
                <span className="text-sky-300 font-medium">1. 两套仓库完全分开：</span>
                <span className="text-slate-300">
                  造厂和生产都在 <strong>行星地面仓（{homePid}）</strong> 扣料出货；飞船卸货与市场买卖则在{' '}
                  <strong>近地轨道站（{homeStationId}）</strong> 完成。
                </span>
              </div>
              <div className="rounded-sm border border-slate-700/70 bg-[#191f27] px-2.5 py-1.5">
                <span className="text-sky-300 font-medium">2. 按回合（Tick）结算 + 控制台回显：</span>
                <span className="text-slate-300">
                  点击任何操作按钮都会进入指令队列，在 <strong>下一个 Tick 统一结算</strong>，提交与结算结果也会同步输出在控制台。
                </span>
              </div>
            </div>

            <div className="rounded-sm border border-slate-700/70 bg-[#1b212b] px-2.5 py-2 space-y-1">
              <div className="text-[10px] text-slate-400">当前开局家底（实时读取）：</div>
              <div className="mono text-[10px] text-slate-200 flex flex-wrap gap-x-3 gap-y-0.5">
                <span>职业：{profName}</span>
                <span>母星：{homeName}（{homePid}）</span>
                <span>现金：{cashCredits.toFixed(1)}</span>
                <span>地块：{plotsCount} 块（{freeSlots}/{totalSlots} 空槽）</span>
                <span>飞船：{shipsCount} 艘{primaryShip ? `（停靠 ${primaryShip.location}）` : ''}</span>
              </div>
            </div>

            {activeWorkspaceId !== 'ws-overview' && (
              <button
                type="button"
                onClick={() => onSwitchWorkspace('ws-overview')}
                className="pill-btn py-0.5 px-2 text-[10px] text-sky-200 border-sky-500/40"
              >
                切到 01 遥测总览
              </button>
            )}
          </>
        )}

        {stepId === 'produce' && (
          <>
            <div className="rounded-sm border border-sky-500/25 bg-[#1b212b] px-2.5 py-2 space-y-1">
              <div className="flex items-center justify-between gap-2 text-[10px] text-sky-300">
                <span>
                  职业推荐直出设施 · <strong className="text-sky-100">{buildingName}</strong>
                </span>
                <span className="mono text-slate-400">{guide.slotsText}</span>
              </div>
              <div className="text-[11px] text-slate-200">
                推荐配方 <strong className="text-emerald-300">「{recipeName}」</strong>：{guide.recipeSummary}
              </div>
              <div className="mono text-[10px] text-slate-400">
                {homeName} 地面仓：建材 {groundMat} · 电力 {groundPower} · 燃料 {groundFuel} · {itemName} {curTargetQty}
              </div>
            </div>

            <div className="space-y-1">
              <div className="text-[11px] font-medium text-slate-100">操作步骤：</div>
              <ol className="list-decimal list-inside space-y-1 text-slate-300">
                <li>
                  在 <strong>01 遥测总览</strong> 右上「我的工厂」顶部选择 <strong>{buildingName}</strong>，在虚线空地上点击{' '}
                  <strong>「建造」</strong>。
                </li>
                <li>
                  点完建造后，列表里会出现一条琥珀色 <strong>「建造中 · {buildingName}」工地卡片</strong>，实时显示已完工回合数与剩余时间。
                </li>
                <li>
                  工地完工变成正式工厂卡片后，选择配方 <strong>「{recipeName}」</strong> 并确认处于{' '}
                  <strong>「运行中」</strong>；等它产出一批 <strong>{itemName}</strong> 即自动进入下一步。
                </li>
              </ol>
            </div>

            <div className="rounded-sm border border-slate-700/70 bg-[#191f27] px-2.5 py-1.5 text-[10px] text-slate-400">
              {guide.tip}
            </div>

            <div className="flex items-center gap-1.5 text-[10px]">
              {producedDone ? (
                <span className="inline-flex items-center gap-1 text-emerald-300">
                  <CheckCircle2 className="w-3.5 h-3.5 shrink-0" />
                  已完成：通过 {buildingName} 产出了 {itemName}（当前地面 {curTargetQty}）
                </span>
              ) : targetSite ? (
                <span className="text-amber-300">
                  施工中：{buildingName} 工地还剩 {targetSite.ticks_remaining} 回合完工（可在我的工厂看进度条）…
                </span>
              ) : hasTargetBuilding ? (
                <span className="text-sky-300">
                  已建成 {buildingName}：请选定「{recipeName}」并保持运行，等待产出 1 批 {itemName}…
                </span>
              ) : (
                <span className="text-amber-300/90">
                  任务目标：建造「{buildingName}」并实际产出 1 批 {itemName}（也可点「下一步」跳过）
                </span>
              )}
            </div>

            {activeWorkspaceId !== 'ws-overview' && (
              <button
                type="button"
                onClick={() => onSwitchWorkspace('ws-overview')}
                className="pill-btn py-0.5 px-2 text-[10px] text-sky-200 border-sky-500/40"
              >
                切回 01 遥测总览
              </button>
            )}
          </>
        )}

        {stepId === 'ship_orbit' && (
          <>
            <p className="text-slate-200">
              刚刚产出的 <strong className="text-emerald-300">{itemName}</strong> 还在{' '}
              <strong>{homeName}（{homePid}）地面仓</strong>（当前有 <code>{curTargetQty}</code> 个）。交易所读不到地面货物，第一步物流先把货拉上头顶的{' '}
              <strong className="text-sky-200">{homeName}近地轨道站（{homeStationId}）</strong>。
            </p>

            <div className="rounded-sm border border-slate-700/70 bg-[#1b212b] px-2.5 py-2 space-y-1.5 text-[10px]">
              <div className="text-sky-300 font-medium inline-flex items-center gap-1">
                <Rocket className="w-3 h-3 shrink-0" />
                「舰队调度」详细发船步骤：
              </div>
              <ol className="list-decimal list-inside space-y-1 text-slate-300">
                <li>
                  在 <strong>01 遥测总览</strong> 的 <strong>「舰队调度」</strong> 选中你的飞船
                  {primaryShip ? `（#${primaryShip.id}，容量 ${primaryShip.capacity}，当前位置 ${primaryShip.location}）` : ''}。
                </li>
                <li>
                  在 <strong>「终点」</strong> 下拉框选择 <strong>{homeStationId}（{homeName}近地轨道站）</strong>。
                </li>
                <li>
                  在货物输入栏填好要运出的 <strong>{itemName}</strong> 数量（注意总货物占用不能超过飞船货舱容量；如只想空船调遣，不填货点「空船启航」）。
                </li>
                <li>
                  核对面板显示的<strong>预计耗油</strong>与当前地面燃料（余油 <code>{groundFuel}</code>），点{' '}
                  <strong>「确认启航发运」</strong>。
                </li>
                <li>
                  发运请求会输出到 <strong>控制台</strong>；等待航行结束抵达 <code>{homeStationId}</code>，货物会自动卸入近地轨道站仓库。
                </li>
              </ol>
            </div>

            <div className="space-y-1 text-[10px]">
              <div className={`flex items-center gap-1.5 ${shipInTransit || shipOrbitArrived ? 'text-emerald-300' : 'text-amber-300/90'}`}>
                <CheckCircle2 className="w-3.5 h-3.5 shrink-0" />
                <span>
                  {shipOrbitArrived
                    ? `已抵达近地轨道：${homeStationId} 当前存有 ${itemName} ${orbitTargetQty} 个`
                    : shipInTransit
                      ? `飞船正在飞往 ${homeStationId}，请等待抵达结算…`
                      : `等待从 ${homePid} 发船前往近地轨道站 ${homeStationId}`}
                </span>
              </div>
            </div>

            {activeWorkspaceId !== 'ws-overview' && (
              <button
                type="button"
                onClick={() => onSwitchWorkspace('ws-overview')}
                className="pill-btn py-0.5 px-2 text-[10px] text-sky-200 border-sky-500/40"
              >
                切回 01 遥测总览调度飞船
              </button>
            )}
          </>
        )}

        {stepId === 'trade_orbit' && (
          <>
            <p className="text-slate-200">
              货物抵达近地轨道站 <strong className="text-sky-200">{homeStationId}</strong>（当前轨道库存{' '}
              <code>{orbitTargetQty}</code> 个 {itemName}）后，就可以在交易所卖出换现金了！
            </p>

            <div className="rounded-sm border border-slate-700/70 bg-[#1b212b] px-2.5 py-2 space-y-1.5 text-[10px]">
              <div className="text-sky-300 font-medium">盘口阅读与两种卖货方法：</div>
              <div className="text-slate-300">
                1. 切到 <strong>02 双图盯盘</strong>，确认盘口左上站点头选在 <strong>{homeStationId}</strong>、物品选{' '}
                <strong>{itemName}</strong>（下方「市场行情」也可切换对应站点的物品）。
              </div>
              <div className="text-slate-300">
                2. 上半区红色/橙色是<strong>卖盘</strong>（别人的售价）；下半区绿色/金色是<strong>买盘</strong>（别人的收货价，带金色{' '}
                <code className="text-amber-300">PLANET:*</code> 标志的是<strong>行星官方刚需买单</strong>，出价稳定）。
              </div>
              <div className="rounded-sm bg-[#191f27] border border-slate-700/70 p-1.5 space-y-1 text-slate-300">
                <div>
                  <strong className="text-emerald-300">方式 A · 主动吃单（立即变现）：</strong>
                  找到买盘里你想接受的那一档出价，在右侧数量框填好数量点 <strong>「吃单」</strong>（或点{' '}
                  <strong>「全吃」</strong>），下回合直接成交拿到现金。
                </div>
                <div>
                  <strong className="text-sky-300">方式 B · 限价挂单（自己定价）：</strong>
                  想卖更高的价，可在下单区切到 <strong>「卖出」</strong>，填好<strong>单价</strong>和<strong>数量</strong>后点{' '}
                  <strong>「提交限价单」</strong>。挂单会暂时冻结轨道站对应存货；不想等了可在下方「我的挂单」点 <strong>「撤单」</strong>。
                </div>
              </div>
            </div>

            <div className="flex items-center gap-1.5 text-[10px]">
              {tradeDone ? (
                <span className="inline-flex items-center gap-1 text-emerald-300">
                  <CheckCircle2 className="w-3.5 h-3.5 shrink-0" />
                  已完成：已提交卖出/吃单交易（可在控制台查看结算回报）
                </span>
              ) : (
                <span className="text-sky-300">
                  任务目标：在 {homeStationId} 完成 1 笔吃单或挂出卖出限价单
                </span>
              )}
            </div>

            <div className="flex flex-wrap items-center gap-1.5">
              {activeWorkspaceId !== 'ws-market' && (
                <button
                  type="button"
                  onClick={() => onSwitchWorkspace('ws-market')}
                  className="pill-btn py-0.5 px-2 text-[10px] text-sky-200 border-sky-500/40"
                >
                  切到 02 双图盯盘
                </button>
              )}
              <button
                type="button"
                onClick={() =>
                  onOpenTemp('orderbook', { stationId: homeStationId, itemId: guide.targetItemId })
                }
                className="pill-btn py-0.5 px-2 text-[10px] text-emerald-200 border-emerald-500/35"
              >
                打开 {homeStationId} · {itemName} 盘口
              </button>
            </div>
          </>
        )}

        {stepId === 'power_supply' && (
          <>
            <div className="rounded-sm border border-amber-500/30 bg-[#1b212b] px-2.5 py-2 space-y-1.5">
              <div className="flex items-center justify-between gap-2">
                <span className="inline-flex items-center gap-1 font-medium text-amber-300">
                  <Zap className="w-3.5 h-3.5 shrink-0" />
                  第一条提醒：千万记得买「电力」
                </span>
                <span
                  className={`mono text-[10px] px-1.5 py-0.5 rounded-sm border ${
                    groundPower < 20
                      ? 'border-rose-500/40 bg-rose-500/10 text-rose-300'
                      : 'border-emerald-500/30 bg-emerald-500/10 text-emerald-300'
                  }`}
                >
                  地面余电 {groundPower}
                </span>
              </div>
              <p className="text-[10px] text-slate-300 leading-relaxed">
                除能源水站外，其他工厂<strong>哪怕处于待机也要每回合耗电</strong>，跑配方耗电更高。开局送的电用完就会全厂停产！
              </p>
              <p className="text-[10px] text-sky-300">
                便利机制：<strong>电力（power）</strong> 与垃圾消纳属于「即时物品」，在近地轨道站{' '}
                <code>{homeStationId}</code> 买入后会<strong>直接入账到地面仓</strong>，不用开船往下拉。
              </p>
            </div>

            <div className="rounded-sm border border-slate-700/70 bg-[#191f27] px-2.5 py-2 space-y-1">
              <div className="font-medium text-sky-200 text-[10px]">
                第二条提醒：后续扩产要盯紧「原料采购」
              </div>
              <p className="text-[10px] text-slate-300 leading-relaxed">{guide.supplyWarning}</p>
              <p className="text-[10px] text-slate-400">
                在近地轨道站 <code>{homeStationId}</code>（或他星轨道）买到的水、生物纤维、矿石、钢材等实体原料会先留在轨道站里——
                <strong>记得用飞船拉回 {homeName}（{homePid}）地面仓</strong>，地面工厂才能吃到。
              </p>
            </div>

            <div className="flex flex-wrap items-center gap-1.5">
              <button
                type="button"
                onClick={() => onOpenTemp('orderbook', { stationId: homeStationId, itemId: 'power' })}
                className="pill-btn py-0.5 px-2 text-[10px] text-amber-200 border-amber-500/35"
              >
                去 {homeStationId} 看看电力盘口
              </button>
            </div>
          </>
        )}

        {stepId === 'bank_land' && (
          <>
            <div className="rounded-sm border border-slate-700/70 bg-[#1b212b] px-2.5 py-2 space-y-1">
              <div className="font-medium text-sky-200 text-[10px]">
                1. 中央银行（财务面板）· 存入吃息与借款周转
              </div>
              <div className="mono text-[10px] text-slate-400">
                当前现金 {cashCredits.toFixed(1)} · 央行存款 {savingsCredits.toFixed(1)} · 借款 {debtCredits.toFixed(1)}
              </div>
              <p className="text-[10px] text-slate-300 leading-relaxed">
                手里有闲钱可先点 <strong>「存入」</strong> 赚利息，要用时随时 <strong>「取出」</strong>；扩建产线或遇到好价格周转不过来时可向央行{' '}
                <strong>「借款」</strong>，回款后及时 <strong>「还款」</strong> 控制利息成本。
              </p>
            </div>

            <div className="rounded-sm border border-slate-700/70 bg-[#1b212b] px-2.5 py-2 space-y-1">
              <div className="font-medium text-sky-200 text-[10px]">
                2. 地块系统（本教程不强制购买）
              </div>
              <div className="mono text-[10px] text-slate-400">
                名下地块 {plotsCount} 块 · 建造槽 {usedSlots}/{totalSlots}（剩余 {freeSlots} 空槽）
              </div>
              <p className="text-[10px] text-slate-300 leading-relaxed">
                不同地貌对各类设施有不同效率加成。等现有槽位快插满、需要扩建新产线时，再到行星/地块面板点{' '}
                <strong>「购买一手空地」</strong> 或二级市场 <strong>「购买挂牌地块」</strong>；前期优先把钱留给买电、补料与跑船。
              </p>
            </div>

            <div className="flex flex-wrap items-center gap-1.5">
              <button
                type="button"
                onClick={() => onOpenTemp('treasury', { planetId: homePid })}
                className="pill-btn py-0.5 px-2 text-[10px] text-sky-200 border-sky-500/40"
              >
                打开财务 / 央行面板
              </button>
              <button
                type="button"
                onClick={() => onOpenTemp('land', { planetId: homePid })}
                className="pill-btn py-0.5 px-2 text-[10px] text-sky-200 border-sky-500/40"
              >
                查看 {homeName} 地块分布
              </button>
            </div>
          </>
        )}

        {stepId === 'script_intro' && (
          <>
            <p className="text-slate-200">
              到这一步，你已经跑通了《子午线》的全部基础玩法。等以后工厂和船队多了起来，可以切到{' '}
              <strong>03 脚本终端</strong> 写几行 JS 代码，让系统在每个 Tick 自动替你巡检执行：
            </p>

            <pre className="mono text-[10px] leading-relaxed bg-[#191f27] border border-slate-700/80 rounded-sm p-2 text-sky-200 overflow-x-auto">
{`module.exports.loop = function () {
  // 1. 巡检 ${homePid} 地面余电与原料，不足时下单补买
  // 2. 挑空闲飞船把地面成品运往 ${homeStationId} 卖出
  console.log('Tick 自动巡检完成');
};`}
            </pre>

            <ul className="list-disc list-inside space-y-1 text-[10px] text-slate-300">
              <li>
                改完代码点 <strong>「保存并热重载」</strong>，下一个回合起自动按新逻辑跑；
              </li>
              <li>
                <strong>脚本与手动界面完全共存</strong>：日常物流交给脚本，自己照样随时点界面插单、借钱、改配方；
              </li>
              <li>
                <strong>控制台</strong> 同时显示脚本打印和你在 UI 上的每次点击提交与结算响应；需要完整 API 可随时打开左侧{' '}
                <strong>API</strong> 参考文档。
              </li>
            </ul>

            <div className="flex flex-wrap items-center gap-1.5">
              {activeWorkspaceId !== 'ws-script' && (
                <button
                  type="button"
                  onClick={() => onSwitchWorkspace('ws-script')}
                  className="pill-btn py-0.5 px-2 text-[10px] text-sky-200 border-sky-500/40"
                >
                  去 03 脚本终端看看
                </button>
              )}
              <button
                type="button"
                onClick={() => onOpenTemp('apidocs')}
                className="pill-btn py-0.5 px-2 text-[10px] text-slate-300 border-slate-600"
              >
                打开 API 参考
              </button>
            </div>
          </>
        )}
      </div>

      {/* Footer Navigation */}
      <div className="flex items-center justify-between gap-2 border-t border-slate-700/70 bg-[#1b212b] px-3 py-1.5 shrink-0">
        <button
          type="button"
          onClick={requestClose}
          className="text-[10px] text-slate-400 hover:text-rose-300"
        >
          关闭教程
        </button>
        <div className="flex items-center gap-1.5">
          <button
            type="button"
            disabled={safeIdx === 0}
            onClick={() => setTutorialStep(safeIdx - 1)}
            className="pill-btn py-0.5 px-2 text-[10px] inline-flex items-center gap-0.5 disabled:opacity-35"
          >
            <ChevronLeft className="w-3 h-3" />
            上一步
          </button>
          {safeIdx < STEP_IDS.length - 1 ? (
            <button
              type="button"
              onClick={() => setTutorialStep(safeIdx + 1)}
              className="cta-blue py-0.5 px-2.5 text-[10px] inline-flex items-center gap-0.5"
            >
              {safeIdx === 0 ? '开始第一步' : '下一步'}
              <ChevronRight className="w-3 h-3" />
            </button>
          ) : (
            <button
              type="button"
              onClick={() => closeTutorial(true)}
              className="cta-green py-0.5 px-2.5 text-[10px]"
            >
              完成教程
            </button>
          )}
        </div>
      </div>

      {/* Close Confirmation Dialog */}
      {confirmClose && (
        <div className="absolute inset-0 z-20 bg-[#141920]/90 backdrop-blur-[1px] flex items-center justify-center p-4">
          <div className="w-full max-w-[320px] rounded-sm border border-amber-400/45 bg-[#212834] p-3.5 shadow-2xl space-y-2.5">
            <div className="flex items-center gap-2 text-amber-300 text-[12px] font-medium">
              <AlertTriangle className="w-4 h-4 shrink-0" />
              <span>确定关闭新手引导吗？</span>
            </div>
            <p className="text-[10px] leading-relaxed text-slate-300">
              关闭后不会再自动弹出；之后随时可点击顶部右上角 <strong>「引导」</strong> 按钮重新打开并继续查看。
            </p>
            <div className="flex items-center justify-end gap-2 pt-1">
              <button
                type="button"
                onClick={() => setConfirmClose(false)}
                className="pill-btn py-1 px-2.5 text-[10px] text-slate-200"
              >
                继续引导
              </button>
              <button
                type="button"
                onClick={() => closeTutorial(true)}
                className="rounded-sm border border-rose-500/50 bg-rose-500/20 px-2.5 py-1 text-[10px] font-medium text-rose-200 hover:bg-rose-500/35"
              >
                确认关闭
              </button>
            </div>
          </div>
        </div>
      )}
    </FloatingWindowFrame>
  );
};

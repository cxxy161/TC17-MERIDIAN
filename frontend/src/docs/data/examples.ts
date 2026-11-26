import type { DocEntry } from '../types';

export const EXAMPLE_ENTRIES: DocEntry[] = [
  {
    id: 'examples/open',
    title: '开局：买地建厂',
    group: '实战示例',
    kind: '指南',
    summary: '使用 API v2 的 Game.map.buyPlot 与 Plot.build 完成选址购地、施工跟踪及建厂闭环',
    keywords: '示例 开局 买地 建厂 buyPlot Plot.build Game.sites Memory 状态机',
    blocks: [
      {
        kind: 'prose',
        text: '利用 `Game.map.getLandPlots` 筛选母星冶炼加成最高的一手空地并用 `Game.map.buyPlot` 购入，随后在下一 tick 新地块到账后通过 `plot.build(\'mine_smelter\')` 开工，并通过 `Game.sites` 实时跟踪施工剩余周期。',
      },
      {
        kind: 'example',
        caption: 'main.js —— API v2 买地建厂闭环状态机',
        code: `module.exports.loop = function () {
  for (const r of Game.lastTick.rejected) {
    console.warn('[上回合被拒]', r.action, r.target, r.code, r.reason);
  }

  const m = (Memory.open = Memory.open || {
    step: 'buy',
    planet: Game.company.homePlanetId,
  });
  if (m.step === 'done') return;

  const plots = Object.values(Game.plots);

  if (m.step === 'buy') {
    const tiles = Game.map.getLandPlots(m.planet);
    if (!tiles) return;

    const target = tiles
      .filter((t) => t.status === 'unclaimed' && t.capacity >= 4 && t.price !== null)
      .sort((a, b) => (b.buildingMods.mine_smelter || 0) - (a.buildingMods.mine_smelter || 0))[0];

    if (!target || target.price === null || Game.company.cash < target.price * 1.2) return;

    const rc = Game.map.buyPlot(m.planet, target.slotId);
    if (rc === OK) {
      m.step = 'wait';
      m.at = Game.time;
      m.plotsBefore = plots.length;
    }
    return;
  }

  if (m.step === 'wait') {
    if (plots.length > m.plotsBefore) {
      m.step = 'build';
    } else if (Game.time - m.at > 2) {
      m.step = 'buy';
    }
    return;
  }

  const bdef = Game.catalog.buildings.mine_smelter;
  const plot = plots.find((p) => p.capacity - p.usedSlots >= bdef.slotsUsed);
  if (!plot) return;

  const ground = Game.planets[plot.planetId].groundStore;
  const hasMat = bdef.buildCost.every((c) => ground[c.item] >= c.qty);
  if (!hasMat || Game.company.cash < bdef.cashFeeBase * Game.cpi) return;

  const rc = plot.build('mine_smelter');
  if (rc === OK) {
    m.step = 'done';
    console.log('已排期建造 mine_smelter，可在 Game.sites 追踪进度');
  }
};`,
      },
      {
        kind: 'links',
        items: [
          { label: 'Game.map.buyPlot', id: 'Game.map.buyPlot' },
          { label: 'Plot.build', id: 'Plot.build' },
          { label: 'ConstructionSite', id: 'ConstructionSite' },
        ],
      },
    ],
  },
  {
    id: 'examples/quote',
    title: '盯盘：跨站套利评估',
    group: '实战示例',
    kind: '指南',
    summary: '结合 Game.market.depth 与 Game.map.calcRoute 自动扫描跨站点价差空间',
    keywords: '示例 盯盘 行情 quote depth calcRoute 套利 价差',
    blocks: [
      {
        kind: 'prose',
        text: '利用 `Game.market.quote` 和 `Game.market.depth` 评估主要消费品在母星轨道站与中心枢纽站之间的价差，并叠加 `Game.map.calcRoute` 估算往返燃料成本。',
      },
      {
        kind: 'example',
        caption: 'main.js —— 跨站点价差扫描巡检',
        code: `module.exports.loop = function () {
  const homeSid = Game.planets[Game.company.homePlanetId].stationId;
  const route = Game.map.calcRoute('ST:HUB', homeSid);
  if (!route) return;

  for (const item of [RESOURCE_STEEL, RESOURCE_BUILDING_MAT, RESOURCE_DAILY_GOODS]) {
    const qHub = Game.market.quote('ST:HUB', item);
    const qHome = Game.market.quote(homeSid, item);
    if (!qHub || !qHome || qHub.bestAsk === null || qHome.bestBid === null) continue;

    const spread = qHome.bestBid * 0.995 - qHub.bestAsk;
    if (spread > 1.0) {
      const book = Game.market.depth('ST:HUB', item, 3);
      console.log('套利窗口:', item, 'Hub卖一:', qHub.bestAsk, homeSid + '买一:', qHome.bestBid, '首档余量:', book.asks[0] ? book.asks[0].qty : 0);
    }
  }
};`,
      },
      {
        kind: 'links',
        items: [
          { label: 'Game.market.quote', id: 'Game.market.quote' },
          { label: 'Game.market.depth', id: 'Game.market.depth' },
          { label: 'Game.map.calcRoute', id: 'Game.map.calcRoute' },
        ],
      },
    ],
  },
  {
    id: 'examples/restock',
    title: '生产：按配方自动补料',
    group: '实战示例',
    kind: '指南',
    summary: '通过 Game.catalog.recipes 汇总建筑原料需求并借助影账连续在轨道站下买单',
    keywords: '示例 生产 补料 Game.catalog createOrder 配方',
    blocks: [
      {
        kind: 'prose',
        text: '直接读取 `Game.catalog.recipes[b.recipeId]` 统计行星上开机建筑对未来 2 个周期的原料需求，如果地面与轨道站总备货不足即刻发起 `createOrder`；沙盒影账会在同 tick 内连续扣减预算与挂单数，避免资金透支。',
      },
      {
        kind: 'example',
        caption: 'main.js —— 产线原料自动采购循环',
        code: `module.exports.loop = function () {
  const pid = Game.company.homePlanetId;
  const planet = Game.planets[pid];
  if (!planet) return;
  const sid = planet.stationId;

  const needByItem = {};
  for (const b of Object.values(Game.buildings)) {
    if (!b.active || b.planetId !== pid) continue;
    const recipe = Game.catalog.recipes[b.recipeId];
    if (!recipe) continue;
    for (const inp of recipe.inputs) {
      needByItem[inp.item] = (needByItem[inp.item] || 0) + inp.qty * 2;
    }
  }

  for (const [item, targetQty] of Object.entries(needByItem)) {
    const have = planet.groundStore[item] + planet.stationStore[item];
    if (have >= targetQty) continue;

    const q = Game.market.quote(sid, item);
    if (!q || q.bestAsk === null) continue;

    const orderQty = Math.min(targetQty - have, 50);
    const price = Math.round((q.bestAsk + 0.01) * MONEY_SCALE) / MONEY_SCALE;
    const rc = Game.market.createOrder({
      type: ORDER_BUY,
      resourceType: item,
      price,
      totalAmount: orderQty,
      stationId: sid,
    });
    if (rc === ERR_FULL || rc === ERR_NOT_ENOUGH_CREDITS) break;
  }
};`,
      },
      {
        kind: 'links',
        items: [
          { label: 'Game.catalog', id: 'Game.catalog' },
          { label: 'Game.market.createOrder', id: 'Game.market.createOrder' },
          { label: 'MONEY_SCALE', id: 'constants/money-scale' },
        ],
      },
    ],
  },
  {
    id: 'examples/logistics',
    title: '物流：地面到轨道站销售',
    group: '实战示例',
    kind: '指南',
    summary: '使用 ship.dispatch(to, cargo) 将地面成品运上轨道站，到站后自动挂单出售',
    keywords: '示例 物流 派船 Ship.dispatch Game.map.calcRoute 轨道站 卖单',
    blocks: [
      {
        kind: 'prose',
        text: '利用 `ship.dispatch(sid, { ... })` 从地面运送产物到行星轨道站 `planet.stationId`，当站点已有成品到库则直接挂卖单，并在低耐久停靠期间顺手修船。',
      },
      {
        kind: 'example',
        caption: 'main.js —— 自动化外运出货与维护巡检',
        code: `const SELL_ITEMS = [RESOURCE_STEEL, RESOURCE_BUILDING_MAT];

module.exports.loop = function () {
  const pid = Game.company.homePlanetId;
  const planet = Game.planets[pid];
  if (!planet) return;
  const sid = planet.stationId;

  // 1. 轨道站已有现货时优先出货
  for (const item of SELL_ITEMS) {
    const stQty = planet.stationStore[item];
    if (stQty < 10) continue;
    const q = Game.market.quote(sid, item);
    if (q && q.bestBid !== null) {
      Game.market.createOrder({
        type: ORDER_SELL,
        resourceType: item,
        price: q.bestBid,
        totalAmount: Math.min(20, stQty),
        stationId: sid,
      });
    }
  }

  // 2. 空闲飞船检修或执行地面到轨道运输
  for (const ship of Object.values(Game.ships)) {
    if (ship.isBusy) continue;
    if (ship.durability < 50 && ship.repair() === OK) continue;

    if (ship.location !== pid) {
      // 返程带点燃料顺路回母星地面，或空载至少需带 1 件物品
      continue;
    }

    const cargo = {};
    let total = 0;
    for (const item of SELL_ITEMS) {
      const avail = planet.groundStore[item];
      const take = Math.min(avail, ship.capacity - total);
      if (take > 0) {
        cargo[item] = take;
        total += take;
      }
    }
    if (total > 0) {
      const rc = ship.dispatch(sid, cargo);
      if (rc === OK) console.log('已派出混装货船:', ship.id, cargo);
    }
  }
};`,
      },
      {
        kind: 'links',
        items: [
          { label: 'Ship.dispatch', id: 'Ship.dispatch' },
          { label: 'Ship.repair', id: 'Ship.repair' },
          { label: 'Game.map.calcRoute', id: 'Game.map.calcRoute' },
        ],
      },
    ],
  },
];

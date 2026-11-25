import type { DocEntry } from '../types';

export const EXAMPLE_ENTRIES: DocEntry[] = [
  {
    id: 'examples/open',
    title: '开局：买地建厂',
    group: '实战示例',
    kind: '指南',
    summary: '用 Memory 状态机完成“筛选空地 → 定向买地 → 下一 tick 建厂”的两段式开局脚本',
    keywords: '示例 开局 买地 建厂 buyPlot buildFacility 状态机 Memory',
    blocks: [
      {
        kind: 'prose',
        text: '由于写操作要到下一 tick 落账后才会反映到 `Game.plots`，跨 tick 协作需要通过 `Memory` 维护状态机。下面示例先挑出母星矿冶加成最高的一手空地买下，确认地块到账后再发起建造 `mine_smelter`。',
      },
      {
        kind: 'example',
        caption: 'main.js —— 两段式买地建厂状态机',
        code: `module.exports.loop = function () {
  const m = (Memory.open = Memory.open || {
    step: 'buy',
    planet: Game.company.homePlanetId,
  });
  if (m.step === 'done') return;

  const plots = Object.values(Game.plots);

  if (m.step === 'buy') {
    const tiles = Game.market.getLandPlots(m.planet);
    if (!tiles) return;

    const target = tiles
      .filter((t) => t.status === 'unclaimed' && t.capacity >= 4 && t.price !== null)
      .sort((a, b) => (b.buildingMods.mine_smelter || 0) - (a.buildingMods.mine_smelter || 0))[0];

    if (!target || target.price === null) {
      console.log('无可用一手空地');
      return;
    }
    if (Game.company.cash < target.price * 1.2) {
      console.log('现金不足以买地，需保留施工费余量');
      return;
    }

    const rc = Game.buyPlot(m.planet, { slotId: target.slotId });
    if (rc === OK) {
      m.step = 'wait';
      m.at = Game.time;
      m.plotsBefore = plots.length;
    } else {
      console.warn('buyPlot 返回:', rc);
    }
    return;
  }

  if (m.step === 'wait') {
    if (plots.length > m.plotsBefore) {
      m.step = 'build';
      console.log('新地块已到账，准备建厂');
    } else if (Game.time - m.at > 2) {
      m.step = 'buy';
      console.warn('买地未落账，重新选址');
    }
    return;
  }

  const plot = plots.find((p) => p.usedSlots < p.capacity);
  if (!plot) return;

  const ground = Game.planets[plot.planetId].groundStore;
  if (ground[RESOURCE_BUILDING_MAT] < 8 || Game.company.cash < 80 * Game.cpi) {
    console.log('等待地面仓建材或施工费就绪');
    return;
  }

  const rc = Game.buildFacility(plot.id, 'mine_smelter');
  if (rc === OK) {
    m.step = 'done';
    console.log('已提交建造任务，施工完成后建筑将出现在 Game.buildings');
  } else {
    console.warn('buildFacility 返回:', rc);
  }
};`,
      },
      {
        kind: 'links',
        items: [
          { label: 'Game.buyPlot', id: 'Game.buyPlot' },
          { label: 'Game.buildFacility', id: 'Game.buildFacility' },
          { label: '执行与落账机制', id: 'guides/execution' },
          { label: 'Memory', id: 'Memory' },
        ],
      },
    ],
  },
  {
    id: 'examples/quote',
    title: '盯盘：报价与盘口',
    group: '实战示例',
    kind: '指南',
    summary: '纯只读行情扫描：结合 quote 与 depth 计算价差并缓存交易阈值到 Memory',
    keywords: '示例 盯盘 行情 报价 盘口 quote depth ema 价差',
    blocks: [
      {
        kind: 'prose',
        text: '行情查询接口不占用任何写操作配额。可以把高频计算好的参考区间缓存在 `Memory` 中，供交易模块或节流下单时直接读取。',
      },
      {
        kind: 'example',
        caption: 'main.js —— 监控母星轨道站核心商品行情',
        code: `const WATCH = [RESOURCE_STEEL, RESOURCE_BUILDING_MAT, RESOURCE_ORE];

module.exports.loop = function () {
  const stationId = 'ST:' + Game.company.homePlanetId;
  Memory.watch = Memory.watch || {};

  for (const item of WATCH) {
    const q = Game.market.quote(stationId, item);
    if (!q) continue;

    const spread =
      q.bestBid !== null && q.bestAsk !== null ? q.bestAsk - q.bestBid : null;
    const trend = q.emaFast >= q.emaSlow ? 'up' : 'down';

    const d = Game.market.depth(stationId, item, 5);
    const ask3Value = d.asks
      .slice(0, 3)
      .reduce((sum, lvl) => sum + lvl.price * lvl.qty, 0);

    console.log(
      item,
      '买一:', q.bestBid,
      '卖一:', q.bestAsk,
      '价差:', spread,
      '趋势:', trend,
      '卖3档货值:', ask3Value.toFixed(0),
    );

    Memory.watch[item] = {
      last: q.lastPrice,
      low: q.emaSlow * 0.97,
      high: q.emaSlow * 1.03,
      tick: Game.time,
    };
  }
};`,
      },
      {
        kind: 'links',
        items: [
          { label: 'Game.market.quote', id: 'Game.market.quote' },
          { label: 'Game.market.depth', id: 'Game.market.depth' },
          { label: 'Memory', id: 'Memory' },
        ],
      },
    ],
  },
  {
    id: 'examples/restock',
    title: '补料：按配方自动挂买单',
    group: '实战示例',
    kind: '指南',
    summary: '遍历在产建筑原料缺口并在母星轨道站自动挂买单，严格控制写操作配额与预算',
    keywords: '示例 补料 原料 配方 getRecipe createOrder 计数 预算',
    blocks: [
      {
        kind: 'prose',
        text: '遍历在产建筑的配方需求，结合地面库存与在途买单计算 4 个周期的原料缺口，在母星轨道站挂买单补货。写操作在最内层严格计数，并自行扣减局部变量 `cash` 防止连续下单超支。',
      },
      {
        kind: 'example',
        caption: 'main.js —— 自动补料并严格限制最多 8 次写操作',
        code: `module.exports.loop = function () {
  const homeStation = 'ST:' + Game.company.homePlanetId;
  const openOrders = Object.values(Game.market.orders);
  let writes = 0;
  let cash = Game.company.cash;

  for (const b of Object.values(Game.buildings)) {
    if (writes >= 8) break;
    if (!b.active || !b.recipeId) continue;

    const recipe = Game.getRecipe(b.recipeId);
    if (!recipe) continue;

    for (const inp of recipe.inputs) {
      if (writes >= 8) break;
      if (inp.item === 'waste') continue;

      const pending = openOrders
        .filter((o) => o.type === ORDER_BUY && o.stationId === homeStation && o.resourceType === inp.item)
        .reduce((sum, o) => sum + o.amount, 0);

      const ground = Game.planets[b.planetId].groundStore;
      const have = ground.getUsedCapacity(inp.item) + pending;
      const need = inp.qty * 4 - have;
      if (need <= 0) continue;

      const q = Game.market.quote(homeStation, inp.item);
      if (!q || q.bestAsk === null) continue;

      const price = q.bestAsk + 0.01;
      const cost = need * price;
      if (cash < cost) continue;

      const rc = Game.market.createOrder({
        type: ORDER_BUY,
        resourceType: inp.item,
        price,
        totalAmount: need,
        stationId: homeStation,
      });

      if (rc === OK) {
        writes += 1;
        cash -= cost;
      } else if (rc === ERR_FULL) {
        console.warn('挂单上限或本 tick 写配额已满');
        return;
      }
    }
  }
};`,
      },
      {
        kind: 'note',
        level: 'info',
        text: '买单成交后的普通原料存放在轨道站仓库中，需要再通过 `ship.dispatch` 运回行星地面才能被地面建筑消耗。',
      },
      {
        kind: 'links',
        items: [
          { label: 'Game.getRecipe', id: 'Game.getRecipe' },
          { label: 'Game.market.createOrder', id: 'Game.market.createOrder' },
          { label: '物流：地面到轨道站销售', id: 'examples/logistics' },
        ],
      },
    ],
  },
  {
    id: 'examples/logistics',
    title: '物流：地面到轨道站销售',
    group: '实战示例',
    kind: '指南',
    summary: '将行星地面产出的货物运上轨道站，并在到货后按买一价挂单出售',
    keywords: '示例 物流 派船 dispatch calcRoute 轨道站 卖单',
    blocks: [
      {
        kind: 'prose',
        text: '工厂产出落在行星地面仓，而市场挂单在轨道站结算。本示例演示如何检查站点存货卖货，并在站点缺货时先估算航线油耗、再将地面库存装船运往轨道站。',
      },
      {
        kind: 'example',
        caption: 'main.js —— 地面产出运至轨道站后出货',
        code: `const SELL_ITEMS = [RESOURCE_STEEL, RESOURCE_BUILDING_MAT];

module.exports.loop = function () {
  const pid = Game.company.homePlanetId;
  const stationId = 'ST:' + pid;
  const planet = Game.planets[pid];
  if (!planet) return;

  const ground = planet.groundStore;
  const station = Game.stations[stationId];
  let writes = 0;
  let dispatchedThisTick = false;

  for (const item of SELL_ITEMS) {
    if (writes >= 6) break;
    const q = Game.market.quote(stationId, item);
    if (!q) continue;

    const stQty = station ? station.store.getUsedCapacity(item) : 0;
    if (stQty >= 20 && q.bestBid !== null) {
      const rc = Game.market.createOrder({
        type: ORDER_SELL,
        resourceType: item,
        price: q.bestBid,
        totalAmount: 20,
        stationId,
      });
      if (rc === OK) writes += 1;
      continue;
    }

    if (dispatchedThisTick) continue;
    const ship = Object.values(Game.ships).find((s) => !s.isBusy && s.location === pid);
    if (!ship) continue;

    const route = Game.market.calcRoute(pid, stationId);
    if (!route) continue;

    const fuelNeed =
      ship.size === 'large' ? route.fuel * 4 : ship.size === 'medium' ? route.fuel * 2 : route.fuel;
    if (ground[RESOURCE_FUEL] < fuelNeed) continue;

    const qty = Math.min(ground[item], ship.capacity);
    if (qty <= 0) continue;

    const rc = ship.dispatch(pid, stationId, { [item]: qty });
    if (rc === OK) {
      writes += 1;
      dispatchedThisTick = true;
      console.log('已派船运送', item, '数量:', qty);
    }
  }
};`,
      },
      {
        kind: 'note',
        level: 'warn',
        text: '飞船到达轨道站后，下一次返程同样需要消耗燃料，请确保轨道站内或回程前备有足够的 `fuel`。',
      },
      {
        kind: 'links',
        items: [
          { label: 'Ship.dispatch', id: 'Ship.dispatch' },
          { label: 'Game.market.calcRoute', id: 'Game.market.calcRoute' },
          { label: 'Game.stations', id: 'Game.stations' },
        ],
      },
    ],
  },
];

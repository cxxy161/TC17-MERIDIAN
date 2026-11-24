import type { DocEntry } from '../types';

/**
 * 「示例」分组：可直接粘进脚本编辑器跑起来的完整套路。
 * 每个示例都遵守同一条铁律：每 tick 最多 32 条写操作，且写操作下一 tick 才生效。
 */
export const EXAMPLE_ENTRIES: DocEntry[] = [
  {
    id: 'example-open',
    title: '开局：买地建厂',
    group: '示例',
    kind: '章节',
    summary: '买一手地块、等一个 tick 地到手、再往上盖厂的两段式起步脚本',
    keywords: '开局 起步 买地 建厂 buyPlot buildFacility 地块 primaryLandPrice 状态机 Memory',
    blocks: [
      {
        kind: 'prose',
        text: '开局只有一块地和一点现金。先用 `Game.buyPlot` 买下母星的一手地块（不传 `listingId` 就是按 `primaryLandPrice` 买一手地），下一 tick 地块才出现在 `Game.plots` 里，这时才能 `Game.buildFacility` 往上盖厂。脚本用 `Memory` 存一个两段式状态机，每 tick 只推进一步、只发 1 条写操作。',
      },
      {
        kind: 'example',
        caption: 'main.js —— 每 tick 最多 1 条写操作',
        code: `// 开局：买一手地 → 下一 tick 地在 Game.plots 里出现 → 建厂。
// 每 tick 只发 1 条写操作，天然不会撞上 32 条上限。
module.exports.loop = function () {
  const m = (Memory.open = Memory.open || { step: 'buy', planet: Game.company.homePlanetId });
  const planet = Game.planets[m.planet];
  const plots = Object.keys(Game.plots).map((id) => Game.plots[id]);

  if (m.step === 'buy') {
    if (planet.primaryLandPrice === null) return console.log('一手地售罄，看挂牌', planet.landListings.length);
    // 留 20% 缓冲：现金校验发生在下一 tick 的 Phase 2
    if (Game.company.cash < planet.primaryLandPrice * 1.2) return console.log('现金不够买地');
    const ret = Game.buyPlot(m.planet);      // 写操作 1/32（不传 listingId = 买一手地）
    if (ret === OK) { m.step = 'wait'; m.at = Game.time; m.plotsBefore = plots.length; }
    else console.log('buyPlot 返回', ret);   // 只拦 -10 入参 / -5 星球不存在，缺钱不在这里报
    return;
  }

  if (m.step === 'wait') {
    // 写操作 t+1 才落账：地块晚一个 tick 出现在 Game.plots
    if (plots.length > m.plotsBefore) { m.step = 'build'; console.log('地到手'); }
    else if (Game.time - m.at > 2) { m.step = 'buy'; console.log('买地没落地'); }
    return;
  }

  // build：Game.plots 只含本公司地块，挑一个还有空位的
  const plot = plots.find((p) => p.usedSlots < p.capacity);
  if (!plot) return console.log('地块占满，先拆旧厂');
  const ret = Game.buildFacility(plot.id, 'mine_smelter');   // 写操作 1/32
  m.step = 'done';
  console.log('buildFacility', ret, '下一 tick 核对 Game.buildings');
};`,
      },
      {
        kind: 'note',
        level: 'warn',
        text: '`buyPlot` / `buildFacility` 返回 `OK` 只代表命令进了 Intent 缓冲：现金不够、地块名额已满、地面仓缺 `building_mat`（常见 6–8 个，船坞要 14）或拿不出 80×cpi 的施工费，都会在下一 tick 的 Phase 2 被**静默丢弃**，脚本拿不到回执。是否真成功只能下一 tick 看 `Game.plots` / `Game.buildings` 有没有变化，而且建厂还要等 `build_ticks` 才出现。',
      },
      {
        kind: 'links',
        items: [
          { label: 'Game.buyPlot', id: 'Game.buyPlot' },
          { label: 'Game.buildFacility', id: 'Game.buildFacility' },
          { label: 'Planet', id: 'Planet' },
          { label: 'Memory', id: 'Memory' },
        ],
      },
    ],
  },
  {
    id: 'example-quote',
    title: '盯盘：报价与盘口',
    group: '示例',
    kind: '章节',
    summary: '用 quote 与 depth 读价差和 5 档盘口，把阈值缓存进 Memory',
    keywords: '盯盘 报价 盘口 quote depth bestBid bestAsk 价差 ema 只读',
    blocks: [
      {
        kind: 'prose',
        text: '价差就是机会：`Game.market.quote` 给买卖一价、最新成交价与快慢 EMA，`Game.market.depth` 给买卖各 5 档。盯盘本身就是纯读，零写操作、零配额消耗，适合把阈值算好存进 `Memory`，让真正下单的脚本直接引用，避免每个 tick 重复判断。',
      },
      {
        kind: 'example',
        caption: 'main.js —— 只读，写操作 0 条',
        code: `// 只有读数，没有写操作；把判断结果存进 Memory 供其它脚本复用。
const WATCH = ['steel', 'building_mat', 'ore'];

module.exports.loop = function () {
  // 站点 id 是 'ST:' + 行星 id；默认世界母星轨道站是 ST:P1
  const home = 'ST:' + Game.company.homePlanetId;
  Memory.watch = Memory.watch || {};

  for (const item of WATCH) {
    const q = Game.market.quote(home, item);
    if (!q) continue;                       // 该站该物品还没报价时返回 null
    const spread = q.bestBid !== null && q.bestAsk !== null ? q.bestAsk - q.bestBid : null;
    const trend = q.emaFast >= q.emaSlow ? 'up' : 'down';
    // 盘口快照只存 5 档，limit 传更大也没用
    const d = Game.market.depth(home, item, 5);
    const ask3 = d.asks.slice(0, 3).reduce((s, l) => s + l.price * l.qty, 0);
    console.log(item, 'bid', q.bestBid, 'ask', q.bestAsk, 'spread', spread, trend, '卖3档值', ask3.toFixed(0));
    // emaSlow 下方 3% 视为低估、上方 3% 视为高估，交给补料脚本用
    Memory.watch[item] = { last: q.lastPrice, low: q.emaSlow * 0.97, high: q.emaSlow * 1.03, tick: Game.time };
  }
};`,
      },
      {
        kind: 'note',
        level: 'info',
        text: '`bestBid` / `bestAsk` 可能是 `null`（冷启动、单边或该物品没挂单），先判空再算价差，否则 `null - 1` 会算出 `-1` 这种假信号。`depth` 的快照只有 5 档，`limit` 传 50 也还是 5 档。盯盘不占写操作配额，但 `console` 每 tick 上限 200 行，别在循环里刷屏。',
      },
      {
        kind: 'links',
        items: [
          { label: 'Game.market.quote', id: 'Game.market.quote' },
          { label: 'Game.market.depth', id: 'Game.market.depth' },
          { label: 'Memory', id: 'Memory' },
          { label: 'Game.market.orders', id: 'Game.market.orders' },
        ],
      },
    ],
  },
  {
    id: 'example-restock',
    title: '补料：按配方挂买单',
    group: '示例',
    kind: '章节',
    summary: '遍历在用建筑、按配方输入算缺口、在母星轨道站挂买单，写操作计数 + break',
    keywords: '补料 原料 配方 getRecipe 买单 createOrder 缺口 库存 计数 break',
    blocks: [
      {
        kind: 'prose',
        text: '建筑按配方吃料，断料就停摆。对每栋在用建筑的 `recipe.inputs` 算缺口，补到 4 个周期的量，在母星轨道站挂买单。写操作必须自己数：够 8 张就 `break`，把剩下的 24 条配额留给派船、切配方这些更急的事。',
      },
      {
        kind: 'example',
        caption: 'main.js —— 写操作计数，最多 8 张买单',
        code: `// 按当前配方算缺口，在母星轨道站挂买单补料。
const HOME = 'ST:' + Game.company.homePlanetId;

module.exports.loop = function () {
  const buys = Object.keys(Game.market.orders).map((k) => Game.market.orders[k]);
  let writes = 0;                     // 本 tick 已用写操作数
  let cash = Game.company.cash;       // 本 tick 读到的都是开盘快照，预算要自己扣

  for (const id of Object.keys(Game.buildings)) {
    if (writes >= 8) break;           // 给自己 8 单，留余量给派船/切配方
    const b = Game.buildings[id];
    if (!b.active || !b.recipeId) continue;
    const recipe = Game.getRecipe(b.recipeId);
    if (!recipe) continue;

    for (const inp of recipe.inputs) {
      // 已挂未成交的量（amount = 剩余）也算在手库存
      const pending = buys
        .filter((o) => o.type === 'buy' && o.stationId === HOME && o.resourceType === inp.item)
        .reduce((s, o) => s + o.amount, 0);
      const have = Game.planets[b.planetId].groundStore.getUsedCapacity(inp.item) + pending;
      const need = inp.qty * 4 - have;        // 备 4 个周期的料
      if (need <= 0) continue;
      const q = Game.market.quote(HOME, inp.item);
      if (!q || q.bestAsk === null) continue;
      const price = q.bestAsk + 0.01, cost = need * price;   // 加一分钱抢卖一
      if (cash < cost) { console.log('现金不足', inp.item, cost); break; }
      const ret = Game.market.createOrder({ type: 'buy', resourceType: inp.item, price, totalAmount: need, stationId: HOME });
      if (ret === OK) { writes++; cash -= cost; }        // 写操作一处一处数
      else if (ret === ERR_FULL) return console.log('挂单满 64 张或本 tick 写满 32 条');
      else console.log('下单失败', inp.item, ret);       // -14 现金不足 / -7 站点或物品无效
    }
  }
  if (writes) console.log('本 tick 挂了', writes, '张买单，下一 tick 才出现在 orders 里');
};`,
      },
      {
        kind: 'note',
        level: 'warn',
        text: '`createOrder` 的买单在落账时按 `qty*price` 冻结现金，不够就返回 `ERR_NOT_ENOUGH_CREDITS`；活跃挂单上限 64 张，本 tick 写满 32 条也返回同一个 `ERR_FULL`。`Game.market.orders` 与 `Game.company.cash` 都是开盘快照——刚挂的单不在 `orders` 里，余额也不会变，所以预算必须用局部变量自己扣。注意引擎会拒绝与**自家反向单**交叉的新单（同站点同物品），JS 侧不判、返回 OK 后可能被静默丢弃。成交的料落在**轨道站仓**，要用船运下来才能进地面生产（见「物流」示例）。',
      },
      {
        kind: 'links',
        items: [
          { label: 'Game.getRecipe', id: 'Game.getRecipe' },
          { label: 'Game.market.createOrder', id: 'Game.market.createOrder' },
          { label: 'Game.market.quote', id: 'Game.market.quote' },
          { label: 'Game.buildings', id: 'Game.buildings' },
          { label: 'ERR_FULL', id: 'ERR_FULL' },
        ],
      },
    ],
  },
  {
    id: 'example-logistics',
    title: '物流：地面→轨道站套利',
    group: '示例',
    kind: '章节',
    summary: '地面产出运上轨道站再挂卖单：calcRoute 算燃料、dispatch 派船、船到了才卖',
    keywords: '物流 运输 派船 dispatch calcRoute 燃料 capacity 卖单 轨道站 套利',
    blocks: [
      {
        kind: 'prose',
        text: '产能在行星地面，市场却在轨道站，中间隔着一次 `dispatch`。正确顺序是先 `Game.market.calcRoute` 拿到这一程要烧多少燃料，确认出发地燃料和货物都够，再一次性把货塞上船；船到了站仓，`Game.stations` 里才有这家公司的库存记录，这时才能挂卖单卖掉。',
      },
      {
        kind: 'example',
        caption: 'main.js —— 最多 6 条写操作，一艘船一 tick 只派一次',
        code: `// 地面产出 → 运上轨道站 → 挂卖单。写操作计数 + break 是硬习惯。
const ITEMS = ['steel', 'building_mat'];

module.exports.loop = function () {
  const pid = Game.company.homePlanetId, home = 'ST:' + pid;   // 默认世界 P1 ↔ ST:P1
  const ground = Game.planets[pid].groundStore;
  const station = Game.stations[home];              // 只含本公司有仓记录的站，可能 undefined
  let writes = 0, shipUsed = false;                 // isBusy 是快照，同一艘船只能派一次

  for (const item of ITEMS) {
    if (writes >= 6) break;                         // 计数 + break，别撞 32 条上限
    const q = Game.market.quote(home, item);
    if (!q) continue;
    const stQty = station ? station.store.getUsedCapacity(item) : 0;

    // 1) 站上有货：就着买一价挂卖单（卖单只能从站仓出货）
    if (stQty >= 20 && q.bestBid !== null) {
      const ret = Game.market.createOrder({ type: 'sell', resourceType: item, price: q.bestBid, totalAmount: 20, stationId: home });
      if (ret === OK) writes++; else console.log('挂卖单失败', item, ret);
      continue;
    }

    // 2) 站上没货：先算路线拿燃料，再派船（出发地库存不足会被整单丢弃）
    if (shipUsed) continue;
    const ship = Object.keys(Game.ships).map((k) => Game.ships[k]).find((s) => !s.isBusy && s.location === pid);
    if (!ship) continue;
    const route = Game.market.calcRoute(pid, home);
    if (!route) continue;
    if (ground.getUsedCapacity('fuel') < route.fuel) { console.log(item, '燃料不够', route.fuel); continue; }
    const qty = Math.min(ground.getUsedCapacity(item), ship.capacity);
    if (qty <= 0) continue;
    const ret = ship.dispatch(pid, home, { [item]: qty });
    if (ret === OK) { writes++; shipUsed = true; console.log(item, '派船', qty, '燃料', route.fuel, '耗时', route.ticks); }
  }
};`,
      },
      {
        kind: 'note',
        level: 'danger',
        text: '出发地必须是船当前的 `location`（地面 `P1` 还是轨道 `ST:P1` 分得很清）；货量按**件数**计而不是体积，总和不能超过货舱**总容量**（小船 40 件）。燃料按路线从**出发地仓**扣：缺燃料会在 JS 层直接返回 `ERR_NOT_ENOUGH_RESOURCES`(-6)；只有货物不足才是返回 `OK` 后在落地阶段被静默丢弃。另外 `calcRoute` 的 `fuel` 是按小船 × 100 耐久估算的近似值，中大船或低耐久船要按实际船型多备油。回程也要油：船停在轨道站后，从那里出发还得站仓里有燃料。',
      },
      {
        kind: 'links',
        items: [
          { label: 'Game.market.calcRoute', id: 'Game.market.calcRoute' },
          { label: 'Ship.dispatch', id: 'Ship' },
          { label: 'Game.market.createOrder', id: 'Game.market.createOrder' },
          { label: 'Game.stations', id: 'Game.stations' },
          { label: 'Store', id: 'Store' },
        ],
      },
    ],
  },
];

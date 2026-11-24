import type { DocEntry } from '../types';

const MATRIX: DocEntry = {
  id: 'error-matrix',
  title: '错误码速查',
  group: '错误码',
  kind: '章节',
  summary: '每个写方法可能返回哪些错误码',
  keywords: '错误码 返回码 err 速查 矩阵 失败',
  blocks: [
    {
      kind: 'prose',
      text: '写方法的返回值只可能是 `OK`（0）或下表里的负数错误码。检查返回码是脚本的第一道防线；但**即使返回 OK，落地阶段仍可能失败**（资金、库存、仓位），失败不会回传。',
    },
    {
      kind: 'table',
      headers: ['方法', '可能返回', '触发条件'],
      rows: [
        ['Building.setRecipe', 'ERR_INVALID_ARGS · ERR_NOT_OWNER · ERR_NOT_FOUND · ERR_INVALID_TARGET · ERR_FULL', '参数非法 / 不是自己的设施 / 配方不存在 / 配方与建筑类型不匹配 / Intent 满'],
        ['Building.setActive', 'ERR_INVALID_ARGS · ERR_NOT_OWNER · ERR_FULL', '参数不是 boolean / 不是自己的设施 / Intent 满'],
        ['Ship.dispatch', 'ERR_INVALID_ARGS · ERR_NOT_OWNER · ERR_BUSY · ERR_NOT_IN_RANGE · ERR_NO_PATH · ERR_FULL · ERR_NOT_ENOUGH_RESOURCES', '参数或货物非法 / 不是自己的船 / 航行中 / 不在出发地 / 无航线 / 超载或 Intent 满 / 出发地燃料不足'],
        ['Ship.repair', 'ERR_INVALID_ARGS · ERR_NOT_OWNER · ERR_BUSY · ERR_FULL', '参数非法 / 不是自己的船 / 航行中 / Intent 满'],
        ['Game.market.createOrder', 'ERR_INVALID_ARGS · ERR_INVALID_TARGET · ERR_NOT_ENOUGH_CREDITS · ERR_FULL', '字段非法 / 物品或站点无报价 / 买单现金不足 / 挂单或 Intent 满'],
        ['Game.market.cancelOrder', 'ERR_INVALID_ARGS · ERR_NOT_FOUND · ERR_FULL', 'id 非法 / 不在自己的挂单里 / Intent 满'],
        ['Game.market.deal', 'ERR_INVALID_ARGS · ERR_NOT_FOUND · ERR_FULL', '数量或 id 非法 / 订单已不存在 / Intent 满'],
        ['Game.buyPlot', 'ERR_NOT_FOUND · ERR_INVALID_ARGS · ERR_FULL', '行星不存在 / listingId 非法 / Intent 满'],
        ['Game.buildFacility', 'ERR_INVALID_ARGS · ERR_NOT_OWNER · ERR_INVALID_TARGET · ERR_FULL', 'id 非法 / 地块不是自己的 / 建筑类型不存在 / Intent 满'],
        ['Game.demolishFacility', 'ERR_INVALID_ARGS · ERR_NOT_OWNER · ERR_FULL', 'id 非法 / 地块不是自己的 / Intent 满'],
        ['Game.bank', 'ERR_INVALID_ARGS · ERR_FULL', '行星不存在、op 非法或金额 ≤ 0 / Intent 满'],
      ],
    },
    {
      kind: 'links',
      items: [
        { label: '执行模型', id: 'overview/execution' },
        { label: 'quotas', id: 'quotas' },
        { label: 'OK', id: 'OK' },
      ],
    },
  ],
};

interface ErrorDef {
  code: string;
  value: number;
  summary: string;
  when: string;
  keywords: string;
  related: Array<[string, string]>;
}

const ERROR_DEFS: ErrorDef[] = [
  {
    code: 'ERR_NOT_OWNER',
    value: -1,
    summary: '目标不属于自己',
    when: '操作别人的设施、飞船或地块：改配方、派船、在别人的地块上建造。',
    keywords: '无权限 不是自己的 归属',
    related: [
      ['Building', 'Building'],
      ['Ship', 'Ship'],
      ['Game.buildFacility', 'Game.buildFacility'],
    ],
  },
  {
    code: 'ERR_NO_PATH',
    value: -2,
    summary: '没有可行航线',
    when: '计算或派船时两地之间不存在可行航线。',
    keywords: '航线 路径 不可达',
    related: [
      ['Ship', 'Ship'],
      ['Game.market.calcRoute', 'Game.market.calcRoute'],
    ],
  },
  {
    code: 'ERR_BUSY',
    value: -4,
    summary: '飞船正在航行',
    when: '对航行中的飞船再次派活或修理。到达后 isBusy 自动变回 false。',
    keywords: '忙 航行中 运输',
    related: [['Ship', 'Ship']],
  },
  {
    code: 'ERR_NOT_FOUND',
    value: -5,
    summary: '目标不存在',
    when: '行星、配方、订单不存在，或订单不在自己的活跃挂单里。',
    keywords: '找不到 不存在 订单 配方',
    related: [
      ['Game.market.cancelOrder', 'Game.market.cancelOrder'],
      ['Game.market.deal', 'Game.market.deal'],
      ['Game.buyPlot', 'Game.buyPlot'],
    ],
  },
  {
    code: 'ERR_NOT_ENOUGH_RESOURCES',
    value: -6,
    summary: '出发地燃料不足',
    when: '派船时出发地没有足够燃料（仅当 production pack 配置了燃料物品才会出现）。',
    keywords: '燃料 油 库存不足',
    related: [
      ['Ship', 'Ship'],
      ['Game.market.calcRoute', 'Game.market.calcRoute'],
    ],
  },
  {
    code: 'ERR_INVALID_TARGET',
    value: -7,
    summary: '目标类型不对',
    when: '配方与建筑类型不匹配、物品未知、站点没有该物品报价、建筑类型不存在。',
    keywords: '目标 无效 配方 建筑 物品',
    related: [
      ['Game.market.createOrder', 'Game.market.createOrder'],
      ['Game.buildFacility', 'Game.buildFacility'],
      ['Building', 'Building'],
    ],
  },
  {
    code: 'ERR_FULL',
    value: -8,
    summary: 'Intent 或挂单名额已满',
    when: '本 tick 已提交 32 条写操作，或公司活跃挂单已达到 64 条。',
    keywords: '满了 上限 32 64 配额',
    related: [
      ['quotas', 'quotas'],
      ['Game.market.createOrder', 'Game.market.createOrder'],
    ],
  },
  {
    code: 'ERR_NOT_IN_RANGE',
    value: -9,
    summary: '飞船不在给定出发点',
    when: 'dispatch 的 from 与飞船当前 location 不一致。',
    keywords: '位置 距离 出发地',
    related: [['Ship', 'Ship']],
  },
  {
    code: 'ERR_INVALID_ARGS',
    value: -10,
    summary: '参数类型或数值非法',
    when: '缺参、类型不对、数量不是正数、id 解析失败等。',
    keywords: '参数 非法 类型 数值',
    related: [
      ['Game.market.createOrder', 'Game.market.createOrder'],
      ['Game.bank', 'Game.bank'],
    ],
  },
  {
    code: 'ERR_NOT_ENOUGH_CREDITS',
    value: -14,
    summary: '现金不足',
    when: '买单下单时现金不够 price × totalAmount（卖单不看现金）。',
    keywords: '钱 现金 余额 不足',
    related: [
      ['Game.market.createOrder', 'Game.market.createOrder'],
      ['Game.market.credits', 'Game.market.credits'],
    ],
  },
];

function errorEntry(def: ErrorDef): DocEntry {
  return {
    id: def.code,
    title: def.code,
    group: '错误码',
    kind: '常量',
    summary: def.summary + '（' + def.value + '）',
    keywords: def.keywords + ' ' + def.code + ' ' + def.value,
    blocks: [
      { kind: 'prose', text: def.when },
      { kind: 'syntax', code: def.code + ' // ' + def.value },
      {
        kind: 'links',
        items: [
          { label: '错误码速查', id: 'error-matrix' },
          ...def.related.map(([label, id]) => ({ label, id })),
        ],
      },
    ],
  };
}

export const ERROR_ENTRIES: DocEntry[] = [MATRIX, ...ERROR_DEFS.map(errorEntry)];

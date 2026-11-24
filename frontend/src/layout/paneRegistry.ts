import type { CatalogIndex } from '../entities/catalogIndex';
import type { WorldIndex } from '../entities/worldIndex';
import { docTitle } from '../docs/apiDocs';

export type PaneKind =
  | 'orbit'
  | 'planet'
  | 'land'
  | 'demand'
  | 'factory'
  | 'cargo'
  | 'fleet'
  | 'ticker'
  | 'chart'
  | 'orderbook'
  | 'items'
  | 'item'
  | 'treasury'
  | 'ranking'
  | 'company'
  | 'files'
  | 'script'
  | 'memory'
  | 'console'
  | 'apidocs'
  | 'settings';

export interface PaneParams {
  planetId?: string;
  slotId?: number;
  companyId?: string;
  locationId?: string;
  stationId?: string;
  itemId?: string;
  buildingId?: string;
  recipeId?: string;
  /** API 文档窗口当前条目 id，如 'Game.market.createOrder'；undefined = 默认条目。 */
  docId?: string;
}

export interface PaneProps {
  params: PaneParams;
  /**
   * The pane's params are its identity. Panels must write entity changes here instead of keeping a
   * private copy in local state, so titles, deep links and restored workspaces all stay truthful.
   */
  setParams: (patch: Partial<PaneParams>) => void;
  /** Replace this pane's content in place (drill down without spawning another window). */
  openInPlace: (kind: PaneKind, params?: PaneParams) => void;
  openTemp: (kind: PaneKind, params?: PaneParams) => void;
}

export interface TileContent {
  kind: PaneKind;
  params: PaneParams;
  /** @deprecated Titles are derived from `(kind, params)`; kept only to read old saved workspaces. */
  title?: string;
}

export interface FloatingWindowItem {
  id: string;
  kind: PaneKind;
  params: PaneParams;
  /** @deprecated see TileContent.title */
  title?: string;
  x: number;
  y: number;
  w: number;
  h: number;
  z: number;
}

export interface PaneMeta {
  kind: PaneKind;
  label: string;
  description: string;
  /** Grouping for the command palette / empty-tile picker. */
  group: '观察' | '生产' | '贸易' | '财务' | '开发' | '系统';
  keywords?: string;
}

export const PANE_CATALOG: PaneMeta[] = [
  { kind: 'orbit', label: '星系轨道雷达', description: '观察行星公转与中心枢纽相对位置', group: '观察' },
  { kind: 'planet', label: '行星遥测', description: '星球信息、环境储备与 3D 地貌', group: '观察' },
  { kind: 'land', label: '行星地块', description: '全星公有空地、城市与企业地块分布及购买 ID', group: '观察', keywords: '地块 土地 坐标 slot listing 地形 加成 购买' },
  { kind: 'demand', label: '城市需求', description: '本回合城市消费需求与本地报价', group: '观察' },
  { kind: 'items', label: '物品总表', description: '全物品检索：持有、挂单、行情、用途', group: '观察', keywords: '物品 目录 索引 搜索 全部' },
  { kind: 'item', label: '物品详情', description: '单个物品的配方、库存分布、全站行情、我的挂单', group: '观察', keywords: '物品 详情 配方 用途' },
  { kind: 'factory', label: '工厂产线', description: '地块槽位、建筑建造与热切配方', group: '生产' },
  { kind: 'cargo', label: '仓库库存', description: '查看任一地点库存（可搜索/只看有货）', group: '生产' },
  { kind: 'fleet', label: '舰队调度', description: '飞船状态、混装派船运输与修船', group: '生产' },
  { kind: 'ticker', label: '全站行情', description: '按站点查看买一/卖一/最新价（可搜索排序）', group: '贸易' },
  { kind: 'chart', label: 'K线图', description: '蜡烛图、均线与成交量（可多开并排盯盘）', group: '贸易' },
  { kind: 'orderbook', label: '盘口深度', description: '实时买卖深度、成交流水与手工限价下单', group: '贸易' },
  { kind: 'treasury', label: '央行与财务', description: '现金、储蓄、借贷与母星央行存贷', group: '财务' },
  { kind: 'ranking', label: '势力排行', description: '玩家与 NPC 公开净流动资产、母星与资产规模排行', group: '财务' },
  { kind: 'company', label: '公司详情', description: '搜索任意公司，查看公开净流动资产、地块设施、舰队规模与挂单', group: '观察', keywords: '公司 企业 npc 搜索 详情 地块 挂单 资产' },
  { kind: 'files', label: '代码文件', description: '脚本模块树管理', group: '开发' },
  { kind: 'script', label: '脚本编辑器', description: '多模块 JS 策略 IDE 与热重载', group: '开发' },
  { kind: 'memory', label: 'Memory 内存', description: '查看、搜索与编辑 128KB 持久化 JSON', group: '开发' },
  { kind: 'console', label: '控制台', description: 'F12 交互式 JS 命令行与沙盒实时日志流', group: '开发' },
  {
    kind: 'apidocs',
    label: 'API 参考',
    description: '玩家脚本 Game / Memory / 错误码速查与可复制示例',
    group: '开发',
    keywords: 'api 文档 手册 game memory console require store 接口 参考 js 脚本 错误码',
  },
  { kind: 'settings', label: '个人设置', description: '账号信息、昵称密码与登录会话管理', group: '系统', keywords: '设置 账号 昵称 密码 会话 登出 关于' },
];

export const PANE_META_BY_KIND: Record<PaneKind, PaneMeta> = PANE_CATALOG.reduce(
  (acc, meta) => {
    acc[meta.kind] = meta;
    return acc;
  },
  {} as Record<PaneKind, PaneMeta>,
);

export interface TitleContext {
  catalog: CatalogIndex;
  world: WorldIndex;
}

const NOT_CHOSEN = '未选择';

function itemTitle(catalog: CatalogIndex, itemId?: string): string {
  if (!itemId) return NOT_CHOSEN;
  return catalog.itemName(itemId);
}

/**
 * Titles are always derived from the pane's params — never stored. Storing them (the previous
 * behaviour) meant a title could keep naming entity A while the pane showed entity B.
 */
export function paneTitle(kind: PaneKind, params: PaneParams | undefined, ctx: TitleContext): string {
  const p = params ?? {};
  const { catalog, world } = ctx;
  switch (kind) {
    case 'orbit':
      return '星系轨道';
    case 'planet':
      return `行星 · ${p.planetId ? world.planetName(p.planetId) : NOT_CHOSEN}`;
    case 'land':
      return `地块 · ${p.planetId ? world.planetName(p.planetId) : NOT_CHOSEN}`;
    case 'demand':
      return `需求 · ${p.planetId ? world.planetName(p.planetId) : NOT_CHOSEN}`;
    case 'factory':
      return `产线 · ${p.planetId ? world.planetName(p.planetId) : NOT_CHOSEN}`;
    case 'cargo':
      return `仓库 · ${p.locationId ? world.locationLabel(p.locationId) : NOT_CHOSEN}`;
    case 'fleet':
      return '舰队调度';
    case 'ticker':
      return `行情 · ${p.stationId ? world.stationLabel(p.stationId) : NOT_CHOSEN}`;
    case 'chart':
    case 'orderbook': {
      const prefix = kind === 'chart' ? 'K线' : '盘口';
      const station = p.stationId ? world.stationLabel(p.stationId) : NOT_CHOSEN;
      return `${prefix} · ${itemTitle(catalog, p.itemId)} @ ${station}`;
    }
    case 'items':
      return '物品总表';
    case 'item':
      return `物品 · ${itemTitle(catalog, p.itemId)}`;
    case 'treasury':
      return `财务 · ${p.planetId ? world.planetName(p.planetId) : '母星'}`;
    case 'ranking':
      return '势力排行';
    case 'company':
      return `公司 · ${p.companyId ? world.companyName(p.companyId) : NOT_CHOSEN}`;
    case 'files':
      return '代码文件';
    case 'script':
      return '脚本编辑器';
    case 'memory':
      return 'Memory 内存';
    case 'console':
      return '控制台';
    case 'apidocs':
      return p.docId ? `API · ${docTitle(p.docId)}` : 'API 参考';
    case 'settings':
      return '设置';
    default:
      return kind;
  }
}

/** Params a pane should open with when the caller did not specify one (never a hardcoded entity). */
export function focusDefaults(kind: PaneKind, focus: PaneParams): PaneParams {
  switch (kind) {
    case 'planet':
    case 'land':
    case 'demand':
    case 'factory':
    case 'treasury':
      return focus.planetId ? { planetId: focus.planetId } : {};
    case 'cargo':
      return focus.locationId ? { locationId: focus.locationId } : {};
    case 'ticker':
      return focus.stationId ? { stationId: focus.stationId } : {};
    case 'chart':
    case 'orderbook': {
      const out: PaneParams = {};
      if (focus.stationId) out.stationId = focus.stationId;
      if (focus.itemId) out.itemId = focus.itemId;
      return out;
    }
    case 'item':
      return focus.itemId ? { itemId: focus.itemId } : {};
    case 'company':
      return focus.companyId ? { companyId: focus.companyId } : {};
    default:
      return {};
  }
}

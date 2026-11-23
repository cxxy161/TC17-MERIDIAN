import { STATION_NAMES } from '../types/meridian';

export type PaneKind =
  | 'orbit'
  | 'planet'
  | 'demand'
  | 'factory'
  | 'cargo'
  | 'fleet'
  | 'ticker'
  | 'chart'
  | 'orderbook'
  | 'treasury'
  | 'ranking'
  | 'files'
  | 'script'
  | 'memory'
  | 'console';

export interface PaneParams {
  planetId?: string;
  locationId?: string;
  stationId?: string;
  itemId?: string;
}

export interface PaneProps {
  params: PaneParams;
  setTitle: (title: string) => void;
  openTemp: (kind: PaneKind, params?: PaneParams) => void;
}

export interface TileContent {
  kind: PaneKind;
  params: PaneParams;
  title?: string;
}

export interface FloatingWindowItem {
  id: string;
  kind: PaneKind;
  params: PaneParams;
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
  defaultParams?: PaneParams;
}

export const PANE_CATALOG: PaneMeta[] = [
  { kind: 'orbit', label: '星系轨道雷达', description: '观察行星实时公转与中心枢纽相对位置' },
  { kind: 'planet', label: '行星遥测', description: '查看星球信息、环境储备与 3D 球体地貌', defaultParams: { planetId: 'P2' } },
  { kind: 'demand', label: '城市需求', description: '查看星球本回合城市消费挂单需求与本地报价', defaultParams: { planetId: 'P2' } },
  { kind: 'factory', label: '工厂产线', description: '管理地块槽位、建筑建造与热切配方', defaultParams: { planetId: 'P1' } },
  { kind: 'cargo', label: '仓库库存', description: '查看地表、行星轨道站或中心枢纽库存', defaultParams: { locationId: 'P1' } },
  { kind: 'fleet', label: '舰队调度', description: '飞船状态、混装派船运输与修船' },
  { kind: 'ticker', label: '全站行情', description: '全品类买一/卖一/最新价与 50 回合量', defaultParams: { stationId: 'ST:HUB' } },
  { kind: 'chart', label: 'K线图', description: '蜡烛图、均线与成交量（可多开并排盯盘）', defaultParams: { stationId: 'ST:HUB', itemId: 'steel' } },
  { kind: 'orderbook', label: '盘口深度', description: '实时买卖深度、成交流水与手工限价下单', defaultParams: { stationId: 'ST:HUB', itemId: 'steel' } },
  { kind: 'treasury', label: '央行与财务', description: '现金、储蓄、借贷与行星央行存贷操作', defaultParams: { planetId: 'P1' } },
  { kind: 'ranking', label: '势力排行', description: '玩家与演化 NPC 净资产排名及货币守恒审计' },
  { kind: 'files', label: '代码文件', description: '类 VS Code 文件夹与脚本模块树管理' },
  { kind: 'script', label: '脚本编辑器', description: 'Screeps 风格多模块 JS 策略 IDE 与热重载' },
  { kind: 'memory', label: 'Memory 内存', description: '独立查看、搜索与编辑 128KB 持久化 JSON' },
  { kind: 'console', label: '控制台', description: 'F12 交互式 JS 命令行与沙盒实时日志流' },
];

export function formatPaneTitle(kind: PaneKind, params: PaneParams): string {
  const planetLabels: Record<string, string> = {
    P1: '灼热矿星-I',
    P2: '新伊甸-II',
    P3: '凛冬外星-III',
  };
  switch (kind) {
    case 'orbit':
      return '星系轨道';
    case 'planet': {
      const pid = params.planetId || 'P2';
      return `行星 · ${planetLabels[pid] ?? pid}`;
    }
    case 'demand': {
      const pid = params.planetId || 'P2';
      return `消费需求 · ${planetLabels[pid] ?? pid}`;
    }
    case 'factory': {
      const pid = params.planetId || 'P1';
      return `产线 · ${planetLabels[pid] ?? pid}`;
    }
    case 'cargo': {
      const loc = params.locationId || 'P1';
      return `仓库 · ${STATION_NAMES[loc] ?? planetLabels[loc] ?? loc}`;
    }
    case 'fleet':
      return '舰队调度';
    case 'ticker': {
      const sid = params.stationId || 'ST:HUB';
      return `行情 · ${STATION_NAMES[sid] ?? sid}`;
    }
    case 'chart': {
      const sid = params.stationId || 'ST:HUB';
      const item = params.itemId || 'steel';
      return `K线 · ${item} @ ${sid === 'ST:HUB' ? '枢纽' : sid}`;
    }
    case 'orderbook': {
      const sid = params.stationId || 'ST:HUB';
      const item = params.itemId || 'steel';
      return `盘口 · ${item} @ ${sid === 'ST:HUB' ? '枢纽' : sid}`;
    }
    case 'treasury': {
      const pid = params.planetId || 'P1';
      return `财务 · ${planetLabels[pid] ?? pid}`;
    }
    case 'ranking':
      return '势力排行';
    case 'files':
      return '代码文件';
    case 'script':
      return '脚本编辑器';
    case 'memory':
      return 'Memory 内存';
    case 'console':
      return '控制台';
  }
}

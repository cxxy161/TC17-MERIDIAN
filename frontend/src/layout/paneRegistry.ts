import type { DockviewApi } from 'dockview-react';
import { STATION_NAMES } from '../types/meridian';

export type PaneKind =
  | 'orbit'
  | 'planet'
  | 'factory'
  | 'cargo'
  | 'fleet'
  | 'ticker'
  | 'chart'
  | 'orderbook'
  | 'treasury'
  | 'ranking'
  | 'script'
  | 'console';

export interface PaneParams {
  planetId?: string;
  locationId?: string;
  stationId?: string;
  itemId?: string;
}

export interface PaneMeta {
  kind: PaneKind;
  label: string;
  description: string;
}

export const PANE_CATALOG: PaneMeta[] = [
  { kind: 'orbit', label: '星系轨道雷达', description: '观察行星实时公转与中心枢纽相对位置' },
  { kind: 'planet', label: '行星遥测', description: '查看星球资源修正、人口需求与土地挂牌' },
  { kind: 'factory', label: '工厂产线', description: '管理地块槽位、建筑建造与热切配方' },
  { kind: 'cargo', label: '仓库库存', description: '查看地表、行星轨道站或中心枢纽库存' },
  { kind: 'fleet', label: '舰队调度', description: '飞船状态、混装派船运输与修船' },
  { kind: 'ticker', label: '全站行情', description: '全品类买一/卖一/最新价与 50 回合量' },
  { kind: 'chart', label: 'K线图', description: '蜡烛图、均线与成交量（可多开并排盯盘）' },
  { kind: 'orderbook', label: '盘口深度', description: '实时买卖深度、成交流水与手工限价下单' },
  { kind: 'treasury', label: '央行与财务', description: '现金、储蓄、借贷与行星央行存贷操作' },
  { kind: 'ranking', label: '势力排行', description: '玩家与演化 NPC 净资产排名及货币守恒审计' },
  { kind: 'script', label: '脚本编辑器', description: 'Screeps 风格多模块 JS 策略 IDE 与热重载' },
  { kind: 'console', label: '遥测终端', description: '脚本 console 输出、CPU 耗时与撮合事件流' },
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
    case 'script':
      return '脚本编辑器';
    case 'console':
      return '遥测终端';
  }
}

let seqCounter = 1;

export function openPane(
  api: DockviewApi | null,
  kind: PaneKind,
  params: PaneParams = {},
  options?: { floating?: boolean; referencePanelId?: string; direction?: 'left' | 'right' | 'above' | 'below' | 'within' },
): string | null {
  if (!api) return null;
  const id = `${kind}-${Date.now()}-${seqCounter++}`;
  const title = formatPaneTitle(kind, params);

  if (options?.floating) {
    api.addPanel({
      id,
      component: kind,
      title,
      params,
      floating: { width: 460, height: 380, x: 140, y: 90 },
    });
    return id;
  }

  api.addPanel({
    id,
    component: kind,
    title,
    params,
    position: options?.referencePanelId
      ? {
          referencePanel: options.referencePanelId,
          direction: options.direction ?? 'right',
        }
      : undefined,
  });
  return id;
}

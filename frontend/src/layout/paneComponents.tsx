import React from 'react';
import type { PaneKind, PaneParams, PaneProps, TileContent } from './paneRegistry';
import { useEntitySearch } from './entitySearch';
import { EntitySearchList } from './EntitySearchList';

import { OrbitPanel } from '../panels/OrbitPanel';
import { PlanetPanel } from '../panels/PlanetPanel';
import { LandPanel } from '../panels/LandPanel';
import { DemandPanel } from '../panels/DemandPanel';
import { FactoryPanel } from '../panels/FactoryPanel';
import { CargoPanel } from '../panels/CargoPanel';
import { FleetPanel } from '../panels/FleetPanel';
import { TickerPanel } from '../panels/TickerPanel';
import { ChartPanel } from '../panels/ChartPanel';
import { OrderBookPanel } from '../panels/OrderBookPanel';
import { ItemListPanel } from '../panels/ItemListPanel';
import { ItemDetailPanel } from '../panels/ItemDetailPanel';
import { TreasuryPanel } from '../panels/TreasuryPanel';
import { RankingPanel } from '../panels/RankingPanel';
import { ScriptIdePanel } from '../panels/ScriptIdePanel';
import { ConsolePanel } from '../panels/ConsolePanel';
import { ApiDocsPanel } from '../panels/ApiDocsPanel';
import { FileExplorerPanel } from '../panels/FileExplorerPanel';
import { MemoryPanel } from '../panels/MemoryPanel';
import { SettingsPanel } from '../panels/SettingsPanel';

const PANEL_COMPONENTS: Record<PaneKind, React.FC<PaneProps>> = {
  orbit: OrbitPanel,
  planet: PlanetPanel,
  land: LandPanel,
  demand: DemandPanel,
  factory: FactoryPanel,
  cargo: CargoPanel,
  fleet: FleetPanel,
  ticker: TickerPanel,
  chart: ChartPanel,
  orderbook: OrderBookPanel,
  items: ItemListPanel,
  item: ItemDetailPanel,
  treasury: TreasuryPanel,
  ranking: RankingPanel,
  files: FileExplorerPanel,
  script: ScriptIdePanel,
  memory: MemoryPanel,
  console: ConsolePanel,
  apidocs: ApiDocsPanel,
  settings: SettingsPanel,
};

export const PaneRenderer: React.FC<{
  kind: PaneKind;
  params: PaneParams;
  setParams: (patch: Partial<PaneParams>) => void;
  openInPlace: (kind: PaneKind, params?: PaneParams) => void;
  openTemp: (kind: PaneKind, params?: PaneParams) => void;
}> = ({ kind, params, setParams, openInPlace, openTemp }) => {
  const Comp = PANEL_COMPONENTS[kind];
  if (!Comp) {
    return <div className="p-3 text-rose-400">未知面板类型：{kind}</div>;
  }
  return <Comp params={params} setParams={setParams} openInPlace={openInPlace} openTemp={openTemp} />;
};

export const EmptyTilePane: React.FC<{ onSelect: (content: TileContent) => void }> = ({ onSelect }) => {
  const options = useEntitySearch();
  return (
    <div className="h-full flex flex-col bg-[#1b212b] overflow-hidden">
      <div className="px-2.5 pt-2 text-[10px] text-slate-500 shrink-0">
        空窗口 · 搜索并选择要显示的内容，或把任意临时悬浮窗拖进来覆盖。
      </div>
      <EntitySearchList
        options={options}
        onPick={(opt) => onSelect(opt.content)}
        autoFocus
        className="flex-1 min-h-0"
      />
    </div>
  );
};

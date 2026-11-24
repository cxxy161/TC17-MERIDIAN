import { useMemo } from 'react';
import { useCatalogIndex, useWorldIndex } from '../entities/hooks';
import { PANE_CATALOG, type TileContent } from './paneRegistry';

export interface EntityOption {
  key: string;
  group: string;
  label: string;
  sub?: string;
  keywords?: string;
  badge?: string;
  content: TileContent;
}

export const GROUP_ALL = '全部';

/**
 * One search index for every entity in the game plus every pane type.
 *
 * Previously the command palette and the empty-tile picker each built their own list, each truncated
 * it (14/16 rows and "first 10 items"), and neither could be reached by name. This is the single
 * source both use, with a group facet and no cap.
 */
export function useEntitySearch(): EntityOption[] {
  const catalog = useCatalogIndex();
  const world = useWorldIndex();

  return useMemo(() => {
    const list: EntityOption[] = [];

    for (const meta of PANE_CATALOG) {
      list.push({
        key: `pane-${meta.kind}`,
        group: '功能窗口',
        label: meta.label,
        sub: meta.description,
        keywords: `${meta.group} ${meta.keywords ?? ''}`,
        badge: meta.group,
        content: { kind: meta.kind, params: {} },
      });
    }

    for (const item of catalog.items) {
      const category = catalog.categoryName(item.demand_category);
      const facets = [
        catalog.roleLabel(item.role),
        catalog.professionName(item.profession),
        category ?? '',
        ...(item.tags ?? []),
        item.id,
      ]
        .filter(Boolean)
        .join(' ');
      list.push({
        key: `item-${item.id}`,
        group: '物品',
        label: item.name,
        sub: [category, catalog.roleLabel(item.role)].filter(Boolean).join(' · '),
        keywords: facets,
        badge: catalog.isInstant(item.id) ? '瞬时' : undefined,
        content: { kind: 'item', params: { itemId: item.id } },
      });
    }

    for (const planet of world.planets) {
      list.push({
        key: `planet-${planet.id}`,
        group: '行星',
        label: planet.name,
        sub: `人口 ${Math.round(planet.population).toLocaleString()} · 繁荣 ${planet.prosperity.toFixed(2)}x · ${planet.id}`,
        keywords: `${planet.id} ${planet.archetype} 行星 星球`,
        badge: planet.archetype,
        content: { kind: 'planet', params: { planetId: planet.id } },
      });
      list.push({
        key: `planet-factory-${planet.id}`,
        group: '行星',
        label: `产线 · ${planet.name}`,
        sub: '设施与配方切换',
        keywords: `${planet.id} 工厂 产线`,
        content: { kind: 'factory', params: { planetId: planet.id } },
      });
      list.push({
        key: `planet-land-${planet.id}`,
        group: '行星',
        label: `地块 · ${planet.name}`,
        sub: '公开地块分布、地形加成与位置 ID',
        keywords: `${planet.id} 地块 土地 slot listing 坐标`,
        content: { kind: 'land', params: { planetId: planet.id } },
      });
    }

    for (const loc of world.locations) {
      list.push({
        key: `loc-${loc.id}`,
        group: '地点',
        label: loc.label,
        sub: loc.kind === 'planet' ? '地表仓库' : loc.isHub ? '中心枢纽站仓库' : '轨道站仓库',
        keywords: `${loc.id} 仓库 库存 地点`,
        badge: loc.kind === 'planet' ? '地表' : '站点',
        content: { kind: 'cargo', params: { locationId: loc.id } },
      });
    }

    for (const station of world.stations) {
      list.push({
        key: `station-${station.id}`,
        group: '地点',
        label: `行情 · ${station.label}`,
        sub: `${station.id} 全部物品买一/卖一`,
        keywords: `${station.id} 行情 市场 交易所`,
        content: { kind: 'ticker', params: { stationId: station.id } },
      });
    }

    for (let i = 0; i < world.companies.length; i += 1) {
      const c = world.companies[i];
      const homeName = world.planetName(c.home_planet_id);
      list.push({
        key: `company-${c.id}`,
        group: '公司',
        label: c.name,
        sub: `#${i + 1} · ${homeName} · 净流动 ${c.net_liquid.toLocaleString(undefined, { maximumFractionDigits: 1 })} · 地块 ${c.plots_count} · 飞船 ${c.ships_count}`,
        keywords: `${c.id} ${c.name} ${c.home_planet_id} ${homeName} 公司 企业 ${c.is_player ? '玩家 player' : 'npc'}`,
        badge: c.is_player ? '玩家' : 'NPC',
        content: { kind: 'company', params: { companyId: c.id } },
      });
    }

    return list;
  }, [catalog, world.planets, world.locations, world.stations, world.companies]);
}

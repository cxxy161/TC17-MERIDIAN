import type {
  BuildingDef,
  DemandCategoryDef,
  ItemDef,
  ProductionPack,
  ProfessionDef,
  RecipeDef,
} from '../types/meridian';

/** Labels for the schema-level item roles. Unknown roles fall through to their raw id. */
const ROLE_LABELS: Record<string, string> = {
  foundation: '能源基础',
  factory_consume: '工业材料',
  planet_supply: '城市消费',
  capital: '资本设备',
  byproduct: '环保副产',
};

const ROLE_ORDER = ['foundation', 'factory_consume', 'planet_supply', 'capital', 'byproduct'];

/**
 * Tags that make an item an *instant* good: it never needs a ship, it is listed and settled
 * directly from the planet surface. Mirrors `ProductionCatalog::is_instant_item` in
 * meridian-core/src/schema.rs — this used to be duplicated (and wrong) in FleetPanel, which
 * silently treated instant goods as shippable cargo.
 */
const INSTANT_TAGS = ['power', 'waste_service'];

export interface CatalogFacetValue {
  id: string;
  label: string;
  count: number;
}

export interface CatalogIndex {
  ready: boolean;
  pack: ProductionPack | null;
  ticksPerDay: number;
  items: ItemDef[];
  buildings: BuildingDef[];
  recipes: RecipeDef[];
  professions: ProfessionDef[];
  categories: DemandCategoryDef[];
  byId: Map<string, ItemDef>;
  buildingById: Map<string, BuildingDef>;
  recipeById: Map<string, RecipeDef>;
  professionById: Map<string, ProfessionDef>;
  recipesByBuilding: Map<string, RecipeDef[]>;
  /** itemId -> recipes that output it */
  recipesProducing: Map<string, RecipeDef[]>;
  /** itemId -> recipes that consume it */
  recipesConsuming: Map<string, RecipeDef[]>;
  item(id: string | null | undefined): ItemDef | undefined;
  itemName(id: string | null | undefined): string;
  building(id: string | null | undefined): BuildingDef | undefined;
  buildingName(id: string | null | undefined): string;
  recipe(id: string | null | undefined): RecipeDef | undefined;
  recipeName(id: string | null | undefined): string;
  professionName(id: string | null | undefined): string;
  categoryName(id: string | null | undefined): string | null;
  roleLabel(role: string): string;
  facets: {
    category: CatalogFacetValue[];
    role: CatalogFacetValue[];
    profession: CatalogFacetValue[];
    tier: CatalogFacetValue[];
    tag: CatalogFacetValue[];
  };
  isInstant(itemId: string | null | undefined): boolean;
  isShippable(itemId: string | null | undefined): boolean;
}

function incr<K>(map: Map<K, number>, key: K): void {
  map.set(key, (map.get(key) ?? 0) + 1);
}

function pushTo<K, V>(map: Map<K, V[]>, key: K, value: V): void {
  const cur = map.get(key);
  if (cur) cur.push(value);
  else map.set(key, [value]);
}

function facet(
  counts: Map<string, number>,
  label: (id: string) => string,
  order?: string[],
): CatalogFacetValue[] {
  const out = [...counts.entries()].map(([id, count]) => ({ id, label: label(id), count }));
  if (order) {
    out.sort((a, b) => {
      const ia = order.indexOf(a.id);
      const ib = order.indexOf(b.id);
      return (ia < 0 ? 999 : ia) - (ib < 0 ? 999 : ib) || b.count - a.count;
    });
  } else {
    out.sort((a, b) => b.count - a.count || a.label.localeCompare(b.label, 'zh-Hans-CN'));
  }
  return out;
}

export function buildCatalogIndex(pack: ProductionPack | null): CatalogIndex {
  const items = pack?.items ?? [];
  const buildings = pack?.buildings ?? [];
  const recipes = pack?.recipes ?? [];
  const professions = pack?.professions ?? [];

  const byId = new Map(items.map((i) => [i.id, i]));
  const buildingById = new Map(buildings.map((b) => [b.id, b]));
  const recipeById = new Map(recipes.map((r) => [r.id, r]));
  const professionById = new Map(professions.map((p) => [p.id, p]));

  const recipesByBuilding = new Map<string, RecipeDef[]>();
  const recipesProducing = new Map<string, RecipeDef[]>();
  const recipesConsuming = new Map<string, RecipeDef[]>();
  for (const r of recipes) {
    pushTo(recipesByBuilding, r.building_id, r);
    for (const out of r.outputs) pushTo(recipesProducing, out.item, r);
    for (const inp of r.inputs) pushTo(recipesConsuming, inp.item, r);
  }

  // Demand category dictionary: prefer the pack's own table, else derive from item usage.
  const categoryCount = new Map<string, number>();
  for (const it of items) if (it.demand_category) incr(categoryCount, it.demand_category);
  const declared = pack?.demand_categories ?? [];
  const categories: DemandCategoryDef[] = declared.length
    ? declared
    : [...categoryCount.keys()].map((id) => ({
        id,
        name: id,
        wealth_tier: 1,
        description: '',
      }));
  const categoryById = new Map(categories.map((c) => [c.id, c]));

  const roleCount = new Map<string, number>();
  const profCount = new Map<string, number>();
  const tierCount = new Map<string, number>();
  const tagCount = new Map<string, number>();
  for (const it of items) {
    incr(roleCount, it.role);
    incr(profCount, it.profession);
    incr(tierCount, String(it.wealth_tier));
    for (const tag of it.tags ?? []) incr(tagCount, tag);
  }

  const index: CatalogIndex = {
    ready: pack !== null,
    pack,
    ticksPerDay: pack?.meta?.ticks_per_day || 24,
    items,
    buildings,
    recipes,
    professions,
    categories,
    byId,
    buildingById,
    recipeById,
    professionById,
    recipesByBuilding,
    recipesProducing,
    recipesConsuming,
    item: (id) => (id ? byId.get(id) : undefined),
    itemName: (id) => {
      if (!id) return '—';
      return byId.get(id)?.name ?? `未知物品（${id}）`;
    },
    building: (id) => (id ? buildingById.get(id) : undefined),
    buildingName: (id) => {
      if (!id) return '—';
      return buildingById.get(id)?.name ?? `未知建筑（${id}）`;
    },
    recipe: (id) => (id ? recipeById.get(id) : undefined),
    recipeName: (id) => {
      if (!id) return '—';
      return recipeById.get(id)?.name ?? `未知配方（${id}）`;
    },
    professionName: (id) => {
      if (!id) return '—';
      return professionById.get(id)?.name ?? id;
    },
    categoryName: (id) => (id ? categoryById.get(id)?.name ?? id : null),
    roleLabel: (role) => ROLE_LABELS[role] ?? role,
    facets: {
      category: [...categoryCount.entries()]
        .map(([id, count]) => ({ id, label: categoryById.get(id)?.name ?? id, count }))
        .sort((a, b) => b.count - a.count),
      role: facet(roleCount, (id) => ROLE_LABELS[id] ?? id, ROLE_ORDER),
      profession: facet(profCount, (id) => professionById.get(id)?.name ?? id),
      tier: facet(tierCount, (id) => `${id} 级`),
      tag: facet(tagCount, (id) => id),
    },
    isInstant: (itemId) => {
      if (!itemId) return false;
      const def = byId.get(itemId);
      if (!def) return false;
      return (def.tags ?? []).some((tg) => INSTANT_TAGS.includes(tg));
    },
    isShippable: (itemId) => (itemId ? !index.isInstant(itemId) : false),
  };

  return index;
}

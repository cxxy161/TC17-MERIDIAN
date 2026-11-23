//! Data-driven production schema loader & deadlock validator (Schema v1.0.0).

use std::collections::{HashMap, HashSet};
use std::path::Path;

use serde::{Deserialize, Serialize};

use crate::types::{BuildingTypeId, ItemId, ProfessionId, RecipeId};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PackMeta {
    pub name: String,
    #[serde(default)]
    pub author: String,
    #[serde(default = "default_ticks_per_day")]
    pub ticks_per_day: u32,
    #[serde(default = "default_tick_seconds")]
    pub tick_seconds: u32,
}

fn default_ticks_per_day() -> u32 {
    24
}
fn default_tick_seconds() -> u32 {
    60
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DemandCategoryDef {
    pub id: String,
    pub name: String,
    pub wealth_tier: u8,
    #[serde(default)]
    pub description: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ProfessionDef {
    pub id: ProfessionId,
    pub name: String,
    pub demand_category: String,
    #[serde(default)]
    pub color: String,
    #[serde(default)]
    pub description: String,
    #[serde(default)]
    pub starter_buildings: Vec<BuildingTypeId>,
    #[serde(default)]
    pub efficiency_bonus: HashMap<BuildingTypeId, f64>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ItemRole {
    Foundation,
    FactoryConsume,
    PlanetSupply,
    Capital,
    Byproduct,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ItemQty {
    pub item: ItemId,
    pub qty: u32,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ItemDef {
    pub id: ItemId,
    pub name: String,
    pub role: ItemRole,
    pub profession: String,
    #[serde(default)]
    pub demand_category: Option<String>,
    pub wealth_tier: u8,
    #[serde(default)]
    pub step_depth: u8,
    pub volume: f64,
    #[serde(default)]
    pub mass: Option<f64>,
    pub ref_price: f64,
    #[serde(default)]
    pub base_demand_per_1k: f64,
    #[serde(default)]
    pub tags: Vec<String>,
}

impl ItemDef {
    pub fn unit_mass(&self) -> f64 {
        self.mass.unwrap_or(self.volume)
    }

    pub fn has_tag(&self, tag: &str) -> bool {
        self.tags.iter().any(|t| t == tag)
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct BuildingDef {
    pub id: BuildingTypeId,
    pub name: String,
    pub profession: ProfessionId,
    #[serde(default = "default_one")]
    pub slots_used: u32,
    pub build_ticks: u32,
    #[serde(default)]
    pub standby_power: u32,
    pub build_cost: Vec<ItemQty>,
    #[serde(default)]
    pub description: String,
}

fn default_one() -> u32 {
    1
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RecipeDef {
    pub id: RecipeId,
    pub name: String,
    pub building_id: BuildingTypeId,
    pub tier: u8,
    pub cycle_ticks: u32,
    #[serde(default)]
    pub power_cost: u32,
    #[serde(default)]
    pub labor_cost: f64,
    pub inputs: Vec<ItemQty>,
    pub outputs: Vec<ItemQty>,
    #[serde(default = "default_true")]
    pub enabled: bool,
    #[serde(default)]
    pub notes: String,
}

fn default_true() -> bool {
    true
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ProductionPack {
    pub schema_version: String,
    pub meta: PackMeta,
    pub demand_categories: Vec<DemandCategoryDef>,
    pub professions: Vec<ProfessionDef>,
    pub items: Vec<ItemDef>,
    pub buildings: Vec<BuildingDef>,
    pub recipes: Vec<RecipeDef>,
}

/// Indexed, validated production catalog loaded once at startup.
#[derive(Debug, Clone)]
pub struct ProductionCatalog {
    pub pack: ProductionPack,
    pub items: HashMap<ItemId, ItemDef>,
    pub buildings: HashMap<BuildingTypeId, BuildingDef>,
    pub recipes: HashMap<RecipeId, RecipeDef>,
    pub recipes_by_building: HashMap<BuildingTypeId, Vec<RecipeId>>,
    pub professions: HashMap<ProfessionId, ProfessionDef>,
    pub repair_item: Option<ItemId>,
    pub fuel_item: Option<ItemId>,
    pub power_item: Option<ItemId>,
    pub waste_item: Option<ItemId>,
}

impl ProductionCatalog {
    pub fn from_json_str(raw: &str) -> Result<Self, String> {
        let pack: ProductionPack =
            serde_json::from_str(raw).map_err(|e| format!("Failed to parse production JSON: {e}"))?;
        Self::from_pack(pack)
    }

    pub fn load_from_file(path: impl AsRef<Path>) -> Result<Self, String> {
        let raw = std::fs::read_to_string(path.as_ref())
            .map_err(|e| format!("Failed to read {}: {e}", path.as_ref().display()))?;
        Self::from_json_str(&raw)
    }

    pub fn from_pack(pack: ProductionPack) -> Result<Self, String> {
        if pack.schema_version != "1.0.0" {
            return Err(format!(
                "Unsupported schema_version '{}', expected '1.0.0'",
                pack.schema_version
            ));
        }

        let cat_ids: HashSet<&str> = pack.demand_categories.iter().map(|c| c.id.as_str()).collect();
        let mut professions = HashMap::new();
        for p in &pack.professions {
            if !cat_ids.contains(p.demand_category.as_str()) {
                return Err(format!(
                    "Profession '{}' references unknown demand_category '{}'",
                    p.id, p.demand_category
                ));
            }
            if professions.insert(p.id.clone(), p.clone()).is_some() {
                return Err(format!("Duplicate profession id '{}'", p.id));
            }
        }

        let mut items = HashMap::new();
        let mut repair_item = None;
        let mut fuel_item = None;
        let mut power_item = None;
        let mut waste_item = None;
        for it in &pack.items {
            if it.profession != "system" && !professions.contains_key(&it.profession) {
                return Err(format!(
                    "Item '{}' references unknown profession '{}'",
                    it.id, it.profession
                ));
            }
            if let Some(dc) = &it.demand_category {
                if !cat_ids.contains(dc.as_str()) {
                    return Err(format!(
                        "Item '{}' references unknown demand_category '{}'",
                        it.id, dc
                    ));
                }
            }
            if it.has_tag("repair") && repair_item.is_none() {
                repair_item = Some(it.id.clone());
            }
            if it.has_tag("fuel") && fuel_item.is_none() {
                fuel_item = Some(it.id.clone());
            }
            if it.has_tag("power") && power_item.is_none() {
                power_item = Some(it.id.clone());
            }
            if it.has_tag("waste") && waste_item.is_none() {
                waste_item = Some(it.id.clone());
            }
            if items.insert(it.id.clone(), it.clone()).is_some() {
                return Err(format!("Duplicate item id '{}'", it.id));
            }
        }

        let mut buildings = HashMap::new();
        for b in &pack.buildings {
            if !professions.contains_key(&b.profession) {
                return Err(format!(
                    "Building '{}' references unknown profession '{}'",
                    b.id, b.profession
                ));
            }
            for c in &b.build_cost {
                if !items.contains_key(&c.item) {
                    return Err(format!(
                        "Building '{}' build_cost references unknown item '{}'",
                        b.id, c.item
                    ));
                }
            }
            if buildings.insert(b.id.clone(), b.clone()).is_some() {
                return Err(format!("Duplicate building id '{}'", b.id));
            }
        }

        let mut recipes = HashMap::new();
        let mut recipes_by_building: HashMap<BuildingTypeId, Vec<RecipeId>> = HashMap::new();
        for r in &pack.recipes {
            if !buildings.contains_key(&r.building_id) {
                return Err(format!(
                    "Recipe '{}' references unknown building '{}'",
                    r.id, r.building_id
                ));
            }
            if r.cycle_ticks == 0 {
                return Err(format!("Recipe '{}' cycle_ticks must be >= 1", r.id));
            }
            if r.outputs.is_empty() {
                return Err(format!("Recipe '{}' has empty outputs", r.id));
            }
            for x in &r.inputs {
                if !items.contains_key(&x.item) || x.qty == 0 {
                    return Err(format!("Recipe '{}' has invalid input '{}'", r.id, x.item));
                }
            }
            for y in &r.outputs {
                if !items.contains_key(&y.item) || y.qty == 0 {
                    return Err(format!("Recipe '{}' has invalid output '{}'", r.id, y.item));
                }
            }
            recipes_by_building
                .entry(r.building_id.clone())
                .or_default()
                .push(r.id.clone());
            if recipes.insert(r.id.clone(), r.clone()).is_some() {
                return Err(format!("Duplicate recipe id '{}'", r.id));
            }
        }

        // Deadlock reachability BFS from zero-input recipes and system byproducts
        let mut reachable: HashSet<&str> = items
            .values()
            .filter(|it| it.role == ItemRole::Byproduct)
            .map(|it| it.id.as_str())
            .collect();
        let mut changed = true;
        while changed {
            changed = false;
            for r in recipes.values().filter(|r| r.enabled) {
                if r.inputs.iter().all(|x| reachable.contains(x.item.as_str())) {
                    for y in &r.outputs {
                        if reachable.insert(y.item.as_str()) {
                            changed = true;
                        }
                    }
                }
            }
        }
        for it in items.values() {
            if !reachable.contains(it.id.as_str()) {
                return Err(format!(
                    "Deadlock: item '{}' ({}) cannot be produced from any bootstrappable chain",
                    it.name, it.id
                ));
            }
        }

        Ok(Self {
            pack,
            items,
            buildings,
            recipes,
            recipes_by_building,
            professions,
            repair_item,
            fuel_item,
            power_item,
            waste_item,
        })
    }
}

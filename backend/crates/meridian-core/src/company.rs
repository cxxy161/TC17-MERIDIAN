//! Company state (shared by human QuickJS players and free-play NPCs).

use std::collections::HashMap;

use serde::{Deserialize, Serialize};

use crate::logistics::Ship;
use crate::types::{CompanyId, ItemId, Money, PlanetId, PlotId, ProfessionId, StationId};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Company {
    pub id: CompanyId,
    pub name: String,
    pub is_player: bool,
    pub profession: ProfessionId,
    pub home_planet_id: PlanetId,
    pub cash: Money,
    pub savings: Money,
    pub debt: Money,
    pub plots: Vec<PlotId>,
    pub ships: Vec<Ship>,
    pub ground_inv: HashMap<PlanetId, HashMap<ItemId, u32>>,
    pub station_inv: HashMap<StationId, HashMap<ItemId, u32>>,
    pub distress_ticks: u32,
}

impl Company {
    pub fn new(
        id: impl Into<CompanyId>,
        name: impl Into<String>,
        is_player: bool,
        profession: impl Into<ProfessionId>,
        home_planet_id: impl Into<PlanetId>,
        cash: Money,
    ) -> Self {
        Self {
            id: id.into(),
            name: name.into(),
            is_player,
            profession: profession.into(),
            home_planet_id: home_planet_id.into(),
            cash,
            savings: 0,
            debt: 0,
            plots: Vec::new(),
            ships: Vec::new(),
            ground_inv: HashMap::new(),
            station_inv: HashMap::new(),
            distress_ticks: 0,
        }
    }

    pub fn ground_qty(&self, pid: &str, item: &str) -> u32 {
        self.ground_inv
            .get(pid)
            .and_then(|m| m.get(item))
            .copied()
            .unwrap_or(0)
    }

    pub fn add_ground_qty(&mut self, pid: &str, item: &str, delta: i64) {
        let map = self.ground_inv.entry(pid.to_string()).or_default();
        let cur = *map.get(item).unwrap_or(&0) as i64;
        let next = (cur + delta).max(0) as u32;
        if next == 0 {
            map.remove(item);
        } else {
            map.insert(item.to_string(), next);
        }
    }

    pub fn station_qty(&self, sid: &str, item: &str) -> u32 {
        self.station_inv
            .get(sid)
            .and_then(|m| m.get(item))
            .copied()
            .unwrap_or(0)
    }

    pub fn add_station_qty(&mut self, sid: &str, item: &str, delta: i64) {
        let map = self.station_inv.entry(sid.to_string()).or_default();
        let cur = *map.get(item).unwrap_or(&0) as i64;
        let next = (cur + delta).max(0) as u32;
        if next == 0 {
            map.remove(item);
        } else {
            map.insert(item.to_string(), next);
        }
    }
}

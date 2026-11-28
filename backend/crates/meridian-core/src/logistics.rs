//! Orbital distances, Keplerian routes (planet <-> ST:P* <-> ST:HUB), and multi-cargo ships.

use std::collections::HashMap;

use serde::{Deserialize, Serialize};

use crate::planet::{Planet, StarSystem};
use crate::types::{CompanyId, ItemId, LocationId, PlanetId, ShipId};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ShipSize {
    Small,
    Medium,
    Large,
}

impl ShipSize {
    pub fn capacity(self) -> u32 {
        match self {
            ShipSize::Small => 40,
            ShipSize::Medium => 120,
            ShipSize::Large => 360,
        }
    }

    pub fn launch_ticks(self) -> u32 {
        match self {
            ShipSize::Small => 1,
            ShipSize::Medium => 2,
            ShipSize::Large => 4,
        }
    }

    pub fn launch_fuel(self) -> u32 {
        match self {
            ShipSize::Small => 1,
            ShipSize::Medium => 2,
            ShipSize::Large => 4,
        }
    }

    pub fn wear_per_trip(self) -> f64 {
        match self {
            ShipSize::Small => 4.0,
            ShipSize::Medium => 3.0,
            ShipSize::Large => 2.5,
        }
    }

    pub fn repair_cost(self) -> u32 {
        match self {
            ShipSize::Small => 1,
            ShipSize::Medium => 2,
            ShipSize::Large => 4,
        }
    }

    pub fn item_id(self) -> &'static str {
        match self {
            ShipSize::Small => "ship_small",
            ShipSize::Medium => "ship_medium",
            ShipSize::Large => "ship_large",
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Ship {
    pub id: ShipId,
    pub owner_id: CompanyId,
    pub size: ShipSize,
    pub durability: f64,
    /// Current physical location ("P2", "ST:P2", or "ST:HUB"). While in flight, destination upon arrival.
    pub location: LocationId,
    pub busy_until: u64,
    pub cargo: HashMap<ItemId, u32>,
}

impl Ship {
    pub fn is_busy(&self, tick: u64) -> bool {
        tick < self.busy_until
    }

    pub fn capacity(&self) -> u32 {
        self.size.capacity()
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ShipInFlight {
    pub ship_id: ShipId,
    pub owner_id: CompanyId,
    pub from: LocationId,
    pub to: LocationId,
    pub cargo: Vec<(ItemId, u32)>,
    #[serde(default)]
    pub launch_tick: u64,
    pub arrival_tick: u64,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RouteKind {
    GroundToStation,
    StationToGround,
    Interplanetary,
    Interstellar,
}

#[derive(Debug, Clone, Copy)]
pub struct RouteSpec {
    pub kind: RouteKind,
    pub ticks: u32,
    pub fuel: u32,
}

pub fn station_coords_in_systems(
    sid: &str,
    planets: &HashMap<PlanetId, Planet>,
    systems: &HashMap<String, StarSystem>,
) -> Option<(f64, f64)> {
    if let Some(sys) = systems.values().find(|s| s.hub_station_id == sid) {
        return Some((
            sys.hub_orbit_radius * sys.hub_orbit_angle.cos(),
            sys.hub_orbit_radius * sys.hub_orbit_angle.sin(),
        ));
    }
    let pid = sid.strip_prefix("ST:")?;
    let p = planets.get(pid)?;
    Some((
        p.orbit_radius * p.orbit_angle.cos(),
        p.orbit_radius * p.orbit_angle.sin(),
    ))
}

pub fn station_coords(
    sid: &str,
    planets: &HashMap<PlanetId, Planet>,
    hub_radius: f64,
    hub_angle: f64,
) -> Option<(f64, f64)> {
    if sid == "ST:HUB" {
        return Some((hub_radius * hub_angle.cos(), hub_radius * hub_angle.sin()));
    }
    let pid = sid.strip_prefix("ST:")?;
    let p = planets.get(pid)?;
    Some((
        p.orbit_radius * p.orbit_angle.cos(),
        p.orbit_radius * p.orbit_angle.sin(),
    ))
}

/// Multi-system-aware physical route calculator:
/// - Planet ground (`P*`) <-> its local orbit station (`ST:P*`)
/// - Same-system station (`ST:P*`) <-> system trade Hub (`ST:HUB` / `ST:HUB:S*`)
/// - Inter-system Hub <-> Hub jump when multiple star systems exist
pub fn compute_route_in_systems(
    from: &str,
    to: &str,
    ship_size: ShipSize,
    durability: f64,
    planets: &HashMap<PlanetId, Planet>,
    systems: &HashMap<String, StarSystem>,
    fallback_hub_radius: f64,
    fallback_hub_angle: f64,
) -> Option<RouteSpec> {
    if systems.is_empty() {
        return compute_route(
            from,
            to,
            ship_size,
            durability,
            planets,
            fallback_hub_radius,
            fallback_hub_angle,
        );
    }
    if from == to {
        return None;
    }

    // 1. Ground <-> Local station
    if let Some(pid) = to.strip_prefix("ST:") {
        if from == pid {
            let p = planets.get(pid)?;
            let mut ticks = ((ship_size.launch_ticks() as f64) * p.launch_ticks_mult())
                .round()
                .max(1.0) as u32;
            let fuel = ((ship_size.launch_fuel() as f64) * p.launch_fuel_mult())
                .round()
                .max(1.0) as u32;
            if durability <= 0.0 {
                ticks *= 2;
            }
            return Some(RouteSpec {
                kind: RouteKind::GroundToStation,
                ticks,
                fuel,
            });
        }
    }
    if let Some(pid) = from.strip_prefix("ST:") {
        if to == pid {
            let p = planets.get(pid)?;
            let mut ticks = ((ship_size.launch_ticks() as f64) * p.launch_ticks_mult())
                .round()
                .max(1.0) as u32;
            let fuel = ((ship_size.launch_fuel() as f64) * p.launch_fuel_mult())
                .round()
                .max(1.0) as u32;
            if durability <= 0.0 {
                ticks *= 2;
            }
            return Some(RouteSpec {
                kind: RouteKind::StationToGround,
                ticks,
                fuel,
            });
        }
    }

    // 2. Inter-system Hub <-> Hub
    let sys_from = systems.values().find(|s| s.hub_station_id == from);
    let sys_to = systems.values().find(|s| s.hub_station_id == to);
    if let (Some(sf), Some(st)) = (sys_from, sys_to) {
        if sf.id == st.id {
            return None;
        }
        let dist = ((sf.x - st.x).powi(2) + (sf.y - st.y).powi(2)).sqrt().max(1.0);
        let mut ticks = (dist * 4.0).round().max(12.0) as u32;
        let fuel = (dist * 6.0).round().max(10.0) as u32;
        if durability <= 0.0 {
            ticks *= 2;
        }
        return Some(RouteSpec {
            kind: RouteKind::Interstellar,
            ticks,
            fuel,
        });
    }

    // 3. Same-system station <-> system Hub, or direct same-system planet station <-> planet station
    let same_system_route = if let (Some(sf), Some(to_pid)) = (sys_from, to.strip_prefix("ST:")) {
        planets
            .get(to_pid)
            .and_then(|p| systems.get(&p.system_id))
            .is_some_and(|s| s.hub_station_id == sf.hub_station_id)
    } else if let (Some(st), Some(from_pid)) = (sys_to, from.strip_prefix("ST:")) {
        planets
            .get(from_pid)
            .and_then(|p| systems.get(&p.system_id))
            .is_some_and(|s| s.hub_station_id == st.hub_station_id)
    } else if let (Some(from_pid), Some(to_pid)) = (from.strip_prefix("ST:"), to.strip_prefix("ST:"))
    {
        match (planets.get(from_pid), planets.get(to_pid)) {
            (Some(pf), Some(pt)) => pf.system_id == pt.system_id,
            _ => false,
        }
    } else {
        false
    };
    if !same_system_route {
        return None;
    }
    let (x1, y1) = station_coords_in_systems(from, planets, systems)?;
    let (x2, y2) = station_coords_in_systems(to, planets, systems)?;
    let dist = ((x1 - x2).powi(2) + (y1 - y2).powi(2)).sqrt();
    let mut ticks = (dist * 6.0).round().max(3.0) as u32;
    let fuel = (dist * 3.0).round().max(2.0) as u32;
    if durability <= 0.0 {
        ticks *= 2;
    }
    Some(RouteSpec {
        kind: RouteKind::Interplanetary,
        ticks,
        fuel,
    })
}

/// Computes physical transit time and fuel cost for valid legs:
/// - Planet ground (`P2`) <-> its local orbit station (`ST:P2`)
/// - Same-system orbital stations (`ST:P*` <-> `ST:P*`) and central Hub (`ST:P*` <-> `ST:HUB`)
pub fn compute_route(
    from: &str,
    to: &str,
    ship_size: ShipSize,
    durability: f64,
    planets: &HashMap<PlanetId, Planet>,
    hub_radius: f64,
    hub_angle: f64,
) -> Option<RouteSpec> {
    if from == to {
        return None;
    }

    // Ground <-> Local station
    if let Some(pid) = to.strip_prefix("ST:") {
        if from == pid {
            let p = planets.get(pid)?;
            let mut ticks = ((ship_size.launch_ticks() as f64) * p.launch_ticks_mult()).round().max(1.0) as u32;
            let fuel = ((ship_size.launch_fuel() as f64) * p.launch_fuel_mult()).round().max(1.0) as u32;
            if durability <= 0.0 {
                ticks *= 2;
            }
            return Some(RouteSpec {
                kind: RouteKind::GroundToStation,
                ticks,
                fuel,
            });
        }
    }
    if let Some(pid) = from.strip_prefix("ST:") {
        if to == pid {
            let p = planets.get(pid)?;
            let mut ticks = ((ship_size.launch_ticks() as f64) * p.launch_ticks_mult()).round().max(1.0) as u32;
            let fuel = ((ship_size.launch_fuel() as f64) * p.launch_fuel_mult()).round().max(1.0) as u32;
            if durability <= 0.0 {
                ticks *= 2;
            }
            return Some(RouteSpec {
                kind: RouteKind::StationToGround,
                ticks,
                fuel,
            });
        }
    }

    // Interplanetary orbital routes (ST:P* <-> ST:P* and ST:P* <-> ST:HUB)
    let is_valid_orbital_leg = from.starts_with("ST:") && to.starts_with("ST:");
    if !is_valid_orbital_leg {
        return None;
    }
    let (x1, y1) = station_coords(from, planets, hub_radius, hub_angle)?;
    let (x2, y2) = station_coords(to, planets, hub_radius, hub_angle)?;
    let dist = ((x1 - x2).powi(2) + (y1 - y2).powi(2)).sqrt();
    let mut ticks = (dist * 6.0).round().max(3.0) as u32;
    let fuel = (dist * 3.0).round().max(2.0) as u32;
    if durability <= 0.0 {
        ticks *= 2;
    }
    Some(RouteSpec {
        kind: RouteKind::Interplanetary,
        ticks,
        fuel,
    })
}

use std::path::PathBuf;

use meridian_core::{
    bps_of, checked_notional, price_band_max, price_in_band, to_money, BankOpKind, Intent, Order,
    OrderId, OrderSide, ProductionCatalog, World, MONEY_SCALE, TRADE_FEE_BPS,
};

fn load_production_catalog() -> ProductionCatalog {
    let manifest_dir = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
    let json_path = manifest_dir
        .join("..")
        .join("..")
        .join("..")
        .join("data")
        .join("production.json");
    ProductionCatalog::load_from_file(&json_path)
        .unwrap_or_else(|e| panic!("Failed to load production.json at {json_path:?}: {e}"))
}

#[test]
fn test_production_json_loads_and_has_zero_deadlocks() {
    let catalog = load_production_catalog();
    assert_eq!(catalog.items.len(), 16);
    assert_eq!(catalog.buildings.len(), 7);
    assert_eq!(catalog.recipes.len(), 18);
    assert_eq!(catalog.professions.len(), 3);
    assert!(catalog.recipes_by_building.contains_key("recycling_plant"));
}

#[test]
fn test_conservation_across_banking_fees_and_npc_bankruptcies() {
    let catalog = load_production_catalog();
    let mut world = World::new_standard(catalog);

    // Spawn 1 player + 2 NPCs
    world
        .spawn_company("player1", "Player Corp", true, "mining_ind", "P1", 10_000.0)
        .expect("spawn player1");
    world
        .spawn_company("npc_rich", "Rich Agro", false, "agri_bio", "P2", 15_000.0)
        .expect("spawn npc_rich");
    world
        .spawn_company("npc_broke", "Broke Smelter", false, "mining_ind", "P1", 50.0)
        .expect("spawn npc_broke");

    // Put npc_broke deep in debt (within starter credit limit, then drain liquid cash below 50*CPI)
    {
        let borrow_amt = to_money(1_800.0);
        world.step_tick(vec![(
            "npc_broke".to_string(),
            vec![Intent::BankOp {
                planet_id: "P1".to_string(),
                op: BankOpKind::Borrow,
                amount: borrow_amt,
            }],
        )]);
    }

    world.step_tick(vec![
        (
            "player1".to_string(),
            vec![
                Intent::BankOp {
                    planet_id: "P1".to_string(),
                    op: BankOpKind::Deposit,
                    amount: to_money(2_000.0),
                },
                Intent::DispatchShip {
                    ship_id: world.companies["player1"].ships[0].id,
                    from: "P1".to_string(),
                    to: "ST:P1".to_string(),
                    cargo: vec![("power".to_string(), 25)],
                },
            ],
        ),
        (
            "npc_rich".to_string(),
            vec![Intent::BankOp {
                planet_id: "P2".to_string(),
                op: BankOpKind::Deposit,
                amount: to_money(4_000.0),
            }],
        ),
    ]);

    assert_eq!(
        world.conservation_error(),
        0,
        "conservation error after initial deposit & dispatch"
    );

    // Wait for player1 ship to arrive at ST:P1 (P1 has 1.4g -> slightly more ticks)
    for _ in 0..10 {
        let rep = world.step_tick(vec![]);
        assert_eq!(world.conservation_error(), 0, "tick {}", rep.tick);
    }
    assert_eq!(world.companies["player1"].ships[0].location, "ST:P1");

    // Freeze npc_broke factories so it won't produce goods or pay wages before matching
    let npc_buildings: Vec<Intent> = world.companies["npc_broke"]
        .plots
        .iter()
        .flat_map(|pid| world.plots[pid].building_ids.iter().copied())
        .map(|bid| Intent::ToggleBuilding {
            building_id: bid,
            active: false,
        })
        .collect();
    world.step_tick(vec![("npc_broke".to_string(), npc_buildings)]);

    // Player1 posts sell order at ST:P1 priced right below npc_broke's remaining liquid cash;
    // npc_broke buys it -> liquid cash drops below 50*CPI while debt > est_assets * 3/4!
    let npc_cash = world.companies["npc_broke"].cash;
    let sell_qty = 25u32;
    let ask_price = ((npc_cash - to_money(5.0)) / (sell_qty as i64)).max(to_money(10.0));
    let p1_treasury_before = world.planets["P1"].treasury;
    let rep = world.step_tick(vec![
        (
            "player1".to_string(),
            vec![Intent::CreateOrder {
                station_id: "ST:P1".to_string(),
                side: OrderSide::Sell,
                item_id: "power".to_string(),
                qty: sell_qty,
                price: ask_price,
            }],
        ),
        (
            "npc_broke".to_string(),
            vec![Intent::CreateOrder {
                station_id: "ST:P1".to_string(),
                side: OrderSide::Buy,
                item_id: "power".to_string(),
                qty: sell_qty,
                price: ask_price,
            }],
        ),
    ]);
    assert_eq!(rep.rejected_intents, 0, "intents should not be rejected");
    assert_eq!(rep.fills.len(), 1, "expected 1 fill on ST:P1");
    let notional = ask_price * (sell_qty as i64);
    let expected_fee = (notional as i128 * TRADE_FEE_BPS as i128 / 10_000) as i64;
    assert_eq!(rep.fills[0].fee, expected_fee);
    assert_eq!(
        world.planets["P1"].treasury - p1_treasury_before,
        expected_fee,
        "0.5% trade station fee must credit planet treasury"
    );
    assert_eq!(world.conservation_error(), 0);

    // Run 300 ticks: player1 withdraws savings+interest mid-way; npc_broke should eventually go bankrupt
    let mut saw_npc_bankrupt = false;
    for t in 0..300 {
        let mut intents = vec![];
        if t == 150 {
            let withdraw_amt = world.companies["player1"].savings;
            if withdraw_amt > 0 {
                intents.push((
                    "player1".to_string(),
                    vec![Intent::BankOp {
                        planet_id: "P1".to_string(),
                        op: BankOpKind::Withdraw,
                        amount: withdraw_amt,
                    }],
                ));
            }
        }
        let report = world.step_tick(intents);
        assert_eq!(
            world.conservation_error(),
            0,
            "currency conservation broken at tick {}",
            report.tick
        );
        if report.bankruptcies.contains(&"npc_broke".to_string()) {
            saw_npc_bankrupt = true;
        }
        assert!(
            !report.bankruptcies.contains(&"player1".to_string()),
            "player1 must NEVER be force-bankrupted"
        );
    }

    assert!(
        saw_npc_bankrupt,
        "insolvent NPC should go bankrupt; remaining npc_broke={:?}",
        world.companies.get("npc_broke").map(|c| (c.cash, c.savings, c.debt, c.distress_ticks))
    );
    assert!(world.companies.contains_key("player1"));
    assert!(!world.companies.contains_key("npc_broke"));
}

#[test]
fn test_player_never_bankrupted_even_when_deeply_insolvent() {
    let catalog = load_production_catalog();
    let mut world = World::new_standard(catalog);

    world
        .spawn_company("player_poor", "Resilient Player", true, "mining_ind", "P1", 10.0)
        .expect("spawn player_poor");
    world
        .spawn_company("counterparty", "Counterparty", false, "agri_bio", "P2", 10_000.0)
        .expect("spawn counterparty");

    // Player borrows 2000 credits, then buys overpriced item from counterparty to have near-zero cash and high debt
    world.step_tick(vec![
        (
            "player_poor".to_string(),
            vec![Intent::BankOp {
                planet_id: "P1".to_string(),
                op: BankOpKind::Borrow,
                amount: to_money(2_000.0),
            }],
        ),
        (
            "counterparty".to_string(),
            vec![Intent::DispatchShip {
                ship_id: world.companies["counterparty"].ships[0].id,
                from: "P2".to_string(),
                to: "ST:P2".to_string(),
                cargo: vec![("power".to_string(), 5)],
            }],
        ),
    ]);

    for _ in 0..4 {
        world.step_tick(vec![]);
    }

    world.step_tick(vec![
        (
            "counterparty".to_string(),
            vec![Intent::CreateOrder {
                station_id: "ST:P2".to_string(),
                side: OrderSide::Sell,
                item_id: "power".to_string(),
                qty: 1,
                price: to_money(2_000.0),
            }],
        ),
        (
            "player_poor".to_string(),
            vec![Intent::CreateOrder {
                station_id: "ST:P2".to_string(),
                side: OrderSide::Buy,
                item_id: "power".to_string(),
                qty: 1,
                price: to_money(2_000.0),
            }],
        ),
    ]);

    // Step 200 ticks with player_poor holding tiny liquid cash and huge debt
    for _ in 0..200 {
        let rep = world.step_tick(vec![]);
        assert!(
            !rep.bankruptcies.contains(&"player_poor".to_string()),
            "player_poor was unexpectedly bankrupted at tick {}",
            rep.tick
        );
        assert_eq!(world.conservation_error(), 0);
    }
    assert!(world.companies.contains_key("player_poor"));
    assert!(world.companies["player_poor"].debt > to_money(2_000.0));
}

#[test]
fn test_orders_do_not_expire_after_48_ticks() {
    let catalog = load_production_catalog();
    let mut world = World::new_standard(catalog);

    world
        .spawn_company("maker", "Maker", true, "mining_ind", "P1", 5_000.0)
        .expect("spawn maker");

    world.step_tick(vec![(
        "maker".to_string(),
        vec![Intent::CreateOrder {
            station_id: "ST:HUB".to_string(),
            side: OrderSide::Buy,
            item_id: "steel".to_string(),
            qty: 10,
            price: to_money(5.0),
        }],
    )]);

    let hub_bids_count = |w: &World| w.stations["ST:HUB"].bids.get("steel").map(|v| v.len()).unwrap_or(0);
    assert_eq!(hub_bids_count(&world), 1);

    // Advance 120 ticks (> 48T old expiry limit)
    for _ in 0..120 {
        world.step_tick(vec![]);
    }

    assert_eq!(
        hub_bids_count(&world),
        1,
        "orders must remain permanent until filled or cancelled (no 48T forced expiry)"
    );
    assert_eq!(world.conservation_error(), 0);
}

#[test]
fn test_manufacturing_recipe_switch_recycling_and_interplanetary_logistics() {
    let catalog = load_production_catalog();
    let mut world = World::new_standard(catalog);

    world
        .spawn_company("ind", "Ind Corp", true, "mining_ind", "P1", 20_000.0)
        .expect("spawn ind");

    // Inspect starter mine_smelter
    let plot_id = world.companies["ind"].plots[0];
    let smelter_id = world
        .plots[&plot_id]
        .building_ids
        .iter()
        .copied()
        .find(|bid| world.buildings[bid].building_type == "mine_smelter")
        .expect("mining_ind starter should include mine_smelter");

    // Seed inputs directly in company ground inventory on P1 for deterministic factory verification
    {
        let comp = world.companies.get_mut("ind").unwrap();
        comp.add_ground_qty("P1", "ore", 40);
        comp.add_ground_qty("P1", "power", 160);
        comp.add_ground_qty("P1", "waste", 20);
        comp.add_ground_qty("P1", "water", 40);
        comp.add_ground_qty("P1", "building_mat", 10);
    }

    // Build a recycling_plant on the plot and switch mine_smelter to steel_electric
    let rep = world.step_tick(vec![(
        "ind".to_string(),
        vec![
            Intent::SetRecipe {
                building_id: smelter_id,
                recipe_id: "steel_electric".to_string(),
            },
            Intent::BuildFacility {
                plot_id,
                building_type: "recycling_plant".to_string(),
            },
        ],
    )]);
    assert_eq!(rep.rejected_intents, 0);
    assert_eq!(world.buildings[&smelter_id].recipe_id, "steel_electric");

    // Run 30 ticks (recycling_plant takes 8 build_ticks, then runs 3-tick recycle_waste cycles)
    for _ in 0..30 {
        world.step_tick(vec![]);
        assert_eq!(world.conservation_error(), 0);
    }

    let steel_produced = world.companies["ind"].ground_qty("P1", "steel");
    let cert_produced = world.companies["ind"].ground_qty("P1", "disposal_cert");
    assert!(steel_produced > 0, "steel_electric should produce steel");
    assert!(
        cert_produced > 0,
        "recycling_plant should process waste into disposal_cert"
    );

    // Multi-cargo ship dispatch: P1 -> ST:P1
    let ship_id = world.companies["ind"].ships[0].id;
    world.step_tick(vec![(
        "ind".to_string(),
        vec![Intent::DispatchShip {
            ship_id,
            from: "P1".to_string(),
            to: "ST:P1".to_string(),
            cargo: vec![
                ("steel".to_string(), steel_produced.min(5)),
                ("disposal_cert".to_string(), cert_produced.min(4)),
            ],
        }],
    )]);

    for _ in 0..10 {
        world.step_tick(vec![]);
    }

    assert_eq!(world.companies["ind"].ships[0].location, "ST:P1");
    assert!(world.companies["ind"].station_qty("ST:P1", "steel") > 0);
    assert!(world.companies["ind"].station_qty("ST:P1", "disposal_cert") > 0);

    // Verify snapshot_for produces complete script-ready data
    let snap = world.snapshot_for("ind").expect("snapshot for ind");
    assert_eq!(snap.company.id, "ind");
    assert!(snap.quotes.contains_key("ST:P1"));
    assert!(snap.quotes.contains_key("ST:HUB"));
}

#[test]
fn test_npc_plot_90_percent_cap_reserves_land_for_players() {
    let catalog = load_production_catalog();
    let mut world = World::new_standard(catalog);

    // P2 has 135 developable plots -> 90% NPC cap = 121 plots
    let cap = world.npc_plot_cap_on("P2");
    assert_eq!(cap, 121);

    world
        .spawn_company("npc_landlord", "NPC Landlord", false, "env_recycle", "P2", 5_000_000.0)
        .expect("spawn npc");
    assert_eq!(world.npc_plot_count_on("P2"), 1);

    // Have the NPC buy explicit unclaimed slots until hitting the 90% ceiling
    for _ in 1..cap {
        let next_slot = world.planets["P2"].unclaimed_slot_ids()[0];
        let rep = world.step_tick(vec![(
            "npc_landlord".to_string(),
            vec![Intent::BuyPlot {
                planet_id: "P2".to_string(),
                slot_id: Some(next_slot),
                listing_id: None,
            }],
        )]);
        assert_eq!(rep.rejected_intents, 0);
    }
    assert_eq!(world.npc_plot_count_on("P2"), cap);

    // Next NPC BuyPlot AND spawning another NPC on P2 must BOTH be blocked!
    let extra_slot = world.planets["P2"].unclaimed_slot_ids()[0];
    let rep_over = world.step_tick(vec![(
        "npc_landlord".to_string(),
        vec![Intent::BuyPlot {
            planet_id: "P2".to_string(),
            slot_id: Some(extra_slot),
            listing_id: None,
        }],
    )]);
    assert_eq!(rep_over.rejected_intents, 1);
    assert!(world
        .spawn_company("npc_blocked", "Blocked", false, "agri_bio", "P2", 8_000.0)
        .is_err());

    // Meanwhile a human player can still claim the reserved 10% plots at an explicit slot!
    world
        .spawn_company("human_p2", "Human Pioneer", true, "agri_bio", "P2", 50_000.0)
        .expect("player must be able to spawn in the reserved 10% land");
    let chosen_slot = world.planets["P2"].unclaimed_slot_ids()[0];
    let rep_human = world.step_tick(vec![(
        "human_p2".to_string(),
        vec![Intent::BuyPlot {
            planet_id: "P2".to_string(),
            slot_id: Some(chosen_slot),
            listing_id: None,
        }],
    )]);
    assert_eq!(rep_human.rejected_intents, 0);
    // Double-buying the already-taken slot must fail cleanly (never silent random fallback)
    let rep_dup = world.step_tick(vec![(
        "human_p2".to_string(),
        vec![Intent::BuyPlot {
            planet_id: "P2".to_string(),
            slot_id: Some(chosen_slot),
            listing_id: None,
        }],
    )]);
    assert_eq!(rep_dup.rejected_intents, 1);
    assert_eq!(world.npc_plot_count_on("P2"), cap);
    assert_eq!(world.conservation_error(), 0);
}

#[test]
fn test_procedural_system_generation_2_to_5_planets_and_conservation() {
    let cat = load_production_catalog();
    let mut seen_counts = std::collections::HashSet::new();
    for seed in [
        11_u64, 42, 107, 2026, 7777, 98765, 133701, 404040, 555123, 888999, 10293847, 99112233,
    ] {
        let mut world = World::new_generated(cat.clone(), seed);
        assert_eq!(world.systems.len(), 1);
        assert!(world.systems.contains_key("S1"));
        assert!(world.stations.contains_key("ST:HUB"));
        let n_planets = world.planets.len();
        assert!(
            (2..=5).contains(&n_planets),
            "seed {seed} produced {n_planets} planets (expected 2..=5)"
        );
        seen_counts.insert(n_planets);

        let total_cities: u32 = world.planets.values().map(|p| p.city_count).sum();
        let total_pop: f64 = world.planets.values().map(|p| p.population).sum();
        for p in world.planets.values() {
            assert_eq!(p.system_id, "S1");
            assert!((0.05..=0.99).contains(&p.habitability));
            if p.habitability < 0.38 {
                assert_eq!(p.city_count, 0);
            } else {
                assert!((1..=10).contains(&p.city_count));
                assert!(p.population >= 300.0);
            }
        }
        if total_cities > 0 {
            assert!(
                (9_500.0..=10_500.0).contains(&total_pop),
                "seed {seed} initial urban pop={total_pop} out of ~10k range"
            );
        } else {
            assert_eq!(total_pop, 0.0);
        }

        // Verify zero currency drift across 12 ticks (including Hub storage rent & city demand ticks)
        let first_pid = world.planets.keys().min().unwrap().clone();
        world
            .spawn_company("probe_corp", "Probe", true, "mining_ind", &first_pid, 10_000.0)
            .expect("spawn probe corp");
        for _ in 0..12 {
            world.step_tick(vec![]);
            assert_eq!(
                world.conservation_error(),
                0,
                "seed {seed} leaked currency at tick {}",
                world.tick
            );
        }
    }
    assert!(
        seen_counts.len() >= 3,
        "expected diverse planet counts across seeds, got {seen_counts:?}"
    );
}

// ---------------------------------------------------------------------------
// Regression tests for the Critical cash-minting advisories (2026-11):
//   * CreateOrder escrow used a truncating `(qty * price) as Money` cast.
//   * match_all / DealOrder refunded more escrow than the buyer actually locked.
// ---------------------------------------------------------------------------

fn spawn_test_company(world: &mut World, id: &str, cash_credits: f64, home: &str) {
    world
        .spawn_company(id, id, false, "mining_ind", home, cash_credits)
        .unwrap_or_else(|e| panic!("spawn {id}: {e}"));
    // Freeze starter factories so per-tick wage payments don't perturb cash assertions.
    for b in world.buildings.values_mut() {
        if b.owner_id == id {
            b.active = false;
            b.active_batch = false;
        }
    }
}

#[test]
fn test_checked_money_helpers_reject_overflow_and_out_of_band_prices() {
    // Exactly the advisory payload: 3 * ((2^64+2)/3) = 2^64+2, which used to truncate to 2.
    let evil_price = (((1u128 << 64) + 2) / 3) as i64;
    assert!(checked_notional(3, evil_price).is_none());
    assert!(checked_notional(i64::MAX as u32, i64::MAX).is_none());
    assert!(checked_notional(0, 100).is_none());
    assert!(checked_notional(1, 0).is_none());
    assert!(checked_notional(1, -5).is_none());
    assert_eq!(checked_notional(3, 7), Some(21));

    // Price band: [1, ref*100] (ref is Money, so exactly 100x the reference price), with a
    // 1-credit floor when ref <= 0.
    assert!(!price_in_band(0, 10_000));
    assert!(price_in_band(1, 10_000));
    assert!(price_in_band(1_000, 10_000));
    assert!(!price_in_band(1i64 << 62, 10_000));
    assert_eq!(price_band_max(10_000), 10_000 * 100);
    assert_eq!(price_band_max(0), price_band_max(MONEY_SCALE));
    assert!(price_in_band(price_band_max(10_000), 10_000));
    assert!(!price_in_band(price_band_max(10_000) + 1, 10_000));
}

fn inject_order(world: &mut World, order: Order) {
    world
        .stations
        .get_mut(&order.station_id)
        .unwrap()
        .insert_order(order);
}

fn make_order(
    order_id: OrderId,
    owner: &str,
    side: OrderSide,
    item: &str,
    qty: u32,
    price: i64,
    escrow_cash: i64,
) -> Order {
    Order {
        order_id,
        owner_id: owner.to_string(),
        side,
        station_id: "ST:HUB".to_string(),
        item_id: item.to_string(),
        qty,
        total_qty: qty,
        price,
        escrow_cash,
        created_tick: 0,
    }
}

#[test]
fn test_create_order_rejects_truncating_qty_times_price() {
    let catalog = load_production_catalog();
    let mut world = World::new_standard(catalog);
    spawn_test_company(&mut world, "buyer", 1_000_000.0, "P1");

    // qty=3, price=(2^64+2)/3: the old `(qty * price) as Money` cast wrapped 2^64+2 down to 2.
    let evil_price = (((1u128 << 64) + 2) / 3) as i64;
    assert!(evil_price > 0);
    assert!(
        (evil_price as i128) * 3 > i64::MAX as i128,
        "fixture must overflow i64 when multiplied by 3"
    );

    let cash_before = world.companies["buyer"].cash;
    let rep = world.step_tick(vec![(
        "buyer".to_string(),
        vec![
            Intent::CreateOrder {
                station_id: "ST:HUB".to_string(),
                side: OrderSide::Buy,
                item_id: "steel".to_string(),
                qty: 3,
                price: evil_price,
            },
            // Sell orders lock no cash, but a sky-high ask must be rejected too (price band).
            Intent::CreateOrder {
                station_id: "ST:HUB".to_string(),
                side: OrderSide::Sell,
                item_id: "steel".to_string(),
                qty: 3,
                price: evil_price,
            },
        ],
    )]);
    assert_eq!(
        rep.rejected_intents, 2,
        "both truncating/out-of-band orders must be rejected"
    );
    assert_eq!(
        world.companies["buyer"].cash, cash_before,
        "a rejected order must never take or mint escrow"
    );
    let hub = &world.stations["ST:HUB"];
    assert!(hub.bids.get("steel").map(|v| v.is_empty()).unwrap_or(true));
    assert!(hub.asks.get("steel").map(|v| v.is_empty()).unwrap_or(true));
    assert_eq!(world.conservation_error(), 0);

    // Sanity check: a normal (bounded) order is still accepted.
    let rep = world.step_tick(vec![(
        "buyer".to_string(),
        vec![Intent::CreateOrder {
            station_id: "ST:HUB".to_string(),
            side: OrderSide::Buy,
            item_id: "steel".to_string(),
            qty: 2,
            price: to_money(5.0),
        }],
    )]);
    assert_eq!(rep.rejected_intents, 0);
    assert_eq!(world.companies["buyer"].cash, cash_before - 2 * to_money(5.0));
    assert_eq!(world.conservation_error(), 0);
}

#[test]
fn test_deal_order_with_absurd_price_cannot_credit_either_side() {
    let catalog = load_production_catalog();
    let mut world = World::new_standard(catalog);
    spawn_test_company(&mut world, "buyer", 10_000.0, "P1");
    spawn_test_company(&mut world, "seller", 0.0, "P1");

    let absurd = 1i64 << 62;

    // A resting ASK at 2^62: the caller must not wrap cash into a negative balance.
    let ask_id = 900_001;
    inject_order(
        &mut world,
        make_order(ask_id, "seller", OrderSide::Sell, "steel", 10, absurd, 0),
    );
    let buyer_before = world.companies["buyer"].cash;
    let rep = world.step_tick(vec![(
        "buyer".to_string(),
        vec![Intent::DealOrder {
            order_id: ask_id,
            amount: 1,
        }],
    )]);
    assert_eq!(rep.rejected_intents, 1, "out-of-band ask must be rejected");
    assert!(rep.fills.is_empty(), "no fill may be produced from a 2^62 ask");
    assert_eq!(
        world.companies["buyer"].cash, buyer_before,
        "buyer must not be debited (or credited) on an absurd ask"
    );
    assert_eq!(world.companies["seller"].cash, 0, "seller must not go negative");
    assert!(
        world.stations["ST:HUB"].asks["steel"]
            .iter()
            .any(|o| o.order_id == ask_id),
        "rejected resting order must stay in the book"
    );

    // A resting BID at 2^62 with zero escrow: the caller sells goods into it and must not be paid.
    world
        .companies
        .get_mut("buyer")
        .unwrap()
        .add_station_qty("ST:HUB", "power", 5);
    let bid_id = 900_002;
    inject_order(
        &mut world,
        make_order(bid_id, "seller", OrderSide::Buy, "power", 5, absurd, 0),
    );
    let cash_before = world.companies["buyer"].cash;
    let rep = world.step_tick(vec![(
        "buyer".to_string(),
        vec![Intent::DealOrder {
            order_id: bid_id,
            amount: 2,
        }],
    )]);
    assert_eq!(rep.rejected_intents, 1);
    assert_eq!(
        world.companies["buyer"].cash, cash_before,
        "seller of goods must not receive minted cash"
    );
    assert_eq!(world.companies["buyer"].station_qty("ST:HUB", "power"), 5);
    assert!(
        world.stations["ST:HUB"].bids["power"]
            .iter()
            .any(|o| o.order_id == bid_id)
    );

    // A resting bid at a sane price but under-escrowed: reject instead of creating negative escrow.
    let bid_id2 = 900_003;
    inject_order(
        &mut world,
        make_order(bid_id2, "seller", OrderSide::Buy, "power", 5, 1_000, 10),
    );
    let rep = world.step_tick(vec![(
        "buyer".to_string(),
        vec![Intent::DealOrder {
            order_id: bid_id2,
            amount: 1,
        }],
    )]);
    assert_eq!(rep.rejected_intents, 1, "under-escrowed bid must be rejected");
    let bid = world.stations["ST:HUB"].bids["power"]
        .iter()
        .find(|o| o.order_id == bid_id2)
        .expect("under-escrowed bid must be re-inserted untouched");
    assert_eq!(bid.qty, 5);
    assert_eq!(bid.escrow_cash, 10);
    assert_eq!(world.companies["buyer"].cash, cash_before);
    assert_eq!(world.companies["buyer"].station_qty("ST:HUB", "power"), 5);
}

#[test]
fn test_partial_fill_refund_bounded_by_escrow_and_cash_conserved() {
    let catalog = load_production_catalog();
    let mut world = World::new_standard(catalog);
    spawn_test_company(&mut world, "buyer", 100_000.0, "P1");
    spawn_test_company(&mut world, "seller", 0.0, "P1");
    world
        .companies
        .get_mut("seller")
        .unwrap()
        .add_station_qty("ST:HUB", "steel", 1);

    // Seller rests a cheaper ask first, so the later crossing bid gets price improvement.
    let rep = world.step_tick(vec![(
        "seller".to_string(),
        vec![Intent::CreateOrder {
            station_id: "ST:HUB".to_string(),
            side: OrderSide::Sell,
            item_id: "steel".to_string(),
            qty: 1,
            price: 900,
        }],
    )]);
    assert_eq!(rep.rejected_intents, 0);
    assert!(rep.fills.is_empty());

    let buyer_cash_before = world.companies["buyer"].cash;
    let seller_cash_before = world.companies["seller"].cash;

    // 3 units bid at 1000 vs 1 unit ask at 900 -> partial fill with a refund of 100.
    let rep = world.step_tick(vec![(
        "buyer".to_string(),
        vec![Intent::CreateOrder {
            station_id: "ST:HUB".to_string(),
            side: OrderSide::Buy,
            item_id: "steel".to_string(),
            qty: 3,
            price: 1_000,
        }],
    )]);
    assert_eq!(rep.rejected_intents, 0);
    let fill = rep
        .fills
        .iter()
        .find(|f| f.item_id == "steel")
        .expect("expected a steel fill");
    assert_eq!(fill.qty, 1);
    assert_eq!(fill.price, 900);
    assert_eq!(fill.notional, 900);
    assert_eq!(fill.fee, bps_of(900, TRADE_FEE_BPS));
    assert_eq!(fill.fee, 4);
    assert_eq!(fill.seller_proceeds, 896);
    // Escrow for take was 1 * 1000 = 1000; the buyer overpaid 100 and must get exactly that back.
    assert_eq!(fill.buyer_refund, 100);
    let escrow_for_take = 1_000;
    assert!(
        fill.buyer_refund <= escrow_for_take,
        "refund {} exceeded escrowed {}",
        fill.buyer_refund,
        escrow_for_take
    );
    assert_eq!(
        fill.buyer_refund + fill.seller_proceeds + fill.fee,
        escrow_for_take,
        "released escrow must equal refund + seller proceeds + fee"
    );
    assert_eq!(fill.seller_proceeds + fill.fee, fill.notional);

    let (bid_qty, bid_escrow) = {
        let bid = world.stations["ST:HUB"].bids["steel"]
            .iter()
            .find(|o| o.owner_id == "buyer")
            .expect("remaining bid");
        (bid.qty, bid.escrow_cash)
    };
    assert_eq!(bid_qty, 2, "1 of 3 units filled");
    assert_eq!(bid_escrow, 2_000, "remaining escrow must match remaining qty");
    assert!(bid_escrow >= 0);

    // buyer + seller + fee credits + escrow must be unchanged by the fill.
    let total_after = world.companies["buyer"].cash
        + world.companies["seller"].cash
        + fill.fee
        + bid_escrow;
    assert_eq!(
        total_after,
        buyer_cash_before + seller_cash_before,
        "buyer+seller+fee+escrow delta must net to zero"
    );
    assert_eq!(world.conservation_error(), 0);

    // A corrupt/legacy bid whose escrow cannot cover even one unit must be evicted, not refunded.
    spawn_test_company(&mut world, "victim", 10_000.0, "P1");
    let victim_cash = world.companies["victim"].cash;
    let corrupt_id = 900_010;
    inject_order(
        &mut world,
        make_order(corrupt_id, "victim", OrderSide::Buy, "power", 10, 1_000, 2),
    );
    inject_order(
        &mut world,
        make_order(900_011, "seller", OrderSide::Sell, "power", 1, 1_000, 0),
    );
    let rep = world.step_tick(vec![]);
    assert!(
        rep.fills.iter().all(|f| f.item_id != "power"),
        "an under-escrowed bid must never produce a fill"
    );
    assert_eq!(
        world.companies["victim"].cash, victim_cash,
        "evicting a corrupt bid must not refund phantom escrow"
    );
    assert!(
        world.stations["ST:HUB"]
            .bids
            .get("power")
            .map(|v| v.iter().all(|o| o.order_id != corrupt_id))
            .unwrap_or(true),
        "under-escrowed bid must be removed from the book"
    );
    assert_eq!(world.conservation_error(), 0);
}

struct TestRng(u64);

impl TestRng {
    fn next(&mut self) -> u64 {
        self.0 = self
            .0
            .wrapping_mul(6_364_136_223_846_793_005)
            .wrapping_add(1_442_695_040_888_963_407);
        self.0 >> 11
    }
}

#[test]
fn test_random_qty_price_take_invariants() {
    let catalog = load_production_catalog();
    for seed in 0..24u64 {
        let mut world = World::new_standard(catalog.clone());
        spawn_test_company(&mut world, "mm", 1_000_000.0, "P1");
        spawn_test_company(&mut world, "npc", 1_000_000.0, "P2");
        for cid in ["mm", "npc"] {
            world
                .companies
                .get_mut(cid)
                .unwrap()
                .add_station_qty("ST:HUB", "steel", 10_000);
        }

        let mut rng = TestRng(seed.wrapping_add(0xA5A5_5A5A_1234_5678));
        for round in 0..12 {
            let qty = (rng.next() % 20) as u32 + 1;
            let price = (rng.next() % 5_000) as i64 + 1;
            let npc_price = match rng.next() % 3 {
                0 => price,
                1 => price.saturating_mul(2),
                _ => (price / 2).max(1),
            };
            let take = (rng.next() % 25) as u32 + 1;
            let (mm_side, npc_side) = if rng.next() % 2 == 0 {
                (OrderSide::Buy, OrderSide::Sell)
            } else {
                (OrderSide::Sell, OrderSide::Buy)
            };

            let mut batches: Vec<(String, Vec<Intent>)> = vec![
                (
                    "mm".to_string(),
                    vec![Intent::CreateOrder {
                        station_id: "ST:HUB".to_string(),
                        side: mm_side,
                        item_id: "steel".to_string(),
                        qty,
                        price,
                    }],
                ),
                (
                    "npc".to_string(),
                    vec![Intent::CreateOrder {
                        station_id: "ST:HUB".to_string(),
                        side: npc_side,
                        item_id: "steel".to_string(),
                        qty: (rng.next() % 20) as u32 + 1,
                        price: npc_price,
                    }],
                ),
            ];

            // Random DealOrder against a random live order on the Hub book.
            let hub = &world.stations["ST:HUB"];
            let live: Vec<OrderId> = hub
                .bids
                .values()
                .chain(hub.asks.values())
                .flat_map(|v| v.iter())
                .map(|o| o.order_id)
                .collect();
            if !live.is_empty() {
                let oid = live[(rng.next() as usize) % live.len()];
                let actor = if rng.next() % 2 == 0 { "mm" } else { "npc" };
                batches.push((
                    actor.to_string(),
                    vec![Intent::DealOrder {
                        order_id: oid,
                        amount: take,
                    }],
                ));
            }

            let rep = world.step_tick(batches);
            assert_eq!(
                world.conservation_error(),
                0,
                "seed {seed} round {round}: currency conservation broken"
            );

            // Every resting bid must still be exactly covered by its escrow.
            for st in world.stations.values() {
                for orders in st.bids.values() {
                    for o in orders {
                        assert!(
                            o.escrow_cash >= 0,
                            "seed {seed} round {round}: negative escrow on order {}",
                            o.order_id
                        );
                        let nominal = checked_notional(o.qty, o.price).unwrap_or_else(|| {
                            panic!(
                                "seed {seed} round {round}: bid {} has invalid qty*price ({}, {})",
                                o.order_id, o.qty, o.price
                            )
                        });
                        assert_eq!(
                            o.escrow_cash, nominal,
                            "seed {seed} round {round}: escrow mismatch on order {}",
                            o.order_id
                        );
                    }
                }
                for orders in st.asks.values() {
                    for o in orders {
                        assert!(o.escrow_cash >= 0);
                        assert!(o.qty > 0);
                        assert!(o.price > 0);
                    }
                }
            }

            for c in world.companies.values() {
                assert!(
                    c.cash >= 0 && c.savings >= 0 && c.debt >= 0,
                    "seed {seed} round {round}: negative balance on {}",
                    c.id
                );
            }

            for fill in &rep.fills {
                assert!(fill.qty > 0);
                assert!(fill.price > 0);
                assert!(fill.notional > 0);
                assert!(fill.fee >= 0);
                assert!(fill.seller_proceeds >= 0);
                assert!(fill.buyer_refund >= 0);
                assert_eq!(fill.notional, fill.qty as i64 * fill.price);
                assert_eq!(fill.seller_proceeds, fill.qty as i64 * fill.price - fill.fee);
            }
        }
    }
}

#[test]
fn test_bank_credit_limit_reserve_guard_and_overdue_25pct_garnishment() {
    use meridian_core::{LOAN_TERM_TICKS, OVERDUE_GARNISH_BPS};

    let catalog = load_production_catalog();
    let mut world = World::new_standard(catalog);

    world
        .spawn_company("depositor", "Depositor", true, "mining_ind", "P1", 40_000.0)
        .unwrap();
    world
        .spawn_company("borrower", "Borrower", true, "mining_ind", "P1", 100.0)
        .unwrap();
    world
        .spawn_company("buyer", "Buyer", true, "mining_ind", "P1", 20_000.0)
        .unwrap();

    // Depositor puts 30,000 into P1 bank; borrower tries to borrow 19,629 (must fail credit limit).
    let rep1 = world.step_tick(vec![
        (
            "depositor".to_string(),
            vec![Intent::BankOp {
                planet_id: "P1".to_string(),
                op: BankOpKind::Deposit,
                amount: to_money(30_000.0),
            }],
        ),
        (
            "borrower".to_string(),
            vec![Intent::BankOp {
                planet_id: "P1".to_string(),
                op: BankOpKind::Borrow,
                amount: to_money(19_629.0),
            }],
        ),
    ]);
    assert_eq!(rep1.rejected_intents, 1, "19,629 borrow on 100 equity must be rejected");
    assert_eq!(world.companies["borrower"].debt, 0);

    // Borrower CAN borrow within starter credit limit (~2,000 * cpi), and depositor can still withdraw reserves.
    let borrow_amt = to_money(1_500.0);
    let rep2 = world.step_tick(vec![(
        "borrower".to_string(),
        vec![Intent::BankOp {
            planet_id: "P1".to_string(),
            op: BankOpKind::Borrow,
            amount: borrow_amt,
        }],
    )]);
    assert_eq!(rep2.rejected_intents, 0);
    assert!(world.companies["borrower"].debt >= borrow_amt);
    let due_tick = world.companies["borrower"].debt_due_tick.unwrap();
    assert_eq!(due_tick, world.tick + LOAN_TERM_TICKS);

    // Depositor must still be able to withdraw >= 25% reserve floor (7,500 credits).
    let rep_wd = world.step_tick(vec![(
        "depositor".to_string(),
        vec![Intent::BankOp {
            planet_id: "P1".to_string(),
            op: BankOpKind::Withdraw,
            amount: to_money(7_500.0),
        }],
    )]);
    assert_eq!(rep_wd.rejected_intents, 0, "depositor reserve must stay withdrawable");

    // Advance past due_tick so borrower becomes overdue.
    while world.tick <= due_tick {
        world.step_tick(vec![]);
    }
    assert!(world.companies["borrower"].is_debt_overdue(world.tick));

    // Overdue borrower cannot borrow more or buy new plots while in default.
    let free_slot = world.planets["P1"]
        .surface_tiles
        .iter()
        .find(|t| !t.is_city && t.owner_id.is_none())
        .unwrap()
        .slot_id;
    let rep_blocked = world.step_tick(vec![(
        "borrower".to_string(),
        vec![
            Intent::BankOp {
                planet_id: "P1".to_string(),
                op: BankOpKind::Borrow,
                amount: to_money(100.0),
            },
            Intent::BuyPlot {
                planet_id: "P1".to_string(),
                slot_id: Some(free_slot),
                listing_id: None,
            },
        ],
    )]);
    assert_eq!(rep_blocked.rejected_intents, 2);

    // Give borrower steel at ST:HUB to sell while overdue -> 25% of proceeds automatically garnish debt!
    world
        .companies
        .get_mut("borrower")
        .unwrap()
        .add_station_qty("ST:HUB", "steel", 100);
    let debt_before = world.companies["borrower"].debt;
    let cash_before = world.companies["borrower"].cash;
    let reserves_before = world.planets["P1"].bank.reserves;

    let sell_price = to_money(2.0);
    let rep_sell = world.step_tick(vec![
        (
            "borrower".to_string(),
            vec![Intent::CreateOrder {
                station_id: "ST:HUB".to_string(),
                side: OrderSide::Sell,
                item_id: "steel".to_string(),
                qty: 100,
                price: sell_price,
            }],
        ),
        (
            "buyer".to_string(),
            vec![Intent::CreateOrder {
                station_id: "ST:HUB".to_string(),
                side: OrderSide::Buy,
                item_id: "steel".to_string(),
                qty: 100,
                price: sell_price,
            }],
        ),
    ]);
    assert_eq!(rep_sell.fills.len(), 1);

    let debt_after = world.companies["borrower"].debt;
    let cash_after = world.companies["borrower"].cash;
    let reserves_after = world.planets["P1"].bank.reserves;
    let garnished = debt_before - debt_after;
    let gross_notional = to_money(200.0);
    let fee = bps_of(gross_notional, meridian_core::TRADE_FEE_BPS);
    let proceeds = gross_notional - fee;
    // Garnishment is 25% of proceeds, credited in full to bank reserves; the borrower's debt also
    // accrues one tick of interest in the same step, so the *observed* debt reduction is
    // (garnish - interest) while the reserve/cash deltas are exact.
    let expected_garnish = bps_of(proceeds, OVERDUE_GARNISH_BPS);
    assert_eq!(reserves_after - reserves_before, expected_garnish);
    assert_eq!(cash_after - cash_before, proceeds - expected_garnish);
    assert!(
        garnished <= expected_garnish && garnished + 2_000 >= expected_garnish,
        "expected ~{expected_garnish} garnished (minus 1 tick interest), got {garnished}"
    );
    assert_eq!(world.conservation_error(), 0);
}

#[test]
fn test_deal_order_enforces_price_priority_and_ema_ramps_smoothly() {
    let catalog = load_production_catalog();
    let mut world = World::new_standard(catalog);

    spawn_test_company(&mut world, "cheap_seller", 5_000.0, "P1");
    spawn_test_company(&mut world, "high_seller", 5_000.0, "P1");
    spawn_test_company(&mut world, "attacker", 50_000.0, "P1");

    world
        .companies
        .get_mut("cheap_seller")
        .unwrap()
        .add_station_qty("ST:HUB", "steel", 10);
    world
        .companies
        .get_mut("high_seller")
        .unwrap()
        .add_station_qty("ST:HUB", "steel", 10);

    // Seed normal baseline trade at 4.0 so EMA has history.
    world
        .companies
        .get_mut("attacker")
        .unwrap()
        .add_station_qty("ST:HUB", "steel", 5);
    world.step_tick(vec![
        (
            "cheap_seller".to_string(),
            vec![Intent::CreateOrder {
                station_id: "ST:HUB".to_string(),
                side: OrderSide::Sell,
                item_id: "steel".to_string(),
                qty: 5,
                price: to_money(4.0),
            }],
        ),
        (
            "attacker".to_string(),
            vec![Intent::CreateOrder {
                station_id: "ST:HUB".to_string(),
                side: OrderSide::Buy,
                item_id: "steel".to_string(),
                qty: 5,
                price: to_money(4.0),
            }],
        ),
    ]);
    let ema_before = world.stations["ST:HUB"].ema_slow["steel"];

    // Post cheap ask (4.0) and overpriced ask (100.0).
    world.step_tick(vec![
        (
            "cheap_seller".to_string(),
            vec![Intent::CreateOrder {
                station_id: "ST:HUB".to_string(),
                side: OrderSide::Sell,
                item_id: "steel".to_string(),
                qty: 5,
                price: to_money(4.0),
            }],
        ),
        (
            "high_seller".to_string(),
            vec![Intent::CreateOrder {
                station_id: "ST:HUB".to_string(),
                side: OrderSide::Sell,
                item_id: "steel".to_string(),
                qty: 5,
                price: to_money(100.0),
            }],
        ),
    ]);

    let high_oid = world.stations["ST:HUB"].asks["steel"]
        .iter()
        .find(|o| o.owner_id == "high_seller")
        .unwrap()
        .order_id;

    // DealOrder skipping the cheaper 4.0 ask to hit 100.0 ask must be rejected!
    let rep_skip = world.step_tick(vec![(
        "attacker".to_string(),
        vec![Intent::DealOrder {
            order_id: high_oid,
            amount: 1,
        }],
    )]);
    assert_eq!(rep_skip.rejected_intents, 1, "DealOrder must not skip better-priced ask");
    assert_eq!(world.stations["ST:HUB"].ema_slow["steel"], ema_before);
}

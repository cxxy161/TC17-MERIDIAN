use std::path::PathBuf;

use meridian_core::{
    to_money, BankOpKind, Intent, OrderSide, ProductionCatalog, World, TRADE_FEE_BPS,
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

    // Put npc_broke deep in debt (debt > estimated assets, liquid < 30 * cpi)
    {
        let borrow_amt = to_money(10_000.0);
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
                    cargo: vec![("power".to_string(), 10)],
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
    // npc_broke buys it -> liquid cash drops below 30*CPI while debt > 2_500!
    let npc_cash = world.companies["npc_broke"].cash;
    let ask_price = (npc_cash - to_money(5.0)).max(to_money(10.0));
    let p1_treasury_before = world.planets["P1"].treasury;
    let rep = world.step_tick(vec![
        (
            "player1".to_string(),
            vec![Intent::CreateOrder {
                station_id: "ST:P1".to_string(),
                side: OrderSide::Sell,
                item_id: "power".to_string(),
                qty: 1,
                price: ask_price,
            }],
        ),
        (
            "npc_broke".to_string(),
            vec![Intent::CreateOrder {
                station_id: "ST:P1".to_string(),
                side: OrderSide::Buy,
                item_id: "power".to_string(),
                qty: 1,
                price: ask_price,
            }],
        ),
    ]);
    assert_eq!(rep.rejected_intents, 0, "intents should not be rejected");
    assert_eq!(rep.fills.len(), 1, "expected 1 fill on ST:P1");
    let expected_fee = (ask_price as i128 * TRADE_FEE_BPS as i128 / 10_000) as i64;
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

    // Verify snapshot_for produces complete Screeps-ready data
    let snap = world.snapshot_for("ind").expect("snapshot for ind");
    assert_eq!(snap.company.id, "ind");
    assert!(snap.quotes.contains_key("ST:P1"));
    assert!(snap.quotes.contains_key("ST:HUB"));
}

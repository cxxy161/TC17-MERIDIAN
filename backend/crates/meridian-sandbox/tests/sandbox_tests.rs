use std::path::PathBuf;
use std::sync::Arc;

use meridian_core::{ProductionCatalog, World};
use meridian_sandbox::{
    run_player_tick, ConsoleLevel, NpcGenome, PlayerRunConfig, PlayerScriptBundle, SimulationRunner,
};

fn load_catalog() -> ProductionCatalog {
    let manifest_dir = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
    let json_path = manifest_dir
        .join("..")
        .join("..")
        .join("..")
        .join("data")
        .join("production.json");
    ProductionCatalog::load_from_file(&json_path).expect("load data/production.json")
}

#[test]
fn test_screeps_api_multimodule_memory_store_and_intents() {
    let catalog = load_catalog();
    let mut world = World::new_standard(catalog);
    world
        .spawn_company("p_js", "Alpha JS", true, "mining_ind", "P1", 10_000.0)
        .expect("spawn player");

    let bundle = PlayerScriptBundle::single_main(
        r#"
        const helper = require('./helper');
        module.exports.loop = function () {
            Memory.runs = (Memory.runs || 0) + 1;

            // Validate Screeps constants & dynamic RESOURCES_ALL
            if (OK !== 0 || RESOURCE_POWER !== 'power' || !Array.isArray(RESOURCES_ALL)) {
                throw new Error('Missing Screeps constants');
            }

            // Validate Store Proxy returning 0 for valid unstocked items
            const p1 = Game.planets['P1'];
            if (p1.groundStore[RESOURCE_STEEL] !== 0) {
                throw new Error('Expected Store proxy to return 0 for unstocked valid item');
            }
            if (p1.groundStore.power <= 0) {
                throw new Error('Expected starter power on P1 groundStore');
            }

            // Validate lazy Market & Recipe FFI
            const q = Game.market.quote('ST:HUB', RESOURCE_STEEL);
            const r = Game.getRecipe('steel_electric');
            const route = Game.market.calcRoute('P1', 'ST:P1');
            console.log('tick', Game.time, 'steel_last', q && q.lastPrice, 'route', route && route.ticks);

            if (!r || r.id !== 'steel_electric') {
                throw new Error('Expected Game.getRecipe to return steel_electric');
            }

            // Emit valid Intents cleanly using helper module
            const res = helper.stepOrdersAndShip(Game);
            Memory.lastCodes = res;
        };
    "#,
    )
    .with_module(
        "helper",
        r#"
        exports.stepOrdersAndShip = function (Game) {
            const codes = [];
            const ships = Object.values(Game.ships);
            if (ships.length > 0 && !ships[0].isBusy && ships[0].location === 'P1') {
                codes.push(ships[0].dispatch('P1', 'ST:P1', { power: 5 }));
                // Wrong origin should return ERR_NOT_IN_RANGE (-9) without queuing intent
                codes.push(ships[0].dispatch('P2', 'ST:P2', { power: 1 }));
            }
            // Invalid recipe returns ERR_NOT_FOUND (-5)
            const blds = Object.values(Game.buildings);
            if (blds.length > 0) {
                codes.push(blds[0].setRecipe('nonexistent_recipe'));
            }
            codes.push(Game.market.createOrder({
                type: ORDER_BUY,
                resourceType: RESOURCE_ORE,
                price: 3.5,
                totalAmount: 4,
                stationId: 'ST:HUB',
            }));
            codes.push(Game.bank('P1', 'deposit', 100));
            return codes;
        };
    "#,
    );

    let mut runner = SimulationRunner::new(PlayerRunConfig::default());
    runner.set_player_script("p_js", bundle);

    // Tick 1
    let rep1 = runner.step_world(&mut world);
    let out1 = runner.last_player_outputs.get("p_js").expect("player output 1");
    assert!(out1.error.is_none(), "unexpected JS error: {:?}", out1.error);
    assert!(!out1.timed_out);
    assert!(!out1.oom);
    assert_eq!(out1.intents.len(), 3, "expected DispatchShip + CreateOrder + BankOp");
    assert_eq!(rep1.rejected_intents, 0);
    assert_eq!(world.conservation_error(), 0);
    assert!(out1.logs.iter().any(|l| l.message.contains("tick 0")));

    let mem1: serde_json::Value = serde_json::from_str(&out1.memory_json).unwrap();
    assert_eq!(mem1["runs"], 1);
    assert_eq!(mem1["lastCodes"], serde_json::json!([0, -9, -5, 0, 0]));

    // Tick 2 confirms Memory persistence
    runner.step_world(&mut world);
    let out2 = runner.last_player_outputs.get("p_js").expect("player output 2");
    assert!(out2.error.is_none());
    let mem2: serde_json::Value = serde_json::from_str(&out2.memory_json).unwrap();
    assert_eq!(mem2["runs"], 2);
}

#[test]
fn test_infinite_loop_timeout_rolls_back_intents_and_memory() {
    let catalog = Arc::new(load_catalog());
    let mut world = World::new_standard((*catalog).clone());
    world
        .spawn_company("p_loop", "Infinite Corp", true, "agri_bio", "P2", 5_000.0)
        .expect("spawn");
    let snap = Arc::new(world.snapshot_for("p_loop").unwrap());

    let bundle = Arc::new(PlayerScriptBundle::single_main(
        r#"
        module.exports.loop = function () {
            Memory.corrupted = true;
            Game.bank('P2', 'deposit', 50);
            while (true) {}
        };
    "#,
    ));

    let cfg = PlayerRunConfig {
        cpu_limit_ms: 5,
        ..Default::default()
    };
    let prev_mem = r#"{"ok":true}"#;
    let out = run_player_tick(snap, catalog, bundle, prev_mem, &cfg);

    assert!(out.timed_out, "expected infinite loop to hit interrupt timeout");
    assert!(out.error.is_some());
    assert!(
        out.intents.is_empty(),
        "timed out script must discard uncommitted intents"
    );
    assert_eq!(
        out.memory_json, prev_mem,
        "timed out script must preserve previous Memory intact"
    );
}

#[test]
fn test_oom_protection_and_console_flood_cap() {
    let catalog = Arc::new(load_catalog());
    let mut world = World::new_standard((*catalog).clone());
    world
        .spawn_company("p_mem", "Leak Corp", true, "env_recycle", "P2", 5_000.0)
        .expect("spawn");
    let snap = Arc::new(world.snapshot_for("p_mem").unwrap());

    // 1. Console flood cap (200 lines max + truncation warning)
    let flood_bundle = Arc::new(PlayerScriptBundle::single_main(
        r#"
        module.exports.loop = function () {
            for (let i = 0; i < 400; i++) {
                console.log('line-' + i);
            }
        };
    "#,
    ));
    let out_flood = run_player_tick(
        Arc::clone(&snap),
        Arc::clone(&catalog),
        flood_bundle,
        "{}",
        &PlayerRunConfig {
            cpu_limit_ms: 50,
            ..Default::default()
        },
    );
    assert!(out_flood.error.is_none(), "{:?}", out_flood.error);
    assert_eq!(out_flood.logs.len(), 201); // 200 lines + 1 warning
    assert_eq!(out_flood.logs.last().unwrap().level, ConsoleLevel::Warn);

    // 2. Heap 4MB OOM cap
    let oom_bundle = Arc::new(PlayerScriptBundle::single_main(
        r#"
        module.exports.loop = function () {
            const arr = [];
            for (let i = 0; i < 100000; i++) {
                arr.push(new Array(1024).fill(i));
            }
        };
    "#,
    ));
    let out_oom = run_player_tick(
        snap,
        catalog,
        oom_bundle,
        "{}",
        &PlayerRunConfig {
            memory_limit_bytes: 4 * 1024 * 1024,
            cpu_limit_ms: 100,
            ..Default::default()
        },
    );
    assert!(out_oom.error.is_some(), "expected OOM error");
    assert!(out_oom.oom, "expected oom flag true, got: {:?}", out_oom.error);
    assert!(out_oom.intents.is_empty());
}

#[test]
fn test_parallel_runner_with_npcs_preserves_conservation() {
    let catalog = load_catalog();
    let mut world = World::new_standard(catalog);

    let mut runner = SimulationRunner::new(PlayerRunConfig {
        cpu_limit_ms: 20,
        ..Default::default()
    });

    world
        .spawn_company("player_main", "Player Corp", true, "mining_ind", "P1", 10_000.0)
        .unwrap();
    runner.set_player_script(
        "player_main",
        PlayerScriptBundle::single_main(
            r#"
            module.exports.loop = function () {
                const ship = Object.values(Game.ships)[0];
                if (ship && !ship.isBusy && ship.location === 'P1' && Game.planets['P1'].groundStore.ore > 0) {
                    ship.dispatch('P1', 'ST:P1', { ore: Math.min(10, Game.planets['P1'].groundStore.ore) });
                }
                const st = Game.stations['ST:P1'];
                if (st && st.store.ore > 0) {
                    Game.market.createOrder({
                        type: ORDER_SELL,
                        resourceType: RESOURCE_ORE,
                        price: 2.2,
                        totalAmount: st.store.ore,
                        stationId: 'ST:P1',
                    });
                }
            };
        "#,
        ),
    );

    let profs = ["env_recycle", "agri_bio", "mining_ind"];
    let planets = ["P2", "P2", "P1"];
    for idx in 0..6 {
        let cid = format!("npc_{idx}");
        world
            .spawn_company(
                &cid,
                format!("NPC-{idx}"),
                false,
                profs[idx % 3],
                planets[idx % 3],
                8_000.0,
            )
            .unwrap();
        runner.register_npc(&cid, NpcGenome::from_seed(1000 + idx as u64));
    }

    for _ in 0..40 {
        let rep = runner.step_world(&mut world);
        assert_eq!(
            world.conservation_error(),
            0,
            "conservation drifted at tick {}",
            rep.tick
        );
    }

    let p_out = &runner.last_player_outputs["player_main"];
    assert!(p_out.error.is_none(), "player JS error: {:?}", p_out.error);
}

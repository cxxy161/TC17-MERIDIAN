use std::path::PathBuf;
use std::sync::Arc;

use axum::body::Body;
use axum::http::{Request, StatusCode};
use http_body_util::BodyExt;
use meridian_core::{from_money, to_money, BankOpKind, Intent};
use meridian_server::engine::{IntentQueueError, MAX_MANUAL_INTENTS_PER_COMPANY};
use meridian_server::{build_router, GameEngine, SqliteStore};
use serde_json::Value;
use tokio::sync::Mutex;
use tower::ServiceExt;

/// argon2 HASH_GATE 是进程级 semaphore(1)：并行跑用例时多个 tokio 测试会同时排队哈希，
/// 叠加 debug 构建 + 1200 tick 重负载可能超过 2s 等待窗（表现为 503）。
/// 这里用测试级互斥把用例串行化，断言本身不做任何放宽。
static TEST_SERIAL: std::sync::Mutex<()> = std::sync::Mutex::new(());

fn serial_guard() -> std::sync::MutexGuard<'static, ()> {
    TEST_SERIAL
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}

fn data_json_path() -> PathBuf {
    let manifest_dir = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
    manifest_dir
        .join("..")
        .join("..")
        .join("..")
        .join("data")
        .join("production.json")
}

async fn read_json(resp: axum::response::Response) -> (StatusCode, Value) {
    let status = resp.status();
    let bytes = resp.into_body().collect().await.unwrap().to_bytes();
    let val = serde_json::from_slice(&bytes).unwrap_or(Value::Null);
    (status, val)
}

#[tokio::test]
async fn test_server_http_endpoints_hot_reload_and_sqlite_persistence() {
    let _serial = serial_guard();
    let db_dir = std::env::temp_dir().join(format!("meridian_test_{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&db_dir);
    std::fs::create_dir_all(&db_dir).unwrap();
    let db_path = db_dir.join("test.db");

    {
        let store = SqliteStore::open(&db_path).expect("open sqlite");
        let engine = GameEngine::bootstrap(data_json_path(), store, 2000).expect("bootstrap");
        let shared = Arc::new(Mutex::new(engine));
        let app = build_router(Arc::clone(&shared), None);

        // 0. 注册首个账号：它会接管预置的 player1 公司并成为管理员
        let reg_body = serde_json::json!({
            "email": "pilot@meridian.test",
            "nickname": "Pilot",
            "password": "correct-horse-battery",
        });
        let reg_resp = app
            .clone()
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri("/api/auth/register")
                    .header("content-type", "application/json")
                    .body(Body::from(reg_body.to_string()))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(reg_resp.status(), StatusCode::OK);
        let cookie = reg_resp
            .headers()
            .get("set-cookie")
            .expect("register must set session cookie")
            .to_str()
            .unwrap()
            .split(';')
            .next()
            .unwrap()
            .to_string();

        // 1. Health & catalog
        let (st, health) = read_json(
            app.clone()
                .oneshot(Request::builder().header("cookie", &cookie).uri("/api/health").body(Body::empty()).unwrap())
                .await
                .unwrap(),
        )
        .await;
        assert_eq!(st, StatusCode::OK);
        assert_eq!(health["ok"], true);
        assert_eq!(health["conservation_error"], 0);
        assert_eq!(health["companies_count"], 49);

        let (st, cat) = read_json(
            app.clone()
                .oneshot(Request::builder().header("cookie", &cookie).uri("/api/catalog").body(Body::empty()).unwrap())
                .await
                .unwrap(),
        )
        .await;
        assert_eq!(st, StatusCode::OK);
        assert_eq!(cat["items"].as_array().unwrap().len(), 18);

        // 2. Fetch /api/state to inspect procedural 3..=9 planets, single S1 system, and player1 home planet
        let (st, init_state) = read_json(
            app.clone()
                .oneshot(
                    Request::builder()
                        .header("cookie", &cookie)
                        .uri("/api/state?company_id=player1")
                        .body(Body::empty())
                        .unwrap(),
                )
                .await
                .unwrap(),
        )
        .await;
        assert_eq!(st, StatusCode::OK);
        let init_planets = init_state["planets"].as_array().unwrap().len();
        assert!(
            (2..=5).contains(&init_planets),
            "expected 2..=5 generated planets, got {init_planets}"
        );
        assert_eq!(init_state["systems"].as_array().unwrap().len(), 1);
        let home_pid = init_state["player_snapshot"]["company"]["home_planet_id"]
            .as_str()
            .unwrap()
            .to_string();

        // 2b. Hot-reload player1 multi-module script via PUT /api/scripts/player1
        let put_body = serde_json::json!({
            "modules": {
                "main": "const m = require('custom'); module.exports.loop = function() { Memory.tag = m.tag; console.log('hot-reloaded'); };",
                "custom": "exports.tag = 'v2-hot';"
            },
            "enabled": true
        });
        let (st, put_res) = read_json(
            app.clone()
                .oneshot(
                    Request::builder().header("cookie", &cookie)
                        .method("PUT")
                        .uri("/api/scripts/player1")
                        .header("content-type", "application/json")
                        .body(Body::from(put_body.to_string()))
                        .unwrap(),
                )
                .await
                .unwrap(),
        )
        .await;
        assert_eq!(st, StatusCode::OK);
        assert_eq!(put_res["ok"], true);

        // 2c. Real-sandbox console evaluation via POST /api/console/eval
        let eval_body = serde_json::json!({
            "company_id": "player1",
            "code": "Memory.consoleSeen = 7; Game.catalog.recipesByBuilding['mine_smelter']"
        });
        let (st, eval_res) = read_json(
            app.clone()
                .oneshot(
                    Request::builder()
                        .header("cookie", &cookie)
                        .method("POST")
                        .uri("/api/console/eval")
                        .header("content-type", "application/json")
                        .body(Body::from(eval_body.to_string()))
                        .unwrap(),
                )
                .await
                .unwrap(),
        )
        .await;
        assert_eq!(st, StatusCode::OK);
        assert!(eval_res["error"].is_null(), "console eval error: {:?}", eval_res["error"]);
        assert_eq!(eval_res["memory_changed"], true);
        assert_eq!(eval_res["cpu_limit_ms"], 10);
        assert!(eval_res["result"]["value"].is_array());

        // 3. Queue manual intent (deposit 50 credits into player1 home planet bank)
        let intent_body = serde_json::json!({
            "company_id": "player1",
            "intent": Intent::BankOp {
                planet_id: home_pid.clone(),
                op: BankOpKind::Deposit,
                amount: to_money(50.0),
            }
        });
        let (st, _) = read_json(
            app.clone()
                .oneshot(
                    Request::builder().header("cookie", &cookie)
                        .method("POST")
                        .uri("/api/intent")
                        .header("content-type", "application/json")
                        .body(Body::from(intent_body.to_string()))
                        .unwrap(),
                )
                .await
                .unwrap(),
        )
        .await;
        assert_eq!(st, StatusCode::OK);

        // 4. Step 10 ticks cleanly via /api/sim/control
        for _ in 0..10 {
            let (st, step_res) = read_json(
                app.clone()
                    .oneshot(
                        Request::builder().header("cookie", &cookie)
                            .method("POST")
                            .uri("/api/sim/control")
                            .header("content-type", "application/json")
                            .body(Body::from(r#"{"action":"step"}"#))
                            .unwrap(),
                    )
                    .await
                    .unwrap(),
            )
            .await;
            assert_eq!(st, StatusCode::OK);
            assert_eq!(step_res["conservation_error"], 0);
        }

        // 5. Inspect state & scripts endpoint -> verify hot-reloaded Memory + manual bank deposit + logs
        let (st, script_res) = read_json(
            app.clone()
                .oneshot(
                    Request::builder().header("cookie", &cookie)
                        .uri("/api/scripts/player1")
                        .body(Body::empty())
                        .unwrap(),
                )
                .await
                .unwrap(),
        )
        .await;
        assert_eq!(st, StatusCode::OK);
        let mem: Value = serde_json::from_str(script_res["memory_json"].as_str().unwrap()).unwrap();
        assert_eq!(mem["tag"], "v2-hot");

        let (st, state_res) = read_json(
            app.clone()
                .oneshot(
                    Request::builder().header("cookie", &cookie)
                        .uri("/api/state?company_id=player1")
                        .body(Body::empty())
                        .unwrap(),
                )
                .await
                .unwrap(),
        )
        .await;
        assert_eq!(st, StatusCode::OK);
        assert_eq!(state_res["tick"], 10);
        let p1_savings = from_money(state_res["player_snapshot"]["company"]["savings"].as_i64().unwrap());
        assert!(p1_savings >= 50.0, "expected bank savings >= 50, got {p1_savings}");

        // 6. Inspect market book & candles endpoint
        let (st, book_res) = read_json(
            app.clone()
                .oneshot(
                    Request::builder().header("cookie", &cookie)
                        .uri("/api/market/book?station_id=ST:HUB&item_id=steel")
                        .body(Body::empty())
                        .unwrap(),
                )
                .await
                .unwrap(),
        )
        .await;
        assert_eq!(st, StatusCode::OK);
        assert_eq!(book_res["station_id"], "ST:HUB");
        assert!(book_res["bid_orders"].is_array());
        assert!(book_res["ask_orders"].is_array());

        // 6a2. Inspect /api/planets/{planet_id}/plots public land grid endpoint
        let (st, plots_res) = read_json(
            app.clone()
                .oneshot(
                    Request::builder()
                        .header("cookie", &cookie)
                        .uri(format!("/api/planets/{home_pid}/plots"))
                        .body(Body::empty())
                        .unwrap(),
                )
                .await
                .unwrap(),
        )
        .await;
        assert_eq!(st, StatusCode::OK);
        assert_eq!(plots_res["planet"]["id"], home_pid);
        let tiles_arr = plots_res["tiles"].as_array().unwrap();
        assert!(tiles_arr.len() >= 48);
        assert!(tiles_arr.iter().any(|t| t["is_mine"] == true));
        assert!(tiles_arr.iter().any(|t| t["status"] == "unclaimed" && t["slot_id"].is_number()));
        for city in tiles_arr.iter().filter(|t| t["is_city"] == true) {
            assert_eq!(city["capacity"], 0);
            assert_eq!(city["building_mods"].as_object().unwrap().len(), 0);
        }
        assert_eq!(book_res["item_id"], "steel");

        // 6b. Inspect admin overview & /admin page endpoints
        let admin_html_resp = app
            .clone()
            .oneshot(Request::builder().header("cookie", &cookie).uri("/admin").body(Body::empty()).unwrap())
            .await
            .unwrap();
        assert_eq!(admin_html_resp.status(), StatusCode::OK);
        let admin_html = String::from_utf8(
            admin_html_resp.into_body().collect().await.unwrap().to_bytes().to_vec(),
        )
        .unwrap();
        assert!(admin_html.contains("<script src=\"/admin.js\"></script>"));
        assert!(!admin_html.contains("<script>"));

        let admin_js_resp = app
            .clone()
            .oneshot(Request::builder().uri("/admin.js").body(Body::empty()).unwrap())
            .await
            .unwrap();
        assert_eq!(admin_js_resp.status(), StatusCode::OK);
        let admin_js_ct = admin_js_resp
            .headers()
            .get("content-type")
            .unwrap()
            .to_str()
            .unwrap();
        assert!(admin_js_ct.contains("javascript"));
        let admin_js = String::from_utf8(
            admin_js_resp.into_body().collect().await.unwrap().to_bytes().to_vec(),
        )
        .unwrap();
        assert!(!admin_js.contains("onclick="));

        let (st, admin_res) = read_json(
            app.clone()
                .oneshot(
                    Request::builder().header("cookie", &cookie)
                        .uri("/api/admin/overview")
                        .body(Body::empty())
                        .unwrap(),
                )
                .await
                .unwrap(),
        )
        .await;
        assert_eq!(st, StatusCode::OK);
        assert_eq!(admin_res["conservation_error"], 0);
        assert_eq!(admin_res["companies"].as_array().unwrap().len(), 49);
        assert_eq!(admin_res["planets"].as_array().unwrap().len(), init_planets);

        // 6c. Verify max-speed (tick_ms=0) sim control works
        let (st, speed_res) = read_json(
            app.clone()
                .oneshot(
                    Request::builder().header("cookie", &cookie)
                        .method("POST")
                        .uri("/api/sim/control")
                        .header("content-type", "application/json")
                        .body(Body::from(r#"{"action":"speed","tick_ms":0}"#))
                        .unwrap(),
                )
                .await
                .unwrap(),
        )
        .await;
        assert_eq!(st, StatusCode::OK);
        assert_eq!(speed_res["tick_ms"], 0);
    }

    // 7. Re-open SQLite DB cleanly and verify world + custom script + memory restored at tick 10!
    {
        let store2 = SqliteStore::open(&db_path).expect("reopen sqlite");
        let eng2 = GameEngine::bootstrap(data_json_path(), store2, 2000).expect("restore");
        assert_eq!(eng2.world.tick, 10);
        assert_eq!(eng2.world.conservation_error(), 0);
        let pvm = &eng2.runner.players["player1"];
        assert!(pvm.bundle.modules.contains_key("custom"));
        let mem: Value = serde_json::from_str(&pvm.memory_json).unwrap();
        assert_eq!(mem["tag"], "v2-hot");
    }

    let _ = std::fs::remove_dir_all(&db_dir);
}

#[test]
fn test_long_horizon_1200_ticks_economy_never_stalls() {
    let _serial = serial_guard();
    let db_dir = std::env::temp_dir().join(format!("meridian_long_{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&db_dir);
    std::fs::create_dir_all(&db_dir).unwrap();
    let db_path = db_dir.join("long.db");

    let store = SqliteStore::open(&db_path).expect("open sqlite");
    let mut engine = GameEngine::bootstrap(data_json_path(), store, 2000).expect("bootstrap");

    assert_eq!(engine.world.systems.len(), 1);
    assert!((2..=5).contains(&engine.world.planets.len()));
    let planet_ids: Vec<String> = engine.world.planets.keys().cloned().collect();

    let mut buckets = [0usize; 6];
    let mut item_fills: std::collections::HashMap<String, (usize, u32)> =
        std::collections::HashMap::new();
    let mut late_item_fills: std::collections::HashMap<String, (usize, u32)> =
        std::collections::HashMap::new();
    let mut total_bankruptcies = 0usize;
    for t in 0..1200 {
        let out = engine.step_once().expect("step_once");
        assert_eq!(out.conservation_error, 0, "conservation violated at tick {}", out.tick);
        for pid in &planet_ids {
            assert!(
                engine.world.npc_plot_count_on(pid) <= engine.world.npc_plot_cap_on(pid),
                "NPC plot cap (90%) exceeded on {pid} at tick {}",
                out.tick
            );
        }
        buckets[t / 200] += out.fills_count;
        total_bankruptcies += out.bankruptcies.len();
    }
    for sid in engine.world.stations.keys() {
        for iid in engine.world.catalog.items.keys() {
            if let Ok(trs) = engine.store.query_recent_trades(sid, iid, 4000) {
                for tr in trs {
                    let e = item_fills.entry(tr.item_id.clone()).or_insert((0, 0));
                    e.0 += 1;
                    e.1 += tr.qty;
                    if tr.tick >= 800 {
                        let le = late_item_fills.entry(tr.item_id.clone()).or_insert((0, 0));
                        le.0 += 1;
                        le.1 += tr.qty;
                    }
                }
            }
        }
    }
    eprintln!("items_recent_all={item_fills:?} items_tick_800_plus={late_item_fills:?}");

    let mut fuel_total = 0u32;
    let mut water_total = 0u32;
    let mut power_total = 0u32;
    let mut prof_counts: std::collections::HashMap<String, usize> = std::collections::HashMap::new();
    for c in engine.world.companies.values() {
        if c.is_player {
            continue;
        }
        *prof_counts.entry(c.profession.clone()).or_insert(0) += 1;
        for inv in c.station_inv.values() {
            fuel_total += inv.get("fuel").copied().unwrap_or(0);
            water_total += inv.get("water").copied().unwrap_or(0);
            power_total += inv.get("power").copied().unwrap_or(0);
        }
        for inv in c.ground_inv.values() {
            fuel_total += inv.get("fuel").copied().unwrap_or(0);
            water_total += inv.get("water").copied().unwrap_or(0);
            power_total += inv.get("power").copied().unwrap_or(0);
        }
    }
    eprintln!(
        "1200-tick buckets={buckets:?} bankruptcies={total_bankruptcies} profs={prof_counts:?} fuel={fuel_total} water={water_total} power={power_total} late_items={}",
        late_item_fills.len()
    );
    let _ = std::fs::remove_dir_all(&db_dir);

    assert!(
        buckets[4] >= 30 && buckets[5] >= 30,
        "late-game market stalled: buckets={buckets:?}, profs={prof_counts:?}, fuel={fuel_total}"
    );
    assert!(
        late_item_fills.len() >= 6,
        "market degenerated to too few active items in ticks 800..1200: {late_item_fills:?}"
    );
    assert!(
        prof_counts.get("agri_bio").copied().unwrap_or(0) >= 4
            && prof_counts.get("mining_ind").copied().unwrap_or(0) >= 4
            && prof_counts.get("env_recycle").copied().unwrap_or(0) >= 4,
        "profession extinction occurred: {prof_counts:?}"
    );
    let total_npcs: usize = prof_counts.values().sum();
    assert!(
        (40..=72).contains(&total_npcs),
        "expected healthy 40..=72 active NPCs after startups/bankruptcies, got {total_npcs}"
    );
    assert!(fuel_total >= 40, "system-wide fuel extinction: fuel={fuel_total}");
}

async fn send(app: &axum::Router, req: Request<Body>) -> (StatusCode, Value, Option<String>) {
    let resp = app.clone().oneshot(req).await.unwrap();
    let status = resp.status();
    let cookie = resp
        .headers()
        .get("set-cookie")
        .and_then(|v| v.to_str().ok())
        .map(|v| v.split(';').next().unwrap().to_string());
    let bytes = resp.into_body().collect().await.unwrap().to_bytes();
    let val = serde_json::from_slice(&bytes).unwrap_or(Value::Null);
    (status, val, cookie)
}

fn register_request(email: &str, nickname: &str, password: &str) -> Request<Body> {
    Request::builder()
        .method("POST")
        .uri("/api/auth/register")
        .header("content-type", "application/json")
        .body(Body::from(
            serde_json::json!({ "email": email, "nickname": nickname, "password": password })
                .to_string(),
        ))
        .unwrap()
}

fn login_request(email: &str, password: &str) -> Request<Body> {
    Request::builder()
        .method("POST")
        .uri("/api/auth/login")
        .header("content-type", "application/json")
        .body(Body::from(
            serde_json::json!({ "email": email, "password": password, "remember": true }).to_string(),
        ))
        .unwrap()
}

#[tokio::test]
async fn test_auth_register_login_ownership_and_admin() {
    let _serial = serial_guard();
    let store = SqliteStore::open_in_memory().expect("open in-memory sqlite");
    let engine = GameEngine::bootstrap(data_json_path(), store, 2000).expect("bootstrap");
    let shared = Arc::new(Mutex::new(engine));
    let app = build_router(Arc::clone(&shared), None);

    // 1. 匿名访问玩家接口一律 401
    let (st, _, _) = send(&app, Request::builder().uri("/api/state").body(Body::empty()).unwrap()).await;
    assert_eq!(st, StatusCode::UNAUTHORIZED, "anonymous /api/state must be 401");

    let (st, _, _) = send(
        &app,
        Request::builder()
            .method("PUT")
            .uri("/api/scripts/player1")
            .header("content-type", "application/json")
            .body(Body::from(r#"{"modules":{"main":"module.exports.loop=()=>{};"}}"#))
            .unwrap(),
    )
    .await;
    assert_eq!(st, StatusCode::UNAUTHORIZED, "anonymous script write must be 401");

    // 2. 首个注册者：接管 player1 并成为管理员
    let (st, body, cookie_a) = send(&app, register_request("alpha@meridian.test", "Alpha", "password-123")).await;
    assert_eq!(st, StatusCode::OK);
    assert_eq!(body["company_id"], "player1");
    assert_eq!(body["role"], "admin");
    let cookie_a = cookie_a.expect("register must return cookie");

    // 3. 会话可用
    let (st, me, _) = send(
        &app,
        Request::builder()
            .uri("/api/auth/me")
            .header("cookie", &cookie_a)
            .body(Body::empty())
            .unwrap(),
    )
    .await;
    assert_eq!(st, StatusCode::OK);
    assert_eq!(me["nickname"], "Alpha");

    // 4. 邮箱重复 → 409 且指明字段
    let (st, dup, _) = send(&app, register_request("alpha@meridian.test", "AlphaTwo", "password-123")).await;
    assert_eq!(st, StatusCode::CONFLICT);
    assert_eq!(dup["field"], "email");

    // 5. 密码错误 → 401；正确 → 200 且发新 cookie
    let (st, _, _) = send(&app, login_request("alpha@meridian.test", "wrong-password")).await;
    assert_eq!(st, StatusCode::UNAUTHORIZED);
    let (st, _, login_cookie) = send(&app, login_request("alpha@meridian.test", "password-123")).await;
    assert_eq!(st, StatusCode::OK);
    assert!(login_cookie.is_some(), "login must set cookie");

    // 6. 第二个账号：新公司 u2，普通玩家
    let (st, body_b, cookie_b) = send(&app, register_request("beta@meridian.test", "Beta", "password-123")).await;
    assert_eq!(st, StatusCode::OK);
    assert_eq!(body_b["company_id"], "u2");
    assert_eq!(body_b["role"], "player");
    let cookie_b = cookie_b.expect("register must return cookie");

    // 7. 越权读他人公司 → 403（普通玩家 B 读 A 的 player1）
    let (st, _, _) = send(
        &app,
        Request::builder()
            .uri("/api/state?company_id=player1")
            .header("cookie", &cookie_b)
            .body(Body::empty())
            .unwrap(),
    )
    .await;
    assert_eq!(st, StatusCode::FORBIDDEN, "cross-account state read must be 403");

    // 7b. 管理员可以查看任意公司（便于运维排查）
    let (st, _, _) = send(
        &app,
        Request::builder()
            .uri("/api/state?company_id=u2")
            .header("cookie", &cookie_a)
            .body(Body::empty())
            .unwrap(),
    )
    .await;
    assert_eq!(st, StatusCode::OK, "admin may read any company");

    // 8. 管理员接口：A 可以，B 403
    let (st, _, _) = send(
        &app,
        Request::builder()
            .method("POST")
            .uri("/api/sim/control")
            .header("content-type", "application/json")
            .header("cookie", &cookie_b)
            .body(Body::from(r#"{"action":"pause"}"#))
            .unwrap(),
    )
    .await;
    assert_eq!(st, StatusCode::FORBIDDEN, "non-admin sim control must be 403");

    let (st, _, _) = send(
        &app,
        Request::builder()
            .method("POST")
            .uri("/api/sim/control")
            .header("content-type", "application/json")
            .header("cookie", &cookie_a)
            .body(Body::from(r#"{"action":"pause"}"#))
            .unwrap(),
    )
    .await;
    assert_eq!(st, StatusCode::OK, "admin sim control must succeed");

    // 9. 账号信息 + 会话列表
    let (st, account, _) = send(
        &app,
        Request::builder()
            .uri("/api/account")
            .header("cookie", &cookie_b)
            .body(Body::empty())
            .unwrap(),
    )
    .await;
    assert_eq!(st, StatusCode::OK);
    assert_eq!(account["email"], "beta@meridian.test");
    assert_eq!(account["sessions"].as_array().unwrap().len(), 1);
    assert_eq!(account["sessions"][0]["current"], true);

    // 10. 登出后会话失效
    let (st, _, _) = send(
        &app,
        Request::builder()
            .method("POST")
            .uri("/api/auth/logout")
            .header("cookie", &cookie_a)
            .body(Body::empty())
            .unwrap(),
    )
    .await;
    assert_eq!(st, StatusCode::OK);
    let (st, _, _) = send(
        &app,
        Request::builder()
            .uri("/api/auth/me")
            .header("cookie", &cookie_a)
            .body(Body::empty())
            .unwrap(),
    )
    .await;
    assert_eq!(st, StatusCode::UNAUTHORIZED, "logged-out cookie must be rejected");
}

#[tokio::test]
async fn test_public_company_endpoint_and_leaderboard_omit_secrets() {
    let _serial = serial_guard();
    let store = SqliteStore::open_in_memory().expect("open in-memory sqlite");
    let engine = GameEngine::bootstrap(data_json_path(), store, 2000).expect("bootstrap");
    let shared = Arc::new(Mutex::new(engine));
    let app = build_router(Arc::clone(&shared), None);

    let (st, _, cookie_opt) = send(&app, register_request("scout@meridian.test", "Scout", "password-123")).await;
    assert_eq!(st, StatusCode::OK);
    let cookie = cookie_opt.expect("register must set cookie");

    // 1. Leaderboard rows expose home_planet_id, asset counts, and net_liquid ONLY (no profession/cash/savings/debt)
    let (st, state_res, _) = send(
        &app,
        Request::builder()
            .uri("/api/state")
            .header("cookie", &cookie)
            .body(Body::empty())
            .unwrap(),
    )
    .await;
    assert_eq!(st, StatusCode::OK);
    let lb = state_res["leaderboard"].as_array().unwrap();
    assert!(!lb.is_empty());
    let first = lb[0].as_object().unwrap();
    assert!(first.contains_key("net_liquid"));
    assert!(first.contains_key("home_planet_id"));
    assert!(first.contains_key("plots_count"));
    assert!(first.contains_key("buildings_count"));
    assert!(first.contains_key("ships_count"));
    assert!(first.contains_key("open_orders_count"));
    for forbidden in ["profession", "cash", "savings", "debt"] {
        assert!(!first.contains_key(forbidden), "leaderboard leaked {forbidden}");
    }

    // 2. GET /api/companies/:id works cross-company and omits private financial/inventory/recipe/route data
    let target_id = lb.iter().find(|r| r["is_player"] == false).unwrap()["id"].as_str().unwrap();
    let (st, detail, _) = send(
        &app,
        Request::builder()
            .uri(format!("/api/companies/{target_id}"))
            .header("cookie", &cookie)
            .body(Body::empty())
            .unwrap(),
    )
    .await;
    assert_eq!(st, StatusCode::OK);
    let obj = detail.as_object().unwrap();
    assert!(obj.contains_key("net_liquid"));
    assert!(obj.contains_key("building_counts"));
    assert!(obj.contains_key("plots"));
    assert!(obj.contains_key("open_orders"));
    assert!(obj.contains_key("ships_by_size"));
    for forbidden in ["profession", "cash", "savings", "debt", "ground_inv", "station_inv", "ships", "distress_ticks"] {
        assert!(!obj.contains_key(forbidden), "company detail leaked {forbidden}");
    }
    let (st, _, _) = send(
        &app,
        Request::builder()
            .uri("/api/companies/does_not_exist")
            .header("cookie", &cookie)
            .body(Body::empty())
            .unwrap(),
    )
    .await;
    assert_eq!(st, StatusCode::NOT_FOUND);
}

#[tokio::test]
async fn test_admin_telemetry_and_player_ops() {
    let _serial = serial_guard();
    let store = SqliteStore::open_in_memory().expect("open in-memory sqlite");
    let engine = GameEngine::bootstrap(data_json_path(), store, 2000).expect("bootstrap");
    let shared = Arc::new(Mutex::new(engine));
    let app = build_router(Arc::clone(&shared), None);

    // First user = admin (player1), second user = regular player (u2)
    let (st, _, admin_ck_opt) = send(&app, register_request("adm@meridian.test", "Boss", "password-123")).await;
    assert_eq!(st, StatusCode::OK);
    let admin_ck = admin_ck_opt.unwrap();

    let (st, u2_body, u2_ck_opt) = send(&app, register_request("ply@meridian.test", "Miner", "password-123")).await;
    assert_eq!(st, StatusCode::OK);
    let u2_ck = u2_ck_opt.unwrap();
    let u2_cid = u2_body["company_id"].as_str().unwrap().to_string();

    // Advance one tick so economy_history and tick phase timings are populated
    let (st, _, _) = send(
        &app,
        Request::builder()
            .method("POST")
            .uri("/api/sim/control")
            .header("content-type", "application/json")
            .header("cookie", &admin_ck)
            .body(Body::from(r#"{"action":"step"}"#))
            .unwrap(),
    )
    .await;
    assert_eq!(st, StatusCode::OK);

    // Non-admin must receive 403 on admin overview & ops
    let (st, _, _) = send(
        &app,
        Request::builder()
            .uri("/api/admin/overview")
            .header("cookie", &u2_ck)
            .body(Body::empty())
            .unwrap(),
    )
    .await;
    assert_eq!(st, StatusCode::FORBIDDEN);

    // Admin overview includes runtime, supply_chain, economy_history, accounts, recent_trades
    let (st, ov, _) = send(
        &app,
        Request::builder()
            .uri("/api/admin/overview")
            .header("cookie", &admin_ck)
            .body(Body::empty())
            .unwrap(),
    )
    .await;
    assert_eq!(st, StatusCode::OK);
    assert!(ov["runtime"]["tps"].is_number());
    assert!(ov["runtime"]["phases"]["world_tick_ms"].is_number());
    assert!(ov["runtime"]["memory"]["rss_bytes"].as_u64().unwrap() > 0);
    assert!(ov["supply_chain"]["total_buildings"].is_number());
    assert_eq!(ov["economy_history"].as_array().unwrap().len(), 1);
    let accounts = ov["accounts"].as_array().unwrap();
    assert_eq!(accounts.len(), 2);
    let u2_uid = accounts
        .iter()
        .find(|a| a["company_id"] == u2_cid)
        .unwrap()["id"]
        .as_i64()
        .unwrap();

    // Inspect & toggle player sandbox script
    let (st, sb, _) = send(
        &app,
        Request::builder()
            .uri(format!("/api/admin/player/{u2_cid}/sandbox"))
            .header("cookie", &admin_ck)
            .body(Body::empty())
            .unwrap(),
    )
    .await;
    assert_eq!(st, StatusCode::OK);
    assert_eq!(sb["enabled"], true);
    assert!(sb["modules"]["main"].is_string());

    let (st, tg, _) = send(
        &app,
        Request::builder()
            .method("POST")
            .uri(format!("/api/admin/player/{u2_cid}/script-toggle"))
            .header("content-type", "application/json")
            .header("cookie", &admin_ck)
            .body(Body::from(r#"{"enabled":false}"#))
            .unwrap(),
    )
    .await;
    assert_eq!(st, StatusCode::OK);
    assert_eq!(tg["enabled"], false);

    // Kick & disable u2 -> existing cookie rejected & login blocked
    let (st, _, _) = send(
        &app,
        Request::builder()
            .method("POST")
            .uri(format!("/api/admin/users/{u2_uid}/status"))
            .header("content-type", "application/json")
            .header("cookie", &admin_ck)
            .body(Body::from(r#"{"status":"disabled"}"#))
            .unwrap(),
    )
    .await;
    assert_eq!(st, StatusCode::OK);
    let (st, _, _) = send(
        &app,
        Request::builder()
            .uri("/api/auth/me")
            .header("cookie", &u2_ck)
            .body(Body::empty())
            .unwrap(),
    )
    .await;
    assert_eq!(st, StatusCode::UNAUTHORIZED);

    // Re-enable + reset password -> new password logs in cleanly
    let (st, _, _) = send(
        &app,
        Request::builder()
            .method("POST")
            .uri(format!("/api/admin/users/{u2_uid}/status"))
            .header("content-type", "application/json")
            .header("cookie", &admin_ck)
            .body(Body::from(r#"{"status":"active"}"#))
            .unwrap(),
    )
    .await;
    assert_eq!(st, StatusCode::OK);

    let (st, _, _) = send(
        &app,
        Request::builder()
            .method("POST")
            .uri(format!("/api/admin/users/{u2_uid}/password"))
            .header("content-type", "application/json")
            .header("cookie", &admin_ck)
            .body(Body::from(r#"{"password":"new-password-99"}"#))
            .unwrap(),
    )
    .await;
    assert_eq!(st, StatusCode::OK);

    let (st, _, _) = send(&app, login_request("ply@meridian.test", "new-password-99")).await;
    assert_eq!(st, StatusCode::OK);
}

/* ============================================================ 安全回归 */

fn login_request_with_xff(email: &str, password: &str, xff: &str) -> Request<Body> {
    Request::builder()
        .method("POST")
        .uri("/api/auth/login")
        .header("content-type", "application/json")
        .header("x-forwarded-for", xff)
        .body(Body::from(
            serde_json::json!({ "email": email, "password": password, "remember": false })
                .to_string(),
        ))
        .unwrap()
}

#[tokio::test]
async fn test_security_headers_csrf_body_limit_and_unknown_api() {
    let _serial = serial_guard();
    let store = SqliteStore::open_in_memory().expect("open in-memory sqlite");
    let engine = GameEngine::bootstrap(data_json_path(), store, 2000).expect("bootstrap");
    let shared = Arc::new(Mutex::new(engine));

    // 临时 dist：验证「未知 /api 回 JSON 404、其它未知路径回 SPA、静态资源照常」。
    let dist = std::env::temp_dir().join(format!("meridian_dist_{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dist);
    std::fs::create_dir_all(&dist).unwrap();
    std::fs::write(dist.join("index.html"), "<html>SPA-INDEX</html>").unwrap();
    std::fs::write(dist.join("asset.txt"), "asset-body").unwrap();

    let app = build_router(Arc::clone(&shared), Some(dist.clone()));

    // 1. 未知 /api/* → JSON 404（不能是 200 index.html），且带全套安全头
    let resp = app
        .clone()
        .oneshot(Request::builder().uri("/api/does-not-exist").body(Body::empty()).unwrap())
        .await
        .unwrap();
    assert_eq!(resp.status(), StatusCode::NOT_FOUND);
    assert_eq!(
        resp.headers().get("x-content-type-options").unwrap().to_str().unwrap(),
        "nosniff"
    );
    assert_eq!(resp.headers().get("x-frame-options").unwrap().to_str().unwrap(), "DENY");
    assert_eq!(
        resp.headers().get("referrer-policy").unwrap().to_str().unwrap(),
        "strict-origin-when-cross-origin"
    );
    assert!(
        resp.headers()
            .get("content-security-policy")
            .unwrap()
            .to_str()
            .unwrap()
            .contains("'unsafe-eval'"),
        "CSP 必须允许 'unsafe-eval'（ConsolePanel 使用 new Function）"
    );
    assert!(
        resp.headers().get("strict-transport-security").is_none(),
        "没有 X-Forwarded-Proto: https 时不得下发 HSTS"
    );
    let bytes = resp.into_body().collect().await.unwrap().to_bytes();
    let body: Value = serde_json::from_slice(&bytes).unwrap();
    assert!(body["message"].is_string());

    // 2. 未知非 /api 路径仍回 SPA index.html
    let resp = app
        .clone()
        .oneshot(Request::builder().uri("/dashboard").body(Body::empty()).unwrap())
        .await
        .unwrap();
    assert_eq!(resp.status(), StatusCode::OK);
    let bytes = resp.into_body().collect().await.unwrap().to_bytes();
    assert_eq!(String::from_utf8_lossy(&bytes), "<html>SPA-INDEX</html>");

    // 3. 静态资源照常由 ServeDir 提供
    let resp = app
        .clone()
        .oneshot(Request::builder().uri("/asset.txt").body(Body::empty()).unwrap())
        .await
        .unwrap();
    assert_eq!(resp.status(), StatusCode::OK);

    // 4. 反代声明 https 时才下发 HSTS
    let resp = app
        .clone()
        .oneshot(
            Request::builder()
                .uri("/api/health")
                .header("x-forwarded-proto", "https")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(resp.status(), StatusCode::OK);
    assert_eq!(
        resp.headers().get("strict-transport-security").unwrap().to_str().unwrap(),
        "max-age=31536000; includeSubDomains"
    );

    // 5. 认证响应带 Cache-Control: no-store
    let resp = app
        .clone()
        .oneshot(
            Request::builder()
                .method("POST")
                .uri("/api/auth/login")
                .header("content-type", "application/json")
                .body(Body::from(
                    r#"{"email":"nobody@meridian.test","password":"wrong-password"}"#,
                ))
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(resp.status(), StatusCode::UNAUTHORIZED);
    assert_eq!(resp.headers().get("cache-control").unwrap().to_str().unwrap(), "no-store");

    // 6. 非白名单 Origin 的写请求 → 403
    let resp = app
        .clone()
        .oneshot(
            Request::builder()
                .method("POST")
                .uri("/api/auth/login")
                .header("content-type", "application/json")
                .header("origin", "https://evil.example")
                .body(Body::from(
                    r#"{"email":"nobody@meridian.test","password":"wrong-password"}"#,
                ))
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(resp.status(), StatusCode::FORBIDDEN);

    // 6b. 同源 Origin（Origin 与 Host 一致）不得被误杀：正常进入登录逻辑 → 401
    let resp = app
        .clone()
        .oneshot(
            Request::builder()
                .method("POST")
                .uri("/api/auth/login")
                .header("content-type", "application/json")
                .header("host", "meridian.test")
                .header("origin", "https://meridian.test")
                .body(Body::from(
                    r#"{"email":"nobody@meridian.test","password":"wrong-password"}"#,
                ))
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(resp.status(), StatusCode::UNAUTHORIZED, "同源 Origin 不应被 CSRF 层拦截");

    // 7. Sec-Fetch-Site: cross-site → 403
    let resp = app
        .clone()
        .oneshot(
            Request::builder()
                .method("POST")
                .uri("/api/auth/login")
                .header("content-type", "application/json")
                .header("sec-fetch-site", "cross-site")
                .body(Body::from(
                    r#"{"email":"nobody@meridian.test","password":"wrong-password"}"#,
                ))
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(resp.status(), StatusCode::FORBIDDEN);

    // 8. 超过 2 MiB 的请求体 → 413
    let big = vec![b'a'; 2 * 1024 * 1024 + 1];
    let resp = app
        .clone()
        .oneshot(
            Request::builder()
                .method("POST")
                .uri("/api/auth/login")
                .header("content-type", "application/json")
                .body(Body::from(big))
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(resp.status(), StatusCode::PAYLOAD_TOO_LARGE);

    let _ = std::fs::remove_dir_all(&dist);
}

#[tokio::test]
async fn test_login_account_lockout_cannot_be_bypassed_by_spoofed_xff() {
    let _serial = serial_guard();
    let store = SqliteStore::open_in_memory().expect("open in-memory sqlite");
    let engine = GameEngine::bootstrap(data_json_path(), store, 2000).expect("bootstrap");
    let shared = Arc::new(Mutex::new(engine));
    let app = build_router(Arc::clone(&shared), None);

    let (st, _, _) = send(&app, register_request("lock@meridian.test", "Lock", "password-123")).await;
    assert_eq!(st, StatusCode::OK);

    // 每次轮换伪造 XFF；无可信 ConnectInfo 时 XFF 一律被忽略 → 第 5 次触发账号锁定。
    for i in 1..=4 {
        let xff = format!("203.0.113.{i}");
        let (st, _, _) =
            send(&app, login_request_with_xff("lock@meridian.test", "wrong-password", &xff)).await;
        assert_eq!(st, StatusCode::UNAUTHORIZED, "第 {i} 次失败应为 401");
    }
    let (st, body, _) = send(
        &app,
        login_request_with_xff("lock@meridian.test", "wrong-password", "203.0.113.5"),
    )
    .await;
    assert_eq!(st, StatusCode::TOO_MANY_REQUESTS, "第 5 次失败应触发账号锁定");
    assert!(body["cooldown_until"].is_number());

    // 锁定期间即使密码正确也拒绝
    let (st, _, _) = send(&app, login_request("lock@meridian.test", "password-123")).await;
    assert_eq!(st, StatusCode::TOO_MANY_REQUESTS);
}

#[tokio::test]
async fn test_login_by_nickname_case_insensitive_and_shared_lockout() {
    let _serial = serial_guard();
    let store = SqliteStore::open_in_memory().expect("open in-memory sqlite");
    let engine = GameEngine::bootstrap(data_json_path(), store, 2000).expect("bootstrap");
    let shared = Arc::new(Mutex::new(engine));
    let app = build_router(Arc::clone(&shared), None);

    let (st, _, _) = send(&app, register_request("nicklogin@meridian.test", "VegaPilot", "password-123")).await;
    assert_eq!(st, StatusCode::OK);

    // 昵称含 @ 必须拒绝，防止与邮箱混淆
    let (st, _, _) = send(&app, register_request("other@meridian.test", "Bad@Name", "password-123")).await;
    assert_eq!(st, StatusCode::BAD_REQUEST);

    // 通过昵称（忽略大小写）登录成功
    let (st, body, _) = send(&app, login_request("vegapilot", "password-123")).await;
    assert_eq!(st, StatusCode::OK);
    assert_eq!(body["email"], "nicklogin@meridian.test");
    assert_eq!(body["nickname"], "VegaPilot");

    // 混用邮箱与昵称输错 5 次也应共同触发账号锁定，锁定后昵称和邮箱都拒绝
    for _ in 0..3 {
        let (st, _, _) = send(&app, login_request("nicklogin@meridian.test", "wrong-1")).await;
        assert_eq!(st, StatusCode::UNAUTHORIZED);
    }
    let (st, _, _) = send(&app, login_request("VegaPilot", "wrong-2")).await;
    assert_eq!(st, StatusCode::UNAUTHORIZED);
    let (st, _, _) = send(&app, login_request("VegaPilot", "wrong-3")).await;
    assert_eq!(st, StatusCode::TOO_MANY_REQUESTS);

    let (st, _, _) = send(&app, login_request("nicklogin@meridian.test", "password-123")).await;
    assert_eq!(st, StatusCode::TOO_MANY_REQUESTS);
    let (st, _, _) = send(&app, login_request("VegaPilot", "password-123")).await;
    assert_eq!(st, StatusCode::TOO_MANY_REQUESTS);
}

#[test]
fn test_manual_intent_queue_has_per_company_cap() {
    let _serial = serial_guard();
    let store = SqliteStore::open_in_memory().expect("open in-memory sqlite");
    let mut engine = GameEngine::bootstrap(data_json_path(), store, 2000).expect("bootstrap");
    let home = engine
        .world
        .companies
        .get("player1")
        .expect("player1 must exist")
        .home_planet_id
        .clone();

    let make_intent = || Intent::BankOp {
        planet_id: home.clone(),
        op: BankOpKind::Deposit,
        amount: to_money(1.0),
    };

    for _ in 0..MAX_MANUAL_INTENTS_PER_COMPANY {
        engine
            .queue_manual_intent("player1".to_string(), make_intent())
            .expect("queue under cap must succeed");
    }
    let err = engine
        .queue_manual_intent("player1".to_string(), make_intent())
        .expect_err("queue over cap must fail");
    match err {
        IntentQueueError::QueueFull { company_id, limit } => {
            assert_eq!(company_id, "player1");
            assert_eq!(limit, MAX_MANUAL_INTENTS_PER_COMPANY);
        }
        other => panic!("expected QueueFull, got {other:?}"),
    }
    assert_eq!(
        engine.runner.extra_intents["player1"].len(),
        MAX_MANUAL_INTENTS_PER_COMPANY
    );
    assert!(matches!(
        engine.queue_manual_intent("does-not-exist".to_string(), make_intent()),
        Err(IntentQueueError::UnknownCompany(_))
    ));
}

#[tokio::test]
async fn test_auth_config_endpoint_returns_no_store_json() {
    let _serial = serial_guard();
    let store = SqliteStore::open_in_memory().expect("open in-memory sqlite");
    let engine = GameEngine::bootstrap(data_json_path(), store, 2000).expect("bootstrap");
    let shared = Arc::new(Mutex::new(engine));
    let app = build_router(Arc::clone(&shared), None);

    let resp = app
        .oneshot(
            Request::builder()
                .method("GET")
                .uri("/api/auth/config")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(resp.status(), StatusCode::OK);
    assert_eq!(
        resp.headers()
            .get("cache-control")
            .and_then(|v| v.to_str().ok()),
        Some("no-store")
    );
    let (_, body) = read_json(resp).await;
    assert!(body["turnstile_site_key"].is_string());
    assert!(body["turnstile_required"].is_boolean());
    assert!(body["turnstile_bypassed"].is_boolean());
}

#[tokio::test]
async fn test_player_deferred_onboarding_flow_and_conservation() {
    let _serial = serial_guard();
    let store = SqliteStore::open_in_memory().expect("open in-memory sqlite");
    let engine = GameEngine::bootstrap(data_json_path(), store, 1000).expect("bootstrap");
    let shared = Arc::new(Mutex::new(engine));
    let app = build_router(Arc::clone(&shared), None);

    // 1. Register with defer_onboarding: true (claims player1 slot as admin but needs onboarding)
    let reg_req = Request::builder()
        .method("POST")
        .uri("/api/auth/register")
        .header("content-type", "application/json")
        .body(Body::from(
            r#"{"email":"newpilot@meridian.test","nickname":"NewPilot","password":"password-123","defer_onboarding":true}"#,
        ))
        .unwrap();
    let (st, body, cookie_opt) = send(&app, reg_req).await;
    assert_eq!(st, StatusCode::OK);
    assert_eq!(body["needs_onboarding"], true);
    let cookie = cookie_opt.expect("must issue session cookie");

    // 2. Fetch onboarding options -> 3 professions (zero specialization bonuses) & planets with unclaimed tiles
    let (st, opts, _) = send(
        &app,
        Request::builder()
            .method("GET")
            .uri("/api/onboarding/options")
            .header("cookie", &cookie)
            .body(Body::empty())
            .unwrap(),
    )
    .await;
    assert_eq!(st, StatusCode::OK);
    assert_eq!(opts["professions"].as_array().unwrap().len(), 3);
    assert_eq!(opts["starter_cash"], 3500.0);
    assert!(opts["system"]["star_class"].is_string());
    let planet = opts["planets"]
        .as_array()
        .unwrap()
        .iter()
        .find(|p| p["unclaimed_count"].as_u64().unwrap_or(0) > 0)
        .expect("at least one planet with unclaimed tiles");
    assert!(planet["orbit_radius"].as_f64().unwrap_or(0.0) > 0.0);
    assert!(planet["solar_mult"].is_f64());
    assert!(planet["mineral_mult"].is_f64());
    assert!(planet["water_mult"].is_f64());
    assert!(planet["launch_cost"].is_array());
    let planet_id = planet["id"].as_str().unwrap().to_string();
    let slot_id = planet["tiles"][0]["slot_id"].as_u64().unwrap();

    // 3. Submit onboarding setup
    let setup_body = serde_json::json!({
        "company_name": "Starborne Agro",
        "profession": "agri_bio",
        "planet_id": planet_id,
        "slot_id": slot_id,
    });
    let (st, setup_res, _) = send(
        &app,
        Request::builder()
            .method("POST")
            .uri("/api/onboarding/setup")
            .header("content-type", "application/json")
            .header("cookie", &cookie)
            .body(Body::from(setup_body.to_string()))
            .unwrap(),
    )
    .await;
    assert_eq!(st, StatusCode::OK, "setup failed: {setup_res}");
    assert_eq!(setup_res["needs_onboarding"], false);

    // 4. Verify world company has 0 buildings, 1 ship, starter supplies, empty script, and zero conservation drift
    {
        let eng = shared.lock().await;
        assert_eq!(eng.world.conservation_error(), 0);
        let comp = &eng.world.companies["player1"];
        assert_eq!(comp.name, "Starborne Agro");
        assert_eq!(comp.profession, "agri_bio");
        assert_eq!(comp.home_planet_id, planet_id);
        assert_eq!(comp.ships.len(), 1);
        assert_eq!(comp.plots.len(), 1);
        let pl = &eng.world.plots[&comp.plots[0]];
        assert_eq!(pl.slot_id, slot_id as u32);
        assert!(pl.building_ids.is_empty(), "starter company must have zero factories");
        assert!(comp.ground_qty(&planet_id, "rations") >= 60);
        assert!(comp.ground_qty(&planet_id, "building_mat") >= 28);
        assert!(!eng.runner.players["player1"].bundle.modules["main"].contains("dispatch("));
    }

    // 5. Duplicate onboarding must be rejected with 409 Conflict
    let (st, _, _) = send(
        &app,
        Request::builder()
            .method("POST")
            .uri("/api/onboarding/setup")
            .header("content-type", "application/json")
            .header("cookie", &cookie)
            .body(Body::from(setup_body.to_string()))
            .unwrap(),
    )
    .await;
    assert_eq!(st, StatusCode::CONFLICT);
}

#[test]
fn test_manual_intent_rejection_surfaces_in_broadcast_and_state() {
    let _serial = serial_guard();
    let store = SqliteStore::open_in_memory().expect("open in-memory sqlite");
    let mut engine = GameEngine::bootstrap(data_json_path(), store, 1000).expect("bootstrap");

    let home_pid = engine.world.companies["player1"].home_planet_id.clone();
    let other_pid = engine
        .world
        .planets
        .keys()
        .find(|pid| *pid != &home_pid)
        .expect("at least 2 planets")
        .clone();

    engine
        .queue_manual_intent(
            "player1".to_string(),
            Intent::BankOp {
                planet_id: other_pid,
                op: meridian_core::BankOpKind::Deposit,
                amount: to_money(10.0),
            },
        )
        .expect("queue manual intent");

    let bcast = engine.step_once().expect("step_once");
    let rejs = bcast
        .company_rejections
        .get("player1")
        .expect("player1 must appear in company_rejections");
    assert_eq!(rejs.len(), 1);
    assert!(
        rejs[0].action.starts_with("manual:"),
        "expected manual: prefix, got {}",
        rejs[0].action
    );
    assert!(rejs[0].reason.contains("home planet"), "reason={}", rejs[0].reason);

    let state = engine.state_response("player1");
    assert_eq!(state.last_rejected.len(), 1);
    assert_eq!(state.last_rejected[0].action, rejs[0].action);
    assert_eq!(state.last_rejected[0].code, rejs[0].code);
}

#[test]
fn test_visible_flights_anonymizes_foreign_ships_and_marks_own() {
    let _serial = serial_guard();
    let store = SqliteStore::open_in_memory().expect("open in-memory sqlite");
    let mut engine = GameEngine::bootstrap(data_json_path(), store, 1000).expect("bootstrap");

    let home_pid = engine.world.companies["player1"].home_planet_id.clone();
    let ship_id = engine.world.companies["player1"].ships[0].id;
    let ship_loc = engine.world.companies["player1"].ships[0].location.clone();
    let dest = if ship_loc == home_pid {
        format!("ST:{home_pid}")
    } else {
        home_pid.clone()
    };

    engine
        .world
        .companies
        .get_mut("player1")
        .unwrap()
        .add_ground_qty(&home_pid, "fuel", 10);
    engine
        .world
        .companies
        .get_mut("player1")
        .unwrap()
        .add_station_qty(&format!("ST:{home_pid}"), "fuel", 10);

    // Also run NPCs alongside player1 dispatch
    engine
        .queue_manual_intent(
            "player1".to_string(),
            Intent::DispatchShip {
                ship_id,
                from: ship_loc,
                to: dest,
                cargo: Vec::new(),
            },
        )
        .expect("queue player1 dispatch");

    for _ in 0..8 {
        engine.step_once().expect("step_once");
        if !engine.world.in_flight.is_empty() {
            break;
        }
    }

    let state = engine.state_response("player1");
    let json = serde_json::to_value(&state.visible_flights).expect("serialize visible_flights");
    let arr = json.as_array().expect("visible_flights array");
    let own = arr.iter().find(|f| f["is_mine"] == true);
    if let Some(mine) = own {
        assert_eq!(mine["ship_id"].as_u64(), Some(ship_id));
        assert!(mine["launch_tick"].as_u64().unwrap_or(0) > 0);
        assert!(mine["arrival_tick"].as_u64().unwrap_or(0) >= mine["launch_tick"].as_u64().unwrap());
    }
    for foreign in arr.iter().filter(|f| f["is_mine"] == false) {
        assert!(foreign.get("ship_id").is_none(), "foreign flight must omit ship_id");
        assert!(foreign.get("owner_id").is_none(), "foreign flight must omit owner_id");
        assert!(foreign.get("cargo").is_none(), "foreign flight must omit cargo");
        assert!(foreign["key"].as_u64().is_some());
    }
}

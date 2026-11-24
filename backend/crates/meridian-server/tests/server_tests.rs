use std::path::PathBuf;
use std::sync::Arc;

use axum::body::Body;
use axum::http::{Request, StatusCode};
use http_body_util::BodyExt;
use meridian_core::{from_money, to_money, BankOpKind, Intent};
use meridian_server::{build_router, GameEngine, SqliteStore};
use serde_json::Value;
use tokio::sync::Mutex;
use tower::ServiceExt;

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
        assert_eq!(cat["items"].as_array().unwrap().len(), 16);

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
            (3..=9).contains(&init_planets),
            "expected 3..=9 generated planets, got {init_planets}"
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

        // 3. Queue manual intent (deposit 50 credits into player1 home planet bank)
        let intent_body = serde_json::json!({
            "company_id": "player1",
            "intent": Intent::BankOp {
                planet_id: home_pid,
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
        assert_eq!(book_res["item_id"], "steel");

        // 6b. Inspect admin overview & /admin page endpoints
        let admin_html_resp = app
            .clone()
            .oneshot(Request::builder().header("cookie", &cookie).uri("/admin").body(Body::empty()).unwrap())
            .await
            .unwrap();
        assert_eq!(admin_html_resp.status(), StatusCode::OK);

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
    let db_dir = std::env::temp_dir().join(format!("meridian_long_{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&db_dir);
    std::fs::create_dir_all(&db_dir).unwrap();
    let db_path = db_dir.join("long.db");

    let store = SqliteStore::open(&db_path).expect("open sqlite");
    let mut engine = GameEngine::bootstrap(data_json_path(), store, 2000).expect("bootstrap");

    assert_eq!(engine.world.systems.len(), 1);
    assert!((3..=9).contains(&engine.world.planets.len()));
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

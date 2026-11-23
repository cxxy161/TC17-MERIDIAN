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

        // 1. Health & catalog
        let (st, health) = read_json(
            app.clone()
                .oneshot(Request::builder().uri("/api/health").body(Body::empty()).unwrap())
                .await
                .unwrap(),
        )
        .await;
        assert_eq!(st, StatusCode::OK);
        assert_eq!(health["ok"], true);
        assert_eq!(health["conservation_error"], 0);
        assert_eq!(health["companies_count"], 13);

        let (st, cat) = read_json(
            app.clone()
                .oneshot(Request::builder().uri("/api/catalog").body(Body::empty()).unwrap())
                .await
                .unwrap(),
        )
        .await;
        assert_eq!(st, StatusCode::OK);
        assert_eq!(cat["items"].as_array().unwrap().len(), 16);

        // 2. Hot-reload player1 multi-module script via PUT /api/scripts/player1
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
                    Request::builder()
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

        // 3. Queue manual intent (deposit 50 credits into P1 bank)
        let intent_body = serde_json::json!({
            "company_id": "player1",
            "intent": Intent::BankOp {
                planet_id: "P1".to_string(),
                op: BankOpKind::Deposit,
                amount: to_money(50.0),
            }
        });
        let (st, _) = read_json(
            app.clone()
                .oneshot(
                    Request::builder()
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
                        Request::builder()
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
                    Request::builder()
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
                    Request::builder()
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
                    Request::builder()
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
            .oneshot(Request::builder().uri("/admin").body(Body::empty()).unwrap())
            .await
            .unwrap();
        assert_eq!(admin_html_resp.status(), StatusCode::OK);

        let (st, admin_res) = read_json(
            app.clone()
                .oneshot(
                    Request::builder()
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
        assert_eq!(admin_res["companies"].as_array().unwrap().len(), 13);
        assert_eq!(admin_res["planets"].as_array().unwrap().len(), 3);
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

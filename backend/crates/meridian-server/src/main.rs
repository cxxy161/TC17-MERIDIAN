use std::path::PathBuf;
use std::sync::Arc;
use std::time::Duration;

use meridian_server::{build_router, GameEngine, SharedEngine, SqliteStore};
use tokio::sync::Mutex;
use tracing::{error, info};

fn pick_existing_or_default(env_key: &str, candidates: &[&str], fallback: &str) -> PathBuf {
    if let Ok(v) = std::env::var(env_key) {
        return PathBuf::from(v);
    }
    for c in candidates {
        let p = PathBuf::from(c);
        if p.exists() {
            return p;
        }
    }
    PathBuf::from(fallback)
}

#[tokio::main]
async fn main() {
    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| "meridian_server=info,tower_http=info".into()),
        )
        .init();

    let data_path = pick_existing_or_default(
        "MERIDIAN_DATA_PATH",
        &["data/production.json", "../data/production.json"],
        "data/production.json",
    );
    let db_path = pick_existing_or_default(
        "MERIDIAN_DB_PATH",
        &["data/meridian.db", "../data/meridian.db"],
        "data/meridian.db",
    );
    let dist_dir = pick_existing_or_default(
        "MERIDIAN_DIST_DIR",
        &["frontend/dist", "../frontend/dist"],
        "frontend/dist",
    );
    let bind_addr = std::env::var("MERIDIAN_ADDR").unwrap_or_else(|_| "0.0.0.0:18420".to_string());
    let tick_ms: u64 = std::env::var("MERIDIAN_TICK_MS")
        .ok()
        .and_then(|s| s.parse().ok())
        .unwrap_or(2000);

    let store = SqliteStore::open(&db_path).expect("failed to open SQLite WAL database");
    let engine = GameEngine::bootstrap(data_path.clone(), store, tick_ms)
        .expect("failed to bootstrap GameEngine");
    let shared: SharedEngine = Arc::new(Mutex::new(engine));

    // Background deterministic tick loop
    {
        let bg = Arc::clone(&shared);
        tokio::spawn(async move {
            loop {
                let wait_ms = {
                    let mut eng = bg.lock().await;
                    if !eng.paused {
                        if let Err(e) = eng.step_once() {
                            error!("tick loop error: {e}");
                        }
                        eng.tick_ms
                    } else {
                        eng.tick_ms.max(50)
                    }
                };
                if wait_ms == 0 {
                    tokio::task::yield_now().await;
                } else {
                    tokio::time::sleep(Duration::from_millis(wait_ms)).await;
                }
            }
        });
    }

    let app = build_router(
        Arc::clone(&shared),
        if dist_dir.exists() {
            Some(dist_dir.clone())
        } else {
            None
        },
    );

    info!(
        "Meridian server listening on http://{bind_addr} (data={:?}, db={:?})",
        data_path, db_path
    );
    let listener = tokio::net::TcpListener::bind(&bind_addr)
        .await
        .expect("failed to bind TCP listener");

    axum::serve(listener, app)
        .with_graceful_shutdown(async {
            let _ = tokio::signal::ctrl_c().await;
        })
        .await
        .expect("axum serve failed");

    // Final world snapshot before exit
    let eng = shared.lock().await;
    if let Err(e) = eng.store.save_world(&eng.world) {
        error!("failed to save world on shutdown: {e}");
    } else {
        info!("World state saved cleanly at tick {}", eng.world.tick);
    }
}

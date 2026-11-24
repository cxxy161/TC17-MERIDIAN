use std::net::SocketAddr;
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
    let mut engine = GameEngine::bootstrap(data_path.clone(), store, tick_ms)
        .expect("failed to bootstrap GameEngine");

    // 可选：按环境变量创建初始管理员（幂等）
    match engine.seed_admin_from_env() {
        Ok(Some((email, company))) => {
            info!("已创建初始管理员账号 {email}（公司 {company}）");
        }
        Ok(None) => {}
        Err(e) => error!("初始管理员创建失败：{e}"),
    }

    // `--seed-admin`：只建号不进入模拟循环，便于对线上库做一次性初始化
    if std::env::args().any(|a| a == "--seed-admin") {
        info!("seed-admin 完成，退出");
        return;
    }

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

    let trusted_proxies = std::env::var("MERIDIAN_TRUSTED_PROXIES").unwrap_or_default();
    let allowed_origins = std::env::var("MERIDIAN_ALLOWED_ORIGINS").unwrap_or_default();
    if trusted_proxies.trim().is_empty() {
        info!(
            "MERIDIAN_TRUSTED_PROXIES 未配置：忽略所有 X-Forwarded-For，限流按 TCP peer IP 计（直连部署正确；反代部署必须配置）"
        );
    } else {
        info!(trusted_proxies = %trusted_proxies, "已启用可信反代 CIDR 名单");
    }
    if allowed_origins.trim().is_empty() {
        info!("MERIDIAN_ALLOWED_ORIGINS 未配置：不启用跨域（同源部署正确）");
    } else {
        info!(allowed_origins = %allowed_origins, "CORS 白名单已启用");
    }
    let tt_secret_set = meridian_server::auth::turnstile_secret_configured();
    let tt_site_key = meridian_server::auth::turnstile_site_key();
    let tt_skip_peers = std::env::var("MERIDIAN_TURNSTILE_SKIP_PEERS").unwrap_or_default();
    let tt_skip_hosts = std::env::var("MERIDIAN_TURNSTILE_SKIP_HOSTS").unwrap_or_default();
    if tt_secret_set {
        info!(
            site_key_set = !tt_site_key.is_empty(),
            skip_peers = %tt_skip_peers,
            skip_hosts = %tt_skip_hosts,
            "Cloudflare Turnstile 注册验证已启用"
        );
    } else {
        info!("MERIDIAN_TURNSTILE_SECRET 未配置：注册跳过人机验证");
    }

    info!(
        "Meridian server listening on http://{bind_addr} (data={:?}, db={:?})",
        data_path, db_path
    );
    let listener = tokio::net::TcpListener::bind(&bind_addr)
        .await
        .expect("failed to bind TCP listener");

    // 必须带 ConnectInfo：client_ip 只能基于可信 peer 判断是否采信 X-Forwarded-For。
    axum::serve(
        listener,
        app.into_make_service_with_connect_info::<SocketAddr>(),
    )
    .with_graceful_shutdown(async {
        let _ = tokio::signal::ctrl_c().await;
    })
    .await
    .expect("axum serve failed");

    // Final world snapshot before exit
    let mut eng = shared.lock().await;
    if let Err(e) = eng.flush_persistence() {
        error!("failed to save world on shutdown: {e}");
    } else {
        info!("World state saved cleanly at tick {}", eng.world.tick);
    }
}

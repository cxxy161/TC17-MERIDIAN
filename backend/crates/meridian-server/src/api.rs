//! Axum HTTP/REST & WebSocket gateway for simulation inspection, script hot-reloading,
//! market depth/candle queries, manual intents, and static frontend serving.

use std::collections::{BTreeMap, HashMap};
use std::convert::Infallible;
use std::path::PathBuf;
use std::sync::LazyLock;
use std::time::Duration;

use axum::extract::ws::{Message, WebSocket, WebSocketUpgrade};
use axum::extract::{Path, Query, Request, State};
use axum::http::{header, HeaderMap, HeaderName, HeaderValue, Method, StatusCode};
use axum::middleware::{self, Next};
use axum::response::{Html, IntoResponse, Response};
use axum::routing::{get, post, put};
use axum::{Json, Router};
use meridian_core::{from_money, Intent, MONEY_SCALE};
use meridian_sandbox::{normalize_module_name, NpcGenome, PlayerRunConfig, PlayerScriptBundle};
use serde::{Deserialize, Serialize};
use tower::limit::ConcurrencyLimitLayer;
use tower::ServiceExt;
use tower_http::cors::{AllowOrigin, CorsLayer};
use tower_http::limit::RequestBodyLimitLayer;
use tower_http::services::{ServeDir, ServeFile};
use tower_http::set_header::SetResponseHeaderLayer;
use tower_http::timeout::TimeoutLayer;

use crate::auth::{
    self, clear_cookie, client_ip, cookie_secure, ensure_owner, hash_password, new_token, now_secs,
    session_cookie, token_hash, verify_password, verify_turnstile, AdminUser, AuthUser, ClientAddr,
    SESSION_TTL_DEFAULT, SESSION_TTL_REMEMBER,
};
use crate::engine::{IntentQueueError, SharedEngine};
use crate::storage::{CandleRow, TradeRow};

const ADMIN_HTML: &str = include_str!("../assets/admin.html");
const ADMIN_JS: &str = include_str!("../assets/admin.js");

/// 请求体上限（2 MiB）。
const MAX_REQUEST_BODY_BYTES: usize = 2 * 1024 * 1024;
/// 同时在途请求上限；超出后排队，排队时间计入 TimeoutLayer。
const MAX_CONCURRENT_REQUESTS: usize = 256;
/// 单请求总超时（含排队与请求体读取）。
const REQUEST_TIMEOUT_SECS: u64 = 15;

const CONTENT_SECURITY_POLICY: &str = "default-src 'self'; script-src 'self' 'unsafe-eval' https://challenges.cloudflare.com https://static.cloudflareinsights.com; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self' data:; connect-src 'self' ws: wss: https://challenges.cloudflare.com https://cloudflareinsights.com; frame-src 'self' https://challenges.cloudflare.com; object-src 'none'; base-uri 'self'; form-action 'self'; frame-ancestors 'none'";

/// MERIDIAN_ALLOWED_ORIGINS（逗号分隔的完整 Origin，如 https://meridian.example.com）。
/// 为空 = 不启用跨域；显式拒绝 *（与 credentials 组合是浏览器的非法配置）。
static ALLOWED_ORIGINS: LazyLock<Vec<HeaderValue>> = LazyLock::new(|| {
    let raw = std::env::var("MERIDIAN_ALLOWED_ORIGINS").unwrap_or_default();
    let mut out = Vec::new();
    for item in raw.split(',') {
        let item = item.trim();
        if item.is_empty() {
            continue;
        }
        if item == "*" {
            tracing::warn!("MERIDIAN_ALLOWED_ORIGINS 不接受 *（与 credentials 冲突），已忽略");
            continue;
        }
        match item.parse::<HeaderValue>() {
            Ok(value) => out.push(value),
            Err(_) => {
                tracing::warn!(origin = item, "MERIDIAN_ALLOWED_ORIGINS 含无效 Origin，已忽略")
            }
        }
    }
    out
});

pub fn build_router(engine: SharedEngine, dist_dir: Option<PathBuf>) -> Router {
    let api_router = Router::new()
        .route("/admin", get(admin_page_handler))
        .route("/admin.html", get(admin_page_handler))
        .route("/admin.js", get(admin_js_handler))
        .route("/api/admin/overview", get(admin_overview_handler))
        .route("/api/admin/player/{company_id}/sandbox", get(admin_player_sandbox_handler))
        .route("/api/admin/player/{company_id}/script-toggle", post(admin_script_toggle_handler))
        .route("/api/admin/users/{user_id}/status", post(admin_user_status_handler))
        .route("/api/admin/users/{user_id}/kick", post(admin_user_kick_handler))
        .route("/api/admin/users/{user_id}/password", post(admin_user_password_handler))
        .route("/api/health", get(health_handler))
        .route("/api/catalog", get(catalog_handler))
        .route("/api/state", get(state_handler))
        .route("/api/planets/{planet_id}/plots", get(planet_plots_handler))
        .route("/api/companies/{company_id}", get(company_detail_handler))
        .route("/api/market/book", get(market_book_handler))
        .route("/api/market/candles", get(market_candles_handler))
        .route("/api/scripts/{company_id}", get(get_scripts_handler))
        .route("/api/scripts/{company_id}", put(put_scripts_handler))
        .route("/api/memory/{company_id}", put(put_memory_handler))
        .route("/api/intent", post(post_intent_handler))
        .route("/api/sim/control", post(sim_control_handler))
        .route("/api/companies", post(create_company_handler))
        .route("/api/auth/config", get(auth_config_handler))
        .route("/api/auth/register", post(register_handler))
        .route("/api/auth/login", post(login_handler))
        .route("/api/auth/logout", post(logout_handler))
        .route("/api/auth/me", get(me_handler))
        .route("/api/account", get(account_handler).patch(update_account_handler))
        .route("/api/account/password", post(change_password_handler))
        .route("/api/account/sessions/revoke", post(revoke_sessions_handler))
        .route("/ws", get(ws_handler))
        .with_state(engine);

    let app = match dist_dir {
        Some(dir) if dir.exists() => {
            let index = dir.join("index.html");
            let static_files = ServeDir::new(dir).fallback(ServeFile::new(index));
            // 未知 /api/* 必须回 JSON 404，不能被 SPA 兜底成 200 index.html。
            let guarded = tower::service_fn(move |req: Request| {
                let static_files = static_files.clone();
                async move {
                    if is_api_path(req.uri().path()) {
                        Ok::<_, Infallible>(api_not_found_response())
                    } else {
                        let response = static_files.oneshot(req).await?;
                        Ok::<_, Infallible>(response.map(axum::body::Body::new))
                    }
                }
            });
            api_router.fallback_service(guarded)
        }
        _ => api_router.fallback(api_not_found_handler),
    };

    let app = app
        .layer(middleware::from_fn(csrf_guard))
        .layer(RequestBodyLimitLayer::new(MAX_REQUEST_BODY_BYTES))
        .layer(ConcurrencyLimitLayer::new(MAX_CONCURRENT_REQUESTS))
        .layer(TimeoutLayer::with_status_code(
            StatusCode::REQUEST_TIMEOUT,
            Duration::from_secs(REQUEST_TIMEOUT_SECS),
        ))
        .layer(middleware::from_fn(security_headers));

    let app = static_security_headers(app);

    // CORS 放最外层：预检请求由 CORS 层直接响应，不会落进 CSRF 校验。
    match cors_layer() {
        Some(cors) => app.layer(cors),
        None => app,
    }
}

fn is_api_path(path: &str) -> bool {
    path == "/api" || path.starts_with("/api/")
}

fn api_not_found_response() -> Response {
    (
        StatusCode::NOT_FOUND,
        Json(serde_json::json!({ "message": "接口不存在" })),
    )
        .into_response()
}

async fn api_not_found_handler() -> Response {
    api_not_found_response()
}

fn forbidden_cross_site_response() -> Response {
    (
        StatusCode::FORBIDDEN,
        Json(serde_json::json!({ "message": "跨站请求被拒绝" })),
    )
        .into_response()
}

fn static_security_headers(app: Router) -> Router {
    app.layer(SetResponseHeaderLayer::overriding(
        header::X_CONTENT_TYPE_OPTIONS,
        HeaderValue::from_static("nosniff"),
    ))
    .layer(SetResponseHeaderLayer::overriding(
        header::X_FRAME_OPTIONS,
        HeaderValue::from_static("DENY"),
    ))
    .layer(SetResponseHeaderLayer::overriding(
        header::REFERRER_POLICY,
        HeaderValue::from_static("strict-origin-when-cross-origin"),
    ))
    .layer(SetResponseHeaderLayer::overriding(
        HeaderName::from_static("content-security-policy"),
        HeaderValue::from_static(CONTENT_SECURITY_POLICY),
    ))
}

fn cors_layer() -> Option<CorsLayer> {
    if ALLOWED_ORIGINS.is_empty() {
        return None;
    }
    // 显式 Origin 列表 + credentials；永远不会出现 * 与 credentials 的组合。
    Some(
        CorsLayer::new()
            .allow_origin(AllowOrigin::list(ALLOWED_ORIGINS.clone()))
            .allow_methods([
                Method::GET,
                Method::POST,
                Method::PUT,
                Method::PATCH,
                Method::OPTIONS,
            ])
            .allow_headers([header::CONTENT_TYPE])
            .allow_credentials(true),
    )
}

/// HSTS（仅当反代声明 X-Forwarded-Proto: https）与认证响应的 Cache-Control: no-store。
async fn security_headers(req: Request, next: Next) -> Response {
    let forwarded_https = req
        .headers()
        .get("x-forwarded-proto")
        .and_then(|v| v.to_str().ok())
        .map(|v| {
            v.split(',')
                .next()
                .unwrap_or("")
                .trim()
                .eq_ignore_ascii_case("https")
        })
        .unwrap_or(false);
    let no_store = {
        let path = req.uri().path();
        path.starts_with("/api/auth/")
            || path == "/api/auth"
            || path.starts_with("/api/account")
            || path == "/api/state"
    };
    let mut response = next.run(req).await;
    if forwarded_https {
        response.headers_mut().insert(
            header::STRICT_TRANSPORT_SECURITY,
            HeaderValue::from_static("max-age=31536000; includeSubDomains"),
        );
    }
    if no_store {
        response
            .headers_mut()
            .insert(header::CACHE_CONTROL, HeaderValue::from_static("no-store"));
    }
    response
}

fn origin_allowed(origin: &str) -> bool {
    ALLOWED_ORIGINS
        .iter()
        .any(|allowed| allowed.as_bytes() == origin.as_bytes())
}

/// 同源写请求也带 Origin：Origin 的 host[:port] 与请求 Host 一致时视为同源放行，
/// 这样 MERIDIAN_ALLOWED_ORIGINS 留空（同源部署）不会被 CSRF 层误杀。
fn origin_matches_host(origin: &str, headers: &HeaderMap) -> bool {
    let Some((scheme, authority)) = origin.split_once("://") else {
        return false;
    };
    let scheme = scheme.to_ascii_lowercase();
    if scheme != "http" && scheme != "https" {
        return false;
    }
    if authority.contains(['/', '?', '#']) {
        return false;
    }
    let Some(host) = headers.get(header::HOST).and_then(|v| v.to_str().ok()) else {
        return false;
    };
    // 默认端口（http:80 / https:443）在 Origin 与 Host 中可能一个有、一个没有
    let strip_default_port = |value: &str| -> String {
        let value = value.trim().to_ascii_lowercase();
        let default_port = if scheme == "https" { ":443" } else { ":80" };
        value.strip_suffix(default_port).unwrap_or(&value).to_string()
    };
    strip_default_port(authority) == strip_default_port(host)
}

/// CSRF 纵深：非安全方法若带 Origin 且不在白名单，或 Sec-Fetch-Site: cross-site，直接 403。
/// 仍保留 SameSite=Lax Cookie 作为第一道防线。
async fn csrf_guard(req: Request, next: Next) -> Response {
    let method = req.method().clone();
    if method != Method::GET && method != Method::HEAD && method != Method::OPTIONS {
        let origin = req
            .headers()
            .get(header::ORIGIN)
            .and_then(|v| v.to_str().ok())
            .map(str::trim)
            .filter(|v| !v.is_empty());
        let origin_ok = origin
            .map(|origin| origin_allowed(origin) || origin_matches_host(origin, req.headers()))
            .unwrap_or(true);
        let cross_site = req
            .headers()
            .get("sec-fetch-site")
            .and_then(|v| v.to_str().ok())
            .map(|v| v.trim().eq_ignore_ascii_case("cross-site"))
            .unwrap_or(false);
        if !origin_ok || cross_site {
            tracing::warn!(origin = ?origin, cross_site, "拒绝跨站写请求（CSRF 纵深）");
            return forbidden_cross_site_response();
        }
    }
    next.run(req).await
}

#[derive(Serialize)]
struct HealthResp {
    ok: bool,
    tick: u64,
    cpi: f64,
    paused: bool,
    tick_ms: u64,
    conservation_error: i128,
    companies_count: usize,
}

async fn admin_page_handler() -> Html<&'static str> {
    Html(ADMIN_HTML)
}

async fn admin_js_handler() -> ([(header::HeaderName, &'static str); 1], &'static str) {
    (
        [(header::CONTENT_TYPE, "application/javascript; charset=utf-8")],
        ADMIN_JS,
    )
}

async fn admin_overview_handler(
    _admin: AdminUser,
    State(engine): State<SharedEngine>,
) -> impl IntoResponse {
    let mut eng = engine.lock().await;
    Json(eng.admin_overview())
}

async fn admin_player_sandbox_handler(
    _admin: AdminUser,
    State(engine): State<SharedEngine>,
    Path(company_id): Path<String>,
) -> Result<Json<serde_json::Value>, (StatusCode, String)> {
    let eng = engine.lock().await;
    let Some(pvm) = eng.runner.players.get(&company_id) else {
        return Err((StatusCode::NOT_FOUND, format!("No player sandbox for '{company_id}'")));
    };
    let out = eng.runner.last_player_outputs.get(&company_id);
    Ok(Json(serde_json::json!({
        "company_id": company_id,
        "enabled": pvm.enabled,
        "memory_json": pvm.memory_json,
        "memory_bytes": pvm.memory_json.len(),
        "memory_limit_bytes": 131_072,
        "modules": pvm.bundle.modules,
        "last_output": out,
    })))
}

#[derive(Deserialize)]
struct ScriptToggleReq {
    enabled: bool,
}

async fn admin_script_toggle_handler(
    _admin: AdminUser,
    State(engine): State<SharedEngine>,
    Path(company_id): Path<String>,
    Json(req): Json<ScriptToggleReq>,
) -> Result<Json<serde_json::Value>, (StatusCode, String)> {
    let mut eng = engine.lock().await;
    let mem_copy = {
        let Some(pvm) = eng.runner.players.get_mut(&company_id) else {
            return Err((StatusCode::NOT_FOUND, format!("No player sandbox for '{company_id}'")));
        };
        pvm.enabled = req.enabled;
        pvm.memory_json.clone()
    };
    eng.store
        .save_player_memory(&company_id, &mem_copy, req.enabled)
        .map_err(internal_error)?;
    eng.mark_player_memory_saved(&company_id, &mem_copy, req.enabled);
    Ok(Json(serde_json::json!({ "ok": true, "company_id": company_id, "enabled": req.enabled })))
}

#[derive(Deserialize)]
struct UserStatusReq {
    status: String,
}

async fn admin_user_status_handler(
    admin: AdminUser,
    State(engine): State<SharedEngine>,
    Path(user_id): Path<i64>,
    Json(req): Json<UserStatusReq>,
) -> Result<Json<serde_json::Value>, (StatusCode, String)> {
    if admin.0.user.id == user_id && req.status != "active" {
        return Err((StatusCode::BAD_REQUEST, "不能禁用当前登录的管理员自身账号".to_string()));
    }
    if req.status != "active" && req.status != "disabled" {
        return Err((StatusCode::BAD_REQUEST, "status 只能为 active 或 disabled".to_string()));
    }
    let eng = engine.lock().await;
    let found = eng
        .store
        .set_user_status(user_id, &req.status, now_secs())
        .map_err(internal_error)?;
    if !found {
        return Err((StatusCode::NOT_FOUND, format!("Unknown user {user_id}")));
    }
    if req.status != "active" {
        let _ = eng.store.delete_all_sessions(user_id);
    }
    Ok(Json(serde_json::json!({ "ok": true, "user_id": user_id, "status": req.status })))
}

async fn admin_user_kick_handler(
    admin: AdminUser,
    State(engine): State<SharedEngine>,
    Path(user_id): Path<i64>,
) -> Result<Json<serde_json::Value>, (StatusCode, String)> {
    let eng = engine.lock().await;
    if admin.0.user.id == user_id {
        let deleted = eng
            .store
            .delete_other_sessions(user_id, admin.0.session_id)
            .map_err(internal_error)?;
        return Ok(Json(serde_json::json!({ "ok": true, "revoked": deleted })));
    }
    let deleted = eng
        .store
        .delete_all_sessions(user_id)
        .map_err(internal_error)?;
    Ok(Json(serde_json::json!({ "ok": true, "revoked": deleted })))
}

#[derive(Deserialize)]
struct AdminResetPasswordReq {
    password: String,
}

async fn admin_user_password_handler(
    _admin: AdminUser,
    State(engine): State<SharedEngine>,
    Path(user_id): Path<i64>,
    Json(req): Json<AdminResetPasswordReq>,
) -> Result<Json<serde_json::Value>, (StatusCode, String)> {
    if req.password.chars().count() < 8 {
        return Err((StatusCode::BAD_REQUEST, "密码至少需要 8 位".to_string()));
    }
    let (salt, hash) = hash_blocking(req.password)
        .await
        .map_err(|e| (e.status, e.body.message))?;
    let eng = engine.lock().await;
    if eng.store.user_by_id(user_id).is_none() {
        return Err((StatusCode::NOT_FOUND, format!("Unknown user {user_id}")));
    }
    eng.store
        .update_password(user_id, &hash, &salt)
        .map_err(internal_error)?;
    let _ = eng.store.delete_all_sessions(user_id);
    Ok(Json(serde_json::json!({ "ok": true, "user_id": user_id })))
}

async fn health_handler(State(engine): State<SharedEngine>) -> Json<HealthResp> {
    let eng = engine.lock().await;
    Json(HealthResp {
        ok: true,
        tick: eng.world.tick,
        cpi: eng.world.cpi,
        paused: eng.paused,
        tick_ms: eng.tick_ms,
        conservation_error: eng.world.conservation_error(),
        companies_count: eng.world.companies.len(),
    })
}

async fn catalog_handler(State(engine): State<SharedEngine>) -> impl IntoResponse {
    let eng = engine.lock().await;
    Json(eng.world.catalog.pack.clone())
}

#[derive(Deserialize)]
struct StateQuery {
    company_id: Option<String>,
}

async fn state_handler(
    State(engine): State<SharedEngine>,
    user: AuthUser,
    Query(q): Query<StateQuery>,
) -> Result<Json<crate::engine::StateResponse>, (StatusCode, String)> {
    let cid = q
        .company_id
        .clone()
        .unwrap_or_else(|| user.user.company_id.clone());
    ensure_owner(&user, &cid)?;
    let eng = engine.lock().await;
    Ok(Json(eng.state_response(&cid)))
}

async fn planet_plots_handler(
    State(engine): State<SharedEngine>,
    user: AuthUser,
    Path(planet_id): Path<String>,
) -> Result<Json<serde_json::Value>, (StatusCode, String)> {
    let eng = engine.lock().await;
    let Some(p) = eng.world.planets.get(&planet_id) else {
        return Err((StatusCode::NOT_FOUND, format!("Unknown planet '{planet_id}'")));
    };
    let Some(tiles) = eng.world.planet_public_tiles(&planet_id) else {
        return Err((StatusCode::NOT_FOUND, format!("Unknown planet '{planet_id}'")));
    };
    let my_cid = user.user.company_id.as_str();
    let tiles_json: Vec<serde_json::Value> = tiles
        .into_iter()
        .map(|t| {
            let is_mine = t.owner_id.as_deref() == Some(my_cid);
            serde_json::json!({
                "slot_id": t.slot_id,
                "planet_id": t.planet_id,
                "lat": t.lat,
                "lon": t.lon,
                "terrain_name": t.terrain_name,
                "capacity": t.capacity,
                "used_slots": t.used_slots,
                "building_mods": t.building_mods,
                "status": t.status,
                "is_city": t.is_city,
                "city_name": t.city_name,
                "owner_id": t.owner_id,
                "owner_name": t.owner_name,
                "is_player_owner": t.is_player_owner,
                "is_mine": is_mine,
                "plot_id": t.plot_id,
                "listing_id": t.listing_id,
                "price": t.price.map(from_money),
                "buildings": t.buildings,
            })
        })
        .collect();
    let primary_price = if p.unclaimed_plots_remaining > 0 {
        Some(from_money(p.primary_land_price(eng.world.cpi)))
    } else {
        None
    };
    Ok(Json(serde_json::json!({
        "planet": {
            "id": p.id,
            "name": p.name,
            "archetype": p.archetype,
            "habitability": p.habitability,
            "city_count": p.city_count,
            "primary_land_price": primary_price,
            "total_developable_plots": p.total_developable_plots,
            "unclaimed_plots": p.unclaimed_plots_remaining,
            "npc_plot_count": eng.world.npc_plot_count_on(&planet_id),
            "npc_plot_cap": eng.world.npc_plot_cap_on(&planet_id),
        },
        "tiles": tiles_json,
    })))
}

async fn company_detail_handler(
    State(engine): State<SharedEngine>,
    _user: AuthUser,
    Path(company_id): Path<String>,
) -> Result<Json<serde_json::Value>, (StatusCode, String)> {
    let eng = engine.lock().await;
    let Some(detail) = eng.world.public_company_detail(&company_id) else {
        return Err((StatusCode::NOT_FOUND, format!("Unknown company '{company_id}'")));
    };
    let plots: Vec<serde_json::Value> = detail
        .plots
        .into_iter()
        .map(|p| {
            serde_json::json!({
                "planet_id": p.planet_id,
                "slot_id": p.slot_id,
                "plot_id": p.plot_id,
                "lat": p.lat,
                "lon": p.lon,
                "terrain_name": p.terrain_name,
                "capacity": p.capacity,
                "used_slots": p.used_slots,
                "status": p.status,
                "listing_id": p.listing_id,
                "price": p.price.map(from_money),
                "buildings": p.buildings,
            })
        })
        .collect();
    let open_orders: Vec<serde_json::Value> = detail
        .open_orders
        .into_iter()
        .map(|o| {
            serde_json::json!({
                "order_id": o.order_id,
                "owner_id": o.owner_id,
                "station_id": o.station_id,
                "item_id": o.item_id,
                "side": o.side,
                "price": from_money(o.price),
                "qty": o.qty,
                "total_qty": o.total_qty,
                "created_tick": o.created_tick,
            })
        })
        .collect();
    Ok(Json(serde_json::json!({
        "id": detail.id,
        "name": detail.name,
        "is_player": detail.is_player,
        "home_planet_id": detail.home_planet_id,
        "net_liquid": from_money(detail.net_liquid),
        "plots_count": detail.plots_count,
        "buildings_count": detail.buildings_count,
        "ships_count": detail.ships_count,
        "ships_by_size": detail.ships_by_size,
        "building_counts": detail.building_counts,
        "plots": plots,
        "open_orders_count": detail.open_orders_count,
        "open_orders": open_orders,
    })))
}

#[derive(Deserialize)]
struct BookQuery {
    station_id: Option<String>,
    item_id: Option<String>,
    limit: Option<usize>,
    candle_limit: Option<usize>,
}

#[derive(Serialize)]
struct DepthPoint {
    price: f64,
    qty: u32,
}

#[derive(Serialize)]
struct MarketBookResp {
    station_id: String,
    item_id: String,
    best_bid: Option<f64>,
    best_ask: Option<f64>,
    last_price: f64,
    ema_fast: f64,
    ema_slow: f64,
    vol_50t: u64,
    bids: Vec<DepthPoint>,
    asks: Vec<DepthPoint>,
    candles: Vec<CandleRow>,
    recent_trades: Vec<TradeRow>,
}

async fn market_book_handler(
    State(engine): State<SharedEngine>,
    Query(q): Query<BookQuery>,
) -> Result<Json<MarketBookResp>, (StatusCode, String)> {
    let eng = engine.lock().await;
    let default_hub = eng.primary_hub_station_id();
    let sid = q.station_id.as_deref().unwrap_or(&default_hub);
    let item_id = q.item_id.as_deref().unwrap_or("steel");
    let depth_lim = q.limit.unwrap_or(20).clamp(1, 100);
    let candle_lim = q.candle_limit.unwrap_or(120).clamp(1, 500);

    let Some(st) = eng.world.stations.get(sid) else {
        return Err((StatusCode::NOT_FOUND, format!("Unknown station '{sid}'")));
    };
    let Some(item_def) = eng.world.catalog.items.get(item_id) else {
        return Err((StatusCode::NOT_FOUND, format!("Unknown item '{item_id}'")));
    };

    let fallback = (item_def.ref_price * MONEY_SCALE as f64).round() as i64;
    let quote = st.quote(item_id, fallback);
    let (bids_raw, asks_raw) = st.depth(item_id, depth_lim);

    let bids = bids_raw
        .into_iter()
        .map(|l| DepthPoint {
            price: from_money(l.price),
            qty: l.qty,
        })
        .collect();
    let asks = asks_raw
        .into_iter()
        .map(|l| DepthPoint {
            price: from_money(l.price),
            qty: l.qty,
        })
        .collect();

    let candles = eng
        .store
        .query_candles(sid, item_id, candle_lim)
        .map_err(internal_error)?;
    let recent_trades = eng
        .store
        .query_recent_trades(sid, item_id, 40)
        .map_err(internal_error)?;

    Ok(Json(MarketBookResp {
        station_id: sid.to_string(),
        item_id: item_id.to_string(),
        best_bid: quote.best_bid.map(from_money),
        best_ask: quote.best_ask.map(from_money),
        last_price: from_money(quote.last_price),
        ema_fast: from_money(quote.ema_fast),
        ema_slow: from_money(quote.ema_slow),
        vol_50t: quote.vol_50t,
        bids,
        asks,
        candles,
        recent_trades,
    }))
}

#[derive(Deserialize)]
struct CandlesQuery {
    station_id: Option<String>,
    item_id: Option<String>,
    period: Option<u64>,
    from_tick: Option<u64>,
    to_tick: Option<u64>,
}

#[derive(Serialize)]
struct MarketCandlesResp {
    station_id: String,
    item_id: String,
    period: u64,
    current_tick: u64,
    from_bucket: u64,
    to_bucket: u64,
    ref_price: f64,
    last_price: f64,
    ema_fast: f64,
    ema_slow: f64,
    best_bid: Option<f64>,
    best_ask: Option<f64>,
    prev_close: Option<f64>,
    earliest_trade_tick: Option<u64>,
    latest_trade_tick: Option<u64>,
    total_trade_ticks: u64,
    candles: Vec<CandleRow>,
}

async fn market_candles_handler(
    State(engine): State<SharedEngine>,
    Query(q): Query<CandlesQuery>,
) -> Result<Json<MarketCandlesResp>, (StatusCode, String)> {
    let eng = engine.lock().await;
    let default_hub = eng.primary_hub_station_id();
    let sid = q.station_id.as_deref().unwrap_or(&default_hub);
    let item_id = q.item_id.as_deref().unwrap_or("steel");
    let period = q.period.unwrap_or(1).clamp(1, 1000);

    let Some(st) = eng.world.stations.get(sid) else {
        return Err((StatusCode::NOT_FOUND, format!("Unknown station '{sid}'")));
    };
    let Some(item_def) = eng.world.catalog.items.get(item_id) else {
        return Err((StatusCode::NOT_FOUND, format!("Unknown item '{item_id}'")));
    };

    let current_tick = eng.world.tick;
    let to_tick = q.to_tick.unwrap_or(current_tick).min(current_tick);
    let to_bucket = (to_tick / period) * period;
    let default_from = to_bucket.saturating_sub(500 * period);
    let from_tick = q.from_tick.unwrap_or(default_from).min(to_bucket);
    let from_bucket = (from_tick / period) * period;

    let fallback = (item_def.ref_price * MONEY_SCALE as f64).round() as i64;
    let quote = st.quote(item_id, fallback);

    let range = eng
        .store
        .query_candles_range(sid, item_id, period, from_bucket, to_bucket)
        .map_err(internal_error)?;

    Ok(Json(MarketCandlesResp {
        station_id: sid.to_string(),
        item_id: item_id.to_string(),
        period,
        current_tick,
        from_bucket,
        to_bucket,
        ref_price: item_def.ref_price,
        last_price: from_money(quote.last_price),
        ema_fast: from_money(quote.ema_fast),
        ema_slow: from_money(quote.ema_slow),
        best_bid: quote.best_bid.map(from_money),
        best_ask: quote.best_ask.map(from_money),
        prev_close: range.prev_close,
        earliest_trade_tick: range.earliest_trade_tick,
        latest_trade_tick: range.latest_trade_tick,
        total_trade_ticks: range.total_trade_ticks,
        candles: range.candles,
    }))
}

#[derive(Serialize)]
struct ScriptsResp {
    company_id: String,
    enabled: bool,
    modules: BTreeMap<String, String>,
    memory_json: String,
    last_output: Option<meridian_sandbox::PlayerRunOutput>,
}

async fn get_scripts_handler(
    State(engine): State<SharedEngine>,
    user: AuthUser,
    Path(company_id): Path<String>,
) -> Result<Json<ScriptsResp>, (StatusCode, String)> {
    ensure_owner(&user, &company_id)?;
    let eng = engine.lock().await;
    let Some(pvm) = eng.runner.players.get(&company_id) else {
        return Err((
            StatusCode::NOT_FOUND,
            format!("No QuickJS player VM registered for '{company_id}'"),
        ));
    };
    Ok(Json(ScriptsResp {
        company_id: company_id.clone(),
        enabled: pvm.enabled,
        modules: pvm.bundle.modules.clone(),
        memory_json: pvm.memory_json.clone(),
        last_output: eng.runner.last_player_outputs.get(&company_id).cloned(),
    }))
}

#[derive(Deserialize)]
struct PutScriptsReq {
    modules: HashMap<String, String>,
    enabled: Option<bool>,
}

async fn put_scripts_handler(
    State(engine): State<SharedEngine>,
    user: AuthUser,
    Path(company_id): Path<String>,
    Json(req): Json<PutScriptsReq>,
) -> Result<Json<serde_json::Value>, (StatusCode, String)> {
    ensure_owner(&user, &company_id)?;
    let mut eng = engine.lock().await;
    if !eng.world.companies.contains_key(&company_id) {
        return Err((
            StatusCode::NOT_FOUND,
            format!("Company '{company_id}' not found"),
        ));
    }

    let mut clean_mods = BTreeMap::new();
    for (k, v) in req.modules {
        let norm = normalize_module_name(&k);
        if !norm.is_empty() {
            clean_mods.insert(norm, v);
        }
    }
    if !clean_mods.contains_key("main") {
        return Err((
            StatusCode::BAD_REQUEST,
            "Script bundle must include a 'main' module".to_string(),
        ));
    }

    let bundle = PlayerScriptBundle { modules: clean_mods };
    eng.store
        .save_player_bundle(&company_id, &bundle)
        .map_err(internal_error)?;
    eng.runner.set_player_script(&company_id, bundle);

    if let Some(en) = req.enabled {
        let mem_copy = eng.runner.players.get_mut(&company_id).map(|pvm| {
            pvm.enabled = en;
            pvm.memory_json.clone()
        });
        if let Some(mem_json) = mem_copy {
            if eng.store.save_player_memory(&company_id, &mem_json, en).is_ok() {
                eng.mark_player_memory_saved(&company_id, &mem_json, en);
            }
        }
    }

    Ok(Json(serde_json::json!({ "ok": true, "company_id": company_id })))
}

#[derive(Deserialize)]
struct PutMemoryReq {
    memory_json: String,
}

async fn put_memory_handler(
    State(engine): State<SharedEngine>,
    user: AuthUser,
    Path(company_id): Path<String>,
    Json(req): Json<PutMemoryReq>,
) -> Result<Json<serde_json::Value>, (StatusCode, String)> {
    ensure_owner(&user, &company_id)?;
    let max_bytes = PlayerRunConfig::default().max_memory_json_bytes;
    if req.memory_json.len() > max_bytes {
        return Err((
            StatusCode::PAYLOAD_TOO_LARGE,
            format!("Memory JSON exceeds {max_bytes} byte limit"),
        ));
    }
    if serde_json::from_str::<serde_json::Value>(&req.memory_json).is_err() {
        return Err((StatusCode::BAD_REQUEST, "Invalid JSON in memory_json".to_string()));
    }

    let mut eng = engine.lock().await;
    if !eng.runner.players.contains_key(&company_id) {
        return Err((
            StatusCode::NOT_FOUND,
            format!("No player VM for '{company_id}'"),
        ));
    }
    eng.runner.set_player_memory(&company_id, req.memory_json.clone());
    let enabled = eng.runner.players[&company_id].enabled;
    eng.store
        .save_player_memory(&company_id, &req.memory_json, enabled)
        .map_err(internal_error)?;
    eng.mark_player_memory_saved(&company_id, &req.memory_json, enabled);

    Ok(Json(serde_json::json!({ "ok": true })))
}

#[derive(Deserialize)]
struct PostIntentReq {
    company_id: String,
    intent: Intent,
}

async fn post_intent_handler(
    State(engine): State<SharedEngine>,
    user: AuthUser,
    Json(req): Json<PostIntentReq>,
) -> Result<Json<serde_json::Value>, (StatusCode, String)> {
    ensure_owner(&user, &req.company_id)?;
    let company_id = req.company_id;
    let mut eng = engine.lock().await;
    eng.queue_manual_intent(company_id.clone(), req.intent)
        .map_err(|e| match e {
            IntentQueueError::QueueFull { limit, .. } => (
                StatusCode::TOO_MANY_REQUESTS,
                format!("手动指令队列已满（每家公司上限 {limit} 条），请稍后重试"),
            ),
            IntentQueueError::UnknownCompany(id) => {
                (StatusCode::NOT_FOUND, format!("公司 '{id}' 不存在"))
            }
        })?;
    Ok(Json(serde_json::json!({ "ok": true, "queued": true })))
}

#[derive(Deserialize)]
struct SimControlReq {
    action: String,
    tick_ms: Option<u64>,
}

async fn sim_control_handler(
    _admin: AdminUser,
    State(engine): State<SharedEngine>,
    Json(req): Json<SimControlReq>,
) -> Result<Json<serde_json::Value>, (StatusCode, String)> {
    let mut eng = engine.lock().await;
    match req.action.as_str() {
        "pause" => {
            eng.paused = true;
            Ok(Json(serde_json::json!({ "ok": true, "paused": true })))
        }
        "resume" => {
            eng.paused = false;
            Ok(Json(serde_json::json!({ "ok": true, "paused": false })))
        }
        "speed" => {
            let ms = req.tick_ms.unwrap_or(2000).clamp(0, 60_000);
            eng.tick_ms = ms;
            Ok(Json(serde_json::json!({ "ok": true, "tick_ms": ms })))
        }
        "step" => {
            let bcast = eng
                .step_once()
                .map_err(internal_error)?;
            Ok(Json(serde_json::to_value(&bcast).unwrap()))
        }
        "reset" => {
            let bcast = eng
                .reset_world()
                .map_err(internal_error)?;
            Ok(Json(serde_json::to_value(&bcast).unwrap()))
        }
        other => Err((
            StatusCode::BAD_REQUEST,
            format!("Unknown sim control action '{other}'"),
        )),
    }
}

#[derive(Deserialize)]
struct CreateCompanyReq {
    id: String,
    name: String,
    is_player: bool,
    profession: String,
    home_planet_id: String,
    initial_cash: Option<f64>,
}

async fn create_company_handler(
    _admin: AdminUser,
    State(engine): State<SharedEngine>,
    Json(req): Json<CreateCompanyReq>,
) -> Result<Json<serde_json::Value>, (StatusCode, String)> {
    let mut eng = engine.lock().await;
    let cash = req.initial_cash.unwrap_or(10_000.0).clamp(100.0, 100_000.0);
    eng.world
        .spawn_company(
            &req.id,
            &req.name,
            req.is_player,
            &req.profession,
            &req.home_planet_id,
            cash,
        )
        .map_err(|e| (StatusCode::BAD_REQUEST, e))?;

    eng.mark_world_dirty();
    if req.is_player {
        let bundle = PlayerScriptBundle::single_main(crate::engine::STARTER_PLAYER_JS);
        eng.store
            .save_player_bundle(&req.id, &bundle)
            .map_err(internal_error)?;
        eng.store
            .save_player_memory(&req.id, "{}", true)
            .map_err(internal_error)?;
        eng.mark_player_memory_saved(&req.id, "{}", true);
        eng.runner.set_player_script(&req.id, bundle);
    } else {
        let genome = NpcGenome::from_seed(eng.world.tick.wrapping_add(req.id.len() as u64) + 31337);
        eng.store
            .save_npc_genome(&req.id, &genome)
            .map_err(internal_error)?;
        eng.runner.register_npc(&req.id, genome);
    }

    Ok(Json(serde_json::json!({ "ok": true, "id": req.id })))
}

async fn ws_handler(
    ws: WebSocketUpgrade,
    State(engine): State<SharedEngine>,
    user: AuthUser,
) -> impl IntoResponse {
    let cid = user.user.company_id.clone();
    ws.on_upgrade(move |socket| handle_ws(socket, engine, cid))
}

async fn handle_ws(mut socket: WebSocket, engine: SharedEngine, cid: String) {
    let (init_json, mut rx, _ws_guard) = {
        let eng = engine.lock().await;
        let guard = eng.telemetry.track_ws(&cid);
        let init = serde_json::to_string(&serde_json::json!({
            "kind": "init",
            "state": eng.state_response(&cid),
        }))
        .unwrap_or_else(|_| "{}".to_string());
        (init, eng.events_tx.subscribe(), guard)
    };

    if socket.send(Message::Text(init_json.into())).await.is_err() {
        return;
    }

    loop {
        tokio::select! {
            res = rx.recv() => {
                match res {
                    Ok(mut ev) => {
                        // 广播里只保留连接者自己的玩家输出，避免全员 Memory/日志泄漏
                        ev.player_outputs.retain(|k, _| k == &cid);
                        if let Ok(txt) = serde_json::to_string(&ev) {
                            if socket.send(Message::Text(txt.into())).await.is_err() {
                                break;
                            }
                        }
                    }
                    Err(tokio::sync::broadcast::error::RecvError::Lagged(_)) => continue,
                    Err(tokio::sync::broadcast::error::RecvError::Closed) => break,
                }
            }
            msg = socket.recv() => {
                match msg {
                    Some(Ok(Message::Close(_))) | None => break,
                    Some(Ok(Message::Ping(p))) => {
                        if socket.send(Message::Pong(p)).await.is_err() {
                            break;
                        }
                    }
                    Some(Ok(_)) => {}
                    Some(Err(_)) => break,
                }
            }
        }
    }
}


/* ============================================================ 账号 / 会话 */

/// 统一的 JSON 错误体：{message, field?, cooldown_until?}
#[derive(Serialize)]
struct ErrBody {
    message: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    field: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    cooldown_until: Option<i64>,
}

pub struct ApiError {
    status: StatusCode,
    body: ErrBody,
}

impl ApiError {
    fn new(status: StatusCode, message: impl Into<String>) -> Self {
        Self {
            status,
            body: ErrBody {
                message: message.into(),
                field: None,
                cooldown_until: None,
            },
        }
    }

    fn field(status: StatusCode, message: impl Into<String>, field: &str) -> Self {
        Self {
            status,
            body: ErrBody {
                message: message.into(),
                field: Some(field.to_string()),
                cooldown_until: None,
            },
        }
    }

    fn cooldown(message: impl Into<String>, until: i64) -> Self {
        Self {
            status: StatusCode::TOO_MANY_REQUESTS,
            body: ErrBody {
                message: message.into(),
                field: None,
                cooldown_until: Some(until),
            },
        }
    }

    /// 内部错误：客户端只看到通用文案，细节（含 SQLite 报错）只进 tracing。
    fn internal(err: impl std::fmt::Display) -> Self {
        tracing::error!(error = %err, "请求处理失败");
        Self::new(StatusCode::INTERNAL_SERVER_ERROR, INTERNAL_ERROR_MESSAGE)
    }
}

impl IntoResponse for ApiError {
    fn into_response(self) -> axum::response::Response {
        (self.status, Json(self.body)).into_response()
    }
}

fn valid_email(email: &str) -> bool {
    if email.len() > 254 || email.contains(char::is_whitespace) {
        return false;
    }
    let mut parts = email.split('@');
    let (Some(local), Some(domain), None) = (parts.next(), parts.next(), parts.next()) else {
        return false;
    };
    if local.is_empty() || domain.len() < 3 {
        return false;
    }
    domain.contains('.') && !domain.starts_with('.') && !domain.ends_with('.')
}

fn user_agent(headers: &HeaderMap) -> String {
    headers
        .get(header::USER_AGENT)
        .and_then(|v| v.to_str().ok())
        .unwrap_or("")
        .chars()
        .take(200)
        .collect()
}

fn user_json(user: &crate::storage::UserRow) -> serde_json::Value {
    serde_json::json!({
        "company_id": user.company_id,
        "nickname": user.nickname,
        "email": user.email,
        "role": user.role,
    })
}

/// 500 响应的统一文案：细节只进日志，不回显给客户端（避免泄露 SQLite/内部结构）。
const INTERNAL_ERROR_MESSAGE: &str = "服务器内部错误，请稍后重试";

fn internal_error(err: impl std::fmt::Display) -> (StatusCode, String) {
    tracing::error!(error = %err, "请求处理失败");
    (
        StatusCode::INTERNAL_SERVER_ERROR,
        INTERNAL_ERROR_MESSAGE.to_string(),
    )
}

/// argon2 全局闸门最多等待 2s，超时 503（避免未认证请求无限排队）。
const HASH_GATE_WAIT: Duration = Duration::from_secs(2);

/// 注册/登录全局在途上限：Turnstile 网络等待 + 阻塞哈希都算在途。
static AUTH_INFLIGHT: tokio::sync::Semaphore = tokio::sync::Semaphore::const_new(64);

fn auth_inflight_slot() -> Result<tokio::sync::SemaphorePermit<'static>, ApiError> {
    AUTH_INFLIGHT
        .try_acquire()
        .map_err(|_| ApiError::new(StatusCode::TOO_MANY_REQUESTS, "认证请求过多，请稍后重试"))
}

async fn hash_gate_permit() -> Result<tokio::sync::SemaphorePermit<'static>, ApiError> {
    match tokio::time::timeout(HASH_GATE_WAIT, auth::HASH_GATE.acquire()).await {
        Ok(Ok(permit)) => Ok(permit),
        Ok(Err(_)) => Err(ApiError::new(
            StatusCode::SERVICE_UNAVAILABLE,
            "认证服务暂不可用，请稍后重试",
        )),
        Err(_) => Err(ApiError::new(
            StatusCode::SERVICE_UNAVAILABLE,
            "认证服务繁忙，请稍后重试",
        )),
    }
}

async fn hash_blocking(password: String) -> Result<(String, String), ApiError> {
    let _permit = hash_gate_permit().await?;
    tokio::task::spawn_blocking(move || hash_password(&password))
        .await
        .map_err(ApiError::internal)?
        .map_err(ApiError::internal)
}

async fn verify_blocking(
    password: String,
    salt: String,
    hash: String,
) -> Result<bool, ApiError> {
    let _permit = hash_gate_permit().await?;
    tokio::task::spawn_blocking(move || verify_password(&password, &salt, &hash))
        .await
        .map_err(ApiError::internal)
}

async fn auth_config_handler(headers: HeaderMap, client: ClientAddr) -> Json<serde_json::Value> {
    let secret_configured = auth::turnstile_secret_configured();
    let bypass = auth::should_bypass_turnstile(&headers, client.connect_info().map(|c| c.0.ip()));
    let turnstile_required = secret_configured && !bypass;
    let turnstile_site_key = if turnstile_required {
        auth::turnstile_site_key()
    } else {
        String::new()
    };
    Json(serde_json::json!({
        "turnstile_site_key": turnstile_site_key,
        "turnstile_required": turnstile_required,
        "turnstile_bypassed": secret_configured && bypass,
    }))
}

#[derive(Deserialize)]
struct RegisterReq {
    email: String,
    nickname: String,
    password: String,
    #[serde(default)]
    turnstile_token: String,
}

async fn register_handler(
    State(engine): State<SharedEngine>,
    headers: HeaderMap,
    client: ClientAddr,
    Json(req): Json<RegisterReq>,
) -> Result<([(header::HeaderName, String); 1], Json<serde_json::Value>), ApiError> {
    // 全局在途上限：超出直接 429，不让慢请求（Turnstile/哈希）无限堆积。
    let _slot = auth_inflight_slot()?;
    let email = req.email.trim().to_lowercase();
    let nickname = req.nickname.trim().to_string();
    if !valid_email(&email) {
        return Err(ApiError::field(StatusCode::BAD_REQUEST, "请输入有效邮箱地址", "email"));
    }
    let nick_len = nickname.chars().count();
    if !(2..=16).contains(&nick_len) {
        return Err(ApiError::field(StatusCode::BAD_REQUEST, "昵称需 2–16 个字符", "nickname"));
    }
    let pwd_len = req.password.chars().count();
    if pwd_len < 8 {
        return Err(ApiError::field(StatusCode::BAD_REQUEST, "密码至少 8 位", "password"));
    }
    if pwd_len > 128 {
        return Err(ApiError::field(StatusCode::BAD_REQUEST, "密码不能超过 128 位", "password"));
    }

    let ip = client_ip(&headers, client.connect_info());
    {
        let eng = engine.lock().await;
        if let Err(msg) = eng.auth.check_register(&ip) {
            return Err(ApiError::new(StatusCode::TOO_MANY_REQUESTS, msg));
        }
    }

    let peer_ip = client.connect_info().map(|c| c.0.ip());
    if !auth::should_bypass_turnstile(&headers, peer_ip) {
        let remote_ip = if ip == auth::UNKNOWN_CLIENT {
            None
        } else {
            Some(ip.as_str())
        };
        verify_turnstile(&req.turnstile_token, remote_ip)
            .await
            .map_err(|m| ApiError::new(StatusCode::FORBIDDEN, m))?;
    }

    let (salt, hash) = hash_blocking(req.password.clone()).await?;

    let mut eng = engine.lock().await;
    if eng.store.email_taken(&email) {
        return Err(ApiError::field(StatusCode::CONFLICT, "该邮箱已注册", "email"));
    }
    if eng.store.nickname_taken(&nickname, None) {
        return Err(ApiError::field(StatusCode::CONFLICT, "该昵称已被占用", "nickname"));
    }

    let now = now_secs();
    // 首个注册者成为管理员（开服引导）；之后通过 MERIDIAN_ADMIN_EMAIL 指定
    let role = if eng.store.count_users() == 0 {
        "admin"
    } else {
        "player"
    };
    let user_id = eng
        .store
        .create_user(&email, &nickname, &hash, &salt, role, "", now)
        .map_err(ApiError::internal)?;

    let company_id = if eng.company_is_unclaimed("player1") {
        "player1".to_string()
    } else {
        format!("u{user_id}")
    };
    eng.store
        .set_user_company(user_id, &company_id)
        .map_err(ApiError::internal)?;
    eng.provision_player_company(&company_id, &nickname)
        .map_err(ApiError::internal)?;

    let ttl = SESSION_TTL_DEFAULT;
    let token = new_token();
    eng.store
        .create_session(user_id, &token_hash(&token), now, now + ttl, &user_agent(&headers))
        .map_err(ApiError::internal)?;
    let _ = eng.store.set_last_login(user_id, now);
    let user = eng
        .store
        .user_by_id(user_id)
        .ok_or_else(|| ApiError::internal("用户创建失败"))?;
    let body = user_json(&user);
    drop(eng);

    Ok((
        [(
            header::SET_COOKIE,
            session_cookie(&token, ttl, false, cookie_secure(&headers)),
        )],
        Json(body),
    ))
}

#[derive(Deserialize)]
struct LoginReq {
    email: String,
    password: String,
    #[serde(default)]
    remember: bool,
}

/// 记录一次账号登录失败，达到阈值时返回 429（带解锁时间戳）。
async fn login_failure(engine: &SharedEngine, email: &str) -> ApiError {
    let locked_until = {
        let eng = engine.lock().await;
        eng.auth.record_login_failure(email)
    };
    if let Some(until) = locked_until {
        return ApiError::cooldown(
            format!("密码错误次数过多，账号已临时锁定至 {until}"),
            until,
        );
    }
    ApiError::new(StatusCode::UNAUTHORIZED, "邮箱或密码错误")
}

async fn login_handler(
    State(engine): State<SharedEngine>,
    headers: HeaderMap,
    client: ClientAddr,
    Json(req): Json<LoginReq>,
) -> Result<([(header::HeaderName, String); 1], Json<serde_json::Value>), ApiError> {
    // 全局在途上限：超出直接 429，不让慢请求无限堆积。
    let _slot = auth_inflight_slot()?;
    let email = req.email.trim().to_lowercase();
    let ip = client_ip(&headers, client.connect_info());
    {
        let eng = engine.lock().await;
        if let Err(msg) = eng.auth.check_login(&ip) {
            return Err(ApiError::new(StatusCode::TOO_MANY_REQUESTS, msg));
        }
        // 按账号维度的失败锁定：换 IP 也无法继续猜密码。
        if let Some(until) = eng.auth.account_lock_until(&email) {
            return Err(ApiError::cooldown(
                format!("该账号因多次密码错误已被临时锁定，解锁时间戳 {until}"),
                until,
            ));
        }
    }

    let found = {
        let eng = engine.lock().await;
        eng.store.user_by_email(&email)
    };
    let Some((user, salt, hash)) = found else {
        // 用户不存在也跑一次哈希，避免通过响应时间探测账号是否注册
        let _ = hash_blocking(req.password.clone()).await;
        return Err(login_failure(&engine, &email).await);
    };
    let ok = verify_blocking(req.password.clone(), salt, hash).await?;
    if !ok {
        return Err(login_failure(&engine, &email).await);
    }
    if user.status != "active" {
        return Err(ApiError::new(StatusCode::FORBIDDEN, "账号已被禁用"));
    }

    let now = now_secs();
    let ttl = if req.remember {
        SESSION_TTL_REMEMBER
    } else {
        SESSION_TTL_DEFAULT
    };
    let token = new_token();
    {
        let eng = engine.lock().await;
        // 登录成功：清零该账号的失败计数。
        eng.auth.clear_login_failures(&email);
        eng.store
            .create_session(
                user.id,
                &token_hash(&token),
                now,
                now + ttl,
                &user_agent(&headers),
            )
            .map_err(ApiError::internal)?;
        let _ = eng.store.set_last_login(user.id, now);
        let _ = eng.store.purge_expired_sessions(now);
    }
    let body = user_json(&user);

    Ok((
        [(
            header::SET_COOKIE,
            session_cookie(&token, ttl, req.remember, cookie_secure(&headers)),
        )],
        Json(body),
    ))
}

async fn logout_handler(
    State(engine): State<SharedEngine>,
    headers: HeaderMap,
    user: AuthUser,
) -> Result<([(header::HeaderName, String); 1], Json<serde_json::Value>), ApiError> {
    let eng = engine.lock().await;
    eng.store
        .delete_session(user.session_id)
        .map_err(ApiError::internal)?;
    drop(eng);
    Ok((
        [(header::SET_COOKIE, clear_cookie(cookie_secure(&headers)))],
        Json(serde_json::json!({ "ok": true })),
    ))
}

async fn me_handler(user: AuthUser) -> Json<serde_json::Value> {
    Json(user_json(&user.user))
}

async fn account_handler(
    State(engine): State<SharedEngine>,
    user: AuthUser,
) -> Json<serde_json::Value> {
    let eng = engine.lock().await;
    let sessions: Vec<serde_json::Value> = eng
        .store
        .list_sessions(user.user.id)
        .into_iter()
        .map(|s| {
            serde_json::json!({
                "id": s.id,
                "created_at": s.created_at,
                "last_seen_at": s.last_seen_at,
                "expires_at": s.expires_at,
                "current": s.id == user.session_id,
                "user_agent": s.user_agent,
            })
        })
        .collect();
    Json(serde_json::json!({
        "email": user.user.email,
        "nickname": user.user.nickname,
        "role": user.user.role,
        "company_id": user.user.company_id,
        "created_at": user.user.created_at,
        "nickname_changed_at": user.user.nickname_changed_at,
        "sessions": sessions,
    }))
}

#[derive(Deserialize)]
struct UpdateAccountReq {
    nickname: String,
}

const NICKNAME_COOLDOWN_SECS: i64 = 30 * 24 * 3600;

async fn update_account_handler(
    State(engine): State<SharedEngine>,
    user: AuthUser,
    Json(req): Json<UpdateAccountReq>,
) -> Result<Json<serde_json::Value>, ApiError> {
    let nickname = req.nickname.trim().to_string();
    let nick_len = nickname.chars().count();
    if !(2..=16).contains(&nick_len) {
        return Err(ApiError::field(StatusCode::BAD_REQUEST, "昵称需 2–16 个字符", "nickname"));
    }
    if nickname == user.user.nickname {
        return Ok(Json(serde_json::json!({ "ok": true, "nickname": nickname })));
    }
    let now = now_secs();
    if let Some(changed_at) = user.user.nickname_changed_at {
        let until = changed_at + NICKNAME_COOLDOWN_SECS;
        if now < until {
            return Err(ApiError::cooldown(
                format!("昵称 30 天内只能修改一次，解锁时间戳 {until}"),
                until,
            ));
        }
    }
    let eng = engine.lock().await;
    if eng.store.nickname_taken(&nickname, Some(user.user.id)) {
        return Err(ApiError::field(StatusCode::CONFLICT, "该昵称已被占用", "nickname"));
    }
    eng.store
        .update_nickname(user.user.id, &nickname, now)
        .map_err(ApiError::internal)?;
    Ok(Json(serde_json::json!({ "ok": true, "nickname": nickname })))
}

#[derive(Deserialize)]
struct ChangePasswordReq {
    current_password: String,
    new_password: String,
}

async fn change_password_handler(
    State(engine): State<SharedEngine>,
    user: AuthUser,
    Json(req): Json<ChangePasswordReq>,
) -> Result<Json<serde_json::Value>, ApiError> {
    let new_len = req.new_password.chars().count();
    if new_len < 8 {
        return Err(ApiError::field(
            StatusCode::BAD_REQUEST,
            "新密码至少 8 位",
            "new_password",
        ));
    }
    if new_len > 128 {
        return Err(ApiError::field(
            StatusCode::BAD_REQUEST,
            "新密码不能超过 128 位",
            "new_password",
        ));
    }

    let found = {
        let eng = engine.lock().await;
        eng.store.user_by_email(&user.user.email)
    };
    let Some((_u, salt, hash)) = found else {
        return Err(ApiError::new(StatusCode::UNAUTHORIZED, "账号不存在"));
    };
    let ok = verify_blocking(req.current_password.clone(), salt, hash).await?;
    if !ok {
        return Err(ApiError::field(
            StatusCode::BAD_REQUEST,
            "当前密码不正确",
            "current_password",
        ));
    }

    let (new_salt, new_hash) = hash_blocking(req.new_password.clone()).await?;
    let eng = engine.lock().await;
    eng.store
        .update_password(user.user.id, &new_hash, &new_salt)
        .map_err(ApiError::internal)?;
    // 改密后踢掉其它设备，只保留当前会话
    let _ = eng.store.delete_other_sessions(user.user.id, user.session_id);
    Ok(Json(serde_json::json!({ "ok": true })))
}

#[derive(Deserialize)]
struct RevokeSessionsReq {
    /// 同时接受数字和字符串：前端会话 id 类型历史上是 string
    #[serde(default)]
    session_id: Option<serde_json::Value>,
    #[serde(default)]
    all: bool,
}

async fn revoke_sessions_handler(
    State(engine): State<SharedEngine>,
    user: AuthUser,
    Json(req): Json<RevokeSessionsReq>,
) -> Result<Json<serde_json::Value>, ApiError> {
    let eng = engine.lock().await;
    if req.all {
        let removed = eng
            .store
            .delete_other_sessions(user.user.id, user.session_id)
            .map_err(ApiError::internal)?;
        return Ok(Json(serde_json::json!({ "ok": true, "revoked": removed })));
    }
    let session_id = match req.session_id {
        Some(serde_json::Value::Number(n)) => n.as_i64(),
        Some(serde_json::Value::String(s)) => s.parse::<i64>().ok(),
        _ => None,
    };
    let Some(session_id) = session_id else {
        return Err(ApiError::new(StatusCode::BAD_REQUEST, "缺少 session_id"));
    };
    if session_id == user.session_id {
        return Err(ApiError::new(
            StatusCode::BAD_REQUEST,
            "不能吊销当前设备，请使用登出",
        ));
    }
    let owns = eng
        .store
        .list_sessions(user.user.id)
        .iter()
        .any(|s| s.id == session_id);
    if !owns {
        return Err(ApiError::new(StatusCode::NOT_FOUND, "会话不存在"));
    }
    eng.store
        .delete_session(session_id)
        .map_err(ApiError::internal)?;
    Ok(Json(serde_json::json!({ "ok": true, "revoked": 1 })))
}

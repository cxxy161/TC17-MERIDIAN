//! Axum HTTP/REST & WebSocket gateway for simulation inspection, script hot-reloading,
//! market depth/candle queries, manual intents, and static frontend serving.

use std::collections::{BTreeMap, HashMap};
use std::path::PathBuf;

use axum::extract::ws::{Message, WebSocket, WebSocketUpgrade};
use axum::extract::{Path, Query, State};
use axum::http::StatusCode;
use axum::response::{Html, IntoResponse};
use axum::routing::{get, post, put};
use axum::{Json, Router};
use meridian_core::{from_money, Intent, MONEY_SCALE};
use meridian_sandbox::{normalize_module_name, NpcGenome, PlayerRunConfig, PlayerScriptBundle};
use serde::{Deserialize, Serialize};
use tower_http::cors::CorsLayer;
use tower_http::services::{ServeDir, ServeFile};

use crate::engine::SharedEngine;
use crate::storage::{CandleRow, TradeRow};

const ADMIN_HTML: &str = include_str!("../assets/admin.html");

pub fn build_router(engine: SharedEngine, dist_dir: Option<PathBuf>) -> Router {
    let api_router = Router::new()
        .route("/admin", get(admin_page_handler))
        .route("/admin.html", get(admin_page_handler))
        .route("/api/admin/overview", get(admin_overview_handler))
        .route("/api/health", get(health_handler))
        .route("/api/catalog", get(catalog_handler))
        .route("/api/state", get(state_handler))
        .route("/api/market/book", get(market_book_handler))
        .route("/api/market/candles", get(market_candles_handler))
        .route("/api/scripts/{company_id}", get(get_scripts_handler))
        .route("/api/scripts/{company_id}", put(put_scripts_handler))
        .route("/api/memory/{company_id}", put(put_memory_handler))
        .route("/api/intent", post(post_intent_handler))
        .route("/api/sim/control", post(sim_control_handler))
        .route("/api/companies", post(create_company_handler))
        .route("/ws", get(ws_handler))
        .with_state(engine)
        .layer(CorsLayer::permissive());

    match dist_dir {
        Some(dir) if dir.exists() => {
            let index = dir.join("index.html");
            api_router.fallback_service(ServeDir::new(dir).fallback(ServeFile::new(index)))
        }
        _ => api_router,
    }
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

async fn admin_overview_handler(State(engine): State<SharedEngine>) -> impl IntoResponse {
    let eng = engine.lock().await;
    Json(eng.admin_overview())
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
    Query(q): Query<StateQuery>,
) -> impl IntoResponse {
    let eng = engine.lock().await;
    let cid = q.company_id.as_deref().unwrap_or("player1");
    Json(eng.state_response(cid))
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
    let sid = q.station_id.as_deref().unwrap_or("ST:HUB");
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
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e))?;
    let recent_trades = eng
        .store
        .query_recent_trades(sid, item_id, 40)
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e))?;

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
    let sid = q.station_id.as_deref().unwrap_or("ST:HUB");
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
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e))?;

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
    Path(company_id): Path<String>,
) -> Result<Json<ScriptsResp>, (StatusCode, String)> {
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
    Path(company_id): Path<String>,
    Json(req): Json<PutScriptsReq>,
) -> Result<Json<serde_json::Value>, (StatusCode, String)> {
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
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e))?;
    eng.runner.set_player_script(&company_id, bundle);

    if let Some(en) = req.enabled {
        let mem_copy = eng.runner.players.get_mut(&company_id).map(|pvm| {
            pvm.enabled = en;
            pvm.memory_json.clone()
        });
        if let Some(mem_json) = mem_copy {
            let _ = eng.store.save_player_memory(&company_id, &mem_json, en);
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
    Path(company_id): Path<String>,
    Json(req): Json<PutMemoryReq>,
) -> Result<Json<serde_json::Value>, (StatusCode, String)> {
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
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e))?;

    Ok(Json(serde_json::json!({ "ok": true })))
}

#[derive(Deserialize)]
struct PostIntentReq {
    company_id: String,
    intent: Intent,
}

async fn post_intent_handler(
    State(engine): State<SharedEngine>,
    Json(req): Json<PostIntentReq>,
) -> Result<Json<serde_json::Value>, (StatusCode, String)> {
    let mut eng = engine.lock().await;
    eng.queue_manual_intent(req.company_id, req.intent)
        .map_err(|e| (StatusCode::BAD_REQUEST, e))?;
    Ok(Json(serde_json::json!({ "ok": true, "queued": true })))
}

#[derive(Deserialize)]
struct SimControlReq {
    action: String,
    tick_ms: Option<u64>,
}

async fn sim_control_handler(
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
            let ms = req.tick_ms.unwrap_or(2000).clamp(50, 60_000);
            eng.tick_ms = ms;
            Ok(Json(serde_json::json!({ "ok": true, "tick_ms": ms })))
        }
        "step" => {
            let bcast = eng
                .step_once()
                .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e))?;
            Ok(Json(serde_json::to_value(&bcast).unwrap()))
        }
        "reset" => {
            let bcast = eng
                .reset_world()
                .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e))?;
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

    if req.is_player {
        let bundle = PlayerScriptBundle::single_main(crate::engine::STARTER_PLAYER_JS);
        eng.store
            .save_player_bundle(&req.id, &bundle)
            .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e))?;
        eng.store
            .save_player_memory(&req.id, "{}", true)
            .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e))?;
        eng.runner.set_player_script(&req.id, bundle);
    } else {
        let genome = NpcGenome::from_seed(eng.world.tick.wrapping_add(req.id.len() as u64) + 31337);
        eng.store
            .save_npc_genome(&req.id, &genome)
            .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e))?;
        eng.runner.register_npc(&req.id, genome);
    }

    Ok(Json(serde_json::json!({ "ok": true, "id": req.id })))
}

async fn ws_handler(
    ws: WebSocketUpgrade,
    State(engine): State<SharedEngine>,
) -> impl IntoResponse {
    ws.on_upgrade(move |socket| handle_ws(socket, engine))
}

async fn handle_ws(mut socket: WebSocket, engine: SharedEngine) {
    let (init_json, mut rx) = {
        let eng = engine.lock().await;
        let init = serde_json::to_string(&serde_json::json!({
            "kind": "init",
            "state": eng.state_response("player1"),
        }))
        .unwrap_or_else(|_| "{}".to_string());
        (init, eng.events_tx.subscribe())
    };

    if socket.send(Message::Text(init_json.into())).await.is_err() {
        return;
    }

    loop {
        tokio::select! {
            res = rx.recv() => {
                match res {
                    Ok(ev) => {
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

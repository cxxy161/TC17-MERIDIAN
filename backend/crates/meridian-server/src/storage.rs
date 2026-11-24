//! SQLite WAL persistence layer for World state, player multi-module scripts,
//! persistent `Memory`, NPC genomes, and OHLCV market candles.

use std::collections::{BTreeMap, HashMap};
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

use meridian_core::{from_money, TradeFill, World};
use meridian_sandbox::{NpcGenome, PlayerScriptBundle};
use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CandleRow {
    pub bucket_tick: u64,
    pub open: f64,
    pub high: f64,
    pub low: f64,
    pub close: f64,
    pub volume: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CandleRangeResult {
    pub candles: Vec<CandleRow>,
    pub prev_close: Option<f64>,
    pub earliest_trade_tick: Option<u64>,
    pub latest_trade_tick: Option<u64>,
    pub total_trade_ticks: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TradeRow {
    pub tick: u64,
    pub station_id: String,
    pub item_id: String,
    pub qty: u32,
    pub price: f64,
    pub fee: f64,
    pub buyer_id: String,
    pub seller_id: String,
}

/// 账号行（不含口令哈希，后者单独查询，避免顺手泄露）
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct UserRow {
    pub id: i64,
    pub email: String,
    pub nickname: String,
    pub role: String,
    pub status: String,
    pub company_id: String,
    pub created_at: i64,
    pub nickname_changed_at: Option<i64>,
    pub last_login_at: Option<i64>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SessionRow {
    pub id: i64,
    pub user_id: i64,
    pub created_at: i64,
    pub expires_at: i64,
    pub last_seen_at: i64,
    pub user_agent: String,
}

fn map_user(row: &rusqlite::Row<'_>) -> rusqlite::Result<UserRow> {
    map_user_at(row, 0)
}

fn map_user_at(row: &rusqlite::Row<'_>, base: usize) -> rusqlite::Result<UserRow> {
    Ok(UserRow {
        id: row.get(base)?,
        email: row.get(base + 1)?,
        nickname: row.get(base + 2)?,
        role: row.get(base + 3)?,
        status: row.get(base + 4)?,
        company_id: row.get(base + 5)?,
        created_at: row.get(base + 6)?,
        nickname_changed_at: row.get(base + 7)?,
        last_login_at: row.get(base + 8)?,
    })
}

const USER_COLUMNS: &str = "id, email, nickname, role, status, company_id, created_at, nickname_changed_at, last_login_at";

pub struct SqliteStore {
    conn: Connection,
    pub db_path: Option<PathBuf>,
}

fn unix_secs() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0)
}

impl SqliteStore {
    pub fn open(path: impl AsRef<Path>) -> Result<Self, rusqlite::Error> {
        let pb = path.as_ref().to_path_buf();
        if let Some(parent) = pb.parent() {
            let _ = std::fs::create_dir_all(parent);
        }
        let conn = Connection::open(&pb)?;
        Self::init(conn, Some(pb))
    }

    pub fn open_in_memory() -> Result<Self, rusqlite::Error> {
        let conn = Connection::open_in_memory()?;
        Self::init(conn, None)
    }

    fn init(conn: Connection, db_path: Option<PathBuf>) -> Result<Self, rusqlite::Error> {
        conn.execute_batch(
            r#"
            PRAGMA journal_mode = WAL;
            PRAGMA synchronous = NORMAL;
            PRAGMA foreign_keys = ON;
            PRAGMA cache_size = -8000;

            CREATE TABLE IF NOT EXISTS world_state (
                id INTEGER PRIMARY KEY CHECK (id = 1),
                tick INTEGER NOT NULL,
                world_json TEXT NOT NULL,
                updated_at INTEGER NOT NULL
            );

            CREATE TABLE IF NOT EXISTS player_scripts (
                company_id TEXT NOT NULL,
                module_name TEXT NOT NULL,
                code TEXT NOT NULL,
                updated_at INTEGER NOT NULL,
                PRIMARY KEY (company_id, module_name)
            );

            CREATE TABLE IF NOT EXISTS player_memory (
                company_id TEXT PRIMARY KEY,
                memory_json TEXT NOT NULL,
                enabled INTEGER NOT NULL DEFAULT 1,
                updated_at INTEGER NOT NULL
            );

            CREATE TABLE IF NOT EXISTS npc_genomes (
                company_id TEXT PRIMARY KEY,
                genome_json TEXT NOT NULL,
                updated_at INTEGER NOT NULL
            );

            CREATE TABLE IF NOT EXISTS candles (
                station_id TEXT NOT NULL,
                item_id TEXT NOT NULL,
                bucket_tick INTEGER NOT NULL,
                open REAL NOT NULL,
                high REAL NOT NULL,
                low REAL NOT NULL,
                close REAL NOT NULL,
                volume INTEGER NOT NULL,
                PRIMARY KEY (station_id, item_id, bucket_tick)
            );

            CREATE TABLE IF NOT EXISTS trade_history (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                tick INTEGER NOT NULL,
                station_id TEXT NOT NULL,
                item_id TEXT NOT NULL,
                qty INTEGER NOT NULL,
                price REAL NOT NULL,
                fee REAL NOT NULL,
                buyer_id TEXT NOT NULL,
                seller_id TEXT NOT NULL
            );
            CREATE INDEX IF NOT EXISTS idx_trade_history_lookup
                ON trade_history (station_id, item_id, id DESC);

            -- 账号与会话（见 docs/MULTIPLAYER_AUDIT.md 的鉴权缺口）
            CREATE TABLE IF NOT EXISTS users (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                email TEXT NOT NULL UNIQUE COLLATE NOCASE,
                nickname TEXT NOT NULL UNIQUE COLLATE NOCASE,
                pwd_hash TEXT NOT NULL,
                salt TEXT NOT NULL,
                role TEXT NOT NULL DEFAULT 'player',
                status TEXT NOT NULL DEFAULT 'active',
                company_id TEXT NOT NULL UNIQUE,
                created_at INTEGER NOT NULL,
                updated_at INTEGER NOT NULL,
                last_login_at INTEGER,
                nickname_changed_at INTEGER
            );

            CREATE TABLE IF NOT EXISTS sessions (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
                token_hash TEXT NOT NULL UNIQUE,
                created_at INTEGER NOT NULL,
                expires_at INTEGER NOT NULL,
                last_seen_at INTEGER NOT NULL,
                user_agent TEXT NOT NULL DEFAULT ''
            );
            CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions (user_id);
            "#,
        )?;
        Ok(Self { conn, db_path })
    }

    pub fn save_world(&self, world: &World) -> Result<(), String> {
        let json = serde_json::to_string(world).map_err(|e| e.to_string())?;
        self.conn
            .execute(
                r#"
                INSERT INTO world_state (id, tick, world_json, updated_at)
                VALUES (1, ?1, ?2, ?3)
                ON CONFLICT(id) DO UPDATE SET
                    tick = excluded.tick,
                    world_json = excluded.world_json,
                    updated_at = excluded.updated_at
                "#,
                params![world.tick as i64, json, unix_secs()],
            )
            .map_err(|e| e.to_string())?;
        Ok(())
    }

    pub fn load_world(&self) -> Result<Option<World>, String> {
        let json_opt: Option<String> = self
            .conn
            .query_row(
                "SELECT world_json FROM world_state WHERE id = 1",
                [],
                |row| row.get(0),
            )
            .optional()
            .map_err(|e| e.to_string())?;
        match json_opt {
            Some(json) => {
                let w: World = serde_json::from_str(&json).map_err(|e| e.to_string())?;
                Ok(Some(w))
            }
            None => Ok(None),
        }
    }

    pub fn clear_world_and_history(&self) -> Result<(), String> {
        self.conn
            .execute_batch(
                r#"
                DELETE FROM world_state;
                DELETE FROM npc_genomes;
                DELETE FROM candles;
                DELETE FROM trade_history;
                "#,
            )
            .map_err(|e| e.to_string())
    }

    pub fn save_player_bundle(
        &mut self,
        company_id: &str,
        bundle: &PlayerScriptBundle,
    ) -> Result<(), String> {
        let now = unix_secs();
        let tx = self.conn.transaction().map_err(|e| e.to_string())?;
        tx.execute(
            "DELETE FROM player_scripts WHERE company_id = ?1",
            params![company_id],
        )
        .map_err(|e| e.to_string())?;
        for (mod_name, code) in &bundle.modules {
            tx.execute(
                "INSERT INTO player_scripts (company_id, module_name, code, updated_at) VALUES (?1, ?2, ?3, ?4)",
                params![company_id, mod_name, code, now],
            )
            .map_err(|e| e.to_string())?;
        }
        tx.commit().map_err(|e| e.to_string())?;
        Ok(())
    }

    pub fn load_all_player_bundles(&self) -> Result<HashMap<String, PlayerScriptBundle>, String> {
        let mut stmt = self
            .conn
            .prepare("SELECT company_id, module_name, code FROM player_scripts")
            .map_err(|e| e.to_string())?;
        let rows = stmt
            .query_map([], |r| {
                Ok((
                    r.get::<_, String>(0)?,
                    r.get::<_, String>(1)?,
                    r.get::<_, String>(2)?,
                ))
            })
            .map_err(|e| e.to_string())?;

        let mut map: HashMap<String, BTreeMap<String, String>> = HashMap::new();
        for row in rows {
            let (cid, mod_name, code) = row.map_err(|e| e.to_string())?;
            map.entry(cid).or_default().insert(mod_name, code);
        }
        Ok(map
            .into_iter()
            .map(|(cid, modules)| (cid, PlayerScriptBundle { modules }))
            .collect())
    }

    pub fn save_player_memory(
        &self,
        company_id: &str,
        memory_json: &str,
        enabled: bool,
    ) -> Result<(), String> {
        self.conn
            .execute(
                r#"
                INSERT INTO player_memory (company_id, memory_json, enabled, updated_at)
                VALUES (?1, ?2, ?3, ?4)
                ON CONFLICT(company_id) DO UPDATE SET
                    memory_json = excluded.memory_json,
                    enabled = excluded.enabled,
                    updated_at = excluded.updated_at
                "#,
                params![company_id, memory_json, if enabled { 1 } else { 0 }, unix_secs()],
            )
            .map_err(|e| e.to_string())?;
        Ok(())
    }

    pub fn load_all_player_memories(&self) -> Result<HashMap<String, (String, bool)>, String> {
        let mut stmt = self
            .conn
            .prepare("SELECT company_id, memory_json, enabled FROM player_memory")
            .map_err(|e| e.to_string())?;
        let rows = stmt
            .query_map([], |r| {
                Ok((
                    r.get::<_, String>(0)?,
                    r.get::<_, String>(1)?,
                    r.get::<_, i64>(2)? != 0,
                ))
            })
            .map_err(|e| e.to_string())?;
        let mut out = HashMap::new();
        for row in rows {
            let (cid, mem, en) = row.map_err(|e| e.to_string())?;
            out.insert(cid, (mem, en));
        }
        Ok(out)
    }

    pub fn save_npc_genome(&self, company_id: &str, genome: &NpcGenome) -> Result<(), String> {
        let json = serde_json::to_string(genome).map_err(|e| e.to_string())?;
        self.conn
            .execute(
                r#"
                INSERT INTO npc_genomes (company_id, genome_json, updated_at)
                VALUES (?1, ?2, ?3)
                ON CONFLICT(company_id) DO UPDATE SET
                    genome_json = excluded.genome_json,
                    updated_at = excluded.updated_at
                "#,
                params![company_id, json, unix_secs()],
            )
            .map_err(|e| e.to_string())?;
        Ok(())
    }

    pub fn delete_npc_genome(&self, company_id: &str) -> Result<(), String> {
        self.conn
            .execute(
                "DELETE FROM npc_genomes WHERE company_id = ?1",
                params![company_id],
            )
            .map_err(|e| e.to_string())?;
        Ok(())
    }

    pub fn load_all_npc_genomes(&self) -> Result<HashMap<String, NpcGenome>, String> {
        let mut stmt = self
            .conn
            .prepare("SELECT company_id, genome_json FROM npc_genomes")
            .map_err(|e| e.to_string())?;
        let rows = stmt
            .query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?)))
            .map_err(|e| e.to_string())?;
        let mut out = HashMap::new();
        for row in rows {
            let (cid, json) = row.map_err(|e| e.to_string())?;
            if let Ok(g) = serde_json::from_str::<NpcGenome>(&json) {
                out.insert(cid, g);
            }
        }
        Ok(out)
    }

    pub fn record_tick_fills(
        &mut self,
        fills: &[TradeFill],
        bucket_ticks: u64,
    ) -> Result<(), String> {
        if fills.is_empty() {
            return Ok(());
        }
        self.persist_tick_batch(fills, bucket_ticks, true, &[], &[], &[], None)
    }

    /// Coalesce fills, optional trade_history pruning, dirty player memories, NPC genome changes,
    /// and optional world snapshot into a single SQLite WAL transaction.
    #[allow(clippy::too_many_arguments)]
    pub fn persist_tick_batch(
        &mut self,
        fills: &[TradeFill],
        bucket_ticks: u64,
        prune_trade_history: bool,
        dirty_memories: &[(&str, &str, bool)],
        dead_npc_ids: &[String],
        new_npc_genomes: &[(&str, &NpcGenome)],
        world_to_save: Option<&World>,
    ) -> Result<(), String> {
        if fills.is_empty()
            && !prune_trade_history
            && dirty_memories.is_empty()
            && dead_npc_ids.is_empty()
            && new_npc_genomes.is_empty()
            && world_to_save.is_none()
        {
            return Ok(());
        }

        // Pre-serialize JSON payloads before opening the write transaction.
        let world_payload = match world_to_save {
            Some(w) => Some((w.tick as i64, serde_json::to_string(w).map_err(|e| e.to_string())?)),
            None => None,
        };
        let mut npc_jsons = Vec::with_capacity(new_npc_genomes.len());
        for &(cid, genome) in new_npc_genomes {
            npc_jsons.push((cid, serde_json::to_string(genome).map_err(|e| e.to_string())?));
        }

        let now = unix_secs();
        let bsize = bucket_ticks.max(1);
        let tx = self.conn.transaction().map_err(|e| e.to_string())?;

        if !fills.is_empty() {
            let mut candle_stmt = tx
                .prepare_cached(
                    r#"
                    INSERT INTO candles (station_id, item_id, bucket_tick, open, high, low, close, volume)
                    VALUES (?1, ?2, ?3, ?4, ?4, ?4, ?4, ?5)
                    ON CONFLICT(station_id, item_id, bucket_tick) DO UPDATE SET
                        high = MAX(candles.high, excluded.high),
                        low = MIN(candles.low, excluded.low),
                        close = excluded.close,
                        volume = candles.volume + excluded.volume
                    "#,
                )
                .map_err(|e| e.to_string())?;
            let mut trade_stmt = tx
                .prepare_cached(
                    r#"
                    INSERT INTO trade_history (tick, station_id, item_id, qty, price, fee, buyer_id, seller_id)
                    VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)
                    "#,
                )
                .map_err(|e| e.to_string())?;

            for f in fills {
                let px = from_money(f.price);
                let fee = from_money(f.fee);
                let bucket = (f.tick / bsize) * bsize;
                candle_stmt
                    .execute(params![
                        f.station_id,
                        f.item_id,
                        bucket as i64,
                        px,
                        f.qty as i64
                    ])
                    .map_err(|e| e.to_string())?;
                trade_stmt
                    .execute(params![
                        f.tick as i64,
                        f.station_id,
                        f.item_id,
                        f.qty as i64,
                        px,
                        fee,
                        f.buyer_id,
                        f.seller_id
                    ])
                    .map_err(|e| e.to_string())?;
            }
        }

        if prune_trade_history {
            // Keep bounded trade history (last 4000 rows) for small memory/disk footprint
            tx.execute(
                "DELETE FROM trade_history WHERE id <= (SELECT COALESCE(MAX(id), 0) - 4000 FROM trade_history)",
                [],
            )
            .map_err(|e| e.to_string())?;
        }

        if !dirty_memories.is_empty() {
            let mut mem_stmt = tx
                .prepare_cached(
                    r#"
                    INSERT INTO player_memory (company_id, memory_json, enabled, updated_at)
                    VALUES (?1, ?2, ?3, ?4)
                    ON CONFLICT(company_id) DO UPDATE SET
                        memory_json = excluded.memory_json,
                        enabled = excluded.enabled,
                        updated_at = excluded.updated_at
                    "#,
                )
                .map_err(|e| e.to_string())?;
            for &(cid, mem_json, enabled) in dirty_memories {
                mem_stmt
                    .execute(params![cid, mem_json, if enabled { 1 } else { 0 }, now])
                    .map_err(|e| e.to_string())?;
            }
        }

        if !dead_npc_ids.is_empty() {
            let mut del_stmt = tx
                .prepare_cached("DELETE FROM npc_genomes WHERE company_id = ?1")
                .map_err(|e| e.to_string())?;
            for dead_cid in dead_npc_ids {
                del_stmt
                    .execute(params![dead_cid])
                    .map_err(|e| e.to_string())?;
            }
        }

        if !npc_jsons.is_empty() {
            let mut npc_stmt = tx
                .prepare_cached(
                    r#"
                    INSERT INTO npc_genomes (company_id, genome_json, updated_at)
                    VALUES (?1, ?2, ?3)
                    ON CONFLICT(company_id) DO UPDATE SET
                        genome_json = excluded.genome_json,
                        updated_at = excluded.updated_at
                    "#,
                )
                .map_err(|e| e.to_string())?;
            for (cid, json) in &npc_jsons {
                npc_stmt
                    .execute(params![cid, json, now])
                    .map_err(|e| e.to_string())?;
            }
        }

        if let Some((tick, json)) = world_payload {
            tx.execute(
                r#"
                INSERT INTO world_state (id, tick, world_json, updated_at)
                VALUES (1, ?1, ?2, ?3)
                ON CONFLICT(id) DO UPDATE SET
                    tick = excluded.tick,
                    world_json = excluded.world_json,
                    updated_at = excluded.updated_at
                "#,
                params![tick, json, now],
            )
            .map_err(|e| e.to_string())?;
        }

        tx.commit().map_err(|e| e.to_string())?;
        Ok(())
    }

    pub fn query_candles(
        &self,
        station_id: &str,
        item_id: &str,
        limit: usize,
    ) -> Result<Vec<CandleRow>, String> {
        let mut stmt = self
            .conn
            .prepare(
                r#"
                SELECT bucket_tick, open, high, low, close, volume
                FROM candles
                WHERE station_id = ?1 AND item_id = ?2
                ORDER BY bucket_tick DESC
                LIMIT ?3
                "#,
            )
            .map_err(|e| e.to_string())?;
        let rows = stmt
            .query_map(params![station_id, item_id, limit as i64], |r| {
                Ok(CandleRow {
                    bucket_tick: r.get::<_, i64>(0)? as u64,
                    open: r.get(1)?,
                    high: r.get(2)?,
                    low: r.get(3)?,
                    close: r.get(4)?,
                    volume: r.get::<_, i64>(5)? as u64,
                })
            })
            .map_err(|e| e.to_string())?;
        let mut vec = Vec::new();
        for row in rows {
            vec.push(row.map_err(|e| e.to_string())?);
        }
        vec.reverse();
        Ok(vec)
    }

    pub fn query_candles_range(
        &self,
        station_id: &str,
        item_id: &str,
        period: u64,
        from_bucket: u64,
        to_bucket: u64,
    ) -> Result<CandleRangeResult, String> {
        let step = period.max(1);
        let aligned_from = (from_bucket / step) * step;
        let aligned_to = (to_bucket.max(aligned_from) / step) * step;
        let raw_to_end = aligned_to.saturating_add(step - 1);

        let (earliest_trade_tick, latest_trade_tick, total_trade_ticks): (
            Option<i64>,
            Option<i64>,
            i64,
        ) = self
            .conn
            .query_row(
                r#"
                SELECT MIN(bucket_tick), MAX(bucket_tick), COUNT(*)
                FROM candles
                WHERE station_id = ?1 AND item_id = ?2
                "#,
                params![station_id, item_id],
                |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
            )
            .map_err(|e| e.to_string())?;

        let prev_close: Option<f64> = self
            .conn
            .query_row(
                r#"
                SELECT close
                FROM candles
                WHERE station_id = ?1 AND item_id = ?2 AND bucket_tick < ?3
                ORDER BY bucket_tick DESC
                LIMIT 1
                "#,
                params![station_id, item_id, aligned_from as i64],
                |r| r.get(0),
            )
            .optional()
            .map_err(|e| e.to_string())?;

        let mut candles = Vec::new();
        if step == 1 {
            let mut stmt = self
                .conn
                .prepare(
                    r#"
                    SELECT bucket_tick, open, high, low, close, volume
                    FROM candles
                    WHERE station_id = ?1
                      AND item_id = ?2
                      AND bucket_tick >= ?3
                      AND bucket_tick <= ?4
                    ORDER BY bucket_tick ASC
                    LIMIT 10000
                    "#,
                )
                .map_err(|e| e.to_string())?;
            let rows = stmt
                .query_map(
                    params![station_id, item_id, aligned_from as i64, raw_to_end as i64],
                    |r| {
                        Ok(CandleRow {
                            bucket_tick: r.get::<_, i64>(0)? as u64,
                            open: r.get(1)?,
                            high: r.get(2)?,
                            low: r.get(3)?,
                            close: r.get(4)?,
                            volume: r.get::<_, i64>(5)? as u64,
                        })
                    },
                )
                .map_err(|e| e.to_string())?;
            for row in rows {
                candles.push(row.map_err(|e| e.to_string())?);
            }
        } else {
            let mut stmt = self
                .conn
                .prepare(
                    r#"
                    WITH ranged AS (
                        SELECT
                            (bucket_tick / ?3) * ?3 AS agg_bucket,
                            bucket_tick,
                            high,
                            low,
                            volume
                        FROM candles
                        WHERE station_id = ?1
                          AND item_id = ?2
                          AND bucket_tick >= ?4
                          AND bucket_tick <= ?5
                    ),
                    bounds AS (
                        SELECT
                            agg_bucket,
                            MIN(bucket_tick) AS first_tick,
                            MAX(bucket_tick) AS last_tick,
                            MAX(high) AS high,
                            MIN(low) AS low,
                            SUM(volume) AS volume
                        FROM ranged
                        GROUP BY agg_bucket
                    )
                    SELECT
                        b.agg_bucket,
                        c_first.open,
                        b.high,
                        b.low,
                        c_last.close,
                        b.volume
                    FROM bounds b
                    JOIN candles c_first
                      ON c_first.station_id = ?1
                     AND c_first.item_id = ?2
                     AND c_first.bucket_tick = b.first_tick
                    JOIN candles c_last
                      ON c_last.station_id = ?1
                     AND c_last.item_id = ?2
                     AND c_last.bucket_tick = b.last_tick
                    ORDER BY b.agg_bucket ASC
                    LIMIT 10000
                    "#,
                )
                .map_err(|e| e.to_string())?;
            let rows = stmt
                .query_map(
                    params![
                        station_id,
                        item_id,
                        step as i64,
                        aligned_from as i64,
                        raw_to_end as i64
                    ],
                    |r| {
                        Ok(CandleRow {
                            bucket_tick: r.get::<_, i64>(0)? as u64,
                            open: r.get(1)?,
                            high: r.get(2)?,
                            low: r.get(3)?,
                            close: r.get(4)?,
                            volume: r.get::<_, i64>(5)? as u64,
                        })
                    },
                )
                .map_err(|e| e.to_string())?;
            for row in rows {
                candles.push(row.map_err(|e| e.to_string())?);
            }
        }

        Ok(CandleRangeResult {
            candles,
            prev_close,
            earliest_trade_tick: earliest_trade_tick.map(|t| t as u64),
            latest_trade_tick: latest_trade_tick.map(|t| t as u64),
            total_trade_ticks: total_trade_ticks.max(0) as u64,
        })
    }

    pub fn query_recent_trades(
        &self,
        station_id: &str,
        item_id: &str,
        limit: usize,
    ) -> Result<Vec<TradeRow>, String> {
        let mut stmt = self
            .conn
            .prepare(
                r#"
                SELECT tick, station_id, item_id, qty, price, fee, buyer_id, seller_id
                FROM trade_history
                WHERE station_id = ?1 AND item_id = ?2
                ORDER BY id DESC
                LIMIT ?3
                "#,
            )
            .map_err(|e| e.to_string())?;
        let rows = stmt
            .query_map(params![station_id, item_id, limit as i64], |r| {
                Ok(TradeRow {
                    tick: r.get::<_, i64>(0)? as u64,
                    station_id: r.get(1)?,
                    item_id: r.get(2)?,
                    qty: r.get::<_, i64>(3)? as u32,
                    price: r.get(4)?,
                    fee: r.get(5)?,
                    buyer_id: r.get(6)?,
                    seller_id: r.get(7)?,
                })
            })
            .map_err(|e| e.to_string())?;
        let mut vec = Vec::new();
        for row in rows {
            vec.push(row.map_err(|e| e.to_string())?);
        }
        Ok(vec)
    }
    /* ---------------------------------------------------------- 账号 / 会话 */

    pub fn count_users(&self) -> i64 {
        self.conn
            .query_row("SELECT COUNT(*) FROM users", [], |r| r.get(0))
            .unwrap_or(0)
    }

    pub fn email_taken(&self, email: &str) -> bool {
        self.conn
            .query_row("SELECT 1 FROM users WHERE email = ?1", params![email], |_| Ok(()))
            .optional()
            .ok()
            .flatten()
            .is_some()
    }

    pub fn nickname_taken(&self, nickname: &str, except_user_id: Option<i64>) -> bool {
        self.conn
            .query_row(
                "SELECT 1 FROM users WHERE nickname = ?1 AND id != ?2",
                params![nickname, except_user_id.unwrap_or(-1)],
                |_| Ok(()),
            )
            .optional()
            .ok()
            .flatten()
            .is_some()
    }

    pub fn create_user(
        &self,
        email: &str,
        nickname: &str,
        pwd_hash: &str,
        salt: &str,
        role: &str,
        company_id: &str,
        now: i64,
    ) -> Result<i64, String> {
        self.conn
            .execute(
                "INSERT INTO users (email, nickname, pwd_hash, salt, role, status, company_id, created_at, updated_at)
                 VALUES (?1, ?2, ?3, ?4, ?5, 'active', ?6, ?7, ?7)",
                params![email, nickname, pwd_hash, salt, role, company_id, now],
            )
            .map_err(|e| e.to_string())?;
        Ok(self.conn.last_insert_rowid())
    }

    /// 返回 (用户, salt, pwd_hash)
    pub fn user_by_email(&self, email: &str) -> Option<(UserRow, String, String)> {
        self.conn
            .query_row(
                &format!("SELECT {USER_COLUMNS}, salt, pwd_hash FROM users WHERE email = ?1"),
                params![email],
                |row| {
                    let user = map_user(row)?;
                    let salt: String = row.get(9)?;
                    let hash: String = row.get(10)?;
                    Ok((user, salt, hash))
                },
            )
            .optional()
            .ok()
            .flatten()
    }

    pub fn user_by_id(&self, id: i64) -> Option<UserRow> {
        self.conn
            .query_row(
                &format!("SELECT {USER_COLUMNS} FROM users WHERE id = ?1"),
                params![id],
                |row| map_user(row),
            )
            .optional()
            .ok()
            .flatten()
    }

    pub fn user_by_company(&self, company_id: &str) -> Option<UserRow> {
        self.conn
            .query_row(
                &format!("SELECT {USER_COLUMNS} FROM users WHERE company_id = ?1"),
                params![company_id],
                |row| map_user(row),
            )
            .optional()
            .ok()
            .flatten()
    }

    pub fn set_user_company(&self, user_id: i64, company_id: &str) -> Result<(), String> {
        self.conn
            .execute(
                "UPDATE users SET company_id = ?1, updated_at = ?2 WHERE id = ?3",
                params![company_id, unix_secs(), user_id],
            )
            .map_err(|e| e.to_string())?;
        Ok(())
    }

    pub fn update_nickname(&self, user_id: i64, nickname: &str, now: i64) -> Result<(), String> {
        self.conn
            .execute(
                "UPDATE users SET nickname = ?1, nickname_changed_at = ?2, updated_at = ?2 WHERE id = ?3",
                params![nickname, now, user_id],
            )
            .map_err(|e| e.to_string())?;
        Ok(())
    }

    pub fn update_password(&self, user_id: i64, pwd_hash: &str, salt: &str) -> Result<(), String> {
        self.conn
            .execute(
                "UPDATE users SET pwd_hash = ?1, salt = ?2, updated_at = ?3 WHERE id = ?4",
                params![pwd_hash, salt, unix_secs(), user_id],
            )
            .map_err(|e| e.to_string())?;
        Ok(())
    }

    pub fn set_last_login(&self, user_id: i64, now: i64) -> Result<(), String> {
        self.conn
            .execute(
                "UPDATE users SET last_login_at = ?1 WHERE id = ?2",
                params![now, user_id],
            )
            .map_err(|e| e.to_string())?;
        Ok(())
    }

    pub fn create_session(
        &self,
        user_id: i64,
        token_hash: &str,
        created_at: i64,
        expires_at: i64,
        user_agent: &str,
    ) -> Result<i64, String> {
        self.conn
            .execute(
                "INSERT INTO sessions (user_id, token_hash, created_at, expires_at, last_seen_at, user_agent)
                 VALUES (?1, ?2, ?3, ?4, ?3, ?5)",
                params![user_id, token_hash, created_at, expires_at, user_agent],
            )
            .map_err(|e| e.to_string())?;
        Ok(self.conn.last_insert_rowid())
    }

    pub fn session_by_token_hash(&self, token_hash: &str) -> Option<(SessionRow, UserRow)> {
        self.conn
            .query_row(
                "SELECT s.id, s.user_id, s.created_at, s.expires_at, s.last_seen_at, s.user_agent,
                        u.id, u.email, u.nickname, u.role, u.status, u.company_id,
                        u.created_at, u.nickname_changed_at, u.last_login_at
                 FROM sessions s JOIN users u ON u.id = s.user_id
                 WHERE s.token_hash = ?1",
                params![token_hash],
                |row| {
                    let session = SessionRow {
                        id: row.get(0)?,
                        user_id: row.get(1)?,
                        created_at: row.get(2)?,
                        expires_at: row.get(3)?,
                        last_seen_at: row.get(4)?,
                        user_agent: row.get(5)?,
                    };
                    Ok((session, map_user_at(row, 6)?))
                },
            )
            .optional()
            .ok()
            .flatten()
    }

    pub fn touch_session(&self, session_id: i64, now: i64) -> Result<(), String> {
        self.conn
            .execute(
                "UPDATE sessions SET last_seen_at = ?1 WHERE id = ?2",
                params![now, session_id],
            )
            .map_err(|e| e.to_string())?;
        Ok(())
    }

    pub fn delete_session(&self, session_id: i64) -> Result<(), String> {
        self.conn
            .execute("DELETE FROM sessions WHERE id = ?1", params![session_id])
            .map_err(|e| e.to_string())?;
        Ok(())
    }

    pub fn delete_session_by_token_hash(&self, token_hash: &str) -> Result<(), String> {
        self.conn
            .execute(
                "DELETE FROM sessions WHERE token_hash = ?1",
                params![token_hash],
            )
            .map_err(|e| e.to_string())?;
        Ok(())
    }

    pub fn delete_other_sessions(&self, user_id: i64, keep_session_id: i64) -> Result<usize, String> {
        self.conn
            .execute(
                "DELETE FROM sessions WHERE user_id = ?1 AND id != ?2",
                params![user_id, keep_session_id],
            )
            .map_err(|e| e.to_string())
    }

    pub fn delete_all_sessions(&self, user_id: i64) -> Result<usize, String> {
        self.conn
            .execute("DELETE FROM sessions WHERE user_id = ?1", params![user_id])
            .map_err(|e| e.to_string())
    }

    pub fn list_sessions(&self, user_id: i64) -> Vec<SessionRow> {
        let mut stmt = match self.conn.prepare(
            "SELECT id, user_id, created_at, expires_at, last_seen_at, user_agent
             FROM sessions WHERE user_id = ?1 ORDER BY last_seen_at DESC",
        ) {
            Ok(s) => s,
            Err(_) => return Vec::new(),
        };
        let rows = stmt.query_map(params![user_id], |row| {
            Ok(SessionRow {
                id: row.get(0)?,
                user_id: row.get(1)?,
                created_at: row.get(2)?,
                expires_at: row.get(3)?,
                last_seen_at: row.get(4)?,
                user_agent: row.get(5)?,
            })
        });
        match rows {
            Ok(iter) => iter.filter_map(|r| r.ok()).collect(),
            Err(_) => Vec::new(),
        }
    }

    pub fn purge_expired_sessions(&self, now: i64) -> Result<usize, String> {
        self.conn
            .execute("DELETE FROM sessions WHERE expires_at <= ?1", params![now])
            .map_err(|e| e.to_string())
    }

    pub fn list_all_users(&self) -> Vec<UserRow> {
        let sql = format!("SELECT {USER_COLUMNS} FROM users ORDER BY id ASC");
        let mut stmt = match self.conn.prepare(&sql) {
            Ok(s) => s,
            Err(_) => return Vec::new(),
        };
        let rows = stmt.query_map([], map_user);
        match rows {
            Ok(iter) => iter.filter_map(|r| r.ok()).collect(),
            Err(_) => Vec::new(),
        }
    }

    pub fn list_active_sessions(&self, now: i64) -> Vec<SessionRow> {
        let mut stmt = match self.conn.prepare(
            "SELECT id, user_id, created_at, expires_at, last_seen_at, user_agent
             FROM sessions WHERE expires_at > ?1 ORDER BY last_seen_at DESC",
        ) {
            Ok(s) => s,
            Err(_) => return Vec::new(),
        };
        let rows = stmt.query_map(params![now], |row| {
            Ok(SessionRow {
                id: row.get(0)?,
                user_id: row.get(1)?,
                created_at: row.get(2)?,
                expires_at: row.get(3)?,
                last_seen_at: row.get(4)?,
                user_agent: row.get(5)?,
            })
        });
        match rows {
            Ok(iter) => iter.filter_map(|r| r.ok()).collect(),
            Err(_) => Vec::new(),
        }
    }

    pub fn set_user_status(&self, user_id: i64, status: &str, now: i64) -> Result<bool, String> {
        let n = self
            .conn
            .execute(
                "UPDATE users SET status = ?1, updated_at = ?2 WHERE id = ?3",
                params![status, now, user_id],
            )
            .map_err(|e| e.to_string())?;
        Ok(n > 0)
    }

    pub fn recent_trades(&self, limit: usize) -> Vec<TradeRow> {
        let lim = limit.clamp(1, 200) as i64;
        let mut stmt = match self.conn.prepare(
            "SELECT tick, station_id, item_id, qty, price, fee, buyer_id, seller_id
             FROM trade_history ORDER BY id DESC LIMIT ?1",
        ) {
            Ok(s) => s,
            Err(_) => return Vec::new(),
        };
        let rows = stmt.query_map(params![lim], |row| {
            Ok(TradeRow {
                tick: row.get::<_, i64>(0)? as u64,
                station_id: row.get(1)?,
                item_id: row.get(2)?,
                qty: row.get::<_, i64>(3)? as u32,
                price: row.get(4)?,
                fee: row.get(5)?,
                buyer_id: row.get(6)?,
                seller_id: row.get(7)?,
            })
        });
        match rows {
            Ok(iter) => iter.filter_map(|r| r.ok()).collect(),
            Err(_) => Vec::new(),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use meridian_core::to_money;

    fn mk_fill(tick: u64, price: f64, qty: u32) -> TradeFill {
        let p = to_money(price);
        let notional = p * qty as i64;
        TradeFill {
            tick,
            station_id: "ST:P2".to_string(),
            item_id: "power".to_string(),
            qty,
            price: p,
            notional,
            fee: 0,
            seller_proceeds: notional,
            buyer_refund: 0,
            buyer_id: "b1".to_string(),
            seller_id: "s1".to_string(),
        }
    }

    #[test]
    fn query_candles_range_handles_sparse_and_aggregated_periods() {
        let mut store = SqliteStore::open_in_memory().unwrap();
        store
            .record_tick_fills(
                &[
                    mk_fill(4, 1.5, 2),
                    mk_fill(4, 2.0, 4),
                    mk_fill(10, 2.2, 3),
                    mk_fill(12, 2.8, 5),
                    mk_fill(14, 2.4, 2),
                    mk_fill(17, 3.0, 1),
                ],
                1,
            )
            .unwrap();

        // Far after last trade: candles empty, prev_close carries last trade close
        let late = store
            .query_candles_range("ST:P2", "power", 1, 4500, 5000)
            .unwrap();
        assert!(late.candles.is_empty());
        assert!((late.prev_close.unwrap() - 3.0).abs() < 1e-6);
        assert_eq!(late.earliest_trade_tick, Some(4));
        assert_eq!(late.latest_trade_tick, Some(17));
        assert_eq!(late.total_trade_ticks, 5);

        // 5-tick aggregation across [10..19] should produce buckets 10 and 15 with prev_close from tick 4
        let agg = store
            .query_candles_range("ST:P2", "power", 5, 10, 19)
            .unwrap();
        assert!((agg.prev_close.unwrap() - 2.0).abs() < 1e-6);
        assert_eq!(agg.candles.len(), 2);
        assert_eq!(agg.candles[0].bucket_tick, 10);
        assert!((agg.candles[0].open - 2.2).abs() < 1e-6);
        assert!((agg.candles[0].high - 2.8).abs() < 1e-6);
        assert!((agg.candles[0].low - 2.2).abs() < 1e-6);
        assert!((agg.candles[0].close - 2.4).abs() < 1e-6);
        assert_eq!(agg.candles[0].volume, 10);

        assert_eq!(agg.candles[1].bucket_tick, 15);
        assert!((agg.candles[1].open - 3.0).abs() < 1e-6);
        assert_eq!(agg.candles[1].volume, 1);
    }
}

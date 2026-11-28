//! SQLite WAL persistence layer for World state, player multi-module scripts,
//! persistent `Memory`, NPC genomes, and OHLCV market candles.

use std::collections::{BTreeMap, BTreeSet, HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

const CANDLE_CHUNK_TICKS: u64 = 1_000;
const CHUNK_MAGIC: &[u8; 3] = b"MC1";

#[inline]
fn encode_uvarint(mut v: u64, out: &mut Vec<u8>) {
    loop {
        let byte = (v & 0x7f) as u8;
        v >>= 7;
        if v == 0 {
            out.push(byte);
            break;
        }
        out.push(byte | 0x80);
    }
}

#[inline]
fn decode_uvarint(buf: &[u8], pos: &mut usize) -> Option<u64> {
    let mut out = 0u64;
    let mut shift = 0u32;
    while *pos < buf.len() {
        let b = buf[*pos];
        *pos += 1;
        out |= ((b & 0x7f) as u64).checked_shl(shift)?;
        if (b & 0x80) == 0 {
            return Some(out);
        }
        shift += 7;
        if shift >= 64 {
            return None;
        }
    }
    None
}

#[inline]
fn zigzag_encode(v: i64) -> u64 {
    ((v << 1) ^ (v >> 63)) as u64
}

#[inline]
fn zigzag_decode(v: u64) -> i64 {
    ((v >> 1) as i64) ^ (-((v & 1) as i64))
}

#[inline]
fn price_to_fixed(px: f64) -> i64 {
    if !px.is_finite() {
        return 0;
    }
    (px * 10_000.0).round() as i64
}

#[inline]
fn fixed_to_price(fp: i64) -> f64 {
    fp as f64 / 10_000.0
}

fn encode_candle_chunk(chunk_start: u64, candles: &[CandleRow]) -> Vec<u8> {
    let mut out = Vec::with_capacity(16 + candles.len() * 6);
    out.extend_from_slice(CHUNK_MAGIC);
    encode_uvarint(candles.len() as u64, &mut out);

    let mut prev_tick = chunk_start;
    let mut prev_close: i64 = 0;
    let mut prev_vol: u64 = 0;

    for (idx, c) in candles.iter().enumerate() {
        let dt = c.bucket_tick.saturating_sub(prev_tick);
        let o = price_to_fixed(c.open);
        let h = price_to_fixed(c.high);
        let l = price_to_fixed(c.low);
        let cl = price_to_fixed(c.close);

        let open_delta = o.saturating_sub(prev_close);
        let body_hi = o.max(cl);
        let body_lo = o.min(cl);
        let hi_extra = h.saturating_sub(body_hi).max(0) as u64;
        let lo_extra = body_lo.saturating_sub(l).max(0) as u64;
        let close_delta = cl.saturating_sub(o);

        let dt_diff = idx == 0 || dt != 1;
        let mut flags = 0u8;
        if dt_diff {
            flags |= 1 << 0;
        }
        if open_delta != 0 {
            flags |= 1 << 1;
        }
        if hi_extra != 0 {
            flags |= 1 << 2;
        }
        if lo_extra != 0 {
            flags |= 1 << 3;
        }
        if close_delta != 0 {
            flags |= 1 << 4;
        }
        if c.volume != prev_vol {
            flags |= 1 << 5;
        }
        out.push(flags);

        if dt_diff {
            encode_uvarint(dt, &mut out);
        }
        if open_delta != 0 {
            encode_uvarint(zigzag_encode(open_delta), &mut out);
        }
        if hi_extra != 0 {
            encode_uvarint(hi_extra, &mut out);
        }
        if lo_extra != 0 {
            encode_uvarint(lo_extra, &mut out);
        }
        if close_delta != 0 {
            encode_uvarint(zigzag_encode(close_delta), &mut out);
        }
        if c.volume != prev_vol {
            encode_uvarint(c.volume, &mut out);
        }

        prev_tick = c.bucket_tick;
        prev_close = cl;
        prev_vol = c.volume;
    }
    out
}

fn decode_candle_chunk(chunk_start: u64, payload: &[u8]) -> Result<Vec<CandleRow>, String> {
    if payload.len() < 4 || &payload[0..3] != CHUNK_MAGIC {
        return Err("corrupt candle chunk header".to_string());
    }
    let mut pos = 3usize;
    let count = decode_uvarint(payload, &mut pos)
        .ok_or_else(|| "corrupt candle chunk count".to_string())? as usize;
    let mut out = Vec::with_capacity(count.min(CANDLE_CHUNK_TICKS as usize + 1));

    let mut prev_tick = chunk_start;
    let mut prev_close: i64 = 0;
    let mut prev_vol: u64 = 0;

    for _ in 0..count {
        if pos >= payload.len() {
            return Err("truncated candle chunk payload".to_string());
        }
        let flags = payload[pos];
        pos += 1;

        let dt = if (flags & (1 << 0)) != 0 {
            decode_uvarint(payload, &mut pos).ok_or_else(|| "bad candle dt".to_string())?
        } else {
            1
        };
        let open_delta = if (flags & (1 << 1)) != 0 {
            zigzag_decode(
                decode_uvarint(payload, &mut pos).ok_or_else(|| "bad open_delta".to_string())?,
            )
        } else {
            0
        };
        let hi_extra = if (flags & (1 << 2)) != 0 {
            decode_uvarint(payload, &mut pos).ok_or_else(|| "bad hi_extra".to_string())? as i64
        } else {
            0
        };
        let lo_extra = if (flags & (1 << 3)) != 0 {
            decode_uvarint(payload, &mut pos).ok_or_else(|| "bad lo_extra".to_string())? as i64
        } else {
            0
        };
        let close_delta = if (flags & (1 << 4)) != 0 {
            zigzag_decode(
                decode_uvarint(payload, &mut pos).ok_or_else(|| "bad close_delta".to_string())?,
            )
        } else {
            0
        };
        let volume = if (flags & (1 << 5)) != 0 {
            decode_uvarint(payload, &mut pos).ok_or_else(|| "bad volume".to_string())?
        } else {
            prev_vol
        };

        let tick = prev_tick.saturating_add(dt);
        let o = prev_close.saturating_add(open_delta);
        let cl = o.saturating_add(close_delta);
        let h = o.max(cl).saturating_add(hi_extra);
        let l = o.min(cl).saturating_sub(lo_extra);

        out.push(CandleRow {
            bucket_tick: tick,
            open: fixed_to_price(o),
            high: fixed_to_price(h),
            low: fixed_to_price(l),
            close: fixed_to_price(cl),
            volume,
        });

        prev_tick = tick;
        prev_close = cl;
        prev_vol = volume;
    }
    Ok(out)
}

use meridian_core::{from_money, TradeFill, World};
use meridian_sandbox::{NpcGenome, NpcMemory, PlayerScriptBundle};
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
    pub needs_onboarding: bool,
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
        needs_onboarding: row.get::<_, i64>(base + 9)? != 0,
    })
}

const USER_COLUMNS: &str = "id, email, nickname, role, status, company_id, created_at, nickname_changed_at, last_login_at, needs_onboarding";

pub struct SqliteStore {
    conn: Connection,
    pub db_path: Option<PathBuf>,
    hot_candles: HashMap<(String, String), BTreeMap<u64, CandleRow>>,
    dirty_hot_candles: HashMap<(String, String), HashSet<u64>>,
    seeded_chunks: HashSet<(String, String, u64)>,
    max_candle_tick: u64,
}

impl Drop for SqliteStore {
    fn drop(&mut self) {
        let _ = self.flush_candles();
    }
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

            CREATE TABLE IF NOT EXISTS npc_memories (
                company_id TEXT PRIMARY KEY,
                memory_json TEXT NOT NULL,
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

            CREATE TABLE IF NOT EXISTS candle_chunks (
                station_id TEXT NOT NULL,
                item_id TEXT NOT NULL,
                chunk_start INTEGER NOT NULL,
                first_tick INTEGER NOT NULL,
                last_tick INTEGER NOT NULL,
                tick_count INTEGER NOT NULL,
                last_close REAL NOT NULL,
                payload BLOB NOT NULL,
                PRIMARY KEY (station_id, item_id, chunk_start)
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
                nickname_changed_at INTEGER,
                needs_onboarding INTEGER NOT NULL DEFAULT 0
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
        let _ = conn.execute(
            "ALTER TABLE users ADD COLUMN needs_onboarding INTEGER NOT NULL DEFAULT 0",
            [],
        );
        let max_hot: Option<i64> = conn
            .query_row("SELECT MAX(bucket_tick) FROM candles", [], |r| r.get(0))
            .ok()
            .flatten();
        let max_chunk: Option<i64> = conn
            .query_row("SELECT MAX(last_tick) FROM candle_chunks", [], |r| r.get(0))
            .ok()
            .flatten();
        let max_candle_tick = max_hot.unwrap_or(0).max(max_chunk.unwrap_or(0)).max(0) as u64;
        Ok(Self {
            conn,
            db_path,
            hot_candles: HashMap::new(),
            dirty_hot_candles: HashMap::new(),
            seeded_chunks: HashSet::new(),
            max_candle_tick,
        })
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

    pub fn clear_world_and_history(&mut self) -> Result<(), String> {
        self.hot_candles.clear();
        self.dirty_hot_candles.clear();
        self.seeded_chunks.clear();
        self.max_candle_tick = 0;
        self.conn
            .execute_batch(
                r#"
                DELETE FROM world_state;
                DELETE FROM npc_genomes;
                DELETE FROM npc_memories;
                DELETE FROM candles;
                DELETE FROM candle_chunks;
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

    pub fn load_all_npc_memories(&self) -> Result<HashMap<String, NpcMemory>, String> {
        let mut stmt = self
            .conn
            .prepare("SELECT company_id, memory_json FROM npc_memories")
            .map_err(|e| e.to_string())?;
        let rows = stmt
            .query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?)))
            .map_err(|e| e.to_string())?;
        let mut out = HashMap::new();
        for row in rows {
            let (cid, json) = row.map_err(|e| e.to_string())?;
            if let Ok(m) = serde_json::from_str::<NpcMemory>(&json) {
                out.insert(cid, m);
            }
        }
        Ok(out)
    }

    pub fn save_all_npc_memories(
        &mut self,
        memories: &HashMap<String, NpcMemory>,
    ) -> Result<(), String> {
        if memories.is_empty() {
            return Ok(());
        }
        let now = unix_secs();
        let mut pairs = Vec::with_capacity(memories.len());
        for (cid, mem) in memories {
            if let Ok(json) = serde_json::to_string(mem) {
                pairs.push((cid.as_str(), json));
            }
        }
        let tx = self.conn.transaction().map_err(|e| e.to_string())?;
        {
            let mut stmt = tx
                .prepare_cached(
                    r#"
                    INSERT INTO npc_memories (company_id, memory_json, updated_at)
                    VALUES (?1, ?2, ?3)
                    ON CONFLICT(company_id) DO UPDATE SET
                        memory_json = excluded.memory_json,
                        updated_at = excluded.updated_at
                    "#,
                )
                .map_err(|e| e.to_string())?;
            for (cid, json) in &pairs {
                stmt.execute(params![cid, json, now])
                    .map_err(|e| e.to_string())?;
            }
        }
        tx.commit().map_err(|e| e.to_string())?;
        Ok(())
    }

    fn seed_chunk_if_needed(
        tx: &rusqlite::Transaction<'_>,
        hot_candles: &mut HashMap<(String, String), BTreeMap<u64, CandleRow>>,
        seeded_chunks: &mut HashSet<(String, String, u64)>,
        station_id: &str,
        item_id: &str,
        chunk_start: u64,
    ) -> Result<(), String> {
        let seed_key = (station_id.to_string(), item_id.to_string(), chunk_start);
        if seeded_chunks.contains(&seed_key) {
            return Ok(());
        }
        let chunk_end = chunk_start.saturating_add(CANDLE_CHUNK_TICKS);
        let key = (station_id.to_string(), item_id.to_string());
        let map = hot_candles.entry(key).or_default();

        let existing_blob: Option<Vec<u8>> = tx
            .query_row(
                r#"
                SELECT payload
                FROM candle_chunks
                WHERE station_id = ?1 AND item_id = ?2 AND chunk_start = ?3
                "#,
                params![station_id, item_id, chunk_start as i64],
                |r| r.get(0),
            )
            .optional()
            .map_err(|e| e.to_string())?;
        if let Some(blob) = existing_blob {
            for c in decode_candle_chunk(chunk_start, &blob)? {
                map.entry(c.bucket_tick).or_insert(c);
            }
        }

        let mut stmt = tx
            .prepare_cached(
                r#"
                SELECT bucket_tick, open, high, low, close, volume
                FROM candles
                WHERE station_id = ?1 AND item_id = ?2 AND bucket_tick >= ?3 AND bucket_tick < ?4
                "#,
            )
            .map_err(|e| e.to_string())?;
        let rows = stmt
            .query_map(
                params![station_id, item_id, chunk_start as i64, chunk_end as i64],
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
            let c = row.map_err(|e| e.to_string())?;
            map.insert(c.bucket_tick, c);
        }

        seeded_chunks.insert(seed_key);
        Ok(())
    }

    fn compact_legacy_candle_batch(
        tx: &rusqlite::Transaction<'_>,
        active_chunk_start: u64,
        max_chunks: usize,
    ) -> Result<(), String> {
        if active_chunk_start == 0 || max_chunks == 0 {
            return Ok(());
        }
        let targets: Vec<(String, String, u64)> = {
            let mut stmt = tx
                .prepare_cached(
                    r#"
                    SELECT DISTINCT
                        station_id,
                        item_id,
                        (bucket_tick / ?1) * ?1 AS cs
                    FROM candles
                    WHERE bucket_tick < ?2
                    LIMIT ?3
                    "#,
                )
                .map_err(|e| e.to_string())?;
            let rows = stmt
                .query_map(
                    params![
                        CANDLE_CHUNK_TICKS as i64,
                        active_chunk_start as i64,
                        max_chunks as i64
                    ],
                    |r| {
                        Ok((
                            r.get::<_, String>(0)?,
                            r.get::<_, String>(1)?,
                            r.get::<_, i64>(2)? as u64,
                        ))
                    },
                )
                .map_err(|e| e.to_string())?;
            let mut out = Vec::new();
            for row in rows {
                out.push(row.map_err(|e| e.to_string())?);
            }
            out
        };

        for (sid, iid, cs) in targets {
            let cs_end = cs.saturating_add(CANDLE_CHUNK_TICKS);
            let mut merged: BTreeMap<u64, CandleRow> = BTreeMap::new();
            let existing_blob: Option<Vec<u8>> = tx
                .query_row(
                    r#"
                    SELECT payload
                    FROM candle_chunks
                    WHERE station_id = ?1 AND item_id = ?2 AND chunk_start = ?3
                    "#,
                    params![sid, iid, cs as i64],
                    |r| r.get(0),
                )
                .optional()
                .map_err(|e| e.to_string())?;
            if let Some(blob) = existing_blob {
                for c in decode_candle_chunk(cs, &blob)? {
                    merged.insert(c.bucket_tick, c);
                }
            }
            {
                let mut q = tx
                    .prepare_cached(
                        r#"
                        SELECT bucket_tick, open, high, low, close, volume
                        FROM candles
                        WHERE station_id = ?1 AND item_id = ?2 AND bucket_tick >= ?3 AND bucket_tick < ?4
                        ORDER BY bucket_tick ASC
                        "#,
                    )
                    .map_err(|e| e.to_string())?;
                let rows = q
                    .query_map(params![sid, iid, cs as i64, cs_end as i64], |r| {
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
                for row in rows {
                    let c = row.map_err(|e| e.to_string())?;
                    merged.insert(c.bucket_tick, c);
                }
            }
            if !merged.is_empty() {
                let list: Vec<CandleRow> = merged.into_values().collect();
                let first_tick = list[0].bucket_tick as i64;
                let last_tick = list.last().unwrap().bucket_tick as i64;
                let tick_count = list.len() as i64;
                let last_close = list.last().unwrap().close;
                let payload = encode_candle_chunk(cs, &list);
                tx.execute(
                    r#"
                    INSERT OR REPLACE INTO candle_chunks
                        (station_id, item_id, chunk_start, first_tick, last_tick, tick_count, last_close, payload)
                    VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)
                    "#,
                    params![sid, iid, cs as i64, first_tick, last_tick, tick_count, last_close, payload],
                )
                .map_err(|e| e.to_string())?;
            }
            tx.execute(
                r#"
                DELETE FROM candles
                WHERE station_id = ?1 AND item_id = ?2 AND bucket_tick >= ?3 AND bucket_tick < ?4
                "#,
                params![sid, iid, cs as i64, cs_end as i64],
            )
            .map_err(|e| e.to_string())?;
        }
        Ok(())
    }

    fn flush_candles_in_tx(
        tx: &rusqlite::Transaction<'_>,
        hot_candles: &mut HashMap<(String, String), BTreeMap<u64, CandleRow>>,
        dirty_hot_candles: &mut HashMap<(String, String), HashSet<u64>>,
        seeded_chunks: &mut HashSet<(String, String, u64)>,
        active_chunk_start: u64,
        flush_hot_to_disk: bool,
    ) -> Result<(), String> {
        let mut closed_chunks: Vec<((String, String), u64)> = Vec::new();
        for (key, map) in hot_candles.iter() {
            let mut seen_cs = HashSet::new();
            for &bt in map.keys() {
                let cs = (bt / CANDLE_CHUNK_TICKS) * CANDLE_CHUNK_TICKS;
                if cs < active_chunk_start && seen_cs.insert(cs) {
                    closed_chunks.push((key.clone(), cs));
                }
            }
        }

        for (key, cs) in closed_chunks {
            Self::seed_chunk_if_needed(tx, hot_candles, seeded_chunks, &key.0, &key.1, cs)?;
            let cs_end = cs.saturating_add(CANDLE_CHUNK_TICKS);
            let list: Vec<CandleRow> = {
                let Some(map) = hot_candles.get_mut(&key) else {
                    continue;
                };
                let keys_in_chunk: Vec<u64> = map.range(cs..cs_end).map(|(&k, _)| k).collect();
                let mut out = Vec::with_capacity(keys_in_chunk.len());
                for bt in keys_in_chunk {
                    if let Some(c) = map.remove(&bt) {
                        out.push(c);
                    }
                    if let Some(dset) = dirty_hot_candles.get_mut(&key) {
                        dset.remove(&bt);
                    }
                }
                out
            };
            if hot_candles.get(&key).is_some_and(|m| m.is_empty()) {
                hot_candles.remove(&key);
            }
            if dirty_hot_candles.get(&key).is_some_and(|s| s.is_empty()) {
                dirty_hot_candles.remove(&key);
            }
            seeded_chunks.remove(&(key.0.clone(), key.1.clone(), cs));

            if !list.is_empty() {
                let first_tick = list[0].bucket_tick as i64;
                let last_tick = list.last().unwrap().bucket_tick as i64;
                let tick_count = list.len() as i64;
                let last_close = list.last().unwrap().close;
                let payload = encode_candle_chunk(cs, &list);
                tx.execute(
                    r#"
                    INSERT OR REPLACE INTO candle_chunks
                        (station_id, item_id, chunk_start, first_tick, last_tick, tick_count, last_close, payload)
                    VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)
                    "#,
                    params![key.0, key.1, cs as i64, first_tick, last_tick, tick_count, last_close, payload],
                )
                .map_err(|e| e.to_string())?;
            }
            tx.execute(
                r#"
                DELETE FROM candles
                WHERE station_id = ?1 AND item_id = ?2 AND bucket_tick >= ?3 AND bucket_tick < ?4
                "#,
                params![key.0, key.1, cs as i64, cs_end as i64],
            )
            .map_err(|e| e.to_string())?;
        }

        if flush_hot_to_disk {
            if !dirty_hot_candles.is_empty() {
                let mut candle_stmt = tx
                    .prepare_cached(
                        r#"
                        INSERT OR REPLACE INTO candles
                            (station_id, item_id, bucket_tick, open, high, low, close, volume)
                        VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)
                        "#,
                    )
                    .map_err(|e| e.to_string())?;
                for (key, buckets) in dirty_hot_candles.drain() {
                    if let Some(map) = hot_candles.get(&key) {
                        for bt in buckets {
                            if let Some(c) = map.get(&bt) {
                                candle_stmt
                                    .execute(params![
                                        key.0,
                                        key.1,
                                        c.bucket_tick as i64,
                                        c.open,
                                        c.high,
                                        c.low,
                                        c.close,
                                        c.volume as i64
                                    ])
                                    .map_err(|e| e.to_string())?;
                            }
                        }
                    }
                }
            }
            Self::compact_legacy_candle_batch(tx, active_chunk_start, 24)?;
        }

        Ok(())
    }

    pub fn flush_candles(&mut self) -> Result<(), String> {
        let active_chunk_start = (self.max_candle_tick / CANDLE_CHUNK_TICKS) * CANDLE_CHUNK_TICKS;
        if self.dirty_hot_candles.is_empty() {
            return Ok(());
        }
        let tx = self.conn.transaction().map_err(|e| e.to_string())?;
        Self::flush_candles_in_tx(
            &tx,
            &mut self.hot_candles,
            &mut self.dirty_hot_candles,
            &mut self.seeded_chunks,
            active_chunk_start,
            true,
        )?;
        tx.commit().map_err(|e| e.to_string())?;
        Ok(())
    }

    pub fn record_tick_fills(
        &mut self,
        fills: &[TradeFill],
        bucket_ticks: u64,
    ) -> Result<(), String> {
        if fills.is_empty() {
            return Ok(());
        }
        self.persist_tick_batch_inner(fills, bucket_ticks, true, &[], &[], &[], None, true)
    }

    /// Coalesce fills, optional trade_history pruning, dirty player memories, NPC genome changes,
    /// and optional world snapshot into a single SQLite WAL transaction.
    ///
    /// Candles are buffered in memory per tick and compacted into compressed 1,000-tick chunks
    /// when a chunk closes or on periodic checkpoints (`world_to_save.is_some()`), slashing SQLite
    /// row count and disk write amplification without losing any history.
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
        let flush_hot = world_to_save.is_some();
        self.persist_tick_batch_inner(
            fills,
            bucket_ticks,
            prune_trade_history,
            dirty_memories,
            dead_npc_ids,
            new_npc_genomes,
            world_to_save,
            flush_hot,
        )
    }

    #[allow(clippy::too_many_arguments)]
    fn persist_tick_batch_inner(
        &mut self,
        fills: &[TradeFill],
        bucket_ticks: u64,
        prune_trade_history: bool,
        dirty_memories: &[(&str, &str, bool)],
        dead_npc_ids: &[String],
        new_npc_genomes: &[(&str, &NpcGenome)],
        world_to_save: Option<&World>,
        flush_hot_candles: bool,
    ) -> Result<(), String> {
        if fills.is_empty()
            && !prune_trade_history
            && dirty_memories.is_empty()
            && dead_npc_ids.is_empty()
            && new_npc_genomes.is_empty()
            && world_to_save.is_none()
            && !flush_hot_candles
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
        let prev_chunk_start = (self.max_candle_tick / CANDLE_CHUNK_TICKS) * CANDLE_CHUNK_TICKS;
        if let Some(w) = world_to_save {
            self.max_candle_tick = self.max_candle_tick.max(w.tick);
        }
        for f in fills {
            let bucket = (f.tick / bsize) * bsize;
            self.max_candle_tick = self.max_candle_tick.max(bucket);
        }
        let active_chunk_start = (self.max_candle_tick / CANDLE_CHUNK_TICKS) * CANDLE_CHUNK_TICKS;
        let rolled_chunk = active_chunk_start > prev_chunk_start;

        let need_tx = !fills.is_empty()
            || prune_trade_history
            || !dirty_memories.is_empty()
            || !dead_npc_ids.is_empty()
            || !new_npc_genomes.is_empty()
            || world_payload.is_some()
            || ((flush_hot_candles || rolled_chunk) && !self.dirty_hot_candles.is_empty())
            || flush_hot_candles;

        if !need_tx {
            return Ok(());
        }

        let tx = self.conn.transaction().map_err(|e| e.to_string())?;

        if !fills.is_empty() {
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
                let cs = (bucket / CANDLE_CHUNK_TICKS) * CANDLE_CHUNK_TICKS;
                Self::seed_chunk_if_needed(
                    &tx,
                    &mut self.hot_candles,
                    &mut self.seeded_chunks,
                    &f.station_id,
                    &f.item_id,
                    cs,
                )?;
                let key = (f.station_id.clone(), f.item_id.clone());
                let map = self.hot_candles.entry(key.clone()).or_default();
                match map.get_mut(&bucket) {
                    Some(c) => {
                        c.high = c.high.max(px);
                        c.low = c.low.min(px);
                        c.close = px;
                        c.volume = c.volume.saturating_add(f.qty as u64);
                    }
                    None => {
                        map.insert(
                            bucket,
                            CandleRow {
                                bucket_tick: bucket,
                                open: px,
                                high: px,
                                low: px,
                                close: px,
                                volume: f.qty as u64,
                            },
                        );
                    }
                }
                self.dirty_hot_candles.entry(key).or_default().insert(bucket);

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

        if flush_hot_candles || rolled_chunk {
            Self::flush_candles_in_tx(
                &tx,
                &mut self.hot_candles,
                &mut self.dirty_hot_candles,
                &mut self.seeded_chunks,
                active_chunk_start,
                flush_hot_candles,
            )?;
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
            let mut del_mem_stmt = tx
                .prepare_cached("DELETE FROM npc_memories WHERE company_id = ?1")
                .map_err(|e| e.to_string())?;
            for dead_cid in dead_npc_ids {
                del_stmt
                    .execute(params![dead_cid])
                    .map_err(|e| e.to_string())?;
                del_mem_stmt
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
        if limit == 0 {
            return Ok(Vec::new());
        }
        let mut merged: BTreeMap<u64, CandleRow> = BTreeMap::new();
        {
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
            for row in rows {
                let c = row.map_err(|e| e.to_string())?;
                merged.insert(c.bucket_tick, c);
            }
        }

        if let Some(hot) = self
            .hot_candles
            .get(&(station_id.to_string(), item_id.to_string()))
        {
            for (&bt, c) in hot.iter().rev().take(limit) {
                merged.insert(bt, c.clone());
            }
        }

        {
            let mut stmt = self
                .conn
                .prepare(
                    r#"
                    SELECT chunk_start, last_tick, payload
                    FROM candle_chunks
                    WHERE station_id = ?1 AND item_id = ?2
                    ORDER BY chunk_start DESC
                    "#,
                )
                .map_err(|e| e.to_string())?;
            let rows = stmt
                .query_map(params![station_id, item_id], |r| {
                    Ok((
                        r.get::<_, i64>(0)? as u64,
                        r.get::<_, i64>(1)? as u64,
                        r.get::<_, Vec<u8>>(2)?,
                    ))
                })
                .map_err(|e| e.to_string())?;
            for row in rows {
                let (cs, last_tick, blob) = row.map_err(|e| e.to_string())?;
                if merged.len() >= limit {
                    if let Some(&min_top_tick) = merged.keys().rev().nth(limit - 1) {
                        if last_tick < min_top_tick {
                            break;
                        }
                    }
                }
                for c in decode_candle_chunk(cs, &blob)? {
                    merged.entry(c.bucket_tick).or_insert(c);
                }
            }
        }

        let mut vec: Vec<CandleRow> = merged.into_values().rev().take(limit).collect();
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

        let key = (station_id.to_string(), item_id.to_string());
        let hot_opt = self.hot_candles.get(&key).filter(|m| !m.is_empty());

        let (chunk_min, chunk_max, chunk_cnt): (Option<i64>, Option<i64>, i64) = self
            .conn
            .query_row(
                r#"
                SELECT MIN(first_tick), MAX(last_tick), COALESCE(SUM(tick_count), 0)
                FROM candle_chunks
                WHERE station_id = ?1 AND item_id = ?2
                "#,
                params![station_id, item_id],
                |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
            )
            .map_err(|e| e.to_string())?;

        let mut earliest_trade_tick: Option<u64> = chunk_min.map(|v| v.max(0) as u64);
        let mut latest_trade_tick: Option<u64> = chunk_max.map(|v| v.max(0) as u64);
        let mut total_trade_ticks: u64 = chunk_cnt.max(0) as u64;

        let mut merge_bounds = |min_t: Option<u64>, max_t: Option<u64>, cnt: u64| {
            if let Some(mn) = min_t {
                earliest_trade_tick = Some(earliest_trade_tick.map_or(mn, |e| e.min(mn)));
            }
            if let Some(mx) = max_t {
                latest_trade_tick = Some(latest_trade_tick.map_or(mx, |l| l.max(mx)));
            }
            total_trade_ticks = total_trade_ticks.saturating_add(cnt);
        };

        if let Some(hot) = hot_opt {
            let split = *hot.keys().next().unwrap();
            let (below_min, below_max, below_cnt): (Option<i64>, Option<i64>, i64) = self
                .conn
                .query_row(
                    r#"
                    SELECT MIN(bucket_tick), MAX(bucket_tick), COUNT(*)
                    FROM candles
                    WHERE station_id = ?1 AND item_id = ?2 AND bucket_tick < ?3
                    "#,
                    params![station_id, item_id, split as i64],
                    |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
                )
                .map_err(|e| e.to_string())?;
            merge_bounds(
                below_min.map(|v| v.max(0) as u64),
                below_max.map(|v| v.max(0) as u64),
                below_cnt.max(0) as u64,
            );

            let mut tail_ticks: BTreeSet<u64> = hot.keys().copied().collect();
            let mut stmt = self
                .conn
                .prepare(
                    r#"
                    SELECT bucket_tick
                    FROM candles
                    WHERE station_id = ?1 AND item_id = ?2 AND bucket_tick >= ?3
                    "#,
                )
                .map_err(|e| e.to_string())?;
            let rows = stmt
                .query_map(params![station_id, item_id, split as i64], |r| {
                    Ok(r.get::<_, i64>(0)? as u64)
                })
                .map_err(|e| e.to_string())?;
            for row in rows {
                tail_ticks.insert(row.map_err(|e| e.to_string())?);
            }
            merge_bounds(
                tail_ticks.iter().next().copied(),
                tail_ticks.iter().next_back().copied(),
                tail_ticks.len() as u64,
            );
        } else {
            let (hot_min, hot_max, hot_cnt): (Option<i64>, Option<i64>, i64) = self
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
            merge_bounds(
                hot_min.map(|v| v.max(0) as u64),
                hot_max.map(|v| v.max(0) as u64),
                hot_cnt.max(0) as u64,
            );
        }

        let mut best_prev: Option<(u64, f64)> = None;
        let mut consider_prev = |tick: u64, close: f64| {
            if tick < aligned_from && best_prev.is_none_or(|(pt, _)| tick > pt) {
                best_prev = Some((tick, close));
            }
        };
        if let Some(hot) = hot_opt {
            if let Some((&bt, c)) = hot.range(..aligned_from).next_back() {
                consider_prev(bt, c.close);
            }
        }
        let db_hot_prev: Option<(i64, f64)> = self
            .conn
            .query_row(
                r#"
                SELECT bucket_tick, close
                FROM candles
                WHERE station_id = ?1 AND item_id = ?2 AND bucket_tick < ?3
                ORDER BY bucket_tick DESC
                LIMIT 1
                "#,
                params![station_id, item_id, aligned_from as i64],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .optional()
            .map_err(|e| e.to_string())?;
        if let Some((bt, cl)) = db_hot_prev {
            let u_bt = bt.max(0) as u64;
            if hot_opt.is_none_or(|h| !h.contains_key(&u_bt)) {
                consider_prev(u_bt, cl);
            }
        }
        let chunk_prev: Option<(i64, i64, f64, Vec<u8>)> = self
            .conn
            .query_row(
                r#"
                SELECT chunk_start, last_tick, last_close, payload
                FROM candle_chunks
                WHERE station_id = ?1 AND item_id = ?2 AND first_tick < ?3
                ORDER BY chunk_start DESC
                LIMIT 1
                "#,
                params![station_id, item_id, aligned_from as i64],
                |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?)),
            )
            .optional()
            .map_err(|e| e.to_string())?;
        if let Some((cs, last_t, last_cl, blob)) = chunk_prev {
            let u_last = last_t.max(0) as u64;
            if u_last < aligned_from {
                consider_prev(u_last, last_cl);
            } else {
                for c in decode_candle_chunk(cs.max(0) as u64, &blob)? {
                    if c.bucket_tick < aligned_from {
                        consider_prev(c.bucket_tick, c.close);
                    }
                }
            }
        }
        let prev_close = best_prev.map(|(_, cl)| cl);

        let mut raw_map: BTreeMap<u64, CandleRow> = BTreeMap::new();
        {
            let mut stmt = self
                .conn
                .prepare(
                    r#"
                    SELECT chunk_start, payload
                    FROM candle_chunks
                    WHERE station_id = ?1
                      AND item_id = ?2
                      AND first_tick <= ?3
                      AND last_tick >= ?4
                    ORDER BY chunk_start ASC
                    "#,
                )
                .map_err(|e| e.to_string())?;
            let rows = stmt
                .query_map(
                    params![station_id, item_id, raw_to_end as i64, aligned_from as i64],
                    |r| Ok((r.get::<_, i64>(0)? as u64, r.get::<_, Vec<u8>>(1)?)),
                )
                .map_err(|e| e.to_string())?;
            for row in rows {
                let (cs, blob) = row.map_err(|e| e.to_string())?;
                for c in decode_candle_chunk(cs, &blob)? {
                    if c.bucket_tick >= aligned_from && c.bucket_tick <= raw_to_end {
                        raw_map.insert(c.bucket_tick, c);
                    }
                }
                if step == 1 && raw_map.len() >= 10_000 {
                    break;
                }
            }
        }
        {
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
                let c = row.map_err(|e| e.to_string())?;
                raw_map.insert(c.bucket_tick, c);
            }
        }
        if let Some(hot) = hot_opt {
            for (&bt, c) in hot.range(aligned_from..=raw_to_end) {
                raw_map.insert(bt, c.clone());
            }
        }

        let candles: Vec<CandleRow> = if step == 1 {
            raw_map.into_values().take(10_000).collect()
        } else {
            let mut agg_map: BTreeMap<u64, CandleRow> = BTreeMap::new();
            for c in raw_map.into_values() {
                let agg_bucket = (c.bucket_tick / step) * step;
                match agg_map.get_mut(&agg_bucket) {
                    Some(agg) => {
                        agg.high = agg.high.max(c.high);
                        agg.low = agg.low.min(c.low);
                        agg.close = c.close;
                        agg.volume = agg.volume.saturating_add(c.volume);
                    }
                    None => {
                        agg_map.insert(
                            agg_bucket,
                            CandleRow {
                                bucket_tick: agg_bucket,
                                open: c.open,
                                high: c.high,
                                low: c.low,
                                close: c.close,
                                volume: c.volume,
                            },
                        );
                    }
                }
            }
            agg_map.into_values().take(10_000).collect()
        };

        Ok(CandleRangeResult {
            candles,
            prev_close,
            earliest_trade_tick,
            latest_trade_tick,
            total_trade_ticks,
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
                    let salt: String = row.get(10)?;
                    let hash: String = row.get(11)?;
                    Ok((user, salt, hash))
                },
            )
            .optional()
            .ok()
            .flatten()
    }

    /// 按昵称查找用户（忽略大小写，schema 中 nickname 为 UNIQUE COLLATE NOCASE）
    pub fn user_by_nickname(&self, nickname: &str) -> Option<(UserRow, String, String)> {
        self.conn
            .query_row(
                &format!("SELECT {USER_COLUMNS}, salt, pwd_hash FROM users WHERE nickname = ?1"),
                params![nickname],
                |row| {
                    let user = map_user(row)?;
                    let salt: String = row.get(10)?;
                    let hash: String = row.get(11)?;
                    Ok((user, salt, hash))
                },
            )
            .optional()
            .ok()
            .flatten()
    }

    /// 支持邮箱或昵称登录查找；含 `@` 时优先按邮箱匹配，并兜底兼容历史上含 `@` 的旧昵称
    pub fn user_by_login(&self, identifier: &str) -> Option<(UserRow, String, String)> {
        if identifier.contains('@') {
            self.user_by_email(identifier)
                .or_else(|| self.user_by_nickname(identifier))
        } else {
            self.user_by_nickname(identifier)
        }
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

    pub fn set_user_onboarding(&self, user_id: i64, needs: bool) -> Result<(), String> {
        self.conn
            .execute(
                "UPDATE users SET needs_onboarding = ?1, updated_at = ?2 WHERE id = ?3",
                params![if needs { 1i64 } else { 0i64 }, unix_secs(), user_id],
            )
            .map_err(|e| e.to_string())?;
        Ok(())
    }

    pub fn mark_all_users_needs_onboarding(&self) -> Result<(), String> {
        self.conn
            .execute(
                "UPDATE users SET needs_onboarding = 1, updated_at = ?1",
                params![unix_secs()],
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
                        u.created_at, u.nickname_changed_at, u.last_login_at, u.needs_onboarding
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

    #[test]
    fn chunked_candle_compression_rolls_over_and_preserves_history() {
        let mut store = SqliteStore::open_in_memory().unwrap();
        let mut fills = Vec::new();
        for t in 1..=1_250u64 {
            let px = 2.0 + ((t % 17) as f64) * 0.1;
            fills.push(mk_fill(t, px, (t % 5 + 1) as u32));
        }
        store.record_tick_fills(&fills, 1).unwrap();

        let chunk_count: i64 = store
            .conn
            .query_row("SELECT COUNT(*) FROM candle_chunks", [], |r| r.get(0))
            .unwrap();
        assert_eq!(chunk_count, 1, "chunk [0..999] must be compressed into 1 row");

        let hot_rows: i64 = store
            .conn
            .query_row("SELECT COUNT(*) FROM candles", [], |r| r.get(0))
            .unwrap();
        assert_eq!(hot_rows, 251, "active chunk [1000..1250] stays in hot candles");

        let res = store
            .query_candles_range("ST:P2", "power", 1, 995, 1_005)
            .unwrap();
        assert_eq!(res.earliest_trade_tick, Some(1));
        assert_eq!(res.latest_trade_tick, Some(1_250));
        assert_eq!(res.total_trade_ticks, 1_250);
        assert!(res.prev_close.is_some());
        assert_eq!(res.candles.len(), 11);
        assert_eq!(res.candles[0].bucket_tick, 995);
        assert_eq!(res.candles[10].bucket_tick, 1_005);

        let recent = store.query_candles("ST:P2", "power", 300).unwrap();
        assert_eq!(recent.len(), 300);
        assert_eq!(recent[0].bucket_tick, 951);
        assert_eq!(recent.last().unwrap().bucket_tick, 1_250);
    }
}

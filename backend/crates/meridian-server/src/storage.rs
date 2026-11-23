//! SQLite WAL persistence layer for World state, player multi-module scripts,
//! persistent `Memory`, NPC genomes, and OHLCV market candles.

use std::collections::{BTreeMap, HashMap};
use std::path::Path;
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

pub struct SqliteStore {
    conn: Connection,
}

fn unix_secs() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0)
}

impl SqliteStore {
    pub fn open(path: impl AsRef<Path>) -> Result<Self, rusqlite::Error> {
        if let Some(parent) = path.as_ref().parent() {
            let _ = std::fs::create_dir_all(parent);
        }
        let conn = Connection::open(path)?;
        Self::init(conn)
    }

    pub fn open_in_memory() -> Result<Self, rusqlite::Error> {
        let conn = Connection::open_in_memory()?;
        Self::init(conn)
    }

    fn init(conn: Connection) -> Result<Self, rusqlite::Error> {
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
            "#,
        )?;
        Ok(Self { conn })
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
        let bsize = bucket_ticks.max(1);
        let tx = self.conn.transaction().map_err(|e| e.to_string())?;
        for f in fills {
            let px = from_money(f.price);
            let fee = from_money(f.fee);
            let bucket = (f.tick / bsize) * bsize;
            tx.execute(
                r#"
                INSERT INTO candles (station_id, item_id, bucket_tick, open, high, low, close, volume)
                VALUES (?1, ?2, ?3, ?4, ?4, ?4, ?4, ?5)
                ON CONFLICT(station_id, item_id, bucket_tick) DO UPDATE SET
                    high = MAX(candles.high, excluded.high),
                    low = MIN(candles.low, excluded.low),
                    close = excluded.close,
                    volume = candles.volume + excluded.volume
                "#,
                params![f.station_id, f.item_id, bucket as i64, px, f.qty as i64],
            )
            .map_err(|e| e.to_string())?;

            tx.execute(
                r#"
                INSERT INTO trade_history (tick, station_id, item_id, qty, price, fee, buyer_id, seller_id)
                VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)
                "#,
                params![
                    f.tick as i64,
                    f.station_id,
                    f.item_id,
                    f.qty as i64,
                    px,
                    fee,
                    f.buyer_id,
                    f.seller_id
                ],
            )
            .map_err(|e| e.to_string())?;
        }
        // Keep bounded trade history (last 4000 rows) for small memory/disk footprint
        tx.execute(
            "DELETE FROM trade_history WHERE id <= (SELECT COALESCE(MAX(id), 0) - 4000 FROM trade_history)",
            [],
        )
        .map_err(|e| e.to_string())?;
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
}

//! Meridian server crate: SQLite WAL persistence, simulation host loop, and axum HTTP/WS gateway.

pub mod api;
pub mod engine;
pub mod storage;

pub use api::build_router;
pub use engine::{GameEngine, SharedEngine, STARTER_PLAYER_JS};
pub use storage::SqliteStore;

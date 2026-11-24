//! Meridian server crate: SQLite WAL persistence, simulation host loop, and axum HTTP/WS gateway.

pub mod api;
pub mod auth;
pub mod engine;
pub mod storage;
pub mod telemetry;

pub use api::build_router;
pub use auth::{AuthUser, AuthLimiter};
pub use engine::{GameEngine, SharedEngine, STARTER_PLAYER_JS};
pub use storage::SqliteStore;

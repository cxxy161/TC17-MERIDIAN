//! Unified Snapshot -> Intent decision boundary for Player QuickJS scripts & free-play NPCs.

pub fn sandbox_ready() -> &'static str {
    meridian_core::engine_version()
}

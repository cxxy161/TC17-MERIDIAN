//! Unified Snapshot -> Intent decision boundary for Player QuickJS scripts & free-play NPCs.

pub mod js_runner;
pub mod npc;
pub mod runner;
pub mod types;

pub use js_runner::{run_player_tick, PlayerVmHandle};
pub use npc::{decide_npc_intents, NpcGenome};
pub use runner::{PlayerVmState, SimulationRunner};
pub use types::{
    normalize_module_name, ConsoleEntry, ConsoleEvalOutput, ConsoleLevel, JsLastTickFill,
    LastTickFeedback, PlayerRunConfig, PlayerRunOutput, PlayerScriptBundle,
};

pub fn sandbox_ready() -> &'static str {
    meridian_core::engine_version()
}

//! Shared sandbox configuration, script bundles, console logs, and run results.

use std::collections::BTreeMap;

use meridian_core::Intent;
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct PlayerScriptBundle {
    /// Mapping from module name (e.g. "main", "market") to JS source code.
    pub modules: BTreeMap<String, String>,
}

impl PlayerScriptBundle {
    pub fn single_main(code: impl Into<String>) -> Self {
        let mut modules = BTreeMap::new();
        modules.insert("main".to_string(), code.into());
        Self { modules }
    }

    pub fn with_module(mut self, name: impl Into<String>, code: impl Into<String>) -> Self {
        self.modules.insert(normalize_module_name(&name.into()), code.into());
        self
    }

    pub fn resolve(&self, name: &str) -> Option<&str> {
        let norm = normalize_module_name(name);
        if let Some(code) = self.modules.get(&norm) {
            return Some(code.as_str());
        }
        let with_ext = format!("{norm}.js");
        if let Some(code) = self.modules.get(&with_ext) {
            return Some(code.as_str());
        }
        self.modules.get(name).map(|s| s.as_str())
    }
}

pub fn normalize_module_name(raw: &str) -> String {
    let trimmed = raw.trim().trim_start_matches("./");
    trimmed.strip_suffix(".js").unwrap_or(trimmed).to_string()
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ConsoleLevel {
    Log,
    Warn,
    Error,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ConsoleEntry {
    pub level: ConsoleLevel,
    pub message: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PlayerRunConfig {
    /// QuickJS heap limit in bytes (default: 4 MB).
    pub memory_limit_bytes: usize,
    /// QuickJS call stack size limit in bytes (default: 256 KB).
    pub stack_size_bytes: usize,
    /// Wall-clock interrupt timeout per tick for user script execution in milliseconds (default: 10 ms).
    pub cpu_limit_ms: u64,
    /// Max serialized `Memory` JSON length in bytes (default: 128 KB).
    pub max_memory_json_bytes: usize,
    /// Max captured console lines per tick (default: 200).
    pub max_console_lines: usize,
    /// Max bytes per console line (default: 1024).
    pub max_console_line_bytes: usize,
}

impl Default for PlayerRunConfig {
    fn default() -> Self {
        Self {
            memory_limit_bytes: 4 * 1024 * 1024,
            stack_size_bytes: 256 * 1024,
            cpu_limit_ms: 10,
            max_memory_json_bytes: 128 * 1024,
            max_console_lines: 200,
            max_console_line_bytes: 1024,
        }
    }
}

impl PlayerRunConfig {
    /// Load default config and apply optional `MERIDIAN_JS_CPU_LIMIT_MS` override.
    pub fn from_env() -> Self {
        let mut cfg = Self::default();
        if let Ok(raw) = std::env::var("MERIDIAN_JS_CPU_LIMIT_MS") {
            if let Ok(ms) = raw.trim().parse::<u64>() {
                cfg.cpu_limit_ms = ms.clamp(1, 500);
            }
        }
        cfg
    }
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct PlayerRunOutput {
    pub intents: Vec<Intent>,
    pub memory_json: String,
    pub logs: Vec<ConsoleEntry>,
    pub cpu_used_ms: f64,
    pub error: Option<String>,
    pub timed_out: bool,
    pub oom: bool,
}

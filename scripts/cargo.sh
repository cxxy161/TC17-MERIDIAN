#!/usr/bin/env bash
set -euo pipefail

# Reuse the self-contained Rust toolchain from /home/cxxy168/code/rust/sand/.toolchain
TOOLCHAIN_ROOT="${MERIDIAN_RUST_TOOLCHAIN:-/home/cxxy168/code/rust/sand/.toolchain}"
export RUSTUP_HOME="${TOOLCHAIN_ROOT}/rustup"
export CARGO_HOME="${TOOLCHAIN_ROOT}/cargo"
export PATH="${CARGO_HOME}/bin:${PATH}"

if [ ! -x "${CARGO_HOME}/bin/cargo" ]; then
  echo "Error: cargo not found at ${CARGO_HOME}/bin/cargo" >&2
  exit 1
fi

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "${ROOT_DIR}/backend"
exec cargo "$@"

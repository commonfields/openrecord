#!/usr/bin/env bash
# Local native desktop: stack via dev-up.sh, then build + run from this checkout.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
export OPENRECORD_API_URL="${OPENRECORD_API_URL:-http://localhost:3001}"

"$ROOT/scripts/dev-up.sh"

cd "$ROOT/apps/desktop"
export CARGO_TARGET_DIR="${CARGO_TARGET_DIR:-$PWD/target}"

osascript -e 'quit app "OpenRecord"' 2>/dev/null || true
pkill -x openrecord-desktop 2>/dev/null || true

if command -v cargo-watch >/dev/null 2>&1; then
  exec cargo watch -x "build -q" -x "run -q"
fi

cargo build
exec cargo run
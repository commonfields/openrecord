#!/usr/bin/env bash
# Local native desktop: stack via dev-up.sh, then build + run from this checkout.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
export OPENRECORD_API_URL="${OPENRECORD_API_URL:-http://localhost:3001}"

"$ROOT/scripts/dev-up.sh"

cd "$ROOT/apps/desktop"
# Reuse ~/openrecord's target when present so rebuilds stay fast (full Rune is slow).
if [[ -z "${CARGO_TARGET_DIR:-}" ]] && [[ -d "$HOME/openrecord/apps/desktop/target" ]]; then
  export CARGO_TARGET_DIR="$HOME/openrecord/apps/desktop/target"
else
  export CARGO_TARGET_DIR="${CARGO_TARGET_DIR:-$PWD/target}"
fi

osascript -e 'quit app "OpenRecord"' 2>/dev/null || true
osascript -e 'quit app "OpenRecord Dev"' 2>/dev/null || true
pkill -x openrecord-desktop 2>/dev/null || true

echo "desktop binary → $CARGO_TARGET_DIR/debug/openrecord-desktop"
echo "(Quit /Applications/OpenRecord.app — it is a separate release build and will not pick up Rust UI edits.)"

if command -v cargo-watch >/dev/null 2>&1; then
  exec cargo watch -x "build -q" -x "run -q"
fi

cargo build
exec cargo run
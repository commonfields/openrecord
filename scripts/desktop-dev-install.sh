#!/usr/bin/env bash
# Build THIS checkout's desktop sources and install a dev app you can open from Finder.
# The release OpenRecord.app in /Applications does not pick up local edits.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
DESKTOP="$ROOT/apps/desktop"
DEV_APP="/Applications/OpenRecord Dev.app"
export OPENRECORD_API_URL="${OPENRECORD_API_URL:-http://localhost:3001}"

"$ROOT/scripts/dev-up.sh"
export CARGO_TARGET_DIR="${CARGO_TARGET_DIR:-$DESKTOP/target}"

echo "Building from: $DESKTOP"
echo "Cargo target:  $CARGO_TARGET_DIR"
cd "$DESKTOP"
./scripts/bundle.sh --debug --no-dmg

osascript -e 'quit app "OpenRecord"' 2>/dev/null || true
osascript -e 'quit app "OpenRecord Dev"' 2>/dev/null || true
pkill -x openrecord-desktop 2>/dev/null || true

rm -rf "$DEV_APP"
ditto "$DESKTOP/dist/OpenRecord.app" "$DEV_APP"
xattr -cr "$DEV_APP" 2>/dev/null || true

# Finder name matches the folder; distinguishes from the release app.
/usr/libexec/PlistBuddy -c "Set :CFBundleName 'OpenRecord Dev'" "$DEV_APP/Contents/Info.plist" 2>/dev/null || true

echo "Installed → $DEV_APP"
echo "Open that app (not OpenRecord.app) to review local UI changes."
open -a "OpenRecord Dev"
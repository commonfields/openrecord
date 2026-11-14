#!/usr/bin/env bash
# Build OpenRecord.app (and a .dmg) from this package.
#
#   scripts/bundle.sh                 # this Mac's architecture
#   scripts/bundle.sh --universal     # Intel + Apple Silicon in one binary
#   scripts/bundle.sh --no-dmg        # skip the disk image
#   scripts/bundle.sh --debug         # dev build: much faster to compile, for local tries
#
# Output lands in apps/desktop/dist/. Signing is optional:
#   MACOS_SIGN_IDENTITY="Developer ID Application: Name (TEAMID)"  signs with
#     the hardened runtime; without it the app is ad-hoc signed, which runs on
#     the Mac that built it but warns on other Macs.
#   APPLE_ID, APPLE_TEAM_ID, APPLE_APP_PASSWORD  also notarize and staple the
#     .dmg (needs MACOS_SIGN_IDENTITY).
set -euo pipefail

cd "$(dirname "$0")/.."

APP_NAME="OpenRecord"
BUNDLE_ID="io.openrecord.desktop"
BIN="openrecord-desktop"
UNIVERSAL=0
DMG=1
PROFILE=release
for arg in "$@"; do
  case "$arg" in
    --universal) UNIVERSAL=1 ;;
    --no-dmg) DMG=0 ;;
    --debug) PROFILE=debug ;;
    -h|--help) sed -n '2,16p' "$0"; exit 0 ;;
    *) echo "unknown option: $arg" >&2; exit 2 ;;
  esac
done

VERSION="$(sed -n 's/^version = "\(.*\)"/\1/p' Cargo.toml | head -1)"
DIST="dist"
APP="$DIST/$APP_NAME.app"

if [[ $UNIVERSAL == 1 ]]; then
  targets=(aarch64-apple-darwin x86_64-apple-darwin)
  rustup target add "${targets[@]}" >/dev/null
  for t in "${targets[@]}"; do cargo build --release --locked --target "$t"; done
  mkdir -p target/universal
  lipo -create -output "target/universal/$BIN" \
    "target/aarch64-apple-darwin/release/$BIN" "target/x86_64-apple-darwin/release/$BIN"
  BUILT="target/universal/$BIN"
else
  if [[ $PROFILE == debug ]]; then cargo build --locked; else cargo build --release --locked; fi
  BUILT="target/$PROFILE/$BIN"
fi

rm -rf "$APP"
mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Resources"
cp "$BUILT" "$APP/Contents/MacOS/$BIN"

# Icon: assets/icon.png (1024px) -> AppIcon.icns
ICONSET="$(mktemp -d)/AppIcon.iconset"
mkdir -p "$ICONSET"
for s in 16 32 128 256 512; do
  sips -z $s $s assets/icon.png --out "$ICONSET/icon_${s}x${s}.png" >/dev/null
  sips -z $((s * 2)) $((s * 2)) assets/icon.png --out "$ICONSET/icon_${s}x${s}@2x.png" >/dev/null
done
iconutil -c icns "$ICONSET" -o "$APP/Contents/Resources/AppIcon.icns"

cat > "$APP/Contents/Info.plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleName</key><string>$APP_NAME</string>
  <key>CFBundleDisplayName</key><string>$APP_NAME</string>
  <key>CFBundleIdentifier</key><string>$BUNDLE_ID</string>
  <key>CFBundleExecutable</key><string>$BIN</string>
  <key>CFBundleIconFile</key><string>AppIcon</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleShortVersionString</key><string>$VERSION</string>
  <key>CFBundleVersion</key><string>$VERSION</string>
  <key>LSMinimumSystemVersion</key><string>11.0</string>
  <key>LSApplicationCategoryType</key><string>public.app-category.business</string>
  <key>CFBundleURLTypes</key><array><dict>
    <key>CFBundleURLName</key><string>io.openrecord.desktop.authorization</string>
    <key>CFBundleURLSchemes</key><array><string>openrecord</string></array>
  </dict></array>
  <key>NSHighResolutionCapable</key><true/>
  <key>NSSupportsAutomaticGraphicsSwitching</key><true/>
</dict>
</plist>
PLIST

if [[ -n "${MACOS_SIGN_IDENTITY:-}" ]]; then
  codesign --force --options runtime --timestamp --sign "$MACOS_SIGN_IDENTITY" "$APP"
else
  codesign --force --sign - "$APP"
fi
codesign --verify --strict "$APP"
echo "built $APP ($VERSION)"

if [[ $DMG == 1 ]]; then
  DMG_PATH="$DIST/$APP_NAME-$VERSION.dmg"
  STAGE="$(mktemp -d)"
  cp -R "$APP" "$STAGE/"
  ln -s /Applications "$STAGE/Applications"
  rm -f "$DMG_PATH"
  hdiutil create -quiet -volname "$APP_NAME" -srcfolder "$STAGE" -ov -format UDZO "$DMG_PATH"
  rm -rf "$STAGE"

  if [[ -n "${MACOS_SIGN_IDENTITY:-}" ]]; then
    codesign --force --timestamp --sign "$MACOS_SIGN_IDENTITY" "$DMG_PATH"
    if [[ -n "${APPLE_ID:-}" && -n "${APPLE_TEAM_ID:-}" && -n "${APPLE_APP_PASSWORD:-}" ]]; then
      xcrun notarytool submit "$DMG_PATH" --wait \
        --apple-id "$APPLE_ID" --team-id "$APPLE_TEAM_ID" --password "$APPLE_APP_PASSWORD"
      xcrun stapler staple "$DMG_PATH"
    fi
  fi
  echo "built $DMG_PATH"
fi

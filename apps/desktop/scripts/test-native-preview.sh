#!/usr/bin/env bash
# Runs real WebKit in an isolated test window. No API, credentials, or network.
set -euo pipefail
cd "$(dirname "$0")/.."
TMP_NATIVE="$(mktemp -d /tmp/openrecord-preview-test.XXXXXX)"
xcrun clang -fobjc-arc -Wno-deprecated-declarations -framework Cocoa -framework WebKit -framework QuartzCore -framework AuthenticationServices native/preview-tests.m -o "$TMP_NATIVE/probe"
# Use the production Rust wrapper, not a separate test implementation.
./target/debug/openrecord-desktop --preview-test-document > "$TMP_NATIVE/probe.html"
"$TMP_NATIVE/probe" "$TMP_NATIVE/probe.html" "$TMP_NATIVE/preview.png"
echo "snapshot: $TMP_NATIVE/preview.png"

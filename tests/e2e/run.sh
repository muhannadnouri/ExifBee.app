#!/bin/sh
# Native desktop E2E (SPEC tier 5, DEC-027). Needs WebKitWebDriver, tauri-driver, xvfb, dbus and
# ExifTool: use `npm run test:e2e:desktop:docker` on distributions that lack them.
set -eu
target="${CARGO_TARGET_DIR:-src-tauri/target}"

for tool in WebKitWebDriver tauri-driver xvfb-run xauth dbus-run-session exiftool; do
  printf '%s: %s\n' "$tool" "$(command -v "$tool" || echo MISSING)"
done

# The test seam must be absent from a normal build, and this check must be able to fail.
npm run -s build:web
cargo build --manifest-path src-tauri/Cargo.toml
if grep -q EXIFBEE_E2E "$target/debug/exifbee"; then
  echo 'a build without the e2e feature contains the test seam' >&2
  exit 1
fi
npx tauri build --debug --no-bundle --features e2e
grep -q EXIFBEE_E2E "$target/debug/exifbee"

# Xvfb has no GPU; without this WebKitGTK can show a blank window.
# Bounded twice over: each step times out, and the whole run stops after 10 minutes.
echo 'starting the native journeys (read, write)'
WEBKIT_DISABLE_DMABUF_RENDERER=1 EXIFBEE_APP="$target/debug/exifbee" exec timeout 600 \
  xvfb-run -a -s '-screen 0 1280x800x24' dbus-run-session -- \
  node --test --test-concurrency=1 --test-timeout=180000 tests/e2e/*.e2e.mjs

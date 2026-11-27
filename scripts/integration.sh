#!/usr/bin/env bash
# Runs test/integration in an isolated VS Code instance (temporary profile, no other extensions).
# Usage: scripts/integration.sh [path-to-vscode-binary]
set -euo pipefail
cd "$(dirname "$0")/.."
MAC_BIN="/Applications/Visual Studio Code.app/Contents/MacOS/Code"
if [ -x "$MAC_BIN" ]; then DEFAULT_BIN="$MAC_BIN"; else DEFAULT_BIN="$(command -v code || true)"; fi
CODE_BIN="${1:-${VSCODE_BIN:-$DEFAULT_BIN}}"
[ -n "$CODE_BIN" ] || { echo "VS Code not found: pass its executable path or set VSCODE_BIN" >&2; exit 1; }
node scripts/build.mjs
node scripts/build.mjs --integration
TMP="$(mktemp -d)"
mkdir -p "$TMP/workspace" "$TMP/user-data/User"
# Keep focus in the editor: chat inputs are textareas, and VS Code sends "undo" to a focused textarea first.
cat > "$TMP/user-data/User/settings.json" <<'JSON'
{
  "chat.disableAIFeatures": true,
  "workbench.secondarySideBar.defaultVisibility": "hidden",
  "workbench.startupEditor": "none",
  "security.workspace.trust.enabled": false
}
JSON
rm -f out-test/integration-results.txt
# A clean environment so the instance doesn't attach to an already running VS Code,
# keeping what a display server needs (e.g. under xvfb-run on Linux).
KEEP=(HOME="$HOME" PATH="$PATH" TMPDIR="${TMPDIR:-/tmp}")
for v in DISPLAY XAUTHORITY WAYLAND_DISPLAY XDG_RUNTIME_DIR DBUS_SESSION_BUS_ADDRESS; do
  if [ -n "${!v:-}" ]; then KEEP+=("$v=${!v}"); fi
done
env -i "${KEEP[@]}" "$CODE_BIN" \
  --extensionDevelopmentPath="$PWD" \
  --extensionTestsPath="$PWD/out-test/integration.js" \
  --user-data-dir="$TMP/user-data" \
  --extensions-dir="$TMP/extensions" \
  --disable-extensions \
  --disable-workspace-trust \
  --skip-welcome \
  --skip-release-notes \
  --new-window \
  "$TMP/workspace" || status=$?
cat out-test/integration-results.txt 2>/dev/null || echo "no results written"
rm -rf "$TMP"
exit "${status:-0}"

#!/usr/bin/env bash
# Idempotent install of doppelganger as a macOS launchd user agent (the launchd counterpart of
# install.sh / systemd). Mirrors install.sh: scaffolds $DOPPELGANGER_HOME/config.json and loads the
# service. Self-update is applied by deploy/start.sh on each (re)start, same model as Linux.
set -euo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
NODE_BIN="$(command -v node)"
NODE_DIR="$(dirname "$NODE_BIN")"
DOPPELGANGER_HOME="${DOPPELGANGER_HOME:-$HOME/.local/share/doppelganger}"
LABEL="com.nilsark.doppelganger"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"

command -v claude >/dev/null || { echo "ERROR: claude CLI missing (install + log in)"; exit 1; }
command -v gws >/dev/null || { echo "ERROR: gws CLI missing (install + gws auth login)"; exit 1; }
command -v git >/dev/null || { echo "ERROR: git missing (xcode-select --install)"; exit 1; }
[ -d "$REPO_DIR/doppelganger/node_modules" ] || (cd "$REPO_DIR/doppelganger" && npm install)

mkdir -p "$HOME/Library/LaunchAgents" "$DOPPELGANGER_HOME"

if [ ! -f "$DOPPELGANGER_HOME/config.json" ]; then
  cp "$REPO_DIR/doppelganger/config.example.json" "$DOPPELGANGER_HOME/config.json"
  echo "Wrote starter config: $DOPPELGANGER_HOME/config.json (edit to set channels, ports, intervals)"
fi

chmod +x "$REPO_DIR/doppelganger/deploy/start.sh" "$REPO_DIR/doppelganger/deploy/update.sh"

sed -e "s|{{REPO_DIR}}|$REPO_DIR|g" \
    -e "s|{{NODE_BIN}}|$NODE_BIN|g" \
    -e "s|{{NODE_DIR}}|$NODE_DIR|g" \
    -e "s|{{DOPPELGANGER_HOME}}|$DOPPELGANGER_HOME|g" \
    "$REPO_DIR/doppelganger/deploy/$LABEL.plist" > "$PLIST"

launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null || true
launchctl bootstrap "gui/$(id -u)" "$PLIST"
launchctl enable "gui/$(id -u)/$LABEL"
launchctl print "gui/$(id -u)/$LABEL" >/dev/null 2>&1 && echo "Loaded $LABEL" || true

echo
echo "Done. Logs: tail -f $DOPPELGANGER_HOME/doppelganger.log"
echo "NOTE: a LaunchAgent runs only while the user is logged in. For a headless Mac mini, enable"
echo "      auto-login (System Settings → Users & Groups), or convert this to a LaunchDaemon."
echo "AUTO-UPDATE: set \"selfUpdateEnabled\": true in $DOPPELGANGER_HOME/config.json to follow the"
echo "             CI-gated 'stable' branch. Rollback: git push -f origin <good-sha>:stable"
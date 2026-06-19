#!/usr/bin/env bash
# Idempotent install of doppelganger as a systemd user unit (prod — on WSL: run `npm run start` in tmux instead).
set -euo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
NODE_BIN="$(command -v node)"
DOPPELGANGER_HOME="${DOPPELGANGER_HOME:-$HOME/.local/share/doppelganger}"
UNIT_DIR="$HOME/.config/systemd/user"

command -v claude >/dev/null || { echo "ERROR: claude CLI missing (install + log in)"; exit 1; }
command -v gws >/dev/null || { echo "ERROR: gws CLI missing (install + gws auth login)"; exit 1; }
command -v jq >/dev/null || { echo "ERROR: jq missing (apt install jq) — entrepreneur uses it to parse gws JSON"; exit 1; }
[ -d "$REPO_DIR/doppelganger/node_modules" ] || (cd "$REPO_DIR/doppelganger" && npm install)

mkdir -p "$UNIT_DIR" "$DOPPELGANGER_HOME"
chmod +x "$REPO_DIR/doppelganger/deploy/update.sh"

# Scaffold the host config file once (defaults < config.json < env). Edit it to turn on channels
# etc.; it lives outside the repo and is the durable place for per-host runtime config.
if [ ! -f "$DOPPELGANGER_HOME/config.json" ]; then
  cp "$REPO_DIR/doppelganger/config.example.json" "$DOPPELGANGER_HOME/config.json"
  echo "Wrote starter config: $DOPPELGANGER_HOME/config.json (edit to set channels, ports, intervals)"
fi

sed -e "s|{{REPO_DIR}}|$REPO_DIR|g" \
    -e "s|{{NODE_BIN}}|$NODE_BIN|g" \
    -e "s|{{DOPPELGANGER_HOME}}|$DOPPELGANGER_HOME|g" \
    "$REPO_DIR/doppelganger/deploy/doppelganger.service" > "$UNIT_DIR/doppelganger.service"

systemctl --user daemon-reload
systemctl --user enable --now doppelganger.service
systemctl --user status doppelganger.service --no-pager || true

echo
echo "Done. Logs: journalctl --user -u doppelganger -f"
echo "NOTE: for the unit to survive logout: loginctl enable-linger $USER"
echo "AUTO-UPDATE: set \"selfUpdateEnabled\": true in $DOPPELGANGER_HOME/config.json to follow the"
echo "             CI-gated 'stable' branch. Rollback: git push -f origin <good-sha>:stable"

#!/usr/bin/env bash
# Apply step for doppelganger self-update. Run by the SERVICE SUPERVISOR *before* the node process
# starts (systemd: ExecStartPre; macOS launchd: deploy/start.sh) — NEVER while a doppelganger process
# is live, so `npm ci` is always safe and there's no restart-vs-update race. Best-effort: a network
# blip must not block startup. Gated by selfUpdateEnabled in $DOPPELGANGER_HOME/config.json.
# Rollback: move `stable` back a commit (e.g. `git push -f origin <good-sha>:stable`).
set -uo pipefail # NB: no -e — every failure path falls through to "start current code" (exit 0).

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
HOME_DIR="${DOPPELGANGER_HOME:-$HOME/.local/share/doppelganger}"
CONFIG="$HOME_DIR/config.json"

# Read a key from config.json using node (always present); fall back to the given default.
read_cfg() {
  node -e "try{const c=require('$CONFIG');const v=c['$1'];process.stdout.write(v===undefined?'$2':String(v))}catch{process.stdout.write('$2')}" 2>/dev/null || printf '%s' "$2"
}

ENABLED="$(read_cfg selfUpdateEnabled false)"
REF="$(read_cfg selfUpdateRef stable)"
[ "$ENABLED" = "true" ] || { echo "[update] self-update disabled — starting current code"; exit 0; }

cd "$REPO_DIR" || exit 0
echo "[update] checking $REF"
git fetch --quiet --tags origin "$REF" || { echo "[update] fetch failed (offline?) — starting current code"; exit 0; }

LOCAL="$(git rev-parse HEAD)"
REMOTE="$(git rev-parse FETCH_HEAD)"
if [ "$LOCAL" = "$REMOTE" ]; then
  echo "[update] already at $REF (${LOCAL:0:7}) — nothing to do"
  exit 0
fi

echo "[update] $REF moved ${LOCAL:0:7} → ${REMOTE:0:7} — applying"
git checkout --quiet --force "$REMOTE" || { echo "[update] checkout failed — starting current code"; exit 0; }
cd "$REPO_DIR/doppelganger" || exit 0
npm ci || echo "[update] npm ci failed — starting anyway (may be unstable; consider rollback)"
echo "[update] applied ${REMOTE:0:7}"

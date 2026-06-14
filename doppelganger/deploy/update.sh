#!/usr/bin/env bash
# Applies a doppelganger self-update: check out the target commit, reinstall deps, restart the unit.
# Launched as a DETACHED transient systemd unit by the runtime (src/selfupdate.ts), so the service
# restart at the end doesn't kill this script mid-flight. Rollback = move `stable` back a commit
# (e.g. `git push -f origin <good-sha>:stable`); the box reverts on its next poll.
set -euo pipefail

TARGET="${1:?usage: update.sh <commit-sha>}"
REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"

cd "$REPO_DIR"
echo "[update] fetching + checking out $TARGET"
git fetch --quiet --tags origin
git checkout --quiet --force "$TARGET"

cd "$REPO_DIR/doppelganger"
echo "[update] npm ci"
npm ci

echo "[update] restarting doppelganger.service"
systemctl --user restart doppelganger.service
echo "[update] done -> $TARGET"

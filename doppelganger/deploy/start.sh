#!/usr/bin/env bash
# launchd entrypoint for macOS (launchd has no ExecStartPre equivalent). Applies any pending
# self-update, then exec's the runtime so node becomes the supervised process launchd keeps alive.
set -uo pipefail
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)" # doppelganger/deploy
"$DIR/update.sh" || true                            # best-effort; never block startup
cd "$DIR/.."                                         # doppelganger/
exec "${NODE_BIN:-node}" src/index.ts

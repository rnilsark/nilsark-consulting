# Deploy

Doppelgänger runs as a single long-lived process (dispatcher + scheduler + web dashboard).
`install.sh` installs it as a **systemd user unit**; `install-macos.sh` uses launchd. Runtime
config lives in `$DOPPELGANGER_HOME/config.json` (outside the repo) — see `config.example.json`.

```bash
deploy/install.sh                       # systemd user unit (Linux / Raspberry Pi)
journalctl --user -u doppelganger -f    # logs
systemctl --user restart doppelganger   # restart (also runs the self-update apply step)
loginctl enable-linger "$USER"          # keep the unit running after logout
```

## Remote access over Tailscale

The dashboard binds to **loopback only by default** (`webHost: 127.0.0.1`) so it is never exposed
on the LAN. Pick one way to reach it remotely.

### Option A — `tailscale serve` (recommended)

Keep the app on loopback and let Tailscale reverse-proxy it over the tailnet (HTTPS, MagicDNS name,
no extra port). Requires MagicDNS + HTTPS certificates enabled in the tailnet admin console.

```bash
sudo tailscale serve --bg <webPort>     # e.g. 4317; proxies https://<host>.<tailnet>.ts.net → it
sudo tailscale serve status
```

Then browse to `https://<host>.<tailnet>.ts.net/` from any tailnet device.

### Option B — bind to the Tailscale interface

Set `webHost` to the node's tailnet IP (`tailscale ip -4`, a `100.x.y.z` address) in `config.json`:

```json
{ "webHost": "100.x.y.z", "webPort": 4317 }
```

Browse to `http://<host>:<webPort>/` (MagicDNS short name) or `http://100.x.y.z:<webPort>/`.

> **Startup ordering caveat:** if you bind to the tailnet IP, the service must not start before
> `tailscale0` has an address, or the bind fails. Gate startup with an `ExecStartPre` that waits for
> the interface, e.g.:
> ```ini
> ExecStartPre=-/usr/bin/bash -c 'for i in $(seq 1 60); do ip -4 addr show tailscale0 2>/dev/null | grep -q "inet 100\." && exit 0; sleep 1; done'
> ```
> Option A avoids this entirely (the app stays on loopback).

Do **not** set `webHost: "0.0.0.0"` to "make it work" — that re-exposes the dashboard to the whole
LAN, defeating the loopback default.

## Self-update

When `selfUpdateEnabled: true`, the supervisor runs `deploy/update.sh` **before** each start
(systemd `ExecStartPre`; launchd via `start.sh`) — never while a process is live, so `npm ci` is
safe and there is no update-vs-restart race. It fetches the ref named by `selfUpdateRef` (default
`stable`) and, if it moved, force-checks-out and reinstalls. A network failure falls through to
"start current code" — an offline box never wedges.

**Push to `main` is the deploy.** CI (`.github/workflows/release.yml`) runs typecheck + tests on
every push touching `doppelganger/**` and, if green, force-advances `stable` to that commit — which
the box then self-updates to. A version tag (`YYYY.N`) is cut only when the commit body contains a
line that is exactly `[release]`; that's the only "deliberate" step — version numbers, not the deploy.

```bash
systemctl --user restart doppelganger   # apply now instead of waiting for the next poll
git push -f origin <good-sha>:stable     # roll back by moving stable to an earlier good commit
```

> **The deploy scripts must stay executable in git (`100755`).** `update.sh` does a
> `git checkout --force`, so any non-executable mode recorded in the repo is restored on every
> update — and a non-executable `update.sh` makes the supervisor silently skip self-update
> (`ExecStartPre` is prefixed `-`, so the failure is swallowed). After adding a script, confirm:
> ```bash
> git ls-files -s deploy/*.sh        # expect mode 100755
> git update-index --chmod=+x deploy/<script>.sh   # fix if it shows 100644
> ```
> This bites on filesystems that don't track the exec bit (e.g. Windows/WSL drvfs mounts).

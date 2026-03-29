---
description: "Authenticate with Google Workspace. Run when gws commands fail with auth errors, or on a new machine. Detects WSL2/Mac and opens the OAuth URL automatically."
allowed-tools: ["Bash"]
---

# GWS Authentication

You are authenticating the gws CLI with Google Workspace for NILSARK CONSULTING AB.

## Step 1 — Check if Already Authenticated

Run a quick test to see if auth is still valid:
```bash
gws gmail users getProfile --params '{"userId": "me"}' --format json 2>&1
```

If this succeeds (returns a JSON object with an `emailAddress` field), tell the user:
> GWS is already authenticated as `<emailAddress>`. No action needed.

Then stop.

## Step 2 — Start Auth Login

Run `gws auth login` in the background and capture its output:
```bash
gws auth login > /tmp/gws-auth-output.txt 2>&1 &
GWS_AUTH_PID=$!
```

Wait up to 5 seconds for the URL to appear:
```bash
for i in $(seq 1 10); do
  sleep 0.5
  AUTH_URL=$(grep -o 'https://[^ ]*' /tmp/gws-auth-output.txt 2>/dev/null | head -1)
  [ -n "$AUTH_URL" ] && break
done
```

If no URL was found after 5 seconds, check if the process has already exited successfully (auth may have completed instantly if credentials were cached elsewhere):
```bash
cat /tmp/gws-auth-output.txt
```
Report the output to the user and proceed to Step 4 to verify.

## Step 3 — Open the URL in Browser

With `AUTH_URL` extracted, detect the environment and open the URL:

```bash
if grep -qi microsoft /proc/version 2>/dev/null; then
  # WSL2 — open in Windows browser
  explorer.exe "$AUTH_URL"
else
  # Mac / native Linux
  open "$AUTH_URL" 2>/dev/null || xdg-open "$AUTH_URL" 2>/dev/null || true
fi
```

Tell the user:
> Opening the Google OAuth page in your browser. Please sign in and click **Allow** to grant access.
>
> If the browser did not open, copy this URL manually:
> `<AUTH_URL>`

Ask the user to confirm when they have approved access in the browser.

## Step 4 — Wait for Auth to Complete

After the user confirms, wait for the background process to finish (up to 30 seconds):
```bash
for i in $(seq 1 30); do
  sleep 1
  kill -0 $GWS_AUTH_PID 2>/dev/null || break
done
# Ensure process is done
wait $GWS_AUTH_PID 2>/dev/null || true
```

## Step 5 — Verify Auth

Run a verification call:
```bash
gws gmail users getProfile --params '{"userId": "me"}' --format json 2>&1
```

If it returns an `emailAddress`, report success:
> GWS authenticated successfully as `<emailAddress>`.

If it fails, report the error output and tell the user:
> Authentication did not complete. Try running `gws auth login` manually in the terminal. See docs/setup.md for WSL2 troubleshooting.

# Setup Guide — New Machine Onboarding

This plugin system runs in **WSL2 on Windows** (or natively on Mac) using the Claude Code CLI.

---

## 1. Install Prerequisites

### Claude Code

```bash
npm install -g @anthropic-ai/claude-code
```

Verify: `claude --version`

### gws CLI (Google Workspace)

```bash
npm install -g @googleworkspace/cli
```

Verify: `gws --version`

### git

```bash
# WSL2 (Ubuntu)
sudo apt install git

# Mac
brew install git
```

---

## 2. Clone the Repo

```bash
# Windows (WSL2)
git clone <repo-url> /mnt/c/dev/nilsark-consulting

# Mac
git clone <repo-url> ~/dev/nilsark-consulting
```

---

## 3. Authenticate gws

```bash
gws auth login
```

Opens a browser for Google OAuth. Credentials stored in `~/.gws/` — persists across sessions. **Must re-run on each new machine.**

Verify:
```bash
gws gmail +triage --max 5
```

---

## 4. Create Your Config File

```bash
# Windows (WSL2)
cp /mnt/c/dev/nilsark-consulting/config.template.md ~/.nilsark-config.md

# Mac
cp ~/dev/nilsark-consulting/config.template.md ~/.nilsark-config.md
```

Edit `~/.nilsark-config.md` and fill in your values.

### Finding your DRIVE_ROOT_FOLDER_ID

1. Open Google Drive in your browser
2. Navigate to your accounting root folder (the one containing `2026-03/`, `2026-02/`, etc.)
3. Look at the URL: `https://drive.google.com/drive/folders/1aBcDeFgHiJkLmNoPqRsTuVwXyZ`
4. The ID is the last segment: `1aBcDeFgHiJkLmNoPqRsTuVwXyZ`

### Setting STAGING_DIR

Create the staging folder then set the path in config:

```bash
mkdir -p ~/Desktop/nilsark-staging
# Set: STAGING_DIR=/home/YourName/Desktop/nilsark-staging
```

Or put it somewhere under your Windows user profile (accessible from both WSL2 and Windows Explorer):
```bash
mkdir -p /mnt/c/Users/YourWindowsName/.nilsark
mkdir -p /mnt/c/Users/YourWindowsName/.nilsark/drop
# Set: STAGING_DIR=/mnt/c/Users/YourWindowsName/.nilsark
```

The `drop/` subfolder is your receipt inbox — drag PDFs and images here and they will be picked up automatically on the next `/fetch-classify` run.

---

## 5. Register Plugins Permanently

Register the local repo as a plugin marketplace, then install both plugins:

**Windows (WSL2):**
```bash
claude plugin marketplace add /mnt/c/dev/nilsark-consulting
claude plugin install swedish-invoice-tools
claude plugin install nilsark
```

**Mac:**
```bash
claude plugin marketplace add ~/dev/nilsark-consulting
claude plugin install swedish-invoice-tools
claude plugin install nilsark
```

After installing, just run `claude` — no flags needed. Type `/help` to verify both plugins appear.

---

## Troubleshooting

### `gws: command not found`
Run `npm install -g @googleworkspace/cli` again. Check that your npm global bin is in your PATH.

### `gws auth login` doesn't open a browser (WSL2)
Run `explorer.exe "$(gws auth login 2>&1 | grep https)"` to open the auth URL in Windows browser. Or copy-paste the URL manually.

### Drive folder not found
Double-check `DRIVE_ROOT_FOLDER_ID` in `~/.nilsark-config.md`. It must be the folder that directly contains the `YYYY-MM` month subfolders.

### PDF not readable
Claude reads PDFs natively. Password-protected or corrupted PDFs will be marked `unknown` and flagged for manual review.

### Bank CSV format changed
SEB occasionally updates their export format. Check the first row of your CSV against the expected columns in [state-schema.md](state-schema.md).

# Setup Guide — New Machine Onboarding

This plugin system runs in **WSL2 on Windows** (or natively on Mac) using the Claude Code CLI.

---

## 1. Install Prerequisites

### Claude Code

```bash
npm install -g @anthropic-ai/claude-code
```

Verify: `cc --version`

### gws CLI (Google Workspace plugin)

```bash
claude plugin marketplace add https://github.com/WadeWarren/gws-claude-plugin
claude plugin install gws
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

Or put it on your Windows Desktop (accessible from both WSL2 and Windows Explorer):
```bash
mkdir -p /mnt/c/Users/YourWindowsName/Desktop/nilsark-staging
# Set: STAGING_DIR=/mnt/c/Users/YourWindowsName/Desktop/nilsark-staging
```

---

## 5. Load the Plugins

```bash
# Windows (WSL2)
cc \
  --plugin-dir /mnt/c/dev/nilsark-consulting/swedish-invoice-tools \
  --plugin-dir /mnt/c/dev/nilsark-consulting/nilsark

# Mac
cc \
  --plugin-dir ~/dev/nilsark-consulting/swedish-invoice-tools \
  --plugin-dir ~/dev/nilsark-consulting/nilsark
```

Type `/help` to verify both plugins appear.

---

## Troubleshooting

### `gws: command not found`
Try `claude plugin install gws` again. Check that `~/.claude/bin/` is in your PATH.

### `gws auth login` doesn't open a browser (WSL2)
Run `explorer.exe "$(gws auth login 2>&1 | grep https)"` to open the auth URL in Windows browser. Or copy-paste the URL manually.

### Drive folder not found
Double-check `DRIVE_ROOT_FOLDER_ID` in `~/.nilsark-config.md`. It must be the folder that directly contains the `YYYY-MM` month subfolders.

### PDF not readable
Claude reads PDFs natively. Password-protected or corrupted PDFs will be marked `unknown` and flagged for manual review.

### Bank CSV format changed
SEB occasionally updates their export format. Check the first row of your CSV against the expected columns in [state-schema.md](state-schema.md).

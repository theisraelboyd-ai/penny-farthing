# Pushing Penny Farthing to GitHub from Linux Mint

*A step-by-step walkthrough for setting up Git, connecting to GitHub via SSH, and deploying to GitHub Pages.*

This document assumes you have Linux Mint Cinnamon, a GitHub account, and nothing else. Copy and paste the commands one block at a time — read the text between them so you know what's happening.

---

## Part 1 — Install and configure Git

### 1. Install Git

Open **Terminal** (keyboard shortcut: `Ctrl + Alt + T`).

```bash
sudo apt update
sudo apt install git -y
```

Enter your password when prompted. Git is tiny; this takes seconds.

Verify it installed:

```bash
git --version
```

You should see something like `git version 2.43.0` (the exact version doesn't matter, just that it responds).

### 2. Tell Git who you are

Git tags every commit with a name and email. Use the email associated with your GitHub account so GitHub properly credits your commits.

```bash
git config --global user.name "Your Name"
git config --global user.email "your-email@example.com"
```

Also set a sensible default for the initial branch name and pull behaviour — this removes some annoying first-time warnings:

```bash
git config --global init.defaultBranch main
git config --global pull.rebase false
```

---

## Part 2 — Connect to GitHub via SSH

SSH is more convenient than HTTPS for repeated pushes because you don't have to type credentials every time. You generate a key pair on your machine, give GitHub the public half, and from then on things just work.

### 3. Generate an SSH key

```bash
ssh-keygen -t ed25519 -C "your-email@example.com"
```

When prompted:

- **File to save the key**: Just press **Enter** to accept the default (`~/.ssh/id_ed25519`).
- **Passphrase**: You can leave it empty (just press Enter twice) for convenience, or set one for extra security. If you set one, Linux Mint's keyring will cache it so you only type it occasionally.

### 4. Start the SSH agent and load the key

```bash
eval "$(ssh-agent -s)"
ssh-add ~/.ssh/id_ed25519
```

The first command starts the agent and prints something like `Agent pid 1234`. The second adds your key to it.

### 5. Copy the public key to your clipboard

```bash
cat ~/.ssh/id_ed25519.pub
```

This prints your public key — a long single line starting with `ssh-ed25519` and ending with your email. **Select the entire line with your mouse** and copy it (right-click → Copy, or Ctrl+Shift+C in Terminal).

> Alternatively, if you have `xclip` installed, `xclip -sel clip < ~/.ssh/id_ed25519.pub` copies it directly. On a fresh Mint install this isn't available — just use the mouse.

### 6. Add the key to GitHub

1. Open [github.com](https://github.com) in your browser and sign in.
2. Click your profile picture (top-right) → **Settings**.
3. In the left sidebar: **SSH and GPG keys**.
4. Click **New SSH key** (green button, top right).
5. Fill in:
   - **Title**: `Linux Mint laptop` (or whatever helps you identify it later)
   - **Key type**: Authentication Key
   - **Key**: paste the whole line you copied from the terminal
6. Click **Add SSH key**. GitHub may ask you to confirm with your password.

### 7. Test the connection

```bash
ssh -T git@github.com
```

You'll see a warning about the authenticity of the host — type `yes` and press Enter. Then you should see:

```
Hi YOUR_USERNAME! You've successfully authenticated, but GitHub does not provide shell access.
```

That "but GitHub does not provide shell access" bit is expected. It confirms the handshake worked.

---

## Part 3 — Create the GitHub repo

Do this in your browser, not the terminal.

1. Go to [github.com/new](https://github.com/new).
2. **Repository name**: `penny-farthing`
3. **Description** (optional): `UK CGT-aware investment tracker`
4. **Public**.
5. **Do NOT** tick "Add a README", "Add .gitignore", or "Add a license". We want an empty repo because we already have these files locally.
6. Click **Create repository**.

GitHub will show you a page with "Quick setup" instructions. Ignore them — we're going to do our own. Note your repository URL: it'll be `git@github.com:YOUR_USERNAME/penny-farthing.git`.

---

## Part 4 — Push the project

Assuming you've extracted `penny-farthing.zip` to, say, your home directory:

```bash
cd ~/penny-farthing
```

(Replace `~/penny-farthing` with wherever you put it — if the zip extracted to `~/Downloads/penny-farthing`, use that path instead.)

### 8. Initialise and commit

```bash
git init
git add .
git commit -m "Day 1 scaffold"
```

The last command will print a summary of the 28 files committed.

### 9. Link to GitHub and push

Replace `YOUR_USERNAME` with your actual GitHub username in the command below:

```bash
git branch -M main
git remote add origin git@github.com:YOUR_USERNAME/penny-farthing.git
git push -u origin main
```

You should see the objects being written, and a final line like `* [new branch] main -> main`. Refresh the GitHub repo page — all your files will be there.

---

## Part 5 — Enable GitHub Pages

1. On the repo page, click **Settings** (top-right tab).
2. In the left sidebar: **Pages** (under "Code and automation").
3. Under **Build and deployment**:
   - **Source**: Deploy from a branch
   - **Branch**: `main` — folder: `/ (root)` — click **Save**
4. Wait 30–90 seconds. Refresh the page.

GitHub will display: **Your site is live at `https://YOUR_USERNAME.github.io/penny-farthing/`**

Click it. The app should load exactly as it does locally, but now on HTTPS — which unlocks the "Install" option when you open it on your phone.

---

## Part 6 — Installing it on your phone

1. Open the GitHub Pages URL on your phone's browser (Chrome or Safari).
2. In Chrome: menu (three dots) → **Install app** or **Add to Home Screen**.
   In Safari: share icon → **Add to Home Screen**.
3. The Penny Farthing icon appears on your home screen. Tap it — it launches like a native app, fullscreen, with offline support.

---

## Making changes later

From then on, whenever you want to update the app:

```bash
cd ~/penny-farthing
# make your edits ...
git add .
git commit -m "describe what changed"
git push
```

GitHub Pages re-deploys automatically within a minute. Your phone will pick up the new version the next time you launch it (the service worker handles updates gracefully).

---

## Troubleshooting

**"Permission denied (publickey)" when pushing**
→ The SSH key isn't loaded. Run `ssh-add ~/.ssh/id_ed25519` again. If that doesn't help, re-run `ssh -T git@github.com` and confirm it says "Hi YOUR_USERNAME".

**"remote origin already exists"**
→ You've run `git remote add origin ...` twice. Use `git remote set-url origin git@github.com:YOUR_USERNAME/penny-farthing.git` instead.

**GitHub Pages URL shows 404**
→ Give it another minute; initial deployment sometimes lags. Also confirm the branch is set to `main` and the folder is `/ (root)` in Pages settings.

**Phone shows old cached version after an update**
→ Open the installed app, pull down to refresh if it's an online page, or force-quit and reopen. If it persists, open it in Chrome first (not the installed app), hard-refresh there (Ctrl+Shift+R on desktop, menu → history → clear browsing data on phone), then reopen the installed app.

---

*Penny Farthing is watching.*

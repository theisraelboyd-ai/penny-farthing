# Getting a GitHub Personal Access Token for Gist Sync

Penny Farthing uses a **private GitHub Gist** as its cloud backup. It's free, stays in your own GitHub account, and syncs across devices. All you need is a token with `gist` scope — nothing else.

## Step-by-step

### 1. Log in to GitHub

Go to [github.com](https://github.com) and sign in.

### 2. Open the token settings

Click your profile picture (top-right) → **Settings**.

In the left sidebar, scroll to the bottom and click:

**Developer settings** → **Personal access tokens** → **Tokens (classic)**

> If you see "Fine-grained tokens" instead, you can use that page too — the fine-grained option is arguably cleaner, but requires extra setup. The classic flow below works fine.

### 3. Generate a new token

Click **Generate new token (classic)**. GitHub may ask you to confirm your password.

Fill in:

| Field       | Value                                     |
|-------------|-------------------------------------------|
| **Note**    | `Penny Farthing sync`              |
| **Expiration** | `No expiration` (or 1 year if you prefer)|
| **Scopes**  | ✅ Tick **only** the `gist` box           |

**Do not tick anything else.** This token only needs to read and write Gists. Giving it more access is a security risk.

Scroll down and click **Generate token**.

### 4. Copy the token immediately

GitHub will show you a string that starts with `ghp_`. **This is the only time you'll see it.** If you close the page without copying it, you'll have to generate a new one.

Copy the whole string.

### 5. Paste it into Penny Farthing

Open the app → **Study** (bottom-right nav) → **Connections** → paste into the **GitHub Personal Access Token** field → click **Save connections**.

### 6. First sync

*(Coming in Day 2)* — the app will create a new private Gist on first sync and save the Gist ID for you. Subsequent syncs update that same Gist.

---

## Revoking the token later

If you ever want to stop sync (or rotate the token), go back to the same Tokens page, find the one named "Penny Farthing sync", and click **Delete**. The app will fail to sync from that point — your local data is unaffected.

## Security notes

- The token is stored **only in your browser's IndexedDB**, never uploaded anywhere except directly to `api.github.com` when syncing.
- If you're publishing this app on GitHub Pages under a public repo, the token is still safe — it lives in the user's browser, not in the code.
- **Never paste this token into a GitHub issue, a chat, or any other public place.** Treat it like a password.

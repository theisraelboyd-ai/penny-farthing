/* Sync status banner — appears above main content on every page.
 *
 * Three states:
 *   - hidden (no changes since last sync, or sync never set up)
 *   - pulse (unsynced changes present)
 *   - syncing (in-flight)
 *
 * Click → routes to Settings → Sync, or triggers a sync write if connected.
 */

import { el } from './ui.js';
import { getSyncState, onSyncDirtyChange, markSynced } from './app-state.js';
import { exportAllData } from './sync.js';

let bannerEl = null;
let unsubscribe = null;

/**
 * Mount the banner inside the given parent (typically <main>).
 * Self-updates on dirty-state changes.
 */
export async function mountSyncBanner(parentEl) {
  if (bannerEl) bannerEl.remove();
  if (unsubscribe) unsubscribe();

  bannerEl = el('div', {
    id: 'sync-banner',
    class: 'sync-banner',
    style: { display: 'none' },
  });
  parentEl.prepend(bannerEl);

  await refresh();
  unsubscribe = onSyncDirtyChange(refresh);
}

async function refresh() {
  if (!bannerEl) return;
  const state = await getSyncState();
  bannerEl.innerHTML = '';

  if (!state.isDirty) {
    bannerEl.style.display = 'none';
    return;
  }

  // Dirty — show the pulse banner
  bannerEl.style.display = 'flex';
  const message = state.lastSyncedAt
    ? `Unsynced changes since ${formatRelative(state.lastSyncedAt)}.`
    : 'You have unsynced changes.';

  bannerEl.append(
    el('div', { class: 'sync-banner__icon' }, '●'),
    el('div', { class: 'sync-banner__text' }, message),
    el('button', {
      class: 'sync-banner__action',
      onclick: handleSyncClick,
    }, 'Sync now →'),
  );
}

async function handleSyncClick(e) {
  e.preventDefault();
  // Route to Settings with a focus param so the page scrolls to the sync
  // section. Hash-fragments within hash routes don't work cleanly, so we
  // use a query parameter that the settings view handles.
  location.hash = '#/settings?focus=sync';
}

/**
 * Trigger a one-shot sync if the user has previously connected a local
 * file. Returns { ok, reason } so the caller can show appropriate feedback.
 * (Reserved for future when local-file-sync is wired up. For now: just
 * download the JSON.)
 */
export async function performQuickSync() {
  try {
    const json = await exportAllData();
    // Trigger a download with a timestamp filename
    const blob = new Blob([JSON.stringify(json, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    const ts = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');
    a.href = url;
    a.download = `penny-farthing-backup-${ts}.json`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
    await markSynced();
    return { ok: true };
  } catch (err) {
    return { ok: false, reason: err.message };
  }
}

function formatRelative(iso) {
  const then = new Date(iso).getTime();
  const now = Date.now();
  const seconds = Math.floor((now - then) / 1000);
  if (seconds < 60) return 'a moment ago';
  if (seconds < 3600) return `${Math.floor(seconds / 60)} min ago`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)} hr ago`;
  const days = Math.floor(seconds / 86400);
  if (days < 30) return `${days} day${days === 1 ? '' : 's'} ago`;
  return new Date(iso).toLocaleDateString();
}

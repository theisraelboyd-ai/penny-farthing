/* Penny Farthing — App entry
 *
 * Wires the router, registers the service worker, sets up theme toggle.
 */

import { registerRoute, start } from './router.js';
import { renderDashboard } from './views/dashboard.js';
import { renderHoldings } from './views/holdings.js';
import { renderTransactions } from './views/transactions.js';
import { renderAddTransaction } from './views/add-transaction.js';
import { renderClosedPosition } from './views/closed-position.js';
import { renderSettings } from './views/settings.js';
import { renderTax } from './views/tax.js';
import { renderImport } from './views/import.js';
import { renderPrint } from './views/print.js';
import { renderDevRepairFx } from './views/dev-repair-fx.js';
import { get, put } from './storage/indexeddb.js';

/* ============================================================
   Routes
   ============================================================ */

/* ============================================================
   Theme
   ============================================================ */

async function initTheme() {
  const settings = await get('settings', 'main');
  const saved = settings?.theme;
  const prefersDark = window.matchMedia('(prefers-color-scheme: dark)').matches;
  const theme = saved || (prefersDark ? 'dark' : 'light');
  document.documentElement.dataset.theme = theme;

  document.getElementById('theme-toggle').addEventListener('click', async () => {
    const current = document.documentElement.dataset.theme;
    const next = current === 'dark' ? 'light' : 'dark';
    document.documentElement.dataset.theme = next;
    const s = (await get('settings', 'main')) || { id: 'main', createdAt: new Date().toISOString() };
    s.theme = next;
    await put('settings', s);
  });
}

/* ============================================================
   Privacy mode

   Toggles a `data-privacy` attribute on <html>. Read synchronously
   from localStorage so the blur applies before first paint —
   prevents the brief "values visible then hidden" flash on reload.
   Persisted in both localStorage (for synchronous boot read) and
   the settings IndexedDB record (for backup portability).
   ============================================================ */

const PRIVACY_KEY = 'penny-farthing-privacy';

function applyPrivacyToDom(on) {
  if (on) {
    document.documentElement.dataset.privacy = 'on';
  } else {
    delete document.documentElement.dataset.privacy;
  }
}

// Apply synchronously at module load — must run before any view renders
applyPrivacyToDom(localStorage.getItem(PRIVACY_KEY) === '1');

function initPrivacyToggle() {
  const btn = document.getElementById('privacy-toggle');
  if (!btn) return;
  const refresh = () => {
    const on = document.documentElement.dataset.privacy === 'on';
    btn.setAttribute('aria-pressed', on ? 'true' : 'false');
    btn.title = on ? 'Privacy mode on — click to show values' : 'Hide values';
  };
  refresh();
  btn.addEventListener('click', async () => {
    const wasOn = document.documentElement.dataset.privacy === 'on';
    const nowOn = !wasOn;
    applyPrivacyToDom(nowOn);
    try {
      localStorage.setItem(PRIVACY_KEY, nowOn ? '1' : '0');
    } catch { /* private mode might block — fail open */ }
    // Best-effort persist to settings; not fatal if it fails
    try {
      const s = (await get('settings', 'main')) || { id: 'main' };
      s.privacyMode = nowOn;
      await put('settings', s);
    } catch { /* ignore */ }
    refresh();
  });
}

/* ============================================================
   Service Worker
   ============================================================ */

function registerSw() {
  if (!('serviceWorker' in navigator)) return;
  // Only register when served over http(s), not file://
  if (location.protocol === 'file:') return;

  window.addEventListener('load', () => {
    navigator.serviceWorker.register('./sw.js').catch((err) => {
      console.warn('SW registration failed:', err);
    });
  });
}

/* ============================================================
   Bootstrap
   ============================================================ */

registerRoute('/dashboard',     renderDashboard);
registerRoute('/holdings',      renderHoldings);
registerRoute('/transactions',  renderTransactions);
registerRoute('/add',           renderAddTransaction);
registerRoute('/closed',        renderClosedPosition);
registerRoute('/import',        renderImport);
registerRoute('/tax',           renderTax);
registerRoute('/print',         renderPrint);
// Hidden dev route — accessible only by typing the URL fragment.
// Not in any nav. Used for one-time surgical repairs to user data
// (e.g. /dev/repair-fx fixes the fxRate=1 silent-default bug).
registerRoute('/dev/repair-fx', renderDevRepairFx);
registerRoute('/settings',      renderSettings);

initTheme();
initPrivacyToggle();
registerSw();

const mount = document.getElementById('app');
start(mount);

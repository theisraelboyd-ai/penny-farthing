/* Penny Farthing — App entry
 *
 * Wires the router, registers the service worker, sets up theme toggle,
 * privacy mode, and the dirty-state sync banner.
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
import { get, put, setMutationHook } from './storage/indexeddb.js';
import {
  markDirty, applyPrivacyToDom, readPrivacySync, setPrivacyMode, isPrivacyOn,
} from './app-state.js';
import { mountSyncBanner } from './sync-banner.js';

// Apply privacy mode synchronously BEFORE any view renders, to prevent
// the brief flash-of-visible-values when a user reloads with privacy on.
applyPrivacyToDom(readPrivacySync());

// Hook the data layer to mark dirty on every mutation.
setMutationHook(markDirty);

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
   Privacy toggle (in masthead)
   ============================================================ */

function initPrivacyToggle() {
  const btn = document.getElementById('privacy-toggle');
  if (!btn) return;
  // Sync UI to current state
  const refresh = () => {
    const on = isPrivacyOn();
    btn.setAttribute('aria-pressed', on ? 'true' : 'false');
    btn.title = on ? 'Privacy mode on — click to show values' : 'Hide values';
  };
  refresh();
  btn.addEventListener('click', async () => {
    await setPrivacyMode(!isPrivacyOn());
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
registerRoute('/settings',      renderSettings);

initTheme();
initPrivacyToggle();
registerSw();

const mount = document.getElementById('app');
const bannerZone = document.getElementById('banner-zone');
mountSyncBanner(bannerZone);
start(mount);

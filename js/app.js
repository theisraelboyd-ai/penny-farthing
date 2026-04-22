/* Penny Farthing — App entry
 *
 * Wires the router, registers the service worker, sets up theme toggle.
 */

import { registerRoute, start } from './router.js';
import { renderDashboard } from './views/dashboard.js';
import { renderHoldings } from './views/holdings.js';
import { renderTransactions } from './views/transactions.js';
import { renderAddTransaction } from './views/add-transaction.js';
import { renderSettings } from './views/settings.js';
import { renderTax } from './views/tax.js';
import { renderImport } from './views/import.js';
import { get, put } from './storage/indexeddb.js';

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
registerRoute('/import',        renderImport);
registerRoute('/tax',           renderTax);
registerRoute('/settings',      renderSettings);

initTheme();
registerSw();

const mount = document.getElementById('app');
start(mount);

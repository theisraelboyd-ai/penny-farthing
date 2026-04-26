/* Penny Farthing — Service Worker
 * Offline-first cache strategy. On install, cache the shell.
 * On fetch, try cache first for shell files, network first for API calls.
 */

const CACHE_NAME = 'penny-farthing-v29';
const SHELL = [
  './',
  './index.html',
  './manifest.json',
  './css/theme.css',
  './css/layout.css',
  './css/print.css',
  './js/app.js',
  './js/router.js',
  './js/ui.js',
  './js/storage/indexeddb.js',
  './js/storage/schema.js',
  './js/assets/registry.js',
  './js/assets/equity.js',
  './js/assets/etf.js',
  './js/assets/gold-physical.js',
  './js/assets/crypto.js',
  './js/assets/bond.js',
  './js/views/dashboard.js',
  './js/views/holdings.js',
  './js/views/transactions.js',
  './js/views/add-transaction.js',
  './js/views/closed-position.js',
  './js/views/import.js',
  './js/views/tax.js',
  './js/views/print.js',
  './js/views/dev-repair-fx.js',
  './js/views/settings.js',
  './js/engine/pool.js',
  './js/engine/portfolio.js',
  './js/engine/fx.js',
  './js/engine/prices.js',
  './js/engine/sell-now.js',
  './js/visual/glyphs.js',
  './js/visual/asset-picker.js',
  './js/importers/csv.js',
  './js/importers/ibkr.js'
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(SHELL))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k)))
    ).then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);

  // Never cache API calls (prices, FX, Gist)
  if (url.hostname.includes('finnhub') || url.hostname.includes('frankfurter')
      || url.hostname.includes('api.github.com')) {
    return; // let the network handle it
  }

  // Cache-first for shell
  event.respondWith(
    caches.match(event.request).then((cached) => cached || fetch(event.request))
  );
});

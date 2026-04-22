/* Penny Farthing — Router
 * Simple hash-based router, no dependencies.
 */

const routes = new Map();

export function registerRoute(path, handler) {
  routes.set(path, handler);
}

export function navigate(path) {
  location.hash = path.startsWith('#') ? path : '#' + path;
}

export function currentPath() {
  const hash = location.hash || '#/dashboard';
  return hash.startsWith('#') ? hash.slice(1) : hash;
}

export function start(mount) {
  const run = () => {
    const path = currentPath();
    let [base] = path.split('?');
    let handler = routes.get(base);
    if (!handler) {
      base = '/dashboard';
      handler = routes.get(base);
    }
    mount.innerHTML = '';
    if (handler) handler(mount, parseQuery(path));
    updateDockActive(base);
  };
  window.addEventListener('hashchange', run);
  run();
}

function parseQuery(path) {
  const qIdx = path.indexOf('?');
  if (qIdx < 0) return {};
  const params = new URLSearchParams(path.slice(qIdx + 1));
  return Object.fromEntries(params);
}

function updateDockActive(path) {
  document.querySelectorAll('.dock__item').forEach((item) => {
    const view = item.dataset.view;
    const match = path === `/${view}`;
    item.classList.toggle('is-active', match);
  });
}

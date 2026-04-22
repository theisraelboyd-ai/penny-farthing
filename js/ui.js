/* Penny Farthing — UI Helpers */

export function el(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'class') node.className = v;
    else if (k === 'style' && typeof v === 'object') Object.assign(node.style, v);
    else if (k.startsWith('on') && typeof v === 'function') node.addEventListener(k.slice(2).toLowerCase(), v);
    else if (k === 'html') node.innerHTML = v;
    else if (v === true) node.setAttribute(k, '');
    else if (v !== false && v != null) node.setAttribute(k, v);
  }
  for (const child of children.flat()) {
    if (child == null || child === false) continue;
    node.append(child instanceof Node ? child : document.createTextNode(child));
  }
  return node;
}

export function clear(container) {
  while (container.firstChild) container.removeChild(container.firstChild);
}

let toastTimer = null;
export function toast(message, { error = false, duration = 2800 } = {}) {
  const t = document.getElementById('toast');
  if (!t) return;
  t.textContent = message;
  t.classList.toggle('is-error', error);
  t.classList.add('is-showing');
  if (toastTimer) clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove('is-showing'), duration);
}

/* ============================================================
   Formatting
   ============================================================ */

export function formatCurrency(amount, currency = 'GBP', { signed = false } = {}) {
  if (amount == null || Number.isNaN(amount)) return '—';
  const fmt = new Intl.NumberFormat('en-GB', {
    style: 'currency',
    currency,
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
  const s = fmt.format(Math.abs(amount));
  if (signed) {
    if (amount > 0) return `+${s}`;
    if (amount < 0) return `−${s}`;
    return s;
  }
  return amount < 0 ? `−${s}` : s;
}

export function formatNumber(n, digits = 4) {
  if (n == null || Number.isNaN(n)) return '—';
  return new Intl.NumberFormat('en-GB', {
    minimumFractionDigits: 0,
    maximumFractionDigits: digits,
  }).format(n);
}

export function formatDate(iso) {
  if (!iso) return '—';
  const d = new Date(iso);
  return d.toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' });
}

export function todayIso() {
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

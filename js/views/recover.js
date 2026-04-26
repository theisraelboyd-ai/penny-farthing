/* Recovery view — accessible at #/recover
 *
 * Provides a fallback UI for when the app's normal data load has
 * corrupted state and the user can't reach Settings to clear it.
 * Bypasses computePortfolio (which is the most likely thing to throw
 * on bad data) and offers raw database operations:
 *
 *   - View raw record counts
 *   - Export current data as JSON (so user can salvage it)
 *   - Wipe everything cleanly
 *   - Import a known-good backup
 *
 * This view should NEVER throw on bad data. Catch everything aggressively.
 */

import { el } from '../ui.js';
import { getAll } from '../storage/indexeddb.js';

const STORES = ['accounts', 'assets', 'transactions', 'taxYears', 'settings'];

export async function renderRecover(mount) {
  mount.append(
    el('div', { class: 'view-header' },
      el('h2', {}, 'Recovery'),
      el('p', {}, 'Fallback tools when the main app can\'t load due to data issues.'),
    ),
  );

  // Try to count records in each store. Each wrapped in try/catch
  // so a single bad store doesn't break the rest.
  const countsList = el('ul', { style: { fontFamily: 'var(--font-mono)' } });
  const counts = {};
  for (const store of STORES) {
    let count = '?';
    try {
      const records = await getAll(store);
      count = records.length;
      counts[store] = records;
    } catch (err) {
      count = `ERROR: ${err.message}`;
    }
    countsList.append(el('li', {}, `${store}: ${count}`));
  }

  const exportBtn = el('button', { class: 'button' }, 'Download raw backup');
  exportBtn.addEventListener('click', () => {
    try {
      const payload = {
        recoveryExport: true,
        exportedAt: new Date().toISOString(),
        data: counts,
      };
      const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `penny-farthing-recovery-${Date.now()}.json`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
    } catch (err) {
      alert(`Export failed: ${err.message}`);
    }
  });

  const wipeBtn = el('button', { class: 'button button--danger' }, 'Wipe ALL data');
  wipeBtn.addEventListener('click', async () => {
    if (!confirm('This will delete everything in the app database — accounts, transactions, assets, settings — and is NOT undoable. Did you download a backup first? Click OK to proceed.')) return;
    if (!confirm('Last warning. Wipe everything?')) return;
    try {
      // Delete the entire database directly, bypassing any module's helpers
      // that might be holding bad cached state.
      const dbName = 'penny-farthing';
      const req = indexedDB.deleteDatabase(dbName);
      req.onsuccess = () => {
        alert('Database wiped. Reloading…');
        // Also clear privacy local storage in case it's contributing
        try { localStorage.removeItem('penny-farthing-privacy'); } catch {}
        location.hash = '#/dashboard';
        location.reload();
      };
      req.onerror = () => alert('Wipe failed: ' + req.error?.message);
      req.onblocked = () => alert('Wipe blocked — close other tabs running this app and try again.');
    } catch (err) {
      alert(`Wipe failed: ${err.message}`);
    }
  });

  const reloadBtn = el('button', { class: 'button button--ghost' }, 'Try main app again');
  reloadBtn.addEventListener('click', () => {
    location.hash = '#/dashboard';
    location.reload();
  });

  mount.append(
    el('section', { class: 'ledger-page' },
      el('div', { class: 'ledger-page__heading' },
        el('h2', {}, 'Database state'),
      ),
      el('p', { class: 'ledger-page__subtitle' },
        'Records in each store. If any show "ERROR" the data is unreadable.'),
      countsList,
      el('h3', { style: { marginTop: 'var(--space-5)', fontSize: 'var(--f-md)' } }, 'Actions'),
      el('p', { class: 'form-group__hint', style: { marginBottom: 'var(--space-3)' } },
        'Always download a backup BEFORE wiping. The backup file includes whatever data could be read, even if some of it is corrupted.'),
      el('div', { class: 'button-row', style: { flexWrap: 'wrap' } },
        exportBtn, wipeBtn, reloadBtn,
      ),
    ),
  );
}

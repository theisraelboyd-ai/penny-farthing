/* Hidden dev tool — accessible at #/dev/repair-fx
 *
 * Surgically repairs transactions affected by the form bug where
 * non-GBP transactions were saved with `fxRate: 1` and `fxSource: 'auto'`
 * because the form's promised "Frankfurter will fetch on next portfolio
 * render" never actually happened. Result: cost basis treated as if
 * 1 USD = 1 GBP, distorting CGT figures.
 *
 * Approach:
 *   1. Scan all transactions, find those with currency != GBP/GBX,
 *      fxRate === 1, fxSource === 'auto'.
 *   2. For each, fetch the historical Frankfurter rate via the existing
 *      engine/fx.js helper (7-day backward walk on 404 already built in).
 *   3. Render a preview table showing date / asset / currency / old rate
 *      (1.000) / new rate / GBP cost before / after / delta.
 *   4. On "Apply repairs" click: write fxRate (new value) and
 *      fxSource: 'frankfurter' to each record. No other fields touched.
 *      Schema unchanged. costGbp / proceedsGbp recompute live on next
 *      render — they're derived, not stored.
 *
 * Not registered in any nav. Access via URL only (#/dev/repair-fx).
 * Per user instruction: form fix lives elsewhere — this view is purely
 * for fixing existing data.
 */

import { el, formatCurrency, formatDate, toast } from '../ui.js';
import { getAll, put } from '../storage/indexeddb.js';
import { getFxRate } from '../engine/fx.js';

export async function renderDevRepairFx(mount) {
  mount.append(
    el('div', { class: 'view-header' },
      el('h2', {}, 'Dev — Repair FX rates'),
      el('p', {}, 'Hidden surgical tool. Fixes transactions where currency conversion silently defaulted to 1.0.'),
    ),
  );

  // Status panel — what's been found, what's been done.
  const statusEl = el('section', { class: 'ledger-page' });
  mount.append(statusEl);

  statusEl.append(
    el('p', { class: 'form-group__hint' },
      'Step 1: Download a backup before doing anything destructive. The repair only writes fxRate and fxSource fields, but belt-and-braces.'),
    el('button', {
      class: 'button button--ghost',
      onclick: handleBackupDownload,
    }, 'Download backup (.json)'),
    el('hr', { style: { margin: 'var(--space-4) 0' } }),
    el('p', { class: 'form-group__hint' },
      'Step 2: Scan for transactions needing repair. Frankfurter will be queried for each historical rate. May take a few seconds.'),
  );

  const scanBtn = el('button', { class: 'button' }, 'Scan transactions');
  const previewWrap = el('div', { style: { marginTop: 'var(--space-4)' } });
  statusEl.append(scanBtn, previewWrap);

  scanBtn.addEventListener('click', async () => {
    scanBtn.disabled = true;
    scanBtn.textContent = 'Scanning…';
    previewWrap.innerHTML = '';
    try {
      const result = await scanForRepairs();
      renderPreview(previewWrap, result);
    } catch (err) {
      previewWrap.append(el('p', { class: 'loss' },
        `Scan failed: ${err.message}`));
    } finally {
      scanBtn.disabled = false;
      scanBtn.textContent = 'Re-scan';
    }
  });
}

/**
 * Scan all transactions and prepare a repair plan. Does NOT write anything.
 */
async function scanForRepairs() {
  const [allTxns, allAssets] = await Promise.all([
    getAll('transactions'),
    getAll('assets'),
  ]);
  const assetMap = new Map(allAssets.map((a) => [a.id, a]));

  // Find affected transactions: non-GBP currency + fxRate=1 + fxSource=auto.
  // We deliberately skip records whose fxSource is 'manual' — user-entered
  // rates are sacred per existing convention.
  const affected = allTxns.filter((t) =>
    t.currency &&
    t.currency !== 'GBP' &&
    t.currency !== 'GBX' &&
    t.fxRate === 1 &&
    t.fxSource === 'auto'
  );

  // Fetch Frankfurter rates for each affected transaction in parallel.
  // The fx engine caches in IndexedDB, so subsequent runs are fast.
  const repairs = await Promise.all(affected.map(async (t) => {
    let newRate = null;
    let fetchError = null;
    try {
      newRate = await getFxRate(t.currency, t.date);
    } catch (err) {
      fetchError = err.message;
    }

    const asset = assetMap.get(t.assetId);
    const ticker = asset ? asset.ticker : '???';
    const gross = (t.quantity || 0) * (t.pricePerUnit || 0);
    // GBP value with old (broken) rate of 1.0:
    const oldGbp = gross;
    // GBP value with new (Frankfurter) rate. The convention in this app:
    // grossGbp = quantity * pricePerUnit * fxRate (per pool.js grossGbp).
    // So new GBP = gross * newRate.
    const newGbp = newRate !== null ? gross * newRate : null;
    const deltaGbp = newGbp !== null ? newGbp - oldGbp : null;

    return {
      txn: t,
      ticker,
      newRate,
      fetchError,
      oldGbp,
      newGbp,
      deltaGbp,
    };
  }));

  // Net portfolio cost-basis impact: sum buys minus sells in delta terms
  let netDelta = 0;
  for (const r of repairs) {
    if (r.deltaGbp === null) continue;
    if (r.txn.type === 'buy') netDelta += r.deltaGbp;
    else if (r.txn.type === 'sell') netDelta -= r.deltaGbp;
  }

  return {
    totalScanned: allTxns.length,
    affected: repairs,
    netDelta,
  };
}

/**
 * Render the repair preview and Apply button.
 */
function renderPreview(wrap, { totalScanned, affected, netDelta }) {
  if (affected.length === 0) {
    wrap.append(el('p', { class: 'gain' },
      `Scanned ${totalScanned} transactions. None need repair.`));
    return;
  }

  const failedCount = affected.filter((r) => r.fetchError || r.newRate === null).length;
  const okCount = affected.length - failedCount;

  wrap.append(
    el('h3', { style: { marginTop: 'var(--space-3)' } },
      `${affected.length} transactions affected`),
    el('p', { class: 'form-group__hint' },
      `Scanned ${totalScanned} total; ${okCount} have valid Frankfurter rates and can be repaired; ${failedCount} failed FX fetch.`),
    el('p', { class: 'form-group__hint' },
      `Estimated net cost-basis change after repair: ${formatCurrency(netDelta, 'GBP')} (positive = portfolio cost goes up).`),
  );

  // Build a table
  const table = el('table', { class: 'hairline-table' });
  const thead = el('thead', {},
    el('tr', {},
      ['Date', 'Type', 'Asset', 'Ccy', 'Old rate', 'New rate', 'Old GBP', 'New GBP', 'Δ GBP', 'Status']
        .map((h) => el('th', {}, h)),
    ),
  );
  const tbody = el('tbody');
  for (const r of affected) {
    const status = r.fetchError
      ? el('span', { class: 'loss' }, `fetch failed: ${r.fetchError}`)
      : r.newRate === null
        ? el('span', { class: 'loss' }, 'no rate')
        : el('span', { class: 'gain' }, 'OK');
    tbody.append(el('tr', {},
      el('td', {}, formatDate(r.txn.date)),
      el('td', {}, r.txn.type),
      el('td', {}, r.ticker),
      el('td', {}, r.txn.currency),
      el('td', { class: 'num' }, '1.0000'),
      el('td', { class: 'num' }, r.newRate !== null ? r.newRate.toFixed(4) : '—'),
      el('td', { class: 'num' }, formatCurrency(r.oldGbp, 'GBP')),
      el('td', { class: 'num' }, r.newGbp !== null ? formatCurrency(r.newGbp, 'GBP') : '—'),
      el('td', { class: 'num' }, r.deltaGbp !== null ? formatCurrency(r.deltaGbp, 'GBP') : '—'),
      el('td', {}, status),
    ));
  }
  table.append(thead, tbody);
  wrap.append(table);

  // Apply button — only enabled if at least one transaction is repairable
  const applyBtn = el('button', {
    class: 'button',
    style: { marginTop: 'var(--space-4)' },
    ...(okCount === 0 ? { disabled: true } : {}),
  }, `Apply repairs (${okCount})`);
  wrap.append(applyBtn);

  applyBtn.addEventListener('click', async () => {
    if (!confirm(`Apply ${okCount} FX rate repairs? This writes fxRate and fxSource on each transaction. Other fields untouched. Schema unchanged. After applying, the page will reload.`)) return;
    applyBtn.disabled = true;
    applyBtn.textContent = 'Applying…';
    let written = 0;
    let writeFailed = 0;
    for (const r of affected) {
      if (r.fetchError || r.newRate === null) continue;
      try {
        const updated = {
          ...r.txn,
          fxRate: r.newRate,
          fxSource: 'frankfurter',
          updatedAt: new Date().toISOString(),
        };
        await put('transactions', updated);
        written++;
      } catch (err) {
        writeFailed++;
        console.error('Write failed for', r.txn.id, err);
      }
    }
    toast(`Repaired ${written} transactions${writeFailed ? `, ${writeFailed} failed` : ''}`);
    setTimeout(() => location.reload(), 1500);
  });
}

/**
 * Reuse the standard backup-download flow. Inlined here because settings.js
 * doesn't export it as a function — it's wired to a button click. Mirror
 * the same logic for the dev tool.
 */
async function handleBackupDownload() {
  const stores = ['accounts', 'assets', 'transactions', 'taxYears', 'settings', 'fxRates', 'prices'];
  const data = {};
  for (const store of stores) {
    try {
      data[store] = await getAll(store);
    } catch {
      data[store] = [];
    }
  }
  data._meta = {
    exportedAt: new Date().toISOString(),
    dbVersion: 1,
    app: 'penny-farthing',
    note: 'pre-fx-repair backup',
  };
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `penny-farthing-pre-fx-repair-${new Date().toISOString().slice(0, 10)}.json`;
  a.click();
  URL.revokeObjectURL(url);
  toast('Backup downloaded');
}

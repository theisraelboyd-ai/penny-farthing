/* Import view — upload a CSV, preview rows, confirm and commit.
 *
 * Currently supports: IBKR Activity Statement.
 * eToro and generic CSV support to follow.
 */

import { el, formatCurrency, formatDate, formatNumber, toast } from '../ui.js';
import { getAll, put, uuid } from '../storage/indexeddb.js';
import { parseIbkrActivityStatement, tradeDedupKey, existingTxnDedupKey } from '../importers/ibkr.js';
import { ukTaxYear } from '../storage/schema.js';
import { navigate } from '../router.js';

export async function renderImport(mount) {
  const accounts = await getAll('accounts');
  const ibkrAccounts = accounts.filter((a) => a.platform === 'ibkr');

  mount.append(
    el('div', { class: 'view-header' },
      el('h2', {}, 'Import trades'),
      el('p', {}, 'Load an IBKR Activity Statement CSV. Review every row before committing.'),
    ),
    el('div', {
      style: {
        padding: 'var(--space-3)',
        background: 'var(--surface-2)',
        borderRadius: 'var(--radius-md)',
        marginBottom: 'var(--space-4)',
        fontSize: 'var(--f-sm)',
      },
    },
      el('strong', {}, 'For eToro / Trading 212 history: '),
      'use ',
      el('a', {
        href: '#/closed',
        style: { color: 'var(--accent)', fontWeight: '500' },
      }, 'Record closed position'),
      ' — enter open and close in one form per disposal. Faster than building an importer for platforms that already match your trades.',
    ),
  );

  // ----- Prerequisite: at least one IBKR account -----
  if (ibkrAccounts.length === 0) {
    mount.append(
      el('section', { class: 'ledger-page' },
        el('h3', {}, 'Open an IBKR account first'),
        el('p', { class: 'text-muted' },
          'You need at least one IBKR account registered in Settings before importing trades. The importer uses it as the target for every row.'),
        el('div', { class: 'button-row' },
          el('button', { class: 'button', onclick: () => navigate('/settings') },
            'Go to Settings'),
        ),
      ),
    );
    return;
  }

  // ----- Step 1: file upload -----
  const fileInput = el('input', {
    type: 'file',
    accept: '.csv,text/csv',
    id: 'ibkr-file',
    style: { display: 'none' },
  });

  const chooseBtn = el('button', { class: 'button' }, 'Choose IBKR CSV…');
  chooseBtn.addEventListener('click', () => fileInput.click());

  const accountSelect = el('select', { class: 'select', id: 'import-account' },
    ...ibkrAccounts.map((a) => el('option', { value: a.id }, `${a.name} · ${a.wrapper}`)),
  );

  const step1 = el('section', { class: 'ledger-page' },
    el('h3', {}, 'Step 1 — Choose target account'),
    el('p', { class: 'form-group__hint' },
      'All imported trades will be attributed to this account. You can re-run import for another account separately.'),
    el('div', { class: 'form-group' },
      el('label', { for: 'import-account' }, 'Target account'),
      accountSelect,
    ),
    el('p', { class: 'form-group__hint', style: { marginTop: 'var(--space-4)' } },
      'To get your CSV from IBKR: Client Portal → Reports → Statements → Activity → choose date range → Format: CSV → Run.'),
    el('div', { class: 'button-row' }, chooseBtn, fileInput),
  );
  mount.append(step1);

  const previewContainer = el('div');
  mount.append(previewContainer);

  fileInput.addEventListener('change', async (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    try {
      const text = await file.text();
      const parsed = parseIbkrActivityStatement(text);
      await renderPreview(previewContainer, parsed, accountSelect.value, () => {
        // Reset on commit
        mount.innerHTML = '';
        renderImport(mount);
      });
    } catch (err) {
      console.error(err);
      toast(`Could not parse CSV: ${err.message}`, { error: true });
    }
  });
}

async function renderPreview(container, parsed, accountId, onCommit) {
  container.innerHTML = '';

  const { trades, dividends, warnings } = parsed;

  // Load existing data for dedup check
  const [existingTxns, existingAssets, accounts] = await Promise.all([
    getAll('transactions'),
    getAll('assets'),
    getAll('accounts'),
  ]);
  const account = accounts.find((a) => a.id === accountId);
  const assetsByTicker = new Map(existingAssets.map((a) => [a.ticker?.toUpperCase(), a]));

  // Build existing dedup set restricted to the target account
  const existingKeys = new Set();
  for (const t of existingTxns) {
    if (t.accountId !== accountId) continue;
    const a = existingAssets.find((x) => x.id === t.assetId);
    existingKeys.add(existingTxnDedupKey(t, a));
  }

  // Warnings section
  if (parsed.summary) {
    container.append(
      el('p', { class: 'text-faint', style: { fontSize: 'var(--f-sm)', marginBottom: 'var(--space-3)' } },
        parsed.summary),
    );
  }

  if (warnings.length > 0) {
    container.append(
      el('section', { class: 'ledger-page', style: { borderColor: 'var(--warn)' } },
        el('h3', { style: { color: 'var(--warn)' } }, 'Import warnings'),
        el('ul', {},
          ...warnings.map((w) => el('li', {}, w)),
        ),
      ),
    );
  }

  if (trades.length === 0 && dividends.length === 0) {
    container.append(
      el('section', { class: 'ledger-page' },
        el('p', {}, 'No trades or dividends found in this CSV.'),
      ),
    );
    return;
  }

  // Tag each trade as new / duplicate
  const rows = trades.map((t) => ({
    trade: t,
    key: tradeDedupKey(t),
    selected: true,
    isDuplicate: existingKeys.has(tradeDedupKey(t)),
    assetExists: !!assetsByTicker.get(t.symbol.toUpperCase()),
  }));
  // Default-deselect duplicates
  for (const r of rows) if (r.isDuplicate) r.selected = false;

  // Dividends (simpler — for now we include them but without dedup)
  const divRows = dividends.map((d) => ({
    dividend: d,
    selected: true,
    assetExists: !!assetsByTicker.get(d.symbol.toUpperCase()),
  }));

  const newCount = () => rows.filter((r) => r.selected && !r.isDuplicate).length;
  const dupCount = () => rows.filter((r) => r.isDuplicate).length;
  const newAssetCount = () => new Set(rows.filter((r) => r.selected && !r.assetExists)
    .map((r) => r.trade.symbol.toUpperCase())).size;

  // Summary
  const summaryPage = el('section', { class: 'ledger-page' });
  const summary = el('div', { class: 'stat-grid' });

  const updateSummary = () => {
    summary.innerHTML = '';
    const selectedCount = rows.filter((r) => r.selected).length;
    summary.append(
      stat('Trades found', String(trades.length),
        `${dupCount()} already in your ledger`),
      stat('Will import', String(selectedCount),
        newAssetCount() > 0 ? `${newAssetCount()} new asset${newAssetCount() === 1 ? '' : 's'}` : 'no new assets'),
      stat('Dividends', String(dividends.length),
        'informational'),
      stat('Target', account?.name || '—',
        account?.wrapper || ''),
    );
  };

  summaryPage.append(
    el('h3', {}, 'Preview'),
    el('p', { class: 'text-muted' },
      'Untick any row you don\'t want to import. Rows already in your ledger are automatically deselected.'),
    summary,
  );
  updateSummary();
  container.append(summaryPage);

  // Trades table
  const tradesTable = el('table', { class: 'hairline-table' },
    el('thead', {},
      el('tr', {},
        el('th', {}, ''),
        el('th', {}, 'Date'),
        el('th', {}, 'Type'),
        el('th', {}, 'Symbol'),
        el('th', { class: 'num' }, 'Qty'),
        el('th', { class: 'num' }, 'Price'),
        el('th', { class: 'num' }, 'Fees'),
        el('th', {}, 'Status'),
      ),
    ),
    el('tbody', {},
      ...rows.map((r) => {
        const t = r.trade;
        const checkbox = el('input', {
          type: 'checkbox',
          checked: r.selected,
          onchange: (e) => {
            r.selected = e.target.checked;
            updateSummary();
          },
        });
        const statusPills = [];
        if (r.isDuplicate) statusPills.push(el('span', { class: 'pill pill--loss' }, 'duplicate'));
        else statusPills.push(el('span', { class: 'pill pill--buy' }, 'new'));
        if (!r.assetExists) statusPills.push(el('span', { class: 'pill' }, 'new asset'));

        return el('tr', { class: `txn-row--${t.type}` },
          el('td', {}, checkbox),
          el('td', {}, formatDate(t.date)),
          el('td', {}, el('span', { class: `pill pill--${t.type}` }, t.type)),
          el('td', { style: { fontWeight: '500' } }, t.symbol),
          el('td', { class: 'num' }, formatNumber(t.quantity, 4)),
          el('td', { class: 'num' }, `${formatNumber(t.pricePerUnit, 4)} ${t.currency}`),
          el('td', { class: 'num' }, formatNumber(t.fees, 2)),
          el('td', {}, ...statusPills),
        );
      }),
    ),
  );

  container.append(el('section', { class: 'ledger-page' },
    el('h3', {}, `Trades (${trades.length})`),
    tradesTable,
  ));

  // Commit button
  const commitBtn = el('button', { class: 'button button--full' }, 'Import selected');
  const cancelBtn = el('button', { class: 'button button--ghost button--full',
    onclick: () => { container.innerHTML = ''; }
  }, 'Cancel');

  container.append(
    el('section', { class: 'ledger-page' },
      el('div', { class: 'button-row' }, commitBtn, cancelBtn),
    ),
  );

  commitBtn.addEventListener('click', async () => {
    commitBtn.disabled = true;
    commitBtn.textContent = 'Importing…';
    try {
      const result = await commit(rows, accountId, existingAssets);
      toast(`Imported ${result.txnsCreated} trades, ${result.assetsCreated} new assets`);
      if (onCommit) onCommit();
    } catch (err) {
      console.error(err);
      toast(`Import failed: ${err.message}`, { error: true });
      commitBtn.disabled = false;
      commitBtn.textContent = 'Import selected';
    }
  });
}

async function commit(rows, accountId, existingAssets) {
  let txnsCreated = 0;
  let assetsCreated = 0;
  const assetMap = new Map(existingAssets.map((a) => [a.ticker?.toUpperCase(), a]));

  for (const r of rows) {
    if (!r.selected) continue;
    if (r.isDuplicate) continue;

    const t = r.trade;
    const sym = t.symbol.toUpperCase();

    // Auto-create asset if missing
    let asset = assetMap.get(sym);
    if (!asset) {
      asset = {
        id: uuid(),
        type: 'equity',
        ticker: t.symbol,
        name: t.symbol,  // user can refine later
        baseCurrency: t.currency,
        exchange: 'NASDAQ',  // placeholder — user can refine
        meta: {},
      };
      await put('assets', asset);
      assetMap.set(sym, asset);
      assetsCreated++;
    }

    // Build the transaction
    // Note: IBKR trades are in native currency. Leave fxRate=1 and fxSource='auto'
    // for non-GBP — the FX engine will back-fill from Frankfurter on next portfolio compute.
    const isForeign = t.currency !== 'GBP' && t.currency !== 'GBX';
    const txn = {
      id: uuid(),
      date: t.date,
      type: t.type,
      assetId: asset.id,
      accountId,
      quantity: t.quantity,
      pricePerUnit: t.pricePerUnit,
      currency: t.currency,
      fxRate: 1,
      fxSource: isForeign ? 'auto' : 'trivial',
      fees: t.fees,
      taxYear: ukTaxYear(t.date),
      notes: 'Imported from IBKR Activity Statement',
      createdAt: new Date().toISOString(),
      importSource: 'ibkr',
    };

    await put('transactions', txn);
    txnsCreated++;
  }

  return { txnsCreated, assetsCreated };
}

function stat(label, value, sub) {
  return el('div', { class: 'stat-tile' },
    el('div', { class: 'stat-tile__label' }, label),
    el('div', { class: 'stat-tile__value' }, value),
    sub ? el('div', { class: 'stat-tile__sub' }, sub) : null,
  );
}

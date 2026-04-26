/* Activity view — the full transaction ledger.
 *
 * Features:
 *   - Filter chips (All / Buys / Sells / Dividends / Fees) with running counts
 *   - Asset-type glyph in the asset column
 *   - Left-border colour on each row by transaction type
 *   - FX-source label for foreign-currency transactions
 *   - Inline delete button
 */

import { el, formatCurrency, formatDate, formatNumber, toast } from '../ui.js';
import { getAll, remove } from '../storage/indexeddb.js';
import { navigate } from '../router.js';
import { glyphFor, txnStyle } from '../visual/glyphs.js';

// Module-local filter state (persists while user navigates within session)
let activeFilter = 'all';

export async function renderTransactions(mount) {
  const [txns, assets, accounts] = await Promise.all([
    getAll('transactions'),
    getAll('assets'),
    getAll('accounts'),
  ]);

  const assetMap = new Map(assets.map((a) => [a.id, a]));
  const accountMap = new Map(accounts.map((a) => [a.id, a]));

  // Sort newest first
  txns.sort((a, b) => (b.date || '').localeCompare(a.date || ''));

  mount.append(
    el('div', { class: 'view-header' },
      el('h2', {}, 'Activity'),
      el('p', {}, `${txns.length} transaction${txns.length === 1 ? '' : 's'} across all accounts.`),
    ),
  );

  if (txns.length === 0) {
    mount.append(
      el('section', { class: 'ledger-page' },
        el('div', { class: 'empty-state' },
          el('p', {}, 'No transactions yet.'),
          el('div', { class: 'button-row', style: { justifyContent: 'center' } },
            el('button', { class: 'button', onclick: () => navigate('/add') },
              'Record your first transaction'),
          ),
        ),
      ),
    );
    return;
  }

  // Count by type for the filter chip badges
  const typeCounts = {
    all: txns.length,
    buy: 0, sell: 0, dividend: 0, fee: 0,
  };
  for (const t of txns) {
    if (typeCounts[t.type] !== undefined) typeCounts[t.type]++;
  }

  // Filter chips
  const chipsWrap = el('div', { class: 'filter-chips' });
  const filters = [
    { key: 'all',      label: 'All' },
    { key: 'buy',      label: 'Buys' },
    { key: 'sell',     label: 'Sells' },
    { key: 'dividend', label: 'Dividends' },
    { key: 'fee',      label: 'Fees' },
  ];
  const tableWrap = el('div'); // placeholder we'll re-render into
  for (const f of filters) {
    const chip = el('button', {
      class: 'filter-chip' + (activeFilter === f.key ? ' is-active' : ''),
      'data-filter': f.key,
      onclick: () => {
        activeFilter = f.key;
        // Update chip states
        chipsWrap.querySelectorAll('.filter-chip').forEach((c) =>
          c.classList.toggle('is-active', c.dataset.filter === f.key));
        // Re-render table
        tableWrap.innerHTML = '';
        tableWrap.append(renderTable(txns, assetMap, accountMap, activeFilter, () => {
          // Re-render callback (after delete)
          mount.innerHTML = '';
          renderTransactions(mount);
        }));
      },
    },
      f.label,
      typeCounts[f.key] > 0
        ? el('span', { class: 'filter-chip__count' }, `(${typeCounts[f.key]})`)
        : null,
    );
    chipsWrap.append(chip);
  }

  const page = el('section', { class: 'ledger-page' });
  tableWrap.append(renderTable(txns, assetMap, accountMap, activeFilter, () => {
    mount.innerHTML = '';
    renderTransactions(mount);
  }));
  page.append(chipsWrap, tableWrap);
  mount.append(page);
}

function renderTable(txns, assetMap, accountMap, filter, onChange) {
  const filtered = filter === 'all' ? txns : txns.filter((t) => t.type === filter);

  if (filtered.length === 0) {
    return el('div', { class: 'empty-state' },
      el('p', {}, `No ${filter === 'all' ? '' : filter + ' '}transactions.`),
    );
  }

  return el('table', { class: 'hairline-table' },
    el('thead', {},
      el('tr', {},
        el('th', {}, 'Date'),
        el('th', {}, 'Type'),
        el('th', {}, 'Asset'),
        el('th', { class: 'num' }, 'Qty'),
        el('th', { class: 'num' }, 'Value (GBP)'),
        el('th', {}, ''),
      ),
    ),
    el('tbody', {},
      ...filtered.map((t) => renderRow(t, assetMap, accountMap, onChange)),
    ),
  );
}

function renderRow(t, assetMap, accountMap, onChange) {
  const asset = assetMap.get(t.assetId);
  const account = accountMap.get(t.accountId);
  const style = txnStyle(t.type);

  // GBP value
  const gross = (t.quantity || 0) * (t.pricePerUnit || 0);
  const gbpFx = t.currency === 'GBX' ? (t.fxRate || 1) * 0.01 : (t.fxRate || 1);
  const grossGbp = gross * gbpFx;

  // FX source indicator for foreign currency only
  const needsFxIndicator = t.currency !== 'GBP' && t.currency !== 'GBX';
  const fxSource = t.fxSource || 'unset';
  const fxLabel = needsFxIndicator
    ? (fxSource === 'manual' ? 'fx manual' :
       fxSource === 'auto'   ? 'fx auto' :
                               'fx unset')
    : null;

  // Asset glyph (defined by type)
  const g = glyphFor(asset?.type);

  return el('tr', { class: `txn-row--${t.type}` },
    el('td', { 'data-label': 'Date' }, formatDate(t.date)),
    el('td', { 'data-label': 'Type' },
      el('span', { class: `pill ${style.pillClass}` }, style.label),
    ),
    el('td', { 'data-label': 'Asset' },
      el('div', { style: { display: 'flex', alignItems: 'center' } },
        el('span', { class: `asset-glyph asset-glyph--${g.tone}`, title: g.label }, g.glyph),
        el('div', {},
          el('div', { style: { fontWeight: '500' } }, asset ? (asset.ticker || '?') : '?'),
          el('div', { class: 'text-faint', style: { fontSize: '0.7rem' } },
            account ? `${account.name} · ${account.wrapper}` : ''),
        ),
      ),
    ),
    el('td', { class: 'num', 'data-label': 'Quantity' }, formatNumber(t.quantity, 6)),
    el('td', { class: 'num', 'data-label': 'Value (GBP)' },
      formatCurrency(grossGbp, 'GBP'),
      needsFxIndicator
        ? el('div', { class: 'text-faint', style: { fontSize: '0.7rem' } },
            `${formatNumber(gross, 2)} ${t.currency} · ${fxLabel}`)
        : null,
    ),
    el('td', { 'data-label': '', style: { textAlign: 'right', whiteSpace: 'nowrap' } },
      el('button', {
        class: 'button button--ghost button-sm',
        style: { marginRight: 'var(--space-1)' },
        onclick: () => {
          const editUrl = t.pairId
            ? `/closed?edit=${encodeURIComponent(t.id)}`
            : `/add?edit=${encodeURIComponent(t.id)}`;
          navigate(editUrl);
        },
      }, 'Edit'),
      el('button', {
        class: 'button button--ghost button-sm',
        onclick: async () => {
          // If this is part of a pair, offer to delete both halves together
          if (t.pairId) {
            const choice = confirm(
              'This transaction is part of a matched pair (buy + sell).\n\n' +
              'OK to delete BOTH halves together (recommended).\n' +
              'Cancel to skip and keep both.'
            );
            if (!choice) return;
            await remove('transactions', t.id);
            await remove('transactions', t.pairId);
            toast('Pair removed');
          } else {
            if (!confirm('Delete this transaction? This cannot be undone.')) return;
            await remove('transactions', t.id);
            toast('Transaction removed');
          }
          if (onChange) onChange();
        },
      }, 'Remove'),
    ),
  );
}

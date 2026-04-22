/* Transactions view — chronological list of all entries */

import { el, formatCurrency, formatDate, formatNumber, toast } from '../ui.js';
import { getAll, remove } from '../storage/indexeddb.js';
import { navigate } from '../router.js';

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

  const page = el('section', { class: 'ledger-page' },
    el('div', { class: 'ledger-page__heading' },
      el('h2', {}, 'Activity'),
      el('span', { class: 'ledger-page__folio' }, `${txns.length} total`),
    ),
  );

  if (txns.length === 0) {
    page.append(
      el('div', { class: 'empty-state' },
        el('p', {}, 'No transactions yet.'),
        el('div', { class: 'button-row', style: { justifyContent: 'center' } },
          el('button', { class: 'button',
            onclick: () => navigate('/add') }, 'Record your first transaction'),
        ),
      ),
    );
    mount.append(page);
    return;
  }

  const table = el('table', { class: 'hairline-table' },
    el('thead', {},
      el('tr', {},
        el('th', {}, 'Date'),
        el('th', {}, 'Type'),
        el('th', {}, 'Asset'),
        el('th', { class: 'num' }, 'Qty'),
        el('th', { class: 'num' }, 'Value'),
        el('th', {}, ''),
      ),
    ),
    el('tbody', {},
      ...txns.map((t) => {
        const asset = assetMap.get(t.assetId);
        const account = accountMap.get(t.accountId);
        const gross = (t.quantity || 0) * (t.pricePerUnit || 0);
        const gbpFx = t.currency === 'GBX' ? (t.fxRate || 1) / 100 : (t.fxRate || 1);
        const grossGbp = gross * gbpFx;
        const typeLabel = t.type.charAt(0).toUpperCase() + t.type.slice(1);
        const rowClass = (t.type === 'sell' || t.type === 'dividend') ? 'credit' : '';

        return el('tr', {},
          el('td', {}, formatDate(t.date)),
          el('td', {}, el('span', { class: 'pill' }, typeLabel)),
          el('td', {},
            el('div', {}, asset ? asset.ticker : '?'),
            el('div', { class: 'text-faint', style: { fontSize: '0.75rem' } },
              account ? `${account.name} · ${account.wrapper}` : ''),
          ),
          el('td', { class: 'num' }, formatNumber(t.quantity, 6)),
          el('td', { class: `num ${rowClass}` }, formatCurrency(grossGbp, 'GBP')),
          el('td', { style: { textAlign: 'right' } },
            el('button', {
              class: 'button button--ghost button-sm',
              onclick: async () => {
                if (!confirm('Delete this transaction? This cannot be undone.')) return;
                await remove('transactions', t.id);
                toast('Transaction removed');
                mount.innerHTML = '';
                renderTransactions(mount);
              },
            }, 'Remove'),
          ),
        );
      }),
    ),
  );

  page.append(table);
  mount.append(page);
}

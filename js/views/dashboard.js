/* Dashboard — Day 1.5 redesign.
 * Stat tiles at the top, preview of real portfolio summary to come in Day 2.
 */

import { el, formatCurrency } from '../ui.js';
import { getAll } from '../storage/indexeddb.js';
import { navigate } from '../router.js';

export async function renderDashboard(mount) {
  const [transactions, assets, accounts] = await Promise.all([
    getAll('transactions'),
    getAll('assets'),
    getAll('accounts'),
  ]);

  // Rough at-a-glance numbers. Full CGT-aware computation lands in Day 2.
  let totalBuys = 0;
  let totalSells = 0;
  for (const t of transactions) {
    const gross = (t.quantity || 0) * (t.pricePerUnit || 0);
    const gbpFx = t.currency === 'GBX' ? (t.fxRate || 1) / 100 : (t.fxRate || 1);
    const gbp = gross * gbpFx;
    if (t.type === 'buy') totalBuys += gbp + (t.fees || 0) * gbpFx;
    if (t.type === 'sell') totalSells += gbp - (t.fees || 0) * gbpFx;
  }
  const netDeployed = totalBuys - totalSells;

  // ----- Empty state -----
  if (transactions.length === 0) {
    mount.append(
      el('div', { class: 'view-header' },
        el('h2', {}, 'Dashboard'),
        el('p', {}, 'Portfolio summary and holdings overview.'),
      ),
      el('section', { class: 'ledger-page' },
        el('div', { class: 'empty-state' },
          el('h3', { style: { fontWeight: '500', color: 'var(--text-muted)' } },
            accounts.length === 0 ? 'No accounts yet' : 'No transactions yet'),
          el('p', {},
            accounts.length === 0
              ? 'Add your first account and start recording trades to see your positions here.'
              : 'Record your first transaction to see your holdings and gain/loss summary here.'),
          el('div', { class: 'button-row', style: { justifyContent: 'center' } },
            el('button', {
              class: 'button',
              onclick: () => navigate('/add'),
            }, 'Record a transaction'),
          ),
        ),
      ),
    );
    return;
  }

  // ----- Stat tiles -----
  const statGrid = el('div', { class: 'stat-grid' },
    statTile('Net deployed', formatCurrency(netDeployed, 'GBP'),
      `${transactions.length} transaction${transactions.length === 1 ? '' : 's'}`),
    statTile('Assets', String(assets.length),
      `${accounts.length} account${accounts.length === 1 ? '' : 's'}`),
    statTile('Gross buys', formatCurrency(totalBuys, 'GBP'), 'purchases to date'),
    statTile('Gross sells', formatCurrency(totalSells, 'GBP'), 'disposals to date'),
  );

  // ----- Portfolio summary placeholder -----
  const note = el('section', { class: 'ledger-page' },
    el('div', { class: 'ledger-page__heading' },
      el('h2', {}, 'Holdings'),
      el('span', { class: 'pill' }, 'Day 2'),
    ),
    el('p', { class: 'text-muted', style: { fontSize: 'var(--f-sm)' } },
      'Section 104 pooled positions, FX-adjusted cost basis, live prices, and the ',
      el('em', {}, '"if sold now, net of tax"'),
      ' calculation arrive in the next release.'),
    el('p', { class: 'text-muted', style: { fontSize: 'var(--f-sm)' } },
      'In the meantime, record trades in ',
      el('a', { href: '#/add' }, 'Record'),
      ' and configure your tax year in ',
      el('a', { href: '#/settings' }, 'Settings'),
      '.'),
  );

  mount.append(
    el('div', { class: 'view-header' },
      el('h2', {}, 'Dashboard'),
      el('p', {}, 'Portfolio summary and holdings overview.'),
    ),
    statGrid,
    note,
  );
}

function statTile(label, value, sub) {
  return el('div', { class: 'stat-tile' },
    el('div', { class: 'stat-tile__label' }, label),
    el('div', { class: 'stat-tile__value' }, value),
    sub ? el('div', { class: 'stat-tile__sub' }, sub) : null,
  );
}

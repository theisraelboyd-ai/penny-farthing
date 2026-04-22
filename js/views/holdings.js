/* Holdings view
 *
 * Shows current positions across all assets and accounts, with Section 104
 * pooled cost basis in GBP. No live prices yet — that's Phase 2.
 */

import { el, formatCurrency, formatNumber } from '../ui.js';
import { computePortfolio } from '../engine/portfolio.js';
import { navigate } from '../router.js';

export async function renderHoldings(mount) {
  const portfolio = await computePortfolio();

  mount.append(
    el('div', { class: 'view-header' },
      el('h2', {}, 'Holdings'),
      el('p', {}, 'Current positions with Section 104 pooled cost basis.'),
    ),
  );

  if (portfolio.holdings.length === 0) {
    mount.append(
      el('section', { class: 'ledger-page' },
        el('div', { class: 'empty-state' },
          el('p', {}, 'No open positions. Record some transactions to see them here.'),
          el('div', { class: 'button-row', style: { justifyContent: 'center' } },
            el('button', { class: 'button', onclick: () => navigate('/add') },
              'Record a transaction'),
          ),
        ),
      ),
    );
    return;
  }

  // Group by wrapper so ISA / GIA / Unwrapped can be visually distinguished
  const byWrapper = {};
  for (const h of portfolio.holdings) {
    const w = h.account.wrapper || 'OTHER';
    if (!byWrapper[w]) byWrapper[w] = [];
    byWrapper[w].push(h);
  }

  // Totals
  const totalCostByWrapper = {};
  for (const [w, list] of Object.entries(byWrapper)) {
    totalCostByWrapper[w] = list.reduce((s, h) => s + h.costGbp, 0);
  }
  const grandTotalCost = portfolio.holdings.reduce((s, h) => s + h.costGbp, 0);

  // Overall summary strip
  mount.append(
    el('div', { class: 'stat-grid' },
      statTile('Total cost basis',
        formatCurrency(grandTotalCost, 'GBP'),
        `${portfolio.holdings.length} position${portfolio.holdings.length === 1 ? '' : 's'}`),
      ...Object.entries(totalCostByWrapper).map(([w, total]) =>
        statTile(`${w} positions`,
          formatCurrency(total, 'GBP'),
          `${byWrapper[w].length} asset${byWrapper[w].length === 1 ? '' : 's'}`)
      ),
    ),
  );

  // One card per wrapper
  const wrapperOrder = ['GIA', 'ISA', 'SIPP', 'UNWRAPPED', 'OTHER'];
  const sortedWrappers = Object.keys(byWrapper).sort(
    (a, b) => wrapperOrder.indexOf(a) - wrapperOrder.indexOf(b)
  );

  for (const wrapper of sortedWrappers) {
    const holdings = byWrapper[wrapper];
    const card = el('section', { class: 'ledger-page' },
      el('div', { class: 'ledger-page__heading' },
        el('h2', {}, wrapper),
        el('span', { class: 'pill' },
          formatCurrency(totalCostByWrapper[wrapper], 'GBP')),
      ),
      renderHoldingsTable(holdings),
    );
    mount.append(card);
  }
}

function renderHoldingsTable(holdings) {
  return el('table', { class: 'hairline-table' },
    el('thead', {},
      el('tr', {},
        el('th', {}, 'Asset'),
        el('th', {}, 'Account'),
        el('th', { class: 'num' }, 'Quantity'),
        el('th', { class: 'num' }, 'Avg cost (GBP)'),
        el('th', { class: 'num' }, 'Cost basis (GBP)'),
      ),
    ),
    el('tbody', {},
      ...holdings.map((h) => {
        const nativeCurrency = h.asset.baseCurrency || 'GBP';
        const showNative = nativeCurrency !== 'GBP' && nativeCurrency !== 'GBX';
        return el('tr', {},
          el('td', {},
            el('div', { style: { fontWeight: '500' } }, h.asset.ticker || '—'),
            el('div', { class: 'text-faint', style: { fontSize: 'var(--f-xs)' } },
              h.asset.name || ''),
          ),
          el('td', {},
            el('div', { style: { fontSize: 'var(--f-sm)' } }, h.account.name),
          ),
          el('td', { class: 'num' }, formatNumber(h.quantity, 6)),
          el('td', { class: 'num' },
            formatCurrency(h.avgCostGbp, 'GBP'),
            showNative
              ? el('div', { class: 'text-faint', style: { fontSize: 'var(--f-xs)' } },
                  `≈ ${nativeCurrency}`)
              : null,
          ),
          el('td', { class: 'num', style: { fontWeight: '500' } },
            formatCurrency(h.costGbp, 'GBP')),
        );
      }),
    ),
  );
}

function statTile(label, value, sub) {
  return el('div', { class: 'stat-tile' },
    el('div', { class: 'stat-tile__label' }, label),
    el('div', { class: 'stat-tile__value' }, value),
    sub ? el('div', { class: 'stat-tile__sub' }, sub) : null,
  );
}

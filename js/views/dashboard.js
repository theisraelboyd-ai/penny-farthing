/* Dashboard — top-level view.
 * Summary stat tiles + holdings preview + links to detail views.
 */

import { el, formatCurrency, formatNumber } from '../ui.js';
import { computePortfolio } from '../engine/portfolio.js';
import { navigate } from '../router.js';
import { glyphFor, txnStyle } from '../visual/glyphs.js';

export async function renderDashboard(mount) {
  const portfolio = await computePortfolio();
  const txnCount = portfolio.realisedDisposals.length +
    portfolio.holdings.length; // rough indicator; not strictly accurate, fine for header

  // ----- Empty state -----
  if (portfolio.holdings.length === 0 && portfolio.realisedDisposals.length === 0) {
    mount.append(
      el('div', { class: 'view-header' },
        el('h2', {}, 'Dashboard'),
        el('p', {}, 'Portfolio summary and holdings overview.'),
      ),
      el('section', { class: 'ledger-page' },
        el('div', { class: 'empty-state' },
          el('h3', { style: { fontWeight: '500', color: 'var(--text-muted)' } },
            'No activity yet'),
          el('p', {}, 'Record your first transaction to see your portfolio summary here.'),
          el('div', { class: 'button-row', style: { justifyContent: 'center' } },
            el('button', { class: 'button', onclick: () => navigate('/add') },
              'Record a transaction'),
          ),
        ),
      ),
    );
    return;
  }

  const totalCostBasis = portfolio.holdings.reduce((s, h) => s + h.costGbp, 0);

  // Tax-year realised totals
  const currentTaxYear = Object.keys(portfolio.byTaxYear).sort().pop();
  const currentYearData = currentTaxYear ? portfolio.byTaxYear[currentTaxYear] : null;

  mount.append(
    el('div', { class: 'view-header' },
      el('h2', {}, 'Dashboard'),
      el('p', {}, 'Portfolio summary and holdings overview.'),
    ),

    el('div', { class: 'stat-grid' },
      statTile('Holdings cost basis',
        formatCurrency(totalCostBasis, 'GBP'),
        `${portfolio.holdings.length} open position${portfolio.holdings.length === 1 ? '' : 's'}`),
      statTile('Disposals to date',
        String(portfolio.realisedDisposals.length),
        'matched and recorded'),
      currentYearData
        ? statTile(`Net realised ${currentTaxYear}`,
            formatCurrency(currentYearData.netGbp, 'GBP'),
            currentYearData.netGbp >= 0 ? 'gain in current tax year' : 'loss in current tax year',
            currentYearData.netGbp >= 0 ? 'gain' : 'loss')
        : statTile('Net realised', '—', 'no CGT-taxable disposals yet'),
    ),
  );

  // Holdings preview — top 5 positions
  if (portfolio.holdings.length > 0) {
    const topHoldings = portfolio.holdings.slice(0, 5);
    mount.append(
      el('section', { class: 'ledger-page' },
        el('div', { class: 'ledger-page__heading' },
          el('h2', {}, 'Top positions'),
          el('a', { href: '#/holdings', style: { fontSize: 'var(--f-sm)' } },
            `View all ${portfolio.holdings.length} →`),
        ),
        el('table', { class: 'hairline-table' },
          el('thead', {},
            el('tr', {},
              el('th', {}, 'Asset'),
              el('th', {}, 'Account'),
              el('th', { class: 'num' }, 'Qty'),
              el('th', { class: 'num' }, 'Cost (GBP)'),
            ),
          ),
          el('tbody', {},
            ...topHoldings.map((h) => {
              const g = glyphFor(h.asset.type);
              return el('tr', {},
                el('td', {},
                  el('div', { style: { display: 'flex', alignItems: 'center' } },
                    el('span', { class: `asset-glyph asset-glyph--${g.tone}`, title: g.label }, g.glyph),
                    el('div', {},
                      el('div', { style: { fontWeight: '500' } }, h.asset.ticker || '—'),
                      el('div', { class: 'text-faint', style: { fontSize: 'var(--f-xs)' } },
                        h.asset.name || ''),
                    ),
                  ),
                ),
                el('td', {}, el('span', { class: 'pill' }, h.account.wrapper || '—')),
                el('td', { class: 'num' }, formatNumber(h.quantity, 4)),
                el('td', { class: 'num' }, formatCurrency(h.costGbp, 'GBP')),
              );
            }),
          ),
        ),
      ),
    );
  }

  // Recent disposals preview
  if (portfolio.realisedDisposals.length > 0) {
    const recent = portfolio.realisedDisposals.slice(0, 5);
    mount.append(
      el('section', { class: 'ledger-page' },
        el('div', { class: 'ledger-page__heading' },
          el('h2', {}, 'Recent disposals'),
          el('a', { href: '#/tax', style: { fontSize: 'var(--f-sm)' } },
            'View tax summary →'),
        ),
        el('table', { class: 'hairline-table' },
          el('thead', {},
            el('tr', {},
              el('th', {}, 'Date'),
              el('th', {}, 'Asset'),
              el('th', { class: 'num' }, 'Proceeds'),
              el('th', { class: 'num' }, 'Gain / Loss'),
            ),
          ),
          el('tbody', {},
            ...recent.map((d) => {
              const isGain = d.gainGbp >= 0;
              return el('tr', {},
                el('td', {}, d.date),
                el('td', {}, d.assetTicker),
                el('td', { class: 'num' }, formatCurrency(d.proceedsNetGbp, 'GBP')),
                el('td', { class: `num ${isGain ? 'gain' : 'loss'}` },
                  (isGain ? '+' : '') + formatCurrency(d.gainGbp, 'GBP')),
              );
            }),
          ),
        ),
      ),
    );
  }
}

function statTile(label, value, sub, tone) {
  const valueClass = tone === 'gain' ? 'gain' : tone === 'loss' ? 'loss' : '';
  return el('div', { class: 'stat-tile' },
    el('div', { class: 'stat-tile__label' }, label),
    el('div', { class: `stat-tile__value ${valueClass}` }, value),
    sub ? el('div', { class: 'stat-tile__sub' }, sub) : null,
  );
}

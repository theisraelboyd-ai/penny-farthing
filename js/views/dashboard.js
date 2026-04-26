/* Dashboard — top-level view.
 * Summary stat tiles + holdings preview + links to detail views.
 */

import { el, formatCurrency, formatNumber } from '../ui.js';
import { computePortfolio } from '../engine/portfolio.js';
import { navigate } from '../router.js';
import { glyphFor, txnStyle } from '../visual/glyphs.js';
import { ukTaxYear } from '../storage/schema.js';

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

  // Today's actual UK tax year (not "latest year with data", which drifts)
  const currentTaxYear = ukTaxYear(new Date());
  const currentYearData = portfolio.byTaxYear[currentTaxYear] || null;

  // Also find the most recent CLOSED year with activity — useful because a
  // user might have just crossed an April boundary and the previous year's
  // paperwork is still relevant to them.
  const closedYearsWithData = Object.keys(portfolio.byTaxYear)
    .filter((y) => y !== currentTaxYear && y < currentTaxYear)
    .sort()
    .reverse();
  const recentClosedYear = closedYearsWithData[0] || null;
  const recentClosedData = recentClosedYear ? portfolio.byTaxYear[recentClosedYear] : null;

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
      // Current tax year — the live one we're IN right now
      currentYearData
        ? statTile(`Net realised ${currentTaxYear}`,
            formatCurrency(currentYearData.netGbp, 'GBP'),
            'current tax year',
            currentYearData.netGbp >= 0 ? 'gain' : 'loss')
        : statTile(`Net realised ${currentTaxYear}`,
            formatCurrency(0, 'GBP'),
            'no disposals this tax year'),
      // Most recent CLOSED year if it had activity — still relevant because
      // Self Assessment deadlines mean you're probably still doing paperwork on it
      recentClosedData
        ? statTile(`Net realised ${recentClosedYear}`,
            formatCurrency(recentClosedData.netGbp, 'GBP'),
            'closed year — for Self Assessment',
            recentClosedData.netGbp >= 0 ? 'gain' : 'loss')
        : null,
    ),
  );

  // If we have a closed year with reportable activity, offer a direct
  // action to generate the SA108 summary — visible on Dashboard so it's
  // impossible to miss when Self Assessment season comes around.
  if (recentClosedData && recentClosedData.disposals.length > 0) {
    mount.append(
      el('div', {
        style: {
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          padding: 'var(--space-3) var(--space-4)',
          background: 'var(--accent-wash)',
          border: '1px solid var(--accent-ring)',
          borderRadius: 'var(--radius-md)',
          marginBottom: 'var(--space-4)',
          fontSize: 'var(--f-sm)',
          gap: 'var(--space-3)',
          flexWrap: 'wrap',
        },
      },
        el('div', {},
          el('strong', {}, `Self Assessment ${recentClosedYear}`),
          el('span', { class: 'text-muted' },
            ` — ${recentClosedData.disposals.length} disposals, net ${formatCurrency(recentClosedData.netGbp, 'GBP')}. Deadline 31 January ${parseInt(recentClosedYear.split('-')[0], 10) + 2}.`),
        ),
        el('button', {
          class: 'button button-sm',
          onclick: () => {
            location.hash = `#/print?year=${encodeURIComponent(recentClosedYear)}`;
          },
        }, 'Print summary →'),
      ),
    );
  }

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
  const valueClass = tone === 'gain' ? 'gain' : tone === 'loss' ? 'loss' : tone === 'warn' ? 'warn' : '';
  const tileClass = tone ? `stat-tile stat-tile--${tone}` : 'stat-tile';
  return el('div', { class: tileClass },
    el('div', { class: 'stat-tile__label' }, label),
    el('div', { class: `stat-tile__value ${valueClass}` }, value),
    sub ? el('div', { class: 'stat-tile__sub' }, sub) : null,
  );
}

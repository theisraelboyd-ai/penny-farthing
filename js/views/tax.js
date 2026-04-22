/* Tax view — placeholder, full implementation comes Day 3
 * Will include: per-year gain/loss summary, HMRC-ready printout, SED scenario table.
 */

import { el } from '../ui.js';
import { getAll, get } from '../storage/indexeddb.js';
import { ukTaxYear } from '../storage/schema.js';

export async function renderTax(mount) {
  const txns = await getAll('transactions');
  const currentYear = ukTaxYear(new Date());
  const yearSettings = await get('taxYears', currentYear);

  const page = el('section', { class: 'ledger-page' },
    el('div', { class: 'ledger-page__heading' },
      el('h2', {}, 'Tax position'),
      el('span', { class: 'ledger-page__folio' }, `${currentYear}`),
    ),

    el('div', { class: 'stat-row' },
      el('span', { class: 'stat-row__label' }, 'Transactions this year'),
      el('span', { class: 'stat-row__value' },
        String(txns.filter((t) => t.taxYear === currentYear).length)),
    ),
    el('div', { class: 'stat-row' },
      el('span', { class: 'stat-row__label' }, 'SED status'),
      el('span', { class: 'stat-row__value' },
        (yearSettings?.sedStatus || 'not set').replace('-', ' ')),
    ),
    el('div', { class: 'stat-row' },
      el('span', { class: 'stat-row__label' }, 'Non-SED income'),
      el('span', { class: 'stat-row__value' },
        yearSettings?.nonSedTaxableIncome != null
          ? `£${yearSettings.nonSedTaxableIncome.toLocaleString('en-GB')}`
          : '—'),
    ),
  );

  const note = el('section', { class: 'ledger-page' },
    el('div', { class: 'ledger-page__heading' },
      el('h2', {}, 'Coming in Day 3'),
      el('span', { class: 'ledger-page__folio' }, 'Roadmap'),
    ),
    el('ul', {},
      el('li', {}, 'Section 104 pooled gain/loss by asset'),
      el('li', {}, 'Same-day and 30-day matching rules'),
      el('li', {}, 'FX-converted gains at transaction date'),
      el('li', {}, '"If sold now" after-tax calculator'),
      el('li', {}, 'Side-by-side SED-success vs SED-fail scenarios'),
      el('li', {}, 'Print-friendly HMRC summary'),
    ),
  );

  mount.append(
    el('header', { class: 'view-header' },
      el('h2', {}, 'Tax'),
      el('p', {}, 'CGT position and SED scenario summary for the current year.'),
    ),
    page,
    note,
  );
}

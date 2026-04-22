/* Tax view — realised disposals, per-year CGT position, losses tracker.
 *
 * For each UK tax year with CGT-relevant activity, shows:
 *   - Total proceeds, gains, losses, net position
 *   - CGT allowance status (£3,000 for 2024-25 onwards)
 *   - Losses brought forward (if set in Settings)
 *   - Taxable net after allowance + losses
 *   - Estimated CGT under both SED scenarios (basic/higher rate)
 *
 * Below the summary: every disposal in chronological order, with the
 * matching rule that HMRC applied (same-day / 30-day / S.104) and a
 * clickable breakdown.
 *
 * ISA and SIPP disposals are excluded from CGT calculations but listed
 * informationally.
 */

import { el, formatCurrency, formatDate } from '../ui.js';
import { computePortfolio } from '../engine/portfolio.js';
import { get } from '../storage/indexeddb.js';
import { ukTaxYear } from '../storage/schema.js';

// HMRC CGT constants for tax years 2024-25 onward
const ANNUAL_EXEMPT_AMOUNT = 3000;
const CGT_RATE_BASIC  = 0.18;  // 18% on disposals from 30 Oct 2024
const CGT_RATE_HIGHER = 0.24;  // 24% on disposals from 30 Oct 2024
const HIGHER_RATE_THRESHOLD = 50270; // income threshold

export async function renderTax(mount) {
  const portfolio = await computePortfolio();
  const currentYear = ukTaxYear(new Date());

  mount.append(
    el('header', { class: 'view-header' },
      el('h2', {}, 'Tax'),
      el('p', {}, 'Per-year CGT position with SED-aware rate calculations.'),
    ),
  );

  // Gather all tax years that appear in the data
  const yearsWithData = Object.keys(portfolio.byTaxYear).sort().reverse();

  if (yearsWithData.length === 0) {
    mount.append(
      el('section', { class: 'ledger-page' },
        el('div', { class: 'empty-state' },
          el('p', {}, 'No CGT-relevant disposals yet. Once you record a sell transaction in a GIA or Unwrapped account, its gain or loss will appear here.'),
        ),
      ),
    );
    return;
  }

  // Load tax-year settings for all years (SED status, losses carried, etc.)
  const yearSettings = {};
  for (const year of yearsWithData) {
    yearSettings[year] = await get('taxYears', year);
  }

  // Render each year
  for (const year of yearsWithData) {
    const data = portfolio.byTaxYear[year];
    const settings = yearSettings[year];
    mount.append(renderYearCard(year, data, settings, year === currentYear));
  }
}

function renderYearCard(year, data, settings, isCurrent) {
  const sedStatus = settings?.sedStatus || 'pending';
  const nonSedIncome = settings?.nonSedTaxableIncome || 0;
  const lossesBf = settings?.carriedLosses || 0;

  // Compute net position
  const totalGain = data.totalGainGbp;
  const totalLoss = data.totalLossGbp;
  const netGbp = data.netGbp;

  // Apply current-year losses first (they offset same-year gains), then
  // brought-forward losses, then the annual exempt amount, then the rate.
  // This ordering matches HMRC's treatment.

  // Step 1: Net position for the year already nets gains and losses.
  //   If netGbp is negative, there's no CGT due; the net loss becomes
  //   a loss to carry forward.
  //   If netGbp is positive, proceed.

  let taxableAfterLosses = Math.max(0, netGbp);
  let losesBfUsed = 0;
  if (taxableAfterLosses > 0 && lossesBf > 0) {
    losesBfUsed = Math.min(taxableAfterLosses, lossesBf);
    taxableAfterLosses -= losesBfUsed;
  }

  // Step 2: Apply annual exempt amount
  const exemptUsed = Math.min(taxableAfterLosses, ANNUAL_EXEMPT_AMOUNT);
  const taxableAfterAea = taxableAfterLosses - exemptUsed;

  // Step 3: Compute CGT under both SED scenarios
  //   SED success: non-SED income is the basis → probably basic rate
  //   SED fail: full income above threshold → probably higher rate
  const cgtIfSedSucceeds = computeCgt(taxableAfterAea, nonSedIncome);
  // For "SED fails" we assume the user is above the higher-rate threshold.
  // This is the pessimistic scenario — not perfect but informative.
  const cgtIfSedFails = taxableAfterAea * CGT_RATE_HIGHER;

  // Net loss position (if negative) becomes loss-to-carry-forward
  const netLossToCarry = netGbp < 0 ? Math.abs(netGbp) : 0;

  // --- Build the card ---

  const header = el('div', { class: 'ledger-page__heading' },
    el('h2', {}, `Tax year ${year}`),
    el('span', { class: 'pill' + (isCurrent ? ' pill--accent' : '') },
      isCurrent ? 'Current' : 'Closed'),
  );

  const sedBadge = el('span',
    { class: 'pill ' + (sedStatus === 'claimed' ? 'pill--gain' : sedStatus === 'not-eligible' ? 'pill--loss' : '') },
    `SED: ${sedStatus.replace('-', ' ')}`);

  // Summary stat strip — proceeds, gains, losses, net
  const summary = el('div', { class: 'stat-grid', style: { marginBottom: 'var(--space-4)' } },
    stat('Proceeds', formatCurrency(data.proceedsGbp, 'GBP'),
      `${data.disposals.length} disposal${data.disposals.length === 1 ? '' : 's'}`),
    stat('Gains', formatCurrency(totalGain, 'GBP'), null, totalGain > 0 ? 'gain' : null),
    stat('Losses', formatCurrency(totalLoss, 'GBP'), null, totalLoss > 0 ? 'loss' : null),
    stat('Net', formatCurrency(netGbp, 'GBP'), null,
      netGbp > 0 ? 'gain' : netGbp < 0 ? 'loss' : null),
  );

  // CGT computation breakdown
  const breakdown = el('table', { class: 'hairline-table', style: { marginTop: 'var(--space-4)' } },
    el('tbody', {},
      row('Net gain/loss for the year', netGbp, { tone: netGbp < 0 ? 'loss' : netGbp > 0 ? 'gain' : null }),
      lossesBf > 0 && netGbp > 0
        ? row(`Losses brought forward used`, -losesBfUsed)
        : null,
      netGbp > 0 ? row('Annual exempt amount', -exemptUsed) : null,
      netGbp > 0
        ? row('Taxable amount', taxableAfterAea, { emphasise: true })
        : null,
      netGbp < 0
        ? row('Loss to carry forward', netLossToCarry, { tone: 'loss', emphasise: true })
        : null,
    ),
  );

  // SED scenario display (only if taxable > 0)
  let sedScenarios = null;
  if (taxableAfterAea > 0) {
    sedScenarios = el('div', { style: { marginTop: 'var(--space-4)' } },
      el('h3', { style: { fontSize: 'var(--f-md)', marginBottom: 'var(--space-2)' } },
        'Estimated CGT under SED scenarios'),
      el('table', { class: 'hairline-table' },
        el('thead', {},
          el('tr', {},
            el('th', {}, 'Scenario'),
            el('th', {}, 'Applicable rate'),
            el('th', { class: 'num' }, 'Estimated CGT'),
          ),
        ),
        el('tbody', {},
          el('tr', {},
            el('td', {}, 'If SED claim succeeds'),
            el('td', {}, `${(cgtIfSedSucceeds.effectiveRate * 100).toFixed(1)}% effective`),
            el('td', { class: 'num loss' }, formatCurrency(cgtIfSedSucceeds.total, 'GBP')),
          ),
          el('tr', {},
            el('td', {}, 'If SED claim fails'),
            el('td', {}, `${(CGT_RATE_HIGHER * 100).toFixed(0)}% (higher rate)`),
            el('td', { class: 'num loss' }, formatCurrency(cgtIfSedFails, 'GBP')),
          ),
          el('tr', {},
            el('td', { style: { fontWeight: '500' } }, 'Difference'),
            el('td', {}, ''),
            el('td', { class: 'num', style: { fontWeight: '500' } },
              formatCurrency(cgtIfSedFails - cgtIfSedSucceeds.total, 'GBP')),
          ),
        ),
      ),
      el('p', { class: 'form-group__hint', style: { marginTop: 'var(--space-3)' } },
        `Assumes non-SED income of ${formatCurrency(nonSedIncome, 'GBP')}. Adjust in Settings → Seafarer status.`),
    );
  }

  // Disposals list — collapsible, scroll if many
  const disposalsList = el('section', { style: { marginTop: 'var(--space-5)' } },
    el('h3', { style: { fontSize: 'var(--f-md)', marginBottom: 'var(--space-3)' } },
      `Disposals (${data.disposals.length})`),
    el('table', { class: 'hairline-table' },
      el('thead', {},
        el('tr', {},
          el('th', {}, 'Date'),
          el('th', {}, 'Asset'),
          el('th', {}, 'Rule'),
          el('th', { class: 'num' }, 'Proceeds'),
          el('th', { class: 'num' }, 'Cost'),
          el('th', { class: 'num' }, 'Gain/Loss'),
        ),
      ),
      el('tbody', {},
        ...data.disposals.map((d) => {
          const tone = d.gainGbp >= 0 ? 'gain' : 'loss';
          // Determine dominant rule (the rule that matched the most quantity)
          const ruleTotals = {};
          for (const m of (d.matches || [])) {
            ruleTotals[m.rule] = (ruleTotals[m.rule] || 0) + (m.quantity || 0);
          }
          const dominantRule = Object.entries(ruleTotals).sort((a, b) => b[1] - a[1])[0]?.[0] || '—';
          const ruleLabel = {
            'same-day': 'Same day',
            '30-day': '30-day B&B',
            's104': 'S.104 pool',
          }[dominantRule] || dominantRule;

          return el('tr', {},
            el('td', {}, formatDate(d.date)),
            el('td', {},
              el('div', { style: { fontWeight: '500' } }, d.assetTicker || '—'),
              el('div', { class: 'text-faint', style: { fontSize: '0.7rem' } },
                `${d.accountName} · ${d.wrapper}`),
            ),
            el('td', {}, el('span', { class: 'pill' }, ruleLabel)),
            el('td', { class: 'num' }, formatCurrency(d.proceedsNetGbp, 'GBP')),
            el('td', { class: 'num' }, formatCurrency(d.allowableCostGbp, 'GBP')),
            el('td', { class: `num ${tone}`, style: { fontWeight: '500' } },
              (d.gainGbp >= 0 ? '+' : '') + formatCurrency(d.gainGbp, 'GBP')),
          );
        }),
      ),
    ),
  );

  return el('section', { class: 'ledger-page' },
    header,
    el('div', { style: { marginBottom: 'var(--space-3)' } }, sedBadge),
    summary,
    breakdown,
    sedScenarios,
    disposalsList,
  );
}

/**
 * Compute CGT given a taxable gain and the user's non-SED taxable income.
 * Respects the band boundary — part of the gain may fall at basic, part at higher.
 */
function computeCgt(taxableGain, nonSedIncome) {
  if (taxableGain <= 0) return { total: 0, effectiveRate: 0 };

  const remainingBasicRoom = Math.max(0, HIGHER_RATE_THRESHOLD - nonSedIncome);
  const atBasic = Math.min(taxableGain, remainingBasicRoom);
  const atHigher = taxableGain - atBasic;
  const total = atBasic * CGT_RATE_BASIC + atHigher * CGT_RATE_HIGHER;
  const effectiveRate = total / taxableGain;
  return { total, effectiveRate, atBasic, atHigher };
}

function stat(label, value, sub, tone) {
  const valueClass = tone === 'gain' ? 'gain' : tone === 'loss' ? 'loss' : '';
  return el('div', { class: 'stat-tile' },
    el('div', { class: 'stat-tile__label' }, label),
    el('div', { class: `stat-tile__value ${valueClass}` }, value),
    sub ? el('div', { class: 'stat-tile__sub' }, sub) : null,
  );
}

function row(label, amount, options = {}) {
  const { tone, emphasise } = options;
  const toneClass = tone === 'gain' ? 'gain' : tone === 'loss' ? 'loss' : '';
  const fontWeight = emphasise ? '600' : 'normal';
  return el('tr', {},
    el('td', { style: { fontWeight: emphasise ? '500' : 'normal' } }, label),
    el('td', { class: `num ${toneClass}`, style: { fontWeight } },
      (amount >= 0 ? '' : '') + formatCurrency(amount, 'GBP')),
  );
}

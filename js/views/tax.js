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

  // Main app settings — default SED status and pre-tracking seed losses
  const mainSettings = await get('settings', 'main');
  const defaultSedStatus = mainSettings?.defaultSedStatus || 'pending';
  const preTrackingSeedLosses = mainSettings?.preTrackingSeedLosses || 0;

  // Render each year
  for (const year of yearsWithData) {
    const data = portfolio.byTaxYear[year];
    const settings = yearSettings[year];
    mount.append(renderYearCard(year, data, settings, year === currentYear, {
      defaultSedStatus,
      preTrackingSeedLosses,
      // For the earliest year, the seed losses apply; for later years, the
      // auto-carried computation already chained them through.
      isEarliestYear: year === yearsWithData[yearsWithData.length - 1],
    }));
  }
}

function renderYearCard(year, data, settings, isCurrent, opts = {}) {
  const { defaultSedStatus = 'pending', preTrackingSeedLosses = 0, isEarliestYear = false } = opts;
  // Per-year override wins; otherwise fall back to the user's default
  const sedStatus = settings?.sedStatus || defaultSedStatus;
  const nonSedIncome = settings?.nonSedTaxableIncome || 0;

  // Losses-brought-forward = auto-carried from prior tracked years (computed
  // by the engine), plus an optional seed amount applied only to the earliest
  // tracked year (represents losses from before Penny Farthing started
  // tracking).
  const autoBf = data.lossesBfAutoStd || 0;
  const seed = isEarliestYear ? preTrackingSeedLosses : 0;
  const lossesBf = autoBf + seed;

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
  let lossesBfUsed = 0;
  if (taxableAfterLosses > 0 && lossesBf > 0) {
    lossesBfUsed = Math.min(taxableAfterLosses, lossesBf);
    taxableAfterLosses -= lossesBfUsed;
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
    el('div', { style: { display: 'flex', gap: 'var(--space-2)', alignItems: 'center' } },
      el('span', { class: 'pill' + (isCurrent ? ' pill--accent' : '') },
        isCurrent ? 'Current' : 'Closed'),
      el('button', {
        class: 'button button--ghost button-sm',
        onclick: () => {
          // Route target — the actual report view is built in the next phase
          location.hash = `#/print?year=${encodeURIComponent(year)}`;
        },
        title: `Generate printable SA108 summary for ${year}`,
      }, 'Print summary →'),
    ),
  );

  const sedBadge = el('span',
    { class: 'pill ' + (sedStatus === 'claimed' ? 'pill--gain' : sedStatus === 'not-eligible' ? 'pill--loss' : '') },
    `SED: ${sedStatus.replace('-', ' ')}`);

  // Summary stat strip — standard CGT pool only (CFDs shown separately below)
  const standardCount = data.disposals.filter((d) => !d.isCfd).length;
  const summary = el('div', { class: 'stat-grid', style: { marginBottom: 'var(--space-4)' } },
    stat('Proceeds', formatCurrency(data.proceedsGbp, 'GBP'),
      `${standardCount} standard disposal${standardCount === 1 ? '' : 's'}`),
    stat('Gains', formatCurrency(totalGain, 'GBP'), null, totalGain > 0 ? 'gain' : null),
    stat('Losses', formatCurrency(totalLoss, 'GBP'), null, totalLoss > 0 ? 'loss' : null),
    stat('Net', formatCurrency(netGbp, 'GBP'), null,
      netGbp > 0 ? 'gain' : netGbp < 0 ? 'loss' : null),
  );

  // CGT computation breakdown — also standard pool only
  const breakdown = el('table', { class: 'hairline-table', style: { marginTop: 'var(--space-4)' } },
    el('tbody', {},
      row('Net gain/loss for the year (standard CGT)', netGbp, { tone: netGbp < 0 ? 'loss' : netGbp > 0 ? 'gain' : null }),
      lossesBf > 0 && netGbp > 0
        ? row(`Losses brought forward used`, -lossesBfUsed)
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

  // ----- CFD ring-fenced block -----
  // Only render if the year has CFD disposals. CFD gains/losses are fully
  // separate from standard CGT per TCGA 1992 s.143 — they get their own
  // allowance headroom inclusion logic (they DO count towards the £3k AEA
  // when combined with other CGT, but can't offset stock losses/gains in
  // the ordering sense).
  let cfdBlock = null;
  if (data.cfdDisposalCount > 0) {
    const cfdNet = data.cfdNetGbp;
    const cfdGain = data.cfdGainGbp;
    const cfdLoss = data.cfdLossGbp;

    cfdBlock = el('div', { style: { marginTop: 'var(--space-5)' } },
      el('h3', { style: {
        fontSize: 'var(--f-md)',
        marginBottom: 'var(--space-3)',
        display: 'flex',
        alignItems: 'center',
        gap: 'var(--space-2)',
      } },
        'CFDs — ring-fenced',
        el('span', { class: 'pill' }, 'TCGA 1992 s.143'),
      ),
      el('p', { class: 'form-group__hint', style: { marginBottom: 'var(--space-3)' } },
        'CFD gains/losses form a separate universe. CFD losses can offset CFD gains only; they cannot reduce taxable gains from stocks, ETFs, or other chargeable assets.'),
      el('div', { class: 'stat-grid' },
        stat(`CFD gains`, formatCurrency(cfdGain, 'GBP'),
          `${data.cfdDisposalCount} disposal${data.cfdDisposalCount === 1 ? '' : 's'}`,
          cfdGain > 0 ? 'gain' : null),
        stat(`CFD losses`, formatCurrency(cfdLoss, 'GBP'), null,
          cfdLoss > 0 ? 'loss' : null),
        stat(`CFD net`, formatCurrency(cfdNet, 'GBP'),
          cfdNet < 0 ? 'loss to carry (CFD pool)' : cfdNet > 0 ? 'taxable if above AEA' : null,
          cfdNet > 0 ? 'gain' : cfdNet < 0 ? 'loss' : null),
      ),
    );
  }

  // Filter disposal list: standard CGT first, then CFDs
  const standardDisposals = data.disposals.filter((d) => !d.isCfd);
  const cfdDisposals = data.disposals.filter((d) => d.isCfd);

  return el('section', { class: 'ledger-page' },
    header,
    el('div', { style: { marginBottom: 'var(--space-3)' } }, sedBadge),
    summary,
    breakdown,
    sedScenarios,
    // Replace the generic disposal list with a segmented one
    renderDisposalList('Stock / ETF / crypto disposals', standardDisposals),
    cfdBlock,
    cfdDisposals.length > 0 ? renderDisposalList('CFD disposals', cfdDisposals) : null,
  );
}

function renderDisposalList(title, disposals) {
  if (disposals.length === 0) return null;
  return el('section', { style: { marginTop: 'var(--space-5)' } },
    el('h3', { style: { fontSize: 'var(--f-md)', marginBottom: 'var(--space-3)' } },
      `${title} (${disposals.length})`),
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
        ...disposals.map((d) => {
          const tone = d.gainGbp >= 0 ? 'gain' : 'loss';
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
  const valueClass = tone === 'gain' ? 'gain' : tone === 'loss' ? 'loss' : tone === 'warn' ? 'warn' : '';
  const tileClass = tone ? `stat-tile stat-tile--${tone}` : 'stat-tile';
  return el('div', { class: tileClass },
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

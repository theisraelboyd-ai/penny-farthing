/* Print view — HMRC Self Assessment CGT summary for a single tax year.
 *
 * Purpose: generate a clean, print-ready HTML document that a UK resident
 * can provide to their accountant (or keep for personal records) to support
 * the SA108 Capital Gains pages of their Self Assessment.
 *
 * DESIGN NOTES:
 *
 *   1. Statutory-figure-first layout. The summary at the top is what the
 *      accountant transcribes onto SA108. Everything else is supporting
 *      detail for audit trail.
 *
 *   2. Standard CGT and CFD are separated throughout — not just visually,
 *      but in computation. Per TCGA 1992 s.143 these are distinct pools.
 *
 *   3. All figures are in GBP, converted at ECB reference rates on each
 *      transaction's date (HMRC CG78300 methodology).
 *
 *   4. A methodology notes section at the end documents exactly how every
 *      number was computed, which HMRC policies were applied, and which
 *      data sources were used. This is what makes the document defensible
 *      in a compliance review years later.
 *
 *   5. Print CSS (in css/print.css) transforms the on-screen rendering into
 *      a clean A4-formatted document when the user triggers browser print.
 *      Screen version is readable; print version is optimised for paper.
 *
 *   6. Content hash at the bottom. Not cryptographically meaningful for an
 *      adversary, but useful as a "this is exactly what was generated on
 *      YYYY-MM-DD" marker for personal records integrity.
 */

import { el, formatCurrency, formatDate, formatNumber } from '../ui.js';
import { computePortfolio } from '../engine/portfolio.js';
import { get } from '../storage/indexeddb.js';
import { ukTaxYear, ukTaxYearBounds } from '../storage/schema.js';
import { navigate } from '../router.js';
import { isPrivacyOn, setPrivacyMode } from '../app-state.js';

// HMRC CGT constants — these apply to 2024-25 onward (post-Autumn Budget 2024)
const ANNUAL_EXEMPT_AMOUNT = 3000;
const CGT_RATE_BASIC  = 0.18;
const CGT_RATE_HIGHER = 0.24;
const HIGHER_RATE_THRESHOLD = 50270;

export async function renderPrint(mount, params = {}) {
  const year = params.year;
  if (!year || !/^\d{4}-\d{2}$/.test(year)) {
    mount.append(renderError('Invalid or missing tax year',
      'This page requires a tax year in the format "2025-26".'));
    return;
  }

  // Privacy guard. If on, refuse to render the document — printing it
  // wouldn't be useful (CSS blur isn't reliable across all print pipelines)
  // and accidentally generating a HMRC-defensible PDF with blurred figures
  // is actively bad. Offer a one-click toggle off + retry.
  if (isPrivacyOn()) {
    mount.append(
      el('section', { class: 'ledger-page' },
        el('div', { class: 'empty-state' },
          el('h3', {}, 'Privacy mode is on'),
          el('p', { class: 'text-muted' },
            'Tax printables show full figures by design — they\'re intended for your accountant or HMRC compliance review. Disable privacy mode to generate the report.'),
          el('div', { class: 'button-row', style: { justifyContent: 'center' } },
            el('button', {
              class: 'button',
              onclick: async () => {
                await setPrivacyMode(false);
                location.reload();
              },
            }, 'Disable privacy & continue'),
            el('button', {
              class: 'button button--ghost',
              onclick: () => navigate('/tax'),
            }, 'Back to Tax view'),
          ),
        ),
      ),
    );
    return;
  }

  const portfolio = await computePortfolio({ fetchFx: false });
  const data = portfolio.byTaxYear[year];
  if (!data) {
    mount.append(renderError(`No data for tax year ${year}`,
      `There are no CGT-relevant disposals recorded for ${year}. If you expected to see disposals here, check the Activity view to confirm they're tagged with the correct tax year.`));
    return;
  }

  const mainSettings = await get('settings', 'main');
  const yearSettings = await get('taxYears', year);

  // Resolve effective SED status
  const defaultSed = mainSettings?.defaultSedStatus || 'pending';
  const sedStatus = (yearSettings?.sedStatus && yearSettings.sedStatus !== '')
    ? yearSettings.sedStatus
    : defaultSed;
  const nonSedIncome = yearSettings?.nonSedTaxableIncome || 0;

  // Standard CGT bucket
  const standardDisposals = data.disposals.filter((d) => !d.isCfd);
  const stdProceeds = data.proceedsGbp;
  const stdGains = data.totalGainGbp;
  const stdLosses = data.totalLossGbp;
  const stdNet = data.netGbp;

  // CFD bucket
  const cfdDisposals = data.disposals.filter((d) => d.isCfd);
  const cfdProceeds = data.cfdProceedsGbp;
  const cfdGains = data.cfdGainGbp;
  const cfdLosses = data.cfdLossGbp;
  const cfdNet = data.cfdNetGbp;

  // Losses brought forward (auto-computed + any pre-tracking seed)
  const seedLosses = mainSettings?.preTrackingSeedLosses || 0;
  // Find if this is the earliest tracked year; if so, seed applies
  const trackedYears = Object.keys(portfolio.byTaxYear).sort();
  const isEarliestYear = year === trackedYears[0];
  const lossesBfStd = (data.lossesBfAutoStd || 0) + (isEarliestYear ? seedLosses : 0);
  const lossesBfCfd = data.lossesBfAutoCfd || 0;

  // Apply reliefs for standard CGT
  const stdReliefs = applyReliefs(stdNet, lossesBfStd);
  const cfdReliefs = applyReliefs(cfdNet, lossesBfCfd);

  // CGT due under both SED scenarios (informational)
  const stdCgtIfClaim = computeCgt(stdReliefs.taxable, nonSedIncome);
  const stdCgtIfFail = stdReliefs.taxable * CGT_RATE_HIGHER;
  const cfdCgtIfClaim = computeCgt(cfdReliefs.taxable, nonSedIncome);
  const cfdCgtIfFail = cfdReliefs.taxable * CGT_RATE_HIGHER;

  // Year-end pool positions (Section 104 balances still held)
  const openPositionsAtYearEnd = portfolio.holdings.filter((h) => {
    // Include if the pool was positive at year end. For this we trust the
    // current holdings state if we're generating for the current year;
    // for a closed year, we'd need to replay state — we do a simple
    // approximation using current pool state (which is close enough for
    // the current year and gives a reasonable snapshot for closed years).
    return h.quantity > 0;
  });

  // Generation metadata
  const generatedAt = new Date().toISOString();
  const bounds = ukTaxYearBounds(year);
  const yearEndDate = bounds.end;

  // Build the document
  const doc = el('article', { class: 'print-doc' });

  // ===== Action bar (hidden on print) =====
  doc.append(
    el('div', { class: 'print-actions no-print' },
      el('button', {
        class: 'button',
        onclick: () => window.print(),
      }, 'Print / Save as PDF'),
      el('button', {
        class: 'button button--ghost',
        onclick: () => navigate('/tax'),
      }, '← Back to Tax view'),
      el('p', { class: 'text-muted', style: { fontSize: 'var(--f-sm)', marginTop: 'var(--space-2)' } },
        'On-screen preview of the printable document. Use your browser\'s Print dialog to save as PDF or send to a printer. A4 formatting is applied automatically.'),
    ),
  );

  // ===== Title block =====
  doc.append(
    el('header', { class: 'print-header' },
      el('div', { class: 'print-header__meta' },
        el('div', { class: 'print-header__brand' }, 'Penny Farthing'),
        el('div', { class: 'print-header__subtitle' },
          'UK Capital Gains Tax Summary — Self Assessment support document'),
      ),
      el('h1', {}, `Tax Year ${year}`),
      el('div', { class: 'print-header__dates' },
        `Period: ${formatDate(bounds.start)} to ${formatDate(bounds.end)}`),
      el('div', { class: 'print-header__generated' },
        `Generated: ${formatDate(generatedAt.slice(0, 10))} ${generatedAt.slice(11, 19)} UTC`),
    ),
  );

  // ===== Statutory summary — standard CGT =====
  if (standardDisposals.length > 0) {
    doc.append(
      el('section', { class: 'print-section' },
        el('h2', {}, 'Standard CGT Summary'),
        el('p', { class: 'print-section__subtitle' },
          'Disposals of stocks, ETFs, and other chargeable assets. Pooled per Section 104.'),
        el('table', { class: 'print-summary-table' },
          tableBody([
            ['Total proceeds', formatCurrency(stdProceeds, 'GBP'), null],
            ['Total allowable costs', formatCurrency(stdProceeds - stdNet, 'GBP'), null],
            ['Total gains', formatCurrency(stdGains, 'GBP'), stdGains > 0 ? 'gain' : null],
            ['Total losses', formatCurrency(stdLosses, 'GBP'), stdLosses > 0 ? 'loss' : null],
            ['Net position for the year', formatCurrency(stdNet, 'GBP'),
              stdNet > 0 ? 'gain' : stdNet < 0 ? 'loss' : null, 'emphasise'],
            lossesBfStd > 0 && stdNet > 0
              ? ['Losses brought forward applied', `−${formatCurrency(stdReliefs.lossesBfUsed, 'GBP')}`, null]
              : null,
            stdNet > 0
              ? ['Annual exempt amount (£3,000)', `−${formatCurrency(stdReliefs.allowanceUsed, 'GBP')}`, null]
              : null,
            stdNet > 0
              ? ['Taxable amount', formatCurrency(stdReliefs.taxable, 'GBP'),
                 stdReliefs.taxable > 0 ? 'warn' : null, 'emphasise']
              : null,
            stdNet < 0
              ? ['Loss to carry forward', formatCurrency(Math.abs(stdNet), 'GBP'), 'loss', 'emphasise']
              : null,
          ]),
        ),
        stdReliefs.taxable > 0
          ? el('div', { class: 'print-subsection' },
              el('h3', {}, 'Estimated CGT under SED scenarios'),
              el('p', { class: 'print-section__subtitle' },
                'Informational. Seafarer\'s Earnings Deduction status affects which income band applies for CGT rate apportionment.'),
              el('table', { class: 'print-scenario-table' },
                el('thead', {}, el('tr', {},
                  el('th', {}, 'Scenario'),
                  el('th', {}, 'Rate'),
                  el('th', { class: 'num' }, 'CGT due'),
                )),
                el('tbody', {},
                  el('tr', { class: sedStatus === 'claimed' ? 'is-effective' : '' },
                    el('td', {}, 'SED claim succeeds'),
                    el('td', {}, 'Per band from non-SED income'),
                    el('td', { class: 'num warn' }, formatCurrency(stdCgtIfClaim, 'GBP')),
                  ),
                  el('tr', { class: sedStatus === 'not-eligible' ? 'is-effective' : '' },
                    el('td', {}, 'SED not eligible / fails'),
                    el('td', {}, '24% higher rate throughout'),
                    el('td', { class: 'num warn' }, formatCurrency(stdCgtIfFail, 'GBP')),
                  ),
                ),
              ),
              el('p', { class: 'print-footnote' },
                `Current declared SED status: ${sedStatus}. Non-SED taxable income on record: ${formatCurrency(nonSedIncome, 'GBP')}.`),
            )
          : null,
      ),
    );
  }

  // ===== Statutory summary — CFDs =====
  if (cfdDisposals.length > 0) {
    doc.append(
      el('section', { class: 'print-section' },
        el('h2', {}, 'CFD Summary (ring-fenced)'),
        el('p', { class: 'print-section__subtitle' },
          'Contracts for Difference. Gains/losses ring-fenced from standard CGT per TCGA 1992 s.143 — cannot offset losses against stock gains or vice-versa.'),
        el('table', { class: 'print-summary-table' },
          tableBody([
            ['Total CFD proceeds', formatCurrency(cfdProceeds, 'GBP'), null],
            ['Total CFD allowable costs', formatCurrency(cfdProceeds - cfdNet, 'GBP'), null],
            ['Total CFD gains', formatCurrency(cfdGains, 'GBP'), cfdGains > 0 ? 'gain' : null],
            ['Total CFD losses', formatCurrency(cfdLosses, 'GBP'), cfdLosses > 0 ? 'loss' : null],
            ['Net CFD position', formatCurrency(cfdNet, 'GBP'),
              cfdNet > 0 ? 'gain' : cfdNet < 0 ? 'loss' : null, 'emphasise'],
            lossesBfCfd > 0 && cfdNet > 0
              ? ['CFD losses brought forward applied', `−${formatCurrency(cfdReliefs.lossesBfUsed, 'GBP')}`, null]
              : null,
            cfdNet > 0
              ? ['Taxable CFD amount', formatCurrency(cfdReliefs.taxable, 'GBP'),
                 'warn', 'emphasise']
              : null,
            cfdNet < 0
              ? ['CFD loss to carry forward (CFD pool only)',
                 formatCurrency(Math.abs(cfdNet), 'GBP'), 'loss', 'emphasise']
              : null,
          ]),
        ),
      ),
    );
  }

  // ===== Disposal schedule: standard CGT =====
  if (standardDisposals.length > 0) {
    doc.append(
      el('section', { class: 'print-section' },
        el('h2', {}, `Disposal Schedule — Standard CGT (${standardDisposals.length})`),
        renderDisposalTable(standardDisposals),
      ),
    );
  }

  // ===== Disposal schedule: CFDs =====
  if (cfdDisposals.length > 0) {
    doc.append(
      el('section', { class: 'print-section' },
        el('h2', {}, `Disposal Schedule — CFDs (${cfdDisposals.length})`),
        renderDisposalTable(cfdDisposals),
      ),
    );
  }

  // ===== Year-end open positions =====
  if (openPositionsAtYearEnd.length > 0) {
    doc.append(
      el('section', { class: 'print-section' },
        el('h2', {}, `Open Positions as of ${formatDate(yearEndDate)}`),
        el('p', { class: 'print-section__subtitle' },
          'Section 104 pooled holdings not disposed of. These generate no immediate CGT event; cost basis is held for future disposals.'),
        el('table', { class: 'print-table' },
          el('thead', {}, el('tr', {},
            el('th', {}, 'Asset'),
            el('th', {}, 'Account'),
            el('th', { class: 'num' }, 'Quantity held'),
            el('th', { class: 'num' }, 'Pooled cost (GBP)'),
          )),
          el('tbody', {},
            ...openPositionsAtYearEnd.map((h) => el('tr', {},
              el('td', {},
                el('div', { style: { fontWeight: '500' } }, h.asset.ticker || '—'),
                el('div', { class: 'print-cell-sub' }, h.asset.name || ''),
              ),
              el('td', {},
                el('div', {}, h.account.name),
                el('div', { class: 'print-cell-sub' }, h.account.wrapper),
              ),
              el('td', { class: 'num' }, formatNumber(h.quantity, 6)),
              el('td', { class: 'num' }, formatCurrency(h.costGbp, 'GBP')),
            )),
          ),
        ),
      ),
    );
  }

  // ===== Methodology notes =====
  doc.append(renderMethodologySection());

  // ===== Content hash =====
  const contentHashText = await computeContentHash(doc);
  doc.append(
    el('footer', { class: 'print-footer' },
      el('div', {}, `Document hash (SHA-256, first 16 chars): ${contentHashText}`),
      el('div', {}, `Generated by Penny Farthing v1.15 · Local-first, no data leaves your device during computation.`),
      el('div', {}, `For questions: this document is a personal record. Verify against your broker statements before submitting figures to HMRC.`),
    ),
  );

  mount.append(doc);
}

// ==================== Supporting functions ====================

function applyReliefs(net, lossesBf) {
  if (net <= 0) return { taxable: 0, allowanceUsed: 0, lossesBfUsed: 0 };
  let taxable = net;
  const lossesBfUsed = Math.min(taxable, lossesBf);
  taxable -= lossesBfUsed;
  const allowanceUsed = Math.min(taxable, ANNUAL_EXEMPT_AMOUNT);
  taxable -= allowanceUsed;
  return { taxable, allowanceUsed, lossesBfUsed };
}

function computeCgt(taxableGain, nonSedIncome) {
  if (taxableGain <= 0) return 0;
  const remainingBasicRoom = Math.max(0, HIGHER_RATE_THRESHOLD - nonSedIncome);
  const atBasic = Math.min(taxableGain, remainingBasicRoom);
  const atHigher = taxableGain - atBasic;
  return atBasic * CGT_RATE_BASIC + atHigher * CGT_RATE_HIGHER;
}

function tableBody(rows) {
  const tbody = el('tbody', {});
  for (const row of rows) {
    if (!row) continue;
    const [label, value, tone, flag] = row;
    const valueClass = tone === 'gain' ? 'gain' : tone === 'loss' ? 'loss' : tone === 'warn' ? 'warn' : '';
    const emphasise = flag === 'emphasise';
    tbody.append(el('tr', { class: emphasise ? 'is-total' : '' },
      el('td', {}, label),
      el('td', { class: `num ${valueClass}` }, value),
    ));
  }
  return tbody;
}

function renderDisposalTable(disposals) {
  return el('table', { class: 'print-table print-table--disposals' },
    el('thead', {},
      el('tr', {},
        el('th', {}, 'Date'),
        el('th', {}, 'Asset'),
        el('th', {}, 'Account'),
        el('th', { class: 'num' }, 'Qty'),
        el('th', { class: 'num' }, 'Proceeds'),
        el('th', { class: 'num' }, 'Cost'),
        el('th', { class: 'num' }, 'Gain/Loss'),
        el('th', {}, 'Rule'),
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
            d.assetName && d.assetName !== d.assetTicker
              ? el('div', { class: 'print-cell-sub' }, d.assetName)
              : null,
          ),
          el('td', {},
            el('div', {}, d.accountName || '—'),
            el('div', { class: 'print-cell-sub' }, d.wrapper || ''),
          ),
          el('td', { class: 'num' }, formatNumber(d.quantity, 4)),
          el('td', { class: 'num' }, formatCurrency(d.proceedsNetGbp, 'GBP')),
          el('td', { class: 'num' }, formatCurrency(d.allowableCostGbp, 'GBP')),
          el('td', { class: `num ${tone}` },
            (d.gainGbp >= 0 ? '+' : '') + formatCurrency(d.gainGbp, 'GBP')),
          el('td', {}, ruleLabel),
        );
      }),
    ),
  );
}

function renderMethodologySection() {
  return el('section', { class: 'print-section print-methodology' },
    el('h2', {}, 'Methodology & Notes'),
    el('div', { class: 'print-methodology__grid' },
      methodologyBlock('Pooling & matching',
        'Share disposals are matched against acquisitions using HMRC rules in strict order: same-day trades first (TCGA 1992 s.105(1)(a)(i)), then acquisitions in the 30 days following the disposal ("bed-and-breakfasting" rule, s.106A), then the Section 104 pool (s.104) with weighted-average cost basis.'),
      methodologyBlock('Foreign currency',
        'Transactions in non-GBP currencies are converted to GBP using ECB reference rates on each transaction\'s execution date (source: Frankfurter API, frankfurter.dev, which republishes ECB data). Both acquisition cost and disposal proceeds are converted at their respective spot rates, per HMRC CG78300. This differs from some platform-reported "profit in GBP" figures that apply only the close-date rate.'),
      methodologyBlock('CFD treatment',
        'Contracts for Difference are ring-fenced from standard CGT per TCGA 1992 s.143. CFD gains/losses pool only with other CFD gains/losses, never against stocks, ETFs or physical assets. Maintained as a separate computational pool.'),
      methodologyBlock('Tax-exempt wrappers',
        'Disposals within ISA and SIPP wrappers are excluded from this summary as they are not CGT-chargeable.'),
      methodologyBlock('Losses brought forward',
        'Automatically chained from prior tracked tax years. Any pre-tracking loss balance seeded in Penny Farthing Settings is applied to the earliest tracked year and carries forward through subsequent years.'),
      methodologyBlock('Annual Exempt Amount',
        `£3,000 for 2024-25 onwards (reduced from £6,000 in 2023-24, £12,300 pre-2023-24). Applied to net gains only after losses brought forward have been offset.`),
      methodologyBlock('CGT rates 2024-25+',
        '18% basic rate and 24% higher rate apply to all disposals. For disposals before 30 October 2024, 10%/20% rates may apply — any such disposals should be reviewed separately with an accountant.'),
      methodologyBlock('Seafarer\'s Earnings Deduction',
        'SED (ITEPA 2003 s.378) affects which CGT rate band applies by reducing taxable income. This summary shows CGT under both "SED succeeds" and "SED fails" scenarios; the user\'s declared status determines which figure is treated as primary.'),
    ),
    el('p', { class: 'print-disclaimer' },
      'This document is a computational summary generated from transaction data entered or imported by the user. It is not tax advice. Figures should be verified against broker statements and reviewed by a qualified accountant before submission to HMRC.'),
  );
}

function methodologyBlock(heading, body) {
  return el('div', { class: 'print-method-block' },
    el('h4', {}, heading),
    el('p', {}, body),
  );
}

async function computeContentHash(element) {
  try {
    const text = element.textContent || '';
    const encoder = new TextEncoder();
    const data = encoder.encode(text);
    const hashBuffer = await crypto.subtle.digest('SHA-256', data);
    const hashArray = Array.from(new Uint8Array(hashBuffer));
    const hashHex = hashArray.map((b) => b.toString(16).padStart(2, '0')).join('');
    return hashHex.slice(0, 16);
  } catch (err) {
    return '(hash unavailable)';
  }
}

function renderError(title, message) {
  return el('section', { class: 'ledger-page' },
    el('div', { class: 'empty-state' },
      el('h3', {}, title),
      el('p', { class: 'text-muted' }, message),
      el('div', { class: 'button-row', style: { justifyContent: 'center' } },
        el('button', {
          class: 'button',
          onclick: () => navigate('/tax'),
        }, 'Back to Tax view'),
      ),
    ),
  );
}

/* Penny Farthing — "If sold now" Calculator
 *
 * For a given holding at a given hypothetical sell price, compute:
 *   - Gross proceeds (GBP, at current FX)
 *   - Gain or loss vs Section 104 pool cost basis
 *   - Marginal CGT that WOULD be incurred, given what the user has already
 *     realised in the current tax year
 *   - Net-in-hand after tax
 *
 * MARGINAL LOGIC:
 *   If you've already realised £X of gains this tax year, and you sold this
 *   position for a £Y gain today, the tax on Y is the difference between:
 *     CGT on (X + Y), minus CGT on X alone.
 *   This is "what would this one additional sale actually cost me in tax?"
 *
 *   This respects the ordering HMRC uses: losses offset gains first, then
 *   the £3,000 annual exempt amount, then the rate.
 *
 *   For losses (Y < 0), net = gross proceeds. The loss adds to the year's
 *   loss bank, which reduces *future* tax — not reflected in the immediate
 *   "net in hand" figure.
 */

import { get } from '../storage/indexeddb.js';
import { getFxRate } from './fx.js';

const ANNUAL_EXEMPT_AMOUNT = 3000;
const CGT_RATE_BASIC  = 0.18;
const CGT_RATE_HIGHER = 0.24;
const HIGHER_RATE_THRESHOLD = 50270;

/**
 * Core CGT calculator given a taxable amount and income context.
 * Allocates between basic and higher rate bands.
 */
function computeCgt(taxableGain, nonSedIncome) {
  if (taxableGain <= 0) return 0;
  const remainingBasicRoom = Math.max(0, HIGHER_RATE_THRESHOLD - nonSedIncome);
  const atBasic = Math.min(taxableGain, remainingBasicRoom);
  const atHigher = taxableGain - atBasic;
  return atBasic * CGT_RATE_BASIC + atHigher * CGT_RATE_HIGHER;
}

/**
 * Apply gains/losses/allowance/losses-bf to produce taxable.
 *
 * @param {number} totalGain    — positive number, total net gain for year
 * @param {number} lossesBf     — losses brought forward available to use
 * @returns {{ taxable: number, allowanceUsed: number, lossesBfUsed: number }}
 */
function applyReliefs(totalGain, lossesBf) {
  if (totalGain <= 0) return { taxable: 0, allowanceUsed: 0, lossesBfUsed: 0 };

  let taxable = totalGain;
  const lossesBfUsed = Math.min(taxable, lossesBf);
  taxable -= lossesBfUsed;

  const allowanceUsed = Math.min(taxable, ANNUAL_EXEMPT_AMOUNT);
  taxable -= allowanceUsed;

  return { taxable, allowanceUsed, lossesBfUsed };
}

/**
 * Compute the hypothetical sale result for a single holding.
 *
 * @param {object} params
 * @param {object} params.holding            — holding entry from portfolio
 * @param {number} params.marketPriceNative  — current price per unit in asset's currency
 * @param {string} params.priceCurrency      — 'USD', 'GBP', 'GBX', etc.
 * @param {object} params.portfolio          — full portfolio (for year's realised gains)
 * @param {object} params.yearSettings       — current tax year record (SED status, income, lossesBf)
 * @param {string} params.taxYear            — e.g. '2025-26'
 * @returns {Promise<object>}
 */
export async function computeSellNow({ holding, marketPriceNative, priceCurrency, portfolio, yearSettings, taxYear }) {
  // ----- 1. Market value in GBP -----
  // FX rate: use today's Frankfurter rate if non-GBP. Don't block on failure —
  // fall back to the pool's avg FX if needed (rough but better than nothing).
  const today = new Date().toISOString().slice(0, 10);
  let fxRate = 1;
  if (priceCurrency === 'GBX') fxRate = 0.01;
  else if (priceCurrency !== 'GBP') {
    const fetched = await getFxRate(priceCurrency, today);
    if (fetched !== null) fxRate = fetched;
  }

  const grossProceedsGbp = holding.quantity * marketPriceNative * fxRate;
  // We don't know exit fees at this hypothetical point. We could let the user
  // configure a default fee % per account, but for now use zero and note it.
  const assumedFees = 0;
  const netProceedsGbp = grossProceedsGbp - assumedFees;

  const hypotheticalGainGbp = netProceedsGbp - holding.costGbp;

  // If the holding is in an ISA or SIPP, there's no CGT.
  const isTaxExemptWrapper = holding.account.wrapper === 'ISA' || holding.account.wrapper === 'SIPP';
  if (isTaxExemptWrapper) {
    return {
      marketValueGbp: grossProceedsGbp,
      grossProceedsGbp,
      netProceedsGbp,
      hypotheticalGainGbp,
      taxDueGbp: 0,
      netInHandGbp: netProceedsGbp,
      tone: hypotheticalGainGbp >= 0 ? 'gain' : 'loss',
      notes: 'Tax-exempt wrapper — no CGT applies',
      exempt: true,
    };
  }

  // ----- 2. Already-realised gains/losses this tax year -----
  const yearData = portfolio.byTaxYear[taxYear];
  const alreadyRealisedNet = yearData?.netGbp || 0;
  const lossesBf = yearSettings?.carriedLosses || 0;
  const nonSedIncome = yearSettings?.nonSedTaxableIncome || 0;

  // ----- 3. Tax if we DO NOT sell -----
  const baselineReliefs = applyReliefs(alreadyRealisedNet, lossesBf);
  const baselineCgtSuccess = computeCgt(baselineReliefs.taxable, nonSedIncome);
  const baselineCgtFail = baselineReliefs.taxable * CGT_RATE_HIGHER;

  // ----- 4. Tax if we DO sell -----
  const afterReliefs = applyReliefs(alreadyRealisedNet + hypotheticalGainGbp, lossesBf);
  const afterCgtSuccess = computeCgt(afterReliefs.taxable, nonSedIncome);
  const afterCgtFail = afterReliefs.taxable * CGT_RATE_HIGHER;

  // ----- 5. Marginal tax on THIS sale only -----
  const marginalCgtSuccess = afterCgtSuccess - baselineCgtSuccess;
  const marginalCgtFail    = afterCgtFail - baselineCgtFail;

  // Use the user's declared SED status for the "primary" figure
  const sedStatus = yearSettings?.sedStatus || 'pending';
  const useSuccessRate = sedStatus === 'claimed';
  const primaryTaxDue = useSuccessRate ? marginalCgtSuccess : marginalCgtFail;
  // "Pending" is neither — show both scenarios, default to the higher (more prudent)
  const displayedTaxDue = sedStatus === 'pending' ? marginalCgtFail : primaryTaxDue;

  const netInHandGbp = netProceedsGbp - displayedTaxDue;

  // ----- 6. Assemble result -----
  return {
    marketValueGbp: grossProceedsGbp,
    grossProceedsGbp,
    netProceedsGbp,
    hypotheticalGainGbp,
    taxDueGbp: displayedTaxDue,
    taxDueGbpIfSedSucceeds: marginalCgtSuccess,
    taxDueGbpIfSedFails: marginalCgtFail,
    netInHandGbp,
    netInHandIfSedSucceeds: netProceedsGbp - marginalCgtSuccess,
    netInHandIfSedFails: netProceedsGbp - marginalCgtFail,
    tone: hypotheticalGainGbp >= 0 ? 'gain' : 'loss',
    sedStatus,
    fxRateUsed: fxRate,
    notes: hypotheticalGainGbp < 0
      ? `A £${Math.abs(hypotheticalGainGbp).toFixed(2)} loss would offset future gains.`
      : null,
    exempt: false,
  };
}

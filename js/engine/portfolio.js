/* Penny Farthing — Portfolio Service
 *
 * Orchestrates the pool engine across all assets and accounts held.
 * Reads transactions from IndexedDB, groups them by asset+account, and
 * computes a holdings snapshot: pool state per holding, realised disposals,
 * and tax-year aggregations.
 *
 * This is the bridge between raw storage and the views.
 */

import { getAll } from '../storage/indexeddb.js';
import { computePool } from './pool.js';
import { ensureFxRates } from './fx.js';
import { ukTaxYear } from '../storage/schema.js';

/**
 * Compute the full portfolio snapshot.
 *
 * @param {object} [options]
 * @param {boolean} [options.fetchFx=true] — if true, auto-fetch missing FX rates
 * @returns {Promise<{...}>}
 */
export async function computePortfolio(options = {}) {
  const { fetchFx = true } = options;

  let [transactions, assets, accounts] = await Promise.all([
    getAll('transactions'),
    getAll('assets'),
    getAll('accounts'),
  ]);

  // Auto-fetch any missing FX rates. Non-blocking on failure — we'll use
  // whatever's stored. Skipped if caller explicitly opts out (useful for
  // tests and for offline use).
  if (fetchFx) {
    try {
      const result = await ensureFxRates(transactions);
      if (result.updated > 0) {
        // Re-read transactions; ensureFxRates writes them back to storage.
        transactions = await getAll('transactions');
      }
    } catch (err) {
      console.warn('[portfolio] FX auto-fetch failed:', err.message);
    }
  }

  const assetMap = new Map(assets.map((a) => [a.id, a]));
  const accountMap = new Map(accounts.map((a) => [a.id, a]));

  // Group buy/sell transactions by (assetId, accountId).
  // HMRC treats wrappers as separate universes; ISA disposals aren't even
  // taxable events, but we still pool them so the dashboard can report
  // quantities and cost basis.
  const byAssetAccount = new Map();
  for (const t of transactions) {
    if (t.type !== 'buy' && t.type !== 'sell') continue;
    const key = `${t.assetId}::${t.accountId}`;
    if (!byAssetAccount.has(key)) byAssetAccount.set(key, []);
    byAssetAccount.get(key).push(t);
  }

  const holdings = [];
  const allDisposals = [];

  for (const [key, txns] of byAssetAccount) {
    const [assetId, accountId] = key.split('::');
    const asset = assetMap.get(assetId);
    const account = accountMap.get(accountId);
    if (!asset || !account) continue;

    const result = computePool(txns);

    // Annotate each disposal with asset + account context for the realised list
    for (const d of result.disposals) {
      allDisposals.push({
        ...d,
        assetId,
        accountId,
        assetTicker: asset.ticker,
        assetName: asset.name,
        accountName: account.name,
        wrapper: account.wrapper,
        taxYear: ukTaxYear(d.date),
        isCfd: !!asset.meta?.cfd,
        // Forex pseudo-assets (e.g. "GBP.USD", "GBP.CAD") arise from broker
        // auto-conversions which are not investment events. They should not
        // appear in CGT calculations. Match the IBKR pattern of CCY.CCY tickers.
        isForex: isForexPseudoAsset(asset),
      });
    }

    // Only list as a "holding" if the pool has quantity remaining AND
    // it's not a forex pseudo-asset (broker auto-conversions don't represent
    // investment positions even if quantity remains).
    if (result.currentPool.quantity > 1e-9 && !isForexPseudoAsset(asset)) {
      holdings.push({
        assetId,
        accountId,
        asset,
        account,
        quantity: result.currentPool.quantity,
        costGbp: result.currentPool.costGbp,
        avgCostGbp: result.currentPool.avgCostGbp,
      });
    }
  }

  // Sort holdings — largest cost basis first (biggest positions up top)
  holdings.sort((a, b) => b.costGbp - a.costGbp);

  // Sort disposals newest first for the realised log
  allDisposals.sort((a, b) => (b.date || '').localeCompare(a.date || ''));

  // Aggregate by tax year, splitting standard CGT from ring-fenced CFD.
  // Per TCGA 1992 s.143, CFD gains/losses cannot pool with spot stock
  // CGT gains/losses — they're their own universe.
  const byTaxYear = {};
  for (const d of allDisposals) {
    // Only aggregate CGT-relevant disposals. ISA/SIPP don't count.
    if (d.wrapper === 'ISA' || d.wrapper === 'SIPP') continue;
    // Forex pseudo-disposals (broker auto-conversions) are not investment
    // events and are not CGT-chargeable. Defence in depth: even if they
    // leak past the importer's filter, they don't pollute tax figures here.
    if (d.isForex) continue;

    if (!byTaxYear[d.taxYear]) {
      byTaxYear[d.taxYear] = {
        year: d.taxYear,
        disposals: [],
        // Standard CGT bucket (stocks, ETFs, crypto, chattels)
        totalGainGbp: 0,
        totalLossGbp: 0,
        netGbp: 0,
        proceedsGbp: 0,
        // Ring-fenced CFD bucket
        cfdGainGbp: 0,
        cfdLossGbp: 0,
        cfdNetGbp: 0,
        cfdProceedsGbp: 0,
        cfdDisposalCount: 0,
      };
    }
    const y = byTaxYear[d.taxYear];
    y.disposals.push(d);
    if (d.isCfd) {
      if (d.gainGbp >= 0) y.cfdGainGbp += d.gainGbp;
      else y.cfdLossGbp += Math.abs(d.gainGbp);
      y.cfdNetGbp += d.gainGbp;
      y.cfdProceedsGbp += d.proceedsNetGbp;
      y.cfdDisposalCount++;
    } else {
      if (d.gainGbp >= 0) y.totalGainGbp += d.gainGbp;
      else y.totalLossGbp += Math.abs(d.gainGbp);
      y.netGbp += d.gainGbp;
      y.proceedsGbp += d.proceedsNetGbp;
    }
  }

  // After initial aggregation, compute auto-carried losses. We walk the years
  // in chronological order; at each year, losses from all PRIOR years (that
  // haven't already been used to offset gains in intermediate years) carry
  // forward into this year's available pool. Same logic separately for
  // standard CGT and for CFDs.
  //
  // This means the user only needs to seed an initial "pre-tracking" loss
  // balance in Settings if they had losses before they started using the
  // app. Everything within the app's own history chains automatically.
  const yearsChronological = Object.keys(byTaxYear).sort();
  let runningStdBf = 0;
  let runningCfdBf = 0;
  for (const yr of yearsChronological) {
    const data = byTaxYear[yr];

    // Standard CGT bucket
    data.lossesBfAutoStd = runningStdBf;
    const stdBfAvailableAfter = runningStdBf + (data.netGbp < 0 ? Math.abs(data.netGbp) : 0);
    // If this year has a positive net, allowance and bf would eat into it,
    // but we don't know the user's AEA / bf-use preferences here. Conservative
    // approach: pass the full carried amount to next year; the tax view
    // decides what to actually apply. This over-reports available losses to
    // the displayed tax year but never under-reports them.
    //
    // Refinement: if net is positive, we assume ALL available bf losses are
    // used against it first (because the user would naturally minimise their
    // tax bill). Any leftover carries on.
    if (data.netGbp > 0) {
      const used = Math.min(runningStdBf, data.netGbp);
      runningStdBf = runningStdBf - used;
    } else if (data.netGbp < 0) {
      runningStdBf += Math.abs(data.netGbp);
    }

    // CFD bucket — fully ring-fenced, separate running balance
    data.lossesBfAutoCfd = runningCfdBf;
    if (data.cfdNetGbp > 0) {
      const used = Math.min(runningCfdBf, data.cfdNetGbp);
      runningCfdBf = runningCfdBf - used;
    } else if (data.cfdNetGbp < 0) {
      runningCfdBf += Math.abs(data.cfdNetGbp);
    }
  }

  return {
    holdings,
    realisedDisposals: allDisposals,
    byTaxYear,
    assetMap,
    accountMap,
  };
}

/**
 * Detect whether an asset is a broker-auto-converted forex pseudo-position
 * rather than a real investment. These show up in IBKR data as "GBP.USD"
 * style tickers — not actual disposals from the user's perspective.
 *
 * Returns true if the ticker matches the pattern of two 3-letter ISO
 * currency codes joined by a dot, OR if the asset's metadata flags it
 * as forex. Conservative: false positives here would suppress real
 * disposals, so we only match the strict CCY.CCY pattern.
 */
export function isForexPseudoAsset(asset) {
  if (!asset) return false;
  if (asset.meta?.forex === true) return true;
  const ticker = (asset.ticker || '').toUpperCase().trim();
  return /^[A-Z]{3}\.[A-Z]{3}$/.test(ticker);
}

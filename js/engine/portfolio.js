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
      });
    }

    // Only list as a "holding" if the pool has quantity remaining
    if (result.currentPool.quantity > 1e-9) {
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

  return {
    holdings,
    realisedDisposals: allDisposals,
    byTaxYear,
    assetMap,
    accountMap,
  };
}

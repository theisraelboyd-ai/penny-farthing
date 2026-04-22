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
import { ukTaxYear } from '../storage/schema.js';

/**
 * Compute the full portfolio snapshot.
 *
 * @returns {Promise<{
 *   holdings: Array,        // one entry per asset+account with non-zero pool
 *   realisedDisposals: Array, // every disposal across all holdings, chronological
 *   byTaxYear: Object,       // { '2024-25': { gains: [], totalGbp }, ... }
 *   assetMap: Map,
 *   accountMap: Map,
 * }>}
 */
export async function computePortfolio() {
  const [transactions, assets, accounts] = await Promise.all([
    getAll('transactions'),
    getAll('assets'),
    getAll('accounts'),
  ]);

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

  // Aggregate by tax year
  const byTaxYear = {};
  for (const d of allDisposals) {
    // Only aggregate CGT-relevant disposals. ISA/SIPP don't count.
    if (d.wrapper === 'ISA' || d.wrapper === 'SIPP') continue;

    if (!byTaxYear[d.taxYear]) {
      byTaxYear[d.taxYear] = {
        year: d.taxYear,
        disposals: [],
        totalGainGbp: 0,
        totalLossGbp: 0,
        netGbp: 0,
        proceedsGbp: 0,
      };
    }
    const y = byTaxYear[d.taxYear];
    y.disposals.push(d);
    if (d.gainGbp >= 0) y.totalGainGbp += d.gainGbp;
    else y.totalLossGbp += Math.abs(d.gainGbp);
    y.netGbp += d.gainGbp;
    y.proceedsGbp += d.proceedsNetGbp;
  }

  return {
    holdings,
    realisedDisposals: allDisposals,
    byTaxYear,
    assetMap,
    accountMap,
  };
}

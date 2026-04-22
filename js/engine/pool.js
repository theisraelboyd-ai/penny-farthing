/* Penny Farthing — Section 104 Pooling Engine
 *
 * Implements UK HMRC's share matching rules for computing the gain or loss
 * on a disposal of pooled assets (listed shares, ETFs, crypto, etc.).
 *
 * HMRC REQUIRES disposals be matched against acquisitions in this strict order:
 *   1. Same-day rule       — acquisitions on the same calendar day as the disposal
 *   2. Bed-and-breakfast   — acquisitions in the 30 days AFTER the disposal
 *   3. Section 104 pool    — the weighted-average pool of all earlier holdings
 *
 * See HMRC HS284 and TCGA 1992 s.104–s.106A for the primary legislation.
 *
 * The engine works per-asset-per-account. Separate wrappers (ISA vs GIA) are
 * separate universes — you can't match a GIA sale against an ISA buy. Callers
 * are responsible for passing the right slice of transactions.
 *
 * INPUT:  an array of transactions, chronological or not, for ONE asset in
 *         ONE account. Transaction shape: { id, date, type, quantity,
 *         pricePerUnit, currency, fxRate, fees, ... }
 *
 * OUTPUT: {
 *   currentPool: { quantity, costGbp, avgCostGbp },
 *   disposals:   [ { txnId, date, quantitySold, proceedsGbp, allowableCostGbp,
 *                    gainGbp, matches: [...], ... } ],
 *   closingQuantity: number,
 * }
 *
 * All monetary values in the output are in GBP, converted from transaction
 * currency using that transaction's fxRate (manual or fetched) at time of
 * the trade. GBX is handled: fxRate field is expected to already convert
 * GBX→GBP at 0.01 if callers pre-adjust, OR we do it here based on .currency.
 */

/**
 * Convert a transaction's native-currency amount to GBP.
 * Handles GBX (pence sterling) as a special case.
 */
function toGbp(amountNative, currency, fxRate) {
  if (currency === 'GBX') {
    // 100 GBX = 1 GBP. fxRate should normally be 1 for GBX.
    return amountNative * 0.01 * (fxRate || 1);
  }
  return amountNative * (fxRate || 1);
}

/**
 * Compute the gross value of a transaction in GBP (quantity × price).
 */
function grossGbp(t) {
  return toGbp((t.quantity || 0) * (t.pricePerUnit || 0), t.currency, t.fxRate);
}

/**
 * Compute the fee portion of a transaction in GBP.
 */
function feesGbp(t) {
  return toGbp(t.fees || 0, t.currency, t.fxRate);
}

/**
 * Run the Section 104 matching engine.
 *
 * @param {Array} transactions — all transactions for ONE asset + ONE account
 * @returns {object} result
 */
export function computePool(transactions) {
  // Filter to buy/sell only. Dividends and fee-only entries don't affect pool.
  const acquisitions = [];
  const disposals = [];

  for (const t of transactions) {
    if (t.type === 'buy') {
      acquisitions.push({ ...t, _remaining: t.quantity });
    } else if (t.type === 'sell') {
      disposals.push({ ...t, _remaining: t.quantity });
    }
  }

  // Sort both by date ascending (stable). HMRC requires chronological
  // processing; order of same-date transactions we treat as ID-stable so
  // results are deterministic.
  const byDate = (a, b) => {
    const d = (a.date || '').localeCompare(b.date || '');
    if (d !== 0) return d;
    return (a.id || '').localeCompare(b.id || '');
  };
  acquisitions.sort(byDate);
  disposals.sort(byDate);

  // -------- Step 1: Process disposals in chronological order --------
  //
  // For each disposal, we match in strict HMRC order:
  //   (a) same-day acquisitions
  //   (b) acquisitions in the 30 days AFTER the disposal date
  //   (c) the Section 104 pool as it stood immediately before this disposal
  //
  // The S.104 pool only receives acquisitions that haven't been consumed by
  // same-day or 30-day matches by the time we reach them chronologically.
  // This means we need to walk the timeline carefully.

  const results = [];

  for (const disposal of disposals) {
    const matches = [];
    let remainingToMatch = disposal._remaining;

    // --- (a) SAME-DAY MATCHES ---
    // Acquisitions on exactly the same date get priority.
    for (const acq of acquisitions) {
      if (remainingToMatch <= 0) break;
      if (acq._remaining <= 0) continue;
      if (acq.date !== disposal.date) continue;

      const matched = Math.min(remainingToMatch, acq._remaining);
      const matchedCostGbp = costPerUnitGbp(acq) * matched;
      matches.push({
        rule: 'same-day',
        acquisitionId: acq.id,
        acquisitionDate: acq.date,
        quantity: matched,
        costGbp: matchedCostGbp,
      });
      acq._remaining -= matched;
      remainingToMatch -= matched;
    }

    // --- (b) 30-DAY (BED-AND-BREAKFAST) MATCHES ---
    // Acquisitions strictly AFTER the disposal date, within 30 calendar days.
    if (remainingToMatch > 0) {
      const disposalDate = new Date(disposal.date + 'T00:00:00Z');
      const thirtyDaysLater = new Date(disposalDate);
      thirtyDaysLater.setUTCDate(thirtyDaysLater.getUTCDate() + 30);

      // Earliest-first within the 30-day window
      for (const acq of acquisitions) {
        if (remainingToMatch <= 0) break;
        if (acq._remaining <= 0) continue;
        const acqDate = new Date(acq.date + 'T00:00:00Z');
        if (acqDate <= disposalDate) continue;           // must be AFTER disposal
        if (acqDate > thirtyDaysLater) continue;         // must be within 30 days

        const matched = Math.min(remainingToMatch, acq._remaining);
        const matchedCostGbp = costPerUnitGbp(acq) * matched;
        matches.push({
          rule: '30-day',
          acquisitionId: acq.id,
          acquisitionDate: acq.date,
          quantity: matched,
          costGbp: matchedCostGbp,
        });
        acq._remaining -= matched;
        remainingToMatch -= matched;
      }
    }

    // --- (c) SECTION 104 POOL MATCH ---
    // Whatever is left is matched against the S.104 pool as it stood
    // immediately before this disposal. We compute the pool fresh here by
    // walking all acquisitions with date < disposal.date that haven't been
    // fully consumed by same-day or 30-day matches against earlier disposals.
    //
    // BUT: acquisitions consumed by same-day/30-day matches against THIS
    // disposal shouldn't already be in the pool — which they're not, because
    // we only add to the pool acquisitions whose date is strictly BEFORE
    // the disposal date. Same-day (a) and 30-day (b) are by definition not
    // before. So the pool as computed here is exactly correct.

    if (remainingToMatch > 0) {
      const pool = poolAsOf(acquisitions, disposal.date);

      if (pool.quantity < remainingToMatch - 1e-9) {
        // Short sale / data integrity issue — we're selling more than we own.
        // Record the match with what's available and flag the issue.
        matches.push({
          rule: 's104',
          quantity: pool.quantity,
          costGbp: pool.costGbp,
          warning: `Insufficient pool: tried to match ${remainingToMatch} but pool only had ${pool.quantity}`,
        });
        remainingToMatch -= pool.quantity;
        // Mark the pool as consumed
        markPoolConsumed(acquisitions, disposal.date, pool.quantity);
      } else {
        const poolCostForMatched = pool.avgCostGbp * remainingToMatch;
        matches.push({
          rule: 's104',
          quantity: remainingToMatch,
          costGbp: poolCostForMatched,
          poolQuantityBefore: pool.quantity,
          poolAvgCostGbp: pool.avgCostGbp,
        });
        markPoolConsumed(acquisitions, disposal.date, remainingToMatch);
        remainingToMatch = 0;
      }
    }

    // Aggregate totals for this disposal
    const matchedQuantity = matches.reduce((s, m) => s + m.quantity, 0);
    const allowableCostGbp = matches.reduce((s, m) => s + (m.costGbp || 0), 0);
    const proceedsGrossGbp = grossGbp(disposal);
    const disposalFeesGbp = feesGbp(disposal);
    // Net proceeds = gross - selling fees. Selling fees reduce proceeds per HMRC rules.
    const proceedsNetGbp = proceedsGrossGbp - disposalFeesGbp;
    const gainGbp = proceedsNetGbp - allowableCostGbp;

    results.push({
      txnId: disposal.id,
      date: disposal.date,
      quantitySold: matchedQuantity,
      proceedsGrossGbp,
      disposalFeesGbp,
      proceedsNetGbp,
      allowableCostGbp,
      gainGbp,
      matches,
    });
  }

  // -------- Step 2: Compute closing S.104 pool --------
  // All acquisitions that still have unconsumed quantity form the pool.
  const closingPool = acquisitions.reduce(
    (acc, acq) => {
      if (acq._remaining > 0) {
        acc.quantity += acq._remaining;
        const costPerUnit = costPerUnitGbp(acq);
        acc.costGbp += costPerUnit * acq._remaining;
      }
      return acc;
    },
    { quantity: 0, costGbp: 0 }
  );
  closingPool.avgCostGbp = closingPool.quantity > 0
    ? closingPool.costGbp / closingPool.quantity
    : 0;

  return {
    currentPool: closingPool,
    disposals: results,
    closingQuantity: closingPool.quantity,
  };
}

/**
 * Compute the Section 104 pool state as of immediately BEFORE a given date.
 * This is the pool that a disposal on that date would match against (for
 * the s.104 portion only — same-day and 30-day matches happen separately).
 *
 * Walks all acquisitions with date STRICTLY BEFORE the target date and
 * sums their remaining (not-yet-consumed) quantities and GBP costs.
 */
function poolAsOf(acquisitions, onDate) {
  let qty = 0;
  let cost = 0;
  for (const acq of acquisitions) {
    if (acq.date >= onDate) continue;      // only strictly before
    if (acq._remaining <= 0) continue;
    const costPerUnit = costPerUnitGbp(acq);
    qty += acq._remaining;
    cost += costPerUnit * acq._remaining;
  }
  const avg = qty > 0 ? cost / qty : 0;
  return { quantity: qty, costGbp: cost, avgCostGbp: avg };
}

/**
 * Mark the S.104 pool as having consumed `quantityToConsume` on a given date.
 * We do this by proportionally reducing each pre-date acquisition's remaining
 * quantity. This preserves the invariant that every acquisition tracks its
 * own consumption, which matters if a later disposal's 30-day window needs
 * to peek back.
 *
 * Using proportional consumption (rather than FIFO) is the correct behaviour:
 * in the S.104 pool, individual share identity is lost — the pool is fungible.
 */
function markPoolConsumed(acquisitions, onDate, quantityToConsume) {
  // Sum remaining eligible
  let totalEligible = 0;
  for (const acq of acquisitions) {
    if (acq.date >= onDate) continue;
    if (acq._remaining <= 0) continue;
    totalEligible += acq._remaining;
  }
  if (totalEligible <= 0) return;

  const ratio = quantityToConsume / totalEligible;
  for (const acq of acquisitions) {
    if (acq.date >= onDate) continue;
    if (acq._remaining <= 0) continue;
    acq._remaining -= acq._remaining * ratio;
    if (acq._remaining < 1e-9) acq._remaining = 0;
  }
}

/**
 * Per-unit cost basis in GBP, including a pro-rata share of fees.
 * Buying fees INCREASE the cost basis (reduce future gain). This is HMRC's
 * standard treatment — acquisition costs are allowable deductions.
 */
function costPerUnitGbp(acq) {
  if ((acq.quantity || 0) <= 0) return 0;
  const gbpGross = grossGbp(acq);
  const gbpFees = feesGbp(acq);
  return (gbpGross + gbpFees) / acq.quantity;
}

/* ============================================================
   Bullion allocation helper
   ============================================================

   For a LUMP-SUM sale of multiple physical items (e.g. the gold bar
   scenario), the user records one sale transaction per item but needs
   proceeds and fees allocated from a single gross figure.

   This helper takes:
     - totalProceedsGbp, totalFeesGbp
     - an array of items with { id, weightGrams } (or weights in any unit)
   and returns per-item allocated proceeds & fees, weighted by weight.

   If weights are missing, it falls back to equal split.
*/
export function allocateBullionLumpSum(items, totalProceeds, totalFees = 0) {
  const totalWeight = items.reduce((s, i) => s + (i.weightGrams || 0), 0);
  const useWeight = totalWeight > 0;
  return items.map((item) => {
    const share = useWeight
      ? (item.weightGrams || 0) / totalWeight
      : 1 / items.length;
    return {
      itemId: item.id,
      proceeds: totalProceeds * share,
      fees: totalFees * share,
      share,
    };
  });
}

/* ============================================================
   Tiny self-test — runnable in browser console as:
     import('./js/engine/pool.js').then(m => m._selfTest && console.log(m._selfTest()))
   ============================================================ */

export function _selfTest() {
  const log = [];
  const assert = (cond, msg) => log.push((cond ? '✓ ' : '✗ FAIL: ') + msg);

  // TEST 1: Simple pool — buy 100 @ £1, buy 100 @ £3 → pool of 200 @ avg £2
  {
    const txns = [
      { id: '1', date: '2025-03-10', type: 'buy', quantity: 100, pricePerUnit: 1, currency: 'GBP', fxRate: 1, fees: 0 },
      { id: '2', date: '2025-04-10', type: 'buy', quantity: 100, pricePerUnit: 3, currency: 'GBP', fxRate: 1, fees: 0 },
    ];
    const r = computePool(txns);
    assert(r.closingQuantity === 200, 'T1: pool qty 200');
    assert(Math.abs(r.currentPool.avgCostGbp - 2) < 1e-9, 'T1: pool avg £2');
  }

  // TEST 2: S.104 disposal — buy 100 @ £1, buy 100 @ £3, sell 50 @ £5 → gain = 50×5 − 50×2 = £150
  {
    const txns = [
      { id: '1', date: '2025-03-10', type: 'buy',  quantity: 100, pricePerUnit: 1, currency: 'GBP', fxRate: 1, fees: 0 },
      { id: '2', date: '2025-04-10', type: 'buy',  quantity: 100, pricePerUnit: 3, currency: 'GBP', fxRate: 1, fees: 0 },
      { id: '3', date: '2025-05-10', type: 'sell', quantity: 50,  pricePerUnit: 5, currency: 'GBP', fxRate: 1, fees: 0 },
    ];
    const r = computePool(txns);
    assert(Math.abs(r.disposals[0].gainGbp - 150) < 1e-9, `T2: gain £150 got £${r.disposals[0].gainGbp}`);
    assert(r.disposals[0].matches[0].rule === 's104', 'T2: matched against S.104');
    assert(Math.abs(r.closingQuantity - 150) < 1e-9, 'T2: closing qty 150');
  }

  // TEST 3: Same-day rule — sell 50 @ £5 and buy 50 @ £4 same day
  //   Disposal matches the same-day acquisition first.
  //   Gain = 50×5 − 50×4 = £50 (NOT matched against any earlier pool)
  {
    const txns = [
      { id: '1', date: '2025-03-10', type: 'buy',  quantity: 100, pricePerUnit: 1, currency: 'GBP', fxRate: 1, fees: 0 },
      { id: '2', date: '2025-05-10', type: 'sell', quantity: 50,  pricePerUnit: 5, currency: 'GBP', fxRate: 1, fees: 0 },
      { id: '3', date: '2025-05-10', type: 'buy',  quantity: 50,  pricePerUnit: 4, currency: 'GBP', fxRate: 1, fees: 0 },
    ];
    const r = computePool(txns);
    assert(r.disposals[0].matches[0].rule === 'same-day', `T3: rule=same-day got ${r.disposals[0].matches[0].rule}`);
    assert(Math.abs(r.disposals[0].gainGbp - 50) < 1e-9, `T3: gain £50 got £${r.disposals[0].gainGbp}`);
  }

  // TEST 4: 30-day (bed-and-breakfast) rule — sell then rebuy within 30 days
  //   Buy 100 @ £1 (day 1), sell 100 @ £5 (day 10), buy 100 @ £4 (day 15)
  //   The day-10 sale matches against the day-15 buy (30-day rule), NOT the original pool.
  //   Gain = 100×5 − 100×4 = £100
  //   Closing pool: 100 shares at £1 (the original, untouched)
  {
    const txns = [
      { id: '1', date: '2025-03-01', type: 'buy',  quantity: 100, pricePerUnit: 1, currency: 'GBP', fxRate: 1, fees: 0 },
      { id: '2', date: '2025-03-10', type: 'sell', quantity: 100, pricePerUnit: 5, currency: 'GBP', fxRate: 1, fees: 0 },
      { id: '3', date: '2025-03-15', type: 'buy',  quantity: 100, pricePerUnit: 4, currency: 'GBP', fxRate: 1, fees: 0 },
    ];
    const r = computePool(txns);
    assert(r.disposals[0].matches[0].rule === '30-day', `T4: rule=30-day got ${r.disposals[0].matches[0].rule}`);
    assert(Math.abs(r.disposals[0].gainGbp - 100) < 1e-9, `T4: gain £100 got £${r.disposals[0].gainGbp}`);
    assert(Math.abs(r.closingQuantity - 100) < 1e-9, `T4: closing qty 100 got ${r.closingQuantity}`);
    assert(Math.abs(r.currentPool.avgCostGbp - 1) < 1e-9, `T4: original £1 pool intact got £${r.currentPool.avgCostGbp}`);
  }

  // TEST 5: Fees increase cost / reduce proceeds
  //   Buy 100 @ £1 + £10 fees, sell 100 @ £2 − £5 fees
  //   Cost basis = 100 + 10 = £110
  //   Net proceeds = 200 − 5 = £195
  //   Gain = 195 − 110 = £85
  {
    const txns = [
      { id: '1', date: '2025-03-10', type: 'buy',  quantity: 100, pricePerUnit: 1, currency: 'GBP', fxRate: 1, fees: 10 },
      { id: '2', date: '2025-05-10', type: 'sell', quantity: 100, pricePerUnit: 2, currency: 'GBP', fxRate: 1, fees: 5 },
    ];
    const r = computePool(txns);
    assert(Math.abs(r.disposals[0].gainGbp - 85) < 1e-9, `T5: gain £85 got £${r.disposals[0].gainGbp}`);
  }

  // TEST 6: FX conversion — buy 100 USD shares @ $2 at 0.8 GBP/USD, sell at $3 at 0.75
  //   Cost = 100 × 2 × 0.8 = £160
  //   Proceeds = 100 × 3 × 0.75 = £225
  //   Gain = £65
  {
    const txns = [
      { id: '1', date: '2025-03-10', type: 'buy',  quantity: 100, pricePerUnit: 2, currency: 'USD', fxRate: 0.8,  fees: 0 },
      { id: '2', date: '2025-05-10', type: 'sell', quantity: 100, pricePerUnit: 3, currency: 'USD', fxRate: 0.75, fees: 0 },
    ];
    const r = computePool(txns);
    assert(Math.abs(r.disposals[0].gainGbp - 65) < 1e-9, `T6: gain £65 got £${r.disposals[0].gainGbp}`);
  }

  // TEST 7: GBX conversion — 1000 shares at 150 GBX/share = £1500
  {
    const txns = [
      { id: '1', date: '2025-03-10', type: 'buy',  quantity: 1000, pricePerUnit: 150, currency: 'GBX', fxRate: 1, fees: 0 },
      { id: '2', date: '2025-05-10', type: 'sell', quantity: 1000, pricePerUnit: 200, currency: 'GBX', fxRate: 1, fees: 0 },
    ];
    const r = computePool(txns);
    // Cost = 1000 × 150 × 0.01 = £1500, Proceeds = 1000 × 200 × 0.01 = £2000, Gain = £500
    assert(Math.abs(r.disposals[0].gainGbp - 500) < 1e-9, `T7: gain £500 got £${r.disposals[0].gainGbp}`);
  }

  // TEST 8: Bullion lump-sum allocator
  {
    const items = [
      { id: 'A', weightGrams: 20 },
      { id: 'B', weightGrams: 20 },
      { id: 'C', weightGrams: 20 },
      { id: 'D', weightGrams: 31.1 }, // 1 oz
    ];
    const alloc = allocateBullionLumpSum(items, 8000, 50);
    const total = alloc.reduce((s, a) => s + a.proceeds, 0);
    assert(Math.abs(total - 8000) < 1e-6, `T8: proceeds sum = £8000 got £${total}`);
    // Heaviest item (1 oz bar) gets the biggest share
    const ounceBar = alloc.find((a) => a.itemId === 'D');
    const twentyG = alloc.find((a) => a.itemId === 'A');
    assert(ounceBar.proceeds > twentyG.proceeds, 'T8: 1 oz bar gets larger allocation than 20g bar');
  }

  return log;
}

/* Penny Farthing — FX Module
 *
 * Fetches historical daily FX rates from Frankfurter (https://frankfurter.dev)
 * and caches them in IndexedDB. Frankfurter is:
 *   - Free
 *   - No API key
 *   - CORS-enabled (works from browsers)
 *   - Sourced from ECB reference rates
 *   - Returns end-of-day rates
 *
 * The API:
 *   GET https://api.frankfurter.dev/v1/{date}?base=USD&symbols=GBP
 *   → { "amount": 1.0, "base": "USD", "date": "2025-03-14",
 *       "rates": { "GBP": 0.7742 } }
 *
 * ECB does not publish on weekends or bank holidays. Frankfurter falls back
 * to the most recent published date automatically (the returned "date" may
 * differ from requested).
 *
 * POLICY:
 *   - If a transaction has a manually-entered fxRate (flag: fxSource='manual'),
 *     NEVER overwrite it. Broker-executed rates are more accurate.
 *   - If fxSource is missing or 'auto', fetch and update.
 *   - Results are cached in the 'fxRates' store keyed by '{CCY}-GBP-{date}'.
 */

import { put, get } from '../storage/indexeddb.js';

const FRANKFURTER_BASE = 'https://api.frankfurter.dev/v1';

/* ============================================================
   Pure helpers
   ============================================================ */

function cacheKey(currency, date) {
  return `${currency}-GBP-${date}`;
}

/**
 * GBX is pence sterling — never needs an API call, it's always 0.01 GBP per GBX.
 * GBP trivially converts to itself.
 */
function trivialRate(currency) {
  if (currency === 'GBP') return 1;
  if (currency === 'GBX') return 0.01;
  return null;
}

/* ============================================================
   Public API
   ============================================================ */

/**
 * Get the GBP-per-unit rate for a given currency on a given date.
 * Checks cache first, then Frankfurter, then returns null on failure.
 *
 * If Frankfurter returns a different date (weekend/holiday fallback), we
 * cache under BOTH the requested date and the returned date so later lookups
 * at either get a hit.
 *
 * If the exact-date query returns 404 (ECB hasn't published yet — happens
 * for "today" since ECB publishes rates with ~1-day lag), we walk BACKWARDS
 * up to 7 days to find a published rate. This covers weekends and bank
 * holidays as well as publication lag.
 *
 * @param {string} currency  ISO 4217 (e.g. 'USD', 'EUR', 'CAD')
 * @param {string} date      ISO date 'YYYY-MM-DD'
 * @returns {Promise<number|null>}
 */
export async function getFxRate(currency, date) {
  const trivial = trivialRate(currency);
  if (trivial !== null) return trivial;

  const key = cacheKey(currency, date);
  const cached = await get('fxRates', key);
  if (cached && typeof cached.rate === 'number') return cached.rate;

  // Walk back up to 7 days if the exact date isn't published.
  // Frankfurter actually handles weekend fallback itself via the closest
  // prior trading day, but DOESN'T for the current day until ~16:00 CET —
  // so walking back by days is a robust, predictable fallback.
  const reqDate = new Date(date + 'T00:00:00Z');
  for (let offsetDays = 0; offsetDays <= 7; offsetDays++) {
    const attempt = new Date(reqDate);
    attempt.setUTCDate(attempt.getUTCDate() - offsetDays);
    const attemptIso = attempt.toISOString().slice(0, 10);

    try {
      const url = `${FRANKFURTER_BASE}/${attemptIso}?base=${currency}&symbols=GBP`;
      const response = await fetch(url);
      if (!response.ok) {
        // 404 = not published; keep walking back
        if (response.status === 404) continue;
        throw new Error(`HTTP ${response.status}`);
      }
      const data = await response.json();
      const rate = data?.rates?.GBP;
      if (typeof rate !== 'number') {
        continue;  // malformed response; try older date
      }

      // Cache under BOTH requested and returned dates.
      const record = {
        id: key,
        currency,
        date,
        actualDate: data.date,
        rate,
        fetchedAt: new Date().toISOString(),
        source: 'frankfurter',
      };
      await put('fxRates', record);
      if (data.date && data.date !== date) {
        await put('fxRates', { ...record, id: cacheKey(currency, data.date), date: data.date });
      }
      return rate;
    } catch (err) {
      console.warn(`[fx] Attempt ${attemptIso} for ${currency}→GBP failed:`, err.message);
      // Try next older date
      continue;
    }
  }

  // Exhausted all attempts
  console.warn(`[fx] Could not fetch ${currency}→GBP within 7 days of ${date}`);
  return null;
}

/**
 * Batch-fetch missing FX rates for a set of transactions.
 *
 * Called proactively when the portfolio engine runs, so the second render
 * has accurate rates even if the first was using defaults.
 *
 * Respects the 'manual' flag — never overwrites user-entered rates.
 *
 * @param {Array} transactions
 * @returns {Promise<{checked: number, updated: number, failed: number}>}
 */
export async function ensureFxRates(transactions) {
  let checked = 0;
  let updated = 0;
  let failed = 0;

  // Collect unique (currency, date) pairs we need, skipping manual entries
  // and trivial currencies.
  const needed = new Set();
  const needsUpdate = [];

  for (const t of transactions) {
    checked++;
    // GBP and GBX are trivial — no fetch needed, but we should normalise fxRate
    if (t.currency === 'GBP' && t.fxRate !== 1) needsUpdate.push({ txn: t, rate: 1 });
    if (t.currency === 'GBX' && t.fxRate !== 1) needsUpdate.push({ txn: t, rate: 1 });
    if (t.currency === 'GBP' || t.currency === 'GBX') continue;

    // Manual rates are sacred — never overwrite
    if (t.fxSource === 'manual') continue;

    // If already auto-fetched and rate looks reasonable, skip
    if (t.fxSource === 'auto' && t.fxRate > 0) continue;

    // If fxRate is the default 1.0 for a foreign currency, that's suspicious
    // and we should try to fetch. Same if no fxSource is set yet.
    needed.add(`${t.currency}::${t.date}`);
  }

  // Fetch each unique pair
  const rateMap = new Map();  // key → rate
  for (const pairKey of needed) {
    const [currency, date] = pairKey.split('::');
    const rate = await getFxRate(currency, date);
    if (rate !== null) {
      rateMap.set(pairKey, rate);
    } else {
      failed++;
    }
  }

  // Apply fetched rates back to transactions that need them
  for (const t of transactions) {
    if (t.currency === 'GBP' || t.currency === 'GBX') continue;
    if (t.fxSource === 'manual') continue;

    const key = `${t.currency}::${t.date}`;
    const rate = rateMap.get(key);
    if (rate !== undefined) {
      needsUpdate.push({ txn: t, rate, source: 'auto' });
    }
  }

  // Write updates back to the store
  for (const { txn, rate, source } of needsUpdate) {
    txn.fxRate = rate;
    if (source) txn.fxSource = source;
    await put('transactions', txn);
    updated++;
  }

  return { checked, updated, failed };
}

/**
 * Tag for display — returns 'manual', 'auto', or 'trivial' to show on the
 * transaction list so the user can see which rates came from where.
 */
export function fxSourceLabel(txn) {
  if (txn.currency === 'GBP' || txn.currency === 'GBX') return 'trivial';
  return txn.fxSource || 'unset';
}

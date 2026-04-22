/* Penny Farthing — Price Fetcher
 *
 * Fetches current prices for holdings from Finnhub.
 *   - Free tier: 60 calls/min, no per-day cap
 *   - Key stored in settings (settings.finnhubApiKey)
 *
 * Finnhub quote endpoint:
 *   GET https://finnhub.io/api/v1/quote?symbol=AAPL&token=API_KEY
 *   → { c: current, h: high, l: low, o: open, pc: prev close, t: timestamp }
 *
 * Policy:
 *   - If asset has price.manualOverride set, use that — never fetched over
 *   - Otherwise fetch and cache in 'prices' store, keyed by assetId
 *   - Cache entries include fetchedAt so we can show staleness
 *   - If Finnhub 403s or returns { c: 0 }, mark as failed — user prompted
 *     to set a manual price
 *
 * Ticker notes:
 *   - US stocks: plain ticker (AAPL, RGTI)
 *   - LSE: suffix .L (VUSA.L, BP.L)
 *   - Physical gold / bullion: Finnhub won't have it; use manual prices.
 */

import { get, put } from '../storage/indexeddb.js';

const FINNHUB_BASE = 'https://finnhub.io/api/v1';

/**
 * Fetch a single price for an asset. Returns { priceNative, currency,
 * fetchedAt, source } or null on failure.
 *
 * @param {object} asset     — the asset record (expects .ticker, .baseCurrency)
 * @param {string} apiKey    — Finnhub API key
 */
export async function fetchPrice(asset, apiKey) {
  if (!asset?.ticker) return null;
  if (!apiKey) return null;

  try {
    const url = `${FINNHUB_BASE}/quote?symbol=${encodeURIComponent(asset.ticker)}&token=${encodeURIComponent(apiKey)}`;
    const response = await fetch(url);
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }
    const data = await response.json();

    // Finnhub returns { c: 0 } for symbols it doesn't cover (no error, just zero).
    if (typeof data?.c !== 'number' || data.c <= 0) {
      return { error: 'no-data', symbol: asset.ticker };
    }

    return {
      priceNative: data.c,
      currency: asset.baseCurrency || 'USD',
      fetchedAt: new Date().toISOString(),
      source: 'finnhub',
      raw: { h: data.h, l: data.l, o: data.o, pc: data.pc, t: data.t },
    };
  } catch (err) {
    return { error: err.message, symbol: asset.ticker };
  }
}

/**
 * Refresh prices for multiple assets in parallel, with throttling.
 * Finnhub free tier caps at 60 calls/min; we do 10 at a time with small
 * spacing to be well below that.
 */
export async function refreshAllPrices(assets, apiKey, onProgress) {
  const results = {
    succeeded: 0, failed: 0, skipped: 0,
    errors: [],
  };

  // Filter to assets Finnhub can plausibly cover (not physical gold, not
  // unknown). Anything with a manual price stays manual.
  const fetchable = [];
  for (const asset of assets) {
    // Check if manual price is set in the price store
    const existing = await get('prices', asset.id);
    if (existing?.manualOverride) {
      results.skipped++;
      continue;
    }
    if (asset.type === 'gold-physical') {
      results.skipped++;
      continue;
    }
    if (!asset.ticker) {
      results.skipped++;
      continue;
    }
    fetchable.push(asset);
  }

  // Process in batches of 10, with a small delay between batches
  const batchSize = 10;
  for (let i = 0; i < fetchable.length; i += batchSize) {
    const batch = fetchable.slice(i, i + batchSize);
    const batchResults = await Promise.all(batch.map((a) => fetchPrice(a, apiKey)));

    for (let j = 0; j < batch.length; j++) {
      const asset = batch[j];
      const result = batchResults[j];
      if (!result) {
        results.failed++;
        continue;
      }
      if (result.error) {
        results.failed++;
        results.errors.push({ asset: asset.ticker, error: result.error });
        // Still save a stub record so we can show "fetch failed" in UI
        await put('prices', {
          id: asset.id,
          assetId: asset.id,
          fetchedAt: new Date().toISOString(),
          source: 'finnhub',
          error: result.error,
        });
      } else {
        results.succeeded++;
        await put('prices', {
          id: asset.id,
          assetId: asset.id,
          priceNative: result.priceNative,
          currency: result.currency,
          fetchedAt: result.fetchedAt,
          source: result.source,
          raw: result.raw,
        });
      }
      if (onProgress) onProgress(results);
    }

    // Small inter-batch delay
    if (i + batchSize < fetchable.length) {
      await new Promise((r) => setTimeout(r, 200));
    }
  }

  return results;
}

/**
 * Set a manual price for an asset. Overrides any Finnhub fetch.
 */
export async function setManualPrice(assetId, priceNative, currency) {
  await put('prices', {
    id: assetId,
    assetId,
    priceNative,
    currency,
    fetchedAt: new Date().toISOString(),
    source: 'manual',
    manualOverride: true,
  });
}

/**
 * Clear manual override (so Finnhub can take over again on next refresh).
 */
export async function clearManualPrice(assetId) {
  const existing = await get('prices', assetId);
  if (!existing) return;
  existing.manualOverride = false;
  delete existing.priceNative; // force refetch
  await put('prices', existing);
}

/**
 * Get the stored price for an asset. Returns the full record or null.
 */
export async function getPrice(assetId) {
  return get('prices', assetId);
}

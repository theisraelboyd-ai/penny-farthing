/* Holdings view — open positions with market value and "If sold now" after-tax.
 *
 * Features:
 *   - Finnhub-fetched prices with refresh button
 *   - Manual price entry for assets Finnhub can't cover (gold, etc.)
 *   - Per-holding marginal CGT calculation respecting SED status
 *   - "If SED succeeds / fails" toggle for pending-SED scenarios
 *   - Staleness indicator on prices
 */

import { el, formatCurrency, formatNumber, toast } from '../ui.js';
import { computePortfolio } from '../engine/portfolio.js';
import { getPrice, setManualPrice, refreshAllPrices } from '../engine/prices.js';
import { computeSellNow } from '../engine/sell-now.js';
import { get, getAll } from '../storage/indexeddb.js';
import { ukTaxYear } from '../storage/schema.js';
import { navigate } from '../router.js';
import { glyphFor } from '../visual/glyphs.js';

export async function renderHoldings(mount) {
  const portfolio = await computePortfolio();
  const settings = await get('settings', 'main');
  const apiKey = settings?.finnhubApiKey || null;
  const currentTaxYear = ukTaxYear(new Date());
  const yearSettings = await get('taxYears', currentTaxYear);

  mount.append(
    el('div', { class: 'view-header' },
      el('h2', {}, 'Holdings'),
      el('p', {}, 'Open positions with pooled cost basis and after-tax "if sold now" estimates.'),
    ),
  );

  // ----- Setup banner if no API key -----
  if (!apiKey) {
    mount.append(
      el('section', { class: 'ledger-page', style: { borderColor: 'var(--warn)' } },
        el('h3', { style: { color: 'var(--warn)', marginBottom: 'var(--space-2)' } },
          'Set up live prices'),
        el('p', { class: 'text-muted', style: { fontSize: 'var(--f-sm)' } },
          'Add a free Finnhub API key in Settings to enable market values. You can still set manual prices per asset without one.'),
        el('div', { class: 'button-row' },
          el('button', {
            class: 'button',
            onclick: () => navigate('/settings'),
          }, 'Go to Settings'),
        ),
      ),
    );
  }

  if (portfolio.holdings.length === 0) {
    mount.append(
      el('section', { class: 'ledger-page' },
        el('div', { class: 'empty-state' },
          el('p', {}, 'No open positions yet.'),
        ),
      ),
    );
    return;
  }

  // Load current prices for all holdings
  const priceMap = new Map();
  for (const h of portfolio.holdings) {
    const p = await getPrice(h.asset.id);
    if (p) priceMap.set(h.asset.id, p);
  }

  // Refresh controls
  const refreshBtn = el('button', { class: 'button' }, 'Refresh prices');
  const refreshStatus = el('span', { class: 'text-faint', style: { fontSize: 'var(--f-sm)', marginLeft: 'var(--space-3)' } });
  const controls = el('div', {
    style: {
      display: 'flex', alignItems: 'center',
      marginBottom: 'var(--space-4)', gap: 'var(--space-3)', flexWrap: 'wrap',
    },
  }, refreshBtn, refreshStatus);

  refreshBtn.addEventListener('click', async () => {
    if (!apiKey) {
      toast('Set your Finnhub API key in Settings first', { error: true });
      return;
    }
    refreshBtn.disabled = true;
    refreshStatus.textContent = 'Fetching…';
    try {
      const assets = await getAll('assets');
      const assetsInHoldings = assets.filter((a) =>
        portfolio.holdings.some((h) => h.asset.id === a.id));
      const result = await refreshAllPrices(assetsInHoldings, apiKey);
      toast(`Updated ${result.succeeded} · skipped ${result.skipped} · failed ${result.failed}`);
      // Re-render
      mount.innerHTML = '';
      await renderHoldings(mount);
    } catch (err) {
      toast(`Refresh failed: ${err.message}`, { error: true });
      refreshBtn.disabled = false;
      refreshStatus.textContent = '';
    }
  });
  mount.append(controls);

  // Group by wrapper
  const byWrapper = {};
  for (const h of portfolio.holdings) {
    const w = h.account.wrapper || 'OTHER';
    if (!byWrapper[w]) byWrapper[w] = [];
    byWrapper[w].push(h);
  }

  // Summary tiles — cost basis per wrapper
  const totalsByWrapper = {};
  let grandTotalCost = 0;
  let grandTotalMarket = 0;
  let grandTotalNetAfterTax = 0;
  let priceCoverage = 0;

  for (const [w, list] of Object.entries(byWrapper)) {
    totalsByWrapper[w] = list.reduce((s, h) => s + h.costGbp, 0);
  }
  for (const h of portfolio.holdings) {
    grandTotalCost += h.costGbp;
    const p = priceMap.get(h.asset.id);
    if (p && typeof p.priceNative === 'number' && p.priceNative > 0) {
      priceCoverage++;
    }
  }

  // Precompute sell-now for all holdings in parallel
  const sellNowResults = new Map();
  for (const h of portfolio.holdings) {
    const p = priceMap.get(h.asset.id);
    if (!p || typeof p.priceNative !== 'number' || p.priceNative <= 0) continue;
    const result = await computeSellNow({
      holding: h,
      marketPriceNative: p.priceNative,
      priceCurrency: p.currency || h.asset.baseCurrency || 'GBP',
      portfolio,
      yearSettings,
      taxYear: currentTaxYear,
    });
    sellNowResults.set(h.asset.id, result);
    grandTotalMarket += result.marketValueGbp;
    grandTotalNetAfterTax += result.netInHandGbp;
  }

  // Summary strip
  mount.append(
    el('div', { class: 'stat-grid' },
      stat('Cost basis', formatCurrency(grandTotalCost, 'GBP'),
        `${portfolio.holdings.length} position${portfolio.holdings.length === 1 ? '' : 's'}`),
      stat('Market value',
        priceCoverage > 0 ? formatCurrency(grandTotalMarket, 'GBP') : '—',
        `${priceCoverage} of ${portfolio.holdings.length} priced`),
      stat('Unrealised P&L',
        priceCoverage > 0 ? formatCurrency(grandTotalMarket - grandTotalCost, 'GBP') : '—',
        null,
        priceCoverage === 0 ? null :
          (grandTotalMarket >= grandTotalCost ? 'gain' : 'loss')),
      stat('If sold all now',
        priceCoverage > 0 ? formatCurrency(grandTotalNetAfterTax, 'GBP') : '—',
        'after tax (estimated)'),
    ),
  );

  // One table per wrapper
  const wrapperOrder = ['GIA', 'ISA', 'SIPP', 'UNWRAPPED', 'OTHER'];
  const sortedWrappers = Object.keys(byWrapper).sort(
    (a, b) => wrapperOrder.indexOf(a) - wrapperOrder.indexOf(b)
  );

  for (const wrapper of sortedWrappers) {
    const holdings = byWrapper[wrapper];
    const card = el('section', { class: 'ledger-page' },
      el('div', { class: 'ledger-page__heading' },
        el('h2', {}, wrapper),
        el('span', { class: 'pill' },
          formatCurrency(totalsByWrapper[wrapper], 'GBP') + ' cost'),
      ),
      renderHoldingsTable(holdings, priceMap, sellNowResults, apiKey, async () => {
        mount.innerHTML = '';
        await renderHoldings(mount);
      }),
    );
    mount.append(card);
  }
}

function renderHoldingsTable(holdings, priceMap, sellNowResults, apiKey, onChange) {
  return el('table', { class: 'hairline-table' },
    el('thead', {},
      el('tr', {},
        el('th', {}, 'Asset'),
        el('th', { class: 'num' }, 'Qty'),
        el('th', { class: 'num' }, 'Cost (GBP)'),
        el('th', { class: 'num' }, 'Price'),
        el('th', { class: 'num' }, 'Market value'),
        el('th', { class: 'num' }, 'If sold now'),
        el('th', {}, ''),
      ),
    ),
    el('tbody', {},
      ...holdings.map((h) => {
        const p = priceMap.get(h.asset.id);
        const sn = sellNowResults.get(h.asset.id);
        const g = glyphFor(h.asset.type);
        const nativeCurrency = h.asset.baseCurrency || 'GBP';

        // Price cell
        let priceCell;
        if (p && typeof p.priceNative === 'number' && p.priceNative > 0) {
          const isManual = p.source === 'manual' || p.manualOverride;
          priceCell = el('td', { class: 'num' },
            formatNumber(p.priceNative, 4),
            el('div', { class: 'text-faint', style: { fontSize: 'var(--f-xs)' } },
              `${p.currency || nativeCurrency} · ${isManual ? 'manual' : 'live'}`),
          );
        } else if (p && p.error) {
          priceCell = el('td', { class: 'num text-faint' }, 'fetch failed');
        } else {
          priceCell = el('td', { class: 'num text-faint' }, '—');
        }

        // Market value + sell-now cells
        let marketCell;
        let sellNowCell;
        if (sn) {
          marketCell = el('td', { class: 'num' },
            formatCurrency(sn.marketValueGbp, 'GBP'),
            el('div', { class: `text-faint ${sn.tone}`, style: { fontSize: 'var(--f-xs)' } },
              (sn.hypotheticalGainGbp >= 0 ? '+' : '') + formatCurrency(sn.hypotheticalGainGbp, 'GBP')),
          );
          if (sn.exempt) {
            sellNowCell = el('td', { class: 'num', style: { fontWeight: '500' } },
              formatCurrency(sn.netInHandGbp, 'GBP'),
              el('div', { class: 'text-faint', style: { fontSize: 'var(--f-xs)' } }, 'tax exempt'),
            );
          } else if (sn.hypotheticalGainGbp < 0) {
            sellNowCell = el('td', { class: 'num', style: { fontWeight: '500' } },
              formatCurrency(sn.netInHandGbp, 'GBP'),
              el('div', { class: 'text-faint loss', style: { fontSize: 'var(--f-xs)' } },
                `banks £${Math.abs(sn.hypotheticalGainGbp).toFixed(0)} loss`),
            );
          } else {
            const sedLabel = sn.sedStatus === 'claimed' ? 'after SED' :
                             sn.sedStatus === 'not-eligible' ? 'no SED' :
                             'SED pending';
            sellNowCell = el('td', { class: 'num', style: { fontWeight: '500' } },
              formatCurrency(sn.netInHandGbp, 'GBP'),
              el('div', { class: 'text-faint', style: { fontSize: 'var(--f-xs)' } },
                `£${sn.taxDueGbp.toFixed(0)} tax · ${sedLabel}`),
            );
          }
        } else {
          marketCell = el('td', { class: 'num text-faint' }, '—');
          sellNowCell = el('td', { class: 'num text-faint' }, '—');
        }

        return el('tr', {},
          el('td', {},
            el('div', { style: { display: 'flex', alignItems: 'center' } },
              el('span', { class: `asset-glyph asset-glyph--${g.tone}`, title: g.label }, g.glyph),
              el('div', {},
                el('div', { style: { fontWeight: '500' } }, h.asset.ticker || '—'),
                el('div', { class: 'text-faint', style: { fontSize: 'var(--f-xs)' } },
                  `${h.asset.name || ''} · ${h.account.name}`),
              ),
            ),
          ),
          el('td', { class: 'num' }, formatNumber(h.quantity, 4)),
          el('td', { class: 'num' }, formatCurrency(h.costGbp, 'GBP')),
          priceCell,
          marketCell,
          sellNowCell,
          el('td', { style: { textAlign: 'right' } },
            el('button', {
              class: 'button button--ghost button-sm',
              onclick: async () => {
                await promptManualPrice(h, onChange);
              },
            }, 'Set price'),
          ),
        );
      }),
    ),
  );
}

async function promptManualPrice(holding, onChange) {
  const asset = holding.asset;
  const existing = await getPrice(asset.id);
  const currentPrice = existing?.priceNative;
  const currencySuggestion = existing?.currency || asset.baseCurrency || 'GBP';

  const msg = `Set manual price for ${asset.ticker} (${asset.name || 'asset'}).
Currency: ${currencySuggestion}${currentPrice ? `\nCurrent: ${currentPrice}` : ''}

Enter price per unit (native currency):`;

  const input = prompt(msg, currentPrice ? String(currentPrice) : '');
  if (input == null) return;
  const value = parseFloat(input);
  if (isNaN(value) || value <= 0) {
    toast('Invalid price', { error: true });
    return;
  }

  await setManualPrice(asset.id, value, currencySuggestion);
  toast(`Price set: ${asset.ticker} = ${value} ${currencySuggestion}`);
  if (onChange) onChange();
}

function stat(label, value, sub, tone) {
  const valueClass = tone === 'gain' ? 'gain' : tone === 'loss' ? 'loss' : '';
  return el('div', { class: 'stat-tile' },
    el('div', { class: 'stat-tile__label' }, label),
    el('div', { class: `stat-tile__value ${valueClass}` }, value),
    sub ? el('div', { class: 'stat-tile__sub' }, sub) : null,
  );
}

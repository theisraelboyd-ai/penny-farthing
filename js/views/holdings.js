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

  // Resolve effective SED status: per-year override > app-wide default > 'pending'
  const defaultSed = settings?.defaultSedStatus || 'pending';
  const effectiveSed = (yearSettings?.sedStatus && yearSettings.sedStatus !== '')
    ? yearSettings.sedStatus
    : defaultSed;

  // View-only scenario override — lives in a module-local variable so the
  // user can toggle through claimed/pending/fails and see the calc update
  // without editing their saved tax records.
  // The toggle persists across re-renders via a window-stash (cleared after read).
  let scenarioOverride = window.__sedScenarioOverride || effectiveSed;
  if (window.__sedScenarioOverride) {
    delete window.__sedScenarioOverride;
  }

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

  // Refresh controls + SED scenario toggle
  const refreshBtn = el('button', { class: 'button' }, 'Refresh prices');
  const refreshStatus = el('span', { class: 'text-faint', style: { fontSize: 'var(--f-sm)', marginLeft: 'var(--space-3)' } });

  // Scenario toggle — view-only (doesn't edit saved tax records)
  const scenarioLabel = el('span', {
    class: 'text-muted',
    style: { fontSize: 'var(--f-sm)', marginRight: 'var(--space-2)' },
  }, 'Scenario:');

  const scenarioChips = el('div', { class: 'filter-chips', style: { marginBottom: 0 } });
  const scenarioOptions = [
    { key: 'claimed',       label: 'SED claimed' },
    { key: 'pending',       label: 'SED pending' },
    { key: 'not-eligible',  label: 'SED fails' },
  ];
  for (const opt of scenarioOptions) {
    const chip = el('button', {
      class: 'filter-chip' + (scenarioOverride === opt.key ? ' is-active' : ''),
      type: 'button',
      onclick: async () => {
        scenarioOverride = opt.key;
        // Re-render the whole view with the new scenario
        mount.innerHTML = '';
        // Pass the override through module-local state — recreate by calling self
        // with scenario context. Simplest: re-run renderHoldings but the override
        // will be reset. We stash it on the window briefly:
        window.__sedScenarioOverride = opt.key;
        await renderHoldings(mount);
        delete window.__sedScenarioOverride;
      },
    }, opt.label);
    scenarioChips.append(chip);
  }

  const controls = el('div', {
    style: {
      display: 'flex', alignItems: 'center',
      marginBottom: 'var(--space-4)', gap: 'var(--space-3)', flexWrap: 'wrap',
    },
  }, refreshBtn, refreshStatus,
    el('div', { style: { flex: '1' } }),  // spacer
    scenarioLabel, scenarioChips,
  );

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
  let fxFailedCount = 0;
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
      sedOverride: scenarioOverride,
      preTrackingSeedLosses: settings?.preTrackingSeedLosses || 0,
    });
    sellNowResults.set(h.asset.id, result);
    if (result.fxFailed) {
      fxFailedCount++;
      continue;  // Don't poison totals with nulls or bad data
    }
    grandTotalMarket += result.marketValueGbp;
    grandTotalNetAfterTax += result.netInHandGbp;
  }

  // FX failure banner — above summary tiles so it's impossible to miss
  if (fxFailedCount > 0) {
    mount.append(
      el('div', { class: 'banner banner--warn', style: { marginBottom: 'var(--space-4)' } },
        el('strong', {}, `FX rates unavailable for ${fxFailedCount} position${fxFailedCount === 1 ? '' : 's'}. `),
        el('span', {},
          'The ECB reference rate for today hasn\'t published yet, or the currency isn\'t covered. '),
        el('span', {},
          'Click "Set price" on any affected row and enter the price directly in GBP to bypass FX conversion.'),
      ),
    );
  }

  // AEA (Annual Exempt Amount) headroom for the current tax year.
  // Tells the user how much chargeable gain they can still realise in
  // 2026-27 before CGT kicks in. Computed from year-to-date realised gains
  // and any losses brought forward (auto-carry from prior tracked years).
  // Floored at 0 — once you're over the line, headroom is just zero.
  const ANNUAL_EXEMPT_AMOUNT = 3000;
  const realisedNetThisYear = portfolio.byTaxYear[currentTaxYear]?.netGbp || 0;
  const lossesBfStd = (portfolio.byTaxYear[currentTaxYear]?.lossesBfAutoStd || 0)
    + (settings?.preTrackingSeedLosses || 0);
  // Available "tax-free room" = AEA + bf losses; consumed by net realised
  // gains so far this year. Negative realised (i.e. losses banked already)
  // doesn't expand the room beyond the AEA — losses get added to the bf
  // bank for *next* year, not this year's headroom.
  const headroomRaw = ANNUAL_EXEMPT_AMOUNT + lossesBfStd - Math.max(0, realisedNetThisYear);
  const aeaHeadroom = Math.max(0, headroomRaw);

  let headroomSubtitle;
  if (realisedNetThisYear > 0) {
    headroomSubtitle = `${formatCurrency(realisedNetThisYear, 'GBP')} already realised`;
  } else if (realisedNetThisYear < 0) {
    headroomSubtitle = `${formatCurrency(Math.abs(realisedNetThisYear), 'GBP')} loss banked`;
  } else {
    headroomSubtitle = 'before CGT applies';
  }

  // Summary strip
  mount.append(
    el('div', { class: 'stat-grid' },
      stat('Cost basis', formatCurrency(grandTotalCost, 'GBP'),
        `${portfolio.holdings.length} position${portfolio.holdings.length === 1 ? '' : 's'}`),
      stat('Market value',
        priceCoverage > 0 ? formatCurrency(grandTotalMarket, 'GBP') : '—',
        fxFailedCount > 0
          ? `${priceCoverage - fxFailedCount} of ${portfolio.holdings.length} converted`
          : `${priceCoverage} of ${portfolio.holdings.length} priced`),
      stat('Unrealised P&L',
        priceCoverage > 0 ? formatCurrency(grandTotalMarket - grandTotalCost, 'GBP') : '—',
        null,
        priceCoverage === 0 ? null :
          (grandTotalMarket >= grandTotalCost ? 'gain' : 'loss')),
      stat(`AEA headroom ${currentTaxYear}`,
        formatCurrency(aeaHeadroom, 'GBP'),
        headroomSubtitle,
        aeaHeadroom > 0 ? 'gain' : 'warn'),
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
          priceCell = el('td', { class: 'num', 'data-label': 'Price' },
            formatNumber(p.priceNative, 4),
            el('div', { class: 'text-faint', style: { fontSize: 'var(--f-xs)' } },
              `${p.currency || nativeCurrency} · ${isManual ? 'manual' : 'live'}`),
          );
        } else if (p && p.error) {
          priceCell = el('td', { class: 'num text-faint', 'data-label': 'Price' }, 'fetch failed');
        } else {
          priceCell = el('td', { class: 'num text-faint', 'data-label': 'Price' }, '—');
        }

        // Market value + sell-now cells
        let marketCell;
        let sellNowCell;
        if (sn && sn.fxFailed) {
          // FX fetch failed — show amber warning with actionable fix.
          marketCell = el('td', { class: 'num', 'data-label': 'Market value' },
            el('span', { class: 'pill pill--warn' }, 'FX unavailable'),
            el('div', { class: 'text-faint', style: { fontSize: 'var(--f-xs)', marginTop: '2px' } },
              `${p?.currency || nativeCurrency}→GBP not fetched`),
          );
          sellNowCell = el('td', { class: 'num text-faint', 'data-label': 'If sold now' },
            '—',
            el('div', { style: { fontSize: 'var(--f-xs)' } }, 'set price manually'),
          );
        } else if (sn) {
          marketCell = el('td', { class: 'num', 'data-label': 'Market value' },
            formatCurrency(sn.marketValueGbp, 'GBP'),
            el('div', { class: `text-faint ${sn.tone}`, style: { fontSize: 'var(--f-xs)' } },
              (sn.hypotheticalGainGbp >= 0 ? '+' : '') + formatCurrency(sn.hypotheticalGainGbp, 'GBP')),
          );
          // Stacked breakdown: Proceeds / [middle row] / Net.
          // Same shape for all three cases — gain (taxable), loss banked,
          // or AEA-exempt — so the user always knows what they'd receive,
          // what tax/loss event happens, and what they'd take home.
          let middleLabel, middleValue, middleClass, captionText;
          if (sn.hypotheticalGainGbp < 0) {
            // Loss — selling banks the loss for future offset, no tax.
            middleLabel = 'Loss';
            middleValue = `−${formatCurrency(Math.abs(sn.hypotheticalGainGbp), 'GBP')}`;
            middleClass = 'loss';
            captionText = 'banked for future offset';
          } else if (sn.exempt) {
            middleLabel = 'Tax';
            middleValue = formatCurrency(0, 'GBP');
            middleClass = '';
            captionText = 'within AEA — exempt';
          } else {
            const sedLabel = sn.sedStatus === 'claimed' ? 'after SED' :
                             sn.sedStatus === 'not-eligible' ? 'no SED' :
                             'SED pending';
            middleLabel = 'Tax';
            middleValue = `−${formatCurrency(sn.taxDueGbp, 'GBP')}`;
            middleClass = 'warn';
            captionText = sedLabel;
          }
          sellNowCell = el('td', { class: 'num sell-now-breakdown', 'data-label': 'If sold now' },
            el('div', { class: 'sell-now-breakdown__row' },
              el('span', { class: 'sell-now-breakdown__label' }, 'Proceeds'),
              el('span', { class: 'sell-now-breakdown__value' },
                formatCurrency(sn.marketValueGbp, 'GBP')),
            ),
            el('div', { class: 'sell-now-breakdown__row' },
              el('span', { class: 'sell-now-breakdown__label' }, middleLabel),
              el('span', { class: `sell-now-breakdown__value ${middleClass}` }, middleValue),
            ),
            el('div', { class: 'sell-now-breakdown__row sell-now-breakdown__row--net' },
              el('span', { class: 'sell-now-breakdown__label' }, 'Net'),
              el('span', { class: 'sell-now-breakdown__value' },
                formatCurrency(sn.netInHandGbp, 'GBP')),
            ),
            el('div', { class: 'text-faint', style: { fontSize: 'var(--f-xs)', textAlign: 'right', marginTop: '2px' } },
              captionText),
          );
        } else {
          marketCell = el('td', { class: 'num text-faint', 'data-label': 'Market value' }, '—');
          sellNowCell = el('td', { class: 'num text-faint', 'data-label': 'If sold now' }, '—');
        }

        return el('tr', {},
          el('td', { 'data-label': 'Asset' },
            el('div', { style: { display: 'flex', alignItems: 'center' } },
              el('span', { class: `asset-glyph asset-glyph--${g.tone}`, title: g.label }, g.glyph),
              el('div', {},
                el('div', { style: { fontWeight: '500' } }, h.asset.ticker || '—'),
                el('div', { class: 'text-faint', style: { fontSize: 'var(--f-xs)' } },
                  `${h.asset.name || ''} · ${h.account.name}`),
              ),
            ),
          ),
          el('td', { class: 'num', 'data-label': 'Quantity' }, formatNumber(h.quantity, 4)),
          el('td', { class: 'num', 'data-label': 'Cost (GBP)' }, formatCurrency(h.costGbp, 'GBP')),
          priceCell,
          marketCell,
          sellNowCell,
          el('td', { 'data-label': '', style: { textAlign: 'right' } },
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
  const valueClass = tone === 'gain' ? 'gain' : tone === 'loss' ? 'loss' : tone === 'warn' ? 'warn' : '';
  const tileClass = tone ? `stat-tile stat-tile--${tone}` : 'stat-tile';
  return el('div', { class: tileClass },
    el('div', { class: 'stat-tile__label' }, label),
    el('div', { class: `stat-tile__value ${valueClass}` }, value),
    sub ? el('div', { class: 'stat-tile__sub' }, sub) : null,
  );
}

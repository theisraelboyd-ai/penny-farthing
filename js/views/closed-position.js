/* Closed Position entry view — currency-aware version.
 *
 * Purpose: record already-matched disposals from platforms that do their
 * own lot matching (eToro, Trading 212, Robinhood) in a way that is
 * HMRC-correct for foreign-currency trades.
 *
 * METHODOLOGY:
 *   For UK residents disposing of foreign-currency-denominated assets,
 *   HMRC requires both the acquisition cost AND the disposal proceeds to
 *   be converted to GBP at the spot rate on their respective dates. You
 *   do NOT use a single FX rate or a platform-supplied "converted profit"
 *   figure. See HMRC manual CG78300 and TCGA 1992 for detail.
 *
 *   This form captures:
 *     - Asset quantity
 *     - Trade currency (USD, EUR, CAD, GBP)
 *     - Open price per unit (native currency)
 *     - Close price per unit (native currency)
 *     - Open-side spread fee (native currency) — treated as incidental
 *       acquisition cost, added to cost basis
 *     - Close-side market spread (native currency) — incidental disposal
 *       cost, subtracts from proceeds
 *     - Overnight / holding fees (native currency) — reduces proceeds
 *
 *   App then:
 *     - Fetches GBP/CCY rate on open date (ECB reference rate, via Frankfurter)
 *     - Fetches GBP/CCY rate on close date (ditto)
 *     - Computes:
 *         costBasisGbp    = qty × openPrice × fxOpen + openFee × fxOpen
 *         proceedsGbp     = qty × closePrice × fxClose − closeFee × fxClose
 *                           − overnightFees × fxClose
 *         gain            = proceedsGbp − costBasisGbp
 *         priceMovementGbp = qty × (closePrice − openPrice) × fxClose
 *         fxMovementGbp   = qty × openPrice × (fxClose − fxOpen)
 *       (decomposition for user insight; tax cares only about `gain`)
 *
 *   The rate source is stored on each transaction so audit trail is defensible.
 */

import { el, toast } from '../ui.js';
import { getAll, get, put, uuid } from '../storage/indexeddb.js';
import { ukTaxYear } from '../storage/schema.js';
import { navigate } from '../router.js';
import { getFxRate } from '../engine/fx.js';

const SUPPORTED_CURRENCIES = ['USD', 'EUR', 'CAD', 'GBP', 'AUD', 'JPY', 'CHF'];

export async function renderClosedPosition(mount, params = {}) {
  const [accounts, assets, settings] = await Promise.all([
    getAll('accounts'),
    getAll('assets'),
    get('settings', 'main'),
  ]);

  // If params.edit is set, load the existing pair of transactions for editing
  let editing = null;
  if (params.edit) {
    const allTxns = await getAll('transactions');
    const target = allTxns.find((t) => t.id === params.edit);
    if (target) {
      // Find its partner (if it has one)
      const partnerId = target.pairId;
      const partner = partnerId ? allTxns.find((t) => t.id === partnerId) : null;
      if (partner) {
        // Order them: buy first, sell second
        const buy = target.type === 'buy' ? target : partner;
        const sell = target.type === 'sell' ? target : partner;
        editing = { buy, sell };
      } else {
        // Paired edit requested but no partner — could be data corruption or
        // an old single transaction. Warn and fall back to regular edit view.
        toast('This transaction has no matching pair — use the regular edit screen', { error: true });
        navigate(`/edit?id=${encodeURIComponent(target.id)}`);
        return;
      }
    } else {
      toast('Transaction not found', { error: true });
      navigate('/transactions');
      return;
    }
  }

  // Remember last-used account for closed-position entry so consecutive rows
  // default to the same account. First use has no default — prevents the
  // "all my eToro trades got entered under IBKR" mistake from recurring.
  const lastUsedAccountId = editing ? editing.buy.accountId
    : (settings?.lastClosedPositionAccountId || null);

  mount.append(
    el('div', { class: 'view-header' },
      el('h2', {}, editing ? 'Edit closed position' : 'Record closed position'),
      el('p', {},
        editing
          ? 'Adjust the details below. Both the open and close transactions will be updated together.'
          : 'For matched disposals from eToro, Trading 212 or similar. Enter the trade in its native currency — the app handles FX conversion using ECB reference rates at open and close dates (HMRC-compliant).'),
    ),
  );

  if (accounts.length === 0) {
    mount.append(
      el('section', { class: 'ledger-page' },
        el('h3', {}, 'Create an account first'),
        el('p', { class: 'text-muted' },
          'You need at least one account in Settings before recording trades.'),
        el('div', { class: 'button-row' },
          el('button', { class: 'button', onclick: () => navigate('/settings') },
            'Go to Settings'),
        ),
      ),
    );
    return;
  }

  // ==================== Form fields ====================

  const form = el('form', { class: 'stacked-form' });

  // Account — no default on first use, remembered from previous save after that
  const accountOptions = [];
  if (!lastUsedAccountId) {
    accountOptions.push(el('option', {
      value: '', disabled: true, selected: true,
    }, 'Choose account…'));
  }
  for (const a of accounts) {
    const isLast = a.id === lastUsedAccountId;
    accountOptions.push(el('option', {
      value: a.id, ...(isLast ? { selected: true } : {}),
    }, `${a.name} · ${a.wrapper} · ${a.platform}`));
  }
  const accountSelect = el('select', {
    class: 'select', id: 'cp-account', required: true,
  }, ...accountOptions);

  // Symbol + name
  const symbolInput = el('input', {
    type: 'text', id: 'cp-symbol', class: 'input',
    placeholder: 'TSLA, NVDA, RGTI …',
    required: true, autocomplete: 'off',
  });
  const nameInput = el('input', {
    type: 'text', id: 'cp-name', class: 'input',
    placeholder: 'Tesla Motors Inc (optional)',
    autocomplete: 'off',
  });

  // Asset class
  const classSelect = el('select', { class: 'select', id: 'cp-class', required: true },
    el('option', { value: 'equity' }, 'Equity (stocks — CGT pool)'),
    el('option', { value: 'etf' }, 'ETF/Fund — CGT pool'),
    el('option', { value: 'cfd-stock' }, 'CFD — ring-fenced'),
    el('option', { value: 'cfd-commodity' }, 'CFD (commodity, e.g. Gold) — ring-fenced'),
    el('option', { value: 'crypto' }, 'Crypto — separate pool'),
  );

  // Currency
  const currencySelect = el('select', { class: 'select', id: 'cp-currency', required: true },
    ...SUPPORTED_CURRENCIES.map((c) =>
      el('option', { value: c, ...(c === 'USD' ? { selected: true } : {}) }, c)),
  );

  // Dates
  const openDateInput = el('input', {
    type: 'date', id: 'cp-open-date', class: 'input', required: true,
  });
  const closeDateInput = el('input', {
    type: 'date', id: 'cp-close-date', class: 'input', required: true,
  });

  // Quantity
  const qtyInput = el('input', {
    type: 'number', id: 'cp-qty', class: 'input',
    step: 'any', min: '0', required: true,
    placeholder: '10.506105',
  });

  // Prices and fees (all in native currency)
  const openPriceInput = el('input', {
    type: 'number', id: 'cp-open-price', class: 'input',
    step: 'any', required: true,
    placeholder: '135.94',
  });
  const closePriceInput = el('input', {
    type: 'number', id: 'cp-close-price', class: 'input',
    step: 'any', required: true,
    placeholder: '191.22',
  });
  const openFeeInput = el('input', {
    type: 'number', id: 'cp-open-fee', class: 'input',
    step: 'any', value: '0',
    placeholder: '0.00',
  });
  const closeFeeInput = el('input', {
    type: 'number', id: 'cp-close-fee', class: 'input',
    step: 'any', value: '0',
    placeholder: '0.21',
  });
  const overnightFeeInput = el('input', {
    type: 'number', id: 'cp-overnight', class: 'input',
    step: 'any', value: '0',
    placeholder: '0.00',
  });

  // Notes
  const notesInput = el('textarea', {
    id: 'cp-notes', class: 'input',
    placeholder: 'Position ID 3028670304 (optional — useful for cross-reference)',
    rows: 2,
  });

  // Prefill form fields if editing an existing pair
  if (editing) {
    const { buy, sell } = editing;
    const asset = assets.find((a) => a.id === buy.assetId);
    if (asset) {
      // Strip any .CFD suffix for symbol display — the class dropdown controls whether
      // we round-trip the suffix back on save
      const displaySymbol = asset.ticker?.endsWith('.CFD')
        ? asset.ticker.replace(/\.CFD$/, '')
        : asset.ticker;
      symbolInput.value = displaySymbol || '';
      nameInput.value = (asset.name || '').replace(/\s*\(CFD\)$/, '');
      // Map asset type + CFD flag back to class select
      if (asset.meta?.cfd) {
        classSelect.value = asset.type === 'gold-physical' ? 'cfd-commodity' : 'cfd-stock';
      } else {
        classSelect.value = asset.type || 'equity';
      }
    }
    currencySelect.value = buy.currency || 'USD';
    openDateInput.value = buy.date;
    closeDateInput.value = sell.date;
    qtyInput.value = buy.quantity;
    openPriceInput.value = buy.pricePerUnit;
    closePriceInput.value = sell.pricePerUnit;
    openFeeInput.value = buy.fees || 0;
    // Sell-side stores close fee + overnight fee combined; we can't split
    // them back reliably, so put the total in closeFee and leave overnight 0.
    closeFeeInput.value = sell.fees || 0;
    overnightFeeInput.value = 0;
    notesInput.value = buy.notes || '';
  }

  // ==================== Preview panel ====================

  const previewPanel = el('div', {
    style: {
      padding: 'var(--space-4)',
      background: 'var(--surface-2)',
      borderRadius: 'var(--radius-md)',
      marginTop: 'var(--space-3)',
      fontSize: 'var(--f-sm)',
      lineHeight: '1.6',
    },
  }, 'Enter quantity, prices and dates to see GBP conversion preview…');

  // Update the preview whenever any relevant field changes.
  // Debounced because it hits the FX API.
  let previewTimer = null;
  const schedulePreview = () => {
    clearTimeout(previewTimer);
    previewTimer = setTimeout(updatePreview, 350);
  };

  async function updatePreview() {
    const currency = currencySelect.value;
    const qty = parseFloat(qtyInput.value);
    const openPrice = parseFloat(openPriceInput.value);
    const closePrice = parseFloat(closePriceInput.value);
    const openFee = parseFloat(openFeeInput.value || '0');
    const closeFee = parseFloat(closeFeeInput.value || '0');
    const overnightFee = parseFloat(overnightFeeInput.value || '0');
    const openDate = openDateInput.value;
    const closeDate = closeDateInput.value;

    if (!qty || !openPrice || !closePrice || !openDate || !closeDate) {
      previewPanel.textContent = 'Enter quantity, prices and dates to see GBP conversion preview…';
      previewPanel.style.color = 'var(--text-muted)';
      return;
    }
    if (qty <= 0 || openDate > closeDate) {
      previewPanel.textContent = 'Check dates and quantity — dates must be in order, quantity positive.';
      previewPanel.style.color = 'var(--loss)';
      return;
    }

    previewPanel.innerHTML = '';
    previewPanel.append(el('div', { class: 'text-muted' }, 'Fetching FX rates…'));

    let fxOpen, fxClose;
    try {
      [fxOpen, fxClose] = await Promise.all([
        getFxRate(currency, openDate),
        getFxRate(currency, closeDate),
      ]);
    } catch (err) {
      previewPanel.innerHTML = '';
      previewPanel.append(
        el('div', { style: { color: 'var(--loss)' } }, `FX fetch error: ${err.message}`));
      return;
    }

    if (fxOpen === null || fxClose === null) {
      previewPanel.innerHTML = '';
      previewPanel.append(
        el('div', { style: { color: 'var(--warn)' } },
          `FX rate unavailable for ${currency}→GBP on one or both dates. `,
          'Check dates or enter a manual rate on the transactions after saving.'),
      );
      return;
    }

    // Compute cost basis, proceeds, gain, and the price/FX decomposition
    const costNative = qty * openPrice + openFee;
    const proceedsNative = qty * closePrice - closeFee - overnightFee;
    const costGbp = costNative * fxOpen;
    const proceedsGbp = proceedsNative * fxClose;
    const gainGbp = proceedsGbp - costGbp;

    // Decomposition (informational): how much of the gain is price vs FX?
    // Using close FX as the "constant" to isolate:
    //   Price-only gain if FX hadn't moved: qty*(close-open)*fxOpen
    //   FX-only gain if price hadn't moved: qty*open*(fxClose-fxOpen)
    //   Residual (interaction term): small, usually pennies
    const priceMovementGbp = qty * (closePrice - openPrice) * fxOpen;
    const fxMovementGbp = qty * openPrice * (fxClose - fxOpen);
    const crossGbp = gainGbp - priceMovementGbp - fxMovementGbp;
    // (crossGbp is the interaction: price_change × fx_change × qty, usually tiny)

    const gainTone = gainGbp >= 0 ? 'gain' : 'loss';
    const gainSign = gainGbp >= 0 ? '+' : '';

    previewPanel.innerHTML = '';
    previewPanel.append(
      // Cost line
      el('div', { style: { marginBottom: 'var(--space-2)' } },
        el('strong', {}, `Cost basis: £${costGbp.toFixed(2)}`),
        el('div', { class: 'text-faint', style: { fontSize: 'var(--f-xs)' } },
          `${qty} × ${openPrice} ${currency}`,
          openFee > 0 ? ` + ${openFee} ${currency} fees` : '',
          ` = ${costNative.toFixed(2)} ${currency}, `,
          `at ${fxOpen.toFixed(5)} GBP/${currency} (${openDate})`),
      ),
      // Proceeds line
      el('div', { style: { marginBottom: 'var(--space-2)' } },
        el('strong', {}, `Proceeds: £${proceedsGbp.toFixed(2)}`),
        el('div', { class: 'text-faint', style: { fontSize: 'var(--f-xs)' } },
          `${qty} × ${closePrice} ${currency}`,
          closeFee > 0 ? ` − ${closeFee} fees` : '',
          overnightFee > 0 ? ` − ${overnightFee} holding` : '',
          ` = ${proceedsNative.toFixed(2)} ${currency}, `,
          `at ${fxClose.toFixed(5)} GBP/${currency} (${closeDate})`),
      ),
      // Gain line
      el('div', {
        style: {
          marginTop: 'var(--space-3)',
          paddingTop: 'var(--space-2)',
          borderTop: '1px solid var(--border)',
          fontSize: 'var(--f-md)',
        }
      },
        el('strong', { class: gainTone }, `Gain/Loss: ${gainSign}£${gainGbp.toFixed(2)}`),
      ),
      // Decomposition (small, informational)
      currency === 'GBP' ? null : el('div', {
        class: 'text-faint',
        style: { fontSize: 'var(--f-xs)', marginTop: 'var(--space-2)' }
      },
        `of which: price movement ${priceMovementGbp >= 0 ? '+' : ''}£${priceMovementGbp.toFixed(2)}, `,
        `FX movement ${fxMovementGbp >= 0 ? '+' : ''}£${fxMovementGbp.toFixed(2)}`,
        Math.abs(crossGbp) > 0.01 ? `, interaction ${crossGbp >= 0 ? '+' : ''}£${crossGbp.toFixed(2)}` : '',
      ),
    );
  }

  // Hook up listeners
  for (const input of [qtyInput, openPriceInput, closePriceInput, openFeeInput,
                        closeFeeInput, overnightFeeInput, openDateInput,
                        closeDateInput, currencySelect]) {
    input.addEventListener('input', schedulePreview);
    input.addEventListener('change', schedulePreview);
  }

  // ==================== Layout ====================

  form.append(
    el('div', { class: 'form-group' },
      el('label', { for: 'cp-account' }, 'Account'),
      accountSelect,
    ),
    el('div', { class: 'form-row' },
      el('div', { class: 'form-group' },
        el('label', { for: 'cp-symbol' }, 'Symbol / ticker'),
        symbolInput,
      ),
      el('div', { class: 'form-group' },
        el('label', { for: 'cp-class' }, 'Asset class'),
        classSelect,
        el('p', { class: 'form-group__hint' },
          'CFDs are ring-fenced per TCGA 1992 s.143.'),
      ),
    ),
    el('div', { class: 'form-group' },
      el('label', { for: 'cp-name' }, 'Full name (optional)'),
      nameInput,
    ),
    el('div', { class: 'form-row' },
      el('div', { class: 'form-group' },
        el('label', { for: 'cp-currency' }, 'Trade currency'),
        currencySelect,
        el('p', { class: 'form-group__hint' },
          'The currency the position opens and closes in. eToro is typically USD.'),
      ),
      el('div', { class: 'form-group' },
        el('label', { for: 'cp-qty' }, 'Quantity / units'),
        qtyInput,
      ),
    ),
    el('div', { class: 'form-row' },
      el('div', { class: 'form-group' },
        el('label', { for: 'cp-open-date' }, 'Open date'),
        openDateInput,
      ),
      el('div', { class: 'form-group' },
        el('label', { for: 'cp-close-date' }, 'Close date'),
        closeDateInput,
      ),
    ),
    el('h3', { style: { fontSize: 'var(--f-md)', marginTop: 'var(--space-4)', marginBottom: 'var(--space-2)' } },
      'Prices (native currency)'),
    el('div', { class: 'form-row' },
      el('div', { class: 'form-group' },
        el('label', { for: 'cp-open-price' }, 'Open rate per unit'),
        openPriceInput,
        el('p', { class: 'form-group__hint' },
          'eToro "Open Rate" column — the price you paid per share.'),
      ),
      el('div', { class: 'form-group' },
        el('label', { for: 'cp-close-price' }, 'Close rate per unit'),
        closePriceInput,
        el('p', { class: 'form-group__hint' },
          'eToro "Close Rate" column — the price you sold at.'),
      ),
    ),
    el('h3', { style: { fontSize: 'var(--f-md)', marginTop: 'var(--space-4)', marginBottom: 'var(--space-2)' } },
      'Fees (native currency, optional)'),
    el('div', { class: 'form-row' },
      el('div', { class: 'form-group' },
        el('label', { for: 'cp-open-fee' }, 'Opening spread fee'),
        openFeeInput,
        el('p', { class: 'form-group__hint' }, 'Usually 0 on eToro for stocks.'),
      ),
      el('div', { class: 'form-group' },
        el('label', { for: 'cp-close-fee' }, 'Closing spread fee'),
        closeFeeInput,
        el('p', { class: 'form-group__hint' }, 'eToro "Market Spread" column.'),
      ),
      el('div', { class: 'form-group' },
        el('label', { for: 'cp-overnight' }, 'Overnight/holding fees'),
        overnightFeeInput,
        el('p', { class: 'form-group__hint' },
          'CFDs only. Sum of nightly charges.'),
      ),
    ),
    el('h3', { style: { fontSize: 'var(--f-md)', marginTop: 'var(--space-4)', marginBottom: 'var(--space-2)' } },
      'GBP conversion preview'),
    el('p', { class: 'form-group__hint', style: { marginBottom: 'var(--space-3)' } },
      'Cost and proceeds are converted separately using ECB reference rates on their respective dates (HMRC method). ',
      'Some trading platforms apply only a close-date rate to the native-currency profit, so their reported GBP figure may differ from ours when the currency moves between open and close.'),
    previewPanel,
    el('div', { class: 'form-group', style: { marginTop: 'var(--space-4)' } },
      el('label', { for: 'cp-notes' }, 'Notes'),
      notesInput,
    ),
  );

  const submitBtn = el('button', { type: 'submit', class: 'button button--full' },
    editing ? 'Update closed position' : 'Record closed position');
  const cancelBtn = el('button', {
    type: 'button',
    class: 'button button--ghost button--full',
    onclick: () => navigate('/transactions'),
  }, 'Cancel');

  form.append(el('div', { class: 'button-row', style: { marginTop: 'var(--space-5)' } }, submitBtn, cancelBtn));

  // ==================== Submit ====================

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    submitBtn.disabled = true;
    submitBtn.textContent = 'Saving…';

    try {
      const symbol = symbolInput.value.trim().toUpperCase();
      const name = nameInput.value.trim() || symbol;
      const accountId = accountSelect.value;
      const assetClass = classSelect.value;
      const currency = currencySelect.value;
      const openDate = openDateInput.value;
      const closeDate = closeDateInput.value;
      const qty = parseFloat(qtyInput.value);
      const openPrice = parseFloat(openPriceInput.value);
      const closePrice = parseFloat(closePriceInput.value);
      const openFee = parseFloat(openFeeInput.value || '0');
      const closeFee = parseFloat(closeFeeInput.value || '0');
      const overnightFee = parseFloat(overnightFeeInput.value || '0');
      const notes = notesInput.value.trim();

      if (!symbol) throw new Error('Symbol required');
      if (!openDate || !closeDate) throw new Error('Both dates required');
      if (openDate > closeDate) throw new Error('Open date must be on or before close date');
      if (qty <= 0) throw new Error('Quantity must be positive');
      if (openPrice <= 0 || closePrice <= 0) throw new Error('Prices must be positive');

      // Fetch FX rates for both dates. These become the fxRate on the
      // corresponding transactions, marked as 'auto' so the pool engine
      // won't re-fetch them (they're already correct for this specific date).
      let fxOpen = 1, fxClose = 1;
      if (currency !== 'GBP') {
        fxOpen = await getFxRate(currency, openDate);
        fxClose = await getFxRate(currency, closeDate);
        if (fxOpen === null) throw new Error(`FX rate for ${currency}→GBP unavailable on open date ${openDate}. Try again in a moment, or enter manually later.`);
        if (fxClose === null) throw new Error(`FX rate for ${currency}→GBP unavailable on close date ${closeDate}.`);
      }

      // ===== Asset creation / lookup =====
      const isCfd = assetClass.startsWith('cfd-');
      const engineType = isCfd
        ? (assetClass === 'cfd-commodity' ? 'gold-physical' : 'equity')
        : (assetClass === 'etf' ? 'etf' : assetClass === 'crypto' ? 'crypto' : 'equity');
      const storedTicker = isCfd ? `${symbol}.CFD` : symbol;

      const existingAsset = (await getAll('assets')).find(
        (a) => a.ticker?.toUpperCase() === storedTicker.toUpperCase()
      );
      let asset = existingAsset;
      if (!asset) {
        asset = {
          id: uuid(),
          type: engineType,
          ticker: storedTicker,
          name: isCfd ? `${name} (CFD)` : name,
          baseCurrency: currency,
          exchange: isCfd ? 'CFD' : 'UNKNOWN',
          meta: isCfd ? { cfd: true } : {},
        };
        await put('assets', asset);
      }

      // ===== Build transactions =====
      // When editing, preserve the existing IDs and createdAt so edits
      // update the same records. When creating, generate fresh UUIDs.
      const buyId = editing ? editing.buy.id : uuid();
      const sellId = editing ? editing.sell.id : uuid();
      const createdAt = editing ? editing.buy.createdAt : new Date().toISOString();

      const buyTxn = {
        id: buyId,
        date: openDate,
        type: 'buy',
        assetId: asset.id,
        accountId,
        quantity: qty,
        pricePerUnit: openPrice,
        currency,
        fxRate: fxOpen,
        fxSource: currency === 'GBP' ? 'trivial' : 'auto',
        fees: openFee,
        taxYear: ukTaxYear(openDate),
        notes: notes || '',
        createdAt,
        updatedAt: editing ? new Date().toISOString() : undefined,
        sourceTag: 'closed-position',
        pairId: sellId,
      };
      const sellTxn = {
        id: sellId,
        date: closeDate,
        type: 'sell',
        assetId: asset.id,
        accountId,
        quantity: qty,
        pricePerUnit: closePrice,
        currency,
        fxRate: fxClose,
        fxSource: currency === 'GBP' ? 'trivial' : 'auto',
        fees: closeFee + overnightFee,
        taxYear: ukTaxYear(closeDate),
        notes: notes || '',
        createdAt,
        updatedAt: editing ? new Date().toISOString() : undefined,
        sourceTag: 'closed-position',
        pairId: buyId,
      };

      await put('transactions', buyTxn);
      await put('transactions', sellTxn);

      // Remember this account for the next closed-position entry
      const currentSettings = (await get('settings', 'main')) || { id: 'main' };
      currentSettings.lastClosedPositionAccountId = accountId;
      await put('settings', currentSettings);

      // Compute final gain for toast message
      const costGbp = (qty * openPrice + openFee) * fxOpen;
      const proceedsGbp = (qty * closePrice - closeFee - overnightFee) * fxClose;
      const gainGbp = proceedsGbp - costGbp;
      toast(`${symbol}: ${gainGbp >= 0 ? '+' : ''}£${gainGbp.toFixed(2)} ${editing ? 'updated' : 'recorded'}`);
      navigate('/transactions');
    } catch (err) {
      console.error(err);
      toast(`Could not save: ${err.message}`, { error: true });
      submitBtn.disabled = false;
      submitBtn.textContent = editing ? 'Update closed position' : 'Record closed position';
    }
  });

  mount.append(el('section', { class: 'ledger-page' }, form));
}

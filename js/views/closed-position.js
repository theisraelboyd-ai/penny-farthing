/* Closed Position entry view.
 *
 * Purpose: record already-matched disposals from platforms that do their
 * own lot matching (eToro, Trading 212, Robinhood). The user enters:
 *   - Open date, close date
 *   - Symbol
 *   - GBP proceeds (or native + currency; we can FX them)
 *   - GBP cost basis
 *   - Account (wrapper determines tax treatment)
 *   - CFD flag (ring-fenced vs standard CGT pool)
 *
 * We synthesise a paired buy+sell that lands in the pool engine cleanly:
 *   - Buy on open date with cost basis as total gross
 *   - Sell on close date with proceeds as total gross
 *   - A unique asset is created per closed-position batch if using CFD mode
 *     so CFD gains/losses don't pool with your spot stock holdings
 *
 * This is one-way: once entered, edit via the Activity view or delete both
 * transactions individually.
 */

import { el, formatCurrency, toast } from '../ui.js';
import { getAll, put, uuid } from '../storage/indexeddb.js';
import { ukTaxYear } from '../storage/schema.js';
import { navigate } from '../router.js';

export async function renderClosedPosition(mount) {
  const [accounts, assets] = await Promise.all([
    getAll('accounts'),
    getAll('assets'),
  ]);

  mount.append(
    el('div', { class: 'view-header' },
      el('h2', {}, 'Record closed position'),
      el('p', {},
        'For already-matched disposals from eToro, Trading 212, or similar. Enter open + close dates and totals — the app records the buy and sell in one go.'),
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

  // ----- Build the form -----
  const form = el('form', { class: 'stacked-form' });

  // Symbol
  const symbolInput = el('input', {
    type: 'text', id: 'cp-symbol', class: 'input',
    placeholder: 'TSLA, NVDA, RGTI …',
    required: true, autocomplete: 'off',
  });

  // Asset name (optional, helpful for CFDs and one-off tickers)
  const nameInput = el('input', {
    type: 'text', id: 'cp-name', class: 'input',
    placeholder: 'Tesla Motors Inc (optional)',
    autocomplete: 'off',
  });

  // Account
  const accountSelect = el('select', { class: 'select', id: 'cp-account', required: true },
    ...accounts.map((a) =>
      el('option', { value: a.id }, `${a.name} · ${a.wrapper} · ${a.platform}`)),
  );

  // Asset class — equity / etf / CFD / crypto
  const classSelect = el('select', { class: 'select', id: 'cp-class', required: true },
    el('option', { value: 'equity' }, 'Equity (stocks — CGT pool)'),
    el('option', { value: 'etf' }, 'ETF/Fund — CGT pool'),
    el('option', { value: 'cfd-stock' }, 'CFD — ring-fenced'),
    el('option', { value: 'cfd-commodity' }, 'CFD (commodity, e.g. Gold) — ring-fenced'),
    el('option', { value: 'crypto' }, 'Crypto — separate pool'),
  );

  // Open date, close date
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
    placeholder: '10.5',
  });

  // Cost basis and proceeds in GBP
  const costInput = el('input', {
    type: 'number', id: 'cp-cost', class: 'input',
    step: '0.01', required: true,
    placeholder: '1495.34',
  });
  const proceedsInput = el('input', {
    type: 'number', id: 'cp-proceeds', class: 'input',
    step: '0.01', required: true,
    placeholder: '2076.16',
  });

  // Fees
  const feesInput = el('input', {
    type: 'number', id: 'cp-fees', class: 'input',
    step: '0.01', value: '0',
    placeholder: '0',
  });

  // Live P&L readout
  const pnlReadout = el('div', {
    style: {
      padding: 'var(--space-3)',
      background: 'var(--surface-2)',
      borderRadius: 'var(--radius-md)',
      fontFamily: 'var(--font-mono)',
      fontSize: 'var(--f-sm)',
      marginTop: 'var(--space-2)',
    },
  }, 'P&L: —');

  const updatePnl = () => {
    const cost = parseFloat(costInput.value || '0');
    const proceeds = parseFloat(proceedsInput.value || '0');
    const fees = parseFloat(feesInput.value || '0');
    if (isNaN(cost) || isNaN(proceeds)) {
      pnlReadout.textContent = 'P&L: —';
      pnlReadout.style.color = 'var(--text-muted)';
      return;
    }
    const pnl = proceeds - cost - fees;
    const sign = pnl >= 0 ? '+' : '';
    pnlReadout.textContent = `P&L: ${sign}£${pnl.toFixed(2)}`;
    pnlReadout.style.color = pnl >= 0 ? 'var(--gain)' : 'var(--loss)';
  };
  costInput.addEventListener('input', updatePnl);
  proceedsInput.addEventListener('input', updatePnl);
  feesInput.addEventListener('input', updatePnl);

  // Notes
  const notesInput = el('textarea', {
    id: 'cp-notes', class: 'input',
    placeholder: 'Position ID 2960821389 (optional — useful for cross-reference)',
    rows: 2,
  });

  // ----- Layout -----
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
          'CFDs are ring-fenced: CFD losses can only offset CFD gains, per TCGA 1992 s.143.'),
      ),
    ),
    el('div', { class: 'form-group' },
      el('label', { for: 'cp-name' }, 'Full name (optional)'),
      nameInput,
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
    el('div', { class: 'form-group' },
      el('label', { for: 'cp-qty' }, 'Quantity (units / contracts)'),
      qtyInput,
    ),
    el('div', { class: 'form-row' },
      el('div', { class: 'form-group' },
        el('label', { for: 'cp-cost' }, 'Cost basis (GBP)'),
        costInput,
        el('p', { class: 'form-group__hint' },
          'Total paid to open including fees.'),
      ),
      el('div', { class: 'form-group' },
        el('label', { for: 'cp-proceeds' }, 'Proceeds (GBP)'),
        proceedsInput,
        el('p', { class: 'form-group__hint' },
          'Total received on close.'),
      ),
    ),
    el('div', { class: 'form-group' },
      el('label', { for: 'cp-fees' }, 'Additional fees (GBP)'),
      feesInput,
      el('p', { class: 'form-group__hint' },
        'Overnight fees, spread fees etc. Already-included fees can stay at 0.'),
    ),
    pnlReadout,
    el('div', { class: 'form-group', style: { marginTop: 'var(--space-4)' } },
      el('label', { for: 'cp-notes' }, 'Notes'),
      notesInput,
    ),
  );

  const submitBtn = el('button', { type: 'submit', class: 'button button--full' }, 'Record closed position');
  const cancelBtn = el('button', {
    type: 'button',
    class: 'button button--ghost button--full',
    onclick: () => navigate('/transactions'),
  }, 'Cancel');

  form.append(el('div', { class: 'button-row', style: { marginTop: 'var(--space-5)' } }, submitBtn, cancelBtn));

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    submitBtn.disabled = true;
    submitBtn.textContent = 'Recording…';

    try {
      const symbol = symbolInput.value.trim().toUpperCase();
      const name = nameInput.value.trim() || symbol;
      const accountId = accountSelect.value;
      const assetClass = classSelect.value;
      const openDate = openDateInput.value;
      const closeDate = closeDateInput.value;
      const quantity = parseFloat(qtyInput.value);
      const cost = parseFloat(costInput.value);
      const proceeds = parseFloat(proceedsInput.value);
      const fees = parseFloat(feesInput.value || '0');
      const notes = notesInput.value.trim();

      if (!symbol) throw new Error('Symbol required');
      if (!openDate || !closeDate) throw new Error('Both dates required');
      if (openDate > closeDate) throw new Error('Open date must be on or before close date');
      if (quantity <= 0) throw new Error('Quantity must be positive');
      if (cost < 0 || proceeds < 0) throw new Error('Cost and proceeds must be non-negative');

      // Map asset class to engine type + CFD flag
      // For CFDs we create a separate asset record with a distinct ticker suffix
      // so the pool engine keeps them ring-fenced from stock pools of the same symbol.
      const isCfd = assetClass.startsWith('cfd-');
      const engineType = isCfd
        ? (assetClass === 'cfd-commodity' ? 'gold-physical' : 'equity')
        : (assetClass === 'etf' ? 'etf' : assetClass === 'crypto' ? 'crypto' : 'equity');
      const storedTicker = isCfd ? `${symbol}.CFD` : symbol;

      // Find or create the asset
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
          baseCurrency: 'GBP',  // we record in GBP directly
          exchange: isCfd ? 'CFD' : 'UNKNOWN',
          meta: isCfd ? { cfd: true } : {},
        };
        await put('assets', asset);
      }

      // Build buy and sell transactions.
      // Price per unit is cost/qty for the buy, proceeds/qty for the sell.
      // Fees sit on the sell side (reducing proceeds) — cleaner for CGT audit.
      const buyPrice = cost / quantity;
      const sellPrice = proceeds / quantity;

      const buyTxn = {
        id: uuid(),
        date: openDate,
        type: 'buy',
        assetId: asset.id,
        accountId,
        quantity,
        pricePerUnit: buyPrice,
        currency: 'GBP',
        fxRate: 1,
        fxSource: 'trivial',
        fees: 0,
        taxYear: ukTaxYear(openDate),
        notes: notes || `Matched pair (closed position)`,
        createdAt: new Date().toISOString(),
        sourceTag: 'closed-position',
      };
      const sellTxn = {
        id: uuid(),
        date: closeDate,
        type: 'sell',
        assetId: asset.id,
        accountId,
        quantity,
        pricePerUnit: sellPrice,
        currency: 'GBP',
        fxRate: 1,
        fxSource: 'trivial',
        fees,
        taxYear: ukTaxYear(closeDate),
        notes: notes || `Matched pair (closed position)`,
        createdAt: new Date().toISOString(),
        sourceTag: 'closed-position',
        pairId: buyTxn.id,  // link for future audit / delete-as-pair
      };
      buyTxn.pairId = sellTxn.id;

      await put('transactions', buyTxn);
      await put('transactions', sellTxn);

      const pnl = proceeds - cost - fees;
      toast(`${symbol}: ${pnl >= 0 ? '+' : ''}£${pnl.toFixed(2)} recorded`);
      navigate('/transactions');
    } catch (err) {
      console.error(err);
      toast(`Could not save: ${err.message}`, { error: true });
      submitBtn.disabled = false;
      submitBtn.textContent = 'Record closed position';
    }
  });

  mount.append(
    el('section', { class: 'ledger-page' }, form),
  );
}

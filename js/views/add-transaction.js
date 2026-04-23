/* Add Transaction view
 *
 * Supports: buy / sell / dividend / fee
 * - Lets user pick existing asset or create new
 * - Captures txn currency, FX rate, fees
 * - Auto-tags the UK tax year based on date
 */

import { el, toast, todayIso } from '../ui.js';
import { getAll, put, uuid } from '../storage/indexeddb.js';
import { listAssetTypes, getHandler } from '../assets/registry.js';
import { ukTaxYear } from '../storage/schema.js';
import { navigate } from '../router.js';

export async function renderAddTransaction(mount) {
  const assets = await getAll('assets');
  const accounts = await getAll('accounts');

  // If the user has no accounts yet, gently push them to create one first.
  if (accounts.length === 0) {
    mount.append(
      el('section', { class: 'ledger-page' },
        el('div', { class: 'ledger-page__heading' },
          el('h2', {}, 'First, open an account'),
          el('span', { class: 'ledger-page__folio' }, 'Required'),
        ),
        el('p', {}, 'You have not yet recorded any accounts. An account is the ',
          'broker or platform where you hold assets — IBKR GIA, eToro, Bullion By Post, and so on.'),
        el('p', {}, 'Open the first one now:'),
        renderAccountForm(async () => {
          // Hash already points at /add, so navigate() won't re-fire the router.
          // Re-render in place instead.
          mount.innerHTML = '';
          await renderAddTransaction(mount);
        }),
      )
    );
    return;
  }

  const page = el('section', { class: 'ledger-page' },
    el('div', { class: 'ledger-page__heading' },
      el('h2', {}, 'Record a transaction'),
    ),
    el('p', { class: 'ledger-page__subtitle' },
      'Enter a buy, sell, dividend, or fee. The tax year is set automatically from the date.'),
    el('div', {
      style: {
        padding: 'var(--space-3)',
        background: 'var(--surface-2)',
        borderRadius: 'var(--radius-md)',
        marginBottom: 'var(--space-4)',
        fontSize: 'var(--f-sm)',
      },
    },
      el('strong', {}, 'Recording an already-closed trade? '),
      'Use ',
      el('a', {
        href: '#/closed',
        style: { color: 'var(--accent)', fontWeight: '500' },
      }, 'Record closed position'),
      ' instead — enter open + close in one go, designed for eToro / Trading 212 history.',
    ),
  );

  // --- Transaction type selector ---
  const typeField = el('div', { class: 'form-group' },
    el('label', {}, 'Transaction type'),
    el('div', { class: 'segmented', role: 'radiogroup' },
      ...['buy', 'sell', 'dividend', 'fee'].map((t, i) => [
        el('input', { type: 'radio', name: 'txnType', id: `txn-${t}`, value: t, ...(i === 0 ? { checked: true } : {}) }),
        el('label', { for: `txn-${t}` }, t.charAt(0).toUpperCase() + t.slice(1)),
      ]).flat(),
    ),
  );

  // --- Date ---
  const dateField = el('div', { class: 'form-group' },
    el('label', { for: 'txn-date' }, 'Date'),
    el('input', { type: 'date', id: 'txn-date', class: 'input', value: todayIso(), required: true }),
    el('p', { class: 'form-group__hint', id: 'tax-year-hint' }, `Tax year ${ukTaxYear(todayIso())}`),
  );
  dateField.querySelector('input').addEventListener('change', (e) => {
    dateField.querySelector('#tax-year-hint').textContent = `Tax year ${ukTaxYear(e.target.value)}`;
  });

  // --- Account ---
  const accountField = el('div', { class: 'form-group' },
    el('label', { for: 'txn-account' }, 'Account'),
    el('select', { id: 'txn-account', class: 'select', required: true },
      ...accounts.map((a) => el('option', { value: a.id },
        `${a.name} · ${a.wrapper}`)),
    ),
    el('p', { class: 'form-group__hint' }, 'Managed in Settings → Accounts.'),
  );

  // --- Asset picker (existing or new) ---
  const assetSection = el('div', { class: 'form-group' },
    el('label', { for: 'txn-asset' }, 'Asset'),
    el('select', { id: 'txn-asset', class: 'select' },
      el('option', { value: '__new__' }, '+ New asset…'),
      ...assets.map((a) => el('option', { value: a.id }, `${a.ticker} — ${a.name}`)),
    ),
  );

  const newAssetWrap = el('div', { id: 'new-asset-wrap', style: { display: assets.length ? 'none' : 'block', marginTop: '1rem' } });
  assetSection.appendChild(newAssetWrap);

  // Render new-asset subform on demand
  const renderNewAssetForm = () => {
    newAssetWrap.innerHTML = '';
    const typeSelect = el('select', { id: 'new-asset-type', class: 'select' },
      ...listAssetTypes().map((t) => el('option', { value: t.key }, t.label)),
    );
    const fieldsWrap = el('div', { id: 'new-asset-fields' });

    const renderFields = () => {
      fieldsWrap.innerHTML = '';
      const type = typeSelect.value;
      const handler = getHandler(type);
      for (const f of handler.formFields()) {
        const input = f.type === 'select'
          ? el('select', { id: `asset-${f.name}`, class: 'select', ...(f.required ? { required: true } : {}) },
              ...(f.options || []).map((o) => {
                if (typeof o === 'string') return el('option', { value: o }, o);
                return el('option', { value: o.value }, o.label);
              }))
          : el('input', {
              type: f.type, id: `asset-${f.name}`, class: 'input',
              ...(f.required ? { required: true } : {}),
              ...(f.type === 'number' ? { step: 'any' } : {}),
            });
        // Apply default
        if (handler.defaults?.[f.name] != null && f.type === 'select') {
          input.value = handler.defaults[f.name];
        }
        fieldsWrap.append(
          el('div', { class: 'form-group' },
            el('label', { for: `asset-${f.name}` }, f.label),
            input,
            f.hint ? el('p', { class: 'form-group__hint' }, f.hint) : null,
          )
        );
      }
    };

    typeSelect.addEventListener('change', renderFields);

    newAssetWrap.append(
      el('p', { class: 'form-group__hint italic' }, 'Creating a new asset record.'),
      el('div', { class: 'form-group' },
        el('label', { for: 'new-asset-type' }, 'Asset type'),
        typeSelect,
      ),
      fieldsWrap,
    );
    renderFields();
  };

  assetSection.querySelector('#txn-asset').addEventListener('change', (e) => {
    if (e.target.value === '__new__') {
      newAssetWrap.style.display = 'block';
      renderNewAssetForm();
    } else {
      newAssetWrap.style.display = 'none';
    }
  });

  if (assets.length === 0) {
    renderNewAssetForm();
  }

  // --- Quantity / price / currency / fees ---
  const qtyField = el('div', { class: 'form-group' },
    el('label', { for: 'txn-qty' }, 'Quantity'),
    el('input', { type: 'number', id: 'txn-qty', class: 'input', step: 'any', required: true,
      placeholder: 'e.g. 100 (shares), 2 (coins), 0.5 (BTC)' }),
  );

  const priceField = el('div', { class: 'form-group' },
    el('label', { for: 'txn-price' }, 'Price per unit'),
    el('input', { type: 'number', id: 'txn-price', class: 'input', step: 'any', required: true,
      placeholder: 'Native currency, e.g. 14.32' }),
  );

  const currencyField = el('div', { class: 'form-group' },
    el('label', { for: 'txn-currency' }, 'Currency'),
    el('select', { id: 'txn-currency', class: 'select', required: true },
      ...['GBP', 'GBX', 'USD', 'EUR', 'CHF', 'JPY', 'CAD', 'AUD'].map((c) =>
        el('option', { value: c }, c)),
    ),
    el('p', { class: 'form-group__hint' },
      'GBX = pence sterling (100 GBX = 1 GBP). Many LSE-listed shares quote in GBX.'),
  );

  const fxField = el('div', { class: 'form-group' },
    el('label', { for: 'txn-fx' }, 'FX rate to GBP'),
    el('input', { type: 'number', id: 'txn-fx', class: 'input', step: 'any', value: '1' }),
    el('p', { class: 'form-group__hint' },
      'Leave at 1 to auto-fetch from Frankfurter (ECB end-of-day rate). Enter your broker’s actual executed rate for more accuracy — manually-entered rates are preserved and never overwritten.'),
  );

  const feesField = el('div', { class: 'form-group' },
    el('label', { for: 'txn-fees' }, 'Fees & commission'),
    el('input', { type: 'number', id: 'txn-fees', class: 'input', step: 'any', value: '0' }),
    el('p', { class: 'form-group__hint' },
      'Total fees in transaction currency. These reduce the allowable CGT gain.'),
  );

  const priceRow = el('div', { class: 'form-row' }, priceField, currencyField);
  const fxRow = el('div', { class: 'form-row' }, fxField, feesField);

  // --- Notes ---
  const notesField = el('div', { class: 'form-group' },
    el('label', { for: 'txn-notes' }, 'Notes'),
    el('input', { type: 'text', id: 'txn-notes', class: 'input', placeholder: 'Optional' }),
  );

  // --- Submit ---
  const submitBtn = el('button', { type: 'submit', class: 'button button--full' }, 'Record entry');
  const cancelBtn = el('button', { type: 'button', class: 'button button--ghost button--full', onclick: () => navigate('/dashboard') }, 'Cancel');

  const form = el('form', { class: 'txn-form', autocomplete: 'off' },
    typeField, dateField, accountField, assetSection,
    qtyField, priceRow, fxRow, notesField,
    el('div', { class: 'button-row' }, submitBtn, cancelBtn),
  );

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    submitBtn.disabled = true;

    try {
      // Resolve asset
      let assetId = form.querySelector('#txn-asset').value;
      if (assetId === '__new__') {
        const type = form.querySelector('#new-asset-type').value;
        const handler = getHandler(type);
        const meta = {};
        const asset = {
          id: uuid(),
          type,
          meta,
        };
        for (const f of handler.formFields()) {
          const val = form.querySelector(`#asset-${f.name}`)?.value;
          if (val == null) continue;
          if (['ticker', 'name', 'exchange', 'baseCurrency'].includes(f.name)) {
            asset[f.name] = val;
          } else {
            meta[f.name] = val;
          }
        }
        if (!asset.ticker) asset.ticker = (asset.name || 'ASSET').slice(0, 8).toUpperCase();
        await put('assets', asset);
        assetId = asset.id;
      }

      const date = form.querySelector('#txn-date').value;
      const txnType = form.querySelector('input[name="txnType"]:checked').value;
      const quantity = parseFloat(form.querySelector('#txn-qty').value);
      const pricePerUnit = parseFloat(form.querySelector('#txn-price').value);
      const currency = form.querySelector('#txn-currency').value;
      const fxRateRaw = form.querySelector('#txn-fx').value;
      const fxRate = parseFloat(fxRateRaw || '1');
      const fees = parseFloat(form.querySelector('#txn-fees').value || '0');
      const accountId = form.querySelector('#txn-account').value;
      const notes = form.querySelector('#txn-notes').value || '';

      // Decide FX source:
      //   - GBP/GBX: trivial, handled by the engine
      //   - Foreign currency where user left the default of "1": mark auto,
      //     Frankfurter will fetch on next portfolio render
      //   - Foreign currency with a user-entered value != 1: mark manual,
      //     never overwritten
      let fxSource = 'trivial';
      if (currency !== 'GBP' && currency !== 'GBX') {
        const userTouchedRate = fxRateRaw !== '' && fxRateRaw !== '1' && parseFloat(fxRateRaw) !== 1;
        fxSource = userTouchedRate ? 'manual' : 'auto';
      }

      const txn = {
        id: uuid(),
        date,
        type: txnType,
        assetId,
        accountId,
        quantity,
        pricePerUnit,
        currency,
        fxRate,
        fxSource,
        fees,
        taxYear: ukTaxYear(date),
        notes,
        createdAt: new Date().toISOString(),
      };

      await put('transactions', txn);
      toast(`Recorded ${txnType} · ${quantity} units`);
      navigate('/transactions');
    } catch (err) {
      console.error(err);
      toast(`Could not save: ${err.message}`, { error: true });
      submitBtn.disabled = false;
    }
  });

  page.append(form);
  mount.append(page);
}

/* Minimal account-creation form, used when no accounts exist yet. */
function renderAccountForm(onDone) {
  const form = el('form', {},
    el('div', { class: 'form-group' },
      el('label', { for: 'acc-name' }, 'Account name'),
      el('input', { type: 'text', id: 'acc-name', class: 'input', required: true,
        placeholder: 'e.g. "IBKR GIA", "eToro", "Bullion By Post"' }),
    ),
    el('div', { class: 'form-row' },
      el('div', { class: 'form-group' },
        el('label', { for: 'acc-platform' }, 'Platform'),
        el('select', { id: 'acc-platform', class: 'select' },
          el('option', { value: 'ibkr' }, 'Interactive Brokers'),
          el('option', { value: 'etoro' }, 'eToro'),
          el('option', { value: 'bullion-by-post' }, 'Bullion By Post'),
          el('option', { value: 'bank' }, 'Bank'),
          el('option', { value: 'other' }, 'Other'),
        ),
      ),
      el('div', { class: 'form-group' },
        el('label', { for: 'acc-wrapper' }, 'Wrapper'),
        el('select', { id: 'acc-wrapper', class: 'select' },
          el('option', { value: 'GIA' }, 'General Investment Account (CGT applies)'),
          el('option', { value: 'ISA' }, 'Stocks & Shares ISA (tax-free)'),
          el('option', { value: 'SIPP' }, 'SIPP (pension, tax-free)'),
          el('option', { value: 'UNWRAPPED' }, 'Unwrapped (e.g. physical gold)'),
        ),
      ),
    ),
    el('div', { class: 'form-group' },
      el('label', { for: 'acc-currency' }, 'Default currency'),
      el('select', { id: 'acc-currency', class: 'select' },
        ...['GBP', 'USD', 'EUR'].map((c) => el('option', { value: c }, c)),
      ),
    ),
    el('div', { class: 'button-row' },
      el('button', { type: 'submit', class: 'button button--full' }, 'Open account'),
    ),
  );

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const account = {
      id: uuid(),
      name: form.querySelector('#acc-name').value,
      platform: form.querySelector('#acc-platform').value,
      wrapper: form.querySelector('#acc-wrapper').value,
      baseCurrency: form.querySelector('#acc-currency').value,
      createdAt: new Date().toISOString(),
    };
    await put('accounts', account);
    toast(`Opened account: ${account.name}`);
    if (onDone) onDone();
  });

  return form;
}

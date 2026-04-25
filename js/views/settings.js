/* Settings view
 *
 * Houses:
 *   - SED status per tax year + non-SED taxable income
 *   - Finnhub API key (for Day 3 prices)
 *   - GitHub token + Gist ID (for Day 2 sync)
 *   - Account management
 *   - JSON export / import (local backup)
 *   - App info
 */

import { el, toast } from '../ui.js';
import { get, put, getAll, remove, exportAll, importAll, uuid } from '../storage/indexeddb.js';
import { ukTaxYear } from '../storage/schema.js';

export async function renderSettings(mount) {
  const settings = (await get('settings', 'main')) || { id: 'main' };
  const currentYear = ukTaxYear(new Date());
  const priorYear = (() => {
    const [y] = currentYear.split('-');
    const start = parseInt(y, 10) - 1;
    return `${start}-${(start + 1).toString().slice(-2)}`;
  })();

  mount.append(
    el('header', { class: 'view-header' },
      el('h2', {}, 'Settings'),
      el('p', {}, 'Tax-year status, connections, accounts, and backups.'),
    ),

    renderPreferencesSection(settings),
    await renderSedSection(currentYear, priorYear),
    renderConnectionsSection(settings),
    await renderAccountsSection(),
    renderBackupSection(),
    renderDeveloperSection(),
    renderAboutSection(),
  );
}

function renderPreferencesSection(settings) {
  const existing = settings || { id: 'main' };
  const defaultSed = existing.defaultSedStatus || 'pending';
  const seedLosses = existing.preTrackingSeedLosses || 0;

  const form = el('form', {});

  form.append(
    el('div', { class: 'form-row' },
      el('div', { class: 'form-group' },
        el('label', { for: 'pref-default-sed' }, 'Default SED claim status'),
        el('select', { id: 'pref-default-sed', class: 'select' },
          ...[
            ['pending', 'Pending (not yet filed / confirmed)'],
            ['claimed', 'Claimed successfully'],
            ['not-eligible', 'Not eligible'],
          ].map(([v, label]) =>
            el('option', { value: v, ...(defaultSed === v ? { selected: true } : {}) }, label)),
        ),
        el('p', { class: 'form-group__hint' },
          'Applied to every tax year unless you override it below. Most seafarers set this once to "Claimed" and forget.'),
      ),
      el('div', { class: 'form-group' },
        el('label', { for: 'pref-seed-losses' }, 'Pre-tracking loss balance (£)'),
        el('input', { type: 'number', id: 'pref-seed-losses', class: 'input',
          step: 'any', value: seedLosses, placeholder: '0' }),
        el('p', { class: 'form-group__hint' },
          'Losses reported to HMRC BEFORE you started using Penny Farthing. Usually 0. Losses within tracked years carry forward automatically.'),
      ),
    ),
    el('button', { type: 'submit', class: 'button' }, 'Save preferences'),
  );

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const updated = (await get('settings', 'main')) || { id: 'main' };
    updated.defaultSedStatus = form.querySelector('#pref-default-sed').value;
    updated.preTrackingSeedLosses = parseFloat(form.querySelector('#pref-seed-losses').value || '0');
    await put('settings', updated);
    toast('Preferences saved');
  });

  return el('section', { class: 'ledger-page' },
    el('div', { class: 'ledger-page__heading' },
      el('h2', {}, 'Preferences'),
    ),
    el('p', { class: 'ledger-page__subtitle' },
      'App-wide defaults. Set once, apply everywhere.'),
    form,
  );
}

async function renderSedSection(currentYear, priorYear) {
  const [curYearRec, priorYearRec] = await Promise.all([
    get('taxYears', currentYear),
    get('taxYears', priorYear),
  ]);

  const page = el('section', { class: 'ledger-page' },
    el('div', { class: 'ledger-page__heading' },
      el('h2', {}, 'Per-year SED overrides'),
    ),
    el('p', { class: 'ledger-page__subtitle' },
      'Override your default SED status for a specific year (e.g. a year you worked shore-side). Record your non-SED taxable income so the ledger can apportion CGT between basic and higher rate bands.'),
  );

  const sedForm = (year, rec) => {
    const existing = rec || { year, sedStatus: null, nonSedTaxableIncome: 0, lossesReported: false };

    const form = el('form', { style: { marginBottom: '1.5rem' } },
      el('h3', { style: { fontSize: '1.1rem' } }, `Tax year ${year}`),
      el('div', { class: 'form-row' },
        el('div', { class: 'form-group' },
          el('label', {}, 'SED claim status (override)'),
          el('select', { id: `sed-status-${year}`, class: 'select' },
            ...[
              ['', 'Use default'],
              ['pending', 'Pending'],
              ['claimed', 'Claimed successfully'],
              ['not-eligible', 'Not eligible this year'],
            ].map(([v, label]) =>
              el('option', { value: v, ...((existing.sedStatus || '') === v ? { selected: true } : {}) }, label)),
          ),
          el('p', { class: 'form-group__hint' },
            'Leave as "Use default" unless this year is unusual.'),
        ),
        el('div', { class: 'form-group' },
          el('label', {}, 'Non-SED taxable income (£)'),
          el('input', { type: 'number', id: `sed-income-${year}`, class: 'input', step: 'any',
            value: existing.nonSedTaxableIncome || 0 }),
          el('p', { class: 'form-group__hint' },
            'UK-taxable income this year after SED. Determines basic vs higher CGT band.'),
        ),
      ),
      el('div', { class: 'form-group' },
        el('label', {}, 'Losses reported to HMRC for this year?'),
        el('select', { id: `sed-reported-${year}`, class: 'select' },
          el('option', { value: 'true', ...(existing.lossesReported ? { selected: true } : {}) }, 'Yes'),
          el('option', { value: 'false', ...(!existing.lossesReported ? { selected: true } : {}) }, 'No — need to file'),
        ),
        el('p', { class: 'form-group__hint' },
          'Losses must be formally reported within 4 years to be usable for offset.'),
      ),
      el('button', { type: 'submit', class: 'button' }, `Save ${year}`),
    );

    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      const sedChoice = form.querySelector(`#sed-status-${year}`).value;
      await put('taxYears', {
        year,
        sedStatus: sedChoice || null,  // null = use app-wide default
        nonSedTaxableIncome: parseFloat(form.querySelector(`#sed-income-${year}`).value || '0'),
        lossesReported: form.querySelector(`#sed-reported-${year}`).value === 'true',
      });
      toast(`Saved ${year}`);
    });

    return form;
  };

  page.append(sedForm(currentYear, curYearRec));
  page.append(el('div', { class: 'motif-divider' }, '∿'));
  page.append(sedForm(priorYear, priorYearRec));

  return page;
}

function renderConnectionsSection(settings) {
  const page = el('section', { class: 'ledger-page' },
    el('div', { class: 'ledger-page__heading' },
      el('h2', {}, 'Connections'),
      el('span', { class: 'ledger-page__folio' }, 'Connections'),
    ),
    el('p', { class: 'ledger-page__subtitle' },
      'API key for prices (Finnhub). GitHub token for Gist sync. Stored locally, never sent anywhere else.'),
  );

  const form = el('form', {},
    el('div', { class: 'form-group' },
      el('label', { for: 'finnhub-key' }, 'Finnhub API key'),
      el('input', { type: 'password', id: 'finnhub-key', class: 'input',
        value: settings.finnhubApiKey || '',
        placeholder: 'Paste your free Finnhub API key' }),
      el('p', { class: 'form-group__hint' },
        'Get one free at finnhub.io/register. Day 3 will use this for live prices.'),
    ),
    el('div', { class: 'form-group' },
      el('label', { for: 'gh-token' }, 'GitHub Personal Access Token'),
      el('input', { type: 'password', id: 'gh-token', class: 'input',
        value: settings.githubToken || '',
        placeholder: 'ghp_...' }),
      el('p', { class: 'form-group__hint' },
        'Needs only the "gist" scope. See the walkthrough in /docs/.'),
    ),
    el('div', { class: 'form-group' },
      el('label', { for: 'gist-id' }, 'Gist ID (optional)'),
      el('input', { type: 'text', id: 'gist-id', class: 'input',
        value: settings.gistId || '',
        placeholder: 'Leave blank to create a new one on first sync' }),
    ),
    el('button', { type: 'submit', class: 'button' }, 'Save connections'),
  );

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const updated = {
      ...settings,
      id: 'main',
      finnhubApiKey: form.querySelector('#finnhub-key').value.trim() || null,
      githubToken: form.querySelector('#gh-token').value.trim() || null,
      gistId: form.querySelector('#gist-id').value.trim() || null,
    };
    await put('settings', updated);
    toast('Connections saved');
  });

  page.append(form);
  return page;
}

async function renderAccountsSection() {
  const accounts = await getAll('accounts');

  const page = el('section', { class: 'ledger-page' },
    el('div', { class: 'ledger-page__heading' },
      el('h2', {}, 'Accounts'),
      el('span', { class: 'ledger-page__folio' }, `${accounts.length} open`),
    ),
    el('p', { class: 'ledger-page__subtitle' },
      'Brokers, platforms, and bullion dealers where you hold assets.'),
  );

  if (accounts.length === 0) {
    page.append(el('p', { class: 'text-faint italic' },
      'No accounts yet. Open one via Record → first entry, or using the form below.'));
  } else {
    page.append(
      el('table', { class: 'hairline-table' },
        el('thead', {}, el('tr', {},
          el('th', {}, 'Name'),
          el('th', {}, 'Platform'),
          el('th', {}, 'Wrapper'),
          el('th', {}, ''),
        )),
        el('tbody', {},
          ...accounts.map((a) => el('tr', {},
            el('td', {}, a.name),
            el('td', { class: 'text-faint' }, a.platform),
            el('td', {}, el('span', { class: 'pill' }, a.wrapper)),
            el('td', { style: { textAlign: 'right' } },
              el('button', {
                class: 'button button--ghost button-sm',
                onclick: async () => {
                  if (!confirm(`Remove "${a.name}"? Any transactions linked to it will be orphaned.`)) return;
                  await remove('accounts', a.id);
                  toast('Account removed');
                  location.reload();
                },
              }, 'Remove'),
            ),
          )),
        ),
      )
    );
  }

  // Add new
  const addForm = el('form', { style: { marginTop: '1.5rem' } },
    el('h3', { style: { fontSize: '1rem' } }, 'Open a new account'),
    el('div', { class: 'form-row' },
      el('div', { class: 'form-group' },
        el('label', {}, 'Name'),
        el('input', { type: 'text', id: 'new-acc-name', class: 'input', required: true,
          placeholder: 'IBKR GIA' }),
      ),
      el('div', { class: 'form-group' },
        el('label', {}, 'Platform'),
        el('select', { id: 'new-acc-platform', class: 'select' },
          el('option', { value: 'ibkr' }, 'Interactive Brokers'),
          el('option', { value: 'etoro' }, 'eToro'),
          el('option', { value: 'bullion-by-post' }, 'Bullion By Post'),
          el('option', { value: 'bank' }, 'Bank'),
          el('option', { value: 'other' }, 'Other'),
        ),
      ),
    ),
    el('div', { class: 'form-row' },
      el('div', { class: 'form-group' },
        el('label', {}, 'Wrapper'),
        el('select', { id: 'new-acc-wrapper', class: 'select' },
          el('option', { value: 'GIA' }, 'GIA — CGT applies'),
          el('option', { value: 'ISA' }, 'ISA — tax-free'),
          el('option', { value: 'SIPP' }, 'SIPP — pension, tax-free'),
          el('option', { value: 'UNWRAPPED' }, 'Unwrapped (physical gold)'),
        ),
      ),
      el('div', { class: 'form-group' },
        el('label', {}, 'Default currency'),
        el('select', { id: 'new-acc-cur', class: 'select' },
          ...['GBP', 'USD', 'EUR'].map((c) => el('option', { value: c }, c)),
        ),
      ),
    ),
    el('button', { type: 'submit', class: 'button' }, 'Open account'),
  );

  addForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    await put('accounts', {
      id: uuid(),
      name: addForm.querySelector('#new-acc-name').value,
      platform: addForm.querySelector('#new-acc-platform').value,
      wrapper: addForm.querySelector('#new-acc-wrapper').value,
      baseCurrency: addForm.querySelector('#new-acc-cur').value,
      createdAt: new Date().toISOString(),
    });
    toast('Account opened');
    location.reload();
  });

  page.append(addForm);
  return page;
}

function renderBackupSection() {
  const page = el('section', { class: 'ledger-page' },
    el('div', { class: 'ledger-page__heading' },
      el('h2', {}, 'Backup & restore'),
      el('span', { class: 'ledger-page__folio' }, 'JSON'),
    ),
    el('p', { class: 'ledger-page__subtitle' },
      'Export the entire ledger as a single JSON file. Keep a copy anywhere you like.'),
  );

  const exportBtn = el('button', { class: 'button' }, 'Download backup (.json)');
  exportBtn.addEventListener('click', async () => {
    const data = await exportAll();
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `penny-farthing-${new Date().toISOString().slice(0, 10)}.json`;
    a.click();
    URL.revokeObjectURL(url);
    toast('Backup downloaded');
  });

  const importInput = el('input', { type: 'file', accept: 'application/json', id: 'import-file',
    style: { display: 'none' } });
  const importBtn = el('button', { class: 'button button--ghost' }, 'Restore from backup…');
  importBtn.addEventListener('click', () => importInput.click());

  importInput.addEventListener('change', async (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    if (!confirm('Restoring will REPLACE all current data. Continue?')) return;
    try {
      const text = await file.text();
      const data = JSON.parse(text);
      await importAll(data);
      toast('Backup restored');
      setTimeout(() => location.reload(), 800);
    } catch (err) {
      toast(`Restore failed: ${err.message}`, { error: true });
    }
  });

  page.append(
    el('div', { class: 'button-row' }, exportBtn, importBtn, importInput),
  );
  return page;
}

function renderDeveloperSection() {
  const page = el('section', { class: 'ledger-page' },
    el('div', { class: 'ledger-page__heading' },
      el('h2', {}, 'Import & test'),
      el('span', { class: 'ledger-page__folio' }, 'Tools'),
    ),
    el('p', { class: 'ledger-page__subtitle' },
      'Import trades from a broker CSV, load test data, or wipe everything and start fresh.'),
  );

  const importBtn = el('button', { class: 'button' }, 'Import from IBKR CSV');
  importBtn.addEventListener('click', () => {
    location.hash = '#/import';
  });

  const loadBtn = el('button', { class: 'button button--ghost' }, 'Load sample data');
  loadBtn.addEventListener('click', async () => {
    if (!confirm('Add sample accounts, assets, and ~15 transactions to your ledger?\n\nThis does NOT overwrite your existing data — it adds alongside.')) return;
    try {
      await loadSampleData();
      toast('Sample data loaded');
      setTimeout(() => location.reload(), 600);
    } catch (err) {
      console.error(err);
      toast(`Failed: ${err.message}`, { error: true });
    }
  });

  const clearForexBtn = el('button', { class: 'button button--ghost' }, 'Remove phantom forex entries');
  clearForexBtn.addEventListener('click', async () => {
    try {
      const result = await scanPhantomForex();
      if (result.assets.length === 0) {
        toast('No phantom forex entries found — your data is clean.');
        return;
      }
      const summary = result.assets
        .map((a) => `  · ${a.ticker} (${result.txnsByAsset[a.id]} transactions)`)
        .join('\n');
      const ok = confirm(
        `Found ${result.assets.length} phantom forex assets and ${result.totalTxns} associated transactions:\n\n` +
        summary +
        `\n\nThese are broker auto-conversions (e.g. GBP↔USD when buying foreign stocks) that were imported as if they were trades. They should not be in CGT calculations.\n\n` +
        `Remove them?`
      );
      if (!ok) return;
      const removed = await removePhantomForex(result);
      toast(`Removed ${removed.assets} forex assets and ${removed.transactions} transactions`);
      setTimeout(() => location.reload(), 1000);
    } catch (err) {
      console.error(err);
      toast(`Failed: ${err.message}`, { error: true });
    }
  });

  const clearSampleBtn = el('button', { class: 'button button--ghost' }, 'Clear sample data only');
  clearSampleBtn.addEventListener('click', async () => {
    if (!confirm('Remove all accounts, assets, and transactions marked as "(sample)"?\n\nYour real data will be preserved.')) return;
    try {
      const removed = await clearSampleData();
      toast(`Removed ${removed.accounts} accounts, ${removed.assets} assets, ${removed.transactions} transactions`);
      setTimeout(() => location.reload(), 800);
    } catch (err) {
      toast(`Failed: ${err.message}`, { error: true });
    }
  });

  const clearBtn = el('button', { class: 'button button--danger' }, 'Clear ALL data');
  clearBtn.addEventListener('click', async () => {
    if (!confirm('This will DELETE all transactions, assets, accounts, and settings.\n\nAre you absolutely sure?')) return;
    if (!confirm('Last chance — this cannot be undone.\n\nExport a backup first if you want to keep anything.')) return;
    try {
      await clearAllData();
      toast('All data cleared');
      setTimeout(() => location.reload(), 600);
    } catch (err) {
      toast(`Failed: ${err.message}`, { error: true });
    }
  });

  page.append(
    el('div', { class: 'button-row' }, importBtn, loadBtn, clearForexBtn, clearSampleBtn, clearBtn),
    el('p', { class: 'form-group__hint', style: { marginTop: 'var(--space-4)' } },
      'Import supports IBKR Activity Statement CSVs. Duplicates are auto-detected and pre-deselected. The "Remove phantom forex" tool cleans up broker auto-conversion entries that were imported as if they were trades.'),
  );
  return page;
}

async function scanPhantomForex() {
  const { getAll } = await import('../storage/indexeddb.js');
  const [assets, transactions] = await Promise.all([
    getAll('assets'),
    getAll('transactions'),
  ]);
  // Pseudo-asset detection: ticker matches CCY.CCY pattern (3 letters dot 3 letters,
  // both uppercase ASCII).
  const forexAssets = assets.filter((a) =>
    /^[A-Z]{3}\.[A-Z]{3}$/.test((a.ticker || '').toUpperCase().trim())
  );
  const forexAssetIds = new Set(forexAssets.map((a) => a.id));
  const txnsByAsset = {};
  let totalTxns = 0;
  for (const t of transactions) {
    if (forexAssetIds.has(t.assetId)) {
      txnsByAsset[t.assetId] = (txnsByAsset[t.assetId] || 0) + 1;
      totalTxns++;
    }
  }
  return { assets: forexAssets, txnsByAsset, totalTxns };
}

async function removePhantomForex(scan) {
  const { getAll, remove } = await import('../storage/indexeddb.js');
  const transactions = await getAll('transactions');
  const forexAssetIds = new Set(scan.assets.map((a) => a.id));

  let removedTxns = 0;
  for (const t of transactions) {
    if (forexAssetIds.has(t.assetId)) {
      await remove('transactions', t.id);
      removedTxns++;
    }
  }
  let removedAssets = 0;
  for (const a of scan.assets) {
    await remove('assets', a.id);
    removedAssets++;
  }
  return { assets: removedAssets, transactions: removedTxns };
}

async function clearSampleData() {
  const { getAll, remove } = await import('../storage/indexeddb.js');
  const accounts = await getAll('accounts');
  const sampleAccountIds = new Set(
    accounts.filter((a) => /\(sample\)/i.test(a.name || '')).map((a) => a.id)
  );
  const txns = await getAll('transactions');
  const sampleAssetIds = new Set();
  let removedTxns = 0;
  for (const t of txns) {
    if (sampleAccountIds.has(t.accountId)) {
      sampleAssetIds.add(t.assetId);
      await remove('transactions', t.id);
      removedTxns++;
    }
  }
  // Remove assets that were ONLY used by sample accounts (keep assets that real
  // transactions also reference)
  const remainingTxns = await getAll('transactions');
  const stillUsed = new Set(remainingTxns.map((t) => t.assetId));
  let removedAssets = 0;
  for (const assetId of sampleAssetIds) {
    if (!stillUsed.has(assetId)) {
      await remove('assets', assetId);
      removedAssets++;
    }
  }
  let removedAccounts = 0;
  for (const accId of sampleAccountIds) {
    await remove('accounts', accId);
    removedAccounts++;
  }
  return { accounts: removedAccounts, assets: removedAssets, transactions: removedTxns };
}

async function loadSampleData() {
  const { put, uuid } = await import('../storage/indexeddb.js');

  // Accounts
  const ibkrGia = { id: uuid(), name: 'IBKR GIA (sample)', platform: 'ibkr', wrapper: 'GIA', baseCurrency: 'USD', createdAt: new Date().toISOString() };
  const ibkrIsa = { id: uuid(), name: 'IBKR ISA (sample)', platform: 'ibkr', wrapper: 'ISA', baseCurrency: 'GBP', createdAt: new Date().toISOString() };
  const etoro   = { id: uuid(), name: 'eToro (sample)',    platform: 'etoro', wrapper: 'GIA', baseCurrency: 'USD', createdAt: new Date().toISOString() };
  const bullion = { id: uuid(), name: 'Bullion (sample)',  platform: 'bullion-by-post', wrapper: 'UNWRAPPED', baseCurrency: 'GBP', createdAt: new Date().toISOString() };

  await put('accounts', ibkrGia);
  await put('accounts', ibkrIsa);
  await put('accounts', etoro);
  await put('accounts', bullion);

  // Assets
  const rgti = { id: uuid(), type: 'equity', ticker: 'RGTI', name: 'Rigetti Computing',
    baseCurrency: 'USD', exchange: 'NASDAQ', meta: {} };
  const aapl = { id: uuid(), type: 'equity', ticker: 'AAPL', name: 'Apple Inc.',
    baseCurrency: 'USD', exchange: 'NASDAQ', meta: {} };
  const vusa = { id: uuid(), type: 'etf', ticker: 'VUSA.L', name: 'Vanguard S&P 500 UCITS ETF',
    baseCurrency: 'GBX', exchange: 'LSE', meta: { reportingStatus: 'reporting' } };
  const bar20a = { id: uuid(), type: 'gold-physical', ticker: 'AU-20G-A', name: '20g gold bar #A',
    baseCurrency: 'GBP', meta: { subType: 'bullion-bar', weightGrams: 20, purity: '24ct (99.99%)' } };
  const bar20b = { id: uuid(), type: 'gold-physical', ticker: 'AU-20G-B', name: '20g gold bar #B',
    baseCurrency: 'GBP', meta: { subType: 'bullion-bar', weightGrams: 20, purity: '24ct (99.99%)' } };
  const bar20c = { id: uuid(), type: 'gold-physical', ticker: 'AU-20G-C', name: '20g gold bar #C',
    baseCurrency: 'GBP', meta: { subType: 'bullion-bar', weightGrams: 20, purity: '24ct (99.99%)' } };
  const barOz  = { id: uuid(), type: 'gold-physical', ticker: 'AU-1OZ',  name: '1oz gold bar',
    baseCurrency: 'GBP', meta: { subType: 'bullion-bar', weightGrams: 31.1, purity: '24ct (99.99%)' } };

  for (const a of [rgti, aapl, vusa, bar20a, bar20b, bar20c, barOz]) await put('assets', a);

  // Transactions — realistic scenarios
  const txn = (date, type, asset, account, qty, price, currency, fxRate, fees = 0, notes = '') => ({
    id: uuid(), date, type, assetId: asset.id, accountId: account.id,
    quantity: qty, pricePerUnit: price, currency, fxRate, fees,
    taxYear: ukTaxYear(date), notes, createdAt: new Date().toISOString(),
  });

  const txns = [
    // Rigetti: bought early in your journey, sold some for a small profit
    txn('2025-03-15', 'buy',  rgti, ibkrGia, 100, 8.50,  'USD', 0.78, 0.50, 'first ever trade'),
    txn('2025-04-02', 'sell', rgti, ibkrGia,  50, 11.20, 'USD', 0.79, 0.50, 'early profit take'),
    // Then bought more later as you got "braver" — this triggers the 30-day rule check
    txn('2025-04-20', 'buy',  rgti, ibkrGia, 200, 14.50, 'USD', 0.76, 0.50, 'doubling down'),
    txn('2025-09-10', 'sell', rgti, ibkrGia, 100, 11.00, 'USD', 0.75, 0.50, 'cutting losses'),

    // Apple: pure GIA hold
    txn('2025-05-10', 'buy',  aapl, ibkrGia,  20, 190.00, 'USD', 0.75, 1.00),
    txn('2025-07-15', 'buy',  aapl, ibkrGia,  10, 210.00, 'USD', 0.74, 1.00),

    // VUSA in ISA — CGT-exempt
    txn('2025-06-01', 'buy',  vusa, ibkrIsa, 50, 8900, 'GBX', 1, 0),

    // eToro trade with higher fees
    txn('2025-08-05', 'buy',  aapl, etoro,   5,  220.00, 'USD', 0.73, 2.50),

    // Gold: 3x20g + 1oz bought, all sold together for ~£8k with a loss
    txn('2025-05-20', 'buy',  bar20a, bullion, 1, 1850, 'GBP', 1, 10, '20g bar A'),
    txn('2025-05-20', 'buy',  bar20b, bullion, 1, 1850, 'GBP', 1, 10, '20g bar B'),
    txn('2025-05-20', 'buy',  bar20c, bullion, 1, 1850, 'GBP', 1, 10, '20g bar C'),
    txn('2025-05-20', 'buy',  barOz,  bullion, 1, 2900, 'GBP', 1, 15, '1oz bar'),

    // Lump-sum sale: £8,000 proceeds, £30 handling fee.
    // Allocated by weight: total = 91.1g. Per bar share of £8000:
    //   20g bar → (20/91.1) × 8000 ≈ £1756.31
    //   1oz bar → (31.1/91.1) × 8000 ≈ £2731.07
    // Same proportional split for the £30 handling fee.
    txn('2026-03-10', 'sell', bar20a, bullion, 1, 1756.31, 'GBP', 1, 6.59, 'lump-sum sale (3x20g + 1oz = £8000, £30 handling)'),
    txn('2026-03-10', 'sell', bar20b, bullion, 1, 1756.31, 'GBP', 1, 6.59, 'lump-sum sale'),
    txn('2026-03-10', 'sell', bar20c, bullion, 1, 1756.31, 'GBP', 1, 6.59, 'lump-sum sale'),
    txn('2026-03-10', 'sell', barOz,  bullion, 1, 2731.07, 'GBP', 1, 10.23, 'lump-sum sale'),
  ];

  for (const t of txns) await put('transactions', t);
}

async function clearAllData() {
  const { clear } = await import('../storage/indexeddb.js');
  for (const store of ['transactions', 'assets', 'accounts', 'fxRates', 'prices', 'settings', 'taxYears']) {
    await clear(store);
  }
}

function renderAboutSection() {
  return el('section', { class: 'ledger-page' },
    el('div', { class: 'ledger-page__heading' },
      el('h2', {}, 'About'),
    ),
    el('p', {},
      el('strong', {}, 'Penny Farthing'),
      ' — a UK CGT-aware investment tracker with Section 104 pooling, automatic FX from Frankfurter, live prices from Finnhub, and SED-aware tax estimation for seafarers.'),
    el('p', { class: 'text-faint', style: { marginTop: 'var(--space-2)' } },
      'Local-first. Your data stays in your browser. Optional GitHub Gist sync for cross-device access.'),
    el('p', { class: 'text-faint italic', style: { marginTop: 'var(--space-3)' } },
      'Not tax advice. Use this to keep immaculate records and sanity-check your filings. Always have a qualified accountant review your Self Assessment.'),
  );
}

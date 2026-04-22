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

    await renderSedSection(currentYear, priorYear),
    renderConnectionsSection(settings),
    await renderAccountsSection(),
    renderBackupSection(),
    renderAboutSection(),
  );
}

async function renderSedSection(currentYear, priorYear) {
  const [curYearRec, priorYearRec] = await Promise.all([
    get('taxYears', currentYear),
    get('taxYears', priorYear),
  ]);

  const page = el('section', { class: 'ledger-page' },
    el('div', { class: 'ledger-page__heading' },
      el('h2', {}, 'Seafarer status & income'),
      el('span', { class: 'ledger-page__folio' }, 'Tax year'),
    ),
    el('p', { class: 'ledger-page__subtitle' },
      'The difference between the basic and higher CGT rate is determined by your taxable income ',
      'after SED is applied. Record that here so the ledger can compute both scenarios.'),
  );

  const sedForm = (year, rec) => {
    const existing = rec || { year, sedStatus: 'pending', nonSedTaxableIncome: 0, carriedLosses: 0, lossesReported: false };

    const form = el('form', { style: { marginBottom: '1.5rem' } },
      el('h3', { style: { fontSize: '1.1rem' } }, `Tax year ${year}`),
      el('div', { class: 'form-row' },
        el('div', { class: 'form-group' },
          el('label', {}, 'SED claim status'),
          el('select', { id: `sed-status-${year}`, class: 'select' },
            ...[
              ['pending', 'Pending (not yet filed/confirmed)'],
              ['claimed', 'Claimed successfully'],
              ['not-eligible', 'Not eligible this year'],
            ].map(([v, label]) =>
              el('option', { value: v, ...(existing.sedStatus === v ? { selected: true } : {}) }, label)),
          ),
        ),
        el('div', { class: 'form-group' },
          el('label', {}, 'Non-SED taxable income (£)'),
          el('input', { type: 'number', id: `sed-income-${year}`, class: 'input', step: 'any',
            value: existing.nonSedTaxableIncome || 0 }),
        ),
      ),
      el('div', { class: 'form-row' },
        el('div', { class: 'form-group' },
          el('label', {}, 'Losses brought forward (£)'),
          el('input', { type: 'number', id: `sed-losses-${year}`, class: 'input', step: 'any',
            value: existing.carriedLosses || 0 }),
          el('p', { class: 'form-group__hint' },
            'Only prior-year losses you have already reported to HMRC.'),
        ),
        el('div', { class: 'form-group' },
          el('label', {}, 'Losses formally reported?'),
          el('select', { id: `sed-reported-${year}`, class: 'select' },
            el('option', { value: 'true', ...(existing.lossesReported ? { selected: true } : {}) }, 'Yes'),
            el('option', { value: 'false', ...(!existing.lossesReported ? { selected: true } : {}) }, 'No — need to file'),
          ),
        ),
      ),
      el('button', { type: 'submit', class: 'button' }, `Save ${year}`),
    );

    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      await put('taxYears', {
        year,
        sedStatus: form.querySelector(`#sed-status-${year}`).value,
        nonSedTaxableIncome: parseFloat(form.querySelector(`#sed-income-${year}`).value || '0'),
        carriedLosses: parseFloat(form.querySelector(`#sed-losses-${year}`).value || '0'),
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

function renderAboutSection() {
  return el('section', { class: 'ledger-page' },
    el('div', { class: 'ledger-page__heading' },
      el('h2', {}, 'About'),
      el('span', { class: 'ledger-page__folio' }, 'About'),
    ),
    el('p', {},
      el('em', {}, 'Penny Farthing'),
      ' · A UK CGT-aware investment tracker for seafarers and other hearty souls.'),
    el('p', { class: 'text-faint' }, 'Version 0.1 — Day 1 scaffold.'),
    el('p', { class: 'text-faint italic' },
      'This application is not tax advice. Use it to keep immaculate records and sanity-check your filings, ',
      'then have a qualified accountant review your first year’s return.'),
  );
}

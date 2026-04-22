/* ETF / Fund handler
 *
 * IMPORTANT: UK reporting status matters.
 *   - UK-domiciled or "Reporting-status" ETFs (VUSA, VWRL, SGLN etc.)
 *     are taxed as CGT like shares.
 *   - Non-reporting offshore funds (e.g. many US-domiciled ETFs held in
 *     a GIA like VOO, SPY) are taxed as OFFSHORE INCOME GAINS at income
 *     tax rates, not CGT. The £3,000 CGT allowance does not apply.
 */

export const etfHandler = {
  label: 'ETF / Fund',
  description: 'Exchange-traded funds and mutual funds',
  pooled: true,

  formFields() {
    return [
      { name: 'ticker',   label: 'Ticker',   type: 'text',  required: true,
        hint: 'e.g. VUSA.L (UK-domiciled S&P 500), SGLN.L (physical gold)' },
      { name: 'name',     label: 'Fund name', type: 'text', required: true },
      { name: 'exchange', label: 'Exchange', type: 'select',
        options: ['LSE', 'NASDAQ', 'NYSE', 'Euronext', 'XETRA', 'Other'] },
      { name: 'baseCurrency', label: 'Listed currency', type: 'select', required: true,
        options: ['GBP', 'GBX', 'USD', 'EUR'] },
      { name: 'reportingStatus', label: 'UK Reporting Status', type: 'select', required: true,
        options: ['reporting', 'non-reporting', 'unknown'],
        hint: 'UK-domiciled and most Irish UCITS ETFs have reporting status. Many US-domiciled ETFs do NOT — their gains are taxed as income, not CGT.' },
    ];
  },

  taxBucket(asset, account) {
    if (account.wrapper === 'ISA' || account.wrapper === 'SIPP') return 'isa-exempt';
    const status = asset.meta?.reportingStatus || 'unknown';
    if (status === 'non-reporting') return 'offshore-income';
    return 'cgt';
  },

  defaults: {
    baseCurrency: 'GBP',
    exchange: 'LSE',
    reportingStatus: 'reporting',
  },
};

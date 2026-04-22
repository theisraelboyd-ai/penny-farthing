/* Listed Equity handler — individual shares */

export const equityHandler = {
  label: 'Listed Equity',
  description: 'Shares in publicly-traded companies (e.g. Rigetti, Apple, BP)',
  pooled: true,

  formFields() {
    return [
      { name: 'ticker',   label: 'Ticker',   type: 'text',  required: true,
        hint: 'e.g. RGTI for Rigetti, AAPL for Apple, BP.L for BP on LSE' },
      { name: 'name',     label: 'Company name', type: 'text', required: true },
      { name: 'exchange', label: 'Exchange', type: 'select',
        options: ['NASDAQ', 'NYSE', 'LSE', 'AIM', 'Euronext', 'XETRA', 'Other'] },
      { name: 'baseCurrency', label: 'Listed currency', type: 'select', required: true,
        options: ['GBP', 'GBX', 'USD', 'EUR', 'CHF', 'JPY', 'CAD', 'AUD'] },
    ];
  },

  taxBucket(asset, account) {
    if (account.wrapper === 'ISA' || account.wrapper === 'SIPP') return 'isa-exempt';
    return 'cgt';
  },

  defaults: {
    baseCurrency: 'USD',
    exchange: 'NASDAQ',
  },
};

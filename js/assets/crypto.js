/* Cryptocurrency handler
 *
 * HMRC treats crypto as chargeable assets under CGT, pooled per token
 * using s.104 rules the same as shares.
 *
 * NOT YET IMPLEMENTED in the transaction type list, but the infrastructure
 * is here so crypto can be added later without refactoring:
 *   - airdrops / staking / mining income = INCOME events (not capital)
 *   - swaps (BTC → ETH) = disposals at GBP market value on the day
 *   - DeFi interactions need careful record-keeping; we'll build these
 *     in when you decide to start reporting crypto.
 */

export const cryptoHandler = {
  label: 'Cryptocurrency',
  description: 'Bitcoin, Ethereum, and other crypto assets',
  pooled: true,

  formFields() {
    return [
      { name: 'ticker', label: 'Symbol', type: 'text', required: true,
        hint: 'e.g. BTC, ETH, SOL' },
      { name: 'name', label: 'Name', type: 'text', required: true },
      { name: 'baseCurrency', label: 'Purchase currency', type: 'select', required: true,
        options: ['GBP', 'USD', 'EUR', 'USDT', 'USDC'] },
    ];
  },

  taxBucket(asset, account) {
    if (account.wrapper === 'ISA' || account.wrapper === 'SIPP') return 'isa-exempt';
    return 'cgt';
  },

  defaults: {
    baseCurrency: 'GBP',
  },
};

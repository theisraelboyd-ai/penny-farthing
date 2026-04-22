/* Bond handler
 *
 * UK tax treatment:
 *   - UK Gilts (government bonds): CGT EXEMPT
 *   - Qualifying Corporate Bonds (QCBs): CGT EXEMPT
 *   - Non-QCB corporate bonds, foreign bonds: CGT applies
 *
 * Coupon interest is ALWAYS taxed as income, regardless of CGT treatment.
 */

export const bondHandler = {
  label: 'Bond / Gilt',
  description: 'Government and corporate debt securities',
  pooled: true,

  formFields() {
    return [
      { name: 'ticker', label: 'ISIN / Ticker', type: 'text', required: true },
      { name: 'name',   label: 'Bond name',     type: 'text', required: true,
        hint: 'e.g. "UK Treasury 4% 2025"' },
      { name: 'bondType', label: 'Bond type', type: 'select', required: true,
        options: [
          { value: 'uk-gilt', label: 'UK Gilt (CGT exempt)' },
          { value: 'qcb', label: 'Qualifying Corporate Bond (CGT exempt)' },
          { value: 'non-qcb', label: 'Non-QCB corporate bond (CGT applies)' },
          { value: 'foreign', label: 'Foreign bond (CGT applies)' },
        ] },
      { name: 'baseCurrency', label: 'Currency', type: 'select', required: true,
        options: ['GBP', 'USD', 'EUR'] },
    ];
  },

  taxBucket(asset, account) {
    if (account.wrapper === 'ISA' || account.wrapper === 'SIPP') return 'isa-exempt';
    const t = asset.meta?.bondType;
    if (t === 'uk-gilt' || t === 'qcb') return 'cgt-exempt';
    return 'cgt';
  },

  defaults: {
    baseCurrency: 'GBP',
    bondType: 'uk-gilt',
  },
};

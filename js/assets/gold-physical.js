/* Physical Gold handler
 *
 * UK tax treatment varies SIGNIFICANTLY by gold sub-type:
 *
 *   - "uk-legal-tender-coin": UK Sovereigns, Britannias, any year →
 *     COMPLETELY CGT EXEMPT. No reporting. No tax. No allowance usage.
 *
 *   - "foreign-coin": Krugerrands, Maple Leafs, Eagles, Pandas etc →
 *     CGT applies, treated as chattels. £6,000 chattel exemption with
 *     5/3 taper relief on gains above that threshold.
 *
 *   - "bullion-bar": Gold bars (any weight) →
 *     CGT applies, chattel rules apply in principle but the £6,000
 *     threshold is often exceeded so normal CGT kicks in.
 *
 *   - "jewellery-other": Not really an investment class but included
 *     for completeness. Chattel rules apply.
 *
 * Each physical gold item is treated as a SEPARATE ASSET, not pooled,
 * because chattel rules apply per disposal (per item or "set").
 */

export const goldPhysicalHandler = {
  label: 'Physical Gold',
  description: 'Coins, bars, and other physical precious-metal holdings',
  pooled: false,

  formFields() {
    return [
      { name: 'subType', label: 'Gold type', type: 'select', required: true,
        options: [
          { value: 'uk-legal-tender-coin', label: 'UK legal tender coin (Sovereign, Britannia) — CGT EXEMPT' },
          { value: 'foreign-coin', label: 'Foreign coin (Krugerrand, Maple Leaf, Eagle, etc.)' },
          { value: 'bullion-bar', label: 'Bullion bar' },
          { value: 'jewellery-other', label: 'Jewellery or other' },
        ] },
      { name: 'name', label: 'Description', type: 'text', required: true,
        hint: 'e.g. "2023 Half Sovereign", "100g PAMP Suisse bar", "1oz Krugerrand"' },
      { name: 'weightGrams', label: 'Weight (grams)', type: 'number', required: false,
        hint: 'Optional but useful for valuation' },
      { name: 'purity', label: 'Purity', type: 'select',
        options: ['22ct (91.67%)', '24ct (99.99%)', '18ct (75%)', 'Other'] },
      { name: 'baseCurrency', label: 'Purchase currency', type: 'select', required: true,
        options: ['GBP', 'USD', 'EUR'] },
    ];
  },

  taxBucket(asset) {
    const sub = asset.meta?.subType;
    if (sub === 'uk-legal-tender-coin') return 'cgt-exempt';
    return 'cgt-chattel';
  },

  defaults: {
    baseCurrency: 'GBP',
    purity: '22ct (91.67%)',
    subType: 'uk-legal-tender-coin',
  },
};

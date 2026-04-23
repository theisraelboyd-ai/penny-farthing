/* Penny Farthing — Data Schema
 *
 * Central definition of every entity the app stores.
 * This file is documentation-as-code: changes here drive migrations.
 *
 * All monetary values are stored as NUMBERS, not strings, in their
 * native transaction currency. GBP conversion is computed on read
 * using stored FX rates so we never lose audit-trail precision.
 */

export const DB_NAME = 'penny-farthing';
export const DB_VERSION = 1;

/**
 * OBJECT STORES
 * Each corresponds to a key-path store in IndexedDB.
 */
export const STORES = {
  /* Individual transactions — buy, sell, dividend, fee, transfer */
  transactions: {
    keyPath: 'id',
    indexes: [
      { name: 'by_date',       keyPath: 'date' },
      { name: 'by_asset',      keyPath: 'assetId' },
      { name: 'by_account',    keyPath: 'accountId' },
      { name: 'by_tax_year',   keyPath: 'taxYear' },
    ],
  },

  /* Assets — the thing you own. e.g. "Rigetti Computing common stock" */
  assets: {
    keyPath: 'id',
    indexes: [
      { name: 'by_ticker', keyPath: 'ticker' },
      { name: 'by_type',   keyPath: 'type' },
    ],
  },

  /* Accounts — where you hold assets. e.g. "IBKR ISA", "eToro GIA" */
  accounts: {
    keyPath: 'id',
    indexes: [
      { name: 'by_wrapper', keyPath: 'wrapper' },
    ],
  },

  /* FX rates cache — keyed by currency pair + date */
  fxRates: {
    keyPath: 'id',   // e.g. 'USD-GBP-2025-03-14'
    indexes: [
      { name: 'by_date', keyPath: 'date' },
    ],
  },

  /* Price history cache */
  prices: {
    keyPath: 'id',   // e.g. 'RGTI-2025-03-14'
    indexes: [
      { name: 'by_asset', keyPath: 'assetId' },
    ],
  },

  /* Settings — single-row store with id='main' */
  settings: {
    keyPath: 'id',
  },

  /* Tax-year state — one row per year holding SED status, income, etc. */
  taxYears: {
    keyPath: 'year',   // e.g. '2024-25'
  },
};

/* ============================================================
   SCHEMAS (documentation of shape, not enforced)
   ============================================================ */

/**
 * Transaction
 * @typedef {object} Transaction
 * @property {string} id                - uuid
 * @property {string} date              - ISO date 'YYYY-MM-DD'
 * @property {string} type              - 'buy' | 'sell' | 'dividend' | 'fee' | 'transfer-in' | 'transfer-out'
 * @property {string} assetId           - FK -> assets
 * @property {string} accountId         - FK -> accounts
 * @property {number} quantity          - units (shares, grams, coins, etc.)
 * @property {number} pricePerUnit      - price in txn currency
 * @property {string} currency          - ISO 4217 code, e.g. 'GBP', 'USD'
 * @property {number} fees              - total fees in txn currency
 * @property {number} fxRate            - rate to GBP on date (snapshot at entry)
 * @property {string} taxYear           - 'YYYY-YY' e.g. '2025-26'
 * @property {string} [notes]           - free text
 * @property {object} [meta]            - importer-specific original row, etc.
 */

/**
 * Asset
 * @typedef {object} Asset
 * @property {string} id                - uuid
 * @property {string} type              - key from asset-registry (equity, etf, gold-physical, crypto, bond)
 * @property {string} ticker            - e.g. 'RGTI', 'VUSA.L', 'BTC', or custom for physical gold
 * @property {string} name              - e.g. 'Rigetti Computing'
 * @property {string} baseCurrency      - native listing currency
 * @property {string} [exchange]        - e.g. 'NASDAQ', 'LSE'
 * @property {object} [taxFlags]        - e.g. { cgtExempt: true } for sovereigns
 * @property {object} [meta]            - type-specific data
 */

/**
 * Account
 * @typedef {object} Account
 * @property {string} id                - uuid
 * @property {string} name              - 'IBKR GIA', 'eToro', 'Bullion By Post'
 * @property {string} platform          - 'ibkr' | 'etoro' | 'bullion-by-post' | 'bank' | 'other'
 * @property {string} wrapper           - 'ISA' | 'GIA' | 'SIPP' | 'UNWRAPPED'
 * @property {string} baseCurrency      - default currency for reporting
 */

/**
 * TaxYear
 * @typedef {object} TaxYear
 * @property {string} year              - '2024-25'
 * @property {string|null} sedStatus    - 'claimed' | 'pending' | 'not-eligible' | null (use default)
 * @property {number} nonSedTaxableIncome - GBP, used for band determination
 * @property {boolean} lossesReported   - have the losses been formally claimed with HMRC
 *
 * Note: losses brought forward are now auto-computed by the portfolio engine
 * from prior tracked years. For losses from before the user started tracking,
 * see Settings.preTrackingSeedLosses.
 */

/**
 * Settings (single row, id='main')
 * @typedef {object} Settings
 * @property {string} id                - always 'main'
 * @property {string} theme             - 'light' | 'dark' | 'auto'
 * @property {string} [finnhubApiKey]
 * @property {string} [githubToken]
 * @property {string} [defaultSedStatus] - default SED status for all tax years
 * @property {number} [preTrackingSeedLosses] - losses from before Penny Farthing tracking began
 * @property {string} [lastClosedPositionAccountId] - remembered for closed-position form
 * @property {string} [gistId]
 * @property {string} lastSyncedAt      - ISO timestamp
 * @property {string} createdAt         - ISO
 */

/* ============================================================
   UK Tax Year helper
   UK tax year runs 6 April – 5 April next
   ============================================================ */

/**
 * Return the UK tax year string ('YYYY-YY') for a given ISO date.
 * @param {string|Date} date
 * @returns {string}
 */
export function ukTaxYear(date) {
  const d = typeof date === 'string' ? new Date(date) : date;
  const y = d.getUTCFullYear();
  const m = d.getUTCMonth() + 1;  // 1-12
  const day = d.getUTCDate();
  const beforeApril6 = (m < 4) || (m === 4 && day < 6);
  const startYear = beforeApril6 ? y - 1 : y;
  const endYear = (startYear + 1).toString().slice(-2);
  return `${startYear}-${endYear}`;
}

/**
 * Return the start and end ISO dates of a given UK tax year.
 * @param {string} year  '2024-25'
 * @returns {{ start: string, end: string }}
 */
export function ukTaxYearBounds(year) {
  const [startYearStr] = year.split('-');
  const startYear = parseInt(startYearStr, 10);
  return {
    start: `${startYear}-04-06`,
    end:   `${startYear + 1}-04-05`,
  };
}

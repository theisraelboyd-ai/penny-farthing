# Penny Farthing

*The big wheel, the little wheel, and what lies between.*

A UK CGT-aware investment tracker for individual investors — built as a Progressive Web App so it installs to your phone and works offline. The name is the metaphor: the giant front wheel is what you could sell your holdings for, the little rear wheel is what you'd actually walk away with after HMRC takes its share. This app shows you both, side by side, in real time. Designed with special attention to **Seafarer's Earnings Deduction** eligibility and the dual CGT-rate scenarios it creates.

## Why this exists

Spreadsheet trackers break down when you hold assets in multiple currencies, across multiple platforms, some inside tax-wrapped accounts and some outside, with the added complication of UK-specific tax rules like Section 104 pooling, the 30-day bed-and-breakfasting rule, CGT-exempt sovereigns, non-reporting ETFs, and SED-affected income bands.

Penny Farthing is a single source of truth for all of it, with one signature feature: the **"if I sold this now, what would I actually get after tax"** ledger — side-by-side scenarios for SED-claim-succeeds and SED-claim-fails.

## Status

**Day 1 scaffold — functional but not feature-complete.**

| Feature                                                | Status     |
|--------------------------------------------------------|------------|
| PWA shell (manifest, service worker, offline)          | ✅ Done    |
| Dark / light Ledger Noir theme                         | ✅ Done    |
| IndexedDB storage + JSON backup/restore                | ✅ Done    |
| Asset-type registry (equity, ETF, gold, crypto, bond)  | ✅ Done    |
| Add transaction form                                   | ✅ Done    |
| Transaction list                                       | ✅ Done    |
| SED status per tax year                                | ✅ Done    |
| Section 104 pooling engine                             | 🔜 Day 2   |
| FX conversion at transaction date                      | 🔜 Day 2   |
| GitHub Gist sync                                       | 🔜 Day 2   |
| Live price fetching (Finnhub)                          | 🔜 Day 3   |
| "Sell now after tax" calculator                        | 🔜 Day 3   |
| CSV importers (IBKR, eToro)                            | 🔜 Day 3   |
| Print-friendly HMRC-ready report                       | 🔜 Day 4   |

## Running locally

No build step. No dependencies. Just a web server because Service Workers and ES modules require HTTPS or `http://localhost`.

```bash
# Any static server works — pick whichever is handy on your Linux box:
python3 -m http.server 8000
# or
npx serve .
```

Then open `http://localhost:8000`.

## Deploying to GitHub Pages

1. Create a public (or private, with Pages enabled) GitHub repo.
2. Push this directory to it.
3. Repo **Settings** → **Pages** → source: "Deploy from a branch" → `main` / `/ (root)`.
4. GitHub gives you a URL; that's your app.

From your phone: open the URL in Chrome → browser menu → **Install app** or **Add to Home Screen**.

## Data & privacy

- All data lives in your browser's **IndexedDB**. Nothing is sent anywhere unless you explicitly configure sync.
- The JSON backup/restore in **Study** lets you move data between devices or keep local backups.
- Day 2 adds optional **GitHub Gist** sync — see `docs/github-token-walkthrough.md`.
- API keys and tokens are stored locally and never shared with anyone other than the service they're for (Finnhub for prices, GitHub for sync).

## Disclaimer

This is a record-keeping tool. It is **not tax advice**. Tax treatments described in the code reflect UK rules at the time of writing but can change, and individual circumstances vary. Have a qualified accountant review your first year's return, especially for SED interactions.

## Folder layout

```
penny-farthing/
├── index.html              App shell
├── manifest.json           PWA manifest
├── sw.js                   Service worker
├── css/
│   ├── theme.css           Ledger Noir: colors, fonts, paper texture
│   └── layout.css          Cards, tables, forms
├── js/
│   ├── app.js              Entry point
│   ├── router.js           Hash-based router
│   ├── ui.js               DOM/toast/format helpers
│   ├── storage/
│   │   ├── schema.js       Data model + UK tax-year helpers
│   │   └── indexeddb.js    Promisified DB wrapper
│   ├── assets/
│   │   ├── registry.js     Asset-type registry
│   │   ├── equity.js       Listed equities
│   │   ├── etf.js          ETFs (with reporting-status flag)
│   │   ├── gold-physical.js   Physical gold (CGT-exempt coins etc.)
│   │   ├── crypto.js       Crypto assets
│   │   └── bond.js         Bonds / gilts
│   └── views/
│       ├── dashboard.js    Main ledger overview
│       ├── transactions.js List of entries
│       ├── add-transaction.js  Record-new form
│       ├── tax.js          Tax position
│       └── settings.js     Study — SED, accounts, connections, backup
├── icons/                  PWA icons
├── scripts/
│   └── gen-icons.py        Regenerates the icons
└── docs/
    └── github-token-walkthrough.md
```

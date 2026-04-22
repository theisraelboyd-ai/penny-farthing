/* Penny Farthing — IBKR Activity Statement Importer
 *
 * IBKR Activity Statement CSVs have a distinctive structure:
 *   - Multiple sections stacked in one file (Statement, Trades, Dividends,
 *     Deposits & Withdrawals, Fees, etc.)
 *   - Each section has a header row and data rows, all prefixed with the
 *     section name and "Header" or "Data":
 *
 *       Trades,Header,DataDiscriminator,Asset Category,Currency,Symbol,Date/Time,Quantity,T. Price,Comm/Fee,Basis,Realized P/L,MTM P/L,Code
 *       Trades,Data,Order,Stocks,USD,AAPL,"2025-05-10, 14:30:00",20,190.00,-1.00,3801.00,0,0,O
 *       Trades,SubTotal,...
 *
 *   - "DataDiscriminator" column distinguishes "Order" (actual trades) from
 *     "Closed Lot" and other sub-entries we want to skip.
 *
 *   - Quantity is SIGNED: negative = sell, positive = buy.
 *
 *   - Comm/Fee is NEGATIVE (money out). We store fees as positive.
 *
 *   - Currency column tells us the trade currency. Date/Time is comma-joined.
 *
 * This importer returns { trades: [...parsed trade objects], warnings: [...] }
 * — it does NOT write to storage. The view layer shows a preview and
 * commits on confirm.
 */

import { parseCsv } from './csv.js';

/**
 * Parse an IBKR Activity Statement CSV string and extract trades.
 *
 * @returns {{ trades: Array, dividends: Array, warnings: string[] }}
 */
export function parseIbkrActivityStatement(csvText) {
  const rows = parseCsv(csvText);
  const warnings = [];
  const trades = [];
  const dividends = [];

  // Find the Trades header row — first row starting with "Trades" and "Header"
  let tradesHeader = null;
  let tradesHeaderIndex = -1;
  for (let i = 0; i < rows.length; i++) {
    const r = rows[i];
    if (r[0] === 'Trades' && r[1] === 'Header') {
      tradesHeader = r;
      tradesHeaderIndex = i;
      break;
    }
  }

  if (!tradesHeader) {
    warnings.push('No "Trades" section found in the CSV. Is this an IBKR Activity Statement?');
    return { trades, dividends, warnings };
  }

  // Build header → column index map
  const colIdx = {};
  for (let i = 0; i < tradesHeader.length; i++) {
    colIdx[tradesHeader[i]] = i;
  }

  const required = ['Symbol', 'Date/Time', 'Quantity', 'T. Price', 'Currency'];
  const missing = required.filter((r) => colIdx[r] === undefined);
  if (missing.length > 0) {
    warnings.push(`Missing expected columns: ${missing.join(', ')}`);
    return { trades, dividends, warnings };
  }

  // Iterate trade data rows
  for (let i = tradesHeaderIndex + 1; i < rows.length; i++) {
    const r = rows[i];
    // End of trades section when we hit another section's header
    if (r[0] !== 'Trades') break;

    // Only process "Data" + "Order" rows. Skip SubTotal, Total, Closed Lot, etc.
    if (r[1] !== 'Data') continue;

    // DataDiscriminator — "Order" = actual trade. "Closed Lot" = IBKR's
    // internal lot-matching bookkeeping, which we ignore (we do our own).
    const discriminator = colIdx['DataDiscriminator'] !== undefined
      ? r[colIdx['DataDiscriminator']]
      : 'Order';
    if (discriminator !== 'Order') continue;

    // Asset Category — skip anything that isn't Stocks or ETF for now
    const category = colIdx['Asset Category'] !== undefined
      ? r[colIdx['Asset Category']]
      : 'Stocks';

    const symbol = (r[colIdx['Symbol']] || '').trim();
    const dateTime = (r[colIdx['Date/Time']] || '').trim();
    const qtyStr = r[colIdx['Quantity']] || '0';
    const priceStr = r[colIdx['T. Price']] || '0';
    const currency = (r[colIdx['Currency']] || 'USD').trim();
    const commStr = colIdx['Comm/Fee'] !== undefined ? (r[colIdx['Comm/Fee']] || '0') : '0';

    if (!symbol) {
      warnings.push(`Row ${i + 1}: missing symbol, skipping`);
      continue;
    }

    const qty = parseFloat(String(qtyStr).replace(/,/g, ''));
    const price = parseFloat(String(priceStr).replace(/,/g, ''));
    const comm = parseFloat(String(commStr).replace(/,/g, ''));

    if (!isFinite(qty) || !isFinite(price)) {
      warnings.push(`Row ${i + 1}: unparseable qty/price (${qtyStr}, ${priceStr}), skipping`);
      continue;
    }

    // Parse date: IBKR uses "YYYY-MM-DD, HH:MM:SS" or sometimes "YYYY-MM-DD HH:MM:SS"
    // Take the date half.
    const dateMatch = dateTime.match(/(\d{4}-\d{2}-\d{2})/);
    if (!dateMatch) {
      warnings.push(`Row ${i + 1}: unparseable date "${dateTime}", skipping`);
      continue;
    }
    const date = dateMatch[1];

    // IBKR: negative qty = sell. Fees are negative (money out); we store positive.
    const type = qty < 0 ? 'sell' : 'buy';
    const absQty = Math.abs(qty);
    const absFees = Math.abs(comm);

    trades.push({
      // Source row index for dedup + debug
      sourceRowIndex: i,
      date,
      dateTime,
      type,
      symbol,
      quantity: absQty,
      pricePerUnit: price,
      currency,
      fees: absFees,
      assetCategory: category,
    });
  }

  // ----- Dividends -----
  let divHeader = null;
  let divHeaderIndex = -1;
  for (let i = 0; i < rows.length; i++) {
    const r = rows[i];
    if (r[0] === 'Dividends' && r[1] === 'Header') {
      divHeader = r;
      divHeaderIndex = i;
      break;
    }
  }

  if (divHeader) {
    const divCol = {};
    for (let i = 0; i < divHeader.length; i++) divCol[divHeader[i]] = i;

    for (let i = divHeaderIndex + 1; i < rows.length; i++) {
      const r = rows[i];
      if (r[0] !== 'Dividends') break;
      if (r[1] !== 'Data') continue;

      const currency = divCol['Currency'] !== undefined ? r[divCol['Currency']] : 'USD';
      const date = divCol['Date'] !== undefined ? r[divCol['Date']] : '';
      const description = divCol['Description'] !== undefined ? r[divCol['Description']] : '';
      const amountStr = divCol['Amount'] !== undefined ? r[divCol['Amount']] : '0';
      const amount = parseFloat(String(amountStr).replace(/,/g, ''));

      // Try to extract the symbol from the description.
      // IBKR dividend description format: "AAPL (US0378331005) Cash Dividend USD 0.24 per Share"
      const symMatch = description.match(/^([A-Z][A-Z0-9.]+)\s*\(/);
      const symbol = symMatch ? symMatch[1] : null;

      if (!isFinite(amount) || !symbol || !date.match(/\d{4}-\d{2}-\d{2}/)) {
        continue;
      }

      dividends.push({
        sourceRowIndex: i,
        date,
        type: 'dividend',
        symbol,
        amount,
        currency,
        description,
      });
    }
  }

  return { trades, dividends, warnings };
}

/**
 * Generate a dedup key for a trade. If an existing transaction has the same
 * key, skip re-importing it.
 */
export function tradeDedupKey(trade) {
  return [
    trade.date,
    trade.type,
    trade.symbol,
    Number(trade.quantity).toFixed(4),
    Number(trade.pricePerUnit).toFixed(4),
  ].join('|');
}

/**
 * Same for existing transactions in the store — produce the key we'd match against.
 */
export function existingTxnDedupKey(txn, asset) {
  const symbol = asset?.ticker || '?';
  return [
    txn.date,
    txn.type,
    symbol,
    Number(txn.quantity).toFixed(4),
    Number(txn.pricePerUnit).toFixed(4),
  ].join('|');
}

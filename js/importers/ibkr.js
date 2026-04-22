/* Penny Farthing — IBKR Importer
 *
 * Handles BOTH flavours of IBKR CSV export:
 *
 *   (A) "Transaction History" export (simpler, what most users get from
 *       Client Portal → Reports → Transaction History → CSV).
 *       Section: "Transaction History"
 *       Columns: Date, Account, Description, Transaction Type, Symbol,
 *                Quantity, Price, Price Currency, Gross Amount, Commission,
 *                Net Amount
 *
 *   (B) "Activity Statement" export (more detailed, structured by section).
 *       Section: "Trades" with Asset Category, Date/Time, signed quantity etc.
 *
 * We detect which format is present and parse accordingly.
 *
 * Filtering rules (common to both formats):
 *   - Skip deposits, withdrawals, credit interest (not CGT-relevant)
 *   - Skip FX/Forex Trade Components (IBKR internal bookkeeping)
 *   - Skip FX Translations P&L adjustments (cash-balance FX P&L, not CGT)
 *   - Commission adjustments on a symbol = add to fees on the matching trades
 *     (allocated proportionally across same-symbol, same-day buys)
 */

import { parseCsv } from './csv.js';

/**
 * Top-level entry — detects format and delegates.
 */
export function parseIbkrCsv(csvText) {
  const rows = parseCsv(csvText);

  // Detect format by scanning for section headers.
  const hasTransactionHistory = rows.some((r) =>
    r[0] === 'Transaction History' && r[1] === 'Header');
  const hasTrades = rows.some((r) =>
    r[0] === 'Trades' && r[1] === 'Header');

  if (hasTransactionHistory) {
    return parseTransactionHistory(rows);
  }
  if (hasTrades) {
    return parseActivityStatement(rows);
  }

  return {
    trades: [],
    dividends: [],
    warnings: ['Could not detect IBKR format. File does not contain a "Transaction History" or "Trades" section.'],
    format: 'unknown',
  };
}

/* ============================================================
   Format A: Transaction History
   ============================================================ */

function parseTransactionHistory(rows) {
  const trades = [];
  const dividends = [];
  const warnings = [];
  const commissionAdjustments = [];  // applied after primary parse

  // Find header row
  let headerIdx = -1;
  let header = null;
  for (let i = 0; i < rows.length; i++) {
    if (rows[i][0] === 'Transaction History' && rows[i][1] === 'Header') {
      header = rows[i];
      headerIdx = i;
      break;
    }
  }
  if (!header) {
    return { trades, dividends, warnings: ['No Transaction History header found'], format: 'transaction-history' };
  }

  const colIdx = {};
  for (let i = 0; i < header.length; i++) colIdx[header[i].trim()] = i;

  const required = ['Date', 'Description', 'Transaction Type', 'Symbol', 'Quantity', 'Price', 'Price Currency', 'Commission'];
  const missing = required.filter((r) => colIdx[r] === undefined);
  if (missing.length > 0) {
    warnings.push(`Missing expected columns: ${missing.join(', ')}`);
    return { trades, dividends, warnings, format: 'transaction-history' };
  }

  // Counters for each filter reason
  const skipped = {
    deposits: 0,
    interest: 0,
    forex: 0,
    fxPnl: 0,
    unknown: 0,
  };

  for (let i = headerIdx + 1; i < rows.length; i++) {
    const r = rows[i];
    if (r[0] !== 'Transaction History') break;
    if (r[1] !== 'Data') continue;

    const date = (r[colIdx['Date']] || '').trim();
    const description = (r[colIdx['Description']] || '').trim();
    const txnType = (r[colIdx['Transaction Type']] || '').trim();
    const symbol = (r[colIdx['Symbol']] || '').trim();
    const qtyStr = (r[colIdx['Quantity']] || '0').trim();
    const priceStr = (r[colIdx['Price']] || '0').trim();
    const currency = (r[colIdx['Price Currency']] || 'USD').trim();
    const commStr = (r[colIdx['Commission']] || '0').trim();
    const netStr = (r[colIdx['Net Amount']] || '0').trim();

    // --- Filters ---
    if (txnType === 'Deposit' || txnType === 'Withdrawal') {
      skipped.deposits++;
      continue;
    }
    if (txnType === 'Credit Interest' || txnType === 'Debit Interest') {
      skipped.interest++;
      continue;
    }
    if (txnType === 'Forex Trade Component' || /Forex Trade/i.test(description)) {
      skipped.forex++;
      continue;
    }
    if (txnType === 'Adjustment' && /FX Translations/i.test(description)) {
      skipped.fxPnl++;
      continue;
    }
    if (txnType === 'Commission Adjustment') {
      // Parse these separately — apply to matching trades.
      // Commission Adjustment rows have '-' for Price Currency since there's
      // no price. The fee is in the trade's currency — we infer by matching
      // symbol and date to existing trades regardless of currency string.
      const commAmount = Math.abs(parseNumeric(netStr) || parseNumeric(commStr));
      if (commAmount > 0 && symbol) {
        commissionAdjustments.push({
          date, symbol, amount: commAmount,
        });
      }
      continue;
    }

    // --- Trades ---
    if (txnType === 'Buy' || txnType === 'Sell') {
      if (!symbol || symbol === '-') {
        warnings.push(`Row ${i + 1}: ${txnType} with no symbol — skipped`);
        continue;
      }
      const qty = parseNumeric(qtyStr);
      const price = parseNumeric(priceStr);
      const comm = Math.abs(parseNumeric(commStr) || 0);
      if (!isFinite(qty) || !isFinite(price)) {
        warnings.push(`Row ${i + 1}: unparseable qty/price (${qtyStr}, ${priceStr}) — skipped`);
        continue;
      }

      // Parse date — expected format YYYY-MM-DD
      const dateMatch = date.match(/(\d{4}-\d{2}-\d{2})/);
      if (!dateMatch) {
        warnings.push(`Row ${i + 1}: unparseable date "${date}" — skipped`);
        continue;
      }

      trades.push({
        sourceRowIndex: i,
        date: dateMatch[1],
        dateTime: date,
        type: txnType.toLowerCase(),  // 'buy' or 'sell'
        symbol,
        quantity: Math.abs(qty),
        pricePerUnit: price,
        currency,
        fees: comm,
        description,
      });
      continue;
    }

    // --- Dividends ---
    if (txnType === 'Dividend' || /Dividend/i.test(description)) {
      const amount = parseNumeric(netStr);
      if (!isFinite(amount)) continue;
      dividends.push({
        sourceRowIndex: i,
        date: date.match(/(\d{4}-\d{2}-\d{2})/)?.[1] || date,
        type: 'dividend',
        symbol: symbol !== '-' ? symbol : null,
        amount,
        currency,
        description,
      });
      continue;
    }

    // Anything else — log as unknown
    skipped.unknown++;
    if (skipped.unknown <= 3) {  // don't flood
      warnings.push(`Row ${i + 1}: unrecognised transaction type "${txnType}" — skipped`);
    }
  }

  // --- Apply commission adjustments to matching trades ---
  // Allocate each adjustment proportionally across same-symbol, same-date buys.
  for (const adj of commissionAdjustments) {
    const matches = trades.filter((t) =>
      t.symbol.toUpperCase() === adj.symbol.toUpperCase() &&
      t.date === adj.date);
    if (matches.length === 0) {
      // Try without date constraint
      const fallback = trades.filter((t) =>
        t.symbol.toUpperCase() === adj.symbol.toUpperCase());
      if (fallback.length === 0) {
        warnings.push(`Commission adjustment ${adj.amount} for ${adj.symbol} on ${adj.date}: no matching trade`);
        continue;
      }
      // Allocate to most recent match
      fallback.sort((a, b) => (b.date || '').localeCompare(a.date || ''));
      fallback[0].fees = (fallback[0].fees || 0) + adj.amount;
      continue;
    }
    // Proportional by quantity
    const totalQty = matches.reduce((s, t) => s + t.quantity, 0);
    for (const t of matches) {
      const share = totalQty > 0 ? (t.quantity / totalQty) : (1 / matches.length);
      t.fees = (t.fees || 0) + adj.amount * share;
    }
  }

  // Build a summary note
  const summary = `Parsed ${trades.length} trades · ${dividends.length} dividends · `
    + `skipped ${skipped.deposits} cash transfers, ${skipped.forex} forex components, `
    + `${skipped.interest} interest, ${skipped.fxPnl} FX P&L adjustments`;

  return { trades, dividends, warnings, format: 'transaction-history', summary };
}

/* ============================================================
   Format B: Activity Statement  (kept from earlier impl)
   ============================================================ */

function parseActivityStatement(rows) {
  const trades = [];
  const dividends = [];
  const warnings = [];
  const commissionAdjustments = [];

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
    return { trades, dividends, warnings: ['No Trades section'], format: 'activity-statement' };
  }

  const colIdx = {};
  for (let i = 0; i < tradesHeader.length; i++) colIdx[tradesHeader[i]] = i;

  const required = ['Symbol', 'Date/Time', 'Quantity', 'T. Price', 'Currency'];
  const missing = required.filter((r) => colIdx[r] === undefined);
  if (missing.length > 0) {
    warnings.push(`Missing expected columns: ${missing.join(', ')}`);
    return { trades, dividends, warnings, format: 'activity-statement' };
  }

  for (let i = tradesHeaderIndex + 1; i < rows.length; i++) {
    const r = rows[i];
    if (r[0] !== 'Trades') break;
    if (r[1] !== 'Data') continue;

    const discriminator = colIdx['DataDiscriminator'] !== undefined
      ? r[colIdx['DataDiscriminator']] : 'Order';
    if (discriminator !== 'Order') continue;

    // Skip forex conversions (IBKR's automatic GBP↔USD/CAD conversions).
    // These are currency plumbing for stock trades, not investment decisions.
    const assetCategory = colIdx['Asset Category'] !== undefined
      ? r[colIdx['Asset Category']] : 'Stocks';
    if (assetCategory === 'Forex') continue;

    const symbol = (r[colIdx['Symbol']] || '').trim();
    const dateTime = (r[colIdx['Date/Time']] || '').trim();
    const qty = parseNumeric(r[colIdx['Quantity']]);
    const price = parseNumeric(r[colIdx['T. Price']]);
    const currency = (r[colIdx['Currency']] || 'USD').trim();
    const comm = Math.abs(parseNumeric(colIdx['Comm/Fee'] !== undefined ? r[colIdx['Comm/Fee']] : '0'));

    if (!symbol) continue;
    if (!isFinite(qty) || !isFinite(price)) continue;
    const dateMatch = dateTime.match(/(\d{4}-\d{2}-\d{2})/);
    if (!dateMatch) continue;

    trades.push({
      sourceRowIndex: i,
      date: dateMatch[1],
      dateTime,
      type: qty < 0 ? 'sell' : 'buy',
      symbol,
      quantity: Math.abs(qty),
      pricePerUnit: price,
      currency,
      fees: comm,
    });
  }

  // --- Commission Adjustments (Activity Statement has its own section) ---
  let caHeader = null;
  let caHeaderIndex = -1;
  for (let i = 0; i < rows.length; i++) {
    if (rows[i][0] === 'Commission Adjustments' && rows[i][1] === 'Header') {
      caHeader = rows[i];
      caHeaderIndex = i;
      break;
    }
  }
  if (caHeader) {
    const caCol = {};
    for (let i = 0; i < caHeader.length; i++) caCol[caHeader[i].trim()] = i;
    for (let i = caHeaderIndex + 1; i < rows.length; i++) {
      const r = rows[i];
      if (r[0] !== 'Commission Adjustments') break;
      if (r[1] !== 'Data') continue;
      const date = caCol['Date'] !== undefined ? r[caCol['Date']] : '';
      const description = caCol['Description'] !== undefined ? r[caCol['Description']] : '';
      const amountStr = caCol['Amount'] !== undefined ? r[caCol['Amount']] : '0';
      const amount = Math.abs(parseNumeric(amountStr));
      // Extract the symbol from the description: "...(HYMC)..."
      const symMatch = description.match(/\(([A-Z][A-Z0-9.]+)\)/);
      const symbol = symMatch ? symMatch[1] : null;
      if (!isFinite(amount) || amount <= 0 || !symbol) continue;
      const dateMatch = date.match(/(\d{4}-\d{2}-\d{2})/);
      commissionAdjustments.push({
        date: dateMatch ? dateMatch[1] : date,
        symbol,
        amount,
      });
    }
  }

  // Apply commission adjustments to matching trades
  for (const adj of commissionAdjustments) {
    const matches = trades.filter((t) =>
      t.symbol.toUpperCase() === adj.symbol.toUpperCase() &&
      t.date === adj.date);
    if (matches.length === 0) {
      const fallback = trades.filter((t) =>
        t.symbol.toUpperCase() === adj.symbol.toUpperCase());
      if (fallback.length === 0) {
        warnings.push(`Commission adjustment ${adj.amount} for ${adj.symbol} on ${adj.date}: no matching trade`);
        continue;
      }
      fallback.sort((a, b) => (b.date || '').localeCompare(a.date || ''));
      fallback[0].fees = (fallback[0].fees || 0) + adj.amount;
      continue;
    }
    const totalQty = matches.reduce((s, t) => s + t.quantity, 0);
    for (const t of matches) {
      const share = totalQty > 0 ? (t.quantity / totalQty) : (1 / matches.length);
      t.fees = (t.fees || 0) + adj.amount * share;
    }
  }

  // Dividends (same as before)
  let divHeader = null;
  let divHeaderIndex = -1;
  for (let i = 0; i < rows.length; i++) {
    if (rows[i][0] === 'Dividends' && rows[i][1] === 'Header') {
      divHeader = rows[i];
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
      const amount = parseNumeric(divCol['Amount'] !== undefined ? r[divCol['Amount']] : '0');
      const symMatch = description.match(/^([A-Z][A-Z0-9.]+)\s*\(/);
      const symbol = symMatch ? symMatch[1] : null;
      if (!isFinite(amount) || !symbol) continue;
      dividends.push({ sourceRowIndex: i, date, type: 'dividend', symbol, amount, currency, description });
    }
  }

  return { trades, dividends, warnings, format: 'activity-statement' };
}

/* ============================================================
   Helpers
   ============================================================ */

function parseNumeric(s) {
  if (typeof s === 'number') return s;
  if (!s || s === '-') return 0;
  return parseFloat(String(s).replace(/,/g, ''));
}

/**
 * Dedup key for a trade.
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

// Back-compat alias for the view module that imports the old name
export { parseIbkrCsv as parseIbkrActivityStatement };

/* Penny Farthing — CSV Parser
 *
 * RFC 4180-compliant-enough for the kinds of CSV files real brokers produce.
 * Handles:
 *   - Double-quoted fields containing commas and newlines
 *   - Escaped quotes ("") within quoted fields
 *   - CRLF and LF line endings
 *   - Trailing empty lines
 *
 * Returns Array<Array<string>> — rows of string cells, no type coercion.
 * Callers are responsible for header recognition and row typing.
 */

export function parseCsv(text) {
  if (typeof text !== 'string') return [];

  const rows = [];
  let row = [];
  let field = '';
  let inQuotes = false;
  let i = 0;
  const len = text.length;

  while (i < len) {
    const ch = text[i];

    if (inQuotes) {
      if (ch === '"') {
        // Look ahead for escaped quote
        if (text[i + 1] === '"') {
          field += '"';
          i += 2;
          continue;
        }
        inQuotes = false;
        i++;
        continue;
      }
      field += ch;
      i++;
      continue;
    }

    // Not in quotes
    if (ch === '"') {
      inQuotes = true;
      i++;
      continue;
    }
    if (ch === ',') {
      row.push(field);
      field = '';
      i++;
      continue;
    }
    if (ch === '\r') {
      // Skip — we'll commit on \n
      i++;
      continue;
    }
    if (ch === '\n') {
      row.push(field);
      field = '';
      // Skip rows that are entirely empty (just one empty string)
      if (!(row.length === 1 && row[0] === '')) {
        rows.push(row);
      }
      row = [];
      i++;
      continue;
    }
    field += ch;
    i++;
  }

  // Final field
  if (field !== '' || row.length > 0) {
    row.push(field);
    if (!(row.length === 1 && row[0] === '')) {
      rows.push(row);
    }
  }

  return rows;
}

/**
 * Find the first row where every expected header appears (case-insensitive).
 * Returns { headerIndex, headers } or null.
 */
export function findHeaderRow(rows, expectedHeaders) {
  const lowered = expectedHeaders.map((h) => h.toLowerCase());
  for (let i = 0; i < rows.length; i++) {
    const rowLower = rows[i].map((c) => c.toLowerCase().trim());
    const allFound = lowered.every((h) => rowLower.includes(h));
    if (allFound) {
      return { headerIndex: i, headers: rows[i] };
    }
  }
  return null;
}

/**
 * Map a data row to an object using the header row.
 */
export function rowToObject(headers, dataRow) {
  const obj = {};
  for (let i = 0; i < headers.length; i++) {
    obj[headers[i]] = dataRow[i] ?? '';
  }
  return obj;
}

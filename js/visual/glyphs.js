/* Asset-type visual cues.
 *
 * Monochrome single-glyph badges that work in light and dark mode and
 * don't clash with our typography. Used on Activity, Holdings, and
 * Dashboard tables.
 *
 * Preferred over emojis because:
 *   - consistent rendering across platforms (no colour shifts)
 *   - align properly with tabular figures
 *   - theme-aware (can tint with accent colour)
 */

export const ASSET_GLYPHS = {
  equity:          { glyph: '▲', label: 'Shares',    tone: 'accent' },
  etf:             { glyph: '◎', label: 'ETF',       tone: 'accent' },
  'gold-physical': { glyph: '◆', label: 'Bullion',   tone: 'gold'   },
  crypto:          { glyph: '⬢', label: 'Crypto',    tone: 'accent' },
  bond:            { glyph: '▬', label: 'Bond',      tone: 'muted'  },
};

export function glyphFor(assetType) {
  return ASSET_GLYPHS[assetType] || { glyph: '○', label: 'Asset', tone: 'muted' };
}

export const TXN_TYPE_STYLE = {
  buy:          { label: 'Buy',      symbol: '↓',  pillClass: 'pill--buy',   tone: 'buy'  },
  sell:         { label: 'Sell',     symbol: '↑',  pillClass: 'pill--sell',  tone: 'sell' },
  dividend:     { label: 'Dividend', symbol: '⁂',  pillClass: 'pill--dividend', tone: 'dividend' },
  fee:          { label: 'Fee',      symbol: '−',  pillClass: 'pill--fee',   tone: 'fee'  },
  'transfer-in':  { label: 'Transfer in',  symbol: '⇤',  pillClass: 'pill--transfer', tone: 'transfer' },
  'transfer-out': { label: 'Transfer out', symbol: '⇥',  pillClass: 'pill--transfer', tone: 'transfer' },
};

export function txnStyle(type) {
  return TXN_TYPE_STYLE[type] || { label: type, symbol: '•', pillClass: '', tone: 'muted' };
}

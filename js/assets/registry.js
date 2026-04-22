/* Penny Farthing — Asset Type Registry
 *
 * Each asset type module exports a handler that describes:
 *   - display name
 *   - which fields the add-transaction form should show
 *   - how to compute allowable cost on disposal (pool vs specific)
 *   - which UK tax bucket gains fall into
 *   - reporting nuances (e.g. offshore income gains for non-reporting ETFs)
 *
 * To add a new asset type later (property, P2P, EIS/SEIS, collectibles):
 *   1. Create a new file in js/assets/
 *   2. Export a handler with the same shape
 *   3. Register it below
 */

import { equityHandler } from './equity.js';
import { etfHandler } from './etf.js';
import { goldPhysicalHandler } from './gold-physical.js';
import { cryptoHandler } from './crypto.js';
import { bondHandler } from './bond.js';

export const ASSET_TYPES = {
  equity:         equityHandler,
  etf:            etfHandler,
  'gold-physical': goldPhysicalHandler,
  crypto:         cryptoHandler,
  bond:           bondHandler,
  // Future: property, p2p, eis-seis, collectible — stubbed in place for pluggability
};

export function getHandler(type) {
  const h = ASSET_TYPES[type];
  if (!h) {
    throw new Error(`Unknown asset type: ${type}`);
  }
  return h;
}

export function listAssetTypes() {
  return Object.entries(ASSET_TYPES).map(([key, h]) => ({
    key,
    label: h.label,
    description: h.description,
  }));
}

/**
 * Shape of a handler:
 *
 * {
 *   label: string,                      // 'Listed Equity'
 *   description: string,                // 'Shares in publicly-traded companies'
 *
 *   // Form fields specific to this type. Returned as an array of
 *   // { name, label, type, options?, hint?, required? }.
 *   formFields(): Array,
 *
 *   // Tax bucket: what HMRC treats gains as.
 *   //   'cgt'            -> normal CGT, pooled
 *   //   'cgt-chattel'    -> chattels rules (1/3 proceeds rule, £6k threshold)
 *   //   'cgt-exempt'     -> no CGT (UK legal tender coins)
 *   //   'offshore-income'-> taxed as income, not CGT
 *   //   'isa-exempt'     -> exempt because in ISA wrapper
 *   taxBucket(asset, account): string,
 *
 *   // Should this asset be pooled (s.104) or treated as individual items?
 *   pooled: boolean,
 *
 *   // Default form values when user picks this type
 *   defaults: object,
 * }
 */

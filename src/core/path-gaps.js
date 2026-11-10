'use strict';

/**
 * Path gap report: what a price table promises that the setup cannot run, and
 * what the setup runs that the price table does not price.
 *
 * A `config.paths[].prices` table is the subscription's own price list. Two
 * gaps make it lie about the routing decision:
 *
 *   missing   a priced model with no runnable on that quota path. The price is
 *             known and the model cannot be dispatched there, so the entry is
 *             dead weight — or a runnable nobody wired up yet.
 *   unpriced  a runnable on a priced path whose model key has no price entry.
 *             That choice silently falls back to the ROI blend or an AA list
 *             price, which is exactly what the price table exists to replace.
 *
 * Pure: no fs, no clock. `snapshot.js` reads the config, the runnables and the
 * observed token mix and hands them here.
 */

const { modelKey } = require('../lib/model-key.js');
const { pathPrice, priceTable } = require('../lib/path-prices.js');
const { activeFundingEntries, activeSubscriptionNames, quotaPathId } = require('../lib/subscriptions.js');
const { mixFor } = require('./token-mix.js');

/**
 * A runnable's model key exactly as the catalog resolves it: the declared
 * `modelKey`, else the key derived from its id. A runnable without a declared
 * key is still priced by the catalog, so it must not be reported missing here.
 *
 * @param {Record<string, any>} runnable
 * @returns {string|null}
 */
function runnableKey(runnable) {
  if (typeof runnable.modelKey === 'string' && runnable.modelKey) return runnable.modelKey;
  return typeof runnable.id === 'string' ? modelKey(runnable.id) || null : null;
}

/**
 * @typedef {object} GapPath
 * @property {string} path quota path id
 * @property {string} pathName active funding subscription names, else the id
 * @property {number} fee monthly fee of the active funding entries, summed
 * @property {Array<{ modelKey: string, costPerMTok: number|null, reason: string|null, expired: boolean }>} missing
 *   priced models with no runnable on this path, cheapest first
 * @property {Array<{ id: string, modelKey: string }>} unpriced runnables with no price entry
 */

/**
 * @param {{
 *   subscriptions?: Array<Record<string, any>>|null,
 *   runnables?: Array<Record<string, any>>,
 *   mixIndex?: ReturnType<typeof import('./token-mix.js').mixIndex>|null,
 *   costBlend?: Record<string, any>|null,
 *   now?: number,
 * }} [input]
 * @returns {{ paths: GapPath[] }} only quota paths that declare a `prices` table
 */
function pathGaps({ subscriptions = null, runnables = [], mixIndex = null, costBlend = null, now = Date.now() } = {}) {
  const entries = (Array.isArray(subscriptions) ? subscriptions : [])
    .filter((entry) => entry && typeof entry.id === 'string');

  // One report per quota path: several config entries can fund the same path
  // (an alias plan), and routing sees the path, not the entry.
  /** @type {Map<string, Map<string, Record<string, any>>>} */
  const pricedByPath = new Map();
  for (const entry of entries) {
    const table = priceTable(entry);
    if (!table.size) continue;
    const quotaPath = quotaPathId(entry);
    if (!quotaPath) continue;
    const keys = pricedByPath.get(quotaPath) ?? new Map();
    for (const [key, price] of table) {
      if (!keys.has(key)) keys.set(key, price);
    }
    pricedByPath.set(quotaPath, keys);
  }

  const reports = [];
  for (const [quotaPath, keys] of pricedByPath) {
    const onPath = (Array.isArray(runnables) ? runnables : [])
      .filter((runnable) => runnable && runnable.path === quotaPath)
      .map((runnable) => ({ id: runnable.id, key: runnableKey(runnable) }))
      .filter((runnable) => runnable.key !== null);
    const runnableKeys = new Set(onPath.map((runnable) => runnable.key));
    // The fee pricing scales by: active funding entries only, so an ended plan
    // that still funds the path does not inflate the header.
    const fee = activeFundingEntries(subscriptions, quotaPath, now)
      .reduce((sum, entry) => sum + (typeof entry.fee === 'number' && Number.isFinite(entry.fee) ? entry.fee : 0), 0);

    /** @type {GapPath['missing']} */
    const missing = [];
    for (const key of keys.keys()) {
      if (runnableKeys.has(key)) continue;
      const priced = pathPrice({
        subscriptions,
        quotaPath,
        modelKey: key,
        now,
        mix: mixFor(mixIndex, { modelKey: key, path: quotaPath, costBlend }),
      });
      missing.push({
        modelKey: key,
        costPerMTok: priced ? priced.costPerMTok : null,
        reason: priced ? priced.reason : null,
        expired: Boolean(priced && priced.expiredReason),
      });
    }
    // Cheapest first; an unpriced gap (no mix) sorts last.
    missing.sort((a, b) => {
      if (a.costPerMTok === b.costPerMTok) return a.modelKey < b.modelKey ? -1 : a.modelKey > b.modelKey ? 1 : 0;
      if (a.costPerMTok === null) return 1;
      if (b.costPerMTok === null) return -1;
      return a.costPerMTok - b.costPerMTok;
    });

    const unpriced = onPath
      .filter((runnable) => !keys.has(runnable.key))
      .map((runnable) => ({ id: runnable.id, modelKey: runnable.key }));

    reports.push({
      path: quotaPath,
      pathName: activeSubscriptionNames(subscriptions, quotaPath, now).join(' + ') || quotaPath,
      fee,
      missing,
      unpriced,
    });
  }

  // Config order, so the report reads like the file it describes.
  const order = [...pricedByPath.keys()];
  reports.sort((a, b) => order.indexOf(a.path) - order.indexOf(b.path));
  return { paths: reports };
}

module.exports = { pathGaps };

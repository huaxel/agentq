'use strict';

/**
 * Path price tables: what a subscription's own price list says a model costs.
 *
 * The ROI pipeline prices every model with ONE global `costBlend` over the
 * registry's list prices. That is wrong for an allowance subscription in two
 * ways:
 *
 *   1. the subscription has its own price list and a per-model allowance, so
 *      the fee buys a *limit* of that model's list-price dollars. $1 of usage
 *      on a $100 limit draws 10% of its value from the quota, while a model on
 *      a $15 limit draws 67%;
 *   2. the token mix differs per model and harness, and cache reads dominate
 *      real usage, so cache-read prices decide the blended price.
 *
 * A `config.paths[].prices` entry supplies (1); the observed mix comes from
 * `src/core/token-mix.js`. This module is the one place that turns the two,
 * plus the funding fee, into a $/MTok and the sentence that explains it.
 *
 * Pure: no fs, no env, and no clock read beyond the injected `now`. Prices are
 * USD per 1M tokens, exactly as providers list them.
 *
 * @typedef {object} PriceSet
 * @property {number|null} input
 * @property {number|null} output
 * @property {number|null} cacheRead
 * @property {number|null} cacheWrite
 *
 * @typedef {object} TokenMix
 * @property {number} cacheRead
 * @property {number} cacheWrite
 * @property {number} input
 * @property {number} output
 *
 * @typedef {object} PathPrice
 * @property {string} pathId config entry that declares the price
 * @property {string} modelKey normalized model key the entry is filed under
 * @property {number} fee monthly fee of the active funding entries, summed
 * @property {number|null} allowanceScale fee / monthlyLimit, or null for pay-per-token
 * @property {boolean|null} peak true = peak prices, false = off-peak, null = no schedule
 * @property {PriceSet} prices the price set actually used
 * @property {number|null} costPerMTok null when no token mix is available
 * @property {boolean} free
 * @property {boolean} dataSharing
 * @property {string|null} expiredReason set from `until` once the date has passed
 * @property {string|null} reason the routing sentence for this cost
 */

const { modelKey } = require('./model-key.js');
const { activeFundingEntries, fundingEntries, quotaPathId } = require('./subscriptions.js');

/** The price fields a set may declare, in the order reasons name them. */
const PRICE_FIELDS = ['input', 'output', 'cacheRead', 'cacheWrite'];

/** How reasons spell each price field. */
const PRICE_LABELS = { input: 'input', output: 'output', cacheRead: 'cache-read', cacheWrite: 'cache-write' };

/** `YYYY-MM-DD`, the only accepted `until` shape. */
const ISO_DAY = /^\d{4}-\d{2}-\d{2}$/;

/** `HH:MM`, 24-hour. */
const CLOCK = /^([01]\d|2[0-3]):([0-5]\d)$/;

/**
 * @param {unknown} value
 * @returns {number|null}
 */
function finiteOrNull(value) {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

/**
 * @param {unknown} value
 * @returns {boolean} true for a plain object (not null, not an array)
 */
function isPlainObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * The normalized price table of one `config.paths[]` entry.
 *
 * Keys are folded with `modelKey()`, so `openrouter/anthropic/claude-opus-4.8`
 * and `claude-opus-4-8` name the same model. The first entry for a key wins,
 * matching the registry join (`src/core/catalog.js`).
 *
 * @param {Record<string, any>|null|undefined} pathEntry
 * @returns {Map<string, Record<string, any>>}
 */
function priceTable(pathEntry) {
  const table = new Map();
  const prices = isPlainObject(pathEntry?.prices) ? pathEntry.prices : null;
  if (!prices) return table;
  for (const [rawKey, entry] of Object.entries(prices)) {
    const key = modelKey(rawKey);
    if (!key || !isPlainObject(entry)) continue;
    if (!table.has(key)) table.set(key, entry);
  }
  return table;
}

/**
 * The config entry that declares a price for `key` on a quota path, and the
 * entry itself. Funding entries are searched in config order, so an alias plan
 * listed first wins — the same precedence the funding rule gives everywhere.
 *
 * @param {Array<Record<string, any>>|null|undefined} subscriptions roi.config.json `paths`
 * @param {string} quotaPath
 * @param {string} key normalized model key
 * @returns {{ pathEntry: Record<string, any>, price: Record<string, any> }|null}
 */
function priceSource(subscriptions, quotaPath, key) {
  if (!key) return null;
  for (const pathEntry of fundingEntries(subscriptions, quotaPath)) {
    const price = priceTable(pathEntry).get(key);
    if (price) return { pathEntry, price };
  }
  return null;
}

/**
 * The monthly fee the path's active subscriptions pay, summed: two active
 * plans for one quota path are two payments for the same allowance.
 *
 * @param {Array<Record<string, any>>|null|undefined} subscriptions
 * @param {string} quotaPath
 * @param {number} now
 * @returns {number}
 */
function pathFee(subscriptions, quotaPath, now) {
  return activeFundingEntries(subscriptions, quotaPath, now)
    .reduce((sum, entry) => sum + (finiteOrNull(entry.fee) ?? 0), 0);
}

/**
 * `HH:MM` as minutes after midnight.
 *
 * @param {unknown} value
 * @returns {number|null} null when the value is not a valid clock time
 */
function parseClock(value) {
  if (typeof value !== 'string') return null;
  const match = CLOCK.exec(value.trim());
  if (!match) return null;
  return Number(match[1]) * 60 + Number(match[2]);
}

/**
 * Minutes after midnight in `tz` at `now`, or null when the zone is unknown.
 *
 * Validation rejects an unknown zone, but routing can be handed a config the
 * validator never saw: an unreadable zone then reads as peak, never as a throw.
 *
 * @param {number} now epoch milliseconds
 * @param {string} tz IANA zone name or `UTC`
 * @returns {number|null}
 */
function localMinutes(now, tz) {
  let parts;
  try {
    parts = new Intl.DateTimeFormat('en-US', {
      timeZone: tz,
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
    }).formatToParts(new Date(now));
  } catch {
    return null;
  }
  const read = (type) => Number(parts.find((part) => part.type === type)?.value ?? 0);
  // Some ICU versions render midnight as 24 with hour12:false.
  return (read('hour') % 24) * 60 + read('minute');
}

/**
 * The off-peak windows a config entry declares, or null when it declares none.
 *
 * `offPeakHours` is either one window object or a non-empty array of them (a
 * provider with two off-peak blocks a day). Routing can be handed a config the
 * validator never saw, so a non-object array entry is skipped rather than
 * thrown on, and an empty array reads as no schedule.
 *
 * @param {unknown} schedule `config.paths[].offPeakHours`
 * @returns {Array<Record<string, any>>|null}
 */
function offPeakWindows(schedule) {
  if (isPlainObject(schedule)) return [schedule];
  if (!Array.isArray(schedule)) return null;
  return schedule.filter(isPlainObject);
}

/**
 * True when `now` falls inside the off-peak window. A window may wrap past
 * midnight (16:30 → 00:30), and the end is exclusive. One window only: the
 * caller ORs the windows of an `offPeakHours` list.
 *
 * @param {{ tz: string, start: string, end: string }} schedule
 * @param {number} now
 * @returns {boolean}
 */
function offPeakActive(schedule, now) {
  const start = parseClock(schedule.start);
  const end = parseClock(schedule.end);
  if (start === null || end === null || typeof schedule.tz !== 'string') return false;
  const minutes = localMinutes(now, schedule.tz);
  if (minutes === null) return false;
  return start > end ? minutes >= start || minutes < end : minutes >= start && minutes < end;
}

/**
 * The price set a call uses. An `offPeak` set replaces the peak prices field by
 * field: a field it declares (even as null) wins, a field it omits falls back
 * to the peak price.
 *
 * @param {Record<string, any>} price
 * @param {{ offPeak: boolean }} options
 * @returns {PriceSet}
 */
function priceSet(price, { offPeak }) {
  const alternate = offPeak && isPlainObject(price.offPeak) ? price.offPeak : null;
  /** @type {PriceSet} */
  const set = { input: null, output: null, cacheRead: null, cacheWrite: null };
  for (const field of PRICE_FIELDS) {
    const source = alternate && Object.hasOwn(alternate, field) ? alternate : price;
    set[field] = finiteOrNull(source[field]);
  }
  return set;
}

/**
 * Blended list price for one token mix. A null price counts as 0: the mix says
 * those tokens are billed at nothing on this path, and the reason says so.
 *
 * @param {PriceSet} prices
 * @param {TokenMix} mix
 * @returns {number}
 */
function mixCost(prices, mix) {
  const share = (value) => finiteOrNull(value) ?? 0;
  const price = (value) => finiteOrNull(value) ?? 0;
  return share(mix.cacheRead) * price(prices.cacheRead)
    + share(mix.cacheWrite) * price(prices.cacheWrite)
    + share(mix.input) * price(prices.input)
    + share(mix.output) * price(prices.output);
}

/**
 * `YYYY-MM-DD` of the injected clock, in UTC (the same day boundary the
 * subscription dates use).
 *
 * @param {number} now
 * @returns {string}
 */
function utcDay(now) {
  return new Date(now).toISOString().slice(0, 10);
}

/**
 * The rejection reason a `until` date produces, or null while it is still in
 * the future. `until` is inclusive: from that date the entry is over.
 *
 * @param {Record<string, any>} price
 * @param {number} now
 * @returns {string|null}
 */
function expiredReason(price, now) {
  const until = typeof price.until === 'string' ? price.until.trim() : '';
  if (!ISO_DAY.test(until) || utcDay(now) < until) return null;
  return price.free === true ? `free tier ended ${until}` : `price entry expired ${until}`;
}

/** `$0.0012` for a sub-dollar price, `$1.22` above it, `$0` for free. */
function formatCost(value) {
  if (value === 0) return '$0';
  return `$${value < 1 ? value.toFixed(4) : value.toFixed(2)}`;
}

/** `$10`, `$12.50`: a dollar amount without trailing zeros. */
function formatDollars(value) {
  return `$${Number(value.toFixed(2))}`;
}

/** `41M`, `1.5M`, `250k`, `900`. */
function formatTokens(tokens) {
  if (tokens >= 1_000_000) {
    const millions = tokens / 1_000_000;
    return `${millions >= 10 ? Math.round(millions) : Number(millions.toFixed(1))}M`;
  }
  if (tokens >= 1_000) return `${Math.round(tokens / 1_000)}k`;
  return String(tokens);
}

/**
 * The sentence that explains a path price, in the same shape the routing
 * reasons use:
 *
 *   cost $0.0012/MTok (path price, off-peak, mix 95/0/5/0
 *   cache-read/write/in/out observed 41M tok, × $10/$100 allowance)
 *
 * @param {{
 *   costPerMTok: number|null, peak: boolean|null, hasSchedule: boolean,
 *   hasOffPeakPrices: boolean, prices: PriceSet, mix: TokenMix|null,
 *   mixSource: string, mixTokens: number|null, fee: number,
 *   monthlyLimit: number|null, free: boolean,
 * }} input
 * @returns {string}
 */
function priceReason({
  costPerMTok, peak, hasSchedule, hasOffPeakPrices, prices, mix, mixSource, mixTokens, fee, monthlyLimit, free,
}) {
  const cost = costPerMTok === null ? 'cost unknown/MTok' : `cost ${formatCost(costPerMTok)}/MTok`;
  if (free) return `${cost} (path price, free)`;
  const segments = ['path price'];
  if (peak === false) segments.push('off-peak');
  else if (peak === true) segments.push('peak');
  else segments.push(hasSchedule ? 'peak price (no off-peak prices)' : 'peak price (no off-peak schedule)');
  if (mix) {
    const percentages = [mix.cacheRead, mix.cacheWrite, mix.input, mix.output]
      .map((share) => Math.round(share * 100))
      .join('/');
    const observed = mixSource === 'observed-path'
      ? `observed ${formatTokens(mixTokens ?? 0)} tok`
      : mixSource === 'observed-model' ? `observed ${formatTokens(mixTokens ?? 0)} tok (any path)` : 'default mix';
    segments.push(`mix ${percentages} cache-read/write/in/out ${observed}`);
  }
  segments.push(monthlyLimit === null
    ? 'pay-per-token (no monthly limit)'
    : `× ${formatDollars(fee)}/${formatDollars(monthlyLimit)} allowance`);
  // Only a price the mix actually spends on is worth naming: a null
  // cache-write price on a mix with no cache writes changes nothing.
  const missing = PRICE_FIELDS
    .filter((field) => prices[field] === null && (finiteOrNull(mix?.[field]) ?? 0) > 0)
    .map((field) => `no ${PRICE_LABELS[field]} price`);
  if (missing.length) segments.push(`(${missing.join(', ')})`);
  return `${cost} (${segments.join(', ')})`;
}

/**
 * Resolve a quota path's own price for one model.
 *
 * The fee is the sum of the ACTIVE funding entries' fees (the same
 * `sourcePath ?? id` rule as `src/lib/subscriptions.js`); `monthlyLimit` is the
 * list-price dollars that fee buys, so the allowance scale is `fee / limit`.
 * A null limit means pay-per-token: no scaling.
 *
 * @param {{
 *   subscriptions?: Array<Record<string, any>>|null,
 *   quotaPath: string,
 *   modelKey: string,
 *   now: number,
 *   mix?: { mix: TokenMix|null, mixSource: string, mixTokens: number|null }|null,
 * }} input
 * @returns {PathPrice|null} null when the path declares no price for the model
 */
function pathPrice({ subscriptions = null, quotaPath, modelKey: key, now, mix = null }) {
  const source = priceSource(subscriptions, quotaPath, key);
  if (!source) return null;
  const { pathEntry, price } = source;
  const fee = pathFee(subscriptions, quotaPath, now);
  const monthlyLimit = finiteOrNull(price.monthlyLimit);
  const allowanceScale = monthlyLimit !== null && monthlyLimit > 0 ? fee / monthlyLimit : null;
  // One window or a list of them: off-peak is active when ANY window
  // contains `now`, and each window is read in its own `tz`.
  const windows = offPeakWindows(pathEntry.offPeakHours);
  const hasSchedule = windows !== null && windows.length > 0;
  const hasOffPeakPrices = isPlainObject(price.offPeak);
  const offPeak = hasSchedule && hasOffPeakPrices && windows.some((window) => offPeakActive(window, now));
  const peak = hasSchedule && hasOffPeakPrices ? !offPeak : null;
  const prices = priceSet(price, { offPeak });
  const free = price.free === true;
  const mixShares = mix && mix.mix ? mix.mix : null;
  const listCost = mixShares ? mixCost(prices, mixShares) : null;
  const costPerMTok = free
    ? 0
    : listCost === null ? null : (allowanceScale === null ? listCost : listCost * allowanceScale);
  return {
    pathId: typeof pathEntry.id === 'string' ? pathEntry.id : quotaPath,
    modelKey: key,
    fee,
    allowanceScale,
    peak,
    prices,
    costPerMTok,
    free,
    dataSharing: price.dataSharing === true,
    expiredReason: expiredReason(price, now),
    reason: priceReason({
      costPerMTok,
      peak,
      hasSchedule,
      hasOffPeakPrices,
      prices,
      mix: mixShares,
      mixSource: mix ? mix.mixSource : 'default',
      mixTokens: mix ? mix.mixTokens : null,
      fee,
      monthlyLimit,
      free,
    }),
  };
}

/**
 * Errors in every `config.paths[].prices` / `offPeakHours` block.
 *
 * A malformed table must fail loudly: a silently ignored price would route on
 * the registry's blended list price while the operator believes the
 * subscription's own list applies.
 *
 * @param {Record<string, any>} config parsed roi.config.json
 * @returns {string[]}
 */
function priceProblems(config) {
  const problems = [];
  const paths = Array.isArray(config?.paths) ? config.paths : [];
  paths.forEach((pathEntry, index) => {
    if (!pathEntry || typeof pathEntry !== 'object') return;
    const label = `paths[${index}] (${pathEntry.id ?? '?'})`;
    if (pathEntry.prices != null) {
      if (!isPlainObject(pathEntry.prices)) {
        problems.push(`${label}: "prices" must be an object keyed by model key`);
      } else {
        for (const [rawKey, entry] of Object.entries(pathEntry.prices)) {
          const keyLabel = `${label}: prices["${rawKey}"]`;
          if (!modelKey(rawKey)) {
            problems.push(`${keyLabel}: model key must be a non-empty string`);
            continue;
          }
          if (!isPlainObject(entry)) {
            problems.push(`${keyLabel}: must be an object`);
            continue;
          }
          for (const field of PRICE_FIELDS) {
            const value = entry[field];
            if (value === undefined || value === null) continue;
            if (finiteOrNull(value) === null) problems.push(`${keyLabel}.${field}: expected a number or null`);
            else if (value < 0) problems.push(`${keyLabel}.${field}: must not be negative`);
          }
          if (entry.monthlyLimit !== undefined && entry.monthlyLimit !== null) {
            const limit = finiteOrNull(entry.monthlyLimit);
            if (limit === null) problems.push(`${keyLabel}.monthlyLimit: expected a number or null`);
            else if (limit <= 0) problems.push(`${keyLabel}.monthlyLimit: must be a positive number`);
          }
          if (entry.offPeak !== undefined && entry.offPeak !== null) {
            if (!isPlainObject(entry.offPeak)) {
              problems.push(`${keyLabel}.offPeak: must be an object of prices`);
            } else {
              for (const field of PRICE_FIELDS) {
                const value = entry.offPeak[field];
                if (value === undefined || value === null) continue;
                if (finiteOrNull(value) === null) problems.push(`${keyLabel}.offPeak.${field}: expected a number or null`);
                else if (value < 0) problems.push(`${keyLabel}.offPeak.${field}: must not be negative`);
              }
            }
          }
          if (entry.longContext !== undefined && entry.longContext !== null) {
            if (!Array.isArray(entry.longContext)) {
              problems.push(`${keyLabel}.longContext: must be an array of tiers`);
            } else {
              entry.longContext.forEach((tier, tierIndex) => {
                const tierLabel = `${keyLabel}.longContext[${tierIndex}]`;
                if (!isPlainObject(tier)) {
                  problems.push(`${tierLabel}: must be an object`);
                  return;
                }
                const above = finiteOrNull(tier.aboveTokens);
                if (above === null || above <= 0) problems.push(`${tierLabel}.aboveTokens: must be a positive number`);
                for (const field of PRICE_FIELDS) {
                  const value = tier[field];
                  if (value === undefined || value === null) continue;
                  if (finiteOrNull(value) === null) problems.push(`${tierLabel}.${field}: expected a number or null`);
                  else if (value < 0) problems.push(`${tierLabel}.${field}: must not be negative`);
                }
              });
            }
          }
          for (const flag of ['free', 'dataSharing']) {
            if (entry[flag] !== undefined && typeof entry[flag] !== 'boolean') {
              problems.push(`${keyLabel}.${flag}: expected a boolean`);
            }
          }
          if (entry.until !== undefined && entry.until !== null) {
            const until = typeof entry.until === 'string' ? entry.until.trim() : '';
            if (!ISO_DAY.test(until) || Number.isNaN(Date.parse(`${until}T00:00:00Z`))) {
              problems.push(`${keyLabel}.until: expected a YYYY-MM-DD date`);
            }
          }
        }
      }
    }
    if (pathEntry.offPeakHours != null) {
      const schedule = pathEntry.offPeakHours;
      if (Array.isArray(schedule)) {
        // A list of windows, each checked on its own. Overlaps are legal: two
        // blocks may cover the same minutes without changing the result.
        if (schedule.length === 0) {
          problems.push(`${label}: "offPeakHours" must not be an empty array`);
        } else {
          schedule.forEach((window, windowIndex) => {
            problems.push(...windowProblems(window, `${label}: offPeakHours[${windowIndex}]`));
          });
        }
      } else if (isPlainObject(schedule)) {
        problems.push(...windowProblems(schedule, `${label}: offPeakHours`));
      } else {
        problems.push(`${label}: "offPeakHours" must be an object with tz, start and end, or a non-empty array of them`);
      }
    }
  });
  return problems;
}

/**
 * The per-window rules, shared by the single-object and array forms.
 *
 * @param {unknown} window
 * @param {string} prefix message prefix naming the window, e.g. `paths[0] (go): offPeakHours[1]`
 * @returns {string[]}
 */
function windowProblems(window, prefix) {
  if (!isPlainObject(window)) return [`${prefix} must be an object with tz, start and end`];
  const problems = [];
  if (typeof window.tz !== 'string' || !window.tz.trim()) {
    problems.push(`${prefix}.tz must be a non-empty time zone name`);
  } else if (!timeZoneKnown(window.tz)) {
    problems.push(`${prefix}.tz "${window.tz}" is not a known time zone`);
  }
  const start = parseClock(window.start);
  const end = parseClock(window.end);
  if (start === null) problems.push(`${prefix}.start must be a HH:MM time`);
  if (end === null) problems.push(`${prefix}.end must be a HH:MM time`);
  if (start !== null && start === end) problems.push(`${prefix}.start and end must differ`);
  return problems;
}

/**
 * @param {string} tz
 * @returns {boolean}
 */
function timeZoneKnown(tz) {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

/**
 * Warnings: a price key the path's own coverage does not list. A price for a
 * model the subscription does not serve is almost always a typo, but a
 * deliberate entry for a model outside `models` is harmless, so it warns.
 * Coverage `"*"` covers every key.
 *
 * @param {Record<string, any>} config parsed roi.config.json
 * @returns {string[]}
 */
function priceWarnings(config) {
  const entries = (Array.isArray(config?.paths) ? config.paths : [])
    .filter((entry) => entry && typeof entry.id === 'string');
  const warnings = [];
  for (const pathEntry of entries) {
    const table = priceTable(pathEntry);
    if (!table.size) continue;
    const quotaPath = quotaPathId(pathEntry);
    if (quotaPath === null) continue;
    // Coverage is the union over every entry funding the same quota path, so a
    // newer plan's model list covers a price declared by an older entry.
    const covering = entries.filter((entry) => quotaPathId(entry) === quotaPath);
    const covered = new Set();
    let all = false;
    for (const entry of covering) {
      for (const model of Array.isArray(entry.models) ? entry.models : []) {
        if (typeof model !== 'string') continue;
        if (model.trim() === '*') all = true;
        else covered.add(modelKey(model));
      }
    }
    if (all) continue;
    for (const key of table.keys()) {
      if (!covered.has(key)) warnings.push(`path ${pathEntry.id}: price for ${key} is not in the path's coverage`);
    }
  }
  return warnings;
}

module.exports = {
  priceTable,
  pathFee,
  parseClock,
  localMinutes,
  offPeakWindows,
  offPeakActive,
  priceSet,
  mixCost,
  formatCost,
  formatDollars,
  formatTokens,
  pathPrice,
  priceProblems,
  priceWarnings,
};

'use strict';

/**
 * Subscription status: which roi.config path funds a quota path, and whether
 * that funding is active right now.
 *
 * Pure data in, pure data out (no fs, no env, no clock reads beyond the
 * injected `now`). It lives in lib because both sides of the product need it:
 * the catalog (src/core) uses it to decide whether a runnable is routable, and
 * the ROI collector (src/roi-tracker) uses it to decide whether a quota path is
 * still worth collecting. Keeping it here is what lets the ROI layer stay free
 * of core imports.
 *
 * @typedef {object} SubscriptionStatus
 * @property {'active'|'ended'|'not-started'|'unconfigured'} state
 * @property {string[]} ids roi.config path ids that fund this quota path
 * @property {string|null} endDate latest end date (YYYYMMDD) when no funding subscription is active
 */

/**
 * @param {unknown} value
 * @returns {string|null} YYYYMMDD
 */
function day8(value) {
  if (value == null || value === '') return null;
  const day = String(value).replace(/-/g, '');
  // A malformed date would compare lexically and silently flip a plan
  // between active and ended; refuse it instead.
  if (!/^\d{8}$/.test(day)) throw new Error(`roi.config: invalid date ${JSON.stringify(value)} (expected YYYYMMDD or YYYY-MM-DD)`);
  return day;
}

/**
 * The quota path a roi.config entry funds: its `sourcePath` when it declares
 * one, its `id` otherwise. This is the ONE funding rule: quota.json keys,
 * `runnables[].path`, coverage and the displayed path name all use it.
 *
 * @param {Record<string, any>|null|undefined} pathEntry one `config.paths[]` entry
 * @returns {string|null} null when the entry names no path at all.
 */
function quotaPathId(pathEntry) {
  const source = typeof pathEntry?.sourcePath === 'string' ? pathEntry.sourcePath.trim() : '';
  if (source) return source;
  const id = typeof pathEntry?.id === 'string' ? pathEntry.id : '';
  return id || null;
}

/**
 * True when `pathEntry` funds quota path `pathId`. An entry without a string
 * `id` funds nothing, so a stray `sourcePath` cannot claim a path.
 *
 * @param {Record<string, any>|null|undefined} pathEntry
 * @param {string} pathId
 * @returns {boolean}
 */
function fundsQuotaPath(pathEntry, pathId) {
  if (!pathEntry || typeof pathEntry.id !== 'string' || typeof pathId !== 'string' || pathId === '') return false;
  return quotaPathId(pathEntry) === pathId;
}

/**
 * The config entries funding a quota path, in config order.
 *
 * @param {Array<Record<string, any>>|null|undefined} subscriptions roi.config.json `paths`
 * @param {string} pathId
 * @returns {Array<Record<string, any>>}
 */
function fundingEntries(subscriptions, pathId) {
  return (Array.isArray(subscriptions) ? subscriptions : []).filter((p) => fundsQuotaPath(p, pathId));
}

/**
 * True when the entry's subscription dates cover `today` (YYYYMMDD, inclusive).
 *
 * @param {Record<string, any>} pathEntry
 * @param {string} today
 * @returns {boolean}
 */
function isActiveOn(pathEntry, today) {
  const start = day8(pathEntry.startDate);
  const end = day8(pathEntry.endDate);
  return (!start || start <= today) && (!end || end >= today);
}

/** `YYYYMMDD` in UTC for an injected clock. */
function currentDay(now) {
  return new Date(now).toISOString().slice(0, 10).replace(/-/g, '');
}

/**
 * Status of the subscriptions that fund a quota path. A roi.config path funds
 * quota path P when its `sourcePath` (or, absent that, its `id`) is P, so
 * `codexprolite` (sourcePath codex) keeps the `codex` path alive after the
 * original `codex` plan ended. Dates are inclusive YYYYMMDD, as in the ROI
 * pipeline. No funding entry at all is `unconfigured`: routing rejects it, so
 * a runnable cannot outlive the subscription that paid for it.
 *
 * @param {Array<Record<string, any>>} subscriptions roi.config.json `paths`
 * @param {string} pathId
 * @param {number} [now]
 * @returns {SubscriptionStatus}
 */
function subscriptionStatus(subscriptions, pathId, now = Date.now()) {
  const today = currentDay(now);
  const funding = fundingEntries(subscriptions, pathId);
  if (!funding.length) return { state: 'unconfigured', ids: [], endDate: null };
  const active = funding.filter((p) => isActiveOn(p, today));
  if (active.length) return { state: 'active', ids: active.map((p) => p.id), endDate: null };
  const upcoming = funding.some((p) => {
    const start = day8(p.startDate);
    return start !== null && start > today;
  });
  const ends = funding.map((p) => day8(p.endDate)).filter((d) => d !== null).sort();
  return {
    state: upcoming ? 'not-started' : 'ended',
    ids: funding.map((p) => p.id),
    endDate: ends.length ? /** @type {string} */ (ends[ends.length - 1]) : null,
  };
}

/**
 * Display names of the config paths currently funding a quota path, in config
 * order. Empty when none is active — the caller falls back to the path id.
 *
 * @param {Array<Record<string, any>>|null|undefined} subscriptions roi.config.json `paths`
 * @param {string} pathId
 * @param {number} [now]
 * @returns {string[]}
 */
function activeSubscriptionNames(subscriptions, pathId, now = Date.now()) {
  const today = currentDay(now);
  return fundingEntries(subscriptions, pathId)
    .filter((p) => isActiveOn(p, today))
    .map((p) => (typeof p.name === 'string' && p.name.trim() ? p.name.trim() : p.id));
}

module.exports = { day8, quotaPathId, fundsQuotaPath, activeSubscriptionNames, subscriptionStatus };

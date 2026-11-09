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
  const today = new Date(now).toISOString().slice(0, 10).replace(/-/g, '');
  const funding = subscriptions.filter((p) => p && typeof p.id === 'string' && (p.sourcePath ?? p.id) === pathId);
  if (!funding.length) return { state: 'unconfigured', ids: [], endDate: null };
  const active = funding.filter((p) => {
    const start = day8(p.startDate);
    const end = day8(p.endDate);
    return (!start || start <= today) && (!end || end >= today);
  });
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

module.exports = { day8, subscriptionStatus };

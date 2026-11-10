'use strict';

/**
 * Track records: what outcome reviews say about a model on THIS user's work.
 *
 * A score (ROI genIntel) or an AA estimate is a claim about a model in general.
 * Neither exists for many cheap subscription models, and neither says anything
 * about how the model performed on the work this queue actually ran. A review
 * fills that gap: the caller (a main assistant or a person) looks at what a
 * model produced and records a verdict. Reviews fold into a per-(model, tier)
 * record, and routing uses it to inform — and, for a model with no intelligence
 * at all, to unlock eligibility.
 *
 * Pure: no fs, no clock, no database. Rows arrive from the queue layer
 * (src/queue/track-records.js) and this module only counts them.
 *
 * Three deliberate rules:
 *
 * 1. A model is identified by its model KEY, resolved exactly as the catalog
 *    does (`runnable.modelKey ?? modelKey(runnable.id)`), so the same model on
 *    two quota paths shares one record.
 * 2. A verdict is weighted: accepted 1, accepted-with-fixes 0.5, rejected 0.
 *    "Worked, but needed fixing" is evidence, not a failure.
 * 3. Tier inheritance is one-directional: a review at `big` also counts for
 *    `medium` and `small`, and one at `medium` also counts for `small`. Doing
 *    well on harder work implies easier work; the reverse does not follow.
 *
 * The Wilson score lower bound at 95% is what makes a small sample honest: 5
 * of 5 accepted is only ~0.566, which is not enough to trust. 10 of 10 is
 * ~0.722. The thresholds below are product judgement, tunable through the
 * `trackRecord` key in the ROI config.
 */

const { modelKey } = require('../lib/model-key.js');

/** Tiers a review can be recorded at, easiest first. */
const REVIEW_TIERS = Object.freeze(['small', 'medium', 'big']);

/** Verdicts, from best to worst. */
const REVIEW_VERDICTS = Object.freeze(['accepted', 'accepted-with-fixes', 'rejected']);

/** Weighted successes per verdict. */
const VERDICT_WEIGHTS = Object.freeze({ accepted: 1, 'accepted-with-fixes': 0.5, rejected: 0 });

/** Where a review row came from: a person/assistant, or a failed verification. */
const REVIEW_SOURCES = Object.freeze(['review', 'verify']);

/** Reviews behind an unscored model before its record can unlock it. */
const TRACK_RECORD_MIN_N = 5;

/** Wilson lower bound a record must reach before it can unlock an unscored model. */
const TRACK_RECORD_MIN_LOWER = 0.7;

/**
 * How many further accepted reviews `reviewsToUnlock` will look at. Beyond the
 * cap a record is reported as unreachable (`null`) rather than as needing an
 * exact number nobody would believe: a Wilson bound is always below 1 for a
 * finite sample, so `minLowerBound: 1` has no answer at any k.
 */
const REVIEWS_TO_UNLOCK_MAX_K = 100;

/** Two-sided 95% z-score for the Wilson interval. */
const WILSON_Z = 1.96;

/**
 * The tier a `verify_failed` outcome counts at.
 *
 * `path_outcomes` records no tier, and a failed verification is evidence about
 * the model's work rather than about a difficulty. Attributing it to the
 * default tier is the honest middle: it counts for `medium` and, by
 * inheritance, for `small`, but it never claims the model failed at `big`.
 */
const VERIFY_OUTCOME_TIER = 'medium';

/** Which tiers a review recorded at `tier` counts for. */
const TIERS_COUNTED_FOR = Object.freeze({
  small: Object.freeze(['small']),
  medium: Object.freeze(['medium', 'small']),
  big: Object.freeze(['big', 'medium', 'small']),
});

/**
 * Wilson score interval lower bound for `successes` out of `n` at z.
 *
 * Fractional successes are intentional: an accepted-with-fixes review counts
 * as half a success, and the bound stays conservative about the unknown.
 *
 * @param {number} successes Weighted successes (0..n).
 * @param {number} n Observations.
 * @param {number} [z]
 * @returns {number} 0..1; 0 when there is nothing to go on.
 */
function wilsonLowerBound(successes, n, z = WILSON_Z) {
  if (!(n > 0) || !Number.isFinite(n) || !Number.isFinite(successes)) return 0;
  const p = Math.min(1, Math.max(0, successes / n));
  const z2 = z * z;
  const denominator = 1 + z2 / n;
  const centre = p + z2 / (2 * n);
  const margin = z * Math.sqrt((p * (1 - p) + z2 / (4 * n)) / n);
  return Math.max(0, (centre - margin) / denominator);
}

/**
 * Weighted successes of a verdict, or null for an unknown verdict.
 *
 * @param {string} verdict
 * @returns {number|null}
 */
function verdictWeight(verdict) {
  return Object.hasOwn(VERDICT_WEIGHTS, verdict) ? VERDICT_WEIGHTS[verdict] : null;
}

/**
 * Weighted successes already on a record, from the same VERDICT_WEIGHTS the
 * fold uses — so a count and a bound never disagree about what a review is
 * worth.
 *
 * @param {{ accepted?: number, withFixes?: number, rejected?: number }|null|undefined} record
 * @returns {number} 0 for a record with nothing on it.
 */
function recordSuccesses(record) {
  const count = (value) => (Number.isFinite(value) ? value : 0);
  return count(record && record.accepted) * VERDICT_WEIGHTS.accepted
    + count(record && record.withFixes) * VERDICT_WEIGHTS['accepted-with-fixes']
    + count(record && record.rejected) * VERDICT_WEIGHTS.rejected;
}

/**
 * The catalog's key resolution, for a review row that names a runnable id.
 *
 * A declared `modelKey` wins over the id's own key, exactly as the catalog
 * joins ROI rows. A model that is no longer a runnable still gets a key from
 * its id, so its history is not silently dropped.
 *
 * @param {Array<{ id: string, modelKey?: string|null }>} runnables
 * @returns {(model: string) => string}
 */
function keyResolver(runnables = []) {
  /** @type {Map<string, string>} */
  const declared = new Map();
  for (const runnable of Array.isArray(runnables) ? runnables : []) {
    if (!runnable || typeof runnable.id !== 'string' || !runnable.id) continue;
    declared.set(runnable.id, typeof runnable.modelKey === 'string' && runnable.modelKey
      ? runnable.modelKey
      : modelKey(runnable.id));
  }
  return (model) => declared.get(model) ?? modelKey(model);
}

/**
 * Fold review rows (and verification failures) into per-(model key, tier)
 * records.
 *
 * An explicit review always overrides a `verify_failed` outcome for the same
 * task: the review is a considered verdict, the outcome is a side effect of
 * running. A verification failure with no review behind it counts as a
 * rejection with source `verify`.
 *
 * @param {{
 *   reviews?: Array<{ model: string, tier: string, verdict: string, task_id?: string|null }>,
 *   verifyOutcomes?: Array<{ model?: string|null, task_id?: string|null, outcome: string, tier?: string|null }>,
 *   runnables?: Array<{ id: string, modelKey?: string|null }>,
 * }} [input]
 * @returns {Map<string, Map<string, { n: number, accepted: number, withFixes: number, rejected: number, rate: number, lowerBound: number }>>}
 *   model key → tier → record. Empty when nothing was recorded.
 */
function buildTrackRecords({ reviews = [], verifyOutcomes = [], runnables = [] } = {}) {
  const keyOf = keyResolver(runnables);

  /** Tasks that already have a considered verdict. */
  const reviewedTasks = new Set();
  for (const review of Array.isArray(reviews) ? reviews : []) {
    if (review && review.task_id != null && review.task_id !== '') reviewedTasks.add(String(review.task_id));
  }

  /** @type {Map<string, Map<string, { accepted: number, withFixes: number, rejected: number }>>} */
  const counts = new Map();

  /**
   * Count one verdict at `tier` and at every tier it implies.
   *
   * @param {string} model
   * @param {unknown} tier
   * @param {string} verdict
   */
  const add = (model, tier, verdict) => {
    if (typeof tier !== 'string' || !Object.hasOwn(TIERS_COUNTED_FOR, tier)) return;
    const key = keyOf(model);
    if (!key) return;
    for (const target of TIERS_COUNTED_FOR[tier]) {
      let byTier = counts.get(key);
      if (!byTier) {
        byTier = new Map();
        counts.set(key, byTier);
      }
      let bucket = byTier.get(target);
      if (!bucket) {
        bucket = { accepted: 0, withFixes: 0, rejected: 0 };
        byTier.set(target, bucket);
      }
      if (verdict === 'accepted') bucket.accepted += 1;
      else if (verdict === 'accepted-with-fixes') bucket.withFixes += 1;
      else if (verdict === 'rejected') bucket.rejected += 1;
    }
  };

  for (const review of Array.isArray(reviews) ? reviews : []) {
    if (!review || typeof review.model !== 'string' || !review.model) continue;
    if (!REVIEW_VERDICTS.includes(review.verdict)) continue;
    add(review.model, review.tier, review.verdict);
  }

  for (const outcome of Array.isArray(verifyOutcomes) ? verifyOutcomes : []) {
    if (!outcome || outcome.outcome !== 'verify_failed') continue;
    if (typeof outcome.model !== 'string' || !outcome.model) continue;
    // The review is the considered verdict; the outcome is what running said.
    if (outcome.task_id != null && outcome.task_id !== '' && reviewedTasks.has(String(outcome.task_id))) continue;
    const tier = typeof outcome.tier === 'string' && outcome.tier ? outcome.tier : VERIFY_OUTCOME_TIER;
    add(outcome.model, tier, 'rejected');
  }

  /** @type {Map<string, Map<string, { n: number, accepted: number, withFixes: number, rejected: number, rate: number, lowerBound: number }>>} */
  const records = new Map();
  for (const [key, byTier] of counts) {
    const tiers = new Map();
    for (const [tier, bucket] of byTier) {
      const n = bucket.accepted + bucket.withFixes + bucket.rejected;
      if (n === 0) continue;
      const successes = recordSuccesses(bucket);
      tiers.set(tier, {
        n,
        accepted: bucket.accepted,
        withFixes: bucket.withFixes,
        rejected: bucket.rejected,
        rate: successes / n,
        lowerBound: wilsonLowerBound(successes, n),
      });
    }
    if (tiers.size) records.set(key, tiers);
  }
  return records;
}

/**
 * The record for one model key at one tier, or null.
 *
 * @param {Map<string, Map<string, any>>|null|undefined} trackRecords
 * @param {string|null|undefined} key
 * @param {string|null|undefined} tier
 * @returns {{ n: number, accepted: number, withFixes: number, rejected: number, rate: number, lowerBound: number }|null}
 */
function trackRecordFor(trackRecords, key, tier) {
  if (!(trackRecords instanceof Map) || typeof key !== 'string' || !key) return null;
  if (typeof tier !== 'string' || !tier) return null;
  const byTier = trackRecords.get(key);
  if (!(byTier instanceof Map)) return null;
  const record = byTier.get(tier);
  return record && typeof record === 'object' ? record : null;
}

/**
 * The thresholds a record must clear to unlock an unscored model, read from
 * the optional `trackRecord` config key. Missing or invalid values fall back
 * to the constants above, so a partial config never disables the feature.
 *
 * @param {Record<string, any>|null|undefined} config Effective ROI config.
 * @returns {{ minReviews: number, minLowerBound: number }}
 */
function trackRecordPolicy(config) {
  const raw = config && typeof config === 'object' && config.trackRecord && typeof config.trackRecord === 'object'
    ? config.trackRecord
    : {};
  return policyThresholds(raw);
}

/**
 * The two thresholds, read off a policy object (or a partial one, or nothing).
 *
 * The same fallbacks as `trackRecordPolicy`, applied to the policy shape that
 * function returns rather than the config that feeds it: an interface that
 * already holds a policy can hand it straight to `reviewsToUnlock`.
 *
 * @param {{ minReviews?: number, minLowerBound?: number }|null|undefined} policy
 * @returns {{ minReviews: number, minLowerBound: number }}
 */
function policyThresholds(policy) {
  const raw = policy && typeof policy === 'object' ? policy : {};
  const minReviews = Number.isFinite(raw.minReviews) && raw.minReviews >= 0
    ? Math.floor(raw.minReviews)
    : TRACK_RECORD_MIN_N;
  const minLowerBound = Number.isFinite(raw.minLowerBound) && raw.minLowerBound >= 0 && raw.minLowerBound <= 1
    ? raw.minLowerBound
    : TRACK_RECORD_MIN_LOWER;
  return { minReviews, minLowerBound };
}

/**
 * Does this record clear the unlock thresholds?
 *
 * @param {{ n: number, lowerBound: number }|null|undefined} record
 * @param {{ minReviews?: number, minLowerBound?: number }} [policy]
 * @returns {boolean}
 */
function qualifies(record, { minReviews = TRACK_RECORD_MIN_N, minLowerBound = TRACK_RECORD_MIN_LOWER } = {}) {
  if (!record || !Number.isFinite(record.n) || !Number.isFinite(record.lowerBound)) return false;
  return record.n >= minReviews && record.lowerBound >= minLowerBound;
}

/**
 * How many more accepted reviews a record needs before it unlocks its model.
 *
 * The distance the stats table otherwise leaves to the reader: the smallest
 * k ≥ 0 such that, once k more accepted reviews (weight 1 each) are on the
 * record, both thresholds clear — `n + k >= minReviews` and
 * `wilsonLowerBound(successes + k, n + k) >= minLowerBound`. Informational
 * only: routing never reads it.
 *
 * @param {{ n?: number, accepted?: number, withFixes?: number, rejected?: number }|null|undefined} record
 *   A record as `buildTrackRecords` builds one: `n` is the observation count and
 *   the verdict counts add up to it. A missing or non-numeric verdict count reads
 *   as zero, and a record with no usable `n` (or a negative one) has no distance
 *   to report, so it returns null rather than inventing one.
 * @param {{ minReviews?: number, minLowerBound?: number }} [policy] Defaults to `trackRecordPolicy()`'s thresholds.
 * @returns {number|null} 0 when the record already clears both thresholds, the
 *   number of clean reviews still needed, or null when nothing within
 *   REVIEWS_TO_UNLOCK_MAX_K gets there.
 */
function reviewsToUnlock(record, policy) {
  const { minReviews, minLowerBound } = policyThresholds(policy);
  if (!record || typeof record !== 'object') return null;
  if (!Number.isFinite(record.n) || record.n < 0) return null;
  const successes = recordSuccesses(record);
  for (let k = 0; k <= REVIEWS_TO_UNLOCK_MAX_K; k += 1) {
    const n = record.n + k;
    if (n >= minReviews && wilsonLowerBound(successes + k, n) >= minLowerBound) return k;
  }
  return null;
}

/**
 * Weighted successes as text: `6` for whole numbers, `3.5` when a
 * with-fixes verdict contributes half.
 *
 * @param {{ accepted: number, withFixes: number }} record
 * @returns {string}
 */
function successesText(record) {
  const successes = recordSuccesses(record);
  return Number.isInteger(successes) ? String(successes) : successes.toFixed(1);
}

/**
 * The plain record sentence: `track record 4/5 at big`.
 *
 * @param {{ n: number, accepted: number, withFixes: number }} record
 * @param {string} tier
 * @returns {string}
 */
function trackRecordReason(record, tier) {
  return `track record ${successesText(record)}/${record.n} at ${tier}`;
}

/**
 * The eligibility sentence for an unscored model whose record unlocks it:
 * `track record 6/6 accepted at medium (lower bound 0.74 >= 0.70)`.
 *
 * @param {{ n: number, accepted: number, withFixes: number, lowerBound: number }} record
 * @param {string} tier
 * @param {{ minLowerBound?: number }} [policy]
 * @returns {string}
 */
function eligibilityReason(record, tier, { minLowerBound = TRACK_RECORD_MIN_LOWER } = {}) {
  return `track record ${successesText(record)}/${record.n} accepted at ${tier} `
    + `(lower bound ${record.lowerBound.toFixed(2)} >= ${minLowerBound.toFixed(2)})`;
}

/**
 * The `record` cell of the pick table: `5/6`, or `—` when there is no record.
 *
 * @param {{ n: number, accepted: number, withFixes: number }|null|undefined} record
 * @returns {string}
 */
function recordCell(record) {
  if (!record || !Number.isFinite(record.n) || record.n === 0) return '—';
  return `${successesText(record)}/${record.n}`;
}

/**
 * Every record as a flat, stable list — the one shape `agentq review stats`
 * and the `track_records` MCP tool both return.
 *
 * @param {Map<string, Map<string, any>>|null|undefined} trackRecords
 * @param {{ minReviews?: number, minLowerBound?: number }} [policy] The thresholds to measure the gap against;
 *   defaults to `trackRecordPolicy()`'s. Callers should pass the policy they route with, so `needed` means
 *   "to unlock here".
 * @returns {{ count: number, records: Array<{ model: string, tier: string, n: number, accepted: number, withFixes: number, rejected: number, rate: number, lowerBound: number, needed: number|null }> }}
 */
function trackRecordStats(trackRecords, policy = trackRecordPolicy()) {
  /** @type {Array<{ model: string, tier: string, n: number, accepted: number, withFixes: number, rejected: number, rate: number, lowerBound: number, needed: number|null }>} */
  const records = [];
  if (trackRecords instanceof Map) {
    for (const [model, byTier] of trackRecords) {
      if (!(byTier instanceof Map)) continue;
      for (const [tier, record] of byTier) {
        if (!record || typeof record !== 'object') continue;
        records.push({
          model,
          tier,
          n: record.n,
          accepted: record.accepted,
          withFixes: record.withFixes,
          rejected: record.rejected,
          rate: record.rate,
          lowerBound: record.lowerBound,
          needed: reviewsToUnlock(record, policy),
        });
      }
    }
  }
  const tierRank = (tier) => {
    const index = REVIEW_TIERS.indexOf(tier);
    return index === -1 ? REVIEW_TIERS.length : index;
  };
  records.sort((a, b) => (a.model < b.model ? -1 : a.model > b.model ? 1 : 0) || tierRank(a.tier) - tierRank(b.tier));
  return { count: records.length, records };
}

module.exports = {
  REVIEW_TIERS,
  REVIEW_VERDICTS,
  REVIEW_SOURCES,
  VERDICT_WEIGHTS,
  VERIFY_OUTCOME_TIER,
  TRACK_RECORD_MIN_N,
  TRACK_RECORD_MIN_LOWER,
  REVIEWS_TO_UNLOCK_MAX_K,
  WILSON_Z,
  TIERS_COUNTED_FOR,
  wilsonLowerBound,
  verdictWeight,
  recordSuccesses,
  keyResolver,
  buildTrackRecords,
  trackRecordFor,
  trackRecordPolicy,
  policyThresholds,
  reviewsToUnlock,
  qualifies,
  successesText,
  trackRecordReason,
  eligibilityReason,
  recordCell,
  trackRecordStats,
};

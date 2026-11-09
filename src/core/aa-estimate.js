'use strict';

/**
 * Intelligence ESTIMATES from the Artificial Analysis Intelligence Index.
 *
 * Some runnables cannot be scored from the benchmark registry (no registry row,
 * or a row whose scoring partitions are incomplete). Routing may still consider
 * them, but only on an explicitly marked estimate: a linear fit of the ROI
 * `genIntel` score on the AA Intelligence Index, learned from the models that
 * have BOTH a complete score and an exact AA row.
 *
 * Three deliberate restrictions keep an estimate from masquerading as a score:
 *
 *   - identity is exact. A pair needs the AA row whose slug is the model key
 *     (or the registry row's pinned `aaSlug`). Folded matches — a `-thinking`
 *     or `-preview` suffix, a parenthetical qualifier, a display name — are
 *     never used, because a wrong model is worse than no estimate.
 *   - the fit must be credible: at least 5 pairs, r >= 0.85, and a positive
 *     slope. Otherwise estimates are disabled entirely.
 *   - the estimate is shifted down by one residual standard error (n-2
 *     degrees of freedom) and capped at the best scored model in the
 *     calibration set. It is never lifted: an AA value below the calibration
 *     range gets no estimate at all, rather than the weakest model's score.
 *
 * Everything here is pure: no fs, no clock, no environment.
 */

const { modelKey } = require('../lib/model-key.js');

/** Minimum exact pairs before a fit is trusted. */
const MIN_PAIRS = 5;
/** Minimum Pearson correlation before a fit is trusted. */
const MIN_R = 0.85;
/** Marks a catalog intelligence value that came from this module. */
const ESTIMATE_SOURCE = 'aa-estimate';
/** Marks a catalog intelligence value that came from the ROI export. */
const SCORE_SOURCE = 'roi';

/**
 * @typedef {object} Calibration
 * @property {number} n pairs used
 * @property {number} a intercept
 * @property {number} b slope (genIntel per AA index point)
 * @property {number} r Pearson correlation
 * @property {number} rmse residual standard error, sqrt(SSE / (n - 2))
 * @property {number} minGen lowest genIntel in the calibration set
 * @property {number} maxGen highest genIntel in the calibration set
 * @property {number} minAa lowest AA index in the calibration set
 * @property {number} maxAa highest AA index in the calibration set
 * @property {string|null} snapshotVersion AA Intelligence Index version the pairs came from
 * @property {string|null} [generatedAt] when the AA snapshot was taken
 */

/**
 * @typedef {{ disabled: string }} DisabledCalibration
 */

/**
 * @param {unknown} value
 * @returns {number|null}
 */
function finite(value) {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

/**
 * Index snapshot rows by their exact slug. A slug that appears more than once
 * is ambiguous and never matches: two rows claiming one identity cannot both be
 * the model in question.
 *
 * @param {{ models?: Array<Record<string, any>> }|null|undefined} snapshot
 * @returns {Map<string, { row: Record<string, any>, ambiguous: boolean }>}
 */
function buildAaIndex(snapshot) {
  /** @type {Map<string, { row: Record<string, any>, ambiguous: boolean }>} */
  const index = new Map();
  const models = snapshot && Array.isArray(snapshot.models) ? snapshot.models : [];
  for (const row of models) {
    if (!row || typeof row.slug !== 'string' || !row.slug) continue;
    const existing = index.get(row.slug);
    if (existing) {
      existing.ambiguous = true;
      continue;
    }
    index.set(row.slug, { row, ambiguous: false });
  }
  return index;
}

/**
 * The exact AA snapshot row for one slug, or null when the slug is absent or
 * ambiguous. Callers that need more than the index (pricing) use this so they
 * read the same row the estimate was built from.
 *
 * @param {ReturnType<typeof buildAaIndex>} index
 * @param {string|null|undefined} slug
 * @returns {Record<string, any>|null}
 */
function aaRowFor(index, slug) {
  if (!index || typeof index.get !== 'function') return null;
  if (typeof slug !== 'string' || !slug) return null;
  const hit = index.get(slug);
  if (!hit || hit.ambiguous) return null;
  return hit.row;
}

/**
 * AA Intelligence Index for one exact slug, or null when the slug is absent,
 * ambiguous, or carries no index value.
 *
 * @param {ReturnType<typeof buildAaIndex>} index
 * @param {string|null|undefined} slug
 * @returns {number|null}
 */
function aaIndexFor(index, slug) {
  const row = aaRowFor(index, slug);
  return row ? finite(row.evaluations?.artificial_analysis_intelligence_index) : null;
}

/**
 * Build the calibration pairs: every COMPLETE ROI model that has an exact AA
 * row. A registry row's `aaSlug` pins the slug (the only way a model whose AA
 * slug differs from its key can match); otherwise the slug must equal the
 * model key exactly.
 *
 * @param {{
 *   roiModels?: Array<Record<string, any>>,
 *   registryRows?: Array<Record<string, any>>,
 *   snapshot?: { models?: Array<Record<string, any>> }|null,
 * }} [input]
 * @returns {{ pairs: Array<{ model: string, aa: number, genIntel: number }>, skipped: Array<{ model: string, reason: string }> }}
 */
function calibrationPairs({ roiModels = [], registryRows = [], snapshot = null } = {}) {
  const index = buildAaIndex(snapshot);
  /** @type {Map<string, Record<string, any>>} */
  const registryByKey = new Map();
  for (const row of registryRows) {
    if (!row || typeof row.model !== 'string') continue;
    const key = modelKey(row.model);
    if (!registryByKey.has(key)) registryByKey.set(key, row);
  }

  const pairs = [];
  const skipped = [];
  const seenKeys = new Set();
  for (const row of roiModels) {
    if (!row || row.complete !== true || typeof row.model !== 'string') continue;
    const key = modelKey(row.model);
    // Rows that fold to one key would pair the same AA value twice; the
    // catalog keeps the first such row, so calibration does too.
    if (seenKeys.has(key)) {
      skipped.push({ model: row.model, reason: `duplicate model key "${key}"` });
      continue;
    }
    seenKeys.add(key);
    const registry = registryByKey.get(key);
    const pinned = registry && typeof registry.aaSlug === 'string' ? registry.aaSlug.trim() : '';
    const aa = aaIndexFor(index, pinned || key);
    if (aa === null) {
      skipped.push({ model: row.model, reason: pinned ? `pinned aaSlug "${pinned}" has no index value` : 'no exact AA row' });
      continue;
    }
    const genIntel = finite(row.genIntel);
    if (genIntel === null) {
      skipped.push({ model: row.model, reason: 'no genIntel score' });
      continue;
    }
    pairs.push({ model: row.model, aa, genIntel });
  }
  return { pairs, skipped };
}

/**
 * Ordinary least squares genIntel = a + b*aa over the calibration pairs.
 *
 * Returns `{ disabled: reason }` when the fit cannot be trusted: fewer than 5
 * pairs, no spread in the AA values, a non-positive slope, or r < 0.85.
 *
 * @param {Array<{ model?: string, aa: number, genIntel: number }>} pairs
 * @param {{ snapshotVersion?: string|null }} [options]
 * @returns {Calibration|DisabledCalibration}
 */
function calibrate(pairs, { snapshotVersion = null } = {}) {
  const usable = (Array.isArray(pairs) ? pairs : [])
    .map((pair) => ({ aa: finite(pair?.aa), genIntel: finite(pair?.genIntel) }))
    .filter((pair) => pair.aa !== null && pair.genIntel !== null);

  const n = usable.length;
  if (n < MIN_PAIRS) return { disabled: `too few exact pairs (n=${n}, need ${MIN_PAIRS})` };

  const meanAa = usable.reduce((sum, p) => sum + p.aa, 0) / n;
  const meanGen = usable.reduce((sum, p) => sum + p.genIntel, 0) / n;
  let sxy = 0;
  let sxx = 0;
  let syy = 0;
  for (const p of usable) {
    sxy += (p.aa - meanAa) * (p.genIntel - meanGen);
    sxx += (p.aa - meanAa) ** 2;
    syy += (p.genIntel - meanGen) ** 2;
  }
  if (sxx === 0) return { disabled: 'no AA spread in the calibration set' };
  if (syy === 0) return { disabled: 'no genIntel spread in the calibration set' };

  const b = sxy / sxx;
  const a = meanGen - b * meanAa;
  const r = sxy / Math.sqrt(sxx * syy);
  if (!Number.isFinite(b) || !Number.isFinite(a) || !Number.isFinite(r)) {
    return { disabled: 'the fit is not finite' };
  }
  if (b <= 0) return { disabled: `non-positive slope (b=${b.toFixed(3)}): AA does not predict the score` };
  if (r < MIN_R) return { disabled: `weak correlation (r=${r.toFixed(3)} < ${MIN_R})` };

  let sse = 0;
  for (const p of usable) sse += (p.genIntel - (a + b * p.aa)) ** 2;
  // Sample residual standard error (n-2 dof): with a handful of pairs the
  // population form understates the error and makes the shift optimistic.
  const rmse = Math.sqrt(sse / (n - 2));

  return {
    n,
    a,
    b,
    r,
    rmse,
    minGen: Math.min(...usable.map((p) => p.genIntel)),
    maxGen: Math.max(...usable.map((p) => p.genIntel)),
    minAa: Math.min(...usable.map((p) => p.aa)),
    maxAa: Math.max(...usable.map((p) => p.aa)),
    snapshotVersion: snapshotVersion ?? null,
  };
}

/**
 * Estimated intelligence for one AA index value.
 *
 * Conservative by construction: the fit minus one residual standard error,
 * capped at the best scored model. Never extrapolated downward: an AA value
 * below the calibration range returns null (a weak model is not lifted to the
 * weakest scored one). Returns null when the calibration is disabled or the AA
 * value is unusable.
 *
 * @param {Calibration|DisabledCalibration|null|undefined} calibration
 * @param {unknown} aa
 * @returns {number|null}
 */
function estimate(calibration, aa) {
  if (!calibration || calibration.disabled) return null;
  const value = finite(aa);
  if (value === null) return null;
  if (value < calibration.minAa) return null;
  const raw = calibration.a + calibration.b * value - calibration.rmse;
  if (!Number.isFinite(raw)) return null;
  return Math.min(raw, calibration.maxGen);
}

/**
 * Calibration from the raw inputs: pairs (registry-pinned, exact only) plus the
 * fit. This is the entry point snapshot.js uses.
 *
 * @param {{
 *   roiModels?: Array<Record<string, any>>,
 *   registryRows?: Array<Record<string, any>>,
 *   snapshot?: { models?: Array<Record<string, any>>, intelligenceIndexVersion?: string|null, generatedAt?: string|null }|null,
 * }} [input]
 * @returns {(Calibration & { pairs: number, skipped: Array<{ model: string, reason: string }> })|DisabledCalibration}
 */
function buildCalibration({ roiModels = [], registryRows = [], snapshot = null } = {}) {
  const { pairs, skipped } = calibrationPairs({ roiModels, registryRows, snapshot });
  const fit = calibrate(pairs, { snapshotVersion: snapshot?.intelligenceIndexVersion ?? null });
  if ('disabled' in fit) return fit;
  return { ...fit, generatedAt: snapshot?.generatedAt ?? null, pairs: fit.n, skipped };
}

module.exports = {
  MIN_PAIRS,
  MIN_R,
  ESTIMATE_SOURCE,
  SCORE_SOURCE,
  buildAaIndex,
  aaRowFor,
  aaIndexFor,
  calibrationPairs,
  calibrate,
  estimate,
  buildCalibration,
};

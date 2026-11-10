'use strict';

/**
 * Catalog: the runnable universe (which model, via which quota path, on which
 * harness) joined with ROI scores. Everything except loadRunnables() is pure.
 *
 * A runnable is a *choice*, not a capability claim: `scored: false` means the
 * ROI export produced no intelligence score for it, so its intelligence/cost
 * are unknown rather than zero. Routing must not treat unknown as cheap.
 *
 * An unscored runnable can still carry an ESTIMATE derived from the Artificial
 * Analysis Intelligence Index (src/core/aa-estimate.js). `intelligenceSource`
 * says where the number came from — `'roi'` for a real score, `'aa-estimate'`
 * for the fit — and an estimate is never reported as `scored`.
 */

const fs = require('node:fs');
const { modelKey } = require('../lib/model-key.js');
const { aaListCost } = require('../lib/aa-pricing.js');
const { pathPrice } = require('../lib/path-prices.js');
const { activeSubscriptionNames, subscriptionStatus } = require('../lib/subscriptions.js');
const { mixFor } = require('./token-mix.js');
const {
  ESTIMATE_SOURCE,
  SCORE_SOURCE,
  aaIndexFor,
  aaRowFor,
  buildAaIndex,
  estimate,
} = require('./aa-estimate.js');
const { homeConfigPath } = require('../lib/home.js');

const SCHEMA_VERSION = 1;

/**
 * The runnable list is personal setup, so it lives in AGENTQ_HOME, never in the
 * checkout. Resolved lazily: a process may change AGENTQ_HOME between calls.
 * @returns {string}
 */
const defaultRunnablesFile = () => homeConfigPath('runnables.json');

/**
 * @typedef {object} Runnable
 * @property {string} id
 * @property {string} path Quota path id (commandcode, codex, cursor, local, clinepass, umans).
 * @property {string} harness Harness that launches the model.
 * @property {string|null} modelKey Normalized join key into ROI rows, or null.
 */

/**
 * @typedef {object} CostBasis
 * @property {'path-price'|'aa-price'|'roi'} source Which price the cost came from.
 * @property {{ cacheRead: number, cacheWrite: number, input: number, output: number }|null} mix
 *   Token shares the price was blended with; null for a `roi` cost, which is the
 *   pipeline's own blend and is carried through unchanged.
 * @property {'observed-path'|'observed-model'|'default'|null} mixSource
 * @property {number|null} mixTokens Tokens behind an observed mix, else null.
 * @property {boolean|null} peak true = peak prices, false = off-peak, null = no schedule.
 * @property {number|null} allowanceScale fee / monthlyLimit, or null for pay-per-token.
 */

/**
 * @typedef {object} CatalogEntry
 * @property {string} id
 * @property {string} path
 * @property {string} harness
 * @property {string|null} modelKey
 * @property {number|null} intelligence Real ROI score, AA estimate, or null.
 * @property {'roi'|'aa-estimate'|null} intelligenceSource Where `intelligence` came from.
 * @property {number|null} aaIndex Exact AA Intelligence Index for this runnable, when known.
 * @property {{ n: number, r: number, rmse: number, snapshotVersion: string|null, generatedAt: string|null }|null} calibration Fit behind an estimate.
 * @property {number|null} costPerMTok The path's own price, the ROI blended list price, or the AA list price.
 * @property {'path-price'|'roi'|'aa-price'|null} costSource Where `costPerMTok` came from.
 * @property {CostBasis|null} costBasis How a mix-derived cost was computed; null without a cost.
 * @property {string|null} costReason The routing sentence for a path price.
 * @property {string|null} priceExpired Rejection reason once the price entry's `until` has passed.
 * @property {boolean} dataSharing The path's price entry says the provider may retain prompts.
 * @property {string|null} tier
 * @property {number|null} speed
 * @property {boolean} scored True only for a real ROI score (never for an estimate).
 * @property {import('../lib/subscriptions.js').SubscriptionStatus|null} subscription null when no subscription list was supplied
 * @property {string} pathName Name of the active subscription funding the quota path, else the path id.
 */

/**
 * @param {string} [file]
 * @returns {Runnable[]}
 */
function loadRunnables(file = defaultRunnablesFile()) {
  const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (!raw || raw.schemaVersion !== SCHEMA_VERSION) {
    throw new Error(
      `runnables: unsupported schemaVersion ${raw && raw.schemaVersion} (expected ${SCHEMA_VERSION})`,
    );
  }
  if (!Array.isArray(raw.runnables)) throw new Error('runnables: "runnables" must be an array');

  const seen = new Set();
  return raw.runnables.map((entry, index) => {
    if (!entry || typeof entry.id !== 'string' || !entry.id) {
      throw new Error(`runnables[${index}]: missing id`);
    }
    if (typeof entry.path !== 'string' || !entry.path) {
      throw new Error(`runnables[${index}] (${entry.id}): missing path`);
    }
    if (seen.has(entry.id)) throw new Error(`runnables[${index}]: duplicate id ${entry.id}`);
    seen.add(entry.id);
    return {
      id: entry.id,
      path: entry.path,
      harness: typeof entry.harness === 'string' && entry.harness ? entry.harness : 'pi',
      modelKey: typeof entry.modelKey === 'string' && entry.modelKey ? entry.modelKey : null,
    };
  });
}

/**
 * Harness that launches a runnable model id, or null when the id is not a
 * runnable. An explicit model outside the catalog keeps the caller's default
 * harness; a runnable's declared harness is what decides how it is launched.
 *
 * @param {Runnable[]} runnables
 * @param {string|null|undefined} model
 * @returns {string|null}
 */
function harnessForModel(runnables, model) {
  if (typeof model !== 'string' || !model) return null;
  const runnable = runnables.find((entry) => entry.id === model);
  return runnable ? runnable.harness : null;
}

/**
 * @param {unknown} value
 * @returns {number|null}
 */
function finiteOrNull(value) {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

/**
 * Join runnables with ROI rows. The first row wins when two ROI rows fold to
 * the same modelKey (e.g. a base id and its -fast variant).
 *
 * An unscored runnable gets an estimate when `aaSnapshot` carries an exact AA
 * row for it AND `calibration` is a usable fit. "Exact" is the same rule the
 * calibration uses: a registry row's pinned `aaSlug` for that key wins,
 * else the AA slug must equal the runnable's model key (declared `modelKey`,
 * else the key of its id — a host prefix such as `mistral/` is irrelevant).
 * Folded matches are never used.
 *
 * @param {{
 *   runnables?: Runnable[],
 *   roiModels?: Array<Record<string, any>>,
 *   subscriptions?: Array<Record<string, any>>|null,
 *   now?: number,
 *   aaSnapshot?: { models?: Array<Record<string, any>> }|null,
 *   calibration?: import('./aa-estimate.js').Calibration|{ disabled: string }|null,
 *   registryRows?: Array<Record<string, any>>,
 *   costBlend?: { cache: number, input: number, output: number }|null,
 *   mixIndex?: ReturnType<typeof import('./token-mix.js').mixIndex>|null,
 * }} [input]
 *   `subscriptions` is roi.config.json `paths`; when supplied, every entry
 *   carries the funding subscription's status for its quota path, and a
 *   `prices` table on a funding entry prices the model from the path's own
 *   list. `mixIndex` is the observed token mix (src/core/token-mix.js); without
 *   it every mix falls back to the global `costBlend`.
 * @returns {CatalogEntry[]}
 */
function buildCatalog({
  runnables = [],
  roiModels = [],
  subscriptions = null,
  now = Date.now(),
  aaSnapshot = null,
  calibration = null,
  registryRows = [],
  costBlend = null,
  mixIndex = null,
} = {}) {
  /** @type {Map<string, Record<string, any>>} */
  const byKey = new Map();
  for (const row of roiModels) {
    if (!row || typeof row.model !== 'string') continue;
    const key = modelKey(row.model);
    if (!byKey.has(key)) byKey.set(key, row);
  }
  const aaIndex = aaSnapshot ? buildAaIndex(aaSnapshot) : null;
  /** @type {Map<string, string>} registry-pinned AA slugs by model key */
  const pinnedSlugs = new Map();
  for (const row of registryRows) {
    if (!row || typeof row.model !== 'string' || typeof row.aaSlug !== 'string' || !row.aaSlug.trim()) continue;
    const pinKey = modelKey(row.model);
    if (!pinnedSlugs.has(pinKey)) pinnedSlugs.set(pinKey, row.aaSlug.trim());
  }
  const usableCalibration = calibration && !calibration.disabled ? calibration : null;

  return runnables.map((runnable) => {
    const subscription = Array.isArray(subscriptions) ? subscriptionStatus(subscriptions, runnable.path, now) : null;
    // The display name belongs here, next to the subscription status it comes
    // from: routing and the shortlist only carry it through. `path` stays the
    // quota path id, because dispatch, quota and health are keyed by it.
    const pathName = Array.isArray(subscriptions)
      ? activeSubscriptionNames(subscriptions, runnable.path, now).join(' + ') || runnable.path
      : runnable.path;
    const row = runnable.modelKey ? byKey.get(runnable.modelKey) : undefined;
    const score = row ? finiteOrNull(row.genIntel) : null;
    // The AA lookup key is the declared modelKey, else the runnable id's own
    // key: `mistral/deepseek-v4-1-flash-1017` matches the AA slug of the model
    // it hosts, not the host's name.
    const key = runnable.modelKey ?? modelKey(runnable.id);
    const aaSlug = pinnedSlugs.get(key) ?? key;
    const aaRow = aaIndex ? aaRowFor(aaIndex, aaSlug) : null;
    const aa = aaIndexFor(aaIndex, aaSlug);
    const roiCost = row ? finiteOrNull(row.mtok) : null;
    // The mix is per (model, path): the same model on a subscription and on a
    // metered path is used differently. It prices the path's own list and the
    // AA list; the ROI pipeline's `mtok` is already a blend and stays as is.
    const tokenMix = mixFor(mixIndex, { modelKey: key, path: runnable.path, costBlend });
    const priced = pathPrice({
      subscriptions,
      quotaPath: runnable.path,
      modelKey: key,
      now,
      mix: tokenMix,
    });
    // Precedence: the subscription's own price list, then the registry/ROI
    // price, then an AA list price for a model the registry does not have. A
    // path price that cannot be computed (no token mix at all) falls through
    // rather than leaving the model unpriced.
    const pathCost = priced ? priced.costPerMTok : null;
    const costPerMTok = pathCost ?? roiCost;
    const costSource = pathCost !== null ? 'path-price' : roiCost === null ? null : 'roi';
    const costBasis = pathCost !== null
      ? {
        source: 'path-price',
        mix: tokenMix.mix,
        mixSource: tokenMix.mixSource,
        mixTokens: tokenMix.mixTokens,
        peak: priced ? priced.peak : null,
        allowanceScale: priced ? priced.allowanceScale : null,
      }
      : roiCost === null ? null : {
        source: 'roi',
        mix: null,
        mixSource: null,
        mixTokens: null,
        peak: null,
        allowanceScale: null,
      };

    const base = {
      id: runnable.id,
      path: runnable.path,
      pathName,
      harness: runnable.harness,
      modelKey: runnable.modelKey ?? null,
      aaIndex: aa,
      costPerMTok,
      costSource,
      costBasis,
      costReason: pathCost !== null && priced ? priced.reason : null,
      priceExpired: priced ? priced.expiredReason : null,
      dataSharing: priced ? priced.dataSharing : false,
      tier: row && typeof row.tierHobby === 'string' ? row.tierHobby : null,
      speed: row ? finiteOrNull(row.speed) : null,
      subscription,
    };

    if (score !== null) {
      return {
        ...base,
        intelligence: score,
        intelligenceSource: SCORE_SOURCE,
        calibration: null,
        scored: true,
      };
    }

    const estimateValue = usableCalibration ? estimate(usableCalibration, aa) : null;
    if (estimateValue === null) {
      return {
        ...base,
        intelligence: null,
        intelligenceSource: null,
        calibration: null,
        scored: false,
      };
    }
    // Only an estimated entry is priced from AA: an unscored model with no
    // estimate is unroutable, so pricing it would buy nothing. A path price or
    // a registry price always wins (base above); AA fills the gap, blended with
    // the observed token mix.
    const aaCost = costPerMTok === null && aaRow ? aaListCost(aaRow, tokenMix.mix) : null;
    return {
      ...base,
      intelligence: estimateValue,
      intelligenceSource: ESTIMATE_SOURCE,
      costPerMTok: aaCost ?? costPerMTok,
      costSource: aaCost === null ? costSource : 'aa-price',
      costBasis: aaCost === null ? costBasis : {
        source: 'aa-price',
        mix: tokenMix.mix,
        mixSource: tokenMix.mixSource,
        mixTokens: tokenMix.mixTokens,
        peak: null,
        allowanceScale: null,
      },
      calibration: {
        n: usableCalibration.n,
        r: usableCalibration.r,
        rmse: usableCalibration.rmse,
        snapshotVersion: usableCalibration.snapshotVersion ?? null,
        generatedAt: usableCalibration.generatedAt ?? null,
      },
      scored: false,
    };
  });
}

module.exports = {
  defaultRunnablesFile,
  SCHEMA_VERSION,
  loadRunnables,
  harnessForModel,
  buildCatalog,
};

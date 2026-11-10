'use strict';

/**
 * Auto-model policy: the one place an 'auto' selection becomes a concrete
 * model. Interfaces (CLI, menu, orchestrator, MCP) call this instead of
 * keeping their own candidate ladders; the ranking itself lives in
 * src/core/routing.js and the data in src/core/snapshot.js.
 *
 * Two rules are deliberate:
 *   - Explicit models pass through unchanged.
 *   - An 'auto' model with no eligible runnable throws instead of falling
 *     back. Silently running work on a saturated or unmeasured path is worse
 *     than refusing and showing why.
 */

const { recommend } = require('./snapshot.js');
const { TIER_FLOORS } = require('./routing.js');
const { attributePath } = require('../lib/path-attribution.js');

const TIERS = Object.keys(TIER_FLOORS);
const DEFAULT_TIER = 'medium';
const MAX_REJECTIONS = 3;

/**
 * @param {unknown} tier
 * @returns {string}
 */
function normalizeTier(tier) {
  if (tier === undefined || tier === null || tier === '') return DEFAULT_TIER;
  if (typeof tier !== 'string' || !Object.hasOwn(TIER_FLOORS, tier)) {
    throw new Error(`Unknown tier: ${tier} (expected ${TIERS.join('|')})`);
  }
  return tier;
}

/**
 * The tier a task was enqueued with, from `routing_policy` (`{ tier }`).
 *
 * The queue stores the requested tier there so every consumer agrees on it:
 * dispatch, the `model-chosen` event, `review_task` and the local claim paths
 * all resolve through this one helper. Unreadable, absent or unknown policy
 * contributes nothing.
 *
 * @param {{ routing_policy?: unknown }|null|undefined} task
 * @returns {string|null}
 */
function storedTier(task) {
  const raw = task?.routing_policy;
  if (typeof raw !== 'string' || !raw) return null;
  try {
    const parsed = JSON.parse(raw);
    return typeof parsed?.tier === 'string' && Object.hasOwn(TIER_FLOORS, parsed.tier) ? parsed.tier : null;
  } catch {
    return null;
  }
}

/**
 * Compact "id: reason" list for humans and error messages. The last reason is
 * the disqualifying one, because routing appends the failing check last.
 *
 * @param {Array<{ id: string, reasons?: string[] }>} [rejected]
 * @param {number} [limit]
 * @returns {string}
 */
function summarizeRejections(rejected = [], limit = MAX_REJECTIONS) {
  return rejected
    .slice(0, limit)
    .map((item) => `${item.id}: ${(item.reasons || []).at(-1) || 'not eligible'}`)
    .join(', ');
}

/**
 * @param {string} tier
 * @param {Array<{ id: string, reasons?: string[] }>} [rejected]
 * @returns {Error}
 */
function noModelError(tier, rejected = []) {
  const detail = summarizeRejections(rejected) || 'no runnable models configured';
  return new Error(`No model available for auto routing (tier ${tier}): ${detail}`);
}

/**
 * @param {string} model
 * @param {Record<string, any>|null|undefined} config
 * @returns {string|null}
 */
function providerFor(model, config) {
  if (!config) return null;
  const pathId = attributePath(config, model).pathId;
  return pathId || null;
}

/**
 * Resolve a stored job/task model to the model and quota path to run it on.
 *
 * @param {string} storedModel 'auto' or an explicit model id.
 * @param {{
 *   tier?: string,
 *   quotaPath?: string,
 *   roiOutputPath?: string,
 *   runnablesPath?: string,
 *   roiConfigPath?: string,
 *   threshold?: number,
 *   now?: number,
 *   config?: Record<string, any>|null,
 *   pathHealth?: Map<string, { state: 'healthy'|'degraded', consecutive: number, lastFailureAt: string|null, reason: string|null }>|null,
 *   trackRecords?: Map<string, Map<string, any>>|null,
 * }} [options]
 * @returns {{ model: string, provider: string|null, tier: string|null, explicit: boolean, default?: import('../core/routing.js').RankedChoice, decision?: ReturnType<typeof recommend> }}
 */
function resolveAutoModel(storedModel, options = {}) {
  if (storedModel !== 'auto') {
    return {
      model: storedModel,
      provider: providerFor(storedModel, options.config),
      tier: null,
      explicit: true,
    };
  }

  const tier = normalizeTier(options.tier);
  const decision = recommend({
    tier,
    quotaPath: options.quotaPath,
    roiOutputPath: options.roiOutputPath,
    runnablesPath: options.runnablesPath,
    roiConfigPath: options.roiConfigPath,
    threshold: options.threshold,
    now: options.now,
    pathHealth: options.pathHealth,
    trackRecords: options.trackRecords,
  });
  // "auto" is the one mode that must pick by itself, so it takes the routing
  // core's default rather than reasoning about the shortlist.
  if (!decision.default) throw noModelError(tier, decision.rejected);

  return {
    model: decision.default.id,
    provider: decision.default.path,
    tier,
    explicit: false,
    default: decision.default,
    decision,
  };
}

module.exports = {
  DEFAULT_TIER,
  MAX_REJECTIONS,
  TIERS,
  normalizeTier,
  summarizeRejections,
  noModelError,
  resolveAutoModel,
  storedTier,
};

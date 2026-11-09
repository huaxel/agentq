#!/usr/bin/env node
'use strict';

/**
 * Quota-aware model resolver: CLI over the routing core (src/core/snapshot.js).
 *
 * There is no candidate ladder here: the runnable universe comes from
 * config/runnables.json, intelligence/cost from the ROI export, and
 * availability from quota freshness. Unknown or stale quota is never treated
 * as available.
 *
 * Called by:
 *   - bin/resolve-model.sh and .agents/skills/agentq/scripts/*.sh
 *   - bin/update-workflow-tiers.sh, bin/update-subagent-models.sh
 *   - any tool that needs a quota-aware model for a tier
 *
 * Usage:
 *   node src/lib/quota-resolver.js --tier small|medium|big
 *   node src/lib/quota-resolver.js --tier small --fallback "mistral/deepseek-v4-1-flash-1017"
 *   node src/lib/quota-resolver.js --check "xai/grok-4.5"
 *   node src/lib/quota-resolver.js --all
 *
 * Output contract (relied on by the shell wrappers):
 *   plain mode prints the model id on stdout, or exits 1 with a stderr message
 *   when no runnable is eligible. --json prints the full decision object.
 */

const { getCatalog, getCapacity, recommend } = require('../core/snapshot.js');
const { rank } = require('../core/routing.js');
const { normalizeTier, noModelError, TIERS } = require('../core/auto-model.js');
const { degradedMarkers } = require('../core/routing.js');
const { attributePath } = require('./path-attribution.js');
const { loadConfig } = require('./model-picker.js');


/**
 * @param {{ quotaPath?: string, threshold?: number, now?: number, pathHealth?: Map<string, { state: string }>|null }} [opts]
 */
function snapshotOptions(opts = {}) {
  return { quotaPath: opts.quotaPath, threshold: opts.threshold, now: opts.now, pathHealth: opts.pathHealth };
}

/**
 * Resolve a tier through the routing core.
 *
 * Callers with DB access pass `pathHealth` (a src/core/path-health.js Map)
 * so a path that keeps failing for infrastructure reasons sorts last; the
 * lib itself never opens the queue (layering: lib may not require queue —
 * compose that in bin/ or interfaces).
 *
 * @param {string} tier
 * @param {{ quotaPath?: string, threshold?: number, now?: number, fallback?: string, pathHealth?: Map<string, { state: string }>|null }} [opts]
 * @returns {{ model: string, path: string, tier: string, headroom: number|null, source: string, choice?: any, rejected?: any[] }}
 * @throws {Error} when no runnable is eligible and no fallback is configured.
 */
function resolveTier(tier, opts = {}) {
  const resolvedTier = normalizeTier(tier);
  const decision = recommend({ ...snapshotOptions(opts), tier: resolvedTier });

  if (!decision.choice) {
    if (opts.fallback) {
      return {
        model: opts.fallback,
        path: 'fallback',
        tier: resolvedTier,
        headroom: null,
        source: 'fallback',
        rejected: decision.rejected,
      };
    }
    throw noModelError(resolvedTier, decision.rejected);
  }

  return {
    model: decision.choice.id,
    path: decision.choice.path,
    tier: resolvedTier,
    headroom: decision.choice.headroomPct,
    source: 'routing',
    choice: decision.choice,
    rejected: decision.rejected,
  };
}

/**
 * Report one model's capacity entry and whether routing would pick it.
 *
 * @param {string} model
 * @param {{ quotaPath?: string, threshold?: number, now?: number, tier?: string, configPath?: string, pathHealth?: Map<string, { state: string }>|null }} [opts]
 */
function checkModel(model, opts = {}) {
  const tier = normalizeTier(opts.tier);
  const options = snapshotOptions(opts);
  const catalog = getCatalog(options);
  const capacityList = getCapacity(options);
  const capacity = new Map(capacityList.map((candidate) => [candidate.path, candidate]));
  const entry = catalog.find((candidate) => candidate.id === model) || null;

  let pathId = entry ? entry.path : '';
  if (!entry) {
    // Not a runnable: still attribute a path so the report names where the
    // model would spend quota, but it can never be eligible.
    try {
      pathId = attributePath(loadConfig(opts.configPath), model).pathId;
    } catch {
      pathId = '';
    }
  }

  const capacityEntry = capacity.get(pathId) || {
    path: pathId,
    state: 'unknown',
    headroomPct: null,
    resetsAt: null,
    observedAt: null,
    stale: true,
    reason: pathId ? 'no quota data' : 'unknown path',
  };

  const decision = rank({ catalog: entry ? [entry] : [], capacity, tier, pathHealth: opts.pathHealth });
  const eligible = decision.choices.some((choice) => choice.id === model);
  const reasons = eligible
    ? decision.choices[0].reasons
    : (decision.rejected[0]?.reasons ?? ['not a runnable model']);

  return {
    model,
    path: pathId || 'unknown',
    tier,
    headroom: capacityEntry.state === 'available' ? true
      : capacityEntry.state === 'saturated' ? false : null,
    usedPercent: capacityEntry.headroomPct === null ? null : 100 - capacityEntry.headroomPct,
    resetsAt: capacityEntry.resetsAt,
    capacity: capacityEntry,
    eligible,
    reasons,
  };
}

/**
 * @param {{ quotaPath?: string, threshold?: number, now?: number, fallback?: string }} [opts]
 */
function listAll(opts = {}) {
  const results = {};
  for (const tier of TIERS) {
    try {
      results[tier] = resolveTier(tier, opts);
    } catch (error) {
      results[tier] = { model: null, path: null, tier, headroom: null, source: 'none', reasons: error.message };
    }
  }
  return results;
}

const USAGE = [
  'Usage: quota-resolver.js --tier <small|medium|big> | --check <model> | --all',
  'Options: --tier small|medium|big   resolve a tier through the routing core',
  '         --check <model>           report a model\'s capacity and eligibility',
  '         --all                     show every tier resolution',
  '         --fallback <model>        use this model when no runnable is eligible',
  '         --json                    machine-readable output',
  '         --quota <path>            quota file (default <home>/data/quota.json)',
  '         --threshold <pct>         headroom threshold (default 85)',
].join('\n');

// CLI entry point
if (require.main === module) {
  const args = process.argv.slice(2);
  const opts = {};

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--tier') opts.tier = args[++i];
    else if (args[i] === '--check') opts.check = args[++i];
    else if (args[i] === '--all') opts.all = true;
    else if (args[i] === '--fallback') opts.fallback = args[++i];
    else if (args[i] === '--quota') opts.quotaPath = args[++i];
    else if (args[i] === '--threshold') {
      opts.thresholdRaw = args[++i];
      opts.threshold = Number(opts.thresholdRaw);
    }
    else if (args[i] === '--json') opts.json = true;
    else if (args[i] === '--help' || args[i] === '-h') opts.help = true;
  }

  if (opts.help) {
    console.log(USAGE);
    process.exit(0);
  }

  // A NaN or out-of-range threshold silently saturates (or frees) every path,
  // so reject it as a usage error instead of routing on it.
  if (opts.threshold !== undefined) {
    if (!Number.isFinite(opts.threshold) || opts.threshold <= 0 || opts.threshold > 100) {
      console.error(`--threshold must be a number greater than 0 and at most 100, got: ${opts.thresholdRaw ?? 'nothing'}`);
      console.error(USAGE);
      process.exit(1);
    }
  }

  let result;
  try {
    if (opts.check) result = checkModel(opts.check, opts);
    else if (opts.all) result = listAll(opts);
    else if (opts.tier) result = resolveTier(opts.tier, opts);
    else {
      console.error(USAGE);
      process.exit(1);
    }
  } catch (error) {
    console.error(error.message);
    process.exit(1);
  }

  // A degraded pick stays eligible but is worth a marker: a wrong "no model"
  // is worse than a slow one, so this is a note, not a refusal.
  const [degraded] = result && result.choice ? degradedMarkers([result.choice]) : [];
  if (degraded) {
    process.stderr.write(`degraded: ${degraded.path} (${degraded.reason})\n`);
  }

  if (opts.json) {
    console.log(JSON.stringify(result, null, 2));
  } else if (result && result.model) {
    console.log(result.model);
  } else if (result) {
    // --all and --check reports have no single model id to print.
    console.log(JSON.stringify(result, null, 2));
  } else {
    console.error('No model available for auto routing');
    process.exit(1);
  }
}

module.exports = { resolveTier, checkModel, listAll };

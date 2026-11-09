'use strict';

/**
 * Snapshot: the one adapter interfaces (MCP, CLI, HTTP) call.
 *
 * It owns path resolution and file layout so no interface re-implements them,
 * and it never throws on *missing* data: an absent quota or ROI file degrades
 * to unknown capacity / unscored catalog, which routing then reports as
 * explicit rejections. Malformed JSON is a different case — an unreadable
 * snapshot is a real mistake, so it is surfaced as an error (same convention
 * as lib/quota-resolver.js).
 *
 * The Artificial Analysis snapshot is the one exception: it is optional
 * enrichment for estimates only, so a missing OR malformed file simply
 * disables estimates (never throws). Nothing routing decides depends on it
 * alone.
 */

const fs = require('node:fs');
const path = require('node:path');

const { buildCatalog, loadRunnables } = require('./catalog.js');
const { capacityFor, readCapacity } = require('./capacity.js');
const { buildCalibration } = require('./aa-estimate.js');
const { recommend: rankAndRecommend } = require('./routing.js');
const { agentqHome, loadRoiConfig } = require('../lib/home.js');
const { coverageProblems } = require('../lib/path-coverage.js');

/**
 * @typedef {object} SnapshotOptions
 * @property {string} [home] agentq home; defaults to AGENTQ_HOME (src/lib/home.js).
 * @property {string} [quotaPath] Overrides AGENTQ_QUOTA and the home default.
 * @property {string} [roiOutputPath] Overrides AGENTQ_ROI_OUTPUT and the home default.
 * @property {string} [runnablesPath]
 * @property {string} [roiConfigPath] Overrides AGENTQ_ROI_CONFIG and the merged home config (subscription dates).
 * @property {string} [aaSnapshotPath] Overrides AGENTQ_AA_SNAPSHOT and the <home>/data/aa-snapshot*.json default.
 * @property {string} [registryPath] Benchmark registry used to pin AA slugs (calibration only).
 * @property {number} [threshold] Capacity headroom threshold (default 85).
 * @property {number} [now] Inject the clock (tests, replays).
 */

/**
 * @typedef {object} RecommendArgs
 * @property {string} [tier]
 * @property {number} [threshold]
 * @property {number} [minIntelligence]
 * @property {boolean} [allowUnknownCapacity]
 * @property {boolean} [allowUnscored]
 * @property {Map<string, { state: 'healthy'|'degraded', consecutive: number, lastFailureAt: string|null, reason: string|null }>} [pathHealth]
 *   Per-path infrastructure-failure verdicts (src/core/path-health.js).
 *   Degraded choices sort after every healthy choice but stay eligible.
 */

/**
 * Every runtime path comes from the agentq home, never from the checkout. An
 * explicit option wins over the file's environment variable, which wins over
 * the home default.
 *
 * `roiConfigPath` stays null when neither an option nor AGENTQ_ROI_CONFIG is
 * set: the effective config is then the method defaults merged with
 * `<home>/config/roi.config.json`, which is what getCatalog reads.
 *
 * @param {SnapshotOptions} [opts]
 * @returns {{ home: string, quotaPath: string, roiOutputPath: string, runnablesPath: string, roiConfigPath: string|null, aaSnapshotPath: string, registryPath: string, now: number|undefined }}
 */
function resolvePaths(opts = {}) {
  const home = opts.home ? path.resolve(opts.home) : agentqHome();
  return {
    home,
    quotaPath: opts.quotaPath ?? process.env.AGENTQ_QUOTA ?? path.join(home, 'data', 'quota.json'),
    roiOutputPath: opts.roiOutputPath ?? process.env.AGENTQ_ROI_OUTPUT ?? path.join(home, 'data', 'roi-output.json'),
    runnablesPath: opts.runnablesPath ?? path.join(home, 'config', 'runnables.json'),
    roiConfigPath: opts.roiConfigPath ?? process.env.AGENTQ_ROI_CONFIG ?? null,
    aaSnapshotPath: opts.aaSnapshotPath ?? process.env.AGENTQ_AA_SNAPSHOT ?? defaultAaSnapshotPath(home),
    registryPath: opts.registryPath ?? process.env.AGENTQ_BENCHMARK_INPUTS ?? path.join(home, 'data', 'benchmark-inputs.json'),
    now: opts.now,
  };
}

/**
 * The Pro snapshot wins when it exists: it is a superset of the Free body for
 * the fields used here, and `aa-sync` writes both tiers separately. A missing
 * Pro file falls back to the Free one.
 *
 * @param {string} home
 * @returns {string}
 */
function defaultAaSnapshotPath(home) {
  const pro = path.join(home, 'data', 'aa-snapshot-pro.json');
  return fs.existsSync(pro) ? pro : path.join(home, 'data', 'aa-snapshot.json');
}

/**
 * @param {string} file
 * @param {string} label
 * @returns {any|null} null when the file does not exist.
 */
function readJsonIfExists(file, label, { optional = false } = {}) {
  if (!fs.existsSync(file)) return null;
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (error) {
    // `optional` data only enriches the catalog; a corrupt copy must not take
    // the whole snapshot down with it.
    if (optional) return null;
    throw new Error(`snapshot: cannot read ${label} at ${file}: ${error instanceof Error ? error.message : error}`);
  }
}

/**
 * Runnable universe joined with ROI scores. A missing ROI export leaves every
 * entry unscored rather than failing the call.
 *
 * @param {SnapshotOptions} [opts]
 * @returns {import('./catalog.js').CatalogEntry[]}
 */
function getCatalog(opts = {}) {
  const { home, roiOutputPath, runnablesPath, roiConfigPath, aaSnapshotPath, registryPath, now } = resolvePaths(opts);
  const runnables = loadRunnables(runnablesPath);
  const roi = readJsonIfExists(roiOutputPath, 'ROI output');
  const roiModels = roi && Array.isArray(roi.models) ? roi.models : [];
  // A missing roi.config leaves every path unconfigured (rejected), never
  // unchecked: subscriptions are what make a runnable routable at all. With no
  // explicit path the effective config is the method defaults merged with the
  // user's setup, so the AA price blend comes from the same place.
  const roiConfig = roiConfigPath ? readJsonIfExists(roiConfigPath, 'ROI config') : loadRoiConfig({ home });
  const subscriptions = roiConfig && Array.isArray(roiConfig.paths) ? roiConfig.paths : [];
  // The AA price blend is the ROI pipeline's own costBlend, read from the same
  // config the pipeline uses, so an estimated model is priced identically.
  const costBlend = roiConfig && roiConfig.costBlend && typeof roiConfig.costBlend === 'object'
    ? roiConfig.costBlend : null;
  const { aaSnapshot, calibration, registryRows } = loadAaEstimates({ roiModels, aaSnapshotPath, registryPath });
  return buildCatalog({
    runnables, roiModels, subscriptions, now: now ?? Date.now(), aaSnapshot, calibration, registryRows, costBlend,
  });
}

/**
 * Read the optional AA snapshot and fit the estimate calibration.
 *
 * Never throws: a missing or malformed snapshot, or a missing registry, only
 * disables estimates. The registry is used solely to pin an AA slug for a
 * model whose slug differs from its key; without it, calibration falls back to
 * exact key matching.
 *
 * @param {{ roiModels: Array<Record<string, any>>, aaSnapshotPath: string, registryPath: string }} input
 * @returns {{ aaSnapshot: { models?: Array<Record<string, any>> }|null, calibration: (import('./aa-estimate.js').Calibration & { pairs: number, skipped: any[] })|{ disabled: string }|null, registryRows: Array<Record<string, any>> }}
 */
function loadAaEstimates({ roiModels, aaSnapshotPath, registryPath }) {
  const aaSnapshot = readJsonIfExists(aaSnapshotPath, 'AA snapshot', { optional: true });
  if (!aaSnapshot || !Array.isArray(aaSnapshot.models)) return { aaSnapshot: null, calibration: null, registryRows: [] };
  const registry = readJsonIfExists(registryPath, 'benchmark registry', { optional: true });
  const registryRows = registry && Array.isArray(registry.models) ? registry.models : [];
  return { aaSnapshot, calibration: buildCalibration({ roiModels, registryRows, snapshot: aaSnapshot }), registryRows };
}

/**
 * Capacity keyed by path, including an explicit unknown entry for every
 * runnable path the snapshot does not mention.
 *
 * @param {SnapshotOptions} [opts]
 * @returns {Map<string, import('./capacity.js').CapacityEntry>}
 */
function loadCapacity(opts = {}) {
  const { quotaPath, runnablesPath, now } = resolvePaths(opts);
  const quota = readJsonIfExists(quotaPath, 'quota snapshot');
  const capacity = readCapacity(quota, { now, threshold: opts.threshold });
  for (const runnable of loadRunnables(runnablesPath)) {
    if (!capacity.has(runnable.path)) capacity.set(runnable.path, capacityFor(capacity, runnable.path));
  }
  return capacity;
}

/**
 * Capacity as an array, so callers see gaps instead of guessing whether a
 * path was omitted or simply has no data.
 *
 * @param {SnapshotOptions} [opts]
 * @returns {import('./capacity.js').CapacityEntry[]}
 */
function getCapacity(opts = {}) {
  return [...loadCapacity(opts).values()];
}

/**
 * Rank the catalog against current capacity. Builds both inputs itself, so an
 * interface only supplies routing policy.
 *
 * @param {SnapshotOptions & RecommendArgs} [args]
 * @returns {{ choice: import('./routing.js').RankedChoice|null, choices: import('./routing.js').RankedChoice[], rejected: import('./routing.js').RankedChoice[], policy: { floor: number, order: string[] } }}
 */
function recommend(args = {}) {
  return rankAndRecommend({
    catalog: getCatalog(args),
    capacity: loadCapacity(args),
    tier: args.tier,
    minIntelligence: args.minIntelligence,
    allowUnknownCapacity: args.allowUnknownCapacity,
    allowUnscored: args.allowUnscored,
    pathHealth: args.pathHealth,
  });
}

/**
 * Runnables whose configured path does not cover their model, as
 * `runnable <id>: path <path> does not cover <modelKey>` strings.
 *
 * Coverage is declared by `config.paths[].models` (src/lib/path-coverage.js).
 * Routing would offer a model the subscription does not serve, so the CLI warns
 * on it; `npm run verify` fails on it. Core stays silent: the reporting is the
 * interface's job, and a warning here would fire for every caller.
 *
 * @param {SnapshotOptions} [opts]
 * @returns {string[]} problems (empty when every runnable is covered)
 */
function coverageIssues(opts = {}) {
  const { home, runnablesPath, roiConfigPath } = resolvePaths(opts);
  const runnables = loadRunnables(runnablesPath);
  const roiConfig = roiConfigPath ? readJsonIfExists(roiConfigPath, 'ROI config') : loadRoiConfig({ home });
  if (!roiConfig) return [];
  return coverageProblems(roiConfig, { runnables });
}

module.exports = {
  resolvePaths, defaultAaSnapshotPath, loadAaEstimates, getCatalog, getCapacity, recommend, coverageIssues,
};

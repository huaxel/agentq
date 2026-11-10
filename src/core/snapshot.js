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
const { pathGaps } = require('./path-gaps.js');
const { recommend: rankAndRecommend } = require('./routing.js');
const { trackRecordPolicy } = require('./track-record.js');
const { mixIndex, parseCsv } = require('./token-mix.js');
const { agentqHome, loadRoiConfig } = require('../lib/home.js');
const { coverageProblems } = require('../lib/path-coverage.js');
const { quotaPathId } = require('../lib/subscriptions.js');

/**
 * @typedef {object} SnapshotOptions
 * @property {string} [home] agentq home; defaults to AGENTQ_HOME (src/lib/home.js).
 * @property {string} [quotaPath] Overrides AGENTQ_QUOTA and the home default.
 * @property {string} [roiOutputPath] Overrides AGENTQ_ROI_OUTPUT and the home default.
 * @property {string} [runnablesPath]
 * @property {string} [roiConfigPath] Overrides AGENTQ_ROI_CONFIG and the merged home config (subscription dates).
 * @property {string} [aaSnapshotPath] Overrides AGENTQ_AA_SNAPSHOT and the <home>/data/aa-snapshot*.json default.
 * @property {string} [registryPath] Benchmark registry used to pin AA slugs (calibration only).
 * @property {string} [mixPath] Overrides AGENTQ_MIX_CSV and <home>/data/ccagg-by-model-path.csv.
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
 * @property {boolean} [excludeDataSharing] Reject choices whose path price entry says the
 *   provider may retain prompts (private work).
 * @property {Map<string, { state: 'healthy'|'degraded', consecutive: number, lastFailureAt: string|null, reason: string|null }>} [pathHealth]
 *   Per-path infrastructure-failure verdicts (src/core/path-health.js).
 *   Degraded choices sort after every healthy choice but stay eligible.
 * @property {Map<string, Map<string, any>>|null} [trackRecords]
 *   Outcome-review records keyed by model key, then tier
 *   (src/core/track-record.js). Supplied by the interface, exactly like
 *   `pathHealth`: src/queue/track-records.js reads the queue and a missing
 *   database or table yields no records rather than an error.
 * @property {{ minReviews?: number, minLowerBound?: number }} [trackRecordPolicy]
 *   Thresholds that let a record unlock an unscored model. Defaults to the
 *   `trackRecord` key of the effective ROI config.
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
 * @returns {{ home: string, quotaPath: string, roiOutputPath: string, runnablesPath: string, roiConfigPath: string|null, aaSnapshotPath: string, registryPath: string, mixPath: string, now: number|undefined }}
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
    mixPath: opts.mixPath ?? process.env.AGENTQ_MIX_CSV ?? path.join(home, 'data', 'ccagg-by-model-path.csv'),
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
 * Observed per-(model, path) token totals, or an empty index.
 *
 * The mix only refines a price, so a missing or unreadable file is not an
 * error: `mixFor` then falls back to the model-wide rows, then to the global
 * `costBlend`. Parsing never throws, and a file that yields no usable rows is
 * the same as no file.
 *
 * @param {string} file
 * @returns {ReturnType<typeof mixIndex>}
 */
function loadMixIndex(file) {
  if (!fs.existsSync(file)) return mixIndex([]);
  try {
    return mixIndex(parseCsv(fs.readFileSync(file, 'utf8')));
  } catch {
    return mixIndex([]);
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
  const { home, roiOutputPath, runnablesPath, roiConfigPath, aaSnapshotPath, registryPath, mixPath, now } = resolvePaths(opts);
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
    runnables,
    roiModels,
    subscriptions,
    now: now ?? Date.now(),
    aaSnapshot,
    calibration,
    registryRows,
    costBlend,
    mixIndex: loadMixIndex(mixPath),
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
 * Per-path window-combine mode from `config.paths[].quotaWindows`.
 *
 * The keys are the ids `data/quota.json` is keyed by. The collector writes
 * `paths[config.providerPathMap[provider]]`, and a config path entry funds that
 * id through `sourcePath` when it declares one, its `id` otherwise — the shared
 * funding rule (src/lib/subscriptions.js `quotaPathId`). So the key is
 * `sourcePath ?? id`, not always `id`.
 *
 * Only entries that declare the key are listed; absent means `all`, which is
 * also what every path gets when the config cannot be read. That keeps an alias
 * entry (same quota path, no `quotaWindows`) from resetting an explicit `"any"`
 * declared by the entry that funds the same quota path.
 *
 * @param {string|null} roiConfigPath
 * @param {string} home
 * @returns {Map<string, 'all'|'any'>}
 */
function quotaWindowCombine(roiConfigPath, home) {
  /** @type {Map<string, 'all'|'any'>} */
  const combine = new Map();
  let roiConfig;
  try {
    roiConfig = roiConfigPath ? readJsonIfExists(roiConfigPath, 'ROI config') : loadRoiConfig({ home });
  } catch {
    // Capacity must still be readable without a setup: `all` is the safe default.
    return combine;
  }
  const paths = roiConfig && Array.isArray(roiConfig.paths) ? roiConfig.paths : [];
  for (const pathEntry of paths) {
    if (!pathEntry || typeof pathEntry.id !== 'string') continue;
    const mode = pathEntry.quotaWindows;
    if (mode !== 'all' && mode !== 'any') continue;
    const pathId = quotaPathId(pathEntry);
    if (pathId !== null && !combine.has(pathId)) combine.set(pathId, mode);
  }
  return combine;
}

/**
 * Capacity keyed by path, including an explicit unknown entry for every
 * runnable path the snapshot does not mention.
 *
 * @param {SnapshotOptions} [opts]
 * @returns {Map<string, import('./capacity.js').CapacityEntry>}
 */
function loadCapacity(opts = {}) {
  const { home, quotaPath, runnablesPath, roiConfigPath, now } = resolvePaths(opts);
  const quota = readJsonIfExists(quotaPath, 'quota snapshot');
  const capacity = readCapacity(quota, {
    now,
    threshold: opts.threshold,
    windowCombine: quotaWindowCombine(roiConfigPath, home),
  });
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
 * @returns {{ options: ReturnType<typeof import('./shortlist.js').shortlist>, default: import('./routing.js').RankedChoice|null, choices: import('./routing.js').RankedChoice[], rejected: import('./routing.js').RankedChoice[], policy: { floor: number, order: string[] } }}
 */
function recommend(args = {}) {
  return rankAndRecommend({
    catalog: getCatalog(args),
    capacity: loadCapacity(args),
    tier: args.tier,
    minIntelligence: args.minIntelligence,
    allowUnknownCapacity: args.allowUnknownCapacity,
    allowUnscored: args.allowUnscored,
    excludeDataSharing: args.excludeDataSharing,
    pathHealth: args.pathHealth,
    trackRecords: args.trackRecords,
    trackRecordPolicy: args.trackRecordPolicy ?? trackRecordPolicy(loadRoiConfigFor(args)),
  });
}

/**
 * The effective ROI config, for the routing policy it carries. A missing setup
 * is not an error here: the method defaults alone are a valid config, and the
 * policy falls back to its constants.
 *
 * @param {SnapshotOptions} [opts]
 * @returns {Record<string, any>|null}
 */
function loadRoiConfigFor(opts = {}) {
  const { home, roiConfigPath } = resolvePaths(opts);
  return roiConfigPath ? readJsonIfExists(roiConfigPath, 'ROI config') : loadRoiConfig({ home });
}

/**
 * The thresholds that let a track record unlock an unscored model, read from
 * the effective config's `trackRecord` key (defaults in config/defaults/roi.json).
 *
 * @param {SnapshotOptions} [opts]
 * @returns {{ minReviews: number, minLowerBound: number }}
 */
function getTrackRecordPolicy(opts = {}) {
  return trackRecordPolicy(loadRoiConfigFor(opts));
}

/**
 * Price-table gaps per quota path: priced models with no runnable there, and
 * runnables with no price entry (src/core/path-gaps.js).
 *
 * Read-only and advisory: it reports what the setup and the price table
 * disagree about, and changes neither.
 *
 * @param {SnapshotOptions} [opts]
 * @returns {{ paths: import('./path-gaps.js').GapPath[] }}
 */
function getPathGaps(opts = {}) {
  const { home, runnablesPath, roiConfigPath, mixPath, now } = resolvePaths(opts);
  const roiConfig = roiConfigPath ? readJsonIfExists(roiConfigPath, 'ROI config') : loadRoiConfig({ home });
  const subscriptions = roiConfig && Array.isArray(roiConfig.paths) ? roiConfig.paths : [];
  const costBlend = roiConfig && roiConfig.costBlend && typeof roiConfig.costBlend === 'object'
    ? roiConfig.costBlend : null;
  return pathGaps({
    subscriptions,
    runnables: loadRunnables(runnablesPath),
    mixIndex: loadMixIndex(mixPath),
    costBlend,
    now: now ?? Date.now(),
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
  resolvePaths,
  defaultAaSnapshotPath,
  loadAaEstimates,
  loadMixIndex,
  getCatalog,
  getCapacity,
  getPathGaps,
  getTrackRecordPolicy,
  recommend,
  coverageIssues,
};

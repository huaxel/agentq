'use strict';

/**
 * Routing fixtures: runnables + ROI scores + quota freshness in a temp
 * AGENTQ_HOME, so no test depends on the real home or the checkout.
 *
 * The temp dir uses the home layout (`config/`, `data/`), so a spawned CLI
 * pointed at it with AGENTQ_HOME resolves exactly these two scored entries and
 * rejects every other runnable as unscored.
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// Real clock: spawned CLIs cannot be handed an injected 'now', so fixture
// observations must be fresh relative to the actual time the test runs.
const NOW = Date.now();
const FRESH = new Date(NOW - 60_000).toISOString();
const FUTURE = new Date(NOW + 3600_000).toISOString();

const CHEAP_MODEL = 'mistral/deepseek-v4-1-flash-1017';
const STRONG_MODEL = 'openai-codex/gpt-5.6-luna';

/** A runnable with no ROI row: always rejected as unscored, never as free. */
const UNSCORED_MODEL = 'openai-codex/gpt-5.6-sol';

const RUNNABLES = {
  schemaVersion: 1,
  runnables: [
    { id: CHEAP_MODEL, path: 'mistral', modelKey: 'deepseek-v4-1-flash', harness: 'pi' },
    { id: STRONG_MODEL, path: 'codex', modelKey: 'gpt-5-6-luna', harness: 'pi' },
    { id: UNSCORED_MODEL, path: 'codex', modelKey: 'gpt-5-6-sol', harness: 'pi' },
  ],
};

const ROI = {
  generatedAt: FRESH,
  models: [
    { model: 'deepseek-v4-1-flash', genIntel: 40, mtok: 0.1, tierHobby: 'Budget', speed: 70 },
    { model: 'gpt-5-6-luna', genIntel: 60, mtok: 2, tierHobby: 'Workhorse', speed: 60 },
  ],
};

// Subscriptions funding the two fixture paths, both active since 2026. `models`
// is the path's coverage: every runnable above must sit on a path that
// declares its modelKey, or `npm run verify` fails.
const ROI_CONFIG = {
  paths: [
    { id: 'mistral', type: 'Wallet', fee: 8.4, startDate: '20260101', models: ['deepseek-v4-1-flash'] },
    { id: 'codex', type: 'Wallet', fee: 100, startDate: '20260101', models: ['gpt-5-6-luna', 'gpt-5-6-sol'] },
  ],
};

/**
 * @param {{ mistral?: number|null, codex?: number|null }} [used]
 */
function quotaFixture({ mistral = 10, codex = 10 } = {}) {
  const paths = {};
  if (mistral !== null) {
    paths.mistral = { updatedAt: FRESH, windows: [{ label: 'month', usedPercent: mistral, resetsAt: FUTURE }] };
  }
  if (codex !== null) {
    paths.codex = { updatedAt: FRESH, windows: [{ label: 'weekly', usedPercent: codex, resetsAt: FUTURE }] };
  }
  return { generatedAt: FRESH, paths };
}

/**
 * @param {{ root?: string, quota?: ReturnType<typeof quotaFixture>, roi?: unknown }} [options]
 */
function writeRoutingFixture(options = {}) {
  const root = options.root || fs.mkdtempSync(path.join(os.tmpdir(), 'agentq-routing-'));
  fs.mkdirSync(path.join(root, 'config'), { recursive: true });
  fs.mkdirSync(path.join(root, 'data'), { recursive: true });
  const runnablesPath = path.join(root, 'config', 'runnables.json');
  const roiOutputPath = path.join(root, 'data', 'roi-output.json');
  const quotaPath = path.join(root, 'data', 'quota.json');
  const roiConfigPath = path.join(root, 'config', 'roi.config.json');
  fs.writeFileSync(runnablesPath, JSON.stringify(RUNNABLES));
  fs.writeFileSync(roiConfigPath, JSON.stringify(ROI_CONFIG));
  fs.writeFileSync(roiOutputPath, JSON.stringify(options.roi ?? ROI));
  fs.writeFileSync(quotaPath, JSON.stringify(options.quota ?? quotaFixture()));

  return {
    root,
    home: root,
    runnablesPath,
    roiOutputPath,
    quotaPath,
    roiConfigPath,
    now: NOW,
    /** Rewrite the quota snapshot in place. */
    writeQuota(quota) {
      fs.writeFileSync(quotaPath, JSON.stringify(quota));
    },
    /** Env overrides for a spawned CLI: the fixture dir is its home. */
    env(extra = {}) {
      return { AGENTQ_HOME: root, AGENTQ_QUOTA: quotaPath, AGENTQ_ROI_OUTPUT: roiOutputPath, AGENTQ_ROI_CONFIG: roiConfigPath, ...extra };
    },
  };
}

module.exports = {
  CHEAP_MODEL,
  STRONG_MODEL,
  UNSCORED_MODEL,
  NOW,
  FRESH,
  FUTURE,
  RUNNABLES,
  ROI,
  ROI_CONFIG,
  quotaFixture,
  writeRoutingFixture,
};

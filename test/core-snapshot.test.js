'use strict';
/**
 * Snapshot adapter tests: path resolution, env overrides, and the rule that
 * missing data degrades to unknown/unscored instead of throwing.
 */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const {
  defaultAaSnapshotPath,
  getCatalog,
  getCapacity,
  recommend,
  resolvePaths,
} = require('../src/core/snapshot.js');

const NOW = Date.parse('2026-11-08T12:00:00Z');
const FRESH = new Date(NOW - 60_000).toISOString();
const FUTURE = new Date(NOW + 3600_000).toISOString();

const RUNNABLES = {
  schemaVersion: 1,
  runnables: [
    { id: 'a-model', path: 'codex', modelKey: 'model-a', harness: 'pi' },
    { id: 'b-model', path: 'local', modelKey: 'model-b', harness: 'pi' },
    { id: 'c-model', path: 'cursor', modelKey: null, harness: 'pi' },
  ],
};

const ROI = {
  generatedAt: FRESH,
  models: [
    { model: 'provider/model-a', genIntel: 50, mtok: 1, tierHobby: 'Workhorse', speed: 80 },
    { model: 'provider/model-b', genIntel: 20, mtok: 0.1, tierHobby: 'Budget', speed: 40 },
  ],
};

const QUOTA = {
  generatedAt: FRESH,
  paths: {
    codex: { updatedAt: FRESH, windows: [{ label: 'weekly', usedPercent: 10, resetsAt: FUTURE }] },
  },
};

const ROI_CONFIG = {
  paths: [
    { id: 'codex', type: 'Wallet', fee: 20, startDate: '20260101' },
    { id: 'local', type: 'Local', fee: 0 },
    { id: 'cursor', type: 'Wallet', fee: 20, startDate: '20260101' },
  ],
};

/**
 * @param {{ quota?: unknown, roi?: unknown, runnables?: unknown, roiConfig?: unknown }} [files]
 */
function fixtureRoot(files = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agentq-snapshot-'));
  fs.mkdirSync(path.join(root, 'config'), { recursive: true });
  fs.mkdirSync(path.join(root, 'data'), { recursive: true });
  fs.writeFileSync(path.join(root, 'config', 'runnables.json'), JSON.stringify(files.runnables ?? RUNNABLES));
  if (files.roiConfig !== null) {
    fs.writeFileSync(path.join(root, 'config', 'roi.config.json'), JSON.stringify(files.roiConfig ?? ROI_CONFIG));
  }
  if (files.roi !== undefined) fs.writeFileSync(path.join(root, 'data', 'roi-output.json'), JSON.stringify(files.roi));
  if (files.quota !== undefined) fs.writeFileSync(path.join(root, 'data', 'quota.json'), JSON.stringify(files.quota));
  return root;
}

function withEnv(vars, fn) {
  const saved = {};
  for (const [key, value] of Object.entries(vars)) {
    saved[key] = process.env[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  try {
    return fn();
  } finally {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

test('paths default to the agentq home and honour explicit options', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'agentq-home-'));
  withEnv({ AGENTQ_HOME: home, XDG_CONFIG_HOME: undefined }, () => {
    const defaults = resolvePaths();
    assert.equal(defaults.home, home);
    assert.equal(defaults.quotaPath, path.join(home, 'data', 'quota.json'));
    assert.equal(defaults.roiOutputPath, path.join(home, 'data', 'roi-output.json'));
    assert.equal(defaults.runnablesPath, path.join(home, 'config', 'runnables.json'));
    assert.equal(defaults.roiConfigPath, null, 'no explicit config means the merged home config');
  });

  const explicit = resolvePaths({ home: '/tmp/example', quotaPath: '/q.json', roiOutputPath: '/r.json', now: NOW });
  assert.equal(explicit.quotaPath, '/q.json');
  assert.equal(explicit.roiOutputPath, '/r.json');
  assert.equal(explicit.runnablesPath, path.join('/tmp/example', 'config', 'runnables.json'));
  assert.equal(explicit.now, NOW);
});

test('env variables override the data paths but not explicit options', () => {
  withEnv({ AGENTQ_QUOTA: '/env/quota.json', AGENTQ_ROI_OUTPUT: '/env/roi-output.json' }, () => {
    const fromEnv = resolvePaths({ home: '/tmp/example' });
    assert.equal(fromEnv.quotaPath, '/env/quota.json');
    assert.equal(fromEnv.roiOutputPath, '/env/roi-output.json');
    assert.equal(fromEnv.runnablesPath, path.join('/tmp/example', 'config', 'runnables.json'));

    const explicit = resolvePaths({ quotaPath: '/explicit/quota.json' });
    assert.equal(explicit.quotaPath, '/explicit/quota.json');
  });
});

test('getCatalog joins runnables with ROI rows and marks unmatched entries unscored', () => {
  const root = fixtureRoot({ roi: ROI, quota: QUOTA });
  const catalog = getCatalog({ home: root });
  assert.deepEqual(
    catalog.map((entry) => [entry.id, entry.intelligence, entry.scored]),
    [
      ['a-model', 50, true],
      ['b-model', 20, true],
      ['c-model', null, false],
    ],
  );
});

test('getCatalog without an ROI export returns every entry unscored instead of throwing', () => {
  const root = fixtureRoot({ quota: QUOTA });
  const catalog = getCatalog({ home: root });
  assert.equal(catalog.length, 3);
  assert.equal(catalog.every((entry) => entry.scored === false), true);
});

test('getCatalog surfaces a malformed ROI export as an error', () => {
  const root = fixtureRoot({ quota: QUOTA });
  fs.writeFileSync(path.join(root, 'data', 'roi-output.json'), '{ not json');
  assert.throws(() => getCatalog({ home: root }), /cannot read ROI output/);
});

test('getCapacity returns an array and fills unknown entries for runnable paths without data', () => {
  const root = fixtureRoot({ roi: ROI, quota: QUOTA });
  const capacity = getCapacity({ home: root, now: NOW });
  assert.equal(Array.isArray(capacity), true);
  const byPath = new Map(capacity.map((entry) => [entry.path, entry]));
  assert.equal(byPath.get('codex').state, 'available');
  assert.equal(byPath.get('codex').headroomPct, 90);
  assert.equal(byPath.get('local').state, 'unknown');
  assert.equal(byPath.get('local').reason, 'no quota data');
  assert.equal(byPath.get('cursor').state, 'unknown');
});

test('getCapacity without a quota snapshot reports every runnable path unknown', () => {
  const root = fixtureRoot({ roi: ROI });
  const capacity = getCapacity({ home: root, now: NOW });
  assert.deepEqual(capacity.map((entry) => entry.path).sort(), ['codex', 'cursor', 'local']);
  assert.equal(capacity.every((entry) => entry.state === 'unknown'), true);
});

/* ───── quotaWindows plumbing ───── */

const TESTDATA_HOME = path.join(__dirname, '..', 'testdata', 'home');

/** A copy of the synthetic fixture home, so a test can edit its config. */
function copyTestdataHome() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agentq-windows-home-'));
  fs.cpSync(TESTDATA_HOME, root, { recursive: true });
  return root;
}

/** Two windows on `go`: a roomy 5-hour one and a nearly spent weekly one. */
const TWO_WINDOW_QUOTA = {
  generatedAt: FRESH,
  paths: {
    go: {
      updatedAt: FRESH,
      windows: [
        { label: '5h', usedPercent: 10, resetsAt: FUTURE },
        { label: 'weekly', usedPercent: 95, resetsAt: FUTURE },
      ],
    },
  },
};

function setGoQuotaWindows(root, quotaWindows) {
  const file = path.join(root, 'config', 'roi.config.json');
  const config = JSON.parse(fs.readFileSync(file, 'utf8'));
  for (const entry of config.paths) {
    if (entry.id === 'go') entry.quotaWindows = quotaWindows;
  }
  fs.writeFileSync(file, JSON.stringify(config));
}

/** `go`'s capacity entry from a fixture home carrying TWO_WINDOW_QUOTA. */
function goCapacity(root) {
  const quotaPath = path.join(root, 'data', 'quota.json');
  fs.writeFileSync(quotaPath, JSON.stringify(TWO_WINDOW_QUOTA));
  return withEnv({ AGENTQ_QUOTA: undefined, AGENTQ_ROI_CONFIG: undefined }, () =>
    getCapacity({ home: root, quotaPath, now: NOW }).find((entry) => entry.path === 'go'));
}

test('a config path with quotaWindows "any" reaches readCapacity', () => {
  const root = copyTestdataHome();
  setGoQuotaWindows(root, 'any');
  const entry = goCapacity(root);
  assert.equal(entry.headroomPct, 90);
  assert.equal(entry.state, 'available');
});

test('a config path without quotaWindows binds every window', () => {
  const root = copyTestdataHome();
  const entry = goCapacity(root);
  assert.equal(entry.headroomPct, 5);
  assert.equal(entry.state, 'saturated');
  assert.equal(entry.reason, 'headroom below threshold (weekly: 5% left)');
});

test('quotaWindows follows the quota path id, so a sourcePath alias still applies', () => {
  const root = copyTestdataHome();
  const file = path.join(root, 'config', 'roi.config.json');
  const config = JSON.parse(fs.readFileSync(file, 'utf8'));
  // A second plan funding the same quota path `go`, declaring the mode; the
  // original entry keeps the default and must not reset it.
  config.paths.push({ id: 'go-lite', sourcePath: 'go', type: 'Wallet', fee: 5, quotaWindows: 'any' });
  fs.writeFileSync(file, JSON.stringify(config));
  const entry = goCapacity(root);
  assert.equal(entry.headroomPct, 90);
  assert.equal(entry.state, 'available');
});

test('an unreadable config leaves every path on the "all" default', () => {
  const root = copyTestdataHome();
  setGoQuotaWindows(root, 'any');
  fs.writeFileSync(path.join(root, 'config', 'roi.config.json'), '{ not json');
  const entry = goCapacity(root);
  assert.equal(entry.headroomPct, 5);
  assert.equal(entry.state, 'saturated');
});

test('getCapacity honours the AGENTQ_QUOTA override', () => {
  const root = fixtureRoot({ roi: ROI });
  const quotaFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'agentq-quota-')), 'quota.json');
  fs.writeFileSync(quotaFile, JSON.stringify(QUOTA));
  withEnv({ AGENTQ_QUOTA: quotaFile }, () => {
    const capacity = getCapacity({ home: root, now: NOW });
    assert.equal(capacity.find((entry) => entry.path === 'codex').state, 'available');
  });
});

test('recommend builds catalog and capacity itself and returns the full decision', () => {
  const root = fixtureRoot({ roi: ROI, quota: QUOTA });
  const result = recommend({ home: root, now: NOW, tier: 'big' });

  // `default` is the old `choice`: the head of the ranked list, kept only so an
  // "auto" dispatch has something to run on.
  assert.equal(result.default.id, 'a-model');
  assert.deepEqual(result.default, result.choices[0]);
  assert.deepEqual(result.options.map((option) => option.id), ['a-model']);
  assert.deepEqual(result.choices.map((choice) => choice.id), ['a-model']);
  assert.equal(result.policy.floor, 45);
  assert.deepEqual(
    result.rejected.map((item) => item.id),
    ['b-model', 'c-model'],
  );
  assert.match(result.rejected.find((item) => item.id === 'b-model').reasons.join(' '), /below floor 45/);
  assert.match(result.rejected.find((item) => item.id === 'c-model').reasons.join(' '), /unscored/);
});

test('recommend passes the policy flags through to routing', () => {
  const root = fixtureRoot({ roi: ROI, quota: QUOTA });
  // floor 30: b-model (20) is too cheap, and local/cursor capacity is unknown.
  const strict = recommend({ home: root, now: NOW, tier: 'small' });
  assert.deepEqual(strict.choices.map((choice) => choice.id), ['a-model']);

  // Cheapest first: b-model (0.1) leads, unscored c-model sorts last.
  const permissive = recommend({ home: root, now: NOW, tier: 'big', minIntelligence: 10, allowUnscored: true, allowUnknownCapacity: true });
  assert.deepEqual(permissive.choices.map((choice) => choice.id), ['b-model', 'a-model', 'c-model']);
  assert.equal(permissive.policy.floor, 10);
});

test('recommend with no usable data returns a null default and explains why', () => {
  const root = fixtureRoot({});
  const result = recommend({ home: root, now: NOW, tier: 'medium' });
  assert.equal(result.default, null);
  assert.deepEqual(result.options, []);
  assert.deepEqual(result.choices, []);
  assert.equal(result.rejected.length, 3);
});

// --- Artificial Analysis estimates ---

/** Six real complete-score pairs, so the fit is the one the dispatcher uses. */
const AA_PAIRS = [
  { model: 'provider/inkling', aa: 12.5, genIntel: 42.756756756756765 },
  { model: 'provider/minimax-m3', aa: 18.9, genIntel: 39.29459459459459 },
  { model: 'provider/deepseek-v4-pro', aa: 23.1, genIntel: 46.18108108108109 },
  { model: 'provider/gpt-5-6-luna', aa: 23.8, genIntel: 45.88999999999999 },
  { model: 'provider/gpt-5-6-terra', aa: 32.3, genIntel: 52.891891891891895 },
  { model: 'provider/claude-opus-5', aa: 44.2, genIntel: 65.97 },
];

const AA_SNAPSHOT = {
  intelligenceIndexVersion: 'v3',
  models: [
    ...AA_PAIRS.map((pair) => ({
      slug: pair.model.split('/')[1],
      evaluations: { artificial_analysis_intelligence_index: pair.aa },
    })),
    { slug: 'unscored-model', evaluations: { artificial_analysis_intelligence_index: 35.5 } },
  ],
};

const AA_ROI = {
  generatedAt: FRESH,
  models: [
    ...AA_PAIRS.map((pair) => ({ model: pair.model, genIntel: pair.genIntel, mtok: 1, complete: true })),
    // A runnable with no score row at all.
  ],
};

const AA_RUNNABLES = {
  schemaVersion: 1,
  runnables: [
    ...AA_PAIRS.map((pair) => ({ id: `host/${pair.model.split('/')[1]}`, path: 'codex', modelKey: pair.model.split('/')[1], harness: 'pi' })),
    { id: 'xai/unscored-model', path: 'codex', modelKey: null, harness: 'pi' },
    { id: 'xai/no-aa-row', path: 'codex', modelKey: null, harness: 'pi' },
  ],
};

function aaFixtureRoot({ snapshot = AA_SNAPSHOT, proSnapshot = null, registry = null } = {}) {
  const root = fixtureRoot({ roi: AA_ROI, quota: QUOTA, runnables: AA_RUNNABLES });
  if (snapshot !== null) fs.writeFileSync(path.join(root, 'data', 'aa-snapshot.json'), JSON.stringify(snapshot));
  if (proSnapshot !== null) fs.writeFileSync(path.join(root, 'data', 'aa-snapshot-pro.json'), JSON.stringify(proSnapshot));
  if (registry !== null) fs.writeFileSync(path.join(root, 'data', 'benchmark-inputs.json'), JSON.stringify(registry));
  return root;
}

test('the AA snapshot path prefers the Pro tier and honours the env override', () => {
  const root = aaFixtureRoot();
  assert.equal(defaultAaSnapshotPath(root), path.join(root, 'data', 'aa-snapshot.json'));
  fs.writeFileSync(path.join(root, 'data', 'aa-snapshot-pro.json'), JSON.stringify(AA_SNAPSHOT));
  assert.equal(defaultAaSnapshotPath(root), path.join(root, 'data', 'aa-snapshot-pro.json'));

  withEnv({ AGENTQ_AA_SNAPSHOT: '/env/aa.json' }, () => {
    assert.equal(resolvePaths({ home: root }).aaSnapshotPath, '/env/aa.json');
    assert.equal(resolvePaths({ home: root, aaSnapshotPath: '/explicit/aa.json' }).aaSnapshotPath, '/explicit/aa.json');
  });
});

test('an unscored runnable with an exact AA row gets an estimate, not a score', () => {
  const root = aaFixtureRoot();
  const catalog = getCatalog({ home: root });
  const estimated = catalog.find((entry) => entry.id === 'xai/unscored-model');

  assert.equal(estimated.intelligenceSource, 'aa-estimate');
  assert.equal(estimated.scored, false);
  assert.equal(estimated.aaIndex, 35.5);
  assert.ok(Math.abs(estimated.intelligence - 53.33) < 0.01);
  assert.equal(estimated.calibration.n, 6);
  assert.ok(Math.abs(estimated.calibration.r - 0.9479) < 0.001);
  assert.ok(Math.abs(estimated.calibration.rmse - 3.39) < 0.01);

  // A model with no AA row stays exactly as before.
  const unscored = catalog.find((entry) => entry.id === 'xai/no-aa-row');
  assert.equal(unscored.intelligence, null);
  assert.equal(unscored.intelligenceSource, null);
  assert.equal(unscored.scored, false);

  // Scored runnables keep the measured value and say so.
  const scored = catalog.find((entry) => entry.id === 'host/gpt-5-6-terra');
  assert.equal(scored.intelligenceSource, 'roi');
  assert.equal(scored.scored, true);
});

test('a missing, malformed or unusable AA snapshot disables estimates without throwing', () => {
  for (const snapshot of [null, '{ not json', { models: [] }, { models: 'nope' }]) {
    const root = aaFixtureRoot({ snapshot: null });
    if (snapshot !== null) fs.writeFileSync(path.join(root, 'data', 'aa-snapshot.json'), typeof snapshot === 'string' ? snapshot : JSON.stringify(snapshot));
    const catalog = getCatalog({ home: root });
    assert.equal(catalog.find((entry) => entry.id === 'xai/unscored-model').intelligence, null, JSON.stringify(snapshot));
    assert.equal(catalog.find((entry) => entry.id === 'host/gpt-5-6-terra').intelligenceSource, 'roi');
  }
});

test('the registry pins an AA slug during calibration but never invents an estimate', () => {
  // The registry row for one pair pins a slug that differs from its model key.
  const registry = {
    models: AA_PAIRS.map((pair) => ({ model: pair.model, aaSlug: pair.model.split('/')[1] })),
  };
  registry.models[0].aaSlug = 'inkling-official';
  const snapshot = {
    ...AA_SNAPSHOT,
    models: [
      ...AA_SNAPSHOT.models.filter((row) => row.slug !== 'inkling'),
      { slug: 'inkling-official', evaluations: { artificial_analysis_intelligence_index: 12.5 } },
    ],
  };
  const root = aaFixtureRoot({ snapshot, registry });
  const catalog = getCatalog({ home: root });
  const estimated = catalog.find((entry) => entry.id === 'xai/unscored-model');
  assert.equal(estimated.intelligenceSource, 'aa-estimate');
  assert.equal(estimated.calibration.n, 6, 'the pinned slug keeps the sixth pair in the fit');
});

test('recommend routes an estimated model and labels the reason', () => {
  const root = aaFixtureRoot();
  const decision = recommend({ home: root, now: NOW, tier: 'medium' });
  const estimated = decision.choices.find((choice) => choice.id === 'xai/unscored-model');
  assert.ok(estimated, 'the estimate is eligible');
  assert.equal(estimated.intelligenceSource, 'aa-estimate');
  assert.match(estimated.reasons.join(' '), /intelligence ≈53\.3 \(AA estimate, n=6, r=0\.95\) >= floor 38/);
});

test('recommend rejects runnables whose subscription ended or is not configured', () => {
  const ended = fixtureRoot({
    roi: ROI,
    quota: QUOTA,
    roiConfig: { paths: [{ id: 'codex', type: 'Wallet', fee: 20, startDate: '20260101', endDate: '20260901' }] },
  });
  const decision = recommend({ home: ended, now: NOW, tier: 'small' });
  assert.equal(decision.default, null);
  const codex = decision.rejected.find((r) => r.id === 'a-model');
  assert.equal(codex?.subscriptionState, 'ended');
  assert.match(codex?.reasons[0] ?? '', /subscription ended \(codex ended 2026-09-01\)/);
  const local = decision.rejected.find((r) => r.id === 'b-model');
  assert.match(local?.reasons[0] ?? '', /subscription unconfigured/);

  const missing = fixtureRoot({ roi: ROI, quota: QUOTA, roiConfig: null });
  assert.ok(recommend({ home: missing, now: NOW }).rejected.every((r) => r.subscriptionState === 'unconfigured'));
});

'use strict';
/**
 * `aa-propose --prices` exists because the registry price columns drive the ROI
 * cost, cost drives routing order, and `--write` only fills nulls, so a stale
 * price is otherwise never surfaced.
 *
 * Every number here is invented. The fixtures are written to a temp dir so the
 * report is exercised through the same loading path as the real command, and no
 * test reads data/benchmark-inputs.json or a real AA snapshot. One edge test
 * reads the tracked config/defaults/roi.json costBlend weights, as the review
 * requires, so the band edge is probed with production weights.
 */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const propose = require('../src/roi-tracker/collect/aa-propose.js');

const ROOT = path.join(__dirname, '..');

// Weights that sum to 1, so a row whose three prices all equal r blends to r
// and its registry/AA ratio is simply r. That keeps the band tests readable.
const COST_BLEND = { cache: 0.5, input: 0.3, output: 0.2 };

function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'agentq-aa-prices-'));
}

function registryRow(model, { cachePrice = 1, inputPrice = 1, outputPrice = 1, aaSlug = null } = {}) {
  return {
    model,
    gdpval: null,
    terminalBench: null,
    tau3Banking: null,
    aaLcr: null,
    aaOmni: null,
    hle: null,
    gpqa: null,
    sciCode: null,
    critPt: null,
    apexAgents: null,
    intRef: null,
    cachePrice,
    inputPrice,
    outputPrice,
    speed: null,
    aaSlug,
    aaCoding: null,
    aaAgentic: null,
  };
}

function aaRow(slug, { cachePrice = 1, inputPrice = 1, outputPrice = 1, creator = 'xAI' } = {}) {
  return {
    id: `id-${slug}`,
    name: slug,
    slug,
    model_creator: { id: `creator-${creator}`, name: creator },
    evaluations: {},
    pricing: {
      price_1m_cache_hit_tokens: cachePrice,
      price_1m_input_tokens: inputPrice,
      price_1m_output_tokens: outputPrice,
    },
    performance: { median_output_tokens_per_second: 50 },
  };
}

/** Write the three inputs and return their paths, all inside one temp dir. */
function workspace({ rows, models }) {
  const dir = tempDir();
  const snapshotPath = path.join(dir, 'aa-snapshot.json');
  const registryPath = path.join(dir, 'benchmark-inputs.json');
  const configPath = path.join(dir, 'roi.config.json');
  fs.writeFileSync(snapshotPath, `${JSON.stringify({
    source: { tier: 'free' },
    generatedAt: '2026-11-09T00:00:00Z',
    intelligenceIndexVersion: 4.1,
    modelCount: models.length,
    models,
  }, null, 2)}\n`);
  fs.writeFileSync(registryPath, `${JSON.stringify({ models: rows }, null, 2)}\n`);
  fs.writeFileSync(configPath, `${JSON.stringify({ costBlend: COST_BLEND }, null, 2)}\n`);
  return { dir, snapshotPath, registryPath, configPath };
}

function runJson(options) {
  const printed = [];
  const report = propose.runPrices({ json: true, log: line => printed.push(line), ...options });
  return { report, printed: printed.join('\n') };
}

// --- drift band ----------------------------------------------------------

test('the band edges are inside: ratio 1/k and k are not flagged', () => {
  const models = [
    aaRow('exactly-half'),
    aaRow('exactly-double'),
    aaRow('just-below'),
    aaRow('just-above'),
  ];
  const rows = [
    registryRow('x-ai/exactly-half', { cachePrice: 0.5, inputPrice: 0.5, outputPrice: 0.5 }),
    registryRow('x-ai/exactly-double', { cachePrice: 2, inputPrice: 2, outputPrice: 2 }),
    registryRow('x-ai/just-below', { cachePrice: 0.49, inputPrice: 0.49, outputPrice: 0.49 }),
    registryRow('x-ai/just-above', { cachePrice: 2.01, inputPrice: 2.01, outputPrice: 2.01 }),
  ];
  const { snapshotPath, registryPath, configPath } = workspace({ rows, models });

  const { report } = runJson({ snapshotPath, registryPath, configPath });
  const byModel = Object.fromEntries(report.rows.map(row => [row.model, row]));
  assert.equal(byModel['x-ai/exactly-half'].ratio, 0.5);
  assert.equal(byModel['x-ai/exactly-half'].flagged, false, 'ratio 1/k is inside the band');
  assert.equal(byModel['x-ai/exactly-double'].ratio, 2);
  assert.equal(byModel['x-ai/exactly-double'].flagged, false, 'ratio k is inside the band');
  assert.equal(byModel['x-ai/just-below'].flagged, true);
  assert.equal(byModel['x-ai/just-above'].flagged, true);
  assert.deepEqual(report.flagged, ['x-ai/just-below', 'x-ai/just-above']);

  // A wider k moves the same rows inside the band.
  const wider = runJson({ snapshotPath, registryPath, configPath, driftK: 3 }).report;
  assert.deepEqual(wider.flagged, []);
  assert.equal(wider.driftK, 3);
});

test('a stale price is flagged through the blend, with the per-component ratios shown', () => {
  const { snapshotPath, registryPath, configPath } = workspace({
    models: [aaRow('mixed-components', { cachePrice: 0.5, inputPrice: 1.5, outputPrice: 2 })],
    rows: [registryRow('x-ai/mixed-components')],
  });

  const { report } = runJson({ snapshotPath, registryPath, configPath });
  const [row] = report.rows;
  // 0.5*0.5 + 0.3*1.5 + 0.2*2 = 1.1 against a registry blend of 1.
  assert.equal(row.blends.registry, 1);
  assert.equal(row.blends.aa, 1.1);
  assert.deepEqual(row.components, { cache: 2, input: 0.666667, output: 0.5 });
  assert.equal(row.flagged, false, 'the blended ratio is inside the band although the components differ');
  assert.equal(report.rows[0].ratio, 0.909091);
});

// --- unknown prices ------------------------------------------------------

test('unknown prices are not compared, and the reason names the side', () => {
  const { snapshotPath, registryPath, configPath } = workspace({
    models: [
      aaRow('reg-zero-input'),
      aaRow('reg-zero-cache'),
      aaRow('aa-missing-output'),
    ],
    rows: [
      registryRow('x-ai/reg-zero-input', { inputPrice: 0 }),
      registryRow('x-ai/reg-zero-cache', { cachePrice: 0 }),
      registryRow('x-ai/aa-missing-output'),
    ],
  });
  // AA lists no output price at all for that model.
  const snapshot = JSON.parse(fs.readFileSync(snapshotPath, 'utf8'));
  snapshot.models[2].pricing.price_1m_output_tokens = null;
  fs.writeFileSync(snapshotPath, `${JSON.stringify(snapshot, null, 2)}\n`);

  const { report } = runJson({ snapshotPath, registryPath, configPath });
  assert.deepEqual(report.rows, []);
  assert.deepEqual(report.flagged, []);
  assert.deepEqual(
    report.notComparable.map(row => [row.model, row.reasons]),
    [
      ['x-ai/aa-missing-output', ['AA outputPrice is 0 or missing']],
      ['x-ai/reg-zero-cache', ['registry cachePrice is 0 (0 means not measured)']],
      ['x-ai/reg-zero-input', ['registry inputPrice is 0 or missing']],
    ],
  );
});

test('a null AA cache price falls back to the AA input price', () => {
  const { snapshotPath, registryPath, configPath } = workspace({
    models: [aaRow('null-cache', { cachePrice: null, inputPrice: 2, outputPrice: 4 })],
    rows: [registryRow('x-ai/null-cache', { cachePrice: 2, inputPrice: 2, outputPrice: 4 })],
  });

  const { report } = runJson({ snapshotPath, registryPath, configPath });
  const [row] = report.rows;
  // 0.5*2 + 0.3*2 + 0.2*4 = 2.4 on both sides: the null AA cache falls back to input.
  assert.deepEqual(row.registry, { cachePrice: 2, inputPrice: 2, outputPrice: 4, cacheSource: 'listed' });
  assert.deepEqual(row.aa, { cachePrice: 2, inputPrice: 2, outputPrice: 4, cacheSource: 'input' });
  assert.deepEqual(row.blends, { registry: 2.4, aa: 2.4 });
  assert.equal(row.ratio, 1);
  assert.equal(row.flagged, false);
  assert.deepEqual(row.components, { cache: 1, input: 1, output: 1 });
  assert.deepEqual(row.notes, []);
  assert.deepEqual(report.notComparable, []);
});

test('a null registry cache is scored as free, the way score.js blends it', () => {
  const { snapshotPath, registryPath, configPath } = workspace({
    models: [aaRow('free-cache', { cachePrice: 1, inputPrice: 1, outputPrice: 1 })],
    rows: [registryRow('x-ai/free-cache', { cachePrice: null, inputPrice: 2, outputPrice: 4 })],
  });

  const { report } = runJson({ snapshotPath, registryPath, configPath });
  const [row] = report.rows;
  // score.js blends the raw row: blendMtok counts the null cache as 0, so the
  // registry blend is 0.5*0 + 0.3*2 + 0.2*4 = 1.4, not the 2.4 a fallback gives.
  assert.deepEqual(row.registry, { cachePrice: null, inputPrice: 2, outputPrice: 4, cacheSource: 'missing' });
  assert.deepEqual(row.blends, { registry: 1.4, aa: 1 });
  assert.equal(row.ratio, 1.4);
  assert.equal(row.flagged, false);
  assert.equal(row.components.cache, null, 'no cache ratio against a null registry cache');
  assert.deepEqual(row.notes, ['registry cache null: scored as free']);
  assert.deepEqual(report.notComparable, []);

  const printed = [];
  propose.runPrices({ snapshotPath, registryPath, configPath, log: line => printed.push(line) });
  assert.match(printed.join('\n'), /x-ai\/free-cache.*\(registry cache null: scored as free\)/);
});

// --- scope and sort ------------------------------------------------------

test('scope is the strict identity rule: a pin matches, a fold does not', () => {
  const { snapshotPath, registryPath, configPath } = workspace({
    models: [aaRow('actual-slug'), aaRow('grok-4-6-preview')],
    rows: [
      registryRow('x-ai/renamed-model', { aaSlug: 'actual-slug' }),
      registryRow('x-ai/grok-4.6'),
    ],
  });

  const { report } = runJson({ snapshotPath, registryPath, configPath });
  assert.deepEqual(report.rows.map(row => [row.model, row.aaSlug]), [['x-ai/renamed-model', 'actual-slug']]);
  assert.deepEqual(report.unmatched.map(row => [row.model, row.via]), [['x-ai/grok-4.6', 'slug']]);
});

test('rows sort by |log ratio| descending, with a stable name tie-break', () => {
  const models = [
    aaRow('alpha-4'),
    aaRow('beta-quarter'),
    aaRow('delta-double'),
    aaRow('gamma-half'),
    aaRow('epsilon-near'),
  ];
  const rows = [
    registryRow('x-ai/alpha-4', { cachePrice: 4, inputPrice: 4, outputPrice: 4 }),
    registryRow('x-ai/beta-quarter', { cachePrice: 0.25, inputPrice: 0.25, outputPrice: 0.25 }),
    registryRow('x-ai/delta-double', { cachePrice: 2, inputPrice: 2, outputPrice: 2 }),
    registryRow('x-ai/gamma-half', { cachePrice: 0.5, inputPrice: 0.5, outputPrice: 0.5 }),
    registryRow('x-ai/epsilon-near', { cachePrice: 1.2, inputPrice: 1.2, outputPrice: 1.2 }),
  ];
  const { snapshotPath, registryPath, configPath } = workspace({ rows, models });

  const { report } = runJson({ snapshotPath, registryPath, configPath });
  assert.deepEqual(report.rows.map(row => row.model), [
    'x-ai/alpha-4',
    'x-ai/beta-quarter',
    'x-ai/delta-double',
    'x-ai/gamma-half',
    'x-ai/epsilon-near',
  ]);
  const round6 = value => Math.round(value * 1e6) / 1e6;
  assert.deepEqual(
    report.rows.map(row => row.logRatio),
    [2 * Math.LN2, -2 * Math.LN2, Math.LN2, -Math.LN2, 0.182322].map(round6),
  );
});

// --- output shapes -------------------------------------------------------

test('the flag follows the printed ratio at the band edge, with the real costBlend', () => {
  const realBlend = JSON.parse(fs.readFileSync(path.join(ROOT, 'config', 'defaults', 'roi.json'), 'utf8')).costBlend;
  const dir = tempDir();
  const snapshotPath = path.join(dir, 'aa-snapshot.json');
  const registryPath = path.join(dir, 'benchmark-inputs.json');
  const configPath = path.join(dir, 'roi.config.json');
  fs.writeFileSync(snapshotPath, `${JSON.stringify({
    source: { tier: 'free' },
    generatedAt: '2026-11-09T00:00:00Z',
    modelCount: 1,
    models: [aaRow('edge', { cachePrice: 1, inputPrice: 1, outputPrice: 1 })],
  }, null, 2)}\n`);
  fs.writeFileSync(registryPath, `${JSON.stringify({
    models: [
      registryRow('x-ai/edge-inside', { cachePrice: 2, inputPrice: 2, outputPrice: 2.0000001, aaSlug: 'edge' }),
      registryRow('x-ai/edge-outside', { cachePrice: 2, inputPrice: 2, outputPrice: 2.00002, aaSlug: 'edge' }),
    ],
  }, null, 2)}\n`);
  fs.writeFileSync(configPath, `${JSON.stringify({ costBlend: realBlend }, null, 2)}\n`);

  const { report } = runJson({ snapshotPath, registryPath, configPath });
  const byModel = Object.fromEntries(report.rows.map(row => [row.model, row]));
  // Raw ratios are 2.0000000042 and 2.0000008466: both above 2 in floating
  // point, but only the second survives rounding to the printed 6 places.
  assert.equal(byModel['x-ai/edge-inside'].ratio, 2);
  assert.equal(byModel['x-ai/edge-inside'].flagged, false);
  assert.equal(byModel['x-ai/edge-outside'].ratio, 2.000001);
  assert.equal(byModel['x-ai/edge-outside'].flagged, true);

  // The rounding rule itself: noise below half a micro-unit stays inside.
  assert.equal(propose.isDrift(2.0000004, 2), false);
  assert.equal(propose.isDrift(2.000001, 2), true);
  assert.equal(propose.isDrift(0.4999999, 2), false);
  assert.equal(propose.isDrift(0.499999, 2), true);
});

test('--json carries the snapshot provenance, the blend and the row shape', () => {
  const { snapshotPath, registryPath, configPath } = workspace({
    models: [aaRow('slow-model', { inputPrice: 0.4, outputPrice: 0.4, cachePrice: 0.4 })],
    rows: [registryRow('x-ai/slow-model')],
  });

  const { report } = runJson({ snapshotPath, registryPath, configPath });
  assert.equal(report.snapshot.path, snapshotPath);
  assert.equal(report.snapshot.generatedAt, '2026-11-09T00:00:00Z');
  assert.equal(report.snapshot.intelligenceIndexVersion, 4.1);
  assert.equal(report.snapshot.modelCount, 1);
  assert.deepEqual(report.costBlend, COST_BLEND);
  assert.equal(report.driftK, 2);
  assert.equal(report.written, null);
  assert.deepEqual(report.flagged, ['x-ai/slow-model']);
  assert.deepEqual(report.notComparable, []);
  assert.deepEqual(report.unmatched, []);

  const [row] = report.rows;
  assert.deepEqual(Object.keys(row), [
    'model', 'modelKey', 'aaSlug', 'notes', 'registry', 'aa', 'blends', 'ratio', 'components', 'flagged', 'logRatio',
  ]);
  assert.equal(row.modelKey, 'slow-model');
  assert.equal(row.aaSlug, 'slow-model');
  assert.deepEqual(row.registry, { cachePrice: 1, inputPrice: 1, outputPrice: 1, cacheSource: 'listed' });
  assert.deepEqual(row.aa, { cachePrice: 0.4, inputPrice: 0.4, outputPrice: 0.4, cacheSource: 'listed' });
  assert.deepEqual(row.blends, { registry: 1, aa: 0.4 });
  assert.equal(row.ratio, 2.5);
  assert.deepEqual(row.components, { cache: 2.5, input: 2.5, output: 2.5 });
});

test('the human report prints flagged rows first, then the two separate lists', () => {
  const { snapshotPath, registryPath, configPath } = workspace({
    models: [aaRow('stale'), aaRow('fresh')],
    rows: [
      registryRow('x-ai/fresh', { cachePrice: 1, inputPrice: 1, outputPrice: 1 }),
      registryRow('x-ai/stale', { cachePrice: 4, inputPrice: 4, outputPrice: 4 }),
      registryRow('x-ai/no-aa-row'),
    ],
  });
  const snapshot = JSON.parse(fs.readFileSync(snapshotPath, 'utf8'));
  fs.writeFileSync(snapshotPath, `${JSON.stringify(snapshot, null, 2)}\n`);

  const printed = [];
  propose.runPrices({ snapshotPath, registryPath, configPath, log: line => printed.push(line) });
  const output = printed.join('\n');
  assert.match(output, /cost blend: cache 0\.5, input 0\.3, output 0\.2; drift band \[0\.50x, 2\.00x\]/);
  assert.match(output, /exact AA identity: 2 of 3 registry rows, 2 comparable, 0 not comparable/);
  assert.match(output, /!\s+x-ai\/stale\s+4\.00\s+1\.00\s+4\.00x/);
  assert.match(output, /1 of 2 comparable row\(s\) flagged at k=2/);
  assert.match(output, /--write --confirm-price <model key>/);
  assert.match(output, /no exact AA identity, not compared \(1\):\n {2}x-ai\/no-aa-row/);
});

// --- opt-in write --------------------------------------------------------

test('--write is refused without --confirm-price and leaves the file alone', () => {
  const { snapshotPath, registryPath, configPath } = workspace({
    models: [aaRow('stale', { cachePrice: 0.4, inputPrice: 0.4, outputPrice: 0.4 })],
    rows: [registryRow('x-ai/stale')],
  });
  const before = fs.readFileSync(registryPath, 'utf8');

  assert.throws(
    () => propose.runPrices({ write: true, snapshotPath, registryPath, configPath, log: () => {} }),
    /needs --confirm-price k1,k2: there is no bulk overwrite/,
  );
  assert.equal(fs.readFileSync(registryPath, 'utf8'), before);
});

test('--confirm-price names only flagged rows: in-band, not comparable and unknown keys error', () => {
  const { snapshotPath, registryPath, configPath } = workspace({
    models: [aaRow('in-band'), aaRow('stale-zero-input'), aaRow('stale')],
    rows: [
      registryRow('x-ai/in-band'),
      registryRow('x-ai/stale-zero-input', { inputPrice: 0 }),
      registryRow('x-ai/stale', { cachePrice: 4, inputPrice: 4, outputPrice: 4 }),
      registryRow('x-ai/no-aa-row'),
    ],
  });
  const before = fs.readFileSync(registryPath, 'utf8');
  const options = { write: true, snapshotPath, registryPath, configPath, log: () => {} };

  assert.throws(() => propose.runPrices({ ...options, confirmPrice: ['in-band'] }), /within the drift band/);
  assert.throws(() => propose.runPrices({ ...options, confirmPrice: ['stale-zero-input'] }), /is not comparable/);
  assert.throws(() => propose.runPrices({ ...options, confirmPrice: ['no-aa-row'] }), /has no exact AA identity/);
  assert.throws(() => propose.runPrices({ ...options, confirmPrice: ['not-a-model'] }), /unknown model, not a registry row/);
  // Nothing above may touch the file.
  assert.equal(fs.readFileSync(registryPath, 'utf8'), before);
});

test('a confirmed write changes only the three price fields of only the confirmed rows', () => {
  const { snapshotPath, registryPath, configPath } = workspace({
    models: [
      aaRow('stale-cheap', { cachePrice: null, inputPrice: 0.4, outputPrice: 0.4 }),
      aaRow('stale-second', { cachePrice: 0.3, inputPrice: 0.3, outputPrice: 0.3 }),
      aaRow('in-band'),
      // No AA row at all for x-ai/no-aa-row.
    ],
    rows: [
      registryRow('x-ai/stale-cheap'),
      registryRow('x-ai/stale-second'),
      registryRow('x-ai/in-band'),
      registryRow('x-ai/no-aa-row'),
    ],
  });
  const original = JSON.parse(fs.readFileSync(registryPath, 'utf8')).models;

  const printed = [];
  const report = propose.runPrices({
    write: true,
    confirmPrice: ['stale-cheap'],
    snapshotPath,
    registryPath,
    configPath,
    log: line => printed.push(line),
  });

  assert.deepEqual(report.written, {
    path: registryPath,
    models: ['x-ai/stale-cheap'],
    fields: ['cachePrice', 'inputPrice', 'outputPrice'],
    next: ['npm run pipeline', 'npm run verify'],
  });

  const written = JSON.parse(fs.readFileSync(registryPath, 'utf8')).models;
  assert.equal(written.length, original.length);

  // The confirmed row: all three prices become the AA prices, and a null AA
  // cache price is written as the AA input price (what those tokens cost).
  assert.deepEqual(written[0], {
    ...original[0],
    cachePrice: 0.4,
    inputPrice: 0.4,
    outputPrice: 0.4,
  });
  assert.deepEqual(Object.keys(written[0]), Object.keys(original[0]), 'field order is preserved');

  // Every other row is byte-identical.
  for (const index of [1, 2, 3]) {
    assert.equal(JSON.stringify(written[index]), JSON.stringify(original[index]), `row ${index} untouched`);
  }

  assert.match(printed.join('\n'), /registry prices updated: x-ai\/stale-cheap/);
  assert.match(printed.join('\n'), /next: npm run pipeline && npm run verify/);
});

test('--confirm-price on a key shared by two registry rows errors and writes nothing', () => {
  const { snapshotPath, registryPath, configPath } = workspace({
    models: [
      aaRow('shared-one', { cachePrice: 0.1, inputPrice: 0.1, outputPrice: 0.1 }),
      aaRow('shared-two', { cachePrice: 0.1, inputPrice: 0.1, outputPrice: 0.1 }),
    ],
    rows: [
      // Different `model` strings, same modelKey: the key cannot pick a row.
      { ...registryRow('x-ai/shared'), aaSlug: 'shared-one' },
      { ...registryRow('other/shared'), aaSlug: 'shared-two' },
    ],
  });
  const before = fs.readFileSync(registryPath, 'utf8');
  const options = { write: true, snapshotPath, registryPath, configPath, log: () => {} };

  assert.throws(
    () => propose.runPrices({ ...options, confirmPrice: ['shared'] }),
    /matches 2 registry rows \(x-ai\/shared, other\/shared\)/,
  );
  assert.equal(fs.readFileSync(registryPath, 'utf8'), before);
});

test('--drift-k parses through parseArgs and stays a --prices-only option', () => {
  assert.equal(propose.parseArgs(['--prices', '--drift-k', '2.5']).driftK, 2.5);
  assert.equal(propose.parseArgs(['--prices']).driftK, 2);
  assert.throws(() => propose.parseArgs(['--prices', '--drift-k', '1']), /greater than 1/);
  assert.throws(() => propose.parseArgs(['--prices', '--drift-k', '0']), /greater than 1/);
  assert.throws(() => propose.parseArgs(['--prices', '--drift-k', 'abc']), /greater than 1/);
  assert.throws(() => propose.parseArgs(['--prices', '--drift-k']), /greater than 1/);
  assert.throws(() => propose.parseArgs(['--drift-k', '3']), /only valid with --prices/);
});

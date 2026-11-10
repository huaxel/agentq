'use strict';
/**
 * Unit tests for src/core/token-mix.js: the CSV parser, the per-(model, path)
 * index, and the fallback chain with its 1,000,000-token floor.
 * Run with `npm test`.
 */
const { test } = require('node:test');
const assert = require('node:assert/strict');

const {
  MIN_MIX_TOKENS,
  MIX_FIELDS,
  parseCsv,
  mixIndex,
  sharesOf,
  defaultMix,
  mixFor,
} = require('../src/core/token-mix.js');

const COST_BLEND = { cache: 0.9174, input: 0.0781, output: 0.044 };

/**
 * @param {Partial<Record<string, string|number>>} [overrides]
 * @returns {Record<string, string|number>}
 */
function row(overrides = {}) {
  return {
    model_key: 'atlas-flash',
    path_id: 'go',
    input: 600000,
    output: 240000,
    cache_write: 0,
    cache_read: 11160000,
    tokens: 12000000,
    ...overrides,
  };
}

test('the CSV parser handles quotes, embedded commas and doubled quotes', () => {
  const rows = parseCsv('a,b,c\n"x,1","y""z",plain\n');
  assert.deepEqual(rows, [{ a: 'x,1', b: 'y"z', c: 'plain' }]);
});

test('the CSV parser tolerates CRLF, a BOM and blank trailing lines', () => {
  const rows = parseCsv('\ufeffmodel_key,path_id\r\natlas-flash,go\r\n\r\n');
  assert.deepEqual(rows, [{ model_key: 'atlas-flash', path_id: 'go' }]);
});

test('the CSV parser returns nothing for empty or non-string input', () => {
  assert.deepEqual(parseCsv(''), []);
  assert.deepEqual(parseCsv(null), []);
  assert.deepEqual(parseCsv(undefined), []);
  assert.deepEqual(parseCsv('model_key,path_id\n'), []);
});

test('the index sums rows per (model, path) and per model', () => {
  const index = mixIndex([
    row(),
    row({ path_id: 'codex', input: 100000, output: 40000, cache_read: 1860000 }),
    row({ model_key: 'atlas-mini', path_id: 'go', input: 50000, output: 20000, cache_read: 930000 }),
  ]);
  assert.deepEqual(index.byPath.get('atlas-flash\u0000go'), {
    cacheRead: 11160000, cacheWrite: 0, input: 600000, output: 240000,
  });
  assert.deepEqual(index.byModel.get('atlas-flash'), {
    cacheRead: 13020000, cacheWrite: 0, input: 700000, output: 280000,
  });
  assert.equal(index.byPath.size, 3);
  assert.equal(index.byModel.size, 2);
});

test('the index folds model keys and ignores rows without one', () => {
  const index = mixIndex([
    row({ model_key: 'orbit/atlas-flash' }),
    row({ model_key: '', path_id: 'go' }),
    row({ model_key: 'atlas-flash', path_id: '' }),
  ]);
  assert.deepEqual([...index.byModel.keys()], ['atlas-flash']);
  assert.deepEqual([...index.byPath.keys()], ['atlas-flash\u0000go']);
});

test('shares are normalized and a level with no tokens yields null', () => {
  const shares = sharesOf({ cacheRead: 75, cacheWrite: 25, input: 0, output: 0 });
  assert.equal(shares.tokens, 100);
  assert.equal(shares.mix.cacheRead, 0.75);
  assert.equal(shares.mix.cacheWrite, 0.25);
  assert.equal(sharesOf({ cacheRead: 0, cacheWrite: 0, input: 0, output: 0 }), null);
  assert.equal(sharesOf(undefined), null);
});

test('the model-and-path level wins, then the model level, then the default', () => {
  const index = mixIndex([
    row(),
    row({ path_id: 'codex', input: 100000, output: 40000, cache_read: 1860000 }),
  ]);
  const onPath = mixFor(index, { modelKey: 'atlas-flash', path: 'go', costBlend: COST_BLEND });
  assert.equal(onPath.mixSource, 'observed-path');
  assert.equal(onPath.mixTokens, 12000000);
  assert.ok(Math.abs(onPath.mix.cacheRead - 11160000 / 12000000) < 1e-12);

  // A path with no rows of its own falls back to the model-wide totals.
  const otherPath = mixFor(index, { modelKey: 'atlas-flash', path: 'cursor', costBlend: COST_BLEND });
  assert.equal(otherPath.mixSource, 'observed-model');
  assert.equal(otherPath.mixTokens, 14000000);

  // A model with no rows at all falls back to the configured blend.
  const unknown = mixFor(index, { modelKey: 'o-mini', path: 'go', costBlend: COST_BLEND });
  assert.equal(unknown.mixSource, 'default');
  assert.equal(unknown.mixTokens, null);
  assert.deepEqual(unknown.mix, { cacheRead: 0.9174, cacheWrite: 0, input: 0.0781, output: 0.044 });
});

test('a level below 1,000,000 tokens is skipped, not scaled down', () => {
  assert.equal(MIN_MIX_TOKENS, 1_000_000);
  const thin = mixIndex([row({ input: 3000, output: 1000, cache_read: 1000, cache_write: 0 })]);
  const result = mixFor(thin, { modelKey: 'atlas-flash', path: 'go', costBlend: COST_BLEND });
  assert.equal(result.mixSource, 'default');

  // Exactly at the floor counts.
  const atFloor = mixIndex([row({ input: 500000, output: 500000, cache_read: 0, cache_write: 0 })]);
  assert.equal(mixFor(atFloor, { modelKey: 'atlas-flash', path: 'go', costBlend: COST_BLEND }).mixSource, 'observed-path');

  // A thin path row still falls back to a fat model row.
  const mixed = mixIndex([
    row({ input: 3000, output: 1000, cache_read: 1000, cache_write: 0 }),
    row({ path_id: 'codex' }),
  ]);
  const fromModel = mixFor(mixed, { modelKey: 'atlas-flash', path: 'go', costBlend: COST_BLEND });
  assert.equal(fromModel.mixSource, 'observed-model');
  assert.equal(fromModel.mixTokens, 12005000, 'the thin path row is summed into the model level, not used alone');
});

test('the default mix reuses the configured weights unchanged', () => {
  assert.deepEqual(defaultMix(COST_BLEND), { cacheRead: 0.9174, cacheWrite: 0, input: 0.0781, output: 0.044 });
  assert.deepEqual(defaultMix({ ...COST_BLEND, cacheWrite: 0.02 }), {
    cacheRead: 0.9174, cacheWrite: 0.02, input: 0.0781, output: 0.044,
  });
  assert.equal(defaultMix(null), null);
  assert.equal(defaultMix({ cache: 1 }), null, 'a partial blend is unusable');
  // Unchanged means un-normalized: the ROI pipeline's mtok formula is preserved.
  const sum = Object.values(defaultMix(COST_BLEND)).reduce((a, b) => a + b, 0);
  assert.ok(Math.abs(sum - 1.0395) < 1e-12);
});

test('no index at all is the default level', () => {
  const result = mixFor(null, { modelKey: 'atlas-flash', path: 'go', costBlend: COST_BLEND });
  assert.equal(result.mixSource, 'default');
  assert.deepEqual(Object.keys(result.mix).sort(), [...MIX_FIELDS].sort());
});

test('a runnable with no model key never matches an observed level', () => {
  const index = mixIndex([row()]);
  const result = mixFor(index, { modelKey: null, path: 'go', costBlend: COST_BLEND });
  assert.equal(result.mixSource, 'default');
});

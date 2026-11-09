'use strict';
/**
 * Unit tests for src/lib/path-coverage.js and the coverage rules in
 * src/lib/validate-config.js: a path declares the models it serves, a runnable
 * must sit on a path that covers its model, and a declared key the registry
 * lacks is only a warning. Run with `npm test`.
 */
const { test } = require('node:test');
const assert = require('node:assert/strict');

const {
  ALL_MODELS, pathCoverage, pathCovers, pathLabel, coverageProblems, coverageWarnings,
} = require('../src/lib/path-coverage.js');
const { configProblems, configWarnings } = require('../src/lib/validate-config.js');

const config = {
  paths: [
    { id: 'local', name: 'Local box', type: 'Local', fee: 0, models: ['tiny-7b'] },
    { id: 'codex', name: 'Acme Codex', type: 'Wallet', fee: 20, models: ['atlas-flash', 'nimbus-coder'] },
    { id: 'openrouter', name: 'OpenRouter', type: 'Metered', fee: 0, models: ['*'] },
  ],
};

test('coverage is per path, and "*" covers everything', () => {
  assert.deepEqual([...pathCoverage(config.paths[1]).keys], ['atlas-flash', 'nimbus-coder']);
  assert.equal(pathCoverage(config.paths[1]).all, false);
  assert.equal(pathCoverage(config.paths[2]).all, true);
  assert.equal(ALL_MODELS, '*');

  assert.equal(pathCovers(config.paths[1], 'atlas-flash'), true);
  assert.equal(pathCovers(config.paths[1], 'o-pro'), false);
  assert.equal(pathCovers(config.paths[2], 'o-pro'), true);
  assert.equal(pathCovers(config.paths[0], 'vendor/tiny-7b'), true, 'keys fold through modelKey()');
});

test('a missing or empty models list covers nothing', () => {
  assert.deepEqual([...pathCoverage({ id: 'x' }).keys], []);
  assert.equal(pathCovers({ id: 'x' }, 'atlas-flash'), false);
  assert.equal(pathCovers({ id: 'x', models: [] }, 'atlas-flash'), false);
  assert.equal(pathCovers({ id: 'x', models: ['*'] }, 'anything'), true);
});

test('the label is the path name, else the id', () => {
  assert.equal(pathLabel(config.paths[1]), 'Acme Codex');
  assert.equal(pathLabel({ id: 'mystery' }), 'mystery');
  assert.equal(pathLabel(undefined), '');
});

test('a runnable on a path that does not cover its model is an error', () => {
  const runnables = [
    { id: 'acme/atlas-flash', path: 'codex', modelKey: 'atlas-flash' },
    { id: 'acme/atlas-large', path: 'codex', modelKey: 'atlas-large' },
  ];
  const expected = ['runnable acme/atlas-large: path codex does not cover atlas-large'];
  assert.deepEqual(coverageProblems(config, { runnables }), expected);
  // Through the config validator, so the pipeline and verify report it too.
  // (This config is deliberately minimal, so only the coverage lines are
  // compared.)
  assert.deepEqual(configProblems(config, { runnables }).filter(p => p.startsWith('runnable ')), expected);
});

test('a runnable on a wildcard path, or with no modelKey, is covered', () => {
  const runnables = [
    { id: 'openrouter/o-pro', path: 'openrouter', modelKey: 'o-pro' },
    { id: 'openrouter/unscored', path: 'openrouter', modelKey: null },
  ];
  assert.deepEqual(coverageProblems(config, { runnables }), []);
});

test('a runnable on a path the config does not declare is not covered', () => {
  const runnables = [{ id: 'x/y', path: 'ghost', modelKey: 'y' }];
  assert.deepEqual(coverageProblems(config, { runnables }), [
    'runnable x/y: path ghost does not cover y',
  ]);
});

test('a declared model key missing from the registry is a warning, not an error', () => {
  const registry = [{ model: 'local/tiny-7b' }, { model: 'acme/atlas-flash' }];
  assert.deepEqual(configWarnings(config, registry), [
    'path codex: model nimbus-coder is not in the registry',
  ]);
  assert.deepEqual(
    configProblems(config, { runnables: [] }).filter(p => /registry|runnable/.test(p)),
    [],
    'unknown keys never fail validation',
  );
  // No registry loaded means nothing to compare against.
  assert.deepEqual(coverageWarnings(config, null), []);
});

test('models must be an array of non-empty strings', () => {
  const bad = { paths: [{ id: 'codex', type: 'Wallet', fee: 20, models: 'atlas-flash' }] };
  assert.ok(configProblems(bad).some(p => /"models" must be an array/.test(p)));

  const mixed = { paths: [{ id: 'codex', type: 'Wallet', fee: 20, models: ['atlas-flash', ''] }] };
  assert.ok(configProblems(mixed).some(p => /models\[1\] must be a non-empty string/.test(p)));

  const missing = { paths: [{ id: 'codex', type: 'Wallet', fee: 20 }] };
  assert.ok(!configProblems(missing).some(p => /models/.test(p)), 'a path with no models covers nothing, and is legal');
});

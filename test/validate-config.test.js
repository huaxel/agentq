'use strict';
/**
 * Unit tests for lib/validate-config.js. Also asserts what `agentq home init`
 * produces (method defaults merged with the example setup) passes, so the
 * validator can't drift away from what the pipeline accepts.
 * Run with `npm test`.
 */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { configProblems, validateConfig } = require('../src/lib/validate-config.js');
const { initHome, loadRoiConfig } = require('../src/lib/home.js');

const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'agentq-validate-home-'));
initHome({ home: HOME });
const realConfig = loadRoiConfig({ home: HOME });

test('the shipped defaults plus example setup validate clean', () => {
  assert.deepEqual(configProblems(realConfig), []);
});

test('flags a missing paths array', () => {
  const c = { ...realConfig, paths: [] };
  assert.ok(configProblems(c).some(p => /paths/.test(p)));
});

test('flags a path entry missing id/type', () => {
  const c = { ...realConfig, paths: [{ fee: 10 }] };
  const problems = configProblems(c);
  assert.ok(problems.some(p => /"id"/.test(p)));
  assert.ok(problems.some(p => /"type"/.test(p)));
});

test('flags a path entry missing a numeric fee', () => {
  const c = { ...realConfig, paths: [{ id: 'go', type: 'Wallet' }] };
  assert.ok(configProblems(c).some(p => /"fee"/.test(p)));
});

test('flags a path entry with an unknown type', () => {
  const c = { ...realConfig, paths: [{ id: 'bad', type: 'wallet', fee: 10 }] };
  assert.ok(configProblems(c).some(p => /unknown type/.test(p)));
});

test('quotaWindows accepts all/any and rejects anything else', () => {
  const withMode = (quotaWindows) => ({ ...realConfig, paths: [{ id: 'go', type: 'Wallet', fee: 10, quotaWindows }] });
  assert.deepEqual(configProblems(withMode('all')), []);
  assert.deepEqual(configProblems(withMode('any')), []);
  assert.deepEqual(configProblems(withMode(undefined)), [], 'omitting the key is the default');
  const problems = configProblems(withMode('some'));
  assert.equal(problems.length, 1);
  assert.match(problems[0], /paths\[0\] \(go\): "quotaWindows" must be "all" or "any"/);
});

test('flags a missing profile and non-numeric weights', () => {
  const c = { ...realConfig, profiles: { tax: { agents: 'x' } } };
  const problems = configProblems(c);
  assert.ok(problems.some(p => /profiles\.hobby/.test(p)));
  assert.ok(problems.some(p => /profiles\.tax\.agents/.test(p)));
});

test('flags a malformed costBlend', () => {
  const c = { ...realConfig, costBlend: { cache: 1 } };
  const problems = configProblems(c);
  assert.ok(problems.some(p => /costBlend\.input/.test(p)));
});

test('validateConfig throws a listed error, or returns the config', () => {
  assert.throws(() => validateConfig({}, 'roi.config.json'), /invalid roi\.config\.json/);
  assert.equal(validateConfig(realConfig), realConfig);
});

test('flags malformed model price aliases', () => {
  assert.ok(configProblems({ ...realConfig, modelPriceAliases: [] }).some(p => p.includes('modelPriceAliases: expected an object')));
  assert.ok(configProblems({ ...realConfig, modelPriceAliases: { '': 'gpt-5-4' } }).some(p => p.includes('alias keys must be non-empty')));
  assert.ok(configProblems({ ...realConfig, modelPriceAliases: { 'gpt-5.4': null } }).some(p => p.includes('expected a non-empty string target')));
});

// --- path prices (W16) ------------------------------------------------------

const { configWarnings } = require('../src/lib/validate-config.js');

/** The shipped config with one priced path. */
function withPrices(prices, extra = {}) {
  return {
    ...realConfig,
    paths: realConfig.paths.map((path) => (
      path.id === 'codex' ? { ...path, prices, ...extra } : path
    )),
  };
}

test('a malformed price table fails validation', () => {
  const problems = configProblems(withPrices({
    'atlas-flash': { input: -1, monthlyLimit: 0 },
    'atlas-ultra': { until: '31/12/2026' },
  }, { offPeakHours: { tz: 'Nowhere/Nothing', start: '25:00', end: '26:00' } }));
  assert.ok(problems.some((p) => /prices\["atlas-flash"\]\.input: must not be negative/.test(p)));
  assert.ok(problems.some((p) => /monthlyLimit: must be a positive number/.test(p)));
  assert.ok(problems.some((p) => /\.until: expected a YYYY-MM-DD date/.test(p)));
  assert.ok(problems.some((p) => /offPeakHours\.tz "Nowhere\/Nothing" is not a known time zone/.test(p)));
});

test('a valid price table validates clean, and an uncovered key only warns', () => {
  const config = withPrices({
    'example-codex': { input: 0.15, output: 0.6, cacheRead: 0.003, monthlyLimit: 100 },
    'atlas-ultra': { input: 0.6, output: 2.4, cacheRead: 0.012, monthlyLimit: 15 },
  }, { offPeakHours: { tz: 'UTC', start: '16:30', end: '00:30' } });
  assert.deepEqual(configProblems(config), []);
  assert.deepEqual(configWarnings(config, null), [
    "path codex: price for atlas-ultra is not in the path's coverage",
  ]);
});

test('offPeakHours accepts several windows, and an empty list fails validation', () => {
  const windows = [
    { tz: 'UTC', start: '01:00', end: '04:00' },
    { tz: 'UTC', start: '06:00', end: '10:00' },
  ];
  const config = withPrices({
    'example-codex': { input: 0.15, output: 0.6, cacheRead: 0.003, monthlyLimit: 100 },
  }, { offPeakHours: windows });
  assert.deepEqual(configProblems(config), []);

  const empty = withPrices({
    'example-codex': { input: 0.15, output: 0.6, cacheRead: 0.003, monthlyLimit: 100 },
  }, { offPeakHours: [] });
  assert.ok(configProblems(empty).some((p) => /"offPeakHours" must not be an empty array/.test(p)));

  const malformed = withPrices({
    'example-codex': { input: 0.15, output: 0.6, cacheRead: 0.003, monthlyLimit: 100 },
  }, { offPeakHours: [windows[0], { tz: 'Nowhere/Nothing', start: '06:00', end: '10:00' }] });
  assert.ok(configProblems(malformed)
    .some((p) => /offPeakHours\[1\]\.tz "Nowhere\/Nothing" is not a known time zone/.test(p)));
});

test('the synthetic fixture home config validates clean', () => {
  // The fixture home carries only the setup; the method defaults supply the
  // scorer's tables, so the effective config is what must validate.
  const fixture = loadRoiConfig({ home: path.join(__dirname, '..', 'testdata', 'home') });
  assert.deepEqual(configProblems(fixture), []);
});

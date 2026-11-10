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

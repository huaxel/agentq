'use strict';
const assert = require('node:assert/strict');
const test = require('node:test');
const { supportsAgyUsage, observeAgyQuota, applyNativeQuota } = require('../src/lib/capacity-native-quota.js');
const { fetchNativeQuota } = require('../src/lib/capacity-live-client.js');
const { buildCapacityView } = require('../src/lib/capacity-view.js');
const { mergeObservations } = require('../src/lib/capacity-observations.js');
const now = Date.parse('2026-10-06T12:00:00Z');
const models = 'gemini-1-flash\tGemini\nclaude-sonnet-1\tClaude';
const entries = [{ model: 'Gemini Models', window: 'five-hour', remaining_fraction: 0.12345, reset_at: '2026-10-06T13:00:00Z' }, { model: 'Claude and GPT models', window: 'weekly', remaining_fraction: 0 }];
const parseUsage = text => JSON.parse(text);
function runFixture(entries, calls = [], version = '1.3.1') {
  return async (args, timeout) => {
    calls.push(args);
    assert.ok([3000, 5000, 12000].includes(timeout));
    return args[0] === '--version' ? version : args[0] === 'models' ? models : JSON.stringify({ models: entries, secret: 'private-sentinel' });
  };
}

test('unknown old prerelease and future major versions never execute usage', async () => {
  for (const version of ['1.1.10', '2.0.0', '1.3.1-beta', 'unknown', '1.999999999999999999999.1']) {
    assert.equal(supportsAgyUsage(version), false);
    const calls = [];
    const result = await observeAgyQuota({ run: runFixture(entries, calls, version), parseUsage });
    assert.equal(result.state, 'unknown');
    assert.deepEqual(calls, [['--version']]);
  }
  assert.equal(supportsAgyUsage('1.1.11'), true);
});

test('only fixed metadata commands run and separate pools do not claim global headroom', async () => {
  const calls = [];
  const result = await observeAgyQuota({ run: runFixture(entries, calls), parseUsage, now: () => now });
  assert.deepEqual(calls, [['--version'], ['models'], ['--output-format', 'json', '-p', '/usage']]);
  assert.equal(result.state, 'unknown');
  assert.equal(result.modelResolved, false);
  assert.equal(result.accountResolved, false);
  assert.equal(result.pools[0].state, 'headroom-observed');
  assert.equal(result.pools[1].state, 'exhausted');
  const output = JSON.stringify(result);
  for (const privateValue of ['0.12345', 'remaining_fraction', 'private-sentinel']) assert.ok(!output.includes(privateValue));
});

test('malformed amounts expired resets and failed commands remain unknown', async () => {
  for (const remaining_fraction of [null, -1, 2, 'bad']) {
    const result = await observeAgyQuota({ run: runFixture([{ model: 'Gemini Models', remaining_fraction }]), parseUsage, now: () => now });
    assert.equal(result.pools[0].state, 'unknown');
  }
  const result = await observeAgyQuota({ run: async () => { throw new Error('private-sentinel'); }, parseUsage });
  assert.equal(result.state, 'unknown');
  assert.ok(!JSON.stringify(result).includes('private-sentinel'));
  const expired = await observeAgyQuota({ run: runFixture([{ model: 'Gemini Models', remaining_fraction: 0, reset_at: '2026-10-06T11:00:00Z' }]), parseUsage, now: () => now });
  assert.equal(expired.pools[0].state, 'unknown');
});

test('blank fields do not become exhausted and approximate resets do not become timestamps', async () => {
  const result = await observeAgyQuota({ run: runFixture([{ model: 'Gemini Models', remaining_fraction: '', reset_at: 'in 1h' }]), parseUsage, now: () => now });
  assert.equal(result.pools[0].state, 'unknown');
  assert.equal(result.pools[0].nextResetAt, null);
  assert.equal(result.pools[0].recheckAt, null);
});

test('zero-duration native reset labels do not retain stale headroom or exhaustion', async () => {
  for (const remaining_fraction of [0, 1]) {
    const result = await observeAgyQuota({ run: runFixture([{ model: 'Gemini Models', remaining_fraction, reset_at: 'in 0s' }]), parseUsage, now: () => now });
    assert.equal(result.pools[0].state, 'unknown');
    assert.equal(result.pools[0].nextResetAt, null);
  }
});

test('only catalog IDs or recognized pool labels are forwarded with bounded rows', async () => {
  const list = [{ model: 'private-sentinel', remaining_fraction: 1 }, ...Array.from({ length: 20 }, () => ({ model: 'Gemini Models', remaining_fraction: 1 }))];
  const result = await observeAgyQuota({ run: runFixture(list), parseUsage, now: () => now });
  assert.equal(result.pools.length, 16);
  assert.equal(result.poolsOmitted, 5);
  assert.ok(!JSON.stringify(result).includes('private-sentinel'));
});

test('native quota cannot be copied into Pi or other machines and never changes access', async () => {
  const quota = await observeAgyQuota({ run: runFixture(entries), parseUsage, now: () => now });
  const view = { observedMachine: 'host', paths: [
    { machine: 'host', harness: 'agy', provider: 'antigravity', access: 'unknown' },
    { machine: 'host', harness: 'pi', provider: 'antigravity', quota: null },
    { machine: 'remote', harness: 'agy', provider: 'antigravity', quota: null },
  ] };
  applyNativeQuota(view, quota);
  assert.equal(view.paths[0].quota.source, 'native-agy-usage');
  assert.equal(view.paths[0].access, 'unknown');
  assert.equal(view.paths[1].quota, null);
  assert.equal(view.paths[2].quota, null);
});

test('merged native pools expire at reset and age boundaries', async () => {
  const quota = await observeAgyQuota({ run: runFixture(entries), parseUsage, now: () => now });
  const inventory = { schemaVersion: 1, paths: [{ id: 'agy', machine: 'local', subscription: 'google-ai-pro', accountRef: null, harness: 'agy', provider: 'antigravity', catalog: 'native', quotaPath: 'antigravity', constraints: [] }] };
  const view = applyNativeQuota(buildCapacityView(inventory, { machine: 'host', installed: new Set(['agy']), now }), quota);
  assert.equal(mergeObservations([view], { now }).paths[0].quota.pools[0].state, 'headroom-observed');
  assert.equal(mergeObservations([view], { now: now + 3600000 }).paths[0].quota.pools[0].state, 'unknown');
  assert.equal(mergeObservations([view], { now: now + 7 * 3600000 }).paths[0].quota.pools[1].state, 'unknown');
});

test('native helper boundary is bounded and discards errors or diagnostic output', () => {
  const result = fetchNativeQuota('/trusted/root', { run: (command, args, options) => {
    assert.equal(command, process.execPath);
    assert.deepEqual(args, ['--experimental-strip-types', '/trusted/root/bin/capacity-native.js']);
    assert.equal(options.timeout, 25000);
    assert.equal(options.maxBuffer, 64 * 1024);
    return { status: 1, stderr: 'private-sentinel' };
  } });
  assert.equal(result, null);
});

test('fixed stage reasons classify unavailable commands without leaking diagnostics', async () => {
  for (const [stage, reason] of [[0, 'native-version-command-unavailable'], [1, 'native-catalog-command-or-format-unavailable'], [2, 'native-usage-command-unavailable']]) {
    let calls = 0;
    const result = await observeAgyQuota({ parseUsage, run: async args => {
      if (calls++ === stage) throw new Error('private-sentinel');
      return args[0] === '--version' ? '1.3.1' : models;
    } });
    assert.equal(result.reason, reason); assert.equal(result.state, 'unknown');
    assert.equal(calls, stage + 1); assert.ok(!JSON.stringify(result).includes('private-sentinel'));
  }
});
test('unrecognized payload and parser response have distinct private-safe reasons', async () => {
  const run = async args => args[0] === '--version' ? '1.3.1' : args[0] === 'models' ? models : 'private-sentinel INVALID';
  const invalid = await observeAgyQuota({ run, parseUsage });
  assert.equal(invalid.reason, 'native-usage-payload-unrecognized');
  assert.ok(!JSON.stringify(invalid).includes('private-sentinel'));
  for (const snapshot of [undefined, { error: 'private-sentinel' }, { models: 'private-sentinel' }]) {
    const result = await observeAgyQuota({ run: runFixture(entries), parseUsage: () => snapshot });
    assert.equal(result.reason, 'native-usage-response-unrecognized');
    assert.ok(!JSON.stringify(result).includes('private-sentinel'));
  }
});

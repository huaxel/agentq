'use strict';
const assert = require('node:assert/strict');
const test = require('node:test');
const { observeLiveQuota } = require('../src/lib/capacity-live-quota.js');
const { fetchLiveQuota, applyLiveQuota } = require('../src/lib/capacity-live-client.js');
const { buildCapacityView } = require('../src/lib/capacity-view.js');
const { mergeObservations } = require('../src/lib/capacity-observations.js');
const now = Date.parse('2026-10-06T12:00:00Z');
const auth = {
  loadAuthJson: () => ({ 'opencode-go-failover': { accounts: [{ key: 'key-one', label: 'private-label' }, { key: 'key-two' }] } }),
  authCredential: () => 'key-one', resolveAuthValue: value => value?.startsWith('!') ? undefined : value,
};
const usage = {
  fetchUsageApi: async key => key === 'key-one'
    ? { rolling: { usagePercent: 100, resetInSec: 3600 }, weekly: { usagePercent: 1 }, monthly: { usagePercent: 1 } }
    : { rolling: { usagePercent: 5 }, weekly: { usagePercent: 5 }, monthly: { usagePercent: 5 } },
  fetchOpenferenceUsage: async () => ({ windows: [{ usedPercent: 12.345 }], fetchedAt: now }),
};

test('Go accounts remain separate and current configured key exhaustion does not erase alternatives', async () => {
  const result = await observeLiveQuota({ auth, usage, now });
  assert.equal(result.go.state, 'exhausted');
  assert.equal(result.go.accounts.length, 2);
  assert.equal(result.go.accounts[0].matchesConfiguredProviderKey, true);
  assert.equal(result.go.accounts[1].state, 'headroom-observed');
  assert.equal(result.go.modelResolved, false);
});

test('missing Go limits remain unknown while a known exhausted limit still blocks', async () => {
  for (const missing of ['rolling', 'weekly', 'monthly']) {
    const complete = { rolling: { usagePercent: 5 }, weekly: { usagePercent: 5 }, monthly: { usagePercent: 5 } };
    for (const malformed of [null, undefined, { usagePercent: null }, { usagePercent: '0' }]) {
      const result = await observeLiveQuota({ auth, now, usage: { ...usage, fetchUsageApi: async () => ({ ...complete, [missing]: malformed }) } });
      assert.equal(result.go.state, 'unknown');
      assert.equal(result.go.accounts[0].state, 'unknown');
    }
  }
  const blocked = await observeLiveQuota({ auth, now, usage: { ...usage, fetchUsageApi: async () => ({ rolling: { usagePercent: 100, resetInSec: 3600 } }) } });
  assert.equal(blocked.go.state, 'exhausted');
  assert.equal(blocked.go.nextResetAt, null);
});

test('live output omits keys labels raw percentages and diagnostic strings', async () => {
  const result = await observeLiveQuota({ auth, usage, now });
  const text = JSON.stringify(result);
  for (const privateValue of ['key-one', 'key-two', 'private-label', '12.345', 'usedPercent']) assert.ok(!text.includes(privateValue));
  assert.equal(result.openference.state, 'headroom-observed');
});

test('missing/error responses are unknown rather than invented exhaustion', async () => {
  const result = await observeLiveQuota({ auth, now, usage: { fetchUsageApi: async () => ({ error: 'private-sentinel' }), fetchOpenferenceUsage: async () => { throw new Error('private-sentinel'); } } });
  assert.equal(result.go.state, 'unknown');
  assert.equal(result.go.accounts[0].state, 'unknown');
  assert.equal(result.openference.state, 'unknown');
  assert.ok(!JSON.stringify(result).includes('private-sentinel'));
});

test('Openference now reset invalidates usage without inventing a timestamp', async () => {
  for (const usedPercent of [0, 100]) {
    const result = await observeLiveQuota({ auth, now, usage: { ...usage, fetchOpenferenceUsage: async () => ({ windows: [{ usedPercent, resetsIn: 'now' }] }) } });
    assert.equal(result.openference.state, 'unknown');
    assert.equal(result.openference.nextResetAt, null);
    assert.equal(result.openference.recheckAt, null);
  }
  const blocked = await observeLiveQuota({ auth, now, usage: { ...usage, fetchOpenferenceUsage: async () => ({ windows: [{ usedPercent: 100, resetsIn: '1h' }, { usedPercent: 100, resetsIn: 'now' }] }) } });
  assert.equal(blocked.openference.state, 'exhausted');
  assert.equal(blocked.openference.nextResetAt, null);
  for (const resetsIn of ['0m', '1h', '1d']) {
    const result = await observeLiveQuota({ auth, now, usage: { ...usage, fetchOpenferenceUsage: async () => ({ windows: [{ usedPercent: 5, resetsIn }] }) } });
    assert.equal(result.openference.state, 'headroom-observed');
    assert.equal(result.openference.recheckAt, null);
  }
});

test('secret commands are not executed and configured key is included within account cap', async () => {
  const localAuth = { ...auth, loadAuthJson: () => ({ 'opencode-go-failover': { accounts: Array.from({ length: 20 }, (_, i) => ({ key: `alternate-${i}` })) } }) };
  const result = await observeLiveQuota({ auth: localAuth, usage, now });
  assert.equal(result.go.accounts.length, 8);
  assert.equal(result.go.accounts[0].matchesConfiguredProviderKey, true);
  const noAuth = { loadAuthJson: () => ({ 'opencode-go-failover': { accounts: [{ key: '!unsafe-command' }] } }), authCredential: () => undefined, resolveAuthValue: () => undefined };
  const missing = await observeLiveQuota({ auth: noAuth, usage, now });
  assert.deepEqual(missing.go.accounts, []);
});

test('live helper invocation is bounded and failures disclose no diagnostics', () => {
  assert.deepEqual(fetchLiveQuota('/trusted/root', { run: (command, args, options) => {
    assert.equal(command, process.execPath);
    assert.deepEqual(args, ['/trusted/root/bin/capacity-live.js']);
    assert.equal(options.timeout, 25000);
    assert.equal(options.maxBuffer, 64 * 1024);
    return { status: 1, stderr: 'private-sentinel' };
  } }), {});
});

test('failed live query replaces stale snapshot with explicit unknown, only on local paths', () => {
  const view = { observedMachine: 'a', paths: [{ machine: 'a', provider: 'opencode-go', quota: { state: 'exhausted' } }, { machine: 'b', provider: 'opencode-go', quota: { state: 'exhausted' } }] };
  applyLiveQuota(view, {});
  assert.equal(view.paths[0].quota.state, 'unknown');
  assert.equal(view.paths[0].quota.reason, 'live-observation-unavailable');
  assert.equal(view.paths[1].quota.state, 'exhausted');
});

test('incomplete reset forecasts still expire at the known account reset', async () => {
  const live = await observeLiveQuota({ auth, now, usage: { ...usage, fetchUsageApi: async () => ({ rolling: { usagePercent: 100, resetInSec: 3600 } }) } });
  assert.equal(live.go.nextResetAt, null);
  assert.equal(live.go.recheckAt, new Date(now + 3600000).toISOString());
  const inventory = { schemaVersion: 1, paths: [{ id: 'go', machine: 'local', subscription: 'opencode-go', accountRef: null, harness: 'pi', provider: 'opencode-go', catalog: 'pi', quotaPath: 'go', constraints: [] }] };
  const view = applyLiveQuota(buildCapacityView(inventory, { machine: 'host-a', now }), live);
  const merged = mergeObservations([view], { now: now + 3600000 });
  assert.equal(merged.paths[0].quota.state, 'unknown');
  assert.ok(merged.paths[0].quota.accounts.every(account => account.state === 'unknown'));
});

test('account summaries survive merging but become unknown when stale', async () => {
  const live = await observeLiveQuota({ auth, usage, now });
  const inventory = { schemaVersion: 1, paths: [{ id: 'go', machine: 'local', subscription: 'opencode-go', accountRef: null, harness: 'pi', provider: 'opencode-go', catalog: 'pi', quotaPath: 'go', constraints: [] }] };
  const view = applyLiveQuota(buildCapacityView(inventory, { machine: 'host-a', now }), live);
  const fresh = mergeObservations([view], { now });
  assert.equal(fresh.paths[0].quota.accounts[1].state, 'headroom-observed');
  const stale = mergeObservations([view], { now: now + 7 * 3600000 });
  assert.equal(stale.paths[0].quota.accounts[1].state, 'unknown');
});

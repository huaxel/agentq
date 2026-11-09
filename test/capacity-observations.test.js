'use strict';
const assert = require('node:assert/strict');
const test = require('node:test');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { buildCapacityView } = require('../src/lib/capacity-view.js');
const { mergeObservations } = require('../src/lib/capacity-observations.js');
const now = Date.parse('2026-10-06T12:00:00Z');
const inventory = { schemaVersion: 1, paths: [{ id: 'pi-codex', machine: 'local', subscription: 'codex', accountRef: null, harness: 'pi', provider: 'openai-codex', catalog: 'pi', quotaPath: 'codex', constraints: [] }] };
function report(machine, time = now) {
  return buildCapacityView(inventory, { machine, now: time, installed: new Set(['pi']), piModels: [{ provider: 'openai-codex', id: 'one', reasoning: true, images: false }], snapshot: { paths: { codex: { updatedAt: new Date(time).toISOString(), windows: [{ usedPercent: 1 }] } } } });
}

test('local inventory resolves relative to observer and host execution keys differ', () => {
  const merged = mergeObservations([report('host-a'), report('host-b')], { now });
  assert.deepEqual(merged.paths.map(p => p.machine), ['host-a', 'host-b']);
  assert.notEqual(merged.paths[0].executionKey, merged.paths[1].executionKey);
  assert.equal(merged.paths[0].quota.bucket, merged.paths[1].quota.bucket);
  assert.equal(merged.paths[0].quota.accountResolved, false);
});

test('newest whole host observation replaces old rows, including absent paths', () => {
  const old = report('host-a', now - 1000);
  const fresh = report('host-a');
  fresh.paths = [];
  assert.equal(mergeObservations([fresh, old], { now }).paths.length, 0);
});

test('host cannot attest another host by copying its inventory rows', () => {
  const a = report('host-a');
  a.paths.push(report('host-b').paths[0]);
  assert.deepEqual(mergeObservations([a], { now }).paths.map(p => p.machine), ['host-a']);
});

test('stale host data becomes unknown rather than remaining configured', () => {
  const merged = mergeObservations([report('host-a', now - 7 * 3600000)], { now });
  const p = merged.paths[0];
  assert.equal(p.access, 'unknown');
  assert.equal(p.models, null);
  assert.equal(p.quota.state, 'unknown');
  assert.equal(p.observation.freshness, 'stale');
});

test('fresh report does not freshen an aged underlying quota observation', () => {
  const a = report('host-a');
  a.paths[0].quota.observedAt = new Date(now - 7 * 3600000).toISOString();
  const merged = mergeObservations([a], { now });
  assert.equal(merged.paths[0].access, 'configured');
  assert.equal(merged.paths[0].quota.state, 'unknown');
});

test('fresh report does not freshen old native auth but preserves missing executable facts', () => {
  const a = report('host-a');
  const p = a.paths[0];
  p.selection = 'native-catalog';
  p.nativeObservedAt = new Date(now - 7 * 3600000).toISOString();
  p.authentication = { state: 'authenticated', mode: 'subscription', source: 'codex-login-status' };
  assert.equal(mergeObservations([a], { now }).paths[0].authentication.state, 'unknown');
  p.access = 'unavailable';
  p.accessReason = 'executable-not-found';
  p.nativeObservedAt = null;
  assert.equal(mergeObservations([a], { now }).paths[0].access, 'unavailable');
});

test('past reset invalidates a previously exhausted quota summary', () => {
  const a = report('host-a');
  a.paths[0].quota.state = 'exhausted';
  a.paths[0].quota.nextResetAt = new Date(now - 1).toISOString();
  assert.equal(mergeObservations([a], { now }).paths[0].quota.state, 'unknown');
});

test('unknown imported fields and raw quota data are discarded', () => {
  const a = report('host-a');
  a.credentials = 'private-sentinel';
  a.paths[0].quota.usedPercent = 12.345;
  a.paths[0].collectorError = 'private-sentinel';
  const output = JSON.stringify(mergeObservations([a], { now }));
  assert.ok(!output.includes('private-sentinel'));
  assert.ok(!output.includes('12.345'));
});

test('supported metadata remains data, with an explicit trusted-input warning', () => {
  const a = report('host-a');
  a.paths[0].constraints = ['operator-provided-metadata'];
  const merged = mergeObservations([a], { now });
  assert.deepEqual(merged.paths[0].constraints, ['operator-provided-metadata']);
  assert.ok(merged.warnings.some(w => w.includes('not secret-scrubbed')));
});

test('future dates, ambiguous machine IDs and conflicting reports are rejected', () => {
  assert.throws(() => mergeObservations([report('local')], { now }), /concrete machine/);
  assert.throws(() => mergeObservations([report('host-a', now + 5001)], { now }), /Future/);
  const a = report('host-a');
  const b = report('host-a');
  b.paths[0].access = 'unavailable';
  assert.throws(() => mergeObservations([a, b], { now }), /Conflicting/);
  assert.throws(() => mergeObservations([{ schemaVersion: 1, paths: [] }], { now }), /Invalid/);
});

test('small host clock skew is explicit and tolerated consistently for source ages', () => {
  const merged = mergeObservations([report('host-a', now + 1000)], { now });
  assert.equal(merged.observations[0].clockSkew, 'small-future-within-tolerance');
  assert.equal(merged.paths[0].quota.state, 'headroom-observed');
  assert.throws(() => mergeObservations([report('host-a', now + 1)], { now, maxClockSkewMs: 0 }), /Future/);
});

test('import order is deterministic and identical reports deduplicate', () => {
  const a = report('host-a');
  const b = report('host-b');
  assert.deepEqual(mergeObservations([a, b, a], { now }), mergeObservations([b, a], { now }));
});

test('merge CLI reads only reports even if inventory/quota do not exist', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'capacity-merge-'));
  try {
    const file = path.join(dir, 'host.json');
    const live = report('host-a', Date.now());
    fs.writeFileSync(file, JSON.stringify(live));
    const output = execFileSync(process.execPath, [path.join(__dirname, '../bin/capacity.js'), '--merge', file, '--inventory', '/does/not/exist', '--quota', '/does/not/exist'], { encoding: 'utf8', env: { ...process.env, PATH: '' } });
    assert.equal(JSON.parse(output).paths[0].machine, 'host-a');
    assert.deepEqual(fs.readdirSync(dir), ['host.json']);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

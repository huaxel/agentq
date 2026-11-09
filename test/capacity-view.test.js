'use strict';
const assert = require('node:assert/strict');
const test = require('node:test');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { parsePiCatalog, summarizeQuota, buildCapacityView } = require('../src/lib/capacity-view.js');
const now = Date.parse('2026-10-06T12:00:00Z');
const entry = windows => ({ paths: { codex: { updatedAt: new Date(now).toISOString(), windows } } });
const descriptor = (id, overrides = {}) => ({ id, machine: 'local', subscription: 'codex', accountRef: null, harness: 'pi', provider: 'openai-codex', catalog: 'pi', quotaPath: 'codex', constraints: [], ...overrides });
const inventory = (...paths) => ({ schemaVersion: 1, paths });
const piModels = [{ provider: 'openai-codex', id: 'model-one', reasoning: true, images: false }];

test('catalog retains spaces and observed capabilities, ignoring chatter', () => {
  assert.deepEqual(parsePiCatalog('[provider] loaded\nprovider  model  context  max-out  thinking  images\nopenference  Qwen3.8 27b  262K  65K  yes  no'), [{ provider: 'openference', id: 'Qwen3.8 27b', reasoning: true, images: false }]);
});

test('any exhausted simultaneous limit blocks the aggregate', () => {
  const q = summarizeQuota(entry([{ usedPercent: 1 }, { usedPercent: 100 }]), 'codex', { now });
  assert.equal(q.state, 'exhausted');
  assert.equal(q.accountResolved, false);
  assert.equal(q.modelResolved, false);
});

test('past reset, missing data, invalid usage and stale observation are unknown', () => {
  for (const snapshot of [null, entry([]), entry([null]), entry([{ usedPercent: -1 }]), entry([{ usedPercent: null }]), entry([{ usedPercent: 100, resetsAt: new Date(now - 1).toISOString() }])]) {
    assert.equal(summarizeQuota(snapshot, 'codex', { now }).state, 'unknown');
  }
  const stale = entry([{ usedPercent: 1 }]);
  stale.paths.codex.updatedAt = '2000-01-01';
  assert.equal(summarizeQuota(stale, 'codex', { now }).freshness, 'stale');
});

test('quota summary exposes neither percentages nor arbitrary collector data', () => {
  const snapshot = entry([{ usedPercent: 12.345, secret: 'private-sentinel' }]);
  snapshot.paths.codex.secret = 'private-sentinel';
  const serialized = JSON.stringify(summarizeQuota(snapshot, 'codex', { now }));
  assert.ok(!serialized.includes('12.345'));
  assert.ok(!serialized.includes('private-sentinel'));
  assert.equal(JSON.parse(serialized).state, 'headroom-observed');
});

test('blocked reset summary uses the latest simultaneous reset', () => {
  const q = summarizeQuota(entry([{ usedPercent: 100, resetsAt: '2026-10-06T13:00:00Z' }, { usedPercent: 100, resetsAt: '2026-10-07T13:00:00Z' }]), 'codex', { now });
  assert.equal(q.nextResetAt, '2026-10-07T13:00:00.000Z');
});

test('earliest observed reset bounds recheck independently of aggregate recovery', () => {
  const quota = summarizeQuota(entry([{ usedPercent: 5, resetsAt: '2026-10-06T13:00:00Z' }, { usedPercent: 10, resetsAt: '2026-10-07T13:00:00Z' }]), 'codex', { now });
  assert.equal(quota.state, 'headroom-observed');
  assert.equal(quota.nextResetAt, null);
  assert.equal(quota.recheckAt, '2026-10-06T13:00:00.000Z');
});

test('incomplete or unknown blocking resets cannot imply full recovery', () => {
  const known = { usedPercent: 100, resetsAt: '2026-10-06T13:00:00Z' };
  for (const other of [{ usedPercent: 100 }, { usedPercent: 100, resetsAt: 'invalid' }, null, { usedPercent: null }, { usedPercent: 100, resetsAt: '2026-10-06T11:00:00Z' }]) {
    const quota = summarizeQuota(entry([known, other]), 'codex', { now });
    assert.equal(quota.state, 'exhausted');
    assert.equal(quota.nextResetAt, null);
  }
});

test('Pi catalog access does not imply native authentication or selectable models', () => {
  const view = buildCapacityView(inventory(descriptor('pi'), descriptor('native', { harness: 'codex', catalog: 'native' })), { now, piModels, installed: new Set(['pi', 'codex']), snapshot: entry([{ usedPercent: 2 }]) });
  assert.equal(view.paths[0].access, 'configured');
  assert.equal(view.paths[1].access, 'unknown');
  assert.equal(view.paths[1].models, null);
  assert.equal(view.paths[0].quota.bucket, view.paths[1].quota.bucket);
});

test('remote paths do not inherit local auth, executables or quota', () => {
  const view = buildCapacityView(inventory(descriptor('remote', { machine: 'other-host' })), { now, piModels, installed: new Set(['pi']), snapshot: entry([{ usedPercent: 2 }]) });
  assert.equal(view.paths[0].accessReason, 'machine-not-observed');
  assert.equal(view.paths[0].quota.state, 'unknown');
  assert.equal(view.paths[0].models, null);
});

test('missing executable is unavailable, missing catalog is unknown, native auto is explicit', () => {
  assert.equal(buildCapacityView(inventory(descriptor('pi')), { now }).paths[0].access, 'unavailable');
  assert.equal(buildCapacityView(inventory(descriptor('pi')), { now, installed: new Set(['pi']) }).paths[0].access, 'unknown');
  assert.equal(buildCapacityView(inventory(descriptor('copilot', { harness: 'copilot', catalog: 'native-auto' })), { now, installed: new Set(['copilot']) }).paths[0].selection, 'native-auto');
});

test('unparseable catalog is unknown, not unavailable', () => {
  // A CLI format drift must not assert the provider is absent: an empty
  // parse is an unobserved catalog, while a parsed catalog that genuinely
  // lacks the provider stays unavailable.
  assert.equal(parsePiCatalog('new format without double spaces\n'), null);
  const unknown = buildCapacityView(inventory(descriptor('pi')), { now, installed: new Set(['pi']), snapshot: entry([{ usedPercent: 2 }]), piModels: null });
  assert.equal(unknown.paths[0].access, 'unknown');
  const parsed = buildCapacityView(inventory(descriptor('pi')), { now, installed: new Set(['pi']), snapshot: entry([{ usedPercent: 2 }]), piModels });
  assert.equal(parsed.paths[0].access, 'configured');
});

test('collector error windows neither block nor grant aggregate headroom', () => {
  // A dead sub-account marker (error:sub-2 at 100%) must not block a
  // healthy sibling sub under failover; with only error markers left
  // there is no usable observation at all.
  const mixed = [{ usedPercent: 8, resetsAt: '2026-10-07T13:00:00Z' }, { label: 'error:sub-2', usedPercent: 100, resetsAt: null }];
  assert.equal(summarizeQuota(entry(mixed), 'codex', { now }).state, 'headroom-observed');
  assert.equal(summarizeQuota(entry([{ label: 'error:sub-1', usedPercent: 100 }]), 'codex', { now }).state, 'unknown');
});

test('duplicate inventory IDs are rejected', () => {
  assert.throws(() => buildCapacityView(inventory(descriptor('same'), descriptor('same'))), /Invalid or duplicate/);
});

test('offline CLI is read-only and redacts malformed private quota errors', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'capacity-view-'));
  try {
    const config = path.join(dir, 'inventory.json');
    const quota = path.join(dir, 'quota.json');
    fs.writeFileSync(config, JSON.stringify(inventory(descriptor('pi'))));
    const output = execFileSync(process.execPath, [path.join(__dirname, '../bin/capacity.js'), '--offline', '--inventory', config, '--quota', quota], { encoding: 'utf8' });
    assert.equal(JSON.parse(output).purpose, 'facts-for-agent-reasoning-not-dispatch-policy');
    assert.deepEqual(fs.readdirSync(dir), ['inventory.json']);
    fs.writeFileSync(quota, 'private-sentinel INVALID JSON');
    assert.throws(() => execFileSync(process.execPath, [path.join(__dirname, '../bin/capacity.js'), '--offline', '--inventory', config, '--quota', quota], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }), error => !error.stderr.includes('private-sentinel'));
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const {
  syncToGit,
  freshEnough,
  reuseFreshBundle,
  shouldSyncGit,
  collectionMode,
  hasUsableGraphResult,
  assignRecordIds,
} = require('../src/roi-tracker/collect/machine.js');

function tmpdir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'collect-machine-'));
}

function git(cwd, args) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: 'pipe' }).trim();
}

test('collect --help documents the local-only default without scanning', () => {
  const script = require.resolve('../src/roi-tracker/collect/machine.js');
  const output = execFileSync(process.execPath, [script, '--help'], {
    encoding: 'utf8',
    timeout: 5_000,
  });
  assert.match(output, /Usage: npm run collect/);
  assert.match(output, /Git synchronization is off by default/);
});

function initRepo(cwd) {
  fs.mkdirSync(cwd, { recursive: true });
  git(cwd, ['init', '-q', '-b', 'main']);
  git(cwd, ['config', 'user.email', 'test@example.test']);
  git(cwd, ['config', 'user.name', 'Test']);
}

// Two "machines" cloned from the same bare remote, both about to sync a
// conflicting change to the exact same file — the scenario that leaves
// .git/rebase-merge behind if the rebase-abort recovery isn't in place.
function makeConflictingMachines(root) {
  const bare = path.join(root, 'remote.git');
  fs.mkdirSync(bare, { recursive: true });
  git(bare, ['init', '-q', '--bare', '-b', 'main']);

  const seed = path.join(root, 'seed');
  initRepo(seed);
  fs.mkdirSync(path.join(seed, 'data', 'usage-imports'), { recursive: true });
  const relFile = 'data/usage-imports/shared.json';
  fs.writeFileSync(path.join(seed, relFile), '{"line": "base"}\n');
  git(seed, ['add', '.']);
  git(seed, ['commit', '-q', '-m', 'seed']);
  git(seed, ['remote', 'add', 'origin', bare]);
  git(seed, ['push', '-q', 'origin', 'main']);

  const machineA = path.join(root, 'machineA');
  const machineB = path.join(root, 'machineB');
  git(root, ['clone', '-q', bare, machineA]);
  git(root, ['clone', '-q', bare, machineB]);
  for (const m of [machineA, machineB]) {
    git(m, ['config', 'user.email', 'test@example.test']);
    git(m, ['config', 'user.name', 'Test']);
  }
  return { machineA, machineB, relFile };
}

test('daily tokscale mode is recognized as one provider-aware graph scan', () => {
  assert.deepEqual(collectionMode([], {}), { tokscale: false, graph: false });
  assert.deepEqual(collectionMode(['--tokscale'], {}), { tokscale: true, graph: false });
  assert.deepEqual(collectionMode(['--tokscale', '--daily'], {}), { tokscale: true, graph: true });
  assert.deepEqual(collectionMode([], { VALUE_RUN_SOURCE: 'tokscale-graph' }), {
    tokscale: true,
    graph: true,
  });
});

test('usage record IDs are deterministic and distinguish repeated equal rows', () => {
  const rows = [
    { date: '2026-08-09', model: 'same', inputTokens: 1, cost: 0.5 },
    { date: '2026-08-09', model: 'same', inputTokens: 1, cost: 0.5 },
  ];
  const first = assignRecordIds('host-a', rows, () => 'usage');
  const second = assignRecordIds('host-a', rows, () => 'usage');

  assert.deepEqual(first, second);
  assert.notEqual(first[0].recordId, first[1].recordId);
  assert.match(first[0].recordId, /^[a-f0-9]{24}$/);
  const repaired = assignRecordIds('host-a', [{ ...rows[0], recordId: 123 }], () => 'usage');
  assert.match(repaired[0].recordId, /^[a-f0-9]{24}$/);
});

test('graph mode skips fallback only for dated model data', () => {
  assert.equal(hasUsableGraphResult(null), false);
  assert.equal(hasUsableGraphResult({ models: {}, records: [] }), false);
  assert.equal(hasUsableGraphResult({ models: { m: {} }, records: [{ date: null }] }), false);
  assert.equal(
    hasUsableGraphResult({ models: { m: {} }, records: [{ date: '2026-08-01' }] }),
    true,
  );
});

test('git synchronization is off by default and requires an explicit flag', () => {
  assert.equal(shouldSyncGit([]), false);
  assert.equal(shouldSyncGit(['--tokscale', '--daily']), false);
  assert.equal(shouldSyncGit(['--sync-git']), true);
  assert.equal(shouldSyncGit(['--sync-git', '--no-git']), false);
});

test('syncToGit recovers from a conflicting rebase instead of leaving the repo wedged', () => {
  const root = tmpdir();
  const { machineA, machineB, relFile } = makeConflictingMachines(root);

  // machineA changes the shared file and syncs first — clean push, no rebase needed.
  fs.writeFileSync(path.join(machineA, relFile), '{"line": "from-A"}\n');
  syncToGit(relFile, machineA);
  assert.equal(git(machineA, ['status', '--porcelain']), '', 'machineA should be clean after sync');

  // machineB, unaware of A's push, changes the SAME line differently and syncs —
  // this creates a real rebase conflict when it pulls A's commit.
  fs.writeFileSync(path.join(machineB, relFile), '{"line": "from-B"}\n');
  syncToGit(relFile, machineB);

  // The repo must not be left mid-rebase.
  assert.equal(fs.existsSync(path.join(machineB, '.git', 'rebase-merge')), false,
    'machineB should not be stuck in an in-progress rebase');
  assert.equal(fs.existsSync(path.join(machineB, '.git', 'rebase-apply')), false,
    'machineB should not be stuck in an in-progress rebase (apply variant)');

  // machineB's own git commands must work normally afterward (proving it's
  // not wedged) — status should report a clean tree with its local commit intact.
  assert.equal(git(machineB, ['status', '--porcelain']), '', 'machineB should be usable after the aborted rebase');
  const log = git(machineB, ['log', '--oneline', '-1']);
  assert.match(log, /usage: /, 'machineB\'s local commit should still exist (not lost by the abort)');
});

test('freshEnough ignores a bundle collected for a different --since window', () => {
  const root = tmpdir();
  const bundlePath = path.join(root, 'bundle.json');
  fs.writeFileSync(bundlePath, JSON.stringify({ generatedAt: new Date().toISOString(), since: '20260501' }));

  assert.equal(freshEnough(bundlePath, 15, '20260501'), true, 'same since window should be reusable');
  assert.equal(freshEnough(bundlePath, 15, '20260701'), false, 'a different since window must not be reused');
});

test('an explicit sync is honored when a fresh bundle skips collection', () => {
  const root = tmpdir();
  const bundlePath = path.join(root, 'bundle.json');
  fs.writeFileSync(bundlePath, JSON.stringify({
    generatedAt: new Date().toISOString(),
    since: '20260501',
  }));
  const synced = [];
  const options = {
    bundlePath,
    maxAgeMin: 15,
    since: '20260501',
    rel: 'data/usage-imports/test.json',
    sync: rel => synced.push(rel),
  };

  assert.equal(reuseFreshBundle([], options), true);
  assert.deepEqual(synced, []);
  assert.equal(reuseFreshBundle(['--sync-git'], options), true);
  assert.deepEqual(synced, ['data/usage-imports/test.json']);
});

test('freshEnough still honors max-age for a matching since window', () => {
  const root = tmpdir();
  const bundlePath = path.join(root, 'bundle.json');
  fs.writeFileSync(bundlePath, JSON.stringify({
    generatedAt: new Date(Date.now() - 60 * 60_000).toISOString(), // 1h old
    since: '20260501',
  }));

  assert.equal(freshEnough(bundlePath, 15, '20260501'), false, 'stale by age even with a matching window');
  assert.equal(freshEnough(bundlePath, 120, '20260501'), true, 'fresh enough within a longer max-age');
});

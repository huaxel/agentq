'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { executeJob } = require('../src/runners/execute.js');
const { SqliteSource, OrchestratorSource } = require('./helpers/pinned-issue.js');
const { emitResult, resultPayload } = require('./helpers/result-file.js');

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agentq-verification-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const repo = path.join(root, 'repo');
  fs.mkdirSync(repo);
  const git = (...args) => execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  git('init', '-b', 'main');
  fs.writeFileSync(path.join(repo, 'source.txt'), 'original\n');
  fs.writeFileSync(path.join(repo, '.gitignore'), 'generated/\n');
  git('add', '.');
  git('-c', 'user.name=AgentQ Test', '-c', 'user.email=agentq@example.test',
    '-c', 'commit.gpgsign=false', 'commit', '-m', 'fixture');
  return { root, repo, git };
}

function snapshot(repo, options) {
  return require('../src/runners/verification-evidence.js').captureGitSnapshot(repo, options);
}

for (const sandboxed of [false, true]) {
  for (const changesArtifact of [false, true]) {
    test(`verification binds the current Git-visible artifact (sandbox=${sandboxed}, mutation=${changesArtifact})`, async t => {
      const { root, repo } = fixture(t);
      const executor = path.join(root, 'executor');
      fs.writeFileSync(executor, '#!/bin/sh\nprintf "new implementation\\n" > new-source.txt\n', { mode: 0o755 });
      const sandbox = path.join(root, 'sandbox');
      fs.writeFileSync(sandbox, '#!/bin/sh\nexec "$@"\n', { mode: 0o755 });
      const source = new SqliteSource(path.join(root, 'queue.sqlite'));
      await source.enqueue({ repo, issue: '42', base: 'main', model: 'test/model', trusted: true });
      const verify = changesArtifact ? 'printf changed > source.txt' : 'test -f new-source.txt';
      const result = await executeJob(await source.claimNext(), {
        executor, verify, ...(sandboxed ? { sandbox } : {}),
      }, source);
      assert.equal(result.status, changesArtifact ? 'unverified' : 'succeeded');
      const [stored] = source.status();
      assert.equal(stored.verified, changesArtifact ? 0 : 1);
      const evidence = stored.verification;
      assert.equal(evidence.command, verify);
      assert.equal(evidence.exit_code, 0);
      assert.equal(evidence.before.available, true);
      assert.equal(evidence.after.available, true);
      assert.equal(evidence.artifact_unchanged, !changesArtifact);
      assert.deepEqual(evidence.after, snapshot(stored.worktree_path));
      source.requeue({ id: source.status()[0].id });
      assert.equal(source.status()[0].verification, null, 'do not retain stale evidence after requeue');
    });
  }
}

test('a managed checkout with unavailable identity cannot become verified', async t => {
  const { root, repo } = fixture(t);
  const executor = path.join(root, 'executor');
  fs.writeFileSync(executor, '#!/bin/sh\nmv .git .git-hidden\n', { mode: 0o755 });
  const source = new SqliteSource(path.join(root, 'queue.sqlite'));
  await source.enqueue({ repo, issue: '42', base: 'main', model: 'test/model', trusted: true });
  const result = await executeJob(await source.claimNext(), { executor, verify: 'true' }, source);
  assert.equal(result.status, 'unverified');
  assert.equal(source.status()[0].verified, 0);
  assert.equal(source.status()[0].verification.before.available, false);
});

test('legacy non-Git verification remains explicitly unbound rather than fabricating an identity', async t => {
  const { root } = fixture(t);
  const repo = path.join(root, 'plain');
  fs.mkdirSync(repo);
  const executor = path.join(root, 'executor');
  fs.writeFileSync(executor, `#!/bin/sh\n${emitResult(root, resultPayload({ worktree: repo }))}\n`, { mode: 0o755 });
  const source = new SqliteSource(path.join(root, 'queue.sqlite'));
  await source.enqueue({ repo, issue: '42', base: 'main', model: 'test/model', trusted: true });
  const result = await executeJob(await source.claimNext(), { executor, verify: 'true' }, source);
  assert.equal(result.status, 'succeeded');
  const evidence = source.status()[0].verification;
  assert.equal(evidence.before.available, false);
  assert.equal(evidence.after.available, false);
  assert.equal(evidence.artifact_unchanged, null);
});

test('snapshot distinguishes tracked, staged, untracked and executable changes without index writes', t => {
  const { repo, git } = fixture(t);
  const index = path.join(repo, '.git', 'index');
  const baseline = snapshot(repo);
  assert.equal(baseline.available, true);
  assert.equal(baseline.head, git('rev-parse', 'HEAD').trim());
  const originalIndex = fs.readFileSync(index);
  assert.deepEqual(snapshot(repo), baseline);
  assert.deepEqual(fs.readFileSync(index), originalIndex);
  fs.writeFileSync(path.join(repo, 'source.txt'), 'changed\n');
  const unstaged = snapshot(repo);
  assert.notEqual(unstaged.digest, baseline.digest);
  git('add', 'source.txt');
  const staged = snapshot(repo);
  assert.notEqual(staged.digest, unstaged.digest);
  fs.writeFileSync(path.join(repo, 'new.txt'), Buffer.from([0, 255, 10]));
  const untracked = snapshot(repo);
  assert.notEqual(untracked.digest, staged.digest);
  fs.chmodSync(path.join(repo, 'new.txt'), 0o755);
  const executable = snapshot(repo);
  assert.notEqual(executable.digest, untracked.digest);
  fs.unlinkSync(path.join(repo, 'source.txt'));
  assert.notEqual(snapshot(repo).digest, executable.digest);
});

test('snapshot excludes ignored outputs and hashes symlink targets without following them', t => {
  const { root, repo } = fixture(t);
  const before = snapshot(repo);
  fs.mkdirSync(path.join(repo, 'generated'));
  fs.writeFileSync(path.join(repo, 'generated', 'cache'), 'ignored');
  assert.deepEqual(snapshot(repo), before);
  const outside = path.join(root, 'outside');
  fs.writeFileSync(outside, 'external bytes');
  fs.symlinkSync(outside, path.join(repo, 'link'));
  const linked = snapshot(repo);
  assert.equal(linked.available, true);
  fs.writeFileSync(outside, 'different external bytes');
  assert.deepEqual(snapshot(repo), linked, 'do not read outside symlink targets');
});

test('snapshot rejects symlinked ancestors and never invokes filters or fsmonitor', t => {
  const { root, repo, git } = fixture(t);
  fs.mkdirSync(path.join(repo, 'nested'));
  fs.writeFileSync(path.join(repo, 'nested', 'source'), 'tracked');
  fs.writeFileSync(path.join(repo, '.gitattributes'), '* filter=canary\n');
  git('add', '.');
  const canary = path.join(root, 'unexpected-command');
  git('config', 'filter.canary.clean', `touch '${canary}'`);
  git('config', 'core.fsmonitor', `touch '${canary}'`);
  assert.equal(snapshot(repo).available, true);
  assert.equal(fs.existsSync(canary), false);
  const outside = path.join(root, 'outside');
  fs.mkdirSync(outside);
  fs.writeFileSync(path.join(outside, 'source'), 'do not read');
  fs.rmSync(path.join(repo, 'nested'), { recursive: true });
  fs.symlinkSync(outside, path.join(repo, 'nested'), 'dir');
  const rejected = snapshot(repo);
  assert.equal(rejected.available, false);
  assert.equal(rejected.reason, 'symlinked-ancestor');
  assert.equal(fs.existsSync(canary), false);
});

test('snapshot budgets reject oversized input before reading it', t => {
  const { repo } = fixture(t);
  assert.deepEqual(snapshot(repo, { maxFiles: 1 }), { available: false, reason: 'snapshot-too-large' });
  assert.deepEqual(snapshot(repo, { maxMs: 0 }), { available: false, reason: 'snapshot-timeout' });
  const large = path.join(repo, 'oversized.bin');
  fs.writeFileSync(large, '');
  fs.truncateSync(large, 128 * 1024 * 1024);
  let opened = false;
  const open = fs.openSync;
  t.mock.method(fs, 'openSync', (file, ...args) => {
    if (file === large) opened = true;
    return open(file, ...args);
  });
  assert.deepEqual(snapshot(repo), { available: false, reason: 'snapshot-too-large' });
  assert.equal(opened, false);
});

test('snapshot suppresses host excludes and attests local info/exclude policy', t => {
  const { root, repo, git } = fixture(t);
  const external = path.join(root, 'host-excludes');
  fs.writeFileSync(external, 'hidden.txt\n');
  git('config', 'core.excludesFile', external);
  fs.writeFileSync(path.join(repo, 'hidden.txt'), 'first');
  const before = snapshot(repo);
  assert.equal(before.available, true);
  fs.writeFileSync(path.join(repo, 'hidden.txt'), 'second');
  const changed = snapshot(repo);
  assert.notEqual(changed.digest, before.digest, 'local configuration must not import host excludes');
  fs.appendFileSync(path.join(repo, '.git', 'info', 'exclude'), '\nhidden.txt\n');
  const excluded = snapshot(repo);
  assert.equal(excluded.available, true);
  assert.notEqual(excluded.local_excludes_digest, changed.local_excludes_digest);
  assert.notEqual(excluded.digest, changed.digest);
});

test('snapshot rejects symlinked local ignore policy', t => {
  const { root, repo } = fixture(t);
  const policy = path.join(repo, '.git', 'info', 'exclude');
  fs.renameSync(policy, `${policy}.retained`);
  const outside = path.join(root, 'outside-policy');
  fs.writeFileSync(outside, 'external patterns must not be read');
  fs.symlinkSync(outside, policy);
  assert.deepEqual(snapshot(repo), { available: false, reason: 'symlinked-ignore-policy' });
});

test('snapshot ignores inherited Git directory, index and configuration overrides', t => {
  const { root, repo } = fixture(t);
  const foreign = fixture(t).repo;
  const baseline = snapshot(repo);
  const global = path.join(root, 'injected-config');
  fs.writeFileSync(global, '[core]\nexcludesFile = /does/not/exist\n');
  const overrides = {
    GIT_DIR: path.join(foreign, '.git'), GIT_WORK_TREE: foreign,
    GIT_INDEX_FILE: path.join(foreign, '.git', 'index'), GIT_CONFIG_GLOBAL: global,
    GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'core.excludesFile',
    GIT_CONFIG_VALUE_0: '/does/not/exist', GIT_CEILING_DIRECTORIES: root,
  };
  const saved = Object.fromEntries(Object.keys(overrides).map(key => [key, process.env[key]]));
  t.after(() => {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });
  Object.assign(process.env, overrides);
  assert.deepEqual(snapshot(repo), baseline);
});

test('snapshot supports Unicode directory names and rejects nested repositories explicitly', t => {
  const { repo } = fixture(t);
  const directory = path.join(repo, 'caf\u00e9');
  fs.mkdirSync(directory);
  fs.writeFileSync(path.join(directory, 'source'), 'Unicode input');
  assert.equal(snapshot(repo).available, true);
  execFileSync('git', ['init', '-q', path.join(repo, 'nested')], { stdio: 'ignore' });
  assert.deepEqual(snapshot(repo), { available: false, reason: 'unsupported-file-type' });
});

for (const transition of ['lose', 'gain']) {
  test(`legacy verification cannot ${transition} Git identity and remain verified`, async t => {
    const { root, repo } = fixture(t);
    const plain = path.join(root, 'plain');
    fs.mkdirSync(plain);
    const worktree = transition === 'lose' ? repo : plain;
    const executor = path.join(root, 'executor');
    fs.writeFileSync(executor, `#!/bin/sh\n${emitResult(root, resultPayload({ worktree }))}\n`, { mode: 0o755 });
    const source = new SqliteSource(path.join(root, 'queue.sqlite'));
    await source.enqueue({ repo: plain, issue: '42', base: 'main', model: 'test/model', trusted: true });
    const verify = transition === 'lose' ? 'mv .git .git-hidden'
      : 'git init -q -b main && git -c user.name=Test -c user.email=test@example.test -c commit.gpgsign=false commit -q --allow-empty -m fixture';
    const result = await executeJob(await source.claimNext(), { executor, verify }, source);
    assert.equal(result.status, 'unverified');
    const evidence = source.status()[0].verification;
    assert.equal(evidence.before.available, transition === 'lose');
    assert.equal(evidence.after.available, transition === 'gain');
    assert.equal(evidence.artifact_unchanged, false);
  });
}

test('orchestrator forwards verification evidence without altering it', async t => {
  const { root } = fixture(t);
  const source = new OrchestratorSource('http://127.0.0.1:1', 'test-worker', { logBase: path.join(root, 'logs'), worktreeBase: path.join(root, 'worktrees') });
  const evidence = { command: 'test', exit_code: 0, artifact_unchanged: true };
  let sent;
  source.worker.complete = async (id, result) => { sent = { id, result }; };
  await source.finish({ id: 'task-1' }, { status: 'succeeded', verification: evidence });
  assert.equal(sent.id, 'task-1');
  assert.deepEqual(sent.result.verification, evidence);
});

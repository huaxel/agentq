'use strict';
/**
 * W28: an optional setup command prepares a fresh job worktree before the
 * agent and the verify step run. Run with `npm test`.
 *
 * Sources, first set winning: `run --setup "CMD"`, then the repo's
 * `agentq.setup` git config. Setup runs once per managed worktree (again after a failed attempt); a failure ends the attempt as infra recovery (like a
 * worktree-creation failure), never as a model outcome.
 */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const { executeJob, runOnce, resolveSetupCommand } = require('../src/runners/execute.js');
const { parseArgs } = require('../src/interfaces/cli/agentq.js');
const { buildDispatchTools } = require('../src/interfaces/mcp/dispatch.js');
const { showTask } = require('../src/queue/task-detail.js');
const { formatTaskDetail } = require('../src/interfaces/cli/format.js');
const { SqliteSource } = require('./helpers/pinned-issue.js');
const { listTaskEvents } = require('../src/queue/db.js');

function workspace(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agentq-worktree-setup-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

function initRepo(root, name = 'repo') {
  const repo = path.join(root, name);
  fs.mkdirSync(repo, { recursive: true });
  execFileSync('git', ['init', '-q', '-b', 'main', repo]);
  execFileSync('git', ['-C', repo, 'config', 'user.email', 't@example.test']);
  execFileSync('git', ['-C', repo, 'config', 'user.name', 'T']);
  execFileSync('git', ['-C', repo, 'commit', '-q', '--allow-empty', '-m', 'init']);
  return repo;
}

function script(root, name, body) {
  const file = path.join(root, name);
  fs.writeFileSync(file, `#!/bin/sh\nset -eu\n${body}\n`, { mode: 0o755 });
  return file;
}

function openSource(t, root) {
  const source = new SqliteSource(path.join(root, 'queue.sqlite'));
  t.after(() => source.stop());
  return source;
}

async function runJob(t, root, repo, options) {
  const source = openSource(t, root);
  await source.enqueue({ repo, issue: '1', model: 'test/model', trusted: true });
  const job = await source.claimNext();
  const result = await executeJob(job, { executor: options.executor, ...options }, source);
  return { source, job, result };
}

function completedPayload(source, jobId) {
  const events = listTaskEvents(source.db, jobId);
  const completed = events.find((event) => event.event === 'completed');
  assert.ok(completed, 'expected a completed event');
  return JSON.parse(completed.payload);
}

test('a --setup command runs in the new worktree before the executor', async t => {
  const root = workspace(t);
  const repo = initRepo(root);
  const executor = script(root, 'executor.sh', `
    if [ ! -f node_modules/setup-done ]; then echo 'setup did not run first' >&2; exit 3; fi
    echo did-work > agent-output.txt
  `);
  const { source, job, result } = await runJob(t, root, repo, {
    executor,
    setup: 'mkdir -p node_modules && touch node_modules/setup-done',
  });
  assert.equal(result.status, 'succeeded');
  const [stored] = source.status();
  assert.equal(stored.status, 'succeeded');
  // The executor ran inside the managed worktree, not the source repo.
  assert.ok(stored.worktree_path && stored.worktree_path !== repo);
  assert.equal(fs.existsSync(path.join(repo, 'agent-output.txt')), false);
  assert.equal(fs.existsSync(path.join(stored.worktree_path, 'agent-output.txt')), true);
  // The job log carries the setup section with the command and exit code.
  const log = fs.readFileSync(source.sink.jobLogPath(job.id), 'utf8');
  assert.match(log, /--- setup ---/);
  assert.match(log, /mkdir -p node_modules && touch node_modules\/setup-done/);
  assert.match(log, /exit=0/);
  // The completed event payload records what ran, and `show` surfaces it.
  const payload = completedPayload(source, job.id);
  assert.equal(payload.setup.command, 'mkdir -p node_modules && touch node_modules/setup-done');
  assert.equal(payload.setup.exit_code, 0);
  const detail = formatTaskDetail(showTask(path.join(root, 'queue.sqlite'), job.id));
  assert.match(detail, /setup/);
});

test('the agentq.setup git config applies when --setup is absent', async t => {
  const root = workspace(t);
  const repo = initRepo(root);
  execFileSync('git', ['-C', repo, 'config', 'agentq.setup', 'touch from-config']);
  const executor = script(root, 'executor.sh', `
    if [ ! -f from-config ]; then echo 'git-config setup did not run' >&2; exit 3; fi
  `);
  const { result } = await runJob(t, root, repo, { executor });
  assert.equal(result.status, 'succeeded');
});

test('--setup overrides the agentq.setup git config', async t => {
  const root = workspace(t);
  const repo = initRepo(root);
  execFileSync('git', ['-C', repo, 'config', 'agentq.setup', 'touch from-config']);
  const executor = script(root, 'executor.sh', `
    if [ ! -f from-flag ]; then echo 'flag setup did not run' >&2; exit 3; fi
    if [ -f from-config ]; then echo 'git-config setup should not run' >&2; exit 4; fi
  `);
  const { result } = await runJob(t, root, repo, { executor, setup: 'touch from-flag' });
  assert.equal(result.status, 'succeeded');
});

test('resolveSetupCommand prefers the flag, then git config, then null', async t => {
  const root = workspace(t);
  const repo = initRepo(root);
  assert.equal(resolveSetupCommand({}, repo), null);
  assert.equal(resolveSetupCommand({}, path.join(root, 'missing')), null);
  execFileSync('git', ['-C', repo, 'config', 'agentq.setup', 'npm ci']);
  assert.equal(resolveSetupCommand({}, repo), 'npm ci');
  assert.equal(resolveSetupCommand({ setup: 'make setup' }, repo), 'make setup');
  // A blank flag is unset: the git config still applies.
  assert.equal(resolveSetupCommand({ setup: '   ' }, repo), 'npm ci');
});

test('a failing setup ends the attempt before the executor runs, as infra recovery', async t => {
  const root = workspace(t);
  const repo = initRepo(root);
  const executorRan = path.join(root, 'executor-ran');
  const executor = script(root, 'executor.sh', `touch '${executorRan}'\necho hi`);
  const source = openSource(t, root);
  await source.enqueue({ repo, issue: '1', model: 'test/model', trusted: true });
  const job = await source.claimNext();
  await assert.rejects(
    () => executeJob(job, { executor, setup: 'echo setup-output && exit 3' }, source),
    (err) => {
      assert.match(err.message, /Setup command "echo setup-output && exit 3" failed .* \(exit 3\)/);
      return true;
    },
  );
  // The executor never started.
  assert.equal(fs.existsSync(executorRan), false);
  // Infra recovery, exactly like a worktree-creation failure: the task is
  // re-pended (not finished), with a recovered event naming the failure.
  const [stored] = source.status();
  assert.equal(stored.status, 'pending');
  const events = listTaskEvents(source.db, job.id);
  const recovered = events.find((event) => event.event === 'recovered');
  assert.ok(recovered, 'expected a recovered event');
  assert.match(String(recovered.payload), /Setup command/);
  // Not a model failure: no path outcome was recorded against the model.
  assert.deepEqual(source.db.prepare('SELECT * FROM path_outcomes').all(), []);
  // The job log still shows the setup section and its exit code.
  const log = fs.readFileSync(source.sink.jobLogPath(job.id), 'utf8');
  assert.match(log, /--- setup ---/);
  assert.match(log, /setup-output/);
  assert.match(log, /exit=3/);
});

test('a reused worktree does not re-run setup', async t => {
  const root = workspace(t);
  const repo = initRepo(root);
  const calls = path.join(root, 'setup-calls');
  const executor = script(root, 'executor.sh', 'exit 0');
  const sink = {
    claim: async () => {},
    finish: async () => ({ completionId: null, status: 'succeeded' }),
    recover: async () => {},
    fireCallback: async () => {},
    jobLogPath: () => path.join(root, 'job.log'),
    worktreePath: () => path.join(root, 'wt'),
  };
  const job = { id: 1, kind: 'prompt', prompt: 'do work', repo_path: repo, model: 'test-model', base_branch: 'main' };
  const options = { executor, setup: `echo run >> '${calls}'` };
  await runOnce(job, options, { sink });
  await runOnce(job, options, { sink });
  assert.equal(fs.readFileSync(calls, 'utf8').trim().split('\n').length, 1);
});

test('a retry after a failed setup runs setup again before the executor', async t => {
  const root = workspace(t);
  const repo = initRepo(root);
  const calls = path.join(root, 'setup-calls');
  const flag = path.join(root, 'setup-ok');
  const executorSaw = path.join(root, 'executor-saw');
  const executor = script(root, 'executor.sh', `cat '${calls}' > '${executorSaw}'`);
  const sink = {
    claim: async () => {},
    finish: async () => ({ completionId: null, status: 'succeeded' }),
    recover: async () => {},
    fireCallback: async () => {},
    jobLogPath: () => path.join(root, 'job.log'),
    worktreePath: () => path.join(root, 'wt'),
  };
  const job = { id: 1, kind: 'prompt', prompt: 'do work', repo_path: repo, model: 'test-model', base_branch: 'main' };
  // Fails until the flag exists, like an install interrupted by a flaky network.
  const options = { executor, setup: `echo run >> '${calls}'; test -f '${flag}'` };
  await assert.rejects(() => runOnce(job, options, { sink }), /Setup command/);
  assert.equal(fs.existsSync(executorSaw), false);
  fs.writeFileSync(flag, '');
  await runOnce(job, options, { sink });
  // The kept worktree was set up again, then the executor ran.
  assert.equal(fs.readFileSync(executorSaw, 'utf8').trim().split('\n').length, 2);
  // And a third attempt, after the successful setup, skips it.
  await runOnce(job, options, { sink });
  assert.equal(fs.readFileSync(calls, 'utf8').trim().split('\n').length, 2);
});

test('no setup configured leaves the run unchanged', async t => {
  const root = workspace(t);
  const repo = initRepo(root);
  const executor = script(root, 'executor.sh', 'echo done');
  const { source, job, result } = await runJob(t, root, repo, { executor });
  assert.equal(result.status, 'succeeded');
  const log = fs.readFileSync(source.sink.jobLogPath(job.id), 'utf8');
  assert.doesNotMatch(log, /--- setup ---/);
  assert.equal(completedPayload(source, job.id).setup, null);
});

test('no setup runs for a non-git repo_path run in place', async t => {
  const root = workspace(t);
  const repo = path.join(root, 'plain');
  fs.mkdirSync(repo, { recursive: true });
  const executor = script(root, 'executor.sh', 'echo done');
  const { source, job, result } = await runJob(t, root, repo, { executor, setup: 'touch SHOULD-NOT-RUN' });
  assert.equal(result.status, 'succeeded');
  const log = fs.readFileSync(source.sink.jobLogPath(job.id), 'utf8');
  assert.doesNotMatch(log, /--- setup ---/);
  assert.equal(fs.existsSync(path.join(repo, 'SHOULD-NOT-RUN')), false);
  assert.equal(completedPayload(source, job.id).setup, null);
});

test('verify passes after a setup that created ignored files', async t => {
  const root = workspace(t);
  const repo = initRepo(root);
  const executor = script(root, 'executor.sh', 'echo done');
  const { source, result } = await runJob(t, root, repo, {
    executor,
    setup: 'mkdir -p node_modules && touch node_modules/setup-done',
    verify: 'test -f node_modules/setup-done',
  });
  assert.equal(result.status, 'succeeded');
  const [stored] = source.status();
  assert.equal(stored.verified, 1);
  // The setup's ignored files are preparation, not artifact changes.
  assert.equal(stored.verification.artifact_unchanged, true);
  assert.equal(stored.verification.command, 'test -f node_modules/setup-done');
});

test('dispatch_task rejects a setup argument', async t => {
  const noop = () => {};
  const tools = buildDispatchTools({
    getTask: noop,
    getCatalog: noop,
    getCapacity: noop,
    recommend: noop,
    recordTaskEvent: noop,
    blockingDependencies: noop,
    dispatchWorkers: noop,
    localTaskSources: noop,
    spawn: noop,
    cliPath: '/bin/agentq',
    dbPath: '/tmp/queue.sqlite',
    logsDir: '/tmp/logs',
  });
  const dispatch = tools.find((tool) => tool.name === 'dispatch_task');
  assert.throws(() => dispatch.handler({ id: 't1', setup: 'npm ci' }), /Unknown argument: setup/);
});

test('run-next, run and drain accept --setup', () => {
  assert.equal(parseArgs(['run-next', '--setup', 'npm ci']).options.setup, 'npm ci');
  assert.equal(parseArgs(['run', '--id', 'abc123', '--setup', 'npm ci']).options.setup, 'npm ci');
  assert.equal(parseArgs(['drain', '--setup', 'npm ci']).options.setup, 'npm ci');
});

'use strict';
/**
 * W22 commit policy: no-commit mode and a commit author per task.
 *
 * CLI: defaults by kind, --commit/--no-commit mutual exclusion,
 * --commit-author parsing, storage, and requeue keeping the policy.
 * MCP: commit accepted, author fields refused, defaults by kind.
 * Runner: author resolution order (task, repo git config, none) and the
 * executor environment (GIT_* + AGENTQ_COMMIT_MODE).
 * Executors: no-commit prompt line, unexpectedCommits warning + result field,
 * and the author identity on agent-mode commits (fake agent on PATH).
 */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync, spawnSync } = require('node:child_process');

const { githubEnv, taskInputForIssue } = require('./helpers/pinned-issue.js');
const { ownStderr } = require('./helpers/stderr.js');
const { SqliteSource } = require('./helpers/pinned-issue.js');
const {
  executeJob, commitPolicyOf, resolveCommitAuthor,
} = require('../src/runners/execute.js');
const {
  validateResultFile, readResultFile,
} = require('../src/runners/result-file.js');
const { buildWriteTools } = require('../src/interfaces/mcp/write-tools.js');
const dbModule = require('../src/queue/db.js');

const AGENTQ = require.resolve('../src/interfaces/cli/agentq.js');
const ROOT = path.join(__dirname, '..');
const PI_TASK = path.join(ROOT, 'pi-task.sh');
const PI_WORKFLOW = path.join(ROOT, 'pi-workflow.sh');
const CLAUDE_TASK = path.join(ROOT, 'claude-task.sh');

function tmpdir(prefix = 'agentq-commit-policy-') {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function makeRepo(root) {
  const repo = path.join(root, 'repo');
  fs.mkdirSync(repo, { recursive: true });
  return repo;
}

function makeGitRepo(root) {
  const repo = makeRepo(root);
  execFileSync('git', ['-C', repo, 'init', '-b', 'master'], { stdio: 'ignore' });
  execFileSync('git', ['-C', repo, 'config', 'user.email', 'owner@example.test'], { stdio: 'ignore' });
  execFileSync('git', ['-C', repo, 'config', 'user.name', 'Repo Owner'], { stdio: 'ignore' });
  fs.writeFileSync(path.join(repo, 'README.md'), 'test\n');
  execFileSync('git', ['-C', repo, 'add', '.'], { stdio: 'ignore' });
  execFileSync('git', ['-C', repo, 'commit', '-m', 'init'], { stdio: 'ignore' });
  return repo;
}

/** A linked worktree, like the ones agentq hands the executor. */
function addLinkedWorktree(repo, name = 'reused-worktree', branch = name) {
  const worktree = path.join(path.dirname(repo), name);
  execFileSync('git', ['-C', repo, 'worktree', 'add', '-b', branch, worktree, 'master'], { stdio: 'ignore' });
  return worktree;
}

function run(args, env = {}) {
  try {
    const stdout = execFileSync(process.execPath, [AGENTQ, ...args], {
      encoding: 'utf8',
      env: { ...process.env, AGENTQ_QUOTA_REFRESH: '0', ...githubEnv(), ...env },
      timeout: 30_000,
    });
    return { exitCode: 0, stdout, stderr: '' };
  } catch (err) {
    return {
      exitCode: err.status ?? 1,
      stdout: err.stdout || '',
      stderr: err.stderr || '',
    };
  }
}

function openDb(dbPath) {
  const db = dbModule.openDb(dbPath);
  dbModule.initSchema(db);
  return db;
}

function storedPolicy(dbPath, id) {
  const db = openDb(dbPath);
  try {
    const row = dbModule.getTask(db, id);
    assert.ok(row, 'task exists');
    assert.ok(row.execution_policy, 'execution_policy column is stored');
    return JSON.parse(row.execution_policy);
  } finally {
    db.close();
  }
}

// --- CLI ---

test('CLI: an issue task defaults to agent commits', () => {
  const root = tmpdir();
  const repo = makeRepo(root);
  const db = path.join(root, 'jobs.sqlite');

  const enqueued = run(['--db', db, 'enqueue', '--repo', repo, '--issue', '7', '--model', 'm', '--json']);
  assert.equal(enqueued.exitCode, 0, enqueued.stderr);
  const { id } = JSON.parse(enqueued.stdout);
  assert.deepEqual(storedPolicy(db, id), { commit: 'agent', author: null });
});

test('CLI: a spec task defaults to no-commit', () => {
  const root = tmpdir();
  const repo = makeRepo(root);
  const db = path.join(root, 'jobs.sqlite');
  const spec = path.join(root, 'spec.md');
  fs.writeFileSync(spec, '# Local spec\n\nDo the work.\n');

  const enqueued = run(['--db', db, 'enqueue', '--repo', repo, '--spec', spec, '--model', 'm', '--json']);
  assert.equal(enqueued.exitCode, 0, enqueued.stderr);
  const { id } = JSON.parse(enqueued.stdout);
  assert.deepEqual(storedPolicy(db, id), { commit: 'none', author: null });
});

test('CLI: --commit and --no-commit together are refused', () => {
  const root = tmpdir();
  const repo = makeRepo(root);
  const db = path.join(root, 'jobs.sqlite');

  const refused = run(['--db', db, 'enqueue', '--repo', repo, '--issue', '7', '--commit', '--no-commit', '--json']);
  assert.notEqual(refused.exitCode, 0);
  assert.match(refused.stderr, /--commit.*--no-commit|--no-commit.*--commit/);
});

test('CLI: --commit-author is parsed and stored; a malformed value is refused', () => {
  const root = tmpdir();
  const repo = makeRepo(root);
  const db = path.join(root, 'jobs.sqlite');

  const enqueued = run([
    '--db', db, 'enqueue', '--repo', repo, '--issue', '7', '--model', 'm',
    '--commit-author', 'Agent Q <agentq@example.test>', '--json',
  ]);
  assert.equal(enqueued.exitCode, 0, enqueued.stderr);
  const { id } = JSON.parse(enqueued.stdout);
  assert.deepEqual(storedPolicy(db, id), {
    commit: 'agent', author: { name: 'Agent Q', email: 'agentq@example.test' },
  });

  for (const bad of ['no-brackets', 'Name <not-an-email>', '<noname@example.test>', 'Name <a@b@c>']) {
    const refused = run([
      '--db', db, 'enqueue', '--repo', repo, '--issue', '7', '--model', 'm',
      '--commit-author', bad, '--json',
    ]);
    assert.notEqual(refused.exitCode, 0, `expected refusal for ${bad}`);
    assert.match(refused.stderr, /--commit-author/, `expected a --commit-author error for ${bad}`);
    // Node's own warnings (Node 22 flags node:sqlite as experimental) are not
    // agentq output; the agentq error itself must be one line.
    assert.equal(ownStderr(refused.stderr).split('\n').length, 1, 'the error is one line');
    assert.doesNotMatch(refused.stderr, /GitHub/, 'the policy is refused before any issue capture');
  }
});

test('CLI: an explicit --no-commit overrides the issue default', () => {
  const root = tmpdir();
  const repo = makeRepo(root);
  const db = path.join(root, 'jobs.sqlite');

  const enqueued = run(['--db', db, 'enqueue', '--repo', repo, '--issue', '7', '--model', 'm', '--no-commit', '--json']);
  assert.equal(enqueued.exitCode, 0, enqueued.stderr);
  assert.deepEqual(storedPolicy(db, JSON.parse(enqueued.stdout).id), { commit: 'none', author: null });
});

test('CLI: requeue keeps the stored policy', () => {
  const root = tmpdir();
  const repo = makeRepo(root);
  const db = path.join(root, 'jobs.sqlite');
  const spec = path.join(root, 'spec.md');
  fs.writeFileSync(spec, '# Keep me\n\nbody\n');

  const enqueued = run(['--db', db, 'enqueue', '--repo', repo, '--spec', spec, '--model', 'm', '--json']);
  assert.equal(enqueued.exitCode, 0, enqueued.stderr);
  const { id } = JSON.parse(enqueued.stdout);
  assert.deepEqual(storedPolicy(db, id), { commit: 'none', author: null });

  // requeue only runs from a terminal status; fail the task directly.
  const handle = openDb(db);
  try {
    handle.prepare("UPDATE tasks SET status = 'failed', result = ? WHERE id = ?")
      .run(JSON.stringify({ status: 'failed' }), id);
  } finally {
    handle.close();
  }
  const requeued = run(['--db', db, 'requeue', '--id', id, '--json']);
  assert.equal(requeued.exitCode, 0, requeued.stderr);
  assert.deepEqual(storedPolicy(db, id), { commit: 'none', author: null });
});

// --- MCP ---

const MCP_REPO = fs.realpathSync(tmpdir('agentq-mcp-commit-'));
fs.mkdirSync(path.join(MCP_REPO, '.git'));

function mcpDeps(captured) {
  return {
    createTask: (task) => {
      captured.push(task);
      return { id: 'new-task-id', status: 'pending', ...task };
    },
    claimNextTask: () => null,
    completeTask: () => {},
    getTask: () => ({ id: 't1', status: 'succeeded', model: 'gpt-5' }),
    listTaskEvents: () => [],
    addReview: (review) => ({ id: 1, ...review }),
    captureIssueInput: () => ({ type: 'agentq.task-input/v1', source: 'github', ref: 3 }),
    resolveAutoModel: () => ({ model: 'gpt-5', provider: 'codex' }),
  };
}

function enqueueTool(captured) {
  const entry = buildWriteTools(mcpDeps(captured)).find((tool) => tool.name === 'enqueue_task');
  assert.ok(entry, 'enqueue_task exists');
  return entry;
}

test('MCP: commit is accepted, with the same defaults by kind', () => {
  // spec defaults to none
  let captured = [];
  enqueueTool(captured).handler({ kind: 'spec', repo: MCP_REPO, title: 'T', body: 'B' });
  assert.deepEqual(captured[0].execution_policy, { commit: 'none', author: null });

  // issue and prompt default to agent
  captured = [];
  enqueueTool(captured).handler({ kind: 'github_issue', repo: MCP_REPO, issue: 3 });
  assert.deepEqual(captured[0].execution_policy, { commit: 'agent', author: null });

  captured = [];
  enqueueTool(captured).handler({ kind: 'prompt', repo: MCP_REPO, prompt: 'do it' });
  assert.deepEqual(captured[0].execution_policy, { commit: 'agent', author: null });

  // an explicit commit wins either way
  captured = [];
  enqueueTool(captured).handler({ kind: 'prompt', repo: MCP_REPO, prompt: 'do it', commit: 'none' });
  assert.deepEqual(captured[0].execution_policy, { commit: 'none', author: null });

  captured = [];
  enqueueTool(captured).handler({ kind: 'spec', repo: MCP_REPO, title: 'T', body: 'B', commit: 'agent' });
  assert.deepEqual(captured[0].execution_policy, { commit: 'agent', author: null });

  // an invalid commit is refused
  assert.throws(
    () => enqueueTool([]).handler({ kind: 'prompt', repo: MCP_REPO, prompt: 'do it', commit: 'sometimes' }),
    /commit/,
  );
});

test('MCP: any author field is refused', () => {
  for (const field of ['author', 'commit_author', 'commitAuthor', 'commit-author']) {
    assert.throws(
      () => enqueueTool([]).handler({
        kind: 'prompt', repo: MCP_REPO, prompt: 'do it', [field]: 'Agent Q <agentq@example.test>',
      }),
      /author/,
      `expected refusal for ${field}`,
    );
  }
});

// --- Runner ---

test('runner: the commit policy tolerates every job shape', () => {
  assert.deepEqual(commitPolicyOf({}), { commit: 'agent', author: null });
  assert.deepEqual(commitPolicyOf({ execution_policy: null }), { commit: 'agent', author: null });
  assert.deepEqual(
    commitPolicyOf({ execution_policy: { commit: 'none', author: null } }),
    { commit: 'none', author: null },
  );
  assert.deepEqual(
    commitPolicyOf({ execution_policy: JSON.stringify({ commit: 'none', author: { name: 'A', email: 'a@b.c' } }) }),
    { commit: 'none', author: { name: 'A', email: 'a@b.c' } },
  );
  assert.deepEqual(commitPolicyOf({ execution_policy: 'not json' }), { commit: 'agent', author: null });
  assert.deepEqual(commitPolicyOf({ execution_policy: { commit: 'sometimes' } }), { commit: 'agent', author: null });
});

test('runner: the author resolves task, then repo git config, then none', (t) => {
  const root = tmpdir();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const repo = makeGitRepo(root);
  execFileSync('git', ['-C', repo, 'config', 'agentq.commitAuthor', 'Repo Bot <bot@example.test>'], { stdio: 'ignore' });

  // The task's own author wins over the repo config.
  assert.deepEqual(
    resolveCommitAuthor({ name: 'Task Author', email: 'task@example.test' }, repo),
    { name: 'Task Author', email: 'task@example.test' },
  );
  // Then the repo config.
  assert.deepEqual(
    resolveCommitAuthor(null, repo),
    { name: 'Repo Bot', email: 'bot@example.test' },
  );
  // A set-but-malformed repo config refuses the run: falling back to the repo
  // identity would defeat the override the owner configured.
  execFileSync('git', ['-C', repo, 'config', 'agentq.commitAuthor', 'not-a-name-email'], { stdio: 'ignore' });
  assert.throws(() => resolveCommitAuthor(null, repo), /Invalid agentq\.commitAuthor/);
  // A task author still wins over a malformed repo config.
  assert.deepEqual(
    resolveCommitAuthor({ name: 'Task Author', email: 'task@example.test' }, repo),
    { name: 'Task Author', email: 'task@example.test' },
  );
  // No config and no task author: nothing.
  execFileSync('git', ['-C', repo, 'config', '--unset', 'agentq.commitAuthor'], { stdio: 'ignore' });
  assert.equal(resolveCommitAuthor(null, repo), null);
  assert.equal(resolveCommitAuthor(null, null), null);
});

/**
 * A fake executor: records the environment the runner hands it and exits 0
 * without writing a result file.
 */
function dumpingExecutor(root) {
  const dump = path.join(root, 'executor-env.txt');
  const executor = path.join(root, 'executor.sh');
  fs.writeFileSync(executor, `#!/bin/sh\nenv | LC_ALL=C sort > ${JSON.stringify(dump)}\n`, { mode: 0o755 });
  return { executor, dump };
}

function readEnvDump(dump) {
  const env = {};
  for (const line of fs.readFileSync(dump, 'utf8').split('\n')) {
    const at = line.indexOf('=');
    if (at > 0) env[line.slice(0, at)] = line.slice(at + 1);
  }
  return env;
}

async function runWithExecutor(t, sourceOptions, enqueueOptions) {
  const root = tmpdir();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const repo = makeGitRepo(root);
  const source = new SqliteSource(path.join(root, 'queue.sqlite'));
  await source.enqueue({ repo, issue: '7', model: 'test/model', base: 'master', trusted: true, ...enqueueOptions });
  const job = await source.claimNext();
  assert.ok(job, 'a job was claimed');
  const { executor, dump } = dumpingExecutor(root);
  const result = await executeJob(job, { executor, ...sourceOptions }, source);
  assert.equal(result.status, 'succeeded');
  return { env: readEnvDump(dump), source, job };
}

test('runner: the executor environment carries the commit mode and the task author', async (t) => {
  const { env } = await runWithExecutor(t, {}, {
    commitAuthor: 'Agent Q <agentq@example.test>',
  });
  assert.equal(env.AGENTQ_COMMIT_MODE, 'agent');
  assert.equal(env.GIT_AUTHOR_NAME, 'Agent Q');
  assert.equal(env.GIT_AUTHOR_EMAIL, 'agentq@example.test');
  assert.equal(env.GIT_COMMITTER_NAME, 'Agent Q');
  assert.equal(env.GIT_COMMITTER_EMAIL, 'agentq@example.test');
});

test('runner: the repo git config supplies the author when the task has none', async (t) => {
  const root = tmpdir();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const repo = makeGitRepo(root);
  execFileSync('git', ['-C', repo, 'config', 'agentq.commitAuthor', 'Repo Bot <bot@example.test>'], { stdio: 'ignore' });
  const source = new SqliteSource(path.join(root, 'queue.sqlite'));
  await source.enqueue({ repo, issue: '7', model: 'test/model', base: 'master', trusted: true });
  const job = await source.claimNext();
  const { executor, dump } = dumpingExecutor(root);
  const result = await executeJob(job, { executor }, source);
  assert.equal(result.status, 'succeeded');
  const env = readEnvDump(dump);
  assert.equal(env.AGENTQ_COMMIT_MODE, 'agent');
  assert.equal(env.GIT_AUTHOR_EMAIL, 'bot@example.test');
});

test('runner: no author anywhere leaves the repo identity alone, in none mode', async (t) => {
  const { env } = await runWithExecutor(t, {}, { noCommit: true });
  assert.equal(env.AGENTQ_COMMIT_MODE, 'none');
  assert.equal(env.GIT_AUTHOR_NAME, undefined);
  assert.equal(env.GIT_AUTHOR_EMAIL, undefined);
  assert.equal(env.GIT_COMMITTER_NAME, undefined);
  assert.equal(env.GIT_COMMITTER_EMAIL, undefined);
});

// --- result file ---

test('result file: unexpectedCommits is optional and validated', () => {
  const ok = validateResultFile({ version: 1, stop: false, unexpectedCommits: 2 });
  assert.equal(ok.ok, true);
  assert.equal(ok.value.unexpectedCommits, 2);

  const absent = validateResultFile({ version: 1, stop: false });
  assert.equal(absent.ok, true);
  assert.equal(absent.value.unexpectedCommits, null);

  for (const bad of [-1, 1.5, '2', Number.NaN]) {
    const checked = validateResultFile({ version: 1, stop: false, unexpectedCommits: bad });
    assert.equal(checked.ok, false, `expected rejection for ${String(bad)}`);
    assert.match(checked.detail, /unexpectedCommits/);
  }
});

// --- executors ---

/**
 * A fake `pi` on PATH: records its stdin and environment, optionally commits
 * one change in the worktree (its cwd), and exits 0.
 */
function fakeAgent(root, { commit = false } = {}) {
  const bin = path.join(root, 'bin');
  const recordDir = path.join(root, 'agent-record');
  fs.mkdirSync(bin, { recursive: true });
  fs.mkdirSync(recordDir, { recursive: true });
  for (const name of ['pi', 'claude']) {
    fs.writeFileSync(path.join(bin, name), `#!${process.execPath}
const fs = require('node:fs');
const { execFileSync } = require('node:child_process');
const dir = ${JSON.stringify(recordDir)};
const me = require('node:path').basename(process.argv[1]);
fs.writeFileSync(require('node:path').join(dir, me + '-stdin.txt'), fs.readFileSync(0, 'utf8'));
fs.writeFileSync(require('node:path').join(dir, me + '-env.json'), JSON.stringify(process.env, null, 1));
if (${commit ? 'true' : 'false'}) {
  fs.writeFileSync('agent-work.txt', 'work\\n');
  execFileSync('git', ['add', 'agent-work.txt']);
  execFileSync('git', ['commit', '-m', 'agent work']);
}
${name === 'claude'
    ? `process.stdout.write(JSON.stringify({ session_id: 'sess-1', subtype: 'done', result: 'done', usage: {}, modelUsage: {}, total_cost_usd: 0, num_turns: 1, duration_ms: 1 }));`
    : `process.stdout.write('Implemented.\\n');`}
process.exit(0);
`, { mode: 0o755 });
  }
  // pi-workflow.sh JSON-encodes the issue text with jq.
  fs.writeFileSync(path.join(bin, 'jq'), `#!${process.execPath}
const args = process.argv.slice(2);
const value = args.includes('-Rs') ? require('node:fs').readFileSync(0, 'utf8') : args[args.indexOf('--arg') + 2];
console.log(JSON.stringify(value));
`, { mode: 0o755 });
  const read = (file) => fs.readFileSync(path.join(recordDir, file), 'utf8');
  return { bin, read };
}

function executorEnv(fake, worktree, extra = {}) {
  return {
    ...process.env,
    PATH: `${fake.bin}${path.delimiter}${process.env.PATH}`,
    AGENTQ_PINNED_INPUT: '1',
    AGENTQ_WORKTREE: worktree,
    BASE_BRANCH: 'master',
    ...extra,
  };
}

test('pi-task.sh: none mode puts the no-commit line in the prompt', (t) => {
  const root = tmpdir();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const repo = makeGitRepo(root);
  const worktree = addLinkedWorktree(repo);
  const fake = fakeAgent(root);
  const input = taskInputForIssue(42, 'do the thing');

  const run = spawnSync('bash', [PI_TASK, '42', 'test/model', '--agentq-pinned-input'], {
    cwd: repo,
    encoding: 'utf8',
    timeout: 60_000,
    input: JSON.stringify(input),
    env: executorEnv(fake, worktree, {
      AGENTQ_INPUT_SHA256: input.sha256,
      AGENTQ_COMMIT_MODE: 'none',
      AGENTQ_RESULT: path.join(root, 'result.json'),
    }),
  });
  assert.equal(run.status, 0, run.stderr);
  const prompt = fake.read('pi-stdin.txt');
  assert.match(prompt, /Do NOT commit\. Leave all changes uncommitted in the working tree for review\./);
  assert.doesNotMatch(prompt, /Make focused commits/);
});

test('pi-task.sh: agent mode keeps the commit line and the commit carries the author', (t) => {
  const root = tmpdir();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const repo = makeGitRepo(root);
  const worktree = addLinkedWorktree(repo);
  const fake = fakeAgent(root, { commit: true });
  const input = taskInputForIssue(42, 'do the thing');

  const run = spawnSync('bash', [PI_TASK, '42', 'test/model', '--agentq-pinned-input'], {
    cwd: repo,
    encoding: 'utf8',
    timeout: 60_000,
    input: JSON.stringify(input),
    env: executorEnv(fake, worktree, {
      AGENTQ_INPUT_SHA256: input.sha256,
      AGENTQ_COMMIT_MODE: 'agent',
      GIT_AUTHOR_NAME: 'Agent Q',
      GIT_AUTHOR_EMAIL: 'agentq@example.test',
      GIT_COMMITTER_NAME: 'Agent Q',
      GIT_COMMITTER_EMAIL: 'agentq@example.test',
      AGENTQ_RESULT: path.join(root, 'result.json'),
    }),
  });
  assert.equal(run.status, 0, run.stderr);
  assert.match(fake.read('pi-stdin.txt'), /Make focused commits on this branch as you go\./);
  // The GIT_* identity reaches the agent process and its commit.
  const agentEnv = JSON.parse(fake.read('pi-env.json'));
  assert.equal(agentEnv.GIT_AUTHOR_EMAIL, 'agentq@example.test');
  assert.equal(execFileSync('git', ['-C', worktree, 'log', '-1', '--format=%ae'], { encoding: 'utf8' }).trim(), 'agentq@example.test');
  assert.equal(execFileSync('git', ['-C', worktree, 'log', '-1', '--format=%an'], { encoding: 'utf8' }).trim(), 'Agent Q');
  const written = readResultFile(path.join(root, 'result.json'));
  assert.equal(written.ok, true, written.detail);
  assert.equal(written.value.unexpectedCommits, null);
});

test('pi-task.sh: a commit in none mode warns and records unexpectedCommits', (t) => {
  const root = tmpdir();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const repo = makeGitRepo(root);
  const worktree = addLinkedWorktree(repo);
  const fake = fakeAgent(root, { commit: true });
  const input = taskInputForIssue(42, 'do the thing');
  const resultPath = path.join(root, 'result.json');

  const run = spawnSync('bash', [PI_TASK, '42', 'test/model', '--agentq-pinned-input'], {
    cwd: repo,
    encoding: 'utf8',
    timeout: 60_000,
    input: JSON.stringify(input),
    env: executorEnv(fake, worktree, {
      AGENTQ_INPUT_SHA256: input.sha256,
      AGENTQ_COMMIT_MODE: 'none',
      AGENTQ_RESULT: resultPath,
    }),
  });
  assert.equal(run.status, 0, run.stderr);
  assert.match(run.stderr, /WARNING: the agent committed 1 commit\(s\) despite no-commit mode/);
  // The working-tree diagnostic replaces the BASE..HEAD log.
  assert.match(run.stdout, /uncommitted changes in working tree/);
  assert.doesNotMatch(run.stdout, /commits \+ diff/);
  const written = readResultFile(resultPath);
  assert.equal(written.ok, true, written.detail);
  assert.equal(written.value.unexpectedCommits, 1);
});

test('claude-task.sh: none mode puts the no-commit line in the prompt', (t) => {
  const root = tmpdir();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const repo = makeGitRepo(root);
  const worktree = addLinkedWorktree(repo);
  const fake = fakeAgent(root);
  const input = taskInputForIssue(42, 'do the thing');
  const settings = path.join(root, 'settings.json');
  fs.writeFileSync(settings, '{}');

  const run = spawnSync('bash', [CLAUDE_TASK, '42', 'test/model', '--agentq-pinned-input'], {
    cwd: repo,
    encoding: 'utf8',
    timeout: 60_000,
    input: JSON.stringify(input),
    env: executorEnv(fake, worktree, {
      AGENTQ_INPUT_SHA256: input.sha256,
      AGENTQ_COMMIT_MODE: 'none',
      AGENTQ_CLAUDE_SETTINGS: settings,
      AGENTQ_RESULT: path.join(root, 'result.json'),
    }),
  });
  assert.equal(run.status, 0, run.stderr);
  const prompt = fake.read('claude-stdin.txt');
  assert.match(prompt, /Do NOT commit\. Leave all changes uncommitted in the working tree for review\./);
  assert.doesNotMatch(prompt, /Make focused commits/);
});

test('pi-workflow.sh: none mode rewrites the commit line in the generated workflow', (t) => {
  const root = tmpdir();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const repo = makeGitRepo(root);
  const worktree = addLinkedWorktree(repo, 'reused-workflow', 'pi/issue-42');
  const fake = fakeAgent(root);
  const input = taskInputForIssue(42, 'do the thing');

  const run = spawnSync('bash', [PI_WORKFLOW, '42', 'test/model', '--agentq-pinned-input'], {
    cwd: repo,
    encoding: 'utf8',
    timeout: 60_000,
    input: JSON.stringify(input),
    env: executorEnv(fake, worktree, {
      AGENTQ_INPUT_SHA256: input.sha256,
      AGENTQ_COMMIT_MODE: 'none',
      AGENTQ_RESULT: path.join(root, 'result.json'),
    }),
  });
  assert.equal(run.status, 0, run.stderr);
  const prompt = fake.read('pi-stdin.txt');
  assert.match(prompt, /Do NOT commit\. Leave all changes uncommitted in the working tree for review\./);
  assert.doesNotMatch(prompt, /Make focused commits/);
  const written = readResultFile(path.join(root, 'result.json'));
  assert.equal(written.ok, true, written.detail);
  assert.equal(written.value.unexpectedCommits, null);
});

test('a spec task runs end to end in none mode with the repo author', async (t) => {
  const root = tmpdir();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const repo = makeGitRepo(root);
  execFileSync('git', ['-C', repo, 'config', 'agentq.commitAuthor', 'Repo Bot <bot@example.test>'], { stdio: 'ignore' });
  const source = new SqliteSource(path.join(root, 'queue.sqlite'));
  // A spec enqueue through the real CLI defaults to none.
  const spec = path.join(root, 'spec.md');
  fs.writeFileSync(spec, '# Spec title\n\nspec body\n');
  const enqueued = run(['--db', path.join(root, 'queue.sqlite'), 'enqueue', '--repo', repo, '--spec', spec, '--model', 'test/model', '--trusted', '--json']);
  assert.equal(enqueued.exitCode, 0, enqueued.stderr);
  const job = await source.claimNext({ kind: 'spec' });
  assert.ok(job, 'the spec task is claimed');
  assert.deepEqual(job.execution_policy, { commit: 'none', author: null });

  const seen = path.join(root, 'env.json');
  const executor = path.join(root, 'executor.sh');
  fs.writeFileSync(executor, `#!/bin/sh\ncat > /dev/null\nenv > ${JSON.stringify(seen)}\n`, { mode: 0o755 });
  const result = await executeJob(job, { executor }, source);
  assert.equal(result.status, 'succeeded');
  const env = Object.fromEntries(
    fs.readFileSync(seen, 'utf8').split('\n').filter(Boolean).map((line) => {
      const at = line.indexOf('=');
      return [line.slice(0, at), line.slice(at + 1)];
    }),
  );
  assert.equal(env.AGENTQ_COMMIT_MODE, 'none');
  assert.equal(env.GIT_AUTHOR_EMAIL, 'bot@example.test');
  const [stored] = source.status();
  assert.equal(stored.unexpected_commits, null);
});

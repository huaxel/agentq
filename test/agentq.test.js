'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync, spawn, spawnSync } = require('node:child_process');
const { DatabaseSync } = require('node:sqlite');

const { githubEnv, snapshotForIssue } = require('./helpers/pinned-issue.js');
const { emitResult, resultPayload } = require('./helpers/result-file.js');
const { ownStderr } = require('./helpers/stderr.js');
const { CHEAP_MODEL, STRONG_MODEL, quotaFixture, writeRoutingFixture } = require('./helpers/routing-fixture.js');
const AGENTQ = require.resolve('../src/interfaces/cli/agentq.js');
const { resolveExecutor, parseArgs, formatModelRow, formatJobBlock, summarizeCosts, truncateRepo } = require('../src/interfaces/cli/agentq.js');
const { SqliteSource, taskToJob } = require('../src/queue/sources.js');
const dbModule = require('../src/queue/db.js');

const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';

function tmpdir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'agentq-test-'));
}

function run(args, env = {}, opts = {}) {
  try {
    const stdout = execFileSync(process.execPath, [AGENTQ, ...args], {
      encoding: 'utf8',
      env: { ...process.env, AGENTQ_QUOTA_REFRESH: '0', ...githubEnv(), ...env },
      timeout: 30_000,
      ...opts,
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

function makeRepo(root) {
  const repo = path.join(root, 'repo');
  fs.mkdirSync(repo, { recursive: true });
  fs.writeFileSync(path.join(repo, 'pi-issue.sh'), '#!/usr/bin/env bash\necho should-not-run\n', { mode: 0o755 });
  return repo;
}

function makeGitRepo(root) {
  const repo = makeRepo(root);
  execFileSync('git', ['-C', repo, 'init', '-b', 'master'], { stdio: 'ignore' });
  execFileSync('git', ['-C', repo, 'config', 'user.email', 'agentq@example.test'], { stdio: 'ignore' });
  execFileSync('git', ['-C', repo, 'config', 'user.name', 'AgentQ Test'], { stdio: 'ignore' });
  fs.writeFileSync(path.join(repo, 'README.md'), 'test\n');
  execFileSync('git', ['-C', repo, 'add', '.'], { stdio: 'ignore' });
  execFileSync('git', ['-C', repo, 'commit', '-m', 'init'], { stdio: 'ignore' });
  return repo;
}

function makeExecutor(root, body, name = 'fake-pi-issue.sh') {
  const file = path.join(root, name);
  fs.writeFileSync(file, body, { mode: 0o755 });
  return file;
}

function jobs(db, env = {}, opts = {}) {
  const result = run(['--db', db, 'status', '--json'], env, opts);
  assert.equal(result.exitCode, 0, result.stderr);
  return JSON.parse(result.stdout);
}

/** Open the queue database with its schema (tests inspect it directly). */
function openDb(dbPath) {
  const db = dbModule.openDb(dbPath);
  dbModule.initSchema(db);
  return db;
}

/** Read the task's stored completion result and patch it (test-only). */
function patchResult(dbPath, id, patch) {
  const db = openDb(dbPath);
  try {
    const row = dbModule.getTask(db, id);
    const result = row.result ? JSON.parse(row.result) : {};
    db.prepare('UPDATE tasks SET result = ? WHERE id = ?').run(JSON.stringify({ ...result, ...patch }), id);
  } finally {
    db.close();
  }
}

function taskEvents(dbPath, id) {
  const db = openDb(dbPath);
  try {
    return dbModule.listTaskEvents(db, id).map((event) => ({ ...event, payload: JSON.parse(event.payload || 'null') }));
  } finally {
    db.close();
  }
}

test('enqueue stores a pending GitHub issue job and status lists it', () => {
  const root = tmpdir();
  const repo = makeRepo(root);
  const db = path.join(root, 'jobs.sqlite');

  const enqueued = run([
    '--db', db,
    'enqueue',
    '--repo', repo,
    '--issue', '304',
    '--model', 'cline-pass/kimi-k2.7-code',
    '--base', 'master',
    '--json',
  ]);

  assert.equal(enqueued.exitCode, 0);
  const { id, status } = JSON.parse(enqueued.stdout);
  assert.match(id, new RegExp(`^${UUID}$`));
  assert.equal(status, 'pending');

  const [job] = jobs(db);
  assert.equal(job.id, id);
  assert.equal(job.repo_path, repo);
  assert.equal(job.issue_number, 304);
  assert.equal(job.model, 'cline-pass/kimi-k2.7-code');
  assert.equal(job.base_branch, 'master');
  assert.equal(job.status, 'pending');
});

test('a local CLI job is visible through listTasks (one shared store)', () => {
  const root = tmpdir();
  const repo = makeRepo(root);
  const db = path.join(root, 'jobs.sqlite');
  const { id } = JSON.parse(run(['--db', db, 'enqueue', '--repo', repo, '--issue', '7', '--model', 'm', '--trusted', '--json']).stdout);

  // The orchestrator, the dashboard and the MCP server all read this table.
  const handle = openDb(db);
  try {
    const rows = dbModule.listTasks(handle, {});
    assert.equal(rows.length, 1);
    assert.equal(rows[0].id, id);
    assert.equal(rows[0].source, 'cli');
    assert.equal(rows[0].kind, 'github_issue');
    assert.equal(rows[0].status, 'pending');
    assert.equal(rows[0].trust_level, 'trusted_agent');
    assert.equal(rows[0].approval_required, 0);
    assert.ok(rows[0].prompt.includes('"agentq.task-input/v1"'));
  } finally {
    handle.close();
  }
});

test('enqueue --spec stores a spec task with the requested tier', () => {
  const root = tmpdir();
  const repo = makeRepo(root);
  const db = path.join(root, 'jobs.sqlite');
  const spec = path.join(root, 'spec.md');
  fs.writeFileSync(spec, '# Local spec\n\nDo the work.\n');

  const enqueued = run([
    '--db', db,
    'enqueue',
    '--repo', repo,
    '--spec', spec,
    '--model', 'test/model',
    '--tier', 'big',
    '--base', 'master',
    '--trusted',
    '--json',
  ]);
  assert.equal(enqueued.exitCode, 0, enqueued.stderr);
  const { id, status } = JSON.parse(enqueued.stdout);
  assert.equal(status, 'pending');

  const handle = openDb(db);
  try {
    const row = dbModule.getTask(handle, id);
    assert.equal(row.kind, 'spec');
    assert.equal(row.issue_num, null);
    assert.deepEqual(JSON.parse(row.routing_policy), { tier: 'big' });
    const pinned = JSON.parse(row.prompt);
    assert.equal(pinned.type, 'agentq.task-input/v1');
    assert.equal(pinned.source, 'file');
    assert.equal(pinned.title, 'Local spec');
    assert.equal(pinned.body, '# Local spec\n\nDo the work.\n');
  } finally {
    handle.close();
  }

  // status names the spec by its title, without the file path.
  const listed = run(['--db', db, 'status']);
  assert.equal(listed.exitCode, 0, listed.stderr);
  assert.match(listed.stdout, /\bpending\s+spec\b.*\bLocal spec$/m);
  assert.doesNotMatch(listed.stdout, /spec\.md/);
});

test('enqueue requires exactly one of --issue or --spec', () => {
  const root = tmpdir();
  const repo = makeRepo(root);
  const db = path.join(root, 'jobs.sqlite');
  const spec = path.join(root, 'spec.md');
  fs.writeFileSync(spec, '# Spec\n\nbody\n');

  const both = run(['--db', db, 'enqueue', '--repo', repo, '--issue', '42', '--spec', spec, '--json']);
  assert.equal(both.exitCode, 1);
  assert.match(both.stderr, /exactly one of --issue or --spec/);

  const neither = run(['--db', db, 'enqueue', '--repo', repo, '--json']);
  assert.equal(neither.exitCode, 1);
  assert.match(neither.stderr, /requires --issue N or --spec FILE/);

  const freshDb = path.join(root, 'fresh.sqlite');
  const missing = run(['--db', freshDb, 'enqueue', '--repo', repo, '--spec', path.join(root, 'absent.md'), '--json']);
  assert.equal(missing.exitCode, 1);
  assert.match(missing.stderr, /Spec file not found/);
  const handle = openDb(freshDb);
  try {
    assert.equal(handle.prepare('SELECT count(*) AS count FROM tasks').get().count, 0, 'a refused spec enqueue creates no task');
  } finally {
    handle.close();
  }
});

test('enqueue --spec names a NUL byte instead of the generic refusal', () => {
  const root = tmpdir();
  const repo = makeRepo(root);
  const db = path.join(root, 'jobs.sqlite');
  const spec = path.join(root, 'nul.md');
  fs.writeFileSync(spec, '# NUL spec\n\nbefore\0after\n');

  const refused = run(['--db', db, 'enqueue', '--repo', repo, '--spec', spec, '--trusted', '--json']);
  assert.equal(refused.exitCode, 1);
  assert.match(refused.stderr, /Task body must not contain a NUL byte/);
  const handle = openDb(db);
  try {
    assert.equal(handle.prepare('SELECT count(*) AS count FROM tasks').get().count, 0);
  } finally {
    handle.close();
  }
});

test('run-next executes the oldest pending job and records success metadata', () => {
  const root = tmpdir();
  const repo = makeRepo(root);
  const db = path.join(root, 'jobs.sqlite');
  const cwdFile = path.join(root, 'cwd.txt');
  const executor = makeExecutor(root, `#!/usr/bin/env bash
set -euo pipefail
pwd > ${JSON.stringify(cwdFile)}
echo "issue=$1 model=$2"
${emitResult(root, resultPayload({
    worktree: path.join(os.tmpdir(), 'pi-issue-304'),
    branch: 'pi/issue-304',
    usage: { inputTokens: 608, cacheReadTokens: 75422, totalCost: 0.0176 },
  }))}
`);

  const { id } = JSON.parse(run(['--db', db, 'enqueue', '--repo', repo, '--issue', '304', '--model', 'cline-pass/kimi-k2.7-code', '--trusted', '--json']).stdout);
  const result = run(['--db', db, 'run-next', '--executor', executor, '--json']);

  assert.equal(result.exitCode, 0);
  assert.deepEqual(JSON.parse(result.stdout), { id, status: 'succeeded', exitCode: 0 });
  assert.equal(fs.realpathSync(fs.readFileSync(cwdFile, 'utf8').trim()), fs.realpathSync(repo));

  const [job] = jobs(db);
  assert.equal(job.status, 'succeeded');
  assert.equal(job.exit_code, 0);
  assert.equal(job.worktree_path, path.join(os.tmpdir(), 'pi-issue-304'));
  assert.equal(job.branch, 'pi/issue-304');
  assert.match(job.log_path, new RegExp(`agentq-job-${UUID}\\.log$`));
  assert.deepEqual(JSON.parse(job.usage_json), {
    inputTokens: 608,
    cacheReadTokens: 75422,
    totalCost: 0.0176,
  });
  assert.match(fs.readFileSync(job.log_path, 'utf8'), /issue=304 model=cline-pass\/kimi-k2\.7-code/);

  // Usage lands in the shared store, not in a side file.
  const handle = openDb(db);
  try {
    const [usage] = dbModule.getUsageByTask(handle, id);
    assert.equal(usage.input_tokens, 608);
    assert.equal(usage.cost, 0.0176);
  } finally {
    handle.close();
  }
});

test('run-next records failed executor attempts without losing the job log', () => {
  const root = tmpdir();
  const repo = makeRepo(root);
  const db = path.join(root, 'jobs.sqlite');
  const executor = makeExecutor(root, `#!/usr/bin/env bash
echo nope
exit 7
`);

  const { id } = JSON.parse(run(['--db', db, 'enqueue', '--repo', repo, '--issue', '99', '--model', 'umans-coder', '--trusted', '--json']).stdout);
  const result = run(['--db', db, 'run-next', '--executor', executor, '--json']);

  assert.equal(result.exitCode, 7);
  // This executor writes no result file, so its metadata is null and the run
  // says why instead of scraping the log.
  assert.deepEqual(JSON.parse(result.stdout), { id, status: 'failed', exitCode: 7, result_file: 'missing' });

  const [job] = jobs(db);
  assert.equal(job.status, 'failed');
  assert.equal(job.exit_code, 7);
  assert.match(fs.readFileSync(job.log_path, 'utf8'), /nope/);
});

test('run-next exits cleanly when there are no pending jobs', () => {
  const root = tmpdir();
  const db = path.join(root, 'jobs.sqlite');

  const result = run(['--db', db, 'run-next', '--json']);

  assert.equal(result.exitCode, 0);
  assert.deepEqual(JSON.parse(result.stdout), { status: 'idle' });
});

test('dependency jobs are blocked until their prerequisites succeed', () => {
  const root = tmpdir();
  const repo = makeRepo(root);
  const db = path.join(root, 'jobs.sqlite');
  const callsFile = path.join(root, 'calls.txt');
  const executor = makeExecutor(root, `#!/usr/bin/env bash
set -euo pipefail
echo "$1" >> ${JSON.stringify(callsFile)}
`);

  const first = JSON.parse(run(['--db', db, 'enqueue', '--repo', repo, '--issue', '1', '--model', 'model-a', '--trusted', '--json']).stdout);
  const blocked = run(['--db', db, 'enqueue', '--repo', repo, '--issue', '2', '--model', 'model-b', '--depends-on', first.id, '--trusted', '--json']);
  const second = JSON.parse(blocked.stdout);
  assert.equal(second.status, 'blocked');

  let listed = jobs(db);
  assert.equal(listed[1].status, 'blocked');
  assert.deepEqual(listed[1].depends_on, [first.id]);

  const drained = run(['--db', db, 'drain', '--executor', executor, '--json']);
  assert.equal(drained.exitCode, 0);
  assert.equal(fs.readFileSync(callsFile, 'utf8'), '1\n2\n');
  listed = jobs(db);
  assert.deepEqual(listed.map(j => j.status), ['succeeded', 'succeeded']);
});

test('--depends-on accepts a unique task-id prefix', () => {
  const root = tmpdir();
  const repo = makeRepo(root);
  const db = path.join(root, 'jobs.sqlite');

  const first = JSON.parse(run(['--db', db, 'enqueue', '--repo', repo, '--issue', '1', '--model', 'm', '--trusted', '--json']).stdout);
  const prefix = first.id.slice(0, 8);
  const second = JSON.parse(run(['--db', db, 'enqueue', '--repo', repo, '--issue', '2', '--model', 'm', '--depends-on', prefix, '--trusted', '--json']).stdout);
  assert.deepEqual(jobs(db).find(j => j.id === second.id).depends_on, [first.id]);
});

test('run-next uses a per-job git worktree when the repo supports it', () => {
  const root = tmpdir();
  const repo = makeGitRepo(root);
  const db = path.join(root, 'jobs.sqlite');
  const cwdFile = path.join(root, 'cwd.txt');
  const executor = makeExecutor(root, `#!/usr/bin/env bash
set -euo pipefail
pwd > ${JSON.stringify(cwdFile)}
`);

  const { id } = JSON.parse(run(['--db', db, 'enqueue', '--repo', repo, '--issue', '10', '--model', 'model-a', '--base', 'master', '--trusted', '--json']).stdout);
  const result = run(['--db', db, 'run-next', '--executor', executor, '--json']);

  assert.equal(result.exitCode, 0);
  const [job] = jobs(db);
  assert.equal(job.worktree_path, path.join(root, 'worktrees', `job-${id}`));
  assert.equal(job.branch, `agentq/job-${id}`);
  assert.equal(fs.realpathSync(fs.readFileSync(cwdFile, 'utf8').trim()), fs.realpathSync(job.worktree_path));
});

test('worktree jobs succeed even when --db is a relative path', () => {
  // Regression: the worktree dir was derived with path.join(dirname(db), ...),
  // so a relative --db pointed the spawn cwd at a dir git had created elsewhere
  // (relative to the repo), and every git-repo job failed in a missing dir.
  const root = tmpdir();
  const repo = makeGitRepo(root);
  const cwdFile = path.join(root, 'cwd.txt');
  const executor = makeExecutor(root, `#!/usr/bin/env bash
set -euo pipefail
pwd > ${JSON.stringify(cwdFile)}
`);

  run(['--db', 'q.sqlite', 'enqueue', '--repo', repo, '--issue', '10', '--model', 'm', '--base', 'master', '--trusted'], {}, { cwd: root });
  const result = run(['--db', 'q.sqlite', 'run-next', '--executor', executor, '--json'], {}, { cwd: root });

  assert.equal(result.exitCode, 0);
  const [job] = jobs('q.sqlite', {}, { cwd: root });
  assert.equal(job.status, 'succeeded');
  assert.match(job.worktree_path, new RegExp(`worktrees/job-${UUID}$`));
  assert.equal(fs.realpathSync(fs.readFileSync(cwdFile, 'utf8').trim()), fs.realpathSync(job.worktree_path));
});

test('drain reports jobs left blocked by a failed prerequisite', () => {
  const root = tmpdir();
  const repo = makeRepo(root);
  const db = path.join(root, 'jobs.sqlite');
  const executor = makeExecutor(root, `#!/usr/bin/env bash
exit 1
`);

  const first = JSON.parse(run(['--db', db, 'enqueue', '--repo', repo, '--issue', '1', '--model', 'm', '--trusted', '--json']).stdout);
  run(['--db', db, 'enqueue', '--repo', repo, '--issue', '2', '--model', 'm', '--depends-on', first.id]);

  const drained = run(['--db', db, 'drain', '--executor', executor, '--json']);
  const summary = JSON.parse(drained.stdout);
  assert.equal(summary.failed, 1);
  assert.equal(summary.blocked, 1); // the dependent never became runnable
  assert.equal(drained.exitCode, 1);

  assert.deepEqual(jobs(db).map(j => j.status), ['failed', 'blocked']);
});

test('prune removes worktrees and branches for finished jobs', () => {
  const root = tmpdir();
  const repo = makeGitRepo(root);
  const db = path.join(root, 'jobs.sqlite');
  const executor = makeExecutor(root, `#!/usr/bin/env bash
set -euo pipefail
true
`);

  const { id } = JSON.parse(run(['--db', db, 'enqueue', '--repo', repo, '--issue', '1', '--model', 'm', '--base', 'master', '--trusted', '--json']).stdout);
  run(['--db', db, 'run-next', '--executor', executor, '--json']);

  const [before] = jobs(db);
  assert.equal(before.status, 'succeeded');
  assert.ok(fs.existsSync(before.worktree_path)); // worktree kept for inspection

  const pruned = JSON.parse(run(['--db', db, 'prune', '--json']).stdout);
  assert.equal(pruned.removed, 1);
  assert.deepEqual(pruned.ids, [id]);
  assert.equal(fs.existsSync(before.worktree_path), false);
  const branches = execFileSync('git', ['-C', repo, 'branch', '--list', `agentq/job-${id}`], { encoding: 'utf8' });
  assert.equal(branches.trim(), '');
  // prune reclaims files only: the task row (and its usage) survives.
  const [after] = jobs(db);
  assert.equal(after.id, id);
  assert.equal(after.status, 'succeeded');
  const prunedEvent = taskEvents(db, id).find(event => event.event === 'pruned');
  assert.ok(prunedEvent, 'prune must leave an audit event');
  assert.equal(prunedEvent.payload.removed, true);
  assert.deepEqual(prunedEvent.payload.skipped, []);
});

test('prune still cleans up legacy pi-issue resources when the agentq worktree is already gone', () => {
  const root = tmpdir();
  const repo = makeGitRepo(root);
  const db = path.join(root, 'jobs.sqlite');
  // The real pi-issue.sh contract: $(mktemp -d)/pi-issue-<issue> and branch
  // pi/issue-<issue> — the standalone resources prune is allowed to bind to.
  const issueNumber = 1337 + process.pid;
  const piWorktree = path.join(os.tmpdir(), `pi-issue-${issueNumber}`);
  try {
    const executor = makeExecutor(root, `#!/usr/bin/env bash
set -euo pipefail
git -C "${repo}" worktree add -q -b pi/issue-${issueNumber} "${piWorktree}" master
`);

    const { id } = JSON.parse(run(['--db', db, 'enqueue', '--repo', repo, '--issue', String(issueNumber), '--model', 'm', '--base', 'master', '--trusted', '--json']).stdout);
    run(['--db', db, 'run-next', '--executor', executor, '--json']);
    // Reproduce a historical completion whose executor-reported standalone
    // worktree label predates managed-checkout pinning.
    patchResult(db, id, { worktree: piWorktree, branch: `pi/issue-${issueNumber}` });

    const [before] = jobs(db);
    assert.equal(before.status, 'succeeded');
    assert.equal(before.worktree_path, piWorktree, 'the executor-reported worktree differs from the agentq-managed one');
    assert.ok(fs.existsSync(piWorktree));

    // Simulate the agentq worktree having already been removed by hand.
    const agentqWorktree = path.join(root, 'worktrees', `job-${id}`);
    execFileSync('git', ['-C', repo, 'worktree', 'remove', '--force', agentqWorktree]);
    assert.equal(fs.existsSync(agentqWorktree), false);

    const pruned = JSON.parse(run(['--db', db, 'prune', '--json']).stdout);
    assert.deepEqual(pruned.ids, [id], `the pi-issue cleanup should still count as a removal: ${JSON.stringify(pruned)}`);
    assert.equal(fs.existsSync(piWorktree), false, 'the pi-issue worktree must still be pruned');
    const branches = execFileSync('git', ['-C', repo, 'branch', '--list', `pi/issue-${issueNumber}`], { encoding: 'utf8' });
    assert.equal(branches.trim(), '', 'the pi-issue branch must still be deleted');
  } finally {
    fs.rmSync(piWorktree, { recursive: true, force: true });
  }
});

test('prune cleans up standalone spec resources under the pi-task contract', () => {
  const root = tmpdir();
  const repo = makeGitRepo(root);
  const db = path.join(root, 'jobs.sqlite');
  const spec = path.join(root, 'prune-spec.md');
  fs.writeFileSync(spec, '# Prune spec\n\nbody\n');
  // pi-task.sh derives the standalone names from the spec: pi-task-<slug> and
  // pi/task-<slug>. Prune must bind to the SAME names to clean them up.
  const slug = 'task-prune-spec';
  const piWorktree = path.join(os.tmpdir(), `pi-${slug}`);
  try {
    execFileSync('git', ['-C', repo, 'worktree', 'add', '-q', '-b', `pi/${slug}`, piWorktree, 'master']);

    const executor = makeExecutor(root, `#!/usr/bin/env bash
set -euo pipefail
${emitResult(root, resultPayload())}
`);
    const { id } = JSON.parse(run(['--db', db, 'enqueue', '--repo', repo, '--spec', spec, '--model', 'm', '--base', 'master', '--trusted', '--json']).stdout);
    run(['--db', db, '--kind', 'spec', 'run-next', '--executor', executor, '--json']);
    // Reproduce a standalone completion: the executor reported its own
    // worktree/branch instead of the agentq-managed checkout.
    patchResult(db, id, { worktree: piWorktree, branch: `pi/${slug}` });

    const [before] = jobs(db);
    assert.equal(before.status, 'succeeded');
    assert.equal(before.kind, 'spec');
    assert.equal(before.worktree_path, piWorktree);

    // The agentq-managed worktree is already gone.
    execFileSync('git', ['-C', repo, 'worktree', 'remove', '--force', path.join(root, 'worktrees', `job-${id}`)]);

    const pruned = JSON.parse(run(['--db', db, 'prune', '--json']).stdout);
    assert.deepEqual(pruned.ids, [id], `the spec cleanup should count as a removal: ${JSON.stringify(pruned)}`);
    assert.equal(fs.existsSync(piWorktree), false, 'the standalone spec worktree must be pruned');
    const branches = execFileSync('git', ['-C', repo, 'branch', '--list', `pi/${slug}`], { encoding: 'utf8' });
    assert.equal(branches.trim(), '', 'the standalone spec branch must be deleted');
  } finally {
    fs.rmSync(piWorktree, { recursive: true, force: true });
  }
});

test('prune never deletes legacy standalone resources outside the job contract', () => {
  const root = tmpdir();
  const repo = makeGitRepo(root);
  const db = path.join(root, 'jobs.sqlite');
  // An attacker (untrusted issue body → agent echo) registers an arbitrary
  // worktree+branch pair and forges matching labels. The pair is NOT this
  // job's contract resources (pi-issue-<issue> / pi/issue-<issue>), so prune
  // must leave both alone — checkout proof alone must not be enough.
  const victimWt = path.join(root, 'pi-victim');
  const executor = makeExecutor(root, `#!/usr/bin/env bash
set -euo pipefail
git -C "${repo}" worktree add -q -b victim "${victimWt}" master
`);

  const { id } = JSON.parse(run(['--db', db, 'enqueue', '--repo', repo, '--issue', '1337', '--model', 'm', '--base', 'master', '--trusted', '--json']).stdout);
  run(['--db', db, 'run-next', '--executor', executor, '--json']);
  // Hostile labels can remain in historical records even though managed runs
  // no longer accept them. Prune must remain conservative for those records.
  patchResult(db, id, { worktree: victimWt, branch: 'victim' });
  const [before] = jobs(db);
  assert.equal(before.status, 'succeeded');

  const pruned = JSON.parse(run(['--db', db, 'prune', '--json']).stdout);
  assert.equal(pruned.removed, 1); // the agentq worktree (self-derived) is pruned
  assert.ok(fs.existsSync(victimWt), 'non-contract worktree must survive prune');
  const branches = execFileSync('git', ['-C', repo, 'branch', '--list', 'victim'], { encoding: 'utf8' });
  assert.match(branches.trim(), /victim/, 'non-contract branch must survive prune');
  assert.ok(pruned.skipped.some(s => s.path === victimWt), 'the skip must be reported');
  assert.equal(jobs(db).length, 1, 'a job with skipped resources keeps its record for a later retry');
});

test('run-next resets a job to pending if it throws after claiming', () => {
  const root = tmpdir();
  const repo = makeRepo(root);
  const db = path.join(root, 'jobs.sqlite');
  const executor = makeExecutor(root, `#!/usr/bin/env bash
echo ok
`);
  const { id } = JSON.parse(run(['--db', db, 'enqueue', '--repo', repo, '--issue', '1', '--model', 'm', '--trusted', '--json']).stdout);
  // Force a post-claim throw: make the per-job log path a directory so the
  // streamed output file cannot be opened after the job is claimed.
  fs.mkdirSync(path.join(root, 'logs', `agentq-job-${id}.log`), { recursive: true });

  const result = run(['--db', db, 'run-next', '--executor', executor, '--json']);
  assert.notEqual(result.exitCode, 0); // the throw propagates

  const [job] = jobs(db);
  assert.equal(job.status, 'pending'); // released via the sink's recover path
  assert.equal(job.claimed_by, null);
  assert.ok(taskEvents(db, id).some(event => event.event === 'recovered'));
});

test('drain runs pending jobs until the queue is idle', () => {
  const root = tmpdir();
  const repo = makeRepo(root);
  const db = path.join(root, 'jobs.sqlite');
  const callsFile = path.join(root, 'calls.txt');
  const executor = makeExecutor(root, `#!/usr/bin/env bash
set -euo pipefail
echo "$1 $2" >> ${JSON.stringify(callsFile)}
`);

  run(['--db', db, 'enqueue', '--repo', repo, '--issue', '304', '--model', 'model-a', '--trusted']);
  run(['--db', db, 'enqueue', '--repo', repo, '--issue', '305', '--model', 'model-b', '--trusted']);

  const result = run(['--db', db, 'drain', '--executor', executor, '--json']);

  assert.equal(result.exitCode, 0);
  assert.deepEqual(JSON.parse(result.stdout), {
    status: 'drained',
    ran: 2,
    succeeded: 2,
    failed: 0,
    unverified: 0,
  });
  assert.equal(fs.readFileSync(callsFile, 'utf8'), '304 model-a\n305 model-b\n');
  assert.deepEqual(jobs(db).map(job => job.status), ['succeeded', 'succeeded']);
});

test('parallel drain overlaps executors after claiming distinct jobs', () => {
  const root = tmpdir();
  const repo = makeRepo(root);
  const db = path.join(root, 'jobs.sqlite');
  const activeDir = path.join(root, 'active');
  fs.mkdirSync(activeDir, { recursive: true });
  const overlap = path.join(root, 'overlap');
  const executor = makeExecutor(root, `#!/usr/bin/env bash
set -euo pipefail
token="${JSON.stringify(activeDir)}/$$"
touch "$token"
count=0
while [ "$(ls -1 "${JSON.stringify(activeDir)}" | wc -l)" -lt 2 ]; do
  sleep 0.05
  count=$((count + 1))
  if [ "$count" -ge 40 ]; then break; fi
done
if [ "$(ls -1 "${JSON.stringify(activeDir)}" | wc -l)" -ge 2 ]; then
  touch ${JSON.stringify(overlap)}
fi
rm -f "$token"
`);

  run(['--db', db, 'enqueue', '--repo', repo, '--issue', '1', '--model', 'model-a', '--trusted']);
  run(['--db', db, 'enqueue', '--repo', repo, '--issue', '2', '--model', 'model-b', '--trusted']);
  const result = run(['--db', db, 'drain', '--parallel', '2', '--executor', executor, '--json']);

  assert.equal(result.exitCode, 0);
  assert.equal(JSON.parse(result.stdout).succeeded, 2);
  assert.equal(fs.existsSync(overlap), true);
});

test('parallel drain waits for already-claimed jobs after a stop signal', () => {
  const root = tmpdir();
  const repo = makeRepo(root);
  const db = path.join(root, 'jobs.sqlite');
  const finished = path.join(root, 'second-finished');
  const stopResult = emitResult(root, resultPayload({ stop: true }));
  const plainResult = emitResult(root, resultPayload());
  const executor = makeExecutor(root, `#!/usr/bin/env bash
set -euo pipefail
if [ "$1" = "1" ]; then
  sleep 0.02
  ${stopResult}
else
  sleep 0.2
  touch ${JSON.stringify(finished)}
  ${plainResult}
fi
`);

  run(['--db', db, 'enqueue', '--repo', repo, '--issue', '1', '--model', 'model-a', '--trusted']);
  run(['--db', db, 'enqueue', '--repo', repo, '--issue', '2', '--model', 'model-b', '--trusted']);
  const result = run([
    '--db', db, 'drain', '--parallel', '2', '--executor', executor,
    '--stop-when', 'done', '--json',
  ]);

  assert.equal(result.exitCode, 0);
  const summary = JSON.parse(result.stdout);
  assert.equal(summary.stop, true);
  assert.equal(summary.ran, 2);
  assert.equal(summary.succeeded, 2);
  assert.equal(fs.existsSync(finished), true);
});

test('parallel drain waits for claimed peers before reporting infrastructure failure', () => {
  const root = tmpdir();
  const repo = makeGitRepo(root);
  const db = path.join(root, 'jobs.sqlite');
  const finished = path.join(root, 'peer-finished');
  const executor = makeExecutor(root, `#!/usr/bin/env bash
set -euo pipefail
sleep 0.2
touch ${JSON.stringify(finished)}
`);

  const broken = JSON.parse(run([
    '--db', db, 'enqueue', '--repo', repo, '--issue', '1', '--model', 'model-a',
    '--base', 'missing-branch', '--trusted', '--json',
  ]).stdout);
  const fine = JSON.parse(run(['--db', db, 'enqueue', '--repo', repo, '--issue', '2', '--model', 'model-b', '--trusted', '--json']).stdout);
  const result = run(['--db', db, 'drain', '--parallel', '2', '--executor', executor, '--json']);

  assert.notEqual(result.exitCode, 0);
  assert.match(result.stderr, /Failed to create isolated worktree/);
  assert.equal(fs.existsSync(finished), true);
  const listed = jobs(db);
  assert.equal(listed.find(job => job.id === broken.id).status, 'pending');
  assert.equal(listed.find(job => job.id === fine.id).status, 'succeeded');
  const claimed = [broken.id, fine.id].map(id => taskEvents(db, id).filter(event => event.event === 'claimed').length);
  assert.deepEqual(claimed, [1, 1]);
});

test('parallel drain retries blocked dependencies after predecessors finish', () => {
  const root = tmpdir();
  const repo = makeRepo(root);
  const db = path.join(root, 'jobs.sqlite');
  const executor = makeExecutor(root, `#!/usr/bin/env bash
set -euo pipefail
sleep 0.05
`);

  const first = JSON.parse(run(['--db', db, 'enqueue', '--repo', repo, '--issue', '1', '--model', 'model-a', '--trusted', '--json']).stdout);
  run(['--db', db, 'enqueue', '--repo', repo, '--issue', '2', '--model', 'model-b', '--trusted', '--depends-on', first.id]);
  const result = run(['--db', db, 'drain', '--parallel', '2', '--executor', executor, '--json']);

  assert.equal(result.exitCode, 0);
  const summary = JSON.parse(result.stdout);
  assert.equal(summary.succeeded, 2);
  assert.equal(summary.blocked, undefined);
});

test('resolveExecutor defaults to the repo-level pi-task.sh kernel', () => {
  assert.equal(resolveExecutor({ repo_path: '/tmp/target-repo' }, {}), path.resolve(__dirname, '..', 'pi-task.sh'));
  assert.equal(resolveExecutor({ repo_path: '/tmp/target-repo' }, { executor: '/tmp/custom.sh' }), '/tmp/custom.sh');
});

test('local CUA feedback worker passes preflight without claiming or launching a VM', () => {
  const db = path.join(tmpdir(), 'agentq.sqlite');
  const result = run(['--db', db, '--kind', 'feedback', 'run-next', '--cua', '--json']);
  assert.equal(result.exitCode, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), { status: 'idle' });
});

test('CUA mode selects only the feedback executor and has exclusive CLI options', () => {
  assert.equal(
    resolveExecutor({ kind: 'feedback' }, { cua: true }),
    path.resolve(__dirname, '..', 'src', 'runners', 'cua-feedback.js'),
  );
  assert.throws(() => resolveExecutor({ kind: 'github_issue' }, { cua: true }), /feedback jobs only/i);
  assert.equal(parseArgs(['run-next', '--cua']).options.cua, true);
  assert.throws(() => parseArgs(['drain', '--cua', '--sandbox', '/tmp/wrapper']), /mutually exclusive/i);
  assert.throws(() => parseArgs(['run-next', '--cua', '--executor', '/tmp/custom']), /cannot be combined/i);
  assert.throws(() => parseArgs(['drain', '--cua', '--parallel', '2']), /one concurrent VM/i);
});

test('--help works after any command', () => {
  for (const args of [
    ['review', '--help'],
    ['review', 'add', '--help'],
    ['enqueue', '-h'],
    ['paths', 'gaps', '--help'],
    ['enqueue', '--help'],
  ]) {
    const result = run(args);
    assert.equal(result.exitCode, 0, `${args.join(' ')}: ${result.stderr}`);
    assert.match(result.stdout, /Usage/);
    assert.equal(ownStderr(result.stderr), '');
  }
  const bogus = run(['review', '--bogus']);
  assert.notEqual(bogus.exitCode, 0);
  assert.match(bogus.stderr, /Unknown option for review/);
});

test('resolveExecutor prefers the job-persisted executor', () => {
  assert.equal(
    resolveExecutor({ repo_path: '/tmp/target-repo', executor: 'src/runners/jules-issue.js' }, {}),
    path.resolve(__dirname, '..', 'src', 'runners', 'jules-issue.js'),
  );
  // command-line --executor still wins over the job default when explicitly passed.
  assert.equal(resolveExecutor({ repo_path: '/tmp/target-repo', executor: 'src/runners/jules-issue.js' }, { executor: '/tmp/override.sh' }), '/tmp/override.sh');
});

test('enqueue --executor stores the override and run-next uses it', () => {
  const root = tmpdir();
  const repo = makeRepo(root);
  const db = path.join(root, 'jobs.sqlite');
  const executor = makeExecutor(root, `#!/usr/bin/env bash
set -euo pipefail
echo "custom-driver issue=$1 model=$2"
${emitResult(root, resultPayload({
    worktree: path.join(os.tmpdir(), 'pi-custom-55'),
    branch: 'custom/branch',
  }))}
`, 'custom-driver.sh');

  const { id } = JSON.parse(run(['--db', db, 'enqueue', '--repo', repo, '--issue', '55', '--model', 'jules', '--executor', executor, '--trusted', '--json']).stdout);
  const result = run(['--db', db, 'run-next', '--json']);
  assert.equal(result.exitCode, 0);
  assert.deepEqual(JSON.parse(result.stdout), { id, status: 'succeeded', exitCode: 0 });

  const [job] = jobs(db);
  assert.equal(job.model, 'jules');
  assert.equal(job.executor, executor);
  assert.equal(job.worktree_path, path.join(os.tmpdir(), 'pi-custom-55'));
  assert.equal(job.branch, 'custom/branch');
});

test('requeue moves a failed job back to pending and can change its model', () => {
  const root = tmpdir();
  const repo = makeRepo(root);
  const db = path.join(root, 'jobs.sqlite');
  const executor = makeExecutor(root, `#!/usr/bin/env bash
exit 7
`);

  const { id } = JSON.parse(run(['--db', db, 'enqueue', '--repo', repo, '--issue', '99', '--model', 'bad-model', '--trusted', '--json']).stdout);
  assert.equal(run(['--db', db, 'run-next', '--executor', executor, '--json']).exitCode, 7);

  const result = run(['--db', db, 'requeue', '--id', id, '--model', 'better-model', '--json']);

  assert.equal(result.exitCode, 0);
  assert.deepEqual(JSON.parse(result.stdout), { id, status: 'pending' });
  const [job] = jobs(db);
  assert.equal(job.status, 'pending');
  assert.equal(job.model, 'better-model');
  assert.equal(job.started_at, null);
  assert.equal(job.finished_at, null);
  assert.equal(job.exit_code, null);
  assert.equal(job.log_path, null);
});

test('requeue accepts a unique id prefix and refuses unknown ids', () => {
  const root = tmpdir();
  const db = path.join(root, 'jobs.sqlite');

  const unknown = run(['--db', db, 'requeue', '--id', '123', '--json']);
  assert.notEqual(unknown.exitCode, 0);
  assert.match(unknown.stderr, /No task found with id 123/);

  const repo = makeRepo(root);
  const executor = makeExecutor(root, '#!/usr/bin/env bash\nexit 7\n');
  const { id } = JSON.parse(run(['--db', db, 'enqueue', '--repo', repo, '--issue', '1', '--model', 'm', '--trusted', '--json']).stdout);
  assert.equal(run(['--db', db, 'run-next', '--executor', executor, '--json']).exitCode, 7);

  const result = run(['--db', db, 'requeue', '--id', id.slice(0, 6), '--json']);
  assert.equal(result.exitCode, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), { id, status: 'pending' });
});

test('an ambiguous id prefix is refused and lists the matches', () => {
  const root = tmpdir();
  const repo = makeRepo(root);
  const db = path.join(root, 'jobs.sqlite');
  const handle = openDb(db);
  let ids;
  try {
    ids = ['aaaaaaaa-1111-4111-8111-111111111111', 'aaaaaaaa-2222-4222-8222-222222222222'];
    for (const id of ids) {
      handle.prepare("INSERT INTO tasks (id, kind, status, repo, issue_num, created_at) VALUES (?, 'github_issue', 'pending', ?, 1, ?)")
        .run(id, repo, new Date().toISOString());
    }
  } finally {
    handle.close();
  }

  const result = run(['--db', db, 'requeue', '--id', 'aaaaaaaa', '--json']);
  assert.notEqual(result.exitCode, 0);
  assert.match(result.stderr, /Ambiguous id prefix aaaaaaaa matches 2 tasks/);
  for (const id of ids) assert.match(result.stderr, new RegExp(id));
});

test('run-next resolves an auto model through the routing core before executing', () => {
  const root = tmpdir();
  const repo = makeRepo(root);
  const db = path.join(root, 'jobs.sqlite');
  const fixture = writeRoutingFixture();
  const seenModel = path.join(root, 'model.txt');
  const executor = makeExecutor(root, `#!/usr/bin/env bash
set -euo pipefail
echo "$2" > ${JSON.stringify(seenModel)}
${emitResult(root, resultPayload())}
`);

  const { id } = JSON.parse(run(['--db', db, 'enqueue', '--repo', repo, '--issue', '304', '--model', 'auto', '--trusted', '--json']).stdout);

  const result = run(['--db', db, 'run-next', '--executor', executor, '--quota', fixture.quotaPath, '--json'], fixture.env());

  assert.equal(result.exitCode, 0);
  assert.deepEqual(JSON.parse(result.stdout), { id, status: 'succeeded', exitCode: 0 });
  assert.equal(fs.readFileSync(seenModel, 'utf8').trim(), CHEAP_MODEL);
  const [job] = jobs(db);
  assert.equal(job.model, CHEAP_MODEL);
  assert.equal(job.status, 'succeeded');
});

test('run-next fails loudly when no auto model is eligible instead of falling back', () => {
  const root = tmpdir();
  const repo = makeRepo(root);
  const db = path.join(root, 'jobs.sqlite');
  const fixture = writeRoutingFixture({ quota: { generatedAt: new Date().toISOString(), paths: {} } });
  const executor = makeExecutor(root, `#!/usr/bin/env bash
echo 'branch   : pi/issue-'"$1"
`);

  run(['--db', db, 'enqueue', '--repo', repo, '--issue', '304', '--model', 'auto', '--trusted']);

  const result = run(['--db', db, 'run-next', '--executor', executor, '--quota', fixture.quotaPath, '--json'], fixture.env());

  assert.notEqual(result.exitCode, 0);
  assert.match(result.stderr, /No model available for auto routing \(tier medium\)/);
  assert.match(result.stderr, /capacity unknown/);
  const [job] = jobs(db);
  assert.equal(job.status, 'pending');
  assert.equal(job.model, 'auto');
});

test('run-next --tier big raises the intelligence floor for auto routing', () => {
  const root = tmpdir();
  const repo = makeRepo(root);
  const db = path.join(root, 'jobs.sqlite');
  const fixture = writeRoutingFixture();
  const seenModel = path.join(root, 'model.txt');
  const executor = makeExecutor(root, `#!/usr/bin/env bash
set -euo pipefail
echo "$2" > ${JSON.stringify(seenModel)}
echo 'branch   : pi/issue-'"$1"
`);

  run(['--db', db, 'enqueue', '--repo', repo, '--issue', '304', '--model', 'auto', '--trusted']);

  const result = run(['--db', db, 'run-next', '--executor', executor, '--quota', fixture.quotaPath, '--tier', 'big', '--json'], fixture.env());

  assert.equal(result.exitCode, 0);
  // big floor 45 rejects the 40-intelligence cheap model.
  assert.equal(fs.readFileSync(seenModel, 'utf8').trim(), STRONG_MODEL);
});

test('run-next routes a spec task at the tier stored at enqueue', () => {
  const root = tmpdir();
  const repo = makeRepo(root);
  const db = path.join(root, 'jobs.sqlite');
  const spec = path.join(root, 'spec.md');
  fs.writeFileSync(spec, '# Tiered spec\n\nbody\n');
  const fixture = writeRoutingFixture();
  const seenModel = path.join(root, 'model.txt');
  const executor = makeExecutor(root, `#!/usr/bin/env bash
set -euo pipefail
echo "$2" > ${JSON.stringify(seenModel)}
${emitResult(root, resultPayload())}
`);

  run(['--db', db, 'enqueue', '--repo', repo, '--spec', spec, '--model', 'auto', '--tier', 'big', '--trusted']);

  // No --tier here: the task's stored tier must decide, or the later review
  // would be credited to a tier the run never used.
  const stored = run(['--db', db, '--kind', 'spec', 'run-next', '--executor', executor, '--quota', fixture.quotaPath, '--json'], fixture.env());
  assert.equal(stored.exitCode, 0, stored.stderr);
  assert.equal(fs.readFileSync(seenModel, 'utf8').trim(), STRONG_MODEL, 'big floor 45 rejects the 40-intelligence cheap model');

  // An explicit --tier still wins over the stored one.
  run(['--db', db, 'enqueue', '--repo', repo, '--spec', spec, '--model', 'auto', '--tier', 'big', '--trusted']);
  const explicit = run(['--db', db, '--kind', 'spec', 'run-next', '--executor', executor, '--quota', fixture.quotaPath, '--tier', 'small', '--json'], fixture.env());
  assert.equal(explicit.exitCode, 0, explicit.stderr);
  assert.equal(fs.readFileSync(seenModel, 'utf8').trim(), CHEAP_MODEL);
});

test('a retry re-resolves at the tier stored at enqueue', () => {
  const root = tmpdir();
  const repo = makeRepo(root);
  const db = path.join(root, 'jobs.sqlite');
  const spec = path.join(root, 'spec.md');
  fs.writeFileSync(spec, '# Retry tier\n\nbody\n');
  const fixture = writeRoutingFixture();
  const models = path.join(root, 'models.txt');
  const count = path.join(root, 'count');
  const executor = makeExecutor(root, `#!/usr/bin/env bash
set -euo pipefail
echo "$2" >> ${JSON.stringify(models)}
n=$(cat ${JSON.stringify(count)} 2>/dev/null || echo 0)
n=$((n + 1))
echo "$n" > ${JSON.stringify(count)}
if [ "$n" -eq 1 ]; then exit 7; fi
${emitResult(root, resultPayload())}
`);

  run(['--db', db, 'enqueue', '--repo', repo, '--spec', spec, '--model', 'auto', '--tier', 'big', '--trusted']);

  const result = run([
    '--db', db, '--kind', 'spec', 'run-next', '--executor', executor,
    '--quota', fixture.quotaPath, '--retry', '1', '--retry-base-ms', '1', '--json',
  ], fixture.env());
  assert.equal(result.exitCode, 0, result.stderr);
  const seen = fs.readFileSync(models, 'utf8').trim().split('\n');
  assert.equal(seen.length, 2, 'the failed attempt and its retry both ran');
  assert.deepEqual(seen, [STRONG_MODEL, STRONG_MODEL], 'the retry must not fall back to the default tier');
});

test('run-next rejects an unknown --tier', () => {
  const root = tmpdir();
  const db = path.join(root, 'jobs.sqlite');
  const result = run(['--db', db, 'run-next', '--tier', 'huge']);
  assert.notEqual(result.exitCode, 0);
  assert.match(result.stderr, /Unknown tier: huge \(expected small\|medium\|big\)/);
});

test('pick reports the routing decision as JSON and exits non-zero when nothing is eligible', () => {
  const fixture = writeRoutingFixture();
  const picked = run(['pick', '--quota', fixture.quotaPath, '--json'], fixture.env());
  assert.equal(picked.exitCode, 0);
  const decision = JSON.parse(picked.stdout);
  assert.equal(decision.tier, 'medium');
  assert.equal(decision.default.id, CHEAP_MODEL);
  assert.equal(decision.default.path, 'mistral');
  assert.ok(decision.rejected.length > 0);

  fixture.writeQuota(quotaFixture({ mistral: null, codex: null }));
  const none = run(['pick', '--quota', fixture.quotaPath, '--json'], fixture.env());
  assert.equal(none.exitCode, 1);
  assert.equal(JSON.parse(none.stdout).default, null);
});

test('pick --tier changes the recommendation and prints the options table without --json', () => {
  const fixture = writeRoutingFixture();
  const small = run(['pick', '--quota', fixture.quotaPath, '--tier', 'small', '--json'], fixture.env());
  assert.equal(JSON.parse(small.stdout).default.id, CHEAP_MODEL);

  const big = run(['pick', '--quota', fixture.quotaPath, '--tier', 'big', '--json'], fixture.env());
  assert.equal(JSON.parse(big.stdout).default.id, STRONG_MODEL);

  const table = run(['pick', '--quota', fixture.quotaPath], fixture.env());
  assert.equal(table.exitCode, 0);
  // The shortlist, with the roles each option plays, and `default` underneath
  // as a footnote rather than a verdict.
  assert.match(table.stdout, /options \(tier medium\)/);
  assert.match(table.stdout, /mistral\/deepseek-v4-1-flash-1017 +mistral +cheapest, expiring, best-value/);
  assert.match(table.stdout, /openai-codex\/gpt-5\.6-luna +codex +smartest/);
  assert.match(table.stdout, /default → mistral\/deepseek-v4-1-flash-1017/);
  assert.doesNotMatch(table.stdout, /auto → /);
});

test('pick leaves an explicit model untouched', () => {
  const result = run(['pick', '--model', 'some/explicit-model', '--json']);
  assert.equal(result.exitCode, 0);
  assert.deepEqual(JSON.parse(result.stdout), {
    model: 'some/explicit-model', provider: null, explicit: true, tier: 'medium',
  });
});

test('drain resolves auto models for each job it runs', () => {
  const root = tmpdir();
  const repo = makeRepo(root);
  const db = path.join(root, 'jobs.sqlite');
  const fixture = writeRoutingFixture();
  const callsFile = path.join(root, 'calls.txt');
  const executor = makeExecutor(root, `#!/usr/bin/env bash
set -euo pipefail
echo "$1 $2" >> ${JSON.stringify(callsFile)}
echo 'branch   : pi/issue-'"$1"
`);

  run(['--db', db, 'enqueue', '--repo', repo, '--issue', '304', '--model', 'auto', '--trusted']);
  run(['--db', db, 'enqueue', '--repo', repo, '--issue', '305', '--model', 'auto', '--trusted']);

  const result = run(['--db', db, 'drain', '--executor', executor, '--quota', fixture.quotaPath, '--json'], fixture.env());

  assert.equal(result.exitCode, 0);
  assert.deepEqual(JSON.parse(result.stdout), { status: 'drained', ran: 2, succeeded: 2, failed: 0, unverified: 0 });
  const lines = fs.readFileSync(callsFile, 'utf8').trim().split('\n');
  assert.equal(lines[0], `304 ${CHEAP_MODEL}`);
  assert.equal(lines[1], `305 ${CHEAP_MODEL}`);
  const models = jobs(db).map(j => j.model);
  assert.deepEqual(models, [CHEAP_MODEL, CHEAP_MODEL]);
});

test('run-next marks succeeded when --verify passes in the worktree', () => {
  const root = tmpdir();
  const repo = makeRepo(root);
  const db = path.join(root, 'jobs.sqlite');
  const wt = path.join(root, 'wt-304');
  fs.mkdirSync(wt);
  fs.writeFileSync(path.join(wt, 'marker'), 'ok');
  const executor = makeExecutor(root, `#!/usr/bin/env bash
set -euo pipefail
${emitResult(root, resultPayload({ worktree: wt, branch: 'pi/issue-304' }))}
`);

  run(['--db', db, 'enqueue', '--repo', repo, '--issue', '304', '--model', 'm', '--trusted']);
  const result = run(['--db', db, 'run-next', '--executor', executor, '--verify', 'test -f marker', '--json']);

  assert.equal(result.exitCode, 0);
  assert.equal(JSON.parse(result.stdout).status, 'succeeded');
  const [job] = jobs(db);
  assert.equal(job.status, 'succeeded');
  assert.equal(job.verified, 1);
});

test('run-next marks unverified when executor succeeds but --verify fails', () => {
  const root = tmpdir();
  const repo = makeRepo(root);
  const db = path.join(root, 'jobs.sqlite');
  const wt = path.join(root, 'wt-99');
  fs.mkdirSync(wt);
  const executor = makeExecutor(root, `#!/usr/bin/env bash
set -euo pipefail
${emitResult(root, resultPayload({ worktree: wt, branch: 'pi/issue-99' }))}
`);

  run(['--db', db, 'enqueue', '--repo', repo, '--issue', '99', '--model', 'm', '--trusted']);
  const result = run(['--db', db, 'run-next', '--executor', executor, '--verify', 'test -f missing', '--json']);

  assert.notEqual(result.exitCode, 0);
  const out = JSON.parse(result.stdout);
  assert.equal(out.status, 'unverified');
  const [job] = jobs(db);
  assert.equal(job.status, 'unverified');
  assert.equal(job.exit_code, 0);
  assert.equal(job.verified, 0);
  assert.match(fs.readFileSync(job.log_path, 'utf8'), /--- verify ---/);
});

test('run-next without --verify is unchanged (verified stays null)', () => {
  const root = tmpdir();
  const repo = makeRepo(root);
  const db = path.join(root, 'jobs.sqlite');
  const wt = path.join(root, 'wt-7');
  fs.mkdirSync(wt);
  const executor = makeExecutor(root, `#!/usr/bin/env bash
set -euo pipefail
${emitResult(root, resultPayload({ worktree: wt, branch: 'pi/issue-7' }))}
`);

  run(['--db', db, 'enqueue', '--repo', repo, '--issue', '7', '--model', 'm', '--trusted']);
  const result = run(['--db', db, 'run-next', '--executor', executor, '--json']);

  assert.equal(result.exitCode, 0);
  const [job] = jobs(db);
  assert.equal(job.status, 'succeeded');
  assert.equal(job.verified, null);
});

test('recover resets stale running jobs back to pending', () => {
  const root = tmpdir();
  const repo = makeRepo(root);
  const db = path.join(root, 'jobs.sqlite');

  const stale = JSON.parse(run(['--db', db, 'enqueue', '--repo', repo, '--issue', '1', '--model', 'm', '--json']).stdout);
  const fresh = JSON.parse(run(['--db', db, 'enqueue', '--repo', repo, '--issue', '2', '--model', 'm', '--json']).stdout);

  // Synthesize running LOCAL claims (this host) with controlled start times:
  // task 1 is stale, task 2 is fresh. Neither has a pid file, so only the
  // age decides.
  const localWorker = `local-${os.hostname()}-999999`;
  const handle = openDb(db);
  try {
    const old = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString();
    handle.prepare("UPDATE tasks SET status = 'running', claimed_by = ?, claim_token = 't1', started_at = ?, lease_expires_at = ?, attempts = 1 WHERE id = ?")
      .run(localWorker, old, old, stale.id);
    handle.prepare("UPDATE tasks SET status = 'running', claimed_by = ?, claim_token = 't2', started_at = ?, lease_expires_at = ?, attempts = 1 WHERE id = ?")
      .run(localWorker, new Date().toISOString(), new Date(Date.now() + 60 * 60 * 1000).toISOString(), fresh.id);
  } finally {
    handle.close();
  }

  const result = run(['--db', db, 'recover', '--max-age-min', '60', '--json']);

  assert.equal(result.exitCode, 0);
  const recovered = JSON.parse(result.stdout);
  assert.equal(recovered.recovered, 1);
  assert.equal(recovered.skipped, 1);

  const listed = jobs(db);
  assert.equal(listed.find(j => j.id === stale.id).status, 'pending');
  assert.equal(listed.find(j => j.id === fresh.id).status, 'running');
});

test('recover with no stale jobs returns zero', () => {
  const root = tmpdir();
  const repo = makeRepo(root);
  const db = path.join(root, 'jobs.sqlite');

  run(['--db', db, 'enqueue', '--repo', repo, '--issue', '1', '--model', 'm']);
  const result = run(['--db', db, 'recover', '--json']);

  const recovered = JSON.parse(result.stdout);
  assert.equal(recovered.recovered, 0);
  assert.equal(recovered.skipped, 0);
});

test('cancel kills a running executor and records the task as failed', () => {
  const root = tmpdir();
  const repo = makeRepo(root);
  const db = path.join(root, 'jobs.sqlite');
  const { id } = JSON.parse(run(['--db', db, 'enqueue', '--repo', repo, '--issue', '1', '--model', 'm', '--trusted', '--json']).stdout);

  // A running task with a live executor pid (this process) is cancelled by
  // killing that pid tree; the task is then recorded as failed.
  const handle = openDb(db);
  try {
    handle.prepare("UPDATE tasks SET status = 'running', claimed_by = 'w', claim_token = 't', started_at = ? WHERE id = ?")
      .run(new Date().toISOString(), id);
  } finally {
    handle.close();
  }
  fs.mkdirSync(path.join(root, 'logs'), { recursive: true });
  fs.writeFileSync(path.join(root, 'logs', `agentq-job-${id}.pid`), String(process.pid));

  const result = run(['--db', db, 'cancel', '--id', id, '--json']);
  assert.equal(result.exitCode, 0, result.stderr);
  const out = JSON.parse(result.stdout);
  assert.equal(out.cancelled, true);
  assert.equal(out.status, 'failed');
  const [job] = jobs(db);
  assert.equal(job.status, 'failed');
  assert.equal(job.claimed_by, null);
});

test('enqueue defaults to untrusted (code is executable text)', () => {
  const root = tmpdir();
  const repo = makeRepo(root);
  const db = path.join(root, 'jobs.sqlite');

  run(['--db', db, 'enqueue', '--repo', repo, '--issue', '42', '--model', 'm', '--json']);

  const [job] = jobs(db);
  assert.equal(job.trusted, 0, 'jobs are untrusted by default');
});

test('a task row without a trust level fails closed', () => {
  const root = tmpdir();
  const db = path.join(root, 'jobs.sqlite');
  const handle = openDb(db);
  try {
    const task = dbModule.createTask(handle, { kind: 'prompt', prompt: 'x' });
    assert.equal(taskToJob(dbModule.getTask(handle, task.id)).trusted, 0);
  } finally {
    handle.close();
  }
});

test('enqueue --trusted marks the job as trusted', () => {
  const root = tmpdir();
  const repo = makeRepo(root);
  const db = path.join(root, 'jobs.sqlite');

  run(['--db', db, 'enqueue', '--repo', repo, '--issue', '42', '--model', 'm', '--trusted', '--json']);

  const [job] = jobs(db);
  assert.equal(job.trusted, 1);
});

function runAsync(args, env = {}) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [AGENTQ, ...args], {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, AGENTQ_QUOTA_REFRESH: '0', ...githubEnv(), ...env },
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', d => { stdout += d; });
    child.stderr.on('data', d => { stderr += d; });
    child.on('close', exitCode => resolve({ exitCode, stdout, stderr }));
  });
}

test('two concurrent run-next processes do not both claim the same job', async () => {
  const root = tmpdir();
  const repo = makeRepo(root);
  const db = path.join(root, 'jobs.sqlite');
  const ranLog = path.join(root, 'ran.log');
  // Slow enough that both processes reach the claim while neither has
  // finished, if the claim were not atomic.
  const executor = makeExecutor(root, `#!/usr/bin/env bash
set -euo pipefail
echo "$$" >> "${ranLog}"
sleep 0.3
`);

  run(['--db', db, 'enqueue', '--repo', repo, '--issue', '42', '--model', 'm', '--trusted']);

  const [a, b] = await Promise.all([
    runAsync(['--db', db, 'run-next', '--executor', executor, '--json']),
    runAsync(['--db', db, 'run-next', '--executor', executor, '--json']),
  ]);

  const ranCount = fs.existsSync(ranLog)
    ? fs.readFileSync(ranLog, 'utf8').split('\n').filter(Boolean).length
    : 0;
  assert.equal(ranCount, 1, `executor ran ${ranCount} times, expected exactly once: ${JSON.stringify({ a, b })}`);

  const statuses = [a, b].map(r => { try { return JSON.parse(r.stdout).status; } catch { return null; } });
  assert.ok(statuses.includes('succeeded'), `neither run reported succeeded: ${JSON.stringify(statuses)}`);
  assert.equal(statuses.filter(s => s === 'succeeded').length, 1, `expected exactly one succeeded run: ${JSON.stringify(statuses)}`);
});

test('two SqliteSource instances never claim the same task', async () => {
  const root = tmpdir();
  const repo = makeRepo(root);
  const dbPath = path.join(root, 'jobs.sqlite');
  const writer = new SqliteSource(dbPath, {
    issueRunner: (_command, args) => {
      const number = Number(args[2]);
      return JSON.stringify({ number, title: 't', body: 'b', url: `https://github.com/a/b/issues/${number}`, updatedAt: '2026-01-01T00:00:00Z' });
    },
  });
  await writer.enqueue({ repo, issue: '1', model: 'm', trusted: true });
  await writer.enqueue({ repo, issue: '2', model: 'm', trusted: true });

  const a = new SqliteSource(dbPath);
  const b = new SqliteSource(dbPath);
  try {
    const [first, second] = await Promise.all([a.claimNext(), b.claimNext()]);
    assert.ok(first && second);
    assert.notEqual(first.id, second.id, 'each instance must claim a different task');
    assert.equal(await a.claimNext(), null);
    assert.equal(await b.claimNext(), null);
    const claimed = a.status().filter(job => job.status === 'running');
    assert.equal(claimed.length, 2);
  } finally {
    await a.stop();
    await b.stop();
    await writer.stop();
  }
});

test('drain reports "busy" (not "drained") while another connection holds the write lock', () => {
  const root = tmpdir();
  const repo = makeRepo(root);
  const db = path.join(root, 'jobs.sqlite');
  run(['--db', db, 'enqueue', '--repo', repo, '--issue', '1', '--model', 'm', '--trusted']);

  // Hold a write transaction on the queue from this process: the child's
  // claim cannot proceed, and must not report an empty queue.
  const holder = new DatabaseSync(db);
  holder.exec('PRAGMA busy_timeout=0');
  holder.exec('BEGIN IMMEDIATE');
  try {
    const result = run(['--db', db, 'drain', '--json'], { AGENTQ_BUSY_TIMEOUT_MS: '100' });
    const summary = JSON.parse(result.stdout);
    assert.equal(summary.status, 'busy');
    assert.equal(summary.ran, 0);
  } finally {
    holder.exec('ROLLBACK');
    holder.close();
  }
  assert.equal(jobs(db)[0].status, 'pending');
});

test('a .log --db path is refused with the import instruction', () => {
  const root = tmpdir();
  const logPath = path.join(root, 'agentq.log');
  fs.writeFileSync(logPath, `${JSON.stringify({ id: 1, event: 'enqueued', repo: '/tmp/r', issue: 9, model: 'm' })}\n`);

  for (const args of [['status', '--json'], ['enqueue', '--repo', root, '--issue', '1', '--json']]) {
    const result = run(['--db', logPath, ...args]);
    assert.notEqual(result.exitCode, 0);
    assert.match(result.stderr, /agentq now stores its queue in SQLite/);
    assert.match(result.stderr, /agentq import-log --log <path>/);
  }
  // The legacy log is untouched: no SQLite header was written into it.
  assert.match(fs.readFileSync(logPath, 'utf8'), /"event":"enqueued"/);
});

test('a JSONL log renamed to .sqlite is still refused', () => {
  const root = tmpdir();
  const disguised = path.join(root, 'queue.sqlite');
  fs.writeFileSync(disguised, '{"id":1,"event":"enqueued"}\n');

  const result = run(['--db', disguised, 'status', '--json']);
  assert.notEqual(result.exitCode, 0);
  assert.match(result.stderr, /agentq now stores its queue in SQLite/);
});

test('import-log is a one-shot, idempotent import of a legacy log', () => {
  const root = tmpdir();
  const db = path.join(root, 'jobs.sqlite');
  const logPath = path.join(root, 'agentq.log');
  const events = [
    { id: 1, event: 'enqueued', repo: '/x', issue: 7, model: 'm', base: 'main', trusted: 1, deps: [], ts: '2020-01-01T00:00:00Z' },
    { id: 1, event: 'claimed', model: 'm', ts: '2020-01-01T00:01:00Z' },
    { id: 1, event: 'finished', status: 'unverified', exit: 0, verified: 0, ts: '2020-01-01T00:02:00Z' },
    { id: 2, event: 'enqueued', repo: '/x', issue: 8, model: 'm', base: 'main', trusted: 0, deps: [1], ts: '2020-01-01T00:03:00Z' },
  ];
  fs.writeFileSync(logPath, `${events.map(event => JSON.stringify(event)).join('\n')}\n`);

  const first = run(['--db', db, 'import-log', '--log', logPath, '--json']);
  assert.equal(first.exitCode, 0, first.stderr);
  assert.deepEqual(JSON.parse(first.stdout), { migrated: 2, skipped: 0, collisions: [] });

  const second = run(['--db', db, 'import-log', '--log', logPath, '--json']);
  assert.equal(second.exitCode, 0, second.stderr);
  assert.deepEqual(JSON.parse(second.stdout), { migrated: 0, skipped: 2, collisions: [] });

  const handle = openDb(db);
  try {
    assert.equal(dbModule.listTasks(handle, {}).length, 2, 'a re-import must not duplicate tasks');
    assert.equal(dbModule.getTask(handle, '1').status, 'unverified');
    assert.deepEqual(dbModule.listDependencies(handle, '2').map(row => row.depends_on_task_id), ['1']);
  } finally {
    handle.close();
  }
});

test('import-log requires an existing --log file', () => {
  const root = tmpdir();
  const result = run(['--db', path.join(root, 'jobs.sqlite'), 'import-log', '--log', path.join(root, 'missing.log')]);
  assert.notEqual(result.exitCode, 0);
  assert.match(result.stderr, /Log file not found/);
});

test('enqueue --untrusted explicitly marks the job as untrusted', () => {
  const root = tmpdir();
  const repo = makeRepo(root);
  const db = path.join(root, 'jobs.sqlite');

  run(['--db', db, 'enqueue', '--repo', repo, '--issue', '42', '--model', 'm', '--untrusted', '--json']);

  const [job] = jobs(db);
  assert.equal(job.trusted, 0);
});

test('run-next refuses a default untrusted job without a sandbox', () => {
  const root = tmpdir();
  const repo = makeRepo(root);
  const db = path.join(root, 'jobs.sqlite');
  const executor = makeExecutor(root, `#!/usr/bin/env bash
echo ran
`);

  // Jobs default to untrusted
  const { id } = JSON.parse(run(['--db', db, 'enqueue', '--repo', repo, '--issue', '42', '--model', 'm', '--json']).stdout);
  const result = run(['--db', db, 'run-next', '--executor', executor, '--json']);

  // Admission is the claim's candidate filter: the job is skipped, never
  // claimed, so it stays pending with no state change at all. The refusal is
  // reported instead of pretending the queue is empty.
  assert.equal(result.exitCode, 2);
  const out = JSON.parse(result.stdout);
  assert.equal(out.status, 'refused');
  assert.equal(out.refused.length, 1);
  assert.equal(out.refused[0].id, id);
  assert.match(out.refused[0].reason, /Refusing untrusted job/);
  assert.match(result.stderr, new RegExp(`job ${id.slice(0, 8)}: Refusing untrusted job`));
  const [job] = jobs(db);
  assert.equal(job.status, 'pending');
  assert.equal(job.claimed_by, null);
});

test('default local worker skips feedback tasks and continues to GitHub issues', () => {
  const root = tmpdir();
  const repo = makeRepo(root);
  const db = path.join(root, 'jobs.sqlite');
  const executor = makeExecutor(root, `#!/usr/bin/env bash
echo ran
`);
  const handle = openDb(db);
  let feedback;
  try {
    feedback = dbModule.createTask(handle, {
      kind: 'feedback', repo, prompt: 'untrusted', model: 'm', trust_level: 'trusted_agent',
    });
  } finally {
    handle.close();
  }
  run(['--db', db, 'enqueue', '--repo', repo, '--issue', '42', '--model', 'm', '--trusted']);

  const result = run(['--db', db, 'run-next', '--executor', executor, '--json']);
  assert.equal(result.exitCode, 0);
  const out = JSON.parse(result.stdout);
  assert.equal(out.status, 'succeeded');
  assert.notEqual(out.id, feedback.id);
  const listed = jobs(db);
  assert.equal(listed.find(job => job.id === feedback.id).status, 'pending');
  assert.equal(listed.find(job => job.id === out.id).status, 'succeeded');
});

test('a malformed feedback job stays pending instead of aborting the drain', () => {
  const root = tmpdir();
  const repo = makeRepo(root);
  const db = path.join(root, 'jobs.sqlite');
  const ran = path.join(root, 'ran');
  const executor = makeExecutor(root, `#!/usr/bin/env bash
touch ${JSON.stringify(ran)}
exit 0
`);
  const sandbox = makeExecutor(root, `#!/usr/bin/env bash
exec "$@"
`, 'sandbox.sh');
  const handle = openDb(db);
  try {
    dbModule.createTask(handle, { kind: 'feedback', repo, model: 'm', trust_level: 'trusted_agent' });
  } finally {
    handle.close();
  }

  const result = run([
    '--db', db, '--kind', 'feedback', 'drain', '--parallel', '2',
    '--executor', executor, '--sandbox', sandbox, '--json',
  ]);
  // Admission refuses the job (no prompt payload) as a claim candidate, so it
  // is skipped rather than claimed and failed — and the drain says so.
  assert.equal(result.exitCode, 2, result.stderr);
  const out = JSON.parse(result.stdout);
  assert.equal(out.ran, 0);
  assert.equal(out.status, 'refused');
  assert.match(out.refused[0].reason, /no prompt payload/);
  assert.equal(fs.existsSync(ran), false);
  const [job] = jobs(db);
  assert.equal(job.status, 'pending');
});

test('run-next refuses trusted feedback without a sandbox and leaves it pending', () => {
  const root = tmpdir();
  const repo = makeRepo(root);
  const db = path.join(root, 'jobs.sqlite');
  const executor = makeExecutor(root, `#!/usr/bin/env bash
 echo ran
`);
  const handle = openDb(db);
  try {
    dbModule.createTask(handle, {
      kind: 'feedback', repo, prompt: '{"text":"untrusted"}', model: 'm', trust_level: 'trusted_agent',
    });
  } finally {
    handle.close();
  }

  const result = run(['--db', db, '--kind', 'feedback', 'run-next', '--executor', executor, '--json']);
  assert.notEqual(result.exitCode, 0);
  assert.match(result.stderr, /feedback workers require --sandbox/i);
  const [job] = jobs(db);
  assert.equal(job.status, 'pending');
});

test('run-next runs a default untrusted job when --sandbox wraps the executor', () => {
  const root = tmpdir();
  const repo = makeRepo(root);
  const db = path.join(root, 'jobs.sqlite');
  const sandbox = makeExecutor(root, `#!/usr/bin/env bash
set -euo pipefail
echo "sandbox got: $@"
exec "$@"
`, 'sandbox.sh');
  const executor = makeExecutor(root, `#!/usr/bin/env bash
set -euo pipefail
${emitResult(root, resultPayload({ worktree: root, branch: 'pi/issue-42' }))}
`, 'executor.sh');

  // Jobs default to untrusted
  run(['--db', db, 'enqueue', '--repo', repo, '--issue', '42', '--model', 'm']);
  const result = run(['--db', db, 'run-next', '--executor', executor, '--sandbox', sandbox, '--json']);

  assert.equal(result.exitCode, 0);
  assert.equal(JSON.parse(result.stdout).status, 'succeeded');
  assert.match(fs.readFileSync(jobs(db)[0].log_path, 'utf8'), /sandbox got:/);
});

test('run-next runs a default untrusted job with --allow-untrusted override', () => {
  const root = tmpdir();
  const repo = makeRepo(root);
  const db = path.join(root, 'jobs.sqlite');
  const executor = makeExecutor(root, `#!/usr/bin/env bash
set -euo pipefail
${emitResult(root, resultPayload({ worktree: root, branch: 'pi/issue-42' }))}
`);

  // Jobs default to untrusted
  run(['--db', db, 'enqueue', '--repo', repo, '--issue', '42', '--model', 'm']);
  const result = run(['--db', db, 'run-next', '--executor', executor, '--allow-untrusted', '--json']);

  assert.equal(result.exitCode, 0);
  const [job] = jobs(db);
  assert.equal(job.status, 'succeeded');
});

test('formatModelRow marks the recommended row and shows capacity plus the rejection reason', () => {
  const recommended = formatModelRow({
    model: CHEAP_MODEL, path: 'mistral', intelligence: 40, costPerMTok: 0.1,
    capacity: { state: 'available', headroomPct: 90 }, recommended: true, reasons: ['intelligence 40 >= floor 38'],
  }, 1);
  assert.match(recommended, /→ 1/);
  assert.match(recommended, /mistral\/deepseek-v4-1-flash-1017/);
  assert.match(recommended, /mistral/);
  assert.match(recommended, /90% left/);
  assert.match(recommended, /recommended/);

  const rejected = formatModelRow({
    model: STRONG_MODEL, path: 'codex', intelligence: 60, costPerMTok: 2,
    capacity: { state: 'saturated', headroomPct: 5 }, recommended: false,
    reasons: ['intelligence 60 >= floor 38', 'capacity saturated: 5% headroom'],
  }, 2);
  assert.doesNotMatch(rejected, /→/);
  assert.match(rejected, /saturated \(5% left\)/);
  assert.match(rejected, /capacity saturated/);
});

test('formatModelRow reports unknown capacity as unknown, never as available', () => {
  const line = formatModelRow({
    model: STRONG_MODEL, path: 'codex', intelligence: 60, costPerMTok: 2,
    capacity: { state: 'unknown', headroomPct: null, reason: 'quota data stale' },
    recommended: false, reasons: ['capacity unknown: quota data stale'],
  }, 1);
  assert.match(line, /unknown \(quota data stale\)/);
  assert.doesNotMatch(line, /available/);
});

test('truncateRepo shows the repo name from a full local path', () => {
  assert.equal(truncateRepo('/home/dev/projects/gadgets'), 'gadgets');
  assert.equal(truncateRepo('/home/dev/src/widgets'), 'widgets');
});

test('formatJobBlock renders a multi-line status block with the fields that matter for review', () => {
  const job = {
    id: '5b1e0d0a-0000-4000-8000-000000000005', status: 'succeeded', issue_number: 304, model: 'cline-pass/kimi-k2.7-code',
    repo_path: '/home/dev/projects/gadgets', branch: 'pi/issue-304',
    verified: 1, exit_code: 0, usage_json: JSON.stringify({ totalCost: 0.0176 }),
    started_at: '2026-07-02T20:00:00Z', finished_at: '2026-07-02T20:05:00Z',
    worktree_path: '/tmp/wt-304', log_path: '/data/logs/agentq-job-5.log',
  };
  const block = formatJobBlock(job);
  assert.match(block, /#5b1e0d0a/);
  assert.match(block, /succeeded/);
  assert.match(block, /gadgets#304/);
  assert.match(block, /cline-pass\/kimi-k2\.7-code/);
  assert.match(block, /pi\/issue-304/);
  assert.match(block, /\$0\.0176/);
  assert.match(block, /✓/);
  assert.match(block, /worktree: .*wt-304/);
  assert.match(block, /log: .*agentq-job-5\.log/);
});

test('formatJobBlock shows ✗ for unverified and omits cost when missing', () => {
  const job = {
    id: 'unverified-job', status: 'unverified', issue_number: 99, model: 'umans-coder',
    repo_path: '/home/dev/projects/gadgets', verified: 0, exit_code: 0,
    started_at: null, finished_at: null, usage_json: null,
  };
  const block = formatJobBlock(job);
  assert.match(block, /✗/);
  assert.doesNotMatch(block, /\$/);
});

test('summarizeCosts returns total cost and job count from usage_json fields', () => {
  const jobsList = [
    { usage_json: JSON.stringify({ totalCost: 0.0176 }) },
    { usage_json: JSON.stringify({ totalCost: 0.0032 }) },
    { usage_json: null },
    { usage_json: JSON.stringify({ cost: 0.0014 }) },
    { usage_json: 'invalid' },
  ];
  const s = summarizeCosts(jobsList);
  assert.equal(s.jobs, 3);
  assert.equal(s.total, 0.0222);
});

test('summarizeCosts returns zero jobs and zero cost for empty or all-null arrays', () => {
  assert.deepEqual(summarizeCosts([]), { jobs: 0, total: 0 });
  assert.deepEqual(summarizeCosts([{ usage_json: null }]), { jobs: 0, total: 0 });
});

// --- auto-retry with exponential backoff (--retry) ---

test('run-next --retry retries a transiently failing job until it succeeds', () => {
  const root = tmpdir();
  const repo = makeRepo(root);
  const db = path.join(root, 'jobs.sqlite');
  // Stateful executor: fails the first 2 attempts, succeeds on the 3rd.
  const executor = makeExecutor(root, `#!/usr/bin/env bash
set -euo pipefail
n=$(cat "$PWD/counter" 2>/dev/null || echo 0)
n=$((n+1))
echo "$n" > "$PWD/counter"
if [ "$n" -lt 3 ]; then
  echo "attempt $n failing"
  exit 7
fi
echo "attempt $n succeeding"
${emitResult(root, resultPayload({ branch: 'pi/issue-304' }))}
`);

  const { id } = JSON.parse(run(['--db', db, 'enqueue', '--repo', repo, '--issue', '304', '--model', 'm', '--trusted', '--json']).stdout);
  const result = run(['--db', db, 'run-next', '--executor', executor, '--retry', '3', '--retry-base-ms', '0', '--json']);

  assert.equal(result.exitCode, 0);
  assert.deepEqual(JSON.parse(result.stdout), { id, status: 'succeeded', exitCode: 0, retries: 2 });
  assert.equal(fs.readFileSync(path.join(repo, 'counter'), 'utf8').trim(), '3');
  const [job] = jobs(db);
  assert.equal(job.status, 'succeeded');
  // The store records the two auto-retries as requeued events.
  const requeues = taskEvents(db, id).filter(event => event.event === 'requeued');
  assert.equal(requeues.length, 2);
  assert.equal(taskEvents(db, id).filter(event => event.event === 'claimed').length, 3);
});

test('run-next --retry marks failed after exhausting retries', () => {
  const root = tmpdir();
  const repo = makeRepo(root);
  const db = path.join(root, 'jobs.sqlite');
  const executor = makeExecutor(root, `#!/usr/bin/env bash
echo nope
exit 7
`);

  const { id } = JSON.parse(run(['--db', db, 'enqueue', '--repo', repo, '--issue', '99', '--model', 'm', '--trusted', '--json']).stdout);
  const result = run(['--db', db, 'run-next', '--executor', executor, '--retry', '2', '--retry-base-ms', '0', '--json']);

  assert.equal(result.exitCode, 7);
  assert.deepEqual(JSON.parse(result.stdout), { id, status: 'failed', exitCode: 7, retries: 2, result_file: 'missing' });
  const [job] = jobs(db);
  assert.equal(job.status, 'failed');
});

test('run-next without --retry is unchanged (a single failed attempt, no retries field)', () => {
  const root = tmpdir();
  const repo = makeRepo(root);
  const db = path.join(root, 'jobs.sqlite');
  const executor = makeExecutor(root, `#!/usr/bin/env bash
exit 7
`);

  const { id } = JSON.parse(run(['--db', db, 'enqueue', '--repo', repo, '--issue', '99', '--model', 'm', '--trusted', '--json']).stdout);
  const result = run(['--db', db, 'run-next', '--executor', executor, '--json']);

  assert.equal(result.exitCode, 7);
  assert.deepEqual(JSON.parse(result.stdout), { id, status: 'failed', exitCode: 7, result_file: 'missing' });
  assert.equal(taskEvents(db, id).filter(event => event.event === 'requeued').length, 0);
});

test('runJobWithRetries non-blocking backoff allows parallel work/heartbeats to continue', async () => {
  const { runJobWithRetries } = require('../src/runners/execute.js');
  let heartbeats = 0;
  const timer = setInterval(() => { heartbeats++; }, 10);

  const root = tmpdir();
  const repo = makeRepo(root);
  const dbPath = path.join(root, 'jobs.sqlite');
  const executor = makeExecutor(root, '#!/usr/bin/env bash\nexit 7\n');

  const source = new SqliteSource(dbPath, {
    issueRunner: (_command, args) => {
      const number = Number(args[2]);
      return JSON.stringify({ number, title: 't', body: 'b', url: `https://github.com/a/b/issues/${number}`, updatedAt: '2026-01-01T00:00:00Z' });
    },
  });
  const job = await (async () => {
    await source.enqueue({ repo, issue: '1', model: 'test-model', trusted: true });
    return source.claimNext();
  })();

  try {
    const result = await runJobWithRetries(job, {
      retries: 1,
      retryBaseMs: 60,
      executor,
      allowUntrusted: true,
    }, source);

    assert.equal(result.status, 'failed');
    assert.equal(result.retries, 1);
    assert.ok(heartbeats >= 3, `Heartbeats must continue during retry backoff, got ${heartbeats}`);
    assert.equal(source.status()[0].status, 'failed');
  } finally {
    clearInterval(timer);
    await source.stop();
    fs.rmSync(root, { recursive: true });
  }
});

// --- natural-language stop condition (--stop-when) ---

test('run-next --stop-when passes the condition to the executor via AGENTQ_STOP_WHEN env', () => {
  const root = tmpdir();
  const repo = makeRepo(root);
  const db = path.join(root, 'jobs.sqlite');
  const executor = makeExecutor(root, `#!/usr/bin/env bash
set -euo pipefail
echo "stopwhen=\${AGENTQ_STOP_WHEN:-unset}"
${emitResult(root, resultPayload({ branch: 'pi/issue-304' }))}
`);

  run(['--db', db, 'enqueue', '--repo', repo, '--issue', '304', '--model', 'm', '--trusted']);
  const result = run(['--db', db, 'run-next', '--executor', executor, '--stop-when', 'all tests pass and README updated', '--json']);

  assert.equal(result.exitCode, 0);
  const [job] = jobs(db);
  assert.match(fs.readFileSync(job.log_path, 'utf8'), /stopwhen=all tests pass and README updated/);
});

test('run-next --stop-when reports stop:true when the executor reports the sentinel', () => {
  const root = tmpdir();
  const repo = makeRepo(root);
  const db = path.join(root, 'jobs.sqlite');
  const executor = makeExecutor(root, `#!/usr/bin/env bash
echo 'SHOULD_FULLY_STOP=true'
${emitResult(root, resultPayload({ branch: 'pi/issue-304', stop: true }))}
`);

  run(['--db', db, 'enqueue', '--repo', repo, '--issue', '304', '--model', 'm', '--trusted']);
  const result = run(['--db', db, 'run-next', '--executor', executor, '--stop-when', 'done', '--json']);

  assert.equal(result.exitCode, 0);
  assert.equal(JSON.parse(result.stdout).stop, true);
});

test('run-next --stop-when reports stop:false when no sentinel is printed', () => {
  const root = tmpdir();
  const repo = makeRepo(root);
  const db = path.join(root, 'jobs.sqlite');
  const executor = makeExecutor(root, `#!/usr/bin/env bash
${emitResult(root, resultPayload({ branch: 'pi/issue-304' }))}
`);

  run(['--db', db, 'enqueue', '--repo', repo, '--issue', '304', '--model', 'm', '--trusted']);
  const result = run(['--db', db, 'run-next', '--executor', executor, '--stop-when', 'done', '--json']);

  assert.equal(result.exitCode, 0);
  assert.equal(JSON.parse(result.stdout).stop, false);
});

test('drain --stop-when ends the loop early when the agent signals stop', () => {
  const root = tmpdir();
  const repo = makeRepo(root);
  const db = path.join(root, 'jobs.sqlite');
  const executor = makeExecutor(root, `#!/usr/bin/env bash
echo 'SHOULD_FULLY_STOP=true'
${emitResult(root, resultPayload({ stop: true }))}
`);

  run(['--db', db, 'enqueue', '--repo', repo, '--issue', '1', '--model', 'm', '--trusted']);
  run(['--db', db, 'enqueue', '--repo', repo, '--issue', '2', '--model', 'm']);
  run(['--db', db, 'enqueue', '--repo', repo, '--issue', '3', '--model', 'm', '--trusted']);

  const result = run(['--db', db, 'drain', '--executor', executor, '--stop-when', 'objective complete', '--json']);

  assert.equal(result.exitCode, 0);
  const summary = JSON.parse(result.stdout);
  assert.equal(summary.ran, 1);
  assert.equal(summary.succeeded, 1);
  assert.equal(summary.stop, true);
  // The remaining two jobs stay pending.
  assert.deepEqual(jobs(db).map(j => j.status), ['succeeded', 'pending', 'pending']);
});

test('drain --stop-when runs all jobs when no sentinel is ever printed', () => {
  const root = tmpdir();
  const repo = makeRepo(root);
  const db = path.join(root, 'jobs.sqlite');
  const executor = makeExecutor(root, `#!/usr/bin/env bash
${emitResult(root, resultPayload())}
`);

  run(['--db', db, 'enqueue', '--repo', repo, '--issue', '1', '--model', 'm', '--trusted']);
  run(['--db', db, 'enqueue', '--repo', repo, '--issue', '2', '--model', 'm', '--trusted']);

  const result = run(['--db', db, 'drain', '--executor', executor, '--stop-when', 'objective complete', '--json']);

  assert.equal(result.exitCode, 0);
  const summary = JSON.parse(result.stdout);
  assert.equal(summary.ran, 2);
  assert.equal(summary.stop, undefined);
});

// --- review round 1: prune scope, approval, cancel fencing, stored status ---

test('prune leaves tasks without worktrees, and their usage, untouched', () => {
  const root = tmpdir();
  const db = path.join(root, 'jobs.sqlite');
  const handle = openDb(db);
  let id;
  try {
    const task = dbModule.createTask(handle, {
      kind: 'prompt', prompt: 'do the thing', model: 'm', source: 'orchestrator',
    });
    id = task.id;
    handle.prepare("UPDATE tasks SET status = 'succeeded', finished_at = ? WHERE id = ?")
      .run(new Date().toISOString(), id);
    dbModule.recordUsage(handle, {
      taskId: id, model: 'm', inputTokens: 10, outputTokens: 5, cacheTokens: 1, cost: 0.5,
    });
  } finally {
    handle.close();
  }

  const pruned = JSON.parse(run(['--db', db, 'prune', '--json']).stdout);
  assert.deepEqual(pruned, { status: 'pruned', removed: 0, ids: [], skipped: [] });

  const [job] = jobs(db);
  assert.equal(job.id, id);
  assert.equal(job.status, 'succeeded');
  const check = openDb(db);
  try {
    assert.equal(dbModule.getUsageByTask(check, id).length, 1, 'prune must never delete usage');
    assert.equal(dbModule.listTaskEvents(check, id).filter(event => event.event === 'pruned').length, 0,
      'a task with nothing to clean is not even considered');
  } finally {
    check.close();
  }
});

test('a failed job can still be requeued after prune', () => {
  const root = tmpdir();
  const repo = makeGitRepo(root);
  const db = path.join(root, 'jobs.sqlite');
  const executor = makeExecutor(root, `#!/usr/bin/env bash
exit 7
`);

  const { id } = JSON.parse(run(['--db', db, 'enqueue', '--repo', repo, '--issue', '1', '--model', 'm', '--base', 'master', '--trusted', '--json']).stdout);
  assert.equal(run(['--db', db, 'run-next', '--executor', executor, '--json']).exitCode, 7);

  const pruned = JSON.parse(run(['--db', db, 'prune', '--json']).stdout);
  assert.deepEqual(pruned.ids, [id], 'the failed job worktree is reclaimed');

  const requeued = run(['--db', db, 'requeue', '--id', id, '--json']);
  assert.equal(requeued.exitCode, 0, requeued.stderr);
  assert.deepEqual(JSON.parse(requeued.stdout), { id, status: 'pending' });
});

test('import-log stores the legacy completion so prune can find its worktree', () => {
  const root = tmpdir();
  const db = path.join(root, 'jobs.sqlite');
  const logPath = path.join(root, 'agentq.log');
  const verification = { command: 'npm test', exit_code: 0, artifact_unchanged: true };
  const events = [
    { id: 7, event: 'enqueued', repo: '/x', issue: 7, model: 'm', base: 'main', trusted: 1, deps: [], ts: '2020-01-01T00:00:00Z' },
    { id: 7, event: 'claimed', model: 'm', ts: '2020-01-01T00:01:00Z' },
    {
      id: 7, event: 'finished', status: 'unverified', exit: 0, verified: 0,
      worktree: path.join(os.tmpdir(), 'pi-issue-7'), branch: 'pi/issue-7',
      session: '/sessions/seven.jsonl', log: '/logs/agentq-job-7.log', verification,
      ts: '2020-01-01T00:02:00Z',
    },
  ];
  fs.writeFileSync(logPath, `${events.map(event => JSON.stringify(event)).join('\n')}\n`);

  assert.equal(run(['--db', db, 'import-log', '--log', logPath, '--json']).exitCode, 0);
  const [job] = jobs(db);
  assert.equal(job.worktree_path, path.join(os.tmpdir(), 'pi-issue-7'));
  assert.equal(job.branch, 'pi/issue-7');
  assert.equal(job.exit_code, 0);
  assert.equal(job.session_path, '/sessions/seven.jsonl');
  assert.equal(job.log_path, '/logs/agentq-job-7.log');
  assert.equal(job.verified, 0);
  assert.deepEqual(job.verification, verification);
});

test('an untrusted CLI enqueue needs approval for HTTP workers but not for the local one', () => {
  const root = tmpdir();
  const repo = makeRepo(root);
  const db = path.join(root, 'jobs.sqlite');
  const executor = makeExecutor(root, `#!/usr/bin/env bash
echo ran
`);
  const sandbox = makeExecutor(root, `#!/usr/bin/env bash
exec "$@"
`, 'sandbox.sh');

  const untrusted = JSON.parse(run(['--db', db, 'enqueue', '--repo', repo, '--issue', '1', '--model', 'm', '--json']).stdout);
  const trusted = JSON.parse(run(['--db', db, 'enqueue', '--repo', repo, '--issue', '2', '--model', 'm', '--trusted', '--json']).stdout);

  const handle = openDb(db);
  try {
    assert.equal(dbModule.getTask(handle, untrusted.id).approval_required, 1);
    assert.equal(dbModule.getTask(handle, trusted.id).approval_required, 0);
    // An HTTP worker (no localTaskSource) may only claim the approved task.
    const httpClaim = dbModule.claimNextTask(handle, 'http-worker', {});
    assert.equal(httpClaim.id, trusted.id);
    assert.equal(dbModule.claimNextTask(handle, 'http-worker', {}), null,
      'the unapproved task stays unclaimable over HTTP');
  } finally {
    handle.close();
  }

  // The local CLI may run it (with a boundary) without a separate approval.
  const result = run(['--db', db, 'run-next', '--executor', executor, '--sandbox', sandbox, '--json']);
  assert.equal(result.exitCode, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).id, untrusted.id);
  assert.equal(jobs(db).find(job => job.id === untrusted.id).status, 'succeeded');
});

test('cancel never overwrites a finished task, even with a stale pid file', () => {
  const root = tmpdir();
  const repo = makeRepo(root);
  const db = path.join(root, 'jobs.sqlite');
  const executor = makeExecutor(root, `#!/usr/bin/env bash
echo done
`);

  const { id } = JSON.parse(run(['--db', db, 'enqueue', '--repo', repo, '--issue', '1', '--model', 'm', '--trusted', '--json']).stdout);
  assert.equal(run(['--db', db, 'run-next', '--executor', executor, '--json']).exitCode, 0);

  // A leftover pid file from the finished run (pid reuse hazard).
  const pidFile = path.join(root, 'logs', `agentq-job-${id}.pid`);
  fs.writeFileSync(pidFile, String(process.pid));

  const result = run(['--db', db, 'cancel', '--id', id, '--json']);
  assert.equal(result.exitCode, 1);
  const out = JSON.parse(result.stdout);
  assert.equal(out.cancelled, false);
  assert.equal(out.status, 'succeeded');
  assert.match(out.reason, /already succeeded/);
  assert.equal(jobs(db)[0].status, 'succeeded');
  assert.equal(fs.existsSync(pidFile), false, 'the stale pid file is removed');
});

test('run-next reports the status the store recorded when a task is re-pended', () => {
  const root = tmpdir();
  const repo = makeRepo(root);
  const db = path.join(root, 'jobs.sqlite');
  const executor = makeExecutor(root, `#!/usr/bin/env bash
exit 7
`);

  // An orchestrator-created task keeps a multi-attempt budget, so a failed
  // local attempt is re-pended by the store instead of finishing.
  const handle = openDb(db);
  let id;
  try {
    const task = dbModule.createTask(handle, {
      kind: 'github_issue',
      repo,
      issue_num: 42,
      prompt: JSON.stringify(snapshotForIssue(42)),
      model: 'm',
      source: 'orchestrator',
      max_attempts: 3,
    });
    id = task.id;
  } finally {
    handle.close();
  }

  const result = run(['--db', db, 'run-next', '--executor', executor, '--allow-untrusted', '--json']);
  assert.equal(result.exitCode, 0, result.stderr);
  const out = JSON.parse(result.stdout);
  assert.equal(out.id, id);
  assert.equal(out.status, 'pending', 'the store re-pended it for another attempt');
  const [job] = jobs(db);
  assert.equal(job.status, 'pending');
  assert.equal(job.attempts, 1);
});

test('a local completion with a mismatching pinned-input digest is rejected', async () => {
  const root = tmpdir();
  const repo = makeRepo(root);
  const dbPath = path.join(root, 'jobs.sqlite');
  const source = new SqliteSource(dbPath, {
    issueRunner: (_command, args) => {
      const number = Number(args[2]);
      return JSON.stringify({
        number, title: 'Fixture issue', body: 'fixture body',
        url: `https://github.com/test/repo/issues/${number}`, updatedAt: '2026-11-02T00:00:00Z',
      });
    },
  });
  const { id } = await source.enqueue({ repo, issue: '42', model: 'm', trusted: true });
  const job = await source.claimNext();
  // The stored snapshot changes after the claim: the completion's digest no
  // longer matches the immutable input, exactly as the HTTP path checks.
  const tampered = snapshotForIssue(42, 'different body');
  source.db.prepare('UPDATE tasks SET prompt = ? WHERE id = ?').run(JSON.stringify(tampered), id);

  await assert.rejects(
    source.sink.finish(job, { status: 'succeeded', inputSha256: job.task_input.sha256 }),
    /digest does not match/i,
  );
  assert.equal(source.status()[0].status, 'running');
  await source.stop();
});

test('commands that do not use the queue never create its database', () => {
  const root = tmpdir();
  const db = path.join(root, 'absent.sqlite');

  for (const args of [['pick', '--json'], ['list-workflows', '--json'], ['jules-sessions', '--json']]) {
    run(['--db', db, ...args], { ORCHESTRATOR_DB: path.join(root, 'orch.sqlite') });
    assert.equal(fs.existsSync(db), false, `'${args[0]}' must not create the queue database`);
  }
  // save-workflow validates its inputs without touching the queue.
  run(['--db', db, 'save-workflow', '--name', 'x', '--file', path.join(root, 'nope.js')]);
  assert.equal(fs.existsSync(db), false, "'save-workflow' must not create the queue database");
});

test('local runs record cache read and write tokens combined in usage_records', () => {
  const root = tmpdir();
  const repo = makeRepo(root);
  const db = path.join(root, 'jobs.sqlite');
  const executor = makeExecutor(root, `#!/usr/bin/env bash
${emitResult(root, resultPayload({
    usage: { inputTokens: 10, outputTokens: 5, cacheReadTokens: 7, cacheWriteTokens: 3, totalCost: 0.02 },
  }))}
`);

  const { id } = JSON.parse(run(['--db', db, 'enqueue', '--repo', repo, '--issue', '1', '--model', 'm', '--trusted', '--json']).stdout);
  assert.equal(run(['--db', db, 'run-next', '--executor', executor, '--json']).exitCode, 0);

  const handle = openDb(db);
  try {
    const [usage] = dbModule.getUsageByTask(handle, id);
    assert.equal(usage.input_tokens, 10);
    assert.equal(usage.output_tokens, 5);
    assert.equal(usage.cache_tokens, 10, 'cacheRead + cacheWrite are combined');
    assert.equal(usage.cost, 0.02);
  } finally {
    handle.close();
  }
});

test('prune is idempotent: a second run reports nothing to clean', () => {
  const root = tmpdir();
  const repo = makeGitRepo(root);
  const db = path.join(root, 'jobs.sqlite');
  const issueNumber = 4242 + process.pid;
  const piWorktree = path.join(os.tmpdir(), `pi-issue-${issueNumber}`);
  try {
    // A legacy standalone completion: the recorded worktree is the pi-issue
    // contract resource, not the agentq-managed one.
    const executorLegacy = makeExecutor(root, `#!/usr/bin/env bash
set -euo pipefail
git -C "${repo}" worktree add -q -b pi/issue-${issueNumber} "${piWorktree}" master
`, 'legacy.sh');
    const { id } = JSON.parse(run(['--db', db, 'enqueue', '--repo', repo, '--issue', String(issueNumber), '--model', 'm', '--base', 'master', '--trusted', '--json']).stdout);
    run(['--db', db, 'run-next', '--executor', executorLegacy, '--json']);
    patchResult(db, id, { worktree: piWorktree, branch: `pi/issue-${issueNumber}` });

    const first = JSON.parse(run(['--db', db, 'prune', '--json']).stdout);
    assert.deepEqual(first.skipped, []);
    assert.equal(fs.existsSync(piWorktree), false);

    const second = JSON.parse(run(['--db', db, 'prune', '--json']).stdout);
    assert.equal(second.removed, 0);
    assert.deepEqual(second.skipped, [], 'an already-cleaned job is not reported as a failure');
  } finally {
    fs.rmSync(piWorktree, { recursive: true, force: true });
  }
});

test('an imported legacy local job is claimable by the local worker', async () => {
  const root = tmpdir();
  const repo = makeRepo(root);
  const db = path.join(root, 'jobs.sqlite');
  const logPath = path.join(root, 'agentq.log');
  // A legacy untrusted prompt job: imported with approval_required 1 and
  // source 'agentq', which is one of the locally-owned sources.
  fs.writeFileSync(logPath, `${JSON.stringify({
    id: 5, event: 'enqueued', kind: 'prompt', repo, model: 'm', prompt: 'legacy work', trusted: 0, ts: '2020-01-01T00:00:00Z',
  })}\n`);
  assert.equal(run(['--db', db, 'import-log', '--log', logPath, '--json']).exitCode, 0);

  const handle = openDb(db);
  try {
    const task = dbModule.listTasks(handle, {})[0];
    assert.equal(task.source, 'agentq');
    assert.equal(task.approval_required, 1);
  } finally {
    handle.close();
  }

  // The local worker may claim it without a separate approval.
  const source = new SqliteSource(db);
  try {
    const claimed = await source.claimNext({ kind: 'prompt', allowUntrusted: true });
    assert.ok(claimed, 'an imported local job is claimable locally');
    assert.equal(claimed.source, 'agentq');
    assert.equal(source.status()[0].status, 'running');
  } finally {
    await source.stop();
  }
});

// --- run --id: claim one specific task (the dispatch path) ---

test('run --id claims and runs exactly that task, leaving the others pending', () => {
  const root = tmpdir();
  const repo = makeRepo(root);
  const db = path.join(root, 'jobs.sqlite');
  const seen = path.join(root, 'seen.txt');
  const executor = makeExecutor(root, `#!/usr/bin/env bash
echo "issue=$1" >> ${JSON.stringify(seen)}
`);

  const first = JSON.parse(run(['--db', db, 'enqueue', '--repo', repo, '--issue', '10', '--model', 'm', '--trusted', '--json']).stdout);
  const second = JSON.parse(run(['--db', db, 'enqueue', '--repo', repo, '--issue', '11', '--model', 'm', '--trusted', '--json']).stdout);

  const result = run(['--db', db, 'run', '--id', second.id, '--executor', executor, '--json']);

  assert.equal(result.exitCode, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), { id: second.id, status: 'succeeded', exitCode: 0, result_file: 'missing' });
  assert.equal(fs.readFileSync(seen, 'utf8').trim(), 'issue=11');
  const byId = new Map(jobs(db).map((job) => [job.id, job]));
  assert.equal(byId.get(second.id).status, 'succeeded');
  assert.equal(byId.get(first.id).status, 'pending');
  assert.equal(byId.get(first.id).claimed_by, null);
});

test('run --id accepts a unique id prefix', () => {
  const root = tmpdir();
  const repo = makeRepo(root);
  const db = path.join(root, 'jobs.sqlite');
  const executor = makeExecutor(root, `#!/usr/bin/env bash
echo "issue=$1"
`);

  const { id } = JSON.parse(run(['--db', db, 'enqueue', '--repo', repo, '--issue', '12', '--model', 'm', '--trusted', '--json']).stdout);
  const result = run(['--db', db, 'run', '--id', id.slice(0, 6), '--executor', executor, '--json']);

  assert.equal(result.exitCode, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), { id, status: 'succeeded', exitCode: 0, result_file: 'missing' });
});

test('run --id refuses an untrusted task through admission and leaves it pending', () => {
  const root = tmpdir();
  const repo = makeRepo(root);
  const db = path.join(root, 'jobs.sqlite');
  const executor = makeExecutor(root, `#!/usr/bin/env bash
echo ran
`);

  const { id } = JSON.parse(run(['--db', db, 'enqueue', '--repo', repo, '--issue', '13', '--model', 'm', '--json']).stdout);
  const result = run(['--db', db, 'run', '--id', id, '--executor', executor, '--json']);

  assert.equal(result.exitCode, 2);
  const out = JSON.parse(result.stdout);
  assert.equal(out.status, 'refused');
  assert.equal(out.refused[0].id, id);
  assert.match(out.refused[0].reason, /Refusing untrusted job/);
  assert.match(result.stderr, new RegExp(`job ${id.slice(0, 8)}: Refusing untrusted job`));
  const [job] = jobs(db);
  assert.equal(job.status, 'pending');
  assert.equal(job.claimed_by, null);
});

test('run --id --model overrides the stored model for that claim', () => {
  const root = tmpdir();
  const repo = makeRepo(root);
  const db = path.join(root, 'jobs.sqlite');
  const seenModel = path.join(root, 'model.txt');
  const executor = makeExecutor(root, `#!/usr/bin/env bash
echo "$2" > ${JSON.stringify(seenModel)}
`);

  const { id } = JSON.parse(run(['--db', db, 'enqueue', '--repo', repo, '--issue', '14', '--model', 'stored/model', '--trusted', '--json']).stdout);
  const result = run(['--db', db, 'run', '--id', id, '--model', 'override/model', '--executor', executor, '--json']);

  assert.equal(result.exitCode, 0, result.stderr);
  assert.equal(fs.readFileSync(seenModel, 'utf8').trim(), 'override/model');
  // The override is stored on the claim, exactly like the orchestrator's
  // modelOverride, so the audit row says what actually ran.
  const [job] = jobs(db);
  assert.equal(job.model, 'override/model');
});

test('run --id --model auto routes through the routing core', () => {
  const root = tmpdir();
  const repo = makeRepo(root);
  const db = path.join(root, 'jobs.sqlite');
  const fixture = writeRoutingFixture();
  const seenModel = path.join(root, 'model.txt');
  const executor = makeExecutor(root, `#!/usr/bin/env bash
echo "$2" > ${JSON.stringify(seenModel)}
`);

  const { id } = JSON.parse(run(['--db', db, 'enqueue', '--repo', repo, '--issue', '15', '--model', 'stored/model', '--trusted', '--json']).stdout);
  const result = run(
    ['--db', db, 'run', '--id', id, '--model', 'auto', '--executor', executor, '--quota', fixture.quotaPath, '--json'],
    fixture.env(),
  );

  assert.equal(result.exitCode, 0, result.stderr);
  assert.equal(fs.readFileSync(seenModel, 'utf8').trim(), CHEAP_MODEL);
  assert.equal(jobs(db)[0].model, CHEAP_MODEL);
});

// --- W25: a local claim records its model decision ---

/** The `model-chosen` payloads of a task, oldest first. */
function modelChoices(dbPath, id) {
  return taskEvents(dbPath, id)
    .filter((event) => event.event === 'model-chosen')
    .map((event) => event.payload);
}

test('run --id with an explicit --model records chosenBy caller', () => {
  const root = tmpdir();
  const repo = makeRepo(root);
  const db = path.join(root, 'jobs.sqlite');
  const executor = makeExecutor(root, '#!/usr/bin/env bash\necho ran\n');

  const { id } = JSON.parse(run(['--db', db, 'enqueue', '--repo', repo, '--issue', '21', '--model', 'stored/model', '--trusted', '--json']).stdout);
  const result = run(['--db', db, 'run', '--id', id, '--model', 'override/model', '--executor', executor, '--json']);
  assert.equal(result.exitCode, 0, result.stderr);

  assert.deepEqual(modelChoices(db, id), [{
    model: 'override/model',
    tier: 'medium',
    chosenBy: 'caller',
    roles: [],
    dataSharing: false,
  }]);
});

test('run --id without --model records the stored model as pinned', () => {
  const root = tmpdir();
  const repo = makeRepo(root);
  const db = path.join(root, 'jobs.sqlite');
  const executor = makeExecutor(root, '#!/usr/bin/env bash\necho ran\n');

  const { id } = JSON.parse(run(['--db', db, 'enqueue', '--repo', repo, '--issue', '22', '--model', 'stored/model', '--trusted', '--json']).stdout);
  const result = run(['--db', db, 'run', '--id', id, '--executor', executor, '--json']);
  assert.equal(result.exitCode, 0, result.stderr);

  assert.deepEqual(modelChoices(db, id), [{
    model: 'stored/model',
    tier: 'medium',
    chosenBy: 'pinned',
    roles: [],
    dataSharing: false,
  }]);
});

test('run --id on an auto task records the routed model, its tier and its roles', () => {
  const root = tmpdir();
  const repo = makeRepo(root);
  const db = path.join(root, 'jobs.sqlite');
  const fixture = writeRoutingFixture();
  const executor = makeExecutor(root, '#!/usr/bin/env bash\necho ran\n');

  const enqueued = run(
    ['--db', db, 'enqueue', '--repo', repo, '--issue', '23', '--model', 'auto', '--tier', 'big', '--trusted', '--json'],
    fixture.env(),
  );
  assert.equal(enqueued.exitCode, 0, enqueued.stderr);
  const { id } = JSON.parse(enqueued.stdout);

  const result = run(['--db', db, 'run', '--id', id, '--executor', executor, '--json'], fixture.env());
  assert.equal(result.exitCode, 0, result.stderr);

  const [choice] = modelChoices(db, id);
  assert.equal(choice.model, STRONG_MODEL);
  assert.equal(choice.chosenBy, 'auto');
  assert.equal(choice.tier, 'big', 'the tier the task was enqueued with');
  assert.deepEqual(
    choice.roles,
    ['cheapest', 'smartest', 'expiring', 'best-value'],
    'the shortlist roles of the chosen model',
  );
  assert.equal(choice.dataSharing, false);
});

test('run --id on a task that is not pending fails instead of running the next one', () => {
  const root = tmpdir();
  const repo = makeRepo(root);
  const db = path.join(root, 'jobs.sqlite');
  const executor = makeExecutor(root, `#!/usr/bin/env bash
echo ran
`);

  const { id } = JSON.parse(run(['--db', db, 'enqueue', '--repo', repo, '--issue', '16', '--model', 'm', '--trusted', '--json']).stdout);
  assert.equal(run(['--db', db, 'run', '--id', id, '--executor', executor, '--json']).exitCode, 0);

  const again = run(['--db', db, 'run', '--id', id, '--executor', executor, '--json']);
  assert.equal(again.exitCode, 1);
  assert.match(again.stderr, /is succeeded, not pending/);
});

test('run --id propagates the executor exit code and records the failure', () => {
  const root = tmpdir();
  const repo = makeRepo(root);
  const db = path.join(root, 'jobs.sqlite');
  const executor = makeExecutor(root, `#!/usr/bin/env bash
echo nope
exit 7
`);

  const { id } = JSON.parse(run(['--db', db, 'enqueue', '--repo', repo, '--issue', '17', '--model', 'm', '--trusted', '--json']).stdout);
  const result = run(['--db', db, 'run', '--id', id, '--executor', executor, '--json']);

  assert.equal(result.exitCode, 7);
  assert.deepEqual(JSON.parse(result.stdout), { id, status: 'failed', exitCode: 7, result_file: 'missing' });
  assert.equal(jobs(db)[0].status, 'failed');
});

test('run --id --verify marks the task unverified when the check fails', () => {
  const root = tmpdir();
  const repo = makeRepo(root);
  const db = path.join(root, 'jobs.sqlite');
  const executor = makeExecutor(root, `#!/usr/bin/env bash
echo ran
`);

  const { id } = JSON.parse(run(['--db', db, 'enqueue', '--repo', repo, '--issue', '18', '--model', 'm', '--trusted', '--json']).stdout);
  const result = run(['--db', db, 'run', '--id', id, '--executor', executor, '--verify', 'test -f missing', '--json']);

  assert.equal(result.exitCode, 1);
  assert.equal(JSON.parse(result.stdout).status, 'unverified');
});

test('run --id requires an id and refuses the orchestrator source', () => {
  const root = tmpdir();
  const db = path.join(root, 'jobs.sqlite');
  const missing = run(['--db', db, 'run', '--json']);
  assert.equal(missing.exitCode, 1);
  assert.match(missing.stderr, /run requires --id/);

  const orchestrator = run(['--db', db, '--source', 'orchestrator', 'run', '--id', 'abcdef12', '--json']);
  assert.equal(orchestrator.exitCode, 1);
  assert.match(orchestrator.stderr, /not implemented for --source orchestrator/);
});

test('run --id refuses an unapproved task instead of bypassing approval', () => {
  const root = tmpdir();
  const repo = makeRepo(root);
  const db = path.join(root, 'jobs.sqlite');
  const executor = makeExecutor(root, `#!/usr/bin/env bash
echo ran
`);

  // An MCP-created task needs a human approval; naming it must not skip that.
  const handle = openDb(db);
  let unapproved;
  try {
    unapproved = dbModule.createTask(handle, {
      kind: 'github_issue',
      repo,
      issue_num: 50,
      prompt: JSON.stringify(snapshotForIssue(50)),
      model: 'm',
      source: 'mcp',
      trust_level: 'untrusted',
      approval_required: 1,
    });
  } finally {
    handle.close();
  }
  const refused = run(['--db', db, 'run', '--id', unapproved.id, '--executor', executor, '--allow-untrusted', '--json']);
  // A policy gate is a refusal (exit 2), not a generic failure: the task stays
  // pending and the reason is printed.
  assert.equal(refused.exitCode, 2);
  assert.match(refused.stderr, /requires human approval/);
  assert.deepEqual(JSON.parse(refused.stdout), {
    status: 'refused',
    refused: [{ id: unapproved.id, reason: `Task ${unapproved.id} requires human approval before it can run.` }],
  });
  assert.equal(jobs(db).find((job) => job.id === unapproved.id).status, 'pending');
});

test('run --id refuses a task whose kind this worker does not claim', () => {
  const root = tmpdir();
  const db = path.join(root, 'jobs.sqlite');
  const executor = makeExecutor(root, `#!/usr/bin/env bash
echo ran
`);

  const handle = openDb(db);
  let prompt;
  try {
    prompt = dbModule.createTask(handle, {
      kind: 'prompt',
      prompt: 'prompt work',
      model: 'm',
      source: 'cli',
      trust_level: 'trusted_agent',
    });
  } finally {
    handle.close();
  }

  const refused = run(['--db', db, 'run', '--id', prompt.id, '--executor', executor, '--json']);
  assert.equal(refused.exitCode, 2);
  assert.match(refused.stderr, /is kind 'prompt', but this worker runs 'github_issue'/);
  assert.equal(jobs(db).find((job) => job.id === prompt.id).status, 'pending');
});

test('run --id refuses a task with unsatisfied dependencies and runs it once they succeed', () => {
  const root = tmpdir();
  const repo = makeRepo(root);
  const db = path.join(root, 'jobs.sqlite');
  const executor = makeExecutor(root, `#!/usr/bin/env bash
echo ran
`);

  const first = JSON.parse(run(['--db', db, 'enqueue', '--repo', repo, '--issue', '40', '--model', 'm', '--trusted', '--json']).stdout);
  const second = JSON.parse(run(['--db', db, 'enqueue', '--repo', repo, '--issue', '41', '--model', 'm', '--trusted', '--depends-on', first.id, '--json']).stdout);

  const blocked = run(['--db', db, 'run', '--id', second.id, '--executor', executor, '--json']);
  assert.equal(blocked.exitCode, 2);
  assert.match(blocked.stderr, /is blocked: dependencies not succeeded/);
  assert.equal(jobs(db).find((job) => job.id === second.id).status, 'blocked');

  // Once the prerequisite succeeds, the same command runs the task.
  assert.equal(run(['--db', db, 'run', '--id', first.id, '--executor', executor, '--json']).exitCode, 0);
  const nowRunnable = run(['--db', db, 'run', '--id', second.id, '--executor', executor, '--json']);
  assert.equal(nowRunnable.exitCode, 0, nowRunnable.stderr);
  assert.equal(jobs(db).find((job) => job.id === second.id).status, 'succeeded');
});

test('run --id exits 3 when the queue is busy and claims nothing', () => {
  const root = tmpdir();
  const repo = makeRepo(root);
  const db = path.join(root, 'jobs.sqlite');
  const executor = makeExecutor(root, `#!/usr/bin/env bash
echo ran
`);
  const { id } = JSON.parse(run(['--db', db, 'enqueue', '--repo', repo, '--issue', '42', '--model', 'm', '--trusted', '--json']).stdout);

  const locker = openDb(db);
  try {
    locker.exec('BEGIN IMMEDIATE');
    // AGENTQ_BUSY_TIMEOUT_MS=0 makes the contention visible immediately.
    const result = run(['--db', db, 'run', '--id', id, '--executor', executor, '--json'], { AGENTQ_BUSY_TIMEOUT_MS: '0' });
    assert.equal(result.exitCode, 3);
    assert.match(result.stderr, /queue busy/);
    assert.deepEqual(JSON.parse(result.stdout), { status: 'busy' });
  } finally {
    locker.exec('ROLLBACK');
    locker.close();
  }

  const [job] = jobs(db);
  assert.equal(job.status, 'pending');
  assert.equal(job.claimed_by, null);
});

test('run --id records the model an override replaced', () => {
  const root = tmpdir();
  const repo = makeRepo(root);
  const db = path.join(root, 'jobs.sqlite');
  const executor = makeExecutor(root, `#!/usr/bin/env bash
echo ran
`);

  const { id } = JSON.parse(run(['--db', db, 'enqueue', '--repo', repo, '--issue', '43', '--model', 'stored/model', '--trusted', '--json']).stdout);
  assert.equal(run(['--db', db, 'run', '--id', id, '--model', 'override/model', '--executor', executor, '--json']).exitCode, 0);

  const claimed = taskEvents(db, id).find((event) => event.event === 'claimed');
  assert.equal(claimed.payload.model, 'override/model');
  assert.equal(claimed.payload.previous_model, 'stored/model');
  assert.equal(claimed.payload.previous_provider, null);
});

test('run --id refuses a task whose attempt budget is spent', () => {
  const root = tmpdir();
  const repo = makeRepo(root);
  const db = path.join(root, 'jobs.sqlite');
  const executor = makeExecutor(root, `#!/usr/bin/env bash
echo ran
`);

  // A non-local source is subject to the store's attempt budget. An interrupted
  // run re-pends the task without resetting attempts, which is how a pending
  // task can have a spent budget.
  const handle = openDb(db);
  let task;
  try {
    task = dbModule.createTask(handle, {
      kind: 'github_issue',
      repo,
      issue_num: 60,
      prompt: JSON.stringify(snapshotForIssue(60)),
      model: 'm',
      source: 'mcp',
      trust_level: 'untrusted',
      approval_required: 0,
      max_attempts: 1,
    });
    const claim = dbModule.claimTaskById(handle, task.id, 'worker-a', { model: 'm' });
    dbModule.recoverTask(handle, task.id, {
      claimedBy: claim.claimed_by, claimToken: claim.claim_token, reason: 'interrupted',
    });
  } finally {
    handle.close();
  }

  const refused = run(['--db', db, 'run', '--id', task.id, '--executor', executor, '--allow-untrusted', '--json']);
  assert.equal(refused.exitCode, 2);
  assert.match(refused.stderr, /has no attempts left \(1\/1\)/);
  assert.equal(jobs(db).find((job) => job.id === task.id).status, 'pending');
});

test('a local --worker-id must use a documented shape', () => {
  const root = tmpdir();
  const repo = makeRepo(root);
  const db = path.join(root, 'jobs.sqlite');
  const executor = makeExecutor(root, `#!/usr/bin/env bash
echo ran
`);

  const bad = run(['--db', db, '--worker-id', 'bogus', 'status', '--json']);
  assert.equal(bad.exitCode, 2);
  assert.match(bad.stderr, /Invalid --worker-id for the local queue: bogus/);
  assert.match(bad.stderr, new RegExp(`expected local-${os.hostname()}-<pid> or local-${os.hostname()}-dispatch-<pid>`));

  // Another host's shape is rejected too: the dispatch cap counts this host's
  // claims only, so impersonating one must not be possible.
  const otherHost = run(['--db', db, '--worker-id', 'local-otherhost-dispatch-1', 'status', '--json']);
  assert.equal(otherHost.exitCode, 2);

  const { id } = JSON.parse(run(['--db', db, 'enqueue', '--repo', repo, '--issue', '61', '--model', 'm', '--trusted', '--json']).stdout);
  const workerId = `local-${os.hostname()}-dispatch-4242`;
  const ok = run(['--db', db, '--worker-id', workerId, 'run', '--id', id, '--executor', executor, '--json']);
  assert.equal(ok.exitCode, 0, ok.stderr);
  assert.equal(jobs(db).find((job) => job.id === id).claimed_by, workerId);
});

test('run --id exits 3 when opening the queue hits the write lock', () => {
  const root = tmpdir();
  const repo = makeRepo(root);
  const db = path.join(root, 'jobs.sqlite');
  const executor = makeExecutor(root, `#!/usr/bin/env bash
echo ran
`);
  const { id } = JSON.parse(run(['--db', db, 'enqueue', '--repo', repo, '--issue', '62', '--model', 'm', '--trusted', '--json']).stdout);

  // A rollback-journal database plus an exclusive lock makes OPENING the queue
  // fail (WAL mode is itself a write), not just the claim.
  const locker = openDb(db);
  try {
    locker.exec('PRAGMA journal_mode=DELETE');
    locker.exec('BEGIN EXCLUSIVE');
    const result = run(['--db', db, 'run', '--id', id, '--executor', executor, '--json'], { AGENTQ_BUSY_TIMEOUT_MS: '0' });
    assert.equal(result.exitCode, 3, result.stderr);
    assert.match(result.stderr, /queue busy/);
    assert.deepEqual(JSON.parse(result.stdout), { status: 'busy' });
  } finally {
    locker.exec('ROLLBACK');
    locker.close();
  }

  const [job] = jobs(db);
  assert.equal(job.status, 'pending');
  assert.equal(job.claimed_by, null);
});

test('run --id refuses a task whose provider rate limit is full', () => {
  const root = tmpdir();
  const repo = makeRepo(root);
  const db = path.join(root, 'jobs.sqlite');
  const executor = makeExecutor(root, `#!/usr/bin/env bash
echo ran
`);

  const handle = openDb(db);
  let task;
  try {
    dbModule.setRateLimit(handle, { provider: 'limited', metric: 'concurrent', limit_val: 0 });
    task = dbModule.createTask(handle, {
      kind: 'github_issue',
      repo,
      issue_num: 63,
      prompt: JSON.stringify(snapshotForIssue(63)),
      model: 'm',
      provider: 'limited',
      source: 'cli',
      trust_level: 'trusted_agent',
    });
  } finally {
    handle.close();
  }

  const refused = run(['--db', db, 'run', '--id', task.id, '--executor', executor, '--json']);
  assert.equal(refused.exitCode, 2);
  assert.match(refused.stderr, /Provider limited is at its rate limit/);
  assert.equal(jobs(db).find((job) => job.id === task.id).status, 'pending');
});

test('run --id keeps the stored quota path when the model is unchanged', () => {
  const root = tmpdir();
  const repo = makeRepo(root);
  const db = path.join(root, 'jobs.sqlite');
  const executor = makeExecutor(root, `#!/usr/bin/env bash
echo ran
`);

  const handle = openDb(db);
  let task;
  try {
    task = dbModule.createTask(handle, {
      kind: 'github_issue',
      repo,
      issue_num: 64,
      prompt: JSON.stringify(snapshotForIssue(64)),
      model: 'm',
      provider: 'path-a',
      source: 'cli',
      trust_level: 'trusted_agent',
    });
  } finally {
    handle.close();
  }

  assert.equal(run(['--db', db, 'run', '--id', task.id, '--executor', executor, '--json']).exitCode, 0);

  const reader = openDb(db);
  try {
    // An explicit model the CLI cannot attribute must not clear the stored
    // path: rate-limit leases and attribution depend on it.
    assert.equal(dbModule.getTask(reader, task.id).provider, 'path-a');
  } finally {
    reader.close();
  }
});

test('formatModelRow marks an AA estimate with ~ so it is not read as a score', () => {
  const row = formatModelRow({
    model: 'xai/grok-4.7', path: 'xai', intelligence: 53.94748582985652, intelligenceSource: 'aa-estimate',
    costPerMTok: 4, capacity: null, recommended: false, reasons: [],
  }, 1);
  assert.match(row, /~53\.9 /);
  const scored = formatModelRow({
    model: 'xai/grok-4.5', path: 'xai', intelligence: 51.3, intelligenceSource: 'roi',
    costPerMTok: 4, capacity: null, recommended: false, reasons: [],
  }, 2);
  assert.doesNotMatch(scored, /~/);
});

test('formatModelRow rounds scores to one decimal and sub-dollar prices to four decimals', () => {
  const row = formatModelRow({
    model: 'qwen3.6-27b-mtp', path: 'local', intelligence: 33.47297297297297, intelligenceSource: 'roi',
    costPerMTok: 0.24903999999999998, capacity: null, recommended: false, reasons: [],
  }, 1);
  assert.match(row, / 33\.5 +\$0\.2490 /);
  assert.doesNotMatch(row, /33\.472|0\.24904/);
});

test('formatModelRow keeps allowance-scaled prices distinguishable and dollars at cents', () => {
  const cheap = formatModelRow({
    model: 'acme/atlas-flash', path: 'go', intelligence: 50, intelligenceSource: 'roi',
    costPerMTok: 0.0012168, capacity: null, recommended: false, reasons: [],
  }, 1);
  assert.match(cheap, /\$0\.0012 /);
  const dear = formatModelRow({
    model: 'acme/atlas-large', path: 'go', intelligence: 60, intelligenceSource: 'roi',
    costPerMTok: 12.3456, capacity: null, recommended: false, reasons: [],
  }, 1);
  assert.match(dear, /\$12\.35 /);
});

// --- stale-quota refresh ---

/**
 * Like run(), but keeps stderr on success too: the refresh line is written to
 * stderr while the command itself succeeds, and execFileSync only returns
 * stdout.
 */
function runCaptured(args, env = {}) {
  const result = spawnSync(process.execPath, [AGENTQ, ...args], {
    encoding: 'utf8',
    env: { ...process.env, AGENTQ_QUOTA_REFRESH: '0', ...githubEnv(), ...env },
    timeout: 60_000,
  });
  return { exitCode: result.status ?? 1, stdout: result.stdout || '', stderr: result.stderr || '' };
}

/** A quota snapshot routing would judge stale (7 hours old). */
function staleQuotaFixture() {
  const old = new Date(Date.now() - 7 * 3600 * 1000).toISOString();
  return {
    generatedAt: old,
    paths: {
      mistral: { updatedAt: old, windows: [{ label: 'month', usedPercent: 10, resetsAt: null }] },
      codex: { updatedAt: old, windows: [{ label: 'weekly', usedPercent: 10, resetsAt: null }] },
    },
  };
}

/** A fake collector: records that it ran and writes a fresh snapshot. */
function makeFakeCollector(root, quotaPath, marker) {
  const file = path.join(root, 'fake-collector.js');
  fs.writeFileSync(file, [
    "const fs = require('node:fs');",
    `fs.appendFileSync(${JSON.stringify(marker)}, 'ran\\n');`,
    `fs.writeFileSync(${JSON.stringify(quotaPath)}, JSON.stringify({`,
    '  generatedAt: new Date().toISOString(),',
    '  paths: {',
    "    mistral: { updatedAt: new Date().toISOString(), windows: [{ label: 'month', usedPercent: 10, resetsAt: null }] },",
    "    codex: { updatedAt: new Date().toISOString(), windows: [{ label: 'weekly', usedPercent: 10, resetsAt: null }] },",
    '  },',
    '}));',
  ].join('\n'));
  return file;
}

test('pick refreshes stale quota and prints one line to stderr', () => {
  const root = tmpdir();
  const fixture = writeRoutingFixture({ quota: staleQuotaFixture() });
  const marker = path.join(root, 'collector.log');
  const collector = makeFakeCollector(root, fixture.quotaPath, marker);

  const result = runCaptured(['pick', '--json'], {
    ...fixture.env(),
    AGENTQ_QUOTA_REFRESH: '1',
    AGENTQ_QUOTA_COLLECTOR: collector,
  });

  assert.equal(result.exitCode, 0, result.stderr);
  assert.match(result.stderr, /quota refreshed in \d+\.\ds/);
  assert.equal(fs.readFileSync(marker, 'utf8').trim(), 'ran');
  // Routing ran against the refreshed snapshot, not the stale one.
  assert.ok(JSON.parse(result.stdout).default, result.stdout);
});

test('a rate-limited refresh is silent, a failed one is reported', () => {
  const root = tmpdir();
  const fixture = writeRoutingFixture({ quota: staleQuotaFixture() });
  const collector = path.join(root, 'failing-collector.js');
  fs.writeFileSync(collector, "process.stderr.write('account-label-secret\\n'); process.exit(1);");
  const env = {
    ...fixture.env(),
    AGENTQ_QUOTA_REFRESH: '1',
    AGENTQ_QUOTA_COLLECTOR: collector,
  };

  // The first attempt runs and fails: that is worth one line.
  const first = runCaptured(['pick', '--json'], env);
  assert.equal(first.exitCode, 1, 'stale quota still yields no choice');
  assert.match(first.stderr, /quota refresh skipped: collector exited 1/);
  assert.ok(!first.stderr.includes('account-label-secret'), 'collector stderr is not echoed');

  // The second attempt is inside the ten-minute window: nothing ran, so
  // nothing is printed (and the collector is not retried).
  const second = runCaptured(['pick', '--json'], env);
  assert.equal(second.exitCode, 1);
  assert.doesNotMatch(second.stderr, /quota refresh/);
});

test('pick --no-quota-refresh leaves the collector alone', () => {
  const root = tmpdir();
  const fixture = writeRoutingFixture({ quota: staleQuotaFixture() });
  const marker = path.join(root, 'collector.log');
  const collector = makeFakeCollector(root, fixture.quotaPath, marker);

  const result = runCaptured(['--no-quota-refresh', 'pick', '--json'], {
    ...fixture.env(),
    AGENTQ_QUOTA_REFRESH: '1',
    AGENTQ_QUOTA_COLLECTOR: collector,
  });

  assert.equal(result.exitCode, 1, 'stale quota still yields no choice');
  assert.doesNotMatch(result.stderr, /quota refreshed/);
  assert.equal(fs.existsSync(marker), false);
});

test('run-next refreshes stale quota only when the task model is auto', () => {
  const root = tmpdir();
  const repo = makeRepo(root);
  const db = path.join(root, 'jobs.sqlite');
  const fixture = writeRoutingFixture({ quota: staleQuotaFixture() });
  const marker = path.join(root, 'collector.log');
  const collector = makeFakeCollector(root, fixture.quotaPath, marker);
  const executor = makeExecutor(root, `#!/usr/bin/env bash
echo "$2"
`);
  const env = {
    ...fixture.env(),
    AGENTQ_QUOTA_REFRESH: '1',
    AGENTQ_QUOTA_COLLECTOR: collector,
  };

  // An auto task: the claim routes, so stale quota must be refreshed first.
  const auto = JSON.parse(run(['--db', db, 'enqueue', '--repo', repo, '--issue', '70', '--model', 'auto', '--trusted', '--json']).stdout);
  const routed = runCaptured(['--db', db, 'run-next', '--executor', executor, '--quota', fixture.quotaPath, '--json'], env);
  assert.equal(routed.exitCode, 0, routed.stderr);
  assert.match(routed.stderr, /quota refreshed in/);
  assert.equal(fs.readFileSync(marker, 'utf8').trim(), 'ran');
  assert.equal(jobs(db).find((job) => job.id === auto.id).model, CHEAP_MODEL);

  // A pinned model never reads capacity, so a stale snapshot is left alone.
  fs.writeFileSync(fixture.quotaPath, JSON.stringify(staleQuotaFixture()));
  fs.rmSync(marker, { force: true });
  run(['--db', db, 'enqueue', '--repo', repo, '--issue', '71', '--model', 'cline-pass/kimi-k2.7-code', '--trusted', '--json']);
  const pinned = runCaptured(['--db', db, 'run-next', '--executor', executor, '--quota', fixture.quotaPath, '--json'], env);
  assert.equal(pinned.exitCode, 0, pinned.stderr);
  assert.doesNotMatch(pinned.stderr, /quota refresh/);
  assert.equal(fs.existsSync(marker), false, 'a pinned model must not trigger a collection');

  // The parallel drain path routes too, so it refreshes as well. Clear the
  // last-attempt stamp first: the previous collection was seconds ago, and the
  // ten-minute rate limit would (correctly) skip this one.
  fs.writeFileSync(fixture.quotaPath, JSON.stringify(staleQuotaFixture()));
  fs.rmSync(`${fixture.quotaPath}.refresh.stamp`, { force: true });
  fs.rmSync(marker, { force: true });
  run(['--db', db, 'enqueue', '--repo', repo, '--issue', '72', '--model', 'auto', '--trusted', '--json']);
  const parallel = runCaptured(
    ['--db', db, 'drain', '--parallel', '2', '--executor', executor, '--quota', fixture.quotaPath, '--json'],
    env,
  );
  assert.equal(parallel.exitCode, 0, parallel.stderr);
  assert.match(parallel.stderr, /quota refreshed in/);
  assert.equal(fs.readFileSync(marker, 'utf8').trim(), 'ran');
});

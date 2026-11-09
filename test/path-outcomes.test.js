'use strict';
/**
 * Path-outcome recording and wiring: the queue table (fresh + migrated DBs,
 * window reads, 7-day pruning), one row per runner attempt through the sink
 * (DB records, non-DB sinks no-op), and health-aware MCP/CLI routing with
 * injected deps.
 */
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { DatabaseSync } = require('node:sqlite');

const dbTasks = require('../src/queue/db-tasks.js');
const dbModule = require('../src/queue/db.js');
const { runOnce, runJobWithRetries } = require('../src/runners/execute.js');
const { loadPathHealth, loadPathHealthFile } = require('../src/queue/path-health.js');
const { pathHealth } = require('../src/core/path-health.js');

const NOW = Date.parse('2026-11-09T12:00:00Z');
const MIN = 60 * 1000;

/**
 * @param {string} pathName
 * @param {string} outcome
 * @param {number} ageMs
 */
function row(pathName, outcome, ageMs) {
  return { path: pathName, outcome, created_at: new Date(NOW - ageMs).toISOString() };
}
const { buildReadTools } = require('../src/interfaces/mcp/tools.js');
const { resolveAutoModel } = require('../src/core/auto-model.js');
const { SqliteSource, OrchestratorSource } = require('./helpers/pinned-issue.js');
const { CHEAP_MODEL, STRONG_MODEL, writeRoutingFixture } = require('./helpers/routing-fixture.js');

const AGENTQ = require.resolve('../src/interfaces/cli/agentq.js');

// Provider attribution reads the merged config from AGENTQ_HOME, so give the
// in-process queue a temp home with a provider map instead of the real one.
const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'agentq-path-outcomes-home-'));
fs.mkdirSync(path.join(HOME, 'config'), { recursive: true });
fs.writeFileSync(path.join(HOME, 'config', 'roi.config.json'), JSON.stringify({
  providerPathMap: { codex: 'codex', mistral: 'mistral' },
}));
process.env.AGENTQ_HOME = HOME;

function tmpdir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'path-outcomes-'));
}

function openFreshDb(root, name = 'orchestrator.sqlite') {
  const dbPath = path.join(root, name);
  const db = dbModule.openDb(dbPath);
  dbModule.initSchema(db);
  return { db, dbPath };
}

function columns(db, table) {
  return db.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name);
}

// --- Queue layer ---

test('fresh databases have the path_outcomes table and its indexes', () => {
  const root = tmpdir();
  const { db } = openFreshDb(root);
  try {
    assert.deepEqual(columns(db, 'path_outcomes'), ['id', 'path', 'model', 'task_id', 'outcome', 'created_at']);
    const indexes = db.prepare("PRAGMA index_list(path_outcomes)").all().map((row) => row.name);
    assert.ok(indexes.includes('idx_path_outcomes_path_created'), `missing index, saw: ${indexes.join(', ')}`);
    // The window read and the prune filter on created_at alone.
    assert.ok(indexes.includes('idx_path_outcomes_created'), `missing created_at index, saw: ${indexes.join(', ')}`);
  } finally {
    db.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('databases created before the table existed evolve on initSchema', () => {
  const root = tmpdir();
  const { db, dbPath } = openFreshDb(root, 'old.sqlite');
  // Simulate a database from before path_outcomes existed: full schema,
  // table and index gone.
  db.exec('DROP TABLE path_outcomes');
  db.close();
  const evolved = dbModule.openDb(dbPath);
  dbModule.initSchema(evolved);
  try {
    assert.deepEqual(columns(evolved, 'path_outcomes'), ['id', 'path', 'model', 'task_id', 'outcome', 'created_at']);
    const indexes = evolved.prepare('PRAGMA index_list(path_outcomes)').all().map((row) => row.name);
    assert.ok(indexes.includes('idx_path_outcomes_path_created'));
    assert.ok(indexes.includes('idx_path_outcomes_created'));
  } finally {
    evolved.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('recorded rows read back in window order; old rows are out of window', () => {
  const root = tmpdir();
  const { db } = openFreshDb(root);
  try {
    // A stale row inserted directly (8 days old) is outside the default window.
    const staleAt = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000).toISOString();
    db.prepare(
      'INSERT INTO path_outcomes (path, model, task_id, outcome, created_at) VALUES (?, ?, ?, ?, ?)',
    ).run('mistral', 'm', 't0', 'timeout', staleAt);
    dbTasks.recordPathOutcome(db, { path: 'mistral', model: 'm', taskId: 't1', outcome: 'timeout' });
    dbTasks.recordPathOutcome(db, { path: 'codex', model: 'c', taskId: 't2', outcome: 'ok' });
    const rows = dbTasks.getPathOutcomes(db);
    assert.equal(rows.length, 2, 'the stale row is outside the 1h window');
    assert.deepEqual(rows.map((row) => row.path), ['mistral', 'codex']);
    assert.ok(rows.every((row) => typeof row.created_at === 'string'));
  } finally {
    db.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('insert prunes rows older than 7 days', () => {
  const root = tmpdir();
  const { db } = openFreshDb(root);
  try {
    const old = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000).toISOString();
    const recent = new Date(Date.now() - 6 * 24 * 60 * 60 * 1000).toISOString();
    const insert = db.prepare(
      'INSERT INTO path_outcomes (path, model, task_id, outcome, created_at) VALUES (?, ?, ?, ?, ?)',
    );
    insert.run('mistral', 'm', 'old', 'timeout', old);
    insert.run('mistral', 'm', 'recent', 'timeout', recent);
    dbTasks.recordPathOutcome(db, { path: 'mistral', model: 'm', taskId: 'new', outcome: 'ok' });
    const remaining = db.prepare('SELECT task_id FROM path_outcomes ORDER BY created_at').all()
      .map((row) => row.task_id);
    assert.deepEqual(remaining, ['recent', 'new']);
  } finally {
    db.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('recording validates its inputs', () => {
  const root = tmpdir();
  const { db } = openFreshDb(root);
  try {
    assert.throws(() => dbTasks.recordPathOutcome(db, { path: '', outcome: 'ok' }), /requires a path/);
    assert.throws(() => dbTasks.recordPathOutcome(db, { path: 'p', outcome: 'exploded' }), /unknown outcome/);
  } finally {
    db.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

// --- Shared loader ---

function captureStderr(fn) {
  const lines = [];
  const original = process.stderr.write;
  process.stderr.write = (chunk) => { lines.push(String(chunk)); return true; };
  try {
    return { value: fn(), lines };
  } finally {
    process.stderr.write = original;
  }
}

test('the shared loader returns undefined for an empty history and for a pre-migration database', () => {
  const root = tmpdir();
  const { db } = openFreshDb(root);
  const { db: old, dbPath: oldPath } = openFreshDb(root, 'old.sqlite');
  try {
    assert.equal(loadPathHealth(db), undefined, 'no rows means no health');

    // An old database without the table: no data, and no warning either.
    old.exec('DROP TABLE path_outcomes');
    const direct = captureStderr(() => loadPathHealth(old));
    assert.equal(direct.value, undefined);
    assert.deepEqual(direct.lines, [], 'a missing table is not a fault');

    // Same through the read-only file loader used by `pick`.
    const fromFile = captureStderr(() => loadPathHealthFile(oldPath));
    assert.equal(fromFile.value, undefined);
    assert.deepEqual(fromFile.lines, []);
  } finally {
    db.close();
    old.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('the shared loader honours AGENTQ_PATH_HEALTH=0', () => {
  const root = tmpdir();
  const { db } = openFreshDb(root);
  try {
    dbTasks.recordPathOutcome(db, { path: 'mistral', outcome: 'timeout' });
    assert.ok(loadPathHealth(db));
    assert.equal(loadPathHealth(db, { env: { AGENTQ_PATH_HEALTH: '0' } }), undefined);
  } finally {
    db.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

// --- Runner ---

function makeExecutor(root, body) {
  const file = path.join(root, `executor-${Math.random().toString(36).slice(2)}.sh`);
  fs.writeFileSync(file, body, { mode: 0o755 });
  return file;
}

function makeRepo(root) {
  const repo = path.join(root, 'repo');
  fs.mkdirSync(repo, { recursive: true });
  return repo;
}

function makeGitRepo(root) {
  const repo = makeRepo(root);
  execFileSync('git', ['-C', repo, 'init', '-q', '-b', 'master']);
  execFileSync('git', ['-C', repo, 'config', 'user.email', 'test@example.com']);
  execFileSync('git', ['-C', repo, 'config', 'user.name', 'test']);
  fs.writeFileSync(path.join(repo, 'README.md'), 'seed\n');
  execFileSync('git', ['-C', repo, 'add', 'README.md']);
  execFileSync('git', ['-C', repo, 'commit', '-qm', 'init']);
  return repo;
}

/**
 * Run one attempt through the real SQLite sink and return its outcome row.
 */
async function runAttempt(t, outcome, { executorBody, options = {}, gitRepo = false }) {
  const root = tmpdir();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const source = new SqliteSource(path.join(root, 'orchestrator.sqlite'));
  await source.start();
  t.after(() => source.stop());
  const repo = gitRepo ? makeGitRepo(root) : makeRepo(root);
  const enqueued = await source.enqueue({ repo, issue: 1, model: 'codex/gpt-test', trusted: true, base: 'master' });
  const job = await source.claimNext({ allowUntrusted: true });
  assert.ok(job, 'the trusted job must be claimable');
  assert.equal(job.provider, 'codex');
  const executor = makeExecutor(root, executorBody);
  const result = await runOnce(job, { executor, ...options }, source);
  assert.equal(result.id, enqueued.id);
  const rows = dbTasks.getPathOutcomes(source.db);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].path, outcome.path);
  assert.equal(rows[0].outcome, outcome.outcome);
  return { result, rows };
}

test('an exit-0 attempt records ok', async (t) => {
  const { result } = await runAttempt(t, { path: 'codex', outcome: 'ok' }, {
    executorBody: '#!/usr/bin/env bash\nexit 0\n',
  });
  assert.equal(result.status, 'succeeded');
});

test('a non-zero exit records error', async (t) => {
  const { result } = await runAttempt(t, { path: 'codex', outcome: 'error' }, {
    executorBody: '#!/usr/bin/env bash\nexit 3\n',
  });
  // A failed attempt with retries left is re-pended, so assert the exit.
  assert.equal(result.exitCode, 3);
});

test('a timed-out attempt records timeout', async (t) => {
  const { result } = await runAttempt(t, { path: 'codex', outcome: 'timeout' }, {
    executorBody: '#!/usr/bin/env bash\nsleep 30\n',
    options: { timeout: 300 },
  });
  assert.equal(result.exitCode, 124);
});

test('exit 0 with failed verification records verify_failed', async (t) => {
  // A real git repo, so a managed worktree exists and verification actually runs.
  const { result } = await runAttempt(t, { path: 'codex', outcome: 'verify_failed' }, {
    executorBody: '#!/usr/bin/env bash\nexit 0\n',
    options: { verify: 'false' },
    gitRepo: true,
  });
  assert.equal(result.status, 'unverified');
});

test('a skipped verification (no worktree) records ok, not verify_failed', async (t) => {
  // Non-git repo: verification cannot run, the task is still unverified, but
  // no verification failed — so this is not a task failure for the path.
  const { result } = await runAttempt(t, { path: 'codex', outcome: 'ok' }, {
    executorBody: '#!/usr/bin/env bash\nexit 0\n',
    options: { verify: 'false' },
  });
  assert.equal(result.status, 'unverified');
});

test('an unattributable path skips the row instead of failing the job', async (t) => {
  const root = tmpdir();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const source = new SqliteSource(path.join(root, 'orchestrator.sqlite'));
  await source.start();
  t.after(() => source.stop());
  const job = {
    id: 'job-1',
    kind: 'prompt',
    model: 'unattributable-model-without-a-provider-separator',
    repo_path: makeRepo(root),
    base_branch: 'main',
  };
  const executor = makeExecutor(root, '#!/usr/bin/env bash\nexit 0\n');
  const fakeSink = {
    claim: async () => {},
    finish: async () => ({ status: 'succeeded' }),
    recover: async () => {},
    recordUsage: async () => {},
    fireCallback: async () => {},
    jobLogPath: (id) => path.join(root, 'logs', `agentq-job-${id}.log`),
    worktreePath: (id) => path.join(root, 'worktrees', `job-${id}`),
    statePath: path.join(root, 'orchestrator.sqlite'),
    // No recordPathOutcome: a file-style sink without health support.
  };
  const result = await runOnce(job, { executor }, { sink: fakeSink });
  assert.equal(result.status, 'succeeded');
  assert.deepEqual(dbTasks.getPathOutcomes(source.db), []);
});

test('a recording failure never fails the job', async (t) => {
  const root = tmpdir();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const job = {
    id: 'job-1',
    kind: 'prompt',
    provider: 'codex',
    model: 'codex/gpt-test',
    repo_path: makeRepo(root),
    base_branch: 'main',
  };
  const executor = makeExecutor(root, '#!/usr/bin/env bash\nexit 0\n');
  const logged = [];
  const original = console.error;
  console.error = (...args) => { logged.push(args.join(' ')); };
  t.after(() => { console.error = original; });
  const failingSink = {
    claim: async () => {},
    finish: async () => ({ status: 'succeeded' }),
    recover: async () => {},
    recordUsage: async () => {},
    fireCallback: async () => {},
    jobLogPath: (id) => path.join(root, 'logs', `agentq-job-${id}.log`),
    worktreePath: (id) => path.join(root, 'worktrees', `job-${id}`),
    statePath: path.join(root, 'orchestrator.sqlite'),
    recordPathOutcome: async () => { throw new Error('disk is gone'); },
  };
  const result = await runOnce(job, { executor }, { sink: failingSink });
  assert.equal(result.status, 'succeeded');
  assert.ok(logged.some((line) => line.includes('path outcome not recorded')), logged.join('\n'));
});

test('the orchestrator sink no-ops path outcomes', async () => {
  const source = new OrchestratorSource('http://127.0.0.1:1', 'test-worker');
  await assert.doesNotReject(source.sink.recordPathOutcome({ id: 'x' }, { path: 'codex', model: 'm', outcome: 'ok' }));
});

/**
 * Attempt 1 times out; the retry is claimed under a DIFFERENT provider. The
 * outcome row must follow the claim that ran, not the first attempt's
 * job.provider.
 *
 * Note on scope: a retry cannot be re-routed from one path to another today —
 * `runOnce` stamps the resolved model onto the job through sink.claim, so
 * claimRetry always re-resolves a concrete model. What this pins down is the
 * attribution bug: the retry claim's provider must travel with the claim.
 */
test('a retry books its outcome under the claim it runs, not the previous path', async (t) => {
  const root = tmpdir();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const job = {
    id: 'job-retry',
    kind: 'prompt',
    model: 'codex/gpt-test',
    provider: 'mistral',
    repo_path: makeRepo(root),
    base_branch: 'main',
  };
  const executor = makeExecutor(root, '#!/usr/bin/env bash\nexit 0\n');
  const rows = [];
  const sink = {
    claim: async () => {},
    finish: async () => ({ status: 'succeeded' }),
    recover: async () => {},
    recordUsage: async () => {},
    fireCallback: async () => {},
    jobLogPath: (id) => path.join(root, 'logs', `agentq-job-${id}.log`),
    worktreePath: (id) => path.join(root, 'worktrees', `job-${id}`),
    statePath: path.join(root, 'orchestrator.sqlite'),
    recordPathOutcome: async (_job, detail) => { rows.push(detail); },
  };
  // The retry claim was routed to codex.
  await runOnce(job, { executor }, { sink }, {
    model: 'codex/gpt-test', provider: 'codex', claim_token: 'token-2', claimed_by: 'worker-1',
  });
  assert.deepEqual(rows.map((row) => [row.path, row.outcome]), [['codex', 'ok']]);
});

test('a retry claim without a provider keeps the job path', async (t) => {
  const root = tmpdir();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const job = {
    id: 'job-retry',
    kind: 'prompt',
    model: 'codex/gpt-test',
    provider: 'mistral',
    repo_path: makeRepo(root),
    base_branch: 'main',
  };
  const executor = makeExecutor(root, '#!/usr/bin/env bash\nexit 0\n');
  const rows = [];
  const sink = {
    claim: async () => {},
    finish: async () => ({ status: 'succeeded' }),
    recover: async () => {},
    recordUsage: async () => {},
    fireCallback: async () => {},
    jobLogPath: (id) => path.join(root, 'logs', `agentq-job-${id}.log`),
    worktreePath: (id) => path.join(root, 'worktrees', `job-${id}`),
    statePath: path.join(root, 'orchestrator.sqlite'),
    recordPathOutcome: async (_job, detail) => { rows.push(detail); },
  };
  await runOnce(job, { executor }, { sink }, {
    model: 'codex/gpt-test', claim_token: 'token-2', claimed_by: 'worker-1',
  });
  assert.deepEqual(rows.map((row) => [row.path, row.outcome]), [['mistral', 'ok']]);
});

test('a concrete-model retry keeps its stored provider', async (t) => {
  // Same rule as claimById/requeue: re-attribute only when the model changes,
  // so a retry does not silently clear the claim's path attribution.
  const root = tmpdir();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const source = new SqliteSource(path.join(root, 'orchestrator.sqlite'));
  await source.start();
  t.after(() => source.stop());
  const repo = makeRepo(root);
  await source.enqueue({ repo, issue: 1, model: 'codex/gpt-test', trusted: true, base: 'master' });
  const claimed = await source.claimNext({ allowUntrusted: true });
  const marker = path.join(root, 'first-attempt-ran');
  const executor = makeExecutor(root, `#!/usr/bin/env bash
if [ -f ${JSON.stringify(marker)} ]; then exit 0; fi
touch ${JSON.stringify(marker)}
sleep 30
`);
  const result = await runJobWithRetries(
    claimed,
    // The first attempt sleeps until killed; the retry must finish inside the
    // same budget, including bash and job setup on a loaded machine. 400ms was
    // too tight to be deterministic.
    { executor, timeout: 3000, retries: 1, retryBaseMs: 0 },
    source,
  );
  assert.equal(result.status, 'succeeded');
  const rows = dbTasks.getPathOutcomes(source.db).map((row) => [row.path, row.outcome]);
  assert.deepEqual(rows, [['codex', 'timeout'], ['codex', 'ok']]);
  assert.equal(dbModule.getTask(source.db, claimed.id).provider, 'codex');
});

// --- Wiring with injected deps ---

function healthFor(pathName, consecutive = 3) {
  return new Map([[pathName, {
    state: 'degraded',
    consecutive,
    lastFailureAt: '2026-11-09T11:48:00Z',
    reason: '3 consecutive failures (3 timeout, 0 error, 0 lost), last 12m ago',
  }]]);
}

function mcpDeps(overrides = {}) {
  const calls = { recommend: [] };
  return {
    deps: {
      getCatalog: () => [],
      getCapacity: () => [],
      recommend: (options) => {
        calls.recommend.push(options);
        return { choice: null, choices: [], rejected: [], policy: {} };
      },
      listTasks: () => [],
      getTask: () => null,
      ...overrides,
    },
    calls,
  };
}

function tool(deps, name) {
  return buildReadTools(deps).find((entry) => entry.name === name);
}

test('MCP tools pass health through and surface degraded entries', () => {
  const { deps, calls } = mcpDeps({ getPathHealth: () => healthFor('codex') });
  const capacity = [{ path: 'codex', state: 'available', headroomPct: 60, resetsAt: null, observedAt: 'now', stale: false, reason: null }];
  const withCapacity = mcpDeps({ getPathHealth: () => healthFor('codex'), getCapacity: () => capacity });

  const overview = tool(withCapacity.deps, 'capacity_overview').handler({});
  assert.deepEqual(overview.pathHealth, [{
    path: 'codex', state: 'degraded', consecutive: 3, lastFailureAt: '2026-11-09T11:48:00Z',
  }]);
  assert.deepEqual(overview.paths[0].health, overview.pathHealth[0]);

  const recommended = tool(deps, 'recommend_model').handler({});
  assert.ok(calls.recommend[0].pathHealth instanceof Map);
  assert.deepEqual(recommended.pathHealth, [{
    path: 'codex', state: 'degraded', consecutive: 3, lastFailureAt: '2026-11-09T11:48:00Z',
  }]);
});

test('MCP tools without health keep their exact shape', () => {
  const { deps, calls } = mcpDeps();
  const overview = tool(deps, 'capacity_overview').handler({});
  assert.ok(!('pathHealth' in overview));
  const recommended = tool(deps, 'recommend_model').handler({});
  assert.deepEqual(calls.recommend, [{ tier: 'medium', minIntelligence: undefined, allowUnknownCapacity: false }]);
  assert.ok(!('pathHealth' in recommended));
});

test('auto-model resolution demotes a degraded path', () => {
  const fixture = writeRoutingFixture();
  const base = {
    quotaPath: fixture.quotaPath,
    roiOutputPath: fixture.roiOutputPath,
    runnablesPath: fixture.runnablesPath,
    roiConfigPath: fixture.roiConfigPath,
  };
  assert.equal(resolveAutoModel('auto', base).model, CHEAP_MODEL);
  const demoted = resolveAutoModel('auto', { ...base, pathHealth: healthFor('mistral') });
  assert.equal(demoted.model, STRONG_MODEL);
  assert.equal(demoted.provider, 'codex');
});

// --- CLI wiring ---

function runCli(args, env = {}) {
  try {
    const stdout = execFileSync(process.execPath, [AGENTQ, ...args], {
      encoding: 'utf8',
      env: { ...process.env, AGENTQ_QUOTA_REFRESH: '0', ...env },
      timeout: 30_000,
    });
    return { exitCode: 0, stdout, stderr: '' };
  } catch (err) {
    return { exitCode: err.status ?? 1, stdout: err.stdout || '', stderr: err.stderr || '' };
  }
}

function seedTimeouts(db, count = 3) {
  for (let i = 0; i < count; i++) {
    dbTasks.recordPathOutcome(db, { path: 'mistral', model: CHEAP_MODEL, taskId: `t${i}`, outcome: 'timeout' });
  }
}

test('pick demotes a degraded path and prints a marker', () => {
  const root = tmpdir();
  try {
    const fixture = writeRoutingFixture({ root: path.join(root, 'routing') });
    const { db, dbPath } = openFreshDb(root, 'queue.sqlite');
    seedTimeouts(db);
    db.close();
    const env = fixture.env();
    const decision = runCli(['--db', dbPath, 'pick', '--quota', fixture.quotaPath, '--json'], env);
    assert.equal(decision.exitCode, 0, decision.stderr);
    const parsed = JSON.parse(decision.stdout);
    assert.equal(parsed.default.id, STRONG_MODEL);
    const demotedChoice = parsed.choices.find((choice) => choice.path === 'mistral');
    assert.ok(demotedChoice, 'the degraded path stays eligible');
    assert.match(demotedChoice.reasons.join('\n'), /path degraded: 3 consecutive failures \(3 timeout, 0 error, 0 lost\)/);

    const table = runCli(['--db', dbPath, 'pick', '--quota', fixture.quotaPath], env);
    assert.equal(table.exitCode, 0, table.stderr);
    assert.match(table.stdout, /degraded: mistral \(path degraded: 3 consecutive failures \(3 timeout, 0 error, 0 lost\)/);
    assert.match(table.stdout, new RegExp(`default → ${STRONG_MODEL.replace(/\//g, '\\/')}`));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('pick with AGENTQ_PATH_HEALTH=0 ignores recorded failures', () => {
  const root = tmpdir();
  try {
    const fixture = writeRoutingFixture({ root: path.join(root, 'routing') });
    const { db, dbPath } = openFreshDb(root, 'queue.sqlite');
    seedTimeouts(db);
    db.close();
    const decision = runCli(
      ['--db', dbPath, 'pick', '--quota', fixture.quotaPath, '--json'],
      { ...fixture.env(), AGENTQ_PATH_HEALTH: '0' },
    );
    assert.equal(decision.exitCode, 0, decision.stderr);
    assert.equal(JSON.parse(decision.stdout).default.id, CHEAP_MODEL);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

// --- Lost attempts: lease expiry with no completion report ---

test('recoverExpiredTasks writes a lost row for every recovered task with a provider', () => {
  const root = tmpdir();
  const { db, dbPath } = openFreshDb(root);
  try {
    const first = dbModule.createTask(db, { kind: 'prompt', prompt: 'hangs', provider: 'mistral', model: CHEAP_MODEL });
    const second = dbModule.createTask(db, { kind: 'prompt', prompt: 'dies', provider: 'codex', model: STRONG_MODEL });
    for (const task of [first, second]) {
      db.prepare(`
        UPDATE tasks SET status = 'running', claimed_by = 'worker-1',
          lease_expires_at = '2020-01-01T00:00:00.000Z',
          started_at = '2020-01-01T00:00:00.000Z'
        WHERE id = ?
      `).run(task.id);
    }
    const result = dbModule.recoverExpiredTasks(db, 60);
    assert.equal(result.recovered, 2);
    // getPathOutcomes selects only the health triple; read the full rows here.
    const rows = db.prepare(
      'SELECT path, model, task_id, outcome FROM path_outcomes ORDER BY created_at ASC, id ASC',
    ).all();
    assert.deepEqual(rows.map((row) => [row.path, row.model, row.task_id, row.outcome]), [
      ['mistral', CHEAP_MODEL, first.id, 'lost'],
      ['codex', STRONG_MODEL, second.id, 'lost'],
    ]);
  } finally {
    db.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('recoverExpiredTasks writes no lost row without a provider', () => {
  const root = tmpdir();
  const { db } = openFreshDb(root);
  try {
    const task = dbModule.createTask(db, { kind: 'prompt', prompt: 'no path', provider: null });
    db.prepare(`
      UPDATE tasks SET status = 'running', claimed_by = 'worker-1',
        lease_expires_at = '2020-01-01T00:00:00.000Z',
        started_at = '2020-01-01T00:00:00.000Z'
      WHERE id = ?
    `).run(task.id);
    const result = dbModule.recoverExpiredTasks(db, 60);
    assert.equal(result.recovered, 1);
    assert.deepEqual(dbTasks.getPathOutcomes(db), []);
  } finally {
    db.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('recoverExpiredTasks writes nothing when no task is recovered', () => {
  const root = tmpdir();
  const { db } = openFreshDb(root);
  try {
    const task = dbModule.createTask(db, { kind: 'prompt', prompt: 'fresh', provider: 'codex' });
    db.prepare(`
      UPDATE tasks SET status = 'running', claimed_by = 'worker-1',
        lease_expires_at = '9999-01-01T00:00:00.000Z',
        started_at = ?
        WHERE id = ?
    `).run(new Date().toISOString(), task.id);
    const result = dbModule.recoverExpiredTasks(db, 60);
    assert.equal(result.recovered, 0);
    assert.deepEqual(dbTasks.getPathOutcomes(db), []);
  } finally {
    db.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('pathHealth counts lost as an infrastructure failure with the mixed-kind reason', () => {
  const health = pathHealth(
    [
      row('p', 'timeout', 30 * MIN),
      row('p', 'lost', 12 * MIN),
    ],
    { now: NOW },
  );
  // Two failures stay under the default threshold of three.
  assert.equal(health.get('p').state, 'healthy');
  assert.equal(health.get('p').consecutive, 2);

  const degraded = pathHealth(
    [
      row('p', 'timeout', 30 * MIN),
      row('p', 'timeout', 20 * MIN),
      row('p', 'lost', 12 * MIN),
    ],
    { now: NOW },
  );
  assert.equal(degraded.get('p').state, 'degraded');
  assert.equal(degraded.get('p').consecutive, 3);
  assert.equal(degraded.get('p').reason, '3 consecutive failures (2 timeout, 0 error, 1 lost), last 12m ago');

  // A lost row can also be the only failure kind.
  const allLost = pathHealth(
    [row('p', 'lost', 30 * MIN), row('p', 'lost', 20 * MIN), row('p', 'lost', 12 * MIN)],
    { now: NOW },
  );
  assert.equal(allLost.get('p').state, 'degraded');
  assert.equal(allLost.get('p').reason, '3 consecutive failures (0 timeout, 0 error, 3 lost), last 12m ago');
});

test('a lost row resets like any failure when an ok follows it', () => {
  const health = pathHealth(
    [row('p', 'lost', 30 * MIN), row('p', 'lost', 20 * MIN), row('p', 'lost', 12 * MIN), row('p', 'ok', MIN)],
    { now: NOW },
  );
  assert.equal(health.get('p').state, 'healthy');
  assert.equal(health.get('p').consecutive, 0);
});

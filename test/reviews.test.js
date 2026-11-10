'use strict';

/**
 * Outcome reviews end to end: the queue table (fresh and migrated databases),
 * the queue adapter that folds them into track records, the CLI
 * (`review add|list|stats`, and `pick` unlocking an unscored model), and the MCP
 * tools (`review_task`, `track_records`).
 *
 * Synthetic rows and a fixed clock; no provider calls.
 */

const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const dbModule = require('../src/queue/db.js');
const { loadReviewsFile, loadTrackRecords, loadTrackRecordsFile } = require('../src/queue/track-records.js');
const { wilsonLowerBound } = require('../src/core/track-record.js');
const { buildReadTools } = require('../src/interfaces/mcp/tools.js');
const { buildWriteTools } = require('../src/interfaces/mcp/write-tools.js');
const { CHEAP_MODEL, UNSCORED_MODEL, writeRoutingFixture } = require('./helpers/routing-fixture.js');

const AGENTQ = require.resolve('../src/interfaces/cli/agentq.js');
const NOW = '2026-11-10T12:00:00Z';

function tmpdir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'agentq-reviews-'));
}

function openFreshDb(root, name = 'orchestrator.sqlite') {
  const dbPath = path.join(root, name);
  const db = dbModule.openDb(dbPath);
  dbModule.initSchema(db);
  return { db, dbPath };
}

function columns(db, table) {
  return db.prepare(`PRAGMA table_info(${table})`).all().map((column) => column.name);
}

/**
 * @param {string} dbPath
 * @param {string[]} args
 * @param {Record<string, string>} [env]
 */
function runCli(dbPath, args, env = {}) {
  try {
    const stdout = execFileSync(process.execPath, [AGENTQ, '--db', dbPath, ...args], {
      encoding: 'utf8',
      env: { ...process.env, AGENTQ_QUOTA_REFRESH: '0', ...env },
      timeout: 30_000,
    });
    return { exitCode: 0, stdout, stderr: '' };
  } catch (error) {
    return { exitCode: error.status ?? 1, stdout: error.stdout || '', stderr: error.stderr || '' };
  }
}

function tool(tools, name) {
  const entry = tools.find((candidate) => candidate.name === name);
  assert.ok(entry, `missing tool ${name}`);
  return entry;
}

// --- Queue table ---

test('fresh databases have the reviews table and its (model, tier) index', () => {
  const root = tmpdir();
  const { db } = openFreshDb(root);
  try {
    assert.deepEqual(columns(db, 'reviews'), [
      'id', 'task_id', 'model', 'tier', 'verdict', 'note', 'reviewer', 'source', 'created_at',
    ]);
    const indexes = db.prepare('PRAGMA index_list(reviews)').all().map((row) => row.name);
    assert.ok(indexes.includes('idx_reviews_model_tier'), `missing index, saw: ${indexes.join(', ')}`);
  } finally {
    db.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('the reviews table is added to a database created before it existed', () => {
  const root = tmpdir();
  const { db } = openFreshDb(root);
  try {
    db.exec('DROP TABLE reviews');
    assert.ok(!columns(db, 'reviews').length);
    dbModule.initSchema(db);
    assert.deepEqual(columns(db, 'reviews'), [
      'id', 'task_id', 'model', 'tier', 'verdict', 'note', 'reviewer', 'source', 'created_at',
    ]);
    // Idempotent: running it again changes nothing.
    dbModule.initSchema(db);
    assert.equal(columns(db, 'reviews').length, 9);
  } finally {
    db.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('addReview validates the enums and records the row', () => {
  const root = tmpdir();
  const { db } = openFreshDb(root);
  try {
    assert.throws(() => dbModule.addReview(db, { model: 'm', tier: 'gigantic', verdict: 'accepted' }), /unknown tier/);
    assert.throws(() => dbModule.addReview(db, { model: 'm', tier: 'medium', verdict: 'great' }), /unknown verdict/);
    assert.throws(() => dbModule.addReview(db, { model: '', tier: 'medium', verdict: 'accepted' }), /requires a model/);
    assert.throws(
      () => dbModule.addReview(db, { model: 'm', tier: 'medium', verdict: 'accepted', source: 'guess' }),
      /unknown source/,
    );

    const review = dbModule.addReview(db, {
      model: CHEAP_MODEL,
      tier: 'medium',
      verdict: 'accepted-with-fixes',
      taskId: 'task-1',
      note: 'tests needed a rerun',
      reviewer: 'owner',
    });
    assert.equal(review.model, CHEAP_MODEL);
    assert.equal(review.tier, 'medium');
    assert.equal(review.verdict, 'accepted-with-fixes');
    assert.equal(review.task_id, 'task-1');
    assert.equal(review.note, 'tests needed a rerun');
    assert.equal(review.reviewer, 'owner');
    assert.equal(review.source, 'review');
    assert.match(review.created_at, /^\d{4}-\d{2}-\d{2}T/);
  } finally {
    db.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('listReviews filters by model and since, newest first', () => {
  const root = tmpdir();
  const { db } = openFreshDb(root);
  try {
    dbModule.addReview(db, { model: CHEAP_MODEL, tier: 'small', verdict: 'accepted' });
    dbModule.addReview(db, { model: UNSCORED_MODEL, tier: 'medium', verdict: 'rejected' });
    dbModule.addReview(db, { model: CHEAP_MODEL, tier: 'big', verdict: 'accepted' });

    assert.equal(dbModule.listReviews(db).length, 3);
    assert.deepEqual(dbModule.listReviews(db, { model: CHEAP_MODEL }).map((row) => row.tier), ['big', 'small']);
    assert.equal(dbModule.listReviews(db, { since: '2999-01-01T00:00:00Z' }).length, 0);
    assert.equal(dbModule.listReviews(db, { since: '2000-01-01T00:00:00Z' }).length, 3);
  } finally {
    db.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

// --- Queue adapter ---

test('loadTrackRecordsFile is non-creating and tolerant of a missing file or table', () => {
  const root = tmpdir();
  const missing = path.join(root, 'nope.sqlite');
  assert.equal(loadTrackRecordsFile(missing), undefined);
  assert.equal(fs.existsSync(missing), false, 'the loader must not create a queue');

  // A database from before the reviews table existed: no records, no error.
  const legacyPath = path.join(root, 'legacy.sqlite');
  const legacy = dbModule.openDb(legacyPath);
  legacy.exec('CREATE TABLE tasks (id TEXT PRIMARY KEY)');
  legacy.close();
  assert.equal(loadTrackRecordsFile(legacyPath), undefined);

  // A malformed database is reported once and also yields no records.
  const garbage = path.join(root, 'garbage.sqlite');
  fs.writeFileSync(garbage, 'not a database');
  assert.equal(loadTrackRecordsFile(garbage), undefined);
});

test('the adapter folds reviews and verify failures into records', () => {
  const root = tmpdir();
  const { db, dbPath } = openFreshDb(root);
  try {
    for (let index = 0; index < 11; index += 1) {
      dbModule.addReview(db, { model: CHEAP_MODEL, tier: 'medium', verdict: 'accepted' });
    }
    dbModule.recordPathOutcome(db, { path: 'codex', model: UNSCORED_MODEL, taskId: 't9', outcome: 'verify_failed' });

    // Key resolution needs the runnables; pass the fixture's own so the test
    // never falls back to the developer's real AGENTQ_HOME.
    const { runnablesPath } = writeRoutingFixture();
    const records = loadTrackRecords(db, { runnablesPath });
    const cheap = records.get('deepseek-v4-1-flash').get('medium');
    assert.equal(cheap.n, 11);
    assert.ok(Math.abs(cheap.lowerBound - wilsonLowerBound(11, 11)) < 1e-12);

    const unscored = records.get('gpt-5-6-sol').get('medium');
    assert.equal(unscored.n, 1);
    assert.equal(unscored.rejected, 1);

    // The file variant agrees with the handle variant.
    const fromFile = loadTrackRecordsFile(dbPath, { runnablesPath });
    assert.equal(fromFile.get('deepseek-v4-1-flash').get('medium').n, 11);
    assert.equal(loadReviewsFile(dbPath).length, 11);
    assert.equal(loadReviewsFile(path.join(root, 'absent.sqlite')).length, 0);
  } finally {
    db.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

// --- CLI ---

test('agentq review add, list and stats work against the queue', () => {
  const fixture = writeRoutingFixture();
  const dbPath = path.join(fixture.root, 'data', 'orchestrator.sqlite');
  try {
    const added = runCli(dbPath, [
      'review', 'add', '--model', CHEAP_MODEL, '--tier', 'medium', '--verdict', 'accepted',
      '--note', 'looks right', '--reviewer', 'owner', '--json',
    ], fixture.env());
    assert.equal(added.exitCode, 0, added.stderr);
    const recorded = JSON.parse(added.stdout);
    assert.equal(recorded.status, 'recorded');
    assert.equal(recorded.review.model, CHEAP_MODEL);
    assert.equal(recorded.review.reviewer, 'owner');

    runCli(dbPath, ['review', 'add', '--model', CHEAP_MODEL, '--tier', 'medium', '--verdict', 'accepted'], fixture.env());

    const listed = runCli(dbPath, ['review', 'list', '--json'], fixture.env());
    assert.equal(listed.exitCode, 0, listed.stderr);
    assert.equal(JSON.parse(listed.stdout).length, 2);

    const filtered = runCli(dbPath, ['review', 'list', '--model', UNSCORED_MODEL, '--json'], fixture.env());
    assert.deepEqual(JSON.parse(filtered.stdout), []);

    const stats = runCli(dbPath, ['review', 'stats', '--json'], fixture.env());
    assert.equal(stats.exitCode, 0, stats.stderr);
    const parsed = JSON.parse(stats.stdout);
    assert.equal(parsed.count, 2, 'two reviews at medium inherit into small');
    const medium = parsed.records.find((row) => row.tier === 'medium');
    assert.equal(medium.model, 'deepseek-v4-1-flash');
    assert.equal(medium.n, 2);
    assert.equal(medium.lowerBound, wilsonLowerBound(2, 2));

    const text = runCli(dbPath, ['review', 'stats'], fixture.env());
    assert.equal(text.exitCode, 0, text.stderr);
    assert.match(text.stdout, /track records/);
    assert.match(text.stdout, /deepseek-v4-1-flash\s+medium/);
  } finally {
    fs.rmSync(fixture.root, { recursive: true, force: true });
  }
});

test('agentq review add refuses an unknown model, tier or verdict', () => {
  const fixture = writeRoutingFixture();
  const dbPath = path.join(fixture.root, 'data', 'orchestrator.sqlite');
  try {
    const unknownModel = runCli(dbPath, ['review', 'add', '--model', 'nobody/nothing', '--tier', 'medium', '--verdict', 'accepted'], fixture.env());
    assert.equal(unknownModel.exitCode, 1);
    assert.match(unknownModel.stderr, /unknown model: nobody\/nothing/);

    const badTier = runCli(dbPath, ['review', 'add', '--model', CHEAP_MODEL, '--tier', 'huge', '--verdict', 'accepted'], fixture.env());
    assert.equal(badTier.exitCode, 1);
    assert.match(badTier.stderr, /unknown tier: huge/i);

    const badVerdict = runCli(dbPath, ['review', 'add', '--model', CHEAP_MODEL, '--tier', 'medium', '--verdict', 'fine'], fixture.env());
    assert.equal(badVerdict.exitCode, 1);
    assert.match(badVerdict.stderr, /unknown verdict: fine/);

    const missing = runCli(dbPath, ['review', 'add', '--model', CHEAP_MODEL], fixture.env());
    assert.equal(missing.exitCode, 1);
    assert.match(missing.stderr, /requires --tier/);
  } finally {
    fs.rmSync(fixture.root, { recursive: true, force: true });
  }
});

test('agentq pick unlocks an unscored model only with a qualifying record', () => {
  const fixture = writeRoutingFixture();
  const dbPath = path.join(fixture.root, 'data', 'orchestrator.sqlite');
  try {
    const before = runCli(dbPath, ['pick', '--tier', 'medium', '--json'], fixture.env());
    assert.equal(before.exitCode, 0, before.stderr);
    const beforeDecision = JSON.parse(before.stdout);
    assert.ok(
      beforeDecision.rejected.some((entry) => entry.id === UNSCORED_MODEL && /unscored: no ROI score row/.test(entry.reasons.join(' '))),
      'the unscored model starts rejected',
    );

    const db = dbModule.openDb(dbPath);
    dbModule.initSchema(db);
    for (let index = 0; index < 11; index += 1) {
      dbModule.addReview(db, { model: UNSCORED_MODEL, tier: 'medium', verdict: 'accepted' });
    }
    db.close();

    const after = runCli(dbPath, ['pick', '--tier', 'medium', '--json'], fixture.env());
    assert.equal(after.exitCode, 0, after.stderr);
    const decision = JSON.parse(after.stdout);
    const unlocked = decision.choices.find((entry) => entry.id === UNSCORED_MODEL);
    assert.ok(unlocked, `expected ${UNSCORED_MODEL} to be eligible`);
    assert.equal(unlocked.intelligence, null);
    assert.equal(
      unlocked.reasons[0],
      'track record 11/11 accepted at medium (lower bound 0.74 >= 0.70)',
    );
    const option = decision.options.find((entry) => entry.id === UNSCORED_MODEL);
    assert.ok(option, 'the unlocked model must be offerable');
    assert.equal(option.trackRecord.n, 11);

    // The scored choices keep their order: the record unlocks, it never reorders.
    assert.deepEqual(
      decision.choices.filter((entry) => entry.intelligence !== null).map((entry) => entry.id),
      beforeDecision.choices.map((entry) => entry.id),
    );
  } finally {
    fs.rmSync(fixture.root, { recursive: true, force: true });
  }
});

// --- MCP ---

function reviewDeps(overrides = {}) {
  const calls = { addReview: [] };
  return {
    calls,
    deps: {
      createTask: (task) => ({ id: 'new', status: 'pending', ...task }),
      claimNextTask: () => null,
      completeTask: () => {},
      getTask: (id) => ({ id, status: 'succeeded', model: 'gpt-5' }),
      listTaskEvents: () => [],
      addReview: (review) => {
        calls.addReview.push(review);
        return { id: 7, ...review };
      },
      captureIssueInput: () => ({}),
      resolveAutoModel: () => ({ model: 'gpt-5', provider: 'codex' }),
      ...overrides,
    },
  };
}

test('review_task refuses a task that is not succeeded or failed', () => {
  for (const status of ['pending', 'running', 'unverified', 'rejected']) {
    const { deps } = reviewDeps({ getTask: (id) => ({ id, status, model: 'gpt-5' }) });
    const reviewTask = tool(buildWriteTools(deps), 'review_task');
    assert.throws(
      () => reviewTask.handler({ id: 't1', verdict: 'accepted' }),
      new RegExp(`task t1 is ${status}: only a succeeded or failed task`),
    );
  }
});

test('review_task takes the model and tier from the model-chosen event', () => {
  const { deps, calls } = reviewDeps({
    getTask: (id) => ({ id, status: 'succeeded', model: 'auto' }),
    listTaskEvents: () => [
      { event: 'created', payload: '{"kind":"prompt"}' },
      { event: 'model-chosen', payload: JSON.stringify({ model: 'mistral/deepseek-v4-1-flash-1017', tier: 'big' }) },
    ],
  });
  const result = tool(buildWriteTools(deps), 'review_task').handler({ id: 't1', verdict: 'accepted-with-fixes', note: 'ok' });
  assert.equal(result.model, 'mistral/deepseek-v4-1-flash-1017');
  assert.equal(result.tier, 'big');
  assert.deepEqual(calls.addReview, [{
    model: 'mistral/deepseek-v4-1-flash-1017',
    tier: 'big',
    verdict: 'accepted-with-fixes',
    taskId: 't1',
    note: 'ok',
    reviewer: 'mcp',
  }]);
});

test('review_task prefers the latest event, an explicit tier, and falls back to the task model', () => {
  const latest = reviewDeps({
    getTask: (id) => ({ id, status: 'failed', model: 'stored/model' }),
    listTaskEvents: () => [
      { event: 'model-chosen', payload: JSON.stringify({ model: 'first/model', tier: 'small' }) },
      { event: 'model-chosen', payload: JSON.stringify({ model: 'second/model', tier: 'medium' }) },
    ],
  });
  const result = tool(buildWriteTools(latest.deps), 'review_task').handler({ id: 't1', verdict: 'rejected', tier: 'big' });
  assert.equal(result.model, 'second/model');
  assert.equal(result.tier, 'big', 'the explicit tier wins');

  const fallback = reviewDeps({ getTask: (id) => ({ id, status: 'succeeded', model: 'stored/model' }) });
  const stored = tool(buildWriteTools(fallback.deps), 'review_task').handler({ id: 't1', verdict: 'accepted' });
  assert.equal(stored.model, 'stored/model');
  assert.equal(stored.tier, 'medium', 'no dispatch tier means the default');

  const none = reviewDeps({ getTask: (id) => ({ id, status: 'succeeded', model: 'auto' }) });
  assert.throws(
    () => tool(buildWriteTools(none.deps), 'review_task').handler({ id: 't1', verdict: 'accepted' }),
    /has no recorded model/,
  );
});

test('review_task records into a real queue and track_records reads it back', () => {
  const root = tmpdir();
  const { db } = openFreshDb(root);
  try {
    const task = dbModule.createTask(db, { kind: 'prompt', prompt: 'do it', model: 'auto' });
    dbModule.createTaskEvent(db, task.id, 'model-chosen', {
      model: 'mistral/deepseek-v4-1-flash-1017', tier: 'medium', chosenBy: 'auto',
    });
    const claimed = dbModule.claimTaskById(db, task.id, 'test-worker', {});
    dbModule.completeTask(db, task.id, { status: 'succeeded', summary: 'done', verified: true }, {
      claimedBy: 'test-worker',
      claimToken: claimed.claim_token,
    });

    const writeDeps = {
      createTask: () => ({}),
      claimNextTask: () => null,
      completeTask: () => {},
      getTask: (id) => dbModule.getTask(db, id),
      listTaskEvents: (id) => dbModule.listTaskEvents(db, id),
      addReview: (review) => dbModule.addReview(db, review),
      captureIssueInput: () => ({}),
      resolveAutoModel: () => ({ model: 'gpt-5', provider: 'codex' }),
    };
    const recorded = tool(buildWriteTools(writeDeps), 'review_task').handler({ id: task.id, verdict: 'accepted' });
    assert.equal(recorded.model, 'mistral/deepseek-v4-1-flash-1017');
    assert.equal(recorded.tier, 'medium');

    const stored = dbModule.listReviews(db, { model: 'mistral/deepseek-v4-1-flash-1017' });
    assert.equal(stored.length, 1);
    assert.equal(stored[0].task_id, task.id);
    assert.equal(stored[0].reviewer, 'mcp');

    const readDeps = {
      getCatalog: () => [],
      getCapacity: () => [],
      recommend: () => ({}),
      listTasks: () => [],
      getTask: () => null,
      getTrackRecords: () => loadTrackRecords(db, { runnablesPath: writeRoutingFixture().runnablesPath }),
    };
    const stats = tool(buildReadTools(readDeps), 'track_records').handler({});
    assert.equal(stats.count, 2, 'medium inherits into small');
    const medium = stats.records.find((row) => row.tier === 'medium');
    assert.equal(medium.n, 1);
    assert.equal(medium.accepted, 1);
  } finally {
    db.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('track_records without an injected source is a clear tool error, not a crash', () => {
  const deps = {
    getCatalog: () => [],
    getCapacity: () => [],
    recommend: () => ({}),
    listTasks: () => [],
    getTask: () => null,
  };
  assert.throws(
    () => tool(buildReadTools(deps), 'track_records').handler({}),
    /track records are unavailable/,
  );
});

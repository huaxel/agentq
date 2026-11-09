#!/usr/bin/env node
'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const { openDb, initSchema, createTask: createRawTask, claimNextTask, completeTask,
  failTask, getTask, listTasks, countByStatus, listTaskEvents,
  listDependencies, registerWorker, listWorkers, heartbeatWorker, renewTaskLease,
  setRateLimit, getRateLimits, leaseResource, releaseLease,
  releaseLeasesForTask, getActiveLeases,
  getUsageByTask, getTotalUsage, recoverExpiredTasks, migrateAgentqLog,
  claimTaskById, requeueTask, retryTask, recoverTask, resolveTaskId,
  approveTask, rejectTask, listPendingApprovals,
  blockingDependencies, listDispatchClaims,
  getProviderUtilization, } = require('../src/queue/db.js');
const { pinnedTask } = require('./helpers/pinned-issue.js');
const createTask = (db, task) => createRawTask(db, pinnedTask(task));
const { resolveAutoModel: resolveAutoModelFor } = require('../src/core/auto-model.js');
const { CHEAP_MODEL, writeRoutingFixture } = require('./helpers/routing-fixture.js');

function tmpdir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'orchestrator-test-'));
}

function makeDb() {
  const root = tmpdir();
  const dbPath = path.join(root, 'orchestrator.sqlite');
  const db = openDb(dbPath);
  initSchema(db);
  return { db, dbPath, root };
}

function closeDb({ db }) {
  db.close();
}

function run(args, env = {}, opts = {}) {
  try {
    const stdout = execFileSync(process.execPath, [path.join(__dirname, '..', 'src', 'orchestrator.js'), ...args], {
      encoding: 'utf8',
      env: { ...process.env, ...env },
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

// --- Task CRUD ---

test('createTask creates a task with defaults', () => {
  const { db } = makeDb();
  try {
    const task = createTask(db, { kind: 'prompt', prompt: 'do something', source: 'test' });
    assert.ok(task.id);
    assert.equal(task.kind, 'prompt');
    assert.equal(task.status, 'pending');
    assert.equal(task.priority, 0);
    assert.equal(task.trust_level, 'agent');
    assert.ok(task.created_at);

    const found = getTask(db, task.id);
    assert.equal(found.id, task.id);
    assert.equal(found.kind, 'prompt');
  } finally { closeDb({ db }); }
});

test('createTask stores dependencies and creates entries in task_dependencies', () => {
  const { db } = makeDb();
  try {
    const parent = createTask(db, { kind: 'prompt', prompt: 'parent' });
    const child = createTask(db, { kind: 'prompt', prompt: 'child', depends_on: [parent.id] });
    assert.ok(child.id);

    const deps = listDependencies(db, child.id);
    assert.equal(deps.length, 1);
    assert.equal(deps[0].depends_on_task_id, parent.id);
  } finally { closeDb({ db }); }
});

test('createTask rejects non-existent dependency', () => {
  const { db } = makeDb();
  try {
    assert.throws(
      () => createTask(db, { kind: 'prompt', prompt: 'orphan', depends_on: ['nonexistent-id'] }),
      /not found/,
    );
  } finally { closeDb({ db }); }
});

test('completeTask marks task as succeeded and records usage', () => {
  const { db } = makeDb();
  try {
    const task = createTask(db, { kind: 'prompt', prompt: 'test' });
    claimNextTask(db, 'worker-1');
    completeTask(db, task.id, {
      status: 'succeeded',
      branch: 'main',
      usage: { provider: 'nan-builder', model: 'deepseek-v4-flash', inputTokens: 100, outputTokens: 200, cacheReadTokens: 30, cacheWriteTokens: 5, totalCost: 0.01 },
    });

    const found = getTask(db, task.id);
    assert.equal(found.status, 'succeeded');
    assert.ok(found.finished_at);

    const usage = getUsageByTask(db, task.id);
    assert.equal(usage.length, 1);
    assert.equal(usage[0].input_tokens, 100);
    assert.equal(usage[0].output_tokens, 200);
    assert.equal(usage[0].cache_tokens, 35); // read + write combined, like the migration path
    assert.equal(usage[0].cost, 0.01);
  } finally { closeDb({ db }); }
});

test('completeTask rejects completing a task that was never claimed (still pending)', () => {
  const { db } = makeDb();
  try {
    const task = createTask(db, { kind: 'prompt', prompt: 'test' });
    assert.throws(() => completeTask(db, task.id, { status: 'succeeded' }), /not running/);
    assert.equal(getTask(db, task.id).status, 'pending');
  } finally { closeDb({ db }); }
});

test('completeTask rejects a stale worker reporting after the task was reclaimed', () => {
  const { db } = makeDb();
  try {
    const task = createTask(db, { kind: 'prompt', prompt: 'test' });
    claimNextTask(db, 'worker-A');
    // Simulate recoverExpiredTasks re-pending the task, then a second
    // worker claiming it — worker-A's lease is effectively gone even though
    // worker-A (unaware) is still about to report its own completion.
    db.prepare("UPDATE tasks SET status = 'pending', claimed_by = NULL WHERE id = ?").run(task.id);
    claimNextTask(db, 'worker-B');

    assert.throws(
      () => completeTask(db, task.id, { status: 'succeeded' }, { claimedBy: 'worker-A' }),
      /not running|not claimed/,
    );
    // worker-B's claim is untouched by worker-A's rejected, stale report.
    const found = getTask(db, task.id);
    assert.equal(found.status, 'running');
    assert.equal(found.claimed_by, 'worker-B');

    // The rejected report isn't just discarded — it's recorded so the real
    // result (here: a genuine success) isn't invisible when duplicate work
    // needs to be reconciled later.
    const events = listTaskEvents(db, task.id);
    const orphaned = events.find(e => e.event === 'orphaned_completion');
    assert.ok(orphaned, 'expected an orphaned_completion audit event');
    const payload = JSON.parse(orphaned.payload);
    assert.equal(payload.reportedBy, 'worker-A');
    assert.equal(payload.currentClaimedBy, 'worker-B');
    assert.equal(payload.result.status, 'succeeded');

    // worker-B, the actual current claimant, can complete it normally.
    completeTask(db, task.id, { status: 'succeeded' }, { claimedBy: 'worker-B' });
    assert.equal(getTask(db, task.id).status, 'succeeded');
  } finally { closeDb({ db }); }
});

test('completeTask re-pends a failed task while attempts remain, and only fails terminally once exhausted', () => {
  const { db } = makeDb();
  try {
    const task = createTask(db, { kind: 'prompt', prompt: 'flaky', max_attempts: 2 });

    // Attempt 1: fails, but a retry is still available (attempts=1 < max=2).
    claimNextTask(db, 'worker-1');
    completeTask(db, task.id, { status: 'failed', error: 'transient' }, { claimedBy: 'worker-1' });
    let found = getTask(db, task.id);
    assert.equal(found.status, 'pending');
    assert.equal(found.claimed_by, null);
    assert.equal(found.attempts, 1);

    // Attempt 2: fails again, attempts (2) now meets max_attempts (2) — terminal.
    claimNextTask(db, 'worker-2');
    completeTask(db, task.id, { status: 'failed', error: 'transient again' }, { claimedBy: 'worker-2' });
    found = getTask(db, task.id);
    assert.equal(found.status, 'failed');
    assert.equal(found.attempts, 2);
  } finally { closeDb({ db }); }
});

test('completeTask honors retryable:false and fails terminally on the first attempt', () => {
  const { db } = makeDb();
  try {
    const task = createTask(db, { kind: 'prompt', prompt: 'policy refusal', max_attempts: 3 });
    claimNextTask(db, 'worker-1');

    completeTask(db, task.id, { status: 'failed', error: 'refused', retryable: false }, { claimedBy: 'worker-1' });

    const found = getTask(db, task.id);
    assert.equal(found.status, 'failed');
    assert.equal(found.attempts, 1);
  } finally { closeDb({ db }); }
});

test('completeTask preserves unverified as a terminal status', () => {
  const { db } = makeDb();
  try {
    const task = createTask(db, { kind: 'prompt', prompt: 'verify check' });
    claimNextTask(db, 'worker-1');
    completeTask(db, task.id, { status: 'unverified', verified: 0, error: 'test check failed' }, { claimedBy: 'worker-1' });

    const found = getTask(db, task.id);
    assert.equal(found.status, 'unverified', 'must preserve unverified, not upgrade to succeeded');
    assert.ok(found.finished_at);
    const result = JSON.parse(found.result);
    assert.equal(result.verified, 0);
  } finally { closeDb({ db }); }
});

test('failTask marks task as failed', () => {
  const { db } = makeDb();
  try {
    const task = createTask(db, { kind: 'prompt', prompt: 'test' });
    failTask(db, task.id, 'something went wrong');

    const found = getTask(db, task.id);
    assert.equal(found.status, 'failed');
    assert.ok(found.finished_at);
    const result = JSON.parse(found.result);
    assert.ok(result.error);
  } finally { closeDb({ db }); }
});

// --- Claim & drain ---

test('claimNextTask returns the highest-priority pending task', () => {
  const { db } = makeDb();
  try {
    createTask(db, { kind: 'prompt', prompt: 'low', priority: 1 });
    createTask(db, { kind: 'prompt', prompt: 'high', priority: 10 });

    const claimed = claimNextTask(db, 'worker-1');
    assert.ok(claimed);
    assert.equal(claimed.priority, 10);
    assert.equal(claimed.status, 'running');
    assert.equal(claimed.claimed_by, 'worker-1');

    // Second claim returns the low-priority one
    const second = claimNextTask(db, 'worker-2');
    assert.ok(second);
    assert.equal(second.priority, 1);
  } finally { closeDb({ db }); }
});

test('claimNextTask returns only pending tasks', () => {
  const { db } = makeDb();
  try {
    createTask(db, { kind: 'prompt', prompt: 'pending task' });
    // Claim the only pending task
    const first = claimNextTask(db, 'worker-1');
    assert.ok(first);

    // No more pending tasks
    const result = claimNextTask(db, 'worker-2');
    assert.equal(result, null);
  } finally { closeDb({ db }); }
});

test('claimNextTask increments attempts', () => {
  const { db } = makeDb();
  try {
    createTask(db, { kind: 'prompt', prompt: 'retry me' });
    claimNextTask(db, 'worker-1');
    const task = getTask(db, Object.keys(db.prepare('SELECT id FROM tasks LIMIT 1').all())[0]) ||
      db.prepare('SELECT * FROM tasks').get();
    assert.equal(task.attempts, 1);
  } finally { closeDb({ db }); }
});

test('claimNextTask honors a custom leaseMinutes instead of the fixed 60-minute default', () => {
  const { db } = makeDb();
  try {
    const task = createTask(db, { kind: 'prompt', prompt: 'long job' });
    const before = Date.now();
    claimNextTask(db, 'worker-1', { leaseMinutes: 750 }); // ~12.5h, matching a blocking executor's max runtime
    const found = getTask(db, task.id);
    const leaseMs = Date.parse(found.lease_expires_at) - before;
    assert.ok(leaseMs > 700 * 60_000, `expected a ~750min lease, got ${leaseMs / 60_000}min`);
  } finally { closeDb({ db }); }
});

test('claimNextTask defaults to a 60-minute lease when leaseMinutes is not given', () => {
  const { db } = makeDb();
  try {
    const task = createTask(db, { kind: 'prompt', prompt: 'short job' });
    const before = Date.now();
    claimNextTask(db, 'worker-1');
    const found = getTask(db, task.id);
    const leaseMs = Date.parse(found.lease_expires_at) - before;
    assert.ok(leaseMs > 55 * 60_000 && leaseMs < 65 * 60_000, `expected ~60min, got ${leaseMs / 60_000}min`);
  } finally { closeDb({ db }); }
});

test('listTasks filters by status', () => {
  const { db } = makeDb();
  try {
    createTask(db, { kind: 'prompt', prompt: 'A' });
    createTask(db, { kind: 'prompt', prompt: 'B' });
    claimNextTask(db, 'worker-1'); // first one becomes running

    const all = listTasks(db);
    assert.equal(all.length, 2);

    const pending = listTasks(db, { status: 'pending' });
    assert.equal(pending.length, 1);

    const running = listTasks(db, { status: 'running' });
    assert.equal(running.length, 1);
  } finally { closeDb({ db }); }
});

test('countByStatus returns counts', () => {
  const { db } = makeDb();
  try {
    const a = createTask(db, { kind: 'prompt', prompt: 'A' });
    createTask(db, { kind: 'prompt', prompt: 'B' });
    createTask(db, { kind: 'prompt', prompt: 'C' });
    // Claim and complete A first, then claim B (which becomes running)
    claimNextTask(db, 'worker-0');
    completeTask(db, a.id, { status: 'succeeded' });
    claimNextTask(db, 'worker-1'); // claims B -> running

    const counts = countByStatus(db);
    assert.equal(counts.succeeded, 1);
    assert.equal(counts.running, 1);
    assert.equal(counts.pending, 1);
  } finally { closeDb({ db }); }
});

// --- Events ---

test('listTaskEvents returns ordered events', () => {
  const { db } = makeDb();
  try {
    const task = createTask(db, { kind: 'prompt', prompt: 'test' });
    claimNextTask(db, 'worker-1');

    const events = listTaskEvents(db, task.id);
    assert.ok(events.length >= 2); // created + claimed
    assert.equal(events[0].event, 'created');
    assert.equal(events[events.length - 1].event, 'claimed');
  } finally { closeDb({ db }); }
});

// --- Workers ---

test('registerWorker registers and updates a worker', () => {
  const { db } = makeDb();
  try {
    const w1 = registerWorker(db, { id: 'w1', name: 'test-worker', capabilities: ['coding'] });
    assert.equal(w1.id, 'w1');
    assert.equal(w1.name, 'test-worker');

    const workers = listWorkers(db);
    assert.equal(workers.length, 1);

    // Update worker
    const w2 = registerWorker(db, { id: 'w1', name: 'updated-worker' });
    assert.equal(w2.name, 'updated-worker');

    const workers2 = listWorkers(db);
    assert.equal(workers2[0].name, 'updated-worker');
  } finally { closeDb({ db }); }
});

test('heartbeatWorker updates last_seen', () => {
  const { db } = makeDb();
  try {
    registerWorker(db, { id: 'w1' });
    const before = db.prepare("SELECT last_seen FROM workers WHERE id = 'w1'").get();
    heartbeatWorker(db, 'w1');
    const after = db.prepare("SELECT last_seen FROM workers WHERE id = 'w1'").get();
    assert.ok(after.last_seen >= before.last_seen);
  } finally { closeDb({ db }); }
});

// --- Rate limits ---

test('setRateLimit and getRateLimits', () => {
  const db = makeDb().db;
  try {
    setRateLimit(db, { provider: 'nan-builder', metric: 'rpm', limit_val: 60 });
    setRateLimit(db, { provider: 'nan-builder', metric: 'concurrent', limit_val: 5 });
    setRateLimit(db, { provider: 'nan-builder', metric: 'tpm', model: 'deepseek-v4-flash', limit_val: 1500000 });

    const rls = getRateLimits(db);
    assert.ok(rls.length >= 3);

    const nanRls = getRateLimits(db, 'nan-builder');
    assert.ok(nanRls.length >= 3);
  } finally { closeDb({ db }); }
});

test('leaseResource and releaseLease', () => {
  const { db } = makeDb();
  try {
    leaseResource(db, { id: 'lease-1', provider: 'nan-builder', metric: 'concurrent', amount: 1, task_id: 'task-1', expires_at: new Date(Date.now() + 3600000).toISOString() });
    const leases = getActiveLeases(db, 'nan-builder', 'concurrent');
    assert.equal(leases.length, 1);
    assert.equal(leases[0].total, 1);

    releaseLease(db, 'lease-1');
    const after = getActiveLeases(db, 'nan-builder', 'concurrent');
    assert.equal(after.length, 1);
    assert.equal(after[0].total, 0);
  } finally { closeDb({ db }); }
});

test('releaseLeasesForTask releases all leases for a task', () => {
  const { db } = makeDb();
  try {
    const exp = new Date(Date.now() + 3600000).toISOString();
    leaseResource(db, { id: 'l1', provider: 'p', metric: 'rpm', amount: 1, task_id: 't1', expires_at: exp });
    leaseResource(db, { id: 'l2', provider: 'p', metric: 'tpm', amount: 50000, task_id: 't1', expires_at: exp });

    releaseLeasesForTask(db, 't1');
    const leases = getActiveLeases(db, 'p', 'rpm');
    assert.equal(leases.length, 1);
    assert.equal(leases[0].total, 0);
  } finally { closeDb({ db }); }
});

// --- Usage ---

test('getTotalUsage returns aggregated usage', () => {
  const { db } = makeDb();
  try {
    const task = createTask(db, { kind: 'prompt', prompt: 'test' });
    claimNextTask(db, 'worker-1');
    completeTask(db, task.id, {
      status: 'succeeded',
      usage: { provider: 'nan-builder', model: 'qwen3.6', inputTokens: 500, outputTokens: 1000, totalCost: 0.05 },
    });

    const total = getTotalUsage(db, 7);
    assert.ok(total);
    assert.ok(total.total_cost > 0);
    assert.equal(total.total_input, 500);
    assert.equal(total.total_output, 1000);
  } finally { closeDb({ db }); }
});

// --- Migration ---

test('migrateAgentqLog migrates a JSONL log', () => {
  const root = tmpdir();
  const logPath = path.join(root, 'agentq.log');
  const dbPath = path.join(root, 'orchestrator.sqlite');

  // Write a minimal agentq log
  const events = [
    JSON.stringify({ id: 1, event: 'enqueued', kind: 'github_issue', repo: '/tmp/repo', issue: 42, model: 'test-model', trusted: 1, ts: '2026-01-01T00:00:00.000Z' }),
    JSON.stringify({ id: 1, event: 'claimed', model: 'test-model', ts: '2026-01-01T00:00:01.000Z' }),
    JSON.stringify({ id: 1, event: 'finished', status: 'succeeded', exit: 0, ts: '2026-01-01T00:00:10.000Z', usage: { inputTokens: 11, outputTokens: 22, cacheReadTokens: 33, cacheWriteTokens: 4, totalCost: 0.02 } }),
  ];
  fs.writeFileSync(logPath, events.join('\n'));

  const db = openDb(dbPath);
  initSchema(db);
  const result = migrateAgentqLog(db, logPath);

  assert.equal(result.migrated, 1);

  const task = db.prepare("SELECT * FROM tasks WHERE id = '1'").get();
  assert.equal(task.status, 'succeeded');
  assert.equal(task.model, 'test-model');

  const events2 = db.prepare('SELECT * FROM task_events WHERE task_id = ?').all('1');
  assert.ok(events2.length >= 3);

  const usage = db.prepare('SELECT * FROM usage_records').all();
  assert.ok(usage.length >= 1);
  assert.equal(usage[0].input_tokens, 11);
  assert.equal(usage[0].output_tokens, 22);
  assert.equal(usage[0].cache_tokens, 37);
  assert.equal(usage[0].cost, 0.02);

  closeDb({ db });
});

test('repeated imports do not duplicate usage records', () => {
  const root = tmpdir();
  const logPath = path.join(root, 'agentq.log');
  const dbPath = path.join(root, 'orchestrator.sqlite');

  const events = [
    JSON.stringify({ id: 3, event: 'enqueued', kind: 'github_issue', repo: '/tmp/repo', issue: 42, model: 'test-model', trusted: 1, ts: '2026-01-01T00:00:00.000Z' }),
    JSON.stringify({ id: 3, event: 'finished', status: 'succeeded', exit: 0, ts: '2026-01-01T00:00:10.000Z', usage: { inputTokens: 11, outputTokens: 22, cacheReadTokens: 33, cacheWriteTokens: 4, totalCost: 0.02 } }),
  ];
  fs.writeFileSync(logPath, events.join('\n'));

  const db = openDb(dbPath);
  initSchema(db);
  try {
    assert.equal(migrateAgentqLog(db, logPath).migrated, 1);

    const rows = db.prepare('SELECT COUNT(*) AS c, SUM(cost) AS s FROM usage_records').get();
    assert.equal(rows.c, 1);
    assert.equal(rows.s, 0.02);

    // Importing the same log again must converge, not append: cost totals
    // stay flat and the task is counted as skipped.
    assert.deepEqual(migrateAgentqLog(db, logPath), { migrated: 0, skipped: 1, collisions: [] });
    const again = db.prepare('SELECT COUNT(*) AS c, SUM(cost) AS s FROM usage_records').get();
    assert.equal(again.c, 1);
    assert.equal(again.s, 0.02);
  } finally { closeDb({ db }); }
});

test('a re-import leaves an existing row completely untouched', () => {
  const root = tmpdir();
  const logPath = path.join(root, 'agentq.log');
  const dbPath = path.join(root, 'orchestrator.sqlite');
  fs.writeFileSync(logPath, JSON.stringify({ id: 9, event: 'enqueued', kind: 'github_issue', repo: '/tmp/repo', issue: 9, model: 'test-model', trusted: 1, ts: '2026-01-01T00:00:00.000Z' }) + '\n');
  const db = openDb(dbPath);
  initSchema(db);
  try {
    assert.equal(migrateAgentqLog(db, logPath).migrated, 1);
    // The live row moves on (a requeue + run, say) after the import.
    db.prepare("UPDATE tasks SET status = 'succeeded', model = 'live-model', result = ? WHERE id = '9'")
      .run(JSON.stringify({ status: 'succeeded', completion_id: 'live' }));
    fs.appendFileSync(logPath, JSON.stringify({ id: 9, event: 'claimed', ts: '2026-01-01T00:00:01.000Z' }) + '\n');
    fs.appendFileSync(logPath, JSON.stringify({ id: 9, event: 'finished', status: 'failed', exit: 7, ts: '2026-01-01T00:00:02.000Z' }) + '\n');
    // A re-import is a true skip: the existing (live) row is never rewritten.
    const second = migrateAgentqLog(db, logPath);
    assert.equal(second.migrated, 0);
    assert.equal(second.skipped, 1);
    const task = db.prepare("SELECT status, model, result FROM tasks WHERE id = '9'").get();
    assert.equal(task.status, 'succeeded');
    assert.equal(task.model, 'live-model');
    assert.equal(JSON.parse(task.result).completion_id, 'live');
  } finally { closeDb({ db }); }
});

test('migration fails legacy trust closed with approval required', () => {
  const root = tmpdir();
  const logPath = path.join(root, 'agentq.log');
  const dbPath = path.join(root, 'orchestrator.sqlite');
  // No trusted flag: a pre-flag legacy event must not become trusted_agent.
  fs.writeFileSync(logPath, JSON.stringify({ id: 11, event: 'enqueued', repo: '/tmp/repo', issue: 11, model: 'm', ts: '2026-01-01T00:00:00.000Z' }) + '\n');
  const db = openDb(dbPath);
  initSchema(db);
  try {
    assert.equal(migrateAgentqLog(db, logPath).migrated, 1);
    const task = db.prepare("SELECT trust_level, approval_required FROM tasks WHERE id = '11'").get();
    assert.equal(task.trust_level, 'agent');
    assert.equal(task.approval_required, 1);
  } finally { closeDb({ db }); }
});

test('createTask coerces hostile priority input to a finite number', () => {
  const { db } = makeDb();
  try {
    const task = createTask(db, { kind: 'prompt', prompt: 'x', source: 'test', priority: '0" onfocus="alert(1)' });
    assert.equal(task.priority, 0);
    assert.equal(getTask(db, task.id).priority, 0);
  } finally { closeDb({ db }); }
});

test('claimTaskById claims exactly that task, once', () => {
  const { db } = makeDb();
  try {
    const first = createTask(db, { kind: 'prompt', prompt: 'first', model: 'm' });
    const second = createTask(db, { kind: 'prompt', prompt: 'second', model: 'm' });
    const claimed = claimTaskById(db, second.id, 'worker-a', { model: 'm', leaseMinutes: 5 });
    assert.equal(claimed.id, second.id);
    assert.equal(claimed.status, 'running');
    assert.equal(getTask(db, second.id).attempts, 1);
    assert.equal(getTask(db, first.id).status, 'pending');
    // A second targeted claim of the same task is refused, not duplicated.
    assert.equal(claimTaskById(db, second.id, 'worker-b', { model: 'm' }), null);
    assert.equal(getTask(db, second.id).claimed_by, 'worker-a');
  } finally { closeDb({ db }); }
});

test('claimTaskById respects the attempt budget', () => {
  const { db } = makeDb();
  try {
    const task = createTask(db, { kind: 'prompt', prompt: 'x', model: 'm', max_attempts: 1 });
    assert.ok(claimTaskById(db, task.id, 'worker-a', { model: 'm' }));
    completeTask(db, task.id, { status: 'failed', retryable: false }, { claimedBy: 'worker-a' });
    // attempts == max_attempts: the store will not hand it out again.
    assert.equal(claimTaskById(db, task.id, 'worker-a', { model: 'm' }), null);
  } finally { closeDb({ db }); }
});

test('claimTaskById refuses an unapproved task and leaves it pending', () => {
  const { db } = makeDb();
  try {
    const task = createTask(db, {
      kind: 'prompt', prompt: 'x', model: 'm', source: 'mcp', approval_required: 1,
    });
    const refused = claimTaskById(db, task.id, 'worker-a', { model: 'm' });
    assert.equal(refused.refused, `Task ${task.id} requires human approval before it can run.`);
    assert.equal(getTask(db, task.id).status, 'pending');
    assert.equal(getTask(db, task.id).claimed_by, null);

    // The local operator's own enqueue is exempt, exactly as in claimNextTask.
    const local = claimTaskById(db, task.id, 'worker-a', { model: 'm', localTaskSource: ['mcp'] });
    assert.equal(local.id, task.id);
  } finally { closeDb({ db }); }
});

test('claimTaskById refuses a task with unsatisfied dependencies', () => {
  const { db } = makeDb();
  try {
    const dep = createTask(db, { kind: 'prompt', prompt: 'dep', model: 'm' });
    const task = createTask(db, { kind: 'prompt', prompt: 'x', model: 'm', depends_on: [dep.id] });

    const refused = claimTaskById(db, task.id, 'worker-a', { model: 'm' });
    assert.match(refused.refused, /is blocked: dependencies not succeeded/);
    assert.match(refused.refused, new RegExp(`${dep.id.slice(0, 8)} pending`));
    assert.equal(getTask(db, task.id).status, 'pending');

    // Satisfy the dependency, then the same claim succeeds.
    const depClaim = claimTaskById(db, dep.id, 'worker-a', { model: 'm' });
    completeTask(db, dep.id, { status: 'succeeded' }, {
      claimedBy: depClaim.claimed_by, claimToken: depClaim.claim_token,
    });
    assert.equal(claimTaskById(db, task.id, 'worker-a', { model: 'm' }).id, task.id);
  } finally { closeDb({ db }); }
});

test('blockingDependencies lists only the dependencies that have not succeeded', () => {
  const { db } = makeDb();
  try {
    const done = createTask(db, { kind: 'prompt', prompt: 'done', model: 'm' });
    const pending = createTask(db, { kind: 'prompt', prompt: 'pending', model: 'm' });
    const task = createTask(db, { kind: 'prompt', prompt: 'x', model: 'm', depends_on: [done.id, pending.id] });

    const claim = claimTaskById(db, done.id, 'worker-a', { model: 'm' });
    completeTask(db, done.id, { status: 'succeeded' }, {
      claimedBy: claim.claimed_by, claimToken: claim.claim_token,
    });

    // node:sqlite rows have a null prototype; compare plain objects.
    assert.deepEqual(blockingDependencies(db, task.id).map((row) => ({ ...row })), [{ id: pending.id, status: 'pending' }]);
    assert.deepEqual(blockingDependencies(db, done.id), []);
  } finally { closeDb({ db }); }
});

test('claimTaskById records the model an override replaced', () => {
  const { db } = makeDb();
  try {
    const task = createTask(db, { kind: 'prompt', prompt: 'x', model: 'old-model', provider: 'old-path' });
    claimTaskById(db, task.id, 'worker-a', { model: 'new-model', provider: 'new-path' });
    const claimed = listTaskEvents(db, task.id).find((event) => event.event === 'claimed');
    const payload = JSON.parse(claimed.payload);
    assert.equal(payload.model, 'new-model');
    assert.equal(payload.previous_model, 'old-model');
    assert.equal(payload.previous_provider, 'old-path');

    // No override, no previous_* keys: the audit row stays minimal.
    const plain = createTask(db, { kind: 'prompt', prompt: 'y', model: 'same-model' });
    claimTaskById(db, plain.id, 'worker-a', { model: 'same-model' });
    const plainClaimed = listTaskEvents(db, plain.id).find((event) => event.event === 'claimed');
    assert.equal(JSON.parse(plainClaimed.payload).previous_model, undefined);

    // 'auto' is not a concrete pin: routing it is the normal claim path.
    const auto = createTask(db, { kind: 'prompt', prompt: 'z', model: 'auto' });
    claimTaskById(db, auto.id, 'worker-a', { model: 'routed-model' });
    const autoClaimed = listTaskEvents(db, auto.id).find((event) => event.event === 'claimed');
    assert.equal(JSON.parse(autoClaimed.payload).previous_model, undefined);
  } finally { closeDb({ db }); }
});

test('listDispatchClaims counts only THIS host\'s dispatch claims', () => {
  const { db } = makeDb();
  try {
    const dispatched = createTask(db, { kind: 'prompt', prompt: 'a', model: 'm' });
    const plain = createTask(db, { kind: 'prompt', prompt: 'b', model: 'm' });
    const otherHost = createTask(db, { kind: 'prompt', prompt: 'c', model: 'm' });
    const notNumeric = createTask(db, { kind: 'prompt', prompt: 'd', model: 'm' });
    claimTaskById(db, dispatched.id, 'local-host-dispatch-7', { model: 'm' });
    claimTaskById(db, plain.id, 'local-host-123', { model: 'm' });
    claimTaskById(db, otherHost.id, 'local-otherhost-dispatch-9', { model: 'm' });
    claimTaskById(db, notNumeric.id, 'local-host-dispatch-abc', { model: 'm' });

    assert.deepEqual(listDispatchClaims(db, 'host').map((row) => ({ ...row })), [
      { id: dispatched.id, claimed_by: 'local-host-dispatch-7' },
    ]);
    // A hostname is required: an unanchored count would include other machines.
    assert.throws(() => listDispatchClaims(db), /requires the hostname/);
  } finally { closeDb({ db }); }
});

test('claimTaskById refuses a task whose attempt budget is spent', () => {
  const { db } = makeDb();
  try {
    const task = createTask(db, {
      kind: 'prompt', prompt: 'x', model: 'm', source: 'mcp', max_attempts: 1,
    });
    const claim = claimTaskById(db, task.id, 'worker-a', { model: 'm' });
    // An interrupted run re-pends without resetting attempts, which is how a
    // pending task can have a spent budget.
    recoverTask(db, task.id, {
      claimedBy: claim.claimed_by, claimToken: claim.claim_token, reason: 'interrupted',
    });
    assert.equal(getTask(db, task.id).status, 'pending');

    const refused = claimTaskById(db, task.id, 'worker-a', { model: 'm' });
    assert.match(refused.refused, /has no attempts left \(1\/1\)/);
    assert.equal(getTask(db, task.id).status, 'pending');

    // A locally-owned task owns its retry policy, so the budget does not apply.
    const local = createTask(db, {
      kind: 'prompt', prompt: 'y', model: 'm', source: 'cli', max_attempts: 1,
    });
    const localClaim = claimTaskById(db, local.id, 'worker-a', { model: 'm', localTaskSource: ['cli', 'agentq'] });
    recoverTask(db, local.id, {
      claimedBy: localClaim.claimed_by, claimToken: localClaim.claim_token, reason: 'interrupted',
    });
    assert.equal(
      claimTaskById(db, local.id, 'worker-a', { model: 'm', localTaskSource: ['cli', 'agentq'] }).id,
      local.id,
    );
  } finally { closeDb({ db }); }
});

test('claimTaskById refuses a task whose provider rate limit is full', () => {
  const { db } = makeDb();
  try {
    setRateLimit(db, { provider: 'limited', metric: 'concurrent', limit_val: 1 });
    const first = createTask(db, { kind: 'prompt', prompt: '1', model: 'm1', provider: 'limited' });
    const second = createTask(db, { kind: 'prompt', prompt: '2', model: 'm1', provider: 'limited' });

    assert.equal(claimTaskById(db, first.id, 'worker-a', { model: 'm1', provider: 'limited' }).id, first.id);
    const refused = claimTaskById(db, second.id, 'worker-a', { model: 'm1', provider: 'limited' });
    assert.match(refused.refused, /Provider limited is at its rate limit/);
    assert.equal(getTask(db, second.id).status, 'pending');
    assert.equal(getTask(db, second.id).claimed_by, null);
  } finally { closeDb({ db }); }
});

test('requeueTask re-pends a terminal task, clears results and restarts attempts', () => {
  const { db } = makeDb();
  try {
    const task = createTask(db, { kind: 'prompt', prompt: 'x', model: 'old-model', max_attempts: 1 });
    const claim = claimTaskById(db, task.id, 'worker-a', { model: 'old-model' });
    completeTask(db, task.id, { status: 'failed', exit: 7, retryable: false, completion_id: 'c1' }, {
      claimedBy: claim.claimed_by, claimToken: claim.claim_token,
    });
    const requeued = requeueTask(db, task.id, { model: 'new-model', provider: 'new-path' });
    assert.equal(requeued.status, 'pending');
    const row = getTask(db, task.id);
    assert.equal(row.status, 'pending');
    assert.equal(row.model, 'new-model');
    assert.equal(row.provider, 'new-path', 'a model change re-attributes the quota path');
    assert.equal(row.result, null);
    assert.equal(row.finished_at, null);
    assert.equal(row.claimed_by, null);
    assert.equal(row.claim_token, null);
    assert.equal(row.attempts, 0);
    assert.equal(row.prompt, 'x', 'the original input is retained');
    const events = db.prepare("SELECT event FROM task_events WHERE task_id = ? ORDER BY id").all(task.id).map(e => e.event);
    assert.deepEqual(events, ['created', 'claimed', 'completed', 'requeued']);
  } finally { closeDb({ db }); }
});

test('requeueTask refuses a running task', () => {
  const { db } = makeDb();
  try {
    const task = createTask(db, { kind: 'prompt', prompt: 'x', model: 'm' });
    claimTaskById(db, task.id, 'worker-a', { model: 'm' });
    assert.throws(() => requeueTask(db, task.id), /running/);
    assert.equal(getTask(db, task.id).status, 'running');
  } finally { closeDb({ db }); }
});

test('retryTask claims the retry of one exact completion, atomically', () => {
  const { db } = makeDb();
  try {
    const task = createTask(db, { kind: 'prompt', prompt: 'x', model: 'm', max_attempts: 3 });
    const claim = claimTaskById(db, task.id, 'worker-a', { model: 'm' });
    completeTask(db, task.id, { status: 'failed', retryable: false, completion_id: 'current' }, {
      claimedBy: claim.claimed_by, claimToken: claim.claim_token,
    });

    // A stale receipt is superseded: nothing changes.
    assert.equal(retryTask(db, task.id, {
      workerId: 'worker-a', expectedCompletionId: 'stale', model: 'm',
    }), null);
    assert.equal(getTask(db, task.id).status, 'failed');

    const retried = retryTask(db, task.id, {
      workerId: 'worker-a', expectedCompletionId: 'current', model: 'new-model', provider: 'new-path',
    });
    assert.equal(retried.status, 'running');
    assert.equal(retried.model, 'new-model');
    assert.ok(retried.claim_token);
    const row = getTask(db, task.id);
    assert.equal(row.provider, 'new-path');
    assert.equal(row.attempts, 2, 'an automatic retry consumes the budget');
    const events = db.prepare("SELECT event, payload FROM task_events WHERE task_id = ? ORDER BY id").all(task.id);
    assert.deepEqual(events.map(event => event.event), ['created', 'claimed', 'completed', 'requeued', 'claimed']);
    assert.equal(JSON.parse(events[3].payload).auto, true);
  } finally { closeDb({ db }); }
});

test('retryTask refuses to spend an exhausted budget, leaving the task failed', () => {
  const { db } = makeDb();
  try {
    const task = createTask(db, { kind: 'prompt', prompt: 'x', model: 'm', max_attempts: 1 });
    const claim = claimTaskById(db, task.id, 'worker-a', { model: 'm' });
    completeTask(db, task.id, { status: 'failed', retryable: false, completion_id: 'c1' }, {
      claimedBy: claim.claimed_by, claimToken: claim.claim_token,
    });
    assert.equal(retryTask(db, task.id, {
      workerId: 'worker-a', expectedCompletionId: 'c1', model: 'm',
    }), null);
    const row = getTask(db, task.id);
    assert.equal(row.status, 'failed', 'a refused retry must not re-pend the task');
    assert.equal(row.attempts, 1);

    // A locally-owned task is exempt from the store's budget.
    db.prepare("UPDATE tasks SET source = 'cli' WHERE id = ?").run(task.id);
    const retried = retryTask(db, task.id, {
      workerId: 'worker-a', expectedCompletionId: 'c1', model: 'm', localTaskSource: 'cli',
    });
    assert.equal(retried.status, 'running');
  } finally { closeDb({ db }); }
});

test('recoverTask releases only the matching running claim', () => {
  const { db } = makeDb();
  try {
    const task = createTask(db, { kind: 'prompt', prompt: 'x', model: 'm', max_attempts: 2 });
    const claim = claimTaskById(db, task.id, 'worker-a', { model: 'm' });
    // A different claim token cannot release this run.
    assert.equal(recoverTask(db, task.id, { claimedBy: 'worker-a', claimToken: 'not-the-token' }), null);
    assert.equal(getTask(db, task.id).status, 'running');

    const recovered = recoverTask(db, task.id, {
      claimedBy: claim.claimed_by, claimToken: claim.claim_token, reason: 'interrupted',
    });
    assert.equal(recovered.status, 'pending');
    const row = getTask(db, task.id);
    assert.equal(row.attempts, 1, 'recovery never resets the store\'s attempt budget');
    assert.equal(row.result, null, 'an interrupted run has no completion');
    assert.equal(row.finished_at, null);
    assert.equal(row.claimed_by, null);
    assert.equal(row.claim_token, null);
    assert.equal(claimTaskById(db, task.id, 'worker-b', { model: 'm' }).id, task.id);
  } finally { closeDb({ db }); }
});

test('resolveTaskId accepts a full id or a unique prefix and refuses ambiguity', () => {
  const { db } = makeDb();
  try {
    const task = createTask(db, { kind: 'prompt', prompt: 'x' });
    assert.equal(resolveTaskId(db, task.id), task.id);
    assert.equal(resolveTaskId(db, task.id.slice(0, 6)), task.id);
    assert.throws(() => resolveTaskId(db, task.id.slice(0, 5)), /at least 6 characters/);
    assert.throws(() => resolveTaskId(db, 'ffffffff'), /No task found/);
    // LIKE metacharacters are literal text, not wildcards.
    assert.throws(() => resolveTaskId(db, '%'), /at least 6 characters/);
    assert.throws(() => resolveTaskId(db, '______'), /No task found/);
  } finally { closeDb({ db }); }
});

test('resolveTaskId lists every match for an ambiguous prefix', () => {
  const { db } = makeDb();
  try {
    for (const id of ['aaaaaaaa-1111-4111-8111-111111111111', 'aaaaaaaa-2222-4222-8222-222222222222']) {
      db.prepare("INSERT INTO tasks (id, kind, status, created_at) VALUES (?, 'prompt', 'pending', ?)")
        .run(id, new Date().toISOString());
    }
    assert.throws(() => resolveTaskId(db, 'aaaaaaaa'), (error) => {
      assert.match(error.message, /Ambiguous id prefix aaaaaaaa matches 2 tasks/);
      assert.match(error.message, /aaaaaaaa-1111/);
      assert.match(error.message, /aaaaaaaa-2222/);
      return true;
    });
  } finally { closeDb({ db }); }
});

test('migrateAgentqLog returns zero when log does not exist', () => {
  const root = tmpdir();
  const dbPath = path.join(root, 'orchestrator.sqlite');
  const db = openDb(dbPath);
  initSchema(db);

  const result = migrateAgentqLog(db, '/nonexistent/path/log');
  assert.equal(result.migrated, 0);

  closeDb({ db });
});

// --- Expired task recovery ---

test('recoverExpiredTasks resets stale running tasks to pending', () => {
  const { db } = makeDb();
  try {
    const task = createTask(db, { kind: 'prompt', prompt: 'stale task' });
    // Manually set it to running with an old lease
    db.prepare(`
      UPDATE tasks SET status = 'running', claimed_by = 'worker-1',
        lease_expires_at = '2020-01-01T00:00:00.000Z',
        started_at = '2020-01-01T00:00:00.000Z'
      WHERE id = ?
    `).run(task.id);

    const result = recoverExpiredTasks(db, 60);
    assert.equal(result.recovered, 1);

    const updated = getTask(db, task.id);
    assert.equal(updated.status, 'pending');
    assert.equal(updated.claimed_by, null);
  } finally { closeDb({ db }); }
});

test('renewTaskLease keeps a long-running, still-heartbeating task from being recovered', () => {
  const { db } = makeDb();
  try {
    const task = createTask(db, { kind: 'prompt', prompt: 'long task' });
    // Claim-time lease has already elapsed (simulates a job that outlives
    // the fixed 1h claim window), but the worker is still alive and heartbeating.
    db.prepare(`
      UPDATE tasks SET status = 'running', claimed_by = 'worker-1',
        lease_expires_at = '2020-01-01T00:00:00.000Z', started_at = '2020-01-01T00:00:00.000Z'
      WHERE id = ?
    `).run(task.id);

    renewTaskLease(db, 'worker-1');

    const result = recoverExpiredTasks(db, 60);
    assert.equal(result.recovered, 0);
    const updated = getTask(db, task.id);
    assert.equal(updated.status, 'running');
    assert.equal(updated.claimed_by, 'worker-1');
    assert.ok(updated.last_heartbeat_at);
  } finally { closeDb({ db }); }
});

test('renewTaskLease only touches tasks claimed by that worker', () => {
  const { db } = makeDb();
  try {
    const task = createTask(db, { kind: 'prompt', prompt: 'other worker task' });
    db.prepare(`
      UPDATE tasks SET status = 'running', claimed_by = 'worker-2',
        lease_expires_at = '2020-01-01T00:00:00.000Z'
      WHERE id = ?
    `).run(task.id);

    renewTaskLease(db, 'worker-1'); // a different worker's heartbeat

    const updated = getTask(db, task.id);
    assert.equal(updated.lease_expires_at, '2020-01-01T00:00:00.000Z');
    assert.equal(updated.last_heartbeat_at, null);
  } finally { closeDb({ db }); }
});

test('recoverExpiredTasks does not affect fresh running tasks', () => {
  const { db } = makeDb();
  try {
    const task = createTask(db, { kind: 'prompt', prompt: 'fresh task' });
    db.prepare(`
      UPDATE tasks SET status = 'running', claimed_by = 'worker-1',
        lease_expires_at = ?, started_at = ?
      WHERE id = ?
    `).run(new Date(Date.now() + 3600000).toISOString(), new Date().toISOString(), task.id);

    const result = recoverExpiredTasks(db, 60);
    assert.equal(result.recovered, 0);

    const updated = getTask(db, task.id);
    assert.equal(updated.status, 'running');
    assert.equal(updated.claimed_by, 'worker-1');
  } finally { closeDb({ db }); }
});

test('recoverExpiredTasks returns zero when no stale tasks', () => {
  const { db } = makeDb();
  try {
    createTask(db, { kind: 'prompt', prompt: 'pending task' });
    const result = recoverExpiredTasks(db, 60);
    assert.equal(result.recovered, 0);
  } finally { closeDb({ db }); }
});

test('recoverExpiredTasks uses current expiry semantics for recently expired leases', () => {
  const { db } = makeDb();
  try {
    const task = createTask(db, { kind: 'prompt', prompt: 'recently expired task' });
    // Lease expired 5 seconds ago — well within the 60-minute maxAge window.
    // Under current expiry semantics, it must be recovered immediately without waiting 60 minutes.
    const expiredAt = new Date(Date.now() - 5000).toISOString();
    db.prepare(`
      UPDATE tasks SET status = 'running', claimed_by = 'worker-1',
        lease_expires_at = ?, started_at = ?
      WHERE id = ?
    `).run(expiredAt, expiredAt, task.id);

    const result = recoverExpiredTasks(db, 60);
    assert.equal(result.recovered, 1, 'Should recover task whose lease expired recently');

    const updated = getTask(db, task.id);
    assert.equal(updated.status, 'pending');
    assert.equal(updated.claimed_by, null);
    assert.equal(updated.lease_expires_at, null);
  } finally { closeDb({ db }); }
});

test('recoverExpiredTasks releases rate-limit leases when recovering an expired task', () => {
  const { db } = makeDb();
  try {
    const task = createTask(db, { kind: 'prompt', prompt: 'task with lease', provider: 'test-prov' });
    const expiredAt = new Date(Date.now() - 5000).toISOString();
    db.prepare(`
      UPDATE tasks SET status = 'running', claimed_by = 'worker-1',
        lease_expires_at = ?, started_at = ?
      WHERE id = ?
    `).run(expiredAt, expiredAt, task.id);

    // Insert rate lease for this task
    db.prepare(`
      INSERT INTO rate_leases (id, provider, model, metric, amount, task_id, expires_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run('lease-rec-1', 'test-prov', 'm1', 'concurrent', 1, task.id, new Date(Date.now() + 3600000).toISOString());

    // Verify lease exists before recovery
    const leasesBefore = db.prepare('SELECT * FROM rate_leases WHERE task_id = ?').all(task.id);
    assert.equal(leasesBefore.length, 1);

    const result = recoverExpiredTasks(db, 60);
    assert.equal(result.recovered, 1);

    // Verify rate leases were released
    const leasesAfter = db.prepare('SELECT * FROM rate_leases WHERE task_id = ?').all(task.id);
    assert.equal(leasesAfter.length, 0, 'Rate leases must be released on recovery');
  } finally { closeDb({ db }); }
});

// --- Quota-aware routing tests ---

test('claimNextTask skips saturated provider and claims next candidate', () => {
  const { db } = makeDb();
  try {
    // Set rate limit for 'umans' provider at 0 RPM (saturated)
    setRateLimit(db, { provider: 'umans', metric: 'rpm', limit_val: 0 });

    // Register a worker
    registerWorker(db, { id: 'w1', name: 'test-worker' });

    // Create two tasks: high priority with saturated provider, low priority with available provider
    // clinepass has no rate limit set, so it passes through
    const high = createTask(db, { kind: 'github_issue', model: 'umans-coder', provider: 'umans', priority: 10 });
    const low = createTask(db, { kind: 'github_issue', model: 'cline-pass/kimi-k2.7-code', provider: 'clinepass', priority: 5 });

    // Claim: should skip high-priority saturated task and claim low-priority
    const claimed = claimNextTask(db, 'w1', {});
    assert.ok(claimed);
    assert.equal(claimed.id, low.id);
    assert.equal(claimed.status, 'running');

    // High-priority task remains blocked because its provider is still saturated
    // (rate limit 0 RPM means no capacity ever)
    const claimed2 = claimNextTask(db, 'w1', {});
    // Only the low-priority task was claimable; high is still blocked
    assert.notEqual(claimed2?.id, high.id);
  } finally { closeDb({ db }); }
});

test('claimNextTask scans multiple candidates until one has capacity', () => {
  const { db } = makeDb();
  try {
    setRateLimit(db, { provider: 'umans-coder', metric: 'rpm', limit_val: 0 });
    registerWorker(db, { id: 'w1', name: 'test-worker' });

    // Three tasks: all saturated provider, then one available
    createTask(db, { kind: 'github_issue', model: 'umans-coder', provider: 'umans-coder', priority: 10 });
    createTask(db, { kind: 'github_issue', model: 'umans-coder', provider: 'umans-coder', priority: 8 });
    const available = createTask(db, { kind: 'github_issue', model: 'qwen3.6-27b-mtp', provider: 'qwen3.6-27b-mtp', priority: 3 });

    const claimed = claimNextTask(db, 'w1', {});
    assert.ok(claimed);
    assert.equal(claimed.id, available.id);
    assert.equal(claimed.status, 'running');
  } finally { closeDb({ db }); }
});

test('claimNextTask records the routed model and provider for an auto task', () => {
  const { db } = makeDb();
  try {
    const fixture = writeRoutingFixture();
    const resolveAutoModel = (storedModel) => resolveAutoModelFor(storedModel, {
      runnablesPath: fixture.runnablesPath,
      roiOutputPath: fixture.roiOutputPath,
      quotaPath: fixture.quotaPath,
      roiConfigPath: fixture.roiConfigPath,
      now: fixture.now,
    });
    registerWorker(db, { id: 'w1', name: 'test-worker' });

    const auto = createTask(db, { kind: 'github_issue', model: 'auto', priority: 10 });

    const claimed = claimNextTask(db, 'w1', { resolveAutoModel });
    assert.ok(claimed);
    assert.equal(claimed.id, auto.id);
    assert.equal(claimed.model, CHEAP_MODEL);
    assert.equal(claimed.provider, 'mistral');

    // The routed values are persisted, not just returned.
    const stored = getTask(db, auto.id);
    assert.equal(stored.model, CHEAP_MODEL);
    assert.equal(stored.provider, 'mistral');
  } finally { closeDb({ db }); }
});

test('claimNextTask skips an auto task whose routed provider is rate-limited', () => {
  const { db } = makeDb();
  try {
    const fixture = writeRoutingFixture();
    const resolveAutoModel = (storedModel) => resolveAutoModelFor(storedModel, {
      runnablesPath: fixture.runnablesPath,
      roiOutputPath: fixture.roiOutputPath,
      quotaPath: fixture.quotaPath,
      roiConfigPath: fixture.roiConfigPath,
      now: fixture.now,
    });

    // Saturate the routed provider so the auto task cannot be leased.
    setRateLimit(db, { provider: 'mistral', metric: 'rpm', limit_val: 0 });
    registerWorker(db, { id: 'w1', name: 'test-worker' });

    createTask(db, { kind: 'github_issue', model: 'auto', priority: 10 });
    const fallback = createTask(db, { kind: 'github_issue', model: 'cline-pass/kimi-k2.7-code', provider: 'clinepass', priority: 5 });

    const claimed = claimNextTask(db, 'w1', { resolveAutoModel });
    assert.ok(claimed);
    assert.equal(claimed.id, fallback.id);
  } finally { closeDb({ db }); }
});


test('retryTask keeps the rate-limit lease its re-claim acquired', () => {
  const { db } = makeDb();
  try {
    setRateLimit(db, { provider: 'prov-retry', metric: 'rpm', limit_val: 10 });
    const task = createTask(db, {
      kind: 'prompt', prompt: 'x', model: 'm1', provider: 'prov-retry', max_attempts: 3,
    });
    const leaseCount = () => db.prepare('SELECT count(*) AS n FROM rate_leases WHERE task_id = ?').get(task.id).n;

    const claim = claimTaskById(db, task.id, 'worker-a', { model: 'm1', provider: 'prov-retry' });
    assert.equal(leaseCount(), 1, 'the first claim holds a lease');
    completeTask(db, task.id, { status: 'failed', retryable: false, completion_id: 'c1' }, {
      claimedBy: claim.claimed_by, claimToken: claim.claim_token,
    });
    assert.equal(leaseCount(), 0, 'the failed attempt released its lease');

    const retried = retryTask(db, task.id, {
      workerId: 'worker-a', expectedCompletionId: 'c1', model: 'm1', provider: 'prov-retry',
    });
    assert.ok(retried);
    assert.equal(leaseCount(), 1, 'the retry must hold the lease its re-claim acquired');
  } finally { closeDb({ db }); }
});

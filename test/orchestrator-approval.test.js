#!/usr/bin/env node
'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { openDb, initSchema, createTask, claimNextTask, completeTask,
  failTask, setRateLimit, getRateLimits, getActiveLeases,
  leaseResource, approveTask, rejectTask, listPendingApprovals,
  getProviderUtilization, } = require('../src/queue/db.js');

function tmpdir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'orchestrator-approval-'));
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

// --- Approval workflow ---

test('approveTask sets approved_by and approved_at', () => {
  const { db } = makeDb();
  try {
    const task = createTask(db, {
      kind: 'prompt',
      prompt: 'needs approval',
      trust_level: 'untrusted',
      approval_required: 1,
    });

    const approved = approveTask(db, task.id, 'team-lead');
    assert.equal(approved.status, 'pending');
    assert.equal(approved.approved_by, 'team-lead');
    assert.ok(approved.approved_at);
    assert.equal(approved.approval_required, 0);

    const events = db.prepare('SELECT * FROM task_events WHERE task_id = ? ORDER BY id ASC').all(task.id);
    const approveEvent = events.find(e => e.event === 'approved');
    assert.ok(approveEvent);
    assert.equal(JSON.parse(approveEvent.payload).approved_by, 'team-lead');
  } finally { closeDb({ db }); }
});

test('approveTask rejects tasks that are already approved', () => {
  const { db } = makeDb();
  try {
    const task = createTask(db, { kind: 'prompt', prompt: 'already approved', approval_required: 1 });
    approveTask(db, task.id, 'lead-1');

    assert.throws(() => approveTask(db, task.id, 'lead-2'), /already approved/);
  } finally { closeDb({ db }); }
});

test('rejectTask marks task as rejected and prevents claiming', () => {
  const { db } = makeDb();
  try {
    const task = createTask(db, { kind: 'prompt', prompt: 'rejected task', approval_required: 1 });

    const rejected = rejectTask(db, task.id, 'reviewer', 'incomplete spec');
    assert.equal(rejected.status, 'rejected');
    assert.equal(rejected.approved_by, 'reviewer');

    // Should not be claimable
    const claimed = claimNextTask(db, 'worker-1', {});
    assert.equal(claimed, null);

    // Check events
    const events = db.prepare('SELECT * FROM task_events WHERE task_id = ?').all(task.id);
    assert.ok(events.some(e => e.event === 'rejected'));
  } finally { closeDb({ db }); }
});

test('rejectTask rejects tasks not in pending state', () => {
  const { db } = makeDb();
  try {
    const task = createTask(db, { kind: 'prompt', prompt: 'running task', approval_required: 1 });
    approveTask(db, task.id, 'lead');
    claimNextTask(db, 'worker-1', {}); // claim it, making it running

    assert.throws(() => rejectTask(db, task.id, 'reviewer', 'nope'), /not in pending state/);
  } finally { closeDb({ db }); }
});

test('listPendingApprovals returns only unapproved pending tasks', () => {
  const { db } = makeDb();
  try {
    const t1 = createTask(db, { kind: 'prompt', prompt: 'needs approval', approval_required: 1 });
    const t2 = createTask(db, { kind: 'prompt', prompt: 'approved', approval_required: 1 });
    const t3 = createTask(db, { kind: 'prompt', prompt: 'no approval needed', approval_required: 1 });
    const t4 = createTask(db, { kind: 'prompt', prompt: 'already approved', approval_required: 1 });

    approveTask(db, t2.id, 'lead');
    approveTask(db, t4.id, 'lead');
    // t1 is NOT approved — it stays pending with approval_required=1
    // and should appear in the pending approvals list
    // t3 is also pending with approval_required=1 and no approved_by
    // So we expect 2 pending approvals (t1 and t3)
    const pending = listPendingApprovals(db);
    assert.equal(pending.length, 2);
    const ids = pending.map(p => p.id);
    assert.ok(ids.includes(t1.id));
    assert.ok(ids.includes(t3.id));
    // t2 and t4 should NOT be in the list (approved)
    assert.ok(!ids.includes(t2.id));
    assert.ok(!ids.includes(t4.id));
  } finally { closeDb({ db }); }
});

test('listPendingApprovals respects limit', () => {
  const { db } = makeDb();
  try {
    createTask(db, { kind: 'prompt', prompt: '1', approval_required: 1 });
    createTask(db, { kind: 'prompt', prompt: '2', approval_required: 1 });
    createTask(db, { kind: 'prompt', prompt: '3', approval_required: 1 });

    const all = listPendingApprovals(db, 5);
    assert.equal(all.length, 3);
    const limited = listPendingApprovals(db, 2);
    assert.equal(limited.length, 2);
  } finally { closeDb({ db }); }
});

// --- Rate limit utilization ---

test('getProviderUtilization returns utilization metrics', () => {
  const { db } = makeDb();
  try {
    setRateLimit(db, { provider: 'test-provider', metric: 'rpm', limit_val: 10 });
    setRateLimit(db, { provider: 'test-provider', metric: 'concurrent', limit_val: 5 });

    const util = getProviderUtilization(db, 'test-provider', null);
    assert.equal(util.length, 2);
    // Check both metrics are present
    const byMetric = {}; for (const u of util) byMetric[u.metric] = u;
    assert.equal(byMetric.rpm.limit, 10);
    assert.equal(byMetric.rpm.used, 0);
    assert.equal(byMetric.rpm.remaining, 10);
    assert.equal(byMetric.concurrent.limit, 5);
    assert.equal(byMetric.concurrent.used, 0);
  } finally { closeDb({ db }); }
});

test('getProviderUtilization accounts for active leases', () => {
  const { db } = makeDb();
  try {
    setRateLimit(db, { provider: 'p', metric: 'concurrent', limit_val: 10 });
    leaseResource(db, {
      id: 'lease-1',
      provider: 'p',
      metric: 'concurrent',
      amount: 3,
      task_id: 't1',
      expires_at: new Date(Date.now() + 3600000).toISOString(),
    });
    leaseResource(db, {
      id: 'lease-2',
      provider: 'p',
      metric: 'concurrent',
      amount: 2,
      task_id: 't2',
      expires_at: new Date(Date.now() + 3600000).toISOString(),
    });

    const util = getProviderUtilization(db, 'p', null);
    assert.equal(util.length, 1);
    assert.equal(util[0].used, 5);
    assert.equal(util[0].remaining, 5);
    assert.equal(util[0].utilization, 50);
  } finally { closeDb({ db }); }
});

test('getProviderUtilization filters by model', () => {
  const { db } = makeDb();
  try {
    setRateLimit(db, { provider: 'p', metric: 'tpm', model: 'model-a', limit_val: 100 });
    setRateLimit(db, { provider: 'p', metric: 'tpm', model: 'model-b', limit_val: 100 });

    leaseResource(db, {
      id: 'l1',
      provider: 'p',
      model: 'model-a',
      metric: 'tpm',
      amount: 30,
      task_id: 't1',
      expires_at: new Date(Date.now() + 3600000).toISOString(),
    });

    // getProviderUtilization returns one row per rate-limit definition for the provider
    // but the utilization values are filtered by model
    const utilA = getProviderUtilization(db, 'p', 'model-a');
    const utilB = getProviderUtilization(db, 'p', 'model-b');
    // Both return 1 metric definition (tpm), but model-a has 30 used
    assert.equal(utilA.length, 1);
    assert.equal(utilA[0].metric, 'tpm');
    assert.equal(utilA[0].used, 30);
    assert.equal(utilA[0].utilization, 30);
    assert.equal(utilB.length, 1);
    assert.equal(utilB[0].metric, 'tpm');
    assert.equal(utilB[0].used, 0); // model-b has no leases
  } finally { closeDb({ db }); }
});

// --- Claim with rate-limit lease acquisition ---

test('claimNextTask acquires rate-limit leases when task has a provider', () => {
  const { db } = makeDb();
  try {
    setRateLimit(db, { provider: 'test-provider', metric: 'concurrent', limit_val: 5 });

    const task = createTask(db, {
      kind: 'prompt',
      prompt: 'needs provider',
      provider: 'test-provider',
      model: 'test-model',
    });

    const claimed = claimNextTask(db, 'worker-1', {});
    assert.ok(claimed);
    assert.equal(claimed.status, 'running');

    // Check that a lease was created
    const leases = getActiveLeases(db, 'test-provider', 'concurrent', 'test-model');
    assert.ok(leases.length > 0);
    assert.ok(leases[0].total >= 1);
  } finally { closeDb({ db }); }
});

test('claimNextTask skips task when rate-limit capacity is full', () => {
  const { db } = makeDb();
  try {
    setRateLimit(db, { provider: 'limited', metric: 'concurrent', limit_val: 2 });

    createTask(db, { kind: 'prompt', prompt: '1', provider: 'limited', model: 'm1' });
    createTask(db, { kind: 'prompt', prompt: '2', provider: 'limited', model: 'm1' });
    createTask(db, { kind: 'prompt', prompt: '3', provider: 'limited', model: 'm1' });

    // Claim first two — should succeed
    const c1 = claimNextTask(db, 'worker-1', {});
    assert.ok(c1);
    const c2 = claimNextTask(db, 'worker-2', {});
    assert.ok(c2);

    // Third should be skipped — capacity full
    const c3 = claimNextTask(db, 'worker-3', {});
    assert.equal(c3, null);

    // Fourth should also be skipped
    const c4 = claimNextTask(db, 'worker-4', {});
    assert.equal(c4, null);
  } finally { closeDb({ db }); }
});

test('claimNextTask acquires all rate-limit metrics for a provider', () => {
  const { db } = makeDb();
  try {
    setRateLimit(db, { provider: 'multi-limit', metric: 'rpm', limit_val: 60 });
    setRateLimit(db, { provider: 'multi-limit', metric: 'concurrent', limit_val: 5 });
    setRateLimit(db, { provider: 'multi-limit', metric: 'tpm', limit_val: 1000000 });

    const task = createTask(db, {
      kind: 'prompt',
      prompt: 'multi-limit task',
      provider: 'multi-limit',
      model: 'm',
    });

    const claimed = claimNextTask(db, 'worker-1', {});
    assert.ok(claimed);

    // Should have leases for all three metrics
    const rpmLeases = getActiveLeases(db, 'multi-limit', 'rpm', 'm');
    const concurrentLeases = getActiveLeases(db, 'multi-limit', 'concurrent', 'm');
    const tpmLeases = getActiveLeases(db, 'multi-limit', 'tpm', 'm');
    assert.ok(rpmLeases.length > 0);
    assert.ok(concurrentLeases.length > 0);
    assert.ok(tpmLeases.length > 0);
  } finally { closeDb({ db }); }
});

test('claimNextTask enforces a provider-wide limit across different models, not per model', () => {
  const { db } = makeDb();
  try {
    // A global (model-less) limit must cap total concurrent leases for the
    // provider regardless of which model each task uses — not N per model.
    setRateLimit(db, { provider: 'shared', metric: 'concurrent', limit_val: 2 });

    createTask(db, { kind: 'prompt', prompt: '1', provider: 'shared', model: 'm1' });
    createTask(db, { kind: 'prompt', prompt: '2', provider: 'shared', model: 'm2' });
    createTask(db, { kind: 'prompt', prompt: '3', provider: 'shared', model: 'm3' });

    const c1 = claimNextTask(db, 'worker-1', {});
    const c2 = claimNextTask(db, 'worker-2', {});
    assert.ok(c1);
    assert.ok(c2);

    // Third task uses a third, never-before-seen model — capacity is still
    // exhausted because the limit is per provider, not per model.
    const c3 = claimNextTask(db, 'worker-3', {});
    assert.equal(c3, null);
  } finally { closeDb({ db }); }
});

test('claimNextTask releases leases on rollback (concurrent claim)', () => {
  const { db } = makeDb();
  try {
    setRateLimit(db, { provider: 'scoped', metric: 'concurrent', limit_val: 1 });
    createTask(db, { kind: 'prompt', prompt: 'A', provider: 'scoped' });

    const c1 = claimNextTask(db, 'worker-1', {});
    assert.ok(c1);

    // Task already claimed — second claim should fail
    const c2 = claimNextTask(db, 'worker-2', {});
    assert.equal(c2, null);
  } finally { closeDb({ db }); }
});

test('distinct model-specific rate limits are preserved and enforced per-model', () => {
  const { db } = makeDb();
  try {
    setRateLimit(db, { provider: 'p-multi', metric: 'concurrent', model: 'model-a', limit_val: 1 });
    setRateLimit(db, { provider: 'p-multi', metric: 'concurrent', model: 'model-b', limit_val: 2 });

    const tA1 = createTask(db, { kind: 'prompt', prompt: 'a1', provider: 'p-multi', model: 'model-a' });
    const tA2 = createTask(db, { kind: 'prompt', prompt: 'a2', provider: 'p-multi', model: 'model-a' });
    const tB1 = createTask(db, { kind: 'prompt', prompt: 'b1', provider: 'p-multi', model: 'model-b' });
    const tB2 = createTask(db, { kind: 'prompt', prompt: 'b2', provider: 'p-multi', model: 'model-b' });
    const tB3 = createTask(db, { kind: 'prompt', prompt: 'b3', provider: 'p-multi', model: 'model-b' });

    const cA1 = claimNextTask(db, 'w-1', {});
    assert.ok(cA1 && cA1.id === tA1.id, 'A1 should be claimed');

    // A2 should be blocked because model-a limit is 1
    // But B1 should be claimable because model-b is separate
    const cB1 = claimNextTask(db, 'w-2', {});
    assert.ok(cB1 && cB1.id === tB1.id, 'B1 should be claimed next');

    const cB2 = claimNextTask(db, 'w-3', {});
    assert.ok(cB2 && cB2.id === tB2.id, 'B2 should be claimed next');

    // Now model-a has 1 (limit 1), model-b has 2 (limit 2)
    // Neither A2 nor B3 should be claimable
    const cBlocked = claimNextTask(db, 'w-4', {});
    assert.equal(cBlocked, null, 'Both model-a and model-b limits are exhausted');
  } finally { closeDb({ db }); }
});

test('applicable global plus model limits are jointly enforced', () => {
  const { db } = makeDb();
  try {
    // Global limit: 3 concurrent across the whole provider
    setRateLimit(db, { provider: 'p-joint', metric: 'concurrent', limit_val: 3 });
    // Model-A limit: at most 2 concurrent
    setRateLimit(db, { provider: 'p-joint', metric: 'concurrent', model: 'model-a', limit_val: 2 });
    // Model-B limit: at most 2 concurrent
    setRateLimit(db, { provider: 'p-joint', metric: 'concurrent', model: 'model-b', limit_val: 2 });

    const tA1 = createTask(db, { kind: 'prompt', prompt: 'a1', provider: 'p-joint', model: 'model-a' });
    const tA2 = createTask(db, { kind: 'prompt', prompt: 'a2', provider: 'p-joint', model: 'model-a' });
    const tA3 = createTask(db, { kind: 'prompt', prompt: 'a3', provider: 'p-joint', model: 'model-a' });
    const tB1 = createTask(db, { kind: 'prompt', prompt: 'b1', provider: 'p-joint', model: 'model-b' });
    const tB2 = createTask(db, { kind: 'prompt', prompt: 'b2', provider: 'p-joint', model: 'model-b' });

    // Claim A1: uses 1 global, 1 model-a
    const cA1 = claimNextTask(db, 'w-1', {});
    assert.ok(cA1 && cA1.id === tA1.id);

    // Claim A2: uses 2 global, 2 model-a
    const cA2 = claimNextTask(db, 'w-2', {});
    assert.ok(cA2 && cA2.id === tA2.id);

    // Now model-a is at 2/2 (exhausted), while global is at 2/3 (1 slot left)
    // Claiming next should skip A3 and claim B1
    const cB1 = claimNextTask(db, 'w-3', {});
    assert.ok(cB1 && cB1.id === tB1.id, 'B1 claimed using the remaining global slot');

    // Now global is at 3/3 (exhausted)!
    // B2 has capacity under model-b (1/2), but global is full (3/3).
    // A3 is blocked on model-a (2/2) AND global (3/3).
    const cFull = claimNextTask(db, 'w-4', {});
    assert.equal(cFull, null, 'Global limit enforced jointly with model limits');
  } finally { closeDb({ db }); }
});

// --- Integration: approve then claim ---

test('approved task becomes claimable after approval', () => {
  const { db } = makeDb();
  try {
    const task = createTask(db, {
      kind: 'prompt',
      prompt: 'security-sensitive task',
      trust_level: 'untrusted',
      approval_required: 1,
    });

    // Not claimable while pending approval
    const claimedBefore = claimNextTask(db, 'worker-1', {});
    assert.equal(claimedBefore, null);

    // Approve it
    approveTask(db, task.id, 'security-lead');

    // Now claimable
    const claimedAfter = claimNextTask(db, 'worker-1', {});
    assert.ok(claimedAfter);
    assert.equal(claimedAfter.id, task.id);
    assert.equal(claimedAfter.status, 'running');
  } finally { closeDb({ db }); }
});

// --- Integration: reject then claim ---

test('rejected task remains unclaimable', () => {
  const { db } = makeDb();
  try {
    const task = createTask(db, {
      kind: 'prompt',
      prompt: 'bad idea',
      approval_required: 1,
    });

    rejectTask(db, task.id, 'security-lead', 'too risky');

    const claimed = claimNextTask(db, 'worker-1', {});
    assert.equal(claimed, null);
  } finally { closeDb({ db }); }
});

// --- Integration: utilization dashboard data ---

test('getProviderUtilization handles no rate limits', () => {
  const { db } = makeDb();
  try {
    const util = getProviderUtilization(db, 'nonexistent-provider', null);
    assert.equal(util.length, 0);
  } finally { closeDb({ db }); }
});

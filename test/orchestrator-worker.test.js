#!/usr/bin/env node
'use strict';

/**
 * Orchestrator worker client tests — tests the OrchestratorWorker class
 * by spinning up a real server and exercising the worker API.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { openDb, initSchema, createTask: createRawTask, claimNextTask } = require('../src/queue/db.js');
const { pinnedTask } = require('./helpers/pinned-issue.js');
const createTask = (db, task) => createRawTask(db, pinnedTask(task));
const { createServer } = require('../src/interfaces/http/server.js');
const { OrchestratorWorker } = require('../src/queue/worker.js');

function tmpdir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'orchestrator-worker-'));
}

function makeServer() {
  const root = tmpdir();
  const dbPath = path.join(root, 'test.sqlite');
  const db = openDb(dbPath);
  initSchema(db);
  const server = createServer(db);
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address();
      resolve({ server, db, port: addr.port, root });
    });
  });
}

function closeServer({ server, db }) {
  return new Promise((resolve) => {
    server.close(() => {
      db.close();
      resolve();
    });
  });
}

function makeWorker(port, id = 'test-worker') {
  return new OrchestratorWorker(`http://127.0.0.1:${port}`, id);
}

// --- Registration ---

test('Worker registers itself with the server', async () => {
  const { server, db, port } = await makeServer();
  try {
    const worker = makeWorker(port);
    const result = await worker.register({ name: 'test', capabilities: ['coding'] });
    assert.ok(result);
    assert.equal(result.id, 'test-worker');
    assert.equal(result.name, 'test');

    // Verify in DB
    const workers = require('../src/queue/db.js').listWorkers(db);
    assert.ok(workers.some(w => w.id === 'test-worker' && w.name === 'test'));
  } finally { await closeServer({ server, db }); }
});

// --- Heartbeat ---

test('Worker heartbeat updates last_seen', async () => {
  const { server, db, port } = await makeServer();
  try {
    const worker = makeWorker(port);
    await worker.register({ name: 'hb-test' });

    const before = require('../src/queue/db.js').listWorkers(db).find(w => w.id === 'test-worker');
    const lastSeen = before.last_seen;

    // Wait a moment, then send heartbeat
    await new Promise(r => setTimeout(r, 50));
    await worker.heartbeat();

    const after = require('../src/queue/db.js').listWorkers(db).find(w => w.id === 'test-worker');
    assert.ok(after.last_seen >= lastSeen);
  } finally { await closeServer({ server, db }); }
});

test('startHeartbeat / stopHeartbeat manage periodic heartbeats', async () => {
  const { server, db, port } = await makeServer();
  try {
    const worker = makeWorker(port, 'heartbeat-test');
    await worker.register({ name: 'heartbeat-test' });

    const before = require('../src/queue/db.js').listWorkers(db).find(w => w.id === 'heartbeat-test');

    // Start heartbeat
    worker.startHeartbeat();
    assert.ok(worker.heartbeatTimer);

    // Wait for a few heartbeats
    await new Promise(r => setTimeout(r, 100));

    // Stop heartbeat
    worker.stopHeartbeat();
    assert.equal(worker.heartbeatTimer, null);

    const after = require('../src/queue/db.js').listWorkers(db).find(w => w.id === 'heartbeat-test');
    assert.ok(after.last_seen >= before.last_seen);
  } finally { await closeServer({ server, db }); }
});

// --- Claim and complete ---

test('Worker claims a task and completes it', async () => {
  const { server, db, port } = await makeServer();
  try {
    const task = createTask(db, { kind: 'prompt', prompt: 'worker task' });

    const worker = makeWorker(port);
    const claimed = await worker.claimNext();
    assert.ok(claimed);
    assert.equal(claimed.id, task.id);
    assert.equal(claimed.status, 'running');
    assert.equal(claimed.claimed_by, 'test-worker');

    await worker.complete(task.id, { status: 'succeeded', branch: 'main' });

    const final = require('../src/queue/db.js').getTask(db, task.id);
    assert.equal(final.status, 'succeeded');
    assert.ok(final.finished_at);
  } finally { await closeServer({ server, db }); }
});

test('Worker reports task failure', async () => {
  const { server, db, port } = await makeServer();
  try {
    const task = createTask(db, { kind: 'prompt', prompt: 'fail task' });

    const worker = makeWorker(port);
    const claimed = await worker.claimNext();
    assert.ok(claimed);

    await worker.fail(task.id, 'test failure', { retryable: false });

    const final = require('../src/queue/db.js').getTask(db, task.id);
    assert.equal(final.status, 'failed');
    const result = JSON.parse(final.result);
    assert.ok(result.error);
  } finally { await closeServer({ server, db }); }
});

test('Worker returns null when no tasks available', async () => {
  const { server, db, port } = await makeServer();
  try {
    const worker = makeWorker(port);
    const claimed = await worker.claimNext();
    assert.equal(claimed, null);
  } finally { await closeServer({ server, db }); }
});

test('Worker claims with worker ID propagation', async () => {
  const { server, db, port } = await makeServer();
  try {
    createTask(db, { kind: 'prompt', prompt: 'named claim' });

    const worker = makeWorker(port, 'named-worker');
    const claimed = await worker.claimNext();
    assert.ok(claimed);
    assert.equal(claimed.claimed_by, 'named-worker');
  } finally { await closeServer({ server, db }); }
});

// --- Enqueue and get task ---

test('Worker enqueues a subtask', async () => {
  const { server, db, port } = await makeServer();
  try {
    // Worker enqueue always sets source = workerId (overrides any passed source)
    const worker = makeWorker(port, 'enqueuer');
    await worker.register({ name: 'enqueuer' });

    const enqueued = await worker.enqueue({
      kind: 'subtask',
      prompt: 'spawned subtask',
    });
    assert.ok(enqueued);
    assert.equal(enqueued.kind, 'subtask');
    // Worker enqueue always overwrites source with its workerId
    assert.equal(enqueued.source, 'enqueuer');

    const task = require('../src/queue/db.js').getTask(db, enqueued.id);
    assert.ok(task);
    assert.equal(task.prompt, 'spawned subtask');
  } finally { await closeServer({ server, db }); }
});

test('Worker gets task status', async () => {
  const { server, db, port } = await makeServer();
  try {
    const task = createTask(db, { kind: 'prompt', prompt: 'status check' });

    const worker = makeWorker(port);
    const status = await worker.getTask(task.id);
    assert.ok(status);
    assert.equal(status.id, task.id);
    assert.equal(status.prompt, 'status check');
  } finally { await closeServer({ server, db }); }
});

// --- Approval workflow via worker ---

test('Worker approves a task', async () => {
  const { server, db, port } = await makeServer();
  try {
    const task = createTask(db, { kind: 'prompt', prompt: 'approve via worker', approval_required: 1 });

    const worker = makeWorker(port);
    const result = await worker.approveTask(task.id, 'worker-lead');
    assert.ok(result);
    assert.equal(result.approved_by, 'worker-lead');
    assert.equal(result.approval_required, 0);
  } finally { await closeServer({ server, db }); }
});

test('Worker rejects a task', async () => {
  const { server, db, port } = await makeServer();
  try {
    const task = createTask(db, { kind: 'prompt', prompt: 'reject via worker', approval_required: 1 });

    const worker = makeWorker(port);
    const result = await worker.rejectTask(task.id, 'bad idea');
    assert.ok(result);
    assert.equal(result.status, 'rejected');
  } finally { await closeServer({ server, db }); }
});

test('Worker lists pending approvals', async () => {
  const { server, db, port } = await makeServer();
  try {
    const dbM = require('../src/queue/db.js');
    createTask(db, { kind: 'prompt', prompt: 'needs approval 1', approval_required: 1 });
    createTask(db, { kind: 'prompt', prompt: 'needs approval 2', approval_required: 1 });
    createTask(db, { kind: 'prompt', prompt: 'already approved', approval_required: 1 });
    const approvedTask = dbM.listTasks(db).find(t => t.prompt === 'already approved');
    dbM.approveTask(db, approvedTask.id, 'lead');

    const worker = makeWorker(port);
    const approvals = await worker.listPendingApprovals({ limit: 10 });
    assert.ok(Array.isArray(approvals));
    assert.equal(approvals.length, 2);
  } finally { await closeServer({ server, db }); }
});

// --- Drain loop ---

test('Worker drain processes tasks until queue is empty', async () => {
  const { server, db, port } = await makeServer();
  try {
    // Pre-populate tasks
    const t1 = createTask(db, { kind: 'prompt', prompt: 'drain 1' });
    const t2 = createTask(db, { kind: 'prompt', prompt: 'drain 2' });

    const worker = makeWorker(port);
    const processed = [];
    const count = await worker.drain(async (task) => {
      processed.push(task.id);
      await worker.complete(task.id, { status: 'succeeded' });
    });

    assert.equal(count, 2);
    assert.equal(processed.length, 2);
    assert.ok(processed.includes(t1.id));
    assert.ok(processed.includes(t2.id));
  } finally { await closeServer({ server, db }); }
});

test('Worker drain with maxTasks limits processing', async () => {
  const { server, db, port } = await makeServer();
  try {
    createTask(db, { kind: 'prompt', prompt: 'drain 1' });
    createTask(db, { kind: 'prompt', prompt: 'drain 2' });
    createTask(db, { kind: 'prompt', prompt: 'drain 3' });

    const worker = makeWorker(port);
    let count = 0;
    const processed = await worker.drain(async (task) => {
      count++;
      await worker.complete(task.id, { status: 'succeeded' });
    }, { maxTasks: 1 });

    assert.equal(processed, 1);
    assert.equal(count, 1);
  } finally { await closeServer({ server, db }); }
});

// --- Utilization ---

test('Worker gets utilization for a provider', async () => {
  const { server, db, port } = await makeServer();
  try {
    require('../src/queue/db.js').setRateLimit(db, { provider: 'util-worker', metric: 'concurrent', limit_val: 10 });
    require('../src/queue/db.js').leaseResource(db, {
      id: 'util-wl', provider: 'util-worker', metric: 'concurrent', amount: 3,
      task_id: 't1', expires_at: new Date(Date.now() + 3600000).toISOString(),
    });

    const worker = makeWorker(port);
    const util = await worker.getUtilization('util-worker');
    assert.ok(util);
    assert.ok(Array.isArray(util));
    assert.ok(util.some(u => u.provider === 'util-worker' && u.used === 3));
  } finally { await closeServer({ server, db }); }
});

// --- Error handling ---

test('Worker handles server errors gracefully', async () => {
  const { server, db, port } = await makeServer();
  try {
    const worker = makeWorker(port, 'error-test');
    await worker.register({ name: 'error-test' });

    // Try to claim from empty queue — should return null, not throw
    const claimed = await worker.claimNext();
    assert.equal(claimed, null);
  } finally { await closeServer({ server, db }); }
});

test('Worker drain on empty queue returns 0', async () => {
  const { server, db, port } = await makeServer();
  try {
    const worker = makeWorker(port);
    const count = await worker.drain(async (task) => {
      // Should never be called
      assert.fail('should not process any tasks');
    });
    assert.equal(count, 0);
  } finally { await closeServer({ server, db }); }
});

test('Heartbeat renews the held task lease by the claimed length', async () => {
  // A long claim lease (agentq uses 12.5 h so a network/loop stall cannot
  // lose the claim) must survive heartbeats: the worker reports the lease
  // length it claimed with, and the server renews by that — not by the
  // fixed 60-minute default, which would shrink the claim on the first beat
  // and let recoverExpiredTasks duplicate a live long job.
  const { server, db, port } = await makeServer();
  try {
    createTask(db, { kind: 'github_issue', prompt: 'long job' });
    const worker = makeWorker(port, 'lease-worker');
    await worker.register({ name: 'lease-worker' });

    const task = await worker.claimNext({ leaseMinutes: 750 });
    assert.ok(task, 'expected a task to claim');

    await worker.heartbeat();
    const renewed = db.prepare('SELECT lease_expires_at, last_heartbeat_at FROM tasks WHERE id = ?').get(task.id);
    assert.ok(renewed.last_heartbeat_at, 'heartbeat should be recorded on the task');
    const renewedMs = Date.parse(renewed.lease_expires_at) - Date.now();
    // ~750 minutes, not ~60: allow clock slack but reject a 60-minute renewal.
    assert.ok(renewedMs > 700 * 60 * 1000, `lease renewed for ${Math.round(renewedMs / 60000)}min, expected ~750min`);
    assert.ok(renewedMs < 760 * 60 * 1000, `lease renewed for ${Math.round(renewedMs / 60000)}min, expected ~750min`);
  } finally { await closeServer({ server, db }); }
});

test('Default claim after a long claim does not inherit the long lease', async () => {
  // The worker must renew a default-lease claim with the DEFAULT lease (60
  // min), not the 750 min cached from an earlier long claim — and an empty
  // claim must not disturb the cache (a bogus 15-min cache would show up in
  // the renewal below).
  const { server, db, port } = await makeServer();
  try {
    const long = createTask(db, { kind: 'github_issue', prompt: 'long job' });
    const short = createTask(db, { kind: 'workflow', prompt: 'short job' });
    const worker = makeWorker(port, 'lease-reset-worker');
    await worker.register({ name: 'lease-reset-worker' });

    const a = await worker.claimNext({ kind: 'github_issue', leaseMinutes: 750 });
    assert.ok(a && a.id === long.id);

    // Empty claim with an explicit lease: nothing is claimed, so the cache
    // must keep the value of the claim the worker still holds.
    const none = await worker.claimNext({ kind: 'github_issue', leaseMinutes: 15 });
    assert.equal(none, null);

    const b = await worker.claimNext({ kind: 'workflow' }); // default lease (server: 60 min)
    assert.ok(b && b.id === short.id);

    await worker.heartbeat();
    const leaseB = db.prepare('SELECT lease_expires_at FROM tasks WHERE id = ?').get(b.id);
    const renewedMs = Date.parse(leaseB.lease_expires_at) - Date.now();
    // Renewed by ~60 min (this claim's lease), not 750 (stale cache) or 15
    // (cache polluted by the empty claim).
    assert.ok(renewedMs > 55 * 60 * 1000 && renewedMs < 70 * 60 * 1000,
      `default-claim lease renewed for ${Math.round(renewedMs / 60000)}min, expected ~60min`);
  } finally { await closeServer({ server, db }); }
});

#!/usr/bin/env node
'use strict';

/**
 * Orchestrator worker client tests — tests the REST API endpoints
 * by spinning up a real HTTP server and making fetch requests against it.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { setTimeout: delay } = require('node:timers/promises');
const { snapshotForIssue } = require('./helpers/pinned-issue.js');

const { openDb, initSchema } = require('../src/queue/db.js');
const { createServer, memoizeWithTtl, DASHBOARD_HTML } = require('../src/interfaces/http/server.js');
const { closeSseClients } = require('../src/interfaces/http/routes.js');

function tmpdir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'orchestrator-http-'));
}

// --- Helpers ---

function makeTestServer(options = {}) {
  const root = tmpdir();
  const dbPath = path.join(root, 'test.sqlite');
  const db = openDb(dbPath);
  initSchema(db);
  const server = createServer(db, null, {
    captureIssueInput: async (_repo, number) => snapshotForIssue(number), ...options,
  });

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

function fetch(path, opts = {}) {
  return new Promise((resolve, reject) => {
    const url = new URL(`http://127.0.0.1:${opts.port}${path}`);
    const req = http.request(url, {
      method: opts.method || 'GET',
      headers: { 'Content-Type': 'application/json', ...(opts.headers || {}) },
    }, (res) => {
      let body = '';
      res.on('data', c => body += c);
      res.on('end', () => {
        resolve({ status: res.statusCode, headers: res.headers, body });
      });
    });
    req.on('error', reject);
    if (opts.body) req.write(JSON.stringify(opts.body));
    req.end();
  });
}

function fetchJSON(path, opts = {}) {
  return fetch(path, opts).then(res => ({
    ...res,
    data: res.body ? JSON.parse(res.body) : null,
  }));
}

test('API rejects oversized JSON bodies', async () => {
  const { server, db, port } = await makeTestServer();
  try {
    const res = await fetch('/api/tasks', {
      port,
      method: 'POST',
      body: { prompt: 'x'.repeat(1_000_001) },
    });
    assert.equal(res.status, 413);
  } finally { await closeServer({ server, db }); }
});

test('API does not trust arbitrary CORS origins even when Host is spoofed', async () => {
  const { server, db, port } = await makeTestServer();
  try {
    const res = await fetch('/api/tasks', {
      port,
      headers: { Origin: 'https://attacker.example', Host: 'attacker.example' },
    });
    assert.equal(res.status, 403);
    assert.equal(res.headers['access-control-allow-origin'], undefined);
    assert.equal(res.headers['x-content-type-options'], 'nosniff');
    assert.equal(res.headers['x-frame-options'], 'DENY');
    assert.equal(res.headers['referrer-policy'], 'no-referrer');
  } finally { await closeServer({ server, db }); }
});

test('denied browser origins cannot claim a task through the GET endpoint', async () => {
  const { server, db, port } = await makeTestServer();
  try {
    const dbMod = require('../src/queue/db.js');
    const task = dbMod.createTask(db, { kind: 'prompt', prompt: 'must remain pending' });
    const res = await fetch('/api/tasks/next', {
      port,
      headers: { Origin: 'https://attacker.example', Host: 'attacker.example' },
    });
    assert.equal(res.status, 403);
    assert.equal(dbMod.getTask(db, task.id).status, 'pending');
  } finally { await closeServer({ server, db }); }
});

test('same-origin loopback browser requests remain allowed without configuration', async () => {
  const { server, db, port } = await makeTestServer();
  try {
    const origin = `http://127.0.0.1:${port}`;
    const res = await fetch('/api/tasks', { port, headers: { Origin: origin } });
    assert.equal(res.status, 200);
    assert.equal(res.headers['access-control-allow-origin'], origin);
  } finally { await closeServer({ server, db }); }
});

test('CORS preflight allows only an explicitly configured exact origin', async () => {
  const previous = process.env.AGENTQ_CORS_ALLOWED_ORIGINS;
  process.env.AGENTQ_CORS_ALLOWED_ORIGINS = 'https://dashboard.example';
  const { server, db, port } = await makeTestServer();
  try {
    const allowed = await fetch('/api/tasks', {
      port,
      method: 'OPTIONS',
      headers: { Origin: 'https://dashboard.example' },
    });
    assert.equal(allowed.status, 204);
    assert.equal(allowed.headers['access-control-allow-origin'], 'https://dashboard.example');
    assert.match(allowed.headers['access-control-allow-methods'], /PATCH/);

    const denied = await fetch('/api/tasks', {
      port,
      method: 'OPTIONS',
      headers: { Origin: 'https://attacker.example' },
    });
    assert.equal(denied.status, 403);
  } finally {
    await closeServer({ server, db });
    if (previous == null) delete process.env.AGENTQ_CORS_ALLOWED_ORIGINS;
    else process.env.AGENTQ_CORS_ALLOWED_ORIGINS = previous;
  }
});

test('mutation endpoints reject non-object JSON bodies', async () => {
  const { server, db, port } = await makeTestServer();
  try {
    const res = await fetchJSON('/api/tasks', { port, method: 'POST', body: [] });
    assert.equal(res.status, 400);
    assert.match(res.data.error, /must be an object/);
    assert.equal(require('../src/queue/db.js').listTasks(db).length, 0);
  } finally { await closeServer({ server, db }); }
});

// --- Task CRUD ---

test('POST /api/tasks creates a task and returns 201', async () => {
  const { server, db, port } = await makeTestServer();
  try {
    const res = await fetchJSON('/api/tasks', {
      port,
      method: 'POST',
      body: { kind: 'prompt', prompt: 'test task', source: 'api-test' },
    });
    assert.equal(res.status, 201);
    assert.ok(res.data.id);
    assert.equal(res.data.kind, 'prompt');
    assert.equal(res.data.status, 'pending');
    assert.ok(res.data.created_at);
  } finally { await closeServer({ server, db }); }
});

test('POST /api/tasks with trust_level + approval_required marks task as pending approval', async () => {
  const { server, db, port } = await makeTestServer();
  try {
    const res = await fetchJSON('/api/tasks', {
      port,
      method: 'POST',
      body: { kind: 'prompt', prompt: 'needs review', trust_level: 'untrusted', approval_required: 1 },
    });
    assert.equal(res.status, 201);
    // approval_required is stored in DB; verify via direct query
    const task = require('../src/queue/db.js').getTask(db, res.data.id);
    assert.equal(task.approval_required, 1);
    assert.equal(task.status, 'pending');
  } finally { await closeServer({ server, db }); }
});

test('POST /api/tasks forces approval for an untrusted task even without approval_required set', async () => {
  const { server, db, port } = await makeTestServer();
  try {
    // A client posting an untrusted task without approval_required (or with
    // it explicitly 0) must still be gated — the server, not the client,
    // enforces the trust gate for untrusted work.
    const res = await fetchJSON('/api/tasks', {
      port,
      method: 'POST',
      body: { kind: 'prompt', prompt: 'attacker-controlled issue text', trust_level: 'untrusted' },
    });
    assert.equal(res.status, 201);
    const dbMod = require('../src/queue/db.js');
    const task = dbMod.getTask(db, res.data.id);
    assert.equal(task.approval_required, 1);

    // Not claimable until approved.
    const claimed = dbMod.claimNextTask(db, 'worker-1', {});
    assert.equal(claimed, null);
  } finally { await closeServer({ server, db }); }
});

test('POST /api/tasks does not let a client bypass the trust gate by supplying its own approved_by', async () => {
  const { server, db, port } = await makeTestServer();
  try {
    // Real approval only ever happens via POST /:id/approve; a client-supplied
    // approved_by in the creation body is never persisted and must not be
    // trusted to skip approval_required either.
    const res = await fetchJSON('/api/tasks', {
      port,
      method: 'POST',
      body: { kind: 'prompt', prompt: 'attacker-controlled issue text', trust_level: 'untrusted', approved_by: 'self-declared' },
    });
    assert.equal(res.status, 201);
    const dbMod = require('../src/queue/db.js');
    const task = dbMod.getTask(db, res.data.id);
    assert.equal(task.approval_required, 1, 'the client-supplied approved_by must not bypass the gate');
    assert.equal(task.approved_by, null, 'approved_by is never persisted at creation time');

    const claimed = dbMod.claimNextTask(db, 'worker-1', {});
    assert.equal(claimed, null);
  } finally { await closeServer({ server, db }); }
});

test('GET /api/tasks lists all tasks', async () => {
  const { server, db, port } = await makeTestServer();
  try {
    const t1 = require('../src/queue/db.js').createTask(db, { kind: 'prompt', prompt: 'A' });
    const t2 = require('../src/queue/db.js').createTask(db, { kind: 'prompt', prompt: 'B' });

    const res = await fetchJSON(`/api/tasks?limit=10&offset=0`, { port });
    assert.equal(res.status, 200);
    assert.ok(Array.isArray(res.data));
    assert.equal(res.data.length, 2);
    const ids = res.data.map(t => t.id);
    assert.ok(ids.includes(t1.id));
    assert.ok(ids.includes(t2.id));
  } finally { await closeServer({ server, db }); }
});

test('GET /api/tasks filters by status', async () => {
  const { server, db, port } = await makeTestServer();
  try {
    require('../src/queue/db.js').createTask(db, { kind: 'prompt', prompt: 'pending' });
    require('../src/queue/db.js').createTask(db, { kind: 'prompt', prompt: 'to-claim' });
    require('../src/queue/db.js').claimNextTask(db, 'worker-1', {});

    // The first-created task should now be running
    const res = await fetchJSON('/api/tasks?status=running&limit=10', { port });
    assert.equal(res.status, 200);
    assert.equal(res.data.length, 1);
    assert.equal(res.data[0].prompt, 'pending');
    assert.equal(res.data[0].status, 'running');
    assert.equal(res.data[0].claimed_by, 'worker-1');

    // The other should still be pending
    const pending = await fetchJSON('/api/tasks?status=pending&limit=10', { port });
    assert.equal(pending.status, 200);
    assert.equal(pending.data.length, 1);
    assert.equal(pending.data[0].prompt, 'to-claim');
  } finally { await closeServer({ server, db }); }
});

test('GET /api/tasks/:id returns a task', async () => {
  const { server, db, port } = await makeTestServer();
  try {
    const task = require('../src/queue/db.js').createTask(db, { kind: 'prompt', prompt: 'detail' });
    const res = await fetchJSON(`/api/tasks/${task.id}`, { port });
    assert.equal(res.status, 200);
    assert.equal(res.data.id, task.id);
    assert.equal(res.data.prompt, 'detail');
  } finally { await closeServer({ server, db }); }
});

test('GET /api/tasks/:id returns 404 for unknown task', async () => {
  const { server, db, port } = await makeTestServer();
  try {
    const res = await fetchJSON('/api/tasks/nonexistent-id', { port });
    assert.equal(res.status, 404);
  } finally { await closeServer({ server, db }); }
});

// --- Task claim and completion ---

test('GET /api/tasks/next claims a task and returns it', async () => {
  const { server, db, port } = await makeTestServer();
  try {
    require('../src/queue/db.js').createTask(db, { kind: 'prompt', prompt: 'claim me' });
    const res = await fetchJSON('/api/tasks/next?worker=worker-1&maxAttempts=3', { port });
    assert.equal(res.status, 200);
    assert.equal(res.data.status, 'running');
    assert.equal(res.data.claimed_by, 'worker-1');
  } finally { await closeServer({ server, db }); }
});

test('unsupported methods cannot claim tasks through /api/tasks/next', async () => {
  const { server, db, port } = await makeTestServer();
  try {
    const dbMod = require('../src/queue/db.js');
    const task = dbMod.createTask(db, { kind: 'prompt', prompt: 'GET claims only' });
    const res = await fetch('/api/tasks/next', { port, method: 'POST', body: {} });
    assert.equal(res.status, 404);
    assert.equal(dbMod.getTask(db, task.id).status, 'pending');
  } finally { await closeServer({ server, db }); }
});

test('GET /api/tasks/next returns 204 when no tasks available', async () => {
  const { server, db, port } = await makeTestServer();
  try {
    const res = await fetchJSON('/api/tasks/next?worker=worker-1', { port });
    assert.equal(res.status, 204);
    assert.equal(res.data, null);
  } finally { await closeServer({ server, db }); }
});

test('GET /api/tasks/next does not claim unapproved tasks', async () => {
  const { server, db, port } = await makeTestServer();
  try {
    require('../src/queue/db.js').createTask(db, {
      kind: 'prompt', prompt: 'pending approval',
      trust_level: 'untrusted', approval_required: 1,
    });
    const res = await fetchJSON('/api/tasks/next?worker=worker-1', { port });
    assert.equal(res.status, 204);
  } finally { await closeServer({ server, db }); }
});

test('POST /api/tasks/:id/result completes a task', async () => {
  const { server, db, port } = await makeTestServer();
  try {
    const task = require('../src/queue/db.js').createTask(db, { kind: 'prompt', prompt: 'complete me' });
    require('../src/queue/db.js').claimNextTask(db, 'worker-1', {});

    const res = await fetchJSON(`/api/tasks/${task.id}/result`, {
      port, method: 'POST', body: { status: 'succeeded', branch: 'main', worker: 'worker-1' },
    });
    assert.equal(res.status, 200);
    assert.equal(res.data.ok, true);

    // Verify task is now succeeded
    const check = require('../src/queue/db.js').getTask(db, task.id);
    assert.equal(check.status, 'succeeded');
    assert.ok(check.finished_at);
  } finally { await closeServer({ server, db }); }
});

test('POST /api/tasks/:id/result fails a task', async () => {
  const { server, db, port } = await makeTestServer();
  try {
    const task = require('../src/queue/db.js').createTask(db, { kind: 'prompt', prompt: 'fail me' });
    require('../src/queue/db.js').claimNextTask(db, 'worker-1', {});

    const res = await fetchJSON(`/api/tasks/${task.id}/result`, {
      port, method: 'POST', body: { status: 'failed', error: 'test error', retryable: false, worker: 'worker-1' },
    });
    assert.equal(res.status, 200);

    const check = require('../src/queue/db.js').getTask(db, task.id);
    assert.equal(check.status, 'failed');
    const result = JSON.parse(check.result);
    assert.ok(result.error);
  } finally { await closeServer({ server, db }); }
});

test('POST /api/tasks/:id/result with usage records cost data', async () => {
  const { server, db, port } = await makeTestServer();
  try {
    const task = require('../src/queue/db.js').createTask(db, { kind: 'prompt', prompt: 'usage task' });
    require('../src/queue/db.js').claimNextTask(db, 'worker-1', {});

    await fetchJSON(`/api/tasks/${task.id}/result`, {
      port, method: 'POST', body: {
        status: 'succeeded',
        usage: { provider: 'test', model: 'm', inputTokens: 100, outputTokens: 200, totalCost: 0.05 },
        worker: 'worker-1',
      },
    });

    const usage = require('../src/queue/db.js').getUsageByTask(db, task.id);
    assert.equal(usage.length, 1);
    assert.equal(usage[0].input_tokens, 100);
    assert.equal(usage[0].output_tokens, 200);
    assert.equal(usage[0].cost, 0.05);
  } finally { await closeServer({ server, db }); }
});

// --- Worker management ---

test('POST /api/workers registers a worker', async () => {
  const { server, db, port } = await makeTestServer();
  try {
    const res = await fetchJSON('/api/workers', {
      port, method: 'POST', body: { id: 'test-worker', name: 'test', capabilities: ['coding'] },
    });
    assert.equal(res.status, 200);
    assert.equal(res.data.id, 'test-worker');
    assert.equal(res.data.name, 'test');
  } finally { await closeServer({ server, db }); }
});

test('GET /api/workers lists registered workers', async () => {
  const { server, db, port } = await makeTestServer();
  try {
    const dbM = require('../src/queue/db.js');
    dbM.registerWorker(db, { id: 'w1', name: 'worker-1' });
    dbM.registerWorker(db, { id: 'w2', name: 'worker-2' });

    const res = await fetchJSON('/api/workers', { port });
    assert.equal(res.status, 200);
    assert.ok(Array.isArray(res.data));
    assert.equal(res.data.length, 2);
  } finally { await closeServer({ server, db }); }
});

test('POST /api/workers/:id/heartbeat updates last_seen', async () => {
  const { server, db, port } = await makeTestServer();
  try {
    const dbM = require('../src/queue/db.js');
    dbM.registerWorker(db, { id: 'hb-worker', name: 'heartbeat-test' });

    const res = await fetchJSON('/api/workers/hb-worker/heartbeat', { port, method: 'POST' });
    assert.equal(res.status, 200);
    assert.equal(res.data.ok, true);

    const worker = dbM.listWorkers(db).find(w => w.id === 'hb-worker');
    assert.ok(worker.last_seen);
  } finally { await closeServer({ server, db }); }
});

// --- Approval endpoints ---

test('GET /api/tasks/pending-approvals returns unapproved tasks', async () => {
  const { server, db, port } = await makeTestServer();
  try {
    const dbM = require('../src/queue/db.js');
    dbM.createTask(db, { kind: 'prompt', prompt: 'pending approval', approval_required: 1 });
    dbM.createTask(db, { kind: 'prompt', prompt: 'approved', approval_required: 1 });
    const approvedTask = dbM.getTask(db, dbM.listTasks(db).find(t => t.prompt === 'approved')?.id);
    dbM.approveTask(db, approvedTask.id, 'lead');

    const res = await fetchJSON('/api/tasks/pending-approvals?limit=10', { port });
    assert.equal(res.status, 200);
    assert.ok(Array.isArray(res.data));
    assert.equal(res.data.length, 1);
    assert.equal(res.data[0].prompt, 'pending approval');
  } finally { await closeServer({ server, db }); }
});

test('POST /api/tasks/:id/approve marks task as approved', async () => {
  const { server, db, port } = await makeTestServer();
  try {
    const task = require('../src/queue/db.js').createTask(db, {
      kind: 'prompt', prompt: 'approve me', approval_required: 1,
    });
    const res = await fetchJSON(`/api/tasks/${task.id}/approve`, {
      port, method: 'POST', body: { approved_by: 'reviewer' },
    });
    assert.equal(res.status, 200);
    assert.equal(res.data.approved_by, 'reviewer');
    assert.equal(res.data.approval_required, 0);
  } finally { await closeServer({ server, db }); }
});

test('POST /api/tasks/:id/reject marks task as rejected', async () => {
  const { server, db, port } = await makeTestServer();
  try {
    const task = require('../src/queue/db.js').createTask(db, {
      kind: 'prompt', prompt: 'reject me', approval_required: 1,
    });
    const res = await fetchJSON(`/api/tasks/${task.id}/reject`, {
      port, method: 'POST', body: { rejected_by: 'reviewer', reason: 'bad idea' },
    });
    assert.equal(res.status, 200);
    assert.equal(res.data.status, 'rejected');
    assert.equal(res.data.approved_by, 'reviewer');
  } finally { await closeServer({ server, db }); }
});

test('approved task becomes claimable via /api/tasks/next', async () => {
  const { server, db, port } = await makeTestServer();
  try {
    const task = require('../src/queue/db.js').createTask(db, {
      kind: 'prompt', prompt: 'approve then claim', approval_required: 1,
    });
    // Not claimable before approval
    let res = await fetchJSON('/api/tasks/next?worker=worker-1', { port });
    assert.equal(res.status, 204);

    // Approve it
    await fetchJSON(`/api/tasks/${task.id}/approve`, {
      port, method: 'POST', body: { approved_by: 'lead' },
    });

    // Now claimable
    res = await fetchJSON('/api/tasks/next?worker=worker-1', { port });
    assert.equal(res.status, 200);
    assert.equal(res.data.id, task.id);
    assert.equal(res.data.status, 'running');
  } finally { await closeServer({ server, db }); }
});

// --- Usage and rate limits ---

test('GET /api/usage returns aggregated usage stats', async () => {
  const { server, db, port } = await makeTestServer();
  try {
    const dbM = require('../src/queue/db.js');
    const task = dbM.createTask(db, { kind: 'prompt', prompt: 'usage test' });
    dbM.claimNextTask(db, 'worker-1', {});
    dbM.completeTask(db, task.id, { status: 'succeeded', usage: { provider: 'p', model: 'm', inputTokens: 500, outputTokens: 1000, totalCost: 0.1 } });

    const res = await fetchJSON('/api/usage?days=7', { port });
    assert.equal(res.status, 200);
    assert.ok(res.data.total_cost >= 0.1);
    assert.equal(res.data.total_input, 500);
    assert.equal(res.data.total_output, 1000);
  } finally { await closeServer({ server, db }); }
});

test('GET /api/rate-limits returns configured limits', async () => {
  const { server, db, port } = await makeTestServer();
  try {
    require('../src/queue/db.js').setRateLimit(db, { provider: 'test', metric: 'rpm', limit_val: 60 });
    require('../src/queue/db.js').setRateLimit(db, { provider: 'test', metric: 'concurrent', limit_val: 5 });

    const res = await fetchJSON('/api/rate-limits', { port });
    assert.equal(res.status, 200);
    assert.ok(Array.isArray(res.data));
    assert.ok(res.data.some(l => l.metric === 'rpm' && l.limit_val === 60));
    assert.ok(res.data.some(l => l.metric === 'concurrent' && l.limit_val === 5));
  } finally { await closeServer({ server, db }); }
});

test('GET /api/utilization returns utilization metrics', async () => {
  const { server, db, port } = await makeTestServer();
  try {
    require('../src/queue/db.js').setRateLimit(db, { provider: 'util-test', metric: 'concurrent', limit_val: 10 });
    require('../src/queue/db.js').leaseResource(db, {
      id: 'util-lease', provider: 'util-test', metric: 'concurrent', amount: 3,
      task_id: 't1', expires_at: new Date(Date.now() + 3600000).toISOString(),
    });

    const res = await fetchJSON('/api/utilization', { port });
    assert.equal(res.status, 200);
    assert.ok(Array.isArray(res.data));
    const util = res.data.find(u => u.provider === 'util-test' && u.metric === 'concurrent');
    assert.ok(util);
    assert.equal(util.used, 3);
    assert.equal(util.remaining, 7);
    assert.equal(util.utilization, 30);
  } finally { await closeServer({ server, db }); }
});

// --- Auth enforcement ---

test('AUTH_TOKEN, when set, gates both reads and the GET claim endpoint, not just POST', async () => {
  const { server, db, port } = await makeTestServer();
  const prevToken = process.env.AUTH_TOKEN;
  process.env.AUTH_TOKEN = 'secret';
  try {
    // Unauthenticated POST is rejected.
    let res = await fetchJSON('/api/tasks', {
      port, method: 'POST', body: { kind: 'prompt', prompt: 'x' },
    });
    assert.equal(res.status, 401);

    // Unauthenticated plain GET read is rejected (task list can contain
    // prompts/repo names; usage endpoints expose real spend).
    res = await fetchJSON('/api/tasks', { port });
    assert.equal(res.status, 401);

    // Unauthenticated GET /api/tasks/next is rejected — it's a GET, but it
    // mutates state (claims a task), so it must not bypass auth either.
    res = await fetchJSON('/api/tasks/next', { port });
    assert.equal(res.status, 401);

    // The static dashboard shell itself stays reachable without a token
    // (it embeds no live data and fetches /api/* client-side, which is gated).
    res = await fetch('/dashboard', { port });
    assert.equal(res.status, 200);
    // Its own client-side data fetches would otherwise 401 forever with no
    // way to supply a token — the dashboard must carry a mechanism to prompt
    // for and attach one once AUTH_TOKEN is set.
    assert.match(res.body, /authFetch/);
    assert.match(res.body, /Authorization.*Bearer/);

    // A correct bearer token is let through.
    res = await fetchJSON('/api/tasks', {
      port,
      headers: { Authorization: 'Bearer secret' },
      method: 'POST',
      body: { kind: 'prompt', prompt: 'x' },
    });
    assert.equal(res.status, 201);

    res = await fetchJSON('/api/tasks', { port, headers: { Authorization: 'Bearer secret' } });
    assert.equal(res.status, 200);
  } finally {
    if (prevToken === undefined) delete process.env.AUTH_TOKEN;
    else process.env.AUTH_TOKEN = prevToken;
    await closeServer({ server, db });
  }
});

// --- 404 ---

test('Unknown path returns 404', async () => {
  const { server, db, port } = await makeTestServer();
  try {
    const res = await fetchJSON('/api/nonexistent', { port });
    assert.equal(res.status, 404);
  } finally { await closeServer({ server, db }); }
});

// --- Malformed JSON ---

test('POST with malformed JSON returns 400', async () => {
  const { server, db, port } = await makeTestServer();
  try {
    const res = await new Promise((resolve, reject) => {
      const req = http.request({ host: '127.0.0.1', port, path: '/api/tasks', method: 'POST', headers: { 'content-type': 'application/json' } }, (r) => {
        let b = '';
        r.on('data', c => b += c);
        r.on('end', () => resolve({ status: r.statusCode, body: b }));
      });
      req.on('error', reject);
      req.write('not json at all');
      req.end();
    });
    assert.equal(res.status, 400);
    assert.match(res.body, /malformed/i);
  } finally { await closeServer({ server, db }); }
});

// --- Integration: full task lifecycle via HTTP ---

test('Full lifecycle: create → claim → complete via HTTP', async () => {
  const { server, db, port } = await makeTestServer();
  try {
    // 1. Create task
    let res = await fetchJSON('/api/tasks', {
      port, method: 'POST', body: { kind: 'prompt', prompt: 'lifecycle test', source: 'http-test' },
    });
    assert.equal(res.status, 201);
    const taskId = res.data.id;

    // 2. List tasks — should see it
    res = await fetchJSON('/api/tasks?limit=10', { port });
    assert.equal(res.status, 200);
    assert.ok(res.data.some(t => t.id === taskId));

    // 3. Claim task
    res = await fetchJSON(`/api/tasks/next?worker=lifecycle-worker`, { port });
    assert.equal(res.status, 200);
    assert.equal(res.data.id, taskId);
    assert.equal(res.data.status, 'running');

    // 4. Get task detail
    res = await fetchJSON(`/api/tasks/${taskId}`, { port });
    assert.equal(res.status, 200);
    assert.equal(res.data.status, 'running');

    // 5. Complete task
    res = await fetchJSON(`/api/tasks/${taskId}/result`, {
      port, method: 'POST', body: { status: 'succeeded', branch: 'main', worker: 'lifecycle-worker' },
    });
    assert.equal(res.status, 200);

    // 6. Verify final state
    res = await fetchJSON(`/api/tasks/${taskId}`, { port });
    assert.equal(res.status, 200);
    assert.equal(res.data.status, 'succeeded');
    assert.ok(res.data.finished_at);
  } finally { await closeServer({ server, db }); }
});

test('GET /api/export/jsonl returns all task events as NDJSON', async () => {
  const { server, db, port } = await makeTestServer();
  try {
    // Create and complete a task to generate events
    let res = await fetchJSON('/api/tasks', {
      port, method: 'POST', body: { kind: 'prompt', prompt: 'export test' },
    });
    assert.equal(res.status, 201);
    const taskId = res.data.id;

    res = await fetchJSON(`/api/tasks/next?worker=export-worker`, { port });
    assert.equal(res.status, 200);

    res = await fetchJSON(`/api/tasks/${taskId}/result`, {
      port, method: 'POST', body: { status: 'succeeded', worker: 'export-worker' },
    });
    assert.equal(res.status, 200);

    // Fetch JSONL export using raw fetch because response is NDJSON
    const raw = await fetch('/api/export/jsonl', { port });
    assert.equal(raw.status, 200);
    assert.ok(raw.headers['content-type'].includes('application/x-ndjson'));

    // Parse NDJSON lines
    const lines = raw.body.trim().split('\n').filter(Boolean);
    assert.ok(lines.length > 0, 'should have at least one event line');

    const events = lines.map(line => JSON.parse(line));
    const eventTypes = events.map(e => e.event);
    assert.ok(eventTypes.includes('created'), 'should contain created event');
    assert.ok(eventTypes.includes('claimed'), 'should contain claimed event');
    assert.ok(eventTypes.includes('completed'), 'should contain completed event');
  } finally { await closeServer({ server, db }); }
});

test('memoizeWithTtl collapses repeated calls within the TTL window into one underlying call', () => {
  let calls = 0;
  const memoized = memoizeWithTtl(() => { calls++; return { n: calls }; }, 1000);

  const a = memoized();
  const b = memoized();
  const c = memoized();
  assert.equal(calls, 1, 'repeated calls within the TTL must not re-invoke the underlying function');
  assert.deepEqual(a, { n: 1 });
  assert.strictEqual(b, a, 'must return the exact same cached value, not a fresh call');
  assert.strictEqual(c, a);
});

test('memoizeWithTtl re-invokes the underlying function once the TTL has elapsed', async () => {
  let calls = 0;
  const memoized = memoizeWithTtl(() => { calls++; return calls; }, 20);

  assert.equal(memoized(), 1);
  await new Promise(r => setTimeout(r, 40));
  assert.equal(memoized(), 2, 'expected a fresh call after the TTL elapsed');
});

// --- Dashboard: approve/reject/create controls ---

test('the dashboard embeds a syntactically valid script with approve/reject/create-task controls', () => {
  const match = DASHBOARD_HTML.match(/<script>([\s\S]*)<\/script>/);
  assert.ok(match, 'expected an embedded <script> tag');
  assert.doesNotThrow(() => new Function(match[1]), 'embedded script must be valid JS');

  for (const marker of ['approveTask', 'rejectTask', 'submitCreateTask', 'toggleCreateForm', 'postJson']) {
    assert.match(DASHBOARD_HTML, new RegExp(marker), `expected the dashboard script to define ${marker}`);
  }
  assert.match(DASHBOARD_HTML, /id="createForm"/);
  assert.match(DASHBOARD_HTML, /name="prompt"/);
});

test('dashboard safeHref allows HTTP(S) and neutralizes active URL schemes', () => {
  const match = DASHBOARD_HTML.match(/<script>([\s\S]*)<\/script>/);
  assert.ok(match);
  const start = match[1].indexOf('function esc(');
  const end = match[1].indexOf('// When AUTH_TOKEN', start);
  assert.ok(start >= 0 && end > start);
  const context = {
    URL,
    window: { location: { origin: 'https://dashboard.example' } },
  };
  vm.runInNewContext(`${match[1].slice(start, end)}\nthis.safeHref = safeHref;`, context);

  assert.equal(context.safeHref('javascript:alert(1)'), '#');
  assert.equal(context.safeHref('data:text/html,boom'), '#');
  assert.equal(context.safeHref('/tasks/1'), 'https://dashboard.example/tasks/1');
  assert.equal(context.safeHref('https://example.com/a?x=1&y=2'), 'https://example.com/a?x=1&amp;y=2');
});

test('API capture rejects missing server directories before contacting GitHub', async () => {
  let captures = 0;
  const state = await makeTestServer({ captureIssueInput: async (_repo, number) => { captures++; return snapshotForIssue(number); } });
  try {
    const result = await fetchJSON('/api/tasks', {
      port: state.port, method: 'POST', body: { kind: 'github_issue', repo: path.join(state.root, 'not-created'), issue_num: 7 },
    });
    assert.equal(result.status, 400);
    assert.equal(captures, 0);
    assert.equal(state.db.prepare('SELECT count(*) AS count FROM tasks').get().count, 0);
  } finally { await closeServer(state); }
});

test('API capture caps concurrent fetches without queuing incomplete tasks', { timeout: 15_000 }, async () => {
  const releases = [];
  const state = await makeTestServer({ captureIssueInput: (_repo, number) => new Promise(resolve => {
    releases.push(() => resolve(snapshotForIssue(number)));
  }) });
  const pending = Array.from({ length: 4 }, (_, index) => fetchJSON('/api/tasks', {
    port: state.port, method: 'POST', body: { kind: 'github_issue', repo: state.root, issue_num: index + 1 },
  }));
  try {
    const deadline = Date.now() + 5000;
    while (releases.length < 4) {
      if (Date.now() > deadline) throw new Error('capture fixtures did not become ready');
      await delay(5);
    }
    const refused = await fetchJSON('/api/tasks', {
      port: state.port, method: 'POST', body: { kind: 'github_issue', repo: state.root, issue_num: 5 },
    });
    assert.equal(refused.status, 503);
    assert.equal(releases.length, 4);
    assert.equal(state.db.prepare('SELECT count(*) AS count FROM tasks').get().count, 0);
    releases.forEach(release => release());
    const accepted = await Promise.all(pending);
    assert.ok(accepted.every(result => result.status === 201));
    assert.equal(state.db.prepare('SELECT count(*) AS count FROM tasks').get().count, 4);
  } finally {
    releases.forEach(release => release());
    await Promise.allSettled(pending);
    await closeServer(state);
  }
});

test('authentication gates GitHub capture before any server-side fetch', async () => {
  let captures = 0;
  const state = await makeTestServer({ captureIssueInput: async (_repo, number) => { captures++; return snapshotForIssue(number); } });
  const previous = process.env.AUTH_TOKEN;
  process.env.AUTH_TOKEN = 'snapshot-test-token';
  try {
    const body = { kind: 'github_issue', repo: state.root, issue_num: 7 };
    const refused = await fetchJSON('/api/tasks', { port: state.port, method: 'POST', body });
    assert.equal(refused.status, 401);
    assert.equal(captures, 0);
    const accepted = await fetchJSON('/api/tasks', {
      port: state.port, method: 'POST', body, headers: { Authorization: 'Bearer snapshot-test-token' },
    });
    assert.equal(accepted.status, 201);
    assert.equal(captures, 1);
  } finally {
    if (previous === undefined) delete process.env.AUTH_TOKEN;
    else process.env.AUTH_TOKEN = previous;
    await closeServer(state);
  }
});

test('API issue capture failure leaves no task or approval to act on', async () => {
  const state = await makeTestServer({ captureIssueInput: async () => { throw new Error('GitHub capture unavailable'); } });
  try {
    const result = await fetchJSON('/api/tasks', {
      port: state.port, method: 'POST', body: { kind: 'github_issue', repo: state.root, issue_num: 7 },
    });
    assert.equal(result.status, 400);
    assert.equal(state.db.prepare('SELECT count(*) AS count FROM tasks').get().count, 0);
  } finally { await closeServer(state); }
});

test('API never refetches over corrupted pinned content', async () => {
  let captures = 0;
  const state = await makeTestServer({ captureIssueInput: async (_repo, number) => { captures++; return snapshotForIssue(number); } });
  try {
    const input = snapshotForIssue(7);
    input.issue.body = 'tampered';
    const result = await fetchJSON('/api/tasks', {
      port: state.port, method: 'POST', body: { kind: 'github_issue', repo: state.root, issue_num: 7, prompt: JSON.stringify(input) },
    });
    assert.equal(result.status, 400);
    assert.equal(captures, 0);
    assert.equal(state.db.prepare('SELECT count(*) AS count FROM tasks').get().count, 0);
  } finally { await closeServer(state); }
});

for (const fields of [
  { issue_num: '7', prompt: '' },
  { issue_num: '7', prompt: 'do not silently discard this' },
  { issue_num: '', prompt: 'a standalone prompt' },
]) {
  test(`dashboard keeps issue and prompt requests distinct (${JSON.stringify(fields)})`, async () => {
    const start = DASHBOARD_HTML.indexOf('async function submitCreateTask(');
    const end = DASHBOARD_HTML.indexOf('\nasync function fetchData(', start);
    const requests = [];
    const alerts = [];
    let reset = false;
    const submit = vm.runInNewContext(`(${DASHBOARD_HTML.slice(start, end)})`, {
      FormData: class { get(name) { return fields[name] || ''; } },
      alert: message => alerts.push(message),
      postJson: async (_url, body) => requests.push(body),
      toggleCreateForm() {}, fetchData() {},
    });
    await submit({ preventDefault() {}, target: { reset() { reset = true; } } });
    if (fields.issue_num && fields.prompt) {
      assert.equal(requests.length, 0);
      assert.equal(reset, false);
      assert.match(alerts[0], /leave Prompt blank/);
    } else {
      assert.equal(requests.length, 1);
      assert.equal(requests[0].kind, fields.issue_num ? 'github_issue' : 'prompt');
      assert.equal(requests[0].prompt, fields.issue_num ? undefined : fields.prompt);
      assert.equal(reset, true);
    }
  });
}

test('the exact request shape submitCreateTask sends is accepted by POST /api/tasks', async () => {
  const { server, db, port, root } = await makeTestServer();
  try {
    const dbMod = require('../src/queue/db.js');

    // Mirrors submitCreateTask's body for a prompt-only task (no issue_num):
    // kind derives to 'prompt'. trust_level 'agent' (the form's default
    // option) does NOT force approval_required — only 'untrusted' does
    // (server.js's create-time gate); 'agent' still can't execute bare in
    // agentq (only 'trusted_agent' can) but is immediately claimable here.
    const res = await fetchJSON('/api/tasks', {
      port,
      method: 'POST',
      body: { kind: 'prompt', repo: undefined, issue_num: undefined, base_branch: undefined, model: undefined, trust_level: 'agent', prompt: 'do the thing' },
    });
    assert.equal(res.status, 201);
    const task = dbMod.getTask(db, res.data.id);
    assert.equal(task.prompt, 'do the thing');
    assert.equal(task.kind, 'prompt');
    assert.equal(task.approval_required, 0);

    // The github-issue-shaped submission (issue_num present -> kind: 'github_issue').
    const res2 = await fetchJSON('/api/tasks', {
      port,
      method: 'POST',
      body: { kind: 'github_issue', repo: root, issue_num: 7, base_branch: 'main', model: 'auto', trust_level: 'trusted_agent' },
    });
    assert.equal(res2.status, 201);
    const task2 = dbMod.getTask(db, res2.data.id);
    assert.equal(task2.issue_num, 7);
    assert.equal(task2.trust_level, 'trusted_agent');
    assert.equal(JSON.parse(task2.prompt).issue.body, 'fixture body');
    assert.match(JSON.parse(task2.prompt).sha256, /^[a-f0-9]{64}$/);

    // The form's 'untrusted' option does force approval_required — unlike
    // task/task2 above, which are immediately claimable (see the dedicated
    // "forces approval for an untrusted task" test for the claim-blocking
    // behavior in isolation).
    const res3 = await fetchJSON('/api/tasks', {
      port,
      method: 'POST',
      body: { kind: 'prompt', trust_level: 'untrusted', prompt: 'from an untrusted source' },
    });
    assert.equal(res3.status, 201);
    const task3 = dbMod.getTask(db, res3.data.id);
    assert.equal(task3.approval_required, 1);
  } finally { await closeServer({ server, db }); }
});

test('the dashboard\'s approve/reject buttons hit the same endpoints end-to-end', async () => {
  const { server, db, port } = await makeTestServer();
  try {
    const dbMod = require('../src/queue/db.js');
    const t1 = dbMod.createTask(db, { kind: 'prompt', prompt: 'needs review 1', trust_level: 'agent', approval_required: 1 });
    const t2 = dbMod.createTask(db, { kind: 'prompt', prompt: 'needs review 2', trust_level: 'agent', approval_required: 1 });

    // approveTask(id) -> POST /api/tasks/:id/approve { approved_by }
    let res = await fetchJSON(`/api/tasks/${t1.id}/approve`, { port, method: 'POST', body: { approved_by: 'alice' } });
    assert.equal(res.status, 200);
    assert.equal(dbMod.getTask(db, t1.id).approved_by, 'alice');
    assert.equal(dbMod.getTask(db, t1.id).approval_required, 0);

    // rejectTask(id) -> POST /api/tasks/:id/reject { rejected_by, reason }
    res = await fetchJSON(`/api/tasks/${t2.id}/reject`, { port, method: 'POST', body: { rejected_by: 'bob', reason: 'not needed' } });
    assert.equal(res.status, 200);
    assert.equal(dbMod.getTask(db, t2.id).status, 'rejected');
  } finally { await closeServer({ server, db }); }
});

// --- Task detail and SSE ---

test('GET /api/tasks/:id returns task detail with events', async () => {
  const { server, db, port } = await makeTestServer();
  try {
    const dbMod = require('../src/queue/db.js');
    const task = dbMod.createTask(db, { kind: 'prompt', prompt: 'detail test' });
    const res = await fetchJSON(`/api/tasks/${task.id}`, { port });
    assert.equal(res.status, 200);
    assert.equal(res.data.id, task.id);
    assert.ok(Array.isArray(res.data.events));
    assert.ok(res.data.events.length > 0);
    assert.equal(res.data.events[0].event, 'created');
  } finally { await closeServer({ server, db }); }
});

test('GET /api/events returns SSE headers', async () => {
  const { server, db, port } = await makeTestServer();
  try {
    const res = await new Promise((resolve, reject) => {
      const req = http.request({ host: '127.0.0.1', port, path: '/api/events', method: 'GET' }, (r) => {
        // Read first chunk then abort
        r.once('data', () => { r.destroy(); resolve({ status: r.statusCode, headers: r.headers }); });
      });
      req.on('error', reject);
      req.end();
    });
    assert.equal(res.status, 200);
    assert.equal(res.headers['content-type'], 'text/event-stream');
    assert.equal(res.headers['cache-control'], 'no-cache');
  } finally { await closeServer({ server, db }); }
});

test('GET /api/events enforces the concurrent client cap', async () => {
  const { server, db, port } = await makeTestServer();
  const responses = [];
  try {
    await Promise.all(Array.from({ length: 100 }, () => new Promise((resolve, reject) => {
      const req = http.request({ host: '127.0.0.1', port, path: '/api/events', method: 'GET' }, response => {
        response.once('data', () => {
          responses.push(response);
          resolve();
        });
        response.once('error', reject);
      });
      req.once('error', reject);
      req.end();
    })));

    const denied = await fetchJSON('/api/events', { port });
    assert.equal(denied.status, 503);
    assert.match(denied.data.error, /Too many event-stream clients/);
  } finally {
    closeSseClients();
    for (const response of responses) response.destroy();
    await closeServer({ server, db });
  }
});

test('graceful shutdown closes active SSE clients', async () => {
  const { server, db, port } = await makeTestServer();
  try {
    await new Promise((resolve, reject) => {
      const req = http.request({ host: '127.0.0.1', port, path: '/api/events', method: 'GET' }, response => {
        response.once('data', () => closeSseClients());
        response.once('end', resolve);
        response.once('error', reject);
      });
      req.once('error', reject);
      req.end();
    });
  } finally { await closeServer({ server, db }); }
});

test('GET /api/workers/stale returns workers older than maxAge', async () => {
  const { server, db, port } = await makeTestServer();
  try {
    const dbMod = require('../src/queue/db.js');
    // Register a worker with an old last_seen
    dbMod.registerWorker(db, { id: 'old-worker', name: 'old' });
    db.prepare('UPDATE workers SET last_seen = ? WHERE id = ?').run(
      new Date(Date.now() - 300 * 1000).toISOString(), 'old-worker'
    );
    const res = await fetchJSON('/api/workers/stale?maxAge=120', { port });
    assert.equal(res.status, 200);
    assert.ok(Array.isArray(res.data));
    assert.ok(res.data.some(w => w.id === 'old-worker'));
  } finally { await closeServer({ server, db }); }
});

test('POST /api/tasks/prune removes old completed tasks', async () => {
  const { server, db, port } = await makeTestServer();
  try {
    const dbMod = require('../src/queue/db.js');
    // Create a completed task with an old finished_at
    const t = dbMod.createTask(db, { kind: 'prompt', prompt: 'old task' });
    dbMod.claimNextTask(db, 'worker-1');
    dbMod.completeTask(db, t.id, { status: 'succeeded' }, { claimedBy: 'worker-1' });
    // Set finished_at to 31 days ago
    db.prepare('UPDATE tasks SET finished_at = ? WHERE id = ?').run(
      new Date(Date.now() - 31 * 24 * 60 * 60 * 1000).toISOString(), t.id
    );
    const res = await fetchJSON('/api/tasks/prune?maxAgeDays=30', { port, method: 'POST' });
    assert.equal(res.status, 200);
    assert.equal(res.data.pruned, 1);
    assert.ok(res.data.ids.includes(t.id));
  } finally { await closeServer({ server, db }); }
});

test('DELETE /api/tasks/:id removes a completed task', async () => {
  const { server, db, port } = await makeTestServer();
  try {
    const dbMod = require('../src/queue/db.js');
    const t = dbMod.createTask(db, { kind: 'prompt', prompt: 'to delete' });
    dbMod.claimNextTask(db, 'worker-1');
    dbMod.completeTask(db, t.id, { status: 'succeeded' }, { claimedBy: 'worker-1' });
    const res = await fetchJSON(`/api/tasks/${t.id}`, { port, method: 'DELETE' });
    assert.equal(res.status, 200);
    assert.equal(res.data.pruned, 1);
    // Verify task is gone
    const check = await fetchJSON(`/api/tasks/${t.id}`, { port });
    assert.equal(check.status, 404);
  } finally { await closeServer({ server, db }); }
});

test('DELETE /api/tasks/:id rejects running tasks', async () => {
  const { server, db, port } = await makeTestServer();
  try {
    const dbMod = require('../src/queue/db.js');
    const t = dbMod.createTask(db, { kind: 'prompt', prompt: 'running task' });
    dbMod.claimNextTask(db, 'worker-1');
    const res = await fetchJSON(`/api/tasks/${t.id}`, { port, method: 'DELETE' });
    assert.equal(res.status, 400);
    assert.match(res.body, /running/);
  } finally { await closeServer({ server, db }); }
});

test('PATCH /api/tasks/:id updates priority', async () => {
  const { server, db, port } = await makeTestServer();
  try {
    const dbMod = require('../src/queue/db.js');
    const t = dbMod.createTask(db, { kind: 'prompt', prompt: 'priority test' });
    const res = await fetchJSON(`/api/tasks/${t.id}`, { port, method: 'PATCH', body: { priority: 10 } });
    assert.equal(res.status, 200);
    assert.equal(res.data.priority, 10);
  } finally { await closeServer({ server, db }); }
});

test('POST /api/tasks/bulk/approve approves multiple tasks', async () => {
  const { server, db, port } = await makeTestServer();
  try {
    const dbMod = require('../src/queue/db.js');
    const t1 = dbMod.createTask(db, { kind: 'prompt', prompt: 'bulk 1', approval_required: 1 });
    const t2 = dbMod.createTask(db, { kind: 'prompt', prompt: 'bulk 2', approval_required: 1 });
    const res = await fetchJSON('/api/tasks/bulk/approve', {
      port, method: 'POST', body: { ids: [t1.id, t2.id], approved_by: 'admin' }
    });
    assert.equal(res.status, 200);
    assert.equal(res.data.length, 2);
    assert.ok(res.data.every(r => r.status === 'approved'));
  } finally { await closeServer({ server, db }); }
});

test('POST /api/tasks/bulk/delete deletes completed tasks', async () => {
  const { server, db, port } = await makeTestServer();
  try {
    const dbMod = require('../src/queue/db.js');
    const t1 = dbMod.createTask(db, { kind: 'prompt', prompt: 'to delete 1' });
    const t2 = dbMod.createTask(db, { kind: 'prompt', prompt: 'to delete 2' });
    dbMod.claimNextTask(db, 'worker-1');
    dbMod.completeTask(db, t1.id, { status: 'succeeded' }, { claimedBy: 'worker-1' });
    dbMod.claimNextTask(db, 'worker-1');
    dbMod.completeTask(db, t2.id, { status: 'succeeded' }, { claimedBy: 'worker-1' });
    const res = await fetchJSON('/api/tasks/bulk/delete', {
      port, method: 'POST', body: { ids: [t1.id, t2.id] }
    });
    assert.equal(res.status, 200);
    assert.equal(res.data.length, 2);
    assert.ok(res.data.every(r => r.status === 'deleted'));
  } finally { await closeServer({ server, db }); }
});

test('GET /api/tasks/export returns JSONL by default', async () => {
  const { server, db, port } = await makeTestServer();
  try {
    const dbMod = require('../src/queue/db.js');
    dbMod.createTask(db, { kind: 'prompt', prompt: 'export test' });
    const res = await fetch('/api/tasks/export', { port });
    assert.equal(res.status, 200);
    assert.ok(res.headers['content-type'].includes('ndjson'));
    assert.ok(res.body.includes('export test'));
  } finally { await closeServer({ server, db }); }
});

test('GET /api/tasks/export?format=csv returns CSV', async () => {
  const { server, db, port } = await makeTestServer();
  try {
    const dbMod = require('../src/queue/db.js');
    dbMod.createTask(db, { kind: 'prompt', prompt: 'csv test' });
    const res = await fetch('/api/tasks/export?format=csv', { port });
    assert.equal(res.status, 200);
    assert.ok(res.headers['content-type'].includes('csv'));
    assert.ok(res.body.includes('id,kind,status'));
    assert.ok(res.body.includes('csv test'));
  } finally { await closeServer({ server, db }); }
});

test('POST /api/tasks/bulk/reject rejects multiple tasks', async () => {
  const { server, db, port } = await makeTestServer();
  try {
    const dbMod = require('../src/queue/db.js');
    const t1 = dbMod.createTask(db, { kind: 'prompt', prompt: 'bulk reject 1', approval_required: 1 });
    const t2 = dbMod.createTask(db, { kind: 'prompt', prompt: 'bulk reject 2', approval_required: 1 });
    const res = await fetchJSON('/api/tasks/bulk/reject', {
      port, method: 'POST', body: { ids: [t1.id, t2.id], rejected_by: 'admin', reason: 'not needed' }
    });
    assert.equal(res.status, 200);
    assert.equal(res.data.length, 2);
    assert.ok(res.data.every(r => r.status === 'rejected'));
  } finally { await closeServer({ server, db }); }
});

test('PATCH /api/tasks/:id rejects updating running tasks', async () => {
  const { server, db, port } = await makeTestServer();
  try {
    const dbMod = require('../src/queue/db.js');
    const t = dbMod.createTask(db, { kind: 'prompt', prompt: 'running priority' });
    dbMod.claimNextTask(db, 'worker-1');
    const res = await fetchJSON(`/api/tasks/${t.id}`, { port, method: 'PATCH', body: { priority: 5 } });
    assert.equal(res.status, 400);
    assert.match(res.body, /running/);
  } finally { await closeServer({ server, db }); }
});

// --- Jules sessions ---

test('GET /api/jules-sessions returns sessions', async () => {
  const { server, db, port } = await makeTestServer();
  try {
    const dbMod = require('../src/queue/db.js');
    const task = dbMod.createTask(db, { kind: 'jules', prompt: 'jules test' });
    dbMod.storeJulesSession(db, { taskId: task.id, sessionName: 'sessions/jules-1', state: 'PLANNING' });
    dbMod.storeJulesSession(db, { taskId: task.id, sessionName: 'sessions/jules-2', state: 'COMPLETED' });
    const res = await fetchJSON('/api/jules-sessions', { port });
    assert.equal(res.status, 200);
    assert.ok(Array.isArray(res.data));
    assert.ok(res.data.length >= 2);
  } finally { await closeServer({ server, db }); }
});

test('GET /api/jules-sessions?state=PLANNING filters by state', async () => {
  const { server, db, port } = await makeTestServer();
  try {
    const dbMod = require('../src/queue/db.js');
    const task = dbMod.createTask(db, { kind: 'jules', prompt: 'jules filter' });
    dbMod.storeJulesSession(db, { taskId: task.id, sessionName: 'sessions/s1', state: 'PLANNING' });
    dbMod.storeJulesSession(db, { taskId: task.id, sessionName: 'sessions/s2', state: 'COMPLETED' });
    const res = await fetchJSON('/api/jules-sessions?state=PLANNING', { port });
    assert.equal(res.status, 200);
    assert.ok(res.data.every(s => s.state === 'PLANNING'));
  } finally { await closeServer({ server, db }); }
});

test('GET /api/jules-sessions/inflight returns non-terminal sessions', async () => {
  const { server, db, port } = await makeTestServer();
  try {
    const dbMod = require('../src/queue/db.js');
    const task = dbMod.createTask(db, { kind: 'jules', prompt: 'jules inflight' });
    dbMod.storeJulesSession(db, { taskId: task.id, sessionName: 'sessions/i1', state: 'CODING' });
    dbMod.storeJulesSession(db, { taskId: task.id, sessionName: 'sessions/i2', state: 'COMPLETED' });
    const res = await fetchJSON('/api/jules-sessions/inflight', { port });
    assert.equal(res.status, 200);
    assert.ok(Array.isArray(res.data));
    assert.ok(res.data.every(s => s.state !== 'COMPLETED' && s.state !== 'FAILED' && s.state !== 'SUCCEEDED' && s.state !== 'CANCELLED'));
  } finally { await closeServer({ server, db }); }
});

// --- Reserved task sources (round 2) ---

for (const source of ['cli', 'mcp', 'agentq']) {
  test(`POST /api/tasks rejects the reserved source '${source}'`, async () => {
    const { server, db, port } = await makeTestServer();
    try {
      const res = await fetchJSON('/api/tasks', {
        port,
        method: 'POST',
        body: { kind: 'prompt', prompt: 'mint a local task', source, approval_required: 1 },
      });
      assert.equal(res.status, 400);
      assert.match(res.data.error, /reserved/);
      assert.equal(require('../src/queue/db.js').listTasks(db).length, 0);
    } finally { await closeServer({ server, db }); }
  });
}

test('a reserved source is rejected before any issue capture runs', async () => {
  let captures = 0;
  const { server, db, port, root } = await makeTestServer({
    captureIssueInput: async (_repo, number) => { captures++; return snapshotForIssue(number); },
  });
  try {
    const res = await fetchJSON('/api/tasks', {
      port,
      method: 'POST',
      body: { kind: 'github_issue', repo: root, issue_num: 7, source: 'cli' },
    });
    assert.equal(res.status, 400);
    assert.equal(captures, 0, 'a rejected request must not trigger a capture');
  } finally { await closeServer({ server, db }); }
});

test('an HTTP-created unapproved task is not claimable by a local worker', async () => {
  const { server, db, port, root } = await makeTestServer();
  try {
    const res = await fetchJSON('/api/tasks', {
      port,
      method: 'POST',
      body: { kind: 'prompt', prompt: 'needs approval', source: 'dashboard', approval_required: 1 },
    });
    assert.equal(res.status, 201);

    const dbModule = require('../src/queue/db.js');
    const { SqliteSource } = require('../src/queue/sources.js');
    // The local worker opens the SAME database file the server uses.
    const local = new SqliteSource(path.join(root, 'test.sqlite'));
    try {
      assert.equal(await local.claimNext(), null, 'approval still gates a non-reserved source');
      assert.equal(dbModule.getTask(db, res.data.id).status, 'pending');
      dbModule.approveTask(db, res.data.id, 'reviewer');
      const claimed = await local.claimNext({ allowUntrusted: true });
      assert.equal(claimed.id, res.data.id);
    } finally {
      await local.stop();
    }
  } finally { await closeServer({ server, db }); }
});

// --- Path health: the server records the outcome of every remote attempt ---

test('a remote timeout and a remote error are recorded against the claimed path', async () => {
  const { server, db, port } = await makeTestServer();
  try {
    const dbModule = require('../src/queue/db.js');
    const timedOut = dbModule.createTask(db, { kind: 'prompt', prompt: 'slow', provider: 'mistral' });
    // Claim by id: a failed completion with retries left re-pends its task, so
    // "claim the next one" could otherwise hand back the previous task.
    assert.ok(dbModule.claimTaskById(db, timedOut.id, 'worker-1', {}));
    const timeoutRes = await fetchJSON(`/api/tasks/${timedOut.id}/result`, {
      port, method: 'POST', body: { status: 'failed', exit: 124, worker: 'worker-1' },
    });
    assert.equal(timeoutRes.status, 200);

    const errored = dbModule.createTask(db, { kind: 'prompt', prompt: 'broken', provider: 'codex' });
    assert.ok(dbModule.claimTaskById(db, errored.id, 'worker-1', {}));
    const errorRes = await fetchJSON(`/api/tasks/${errored.id}/result`, {
      port, method: 'POST', body: { status: 'failed', exit: 7, retryable: false, worker: 'worker-1' },
    });
    assert.equal(errorRes.status, 200);

    const rows = dbModule.getPathOutcomes(db);
    assert.deepEqual(rows.map((row) => [row.path, row.outcome]), [['mistral', 'timeout'], ['codex', 'error']]);
  } finally { await closeServer({ server, db }); }
});

test('a remote success records ok and a failed verification records verify_failed', async () => {
  const { server, db, port } = await makeTestServer();
  try {
    const dbModule = require('../src/queue/db.js');
    const ok = dbModule.createTask(db, { kind: 'prompt', prompt: 'fine', provider: 'codex' });
    assert.ok(dbModule.claimTaskById(db, ok.id, 'worker-1', {}));
    const okRes = await fetchJSON(`/api/tasks/${ok.id}/result`, {
      port, method: 'POST', body: { status: 'succeeded', exit: 0, verified: 1, worker: 'worker-1' },
    });
    assert.equal(okRes.status, 200);

    const unverified = dbModule.createTask(db, { kind: 'prompt', prompt: 'untested', provider: 'mistral' });
    assert.ok(dbModule.claimTaskById(db, unverified.id, 'worker-1', {}));
    const verifyRes = await fetchJSON(`/api/tasks/${unverified.id}/result`, {
      port, method: 'POST', body: { status: 'unverified', exit: 0, verified: 0, worker: 'worker-1' },
    });
    assert.equal(verifyRes.status, 200);

    const rows = dbModule.getPathOutcomes(db);
    assert.deepEqual(rows.map((row) => [row.path, row.outcome]), [['codex', 'ok'], ['mistral', 'verify_failed']]);
  } finally { await closeServer({ server, db }); }
});

test('a task with no attributed path records nothing', async () => {
  const { server, db, port } = await makeTestServer();
  try {
    const dbModule = require('../src/queue/db.js');
    const task = dbModule.createTask(db, { kind: 'prompt', prompt: 'unattributed' });
    assert.ok(dbModule.claimTaskById(db, task.id, 'worker-1', {}));
    const res = await fetchJSON(`/api/tasks/${task.id}/result`, {
      port, method: 'POST', body: { status: 'succeeded', exit: 0, worker: 'worker-1' },
    });
    assert.equal(res.status, 200);
    assert.deepEqual(dbModule.getPathOutcomes(db), []);
  } finally { await closeServer({ server, db }); }
});

test('a rejected completion records no outcome', async () => {
  const { server, db, port } = await makeTestServer();
  try {
    const dbModule = require('../src/queue/db.js');
    const task = dbModule.createTask(db, { kind: 'prompt', prompt: 'never claimed', provider: 'codex' });
    // Not claimed by this worker: completeTask rejects the report.
    const res = await fetchJSON(`/api/tasks/${task.id}/result`, {
      port, method: 'POST', body: { status: 'succeeded', exit: 0, worker: 'someone-else' },
    });
    assert.equal(res.status, 400);
    assert.deepEqual(dbModule.getPathOutcomes(db), []);
  } finally { await closeServer({ server, db }); }
});

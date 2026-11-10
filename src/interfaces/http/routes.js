'use strict';

/**
 * Orchestrator HTTP routing layer — request parsing, auth, SSE, and every
 * REST endpoint. Pure handler wiring over the database module; the boot and
 * lifecycle code lives in server.js.
 */

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const net = require('node:net');
const { EventEmitter } = require('node:events');
const dbModule = require('../../queue/db.js');
const { classifyOutcome } = require('../../core/path-health.js');
const DASHBOARD_HTML = require('./dashboard-html.js');
const { fetchTaskInputAsync } = require('../../core/task-input.js');

// Global event bus for pushing state changes to connected SSE clients.
const taskBus = new EventEmitter();
taskBus.setMaxListeners(50);

// Connected SSE clients for task events.
const sseClients = new Set();
const MAX_SSE_CLIENTS = 100;
const MAX_ISSUE_CAPTURES = 4;
let activeIssueCaptures = 0;

function broadcastSse(event, data) {
  const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const res of sseClients) {
    try { res.write(payload); } catch { sseClients.delete(res); }
  }
}

function closeSseClients() {
  for (const res of sseClients) {
    try { res.end(); } catch {}
  }
  sseClients.clear();
}

// Cache fn()'s result for ttlMs — useful for wrapping a synchronous file
// read that a hot loop (e.g. one per candidate in a single claim request)
// might otherwise call redundantly for data that can't change that fast.
function memoizeWithTtl(fn, ttlMs) {
  let cache = { value: undefined, loadedAt: -Infinity };
  return () => {
    if (Date.now() - cache.loadedAt < ttlMs) return cache.value;
    cache = { value: fn(), loadedAt: Date.now() };
    return cache.value;
  };
}

// Constant-time string compare — avoids leaking the token via response timing.
// Bails false on a length mismatch (timingSafeEqual requires equal-length
// buffers); the token's length is not the secret worth protecting here.
function safeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) return false;
  return crypto.timingSafeEqual(ab, bb);
}

// True when an Authorization header carries the expected bearer token.
function bearerTokenMatches(authHeader, token) {
  if (typeof authHeader !== 'string') return false;
  const prefix = 'Bearer ';
  if (!authHeader.startsWith(prefix)) return false;
  return safeEqual(authHeader.slice(prefix.length), token);
}

// --- HTTP helpers ---

function sendJson(res, data, status = 200) {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(data));
}

function sendHtml(res, html) {
  res.writeHead(200, { 'Content-Type': 'text/html' });
  res.end(html);
}

function sendError(res, msg, status = 400) {
  sendJson(res, { error: msg }, status);
}

function boundedQueryInt(params, name, fallback, max, min = 0) {
  const raw = params.get(name);
  if (raw == null || raw === '') return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value) || !Number.isInteger(value)) return fallback;
  return Math.min(max, Math.max(min, value));
}

const MAX_JSON_BODY_BYTES = 1_000_000;

function jsonBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    let bytes = 0;
    let settled = false;
    const fail = (err) => {
      if (settled) return;
      settled = true;
      reject(err);
    };
    req.on('data', chunk => {
      if (settled) return;
      bytes += Buffer.byteLength(chunk);
      if (bytes > MAX_JSON_BODY_BYTES) {
        const err = new Error(`JSON body exceeds ${MAX_JSON_BODY_BYTES} bytes`);
        err.statusCode = 413;
        fail(err);
        req.removeAllListeners('data');
        req.resume();
        return;
      }
      body += chunk;
    });
    req.on('end', () => {
      if (settled) return;
      try {
        const parsed = body ? JSON.parse(body) : {};
        settled = true;
        resolve(parsed);
      } catch {
        fail(new Error('Malformed JSON body'));
      }
    });
    req.on('error', fail);
  });
}

async function jsonObjectBody(req) {
  const body = await jsonBody(req);
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    const err = new Error('JSON body must be an object');
    err.statusCode = 400;
    throw err;
  }
  return body;
}

function allowedCorsOrigins() {
  return new Set(String(process.env.AGENTQ_CORS_ALLOWED_ORIGINS || '')
    .split(',')
    .map(value => value.trim())
    .filter(Boolean));
}

function corsOriginAllowed(origin, host) {
  if (!origin) return true;
  if (allowedCorsOrigins().has(origin)) return true;
  try {
    const url = new URL(origin);
    const hostname = url.hostname.replace(/^\[|\]$/g, '');
    const isLoopback = hostname === 'localhost' || hostname === '::1' ||
      (net.isIP(hostname) === 4 && hostname.startsWith('127.'));
    return isLoopback && url.host === host && (url.protocol === 'http:' || url.protocol === 'https:');
  } catch {
    return false;
  }
}

async function handleRequest(req, res, db, resolveAutoModel = null, options = {}) {
  try {
    const url = new URL(req.url, `http://localhost`);
    const pathname = url.pathname;
    const params = url.searchParams;
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('X-Frame-Options', 'DENY');

    // Requests without Origin (CLI and ordinary navigation) need no CORS
    // headers. Browser origins are accepted only for an exact configured
    // origin or an exact loopback Origin/Host pair; arbitrary Host reflection
    // would remain vulnerable to Host spoofing and DNS rebinding.
    const origin = req.headers.origin;
    const originAllowed = corsOriginAllowed(origin, req.headers.host || '');
    if (origin) res.setHeader('Vary', 'Origin');
    if (origin && originAllowed) {
      res.setHeader('Access-Control-Allow-Origin', origin);
      res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PATCH, DELETE, OPTIONS');
      res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
    }
    // CORS response headers alone do not prevent CSRF: a denied cross-origin
    // GET can still reach a mutating endpoint such as /api/tasks/next. Refuse
    // the request before routing so an unreadable response has no side effect.
    if (!originAllowed) { sendError(res, 'CORS origin denied', 403); return; }
    if (req.method === 'OPTIONS') {
      if (!origin) { sendError(res, 'CORS origin required', 403); return; }
      res.writeHead(204); res.end(); return;
    }

    // Dashboard (static HTML shell — no live data embedded; safe to serve
    // without auth since it only fetches /api/* client-side, which IS gated).
    if (pathname === '/' || pathname === '/dashboard') {
      sendHtml(res, DASHBOARD_HTML);
      return;
    }

    // --- SSE event stream ---
    // Placed BEFORE the blanket auth check because EventSource cannot send
    // custom headers — this handler accepts auth via query-param token.
    if (pathname === '/api/events' && req.method === 'GET') {
      // SSE endpoint for real-time dashboard updates. The dashboard connects
      // once and receives push events when tasks or workers change state.
      // Auth: if AUTH_TOKEN is set, accept it via query param (EventSource
      // can't send custom headers) or via Authorization header.
      const token = process.env.AUTH_TOKEN;
      if (token) {
        const qsToken = params.get('token');
        const hdrToken = bearerTokenMatches(req.headers.authorization, token);
        if (!safeEqual(qsToken, token) && !hdrToken) {
          sendError(res, 'Unauthorized', 401);
          return;
        }
      }
      if (sseClients.size >= MAX_SSE_CLIENTS) {
        sendError(res, 'Too many event-stream clients', 503);
        return;
      }
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
      });
      res.write('retry: 3000\n\n');
      sseClients.add(res);
      req.on('close', () => sseClients.delete(res));
      return;
    }

    // Auth check for the whole API when AUTH_TOKEN is set. This covers every
    // method, not just POST: GET /api/tasks/next claims (mutates) a task, and
    // plain reads (task prompts/repos, usage/spend, workers) are themselves
    // sensitive once the server is reachable beyond localhost (--host 0.0.0.0).
    const authHeader = req.headers.authorization;
    const token = process.env.AUTH_TOKEN;
    if (token && !bearerTokenMatches(authHeader, token)) {
      sendError(res, 'Unauthorized', 401);
      return;
    }

    // --- Task routes ---

    if (pathname === '/api/tasks') {
      if (req.method === 'POST') return await handleCreateTask(req, res, db, options);
      if (req.method === 'GET') return await handleListTasks(req, res, db, params);
    }

    if (pathname.match(/^\/api\/tasks\/[a-f0-9-]+$/) && req.method === 'GET') {
      const id = pathname.split('/')[3];
      return await handleGetTask(res, db, id);
    }

    if (pathname.match(/^\/api\/tasks\/[a-f0-9-]+\/result$/) && req.method === 'POST') {
      const id = pathname.split('/')[3];
      return await handleCompleteTask(req, res, db, id);
    }

    if (pathname === '/api/tasks/next' && req.method === 'GET') {
      return await handleClaimTask(req, res, db, params, resolveAutoModel);
    }

    // --- Worker routes ---

    if (pathname === '/api/workers' && req.method === 'POST') {
      return await handleRegisterWorker(req, res, db);
    }

    if (pathname.match(/^\/api\/workers\/[^/]+\/heartbeat$/) && req.method === 'POST') {
      const id = pathname.split('/')[3];
      // A live heartbeat proves whatever task this worker currently holds is
      // still alive — renew its lease so recoverExpiredTasks doesn't re-pend
      // (and duplicate) a long-running task out from under an active worker.
      // Workers report the lease length they claimed with; renewing by the
      // fixed 60-minute default would shrink long claims on the first beat.
      const leaseMinutes = boundedQueryInt(params, 'leaseMinutes', 60, 24 * 60, 1);
      dbModule.heartbeatWorker(db, id);
      dbModule.renewTaskLease(db, id, leaseMinutes);
      broadcastSse('heartbeat', { worker: id, ts: new Date().toISOString() });
      sendJson(res, { ok: true });
      return;
    }

    if (pathname === '/api/workers' && req.method === 'GET') {
      return sendJson(res, dbModule.listWorkers(db));
    }

    // --- Usage routes ---

    if (pathname === '/api/usage') {
      const days = boundedQueryInt(params, 'days', 7, 3650, 1);
      return sendJson(res, dbModule.getTotalUsage(db, days));
    }

    // --- JSONL export route ---

    if (pathname === '/api/export/jsonl' && req.method === 'GET') {
      return handleJsonlExport(res, db);
    }

    // --- Rate limit routes ---

    if (pathname === '/api/rate-limits') {
      return sendJson(res, dbModule.getRateLimits(db));
    }

    // --- Utilization route ---

    if (pathname === '/api/utilization') {
      const provider = params.get('provider') || undefined;
      const model = params.get('model') || undefined;
      const util = provider
        ? dbModule.getProviderUtilization(db, provider, model)
        : dbModule.getRateLimits(db).map(rl => dbModule.getProviderUtilization(db, rl.provider, rl.model || undefined)[0] || { metric: rl.metric, provider: rl.provider });
      return sendJson(res, util);
    }

    // --- Approval routes ---

    if (pathname === '/api/tasks/pending-approvals') {
      const limit = boundedQueryInt(params, 'limit', 50, 1000, 1);
      return sendJson(res, dbModule.listPendingApprovals(db, limit));
    }

    if (pathname.match(/^\/api\/tasks\/[a-f0-9-]+\/approve$/) && req.method === 'POST') {
      const id = pathname.split('/')[3];
      return await handleApproveTask(req, res, db, id);
    }

    if (pathname.match(/^\/api\/tasks\/[a-f0-9-]+\/reject$/) && req.method === 'POST') {
      const id = pathname.split('/')[3];
      return await handleRejectTask(req, res, db, id);
    }

    // --- Worker staleness ---

    if (pathname === '/api/workers/stale' && req.method === 'GET') {
      const maxAge = boundedQueryInt(params, 'maxAge', 120, 31_536_000, 1); // seconds
      const cutoff = new Date(Date.now() - maxAge * 1000).toISOString();
      const stale = db.prepare(
        'SELECT * FROM workers WHERE last_seen < ?',
      ).all(cutoff);
      return sendJson(res, stale);
    }

    // --- Task pruning ---

    if (pathname === '/api/tasks/prune' && req.method === 'POST') {
      const maxAgeDays = boundedQueryInt(params, 'maxAgeDays', 30, 3650, 1);
      const result = dbModule.pruneCompletedTasks(db, maxAgeDays);
      broadcastSse('tasks-pruned', result);
      return sendJson(res, result);
    }

    // --- Task deletion ---

    if (pathname.match(/^\/api\/tasks\/[a-f0-9-]+$/) && req.method === 'DELETE') {
      const id = pathname.split('/')[3];
      try {
        const result = dbModule.pruneTask(db, id);
        broadcastSse('task-deleted', { id });
        return sendJson(res, result);
      } catch (e) { return sendError(res, e.message, e.statusCode || 400); }
    }

    // --- Task update (priority, prompt) ---

    if (pathname.match(/^\/api\/tasks\/[a-f0-9-]+$/) && req.method === 'PATCH') {
      const id = pathname.split('/')[3];
      try {
        const body = await jsonObjectBody(req);
        let task;
        if (body.priority != null) {
          task = dbModule.updateTaskPriority(db, id, Number(body.priority));
        } else if (body.prompt != null) {
          task = dbModule.updateTaskPrompt(db, id, String(body.prompt));
        } else {
          return sendError(res, 'No valid fields to update (priority, prompt)', 400);
        }
        broadcastSse('task-updated', task);
        return sendJson(res, task);
      } catch (e) { return sendError(res, e.message, e.statusCode || 400); }
    }

    // --- Bulk operations ---

    if (pathname === '/api/tasks/bulk/approve' && req.method === 'POST') {
      try {
        const body = await jsonObjectBody(req);
        const ids = body.ids || [];
        const approvedBy = body.approved_by || 'admin';
        const results = dbModule.bulkApproveTasks(db, ids, approvedBy);
        broadcastSse('tasks-bulk-updated', results);
        return sendJson(res, results);
      } catch (e) { return sendError(res, e.message, e.statusCode || 400); }
    }

    if (pathname === '/api/tasks/bulk/reject' && req.method === 'POST') {
      try {
        const body = await jsonObjectBody(req);
        const ids = body.ids || [];
        const rejectedBy = body.rejected_by || 'admin';
        const reason = body.reason || null;
        const results = dbModule.bulkRejectTasks(db, ids, rejectedBy, reason);
        broadcastSse('tasks-bulk-updated', results);
        return sendJson(res, results);
      } catch (e) { return sendError(res, e.message, e.statusCode || 400); }
    }

    if (pathname === '/api/tasks/bulk/delete' && req.method === 'POST') {
      try {
        const body = await jsonObjectBody(req);
        const ids = body.ids || [];
        const results = dbModule.bulkDeleteTasks(db, ids);
        broadcastSse('tasks-bulk-updated', results);
        return sendJson(res, results);
      } catch (e) { return sendError(res, e.message, e.statusCode || 400); }
    }

    // --- Export ---

    if (pathname === '/api/tasks/export' && req.method === 'GET') {
      const format = params.get('format') || 'jsonl';
      const status = params.get('status') || undefined;
      const limit = boundedQueryInt(params, 'limit', 1000, 10_000, 1);
      if (format === 'csv') {
        const csv = dbModule.exportTasksAsCsv(db, { status, limit });
        res.writeHead(200, {
          'Content-Type': 'text/csv',
          'Content-Disposition': 'attachment; filename="tasks.csv"',
        });
        return res.end(csv);
      }
      const jsonl = dbModule.exportTasksAsJsonl(db, { status, limit });
      res.writeHead(200, {
        'Content-Type': 'application/x-ndjson',
        'Content-Disposition': 'attachment; filename="tasks.jsonl"',
      });
      return res.end(jsonl);
    }

    // --- Jules sessions ---

    if (pathname === '/api/jules-sessions' && req.method === 'GET') {
      const state = params.get('state') || undefined;
      const limit = boundedQueryInt(params, 'limit', 50, 1000, 1);
      const sessions = dbModule.listJulesSessions(db, { state, limit });
      return sendJson(res, sessions);
    }

    if (pathname === '/api/jules-sessions/inflight' && req.method === 'GET') {
      const sessions = dbModule.findInflightJulesSessions(db);
      return sendJson(res, sessions);
    }

    // 404
    sendError(res, 'Not found', 404);
  } catch (err) {
    sendError(res, err.message || 'Internal error', err.statusCode || 500);
  }
}

// --- Task handlers ---

async function handleCreateTask(req, res, db, options = {}) {
  try {
    const body = await jsonObjectBody(req);
    // Reserve agentq's own task sources. A locally-owned source lets a local
    // worker claim an unapproved task and exempts it from the attempt cap, so
    // an HTTP client must never be able to mint one through this route. Checked
    // first so a rejected request cannot trigger a GitHub capture either.
    if (dbModule.RESERVED_TASK_SOURCES.includes(body.source)) {
      const err = new Error(`source '${body.source}' is reserved for agentq's own enqueues`);
      err.statusCode = 400;
      throw err;
    }
    if ((body.kind === 'github_issue' || body.issue_num != null)
      && (body.prompt === undefined || body.prompt === null || body.prompt === '')) {
      if (typeof body.repo !== 'string' || !body.repo.trim()
        || !Number.isSafeInteger(body.issue_num) || body.issue_num <= 0) {
        throw new Error('GitHub issue enqueue requires a repository path and positive issue number.');
      }
      const repo = path.resolve(body.repo);
      try {
        if (!fs.statSync(repo).isDirectory()) throw new Error();
      } catch { throw new Error('Issue capture requires an accessible repository directory on the enqueueing server.'); }
      if (activeIssueCaptures >= MAX_ISSUE_CAPTURES) {
        sendError(res, 'Issue input capture is busy; retry enqueueing later.', 503);
        return;
      }
      const capture = options.captureIssueInput || fetchTaskInputAsync;
      activeIssueCaptures++;
      try {
        body.prompt = JSON.stringify(await capture(repo, body.issue_num));
        body.repo = repo;
      } finally { activeIssueCaptures--; }
    }
    // A supplied prompt must be a valid snapshot, not instructions silently
    // discarded in favor of live GitHub content. createTask validates it.
    // Enforce trust gate: untrusted tasks always require approval, full
    // stop — approval can only happen after creation, via the dedicated
    // POST /api/tasks/:id/approve endpoint (approveTask), which is the only
    // code path that ever persists approved_by. A client-supplied
    // `approved_by` field in the creation body is never stored (createTask's
    // INSERT has no such column) and must not be trusted to skip the gate
    // here either — otherwise any client could claim pre-approval for free.
    if (body.trust_level === 'untrusted') {
      body.approval_required = 1;
    }
    const task = dbModule.createTask(db, body);
    broadcastSse('task-created', task);
    res.writeHead(201, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(task));
  } catch (e) { sendError(res, e.message, e.statusCode || 400); }
}

function handleGetTask(res, db, id) {
  const task = dbModule.getTask(db, id);
  if (!task) return sendError(res, 'Task not found', 404);
  const events = dbModule.listTaskEvents(db, id);
  sendJson(res, { ...task, events });
}

function handleListTasks(req, res, db, params) {
  const status = params.get('status');
  const kind = params.get('kind');
  const limit = boundedQueryInt(params, 'limit', 50, 1000, 1);
  const offset = boundedQueryInt(params, 'offset', 0, 10_000_000, 0);
  sendJson(res, dbModule.listTasks(db, { status, kind, limit, offset }));
}

function handleClaimTask(req, res, db, params, resolveAutoModel = null) {
  const kind = params.get('kind') || undefined;
  const model = params.get('model') || undefined;
  const modelOverride = params.get('modelOverride') || undefined;
  if (modelOverride && (kind !== 'feedback' || model)) {
    sendJson(res, { error: 'modelOverride is only supported for feedback claims without model filtering' }, 400);
    return;
  }
  const maxAttempts = boundedQueryInt(params, 'maxAttempts', 3, 100, 1);
  const workerId = params.get('worker') || 'http-api';
  const leaseMinutes = boundedQueryInt(params, 'leaseMinutes', 60, 24 * 60, 1);

  const task = dbModule.claimNextTask(db, workerId, { kind, model, modelOverride, maxAttempts, resolveAutoModel, leaseMinutes });
  if (!task) { res.writeHead(204); res.end(); return; }
  broadcastSse('task-claimed', task);
  sendJson(res, task);
}

async function handleCompleteTask(req, res, db, taskId) {
  try {
    const body = await jsonObjectBody(req);
    const worker = typeof body.worker === 'string' ? body.worker.trim() : '';
    if (!worker) {
      const err = new Error('worker identity is required');
      err.statusCode = 400;
      throw err;
    }
    const status = body.status || 'succeeded';
    dbModule.completeTask(db, taskId, { status, ...body }, { claimedBy: worker });
    const updated = dbModule.getTask(db, taskId);
    recordCompletionOutcome(db, updated);
    broadcastSse('task-completed', updated);
    sendJson(res, { ok: true });
  } catch (e) { sendError(res, e.message, e.statusCode || 400); }
}

/**
 * Record one attempt's outcome for the path it ran on.
 *
 * A remote worker reports through this route; its own OrchestratorSource
 * never writes outcomes (the queue lives here), so this is the single
 * server-side writer. The classification rule is the same shared function the
 * local runner uses, and the path is the provider the claim stored. A
 * completion that was rejected never reaches here (completeTask throws), so
 * only accepted attempts are counted. Recording must not fail the request.
 *
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {ReturnType<typeof dbModule.getTask>} task
 */
function recordCompletionOutcome(db, task) {
  const provider = task && typeof task.provider === 'string' ? task.provider : '';
  if (!provider) return;
  let completion = {};
  try { completion = task.result ? JSON.parse(task.result) : {}; } catch { completion = {}; }
  try {
    dbModule.recordPathOutcome(db, {
      path: provider,
      model: task.model ?? null,
      taskId: task.id,
      outcome: classifyOutcome({
        exitCode: typeof completion.exit === 'number' ? completion.exit : null,
        verified: typeof completion.verified === 'number' ? completion.verified : null,
        status: typeof completion.status === 'string' ? completion.status : null,
      }),
    });
  } catch (error) {
    console.error(`task ${task.id}: path outcome not recorded (${error instanceof Error ? error.message : String(error)})`);
  }
}

// --- Approval handlers ---

async function handleApproveTask(req, res, db, taskId) {
  try {
    const body = await jsonObjectBody(req);
    const approvedBy = body.approved_by || body.approvedBy || 'admin';
    const task = dbModule.approveTask(db, taskId, approvedBy);
    broadcastSse('task-approved', task);
    sendJson(res, task);
  } catch (e) { sendError(res, e.message, e.statusCode || 400); }
}

async function handleRejectTask(req, res, db, taskId) {
  try {
    const body = await jsonObjectBody(req);
    const rejectedBy = body.rejected_by || body.rejectedBy || 'admin';
    const reason = body.reason || null;
    const task = dbModule.rejectTask(db, taskId, rejectedBy, reason);
    broadcastSse('task-rejected', task);
    sendJson(res, task);
  } catch (e) { sendError(res, e.message, e.statusCode || 400); }
}

// --- Worker handlers ---

async function handleRegisterWorker(req, res, db) {
  try {
    const body = await jsonObjectBody(req);
    const worker = dbModule.registerWorker(db, body);
    broadcastSse('worker-updated', worker);
    sendJson(res, worker);
  } catch (e) { sendError(res, e.message, e.statusCode || 400); }
}

// --- JSONL export ---

async function handleJsonlExport(res, db) {
  res.writeHead(200, {
    'Content-Type': 'application/x-ndjson',
    'Content-Disposition': 'attachment; filename="orchestrator-events.jsonl"',
  });
  // Stream in batches — loading the whole events table into memory would
  // grow without bound over the server's lifetime. Honor backpressure: a
  // slow client must not make the response buffer the whole table, and a
  // disconnected client must not keep the loop (and its DB reads) running.
  const BATCH = 1000;
  let aborted = false;
  res.on('close', () => { aborted = true; });
  try {
    for (let offset = 0; !aborted; offset += BATCH) {
      const events = dbModule.listAllTaskEvents(db, { offset, limit: BATCH });
      for (const ev of events) {
        if (aborted) break;
        if (!res.write(JSON.stringify(ev) + '\n')) {
          // Wait for drain — or for the client to go away; on close the
          // 'drain' event may never fire, which would hang this promise.
          // Both temporary listeners are removed when either fires.
          await new Promise((resolve) => {
            const onDrain = () => { res.off('close', onClose); resolve(); };
            const onClose = () => { res.off('drain', onDrain); resolve(); };
            res.once('drain', onDrain);
            res.once('close', onClose);
          });
        }
      }
      if (events.length < BATCH) break; // last page; loop must terminate
    }
  } catch {
    aborted = true; // client went away mid-stream
  }
  res.end();
}

module.exports = {
  handleRequest,
  memoizeWithTtl,
  broadcastSse,
  closeSseClients,
};

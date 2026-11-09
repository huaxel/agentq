'use strict';
/**
 * Unit tests for serve.js's request handler — /healthz, /refresh auth+method
 * gating, and the dashboard/404 routes. Uses a fake `rebuild` (no live network
 * fetch, no real pipeline run) and injected state so these are fast and
 * hermetic. Run with `npm test`.
 */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { createServer, atomicWriteFile } = require('../src/roi-tracker/serve.js');

function tmpdir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'serve-test-'));
}

function makeTestServer({ isLocalhost = true, refreshToken = '', htmlPath, state, minManualRefreshMs = 5000, rebuildCalls } = {}) {
  const root = tmpdir();
  const finalHtmlPath = htmlPath ?? path.join(root, 'dashboard.html');
  const sharedState = state || { building: false, lastBuilt: null, lastError: null, lastManualRefresh: 0 };
  const calls = rebuildCalls || [];
  const rebuild = async (reason) => {
    calls.push(reason);
    sharedState.lastBuilt = new Date().toISOString();
    sharedState.lastError = null;
  };
  const server = createServer({ isLocalhost, refreshToken, rebuild, state: sharedState, htmlPath: finalHtmlPath, minManualRefreshMs });

  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address();
      resolve({ server, port: addr.port, root, htmlPath: finalHtmlPath, state: sharedState, calls });
    });
  });
}

function closeServer({ server }) {
  return new Promise((resolve) => server.close(resolve));
}

function fetch(path, { port, method = 'GET', headers = {}, body = null } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path, method, headers }, (res) => {
      let body = '';
      res.on('data', c => body += c);
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body }));
    });
    req.on('error', reject);
    req.end(body);
  });
}

test('atomicWriteFile replaces artifacts and cleans failed temporary writes', () => {
  const root = tmpdir();
  const file = path.join(root, 'artifact.html');
  fs.writeFileSync(file, 'old');
  atomicWriteFile(file, 'new');
  assert.equal(fs.readFileSync(file, 'utf8'), 'new');
  assert.deepEqual(fs.readdirSync(root), ['artifact.html']);
});

// --- /healthz ---

test('/healthz returns 503 before any build has ever completed', async () => {
  const ctx = await makeTestServer();
  try {
    const res = await fetch('/healthz', { port: ctx.port });
    assert.equal(res.status, 503);
    const body = JSON.parse(res.body);
    assert.equal(body.healthy, false);
  } finally { await closeServer(ctx); }
});

test('/healthz returns 200 once a build has completed, even if the most recent refresh failed', async () => {
  const state = { building: false, lastBuilt: new Date().toISOString(), lastError: 'pricing fetch failed', lastManualRefresh: 0 };
  const ctx = await makeTestServer({ state });
  try {
    const res = await fetch('/healthz', { port: ctx.port });
    assert.equal(res.status, 200, 'a prior successful build means the server can still serve something');
    const body = JSON.parse(res.body);
    assert.equal(body.healthy, true);
    assert.equal(body.ok, false, 'ok still reflects the most recent error');
  } finally { await closeServer(ctx); }
});

// --- /refresh: localhost bypasses auth entirely ---

test('/refresh on localhost requires POST even with no token', async () => {
  const ctx = await makeTestServer({ isLocalhost: true });
  try {
    let res = await fetch('/refresh', { port: ctx.port, method: 'GET' });
    assert.equal(res.status, 405);
    assert.equal(res.headers.allow, 'POST');
    res = await fetch('/refresh', { port: ctx.port, method: 'POST' });
    assert.equal(res.status, 303);
    assert.deepEqual(ctx.calls, ['manual']);
  } finally { await closeServer(ctx); }
});

test('/refresh on localhost still enforces a configured REFRESH_TOKEN (defense in depth behind a reverse proxy)', async () => {
  const ctx = await makeTestServer({ isLocalhost: true, refreshToken: 'secret' });
  try {
    let res = await fetch('/refresh', { port: ctx.port, method: 'GET' });
    assert.equal(res.status, 405, 'a token configured on localhost still requires POST');

    res = await fetch('/refresh', { port: ctx.port, method: 'POST' });
    assert.equal(res.status, 403, 'a token configured on localhost still requires the correct header');
    assert.equal(ctx.calls.length, 0);

    res = await fetch('/refresh', { port: ctx.port, method: 'POST', headers: { 'X-Refresh-Token': 'secret' } });
    assert.equal(res.status, 303);
    assert.deepEqual(ctx.calls, ['manual']);
  } finally { await closeServer(ctx); }
});

// --- /refresh: non-localhost, no token configured ---

test('/refresh is disabled (403) for non-localhost access when no REFRESH_TOKEN is configured', async () => {
  const ctx = await makeTestServer({ isLocalhost: false, refreshToken: '' });
  try {
    const res = await fetch('/refresh', { port: ctx.port, method: 'POST', headers: { 'X-Refresh-Token': 'anything' } });
    assert.equal(res.status, 403);
    assert.match(res.body, /disabled/);
    assert.equal(ctx.calls.length, 0, 'rebuild must not run');
  } finally { await closeServer(ctx); }
});

// --- /refresh: non-localhost, token configured ---

test('/refresh rejects a GET even with a valid token — POST is required', async () => {
  const ctx = await makeTestServer({ isLocalhost: false, refreshToken: 'secret' });
  try {
    const res = await fetch('/refresh?token=secret', { port: ctx.port, method: 'GET' });
    assert.equal(res.status, 405);
    assert.equal(res.headers.allow, 'POST');
    assert.equal(ctx.calls.length, 0, 'a GET must never trigger a rebuild, regardless of a query-string token');
  } finally { await closeServer(ctx); }
});

test('/refresh rejects a POST with a missing or wrong X-Refresh-Token header', async () => {
  const ctx = await makeTestServer({ isLocalhost: false, refreshToken: 'secret' });
  try {
    let res = await fetch('/refresh', { port: ctx.port, method: 'POST' });
    assert.equal(res.status, 403);
    res = await fetch('/refresh', { port: ctx.port, method: 'POST', headers: { 'X-Refresh-Token': 'wrong' } });
    assert.equal(res.status, 403);
    assert.equal(ctx.calls.length, 0);
  } finally { await closeServer(ctx); }
});

test('/refresh succeeds on POST with the correct X-Refresh-Token header', async () => {
  const ctx = await makeTestServer({ isLocalhost: false, refreshToken: 'secret' });
  try {
    const res = await fetch('/refresh', { port: ctx.port, method: 'POST', headers: { 'X-Refresh-Token': 'secret' } });
    assert.equal(res.status, 303);
    assert.deepEqual(ctx.calls, ['manual']);
  } finally { await closeServer(ctx); }
});

test('/benchmark is disabled for non-localhost access without REFRESH_TOKEN', async () => {
  const ctx = await makeTestServer({ isLocalhost: false, refreshToken: '' });
  try {
    const res = await fetch('/benchmark', { port: ctx.port, method: 'POST' });
    assert.equal(res.status, 403);
    assert.match(res.body, /disabled/);
    assert.deepEqual(ctx.calls, []);
  } finally { await closeServer(ctx); }
});

test('/benchmark rejects oversized request bodies', async () => {
  const ctx = await makeTestServer({ isLocalhost: true });
  try {
    const body = 'x'.repeat(64 * 1024 + 1);
    const res = await fetch('/benchmark', {
      port: ctx.port,
      method: 'POST',
      headers: { 'Content-Length': String(body.length) },
      body,
    });
    assert.equal(res.status, 413);
    assert.deepEqual(ctx.calls, []);
  } finally { await closeServer(ctx); }
});

test('/refresh throttles rapid repeated requests', async () => {
  const ctx = await makeTestServer({ isLocalhost: true, minManualRefreshMs: 60_000 });
  try {
    const first = await fetch('/refresh', { port: ctx.port, method: 'POST' });
    assert.equal(first.status, 303);
    const second = await fetch('/refresh', { port: ctx.port, method: 'POST' });
    assert.equal(second.status, 429);
    assert.deepEqual(ctx.calls, ['manual'], 'the throttled request must not trigger a second rebuild');
  } finally { await closeServer(ctx); }
});

// --- dashboard + 404 ---

test('/ returns 503 before the dashboard has been rendered', async () => {
  const ctx = await makeTestServer();
  try {
    const res = await fetch('/', { port: ctx.port });
    assert.equal(res.status, 503);
  } finally { await closeServer(ctx); }
});

test('/ serves the rendered HTML once it exists', async () => {
  const ctx = await makeTestServer();
  fs.writeFileSync(ctx.htmlPath, '<html>dashboard</html>');
  try {
    const res = await fetch('/', { port: ctx.port });
    assert.equal(res.status, 200);
    assert.equal(res.body, '<html>dashboard</html>');
  } finally { await closeServer(ctx); }
});

test('unknown paths return 404', async () => {
  const ctx = await makeTestServer();
  try {
    const res = await fetch('/nope', { port: ctx.port });
    assert.equal(res.status, 404);
  } finally { await closeServer(ctx); }
});

test('/benchmark rejects non-numeric field values instead of storing NaN', async () => {
  const ctx = await makeTestServer({ isLocalhost: true });
  try {
    const res = await fetch('/benchmark', {
      port: ctx.port,
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: 'test/never-written', GPQA: 'eighty-nine' }),
    });
    assert.equal(res.status, 400);
    assert.match(res.body, /GPQA/);
    assert.deepEqual(ctx.calls, []);
  } finally { await closeServer(ctx); }
});

test('/benchmark rejects negative values instead of distorting normalization', async () => {
  const ctx = await makeTestServer({ isLocalhost: true });
  try {
    const res = await fetch('/benchmark', {
      port: ctx.port,
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: 'test/never-written', HLE: -5 }),
    });
    assert.equal(res.status, 400);
    assert.deepEqual(ctx.calls, []);
  } finally { await closeServer(ctx); }
});

test('/benchmark requires a model name', async () => {
  const ctx = await makeTestServer({ isLocalhost: true });
  try {
    const res = await fetch('/benchmark', {
      port: ctx.port,
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ GPQA: 90 }),
    });
    assert.equal(res.status, 400);
    assert.deepEqual(ctx.calls, []);
  } finally { await closeServer(ctx); }
});

test('/benchmark drops legacy availability columns when it rewrites a row', async () => {
  const home = tmpdir();
  fs.mkdirSync(path.join(home, 'data'), { recursive: true });
  const registryPath = path.join(home, 'data', 'benchmark-inputs.json');
  // A pre-migration row: the per-subscription on* columns are no longer read
  // (coverage lives in config.paths[].models), so the editor must not carry
  // them forward.
  fs.writeFileSync(registryPath, JSON.stringify({
    models: [{ model: 'test/legacy-row', onClaudeMax: 1, onOpenRouter: null, speed: 40 }],
  }, null, 2));

  const previous = process.env.AGENTQ_HOME;
  process.env.AGENTQ_HOME = home;
  const ctx = await makeTestServer({ isLocalhost: true });
  try {
    const res = await fetch('/benchmark', {
      port: ctx.port,
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: 'test/legacy-row', GPQA: 90 }),
    });
    assert.equal(res.status, 200, res.body);
    const written = JSON.parse(fs.readFileSync(registryPath, 'utf8'));
    assert.deepEqual(written.models, [{ model: 'test/legacy-row', speed: 40, gpqa: 90 }]);
    assert.deepEqual(ctx.calls, ['benchmark-added']);
  } finally {
    await closeServer(ctx);
    if (previous === undefined) delete process.env.AGENTQ_HOME;
    else process.env.AGENTQ_HOME = previous;
  }
});

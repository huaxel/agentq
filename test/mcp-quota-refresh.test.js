'use strict';

/**
 * The MCP side of stale-quota refresh: the wrapper that refreshes before a
 * capacity-reading tool runs, and the real server wiring (a fake collector
 * script writes the snapshot; the shipped collector and the network are never
 * touched).
 */

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { test } = require('node:test');

const { createQuotaRefresh, withQuotaRefresh, quotaRefreshOutcome, REFRESH_TOOLS } = require('../src/interfaces/mcp/quota-refresh.js');

const ROOT = path.join(__dirname, '..');
const BIN = path.join(ROOT, 'bin', 'agentq-mcp.js');
const HOUR = 3600 * 1000;

/** Poll until `predicate()` is true (bounded). */
async function waitFor(predicate, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  return false;
}

function tool(name, handler = () => ({ tool: name })) {
  return { name, description: name, inputSchema: { type: 'object' }, annotations: { readOnlyHint: true }, handler };
}

test('the wrapper refreshes before each capacity-reading tool and passes the outcome through', async () => {
  const events = [];
  const tools = withQuotaRefresh(
    [
      tool('capacity_overview', () => { events.push('handler:capacity'); return { tool: 'capacity_overview' }; }),
      tool('recommend_model', () => { events.push('handler:recommend'); return { tool: 'recommend_model' }; }),
      tool('recommend_for_task', () => ({ tool: 'recommend_for_task' })),
      tool('dispatch_task', () => ({ dispatched: true })),
      tool('list_tasks', () => ({ tasks: [] })),
    ],
    {
      refreshQuota: async () => {
        events.push('refresh');
        return { refreshed: true, reason: 'refreshed', durationMs: 1234 };
      },
    },
  );
  const byName = new Map(tools.map((entry) => [entry.name, entry]));

  assert.deepEqual(await byName.get('capacity_overview').handler({}), {
    tool: 'capacity_overview',
    quota_refresh: { refreshed: true, reason: 'refreshed' },
  });
  assert.deepEqual(events.slice(0, 2), ['refresh', 'handler:capacity'], 'refresh runs before the handler');
  assert.deepEqual(await byName.get('dispatch_task').handler({}), {
    dispatched: true,
    quota_refresh: { refreshed: true, reason: 'refreshed' },
  });

  // A tool that does not read capacity is untouched.
  assert.deepEqual(await byName.get('list_tasks').handler({}), { tasks: [] });
  assert.equal(byName.get('list_tasks').handler, tools.find((entry) => entry.name === 'list_tasks').handler);
});

test('a slow refresh is bounded: the tool answers "refresh in progress" and the collection continues', async () => {
  let calls = 0;
  let fresh = false;
  const refreshQuota = async () => {
    calls += 1;
    if (fresh) return { refreshed: false, reason: 'fresh' };
    await new Promise((resolve) => setTimeout(resolve, 300));
    fresh = true;
    return { refreshed: true, reason: 'refreshed' };
  };
  const tools = withQuotaRefresh(
    [tool('capacity_overview', () => ({ fresh }))],
    { refreshQuota, mcpWaitMs: 50 },
  );

  const started = Date.now();
  const first = await tools[0].handler({});
  const elapsed = Date.now() - started;
  // Generous relative bound: the call must return after about one wait, not
  // after the 300 ms collection (load can stretch timers, so no tight ceiling).
  assert.ok(elapsed < 300 / 2 + 200, `the tool must answer within the bound, took ${elapsed}ms`);
  assert.deepEqual(first.quota_refresh, { refreshed: false, reason: 'refresh in progress' });
  assert.equal(first.fresh, false, 'it answers from the current snapshot');

  // A second call while the collection is still running joins it: one
  // collection per server, never two.
  const second = await tools[0].handler({});
  assert.deepEqual(second.quota_refresh, { refreshed: false, reason: 'refresh in progress' });
  assert.equal(calls, 1);

  // Once the background refresh has settled, the next call sees the result and
  // reports it once; the call after that starts a fresh check.
  await new Promise((resolve) => setTimeout(resolve, 400));
  const third = await tools[0].handler({});
  assert.equal(third.fresh, true, 'the later call reads the refreshed snapshot');
  assert.deepEqual(third.quota_refresh, { refreshed: true, reason: 'completed in background' });
  const fourth = await tools[0].handler({});
  assert.deepEqual(fourth.quota_refresh, { refreshed: false, reason: 'fresh' });
  assert.equal(calls, 2);
});

test('once a call has timed out, later calls answer immediately (one wait, not N)', async () => {
  let calls = 0;
  const refreshQuota = async () => {
    calls += 1;
    await new Promise((resolve) => setTimeout(resolve, 400));
    return { refreshed: true, reason: 'refreshed' };
  };
  const tools = withQuotaRefresh([tool('capacity_overview')], { refreshQuota, mcpWaitMs: 100 });

  const waitMs = 100;
  const queuedCalls = 8;
  const started = Date.now();
  const first = await tools[0].handler({});
  const firstMs = Date.now() - started;
  const restStarted = Date.now();
  const rest = [];
  for (let index = 1; index < queuedCalls; index += 1) rest.push(await tools[0].handler({}));
  const restMs = Date.now() - restStarted;

  // The first call pays the wait; the rest must answer immediately. If they
  // each waited, the rest would cost about (calls - 1) x waitMs. The bound is
  // relative to that, so a loaded machine cannot flake it.
  assert.ok(
    restMs < ((queuedCalls - 1) * waitMs) / 2,
    `${queuedCalls - 1} queued calls must not each wait (first ${firstMs}ms, rest ${restMs}ms)`,
  );
  for (const result of [first, ...rest]) {
    assert.deepEqual(result.quota_refresh, { refreshed: false, reason: 'refresh in progress' });
  }
  assert.equal(calls, 1, 'one background collection for all of them');
});

test('a background refresh that outlived the wait is reported once on the next call', async () => {
  let calls = 0;
  let fresh = false;
  const refreshQuota = async () => {
    calls += 1;
    if (fresh) return { refreshed: false, reason: 'fresh' };
    await new Promise((resolve) => setTimeout(resolve, 200));
    fresh = true;
    return { refreshed: true, reason: 'refreshed' };
  };
  const tools = withQuotaRefresh(
    [tool('capacity_overview', () => ({ fresh }))],
    { refreshQuota, mcpWaitMs: 50 },
  );

  const first = await tools[0].handler({});
  assert.deepEqual(first.quota_refresh, { refreshed: false, reason: 'refresh in progress' });
  assert.equal(first.fresh, false);

  await new Promise((resolve) => setTimeout(resolve, 250)); // let the collection finish

  const second = await tools[0].handler({});
  assert.equal(second.fresh, true, 'the next call reads the refreshed snapshot');
  assert.deepEqual(second.quota_refresh, { refreshed: true, reason: 'completed in background' });

  // Reported once: the following call starts a fresh check.
  const third = await tools[0].handler({});
  assert.deepEqual(third.quota_refresh, { refreshed: false, reason: 'fresh' });
  assert.equal(calls, 2);
});

test('a background refresh failure is reported once on the next call', async () => {
  let calls = 0;
  const refreshQuota = async () => {
    calls += 1;
    await new Promise((resolve) => setTimeout(resolve, 150));
    throw new Error('collector exploded');
  };
  const tools = withQuotaRefresh([tool('capacity_overview')], { refreshQuota, mcpWaitMs: 40 });

  assert.deepEqual((await tools[0].handler({})).quota_refresh, { refreshed: false, reason: 'refresh in progress' });
  await new Promise((resolve) => setTimeout(resolve, 200));
  assert.deepEqual((await tools[0].handler({})).quota_refresh, { refreshed: false, reason: 'refresh failed' });
  assert.equal(calls, 1, 'the failure is reported, not retried immediately');
});

test('cancel() aborts a running background collection', async () => {
  let aborted = false;
  const refreshQuota = ({ signal }) => new Promise((resolve) => {
    signal.addEventListener('abort', () => {
      aborted = true;
      resolve({ refreshed: false, reason: 'cancelled' });
    }, { once: true });
  });
  const quota = createQuotaRefresh({ refreshQuota, mcpWaitMs: 20 });
  const tools = quota.wrap([tool('capacity_overview')]);

  assert.deepEqual((await tools[0].handler({})).quota_refresh, { refreshed: false, reason: 'refresh in progress' });
  quota.cancel();
  await new Promise((resolve) => setTimeout(resolve, 30));

  assert.equal(aborted, true, 'the refresher received the abort');
  assert.deepEqual((await tools[0].handler({})).quota_refresh, { refreshed: false, reason: 'cancelled' });
});

test('a refresh that finishes inside the bound is reported as refreshed', async () => {
  const tools = withQuotaRefresh(
    [tool('recommend_model', () => ({ choice: 'gpt-5' }))],
    { refreshQuota: async () => ({ refreshed: true, reason: 'refreshed' }), mcpWaitMs: 5000 },
  );
  const result = await tools[0].handler({});
  assert.deepEqual(result.quota_refresh, { refreshed: true, reason: 'refreshed' });
});

test('a rejected background refresh does not poison later calls', async () => {
  let calls = 0;
  const tools = withQuotaRefresh([tool('capacity_overview')], {
    refreshQuota: async () => {
      calls += 1;
      throw new Error('boom');
    },
    mcpWaitMs: 1000,
  });
  assert.deepEqual((await tools[0].handler({})).quota_refresh, { refreshed: false, reason: 'refresh failed' });
  assert.deepEqual((await tools[0].handler({})).quota_refresh, { refreshed: false, reason: 'refresh failed' });
  assert.equal(calls, 2, 'a settled refresh is not reused forever');
});

test('a throwing refresher becomes a skipped refresh, never a failed tool', async () => {
  const tools = withQuotaRefresh([tool('capacity_overview')], {
    refreshQuota: () => { throw new Error('collector exploded'); },
  });
  const result = await tools[0].handler({});
  assert.deepEqual(result.quota_refresh, { refreshed: false, reason: 'refresh failed' });
  assert.equal(result.tool, 'capacity_overview');
});

test('a refresher outcome is normalised to { refreshed, reason }', async () => {
  assert.deepEqual(await quotaRefreshOutcome(() => ({ refreshed: 'yes', reason: 7 })), {
    refreshed: false,
    reason: 'unknown',
  });
  assert.deepEqual(await quotaRefreshOutcome(async () => ({ refreshed: false, reason: 'rate limited' })), {
    refreshed: false,
    reason: 'rate limited',
  });
});

test('without a refresher the tool list is returned unchanged', () => {
  const tools = [tool('capacity_overview')];
  assert.equal(withQuotaRefresh(tools, {}), tools);
  assert.equal(withQuotaRefresh(tools, { refreshQuota: null }), tools);
});

test('the four capacity-reading tools are the ones wrapped', () => {
  assert.deepEqual([...REFRESH_TOOLS].sort(), [
    'capacity_overview', 'dispatch_task', 'recommend_for_task', 'recommend_model',
  ]);
});

// --- real server wiring ---

function runServer(messages, { env = {} } = {}) {
  const expected = messages.filter((message) => message.id !== undefined).length;
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [BIN], {
      env: { ...process.env, ...env },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error(`timed out waiting for ${expected} responses; stderr: ${stderr}`));
    }, 20000);
    const finish = () => {
      clearTimeout(timer);
      child.kill();
      resolve({ stdout, stderr, lines: stdout.split('\n').filter((line) => line !== '') });
    };
    child.stdout.on('data', (chunk) => {
      stdout += String(chunk);
      if (stdout.split('\n').filter((line) => line !== '').length >= expected) finish();
    });
    child.stderr.on('data', (chunk) => {
      stderr += String(chunk);
    });
    child.on('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    for (const message of messages) child.stdin.write(`${JSON.stringify(message)}\n`);
  });
}

test('bin/agentq-mcp.js refreshes a stale snapshot before answering capacity_overview', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentq-mcp-quota-'));
  const quotaPath = path.join(dir, 'quota.json');
  const marker = path.join(dir, 'collector-ran');
  const collector = path.join(dir, 'collector.js');
  const stale = new Date(Date.now() - 7 * HOUR).toISOString();
  fs.writeFileSync(quotaPath, JSON.stringify({
    generatedAt: stale,
    paths: { codex: { updatedAt: stale, windows: [{ label: 'week', usedPercent: 99 }] } },
  }));
  // The fake collector records that it ran and writes a fresh snapshot.
  fs.writeFileSync(collector, [
    "const fs = require('node:fs');",
    `fs.writeFileSync(${JSON.stringify(marker)}, 'ran');`,
    'const now = new Date().toISOString();',
    'fs.writeFileSync(process.env.AGENTQ_QUOTA, JSON.stringify({',
    '  generatedAt: now,',
    "  paths: { codex: { updatedAt: now, windows: [{ label: 'week', usedPercent: 10 }] } },",
    '}));',
  ].join('\n'));

  // capacity_overview reads the runnable list from AGENTQ_HOME.
  const home = path.join(dir, 'home');
  fs.mkdirSync(path.join(home, 'config'), { recursive: true });
  fs.writeFileSync(path.join(home, 'config', 'runnables.json'), JSON.stringify({
    schemaVersion: 1,
    runnables: [{ id: 'openai-codex/gpt-5.6-terra', path: 'codex', modelKey: 'gpt-5-6-terra', harness: 'pi' }],
  }));

  try {
    const { lines, stderr } = await runServer([
      { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18' } },
      { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'capacity_overview', arguments: {} } },
    ], {
      env: {
        AGENTQ_HOME: home,
        AGENTQ_QUOTA: quotaPath,
        AGENTQ_QUOTA_COLLECTOR: collector,
        AGENTQ_QUOTA_REFRESH: '1',
        AGENTQ_ORCHESTRATOR_DB: path.join(dir, 'absent.sqlite'),
      },
    });
    const [, call] = lines.map((line) => JSON.parse(line));
    assert.equal(call.result.isError, undefined, `${JSON.stringify(call.result)} stderr=${stderr}`);
    const payload = call.result.structuredContent;
    assert.deepEqual(payload.quota_refresh, { refreshed: true, reason: 'refreshed' });
    assert.equal(fs.readFileSync(marker, 'utf8'), 'ran');
    // The tool read the refreshed file, not the stale one.
    const codex = payload.paths.find((entry) => entry.path === 'codex');
    assert.equal(codex.state, 'available');
    assert.equal(codex.headroomPct, 90);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('closing stdin cancels a running background collection instead of lingering', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentq-mcp-quota-cancel-'));
  const quotaPath = path.join(dir, 'quota.json');
  const collectorPidFile = path.join(dir, 'collector.pid');
  const collector = path.join(dir, 'slow-collector.js');
  const stale = new Date(Date.now() - 7 * HOUR).toISOString();
  fs.writeFileSync(quotaPath, JSON.stringify({
    generatedAt: stale,
    paths: { codex: { updatedAt: stale, windows: [{ label: 'week', usedPercent: 99 }] } },
  }));
  fs.writeFileSync(collector, [
    "const fs = require('node:fs');",
    `fs.writeFileSync(${JSON.stringify(collectorPidFile)}, String(process.pid));`,
    'setTimeout(() => {}, 60000);',
  ].join('\n'));

  const child = spawn(process.execPath, [BIN], {
    env: {
      ...process.env,
      AGENTQ_QUOTA: quotaPath,
      AGENTQ_QUOTA_COLLECTOR: collector,
      AGENTQ_QUOTA_REFRESH: '1',
      AGENTQ_ORCHESTRATOR_DB: path.join(dir, 'absent.sqlite'),
    },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  try {
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18' } })}\n`);
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'capacity_overview', arguments: {} } })}\n`);
    assert.ok(await waitFor(() => fs.existsSync(collectorPidFile)), 'the collection started');
    const collectorPid = Number(fs.readFileSync(collectorPidFile, 'utf8'));

    const started = Date.now();
    child.stdin.end();
    await new Promise((resolve) => child.on('close', resolve));
    const elapsed = Date.now() - started;

    assert.ok(elapsed < 5000, `the server must exit promptly, took ${elapsed}ms`);
    assert.ok(
      await waitFor(() => {
        try { process.kill(collectorPid, 0); return false; } catch { return true; }
      }),
      'the collector process is killed',
    );
  } finally {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    try {
      const pid = Number(fs.readFileSync(collectorPidFile, 'utf8'));
      if (Number.isInteger(pid) && pid > 0) {
        try { process.kill(-pid, 'SIGKILL'); } catch { /* gone */ }
      }
    } catch { /* the collector never started */ }
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

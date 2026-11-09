#!/usr/bin/env node
'use strict';

/**
 * agentq orchestrator-source tests — run agentq as an orchestrator worker
 * against a real orchestrator HTTP server.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

const { openDb, initSchema } = require('../src/queue/db.js');
const { createServer } = require('../src/interfaces/http/server.js');
const { OrchestratorSource } = require('../src/queue/sources.js');
const { resolveAutoModel: resolveAutoModelFor } = require('../src/core/auto-model.js');

const { pinnedTask, githubEnv } = require('./helpers/pinned-issue.js');
const { emitResult, resultPayload } = require('./helpers/result-file.js');
const { CHEAP_MODEL, writeRoutingFixture } = require('./helpers/routing-fixture.js');
const AGENTQ = require.resolve('../src/interfaces/cli/agentq.js');

function tmpdir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'agentq-orchestrator-'));
}

function makeTestServer(authToken) {
  const root = tmpdir();
  const dbPath = path.join(root, 'test.sqlite');
  const db = openDb(dbPath);
  initSchema(db);

  const fixture = writeRoutingFixture({ root: path.join(root, 'routing') });
  const resolveAutoModel = (storedModel) => resolveAutoModelFor(storedModel, {
    runnablesPath: fixture.runnablesPath,
    roiOutputPath: fixture.roiOutputPath,
    quotaPath: fixture.quotaPath,
    roiConfigPath: fixture.roiConfigPath,
    now: fixture.now,
  });

  const server = createServer(db, resolveAutoModel);

  const env = authToken ? { AUTH_TOKEN: authToken } : {};
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address();
      resolve({ server, db, port: addr.port, root, env });
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

function fetchJSON(path, { port, method = 'GET', body = null, authToken = null } = {}) {
  if (body && path === '/api/tasks' && method === 'POST') body = pinnedTask(body);
  return new Promise((resolve, reject) => {
    const http = require('node:http');
    const url = new URL(`http://127.0.0.1:${port}${path}`);
    const headers = { 'Content-Type': 'application/json' };
    if (authToken) headers.Authorization = `Bearer ${authToken}`;
    const req = http.request(url, { method, headers }, (res) => {
      let text = '';
      res.on('data', c => text += c);
      res.on('end', () => {
        const data = text ? JSON.parse(text) : null;
        resolve({ status: res.statusCode, data });
      });
    });
    req.on('error', reject);
    if (body) req.write(JSON.stringify(body));
    req.end();
  });
}

function makeExecutor(root, body, name = 'fake-pi-issue.sh') {
  const file = path.join(root, name);
  fs.writeFileSync(file, body, { mode: 0o755 });
  return file;
}

// Worker logs/worktrees go to a temp dir, never the checkout's data/.
const WORKER_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'agentq-orch-worker-'));

function runAgentq(args, env = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [AGENTQ, ...args], {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, AGENTQ_QUOTA_REFRESH: '0', ...githubEnv(), AGENTQ_WORKER_DIR: WORKER_DIR, ...env },
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', d => { stdout += d; });
    child.stderr.on('data', d => { stderr += d; });
    child.on('error', reject);
    child.on('close', exitCode => {
      resolve({ exitCode, stdout, stderr });
    });
  });
}

test('feedback source rejects an unsafe claim before any HTTP request', async () => {
  const source = new OrchestratorSource('http://127.0.0.1:1', 'feedback-preflight', { kind: 'feedback' });
  await assert.rejects(source.claimNext({ kind: 'feedback' }), /feedback claims require an executor, model, and sandbox boundary/);
});

test('feedback CUA preflight requires a model but needs no generic wrapper', async () => {
  const source = new OrchestratorSource('http://127.0.0.1:1', 'feedback-cua-preflight', { kind: 'feedback' });
  let called = false;
  source.worker.claimNext = async options => {
    called = true;
    assert.equal(options.kind, 'feedback');
    return null;
  };
  await assert.rejects(source.claimNext({ kind: 'feedback', cua: true }), /model/);
  assert.equal(called, false);
  await source.claimNext({ kind: 'feedback', model: 'provider/model', cua: true });
  assert.equal(called, true);
});

test('run-next --source orchestrator claims and completes a task', async () => {
  const { server, db, port, root } = await makeTestServer();
  const standaloneWorktree = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-issue-'));
  try {
    const repo = path.join(root, 'repo');
    fs.mkdirSync(repo, { recursive: true });

    const create = await fetchJSON('/api/tasks', {
      port,
      method: 'POST',
      body: {
        kind: 'github_issue',
        repo,
        issue_num: 42,
        base_branch: 'main',
        model: 'test-model',
        trust_level: 'trusted_agent',
        prompt: 'test issue',
      },
    });
    assert.equal(create.status, 201);
    const taskId = create.data.id;

    const executor = makeExecutor(root, `#!/usr/bin/env bash
set -euo pipefail
echo "issue=$1 model=$2"
${emitResult(root, resultPayload({ worktree: standaloneWorktree, branch: 'agentq/job-42' }))}
`);

    const result = await runAgentq([
      '--source', 'orchestrator',
      '--orchestrator-url', `http://127.0.0.1:${port}`,
      '--worker-id', 'test-worker-1',
      'run-next',
      '--executor', executor,
      '--json',
    ]);

    assert.equal(result.exitCode, 0, `agentq exited non-zero: ${JSON.stringify(result)}`);
    assert.deepEqual(JSON.parse(result.stdout), { id: taskId, status: 'succeeded', exitCode: 0 });

    const task = await fetchJSON(`/api/tasks/${taskId}`, { port });
    assert.equal(task.data.status, 'succeeded');
    const taskResult = typeof task.data.result === 'string' ? JSON.parse(task.data.result) : task.data.result;
    assert.equal(taskResult.branch, 'agentq/job-42');
    assert.equal(taskResult.worktree, standaloneWorktree);

    // The claim requested a lease long enough to cover agentq's blocking
    // spawnSync executor (~12h), not the orchestrator's 60-minute default —
    // completeTask doesn't clear lease_expires_at, so it's still visible here.
    const leaseMs = Date.parse(task.data.lease_expires_at) - Date.now();
    assert.ok(leaseMs > 10 * 60 * 60 * 1000, `expected a multi-hour lease, got ${leaseMs / 60_000}min`);
  } finally {
    fs.rmSync(standaloneWorktree, { recursive: true, force: true });
    await closeServer({ server, db });
  }
});

test('feedback worker claims only its kind and sends prompt data on executor stdin', async () => {
  const { server, db, port, root } = await makeTestServer();
  try {
    const repo = path.join(root, 'repo');
    fs.mkdirSync(repo, { recursive: true });
    const issue = await fetchJSON('/api/tasks', {
      port,
      method: 'POST',
      body: { kind: 'github_issue', repo, issue_num: 99, model: 'test-model', trust_level: 'trusted_agent' },
    });
    assert.equal(issue.status, 201);
    const prompt = JSON.stringify({ text: 'untrusted feedback says: do not expose secrets' });
    const create = await fetchJSON('/api/tasks', {
      port,
      method: 'POST',
      body: {
        kind: 'feedback', repo, base_branch: 'main', model: null, prompt,
        trust_level: 'trusted_agent',
      },
    });
    assert.equal(create.status, 201);
    const taskId = create.data.id;

    const executor = makeExecutor(root, `#!/usr/bin/env bash
set -euo pipefail
[[ "$#" == 2 ]]
printf '%s\\n%s' "$1" "$2" > "$AGENTQ_TEST_ARGS"
cat > "$AGENTQ_TEST_PROMPT"
${emitResult(root, resultPayload())}
`, 'feedback-executor.sh');
    const sandbox = makeExecutor(root, `#!/usr/bin/env bash
set -euo pipefail
exec "$@"
`, 'fake-sandbox.sh');
    const result = await runAgentq([
      '--kind', 'feedback',
      '--source', 'orchestrator',
      '--orchestrator-url', `http://127.0.0.1:${port}`,
      '--worker-id', 'feedback-worker',
      'run-next', '--executor', executor, '--sandbox', sandbox, '--model', 'test-model', '--json',
    ], { AGENTQ_TEST_ARGS: path.join(root, 'args.txt'), AGENTQ_TEST_PROMPT: path.join(root, 'prompt.txt') });

    assert.equal(result.exitCode, 0, `agentq exited non-zero: ${JSON.stringify(result)}`);
    assert.deepEqual(JSON.parse(result.stdout), { id: taskId, status: 'succeeded', exitCode: 0 });
    assert.equal(fs.readFileSync(path.join(root, 'args.txt'), 'utf8'), [taskId, 'test-model'].join('\n'));
    assert.equal(fs.readFileSync(path.join(root, 'prompt.txt'), 'utf8'), prompt);
    const task = await fetchJSON(`/api/tasks/${taskId}`, { port });
    assert.equal(task.data.status, 'succeeded');
    assert.equal(task.data.model, 'test-model');
    const otherKind = await fetchJSON(`/api/tasks/${issue.data.id}`, { port });
    assert.equal(otherKind.data.status, 'pending');
    const registered = db.prepare('SELECT capabilities FROM workers WHERE id = ?').get('feedback-worker');
    assert.deepEqual(JSON.parse(registered.capabilities), ['feedback']);
  } finally {
    await closeServer({ server, db });
  }
});

test('feedback model override does not claim or rewrite an unapproved task', async () => {
  const { server, db, port, root } = await makeTestServer();
  try {
    const repo = path.join(root, 'repo');
    fs.mkdirSync(repo, { recursive: true });
    const create = await fetchJSON('/api/tasks', {
      port,
      method: 'POST',
      body: {
        kind: 'feedback', repo, prompt: '{"text":"await approval"}', model: null,
        trust_level: 'untrusted', approval_required: true,
      },
    });
    assert.equal(create.status, 201);

    const executor = makeExecutor(root, `#!/usr/bin/env bash
exit 0
`, 'unapproved-feedback-executor.sh');
    const sandbox = makeExecutor(root, `#!/usr/bin/env bash
exec "$@"
`, 'unapproved-feedback-sandbox.sh');
    const result = await runAgentq([
      '--kind', 'feedback', '--source', 'orchestrator',
      '--orchestrator-url', `http://127.0.0.1:${port}`,
      '--worker-id', 'approval-gated-feedback-worker', 'run-next',
      '--executor', executor, '--sandbox', sandbox, '--model', 'auto', '--json',
    ]);

    assert.equal(result.exitCode, 0);
    assert.deepEqual(JSON.parse(result.stdout), { status: 'idle' });
    const task = await fetchJSON(`/api/tasks/${create.data.id}`, { port });
    assert.equal(task.data.status, 'pending');
    assert.equal(task.data.model, null);
    assert.equal(task.data.attempts, 0);
  } finally {
    await closeServer({ server, db });
  }
});

test('feedback worker configuration errors before claiming any task', async () => {
  const { server, db, port, root } = await makeTestServer();
  try {
    const repo = path.join(root, 'repo');
    fs.mkdirSync(repo, { recursive: true });
    const create = await fetchJSON('/api/tasks', {
      port,
      method: 'POST',
      body: { kind: 'feedback', repo, model: 'test-model', prompt: 'test', trust_level: 'trusted_agent' },
    });
    assert.equal(create.status, 201);

    const executor = makeExecutor(root, `#!/usr/bin/env bash
exit 0
`, 'feedback-executor.sh');
    const common = [
      '--kind', 'feedback', '--source', 'orchestrator',
      '--orchestrator-url', `http://127.0.0.1:${port}`,
      '--worker-id', 'unconfigured-feedback-worker', 'run-next',
    ];
    const missingExecutor = await runAgentq([...common, '--json']);
    assert.notEqual(missingExecutor.exitCode, 0);
    assert.match(missingExecutor.stderr, /feedback workers require --executor or --cua/);

    const missingModel = await runAgentq([...common, '--executor', executor, '--json']);
    assert.notEqual(missingModel.exitCode, 0);
    assert.match(missingModel.stderr, /feedback workers require --model/);

    const missingSandbox = await runAgentq([...common, '--executor', executor, '--model', 'test-model', '--json']);
    assert.notEqual(missingSandbox.exitCode, 0);
    assert.match(missingSandbox.stderr, /feedback workers require --sandbox/);

    const task = await fetchJSON(`/api/tasks/${create.data.id}`, { port });
    assert.equal(task.data.status, 'pending');
    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM workers').get().count, 0);
  } finally {
    await closeServer({ server, db });
  }
});

test('drain --source orchestrator processes tasks until the queue is empty', async () => {
  const { server, db, port, root } = await makeTestServer();
  try {
    const repo = path.join(root, 'repo');
    fs.mkdirSync(repo, { recursive: true });

    for (const issue of [1, 2]) {
      const res = await fetchJSON('/api/tasks', {
        port,
        method: 'POST',
        body: {
          kind: 'github_issue',
          repo,
          issue_num: issue,
          base_branch: 'main',
          model: 'test-model',
          trust_level: 'trusted_agent',
        },
      });
      assert.equal(res.status, 201);
    }

    const executor = makeExecutor(root, `#!/usr/bin/env bash
set -euo pipefail
${emitResult(root, resultPayload({ worktree: path.join(root, 'wt'), branch: 'agentq/job-1' }))}
`);

    const result = await runAgentq([
      '--source', 'orchestrator',
      '--orchestrator-url', `http://127.0.0.1:${port}`,
      '--worker-id', 'test-worker-2',
      'drain',
      '--executor', executor,
      '--json',
    ]);

    assert.equal(result.exitCode, 0, `agentq exited non-zero: ${JSON.stringify(result)}`);
    const summary = JSON.parse(result.stdout);
    assert.equal(summary.ran, 2);
    assert.equal(summary.succeeded, 2);

    const tasks = await fetchJSON('/api/tasks?status=succeeded', { port });
    assert.equal(tasks.data.length, 2);
  } finally {
    await closeServer({ server, db });
  }
});

test('parallel orchestrator drain revisits tasks blocked by running dependencies', async () => {
  const { server, db, port, root } = await makeTestServer();
  try {
    const repo = path.join(root, 'repo');
    fs.mkdirSync(repo, { recursive: true });
    const first = await fetchJSON('/api/tasks', {
      port,
      method: 'POST',
      body: {
        kind: 'github_issue', repo, issue_num: 1, base_branch: 'main',
        model: 'test-model', trust_level: 'trusted_agent',
      },
    });
    assert.equal(first.status, 201);
    const second = await fetchJSON('/api/tasks', {
      port,
      method: 'POST',
      body: {
        kind: 'github_issue', repo, issue_num: 2, base_branch: 'main',
        model: 'test-model', trust_level: 'trusted_agent', depends_on: [first.data.id],
      },
    });
    assert.equal(second.status, 201);

    const executor = makeExecutor(root, `#!/usr/bin/env bash
set -euo pipefail
sleep 0.05
${emitResult(root, resultPayload())}
`);
    const result = await runAgentq([
      '--source', 'orchestrator',
      '--orchestrator-url', `http://127.0.0.1:${port}`,
      '--worker-id', 'parallel-dependency-worker',
      'drain', '--parallel', '2', '--executor', executor, '--json',
    ]);

    assert.equal(result.exitCode, 0, `agentq exited non-zero: ${JSON.stringify(result)}`);
    const summary = JSON.parse(result.stdout);
    assert.equal(summary.succeeded, 2);
    const tasks = await fetchJSON('/api/tasks?status=succeeded', { port });
    assert.equal(tasks.data.length, 2);
  } finally {
    await closeServer({ server, db });
  }
});

test('run-next --source orchestrator sends auth token when configured', async () => {
  const authToken = 'secret-token-123';
  const { server, db, port, root } = await makeTestServer(authToken);
  try {
    const repo = path.join(root, 'repo');
    fs.mkdirSync(repo, { recursive: true });

    const create = await fetchJSON('/api/tasks', {
      port,
      method: 'POST',
      body: {
        kind: 'github_issue',
        repo,
        issue_num: 7,
        base_branch: 'main',
        model: 'test-model',
        trust_level: 'trusted_agent',
      },
      authToken,
    });
    assert.equal(create.status, 201);
    const taskId = create.data.id;

    const executor = makeExecutor(root, `#!/usr/bin/env bash
${emitResult(root, resultPayload({ branch: 'agentq/job-7' }))}
`);

    const result = await runAgentq([
      '--source', 'orchestrator',
      '--orchestrator-url', `http://127.0.0.1:${port}`,
      '--worker-id', 'test-worker-3',
      '--auth-token', authToken,
      'run-next',
      '--executor', executor,
      '--json',
    ]);

    assert.equal(result.exitCode, 0, `agentq exited non-zero: ${JSON.stringify(result)}`);
    assert.deepEqual(JSON.parse(result.stdout), { id: taskId, status: 'succeeded', exitCode: 0 });

    const task = await fetchJSON(`/api/tasks/${taskId}`, { port, authToken });
    assert.equal(task.data.status, 'succeeded');
  } finally {
    await closeServer({ server, db });
  }
});

test('enqueue --source orchestrator creates a pending task', async () => {
  const { server, db, port, root } = await makeTestServer();
  try {
    const repo = path.join(root, 'repo');
    fs.mkdirSync(repo, { recursive: true });

    const result = await runAgentq([
      '--source', 'orchestrator',
      '--orchestrator-url', `http://127.0.0.1:${port}`,
      '--worker-id', 'test-worker-4',
      'enqueue',
      '--repo', repo,
      '--issue', '100',
      '--model', 'test-model',
      '--json',
    ]);

    assert.equal(result.exitCode, 0, `agentq exited non-zero: ${JSON.stringify(result)}`);
    const out = JSON.parse(result.stdout);
    assert.ok(out.id);
    assert.equal(out.status, 'pending_approval');

    const task = await fetchJSON(`/api/tasks/${out.id}`, { port });
    assert.equal(task.data.status, 'pending');
    assert.equal(task.data.approval_required, 1);
    assert.equal(task.data.repo, repo);
    assert.equal(task.data.issue_num, 100);
    assert.equal(task.data.base_branch, 'master');
    assert.equal(task.data.provider, null);
  } finally {
    await closeServer({ server, db });
  }
});

test('enqueue --source orchestrator --trusted creates a runnable task', async () => {
  const { server, db, port, root } = await makeTestServer();
  try {
    const repo = path.join(root, 'repo');
    fs.mkdirSync(repo, { recursive: true });

    const enqueue = await runAgentq([
      '--source', 'orchestrator',
      '--orchestrator-url', `http://127.0.0.1:${port}`,
      '--worker-id', 'test-worker-5',
      'enqueue',
      '--repo', repo,
      '--issue', '101',
      '--model', 'test-model',
      '--trusted',
      '--json',
    ]);

    assert.equal(enqueue.exitCode, 0, `agentq exited non-zero: ${JSON.stringify(enqueue)}`);
    const { id: taskId } = JSON.parse(enqueue.stdout);

    const task = await fetchJSON(`/api/tasks/${taskId}`, { port });
    assert.equal(task.data.status, 'pending');
    assert.equal(task.data.approval_required, 0);

    const executor = makeExecutor(root, `#!/usr/bin/env bash
${emitResult(root, resultPayload({ branch: 'agentq/job-101' }))}
`);

    const run = await runAgentq([
      '--source', 'orchestrator',
      '--orchestrator-url', `http://127.0.0.1:${port}`,
      '--worker-id', 'test-worker-6',
      'run-next',
      '--executor', executor,
      '--json',
    ]);

    assert.equal(run.exitCode, 0, `agentq exited non-zero: ${JSON.stringify(run)}`);
    assert.deepEqual(JSON.parse(run.stdout), { id: taskId, status: 'succeeded', exitCode: 0 });

    const completed = await fetchJSON(`/api/tasks/${taskId}`, { port });
    assert.equal(completed.data.status, 'succeeded');
  } finally {
    await closeServer({ server, db });
  }
});

test('server-side auto model resolution resolves at claim time', async () => {
  const { server, db, port, root } = await makeTestServer();
  try {
    const repo = path.join(root, 'repo');
    fs.mkdirSync(repo, { recursive: true });

    const enqueue = await runAgentq([
      '--source', 'orchestrator',
      '--orchestrator-url', `http://127.0.0.1:${port}`,
      '--worker-id', 'test-worker-7',
      'enqueue',
      '--repo', repo,
      '--issue', '102',
      '--model', 'auto',
      '--trusted',
      '--json',
    ]);

    assert.equal(enqueue.exitCode, 0, `agentq exited non-zero: ${JSON.stringify(enqueue)}`);
    const { id: taskId } = JSON.parse(enqueue.stdout);

    const before = await fetchJSON(`/api/tasks/${taskId}`, { port });
    assert.equal(before.data.model, 'auto');

    const seenModel = path.join(root, 'model.txt');
    const executor = makeExecutor(root, `#!/usr/bin/env bash
set -euo pipefail
echo "$2" > ${JSON.stringify(seenModel)}
${emitResult(root, resultPayload({ branch: 'agentq/job-102' }))}
`);

    const run = await runAgentq([
      '--source', 'orchestrator',
      '--orchestrator-url', `http://127.0.0.1:${port}`,
      '--worker-id', 'test-worker-10',
      'run-next',
      '--executor', executor,
      '--json',
    ]);

    assert.equal(run.exitCode, 0, `agentq exited non-zero: ${JSON.stringify(run)}`);

    const after = await fetchJSON(`/api/tasks/${taskId}`, { port });
    assert.equal(after.data.model, CHEAP_MODEL);
    assert.equal(after.data.provider, 'mistral');
    assert.equal(fs.readFileSync(seenModel, 'utf8').trim(), CHEAP_MODEL);
  } finally {
    await closeServer({ server, db });
  }
});

test('run-next --source orchestrator reports executor failure to the server', async () => {
  const { server, db, port, root } = await makeTestServer();
  try {
    const repo = path.join(root, 'repo');
    fs.mkdirSync(repo, { recursive: true });

    const create = await fetchJSON('/api/tasks', {
      port,
      method: 'POST',
      body: {
        kind: 'github_issue',
        repo,
        issue_num: 9,
        base_branch: 'main',
        model: 'test-model',
        trust_level: 'trusted_agent',
        max_attempts: 1, // exhaust retries on the first failure for this test
      },
    });
    assert.equal(create.status, 201);
    const taskId = create.data.id;

    const executor = makeExecutor(root, `#!/usr/bin/env bash
echo boom
exit 7
`);

    const result = await runAgentq([
      '--source', 'orchestrator',
      '--orchestrator-url', `http://127.0.0.1:${port}`,
      '--worker-id', 'test-worker-8',
      'run-next',
      '--executor', executor,
      '--json',
    ]);

    assert.equal(result.exitCode, 7, `agentq exited unexpectedly: ${JSON.stringify(result)}`);
    let out;
    try {
      out = JSON.parse(result.stdout);
    } catch (parseErr) {
      assert.fail(`run-next --json output was not parseable JSON (exit=${result.exitCode} stdout=${JSON.stringify(result.stdout)} stderr=${JSON.stringify(result.stderr)}): ${parseErr.message}`);
    }
    assert.equal(out.status, 'failed');
    assert.equal(out.exitCode, 7);

    const task = await fetchJSON(`/api/tasks/${taskId}`, { port });
    assert.equal(task.data.status, 'failed');
    assert.equal(task.data.attempts, 1);
  } finally {
    await closeServer({ server, db });
  }
});

test('run-next --source orchestrator releases the claim when the trust gate refuses, instead of stranding it running', async () => {
  const { server, db, port, root } = await makeTestServer();
  try {
    const repo = path.join(root, 'repo');
    fs.mkdirSync(repo, { recursive: true });

    // trust_level 'agent' (not 'trusted_agent') with approval_required
    // explicitly 0: immediately claimable, but execute.js's trust gate will
    // refuse it since no --sandbox/--allow-untrusted is passed below.
    const create = await fetchJSON('/api/tasks', {
      port,
      method: 'POST',
      body: {
        kind: 'github_issue',
        repo,
        issue_num: 13,
        base_branch: 'main',
        model: 'test-model',
        trust_level: 'agent',
        approval_required: 0,
      },
    });
    assert.equal(create.status, 201);
    const taskId = create.data.id;

    const executor = makeExecutor(root, `#!/usr/bin/env bash
echo "should never run"
`);

    const result = await runAgentq([
      '--source', 'orchestrator',
      '--orchestrator-url', `http://127.0.0.1:${port}`,
      '--worker-id', 'test-worker-9',
      'run-next',
      '--executor', executor,
      '--json',
    ]);

    assert.notEqual(result.exitCode, 0, `expected agentq to refuse the untrusted job: ${JSON.stringify(result)}`);
    assert.match(result.stderr, /Refusing untrusted job/);

    // The task must not be stranded 'running' — it should be released as failed.
    const task = await fetchJSON(`/api/tasks/${taskId}`, { port });
    assert.equal(task.data.status, 'failed');
    const taskResult = typeof task.data.result === 'string' ? JSON.parse(task.data.result) : task.data.result;
    assert.match(taskResult.error, /Refusing untrusted job/);
  } finally {
    await closeServer({ server, db });
  }
});

test('drain --source orchestrator returns idle when the queue is empty', async () => {
  const { server, db, port, root } = await makeTestServer();
  try {
    const executor = makeExecutor(root, `#!/usr/bin/env bash\necho ok\n`);

    const result = await runAgentq([
      '--source', 'orchestrator',
      '--orchestrator-url', `http://127.0.0.1:${port}`,
      '--worker-id', 'test-worker-9',
      'drain',
      '--executor', executor,
      '--json',
    ]);

    assert.equal(result.exitCode, 0, `agentq exited non-zero: ${JSON.stringify(result)}`);
    assert.deepEqual(JSON.parse(result.stdout), { status: 'drained', ran: 0, succeeded: 0, failed: 0, unverified: 0 });
  } finally {
    await closeServer({ server, db });
  }
});

test('administrative commands fail loudly for --source orchestrator instead of silently touching the local queue', async () => {
  const { server, db, port, root } = await makeTestServer();
  const localDb = path.join(root, 'local-queue.sqlite');
  try {
    for (const args of [['status'], ['requeue', '--id', '1'], ['recover'], ['prune'], ['cancel', '--id', '1']]) {
      const result = await runAgentq([
        '--source', 'orchestrator',
        '--orchestrator-url', `http://127.0.0.1:${port}`,
        '--worker-id', 'test-worker-guard',
        '--db', localDb, // a local path that must NOT get silently read/written
        ...args,
      ]);
      assert.notEqual(result.exitCode, 0, `expected '${args[0]}' to fail for --source orchestrator: ${JSON.stringify(result)}`);
      assert.match(result.stderr, /not implemented for --source orchestrator/);
      assert.equal(fs.existsSync(localDb), false, `'${args[0]}' must not touch the local queue file`);
    }
  } finally {
    await closeServer({ server, db });
  }
});

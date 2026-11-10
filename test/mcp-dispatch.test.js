'use strict';

/**
 * MCP dispatch: `dispatch_task` (a detached `agentq run --id` worker) and
 * `dispatch_status` (task state + worker liveness + log tail).
 *
 * The unit tests inject a spawn function, so no real executor is ever started.
 * The integration tests spawn the real binary to cover the flag wiring and the
 * read/write split.
 */

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { after, test } = require('node:test');

const {
  buildDispatchTools,
  parseDispatchFlags,
  dispatchWorkerId,
  dispatchClaimPrefix,
  isDispatchClaim,
  DEFAULT_DISPATCH_MAX,
  MAX_LOG_TAIL_BYTES,
} = require('../src/interfaces/mcp/dispatch.js');
const { createMcpServer } = require('../src/interfaces/mcp/protocol.js');
const { openDb, initSchema, createTask, getTask } = require('../src/queue/db.js');
const { snapshotForIssue } = require('./helpers/pinned-issue.js');

const ROOT = path.join(__dirname, '..');
const BIN = path.join(ROOT, 'bin', 'agentq-mcp.js');

const CATALOG = [
  {
    id: 'gpt-5', path: 'codex', harness: 'pi', modelKey: 'gpt-5', intelligence: 60, costPerMTok: 3,
    scored: true, subscription: { state: 'active', ids: ['codex'], endDate: null },
  },
  {
    id: 'unscored-model', path: 'codex', harness: 'pi', modelKey: null, intelligence: null,
    costPerMTok: null, scored: false, subscription: { state: 'active', ids: ['codex'], endDate: null },
  },
  {
    id: 'old-model', path: 'legacy', harness: 'pi', modelKey: 'old', intelligence: 50, costPerMTok: 1,
    scored: true, subscription: { state: 'ended', ids: ['legacy'], endDate: '20260131' },
  },
  {
    id: 'unfunded-model', path: 'ghost', harness: 'pi', modelKey: 'ghost', intelligence: 50, costPerMTok: 1,
    scored: true, subscription: null,
  },
];

const CAPACITY = [
  { path: 'codex', state: 'available', headroomPct: 62, resetsAt: null, observedAt: '2026-11-08T10:00:00Z', stale: false, reason: null },
  { path: 'legacy', state: 'saturated', headroomPct: 0, resetsAt: null, observedAt: '2026-11-08T10:00:00Z', stale: false, reason: null },
];

const LIVE = new Set([9001, 9002, 9003]);

/** A dispatchable task: trusted, approved-not-required, valid pinned input. */
function trustedTask(overrides = {}) {
  return {
    id: 't1',
    kind: 'github_issue',
    status: 'pending',
    issue_num: 7,
    prompt: JSON.stringify(snapshotForIssue(7)),
    model: 'gpt-5',
    trust_level: 'trusted_agent',
    approval_required: 0,
    approved_by: null,
    ...overrides,
  };
}

/**
 * @param {Record<string, any>} [overrides]
 */
function fakeDeps(overrides = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentq-dispatch-'));
  const calls = { spawn: [], recommend: [], blocking: [], workers: 0, events: [] };
  const deps = {
    getTask: () => trustedTask(),
    getCatalog: () => CATALOG,
    getCapacity: () => CAPACITY,
    recommend: (options) => {
      calls.recommend.push(options);
      return {
        options: [{ id: 'gpt-5', path: 'codex', roles: ['cheapest', 'smartest'] }],
        default: { id: 'gpt-5', path: 'codex' },
        choices: [{ id: 'gpt-5' }],
        rejected: [],
      };
    },
    recordTaskEvent: (taskId, event, payload) => {
      calls.events.push({ taskId, event, payload });
    },
    blockingDependencies: (id) => {
      calls.blocking.push(id);
      return [];
    },
    dispatchWorkers: () => {
      calls.workers += 1;
      return [];
    },
    localTaskSources: () => ['cli', 'agentq'],
    spawn: (command, args, options) => {
      calls.spawn.push({ command, args, options });
      return { pid: 9001, unref() { calls.spawn.at(-1).unref = true; }, on() {} };
    },
    cliPath: path.join(ROOT, 'src', 'agentq', 'agentq.js'),
    dbPath: path.join(dir, 'queue.sqlite'),
    logsDir: path.join(dir, 'logs'),
    pidAlive: (pid) => LIVE.has(pid),
    now: () => 1700000000000,
    hostname: 'testhost',
    workerPid: 4242,
    ...overrides,
  };
  return { deps, calls, dir };
}

/** @param {string} name */
function tool(name, deps) {
  const entry = buildDispatchTools(deps).find((candidate) => candidate.name === name);
  assert.ok(entry, `missing dispatch tool ${name}`);
  return entry;
}

/** Both dispatch tools over ONE shared registry, as the server builds them. */
function tools(deps) {
  const built = buildDispatchTools(deps);
  return {
    dispatch: built.find((entry) => entry.name === 'dispatch_task'),
    status: built.find((entry) => entry.name === 'dispatch_status'),
  };
}

after(() => {
  for (const entry of fs.readdirSync(os.tmpdir())) {
    if (entry.startsWith('agentq-dispatch-')) {
      fs.rmSync(path.join(os.tmpdir(), entry), { recursive: true, force: true });
    }
  }
});

// --- server flags ---

test('dispatch flags default to no boundary, no unrouted override, and a cap of two', () => {
  const { options, rest } = parseDispatchFlags([]);
  assert.deepEqual(options, {
    sandbox: null, verify: null, allowUntrusted: false, allowUnrouted: false, max: DEFAULT_DISPATCH_MAX,
  });
  assert.deepEqual(rest, []);
});

test('dispatch flags are parsed out and leave other arguments alone', () => {
  const { options, rest } = parseDispatchFlags([
    '--allow-write',
    '--dispatch-sandbox', '/usr/local/bin/wrap',
    '--dispatch-verify', 'npm test',
    '--dispatch-allow-untrusted',
    '--dispatch-allow-unrouted',
    '--dispatch-max', '5',
  ]);
  assert.equal(options.sandbox, '/usr/local/bin/wrap');
  assert.equal(options.verify, 'npm test');
  assert.equal(options.allowUntrusted, true);
  assert.equal(options.allowUnrouted, true);
  assert.equal(options.max, 5);
  assert.deepEqual(rest, ['--allow-write']);
});

test('dispatch flags reject a missing value and an invalid cap', () => {
  assert.throws(() => parseDispatchFlags(['--dispatch-sandbox']), /Missing value for --dispatch-sandbox/);
  assert.throws(() => parseDispatchFlags(['--dispatch-verify', '--dispatch-max', '2']), /Missing value for --dispatch-verify/);
  assert.throws(() => parseDispatchFlags(['--dispatch-max', '0']), /between 1 and/);
  assert.throws(() => parseDispatchFlags(['--dispatch-max', 'many']), /between 1 and/);
});

test('the dispatch worker id carries the marker the queue cap counts', () => {
  assert.equal(dispatchWorkerId({ hostname: 'host', pid: 7 }), 'local-host-dispatch-7');
});

test('dispatch claim identity is anchored to this host', () => {
  assert.equal(dispatchClaimPrefix('host'), 'local-host-dispatch-');
  assert.equal(dispatchWorkerId({ hostname: 'host', pid: 42 }), 'local-host-dispatch-42');
  assert.equal(isDispatchClaim('local-host-dispatch-42', 'host'), true);
  // Another host, a non-numeric suffix, a plain local worker and junk are not
  // this host's dispatch claims.
  assert.equal(isDispatchClaim('local-otherhost-dispatch-42', 'host'), false);
  assert.equal(isDispatchClaim('local-host-dispatch-abc', 'host'), false);
  assert.equal(isDispatchClaim('local-host-42', 'host'), false);
  assert.equal(isDispatchClaim('local-host-dispatch-', 'host'), false);
  assert.equal(isDispatchClaim(null, 'host'), false);
});

// --- dispatch_task: task eligibility ---

test('dispatch_task refuses a task that does not exist', () => {
  const { deps } = fakeDeps({ getTask: () => undefined });
  assert.throws(() => tool('dispatch_task', deps).handler({ id: 'missing' }), /Task not found: missing/);
});

test('dispatch_task refuses a task that is not pending', () => {
  const { deps } = fakeDeps({ getTask: () => trustedTask({ status: 'running' }) });
  assert.throws(() => tool('dispatch_task', deps).handler({ id: 't1' }), /is running, not pending/);
});

test('dispatch_task refuses a task awaiting human approval and one that was rejected', () => {
  const pending = fakeDeps({
    getTask: () => trustedTask({ trust_level: 'untrusted', approval_required: 1 }),
  }).deps;
  assert.throws(() => tool('dispatch_task', pending).handler({ id: 't1' }), /waiting for human approval/);

  const rejected = fakeDeps({
    getTask: () => trustedTask({ status: 'rejected', approval_required: 1 }),
  }).deps;
  assert.throws(() => tool('dispatch_task', rejected).handler({ id: 't1' }), /rejected/);

  const approved = fakeDeps({
    getTask: () => trustedTask({ trust_level: 'untrusted', approval_required: 1, approved_by: 'human' }),
  });
  // Approved but untrusted: the boundary still decides (see the admission test).
  assert.throws(() => tool('dispatch_task', approved.deps).handler({ id: 't1' }), /Refusing untrusted job/);
});

test('dispatch_task refuses a task kind the spawned worker cannot claim', () => {
  const { deps } = fakeDeps({ getTask: () => trustedTask({ kind: 'prompt', issue_num: null, prompt: 'do it' }) });
  assert.throws(() => tool('dispatch_task', deps).handler({ id: 't1' }), /is kind 'prompt'.*github_issue.*only/);
});

test('dispatch_task takes no boundary arguments from the client', () => {
  const { deps } = fakeDeps();
  const entry = tool('dispatch_task', deps);
  for (const extra of ['sandbox', 'verify', 'executor', 'allow_untrusted', 'trust', 'trusted', 'allow_unrouted']) {
    assert.throws(() => entry.handler({ id: 't1', [extra]: 'x' }), /Unknown argument/, extra);
  }
});

// --- dispatch_task: pre-checks (no false "dispatched") ---

test('dispatch_task runs admission with the server boundary before spawning', () => {
  const untrusted = () => trustedTask({ trust_level: 'untrusted' });

  const noBoundary = fakeDeps({ getTask: untrusted });
  assert.throws(() => tool('dispatch_task', noBoundary.deps).handler({ id: 't1' }), /Refusing untrusted job/);
  assert.equal(noBoundary.calls.spawn.length, 0);

  const sandboxed = fakeDeps({ getTask: untrusted, sandbox: '/usr/local/bin/wrap' });
  assert.equal(tool('dispatch_task', sandboxed.deps).handler({ id: 't1' }).dispatched, true);

  const overridden = fakeDeps({ getTask: untrusted, allowUntrusted: true });
  assert.equal(tool('dispatch_task', overridden.deps).handler({ id: 't1' }).dispatched, true);
});

test('dispatch_task refuses a task with unsatisfied dependencies, listing them', () => {
  const { deps, calls } = fakeDeps({
    blockingDependencies: () => [
      { id: 'aaaaaaaa-1111', status: 'pending' },
      { id: 'bbbbbbbb-2222', status: 'failed' },
    ],
  });
  assert.throws(
    () => tool('dispatch_task', deps).handler({ id: 't1' }),
    /is blocked: dependencies not succeeded \(aaaaaaaa pending, bbbbbbbb failed\)/,
  );
  assert.equal(calls.spawn.length, 0);
});

test('dispatch_task refuses a task with no attempts left, before spawning', () => {
  const { deps, calls } = fakeDeps({
    getTask: () => trustedTask({ source: 'mcp', attempts: 3, max_attempts: 3 }),
  });
  assert.throws(
    () => tool('dispatch_task', deps).handler({ id: 't1' }),
    /has no attempts left \(3\/3\); requeue it to reset the budget/,
  );
  assert.equal(calls.spawn.length, 0);

  // A locally-owned task owns its retry policy, so the budget does not apply.
  const local = fakeDeps({ getTask: () => trustedTask({ source: 'cli', attempts: 3, max_attempts: 3 }) });
  assert.equal(tool('dispatch_task', local.deps).handler({ id: 't1' }).dispatched, true);

  // A task with no stored max_attempts uses the store's default (3).
  const noMax = fakeDeps({ getTask: () => trustedTask({ source: 'mcp', attempts: 3, max_attempts: 0 }) });
  assert.throws(() => tool('dispatch_task', noMax.deps).handler({ id: 't1' }), /has no attempts left \(3\/3\)/);
});

// --- dispatch_task: model resolution ---

test('dispatch_task respects a pinned model and does not pass --model', () => {
  const { deps, calls } = fakeDeps();
  const result = tool('dispatch_task', deps).handler({ id: 't1' });
  assert.equal(result.model, 'gpt-5');
  assert.equal(result.overrode, undefined);
  assert.ok(!calls.spawn[0].args.includes('--model'), calls.spawn[0].args.join(' '));
});

test('dispatch_task routes when the task has no pinned model or asks for auto', () => {
  const autoTask = fakeDeps({ getTask: () => trustedTask({ model: 'auto' }) });
  const routed = tool('dispatch_task', autoTask.deps).handler({ id: 't1', tier: 'big' });
  assert.equal(routed.model, 'gpt-5');
  assert.deepEqual(autoTask.calls.recommend, [{ tier: 'big' }]);
  assert.deepEqual(autoTask.calls.spawn[0].args.slice(-5), ['--model', 'gpt-5', '--tier', 'big', '--json']);

  const noModel = fakeDeps({ getTask: () => trustedTask({ model: null }) });
  assert.equal(tool('dispatch_task', noModel.deps).handler({ id: 't1' }).model, 'gpt-5');

  const explicitAuto = fakeDeps();
  assert.equal(tool('dispatch_task', explicitAuto.deps).handler({ id: 't1', model: 'auto' }).model, 'gpt-5');
  assert.deepEqual(explicitAuto.calls.recommend.at(-1), { tier: 'medium' });
});

test('dispatch_task defaults the tier to the one stored at enqueue', () => {
  const stored = fakeDeps({
    getTask: () => trustedTask({ model: 'auto', routing_policy: JSON.stringify({ tier: 'big' }) }),
  });
  tool('dispatch_task', stored.deps).handler({ id: 't1' });
  assert.deepEqual(stored.calls.recommend, [{ tier: 'big' }]);
  assert.equal(stored.calls.events.find((entry) => entry.event === 'model-chosen').payload.tier, 'big');

  // An explicit argument still wins over the stored policy.
  const explicit = fakeDeps({
    getTask: () => trustedTask({ model: 'auto', routing_policy: JSON.stringify({ tier: 'big' }) }),
  });
  tool('dispatch_task', explicit.deps).handler({ id: 't1', tier: 'small' });
  assert.deepEqual(explicit.calls.recommend, [{ tier: 'small' }]);
});

test('dispatch_task refuses "auto" when routing finds no eligible model, with reasons', () => {
  const { deps } = fakeDeps({
    getTask: () => trustedTask({ model: 'auto' }),
    recommend: () => ({
      options: [],
      default: null,
      choices: [],
      rejected: [
        { id: 'gpt-5', reasons: ['intelligence 20 below floor 38'] },
        { id: 'old-model', reasons: ['subscription ended'] },
      ],
    }),
  });
  assert.throws(
    () => tool('dispatch_task', deps).handler({ id: 't1', model: 'auto' }),
    /no eligible model for tier "medium": gpt-5: intelligence 20 below floor 38, old-model: subscription ended/,
  );
});

test('dispatch_task refuses an explicit model that is not a runnable', () => {
  const { deps } = fakeDeps();
  assert.throws(
    () => tool('dispatch_task', deps).handler({ id: 't1', model: 'not-a-runnable' }),
    /not a runnable in the catalog/,
  );
});

test('dispatch_task refuses an explicit model whose subscription is not active or unknown', () => {
  const { deps } = fakeDeps();
  assert.throws(
    () => tool('dispatch_task', deps).handler({ id: 't1', model: 'old-model' }),
    /not runnable: subscription ended \(legacy\)/,
  );
  assert.throws(
    () => tool('dispatch_task', deps).handler({ id: 't1', model: 'unfunded-model' }),
    /not runnable: subscription unknown/,
  );
});

test('dispatch_task refuses an explicit model on a saturated or unknown capacity path', () => {
  const saturated = fakeDeps({ getTask: () => trustedTask({ model: 'auto' }) });
  assert.throws(
    () => tool('dispatch_task', saturated.deps).handler({ id: 't1', model: 'old-model' }),
    /subscription ended/,
  );

  // An active subscription on a path with no quota data fails closed.
  const unknownCapacity = fakeDeps({
    getCatalog: () => [
      ...CATALOG,
      {
        id: 'unmeasured-model', path: 'unmeasured', harness: 'pi', modelKey: 'unmeasured', intelligence: 55,
        costPerMTok: 2, scored: true, subscription: { state: 'active', ids: ['unmeasured'], endDate: null },
      },
    ],
  });
  assert.throws(
    () => tool('dispatch_task', unknownCapacity.deps).handler({ id: 't1', model: 'unmeasured-model' }),
    /not dispatchable: capacity unknown: no quota data \(start the server with --dispatch-allow-unrouted/,
  );

  // A saturated path is refused with the routing core's reason.
  const saturatedPath = fakeDeps({
    getCatalog: () => [
      ...CATALOG,
      {
        id: 'busy-model', path: 'legacy', harness: 'pi', modelKey: 'busy', intelligence: 55,
        costPerMTok: 2, scored: true, subscription: { state: 'active', ids: ['legacy'], endDate: null },
      },
    ],
  });
  assert.throws(
    () => tool('dispatch_task', saturatedPath.deps).handler({ id: 't1', model: 'busy-model' }),
    /not dispatchable: capacity saturated: 0% headroom \(start the server with --dispatch-allow-unrouted/,
  );
});

test('dispatch_task --dispatch-allow-unrouted accepts a model with unknown capacity', () => {
  const { deps } = fakeDeps({
    allowUnrouted: true,
    getCatalog: () => [
      ...CATALOG,
      {
        id: 'unmeasured-model', path: 'unmeasured', harness: 'pi', modelKey: 'unmeasured', intelligence: 55,
        costPerMTok: 2, scored: true, subscription: { state: 'active', ids: ['unmeasured'], endDate: null },
      },
    ],
  });
  assert.equal(tool('dispatch_task', deps).handler({ id: 't1', model: 'unmeasured-model' }).model, 'unmeasured-model');
});

test('dispatch_task accepts an unscored runnable on an available path', () => {
  const { deps } = fakeDeps();
  assert.equal(tool('dispatch_task', deps).handler({ id: 't1', model: 'unscored-model' }).model, 'unscored-model');
});

test('dispatch_task reports the pin an explicit model overrides', () => {
  const { deps } = fakeDeps();
  const result = tool('dispatch_task', deps).handler({ id: 't1', model: 'unscored-model' });
  assert.equal(result.model, 'unscored-model');
  assert.equal(result.overrode, 'gpt-5');

  const same = tool('dispatch_task', fakeDeps().deps).handler({ id: 't1', model: 'gpt-5' });
  assert.equal(same.overrode, undefined);
});

test('dispatch_task refuses a pinned model that is no longer dispatchable', () => {
  const { deps } = fakeDeps({ getTask: () => trustedTask({ model: 'old-model' }) });
  assert.throws(() => tool('dispatch_task', deps).handler({ id: 't1' }), /subscription ended/);
});

// --- dispatch_task: model-choice audit ---

test('dispatch_task records how the model was chosen, with its shortlist roles', () => {
  // Pinned: the task already names a model, so nothing is routed.
  const pinned = fakeDeps();
  tool('dispatch_task', pinned.deps).handler({ id: 't1' });
  assert.deepEqual(pinned.calls.events, [{
    taskId: 't1',
    event: 'model-chosen',
    payload: { model: 'gpt-5', tier: 'medium', chosenBy: 'pinned', roles: [], dataSharing: false },
  }]);
  assert.equal(pinned.calls.recommend.length, 0, 'a pin is not re-routed');

  // Caller: an explicit model overrides the pin. Off the shortlist: no roles.
  const caller = fakeDeps();
  tool('dispatch_task', caller.deps).handler({ id: 't1', model: 'unscored-model' });
  assert.deepEqual(caller.calls.events[0].payload, {
    model: 'unscored-model', tier: 'medium', chosenBy: 'caller', roles: [], dataSharing: false,
  });

  // Caller picks an option from the shortlist: its roles are logged.
  const fromList = fakeDeps({ getTask: () => trustedTask({ model: 'auto' }) });
  tool('dispatch_task', fromList.deps).handler({ id: 't1', model: 'gpt-5' });
  assert.deepEqual(fromList.calls.events[0].payload, {
    model: 'gpt-5', tier: 'medium', chosenBy: 'caller', roles: ['cheapest', 'smartest'], dataSharing: false,
  });

  // A routing failure never blocks a caller-chosen dispatch.
  const broken = fakeDeps({ recommend: () => { throw new Error('no catalog'); } });
  tool('dispatch_task', broken.deps).handler({ id: 't1', model: 'gpt-5' });
  assert.deepEqual(broken.calls.events[0].payload, {
    model: 'gpt-5', tier: 'medium', chosenBy: 'caller', roles: [], dataSharing: false,
  });

  // Auto: the routing core decides, and its shortlist says what the model is for.
  const auto = fakeDeps({ getTask: () => trustedTask({ model: 'auto' }) });
  tool('dispatch_task', auto.deps).handler({ id: 't1', tier: 'big' });
  assert.deepEqual(auto.calls.events[0].payload, {
    model: 'gpt-5', tier: 'big', chosenBy: 'auto', roles: ['cheapest', 'smartest'], dataSharing: false,
  });
});

test('dispatch_task logs dataSharing and never blocks an explicit caller model on it', () => {
  // The price entry says the provider may retain prompts. An explicit caller
  // model is the caller's decision, so it dispatches — and the audit trail
  // records what was sent where.
  const shared = { ...CATALOG[0], dataSharing: true };
  const caller = fakeDeps({ getCatalog: () => [shared, ...CATALOG.slice(1)] });
  tool('dispatch_task', caller.deps).handler({ id: 't1', model: 'gpt-5' });
  assert.equal(caller.calls.events[0].payload.dataSharing, true);

  // A pin carries the same fact.
  const pinned = fakeDeps({
    getCatalog: () => [shared, ...CATALOG.slice(1)],
    getTask: () => trustedTask({ model: 'gpt-5' }),
  });
  tool('dispatch_task', pinned.deps).handler({ id: 't1' });
  assert.equal(pinned.calls.events[0].payload.dataSharing, true);

  // Auto routing reports what the routing core chose.
  const auto = fakeDeps({
    getTask: () => trustedTask({ model: 'auto' }),
    recommend: () => ({
      options: [{ id: 'gpt-5', path: 'codex', roles: ['cheapest'], dataSharing: true }],
      default: { id: 'gpt-5', path: 'codex', dataSharing: true },
      choices: [{ id: 'gpt-5' }],
      rejected: [],
    }),
  });
  tool('dispatch_task', auto.deps).handler({ id: 't1' });
  assert.equal(auto.calls.events[0].payload.dataSharing, true);
});

test('dispatch_task reports a store failure instead of failing a running dispatch', () => {
  const { deps } = fakeDeps({
    recordTaskEvent: () => {
      throw new Error('database is locked');
    },
  });
  const written = [];
  const original = process.stderr.write;
  process.stderr.write = (chunk) => {
    written.push(String(chunk));
    return true;
  };
  let result;
  try {
    result = tool('dispatch_task', deps).handler({ id: 't1' });
  } finally {
    process.stderr.write = original;
  }
  assert.equal(result.dispatched, true, 'the worker is already running');
  assert.match(written.join(''), /could not record the model choice for t1: database is locked/);
});

// --- dispatch_task: spawn ---

test('dispatch_task spawns a detached agentq run --id with the dispatch worker id', () => {
  const { deps, calls, dir } = fakeDeps();
  const result = tool('dispatch_task', deps).handler({ id: 'abcdef12-3456-7890-abcd-ef1234567890' });

  assert.deepEqual(result, {
    dispatched: true,
    id: 'abcdef12-3456-7890-abcd-ef1234567890',
    model: 'gpt-5',
    path: deps.cliPath,
    pid: 9001,
    log: path.join(dir, 'logs', 'dispatch-abcdef12-1700000000000.log'),
  });

  const [call] = calls.spawn;
  assert.equal(call.command, process.execPath);
  assert.deepEqual(call.args, [
    deps.cliPath, '--db', deps.dbPath, '--worker-id', 'local-testhost-dispatch-4242',
    'run', '--id', 'abcdef12-3456-7890-abcd-ef1234567890', '--tier', 'medium', '--json',
  ]);
  assert.equal(call.options.detached, true);
  assert.deepEqual(call.options.stdio.slice(0, 1), ['ignore']);
  assert.equal(call.unref, true);
  // The worker gets an explicit environment (it needs provider auth).
  assert.equal(call.options.env.PATH, process.env.PATH);
  assert.equal(call.options.env.HOME, process.env.HOME);

  // The log exists, is private, and its directory is private too.
  const stat = fs.statSync(result.log);
  assert.equal(stat.mode & 0o777, 0o600);
  assert.equal(fs.statSync(dir, { throwIfNoEntry: false }) ? fs.statSync(deps.logsDir).mode & 0o777 : 0o700, 0o700);
});

test('dispatch_task forwards only the server-side boundary flags', () => {
  const { deps, calls } = fakeDeps({
    sandbox: '/usr/local/bin/agentq-sandbox',
    verify: 'npm test',
    allowUntrusted: true,
  });
  tool('dispatch_task', deps).handler({ id: 't1', model: 'gpt-5' });
  assert.deepEqual(calls.spawn[0].args.slice(-10), [
    '--model', 'gpt-5',
    '--tier', 'medium',
    '--sandbox', '/usr/local/bin/agentq-sandbox',
    '--verify', 'npm test',
    '--allow-untrusted',
    '--json',
  ]);
});

test('dispatch_task sanitizes the task id in the log name', () => {
  const { deps } = fakeDeps();
  const result = tool('dispatch_task', deps).handler({ id: 'ab/cd:ef12' });
  assert.equal(path.basename(result.log), 'dispatch-ab_cd_ef-1700000000000.log');
});

test('dispatch_task refuses to reuse an existing log path or follow a symlink', () => {
  const existing = fakeDeps();
  fs.mkdirSync(existing.deps.logsDir, { recursive: true });
  fs.writeFileSync(path.join(existing.deps.logsDir, 'dispatch-t1-1700000000000.log'), 'pre-existing\n');
  assert.throws(() => tool('dispatch_task', existing.deps).handler({ id: 't1' }), /dispatch log already exists/);
  assert.equal(existing.calls.spawn.length, 0);

  if (fs.constants.O_NOFOLLOW) {
    const linked = fakeDeps();
    fs.mkdirSync(linked.deps.logsDir, { recursive: true });
    const target = path.join(linked.dir, 'target.log');
    fs.writeFileSync(target, 'do not touch\n');
    fs.symlinkSync(target, path.join(linked.deps.logsDir, 'dispatch-t1-1700000000000.log'));
    // O_EXCL refuses an existing path (a symlink included) and O_NOFOLLOW is
    // the second line of defence: either way the target is never opened.
    assert.throws(() => tool('dispatch_task', linked.deps).handler({ id: 't1' }), /dispatch log already exists|path is a symlink/);
    assert.equal(fs.readFileSync(target, 'utf8'), 'do not touch\n');
  }
});

test('dispatch_task reports a worker that never started instead of pretending', () => {
  const { deps } = fakeDeps({ spawn: () => ({ unref() {}, on() {} }) });
  const built = tools(deps);
  const result = built.dispatch.handler({ id: 't1' });

  assert.equal(result.dispatched, false);
  assert.equal(result.pid, null);
  assert.match(result.reason, /did not start/);
  assert.match(fs.readFileSync(result.log, 'utf8'), /did not start/);
  // No registry entry, so no slot is held and status has no record.
  const status = built.status.handler({ id: 't1' });
  assert.equal(status.dispatched, null);
  assert.equal(status.slot_held, false);
  assert.equal(status.worker_alive, false);
});

test('dispatch_task turns a synchronous spawn failure into a refusal and cleans up', () => {
  const { deps } = fakeDeps({
    spawn: () => {
      throw new Error('spawn EACCES');
    },
  });
  const entry = tool('dispatch_task', deps);
  assert.throws(() => entry.handler({ id: 't1' }), /could not start the dispatch worker: spawn EACCES/);
  // The just-created log is removed, and nothing was registered.
  const status = tool('dispatch_status', deps).handler({ id: 't1' });
  assert.equal(status.dispatched, null);
});

test('a spawn error after registration drops the record and reports on stderr', () => {
  const handlers = {};
  const { deps } = fakeDeps({
    spawn: () => ({ pid: 9001, unref() {}, on(event, callback) { handlers[event] = callback; } }),
  });
  const built = tools(deps);
  const { log } = built.dispatch.handler({ id: 't1' });
  assert.equal(built.status.handler({ id: 't1' }).dispatched.pid, 9001);

  const written = [];
  const original = process.stderr.write;
  process.stderr.write = (chunk) => {
    written.push(String(chunk));
    return true;
  };
  try {
    handlers.error(new Error('boom'));
  } finally {
    process.stderr.write = original;
  }
  assert.match(written.join(''), /dispatch of t1 failed: boom/);
  // The reason also lands in the dispatch log, which is what dispatch_status
  // shows the operator.
  assert.match(fs.readFileSync(log, 'utf8'), /dispatch worker failed to start: boom/);
  assert.equal(built.status.handler({ id: 't1' }).dispatched, null);
});

// --- dispatch_task: concurrency cap ---

test('dispatch_task counts running dispatch claims from the queue', () => {
  const { deps, calls } = fakeDeps({
    max: 2,
    dispatchWorkers: () => [
      { id: 'queued-one', claimed_by: 'local-host-dispatch-1' },
      { id: 'queued-two', claimed_by: 'local-host-dispatch-1' },
    ],
  });
  assert.throws(
    () => tool('dispatch_task', deps).handler({ id: 't1' }),
    /dispatch limit reached: 2\/2 workers running \(queued-o, queued-t\)/,
  );
  assert.equal(calls.spawn.length, 0);
});

test('dispatch_task refuses a task already running as a dispatch claim', () => {
  const { deps, calls } = fakeDeps({
    dispatchWorkers: () => [{ id: 't1', claimed_by: 'local-host-dispatch-1' }],
  });
  assert.throws(() => tool('dispatch_task', deps).handler({ id: 't1' }), /already dispatched/);
  assert.equal(calls.spawn.length, 0);
});

test('the cap unions queue claims with live pids without double counting', () => {
  const { deps } = fakeDeps({
    max: 2,
    dispatchWorkers: () => [{ id: 't1', claimed_by: 'local-host-dispatch-1' }],
  });
  const built = tools(deps);
  // t1 is in the queue AND in the registry: one slot, and it is already taken.
  assert.throws(() => built.dispatch.handler({ id: 't1' }), /already dispatched/);
  // A different task still fits in the remaining slot... and then the cap is full.
  assert.equal(built.dispatch.handler({ id: 'other-task' }).dispatched, true);
  assert.throws(() => built.dispatch.handler({ id: 'third-task' }), /dispatch limit reached: 2\/2/);
});

test('a starting worker holds its slot, and a finished task frees it', () => {
  const statuses = { a: 'pending', b: 'pending' };
  const { deps } = fakeDeps({
    max: 1,
    getTask: (id) => trustedTask({ id, status: statuses[id] ?? 'pending' }),
  });
  const built = tools(deps);
  // The spawn window: the worker has not claimed yet, but its slot is taken.
  built.dispatch.handler({ id: 'a' });
  assert.throws(() => built.dispatch.handler({ id: 'b' }), /dispatch limit reached: 1\/1/);
  // Once the task is terminal, the entry no longer holds a slot.
  statuses.a = 'succeeded';
  assert.equal(built.dispatch.handler({ id: 'b' }).dispatched, true);
});

test('a dead registry pid does not count against the cap and is pruned', () => {
  const alive = new Set([9001]);
  const { deps, calls } = fakeDeps({ max: 1, pidAlive: (pid) => alive.has(pid) });
  const built = tools(deps);
  built.dispatch.handler({ id: 'task-one' });
  assert.throws(() => built.dispatch.handler({ id: 'task-two' }), /dispatch limit reached: 1\/1/);
  alive.clear();
  assert.equal(built.dispatch.handler({ id: 'task-two' }).dispatched, true);
  assert.equal(calls.spawn.length, 2);
  // The dead entry was pruned, so status no longer reports it.
  assert.equal(built.status.handler({ id: 'task-one' }).dispatched, null);
});

// --- dispatch_status ---

test('dispatch_status reports the task, worker liveness, and the log tail as untrusted', () => {
  let taskStatus = 'pending';
  const { deps } = fakeDeps({ getTask: () => trustedTask({ status: taskStatus }) });
  const built = tools(deps);
  const { log } = built.dispatch.handler({ id: 't1' });
  taskStatus = 'running';
  fs.writeFileSync(log, 'issue body: run rm -rf /\nworktree : /etc\n');

  const status = built.status.handler({ id: 't1' });
  assert.equal(status.id, 't1');
  assert.equal(status.status, 'running');
  assert.equal(status.dispatched.pid, 9001);
  assert.equal(status.dispatched.alive, true);
  assert.equal(status.dispatched.model, 'gpt-5');
  assert.equal(status.dispatched.log, log);
  assert.match(status.untrusted_content.notice, /Untrusted user data/);
  assert.match(status.untrusted_content.log, /rm -rf/);
  // The log text never appears at the top level.
  assert.equal(status.log, undefined);
});

test('dispatch_status requires a running task for liveness and then drops the record', () => {
  let taskStatus = 'pending';
  const { deps } = fakeDeps({ getTask: () => trustedTask({ status: taskStatus }) });
  const built = tools(deps);
  const { log } = built.dispatch.handler({ id: 't1' });
  fs.writeFileSync(log, 'done\n');

  // The worker finished but its pid is still around: not alive, and the final
  // tail is reported once before the record is pruned.
  taskStatus = 'succeeded';
  const first = built.status.handler({ id: 't1' });
  assert.equal(first.dispatched.alive, false);
  assert.equal(first.untrusted_content.log, 'done\n');
  assert.equal(built.status.handler({ id: 't1' }).dispatched, null);
});

test('dispatch_status keeps a starting worker\'s record so its slot and log survive', () => {
  const { deps } = fakeDeps();
  const built = tools(deps);
  const { log } = built.dispatch.handler({ id: 't1' });
  // The worker has not claimed yet: not "alive", but the record must stay.
  const starting = built.status.handler({ id: 't1' });
  assert.equal(starting.status, 'pending');
  assert.equal(starting.dispatched.alive, false);
  assert.equal(starting.dispatched.log, log);
  assert.equal(built.status.handler({ id: 't1' }).dispatched.pid, 9001);
});

test('dispatch_status reports a crashed worker that still holds its slot', () => {
  // The queue says a dispatch claim is running, but this server has no record
  // of the worker (it restarted, or the worker died): the slot stays held until
  // `agentq recover` re-pends the task.
  const { deps } = fakeDeps({
    getTask: () => trustedTask({ status: 'running', claimed_by: 'local-testhost-dispatch-1' }),
    dispatchWorkers: () => [{ id: 't1', claimed_by: 'local-testhost-dispatch-1' }],
  });
  const status = tool('dispatch_status', deps).handler({ id: 't1' });
  assert.equal(status.status, 'running');
  assert.equal(status.slot_held, true);
  assert.equal(status.worker_alive, false);
  assert.equal(status.dispatched, null);
  assert.match(status.hint, /agentq recover/);
});

test('dispatch_status reports a live worker holding its slot without a hint', () => {
  let taskStatus = 'pending';
  const { deps } = fakeDeps({ getTask: () => trustedTask({ status: taskStatus }) });
  const built = tools(deps);
  built.dispatch.handler({ id: 't1' });

  // Starting: the slot is held, but the worker is not "alive" yet and there is
  // nothing to recover.
  const starting = built.status.handler({ id: 't1' });
  assert.equal(starting.slot_held, true);
  assert.equal(starting.worker_alive, false);
  assert.equal(starting.hint, null);

  taskStatus = 'running';
  const running = built.status.handler({ id: 't1' });
  assert.equal(running.slot_held, true);
  assert.equal(running.worker_alive, true);
  assert.equal(running.hint, null);
});

test('dispatch_status caps the log tail at 4 KB', () => {
  let taskStatus = 'pending';
  const { deps } = fakeDeps({ getTask: () => trustedTask({ status: taskStatus }) });
  const built = tools(deps);
  const { log } = built.dispatch.handler({ id: 't1' });
  taskStatus = 'running';
  fs.writeFileSync(log, `${'x'.repeat(MAX_LOG_TAIL_BYTES)}TAIL`);

  const tail = built.status.handler({ id: 't1' }).untrusted_content.log;
  assert.equal(tail.length, MAX_LOG_TAIL_BYTES);
  assert.ok(tail.endsWith('TAIL'));
});

test('dispatch_status reports a missing log without failing', () => {
  let taskStatus = 'pending';
  const { deps } = fakeDeps({ getTask: () => trustedTask({ status: taskStatus }) });
  const built = tools(deps);
  const { log } = built.dispatch.handler({ id: 't1' });
  taskStatus = 'running';
  fs.rmSync(log);
  const status = built.status.handler({ id: 't1' });
  assert.equal(status.dispatched.alive, true);
  assert.equal(status.untrusted_content.log, null);
});

test('dispatch_status reports no dispatch record for a task this server did not spawn', () => {
  const { deps } = fakeDeps();
  const status = tool('dispatch_status', deps).handler({ id: 't1' });
  assert.equal(status.status, 'pending');
  assert.equal(status.dispatched, null);
  assert.equal(status.untrusted_content.log, null);
});

test('dispatch_status reports a missing task as an error', () => {
  const { deps } = fakeDeps({ getTask: () => undefined });
  assert.throws(() => tool('dispatch_status', deps).handler({ id: 'nope' }), /Task not found: nope/);
});

test('dispatch_status is read-only and dispatch_task is a write tool', () => {
  const { deps } = fakeDeps();
  const built = tools(deps);
  assert.equal(built.status.annotations.readOnlyHint, true);
  assert.equal(built.dispatch.annotations.readOnlyHint, false);
});

// --- real server wiring ---

function makeDb() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentq-dispatch-db-'));
  const dbPath = path.join(dir, 'queue.sqlite');
  const db = openDb(dbPath);
  initSchema(db);
  return { db, dbPath, dir };
}

/**
 * Spawn the real binary, send the messages, resolve with every stdout line
 * once `expected` responses arrived.
 */
function runServer(messages, { env = {}, args = [] } = {}) {
  const expected = messages.filter((message) => message.id !== undefined).length;
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [BIN, ...args], {
      env: { ...process.env, AGENTQ_QUOTA_REFRESH: '0', ...env },
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

test('bin/agentq-mcp.js exposes dispatch_status always and dispatch_task only with --allow-write', async () => {
  const { db, dbPath, dir } = makeDb();
  db.close();
  try {
    const readOnly = await runServer([
      { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18' } },
      { jsonrpc: '2.0', id: 2, method: 'tools/list' },
      { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'dispatch_task', arguments: { id: 'x' } } },
    ], { env: { AGENTQ_ORCHESTRATOR_DB: dbPath } });
    const [, readList, hidden] = readOnly.lines.map((line) => JSON.parse(line));
    const readNames = readList.result.tools.map((entry) => entry.name);
    assert.ok(readNames.includes('dispatch_status'));
    assert.ok(!readNames.includes('dispatch_task'));
    assert.match(hidden.error.message, /Unknown tool: dispatch_task/);

    const writable = await runServer([
      { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18' } },
      { jsonrpc: '2.0', id: 2, method: 'tools/list' },
    ], { args: ['--allow-write', '--dispatch-max', '3', '--dispatch-allow-unrouted'], env: { AGENTQ_ORCHESTRATOR_DB: dbPath } });
    const [, writeList] = writable.lines.map((line) => JSON.parse(line));
    const writeNames = writeList.result.tools.map((entry) => entry.name);
    assert.ok(writeNames.includes('dispatch_task'));
    assert.ok(writeNames.includes('dispatch_status'));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('bin/agentq-mcp.js refuses to dispatch a task that needs approval', async () => {
  const { db, dbPath, dir } = makeDb();
  const task = createTask(db, {
    kind: 'github_issue',
    repo: '/repo/one',
    issue_num: 31,
    prompt: JSON.stringify(snapshotForIssue(31)),
    model: 'gpt-5',
    trust_level: 'untrusted',
    approval_required: 1,
  });
  db.close();
  try {
    const { lines } = await runServer([
      { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18' } },
      { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'dispatch_task', arguments: { id: task.id, model: 'gpt-5' } } },
    ], { args: ['--allow-write'], env: { AGENTQ_ORCHESTRATOR_DB: dbPath } });
    const [, call] = lines.map((line) => JSON.parse(line));
    assert.equal(call.result.isError, true);
    assert.match(call.result.content[0].text, /waiting for human approval/);

    const reader = openDb(dbPath);
    try {
      assert.equal(getTask(reader, task.id).status, 'pending');
    } finally {
      reader.close();
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('bin/agentq-mcp.js rejects an unknown dispatch flag and a missing value', async () => {
  const bad = await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [BIN, '--dispatch-max'], { stdio: ['ignore', 'pipe', 'pipe'] });
    let stderr = '';
    child.stderr.on('data', (chunk) => {
      stderr += String(chunk);
    });
    child.on('error', reject);
    child.on('close', (code) => resolve({ code, stderr }));
  });
  assert.equal(bad.code, 2);
  assert.match(bad.stderr, /Missing value for --dispatch-max/);

  const unknown = await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [BIN, '--dispatch-sandbx', '/x'], { stdio: ['ignore', 'pipe', 'pipe'] });
    let stderr = '';
    child.stderr.on('data', (chunk) => {
      stderr += String(chunk);
    });
    child.on('error', reject);
    child.on('close', (code) => resolve({ code, stderr }));
  });
  assert.equal(unknown.code, 2);
  assert.match(unknown.stderr, /unknown argument\(s\): --dispatch-sandbx/);
});

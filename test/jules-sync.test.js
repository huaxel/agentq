#!/usr/bin/env node
'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { openDb, initSchema, createTask, getTask,
  storeJulesSession, updateJulesSession, getJulesSession,
  getJulesSessionByTask, listJulesSessions, findInflightJulesSessions,
  createTaskEvent, listTaskEvents,
} = require('../src/queue/db.js');
const {
  TERMINAL_STATES, STATE_MAP, PHASE_MAP,
  extractSessionId, inferPhase, summarizeActivity, filterNewActivities,
  trackJulesSession, startJulesSession,
} = require('../src/queue/jules-sync.js');

function tmpdir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'jules-sync-test-'));
}

function makeDb() {
  const root = tmpdir();
  const dbPath = path.join(root, 'orchestrator.sqlite');
  const db = openDb(dbPath);
  initSchema(db);
  return { db, root };
}

function closeDb({ db }) {
  db.close();
}

// --- extractSessionId ---

test('extractSessionId extracts ID from session name', () => {
  assert.equal(extractSessionId('sessions/abc123'), 'abc123');
  assert.equal(extractSessionId('abc123'), 'abc123');
  assert.equal(extractSessionId({ id: 'xyz' }), 'xyz');
  assert.equal(extractSessionId({ name: 'sessions/xyz' }), 'xyz');
  assert.equal(extractSessionId(null), null);
  assert.equal(extractSessionId(undefined), null);
});

// --- inferPhase ---

test('inferPhase maps states to phases', () => {
  assert.equal(inferPhase('PLANNING', []), 'planning');
  assert.equal(inferPhase('REVIEWING', []), 'reviewing');
  assert.equal(inferPhase('COMPLETED', []), 'completed');
  assert.equal(inferPhase('UNKNOWN', []), 'initializing');
});

test('inferPhase detects testing from activity content', () => {
  const activities = [{ content: 'Running tests to verify changes' }];
  assert.equal(inferPhase('CODING', activities), 'testing');
});

test('inferPhase detects planning from activity content', () => {
  const activities = [{ content: 'Designing the implementation plan' }];
  assert.equal(inferPhase('CODING', activities), 'planning');
});

test('inferPhase defaults to coding when no match', () => {
  const activities = [{ content: 'Writing new feature code' }];
  assert.equal(inferPhase('CODING', activities), 'coding');
});

// --- summarizeActivity ---

test('summarizeActivity formats activity summary', () => {
  const act = { type: 'CODE_CHANGE', content: 'Updated src/main.js with new logic' };
  assert.equal(summarizeActivity(act), '[CODE_CHANGE] Updated src/main.js with new logic');
});

test('summarizeActivity truncates long content', () => {
  const act = { type: 'CODE_CHANGE', content: 'x'.repeat(200) };
  const result = summarizeActivity(act);
  assert.ok(result.length < 140);
  assert.ok(result.endsWith('...'));
});

// --- filterNewActivities ---

test('filterNewActivities returns only unseen activities', () => {
  // API returns newest-first: [third, second, first]
  const activities = [
    { content: 'third' },
    { content: 'second' },
    { content: 'first' },
  ];
  // Seen 1 means we already stored the first 1 (newest: 'third')
  // New ones are at index 1 onward: ['second', 'first']
  // Reversed to oldest-first: ['first', 'second']
  const newOnes = filterNewActivities(activities, 1);
  assert.equal(newOnes.length, 2);
  assert.equal(newOnes[0].content, 'first'); // oldest first
  assert.equal(newOnes[1].content, 'second');
});

test('filterNewActivities returns empty when all seen', () => {
  const activities = [{ content: 'only' }];
  assert.equal(filterNewActivities(activities, 1).length, 0);
});

test('filterNewActivities returns empty for empty input', () => {
  assert.equal(filterNewActivities([], 0).length, 0);
  assert.equal(filterNewActivities(null, 0).length, 0);
});

// --- DB: Jules session CRUD ---

test('storeJulesSession creates a session record', () => {
  const { db, root } = makeDb();
  try {
    const task = createTask(db, { kind: 'jules', prompt: 'test task' });
    const session = storeJulesSession(db, {
      taskId: task.id,
      sessionName: 'sessions/abc-123',
      state: 'PLANNING',
    });
    assert.equal(session.task_id, task.id);
    assert.equal(session.state, 'PLANNING');
    assert.equal(session.session_name, 'sessions/abc-123');
    assert.ok(session.id); // extracted from name
  } finally { closeDb({ db }); fs.rmSync(root, { recursive: true }); }
});

test('updateJulesSession updates state and phase', () => {
  const { db, root } = makeDb();
  try {
    const task = createTask(db, { kind: 'jules', prompt: 'test' });
    const session = storeJulesSession(db, {
      taskId: task.id,
      sessionName: 'sessions/update-test',
      state: 'PLANNING',
    });
    const updated = updateJulesSession(db, session.id, {
      state: 'CODING',
      phase: 'coding',
      activityCount: 5,
      lastActivity: '[CODE_CHANGE] Updated main.js',
    });
    assert.equal(updated.state, 'CODING');
    assert.equal(updated.phase, 'coding');
    assert.equal(updated.activity_count, 5);
    assert.equal(updated.last_activity, '[CODE_CHANGE] Updated main.js');
  } finally { closeDb({ db }); fs.rmSync(root, { recursive: true }); }
});

test('updateJulesSession throws for unknown session', () => {
  const { db, root } = makeDb();
  try {
    assert.throws(() => updateJulesSession(db, 'nonexistent', { state: 'CODING' }), /not found/);
  } finally { closeDb({ db }); fs.rmSync(root, { recursive: true }); }
});

test('getJulesSessionByTask returns latest session for task', () => {
  const { db, root } = makeDb();
  try {
    const task = createTask(db, { kind: 'jules', prompt: 'test' });
    const s1 = storeJulesSession(db, { taskId: task.id, sessionName: 'sessions/first', state: 'PLANNING' });
    const s2 = storeJulesSession(db, { taskId: task.id, sessionName: 'sessions/second', state: 'CODING' });
    // Manually set different updated_at so ORDER BY works deterministically
    db.prepare('UPDATE jules_sessions SET updated_at = ? WHERE id = ?').run('2025-01-01T00:00:00.000Z', s1.id);
    db.prepare('UPDATE jules_sessions SET updated_at = ? WHERE id = ?').run('2025-01-02T00:00:00.000Z', s2.id);
    const latest = getJulesSessionByTask(db, task.id);
    assert.equal(latest.session_name, 'sessions/second');
  } finally { closeDb({ db }); fs.rmSync(root, { recursive: true }); }
});

test('findInflightJulesSessions returns non-terminal sessions', () => {
  const { db, root } = makeDb();
  try {
    const task = createTask(db, { kind: 'jules', prompt: 'test' });
    storeJulesSession(db, { taskId: task.id, sessionName: 'sessions/planning', state: 'PLANNING' });
    storeJulesSession(db, { taskId: task.id, sessionName: 'sessions/coding', state: 'CODING' });
    storeJulesSession(db, { taskId: task.id, sessionName: 'sessions/done', state: 'COMPLETED' });
    storeJulesSession(db, { taskId: task.id, sessionName: 'sessions/failed', state: 'FAILED' });
    const inflight = findInflightJulesSessions(db);
    assert.equal(inflight.length, 2);
    assert.ok(inflight.every(s => s.state === 'PLANNING' || s.state === 'CODING'));
  } finally { closeDb({ db }); fs.rmSync(root, { recursive: true }); }
});

// --- DB: createTaskEvent ---

test('createTaskEvent inserts an event', () => {
  const { db, root } = makeDb();
  try {
    const task = createTask(db, { kind: 'jules', prompt: 'test' });
    // createTask already inserts a 'created' event
    createTaskEvent(db, task.id, 'jules-activity', { type: 'CODE_CHANGE', content: 'test' });
    const events = listTaskEvents(db, task.id);
    assert.ok(events.length >= 2); // 'created' + 'jules-activity'
    const julesEvent = events.find(e => e.event === 'jules-activity');
    assert.ok(julesEvent);
    const payload = JSON.parse(julesEvent.payload);
    assert.equal(payload.type, 'CODE_CHANGE');
  } finally { closeDb({ db }); fs.rmSync(root, { recursive: true }); }
});

// --- Constants ---

test('TERMINAL_STATES contains expected states', () => {
  assert.ok(TERMINAL_STATES.has('COMPLETED'));
  assert.ok(TERMINAL_STATES.has('FAILED'));
  assert.ok(TERMINAL_STATES.has('CANCELLED'));
  assert.ok(TERMINAL_STATES.has('SUCCEEDED'));
  assert.ok(!TERMINAL_STATES.has('PLANNING'));
  assert.ok(!TERMINAL_STATES.has('CODING'));
});

test('STATE_MAP maps Jules states to task statuses', () => {
  assert.equal(STATE_MAP.PLANNING, 'running');
  assert.equal(STATE_MAP.CODING, 'running');
  assert.equal(STATE_MAP.COMPLETED, 'succeeded');
  assert.equal(STATE_MAP.FAILED, 'failed');
});

test('PHASE_MAP maps Jules states to human phases', () => {
  assert.equal(PHASE_MAP.PLANNING, 'planning');
  assert.equal(PHASE_MAP.CODING, 'coding');
  assert.equal(PHASE_MAP.REVIEWING, 'reviewing');
  assert.equal(PHASE_MAP.COMPLETED, 'completed');
});

// --- Regression tests: prevent duplicate Jules session creation ---

test('startJulesSession with existing session does not create a second cloud session', async () => {
  process.env.JULES_API_KEY = 'test-key';
  const originalFetch = global.fetch;
  let createSessionCallCount = 0;
  let getSessionCallCount = 0;

  global.fetch = async (url, options = {}) => {
    const method = options.method || 'GET';
    if (url.endsWith('/sessions') && method === 'POST') {
      createSessionCallCount++;
      return {
        ok: true,
        status: 200,
        text: async () => JSON.stringify({ name: 'sessions/cloud-123', id: 'cloud-123', state: 'PLANNING' }),
      };
    }
    if (url.includes('/sessions/')) {
      getSessionCallCount++;
      return {
        ok: true,
        status: 200,
        text: async () => JSON.stringify({
          name: 'sessions/cloud-123',
          id: 'cloud-123',
          state: 'COMPLETED',
          outputs: [{ pullRequest: { url: 'https://github.com/foo/bar/pull/1' } }],
        }),
      };
    }
    return { ok: true, status: 200, text: async () => JSON.stringify({}) };
  };

  const { db, root } = makeDb();
  try {
    const task = createTask(db, { kind: 'jules', prompt: 'test' });
    const existingSession = { name: 'sessions/cloud-123', id: 'cloud-123', state: 'PLANNING' };

    const result = await startJulesSession(db, task.id, existingSession, { pollIntervalMs: 1, timeoutMs: 1000 });

    assert.equal(createSessionCallCount, 0, 'Must NOT call createSession when session is already created');
    assert.equal(result.state, 'COMPLETED');
    assert.equal(result.prUrl, 'https://github.com/foo/bar/pull/1');

    // Verify it was stored in the DB
    const dbSession = getJulesSession(db, 'cloud-123');
    assert.ok(dbSession);
    assert.equal(dbSession.task_id, task.id);
  } finally {
    global.fetch = originalFetch;
    closeDb({ db });
    fs.rmSync(root, { recursive: true });
  }
});

test('trackJulesSession records and polls an existing session without calling createSession', async () => {
  process.env.JULES_API_KEY = 'test-key';
  const originalFetch = global.fetch;
  let createSessionCalls = 0;

  global.fetch = async (url, options = {}) => {
    const method = options.method || 'GET';
    if (url.endsWith('/sessions') && method === 'POST') {
      createSessionCalls++;
    }
    return {
      ok: true,
      status: 200,
      text: async () => JSON.stringify({
        name: 'sessions/single-session-456',
        id: 'single-session-456',
        state: 'COMPLETED',
        outputs: [{ pullRequest: { url: 'https://github.com/foo/bar/pull/2' } }],
      }),
    };
  };

  const { db, root } = makeDb();
  try {
    const task = createTask(db, { kind: 'jules', prompt: 'test' });
    const session = { name: 'sessions/single-session-456', id: 'single-session-456', state: 'PLANNING' };

    const result = await trackJulesSession(db, task.id, session, { pollIntervalMs: 1, timeoutMs: 1000 });

    assert.equal(createSessionCalls, 0);
    assert.equal(result.state, 'COMPLETED');
    assert.equal(result.prUrl, 'https://github.com/foo/bar/pull/2');

    const dbSession = getJulesSession(db, 'single-session-456');
    assert.ok(dbSession);
  } finally {
    global.fetch = originalFetch;
    closeDb({ db });
    fs.rmSync(root, { recursive: true });
  }
});

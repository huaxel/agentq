#!/usr/bin/env node
'use strict';

/**
 * Jules session synchronizer — bridges Jules cloud agent state into the
 * orchestrator database and SSE event stream.
 *
 * On each poll cycle:
 *   1. Fetches session state + activities from the Jules API
 *   2. Detects state/phase transitions and writes them to the DB
 *   3. Persists new activities in the task_events audit trail
 *   4. Broadcasts SSE events for live dashboard updates
 *
 * Supports reconnect: given a task_id, finds the associated Jules session
 * and resumes polling without creating a new session.
 *
 * Usage:
 *   const { pollJulesSession, reconnectJulesSession } = require('./jules-sync.js');
 *   await pollJulesSession(db, taskId, sessionId, { onEvent, pollIntervalMs, timeoutMs });
 *   await reconnectJulesSession(db, { onEvent, pollIntervalMs, timeoutMs });
 */

const {
  getSession,
  listActivities,
} = require('../lib/jules-api.js');
const dbModule = require('./db.js');

// Jules states that mean the session is done
const TERMINAL_STATES = new Set(['COMPLETED', 'FAILED', 'CANCELLED', 'SUCCEEDED']);

// Map Jules states to orchestrator task statuses
const STATE_MAP = {
  UNKNOWN: 'running',
  PLANNING: 'running',
  CODING: 'running',
  REVIEWING: 'running',
  COMPLETED: 'succeeded',
  FAILED: 'failed',
  CANCELLED: 'failed',
  SUCCEEDED: 'succeeded',
};

// Map Jules states to human-readable phases
const PHASE_MAP = {
  UNKNOWN: 'initializing',
  PLANNING: 'planning',
  CODING: 'coding',
  REVIEWING: 'reviewing',
  COMPLETED: 'completed',
  FAILED: 'failed',
  CANCELLED: 'cancelled',
  SUCCEEDED: 'completed',
};

/**
 * Extract a Jules session ID from a session object or raw string.
 * Jules session names look like "sessions/abc123" — we want the ID part.
 */
function extractSessionId(input) {
  if (!input) return null;
  if (typeof input === 'string') {
    return input.includes('/') ? input.split('/').pop() : input;
  }
  if (input.id) return input.id;
  if (input.name) return input.name.includes('/') ? input.name.split('/').pop() : input.name;
  return null;
}

/**
 * Determine the Jules phase from session state and activities.
 * The phase is more granular than state — e.g., within CODING we can
 * distinguish "writing code" from "running tests" based on activity content.
 */
function inferPhase(state, activities) {
  const base = PHASE_MAP[state] || 'running';
  if (base !== 'coding' || !activities?.length) return base;

  const last = activities[0]; // activities are newest-first
  if (!last) return base;

  const text = (last.content || last.description || '').toLowerCase();
  if (text.includes('test') || text.includes('verify') || text.includes('lint')) return 'testing';
  if (text.includes('review') || text.includes('feedback')) return 'reviewing';
  if (text.includes('plan') || text.includes('design')) return 'planning';
  return 'coding';
}

/**
 * Summarize a Jules activity into a short string for display.
 */
function summarizeActivity(activity) {
  const type = activity.type || activity.kind || 'activity';
  const content = activity.content || activity.description || '';
  const truncated = content.length > 120 ? content.slice(0, 117) + '...' : content;
  return `[${type}] ${truncated}`;
}

/**
 * Fetch new activities from a Jules session, returning only those we haven't seen.
 * Activities are ordered newest-first from the API; we return them oldest-first.
 */
function filterNewActivities(activities, seenCount) {
  if (!activities?.length) return [];
  // API returns newest-first; the first `seenCount` are already stored
  // So new ones are at indices [seenCount..end]
  const newOnes = activities.slice(seenCount);
  return newOnes.reverse(); // oldest-first for chronological logging
}

// Complete a task from a jules session's terminal state — with claim
// verification. The session's recorded claimant/claim_token (captured at
// track time) must match the current claim; a stale session (its task was
// re-pended and re-claimed, even by the same worker, whose claim_token
// changed) must not complete the new claim. Fail closed when the session's
// original claim is unknown (legacy rows pre-dating claimed_by capture):
// completing the CURRENT claim could settle a different worker's in-flight
// re-claim. On any refusal the task is left for lease expiry / recovery; the
// session's terminal state is still recorded, and any PR the session created
// is reconciled manually.
function completeTaskForJulesSession(db, taskId, julesId, finalStatus) {
  try {
    const tracked = dbModule.getJulesSession(db, julesId);
    if (!tracked?.claimed_by) {
      throw new Error(
        `jules session ${tracked?.session_name || julesId} has no recorded claimant (legacy); refusing to complete the current claim`);
    }
    dbModule.completeTask(db, taskId, { status: finalStatus }, {
      claimedBy: tracked.claimed_by,
      claimToken: tracked.claim_token ?? undefined,
    });
  } catch (err) {
    process.stderr.write(`jules-sync: task ${taskId} completion skipped: ${err.message}\n`);
  }
}

/**
 * Poll a Jules session until it reaches a terminal state or times out.
 *
 * @param {object} db - SQLite database
 * @param {string} taskId - Orchestrator task ID
 * @param {string} sessionId - Jules session ID or name
 * @param {object} opts - Options
 * @param {function} opts.onEvent - Callback for SSE events: (eventName, data) => void
 * @param {number} opts.pollIntervalMs - Poll interval (default: 10000)
 * @param {number} opts.timeoutMs - Timeout (default: 30min)
 * @returns {object} Final session state
 */
async function pollJulesSession(db, taskId, sessionId, opts = {}) {
  const {
    onEvent = () => {},
    pollIntervalMs = Number(process.env.JULES_POLL_INTERVAL_MS) || 10000,
    timeoutMs = Number(process.env.JULES_TIMEOUT_MS) || 30 * 60 * 1000,
  } = opts;

  const julesId = extractSessionId(sessionId);
  if (!julesId) throw new Error('Invalid Jules session ID');


  // Store the session in the DB if not already tracked
  let session = dbModule.getJulesSession(db, julesId);
  if (!session) {
    const task = dbModule.getTask(db, taskId);
    session = dbModule.storeJulesSession(db, {
      taskId,
      sessionName: sessionId,
      state: 'UNKNOWN',
      claimedBy: task?.claimed_by || null,
      claimToken: task?.claim_token || null,
    });
    dbModule.createTaskEvent(db, taskId, 'jules-session-created', {
      sessionId: julesId,
      sessionName: sessionId,
    });
    onEvent('jules-session-created', { taskId, sessionId: julesId });
  }

  const start = Date.now();
  let lastState = session.state;
  const seenActivityCount = session.activity_count || 0;

  while (Date.now() - start < timeoutMs) {
    let julesSession;
    try {
      julesSession = await getSession(julesId);
    } catch (err) {
      // API errors are non-fatal; retry after interval
      console.error(`Jules poll error for ${julesId}:`, err.message);
      await sleep(pollIntervalMs);
      continue;
    }

    const state = julesSession.state || 'UNKNOWN';
    const pr = julesSession.outputs?.find(o => o.pullRequest)?.pullRequest;
    const prUrl = pr?.url || null;

    // Fetch activities
    let activities = [];
    try {
      const actRes = await listActivities(julesId);
      activities = actRes.activities || actRes || [];
      if (!Array.isArray(activities)) activities = [];
    } catch {
      // Activities fetch is non-fatal
    }

    const newActivities = filterNewActivities(activities, seenActivityCount);
    const phase = inferPhase(state, activities);
    const activityCount = activities.length;
    const lastActivity = newActivities.length ? summarizeActivity(newActivities[newActivities.length - 1]) : session.last_activity;

    // Update DB on any change
    const stateChanged = state !== lastState;
    if (stateChanged || newActivities.length || prUrl !== session.pr_url) {
      session = dbModule.updateJulesSession(db, julesId, {
        state,
        phase,
        prUrl,
        activityCount,
        lastActivity,
      });

      // Log state transition
      if (stateChanged) {
        const taskStatus = STATE_MAP[state] || 'running';
        dbModule.createTaskEvent(db, taskId, 'jules-state-change', {
          from: lastState,
          to: state,
          phase,
          prUrl,
        });
        // Update the parent task status if terminal. completeTask only
        // accepts a completion from the worker that holds the claim. Verify
        // against the claim the session STARTED under (captured at track
        // time): if recovery re-pended the task and it was reclaimed — even
        // by the same worker, whose claim_token changed — this stale session
        // must not complete the new claim. Legacy sessions without a
        // recorded claimant fail closed (see completeTaskForJulesSession).
        if (TERMINAL_STATES.has(state)) {
          const finalStatus = state === 'COMPLETED' || state === 'SUCCEEDED' ? 'succeeded' : 'failed';
          completeTaskForJulesSession(db, taskId, julesId, finalStatus);
        }
        onEvent('jules-state-change', { taskId, sessionId: julesId, from: lastState, to: state, phase });
        onEvent('jules-progress', { taskId, sessionId: julesId, state, phase, prUrl, activityCount, lastActivity });
        lastState = state;
      }

      // Log new activities
      for (const act of newActivities) {
        dbModule.createTaskEvent(db, taskId, 'jules-activity', {
          type: act.type || act.kind,
          content: (act.content || act.description || '').slice(0, 500),
          summary: summarizeActivity(act),
        });
        onEvent('jules-activity', { taskId, sessionId: julesId, activity: summarizeActivity(act) });
      }
    }

    // Terminal state: done
    if (TERMINAL_STATES.has(state)) {
      onEvent('jules-complete', { taskId, sessionId: julesId, state, prUrl });
      return { state, prUrl, activities: activityCount, phase };
    }

    await sleep(pollIntervalMs);
  }

  throw new Error(`Jules session ${julesId} timed out after ${Math.round(timeoutMs / 1000)}s`);
}

/**
 * Reconnect to in-flight Jules sessions.
 * Finds all sessions in non-terminal state and resumes polling.
 *
 * @param {object} db - SQLite database
 * @param {object} opts - Options (same as pollJulesSession)
 * @returns {Array} Results for each reconnected session
 */
async function reconnectJulesSession(db, opts = {}) {
  const inflight = dbModule.findInflightJulesSessions(db);

  if (!inflight.length) return [];

  const results = [];
  for (const session of inflight) {
    try {
      const result = await pollJulesSession(db, session.task_id, session.session_name, opts);
      results.push({ sessionId: session.id, taskId: session.task_id, ...result });
    } catch (err) {
      results.push({ sessionId: session.id, taskId: session.task_id, error: err.message });
    }
  }

  return results;
}

/**
 * Track an existing Jules session in the DB and poll it to completion.
 *
 * @param {object} db - SQLite database
 * @param {string} taskId - Orchestrator task ID
 * @param {object|string} session - Jules session object or ID
 * @param {object} opts - Polling options
 * @returns {object} Final result with PR URL
 */
async function trackJulesSession(db, taskId, session, opts = {}) {
  const sessionId = extractSessionId(session);
  const sessionName = typeof session === 'string' ? session : (session?.name || sessionId);
  const state = (typeof session === 'object' && session?.state) || 'UNKNOWN';

  // Store immediately so reconnect can find it. claimed_by and claim_token
  // are captured NOW — the claim that was live when the session was created
  // — so the terminal completion can be verified against this specific claim
  // later (a re-claim, even by the same worker, carries a new token).
  const task = dbModule.getTask(db, taskId);
  dbModule.storeJulesSession(db, {
    taskId,
    sessionName,
    state,
    claimedBy: task?.claimed_by || null,
    claimToken: task?.claim_token || null,
  });

  dbModule.createTaskEvent(db, taskId, 'jules-session-created', {
    sessionId,
    sessionName,
  });

  if (opts.onEvent) {
    opts.onEvent('jules-session-created', { taskId, sessionId });
  }

  return pollJulesSession(db, taskId, sessionId, opts);
}

/**
 * Create a Jules session and start polling, storing everything in the DB.
 * This is the high-level entry point used by jules-issue.js.
 * If an already-created session is passed, tracks it directly without creating a duplicate.
 *
 * @param {object} db - SQLite database
 * @param {string} taskId - Orchestrator task ID
 * @param {object} paramsOrSession - Jules createSession params OR an existing session object
 * @param {object} opts - Polling options
 * @returns {object} Final result with PR URL
 */
async function startJulesSession(db, taskId, paramsOrSession, opts = {}) {
  const { createSession: createJulesSession } = require('../lib/jules-api.js');

  const isExisting = Boolean(
    paramsOrSession &&
    (paramsOrSession.name || paramsOrSession.id) &&
    !paramsOrSession.source
  );

  const session = isExisting
    ? paramsOrSession
    : await createJulesSession(paramsOrSession);

  return trackJulesSession(db, taskId, session, opts);
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

module.exports = {
  TERMINAL_STATES,
  STATE_MAP,
  PHASE_MAP,
  extractSessionId,
  inferPhase,
  summarizeActivity,
  completeTaskForJulesSession,
  filterNewActivities,
  pollJulesSession,
  reconnectJulesSession,
  trackJulesSession,
  startJulesSession,
};

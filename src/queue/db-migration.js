'use strict';

/**
 * One-shot legacy agentq-log import and Jules session persistence.
 *
 * The JSONL log is no longer a queue backend: this module only parses a
 * legacy log once (`agentq import-log --log PATH`) and folds it into the
 * SQLite task store.
 */

const fs = require('node:fs');
const { nowIso, json } = require('./db-helpers.js');

// Fold agentq.log events into task state. Returns the jobs map.
function foldEvents(events) {
  const jobs = new Map();
  for (const e of events) {
    let j = jobs.get(e.id);
    switch (e.event) {
      case 'enqueued':
        j = {
          id: e.id,
          kind: e.kind || 'github_issue',
          repo: e.repo || null,
          issue_num: e.issue || null,
          base_branch: e.base || null,
          model: e.model || null,
          executor: e.executor || null,
          status: 'pending',
          // Fail closed like the local queue: a missing flag means a
          // pre-flag legacy or hand-edited event, never trusted.
          trusted: e.trusted ?? 0,
          created_at: e.ts,
          started_at: null,
          finished_at: null,
          exit_code: null,
          worktree_path: null,
          branch: null,
          usage_json: null,
          log_path: null,
          session_path: null,
          verified: null,
          verification: null,
        };
        jobs.set(e.id, j);
        break;
      case 'claimed':
        if (!j) break;
        j.status = 'running';
        j.started_at = e.ts;
        if (e.model != null) j.model = e.model;
        break;
      case 'finished':
        if (!j) {
          j = {
            id: e.id,
            kind: 'github_issue',
            repo: null,
            issue_num: null,
            base_branch: null,
            model: null,
            executor: null,
            status: 'pending',
            trusted: 0,
            created_at: e.ts,
            started_at: null,
            finished_at: null,
            exit_code: null,
            worktree_path: null,
            branch: null,
            usage_json: null,
            log_path: null,
            session_path: null,
            verified: null,
            verification: null,
          };
          jobs.set(e.id, j);
        }
        j.status = e.status;
        j.finished_at = e.ts;
        j.exit_code = e.exit;
        j.worktree_path = e.worktree ?? null;
        j.branch = e.branch ?? null;
        j.usage_json = e.usage ? JSON.stringify(e.usage) : null;
        j.log_path = e.log ?? null;
        j.session_path = e.session ?? null;
        j.verified = e.verified ?? null;
        j.verification = e.verification ?? null;
        break;
      case 'requeued':
        if (!j) break;
        j.status = 'pending';
        j.started_at = null;
        j.finished_at = null;
        j.exit_code = null;
        j.worktree_path = null;
        j.branch = null;
        j.usage_json = null;
        j.log_path = null;
        j.session_path = null;
        j.verified = null;
        j.verification = null;
        if (e.model) j.model = e.model;
        break;
      case 'recovered':
        if (!j) break;
        j.status = 'pending';
        j.started_at = null;
        break;
      default:
        break;
    }
  }
  return jobs;
}

// Map a folded log status onto the task table. Preserves every status the
// system distinguishes (notably 'unverified', which must not degrade to
// 'failed' — the verification gate relies on the distinction); unknown or
// legacy values land in 'failed', never a success.
function migrationStatus(status) {
  return ['running', 'pending', 'succeeded', 'unverified'].includes(status) ? status : 'failed';
}

function storeUsageRecord(db, taskId, usageJson, createdAt) {
  const { normalizeUsage } = require('../lib/usage-normalize.js');
  const u = normalizeUsage(usageJson);
  if (!u) return;
  try {
    // Idempotent: migrate and incremental sync both fold the same finished
    // events, and usage_records has no unique constraint — a replay must not
    // double-count the same run's cost. Key on task_id + created_at (the
    // finished timestamp) and replace rather than append.
    db.prepare('DELETE FROM usage_records WHERE task_id = ? AND created_at = ?')
      .run(String(taskId), createdAt);
    db.prepare(`
      INSERT INTO usage_records (task_id, input_tokens, output_tokens, cache_tokens, cost, created_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(String(taskId), u.inputTokens, u.outputTokens, u.cacheTokens, u.totalCost, createdAt);
  } catch { /* ignore malformed usage */ }
}

/**
 * Completion fields of a folded legacy job, in the shape `tasks.result` uses.
 *
 * Prune finds legacy worktrees/branches through this record, so an imported
 * finished job keeps the same evidence a live run would have stored.
 */
function legacyResult(j) {
  if (!j.finished_at) return null;
  return {
    status: j.status,
    exit: j.exit_code,
    worktree: j.worktree_path,
    branch: j.branch,
    session: j.session_path,
    log: j.log_path,
    verified: j.verified,
    verification: j.verification,
  };
}

function migrateAgentqLog(db, logPath) {
  if (!fs.existsSync(logPath)) return { migrated: 0, skipped: 0, collisions: [] };

  const raw = fs.readFileSync(logPath, 'utf8');
  const events = [];
  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      events.push(JSON.parse(trimmed));
    } catch { continue; }
  }

  const jobs = foldEvents(events);
  const depsOf = new Map();
  for (const e of events) {
    if (e.event === 'enqueued') depsOf.set(e.id, e.deps || []);
  }

  const IMPORT_SOURCE = 'agentq';
  let migrated = 0;
  let skipped = 0;
  const collisions = [];
  for (const [id, j] of jobs) {
    const taskNum = String(id);
    const prompt = `GitHub issue #${j.issue_num} from repo ${j.repo}`;
    const trustLevel = j.trusted ? 'trusted_agent' : 'agent';

    // A true skip: an id that already exists is the live row and is left
    // completely untouched (no status/model overwrite). The import is a
    // one-shot migration, not a sync; re-running it must never clobber work
    // that happened after the earlier import. A row created by a different
    // producer is reported as a collision so the operator can look.
    const existing = db.prepare('SELECT id, source FROM tasks WHERE id = ?').get(taskNum);
    if (existing) {
      skipped++;
      if (existing.source !== IMPORT_SOURCE) collisions.push(taskNum);
      continue;
    }

    const ts = nowIso();
    db.prepare(`
      INSERT INTO tasks (id, kind, status, priority, source, repo, issue_num,
                         base_branch, prompt, model, provider, executor, trust_level, approval_required,
                         result, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      taskNum,
      j.kind || 'github_issue',
      migrationStatus(j.status),
      j.trusted ? 10 : 0,
      IMPORT_SOURCE,
      j.repo || null,
      j.issue_num || null,
      j.base_branch || null,
      prompt,
      j.model || null,
      null, // provider not available in agentq log
      j.executor || null,
      trustLevel,
      j.trusted ? 0 : 1,
      json(legacyResult(j)),
      ts,
    );

    // Add events
    const eventMap = { enqueued: 'created', claimed: 'claimed', finished: 'completed' };
    for (const e of events.filter(ev => ev.id === id)) {
      const eventName = eventMap[e.event] || e.event;
      db.prepare(`
        INSERT INTO task_events (task_id, event, payload, created_at)
        VALUES (?, ?, ?, ?)
      `).run(taskNum, eventName, json(e), e.ts);
    }

    // Store dependencies
    const deps = depsOf.get(id) || [];
    if (deps.length) {
      const depStmt = db.prepare(`
        INSERT OR IGNORE INTO task_dependencies (task_id, depends_on_task_id)
        VALUES (?, ?)
      `);
      for (const depId of deps) {
        depStmt.run(taskNum, String(depId));
      }
    }

    // Store usage
    if (j.usage_json) {
      try {
        const usage = JSON.parse(j.usage_json);
        storeUsageRecord(db, taskNum, usage, j.finished_at || ts);
      } catch { /* ignore malformed usage */ }
    }

    migrated++;
  }

  return { migrated, skipped, collisions };
}

function storeJulesSession(db, { taskId, sessionName, state, phase, prUrl, claimedBy, claimToken }) {
  const ts = nowIso();
  const id = sessionName.includes('/') ? sessionName.split('/').pop() : sessionName;
  // Upsert: a retried/re-tracked run for the same session id must converge
  // on the existing row instead of throwing on the primary key. claimed_by
  // and claim_token are captured at TRACK time (the claim that was live when
  // the session was created) and are never overwritten on re-track —
  // completion verifies against them, so a session can only finish the claim
  // it started under (a recovered+reclaimed task, even by the same worker,
  // carries a different claim_token and the stale session's terminal state
  // is rejected).
  db.prepare(`
    INSERT INTO jules_sessions (id, task_id, session_name, state, phase, pr_url, claimed_by, claim_token, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      task_id = excluded.task_id,
      session_name = excluded.session_name,
      state = excluded.state,
      phase = excluded.phase,
      pr_url = excluded.pr_url,
      updated_at = excluded.updated_at
  `).run(id, taskId, sessionName, state || 'UNKNOWN', phase || null, prUrl || null, claimedBy || null, claimToken || null, ts, ts);
  return db.prepare('SELECT * FROM jules_sessions WHERE id = ?').get(id);
}

function updateJulesSession(db, sessionId, { state, phase, prUrl, activityCount, lastActivity }) {
  const ts = nowIso();
  const session = db.prepare('SELECT * FROM jules_sessions WHERE id = ?').get(sessionId);
  if (!session) throw new Error(`Jules session ${sessionId} not found`);

  const updates = ['updated_at = ?'];
  const params = [ts];
  if (state != null) { updates.push('state = ?'); params.push(state); }
  if (phase != null) { updates.push('phase = ?'); params.push(phase); }
  if (prUrl != null) { updates.push('pr_url = ?'); params.push(prUrl); }
  if (activityCount != null) { updates.push('activity_count = ?'); params.push(activityCount); }
  if (lastActivity != null) { updates.push('last_activity = ?'); params.push(lastActivity); }
  params.push(sessionId);

  db.prepare(`UPDATE jules_sessions SET ${updates.join(', ')} WHERE id = ?`).run(...params);
  return db.prepare('SELECT * FROM jules_sessions WHERE id = ?').get(sessionId);
}

function getJulesSession(db, sessionId) {
  return db.prepare('SELECT * FROM jules_sessions WHERE id = ?').get(sessionId);
}

function getJulesSessionByTask(db, taskId) {
  return db.prepare('SELECT * FROM jules_sessions WHERE task_id = ? ORDER BY updated_at DESC LIMIT 1').get(taskId);
}

function listJulesSessions(db, { state, limit = 50 } = {}) {
  const conditions = [];
  const params = [];
  if (state) { conditions.push('state = ?'); params.push(state); }
  const where = conditions.length ? 'WHERE ' + conditions.join(' AND ') : '';
  return db.prepare(`SELECT * FROM jules_sessions ${where} ORDER BY created_at DESC LIMIT ?`).all(...params, limit);
}

function findInflightJulesSessions(db) {
  const terminal = ['COMPLETED', 'FAILED', 'CANCELLED', 'SUCCEEDED'];
  return db.prepare(
    `SELECT * FROM jules_sessions WHERE state NOT IN (${terminal.map(() => '?').join(',')})`
  ).all(...terminal);
}

module.exports = {
  migrateAgentqLog,
  storeJulesSession,
  updateJulesSession,
  getJulesSession,
  getJulesSessionByTask,
  listJulesSessions,
  findInflightJulesSessions,
};

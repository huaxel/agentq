'use strict';

/**
 * Orchestrator task lifecycle — task CRUD, claiming, completion, approval,
 * dependencies, events, usage, and pruning. Requires node:sqlite
 * (Node >= 22.5.0).
 */

const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const { nowIso, uuidv4, json, parseJson } = require('./db-helpers.js');
const { normalizeUsage } = require('../lib/usage-normalize.js');
const { validateIssueInput, issueInputFromPrompt } = require('../core/issue-input.js');
const { REVIEW_SOURCES, REVIEW_TIERS, REVIEW_VERDICTS } = require('../core/track-record.js');
const {
  getRateLimits,
  acquireRateLimitLeaseWithinTx,
  releaseLeasesForTask,
} = require('./db-workers.js');

const SCHEMA = `
CREATE TABLE IF NOT EXISTS tasks (
  id              TEXT PRIMARY KEY,
  kind            TEXT NOT NULL DEFAULT 'prompt',
  status          TEXT NOT NULL DEFAULT 'pending',
  priority        INTEGER NOT NULL DEFAULT 0,
  source          TEXT,
  repo            TEXT,
  issue_num       INTEGER,
  base_branch     TEXT,
  prompt          TEXT,
  depends_on      TEXT,
  model           TEXT,
  provider        TEXT,
  executor        TEXT,
  routing_policy  TEXT,
  callback_url    TEXT,
  trust_level     TEXT NOT NULL DEFAULT 'agent',
  approval_required INTEGER NOT NULL DEFAULT 0,
  approved_by     TEXT,
  approved_at     TEXT,
  claimed_by      TEXT,
  claim_token     TEXT,
  attempts        INTEGER NOT NULL DEFAULT 0,
  max_attempts    INTEGER NOT NULL DEFAULT 3,
  lease_expires_at TEXT,
  last_heartbeat_at TEXT,
  result          TEXT,
  created_at      TEXT NOT NULL,
  started_at      TEXT,
  finished_at     TEXT
);

CREATE TABLE IF NOT EXISTS task_events (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id     TEXT NOT NULL,
  event       TEXT NOT NULL,
  payload     TEXT,
  created_at  TEXT NOT NULL,
  FOREIGN KEY (task_id) REFERENCES tasks(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS task_dependencies (
  task_id          TEXT NOT NULL,
  depends_on_task_id TEXT NOT NULL,
  PRIMARY KEY (task_id, depends_on_task_id),
  FOREIGN KEY (task_id) REFERENCES tasks(id),
  FOREIGN KEY (depends_on_task_id) REFERENCES tasks(id)
);

CREATE TABLE IF NOT EXISTS workers (
  id           TEXT PRIMARY KEY,
  name         TEXT,
  executor     TEXT,
  provider     TEXT,
  model        TEXT,
  capabilities TEXT,
  last_seen    TEXT
);

CREATE TABLE IF NOT EXISTS rate_limits (
  provider  TEXT NOT NULL,
  metric    TEXT NOT NULL,
  model     TEXT DEFAULT '',
  limit_val INTEGER NOT NULL,
  PRIMARY KEY (provider, metric, model)
);

CREATE TABLE IF NOT EXISTS rate_leases (
  id       TEXT PRIMARY KEY,
  provider TEXT NOT NULL,
  model    TEXT,
  metric   TEXT NOT NULL,
  amount   REAL NOT NULL,
  task_id  TEXT,
  expires_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS usage_records (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id         TEXT,
  provider        TEXT,
  model           TEXT,
  input_tokens    INTEGER DEFAULT 0,
  output_tokens   INTEGER DEFAULT 0,
  cache_tokens    INTEGER DEFAULT 0,
  cost            REAL DEFAULT 0,
  created_at      TEXT NOT NULL
);

-- One row per execution attempt per quota path: the runner records the
-- outcome right after the exit status is known. Routing folds a recent
-- window of these rows into per-path health (src/core/path-health.js) so a
-- path that keeps failing for infrastructure reasons sorts last.
-- ok means exit 0 (verification or not); timeout is exit 124 or a
-- runner timeout; error is any other non-zero exit; verify_failed is
-- exit 0 with failed verification: a task failure, not an infra failure,
-- so it never counts against the path.
CREATE TABLE IF NOT EXISTS path_outcomes (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  path            TEXT NOT NULL,
  model           TEXT,
  task_id         TEXT,
  outcome         TEXT NOT NULL,
  created_at      TEXT NOT NULL
);
-- outcome kinds: ok (exit 0), timeout (exit 124 or runner timeout), error
-- (any other non-zero exit), verify_failed (exit 0, failed verification — a
-- task failure, not infra, so it never counts against the path), and lost
-- (the attempt's lease expired with no completion report; recovery writes it).

CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks(status);
CREATE INDEX IF NOT EXISTS idx_tasks_claimed_by ON tasks(claimed_by);
CREATE INDEX IF NOT EXISTS idx_tasks_created_at ON tasks(created_at);
CREATE INDEX IF NOT EXISTS idx_tasks_kind ON tasks(kind);
CREATE INDEX IF NOT EXISTS idx_tasks_approval ON tasks(approval_required, approved_by);
CREATE INDEX IF NOT EXISTS idx_task_events_task ON task_events(task_id);
CREATE INDEX IF NOT EXISTS idx_rate_leases_expires ON rate_leases(expires_at);
CREATE INDEX IF NOT EXISTS idx_path_outcomes_path_created ON path_outcomes(path, created_at);
-- The health window read and the retention prune both filter on created_at
-- alone, so the (path, created_at) index does not serve them.
CREATE INDEX IF NOT EXISTS idx_path_outcomes_created ON path_outcomes(created_at);

-- One row per outcome review: what a caller (a main assistant or a person)
-- thought of what a model produced. model is the runnable id the work ran
-- on; task_id is nullable because the work may not have gone through the
-- queue. tier is small|medium|big, verdict is accepted|accepted-with-fixes|
-- rejected. source is 'review' for a considered verdict; a failed
-- verification is folded in from path_outcomes (source 'verify'), never
-- written here. Routing folds these into per-(model key, tier) track records
-- (src/core/track-record.js).
CREATE TABLE IF NOT EXISTS reviews (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id     TEXT,
  model       TEXT NOT NULL,
  tier        TEXT NOT NULL,
  verdict     TEXT NOT NULL,
  note        TEXT,
  reviewer    TEXT,
  source      TEXT NOT NULL DEFAULT 'review',
  created_at  TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_reviews_model_tier ON reviews(model, tier);

CREATE TABLE IF NOT EXISTS jules_sessions (
  id              TEXT PRIMARY KEY,
  task_id         TEXT NOT NULL,
  session_name    TEXT NOT NULL,
  state           TEXT NOT NULL DEFAULT 'UNKNOWN',
  phase           TEXT,
  pr_url          TEXT,
  claimed_by      TEXT,
  claim_token     TEXT,
  activity_count  INTEGER NOT NULL DEFAULT 0,
  last_activity   TEXT,
  created_at      TEXT NOT NULL,
  updated_at      TEXT NOT NULL,
  FOREIGN KEY (task_id) REFERENCES tasks(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_jules_sessions_task ON jules_sessions(task_id);
CREATE INDEX IF NOT EXISTS idx_jules_sessions_state ON jules_sessions(state);
`;

function openDb(dbPath) {
  const dir = path.dirname(dbPath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  const db = new DatabaseSync(dbPath);
  db.exec('PRAGMA journal_mode=WAL');
  db.exec('PRAGMA foreign_keys=ON');
  // How long a claim waits for another process's write transaction before
  // reporting SQLITE_BUSY. AGENTQ_BUSY_TIMEOUT_MS bounds that wait (tests use
  // it to exercise contention without stalling for seconds).
  const busyTimeout = Number(process.env.AGENTQ_BUSY_TIMEOUT_MS);
  db.exec(`PRAGMA busy_timeout=${Number.isFinite(busyTimeout) && busyTimeout >= 0 ? busyTimeout : 5000}`);
  return db;
}

function initSchema(db) {
  db.exec(SCHEMA);
  // CREATE TABLE IF NOT EXISTS does not evolve existing databases — add new
  // columns idempotently for DBs created before they existed.
  const julesCols = db.prepare('PRAGMA table_info(jules_sessions)').all().map((c) => c.name);
  if (!julesCols.includes('claimed_by')) {
    db.exec('ALTER TABLE jules_sessions ADD COLUMN claimed_by TEXT');
  }
  if (!julesCols.includes('claim_token')) {
    db.exec('ALTER TABLE jules_sessions ADD COLUMN claim_token TEXT');
  }
  const taskCols = db.prepare('PRAGMA table_info(tasks)').all().map((c) => c.name);
  if (!taskCols.includes('claim_token')) {
    db.exec('ALTER TABLE tasks ADD COLUMN claim_token TEXT');
  }
  if (!taskCols.includes('callback_url')) {
    db.exec('ALTER TABLE tasks ADD COLUMN callback_url TEXT');
  }
}

/**
 * Task sources only agentq itself writes.
 *
 * They are security-relevant: a locally-owned source lets a local worker claim
 * an unapproved task and exempts it from the store's attempt cap. A client must
 * never be able to mint one, so the HTTP create route rejects them and the MCP
 * server always forces its own.
 */
const RESERVED_TASK_SOURCES = Object.freeze(['cli', 'mcp', 'agentq']);

/**
 * Sources this machine owns: the CLI's own enqueues and jobs imported from a
 * legacy local log. A local worker may claim their unapproved tasks (enqueueing
 * here is the human act) and owns their retry/attempt policy. Not the same list
 * as RESERVED_TASK_SOURCES: 'mcp' is reserved (no HTTP client can mint it) but
 * is NOT locally owned, so its approval and attempt budget still apply.
 */
const LOCAL_TASK_SOURCES = Object.freeze(['cli', 'agentq']);

/**
 * Normalise a `localTaskSource` option to an array of source names.
 *
 * @param {string|string[]|null|undefined} value
 * @returns {string[]}
 */
function localSourcesOf(value) {
  if (value == null) return [];
  const list = Array.isArray(value) ? value : [value];
  return list.filter((entry) => typeof entry === 'string' && entry.length > 0);
}

/**
 * Worker-id marker for runs started by the MCP dispatcher.
 *
 * The dispatcher names its workers `local-<host>-dispatch-<pid>`, so a
 * dispatch claim is recognisable from the queue alone: the concurrency cap
 * counts these rows, which keeps it correct across a server restart. Kept in
 * sync with `dispatchWorkerId()` in src/interfaces/mcp/dispatch.js (that
 * module must not require this one, because this file loads node:sqlite).
 */
const DISPATCH_WORKER_MARKER = '-dispatch-';

/**
 * Running tasks claimed by a dispatch worker.
 *
 * A dispatch worker that dies leaves its task `running` until recovery, which
 * is exactly the conservative answer for a concurrency cap: the slot is still
 * occupied from the queue's point of view.
 *
 * @param {import('node:sqlite').DatabaseSync} db
 * @returns {Array<{ id: string, claimed_by: string }>}
 */
function listDispatchClaims(db, hostname) {
  if (typeof hostname !== 'string' || hostname === '') {
    throw new Error('listDispatchClaims requires the hostname whose dispatch claims to count');
  }
  // Anchored to THIS host: `local-<host>-dispatch-<digits>`. The LIKE prefix
  // narrows the scan (hostname metacharacters escaped), and the suffix check
  // rejects anything that only looks similar — including another host's
  // workers and free-form --worker-id values.
  const prefix = `local-${hostname}${DISPATCH_WORKER_MARKER}`;
  const pattern = `${prefix.replace(/[\\%_]/g, (char) => `\\${char}`)}%`;
  return db.prepare(
    "SELECT id, claimed_by FROM tasks WHERE status = 'running' AND claimed_by LIKE ? ESCAPE '\\'",
  ).all(pattern).filter((row) => {
    // LIKE is ASCII case-insensitive; the prefix must match exactly.
    const claimedBy = String(row.claimed_by);
    return claimedBy.startsWith(prefix) && /^\d+$/.test(claimedBy.slice(prefix.length));
  });
}

/**
 * Dependencies that keep a task unrunnable: every dependency must have
 * succeeded. This is the single definition of that rule — claimNextTask
 * filters with UNSATISFIED_DEPENDENCY_IDS (as `id NOT IN (...)`), and
 * blockingDependencies() reports the rows that make a NAMED task unrunnable.
 */
const DEPENDENCY_UNSATISFIED = "dep.status != 'succeeded'";
const UNSATISFIED_DEPENDENCY_IDS = `
  SELECT td.task_id FROM task_dependencies td
  JOIN tasks dep ON dep.id = td.depends_on_task_id
  WHERE ${DEPENDENCY_UNSATISFIED}
`;

/**
 * Approval predicate, shared by claimNextTask's SQL filter and the named-task
 * gate. A locally-owned task is the local operator's own enqueue, which is the
 * human act; every other claimer needs a recorded approval.
 *
 * @param {string[]} localSources
 * @returns {string} SQL condition, with one placeholder per local source
 */
function approvalCondition(localSources) {
  if (!localSources.length) return '(approval_required = 0 OR approved_by IS NOT NULL)';
  return `(approval_required = 0 OR approved_by IS NOT NULL OR source IN (${localSources.map(() => '?').join(', ')}))`;
}

/**
 * The dependencies of `taskId` that have not succeeded, oldest first.
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {string} taskId
 * @returns {Array<{ id: string, status: string }>}
 */
function blockingDependencies(db, taskId) {
  return db.prepare(`
    SELECT dep.id AS id, dep.status AS status
    FROM task_dependencies td
    JOIN tasks dep ON dep.id = td.depends_on_task_id
    WHERE td.task_id = ? AND ${DEPENDENCY_UNSATISFIED}
    ORDER BY dep.created_at ASC, dep.id ASC
  `).all(taskId);
}

/**
 * The claim gates a NAMED task must pass, shared with claimNextTask's SQL
 * filters: human approval (a locally-owned task is the local operator's own
 * enqueue) and dependency satisfaction. Returns the refusal reason, or null.
 *
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {Record<string, any>} row
 * @param {{ localSources?: string[] }} [options]
 * @returns {string|null}
 */
function claimGateRefusal(db, row, { localSources = [] } = {}) {
  // Same predicate claimNextTask filters with, evaluated for this one row.
  const approved = db.prepare(
    `SELECT 1 AS ok FROM tasks WHERE id = ? AND ${approvalCondition(localSources)}`,
  ).get(row.id, ...localSources);
  if (!approved) {
    return `Task ${row.id} requires human approval before it can run.`;
  }
  const blocking = blockingDependencies(db, row.id);
  if (blocking.length) {
    const detail = blocking.map((dep) => `${dep.id.slice(0, 8)} ${dep.status}`).join(', ');
    return `Task ${row.id} is blocked: dependencies not succeeded (${detail}).`;
  }
  return null;
}

// --- Task queries ---

function createTask(db, task) {
  const id = uuidv4();
  const ts = nowIso();
  // Priority renders unquoted-adjacent in the dashboard; coerce hostile or
  // garbage input to a finite number instead of persisting a raw string.
  const priority = Number.isFinite(Number(task.priority)) ? Number(task.priority) : 0;
  // Status is a closed set that the claim/recovery/prune machinery reasons
  // about; an arbitrary client-supplied status is a permanent queue poison
  // (e.g. 'running' with NULL lease/started fields matches no recovery
  // clause and is not prunable either). Only 'pending' is creatable; all
  // other transitions happen through the lifecycle functions.
  if (task.status != null && task.status !== 'pending') {
    const err = new Error(`Invalid status at creation: ${String(task.status)} (only 'pending' can be created)`);
    err.statusCode = 400;
    throw err;
  }

  const issueInput = task.kind === 'github_issue' || task.issue_num != null
    ? validateIssueInput(Number.isSafeInteger(task.issue_num) && task.issue_num > 0
      ? issueInputFromPrompt(task.prompt, task.issue_num) : null, task.issue_num) : null;

  try {
    db.exec('BEGIN IMMEDIATE');

    db.prepare(`
      INSERT INTO tasks (id, kind, status, priority, source, repo, issue_num,
                         base_branch, prompt, depends_on, model, provider, executor,
                         routing_policy, callback_url, trust_level, approval_required,
                         max_attempts, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      id,
      task.kind || 'prompt',
      'pending',
      priority,
      task.source || null,
      task.repo || null,
      task.issue_num || null,
      task.base_branch || null,
      issueInput ? JSON.stringify(issueInput) : task.prompt || null,
      json(task.depends_on),
      task.model || null,
      task.provider || null,
      task.executor || null,
      json(task.routing_policy),
      task.callback_url || null,
      task.trust_level || 'agent',
      task.approval_required ? 1 : 0,
      task.max_attempts > 0 ? task.max_attempts : 3,
      ts,
    );

    db.prepare(`
      INSERT INTO task_events (task_id, event, payload, created_at)
      VALUES (?, 'created', ?, ?)
    `).run(id, json({ kind: task.kind, source: task.source, input_sha256: issueInput?.sha256 }), ts);

    if (task.depends_on && Array.isArray(task.depends_on)) {
      // Validate each dependency exists as a task
      for (const depId of task.depends_on) {
        const dep = db.prepare('SELECT id FROM tasks WHERE id = ?').get(depId);
        if (!dep) throw new Error(`Dependency task ${depId} not found`);
      }
      // Detect cycles: walk transitive deps of every new dependency.
      // A cycle exists if any path leads back to the new task's id.
      const visited = new Set();
      const stack = [...task.depends_on];
      while (stack.length) {
        const current = stack.pop();
        if (current === id) throw new Error('Circular dependency detected');
        if (visited.has(current)) continue;
        visited.add(current);
        const rows = db.prepare('SELECT depends_on_task_id FROM task_dependencies WHERE task_id = ?').all(current);
        for (const row of rows) stack.push(row.depends_on_task_id);
      }

      const depStmt = db.prepare(`
        INSERT OR IGNORE INTO task_dependencies (task_id, depends_on_task_id)
        VALUES (?, ?)
      `);
      for (const depId of task.depends_on) {
        depStmt.run(id, depId);
      }
    }

    db.exec('COMMIT');

    return {
      id,
      kind: task.kind || 'prompt',
      status: 'pending',
      priority,
      source: task.source || null,
      repo: task.repo || null,
      issue_num: task.issue_num || null,
      base_branch: task.base_branch || null,
      prompt: task.prompt || null,
      model: task.model || null,
      provider: task.provider || null,
      executor: task.executor || null,
      callback_url: task.callback_url || null,
      trust_level: task.trust_level || 'agent',
      max_attempts: task.max_attempts > 0 ? task.max_attempts : 3,
      created_at: ts,
    };
  } catch (err) {
    try {
      db.exec('ROLLBACK');
    } catch { /* ignore rollback errors */ }
    throw err;
  }
}

/**
 * Claim a pending task for a worker.
 *
 * Optional eligibility filters run BEFORE the transactional claim, so a caller
 * whose policy is stricter than the queue (for example the MCP server, which
 * has no sandbox and therefore may only run trusted tasks) skips ineligible
 * rows instead of claiming and then failing them.
 *
 * @param {object} db
 * @param {string} workerId
 * @param {object} [options]
 * @param {string} [options.kind] only claim this kind
 * @param {string} [options.model]
 * @param {string} [options.modelOverride]
 * @param {number} [options.maxAttempts]
 * @param {((model: string) => { model: string, provider: string|null })|null} [options.resolveAutoModel]
 * @param {number} [options.leaseMinutes]
 * @param {string[]} [options.trustLevels] only claim these `trust_level` values
 * @param {string[]} [options.excludeKinds] never claim these kinds
 * @param {((candidate: object) => boolean)|null} [options.acceptCandidate] extra predicate on the raw row
 * @param {string|string[]|null} [options.localTaskSource] tasks created by
 *   these sources are governed by a LOCAL operator: claimable without approval
 *   (enqueueing on this machine is the human act) and exempt from the store's
 *   attempt cap (the local CLI owns retry policy). HTTP claims never pass this,
 *   so approval and `max_attempts` still gate them.
 */
function claimNextTask(db, workerId, {
  kind, model, modelOverride, maxAttempts = 3, resolveAutoModel = null, leaseMinutes = 60,
  trustLevels = null, excludeKinds = null, acceptCandidate = null, localTaskSource = null,
} = {}) {
  const localSources = localSourcesOf(localTaskSource);
  // Check for expired leases and clear them
  db.prepare('DELETE FROM rate_leases WHERE expires_at < ?').run(nowIso());

  // Build WHERE clause
  const conditions = ["status = 'pending'"];
  const params = [];
  if (kind) { conditions.push('kind = ?'); params.push(kind); }
  // An empty list means "no filter", not "match nothing": existing callers
  // pass no options at all and must keep seeing every pending task.
  if (Array.isArray(trustLevels) && trustLevels.length) {
    conditions.push(`trust_level IN (${trustLevels.map(() => '?').join(', ')})`);
    params.push(...trustLevels);
  }
  if (Array.isArray(excludeKinds) && excludeKinds.length) {
    conditions.push(`kind NOT IN (${excludeKinds.map(() => '?').join(', ')})`);
    params.push(...excludeKinds);
  }
  // Feedback model overrides match either that exact model or an unassigned
  // row; they never replace a task's already-selected different model.
  if (modelOverride) {
    conditions.push('(model = ? OR model IS NULL)');
    params.push(modelOverride);
  } else if (model) {
    conditions.push('model = ?');
    params.push(model);
  }

  // Check if task needs approval. A local worker may claim an unapproved task
  // it enqueued itself (localTaskSource); every other claimer, including the
  // HTTP orchestrator, still needs a human approval.
  conditions.push(approvalCondition(localSources));
  params.push(...localSources);

  // Check dependencies are satisfied (same rule as blockingDependencies).
  conditions.push(`id NOT IN (${UNSATISFIED_DEPENDENCY_IDS})`);

  // Exclude attempts-exhausted tasks HERE, not just in the per-row gate
  // below: they stay 'pending' forever, and left in the window they
  // permanently occupy scan slots, starving eligible tasks behind them
  // (the per-row check then never even sees those rows). max_attempts <= 0
  // means "use the API-level default". Locally-owned tasks are exempt: their
  // retry policy lives in the CLI, not in the store.
  const attemptGate = '((max_attempts > 0 AND attempts < max_attempts) OR (max_attempts <= 0 AND attempts < ?))';
  if (localSources.length) {
    conditions.push(`(source IN (${localSources.map(() => '?').join(', ')}) OR ${attemptGate})`);
    params.push(...localSources, maxAttempts);
  } else {
    conditions.push(attemptGate);
    params.push(maxAttempts);
  }

  const where = conditions.join(' AND ');
  // Scan pending tasks in priority order, page by page: quota-aware routing
  // skips candidates whose provider is saturated (or whose auto model has no
  // headroom), so a single bounded window can starve eligible tasks further
  // down the queue. Pages keep the scan bounded — each row carries the full
  // prompt (up to ~1 MB) and a saturated claim retries on every request —
  // while still reaching deeper tasks when the near window is unsatisfiable.
  // Deep-queue deployments can widen the scan via AGENTQ_CLAIM_MAX_PAGES.
  const PAGE = 500;
  const MAX_PAGES = Math.max(1, Number(process.env.AGENTQ_CLAIM_MAX_PAGES) || 4); // 2000 rows by default
  const stmt = db.prepare(
    `SELECT * FROM tasks WHERE ${where} ORDER BY priority DESC, created_at ASC LIMIT ? OFFSET ?`,
  );

  for (let page = 0; page < MAX_PAGES; page++) {
    // Bind order follows the SQL text: WHERE params first, then LIMIT/OFFSET.
    const candidates = stmt.all(...params, PAGE, page * PAGE);
    if (!candidates.length) break;

    for (const candidate of candidates) {
    // Caller-supplied eligibility predicate, evaluated on the raw row before
    // any model resolution or lease acquisition: a refused candidate must be
    // skipped, never claimed and then failed.
    if (typeof acceptCandidate === 'function' && !acceptCandidate(candidate)) continue;

    // Resolve auto models and explicit overrides server-side before acquiring
    // leases. A feedback worker may choose a model for a task whose model is
    // still null; the stored task is updated only inside the successful claim.
    let task = { ...candidate };
    if (task.model == null && modelOverride) {
      try {
        const resolved = resolveAutoModel ? resolveAutoModel(modelOverride) : { model: modelOverride, provider: null };
        task = { ...task, model: resolved.model, provider: resolved.provider };
      } catch {
        // no headroom or invalid routing; skip and try next candidate
        continue;
      }
    } else if (task.model === 'auto' && resolveAutoModel) {
      try {
        const resolved = resolveAutoModel(task.model);
        task = { ...task, model: resolved.model, provider: resolved.provider };
      } catch {
        // no headroom for this task; skip and try next candidate
        continue;
      }
    }

    // Check max_attempts on the task itself, then the API parameter. The
    // exemption needs an actual source: a null source must never compare equal
    // to an absent localTaskSource.
    const effectiveMax = task.max_attempts > 0 ? task.max_attempts : maxAttempts;
    const locallyOwned = localSources.includes(task.source);
    if (!locallyOwned && task.attempts >= effectiveMax) continue;

    // Transactional claim: capacity check, rate-lease acquisition, and
    // task status update happen atomically so two concurrent workers
    // cannot both see the same remaining capacity and both claim a task.
    try {
      db.exec('BEGIN IMMEDIATE');
      const { claimed } = claimCandidateWithinTx(db, task, workerId, leaseMinutes);
      if (!claimed) {
        db.exec('ROLLBACK');
        continue; // claimed by another worker or capacity full; try next
      }
      db.exec('COMMIT');
      return claimed;
    } catch (err) {
      try { db.exec('ROLLBACK'); } catch { /* ignore rollback errors */ }
      throw err;
    }
    }

    if (candidates.length < PAGE) break; // last page; deeper pages are empty
  }

  // No candidate with capacity found.
  return null;
}

/**
 * Claim one specific task row inside an OPEN transaction.
 *
 * Returns the claimed row, or null when the row is no longer pending or the
 * provider has no capacity left. The caller owns BEGIN/COMMIT/ROLLBACK so the
 * status re-check and the update stay atomic.
 */
function claimCandidateWithinTx(db, task, workerId, leaseMinutes, eventExtra = null) {
  const recheck = db.prepare(
    "SELECT * FROM tasks WHERE id = ? AND status = 'pending'",
  ).get(task.id);
  if (!recheck) return { claimed: null, refused: null };

  // Acquire rate-limit leases inside the transaction so they are rolled back
  // if the claim fails — no orphan leases.
  let leaseResults = null;
  if (task.provider) {
    const limits = getRateLimits(db, task.provider);
    if (limits.length) {
      leaseResults = acquireRateLimitLeaseWithinTx(db, task.provider, task.model, task.id);
      if (!leaseResults) {
        return {
          claimed: null,
          refused: `Provider ${task.provider} is at its rate limit; no lease available for ${task.model ?? 'this task'}.`,
        };
      }
    }
  }

  const leaseExpires = new Date(Date.now() + leaseMinutes * 60 * 1000).toISOString();
  // A fresh token per claim: claimed_by alone can't distinguish successive
  // claims by the SAME worker (a stale session from claim N would otherwise
  // complete claim N+1 of the same task).
  const claimToken = uuidv4();

  db.prepare(`
    UPDATE tasks SET
      status = 'running',
      model = ?,
      provider = ?,
      claimed_by = ?,
      claim_token = ?,
      attempts = attempts + 1,
      lease_expires_at = ?,
      started_at = COALESCE(started_at, ?)
    WHERE id = ?
  `).run(task.model, task.provider, workerId, claimToken, leaseExpires, nowIso(), task.id);

  // `eventExtra` records what an explicit override replaced (previous_model /
  // previous_provider) so the audit trail can explain a model the task was not
  // queued with.
  db.prepare(`
    INSERT INTO task_events (task_id, event, payload, created_at)
    VALUES (?, 'claimed', ?, ?)
  `).run(task.id, json({ worker: workerId, model: task.model, ...(eventExtra || {}) }), nowIso());

  return {
    claimed: {
      ...task,
      status: 'running',
      claimed_by: workerId,
      claim_token: claimToken,
      lease_expires_at: leaseExpires,
      _lease: leaseResults?.[0] || null,
    },
    refused: null,
  };
}

/**
 * Claim one specific pending task by id.
 *
 * Used by local retries and by `agentq run --id`: the caller re-claims (or
 * names) the SAME task instead of racing other workers for "the next" one.
 * Eligibility is the same as claimNextTask — pending, attempts remaining, and
 * the approval/dependency gates, which run inside the same write transaction
 * so a concurrent approval or completion is never missed.
 *
 * @returns {object|null|{ refused: string }} the claimed task; null when it is
 *   not claimable at all (already claimed, or the row is gone); or
 *   `{ refused }` when the task cannot run RIGHT NOW but stays pending: an
 *   approval/dependency gate, a spent attempt budget, or a full provider rate
 *   limit. A refusal leaves the task untouched.
 */
function claimTaskById(db, taskId, workerId, {
  model = null, provider = null, leaseMinutes = 60, maxAttempts = 3, localTaskSource = null,
} = {}) {
  const localSources = localSourcesOf(localTaskSource);
  try {
    db.exec('BEGIN IMMEDIATE');
    const row = db.prepare("SELECT * FROM tasks WHERE id = ? AND status = 'pending'").get(taskId);
    if (!row) {
      db.exec('ROLLBACK');
      return null;
    }
    const effectiveMax = row.max_attempts > 0 ? row.max_attempts : maxAttempts;
    const locallyOwned = localSources.includes(row.source);
    if (!locallyOwned && row.attempts >= effectiveMax) {
      // A spent budget is a refusal, not "not claimable": the task stays
      // pending and the caller must say why (requeue resets the budget).
      db.exec('ROLLBACK');
      return { refused: `Task ${row.id} has no attempts left (${row.attempts}/${effectiveMax}).` };
    }
    // Policy gates are refusals, not "not claimable": the task stays pending
    // and the caller reports why (the CLI exits 2) instead of claiming it.
    const refusal = claimGateRefusal(db, row, { localSources });
    if (refusal) {
      db.exec('ROLLBACK');
      return { refused: refusal };
    }
    const task = { ...row };
    let eventExtra = null;
    if (model) {
      task.model = model;
      task.provider = provider;
      // Only an override that actually replaces a CONCRETE model is worth
      // recording. Filling in a routed model for 'auto' (or for an unset
      // model) is the normal claim path, not an override.
      if (row.model != null && row.model !== 'auto' && row.model !== model) {
        eventExtra = { previous_model: row.model, previous_provider: row.provider ?? null };
      }
    }
    const { claimed, refused } = claimCandidateWithinTx(db, task, workerId, leaseMinutes, eventExtra);
    if (!claimed) {
      db.exec('ROLLBACK');
      return refused ? { refused } : null;
    }
    db.exec('COMMIT');
    return claimed;
  } catch (err) {
    try { db.exec('ROLLBACK'); } catch { /* ignore rollback errors */ }
    throw err;
  }
}

function completeTask(db, taskId, result, { claimedBy, claimToken } = {}) {
  const ts = nowIso();
  // Fail closed: only the three statuses the executors actually report
  // (succeeded/failed/unverified) are honored — anything else (a worker bug
  // reporting 'cancelled'/'partial', or a hostile report) must not be
  // recorded as a success, and 'unverified' stays distinct from 'succeeded'
  // so the verification gate keeps surfacing untested diffs.
  const knownStatuses = ['succeeded', 'failed', 'unverified'];
  const finalStatus = knownStatuses.includes(result.status) ? result.status : 'failed';

  // Transactional completion: verify task exists, update, record event, store usage
  try {
    db.exec('BEGIN IMMEDIATE');

    // Only a task that is actually running can be completed, and (when the
    // reporter identifies itself) only by the worker currently holding its
    // claim — otherwise a stale worker whose lease was reclaimed by
    // recoverExpiredTasks could overwrite a fresher run's result, or a
    // never-claimed pending task could be marked succeeded without running.
    const conditions = ['id = ?', "status = 'running'"];
    const params = [taskId];
    if (claimedBy) { conditions.push('claimed_by = ?'); params.push(claimedBy); }
    // claimToken identifies the CLAIM, not just the claimant — a stale
    // session from an earlier claim of the same task by the same worker
    // must not complete a later re-claim. Only checked when provided
    // (legacy sessions without a token fall back to claimed_by alone).
    if (claimToken) { conditions.push('claim_token = ?'); params.push(claimToken); }
    const existing = db.prepare(`SELECT * FROM tasks WHERE ${conditions.join(' AND ')}`).get(...params);
    if (!existing) {
      db.exec('ROLLBACK');
      // Record the orphaned report even though it's rejected: without this,
      // a worker's real result (a genuine success, with real cost/usage
      // data) vanishes with zero trace the moment the task's state no
      // longer matches — e.g. recoverExpiredTasks re-pent it while this
      // worker was still genuinely running — and whoever claims the
      // re-pended task next duplicates work that had already finished.
      const stale = db.prepare('SELECT id, status, claimed_by FROM tasks WHERE id = ?').get(taskId);
      if (stale) {
        try {
          db.prepare(`
            INSERT INTO task_events (task_id, event, payload, created_at)
            VALUES (?, 'orphaned_completion', ?, ?)
          `).run(taskId, json({
            reportedBy: claimedBy || null,
            currentStatus: stale.status,
            currentClaimedBy: stale.claimed_by,
            result,
          }), ts);
        } catch { /* best-effort audit only — must not mask the rejection below */ }
      }
      throw new Error(`Task not running or not claimed by this worker: ${taskId}`);
    }

    const isIssueTask = existing.kind === 'github_issue' || existing.issue_num != null;
    const issueInput = issueInputFromPrompt(existing.prompt, existing.issue_num);
    if (isIssueTask) validateIssueInput(issueInput, existing.issue_num);
    if (issueInput) {
      if (result.input_sha256 != null && result.input_sha256 !== issueInput.sha256) {
        const error = new Error('Completion input digest does not match the immutable task snapshot.');
        error.statusCode = 400;
        throw error;
      }
      result = { ...result, input_sha256: issueInput.sha256 };
    }

    // A failure with attempts remaining is re-pended (server-side retry via
    // max_attempts) instead of terminal — without this, attempts/max_attempts
    // only ever bounded lease-expiry recovery, and a failed task simply
    // stayed 'failed' forever regardless of how many retries it had left.
    const effectiveMax = existing.max_attempts > 0 ? existing.max_attempts : 3;
    const willRetry = finalStatus === 'failed' && result.retryable !== false && existing.attempts < effectiveMax;

    if (willRetry) {
      db.prepare(`
        UPDATE tasks SET
          status = 'pending',
          claimed_by = NULL,
          claim_token = NULL,
          lease_expires_at = NULL,
          last_heartbeat_at = NULL,
          started_at = NULL,
          result = ?
        WHERE id = ?
      `).run(json(result), taskId);

      db.prepare(`
        INSERT INTO task_events (task_id, event, payload, created_at)
        VALUES (?, 'requeued', ?, ?)
      `).run(taskId, json({ auto: true, attempts: existing.attempts, max_attempts: effectiveMax, status: result.status, input_sha256: result.input_sha256 }), ts);
    } else {
      db.prepare(`
        UPDATE tasks SET
          status = ?,
          result = ?,
          finished_at = ?
        WHERE id = ?
      `).run(finalStatus, json(result), ts, taskId);

      db.prepare(`
        INSERT INTO task_events (task_id, event, payload, created_at)
        VALUES (?, 'completed', ?, ?)
      `).run(taskId, json({ status: result.status, input_sha256: result.input_sha256 }), ts);
    }

    if (result.usage) {
      const u = normalizeUsage(result.usage);
      if (u) {
        db.prepare(`
          INSERT INTO usage_records (task_id, provider, model, input_tokens,
                                      output_tokens, cache_tokens, cost, created_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        `).run(
          taskId,
          result.usage.provider || null,
          result.usage.model || null,
          u.inputTokens,
          u.outputTokens,
          u.cacheTokens,
          u.totalCost,
          ts,
        );
      }
    }

    db.exec('COMMIT');

    // Release all rate-limit leases for this task outside the transaction
    releaseLeasesForTask(db, taskId);
  } catch (err) {
    try { db.exec('ROLLBACK'); } catch { /* ignore rollback errors */ }
    throw err;
  }
}

/**
 * Mark a task failed.
 *
 * Only a task that has not finished can fail: a terminal status is never
 * overwritten by a late failure report. When `claimToken` is supplied the
 * update is also fenced to that claim, so a stale reporter cannot fail a
 * re-claimed run.
 *
 * @returns {boolean} true when a row was updated
 */
function failTask(db, taskId, error, { claimToken = null } = {}) {
  const ts = nowIso();

  try {
    db.exec('BEGIN IMMEDIATE');

    const conditions = ['id = ?', "status IN ('pending', 'running')"];
    const params = [taskId];
    if (claimToken) { conditions.push('claim_token = ?'); params.push(claimToken); }

    // A failed task has no live claim: leaving claimed_by/claim_token/lease
    // behind would make a later completion look plausible to the fencing
    // checks and keep a dead lease in the recovery window.
    const updated = db.prepare(`
      UPDATE tasks SET
        status = 'failed',
        result = ?,
        finished_at = ?,
        claimed_by = NULL,
        claim_token = NULL,
        lease_expires_at = NULL,
        last_heartbeat_at = NULL
      WHERE ${conditions.join(' AND ')}
    `).run(json({ error: String(error) }), ts, ...params);

    if (updated.changes === 0) {
      db.exec('ROLLBACK');
      return false;
    }

    db.prepare(`
      INSERT INTO task_events (task_id, event, payload, created_at)
      VALUES (?, 'failed', ?, ?)
    `).run(taskId, json({ error: String(error) }), ts);

    db.exec('COMMIT');

    // Release rate-limit leases for failed tasks too
    releaseLeasesForTask(db, taskId);
    return true;
  } catch (err) {
    try { db.exec('ROLLBACK'); } catch { /* ignore rollback errors */ }
    throw err;
  }
}

/**
 * Statuses a manual/targeted requeue may start from. They are terminal, so no
 * executor still owns the task; 'running' is deliberately excluded (cancel it
 * or recover the interrupted claim first).
 */
const REQUEUEABLE_STATUSES = ['succeeded', 'failed', 'unverified', 'rejected'];

/**
 * Return a terminal task to 'pending' for another run.
 *
 * The pinned issue input (prompt) is never touched: a requeue re-runs the
 * same captured requirements. Result fields are cleared so the next run
 * cannot inherit stale worktree/usage/verification evidence, and `attempts`
 * restarts because a requeue is an explicit new run, not a store-level retry.
 *
 * @param {object} db
 * @param {string} taskId full task id
 * @param {object} [options]
 * @param {string|null} [options.model] replace the stored model (default: keep)
 * A manual requeue is an explicit new run, so it starts a fresh attempt
 * budget. Automatic retries use retryTask() instead.
 *
 * @returns {object} the re-pended task
 */
function requeueTask(db, taskId, { model = null, provider = null } = {}) {
  try {
    db.exec('BEGIN IMMEDIATE');
    const task = db.prepare('SELECT * FROM tasks WHERE id = ?').get(taskId);
    if (!task) throw new Error(`Task ${taskId} not found`);
    if (!REQUEUEABLE_STATUSES.includes(task.status)) {
      throw new Error(`Cannot requeue task in '${task.status}' status; cancel a running task or recover an interrupted one first`);
    }
    const nextModel = model || task.model;
    // A model change must not keep the previous model's provider: the next
    // claim would acquire rate-limit leases against the wrong path.
    const nextProvider = model ? (provider || null) : task.provider;
    db.prepare(`
      UPDATE tasks SET
        status = 'pending',
        model = ?,
        provider = ?,
        claimed_by = NULL,
        claim_token = NULL,
        lease_expires_at = NULL,
        last_heartbeat_at = NULL,
        started_at = NULL,
        finished_at = NULL,
        result = NULL,
        attempts = 0
      WHERE id = ?
    `).run(nextModel, nextProvider, taskId);
    db.prepare(`
      INSERT INTO task_events (task_id, event, payload, created_at)
      VALUES (?, 'requeued', ?, ?)
    `).run(taskId, json({ manual: true, model: nextModel, provider: nextProvider, previous_status: task.status }), nowIso());
    db.exec('COMMIT');
    releaseLeasesForTask(db, taskId);
    return {
      ...task,
      status: 'pending',
      model: nextModel,
      provider: nextProvider,
      claimed_by: null,
      claim_token: null,
      lease_expires_at: null,
      last_heartbeat_at: null,
      started_at: null,
      finished_at: null,
      result: null,
      attempts: 0,
    };
  } catch (err) {
    try { db.exec('ROLLBACK'); } catch { /* ignore rollback errors */ }
    throw err;
  }
}

/**
 * Claim the retry of one specific failed completion, atomically.
 *
 * Everything happens in one write transaction: the completion fence, the
 * attempt budget, the re-pend and the re-claim. Either the retry is claimed or
 * the task is left exactly as it was — a refused retry can never strand a task
 * in 'pending' with an exhausted budget. Tasks created by `localTaskSource`
 * are exempt from the budget (the local CLI owns their retry policy).
 *
 * @returns {object|null} the claimed task, or null when the retry is
 *   superseded, the budget is spent, or another owner took the task
 */
function retryTask(db, taskId, {
  workerId, expectedCompletionId, model = null, provider = null,
  leaseMinutes = 60, maxAttempts = 3, localTaskSource = null,
} = {}) {
  const localSources = localSourcesOf(localTaskSource);
  try {
    db.exec('BEGIN IMMEDIATE');
    const task = db.prepare('SELECT * FROM tasks WHERE id = ?').get(taskId);
    if (!task) {
      db.exec('ROLLBACK');
      return null;
    }
    const stored = parseJson(task.result);
    if (!stored || stored.completion_id !== expectedCompletionId) {
      db.exec('ROLLBACK');
      return null; // a different completion now owns the task
    }
    if (task.status !== 'pending' && !REQUEUEABLE_STATUSES.includes(task.status)) {
      db.exec('ROLLBACK');
      return null; // running: someone else is on it
    }
    const effectiveMax = task.max_attempts > 0 ? task.max_attempts : maxAttempts;
    const locallyOwned = localSources.includes(task.source);
    if (!locallyOwned && task.attempts >= effectiveMax) {
      db.exec('ROLLBACK');
      return null; // the store's retry budget is spent
    }

    const nextModel = model || task.model;
    const nextProvider = model ? (provider || null) : task.provider;
    db.prepare(`
      UPDATE tasks SET
        status = 'pending',
        model = ?,
        provider = ?,
        claimed_by = NULL,
        claim_token = NULL,
        lease_expires_at = NULL,
        last_heartbeat_at = NULL,
        started_at = NULL,
        finished_at = NULL,
        result = NULL
      WHERE id = ?
    `).run(nextModel, nextProvider, taskId);
    db.prepare(`
      INSERT INTO task_events (task_id, event, payload, created_at)
      VALUES (?, 'requeued', ?, ?)
    `).run(taskId, json({ auto: true, model: nextModel, provider: nextProvider, previous_status: task.status }), nowIso());

    const { claimed } = claimCandidateWithinTx(
      db, { ...task, model: nextModel, provider: nextProvider }, workerId, leaseMinutes,
    );
    if (!claimed) {
      db.exec('ROLLBACK');
      return null;
    }
    db.exec('COMMIT');
    // No lease release here: the previous claim's leases were released when it
    // completed, and the re-claim inside this transaction just acquired the
    // lease the retry needs. Releasing now would hand capacity back while the
    // retry is running.
    return claimed;
  } catch (err) {
    try { db.exec('ROLLBACK'); } catch { /* ignore rollback errors */ }
    throw err;
  }
}

/**
 * Release a running claim back to 'pending' after an interrupted run.
 *
 * Fenced by claimed_by/claim_token when supplied, so a stale worker cannot
 * re-pend a task another worker has since claimed. The interrupted attempt
 * produced no completion, so its result fields are cleared. `attempts` is
 * NOT reset: only an explicit requeue starts a fresh budget, which keeps the
 * store's retry accounting honest (and local CLI tasks are exempt from the
 * attempt cap anyway).
 *
 * @returns {object|null} the re-pended task, or null when no running claim
 *   matched (already completed, recovered, or reassigned)
 */
function recoverTask(db, taskId, { claimedBy = null, claimToken = null, reason = 'interrupted' } = {}) {
  try {
    db.exec('BEGIN IMMEDIATE');
    const conditions = ['id = ?', "status = 'running'"];
    const params = [taskId];
    if (claimedBy) { conditions.push('claimed_by = ?'); params.push(claimedBy); }
    if (claimToken) { conditions.push('claim_token = ?'); params.push(claimToken); }
    const task = db.prepare(`SELECT * FROM tasks WHERE ${conditions.join(' AND ')}`).get(...params);
    if (!task) {
      db.exec('ROLLBACK');
      return null;
    }
    db.prepare(`
      UPDATE tasks SET
        status = 'pending',
        claimed_by = NULL,
        claim_token = NULL,
        lease_expires_at = NULL,
        last_heartbeat_at = NULL,
        started_at = NULL,
        finished_at = NULL,
        result = NULL
      WHERE id = ?
    `).run(taskId);
    db.prepare(`
      INSERT INTO task_events (task_id, event, payload, created_at)
      VALUES (?, 'recovered', ?, ?)
    `).run(taskId, json({ reason: String(reason) }), nowIso());
    db.exec('COMMIT');
    releaseLeasesForTask(db, taskId);
    return {
      ...task,
      status: 'pending',
      claimed_by: null,
      claim_token: null,
      finished_at: null,
      result: null,
    };
  } catch (err) {
    try { db.exec('ROLLBACK'); } catch { /* ignore rollback errors */ }
    throw err;
  }
}

/** Minimum characters accepted for a task-id prefix. */
const MIN_ID_PREFIX = 6;

/**
 * Resolve a full task id or a unique prefix of at least MIN_ID_PREFIX chars.
 *
 * Task ids are UUIDs, so nobody types them in full. Ambiguity is an error
 * that lists the matches rather than picking one.
 *
 * @returns {string} the full task id
 */
function resolveTaskId(db, input) {
  const value = String(input ?? '').trim();
  if (!value) throw new Error('Missing task id');
  const exact = db.prepare('SELECT id FROM tasks WHERE id = ?').get(value);
  if (exact) return exact.id;
  if (value.length < MIN_ID_PREFIX) {
    throw new Error(`No task found with id ${value} (a prefix must be at least ${MIN_ID_PREFIX} characters)`);
  }
  // Escape LIKE metacharacters: a prefix is literal text, not a pattern.
  const pattern = `${value.replace(/[\\%_]/g, (char) => `\\${char}`)}%`;
  const matches = db.prepare(
    "SELECT id FROM tasks WHERE id LIKE ? ESCAPE '\\' ORDER BY created_at ASC, id ASC",
  ).all(pattern);
  if (!matches.length) throw new Error(`No task found with id ${value}`);
  if (matches.length > 1) {
    const listed = matches.slice(0, 10).map((row) => row.id).join(', ');
    const more = matches.length > 10 ? `, ... (${matches.length} total)` : '';
    throw new Error(`Ambiguous id prefix ${value} matches ${matches.length} tasks: ${listed}${more}`);
  }
  return matches[0].id;
}

function getTask(db, taskId) {
  return db.prepare('SELECT * FROM tasks WHERE id = ?').get(taskId);
}

function listTasks(db, { status, kind, limit = 50, offset = 0 } = {}) {
  const conditions = [];
  const params = [];
  if (status) { conditions.push('status = ?'); params.push(status); }
  if (kind) { conditions.push('kind = ?'); params.push(kind); }
  const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
  const tasks = db.prepare(`SELECT * FROM tasks ${where} ORDER BY created_at DESC LIMIT ? OFFSET ?`)
    .all(...params, limit, offset);
  // Attach dependencies to each task
  const depStmt = db.prepare('SELECT depends_on_task_id FROM task_dependencies WHERE task_id = ?');
  for (const task of tasks) {
    const deps = depStmt.all(task.id).map(r => r.depends_on_task_id);
    task.depends_on = deps.length ? deps : null;
  }
  return tasks;
}

function listRunningTasks(db, workerId) {
  return db.prepare(
    "SELECT * FROM tasks WHERE status = 'running' AND (claimed_by = ? OR claimed_by IS NULL)",
  ).all(workerId);
}

function countByStatus(db) {
  const rows = db.prepare(
    'SELECT status, COUNT(*) as count FROM tasks GROUP BY status',
  ).all();
  const result = {};
  for (const row of rows) result[row.status] = row.count;
  return result;
}

function listTaskEvents(db, taskId) {
  return db.prepare(
    'SELECT * FROM task_events WHERE task_id = ? ORDER BY id ASC',
  ).all(taskId);
}

function listAllTaskEvents(db, { offset = 0, limit = 1000 } = {}) {
  return db.prepare(
    'SELECT * FROM task_events ORDER BY id ASC LIMIT ? OFFSET ?',
  ).all(limit, offset);
}

function createTaskEvent(db, taskId, event, payload) {
  db.prepare(
    `INSERT INTO task_events (task_id, event, payload, created_at)
     VALUES (?, ?, ?, ?)`,
  ).run(taskId, event, json(payload), nowIso());
}

function listDependencies(db, taskId) {
  return db.prepare(
    'SELECT td.depends_on_task_id FROM task_dependencies td WHERE td.task_id = ?',
  ).all(taskId);
}

function approveTask(db, taskId, approvedBy) {
  const ts = nowIso();

  try {
    db.exec('BEGIN IMMEDIATE');

    const task = db.prepare('SELECT * FROM tasks WHERE id = ? AND approval_required = 1 AND (approved_by IS NULL)').get(taskId);
    if (!task) {
      db.exec('ROLLBACK');
      throw new Error(`Task ${taskId} not found or already approved`);
    }

    const issueInput = task.kind === 'github_issue' || task.issue_num != null
      ? validateIssueInput(issueInputFromPrompt(task.prompt, task.issue_num), task.issue_num) : null;
    db.prepare(`
      UPDATE tasks SET
        approval_required = 0,
        approved_by = ?,
        approved_at = ?
      WHERE id = ?
    `).run(approvedBy, ts, taskId);

    db.prepare(`
      INSERT INTO task_events (task_id, event, payload, created_at)
      VALUES (?, 'approved', ?, ?)
    `).run(taskId, json({ approved_by: approvedBy, input_sha256: issueInput?.sha256 }), ts);

    db.exec('COMMIT');

    return { ...task, approved_by: approvedBy, approved_at: ts, approval_required: 0 };
  } catch (err) {
    try { db.exec('ROLLBACK'); } catch { /* ignore rollback errors */ }
    throw err;
  }
}

/**
 * Reject a pending task. Marks it as 'rejected' (terminal).
 * @param {object} db - Database connection
 * @param {string} taskId - Task ID to reject
 * @param {string} rejectedBy - Who rejected it
 * @param {string} [reason] - Optional rejection reason
 * @returns {object} Updated task
 */
function rejectTask(db, taskId, rejectedBy, reason) {
  const ts = nowIso();

  try {
    db.exec('BEGIN IMMEDIATE');

    const task = db.prepare('SELECT * FROM tasks WHERE id = ? AND status = ?').get(taskId, 'pending');
    if (!task) {
      db.exec('ROLLBACK');
      throw new Error(`Task ${taskId} not found or not in pending state`);
    }

    db.prepare(`
      UPDATE tasks SET
        status = 'rejected',
        approved_by = ?
      WHERE id = ?
    `).run(rejectedBy, taskId);

    db.prepare(`
      INSERT INTO task_events (task_id, event, payload, created_at)
      VALUES (?, 'rejected', ?, ?)
    `).run(taskId, json({ rejected_by: rejectedBy, reason }), ts);

    db.exec('COMMIT');

    return { ...task, status: 'rejected', approved_by: rejectedBy };
  } catch (err) {
    try { db.exec('ROLLBACK'); } catch { /* ignore rollback errors */ }
    throw err;
  }
}

/**
 * List tasks awaiting approval (approval_required = 1, approved_by IS NULL).
 */
function listPendingApprovals(db, limit = 50) {
  return db.prepare(`
    SELECT * FROM tasks
    WHERE approval_required = 1 AND approved_by IS NULL AND status = 'pending'
    ORDER BY priority DESC, created_at ASC
    LIMIT ?
  `).all(limit);
}

function recoverExpiredTasks(db, maxAgeMinutes = 60) {
  const now = nowIso();
  const cutoff = new Date(Date.now() - maxAgeMinutes * 60 * 1000).toISOString();

  try {
    db.exec('BEGIN IMMEDIATE');

    // Find running tasks whose lease has expired or whose heartbeat is stale
    const stale = db.prepare(`
      SELECT * FROM tasks
      WHERE status = 'running'
        AND (
          (lease_expires_at IS NOT NULL AND lease_expires_at <= ?)
          OR (last_heartbeat_at IS NOT NULL AND last_heartbeat_at < ?)
          OR (lease_expires_at IS NULL AND started_at < ?)
        )
    `).all(now, cutoff, cutoff);

    if (!stale.length) {
      db.exec('COMMIT');
      return { recovered: 0, skipped: 0 };
    }

    let recovered = 0;
    for (const task of stale) {
      const res = db.prepare(`
        UPDATE tasks SET
          status = 'pending',
          claimed_by = NULL,
          claim_token = NULL,
          lease_expires_at = NULL,
          last_heartbeat_at = NULL,
          started_at = NULL
        WHERE id = ? AND status = 'running'
      `).run(task.id);

      if (res.changes > 0) {
        db.prepare(`
          INSERT INTO task_events (task_id, event, payload, created_at)
          VALUES (?, 'recovered', ?, ?)
        `).run(task.id, json({ reason: 'expired_lease' }), now);

        // The attempt produced no completion report: the worker hung or died.
        // Count it against the path (src/core/path-health.js folds `lost` in
        // with timeout/error), inside this same transaction so the row is
        // never missing while the task is already back to pending.
        if (task.provider) {
          recordPathOutcome(db, {
            path: task.provider,
            model: task.model ?? null,
            taskId: task.id,
            outcome: 'lost',
          });
        }

        // Release rate-limit leases for the recovered task
        releaseLeasesForTask(db, task.id);
        recovered++;
      }
    }

    db.exec('COMMIT');
    return { recovered };
  } catch (err) {
    try { db.exec('ROLLBACK'); } catch {}
    throw err;
  }
}

function hasExpiredTasks(db, maxAgeMinutes = 60) {
  const now = nowIso();
  const cutoff = new Date(Date.now() - maxAgeMinutes * 60 * 1000).toISOString();
  const row = db.prepare(`
    SELECT COUNT(*) as count FROM tasks
    WHERE status = 'running'
      AND (
        (lease_expires_at IS NOT NULL AND lease_expires_at <= ?)
        OR (last_heartbeat_at IS NOT NULL AND last_heartbeat_at < ?)
        OR (lease_expires_at IS NULL AND started_at < ?)
      )
  `).get(now, cutoff, cutoff);
  return row.count > 0;
}

// --- Task pruning ---

const TERMINAL_TASK_STATUSES = ['succeeded', 'failed', 'unverified', 'rejected'];

function hasUnfinishedDependents(db, taskId) {
  return !!db.prepare(`
    SELECT 1 FROM task_dependencies td JOIN tasks t ON t.id = td.task_id
    WHERE td.depends_on_task_id = ?
      AND t.status NOT IN (${TERMINAL_TASK_STATUSES.map(() => '?').join(',')})
    LIMIT 1
  `).get(taskId, ...TERMINAL_TASK_STATUSES);
}

function deleteTaskRecords(db, taskId) {
  releaseLeasesForTask(db, taskId);
  db.prepare('DELETE FROM task_dependencies WHERE task_id = ? OR depends_on_task_id = ?').run(taskId, taskId);
  db.prepare('DELETE FROM usage_records WHERE task_id = ?').run(taskId);
  db.prepare('DELETE FROM task_events WHERE task_id = ?').run(taskId);
  db.prepare('DELETE FROM tasks WHERE id = ?').run(taskId);
}

function pruneCompletedTasks(db, maxAgeDays = 30) {
  const cutoff = new Date(Date.now() - maxAgeDays * 24 * 60 * 60 * 1000).toISOString();
  try {
    db.exec('BEGIN IMMEDIATE');
    const candidates = db.prepare(
      `SELECT id FROM tasks WHERE status IN (${TERMINAL_TASK_STATUSES.map(() => '?').join(',')}) AND finished_at < ?`,
    ).all(...TERMINAL_TASK_STATUSES, cutoff);
    const ids = [];
    for (const { id } of candidates) {
      // Keep the prerequisite and its outcome while any dependent can run.
      if (hasUnfinishedDependents(db, id)) continue;
      deleteTaskRecords(db, id);
      ids.push(id);
    }
    db.exec('COMMIT');
    return { pruned: ids.length, ids };
  } catch (err) {
    try { db.exec('ROLLBACK'); } catch {}
    throw err;
  }
}

function pruneTask(db, taskId) {
  try {
    // Serialize the dependency check with deletion so a concurrent enqueue
    // cannot add a dependent between the check and removal.
    db.exec('BEGIN IMMEDIATE');
    const task = db.prepare('SELECT id, status FROM tasks WHERE id = ?').get(taskId);
    if (!task) throw new Error(`Task ${taskId} not found`);
    if (!TERMINAL_TASK_STATUSES.includes(task.status)) {
      throw new Error(`Cannot delete task in '${task.status}' status`);
    }
    if (hasUnfinishedDependents(db, taskId)) {
      throw new Error(`Cannot delete task ${taskId} with unfinished dependents`);
    }
    deleteTaskRecords(db, taskId);
    db.exec('COMMIT');
    return { pruned: 1, ids: [taskId] };
  } catch (err) {
    try { db.exec('ROLLBACK'); } catch {}
    throw err;
  }
}

// --- Task updates ---

function updateTaskPriority(db, taskId, priority) {
  const task = db.prepare('SELECT id, status FROM tasks WHERE id = ?').get(taskId);
  if (!task) throw new Error(`Task ${taskId} not found`);
  if (task.status !== 'pending') throw new Error(`Cannot change priority of task in '${task.status}' status`);
  db.prepare('UPDATE tasks SET priority = ? WHERE id = ?').run(priority, taskId);
  return db.prepare('SELECT * FROM tasks WHERE id = ?').get(taskId);
}

function updateTaskPrompt(db, taskId, prompt) {
  const task = db.prepare('SELECT id, status, kind, issue_num FROM tasks WHERE id = ?').get(taskId);
  if (!task) throw new Error(`Task ${taskId} not found`);
  if (task.kind === 'github_issue' || task.issue_num != null) throw new Error('Pinned GitHub issue input is immutable; enqueue a new task for changed requirements.');
  if (task.status !== 'pending') throw new Error(`Cannot change prompt of task in '${task.status}' status`);
  db.prepare('UPDATE tasks SET prompt = ? WHERE id = ?').run(prompt, taskId);
  return db.prepare('SELECT * FROM tasks WHERE id = ?').get(taskId);
}

// --- Bulk operations ---

function bulkApproveTasks(db, taskIds, approvedBy) {
  const results = [];
  for (const id of taskIds) {
    try {
      approveTask(db, id, approvedBy);
      results.push({ id, status: 'approved' });
    } catch (e) {
      results.push({ id, status: 'error', error: e.message });
    }
  }
  return results;
}

function bulkRejectTasks(db, taskIds, rejectedBy, reason) {
  const results = [];
  for (const id of taskIds) {
    try {
      rejectTask(db, id, rejectedBy, reason);
      results.push({ id, status: 'rejected' });
    } catch (e) {
      results.push({ id, status: 'error', error: e.message });
    }
  }
  return results;
}

function bulkDeleteTasks(db, taskIds) {
  const results = [];
  for (const id of taskIds) {
    try {
      pruneTask(db, id);
      results.push({ id, status: 'deleted' });
    } catch (e) {
      results.push({ id, status: 'error', error: e.message });
    }
  }
  return results;
}

// --- Export ---

function exportTasksAsJsonl(db, { status, limit = 1000 } = {}) {
  const conditions = [];
  const params = [];
  if (status) { conditions.push('status = ?'); params.push(status); }
  const where = conditions.length ? 'WHERE ' + conditions.join(' AND ') : '';
  const tasks = db.prepare(`SELECT * FROM tasks ${where} ORDER BY created_at DESC LIMIT ?`).all(...params, limit);
  return tasks.map(t => JSON.stringify(t)).join('\n');
}

function exportTasksAsCsv(db, { status, limit = 1000 } = {}) {
  const conditions = [];
  const params = [];
  if (status) { conditions.push('status = ?'); params.push(status); }
  const where = conditions.length ? 'WHERE ' + conditions.join(' AND ') : '';
  const tasks = db.prepare(`SELECT * FROM tasks ${where} ORDER BY created_at DESC LIMIT ?`).all(...params, limit);
  if (!tasks.length) return '';
  const headers = Object.keys(tasks[0]);
  const rows = tasks.map(t => headers.map(h => {
    let v = t[h];
    if (typeof v === 'string') {
      // Formula injection: spreadsheets evaluate cells starting with = + - @
      // (or tab/CR). Task prompts are issue text, so neutralize with a
      // leading apostrophe (it renders as a literal quote in the cell).
      if (/^[=+\-@\t\r]/.test(v)) v = `'${v}`;
      // A raw CR inside an unquoted cell is a record separator in CR-aware
      // readers — the continuation could start a formula — so quote on \r
      // too, not just \n.
      if (v.includes(',') || v.includes('"') || v.includes('\n') || v.includes('\r')) {
        v = `"${v.replace(/"/g, '""')}"`;
      }
    }
    return v ?? '';
  }).join(','));
  return [headers.join(','), ...rows].join('\n');
}

// --- Worker cleanup ---

function cleanupStaleWorkers(db, maxAgeMinutes = 60) {
  const cutoff = new Date(Date.now() - maxAgeMinutes * 60 * 1000).toISOString();
  const stale = db.prepare('SELECT id FROM workers WHERE last_seen < ?').all(cutoff);
  if (!stale.length) return { removed: 0, ids: [] };
  for (const w of stale) {
    db.prepare('DELETE FROM workers WHERE id = ?').run(w.id);
  }
  return { removed: stale.length, ids: stale.map(w => w.id) };
}

// --- Usage recording ---

function recordUsage(db, { taskId, provider, model, inputTokens, outputTokens, cacheTokens, cost }) {
  db.prepare(`
    INSERT INTO usage_records (task_id, provider, model, input_tokens, output_tokens, cache_tokens, cost, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(taskId, provider || null, model || null, inputTokens || 0, outputTokens || 0, cacheTokens || 0, cost || 0, nowIso());
}

function getUsageByTask(db, taskId) {
  return db.prepare('SELECT * FROM usage_records WHERE task_id = ? ORDER BY created_at DESC').all(taskId);
}

const PATH_OUTCOMES = Object.freeze(['ok', 'timeout', 'error', 'verify_failed', 'lost']);

/** Rows older than this are pruned on every insert (cheap DELETE). */
const PATH_OUTCOME_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;

/** Default health window: the last hour of attempts for every path. */
const PATH_OUTCOME_WINDOW_MS = 60 * 60 * 1000;

/**
 * Record one execution attempt's outcome for the quota path it ran on.
 * Prunes rows older than 7 days on insert.
 *
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {{ path: string, model?: string|null, taskId?: string|number|null, outcome: string }} detail
 */
function recordPathOutcome(db, { path, model = null, taskId = null, outcome }) {
  if (typeof path !== 'string' || !path) throw new Error('recordPathOutcome requires a path');
  if (!PATH_OUTCOMES.includes(outcome)) throw new Error(`recordPathOutcome: unknown outcome ${outcome}`);
  const cutoff = new Date(Date.now() - PATH_OUTCOME_RETENTION_MS).toISOString();
  db.prepare('DELETE FROM path_outcomes WHERE created_at < ?').run(cutoff);
  db.prepare(
    'INSERT INTO path_outcomes (path, model, task_id, outcome, created_at) VALUES (?, ?, ?, ?, ?)',
  ).run(path, model ?? null, taskId == null ? null : String(taskId), outcome, nowIso());
}

/**
 * Read the window's outcome rows for all paths, oldest first, for
 * src/core/path-health.js.
 *
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {{ windowMs?: number, now?: number }} [opts]
 * @returns {Array<{ path: string, outcome: string, created_at: string }>}
 */
function getPathOutcomes(db, { windowMs = PATH_OUTCOME_WINDOW_MS, now = Date.now() } = {}) {
  const cutoff = new Date(now - windowMs).toISOString();
  return db.prepare(
    'SELECT path, outcome, created_at FROM path_outcomes WHERE created_at >= ? ORDER BY created_at ASC, id ASC',
  ).all(cutoff);
}

/**
 * Record one outcome review.
 *
 * The enums are validated here, not by the caller: a row with an unknown
 * verdict would silently disappear from every track record, and a row with an
 * unknown tier would never be counted at all.
 *
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {{ model: string, tier: string, verdict: string, taskId?: string|number|null, note?: string|null, reviewer?: string|null, source?: string }} review
 * @returns {{ id: number, task_id: string|null, model: string, tier: string, verdict: string, note: string|null, reviewer: string|null, source: string, created_at: string }}
 */
function addReview(db, { model, tier, verdict, taskId = null, note = null, reviewer = null, source = 'review' }) {
  if (typeof model !== 'string' || !model.trim()) throw new Error('addReview requires a model');
  if (!REVIEW_TIERS.includes(tier)) {
    throw new Error(`addReview: unknown tier ${String(tier)} (expected ${REVIEW_TIERS.join('|')})`);
  }
  if (!REVIEW_VERDICTS.includes(verdict)) {
    throw new Error(`addReview: unknown verdict ${String(verdict)} (expected ${REVIEW_VERDICTS.join('|')})`);
  }
  if (!REVIEW_SOURCES.includes(source)) {
    throw new Error(`addReview: unknown source ${String(source)} (expected ${REVIEW_SOURCES.join('|')})`);
  }
  const createdAt = nowIso();
  const inserted = db.prepare(`
    INSERT INTO reviews (task_id, model, tier, verdict, note, reviewer, source, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    taskId == null || taskId === '' ? null : String(taskId),
    model.trim(),
    tier,
    verdict,
    note == null || note === '' ? null : String(note),
    reviewer == null || reviewer === '' ? null : String(reviewer),
    source,
    createdAt,
  );
  return db.prepare('SELECT * FROM reviews WHERE id = ?').get(inserted.lastInsertRowid);
}

/**
 * Review rows, newest first, optionally for one model and/or since a time.
 *
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {{ model?: string|null, since?: string|number|Date|null }} [opts]
 * @returns {Array<{ id: number, task_id: string|null, model: string, tier: string, verdict: string, note: string|null, reviewer: string|null, source: string, created_at: string }>}
 */
function listReviews(db, { model = null, since = null } = {}) {
  const clauses = [];
  const params = [];
  if (typeof model === 'string' && model) {
    clauses.push('model = ?');
    params.push(model);
  }
  if (since != null && since !== '') {
    const iso = since instanceof Date ? since.toISOString() : String(since);
    clauses.push('created_at >= ?');
    params.push(iso);
  }
  const where = clauses.length ? ` WHERE ${clauses.join(' AND ')}` : '';
  return db.prepare(`SELECT * FROM reviews${where} ORDER BY created_at DESC, id DESC`).all(...params);
}

/**
 * Every `verify_failed` outcome, oldest first, for the track-record fold.
 *
 * Unlike the one-hour health window, a track record is history: the rows are
 * bounded by the 7-day retention prune, not by a read window.
 *
 * @param {import('node:sqlite').DatabaseSync} db
 * @returns {Array<{ model: string|null, task_id: string|null, outcome: string, created_at: string }>}
 */
function getVerifyFailures(db) {
  return db.prepare(
    "SELECT model, task_id, outcome, created_at FROM path_outcomes WHERE outcome = 'verify_failed' ORDER BY created_at ASC, id ASC",
  ).all();
}

function getUsageByProvider(db, provider, days = 7) {
  const cutoff = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
  return db.prepare(
    `SELECT provider, model, SUM(input_tokens) as total_input,
            SUM(output_tokens) as total_output,
            SUM(cost) as total_cost
     FROM usage_records WHERE provider = ? AND created_at >= ?
     GROUP BY provider, model`,
  ).all(provider, cutoff);
}

function getTotalUsage(db, days = 7) {
  const cutoff = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
  return db.prepare(
    `SELECT SUM(cost) as total_cost,
            SUM(input_tokens) as total_input,
            SUM(output_tokens) as total_output
     FROM usage_records WHERE created_at >= ?`,
  ).get(cutoff);
}

module.exports = {
  SCHEMA,
  openDb,
  initSchema,
  createTask,
  claimNextTask,
  claimTaskById,
  claimGateRefusal,
  blockingDependencies,
  listDispatchClaims,
  DISPATCH_WORKER_MARKER,
  completeTask,
  failTask,
  requeueTask,
  retryTask,
  recoverTask,
  resolveTaskId,
  RESERVED_TASK_SOURCES,
  LOCAL_TASK_SOURCES,
  localSourcesOf,
  MIN_ID_PREFIX,
  getTask,
  listTasks,
  listRunningTasks,
  countByStatus,
  listTaskEvents,
  listAllTaskEvents,
  createTaskEvent,
  listDependencies,
  approveTask,
  rejectTask,
  listPendingApprovals,
  recoverExpiredTasks,
  hasExpiredTasks,
  pruneCompletedTasks,
  pruneTask,
  updateTaskPriority,
  updateTaskPrompt,
  bulkApproveTasks,
  bulkRejectTasks,
  bulkDeleteTasks,
  exportTasksAsJsonl,
  exportTasksAsCsv,
  cleanupStaleWorkers,
  recordUsage,
  getUsageByTask,
  getUsageByProvider,
  getTotalUsage,
  recordPathOutcome,
  getPathOutcomes,
  getVerifyFailures,
  addReview,
  listReviews,
  REVIEW_TIERS,
  REVIEW_VERDICTS,
  PATH_OUTCOMES,
  PATH_OUTCOME_RETENTION_MS,
  PATH_OUTCOME_WINDOW_MS,
};

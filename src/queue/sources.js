#!/usr/bin/env node
'use strict';

/**
 * Queue sources for agentq.
 *
 * There is one store: the orchestrator SQLite schema (`src/queue/db*.js`).
 * Two access modes sit on top of it:
 *
 *   SqliteSource       — in-process, `--source local` (default). Calls the
 *                        db-tasks functions directly on the database file.
 *   OrchestratorSource — over HTTP, `--source orchestrator`.
 *
 * A QueueSource is also a JobSink so `executeJob` can record state transitions
 * without knowing which backend owns the queue.
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { execFileSync, spawnSync } = require('node:child_process');
const { OrchestratorWorker } = require('./worker.js');
const { admit } = require('../core/admission.js');
const {
  fetchTaskInput, readSpecFile, taskInputFromTask, taskSlug, validateTaskJob,
} = require('../core/task-input.js');
const { attributePath } = require('../lib/path-attribution.js');
const { loadConfig } = require('../lib/model-picker.js');
const { homeDataPath } = require('../lib/home.js');
const { resolveAutoModel: resolveAutoModelFor, storedTier } = require('../core/auto-model.js');
const { loadPathHealth } = require('./path-health.js');
const { loadTrackRecords } = require('./track-records.js');
const {
  cancelJob,
  EXECUTOR_TIMEOUT_MS,
  jobWorktreePath,
  readPidFile,
  removePidFile,
} = require('./job-state.js');
const { canonicalizePath } = require('../lib/paths.js');
const {
  claimNextTask,
  claimTaskById,
  completeTask,
  createTask,
  failTask,
  getTask,
  LOCAL_TASK_SOURCES,
  initSchema,
  createTaskEvent,
  listTasks,
  openDb,
  recoverTask,
  requeueTask,
  resolveTaskId,
  retryTask,
  recordPathOutcome,
} = require('./db.js');

const ROOT = path.join(__dirname, '..', '..');

/** Task kinds a plain pi/claude worker can run when named by id. */
const PI_TASK_KINDS = Object.freeze(['github_issue', 'spec']);

// --- Queue database ---

const LEGACY_LOG_ERROR = 'agentq now stores its queue in SQLite; import this log once with: agentq import-log --log <path>';

/**
 * Refuse a path that names a legacy JSONL event log.
 *
 * A `.log` name is conclusive on its own (even before the file exists), and so
 * is a file whose first byte is '{': a SQLite database starts with
 * "SQLite format 3\0", so a JSONL log renamed to .sqlite is still a log.
 * Opening one as SQLite would either corrupt it or produce a confusing
 * "file is not a database" error, so fail with the migration instruction.
 */
function assertQueueDbPath(dbPath) {
  if (/\.log$/i.test(dbPath)) throw new Error(LEGACY_LOG_ERROR);
  let fd;
  try {
    fd = fs.openSync(dbPath, 'r');
  } catch {
    return; // missing file: openDb creates it
  }
  try {
    const head = Buffer.alloc(16);
    const read = fs.readSync(fd, head, 0, head.length, 0);
    if (read > 0 && head.subarray(0, read).toString('utf8').trimStart().startsWith('{')) {
      throw new Error(LEGACY_LOG_ERROR);
    }
  } finally {
    fs.closeSync(fd);
  }
}

/** Open (and initialise) the queue database at `dbPath`. */
function openQueueDb(dbPath) {
  assertQueueDbPath(dbPath);
  const db = openDb(dbPath);
  initSchema(db);
  return db;
}

/**
 * How a task's pinned input is named in the CLI: `issue 42` or
 * `spec: Title (/abs/file.md)`.
 *
 * @param {Record<string, any>|null} taskInput
 * @returns {string|null}
 */
function taskSubject(taskInput) {
  if (!taskInput) return null;
  if (taskInput.source === 'github') return `issue ${taskInput.ref}`;
  return `spec: ${taskInput.title} (${taskInput.source === 'file' ? taskInput.ref : 'inline'})`;
}

/**
 * Resolve what an enqueue request is for.
 *
 * Exactly one of `--issue` or `--spec` is required. A spec is read now, at
 * enqueue time, so later edits cannot change what runs; a failed read creates
 * nothing.
 *
 * @param {Record<string, any>} options
 * @param {string} repo resolved repository path
 * @param {Function} [issueRunner] injected `gh` runner (tests)
 * @returns {{ kind: string, issue: number|null, taskInput: Record<string, any> }}
 */
function enqueueInput(options, repo, issueRunner) {
  const hasSpec = typeof options.spec === 'string' && options.spec.trim() !== '';
  const hasIssue = options.issue !== undefined && options.issue !== null && options.issue !== '';
  if (hasSpec === hasIssue) {
    throw new Error(hasSpec
      ? 'enqueue accepts exactly one of --issue or --spec, not both'
      : 'enqueue requires --issue N or --spec FILE');
  }
  if (hasSpec) return { kind: 'spec', issue: null, taskInput: readSpecFile(options.spec) };
  const issue = Number(options.issue);
  if (!/^[0-9]+$/.test(String(options.issue)) || !Number.isSafeInteger(issue) || issue <= 0) {
    throw new Error(`Invalid --issue: ${options.issue}`);
  }
  return { kind: 'github_issue', issue, taskInput: fetchTaskInput(repo, issue, { run: issueRunner }) };
}

/**
 * Present a task row in the shape the executor, CLI and menu already use.
 *
 * Completion data (exit code, worktree, branch, usage, verification) lives in
 * the task's `result` JSON; everything else is a column.
 */
function taskToJob(task) {
  let result = null;
  try { result = task.result ? JSON.parse(task.result) : null; } catch { result = null; }
  const completion = result && typeof result === 'object' ? result : {};
  const taskInput = taskInputFromTask(task);
  return {
    id: task.id,
    kind: task.kind || 'github_issue',
    source: task.source || null,
    repo_path: task.repo || null,
    issue_number: task.issue_num ?? null,
    task_input: taskInput,
    subject: taskSubject(taskInput),
    prompt: typeof task.prompt === 'string' ? task.prompt : null,
    model: task.model || null,
    provider: task.provider || null,
    base_branch: task.base_branch || 'main',
    executor: task.executor || null,
    callback_url: task.callback_url || null,
    trusted: task.trust_level === 'trusted_agent' ? 1 : 0,
    trust_level: task.trust_level || 'agent',
    status: task.status,
    created_at: task.created_at || null,
    started_at: task.started_at || null,
    finished_at: task.finished_at || null,
    exit_code: completion.exit ?? null,
    worktree_path: completion.worktree ?? null,
    branch: completion.branch ?? null,
    session_path: completion.session ?? null,
    usage_json: completion.usage ? JSON.stringify(completion.usage) : null,
    log_path: completion.log ?? null,
    verified: completion.verified ?? null,
    verification: completion.verification ?? null,
    attempts: task.attempts,
    max_attempts: task.max_attempts,
    claimed_by: task.claimed_by ?? null,
    claim_token: task.claim_token ?? null,
  };
}

/** Split `--depends-on` into task-id tokens (full ids or unique prefixes). */
function parseDependencyIds(value) {
  if (!value) return [];
  const ids = String(value).split(',').map((entry) => entry.trim()).filter(Boolean);
  if (!ids.length) throw new Error(`Invalid --depends-on id: ${value}`);
  return [...new Set(ids)];
}

function currentBranch(repo) {
  try {
    return execFileSync('git', ['-C', repo, 'symbolic-ref', '--short', 'HEAD'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 5_000,
    }).trim();
  } catch {
    return 'master';
  }
}

/** True if `pid` names a live process (EPERM = alive but owned by someone else). */
function pidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err.code === 'EPERM';
  }
}

// --- Local (in-process) SQLite queue source ---

// Only delete a persisted branch if we can prove it belongs to this job.
// The branch name comes from the executor's result file, which the executor
// writes, not agentq — so it is not proof of ownership, and a wrong value must
// never reach prune's `git branch -D` (e.g. `branch: main`). Proof is the
// worktree checkout (the job's worktree still has the branch checked out);
// once the worktree is gone, only job-namespace names (pi/*) are deletable.
// Failing to clean up a stray branch is acceptable; deleting a user branch is
// not, so every unprovable case falls through to a skip.
/**
 * Ownership proof for the STANDALONE (executor-created) resources reported by
 * executor labels. pi-task.sh and pi-workflow.sh allocate
 * `$(mktemp -d)/pi-issue-<issue>` with branch `pi/issue-<issue>` — the random
 * mkdtemp parent is unknowable in advance, so the contract is bound by TMPDIR
 * scope + exact basename. A forged label pair can only ever name these
 * contract resources, so cleanup cannot hit arbitrary worktrees/branches.
 * Ownership requires the resources to MATCH: while the worktree exists, its
 * checkout must be the contract branch (a contract-named worktree checked out
 * on anything else is not provably this job's — delete nothing).
 */
function standaloneContract(job) {
  const input = job?.task_input ?? null;
  if (input) {
    // The same slug the executor derives from the pinned input: a GitHub task
    // keeps `pi-issue-<n>` / `pi/issue-<n>`, a spec gets `pi-task-<slug>` /
    // `pi/task-<slug>`.
    const slug = taskSlug(input);
    return { branch: `pi/${slug}`, worktreeBasename: `pi-${slug}` };
  }
  if (job?.issue_number != null) {
    return { branch: `pi/issue-${job.issue_number}`, worktreeBasename: `pi-issue-${job.issue_number}` };
  }
  return null;
}

function isContractWorktreePath(worktreePath, job) {
  const contract = standaloneContract(job);
  if (!contract) return false;
  const resolved = canonicalizePath(worktreePath);
  const tmp = canonicalizePath(os.tmpdir());
  if (!resolved || !tmp || !resolved.startsWith(tmp + path.sep)) return false;
  return path.basename(resolved) === contract.worktreeBasename;
}

function standaloneOwnership(repoPath, worktreePath, branchLabel, job) {
  const contract = standaloneContract(job);
  if (!contract) return { owned: false };
  const contractBranch = contract.branch;
  if (branchLabel != null && branchLabel !== contractBranch) return { owned: false };
  const resolved = canonicalizePath(worktreePath);
  if (!resolved) return { owned: false };
  if (!fs.existsSync(worktreePath)) return { owned: true };
  let expectedPath;
  try { expectedPath = fs.realpathSync(worktreePath); } catch { return { owned: false }; }
  try {
    const out = execFileSync('git', ['-C', repoPath, 'worktree', 'list', '--porcelain'], { encoding: 'utf8', timeout: 10_000 });
    for (const block of out.split('\n\n')) {
      const wt = block.match(/^worktree (.+)$/m);
      if (!wt) continue;
      let registeredPath;
      try { registeredPath = fs.realpathSync(wt[1]); } catch { continue; }
      if (registeredPath !== expectedPath) continue;
      const br = block.match(/^branch refs\/heads\/(.+)$/m);
      // The checkout is the live proof the worktree belongs to this job.
      return { owned: !!br && br[1] === contractBranch };
    }
    return { owned: false }; // not a registered worktree of this repo
  } catch {
    return { owned: false };
  }
}

/** True when git reports that the branch simply does not exist (already gone). */
function branchAlreadyGone(result) {
  return /not found|no branch named|unknown revision/i
    .test(`${result.stderr || ''}${result.stdout || ''}`);
}

// Local workers hold the claim for the whole executor window: there is no
// heartbeat process, so a short lease would let `recover` re-pend (and a
// second worker duplicate) a job that is legitimately still running.
const LOCAL_LEASE_MINUTES = Math.ceil(EXECUTOR_TIMEOUT_MS / 60_000) + 30;

// `LOCAL_TASK_SOURCES` (from the task store) names the `tasks.source` values
// this machine owns: the CLI's own enqueues and jobs imported from a legacy
// local log. A local worker may claim their unapproved tasks (enqueueing here
// is the human act) and owns their retry policy; HTTP claimers are unaffected.

/**
 * Local claim identities are `local-<host>-<pid>` (a plain local worker) or
 * `local-<host>-dispatch-<pid>` (a worker the MCP dispatcher started).
 *
 * The shapes are validated because the dispatch concurrency cap counts the
 * second one: a free-form `--worker-id` must not be able to impersonate a
 * dispatch worker (or another host's worker) and take slots that are not its
 * own.
 *
 * @param {string} workerId
 * @param {string} [hostname]
 * @returns {string|null} the problem, or null when the id is valid
 */
function localWorkerIdError(workerId, hostname = os.hostname()) {
  const host = hostname.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  if (new RegExp(`^local-${host}-(?:dispatch-)?\\d+$`).test(workerId)) return null;
  return `Invalid --worker-id for the local queue: ${workerId} `
    + `(expected local-${hostname}-<pid> or local-${hostname}-dispatch-<pid>)`;
}

/**
 * JobSink over the SQLite task store.
 *
 * The source is not its own sink: executeJob's sink methods (claim/finish/
 * recover/requeue) and the source's administrative methods (requeue/recover by
 * id) would otherwise collide, and they mean different things.
 */
class SqliteJobSink {
  constructor(source) {
    this.source = source;
    // The work-area/label checks and pid files read these off the sink.
    this.worktreeBase = source.worktreeBase;
    this.statePath = source.statePath;
  }

  async claim(job, { model } = {}) {
    // claimNext already committed the claim and the routed model. A direct
    // executeJob call may still resolve 'auto' itself, so keep the audit row
    // truthful about what actually ran — but only for THIS claim.
    if (!model || model === job.model) return;
    this.source.db.prepare(`
      UPDATE tasks SET model = ?
      WHERE id = ? AND status = 'running' AND claimed_by = ? AND claim_token = ?
    `).run(model, job.id, job.claimed_by || this.source.workerId, job.claim_token || '');
    job.model = model;
  }

  /**
   * Persist the completion.
   *
   * The payload uses the same snake_case keys the HTTP worker sends, so
   * completeTask's immutability checks (the pinned input digest) actually run
   * on a local completion too. Returns the completion receipt and the status
   * the store ACTUALLY recorded: a task with attempts left may have been
   * re-pended instead of finished.
   */
  async finish(job, result) {
    const completionId = randomUUID();
    completeTask(this.source.db, job.id, {
      attempt_id: result.attemptId,
      input_sha256: result.inputSha256,
      status: result.status,
      exit: result.exit,
      worktree: result.worktree,
      branch: result.branch,
      session: result.session,
      usage: result.usage,
      log: result.log,
      verified: result.verified,
      verification: result.verification,
      stop: result.stop,
      result_file: result.resultFile ?? null,
      completion_id: completionId,
    }, {
      claimedBy: job.claimed_by || this.source.workerId,
      claimToken: job.claim_token || null,
    });
    const stored = getTask(this.source.db, job.id);
    return { completionId, status: stored?.status ?? result.status };
  }

  /**
   * Release a claim.
   *
   * `retryable` (the default) is an interrupted or transient run: re-pend it so
   * the lease/PID recovery path can pick it up again.
   *
   * `retryable: false` is a deterministic refusal (an unlaunchable harness, or
   * a pi-only mode with a claude-harness model). Re-pending it would re-claim
   * and re-refuse the same head-of-queue task on every pass and starve the
   * tasks behind it, so finish it as failed with the reason in its result,
   * fenced to this claim. `requeue` starts it again once the cause is fixed.
   */
  async recover(job, err, { retryable = true } = {}) {
    const reason = err?.message || String(err || 'interrupted');
    if (retryable === false) {
      failTask(this.source.db, job.id, reason, { claimToken: job.claim_token || null });
      return;
    }
    recoverTask(this.source.db, job.id, {
      claimedBy: job.claimed_by || this.source.workerId,
      claimToken: job.claim_token || null,
      reason,
    });
  }

  async requeue(job) {
    // Only used by the sink-level retry protocol; local retries go through
    // SqliteSource.claimRetry(), which re-claims the same task by id.
    requeueTask(this.source.db, job.id, {});
  }

  jobLogPath(id) {
    return this.source.jobLogPath(id);
  }

  worktreePath(id) {
    return this.source.worktreePath(id);
  }

  /** Usage is recorded by completeTask from the completion payload. */
  recordUsage() {}

  /**
   * Record one attempt's outcome for the quota path it ran on. The DB sink
   * persists it (pruning rows older than 7 days); non-DB sinks no-op (see
   * OrchestratorSource below). Recording never fails the job: the runner
   * logs and continues when this throws.
   */
  async recordPathOutcome(job, { path, model, outcome }) {
    recordPathOutcome(this.source.db, { path, model, taskId: job.id, outcome });
  }

  /** Fire webhook callback if the job has one configured. */
  async fireCallback(job, result) {
    const callbackUrl = job.callback_url;
    if (!callbackUrl) return;
    try {
      const payload = JSON.stringify({
        jobId: job.id,
        status: result.status,
        exitCode: result.exit,
        model: job.model,
        worktree: result.worktree,
        branch: result.branch,
        verified: result.verified,
        ts: new Date().toISOString(),
      });
      await fetch(callbackUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: payload,
        signal: AbortSignal.timeout(10000), // 10s timeout
      });
    } catch (err) {
      // Callback failures are non-fatal
      console.error(`Callback to ${callbackUrl} failed: ${err.message}`);
    }
  }
}

class SqliteSource {
  /**
   * @param {string} dbPath SQLite queue file (shared with the orchestrator)
   * @param {{ issueRunner?: Function, kind?: string|null, workerId?: string }} [options]
   */
  constructor(dbPath, options = {}) {
    this.dbPath = path.resolve(dbPath);
    this.issueRunner = options.issueRunner;
    this.kind = options.kind || null;
    // The worker id is the claim identity recorded on the task. The MCP
    // dispatcher passes its own (`local-<host>-dispatch-<pid>`) so the
    // concurrency cap can count dispatch claims from the queue; recover()
    // accepts both shapes.
    this.workerId = options.workerId || `local-${os.hostname()}-${process.pid}`;
    this.worktreeBase = path.join(path.dirname(this.dbPath), 'worktrees');
    this.logBase = path.join(path.dirname(this.dbPath), 'logs');
    // PID files live beside the per-job logs; the queue file locates them.
    this.statePath = this.dbPath;
    this.db = openQueueDb(this.dbPath);
    // The sink writes claim/finish/recover/requeue to the same database.
    this.sink = new SqliteJobSink(this);
    this.inProcessRetry = true;
    // Admission refusals from the most recent claimNext() call, as
    // `{ id, reason }`. A refusal is not an empty queue: the CLI reports it.
    this.refused = [];
    // claimNext() commits the claim itself (atomically, in SQLite) and filters
    // candidates through admission, so a refused job is normally never
    // claimed. The flag still says "the claim is already committed": if
    // executeJob's gate ever refuses a claimed job (a mutated or tampered
    // job), the claim must be released or the task is stranded 'running'.
    this.claimIsRemote = true;
  }

  async start() { /* nothing to start: the database is opened in the constructor */ }

  async stop() {
    try { this.db.close(); } catch { /* already closed */ }
  }

  // --- Queue operations ---

  async enqueue(options = {}) {
    if (!options.repo) throw new Error('enqueue requires --repo');
    const repo = path.resolve(options.repo);
    if (!fs.existsSync(repo)) throw new Error(`Repo path does not exist: ${repo}`);

    const model = options.model || 'auto';
    const base = options.base || currentBranch(repo);
    // --untrusted takes precedence (explicit opt-out), then --trusted.
    const trusted = !options.untrusted && !!options.trusted;
    const deps = parseDependencyIds(options.dependsOn).map((dep) => resolveTaskId(this.db, dep));
    const config = loadConfig();
    // Capture before creating the task: a failed gh call or spec read must not
    // leave a half-created job behind, and a bad dependency id must not spend
    // a capture first.
    const { kind, issue, taskInput } = enqueueInput(options, repo, this.issueRunner);

    const task = createTask(this.db, {
      kind,
      source: 'cli',
      repo,
      issue_num: issue,
      base_branch: base,
      prompt: JSON.stringify(taskInput),
      routing_policy: options.tier ? { tier: options.tier } : null,
      model,
      provider: model === 'auto' ? null : attributePath(config, model).pathId,
      executor: options.executor ? path.resolve(options.executor) : null,
      callback_url: options.callbackUrl || null,
      trust_level: trusted ? 'trusted_agent' : 'agent',
      // An untrusted issue needs a human checkpoint. The local CLI is that
      // human (its own worker may claim `source = 'cli'` tasks), but an HTTP
      // orchestrator worker must not pick it up and fail it on the trust gate.
      approval_required: trusted ? 0 : 1,
      depends_on: deps,
      // The CLI owns retry policy (--retry): the store must not re-pend a
      // failed local run on its own, so a single attempt is terminal.
      max_attempts: 1,
    });
    return { id: task.id, status: deps.length ? 'blocked' : 'pending' };
  }

  /**
   * Would the next claim need model routing (`model = 'auto'`)?
   *
   * `run-next`/`drain` refresh stale quota before claiming, but only when a
   * routing decision is actually coming: a pinned model does not read capacity.
   * This is the same predicate claimNextTask's resolver uses.
   *
   * @returns {boolean}
   */
  hasPendingAutoModel() {
    return Boolean(this.db.prepare(
      "SELECT 1 AS ok FROM tasks WHERE status = 'pending' AND model = 'auto' LIMIT 1",
    ).get());
  }

  /**
   * Would claiming this task (by id, with an optional --model override) need
   * model routing? An unknown or ambiguous id is false: the claim reports the
   * real error, the refresh does not guess.
   *
   * @param {string} id
   * @param {string|null} [requestedModel]
   * @returns {boolean}
   */
  taskNeedsRouting(id, requestedModel = null) {
    try {
      const row = getTask(this.db, resolveTaskId(this.db, id));
      if (!row) return false;
      const model = typeof requestedModel === 'string' && requestedModel.trim() ? requestedModel : row.model;
      return model === 'auto';
    } catch {
      return false;
    }
  }

  /**
   * Claim the next runnable task for this worker.
   *
   * Admission runs as the claim's candidate filter, so a job this worker may
   * not run (untrusted without --sandbox, feedback without a boundary, corrupt
   * pinned input) stays pending with no state change at all. Every refusal is
   * recorded in `this.refused` (`{ id, reason }`) so the caller can report why
   * nothing ran instead of claiming the queue is empty.
   */
  async claimNext(options = {}) {
    const kind = options.kind || this.kind || undefined;
    // A feedback worker picks the model on the command line; the override is
    // applied to the candidate BEFORE admission, exactly like the HTTP worker's
    // pre-checks, so a task with no model yet can still be admitted.
    const modelOverride = kind === 'feedback' ? options.model : undefined;
    // The HTTP worker's pre-checks: a feedback claim needs an executor and a
    // boundary before the queue is touched. The model requirement is HTTP-only
    // (there the worker must name the model it will run); locally the task's
    // own model is used, and admission refuses a task that has none.
    if (kind === 'feedback'
      && ((!options.executor && !options.cua)
        || (!options.sandbox && !options.cua && !options.allowUntrusted))) {
      throw new Error('feedback claims require an executor and a sandbox boundary before queue access');
    }

    const refused = [];
    let routingError = null;
    const health = loadPathHealth(this.db);
    // Read once per claim, like health: the resolver runs per candidate, and a
    // per-candidate queue read would scale with the backlog. A caller that
    // already read them (the CLI) passes its own map.
    const trackRecords = options.trackRecords ?? loadTrackRecords(this.db);
    const resolve = (storedModel, candidate) => {
      try {
        return resolveAutoModelFor(storedModel, {
          ...options,
          // A task enqueued with --tier routes at that tier even when this
          // drain did not pass one; an explicit --tier still wins.
          tier: options.tier ?? storedTier(candidate),
          pathHealth: health,
          trackRecords,
        });
      } catch (error) {
        routingError ??= error;
        throw error; // claimNextTask skips this candidate
      }
    };
    const task = claimNextTask(this.db, this.workerId, {
      kind,
      modelOverride,
      resolveAutoModel: resolve,
      acceptCandidate: (candidate) => {
        const job = taskToJob(candidate);
        if (modelOverride && job.model == null) job.model = modelOverride;
        const verdict = admit(job, options);
        if (!verdict.ok) {
          refused.push({ id: candidate.id, reason: verdict.reason });
          return false;
        }
        return true;
      },
      leaseMinutes: LOCAL_LEASE_MINUTES,
      // This worker is a local CLI: it may run its own unapproved enqueues and
      // owns the retry policy for them.
      localTaskSource: LOCAL_TASK_SOURCES,
    });
    this.refused = refused;
    if (task) return taskToJob(task);
    // claimNextTask swallows routing failures to try the next candidate. When
    // nothing else was claimable, report the routing failure instead of an
    // idle queue: silently doing nothing hides a saturated/unmeasured path.
    if (routingError) throw routingError;
    return null;
  }

  /**
   * Claim one specific pending task by id (full id or unique prefix).
   *
   * `agentq run --id` uses this instead of racing other workers for "the next"
   * task. The model is resolved BEFORE the claim, exactly as claimNext does it,
   * so the audit row records the concrete model that will run: `--model`
   * overrides the stored model for this claim (the same modelOverride the
   * orchestrator worker applies) and `auto` is routed through the routing core.
   *
   * Every gate is a refusal (`this.refused`, printed by the CLI, exit 2) and
   * leaves the task pending with no state change: admission, the worker kind,
   * and — inside claimTaskById's transaction — human approval and unsatisfied
   * dependencies. A task that is not pending is an error, not an idle queue:
   * the caller asked for that exact task.
   */
  async claimById(options = {}) {
    if (!options.id) throw new Error('run --id requires --id');
    this.refused = [];
    const id = resolveTaskId(this.db, options.id);
    const task = getTask(this.db, id);
    if (!task) throw new Error(`No job found with id ${options.id}`);
    if (task.status !== 'pending') {
      throw new Error(`Job #${id} is ${task.status}, not pending: only a pending task can be run by id.`);
    }

    // A worker claims one kind of task. Naming a task of another kind must not
    // run it with this worker's executor and gates: a feedback task needs
    // --kind feedback (and its sandbox/CUA boundary), which is a different
    // worker configuration entirely.
    const workerKind = options.kind || this.kind || 'github_issue';
    // `github_issue` and `spec` are the same executor family: both are plain
    // pi/claude tasks with the same admission gate and pinned input. Naming one
    // by id is explicit, so a default worker may run either. Feedback stays a
    // different worker configuration (it needs a sandbox/CUA boundary).
    const sameFamily = PI_TASK_KINDS.includes(task.kind) && PI_TASK_KINDS.includes(workerKind);
    if (task.kind !== workerKind && !sameFamily) {
      this.refused = [{
        id,
        reason: `Task #${id} is kind '${task.kind}', but this worker runs '${workerKind}'. `
          + (task.kind === 'feedback' ? 'Run it with --kind feedback and its boundary.' : 'Run it with a matching --kind.'),
      }];
      return null;
    }

    const job = taskToJob(task);
    // --model wins for this claim; otherwise the stored model decides. 'auto'
    // is resolved now so admission (and the audit row) sees the concrete model.
    const requested = typeof options.model === 'string' && options.model.trim() ? options.model : null;
    const resolved = resolveAutoModelFor(requested ?? job.model, {
      // A named task routes for the tier it was enqueued with unless this run
      // asks for another one; the same tier review_task records later.
      tier: options.tier ?? storedTier(task),
      quotaPath: options.quota,
      roiOutputPath: options.roiOutputPath,
      runnablesPath: options.runnablesPath,
      roiConfigPath: options.roiConfigPath,
      threshold: options.threshold,
      pathHealth: loadPathHealth(this.db),
      trackRecords: loadTrackRecords(this.db),
    });
    // The quota path is re-attributed only when the model actually changes
    // (same rule as requeue). Keeping the stored provider otherwise preserves
    // rate-limit leases and path attribution for a task claimed as queued —
    // an unattributable explicit model must not silently clear them.
    const provider = resolved.model === task.model
      ? (task.provider ?? resolved.provider ?? null)
      : (resolved.provider ?? null);
    job.model = resolved.model;

    const verdict = admit(job, options);
    if (!verdict.ok) {
      this.refused = [{ id, reason: verdict.reason }];
      return null;
    }

    const claimed = claimTaskById(this.db, id, this.workerId, {
      model: resolved.model,
      provider,
      leaseMinutes: LOCAL_LEASE_MINUTES,
      localTaskSource: LOCAL_TASK_SOURCES,
    });
    if (claimed && typeof claimed.refused === 'string') {
      // Approval or dependency gate, decided inside the claim transaction so a
      // concurrent approval/completion cannot be missed. The task is untouched.
      this.refused = [{ id, reason: claimed.refused }];
      return null;
    }
    if (!claimed) {
      // Lost the race between the read and the write (an exhausted attempt
      // budget is a refusal above). Report the state that actually won.
      const after = getTask(this.db, id);
      throw new Error(`Job #${id} could not be claimed (status ${after?.status ?? 'unknown'}).`);
    }
    return taskToJob(claimed);
  }

  /** All tasks in the same shape the CLI/menu/format.js render. */
  status() {
    const tasks = listTasks(this.db, { limit: 10_000 });
    // Insertion order (rowid) breaks created_at ties: several tasks can be
    // created inside the same millisecond, and the CLI/menu must show them in
    // the order they were queued, not in UUID order.
    const seq = new Map(
      this.db.prepare('SELECT id, rowid AS seq FROM tasks').all().map((row) => [row.id, row.seq]),
    );
    const depStmt = this.db.prepare(`
      SELECT t.id AS id, t.status AS status
      FROM task_dependencies td JOIN tasks t ON t.id = td.depends_on_task_id
      WHERE td.task_id = ?
    `);
    const jobs = tasks.map((task) => {
      const job = taskToJob(task);
      const deps = depStmt.all(task.id);
      job.depends_on = deps.map((dep) => dep.id);
      let inputError = null;
      if (job.status === 'pending') {
        try { validateTaskJob(job); } catch (error) { inputError = error.message; }
      }
      const blocked = job.status === 'pending'
        && (inputError || deps.some((dep) => dep.status !== 'succeeded'));
      if (blocked) job.status = 'blocked';
      if (inputError) job.input_error = inputError;
      return job;
    });
    // Oldest first: the queue's own order, and what the CLI printed before.
    return jobs.sort((a, b) => {
      if (a.created_at !== b.created_at) return a.created_at < b.created_at ? -1 : 1;
      return (seq.get(a.id) ?? 0) - (seq.get(b.id) ?? 0);
    });
  }

  requeue(options = {}) {
    if (!options.id) throw new Error('requeue requires --id');
    const id = resolveTaskId(this.db, options.id);
    const model = options.model || null;
    // Re-attribute an explicit model change so rate-limit leases follow it.
    const provider = model && model !== 'auto' ? attributePath(loadConfig(), model).pathId : null;
    requeueTask(this.db, id, { model, provider });
    return { id, status: 'pending' };
  }

  /**
   * Re-pend interrupted LOCAL runs (this host's claims only).
   *
   * The database is shared with the orchestrator, whose workers hold their own
   * lease/heartbeat: expired orchestrator leases are the orchestrator server's
   * job (`orchestrator recover`), never this command's. A local claim holds a
   * full executor-window lease and has no heartbeat process, so liveness comes
   * from the job's PID file: an old local claim whose executor is gone was
   * interrupted. `attempts` is not reset here; only an explicit requeue starts
   * a fresh budget.
   */
  recover(options = {}) {
    const maxAge = options.maxAge ?? 60;
    const cutoff = new Date(Date.now() - maxAge * 60 * 1000).toISOString();
    // Local worker ids are `local-<hostname>-<pid>` or the dispatcher's
    // `local-<hostname>-dispatch-<pid>`: the remainder after the host prefix
    // must be the pid (optionally marked as a dispatch worker), or host "a"
    // would match another host "a-b"'s claim as its own.
    const localPrefix = `local-${os.hostname()}-`;
    const stale = this.db.prepare(`
      SELECT id, claimed_by, claim_token FROM tasks
      WHERE status = 'running' AND started_at IS NOT NULL AND started_at < ?
    `).all(cutoff).filter((row) => {
      const claimedBy = row.claimed_by || '';
      return claimedBy.startsWith(localPrefix) && /^(?:dispatch-)?\d+$/.test(claimedBy.slice(localPrefix.length));
    });
    let recovered = 0;
    for (const row of stale) {
      const pid = readPidFile(this.dbPath, row.id);
      if (pid && pidAlive(pid)) continue;
      if (recoverTask(this.db, row.id, {
        claimedBy: row.claimed_by,
        claimToken: row.claim_token,
        reason: 'stale_local_run',
      })) recovered += 1;
    }
    const skipped = this.db.prepare("SELECT count(*) AS count FROM tasks WHERE status = 'running'").get().count;
    return { recovered, skipped };
  }

  /**
   * Remove finished jobs' worktrees/branches. NEVER deletes task rows or usage.
   *
   * Every ownership rule is unchanged: the agentq worktree is self-derived, and
   * executor-reported standalone resources are deleted only inside the
   * pi-issue contract with a matching checkout. What was removed or skipped is
   * recorded as a `pruned` task event so the audit trail survives; row deletion
   * stays with the age-based `pruneCompletedTasks` orchestrator cleanup.
   *
   * Only tasks that actually have worktree/branch information are considered:
   * a plain prompt task (or an orchestrator task that never ran here) has
   * nothing to clean and is left untouched.
   */
  prune(options = {}) {
    const terminal = new Set(['succeeded', 'failed', 'unverified', 'rejected']);
    const removed = [];
    const skipped = [];
    for (const job of this.status()) {
      if (!terminal.has(job.status)) continue;
      const worktree = jobWorktreePath(this.dbPath, job.id);
      const hasResources = !!job.worktree_path || !!job.branch || fs.existsSync(worktree);
      if (!hasResources) continue;
      let anyRemoved = false;
      const jobSkipped = [];

      // The agentq worktree may already be gone (removed by hand, or never
      // created for this job) — that must not skip the separate pi-issue
      // worktree/branch cleanup below. A task without a repo (a plain prompt
      // task) never had a worktree.
      if (job.repo_path && fs.existsSync(worktree)) {
        const rm = spawnSync(
          'git',
          ['-C', job.repo_path, 'worktree', 'remove', ...(options.force ? ['--force'] : []), worktree],
          { encoding: 'utf8', timeout: 30_000 },
        );
        if (rm.status !== 0) {
          jobSkipped.push({ id: job.id, reason: (rm.stderr || rm.stdout || 'git worktree remove failed').trim() });
        } else {
          const branch = `agentq/job-${job.id}`;
          const brDel = spawnSync(
            'git', ['-C', job.repo_path, 'branch', '-D', branch],
            { encoding: 'utf8', timeout: 10_000 },
          );
          if (brDel.status !== 0 && !branchAlreadyGone(brDel)) {
            jobSkipped.push({ id: job.id, branch, reason: (brDel.stderr || brDel.stdout || 'git branch -D failed').trim() });
          } else if (brDel.status === 0) {
            anyRemoved = true;
          }
        }
      }

      if (job.worktree_path && job.worktree_path !== worktree) {
        const piWt = job.worktree_path;
        if (!isContractWorktreePath(piWt, job)) {
          // Outside this job's standalone contract (pi-issue-<issue> under
          // TMPDIR): not provably this job's resource — never delete it.
          jobSkipped.push({ id: job.id, path: piWt, reason: 'worktree label outside the standalone contract; left for manual cleanup' });
          if (job.branch) {
            jobSkipped.push({ id: job.id, branch: job.branch, reason: 'branch of a non-contract worktree; left for manual deletion' });
          }
        } else {
          // Prove ownership BEFORE any deletion so the proof can use the
          // still-present worktree checkout. A contract-named worktree whose
          // checkout is not the contract branch is not provably this job's:
          // delete NEITHER resource.
          const own = standaloneOwnership(job.repo_path, piWt, job.branch, job);
          if (!own.owned) {
            jobSkipped.push({ id: job.id, path: piWt, reason: 'standalone worktree not verified as job-owned; left for manual cleanup' });
            if (job.branch) {
              jobSkipped.push({ id: job.id, branch: job.branch, reason: 'branch not verified as job-owned; left for manual deletion' });
            }
          } else {
            if (fs.existsSync(piWt)) {
              const piRm = spawnSync(
                'git', ['-C', job.repo_path, 'worktree', 'remove', ...(options.force ? ['--force'] : []), piWt],
                { encoding: 'utf8', timeout: 30_000 },
              );
              if (piRm.status !== 0) {
                jobSkipped.push({ id: job.id, path: piWt, reason: (piRm.stderr || piRm.stdout || 'git worktree remove failed').trim() });
              } else {
                anyRemoved = true;
              }
            }
            if (job.branch) {
              const brDel = spawnSync(
                'git', ['-C', job.repo_path, 'branch', '-D', job.branch],
                { encoding: 'utf8', timeout: 10_000 },
              );
              if (brDel.status !== 0 && !branchAlreadyGone(brDel)) {
                jobSkipped.push({ id: job.id, branch: job.branch, reason: (brDel.stderr || brDel.stdout || 'git branch -D failed').trim() });
              } else if (brDel.status === 0) {
                anyRemoved = true;
              }
            }
          }
        }
      }

      if (anyRemoved) removed.push(job.id);
      skipped.push(...jobSkipped);
      // The record (and its usage) stays: prune only reclaims files. The event
      // keeps an auditable trace of what was removed and what was left behind.
      createTaskEvent(this.db, job.id, 'pruned', {
        removed: anyRemoved,
        skipped: jobSkipped,
        force: !!options.force,
      });
    }
    return { status: 'pruned', removed: removed.length, ids: removed, skipped };
  }

  /**
   * Kill a running executor (pid file) and record the cancellation.
   *
   * A terminal task is never overwritten: its pid file is stale by definition,
   * so it is removed rather than killing whatever process reused that pid. A
   * running task is failed only under the claim that was observed, so a
   * re-claimed run is not clobbered. The store has no 'cancelled' status, so a
   * cancelled run is a failed run with an explicit reason.
   */
  cancel(options = {}) {
    if (!options.id) throw new Error('cancel requires --id');
    const id = resolveTaskId(this.db, options.id);
    const task = getTask(this.db, id);
    if (!task) throw new Error(`No job found with id ${options.id}`);

    if (task.status !== 'pending' && task.status !== 'running') {
      removePidFile(this.dbPath, id);
      return { cancelled: false, reason: `task already ${task.status}`, id, status: task.status };
    }

    const kill = cancelJob(this.dbPath, id);
    // Only record the cancellation when nothing can still report a result for
    // the task: the kill succeeded, or it never started.
    if (kill.cancelled || task.status === 'pending') {
      const failed = failTask(this.db, id, 'cancelled by operator', {
        claimToken: task.status === 'running' ? task.claim_token : null,
      });
      if (failed) return { ...kill, id, status: 'failed' };
    }
    return { ...kill, id, status: getTask(this.db, id)?.status ?? task.status };
  }

  /**
   * Claim the retry of the exact completion this worker just failed.
   *
   * The stored completion id fences the retry: if another owner requeued,
   * re-claimed or replaced the task meanwhile, the stored result no longer
   * matches and no retry is claimed (null). The task is re-pended through the
   * database and re-claimed by id, never through in-memory state.
   */
  async claimRetry(job, { completionId, retryCount, options = {} } = {}) {
    if (!completionId) throw new Error(`Cannot retry job #${job.id} without a completion receipt.`);
    // Read the row first: the retry routes at the tier the task was enqueued
    // with unless this run asks for another one. Resolving before any write
    // still keeps a routing failure from re-pending the task with nobody to
    // run it.
    const task = getTask(this.db, job.id);
    if (!task) return null;
    const resolved = resolveAutoModelFor(job.model, {
      ...options,
      tier: options.tier ?? storedTier(task),
      pathHealth: loadPathHealth(this.db),
      trackRecords: loadTrackRecords(this.db),
    });
    // Same rule as claimById/requeue: re-attribute the path only when the
    // model actually changes. Passing `model` unconditionally used to clear a
    // stored provider on every retry (resolved.provider is null for an
    // explicit model with no config), losing rate-limit leases and path
    // attribution the claim had already established.
    const provider = resolved.model === task.model
      ? (task.provider ?? resolved.provider ?? null)
      : (resolved.provider ?? null);
    let stored = null;
    try { stored = task.result ? JSON.parse(task.result) : null; } catch { stored = null; }
    if (!stored || stored.completion_id !== completionId) return null;
    // Atomic: fence + budget + re-pend + re-claim in one transaction, so a
    // refused retry leaves the task untouched instead of re-pending it.
    const claimed = retryTask(this.db, job.id, {
      workerId: this.workerId,
      expectedCompletionId: completionId,
      model: resolved.model,
      provider,
      leaseMinutes: LOCAL_LEASE_MINUTES,
      // Only locally-owned tasks are exempt from the store's attempt cap; an
      // orchestrator-created task keeps its max_attempts budget.
      localTaskSource: LOCAL_TASK_SOURCES,
    });
    if (!claimed) return null; // superseded, budget spent, or another owner
    // The retry is a NEW claim with a fresh token: the caller must report the
    // completion under this claim, not the one that just failed. The provider
    // travels with it too: a retry can be routed to a different path, and the
    // outcome must be recorded against the path that actually ran.
    return {
      model: claimed.model,
      provider: claimed.provider ?? null,
      claim_token: claimed.claim_token,
      claimed_by: claimed.claimed_by,
    };
  }

  jobLogPath(id) {
    fs.mkdirSync(this.logBase, { recursive: true });
    return path.join(this.logBase, `agentq-job-${id}.log`);
  }

  worktreePath(id) {
    fs.mkdirSync(this.worktreeBase, { recursive: true });
    return path.join(this.worktreeBase, `job-${id}`);
  }
}

// --- Orchestrator worker queue source ---

function normalizeTask(task) {
  const taskInput = taskInputFromTask(task);
  return {
    id: task.id,
    kind: task.kind || 'github_issue',
    repo_path: task.repo || null,
    issue_number: task.issue_num || null,
    task_input: taskInput,
    subject: taskSubject(taskInput),
    prompt: typeof task.prompt === 'string' ? task.prompt : null,
    model: task.model || null,
    provider: task.provider || null,
    routing_policy: task.routing_policy || null,
    base_branch: task.base_branch || 'main',
    executor: task.executor || null,
    trusted: task.trust_level === 'trusted_agent' ? 1 : 0,
  };
}

class OrchestratorSource {
  constructor(baseUrl, workerId, options = {}) {
    this.worker = new OrchestratorWorker(baseUrl, workerId, {
      authToken: options.authToken,
      heartbeatInterval: options.heartbeatInterval,
    });
    this.kind = options.kind || 'github_issue';
    this.issueRunner = options.issueRunner;
    // AGENTQ_WORKER_DIR relocates the worker's logs/worktrees (tests use it to
    // stay out of the checkout).
    const workerDir = process.env.AGENTQ_WORKER_DIR || homeDataPath('agentq-worker');
    this.worktreeBase = options.worktreeBase || path.join(workerDir, 'worktrees');
    this.logBase = options.logBase || path.join(workerDir, 'logs');
    this.inProcessRetry = false;
    this._started = false;
    // claimNext() claims over HTTP eagerly, before executeJob's trust gate
    // runs — a refused job must release that claim (see execute.js).
    this.claimIsRemote = true;
    // The source is its own sink: claim/finish/recover/requeue map to worker API calls.
    this.sink = this;
  }

  async start() {
    if (this._started) return;
    await this.worker.register({
      name: this.worker.workerId,
      executor: 'agentq',
      capabilities: [this.kind],
    });
    this.worker.startHeartbeat();
    this._started = true;
  }

  async stop() {
    if (!this._started) return;
    this.worker.stopHeartbeat();
    this._started = false;
  }

  async claimNext(options = {}) {
    const kind = options.kind || this.kind;
    if (kind === 'feedback'
      && ((!options.executor && !options.cua) || !options.model
        || (!options.sandbox && !options.cua && !options.allowUntrusted))) {
      throw new Error('feedback claims require an executor, model, and sandbox boundary before queue access');
    }
    const task = await this.worker.claimNext({
      kind,
      model: kind === 'feedback' ? undefined : options.model,
      modelOverride: kind === 'feedback' ? options.model : undefined,
      maxAttempts: options.maxAttempts,
      // Claim a lease long enough to cover the whole job up front. Heartbeats
      // normally renew it while the async executor runs, but a temporary event
      // loop stall or network interruption must not let recovery duplicate a
      // legitimately long-running task.
      leaseMinutes: Math.ceil(EXECUTOR_TIMEOUT_MS / 60_000) + 30,
    });
    if (!task) return null;
    return normalizeTask(task);
  }

  async enqueue(options = {}) {
    if (!options.repo) throw new Error('enqueue requires --repo');
    const repo = path.resolve(options.repo);
    if (!fs.existsSync(repo)) throw new Error(`Repo path does not exist: ${repo}`);
    const { kind, issue, taskInput } = enqueueInput(options, repo, this.issueRunner);

    const model = options.model || 'auto';
    const base = options.base || currentBranch(repo);
    const trusted = !options.untrusted && options.trusted;
    const trustLevel = trusted ? 'trusted_agent' : 'agent';
    const config = loadConfig();
    const provider = model === 'auto' ? null : attributePath(config, model).pathId;

    const task = await this.worker.enqueue({
      kind,
      repo,
      issue_num: issue,
      base_branch: base,
      model,
      provider,
      routing_policy: options.tier ? { tier: options.tier } : null,
      prompt: JSON.stringify(taskInput),
      executor: options.executor ? path.resolve(options.executor) : null,
      trust_level: trustLevel,
      approval_required: trusted ? 0 : 1,
    });
    return { id: task.id, status: trusted ? 'pending' : 'pending_approval' };
  }

  // JobSink interface (also exposed via this.sink)
  async claim(job, { model }) {
    // Claim already happened via HTTP; no local event to write.
  }

  async finish(job, result) {
    await this.worker.complete(job.id, {
      attempt_id: result.attemptId,
      input_sha256: result.inputSha256,
      status: result.status,
      exit: result.exit,
      worktree: result.worktree,
      branch: result.branch,
      session: result.session,
      usage: result.usage,
      log: result.log,
      verified: result.verified,
      verification: result.verification,
      stop: result.stop,
      result_file: result.resultFile ?? null,
    });
    // The server owns the stored status; there is no local completion receipt.
    return { completionId: null, status: result.status };
  }

  async recover(job, err, { retryable = true } = {}) {
    await this.worker.fail(job.id, err || 'worker error during execution', { retryable });
  }

  async requeue(job, { auto, retryCount }) {
    // Retry is handled server-side via max_attempts.
  }

  jobLogPath(id) {
    fs.mkdirSync(this.logBase, { recursive: true });
    return path.join(this.logBase, `agentq-job-${id}.log`);
  }

  worktreePath(id) {
    fs.mkdirSync(this.worktreeBase, { recursive: true });
    return path.join(this.worktreeBase, `job-${id}`);
  }

  // No-ops for orchestrator source (handled server-side)
  recordUsage() {}
  async fireCallback() {}

  /**
   * File/remote sink no-op: this worker reports the completion over HTTP and
   * the orchestrator records the outcome itself, in its completion route
   * (src/interfaces/http/routes.js, recordCompletionOutcome). Recording here
   * as well would double-count every remote attempt.
   */
  async recordPathOutcome() {}
}

module.exports = {
  LEGACY_LOG_ERROR,
  assertQueueDbPath,
  openQueueDb,
  taskToJob,
  SqliteJobSink,
  parseDependencyIds,
  pidAlive,
  localWorkerIdError,
  LOCAL_TASK_SOURCES,
  SqliteSource,
  OrchestratorSource,
};

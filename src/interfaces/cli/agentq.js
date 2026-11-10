#!/usr/bin/env node
'use strict';

const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');
const {
  executeJob,
  prepareJobWorktree,
  resolveAutoModel,
  resolveExecutor,
  runVerify,
} = require('../../runners/execute.js');
const { jobWorktreePath } = require('../../queue/job-state.js');
const { coverageIssues, getPathGaps, getTrackRecordPolicy, recommend, resolvePaths } = require('../../core/snapshot.js');
const { degradedMarkers } = require('../../core/routing.js');
const { loadPathHealthFile } = require('../../queue/path-health.js');
const { loadReviewsFile, loadTrackRecords, loadTrackRecordsFile } = require('../../queue/track-records.js');
const { loadRunnables } = require('../../core/catalog.js');
const { REVIEW_TIERS, REVIEW_VERDICTS, trackRecordStats } = require('../../core/track-record.js');
const { refreshQuotaIfStale } = require('../../lib/quota-refresh.js');
const { DEFAULT_TIER, normalizeTier, summarizeRejections } = require('../../core/auto-model.js');
const { isSqliteBusy } = require('../../queue/db-helpers.js');
const { showTask } = require('../../queue/task-detail.js');
const {
  localWorkerIdError,
  openQueueDb,
  OrchestratorSource,
  parseDependencyIds,
  SqliteSource,
} = require('../../queue/sources.js');
const {
  buildModelRows,
  formatModelRow,
  formatModelTable,
  formatOptionsTable,
  formatGapReport,
  formatTaskDetail,
  formatTrackRecordTable,
  truncateRepo,
  formatCost,
  formatJobBlock,
  summarizeCosts,
} = require('./format.js');

const { agentqHome, homeConfigStatus, homeDataPath, initHome } = require('../../lib/home.js');

// --db / AGENTQ_DB name the SQLite queue: the same file the orchestrator and
// the MCP server use, so local CLI jobs, orchestrator tasks and the dashboard
// all see one queue. `task_events` is the audit trail (one row per transition).
// The default lives under AGENTQ_HOME, never in the checkout.
const defaultDbPath = () => homeDataPath('orchestrator.sqlite');
const DEFAULT_ORCHESTRATOR_URL = 'http://localhost:8090';
const SAVED_WORKFLOWS_DIR = path.join(os.homedir(), '.pi', 'workflows', 'saved');

function usage() {
  return `Usage:
  node bin/agentq.js [global opts] enqueue --repo PATH (--issue N | --spec FILE) [--model MODEL] [--tier T] [--base BRANCH] [--depends-on ID[,ID...]] [--trusted] [--commit|--no-commit] [--commit-author "Name <email>"] [--json]
  node bin/agentq.js [global opts] run-next [--executor PATH] [--verify CMD] [--sandbox PATH | --cua] [--allow-untrusted] [--quota PATH] [--tier T] [--retry N] [--retry-base-ms MS] [--stop-when NL] [--json]
  node bin/agentq.js [global opts] run --id ID [--model MODEL|auto] [--tier T] [--executor PATH] [--verify CMD] [--sandbox PATH | --cua] [--allow-untrusted] [--quota PATH] [--retry N] [--retry-base-ms MS] [--stop-when NL] [--json]
  node bin/agentq.js [global opts] drain [--executor PATH] [--verify CMD] [--sandbox PATH | --cua] [--quota PATH] [--tier T] [--retry N] [--retry-base-ms MS] [--stop-when NL] [--json]
  node bin/agentq.js [global opts] requeue --id ID [--model MODEL] [--json]
  node bin/agentq.js [global opts] recover [--max-age-min N] [--json]
  node bin/agentq.js [global opts] prune [--force] [--json]
  node bin/agentq.js [global opts] pick [--tier small|medium|big] [--quota PATH] [--threshold N] [--private] [--json]
  node bin/agentq.js [global opts] review add --model ID --tier T --verdict V [--task ID] [--note TEXT] [--reviewer NAME] [--json]
  node bin/agentq.js [global opts] review amend --id N [--verdict V] [--tier T] [--note TEXT] [--json]
  node bin/agentq.js [global opts] review list [--model ID] [--json]
  node bin/agentq.js [global opts] review stats [--json]
  node bin/agentq.js [global opts] paths gaps [--json]
  node bin/agentq.js [global opts] status [--json]
  node bin/agentq.js [global opts] show --id ID [--json]
  node bin/agentq.js [global opts] save-workflow --name NAME --file PATH [--json]
  node bin/agentq.js [global opts] list-workflows [--json]
  node bin/agentq.js [global opts] cancel --id ID [--json]
  node bin/agentq.js [global opts] import-usage [--json]
  node bin/agentq.js [global opts] import-log --log PATH [--json]
  node bin/agentq.js [global opts] jules-reconnect [--json]
  node bin/agentq.js [global opts] jules-sessions [--json]
  node bin/agentq.js home [init [--force]]

  Task sources:
    --issue N pins a GitHub issue snapshot (captured with gh at enqueue time).
    --spec FILE pins a local Markdown specification: the first "# " heading is
    the title (else the file name) and the whole file is the body. Exactly one
    of --issue or --spec is required. --tier is stored in routing_policy so a
    later dispatch, the model-chosen event and review_task agree on it.
    Commit policy: --commit (the agent commits as it goes) and --no-commit
    (leave everything uncommitted for review) are mutually exclusive. The
    default is --no-commit for --spec tasks and --commit for --issue tasks.
    --commit-author "Name <email>" sets the git identity the agent commits
    under; otherwise the repo's agentq.commitAuthor git config applies, else
    the repo's normal identity.

  Executor selection:
    The runnable's harness picks the executor (pi -> pi-task.sh,
    claude -> claude-task.sh). --executor overrides it; --workflow,
    feedback jobs and --cua stay pi-only. A spec task runs on pi-task.sh
    unless --executor or the task's stored executor says otherwise.

  run --id:
    Claims exactly that task (id or unique prefix) instead of the next one, so
    a dispatcher can hand a specific task to a background worker. Every gate is
    still a refusal: a task refused by admission, of another kind than this
    worker, awaiting approval, or with unsatisfied dependencies stays pending
    and the command exits 2 with the reason. Exit 3 means the queue was busy
    (another process held the SQLite write lock) and nothing ran. --model
    overrides the stored model for this claim only (the same modelOverride the
    orchestrator worker applies); the claimed event keeps the replaced model.

  Workflow options:
    --workflow               Use pi-dynamic-workflows executor instead of pi-task.sh
    --workflow-name NAME     Run a saved workflow from ~/.pi/workflows/saved/

  Auto-routing options:
    --tier small|medium|big  Intelligence floor for --model auto (default: medium)
    --quota PATH             Quota snapshot used for capacity (default: <home>/data/quota.json)
    --private                Exclude paths whose price entry says the provider may
                             retain prompts (dataSharing: true)

  Path prices:
    agentq paths gaps        Priced models with no runnable on their path, and
                             runnables on a priced path with no price entry

  Track records (outcome reviews):
    agentq review add        Record what a model produced: --tier small|medium|big,
                             --verdict accepted|accepted-with-fixes|rejected.
                             --model must be a known runnable; --task is optional
                             (work outside the queue has no task id).
    agentq review list       Reviews, newest first (--model to filter).
    agentq review amend      Correct a review (by --id): --verdict, --tier and/or
                             --note, at least one. Model, task and reviewer are
                             frozen; the change is stamped in the review.
    agentq review stats      The per-(model, tier) track records routing uses.
                             A record with enough reviews can make an unscored
                             model eligible; it never reorders scored models.
                             Each row says how many more accepted reviews would
                             unlock it (the needed column).

  Home:
    Everything personal lives outside the checkout, in $AGENTQ_HOME
    (default: \${XDG_CONFIG_HOME:-~/.config}/agentq).
    agentq home              print the resolved home and which config files exist
    agentq home init         create <home>/config + <home>/data and seed the example setup
    agentq home init --force overwrite existing config files with the examples

  Global options:
    --db PATH                SQLite queue file (default: <home>/data/orchestrator.sqlite)
    --source local|orchestrator  queue access mode (default: local)
    --orchestrator-url URL   orchestrator base URL (default: http://localhost:8090)
    --worker-id ID           worker identity: the orchestrator worker name, or
                             the local claim identity (default local-<host>-<pid>)
    --no-quota-refresh       Do not refresh stale quota before an auto-model
                             decision (also AGENTQ_QUOTA_REFRESH=0)
    --auth-token TOKEN       bearer token for orchestrator API
    --kind KIND              task kind: github_issue, spec or feedback (default: github_issue)

  Task ids are UUIDs: --id and --depends-on accept a full id or a unique
  prefix of at least 6 characters.

  A legacy JSONL log is not a queue any more. Import it once:
    agentq --db <home>/data/orchestrator.sqlite import-log --log <home>/data/agentq.log

  Issue and spec jobs default to untrusted (require --trusted to execute bare).
  Feedback jobs are always untrusted and require --sandbox, --cua, or an explicit override.
  --cua runs feedback in a fresh network-isolated local QEMU VM; it cannot run issue jobs.
`;
}

function parseArgs(argv) {
  const args = [...argv];
  const global = {
    db: process.env.AGENTQ_DB || defaultDbPath(),
    source: process.env.AGENTQ_SOURCE || 'local',
    orchestratorUrl: process.env.AGENTQ_ORCHESTRATOR_URL || DEFAULT_ORCHESTRATOR_URL,
    workerId: process.env.AGENTQ_WORKER_ID || null,
    // Stale-quota refresh is on by default; --no-quota-refresh disables it.
    quotaRefresh: true,
    authToken: process.env.AUTH_TOKEN || null,
    kind: process.env.AGENTQ_KIND || 'github_issue',
  };
  while (args[0]?.startsWith('--')) {
    const flag = args.shift();
    if (flag === '--db') global.db = needValue(args, flag);
    else if (flag === '--source') global.source = needValue(args, flag);
    else if (flag === '--orchestrator-url') global.orchestratorUrl = needValue(args, flag);
    else if (flag === '--worker-id') global.workerId = needValue(args, flag);
    else if (flag === '--no-quota-refresh') global.quotaRefresh = false;
    else if (flag === '--auth-token') global.authToken = needValue(args, flag);
    else if (flag === '--kind') global.kind = needValue(args, flag);
    else if (flag === '--help' || flag === '-h') return { command: 'help', global, options: {} };
    else throw new Error(`Unknown global option: ${flag}`);
  }

  const command = args.shift() || 'help';
  const options = {};
  // `agentq home [init]`, `agentq paths gaps` and `agentq review <action>` take a
  // bare subcommand, not a flag.
  if ((command === 'home' || command === 'paths' || command === 'review') && args[0] && !args[0].startsWith('--') && args[0] !== '-h') {
    options.action = args.shift();
  }
  while (args.length) {
    const flag = args.shift();
    // `--help`/`-h` after the command (or after a bare subcommand) is a help
    // request, not an option: print usage and exit 0, even when required
    // options are missing.
    if (flag === '--help' || flag === '-h') return { command: 'help', global, options: {} };
    if (flag === '--json') options.json = true;
    else if (flag === '--repo') options.repo = needValue(args, flag);
    else if (flag === '--issue') options.issue = needValue(args, flag);
    else if (flag === '--spec') options.spec = needValue(args, flag);
    else if (flag === '--id') options.id = needValue(args, flag);
    else if (flag === '--model') options.model = needValue(args, flag);
    else if (flag === '--task') options.task = needValue(args, flag);
    else if (flag === '--verdict') options.verdict = needValue(args, flag);
    else if (flag === '--note') options.note = needValue(args, flag);
    else if (flag === '--reviewer') options.reviewer = needValue(args, flag);
    else if (flag === '--base') options.base = needValue(args, flag);
    else if (flag === '--depends-on') options.dependsOn = needValue(args, flag);
    else if (flag === '--untrusted') options.untrusted = true;
    else if (flag === '--trusted') options.trusted = true;
    else if (flag === '--commit') options.commit = true;
    else if (flag === '--no-commit') options.noCommit = true;
    else if (flag === '--commit-author') options.commitAuthor = needValue(args, flag);
    else if (flag === '--allow-untrusted') options.allowUntrusted = true;
    else if (flag === '--force') options.force = true;
    else if (flag === '--executor') options.executor = needValue(args, flag);
    else if (flag === '--sandbox') options.sandbox = needValue(args, flag);
    else if (flag === '--cua') options.cua = true;
    else if (flag === '--quota') options.quota = needValue(args, flag);
    else if (flag === '--tier') options.tier = needValue(args, flag);
    else if (flag === '--private') options.private = true;
    else if (flag === '--threshold') options.threshold = Number(needValue(args, flag));
    else if (flag === '--verify') options.verify = needValue(args, flag);
    else if (flag === '--retry') options.retries = Number(needValue(args, flag));
    else if (flag === '--retry-base-ms') options.retryBaseMs = Number(needValue(args, flag));
    else if (flag === '--stop-when') options.stopWhen = needValue(args, flag);
    else if (flag === '--callback-url') options.callbackUrl = needValue(args, flag);
    else if (flag === '--timeout') options.timeout = Number(needValue(args, flag)) * 1000; // seconds → ms
    else if (flag === '--parallel') options.parallel = Number(needValue(args, flag));
    else if (flag === '--max-age-min' || flag === '--max-age') options.maxAge = Number(needValue(args, flag));
    else if (flag === '--workflow') options.workflow = true;
    else if (flag === '--workflow-name') options.workflowName = needValue(args, flag);
    else if (flag === '--name') options.name = needValue(args, flag);
    else if (flag === '--file') options.file = needValue(args, flag);
    else if (flag === '--log') options.log = needValue(args, flag);
    else throw new Error(`Unknown option for ${command}: ${flag}`);
  }
  if (options.cua && options.sandbox) throw new Error('--cua and --sandbox are mutually exclusive.');
  if (options.cua && options.executor) throw new Error('--cua selects its own feedback executor; --executor cannot be combined.');
  if (options.cua && (options.workflow || options.workflowName)) throw new Error('--cua cannot be combined with workflow execution.');
  if (options.cua && options.parallel > 1) throw new Error('--cua is limited to one concurrent VM per worker.');
  return { command, global, options };
}

function needValue(args, flag) {
  const value = args.shift();
  if (!value || value.startsWith('--')) throw new Error(`Missing value for ${flag}`);
  return value;
}

function createSource(global) {
  if (global.source === 'orchestrator') {
    const workerId = global.workerId || `agentq-${os.hostname()}-${process.pid}`;
    return new OrchestratorSource(global.orchestratorUrl, workerId, {
      authToken: global.authToken,
      kind: global.kind,
    });
  }
  if (global.source !== 'local') throw new Error(`Unknown source: ${global.source}`);
  // --worker-id is the local claim identity when given: the MCP dispatcher
  // marks its workers so the queue can count dispatch claims.
  return new SqliteSource(global.db, { kind: global.kind, workerId: global.workerId || undefined });
}

/** Run `fn` against a source, opening (and closing) one for a bare db path. */
async function withSource(input, fn) {
  if (typeof input !== 'string') return fn(input);
  const source = new SqliteSource(input);
  try {
    return await fn(source);
  } finally {
    await source.stop();
  }
}

async function runNextOnce(source, options) {
  await refreshQuotaForClaim(source, options);
  let job;
  try {
    job = await source.claimNext(options);
  } catch (error) {
    // Another process holds the SQLite write lock (it is mid-claim). That is
    // not an empty queue: report it distinctly so drain() stops instead of
    // claiming there is nothing left to do.
    if (isSqliteBusy(error)) return { status: 'busy' };
    throw error;
  }
  if (!job) {
    // Nothing was claimable. If admission refused candidates, that is the
    // reason the queue looked empty, and the caller must report it.
    const refused = source.refused || [];
    if (refused.length) return { status: 'refused', refused };
    return { status: 'idle' };
  }
  return executeJob(job, options, source);
}

async function claimForParallel(source, options) {
  // Same stale-quota rule as the sequential claim path: only a routing
  // decision needs fresh capacity.
  await refreshQuotaForClaim(source, options);
  const job = await source.claimNext(options);
  if (!job) return { status: 'idle' };
  // The SQLite claim already resolved and persisted the routed model; the
  // orchestrator source may still hand back 'auto', so resolve it here too.
  const model = resolveAutoModel(job.model, options);
  await source.sink.claim(job, { model });
  return { job, model };
}

async function runNextParallel(source, options) {
  const claimed = await claimForParallel(source, options);
  if (claimed.status) return claimed;
  return executeJob(claimed.job, options, source, { preclaimedModel: claimed.model });
}

async function runNext(input, options) {
  return withSource(input, (source) => runNextOnce(source, options));
}

/**
 * Run one specific task by id (full id or unique prefix).
 *
 * Same executor, admission and exit-code semantics as run-next; the only
 * difference is which task is claimed. A task that is not pending is an error
 * (the caller named it), while an admission refusal is reported as `refused`
 * so the CLI exits 2 with the reason and the task stays pending.
 */
async function runByIdOnce(source, options) {
  if (!options.id) throw new Error('run requires --id');
  await refreshQuotaForClaim(source, options, { taskId: options.id });
  let job;
  try {
    job = await source.claimById(options);
  } catch (error) {
    if (isSqliteBusy(error)) return { status: 'busy' };
    throw error;
  }
  if (!job) {
    const refused = source.refused || [];
    if (refused.length) return { status: 'refused', refused };
    return { status: 'idle' };
  }
  return executeJob(job, options, source);
}

async function runById(input, options) {
  return withSource(input, (source) => runByIdOnce(source, options));
}

async function drain(input, options) {
  return withSource(input, (source) => drainSource(source, options));
}

async function drainSource(source, options) {
  const summary = { status: 'drained', ran: 0, succeeded: 0, failed: 0, unverified: 0 };
  const refused = [];
  while (true) {
    const result = await runNext(source, options);
    if (result.status === 'refused') {
      refused.push(...result.refused);
      break;
    }
    if (result.status === 'busy') {
      // Another process holds the SQLite write lock — stop rather than spin
      // waiting for it, but report 'busy', not 'drained': pending jobs may
      // remain untouched, this was not a genuinely empty queue.
      summary.status = 'busy';
      break;
    }
    if (result.status === 'idle') break;
    summary.ran += 1;
    if (result.status === 'succeeded') summary.succeeded += 1;
    else if (result.status === 'unverified') summary.unverified += 1;
    else if (result.status === 'failed') summary.failed += 1;
    if (options.stopWhen && result.stop) { summary.stop = true; break; }
  }
  if (refused.length) {
    summary.refused = refused;
    // Nothing ran and something was refused: the queue is not empty, it is
    // unrunnable for this worker.
    if (summary.ran === 0) summary.status = 'refused';
  }
  if (typeof source.status === 'function') {
    const blocked = source.status().filter(j => j.status === 'blocked').length;
    if (blocked > 0) summary.blocked = blocked;
  }
  return summary;
}

/**
 * Parallel drain — runs up to N independent jobs concurrently.
 * Jobs with unsatisfied dependencies are skipped until their deps complete.
 * Rate-limit leases prevent model contention.
 */
async function drainParallel(input, options, parallelism) {
  return withSource(input, (source) => drainParallelSource(source, options, parallelism));
}

async function drainParallelSource(source, options, parallelism) {
  const summary = { status: 'drained', ran: 0, succeeded: 0, failed: 0, unverified: 0, parallel: parallelism };
  const refused = [];
  const running = new Map(); // slot → Promise
  let nextSlot = 0;
  let stopRequested = false;
  let firstError = null;

  function startClaimed(claimed) {
    const slot = nextSlot++;
    const promise = Promise.resolve().then(() => executeJob(claimed.job, options, source, {
      preclaimedModel: claimed.model,
    })).then(result => {
      running.delete(slot);
      summary.ran += 1;
      if (result.status === 'succeeded') summary.succeeded += 1;
      else if (result.status === 'unverified') summary.unverified += 1;
      else if (result.status === 'failed') summary.failed += 1;
      if (options.stopWhen && result.stop) {
        stopRequested = true;
        summary.stop = true;
      }
      return result;
    }).catch(err => {
      // An infrastructure failure (output disk, worktree setup, remote report,
      // etc.) must stop new claims, but peers already claimed by this drain
      // still need to finish and report their state before the error escapes.
      running.delete(slot);
      if (!firstError) firstError = err;
      stopRequested = true;
      return { status: 'error' };
    });
    running.set(slot, promise);
  }

  async function fillSlots() {
    if (stopRequested) return;
    const batch = [];
    while (running.size + batch.length < parallelism && !stopRequested) {
      let claimed;
      try {
        claimed = await claimForParallel(source, options);
      } catch (err) {
        if (isSqliteBusy(err)) {
          summary.status = 'busy';
        } else if (!firstError) {
          firstError = err;
        }
        stopRequested = true;
        break;
      }
      if (claimed.status === 'busy') {
        summary.status = 'busy';
        stopRequested = true;
        break;
      }
      if (claimed.status === 'idle') {
        // Nothing claimable: keep the admission refusals so the caller can
        // explain why instead of reporting an empty queue.
        if (source.refused?.length) refused.push(...source.refused);
        break;
      }
      batch.push(claimed);
    }

    // Complete the whole claim wave before starting any executor. This is
    // important for remote claims too: a fast setup failure can recover a task
    // before the next HTTP claim returns, causing two slots to select it.
    for (const claimed of batch) startClaimed(claimed);
  }

  while (true) {
    await fillSlots();
    if (running.size === 0) break;
    // A stop/error prevents new claims, but all jobs already claimed by this
    // drain finish and report their terminal state before it returns or throws.
    await Promise.race(running.values());
  }

  if (firstError) throw firstError;
  if (refused.length) {
    summary.refused = refused;
    if (summary.ran === 0) summary.status = 'refused';
  }
  if (typeof source.status === 'function') {
    const blocked = source.status().filter(j => j.status === 'blocked').length;
    if (blocked > 0) summary.blocked = blocked;
  }
  return summary;
}

// --- Menu data layer: pure functions the TUI consumes ---
// No I/O, no readline — these render the "model + quota + impact" table.

function print(result, json) {
  if (json) {
    process.stdout.write(`${JSON.stringify(result)}\n`);
    return;
  }
  if (Array.isArray(result)) {
    if (!result.length) {
      process.stdout.write('no jobs\n');
      return;
    }
    for (const job of result) {
      const subject = job.subject ?? (job.issue_number != null ? `issue ${job.issue_number}` : (job.kind || 'task'));
      process.stdout.write(`#${job.id} ${job.status.padEnd(9)} ${subject} ${job.model ?? '(unset)'} ${job.branch || ''}\n`);
    }
    return;
  }
  if (result.status === 'refused') process.stdout.write(`refused ${result.refused.length} job(s)\n`);
  else if (result.status === 'idle') process.stdout.write('idle: no pending jobs\n');
  else if (result.id) process.stdout.write(`#${result.id} ${result.status}${result.exitCode != null ? ` exit=${result.exitCode}` : ''}\n`);
  else if (result.recovered != null) process.stdout.write(`recovered ${result.recovered} stale job(s) (${result.skipped} still running)\n`);
  else process.stdout.write(`${JSON.stringify(result)}\n`);
}

/** Print admission refusals: the queue is not empty, it is unrunnable here. */
function reportRefusals(refused) {
  for (const entry of refused) {
    process.stderr.write(`job ${String(entry.id).slice(0, 8)}: ${entry.reason}\n`);
  }
}

// --- Commands that never touch the local queue database ---

function commandImportLog(global, options) {
  if (!options.log) throw new Error('import-log requires --log PATH');
  const logPath = path.resolve(options.log);
  if (!fs.existsSync(logPath)) throw new Error(`Log file not found: ${logPath}`);
  const { migrateAgentqLog } = require('../../queue/db.js');
  const db = openQueueDb(global.db);
  try {
    const result = migrateAgentqLog(db, logPath);
    if (!options.json && result.collisions.length) {
      process.stderr.write(`id collision(s) left untouched: ${result.collisions.join(', ')}\n`);
    }
    print(result, options.json);
    return 0;
  } finally {
    db.close();
  }
}

/**
 * Refresh stale quota before a routing decision and report it on stderr.
 *
 * One line only when a collection ran: a fresh snapshot, an opt-out, a rate
 * limit and another process's refresh are the normal quiet cases. The
 * refresher never throws; a failure is reported as a skipped refresh, never as
 * a failed command.
 */
/** Refresh outcomes that mean "no collection was started by this command". */
const SILENT_REFRESH_REASONS = new Set(['fresh', 'disabled', 'rate limited', 'refreshed by another process']);

async function refreshQuotaForAuto(options) {
  const quotaPath = resolvePaths({ quotaPath: options.quota }).quotaPath;
  const outcome = await refreshQuotaIfStale({
    quotaPath,
    enabled: options.noQuotaRefresh !== true,
  });
  // One line only when a collection actually ran (or failed): nothing to do,
  // opted out, rate-limited, or already refreshed elsewhere stay silent.
  if (SILENT_REFRESH_REASONS.has(outcome.reason)) return outcome;
  if (outcome.refreshed) {
    const seconds = (outcome.durationMs ?? 0) / 1000;
    process.stderr.write(`quota refreshed in ${seconds.toFixed(1)}s\n`);
  } else {
    process.stderr.write(`quota refresh skipped: ${outcome.reason}\n`);
  }
  return outcome;
}

/** Refresh only when this claim will actually route an 'auto' model. */
async function refreshQuotaForClaim(source, options, { taskId = null } = {}) {
  if (options.noQuotaRefresh === true) return null;
  const needsRouting = taskId === null
    ? (typeof source.hasPendingAutoModel === 'function' && source.hasPendingAutoModel())
    : (typeof source.taskNeedsRouting === 'function' && source.taskNeedsRouting(taskId, options.model));
  if (!needsRouting) return null;
  return refreshQuotaForAuto(options);
}

async function commandPick(global, options) {
  const tier = options.tier || DEFAULT_TIER;
  // An explicit model is not routed, so there is nothing to rank.
  if (options.model && options.model !== 'auto') {
    print({ model: options.model, provider: null, explicit: true, tier }, options.json);
    return 0;
  }
  const snapshotArgs = { quotaPath: options.quota, threshold: options.threshold };
  await refreshQuotaForAuto({ quota: options.quota, noQuotaRefresh: global.quotaRefresh === false });
  // A runnable on a path that does not declare its model is a setup mistake
  // routing cannot repair. `npm run verify` fails on it; here it is a warning
  // so a pick still returns the best decision it can.
  for (const issue of coverageIssues(snapshotArgs)) process.stderr.write(`coverage: ${issue}\n`);
  const decision = recommend({
    ...snapshotArgs,
    tier,
    excludeDataSharing: options.private === true,
    pathHealth: loadPathHealthFile(global.db),
    // Outcome reviews live in the same queue file --db names. Read-only: a
    // missing queue is no records, never an error.
    trackRecords: loadTrackRecordsFile(global.db, { runnablesPath: resolvePaths({}).runnablesPath }),
  });
  if (options.json) {
    print({ tier, ...decision }, true);
    return decision.default ? 0 : 1;
  }
  // The shortlist, not the whole catalog: the caller weighs a few options and
  // picks. `default` is only what "auto" would take, so it is a footnote.
  if (decision.options.length) {
    process.stdout.write(`${formatOptionsTable(decision.options, { title: `options (tier ${tier})` })}\n`);
    for (const marker of degradedMarkers(decision.options)) {
      process.stdout.write(`degraded: ${marker.path} (${marker.reason})\n`);
    }
  }
  if (decision.default) {
    process.stdout.write(`default → ${decision.default.id} (${decision.default.path})\n`);
    return 0;
  }
  process.stdout.write(`default → no eligible model: ${summarizeRejections(decision.rejected)}\n`);
  return 1;
}

/**
 * `agentq paths gaps`: what the price tables promise and the setup cannot run,
 * and what the setup runs that no price table covers. Read-only.
 */
function commandPaths(options) {
  if (options.action !== 'gaps') {
    throw new Error(`unknown paths command: ${options.action} (expected "gaps")`);
  }
  const report = getPathGaps({});
  if (options.json) {
    print(report, true);
    return 0;
  }
  process.stdout.write(`${formatGapReport(report)}\n`);
  return 0;
}

/**
 * `agentq show --id ID`: one task in full — header, pinned input, the
 * `task_events` audit trail, and the reviews linked to it.
 *
 * Read-only, and it deliberately does not go through a queue source: opening a
 * source would create the file and run schema migrations, which are writes. The
 * id is a full id or a unique prefix, resolved by the store's own resolver, so
 * an unknown or ambiguous prefix reports exactly the error `run --id` reports.
 */
function commandShow(global, options) {
  if (!options.id) throw new Error('show requires --id');
  if (global.source === 'orchestrator') {
    throw new Error(
      "'show' reads the local queue file and is not implemented for --source orchestrator. " +
      "Use the orchestrator's HTTP API (GET /api/tasks/:id) or run it against the shared database without --source orchestrator.",
    );
  }
  const detail = showTask(global.db, options.id);
  if (options.json) {
    print(detail, true);
    return 0;
  }
  process.stdout.write(`${formatTaskDetail(detail)}\n`);
  return 0;
}

/**
 * `agentq review <action>`: record an outcome review, or read the reviews and
 * the track records they fold into.
 *
 * A review is the caller's verdict on what a model produced. It is recorded
 * here (and over MCP by `review_task`) and never changes a task's status: the
 * queue records what happened, the review records what was thought of it.
 */
function commandReview(global, options) {
  if (options.action === 'add') return commandReviewAdd(global, options);
  if (options.action === 'amend') return commandReviewAmend(global, options);
  if (options.action === 'list') return commandReviewList(global, options);
  if (options.action === 'stats') return commandReviewStats(global, options);
  throw new Error(`unknown review command: ${options.action ?? '(none)'} (expected add, amend, list or stats)`);
}

function commandReviewAdd(global, options) {
  if (!options.model) throw new Error('review add requires --model');
  if (!options.tier) throw new Error(`review add requires --tier (${REVIEW_TIERS.join('|')})`);
  if (!options.verdict) throw new Error(`review add requires --verdict (${REVIEW_VERDICTS.join('|')})`);
  if (!REVIEW_TIERS.includes(options.tier)) {
    throw new Error(`unknown tier: ${options.tier} (expected ${REVIEW_TIERS.join('|')})`);
  }
  if (!REVIEW_VERDICTS.includes(options.verdict)) {
    throw new Error(`unknown verdict: ${options.verdict} (expected ${REVIEW_VERDICTS.join('|')})`);
  }
  // A review names a runnable: the record is keyed by the runnable's model key,
  // so an id nothing can run would never be routed and never count.
  const { runnablesPath } = resolvePaths({});
  const runnables = loadRunnables(runnablesPath);
  if (!runnables.some((runnable) => runnable.id === options.model)) {
    throw new Error(`unknown model: ${options.model} (not a runnable; see ${runnablesPath})`);
  }
  const { addReview } = require('../../queue/db.js');
  const db = openQueueDb(global.db);
  try {
    const review = addReview(db, {
      model: options.model,
      tier: options.tier,
      verdict: options.verdict,
      taskId: options.task ?? null,
      note: options.note ?? null,
      reviewer: options.reviewer ?? null,
    });
    if (options.json) {
      print({ status: 'recorded', review }, true);
    } else {
      process.stdout.write(`recorded review ${review.id}: ${review.model} ${review.tier} ${review.verdict}\n`);
    }
    return 0;
  } finally {
    db.close();
  }
}

/**
 * `agentq review amend --id N [--verdict V] [--tier T] [--note TEXT] [--json]`.
 *
 * Correct a recorded review. At least one of --verdict, --tier or --note is
 * required; the enums are validated exactly as `review add` validates them
 * (via the same `amendReview` helper). Model, task and reviewer are frozen.
 */
function commandReviewAmend(global, options) {
  if (options.id == null || options.id === '') throw new Error('review amend requires --id');
  if (options.verdict == null && options.tier == null && options.note == null) {
    throw new Error('review amend requires at least one of --verdict, --tier or --note');
  }
  const changes = {};
  if (options.verdict != null) changes.verdict = options.verdict;
  if (options.tier != null) changes.tier = options.tier;
  if (options.note != null) changes.note = options.note;
  const { amendReview } = require('../../queue/db.js');
  const db = openQueueDb(global.db);
  try {
    const review = amendReview(db, options.id, changes);
    if (options.json) {
      print({ status: 'amended', review }, true);
    } else {
      process.stdout.write(`amended review ${review.id}: ${review.model} ${review.tier} ${review.verdict}\n`);
    }
    return 0;
  } finally {
    db.close();
  }
}

function commandReviewList(global, options) {
  const reviews = loadReviewsFile(global.db, { model: options.model ?? null });
  if (options.json) {
    // `--json` prints the full rows, which already include `id`; assert it so
    // a future refactor can't silently drop the column `amend` points at.
    if (reviews.length && !('id' in reviews[0])) {
      throw new Error('review list: --json output is missing the review id');
    }
    print(reviews, true);
    return 0;
  }
  if (!reviews.length) {
    process.stdout.write('no reviews\n');
    return 0;
  }
  for (const review of reviews) {
    const task = review.task_id ? ` task=${review.task_id}` : '';
    const note = review.note ? `  ${review.note}` : '';
    const reviewer = review.reviewer ? ` by ${review.reviewer}` : '';
    process.stdout.write(
      `${String(review.id).padStart(4)}  ${review.created_at}  ${String(review.model).padEnd(40)} ${review.tier.padEnd(6)} `
      + `${review.verdict.padEnd(18)} ${review.source}${task}${reviewer}${note}\n`,
    );
  }
  return 0;
}

function commandReviewStats(global, options) {
  const { runnablesPath } = resolvePaths({});
  // One policy for both the rows and the table: `needed` answers "how far from
  // unlocking here", so it has to be measured against the thresholds routing uses.
  const policy = getTrackRecordPolicy();
  const stats = trackRecordStats(loadTrackRecordsFile(global.db, { runnablesPath }), policy);
  if (options.json) {
    print(stats, true);
    return 0;
  }
  process.stdout.write(`${formatTrackRecordTable(stats, policy)}\n`);
  return 0;
}

function commandSaveWorkflow(options) {
  if (!options.name) throw new Error('save-workflow requires --name');
  if (!options.file) throw new Error('save-workflow requires --file');
  // The name becomes a filename under ~/.pi/workflows/saved/ — reject
  // separators and traversal (`--name ../../x` would write outside it).
  if (!/^[A-Za-z0-9._-]+$/.test(options.name)) {
    throw new Error(`Invalid workflow name: ${options.name}`);
  }
  const src = path.resolve(options.file);
  if (!fs.existsSync(src)) throw new Error(`File not found: ${src}`);
  fs.mkdirSync(SAVED_WORKFLOWS_DIR, { recursive: true });
  const dest = path.join(SAVED_WORKFLOWS_DIR, `${options.name}.js`);
  fs.copyFileSync(src, dest);
  print({ status: 'saved', name: options.name, path: dest }, options.json);
  return 0;
}

function commandListWorkflows(options) {
  const saved = [];
  if (fs.existsSync(SAVED_WORKFLOWS_DIR)) {
    for (const f of fs.readdirSync(SAVED_WORKFLOWS_DIR)) {
      if (f.endsWith('.js')) {
        const name = f.slice(0, -3);
        const stat = fs.statSync(path.join(SAVED_WORKFLOWS_DIR, f));
        saved.push({ name, path: path.join(SAVED_WORKFLOWS_DIR, f), size: stat.size, modified: stat.mtime });
      }
    }
  }
  print(saved, options.json);
  return 0;
}

/**
 * `agentq home` prints the resolved home and the config files that exist;
 * `agentq home init [--force]` creates the layout and seeds the example setup
 * (only where a file is missing, unless --force).
 */
function commandHome(options) {
  if (options.action === undefined) {
    const home = agentqHome();
    process.stdout.write(`home: ${home}\n`);
    for (const file of homeConfigStatus({ home })) {
      process.stdout.write(`  ${file.exists ? 'ok     ' : 'missing'} config/${file.name}\n`);
    }
    return 0;
  }
  if (options.action !== 'init') throw new Error(`unknown home command: ${options.action} (expected "init")`);
  const result = initHome({ force: options.force === true });
  process.stdout.write(`home: ${result.home}\n`);
  for (const name of result.created) process.stdout.write(`  wrote  config/${name}\n`);
  for (const name of result.kept) process.stdout.write(`  kept   config/${name} (use --force to overwrite)\n`);
  return 0;
}

async function commandJulesReconnect(options) {
  const { openDb, initSchema } = require('../../queue/db.js');
  const { reconnectJulesSession } = require('../../queue/jules-sync.js');
  // Jules sessions live in the orchestrator database. Same ORCHESTRATOR_DB
  // convention as jules-issue.js (the default is the same file --db names).
  const dbPath = process.env.ORCHESTRATOR_DB || defaultDbPath();
  const db = openDb(dbPath);
  initSchema(db);
  try {
    const onEvent = (name, data) => console.error(`  ${name}: ${JSON.stringify(data)}`);
    const results = await reconnectJulesSession(db, {
      onEvent,
      pollIntervalMs: Number(process.env.JULES_POLL_INTERVAL_MS) || 10000,
      timeoutMs: Number(process.env.JULES_TIMEOUT_MS) || 30 * 60 * 1000,
    });
    print(results.length ? results : { status: 'no-inflight-sessions' }, options.json);
    return results.length ? 0 : 1;
  } finally {
    db.close();
  }
}

function commandJulesSessions(options) {
  const { openDb, initSchema, listJulesSessions } = require('../../queue/db.js');
  const dbPath = process.env.ORCHESTRATOR_DB || defaultDbPath();
  const db = openDb(dbPath);
  initSchema(db);
  try {
    const sessions = listJulesSessions(db, { limit: options.limit || 20 });
    print(sessions, options.json);
    return 0;
  } finally {
    db.close();
  }
}

async function main(argv = process.argv.slice(2)) {
  const { command, global, options } = parseArgs(argv);
  if (command === 'help') {
    // No args → launch the interactive menu instead of printing usage.
    if (argv.length === 0) {
      require('./menu.js').main().catch(e => {
        process.stderr.write(`${e.message}\n`);
        process.exitCode = 1;
      });
      return 0;
    }
    process.stdout.write(usage());
    return 0;
  }

  if (options.parallel != null && (!Number.isInteger(options.parallel) || options.parallel < 1 || options.parallel > 128)) {
    throw new Error('--parallel must be an integer between 1 and 128');
  }
  if (options.tier !== undefined) options.tier = normalizeTier(options.tier);
  if (options.threshold !== undefined && !Number.isFinite(options.threshold)) {
    throw new Error('--threshold must be a number');
  }
  if (!['github_issue', 'spec', 'feedback'].includes(global.kind)) {
    throw new Error(`unsupported task kind: ${global.kind}`);
  }
  const runCommands = ['run-next', 'drain', 'run'];
  if (global.kind === 'feedback' && !runCommands.includes(command)) {
    throw new Error('--kind feedback is only supported with run-next, drain or run');
  }
  if (global.kind === 'feedback' && runCommands.includes(command)) {
    if (!options.executor && !options.cua) throw new Error('feedback workers require --executor or --cua');
    if (global.source === 'orchestrator' && !options.model) {
      throw new Error('orchestrator feedback workers require --model matching the queued task (use auto for auto-routed tasks)');
    }
    if (!options.sandbox && !options.cua && !options.allowUntrusted) {
      throw new Error('feedback workers require --sandbox, --cua, or the explicit --allow-untrusted override');
    }
  }
  if (command === 'enqueue') {
    const hasSpec = options.spec !== undefined && options.spec !== '';
    const hasIssue = options.issue !== undefined && options.issue !== '';
    if (hasSpec === hasIssue) {
      throw new Error(hasSpec
        ? 'enqueue accepts exactly one of --issue or --spec, not both'
        : 'enqueue requires --issue N or --spec FILE');
    }
  }
  if (command === 'run') {
    if (!options.id) throw new Error('run requires --id');
    // A specific task is claimed in the local SQLite queue. The orchestrator
    // source has no claim-by-id endpoint, so fail loudly instead of silently
    // claiming "the next" task, which would run the wrong work.
    if (global.source === 'orchestrator') {
      throw new Error(
        "'run --id' claims a task by id in the local SQLite queue and is not implemented for --source orchestrator. " +
        'Use run-next against the orchestrator, or run it against the shared database without --source orchestrator.',
      );
    }
  }
  options.noQuotaRefresh = global.quotaRefresh === false;
  if (global.source === 'local') options.kind = global.kind;

  // Commands that do not open a queue source: they must not create or require
  // its database (pick/list-workflows/save-workflow are pure, jules-* open the
  // orchestrator database themselves, import-log opens the target itself, and
  // `show` reads an existing queue through a read-only handle instead).
  if (command === 'home') return commandHome(options);
  if (command === 'paths') return commandPaths(options);
  if (command === 'show') return commandShow(global, options);
  if (command === 'review') return commandReview(global, options);
  if (command === 'import-log') return commandImportLog(global, options);
  if (command === 'pick') return commandPick(global, options);
  if (command === 'save-workflow') return commandSaveWorkflow(options);
  if (command === 'list-workflows') return commandListWorkflows(options);
  if (command === 'jules-reconnect') return commandJulesReconnect(options);
  if (command === 'jules-sessions') return commandJulesSessions(options);

  if (global.source === 'local' && global.workerId) {
    // The local claim identity feeds the dispatch concurrency cap, so only the
    // two documented shapes are accepted. A usage error, not a runtime one.
    const problem = localWorkerIdError(global.workerId);
    if (problem) {
      process.stderr.write(`${problem}\n`);
      return 2;
    }
  }

  let source;
  try {
    source = createSource(global);
  } catch (error) {
    // Opening the queue itself can hit another process's write lock (WAL mode
    // and schema init are writes). For `run --id` that is the same retryable
    // busy condition as a claim, so report it the same way (exit 3) instead of
    // a generic failure.
    if (command === 'run' && isSqliteBusy(error)) {
      process.stderr.write('queue busy: another process holds the SQLite write lock; nothing was claimed\n');
      print({ status: 'busy' }, options.json);
      return 3;
    }
    throw error;
  }
  await source.start();
  // Outcome reviews live in the queue this command opened, so --db is
  // authoritative for every routing decision made below, including the
  // runner's own 'auto' resolution. A source without a local database (the
  // orchestrator) routes without records, exactly as it does without health.
  if (source && source.db) options.trackRecords = loadTrackRecords(source.db);
  try {
    if (command === 'enqueue') {
      print(await source.enqueue(options), options.json);
      return 0;
    }
    // status/requeue/recover/prune/cancel/import-usage are administrative
    // operations on the local queue file. Fail loudly rather than silently
    // reading/writing a local database when --source orchestrator was
    // requested, which would look like it worked but touch the wrong queue.
    if (['status', 'requeue', 'recover', 'prune', 'cancel', 'import-usage'].includes(command) && global.source === 'orchestrator') {
      throw new Error(
        `'${command}' is not implemented for --source orchestrator. ` +
        `Use the orchestrator's HTTP API (GET /api/tasks, POST /api/tasks/:id/approve, etc.) ` +
        `or run it against the shared database without --source orchestrator.`
      );
    }
    if (command === 'status') {
      print(source.status(), options.json);
      return 0;
    }
    if (command === 'run-next') {
      const result = await runNext(source, options);
      if (result.status === 'refused') {
        reportRefusals(result.refused);
        if (options.json) print({ status: 'refused', refused: result.refused }, true);
        else print(result, false);
        return 2;
      }
      print(result, options.json);
      return (result.status === 'failed' || result.status === 'unverified') ? result.exitCode || 1 : 0;
    }
    if (command === 'run') {
      const result = await runById(source, options);
      if (result.status === 'refused') {
        reportRefusals(result.refused);
        if (options.json) print({ status: 'refused', refused: result.refused }, true);
        else print(result, false);
        return 2;
      }
      if (result.status === 'busy') {
        // Another process held the write lock, so nothing was claimed. This is
        // distinct from both "refused" (2) and a failed run (the executor's
        // code), and it is retryable: a dispatcher can simply try again.
        process.stderr.write('queue busy: another process holds the SQLite write lock; nothing was claimed\n');
        print(result, options.json);
        return 3;
      }
      print(result, options.json);
      return (result.status === 'failed' || result.status === 'unverified') ? result.exitCode || 1 : 0;
    }
    if (command === 'drain') {
      const result = options.parallel > 1
        ? await drainParallel(source, options, options.parallel)
        : await drain(source, options);
      if (result.refused?.length) reportRefusals(result.refused);
      print(result, options.json);
      if (result.failed > 0 || result.unverified > 0) return 1;
      // Nothing ran because everything claimable was refused by admission.
      return (result.ran === 0 && result.refused?.length) ? 2 : 0;
    }
    if (command === 'requeue') {
      print(source.requeue(options), options.json);
      return 0;
    }
    if (command === 'recover') {
      print(source.recover(options), options.json);
      return 0;
    }
    if (command === 'prune') {
      print(source.prune(options), options.json);
      return 0;
    }
    if (command === 'cancel') {
      const result = source.cancel(options);
      print(result, options.json);
      // A cancel succeeds when the task ends up failed (killed, or never
      // started). A running task with no reachable executor is reported
      // unchanged so a live run is never marked failed behind its back.
      return result.status === 'failed' ? 0 : 1;
    }
    if (command === 'import-usage') {
      // Legacy local runs wrote usage.jsonl next to the queue file; import it
      // once into the same database the queue now lives in.
      const usagePath = path.join(path.dirname(global.db), 'usage.jsonl');
      if (!fs.existsSync(usagePath)) { print({ imported: 0 }, options.json); return 0; }
      const { recordUsage } = require('../../queue/db.js');
      const db = source.db;
      const lines = fs.readFileSync(usagePath, 'utf8').split('\n').filter(Boolean);
      let imported = 0;
      let skipped = 0;
      for (const line of lines) {
        try {
          const rec = JSON.parse(line);
          // Idempotent: a job that already has usage recorded is skipped.
          const existing = db.prepare('SELECT id FROM usage_records WHERE task_id = ?').get(String(rec.jobId));
          if (existing) { skipped++; continue; }
          recordUsage(db, {
            taskId: String(rec.jobId),
            provider: null,
            model: rec.model,
            inputTokens: rec.inputTokens,
            outputTokens: rec.outputTokens,
            cacheTokens: rec.cacheTokens,
            cost: rec.cost,
          });
          imported++;
        } catch { /* skip corrupt lines */ }
      }
      print({ imported, skipped, total: lines.length }, options.json);
      return 0;
    }
    throw new Error(`Unknown command: ${command}`);
  } finally {
    await source.stop();
  }
}

module.exports = {
  main,
  runNext,
  runById,
  drain,
  drainParallel,
  createSource,
  jobWorktreePath,
  resolveAutoModel,
  runVerify,
  summarizeCosts,
  buildModelRows,
  formatModelRow,
  formatModelTable,
  formatTrackRecordTable,
  truncateRepo,
  formatJobBlock,
  formatCost,
  resolveExecutor,
  parseArgs,
  parseDependencyIds,
  prepareJobWorktree,
};

// Runnable directly (the file keeps its shebang) and through bin/agentq.js,
// which is the stable entry point for npm scripts, the package "bin" map and
// the MCP dispatcher's spawned worker.
if (require.main === module) {
  main().then(exitCode => {
    process.exitCode = exitCode ?? 0;
  }).catch(err => {
    process.stderr.write(`${err.message}\n`);
    process.exitCode = 1;
  });
}

#!/usr/bin/env node
'use strict';

/**
 * agentq execution core — source-agnostic job runner.
 *
 * The queue-specific bits live behind a JobSink:
 *   sink.claim(job, { model })
 *   sink.finish(job, result)
 *   sink.recover(job)
 *   sink.requeue(job, { auto, retryCount })
 *   sink.jobLogPath(id)
 *   sink.worktreePath(id)
 *
 * SqliteSource maps those transitions onto the task store in-process;
 * OrchestratorSource maps them onto worker.complete()/fail().
 */

const fs = require('node:fs');
const { randomUUID } = require('node:crypto');
const os = require('node:os');
const path = require('node:path');
const { spawnSync, spawn, execFileSync } = require('node:child_process');
const { captureGitSnapshot } = require('./verification-evidence.js');
const { RESULT_FILE_ENV, createResultPath, readResultFile } = require('./result-file.js');
const { parseCommitAuthor } = require('../queue/db-tasks.js');
const { validateTaskJob } = require('../core/task-input.js');
const { admit } = require('../core/admission.js');
const { loadRunnables, harnessForModel } = require('../core/catalog.js');
const {
  EXECUTOR_TIMEOUT_MS,
  writePidFile,
  removePidFile,
  killProcessTree,
} = require('../queue/job-state.js');
const { canonicalizePath } = require('../lib/paths.js');
const { providerFor, resolveAutoModel: resolveAutoModelFor } = require('../core/auto-model.js');
const { classifyOutcome } = require('../core/path-health.js');
const { loadConfig } = require('../lib/model-picker.js');

const ROOT = path.join(__dirname, '..', '..');
const DEFAULT_EXECUTOR = path.join(ROOT, 'pi-task.sh');
const CLAUDE_EXECUTOR = path.join(ROOT, 'claude-task.sh');
const WORKFLOW_EXECUTOR = path.join(ROOT, 'pi-workflow.sh');
const CUA_FEEDBACK_EXECUTOR = path.join(ROOT, 'src', 'runners', 'cua-feedback.js');
// Harnesses agentq can launch. A runnable that names anything else is a
// catalog entry without an executor: refuse it before claiming rather than
// silently running the model on a harness it was not scored for.
const EXECUTABLE_HARNESSES = Object.freeze(['pi', 'claude']);
function nowIso() {
  return new Date().toISOString();
}

// Resolve the model a job will run on. Explicit models pass through; 'auto'
// is decided by the routing core (runnables + ROI scores + quota freshness)
// and throws when nothing is eligible, rather than falling back silently.
function resolveAutoModel(storedModel, options = {}) {
  if (storedModel !== 'auto') return storedModel;
  return resolveAutoModelFor(storedModel, {
    tier: options.tier,
    quotaPath: options.quota,
    threshold: options.threshold,
    // Every documented routing input travels with the runner too: dropping
    // one here silently routed a run against the wrong snapshot.
    roiOutputPath: options.roiOutputPath,
    runnablesPath: options.runnablesPath,
    roiConfigPath: options.roiConfigPath,
    config: options.config,
    pathHealth: options.pathHealth,
    trackRecords: options.trackRecords,
  }).model;
}

/**
 * The quota path the attempt actually ran on: the routed provider persisted
 * on the job, else the explicit model's attributed path. Null when no path
 * is known — the caller then skips the row.
 *
 * @param {{ provider?: string|null }} [job]
 * @param {string|null} [model]
 * @returns {string|null}
 */
function attemptPathFor(job = {}, model = null) {
  if (job && typeof job.provider === 'string' && job.provider) return job.provider;
  if (typeof model !== 'string' || !model) return null;
  try {
    return providerFor(model, loadConfig()) || null;
  } catch {
    return null;
  }
}

/**
 * Write one path-outcome row per attempt through the sink, so the DB sink
 * records it and non-DB (file/remote) sinks no-op. Recording never fails
 * the job: a throw is logged to stderr and the run continues.
 */
async function recordAttemptOutcome(sink, job, { path, model, outcome }) {
  if (!path || typeof sink.recordPathOutcome !== 'function') return;
  try {
    await sink.recordPathOutcome(job, { path, model, outcome });
  } catch (error) {
    console.error(`job #${job?.id}: path outcome not recorded (${error instanceof Error ? error.message : String(error)})`);
  }
}

// A missing runnables file must not break explicit pi models, so it degrades to
// "no catalog" (default pi harness). A malformed one is a real mistake and is
// surfaced, because silently launching a different harness is worse.
function loadRunnablesForExecutor(options = {}) {
  if (Array.isArray(options.runnables)) return options.runnables;
  try {
    return loadRunnables(options.runnablesPath);
  } catch (err) {
    if (err && err.code === 'ENOENT') return [];
    throw err;
  }
}

// Which harness runs this model. Explicit models that are not runnables (jules,
// a custom --executor target) keep the default pi harness.
function resolveHarness(model, options = {}) {
  const harness = harnessForModel(loadRunnablesForExecutor(options), model);
  if (harness === null) return 'pi';
  if (!EXECUTABLE_HARNESSES.includes(harness)) {
    throw new Error(
      `Model ${model} declares harness '${harness}', which agentq cannot execute ` +
        `(known harnesses: ${EXECUTABLE_HARNESSES.join(', ')}).`,
    );
  }
  return harness;
}

function resolveExecutor(job, options = {}) {
  // The resolved model (auto already expanded) decides the harness. Feedback
  // and CUA stay pi-only: their executors are pi sessions, not Claude Code.
  const model = options.model ?? job?.model ?? null;
  const harness = resolveHarness(model, options);
  if (options?.cua) {
    if (job?.kind !== 'feedback') throw new Error('--cua can run feedback jobs only.');
    if (harness === 'claude') {
      throw new Error(`--cua runs feedback jobs on pi only; model ${model} uses the claude harness.`);
    }
    return CUA_FEEDBACK_EXECUTOR;
  }
  if (job?.kind === 'feedback' && harness === 'claude') {
    throw new Error(
      `Feedback jobs run on pi only; model ${model} uses the claude harness. ` +
        'Enqueue the task with a pi-harness model.',
    );
  }
  // Workflow mode: use pi-workflow.sh instead of pi-task.sh
  if (options?.workflow || job?.workflow) {
    if (harness === 'claude') {
      throw new Error(`--workflow is pi-only; model ${model} uses the claude harness.`);
    }
    if (options?.executor) return path.resolve(options.executor);
    return path.resolve(WORKFLOW_EXECUTOR);
  }
  // Explicit executor choices (CLI flag, then the job's persisted executor)
  // keep winning; the harness only supplies the default.
  if (options?.executor) return path.resolve(options.executor);
  if (job?.executor) return path.resolve(job.executor);
  if (harness === 'claude') return path.resolve(CLAUDE_EXECUTOR);
  return path.resolve(DEFAULT_EXECUTOR);
}

/** Run a command async with a timeout, returning { stdout, stderr, exitCode, timedOut }. */
const MAX_CAPTURE_BYTES = 1024 * 1024;

function appendTail(current, chunk) {
  const text = String(chunk);
  const next = current + text;
  return next.length > MAX_CAPTURE_BYTES ? next.slice(-MAX_CAPTURE_BYTES) : next;
}

function runAsync(command, args, {
  cwd, env, timeoutMs, statePath, jobId, outputPath, input,
  appendOutput = false, outputPrefix = '',
} = {}) {
  return new Promise((resolve, reject) => {
    let outputFd = null;
    let child;
    try {
      if (outputPath) {
        fs.mkdirSync(path.dirname(outputPath), { recursive: true });
        outputFd = fs.openSync(outputPath, appendOutput ? 'a' : 'w');
        if (outputPrefix) fs.writeSync(outputFd, outputPrefix);
      }
      child = spawn(command, args, {
        cwd,
        env,
        stdio: [input === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'],
        detached: true,
      });
    } catch (err) {
      try {
        if (outputFd != null) fs.closeSync(outputFd);
      } catch {}
      reject(err);
      return;
    }

    let stdout = '';
    let stderr = '';
    let timedOut = false;
    let lastOutputStream = null;
    let timer;
    let killTimer;
    let settled = false;
    let fatalError = null;

    const closeOutput = () => {
      if (outputFd == null) return null;
      try {
        fs.closeSync(outputFd);
        return null;
      } catch (err) {
        return err;
      } finally {
        outputFd = null;
      }
    };
    const finish = (result, error = null) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      if (killTimer) clearTimeout(killTimer);
      if (statePath && jobId != null) removePidFile(statePath, jobId);
      const closeError = closeOutput();
      if (error || closeError) reject(error || closeError);
      else resolve(result);
    };
    const abort = err => {
      if (fatalError) return;
      fatalError = err;
      // Do not report recovery/requeue until the old executor has actually
      // exited. Otherwise an output or PID-file failure can run two copies of
      // the same job concurrently. `close` settles after TERM/KILL cleanup.
      killTimer = killProcessTree(child.pid);
    };
    const writeOutput = (chunk, isStderr = false) => {
      if (outputFd == null) return;
      const stream = isStderr ? 'stderr' : 'stdout';
      if (stream !== lastOutputStream && (isStderr || lastOutputStream === 'stderr')) {
        fs.writeSync(outputFd, `\n--- ${stream} ---\n`);
      }
      lastOutputStream = stream;
      fs.writeSync(outputFd, chunk);
    };

    child.stdout.on('data', d => {
      if (fatalError) return;
      stdout = appendTail(stdout, d);
      try { writeOutput(d); } catch (err) { abort(err); }
    });
    child.stderr.on('data', d => {
      if (fatalError) return;
      stderr = appendTail(stderr, d);
      try { writeOutput(d, true); } catch (err) { abort(err); }
    });
    child.once('close', code => {
      finish({ stdout, stderr, exitCode: code ?? 1, timedOut }, fatalError);
    });
    child.once('error', err => finish(null, fatalError || err));
    if (input !== undefined) {
      child.stdin.on('error', err => {
        if (!['EPIPE', 'ERR_STREAM_DESTROYED', 'ECONNRESET'].includes(err.code)) abort(err);
      });
    }

    try {
      if (statePath && jobId != null && child.pid) writePidFile(statePath, jobId, child.pid);
    } catch (err) {
      abort(err);
    }

    if (input !== undefined && !fatalError) child.stdin.end(input);

    if (timeoutMs && !fatalError) {
      timer = setTimeout(() => {
        timedOut = true;
        killTimer = killProcessTree(child.pid);
      }, timeoutMs);
    }
  });
}

// The executor's stdout is dominated by the pi session echoing the (untrusted)
// issue body, so it is never parsed for metadata (that is what the
// AGENTQ_RESULT file is for). A worktree reported in that file is still
// untrusted input from the executor's perspective: it is trusted only if it
// stays inside the job's own footprint:
//   - the prepared execution dir (runCwd), or
//   - the job's work area (log root: worktrees/, logs, db — operator-managed
//     scratch space; sibling job worktrees live here too, and branch deletion
//     is separately gated by jobBranchIsJobOwned() at prune time), or
//   - a `pi-*` dir under TMPDIR (pi-task.sh standalone creates
//     $(mktemp -d)/pi-<slug>; the pi- prefix is the documented contract).
// Everything else — user dirs, other repos, other queues' data roots — is
// dropped and the label falls back to runCwd. Resolve existing ancestors too,
// so non-existent descendants compare correctly when TMPDIR contains symlinks.
// A dangling or otherwise unresolved symlink is rejected rather than treated
// as a lexical path inside an allowed area.
function trustedWorktreeLabel(label, runCwd, workArea, jobId) {
  if (typeof label !== 'string' || !path.isAbsolute(label)) return null;
  const canonicalLabel = canonicalizePath(label);
  if (!canonicalLabel) return null;
  const p = path.resolve(canonicalLabel);
  const canonical = target => {
    if (!target) return null;
    const resolved = canonicalizePath(target);
    return resolved ? path.resolve(resolved) : null;
  };
  const eq = target => p === canonical(target);
  const under = base => {
    const b = canonical(base);
    return !!b && p.startsWith(b + path.sep);
  };
  if (p === canonicalizePath(runCwd)) return label;
  if (under(workArea)) {
    // Sibling managed worktrees (worktrees/job-<id>, any depth) are the
    // structured, GUESSABLE targets inside the shared work area that prune
    // can act on (registered worktrees of the repo). Reject them entirely
    // unless id is this job's own; other work-area paths stay allowed
    // (executor-created scratch, not registered worktrees).
    const rel = path.relative(canonical(workArea), p).split(path.sep);
    if (rel[0] === 'worktrees' && /^job-\d+$/.test(rel[1])
      && jobId != null && rel[1] !== `job-${jobId}`) return null;
    return label;
  }
  if (under(canonicalizePath(os.tmpdir())) && path.basename(p).startsWith('pi-')) return label;
  return null;
}

// A branch label is persisted and later passed to `git branch -D`; reject
// anything that is not a sane refname (no leading dash — git option injection
// via argv — no '..'/'@{' components, no whitespace/control characters).
function isSafeBranchName(label) {
  return typeof label === 'string'
    && /^[A-Za-z0-9](?:[A-Za-z0-9._/-]*[A-Za-z0-9])?$/.test(label)
    && !label.includes('..')
    && !label.includes('@{');
}

// The job's work area: the operator-managed scratch space for job work
// (queue root — worktrees/, logs, usage, db). OrchestratorSource and
// SqliteSource both derive it from worktreeBase. Computed directly so
// validation has no mkdir side effects (unlike sink.worktreePath()).
function sinkWorkArea(sink) {
  if (sink.worktreeBase) return path.dirname(sink.worktreeBase);
  if (sink.statePath) return path.dirname(sink.statePath);
  return null;
}

/**
 * The commit policy for a job, tolerant of every job shape.
 *
 * Local claims project the row through taskToJob (an object), while the
 * orchestrator returns the raw row (a JSON string, or nothing on old rows).
 * Anything unreadable falls back to today's behaviour: the agent commits.
 *
 * @param {Record<string, any>} job
 * @returns {{ commit: 'agent'|'none', author: { name: string, email: string }|null }}
 */
function commitPolicyOf(job) {
  let policy = job?.execution_policy;
  if (typeof policy === 'string') {
    try {
      policy = JSON.parse(policy);
    } catch {
      policy = null;
    }
  }
  if (!policy || typeof policy !== 'object') return { commit: 'agent', author: null };
  const author = policy.author
    && typeof policy.author.name === 'string' && policy.author.name.trim()
    && typeof policy.author.email === 'string' && policy.author.email.trim()
    ? { name: policy.author.name.trim(), email: policy.author.email.trim() }
    : null;
  return { commit: policy.commit === 'none' ? 'none' : 'agent', author };
}

/**
 * Resolve the git identity the agent commits under, in order:
 *
 * 1. The task's own author.
 * 2. The target repo's `agentq.commitAuthor` git config, in `Name <email>`
 *    form, so an owner sets a noreply identity once per repo with plain git
 *    config.
 * 3. Nothing: the repo's normal identity, as today.
 *
 * A key that is SET but malformed is fatal. The owner set it to keep their
 * normal identity off agent commits, so silently falling back to that identity
 * would defeat it. An unset key (git exits 1) means "no override".
 *
 * @param {{ name: string, email: string }|null} taskAuthor
 * @param {string|null|undefined} repoPath
 * @returns {{ name: string, email: string }|null}
 */
function resolveCommitAuthor(taskAuthor, repoPath) {
  if (taskAuthor) return taskAuthor;
  if (typeof repoPath !== 'string' || !repoPath) return null;
  let raw;
  try {
    raw = execFileSync('git', ['-C', repoPath, 'config', '--get', 'agentq.commitAuthor'], {
      encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 5_000,
    }).trim();
  } catch {
    return null;
  }
  if (!raw) return null;
  try {
    return parseCommitAuthor(raw);
  } catch {
    throw new Error(`Invalid agentq.commitAuthor in ${repoPath}: expected \`Name <email>\`; refusing to run under the repo's default identity.`);
  }
}

function isGitRepo(repo) {
  try {
    execFileSync('git', ['-C', repo, 'rev-parse', '--is-inside-work-tree'], {
      encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 5_000,
    });
    return true;
  } catch {
    return false;
  }
}

/**
 * The one-off command that prepares a fresh job worktree, in order:
 *
 * 1. `agentq run --setup "CMD"`;
 * 2. the target repo's `agentq.setup` git config, so an owner sets `npm ci`
 *    once per repo with plain git config.
 *
 * Nothing is ever read from a file inside the repo: a repo's content must
 * not be able to make agentq run a command, and only the machine owner can
 * set local git config. An unset key (git exits 1) means "no setup".
 *
 * @param {Record<string, any>} [options] CLI-style options (`setup`)
 * @param {string|null|undefined} repoPath
 * @returns {string|null} the setup command, or null when none is configured
 */
function resolveSetupCommand(options = {}, repoPath) {
  if (typeof options.setup === 'string' && options.setup.trim() !== '') return options.setup;
  if (typeof repoPath !== 'string' || !repoPath) return null;
  let raw;
  try {
    raw = execFileSync('git', ['-C', repoPath, 'config', '--get', 'agentq.setup'], {
      encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 5_000,
    }).trim();
  } catch {
    return null;
  }
  return raw || null;
}

/**
 * Where a worktree records that its setup succeeded: inside the worktree's own
 * git dir, so the marker never shows up as a change in the tree (the same place
 * the pi session transcript lives).
 *
 * @param {string} worktree
 * @returns {string}
 */
function setupMarkerPath(worktree) {
  const gitDir = execFileSync('git', ['-C', worktree, 'rev-parse', '--absolute-git-dir'], {
    encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 5_000,
  }).trim();
  return path.join(gitDir, 'agentq-setup.done');
}

// The setup step shares verify's bound: dependency installs are the slow case.
const SETUP_TIMEOUT_MS = 30 * 60 * 1000;

/**
 * Run the setup command once in a newly created job worktree, before the
 * executor starts. The command runs via a shell with `cwd` at the worktree
 * (through the sandbox wrapper when one is set, exactly like verify), and
 * its output lands in the job log under a `--- setup ---` header.
 *
 * A failure throws, so the attempt fails before the executor runs and
 * runOnce's catch reports it through sink.recover — the same infra path as
 * a worktree-creation failure, never a model outcome.
 *
 * @param {{ sink: { statePath?: string }, job: Record<string, any>, logPath: string, cwd: string, command: string, env: Record<string, string>, sandbox?: string }} params
 * @returns {Promise<{ command: string, exit_code: number }>} for the completion record
 */
async function runWorktreeSetup({ sink, job, logPath, cwd, command, env, sandbox }) {
  const prefix = `\n--- setup ---\n${command}\n`;
  const base = {
    cwd,
    env,
    timeoutMs: SETUP_TIMEOUT_MS,
    statePath: sink.statePath,
    jobId: job.id,
    outputPath: logPath,
    appendOutput: true,
    outputPrefix: prefix,
  };
  const result = sandbox
    ? await runAsync(sandbox, ['sh', '-c', command], base)
    : await runAsync('sh', ['-c', command], base);
  // A deadline breach is failure even if signal cleanup exits zero.
  const exitCode = result.timedOut ? 124 : (result.exitCode ?? 1);
  fs.appendFileSync(logPath, `exit=${exitCode}\n`);
  if (exitCode !== 0) {
    throw new Error(
      `Setup command ${JSON.stringify(command)} failed in ${cwd} (exit ${exitCode}${result.timedOut ? ', timed out' : ''})`,
    );
  }
  return { command, exit_code: exitCode };
}

function runVerify(command, cwd) {
  const result = spawnSync(command, [], {
    cwd,
    encoding: 'utf8',
    shell: true,
    timeout: 30 * 60 * 1000,
  });
  const output = `${result.stdout || ''}${result.stderr ? `\n${result.stderr}` : ''}`;
  return { passed: result.status === 0, exitCode: result.status ?? 1, output };
}

function sleep(ms) {
  if (ms <= 0) return Promise.resolve();
  return new Promise(resolve => setTimeout(resolve, ms));
}

// The sink owns paths so each source can point at its own local worktree/log
// directory while reusing this runner.
function prepareJobWorktree(sink, job) {
  if (!isGitRepo(job.repo_path)) return job.repo_path;
  const branch = `agentq/job-${job.id}`;
  const worktree = sink.worktreePath(job.id);
  if (fs.existsSync(worktree)) return worktree;
  fs.mkdirSync(path.dirname(worktree), { recursive: true });
  const result = spawnSync('git', ['-C', job.repo_path, 'worktree', 'add', '-B', branch, worktree, job.base_branch], {
    encoding: 'utf8',
    timeout: 30_000,
  });
  if (result.status !== 0) {
    const detail = (result.stderr || result.stdout || 'unknown git worktree error').trim();
    throw new Error(`Failed to create isolated worktree for job #${job.id}: ${detail}`);
  }
  return worktree;
  // Note: worktree/branch are not persisted here; the completion result records
  // them (the managed checkout, or the executor's result file for a standalone
  // checkout).
}

/**
 * The executor's first positional argument.
 *
 * A GitHub task keeps its issue number (the documented standalone contract);
 * a spec task has none, so it passes its own id and the executor names the
 * worktree from the pinned title.
 *
 * @param {Record<string, any>} job
 * @param {Record<string, any>|null} [input] the validated pinned input
 * @returns {string}
 */
function executorSubject(job, input = job.task_input ?? null) {
  if (input && input.source === 'github') return String(input.ref);
  if (input) return String(job.id);
  return String(job.issue_number);
}

async function executeJob(job, options, source, { preclaimedModel = null } = {}) {
  // Admission is one pure gate (src/core/admission.js). The local SQLite
  // source already applies it as the claim's candidate filter, so a job it
  // would refuse is never claimed; this check is the single policy applied
  // again to the job that will run. The orchestrator source claims remotely
  // over HTTP *before* executeJob is ever called (source.claimNext already
  // marked the task 'running' server-side), so a refusal must also release
  // that claim.
  // Otherwise the task is stranded 'running' forever (or until its lease
  // expires, then gets re-claimed and refused in the same loop until it
  // silently exhausts max_attempts). recover() is the existing "abort with an
  // error" path (worker.fail on the orchestrator side): it reports
  // status:failed with the message, releasing the claim. A refusal is a
  // deterministic policy decision, not a transient failure, so every retry
  // would refuse identically and it is never retryable.
  const admission = admit(job, options);
  if (!admission.ok) {
    if (source.claimIsRemote) await source.sink.recover(job, admission.reason, { retryable: false });
    // Check (5) carries the original error object so its identity, type and
    // extra properties survive; the other checks only ever had a message.
    throw admission.error ?? new Error(admission.reason);
  }
  return runJobWithRetries(admission.job, options, source, preclaimedModel == null ? null : { model: preclaimedModel });
}

// Auto-retry with exponential backoff (--retry N). Local queue retries wait
// before atomically requeueing/claiming the exact failed completion. Another
// owner or manual action during backoff supersedes that retry. Custom sources
// without claimRetry retain the legacy sink retry protocol. `retries` counts
// retries actually claimed, keeping the default run-next shape identical.
async function runJobWithRetries(job, options, source, preclaimed = null) {
  const sink = source.sink;
  const maxRetries = source.inProcessRetry === false ? 0 : (options.retries || 0);
  const baseMs = options.retryBaseMs ?? 30000;
  let attempt = 0;
  let result;
  while (true) {
    const attemptState = {};
    result = await runOnce(job, options, source, preclaimed, attemptState);
    preclaimed = null;
    if (result.status !== 'failed') break;
    // A deterministic refusal already ended the task; retrying it would just
    // re-claim and re-refuse the same job.
    if (result.refusal) break;
    if (attempt >= maxRetries) break;
    const retryCount = attempt + 1;
    const delay = baseMs * 2 ** attempt; // 1st retry: base, 2nd: 2*base, ...
    if (typeof source.claimRetry === 'function') {
      await sleep(delay);
      // Busy is not superseded. Poll briefly without blocking peer output or
      // heartbeats, but cap contention waits rather than retaining a worker
      // indefinitely behind another process's potentially hours-long run.
      const claimWaitMs = Math.max(0, Math.min(options.timeout || EXECUTOR_TIMEOUT_MS, 30_000));
      const deadline = Date.now() + claimWaitMs;
      let claimed;
      while (true) {
        claimed = await source.claimRetry(job, {
          completionId: attemptState.completionId, retryCount, options,
        });
        const remaining = deadline - Date.now();
        if (claimed?.status !== 'busy' || remaining <= 0) break;
        await sleep(Math.min(50, remaining));
      }
      if (claimed?.status === 'busy') {
        console.error(`job #${job.id}: retry deferred: claim lock stayed busy for ${claimWaitMs}ms; no retry was claimed`);
        break;
      }
      if (!claimed) break;
      preclaimed = claimed;
    } else {
      await sink.requeue(job, { auto: true, retryCount });
      await sleep(delay);
    }
    attempt = retryCount;
  }
  if (maxRetries > 0) result.retries = attempt;
  return result;
}

// One claim → run → finish cycle. The `claimed` event carries the resolved
// model so the audit log shows what actually ran (auto → concrete). When
// --stop-when is set, the executor receives AGENTQ_STOP_WHEN in env and is
// expected to print `SHOULD_FULLY_STOP=true` when the objective is complete;
// `stop` is only included in the result when --stop-when was passed.
async function runOnce(job, options, source, preclaimed = null, attemptState = null) {
  const sink = source.sink;
  // A retry re-claims the task, which mints a fresh claim token; completion
  // must be reported under THAT claim (the previous token is now stale).
  if (preclaimed && (preclaimed.claim_token || preclaimed.claimed_by)) {
    job = {
      ...job,
      claim_token: preclaimed.claim_token ?? job.claim_token,
      claimed_by: preclaimed.claimed_by ?? job.claimed_by,
      // A retry can be routed to a different path than the attempt that
      // failed; its outcome must be recorded against the path that ran.
      ...(Object.hasOwn(preclaimed, 'provider') ? { provider: preclaimed.provider } : {}),
    };
  }
  const model = preclaimed?.model ?? resolveAutoModel(job.model, options);

  // The executor follows the resolved model's harness. A refusal here
  // (unlaunchable harness, pi-only mode) is deterministic policy, not a
  // transient failure: finish THIS job as failed with the reason and let the
  // caller move on. Re-pending it would re-claim and re-refuse the same
  // head-of-queue task on every pass and starve the tasks behind it. The
  // queue's candidate filter cannot make this decision, because an 'auto'
  // model only resolves to a runnable at claim time.
  let executor;
  try {
    executor = resolveExecutor(job, { ...options, model });
  } catch (error) {
    try {
      await sink.recover(job, error, { retryable: false });
    } catch (recoverErr) {
      console.error(`job #${job.id}: failed to release the claim for the error below (${recoverErr.message})`);
    }
    console.error(`job ${job.id}: ${error.message}`);
    return { id: job.id, status: 'failed', exitCode: 1, refusal: error.message };
  }
  // The pinned input is validated once, before the claim, and drives both the
  // executor argument and the stdin payload. The executor's first argument
  // names the task: the issue number for a GitHub task (its standalone
  // contract), the task id for a spec task (the executor derives its worktree
  // slug from the pinned title).
  const taskInput = job.kind === 'feedback' ? null : validateTaskJob(job);
  const execArgs = job.kind === 'feedback'
    ? [String(job.id), model]
    : [executorSubject(job, taskInput), model, ...(taskInput ? ['--agentq-pinned-input'] : [])];
  let command = executor;
  let args = execArgs;
  if (options.sandbox) {
    command = options.sandbox;
    args = [executor, ...execArgs];
  }

  const logPathJob = sink.jobLogPath(job.id);
  fs.mkdirSync(path.dirname(logPathJob), { recursive: true });

  if (!preclaimed) await sink.claim(job, { model });

  // Recover errors before completion so a claimed job is not stranded. Once
  // finish() acknowledges persistence, bookkeeping errors must not reopen it.
  let completionPersisted = false;
  try {
    const runCwd = prepareJobWorktree(sink, job);
    // The setup command runs only in a managed worktree that has not been
    // set up yet: a retry after a successful setup skips it, a retry after a
    // FAILED setup (the task was re-pended, the worktree kept) runs it again,
    // and a non-git repo_path runs in place with nothing to prepare.
    const managedWorktree = isGitRepo(job.repo_path) && runCwd === sink.worktreePath(job.id);
    const setupMarker = managedWorktree ? setupMarkerPath(runCwd) : null;
    const needsSetup = Boolean(setupMarker) && !fs.existsSync(setupMarker);
    // The commit policy travels with the task (taskToJob) or the raw row
    // (orchestrator claims). Resolve the author here, not in the shell
    // scripts, and hand both to the executor as environment.
    const commitPolicy = commitPolicyOf(job);
    const commitAuthor = resolveCommitAuthor(commitPolicy.author, job.repo_path || job.repo || null);
    const attemptId = randomUUID();
    // One fresh result path per attempt, inside a new 0700 directory under the
    // job's log directory: a retry must never read the previous attempt's
    // metadata, and the path is not derivable from sibling file names. Nothing
    // is created at the path itself, so an executor that writes nothing leaves
    // nothing to read.
    const resultPath = createResultPath(path.dirname(logPathJob), job.id, attemptId);
    const env = {
      ...process.env,
      BASE_BRANCH: job.base_branch,
      AGENTQ_WORKTREE: runCwd,
      AGENTQ_JOB_ID: String(job.id),
      AGENTQ_COMMIT_MODE: commitPolicy.commit,
      [RESULT_FILE_ENV]: resultPath,
    };
    if (commitAuthor) {
      env.GIT_AUTHOR_NAME = commitAuthor.name;
      env.GIT_AUTHOR_EMAIL = commitAuthor.email;
      env.GIT_COMMITTER_NAME = commitAuthor.name;
      env.GIT_COMMITTER_EMAIL = commitAuthor.email;
    }
    delete env.AGENTQ_PINNED_INPUT;
    delete env.AGENTQ_INPUT_SHA256;
    if (taskInput) {
      env.AGENTQ_PINNED_INPUT = '1';
      env.AGENTQ_INPUT_SHA256 = taskInput.sha256;
    }
    if (options.cua && options.verify) env.AGENTQ_VERIFY_COMMAND = options.verify;
    if (options.stopWhen) env.AGENTQ_STOP_WHEN = options.stopWhen;
    // Optional one-off worktree preparation (dependency install): --setup
    // wins, else the repo's agentq.setup git config. It runs before the
    // executor, and the verification identity below is captured after it, so
    // setup side effects (gitignored installs) never count as artifact
    // changes. A failure throws: the attempt ends here, through the same
    // infra recovery as a worktree-creation failure, with no model outcome.
    const setupCommand = needsSetup
      ? resolveSetupCommand(options, job.repo_path || job.repo || null)
      : null;
    const setup = setupCommand
      ? await runWorktreeSetup({
        sink, job, logPath: logPathJob, cwd: runCwd, command: setupCommand, env, sandbox: options.sandbox,
      })
      : null;
    // Only a successful setup marks the worktree as prepared.
    if (setup) fs.writeFileSync(setupMarker, `${setup.command}\n`);
    const timeoutMs = options.timeout || EXECUTOR_TIMEOUT_MS;
    // Everything the executor writes must be newer than this, and owned by this
    // user; a pre-existing or foreign file is never accepted.
    const executorStartedAt = Date.now();
    const result = await runAsync(command, args, {
      cwd: runCwd,
      env,
      timeoutMs,
      statePath: sink.statePath,
      jobId: job.id,
      outputPath: logPathJob,
      input: job.kind === 'feedback' ? job.prompt : (taskInput ? JSON.stringify(taskInput) : undefined),
      appendOutput: true,
      outputPrefix: `\n--- attempt ${attemptId} ---\n${JSON.stringify({ jobId: job.id, model, input_sha256: taskInput?.sha256, startedAt: nowIso() })}\n`,
    });

    if (result.timedOut) {
      fs.appendFileSync(logPathJob, `\n--- timed out after ${Math.round(timeoutMs / 1000)}s ---`);
    }

    // A deadline breach is failure even if SIGTERM cleanup exits zero.
    const exitCode = result.timedOut ? 124 : (result.exitCode ?? 1);

    // Metadata comes from the result file only. Stdout is the human log: it
    // echoes the untrusted issue body and the model's output, so nothing in it
    // may steer the persisted worktree, branch, session, usage or stop. A
    // missing or invalid file leaves the metadata null and records why; there
    // is deliberately no fallback to scraping.
    const resultFile = readResultFile(resultPath, {
      notBefore: executorStartedAt,
      uid: typeof process.getuid === 'function' ? process.getuid() : null,
    });
    const meta = resultFile.ok ? resultFile.value : null;
    const resultFileReason = resultFile.ok ? null : resultFile.reason;
    if (resultFileReason) {
      fs.appendFileSync(logPathJob, `\n--- result file ---\n${JSON.stringify({
        result_file: resultFileReason, path: resultPath, detail: resultFile.detail ?? null,
      })}\n`);
    }
    const usage = meta?.usage ?? null;
    // The runner owns managed checkout identity. The result file must not
    // redirect verification or the persisted artifact to another directory.
    // Preserve validated values only for executors without a managed checkout.
    const managedCheckout = runCwd !== job.repo_path;
    const worktree = managedCheckout ? runCwd
      : trustedWorktreeLabel(meta?.worktree, runCwd, sinkWorkArea(sink), job.id);
    const branch = managedCheckout ? `agentq/job-${job.id}`
      : (isSafeBranchName(meta?.branch) ? meta.branch : (worktree ? `agentq/job-${job.id}` : null));
    const session = meta?.session ?? null;

    let nextStatus;
    let verified = null;
    let verification = null;
    if (exitCode !== 0) {
      nextStatus = 'failed';
    } else if (options.cua && options.verify) {
      verified = meta?.verification === 'passed' ? 1 : 0;
      nextStatus = verified ? 'succeeded' : 'unverified';
    } else if (options.verify && worktree) {
      const startedAt = nowIso();
      const before = captureGitSnapshot(worktree);
      // Verification executes agent-modified code through the same boundary.
      // The sandbox command is asynchronous; identity captures are separately bounded.
      let verifyResult;
      if (options.sandbox) {
        const checked = await runAsync(options.sandbox, ['sh', '-c', options.verify], {
          cwd: worktree,
          env,
          timeoutMs: 30 * 60 * 1000,
          statePath: sink.statePath,
          jobId: job.id,
        });
        verifyResult = {
          passed: checked.exitCode === 0 && !checked.timedOut,
          exitCode: checked.exitCode,
          output: `${checked.stdout}${checked.stderr ? `\n${checked.stderr}` : ''}`,
        };
      } else {
        verifyResult = runVerify(options.verify, worktree);
      }
      const after = captureGitSnapshot(worktree);
      const unchanged = before.available && after.available ? before.digest === after.digest
        : (before.available !== after.available ? false : null);
      verification = {
        command: options.verify, exit_code: verifyResult.exitCode,
        started_at: startedAt, finished_at: nowIso(),
        before, after, artifact_unchanged: unchanged,
      };
      // Managed Git jobs require a usable identity. Legacy non-Git executors
      // retain command-only verification, explicitly recorded as unbound.
      const legacyNonGit = !managedCheckout && before.reason === 'not-git' && after.reason === 'not-git';
      const artifactValid = unchanged === true || legacyNonGit;
      verified = verifyResult.passed && artifactValid ? 1 : 0;
      nextStatus = verified ? 'succeeded' : 'unverified';
      const verificationLog = `\n--- verification identity ---\n${JSON.stringify(verification)}\n`
        + `\n--- verify ---\n${options.verify}\nexit=${verifyResult.exitCode}\n${verifyResult.output}`;
      fs.appendFileSync(logPathJob, verificationLog);
    } else if (options.verify && !worktree) {
      // Non-git repo or worktree creation failed: run verify in-place
      // but mark as unverified to flag the gap.
      nextStatus = 'unverified';
    } else {
      nextStatus = 'succeeded';
    }

    const stop = meta?.stop === true;
    // One outcome row per attempt, on the path the attempt actually ran on.
    // `ok` covers exit 0 with or without verification; only timeout/error
    // count against the path (verify_failed is a task failure, not infra).
    await recordAttemptOutcome(sink, job, {
      path: attemptPathFor(job, model),
      model,
      outcome: classifyOutcome({ timedOut: result.timedOut, exitCode, verified }),
    });
    // Persist executor and verification evidence before acknowledging completion.
    const logFd = fs.openSync(logPathJob, 'r+');
    try { fs.fsyncSync(logFd); } finally { fs.closeSync(logFd); }
    const completion = await sink.finish(job, {
      attemptId,
      inputSha256: taskInput?.sha256,
      status: nextStatus,
      exit: exitCode,
      worktree,
      branch,
      session,
      usage,
      log: logPathJob,
      verified,
      verification,
      // What prepared the worktree, so `show` says what ran. Null when no
      // setup was configured (or the worktree was reused): the completed
      // event payload carries it.
      setup,
      stop,
      unexpectedCommits: meta?.unexpectedCommits ?? null,
      // The sinks persist this as `result_file`; null means the executor
      // honoured the contract.
      resultFile: resultFileReason,
    });
    completionPersisted = true;
    if (attemptState) attemptState.completionId = completion?.completionId ?? null;
    // Report what the store actually recorded: a task with attempts left may
    // have been re-pended for a server-side retry instead of finishing.
    const storedStatus = completion?.status ?? nextStatus;

    // Await asynchronous sinks too, so accounting errors remain observable.
    if (usage && storedStatus === 'succeeded') {
      await sink.recordUsage(job, usage);
    }

    // Fire webhook callback if configured
    await sink.fireCallback(job, { status: storedStatus, exit: exitCode, worktree, branch, verified, stop });

    const out = { id: job.id, status: storedStatus, exitCode };
    if (options.stopWhen) out.stop = stop;
    if (resultFileReason) out.result_file = resultFileReason;
    return out;
  } catch (err) {
    // Surface ancillary failures without replaying already-completed work.
    if (completionPersisted) throw err;
    // If recover() itself throws (e.g. the orchestrator rejects it because
    // this job's claim was reassigned while it was running — the same class
    // of condition that can cause the original failure), don't let that
    // secondary failure replace/mask the real error: the caller needs `err`,
    // not an unrelated-looking exception from the recovery attempt.
    try {
      await sink.recover(job, err);
    } catch (recoverErr) {
      console.error(`job #${job.id}: failed to report recovery for the error below (${recoverErr.message})`);
    }
    throw err;
  }
}

module.exports = {
  CUA_FEEDBACK_EXECUTOR,
  CLAUDE_EXECUTOR,
  EXECUTABLE_HARNESSES,
  executorSubject,
  nowIso,
  attemptPathFor,
  recordAttemptOutcome,
  resolveAutoModel,
  resolveHarness,
  resolveExecutor,
  runVerify,
  trustedWorktreeLabel,
  isSafeBranchName,
  commitPolicyOf,
  resolveCommitAuthor,
  resolveSetupCommand,
  runWorktreeSetup,
  prepareJobWorktree,
  isGitRepo,
  sleep,
  executeJob,
  runJobWithRetries,
  runOnce,
  runAsync,
};

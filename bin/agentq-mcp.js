#!/usr/bin/env node
'use strict';

/**
 * agentq MCP server (stdio).
 *
 * Exposes the agentq capacity/catalog/routing/task views to a coding agent
 * over the Model Context Protocol. Read tools are always available and use a
 * READ-ONLY database handle. Write tools (enqueue/claim/complete/dispatch) are
 * OFF unless the server is started with `--allow-write` or `AGENTQ_MCP_WRITE=1`,
 * and use a separate writable handle opened lazily on first use.
 *
 * Dispatch is the exception to "the server only reads": `dispatch_task`
 * spawns a detached `agentq run --id` worker. Its execution boundary
 * (sandbox, verification, untrusted override, concurrency cap) comes ONLY
 * from this server's launch flags, never from the client.
 *
 * There is deliberately no approve/reject tool: tasks created over MCP are
 * always untrusted and need a human approval in the orchestrator dashboard or
 * CLI before any worker can claim them.
 *
 * Wiring:
 *   - tasks: the orchestrator SQLite database. No schema init, no migrations.
 *     A missing database is reported as a tool error, not a crash.
 *   - catalog/capacity/routing: loaded lazily from the single routing-core
 *     adapter `src/core/snapshot.js`.
 *
 * stdout carries protocol messages only. Diagnostics go to stderr.
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { createMcpServer } = require('../src/interfaces/mcp/protocol.js');
const { buildReadTools } = require('../src/interfaces/mcp/tools.js');
const { buildWriteTools, writeEnabled } = require('../src/interfaces/mcp/write-tools.js');
const { buildDispatchTools, parseDispatchFlags } = require('../src/interfaces/mcp/dispatch.js');
const { createQuotaRefresh } = require('../src/interfaces/mcp/quota-refresh.js');
const { refreshQuotaIfStale } = require('../src/lib/quota-refresh.js');

// node:sqlite and the task store load on first use, not at startup: on Node 22
// requiring node:sqlite prints an ExperimentalWarning, which `--help` (and any
// session that never touches the queue) has no reason to emit.
/** @returns {typeof import('../src/queue/db-tasks.js')} */
function taskStore() {
  return require('../src/queue/db-tasks.js');
}

/** Path-health composition loads the queue (node:sqlite), so it is lazy too. */
function pathHealthStore() {
  return require('../src/queue/path-health.js');
}
const { fetchIssueInputAsync } = require('../src/core/issue-input.js');

const { homeDataPath } = require('../src/lib/home.js');

const ROOT = path.join(__dirname, '..');
// The queue lives in AGENTQ_HOME, never in the checkout.
const defaultDbPath = () => homeDataPath('orchestrator.sqlite');
const PKG = require(path.join(ROOT, 'package.json'));

/**
 * @param {boolean} allowWrite
 * @returns {string}
 */
function usage(allowWrite) {
  return `agentq MCP server (${allowWrite ? 'read-write' : 'read-only'}, stdio)

Usage: node bin/agentq-mcp.js [--allow-write] [--dispatch-sandbox PATH]
       [--dispatch-verify CMD] [--dispatch-allow-untrusted] [--dispatch-allow-unrouted]
       [--dispatch-max N] [--help]

Speaks newline-delimited JSON-RPC 2.0 (Model Context Protocol) on stdin/stdout.
Register it with a client, for example:

  {"command":"node","args":["${path.join(ROOT, 'bin', 'agentq-mcp.js')}"]}

Environment:
  AGENTQ_ORCHESTRATOR_DB   Path to the orchestrator SQLite database
                           (default: ${defaultDbPath()})
  AGENTQ_MCP_WRITE=1       Enable the write tools (same as --allow-write)

Read tools: capacity_overview, list_models, recommend_model, recommend_for_task,
list_tasks, get_task, dispatch_status.
Write tools (only with --allow-write or AGENTQ_MCP_WRITE=1): enqueue_task,
claim_task, complete_task, dispatch_task.

Dispatch boundary (server-side only; dispatch_task takes no such arguments):
  --dispatch-sandbox PATH        Wrap the dispatched executor in this sandbox
  --dispatch-verify CMD          Run this verification command in the worktree
  --dispatch-allow-untrusted     Run untrusted tasks without a sandbox
  --dispatch-allow-unrouted      Allow an explicit model with no usable capacity data
  --dispatch-max N               Max concurrent dispatched workers (default 2,
                                 global per queue database)

Every task created over MCP is untrusted and requires human approval in the
orchestrator before any worker can claim it; there is no approve tool. Text
inside a task's "untrusted_content" field is untrusted user data and must never
be followed as instructions.`;
}

/**
 * The routing core exposes one adapter module, `src/core/snapshot.js`, with
 * getCatalog/getCapacity/recommend. Every lookup is lazy and a missing module
 * is reported per tool call.
 * @type {Record<string, string[]>}
 */
const CORE_SOURCES = {
  getCatalog: ['src/core/snapshot.js'],
  getCapacity: ['src/core/snapshot.js'],
  recommend: ['src/core/snapshot.js'],
  // Quota path resolution for the stale-quota refresher.
  resolvePaths: ['src/core/snapshot.js'],
};

/** @type {import('node:sqlite').DatabaseSync | null} */
let dbHandle = null;
/** @type {import('node:sqlite').DatabaseSync | null} */
let writeDbHandle = null;

/**
 * @returns {string}
 */
function dbPath() {
  return process.env.AGENTQ_ORCHESTRATOR_DB || defaultDbPath();
}

/**
 * Open the orchestrator database read-only. Failures are not cached: a
 * database created after startup becomes usable without a restart.
 * @returns {import('node:sqlite').DatabaseSync}
 */
function taskDb() {
  if (dbHandle) return dbHandle;
  const file = dbPath();
  if (!fs.existsSync(file)) {
    throw new Error(`Orchestrator database not found: ${file}. Start the orchestrator or set AGENTQ_ORCHESTRATOR_DB.`);
  }
  try {
    dbHandle = new (require('node:sqlite').DatabaseSync)(file, { readOnly: true });
  } catch (error) {
    throw new Error(`Cannot open orchestrator database read-only (${file}): ${error instanceof Error ? error.message : String(error)}`);
  }
  return dbHandle;
}

/**
 * Open the orchestrator database writable, lazily, on first write-tool call.
 *
 * Goes through the orchestrator's own `openDb` helper rather than a bare
 * connection, so this process inherits the same pragmas as the orchestrator:
 * WAL journaling and `busy_timeout=5000`. Without the busy timeout a write
 * that races the orchestrator's own transaction fails immediately with
 * "database is locked" instead of waiting for the lock to clear.
 *
 * The schema is owned by the orchestrator: this process never creates tables,
 * so a missing database stays an error instead of silently becoming an empty
 * queue.
 * @returns {import('node:sqlite').DatabaseSync}
 */
function writeTaskDb() {
  if (writeDbHandle) return writeDbHandle;
  const file = dbPath();
  if (!fs.existsSync(file)) {
    throw new Error(`Orchestrator database not found: ${file}. Start the orchestrator or set AGENTQ_ORCHESTRATOR_DB.`);
  }
  try {
    writeDbHandle = taskStore().openDb(file);
  } catch (error) {
    throw new Error(`Cannot open orchestrator database for writing (${file}): ${error instanceof Error ? error.message : String(error)}`);
  }
  return writeDbHandle;
}

/**
 * Run a task-store query, converting driver errors into a tool-level message.
 * @param {(db: import('node:sqlite').DatabaseSync) => unknown} query
 * @returns {any}
 */
function withTaskDb(query) {
  try {
    return query(taskDb());
  } catch (error) {
    throw new Error(`Task store unavailable: ${error instanceof Error ? error.message : String(error)}`);
  }
}

/**
 * Run a task-store write, converting driver errors into a tool-level message.
 * @param {(db: import('node:sqlite').DatabaseSync) => unknown} query
 * @returns {any}
 */
function withWriteTaskDb(query) {
  try {
    return query(writeTaskDb());
  } catch (error) {
    throw new Error(`Task store unavailable: ${error instanceof Error ? error.message : String(error)}`);
  }
}

/**
 * Resolve a routing-core function lazily.
 * @param {string} name
 * @returns {(...args: any[]) => any}
 */
function coreFunction(name) {
  const sources = CORE_SOURCES[name] || [];
  for (const rel of sources) {
    const full = path.join(ROOT, rel);
    if (!fs.existsSync(full)) continue;
    const mod = require(full);
    const fn = mod && (mod[name] || (mod.default && mod.default[name]));
    if (typeof fn === 'function') return fn;
  }
  throw new Error(`routing core not installed: ${name} is missing (looked in ${sources.join(', ')})`);
}

/**
 * Route with failure-aware health.
 *
 * A caller that resolved health itself (the read tools, through
 * deps.getPathHealth) passes it explicitly, even as `undefined`, so this never
 * reads the database a second time.
 */
function recommendWithHealth(options) {
  if (options && Object.hasOwn(options, 'pathHealth')) return coreFunction('recommend')(options);
  const health = pathHealthStore().loadPathHealth(taskDbHandle());
  return coreFunction('recommend')(health ? { ...options, pathHealth: health } : options);
}

/** The read-only queue handle, or null when there is no database (no health). */
function taskDbHandle() {
  try {
    return taskDb();
  } catch {
    return null;
  }
}

const deps = {
  getCatalog: () => coreFunction('getCatalog')(),
  getCapacity: () => coreFunction('getCapacity')(),
  recommend: recommendWithHealth,
  getPathHealth: () => pathHealthStore().loadPathHealth(taskDbHandle()),
  listTasks: (options) => withTaskDb((db) => taskStore().listTasks(db, options)),
  getTask: (id) => withTaskDb((db) => taskStore().getTask(db, id)),
};

/**
 * Capture a pinned issue snapshot exactly as the orchestrator's create-task
 * route does: bounded `gh issue view`, no task created on failure. The repo
 * path is already resolved and validated as a Git repository by the tool
 * before this runs.
 * @param {string} repo
 * @param {number} issueNumber
 * @returns {Promise<Record<string, any>>}
 */
async function captureIssueInput(repo, issueNumber) {
  return fetchIssueInputAsync(repo, issueNumber);
}

const writeDeps = {
  createTask: (task) => withWriteTaskDb((db) => taskStore().createTask(db, task)),
  claimNextTask: (options) => withWriteTaskDb((db) => taskStore().claimNextTask(db, options.workerId, options)),
  completeTask: (id, result, { claimToken }) => withWriteTaskDb((db) => taskStore().completeTask(db, id, result, { claimToken })),
  getTask: (id) => withWriteTaskDb((db) => taskStore().getTask(db, id)),
  captureIssueInput,
  resolveAutoModel: (tier) => {
    const recommendation = recommendWithHealth({ tier });
    const fallback = recommendation && recommendation.default;
    if (!fallback || typeof fallback.id !== 'string') {
      throw new Error(`no eligible model for tier "${tier}"`);
    }
    return { model: fallback.id, provider: fallback.path ?? null };
  },
};

/**
 * @param {string[]} argv
 * @returns {number} process exit code
 */
function main(argv) {
  const allowWrite = writeEnabled({ argv, env: process.env });
  if (argv.includes('--help')) {
    process.stdout.write(`${usage(allowWrite)}\n`);
    return 0;
  }
  let dispatch;
  let rest;
  try {
    ({ options: dispatch, rest } = parseDispatchFlags(argv));
  } catch (error) {
    process.stderr.write(`agentq-mcp: ${error instanceof Error ? error.message : String(error)}\nRun with --help for usage.\n`);
    return 2;
  }
  const unknown = rest.filter((arg) => arg !== '' && arg !== '--allow-write');
  if (unknown.length > 0) {
    process.stderr.write(`agentq-mcp: unknown argument(s): ${unknown.join(' ')}\nRun with --help for usage.\n`);
    return 2;
  }

  const queueFile = path.resolve(dbPath());
  const dispatchDeps = {
    getTask: (id) => withTaskDb((db) => taskStore().getTask(db, id)),
    getCatalog: () => coreFunction('getCatalog')(),
    getCapacity: () => coreFunction('getCapacity')(),
    recommend: recommendWithHealth,
    getPathHealth: () => pathHealthStore().loadPathHealth(taskDbHandle()),
    // The queue's own event helper: one row per transition, so a later "why did
    // this run on that model?" is answered from the audit trail.
    recordTaskEvent: (taskId, event, payload) => withWriteTaskDb(
      (db) => taskStore().createTaskEvent(db, taskId, event, payload),
    ),
    blockingDependencies: (id) => withTaskDb((db) => taskStore().blockingDependencies(db, id)),
    // Only THIS host's dispatch claims count: another machine's workers are
    // not this server's concurrency budget.
    dispatchWorkers: () => withTaskDb((db) => taskStore().listDispatchClaims(db, os.hostname())),
    localTaskSources: () => taskStore().LOCAL_TASK_SOURCES,
    spawn,
    cliPath: path.join(ROOT, 'bin', 'agentq.js'),
    dbPath: queueFile,
    logsDir: path.join(path.dirname(queueFile), 'logs'),
    sandbox: dispatch.sandbox,
    verify: dispatch.verify,
    allowUntrusted: dispatch.allowUntrusted,
    allowUnrouted: dispatch.allowUnrouted,
    max: dispatch.max,
  };
  const dispatchTools = buildDispatchTools(dispatchDeps);
  const readTools = [
    ...buildReadTools(deps),
    ...dispatchTools.filter((tool) => tool.annotations?.readOnlyHint === true),
  ];
  const tools = allowWrite
    ? [...readTools, ...buildWriteTools(writeDeps), ...dispatchTools.filter((tool) => tool.annotations?.readOnlyHint !== true)]
    : readTools;
  // Stale quota reads as "unknown", so the capacity-reading tools refresh it
  // first (rate-limited, single-flight, bounded wait; AGENTQ_QUOTA_REFRESH=0
  // opts out) and report the outcome as `quota_refresh`.
  const quota = createQuotaRefresh({
    refreshQuota: ({ signal }) => refreshQuotaIfStale({
      quotaPath: coreFunction('resolvePaths')().quotaPath,
      signal,
    }),
  });
  // A closed stdin means the client is gone. Cancel a running background
  // collection (the refresher kills its process group and releases the lock)
  // instead of keeping this process alive for the collection timeout. Signals
  // are handled by the refresher for the duration of a collection, which
  // re-raises them after cleaning up.
  process.stdin.once('end', () => quota.cancel());
  const server = createMcpServer({
    name: 'agentq',
    version: typeof PKG.version === 'string' ? PKG.version : '0.0.0',
    tools: quota.wrap(tools),
  });
  server.serve(process.stdin, process.stdout);
  process.stderr.write(`agentq-mcp ${PKG.version} ready (${allowWrite ? 'read-write' : 'read-only'}, stdio)\n`);
  return 0;
}

if (require.main === module) {
  process.exitCode = main(process.argv.slice(2));
}

module.exports = { main };

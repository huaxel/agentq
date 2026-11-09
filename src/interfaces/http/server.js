#!/usr/bin/env node
'use strict';

/**
 * Orchestrator — HTTP server with REST API and embedded web dashboard.
 *
 * Usage:
 *   node src/interfaces/http/server.js                    — start server (default :8090)
 *   node src/interfaces/http/server.js --port 3000        — custom port
 *   node src/interfaces/http/server.js --db /path/to/db   — custom DB path
 *   node src/interfaces/http/server.js migrate --log PATH — one-shot agentq.log import
 *   node src/interfaces/http/server.js recover            — recover expired running tasks
 *
 * Auth: set AUTH_TOKEN env var for bearer-token auth on all API endpoints;
 *       it is mandatory when binding beyond localhost.
 * Bind: defaults to 127.0.0.1 for security; use --host 0.0.0.0 only with auth.
 *
 * The request routing and endpoint handlers live in routes.js; this module
 * owns argument parsing, lifecycle, and the periodic cleanup loop.
 */

const http = require('node:http');
const path = require('node:path');
const { openDb, initSchema } = require('../../queue/db.js');
const dbModule = require('../../queue/db.js');
const { loadConfig } = require('../../lib/model-picker.js');
const { resolveAutoModel: resolveAutoModelFor } = require('../../core/auto-model.js');
const { getCapacity } = require('../../core/snapshot.js');
const { loadPathHealth } = require('../../queue/path-health.js');
const { homeDataPath } = require('../../lib/home.js');
const { handleRequest, memoizeWithTtl, broadcastSse, closeSseClients } = require('./routes.js');
const DASHBOARD_HTML = require('./dashboard-html.js');

// --- CLI parsing ---

function isLoopbackHost(host) {
  return host === '127.0.0.1' || host === 'localhost' || host === '::1' || host === '[::1]';
}

function parseArgs(argv) {
  const args = [...argv];
  const opts = {
    port: 8090,
    db: homeDataPath('orchestrator.sqlite'),
    host: '127.0.0.1',
    quota: homeDataPath('quota.json'),
    // null means "the method defaults merged with <home>/config/roi.config.json".
    config: null,
    recoveryMinutes: 60,
    pruneDays: 30,
    workerStaleMinutes: 60,
    cleanupIntervalMinutes: 5,
  };
  while (args.length) {
    const flag = args.shift();
    if (flag === '--port' || flag === '-p') opts.port = Number(args.shift());
    else if (flag === '--db' || flag === '-d') opts.db = args.shift();
    else if (flag === '--log' || flag === '-l') opts.log = args.shift();
    else if (flag === '--host' || flag === '-H') opts.host = args.shift();
    else if (flag === '--quota' || flag === '-q') opts.quota = args.shift();
    else if (flag === '--config' || flag === '-c') opts.config = args.shift();
    else if (flag === '--recovery-minutes') opts.recoveryMinutes = Number(args.shift());
    else if (flag === '--prune-days') opts.pruneDays = Number(args.shift());
    else if (flag === '--worker-stale-minutes') opts.workerStaleMinutes = Number(args.shift());
    else if (flag === '--cleanup-interval-minutes') opts.cleanupIntervalMinutes = Number(args.shift());
    else if (flag === 'migrate' || flag === '--migrate') opts.migrate = true;
    else if (flag === 'recover' || flag === '--recover') opts.recover = true;
    else if (flag === '--help' || flag === '-h') { opts.help = true; break; }
  }
  return opts;
}

// --- Server ---

function createServer(db, resolveAutoModel = null, options = {}) {
  return http.createServer((req, res) => handleRequest(req, res, db, resolveAutoModel, options));
}

function main(argv) {
  const opts = parseArgs(argv);

  if (opts.help) {
    console.log(`Usage: node src/interfaces/http/server.js [options] [command]`);
    console.log('');
    console.log('Commands:');
    console.log('  migrate    One-shot import of a legacy agentq.log into the task store');
    console.log('  recover    Recover expired running tasks back to pending');
    console.log('');
    console.log('Options:');
    console.log('  -p, --port PORT                    Server port (default: 8090)');
    console.log('  -H, --host HOST                    Bind address (default: 127.0.0.1)');
    console.log('  -d, --db PATH                      Database path (default: <home>/data/orchestrator.sqlite)');
    console.log('  -l, --log PATH                     Legacy JSONL log to import with migrate (default: <home>/data/agentq.log)');
    console.log('  -q, --quota PATH                   Quota file for auto model resolution (default: <home>/data/quota.json)');
    console.log('  -c, --config PATH                  Config file for model attribution (default: defaults merged with <home>/config/roi.config.json)');
    console.log('  --recovery-minutes MIN             Stale task recovery threshold (default: 60)');
    console.log('  --prune-days DAYS                  Auto-prune completed tasks older than N days (default: 30)');
    console.log('  --worker-stale-minutes MIN         Remove workers offline longer than N minutes (default: 60)');
    console.log('  --cleanup-interval-minutes MIN     How often to run cleanup (default: 5)');
    console.log('');
    console.log('Auth: set AUTH_TOKEN env var for bearer-token auth (required beyond localhost)');
    return;
  }

  if (opts.migrate) {
    // Same one-shot import as `agentq import-log`; it never runs continuously.
    const logPath = opts.log ? path.resolve(opts.log) : homeDataPath('agentq.log');
    const db = openDb(opts.db);
    initSchema(db);
    try {
      const result = dbModule.migrateAgentqLog(db, logPath);
      console.log(`Migrated ${result.migrated} task(s), ${result.skipped} skipped`);
    } finally {
      db.close();
    }
    return;
  }

  if (opts.recover) {
    const db = openDb(opts.db);
    initSchema(db);
    const result = dbModule.recoverExpiredTasks(db, 60);
    console.log(`Recovered ${result.recovered} expired task(s)`);
    db.close();
    return;
  }

  if (!isLoopbackHost(opts.host) && !process.env.AUTH_TOKEN) {
    console.error('Refusing to bind orchestrator beyond localhost without AUTH_TOKEN');
    process.exitCode = 1;
    return;
  }

  let config = null;
  if (!opts.migrate && !opts.recover) {
    try {
      config = loadConfig(opts.config);
      // Read the quota snapshot once at boot so a malformed file fails loudly
      // here instead of silently skipping every 'auto' task at claim time.
      getCapacity({ quotaPath: opts.quota });
    } catch (err) {
      console.error(`Failed to load config/quota: ${err.message}`);
      process.exit(1);
    }
  }

  const db = openDb(opts.db);
  initSchema(db);

  // Auto routing re-reads runnables, ROI scores and quota rather than closing
  // over the boot-time snapshot: collect-quota re-runs periodically and the
  // server is long-running. Cache the decision for a short window: a single
  // claim can call resolveAutoModel once per pending 'auto' task, and each
  // call is a set of synchronous reads that would otherwise block the event
  // loop redundantly for every candidate past the first. Path health rides
  // the same cache window, so a failure streak demotes a path within seconds.
  const resolveAutoCached = memoizeWithTtl(
    () => resolveAutoModelFor('auto', { quotaPath: opts.quota, config, pathHealth: loadPathHealth(db) }),
    1000,
  );
  const resolveAutoModel = config
    ? (storedModel) => (storedModel === 'auto'
      ? resolveAutoCached()
      : resolveAutoModelFor(storedModel, { config }))
    : null;

  // Periodic recovery: recover expired/abandoned running tasks back to
  // pending so they can be re-claimed, instead of leaving them stuck
  // until an operator runs `node server.js recover` manually.
  const CLEANUP_INTERVAL_MS = opts.cleanupIntervalMinutes * 60 * 1000;
  const recoveryTimer = setInterval(() => {
    try {
      // Recover expired running tasks
      const result = dbModule.recoverExpiredTasks(db, opts.recoveryMinutes);
      if (result.recovered > 0) {
        console.log(`Recovered ${result.recovered} expired task(s)`);
        broadcastSse('tasks-recovered', result);
      }
      // Prune old completed tasks
      const pruned = dbModule.pruneCompletedTasks(db, opts.pruneDays);
      if (pruned.pruned > 0) {
        console.log(`Pruned ${pruned.pruned} old completed task(s)`);
      }
      // Clean up stale workers
      const cleaned = dbModule.cleanupStaleWorkers(db, opts.workerStaleMinutes);
      if (cleaned.removed > 0) {
        console.log(`Cleaned up ${cleaned.removed} stale worker(s)`);
      }
    } catch (err) {
      console.error('Periodic cleanup failed:', err.message);
    }
  }, CLEANUP_INTERVAL_MS);

  const server = createServer(db, resolveAutoModel);

  let shuttingDown = false;
  const shutdown = signal => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`\nReceived ${signal}; shutting down...`);
    clearInterval(recoveryTimer);
    closeSseClients();
    const forceTimer = setTimeout(() => server.closeAllConnections(), 10_000);
    server.close(() => {
      clearTimeout(forceTimer);
      try { db.close(); } finally { process.exit(0); }
    });
  };
  process.once('SIGINT', () => shutdown('SIGINT'));
  process.once('SIGTERM', () => shutdown('SIGTERM'));

  // Allow the timer to keep the process alive (setInterval already does).
  server.on('close', () => clearInterval(recoveryTimer));

  server.listen(opts.port, opts.host, () => {
    console.log(`Orchestrator running on http://${opts.host}:${opts.port}`);
    console.log(`  Dashboard: http://${opts.host}:${opts.port}/`);
    console.log(`  REST API:  http://${opts.host}:${opts.port}/api/tasks`);
    console.log(`  Database:  ${opts.db}`);
    if (process.env.AUTH_TOKEN) {
      console.log(`  Auth:      Bearer token enabled`);
    }
  });
}

if (require.main === module) {
  main(process.argv.slice(2));
}

module.exports = { createServer, handleRequest, DASHBOARD_HTML, memoizeWithTtl };

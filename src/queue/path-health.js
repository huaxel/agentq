'use strict';

/**
 * Path health composition (queue layer): the one adapter that reads recorded
 * attempt outcomes from the queue and folds them with the pure rule in
 * src/core/path-health.js.
 *
 * Every DB-holding caller uses these helpers instead of its own copy:
 * sources (claim/retry), the orchestrator server, the MCP composition root,
 * and the CLI. Core and lib never import queue; interfaces and runners may.
 *
 * Failure policy: a missing history, a disabled feature
 * (`AGENTQ_PATH_HEALTH=0`), a database without the `path_outcomes` table yet,
 * or an unreadable database all mean "route without health" — never a thrown
 * error. An unreadable database is reported once per process on stderr.
 */

const fs = require('node:fs');

const { pathHealth } = require('../core/path-health.js');
const { getPathOutcomes } = require('./db.js');

/** Warn once per process: a DB read failure must not break routing. */
let warned = false;

/**
 * @param {unknown} error
 * @returns {boolean} true for a database that predates the table (no data, not a fault).
 */
function isMissingTable(error) {
  const message = error instanceof Error ? error.message : String(error ?? '');
  return /no such table/i.test(message);
}

/**
 * @param {string} message
 */
function warnOnce(message) {
  if (warned) return;
  warned = true;
  process.stderr.write(`${message}\n`);
}

/**
 * Per-path infrastructure-failure health for routing.
 *
 * @param {import('node:sqlite').DatabaseSync|null|undefined} db
 * @param {{ now?: number, env?: NodeJS.ProcessEnv }} [opts]
 * @returns {Map<string, { state: 'healthy'|'degraded', consecutive: number, lastFailureAt: string|null, reason: string|null }>|undefined}
 *   undefined means "route without health".
 */
function loadPathHealth(db, { now = Date.now(), env = process.env } = {}) {
  if (!db || env.AGENTQ_PATH_HEALTH === '0') return undefined;
  try {
    const health = pathHealth(getPathOutcomes(db, { now }), { now });
    return health.size ? health : undefined;
  } catch (error) {
    if (!isMissingTable(error)) {
      warnOnce(`agentq: path health unavailable (${error instanceof Error ? error.message : String(error)}); routing without it`);
    }
    return undefined;
  }
}

/**
 * Same health, read from a queue file this process does not own.
 *
 * Read-only and strictly non-creating: a command like `agentq pick` must not
 * create or require the queue database, so a missing file (or a database from
 * before the table existed) simply means no health.
 *
 * @param {string} dbPath
 * @param {{ now?: number, env?: NodeJS.ProcessEnv }} [opts]
 * @returns {Map<string, { state: 'healthy'|'degraded', consecutive: number, lastFailureAt: string|null, reason: string|null }>|undefined}
 */
function loadPathHealthFile(dbPath, { now = Date.now(), env = process.env } = {}) {
  if (!dbPath || env.AGENTQ_PATH_HEALTH === '0') return undefined;
  if (!fs.existsSync(dbPath)) return undefined;
  const { DatabaseSync } = require('node:sqlite');
  let db = null;
  try {
    db = new DatabaseSync(dbPath, { readOnly: true });
    return loadPathHealth(db, { now, env });
  } catch (error) {
    if (!isMissingTable(error)) {
      warnOnce(`agentq: path health unavailable (${error instanceof Error ? error.message : String(error)}); routing without it`);
    }
    return undefined;
  } finally {
    if (db) {
      try { db.close(); } catch { /* already closed */ }
    }
  }
}

module.exports = { loadPathHealth, loadPathHealthFile };

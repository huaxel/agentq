'use strict';

/**
 * Track-record composition (queue layer): the one adapter that reads recorded
 * reviews and failed verifications from the queue and folds them with the pure
 * rule in src/core/track-record.js.
 *
 * It mirrors src/queue/path-health.js on purpose: the same failure policy (a
 * missing database, a database from before the table existed, or an unreadable
 * one all mean "no records", never an error), the same read-only non-creating
 * file variant for commands that must not create a queue, and the same
 * warn-once-on-stderr report for a real fault.
 *
 * Core and lib never import queue; interfaces and runners may.
 */

const fs = require('node:fs');

const { buildTrackRecords } = require('../core/track-record.js');
const { defaultRunnablesFile, loadRunnables } = require('../core/catalog.js');
const { listReviews, getVerifyFailures } = require('./db.js');

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
 * The runnable list used to resolve a review's runnable id to its model key.
 * A missing or unreadable file is not a routing failure: the key then comes
 * from the id alone, which is what the catalog does for an undeclared key.
 *
 * @param {string|null|undefined} runnablesPath
 * @returns {Array<{ id: string, modelKey: string|null }>}
 */
function readRunnables(runnablesPath) {
  try {
    return loadRunnables(runnablesPath || defaultRunnablesFile());
  } catch {
    return [];
  }
}

/**
 * Per-(model key, tier) track records from a queue handle.
 *
 * @param {import('node:sqlite').DatabaseSync|null|undefined} db
 * @param {{ runnables?: Array<{ id: string, modelKey?: string|null }>|null, runnablesPath?: string|null }} [opts]
 * @returns {Map<string, Map<string, { n: number, accepted: number, withFixes: number, rejected: number, rate: number, lowerBound: number }>>|undefined}
 *   undefined means "route without records".
 */
function loadTrackRecords(db, { runnables = null, runnablesPath = null } = {}) {
  if (!db) return undefined;
  try {
    const records = buildTrackRecords({
      reviews: listReviews(db),
      verifyOutcomes: getVerifyFailures(db),
      runnables: Array.isArray(runnables) ? runnables : readRunnables(runnablesPath),
    });
    return records.size ? records : undefined;
  } catch (error) {
    if (!isMissingTable(error)) {
      warnOnce(`agentq: track records unavailable (${error instanceof Error ? error.message : String(error)}); routing without them`);
    }
    return undefined;
  }
}

/**
 * Same records, read from a queue file this process does not own.
 *
 * Read-only and strictly non-creating: `agentq pick` and the routing core must
 * not create or require the queue database, so a missing file (or a database
 * from before the table existed) simply means no records.
 *
 * @param {string} dbPath
 * @param {{ runnables?: Array<{ id: string, modelKey?: string|null }>|null, runnablesPath?: string|null }} [opts]
 * @returns {Map<string, Map<string, any>>|undefined}
 */
function loadTrackRecordsFile(dbPath, { runnables = null, runnablesPath = null } = {}) {
  if (!dbPath || !fs.existsSync(dbPath)) return undefined;
  const { DatabaseSync } = require('node:sqlite');
  let db = null;
  try {
    db = new DatabaseSync(dbPath, { readOnly: true });
    return loadTrackRecords(db, { runnables, runnablesPath });
  } catch (error) {
    if (!isMissingTable(error)) {
      warnOnce(`agentq: track records unavailable (${error instanceof Error ? error.message : String(error)}); routing without them`);
    }
    return undefined;
  } finally {
    if (db) {
      try { db.close(); } catch { /* already closed */ }
    }
  }
}

/**
 * Review rows from a queue file, newest first. Read-only and non-creating, for
 * `agentq review list`.
 *
 * @param {string} dbPath
 * @param {{ model?: string|null, since?: string|number|Date|null }} [opts]
 * @returns {Array<Record<string, any>>} empty when there is no queue yet.
 */
function loadReviewsFile(dbPath, { model = null, since = null } = {}) {
  if (!dbPath || !fs.existsSync(dbPath)) return [];
  const { DatabaseSync } = require('node:sqlite');
  let db = null;
  try {
    db = new DatabaseSync(dbPath, { readOnly: true });
    return listReviews(db, { model, since });
  } catch (error) {
    if (!isMissingTable(error)) {
      warnOnce(`agentq: reviews unavailable (${error instanceof Error ? error.message : String(error)}); reporting none`);
    }
    return [];
  } finally {
    if (db) {
      try { db.close(); } catch { /* already closed */ }
    }
  }
}

module.exports = { loadTrackRecords, loadTrackRecordsFile, loadReviewsFile };

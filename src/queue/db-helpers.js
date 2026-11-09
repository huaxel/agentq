'use strict';

/**
 * Shared helpers for the orchestrator database modules.
 */

const crypto = require('node:crypto');

function nowIso() {
  return new Date().toISOString();
}

function uuidv4() {
  return crypto.randomUUID();
}

function json(obj) {
  return obj != null ? JSON.stringify(obj) : null;
}

function parseJson(val) {
  if (val == null) return null;
  try {
    return JSON.parse(val);
  } catch {
    return val;
  }
}

/**
 * True when the error means "another connection holds the write lock".
 *
 * node:sqlite reports SQLITE_BUSY as errcode 5 with the message
 * "database is locked"; callers use this to report queue contention as its own
 * state instead of as a job failure.
 */
function isSqliteBusy(error) {
  if (!error) return false;
  if (error.errcode === 5) return true;
  return /SQLITE_BUSY|database is locked/i.test(String(error.message || ''));
}

module.exports = { nowIso, uuidv4, json, parseJson, isSqliteBusy };

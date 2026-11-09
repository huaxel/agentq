'use strict';

/**
 * Path health: failure-aware routing input. Pure — no fs, no db, no clock
 * reads (callers inject `now`). The queue records one row per attempt per
 * path; this module folds a window of those rows into a per-path verdict the
 * routing core (`src/core/routing.js`) ranks below every healthy choice.
 *
 * A path is degraded when its most recent `threshold` (default 3) non-ignored
 * outcomes inside `window` (default 60 minutes) are all infrastructure
 * failures (`timeout`, `error` or `lost` — a lease that expired with no
 * completion report), and the last of them is less than `cooldown` (default
 * 30 minutes) old. Any `ok` after the failures resets it. `verify_failed`
 * rows are task failures, not infrastructure failures, so they never count.
 */

const WINDOW_MS = 60 * 60 * 1000;
const THRESHOLD = 3;
const COOLDOWN_MS = 30 * 60 * 1000;

const INFRA_FAILURES = new Set(['timeout', 'error', 'lost']);

/**
 * @param {unknown} value
 * @returns {number|null} epoch ms, or null when unparseable.
 */
function parseTime(value) {
  if (typeof value !== 'string' && typeof value !== 'number') return null;
  const ms = typeof value === 'number' ? value : Date.parse(value);
  return Number.isFinite(ms) ? ms : null;
}

/**
 * @param {number} ageMs
 * @returns {string} compact age like "12m" (the caller appends "ago").
 */
function formatAge(ageMs) {
  const age = Math.max(0, ageMs);
  if (age < 60 * 1000) return `${Math.max(1, Math.floor(age / 1000))}s`;
  if (age < 60 * 60 * 1000) return `${Math.floor(age / (60 * 1000))}m`;
  if (age < 24 * 60 * 60 * 1000) return `${Math.floor(age / (60 * 60 * 1000))}h`;
  return `${Math.floor(age / (24 * 60 * 60 * 1000))}d`;
}

/**
 * Classify one attempt's outcome. The ONE classifier: the local runner and the
 * orchestrator's HTTP completion route both call this, so a remote attempt and
 * a local one are counted identically.
 *
 * `ok` means exit 0, whether or not verification ran; `timeout` is a runner
 * timeout or exit 124; `error` is any other non-zero exit (or a reported
 * `failed` with no exit code); `verify_failed` is exit 0 with failed
 * verification — a task failure, not an infrastructure failure, so it never
 * counts against the path. A verification that never ran (`verified` null)
 * is `ok`, never `verify_failed`.
 *
 * @param {{ timedOut?: boolean, exitCode?: number|null, verified?: number|null, status?: string|null }} [attempt]
 * @returns {'ok'|'timeout'|'error'|'verify_failed'}
 */
function classifyOutcome({ timedOut = false, exitCode = null, verified = null, status = null } = {}) {
  if (timedOut || exitCode === 124) return 'timeout';
  if (typeof exitCode === 'number' && exitCode !== 0) return 'error';
  if (exitCode == null && status === 'failed') return 'error';
  if (verified === 0) return 'verify_failed';
  return 'ok';
}

/**
 * Fold attempt-outcome rows into a per-path health verdict.
 *
 * @param {Array<{ path: string, outcome: string, created_at: string }>} [outcomes]
 * @param {{ now?: number, window?: number, threshold?: number, cooldown?: number }} [opts]
 * @returns {Map<string, { state: 'healthy'|'degraded', consecutive: number, lastFailureAt: string|null, reason: string|null }>}
 */
function pathHealth(outcomes = [], { now = Date.now(), window = WINDOW_MS, threshold = THRESHOLD, cooldown = COOLDOWN_MS } = {}) {
  const nowMs = Number(now);
  const cutoff = nowMs - window;
  /** @type {Map<string, Array<{ outcome: string, at: number }>>} */
  const byPath = new Map();
  for (const row of outcomes || []) {
    if (!row || typeof row.path !== 'string' || !row.path) continue;
    const outcome = row.outcome;
    if (outcome === 'verify_failed') continue;
    if (outcome !== 'ok' && !INFRA_FAILURES.has(outcome)) continue;
    const at = parseTime(row.created_at);
    if (at === null || at < cutoff) continue;
    let list = byPath.get(row.path);
    if (!list) {
      list = [];
      byPath.set(row.path, list);
    }
    list.push({ outcome, at });
  }

  /** @type {Map<string, { state: 'healthy'|'degraded', consecutive: number, lastFailureAt: string|null, reason: string|null }>} */
  const health = new Map();
  for (const [path, rows] of byPath) {
    rows.sort((a, b) => a.at - b.at);
    let consecutive = 0;
    const kinds = { timeout: 0, error: 0, lost: 0 };
    let lastFailureMs = null;
    for (const row of rows) {
      if (INFRA_FAILURES.has(row.outcome)) {
        consecutive += 1;
        kinds[row.outcome] += 1;
        lastFailureMs = row.at;
      } else {
        // An `ok` ends the streak: the kind counts describe the failures
        // SINCE it, so they reset with `consecutive`. Leaving them behind
        // reported e.g. "3 consecutive failures (4 timeout, ...)".
        consecutive = 0;
        kinds.timeout = 0;
        kinds.error = 0;
        kinds.lost = 0;
      }
    }
    const lastFailureAt = lastFailureMs === null ? null : new Date(lastFailureMs).toISOString();
    const degraded = consecutive >= threshold && lastFailureMs !== null && (nowMs - lastFailureMs) < cooldown;
    health.set(path, {
      state: degraded ? 'degraded' : 'healthy',
      consecutive,
      lastFailureAt,
      reason: degraded
        ? `${consecutive} consecutive failures (${kinds.timeout} timeout, ${kinds.error} error, ${kinds.lost} lost), last ${formatAge(nowMs - /** @type {number} */ (lastFailureMs))} ago`
        : null,
    });
  }
  return health;
}

module.exports = { WINDOW_MS, THRESHOLD, COOLDOWN_MS, pathHealth, classifyOutcome };

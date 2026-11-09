'use strict';

/**
 * Capacity: quota snapshot -> per-path state with freshness.
 *
 * Missing or stale data is UNKNOWN, never available. The retired picker helper
 * failed open on missing data, which made the first entry of its ladder always
 * win; routing must not repeat that. Window headroom semantics are otherwise
 * kept: a window past its reset time counts as 100% headroom, and a path is
 * usable when ANY window has room (failover between sub-accounts).
 */

const DEFAULT_MAX_AGE_MS = 6 * 3600 * 1000;
const DEFAULT_THRESHOLD = 85;

/**
 * @typedef {object} CapacityEntry
 * @property {string} path
 * @property {'available'|'saturated'|'unknown'} state
 * @property {number|null} headroomPct
 * @property {string|null} resetsAt Soonest future reset among the path's windows.
 * @property {string|null} observedAt
 * @property {boolean} stale
 * @property {string|null} reason
 */

/**
 * @param {unknown} value
 * @returns {number|null}
 */
function toMs(value) {
  const ms = Date.parse(/** @type {string} */ (value));
  return Number.isFinite(ms) ? ms : null;
}

/**
 * @param {Record<string, any>|null|undefined} quota
 * @param {{ now?: number, maxAgeMs?: number, threshold?: number }} [options]
 * @returns {Map<string, CapacityEntry>}
 */
function readCapacity(quota, { now = Date.now(), maxAgeMs = DEFAULT_MAX_AGE_MS, threshold = DEFAULT_THRESHOLD } = {}) {
  /** @type {Map<string, CapacityEntry>} */
  const map = new Map();
  const paths = (quota && quota.paths) || {};
  const snapshotMs = toMs(quota && quota.generatedAt);

  for (const [pathId, entry] of Object.entries(paths)) {
    const windows = Array.isArray(entry && entry.windows)
      ? entry.windows.filter((w) => w && typeof w === 'object')
      : [];
    const observedMs = toMs(entry && entry.updatedAt) ?? snapshotMs;
    const observedAt = observedMs === null ? null : new Date(observedMs).toISOString();

    /** @type {number|null} */
    let headroomPct = null;
    let recentResetSinceObservation = false;
    let oldResetSinceObservation = false;
    /** @type {number|null} */
    let soonestResetMs = null;

    for (const window of windows) {
      const resetMs = toMs(window.resetsAt);
      if (resetMs !== null && resetMs <= now) {
        // Already reset: fresh headroom regardless of the last observation.
        headroomPct = headroomPct === null ? 100 : Math.max(headroomPct, 100);
        // A reset only vouches for a stale observation while it is recent:
        // usage since a long-past reset was never observed.
        if (observedMs === null || resetMs > observedMs) {
          if (now - resetMs <= maxAgeMs) recentResetSinceObservation = true;
          else oldResetSinceObservation = true;
        }
        continue;
      }
      if (resetMs !== null && (soonestResetMs === null || resetMs < soonestResetMs)) {
        soonestResetMs = resetMs;
      }
      const used = typeof window.usedPercent === 'number' && Number.isFinite(window.usedPercent) ? window.usedPercent : 0;
      const headroom = 100 - used;
      headroomPct = headroomPct === null ? headroom : Math.max(headroomPct, headroom);
    }

    // No windows at all: the path reports no usage, so treat it as full
    // headroom. Staleness is still applied below.
    if (headroomPct === null) headroomPct = 100;

    const stale = observedMs === null || now - observedMs > maxAgeMs;
    /** @type {CapacityEntry['state']} */
    let state;
    /** @type {string|null} */
    let reason;
    if (stale) {
      if (recentResetSinceObservation) {
        state = 'available';
        reason = 'window reset since observation';
      } else if (oldResetSinceObservation) {
        state = 'unknown';
        reason = 'quota data stale; window reset long ago, usage since unobserved';
      } else {
        state = 'unknown';
        reason = observedMs === null ? 'no observation time' : 'quota data stale';
      }
    } else if (headroomPct > 100 - threshold) {
      state = 'available';
      reason = null;
    } else {
      state = 'saturated';
      reason = 'headroom below threshold';
    }

    map.set(pathId, {
      path: pathId,
      state,
      headroomPct,
      resetsAt: soonestResetMs === null ? null : new Date(soonestResetMs).toISOString(),
      observedAt,
      stale,
      reason,
    });
  }

  return map;
}

/**
 * Look up one path. An absent path is UNKNOWN, never available.
 *
 * @param {Map<string, CapacityEntry>|Record<string, CapacityEntry>|null|undefined} capacity
 * @param {string} pathId
 * @returns {CapacityEntry}
 */
function capacityFor(capacity, pathId) {
  let entry = null;
  if (capacity instanceof Map) entry = capacity.get(pathId) ?? null;
  else if (capacity && Object.hasOwn(capacity, pathId)) entry = capacity[pathId];
  if (entry) return entry;
  return {
    path: pathId,
    state: 'unknown',
    headroomPct: null,
    resetsAt: null,
    observedAt: null,
    stale: true,
    reason: 'no quota data',
  };
}

module.exports = { DEFAULT_MAX_AGE_MS, DEFAULT_THRESHOLD, readCapacity, capacityFor };

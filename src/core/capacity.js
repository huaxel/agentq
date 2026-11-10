'use strict';

/**
 * Capacity: quota snapshot -> per-path state with freshness.
 *
 * Missing or stale data is UNKNOWN, never available. The retired picker helper
 * failed open on missing data, which made the first entry of its ladder always
 * win; routing must not repeat that. Window headroom semantics are otherwise
 * kept: a window past its reset time counts as 100% headroom.
 *
 * Windows bind together by default (`quotaWindows: "all"`): a path's headroom
 * is the smallest headroom over its live windows, because most providers
 * enforce every window at once — an exhausted weekly limit blocks a path whose
 * 5-hour window still has room. `quotaWindows: "any"` restores the failover
 * reading (the largest headroom) for separate sub-accounts or model groups.
 */

const DEFAULT_MAX_AGE_MS = 6 * 3600 * 1000;
const DEFAULT_THRESHOLD = 85;

const MINUTE_MS = 60 * 1000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;

/** How a path's windows combine. `all` binds every window; `any` fails over. */
const WINDOW_COMBINE_DEFAULT = 'all';

/**
 * @typedef {object} QuotaPace
 * @property {string|null} window Label of the window that binds the path.
 * @property {number} usedPct
 * @property {number} elapsedPct
 * @property {number} projectedPct Linear extrapolation to the reset.
 * @property {'behind'|'on'|'ahead'} state
 */

/**
 * @typedef {object} CapacityEntry
 * @property {string} path
 * @property {'available'|'saturated'|'unknown'} state
 * @property {number|null} headroomPct
 * @property {string|null} resetsAt Soonest future reset among the path's windows.
 * @property {string|null} observedAt
 * @property {boolean} stale
 * @property {string|null} reason
 * @property {QuotaPace|null} pace Binding window's pace; null when nothing projects.
 * @property {number|null} quotaPressure Clamped projectedPct / 100; null with pace.
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
 * A window's label, lower-cased, with any parenthetical qualifier removed:
 * `5-hour (gosingle)` is a 5-hour window.
 *
 * @param {Record<string, any>} window
 * @returns {string}
 */
function windowLabel(window) {
  const raw = typeof window.label === 'string' ? window.label : '';
  return raw.replace(/\([^)]*\)/g, ' ').trim().toLowerCase();
}

/**
 * The calendar month ending at `resetsAt`, in UTC: the reset minus one month.
 *
 * @param {unknown} resetsAt
 * @returns {number|null}
 */
function monthDurationMs(resetsAt) {
  const resetMs = toMs(resetsAt);
  if (resetMs === null) return null;
  const start = new Date(resetMs);
  start.setUTCMonth(start.getUTCMonth() - 1);
  const durationMs = resetMs - start.getTime();
  return durationMs > 0 ? durationMs : null;
}

/**
 * A duration from a duration-ish string (`5h`, `5-hour`, `daily`, `weekly`,
 * `monthly`, `<n>m|h|d`), case-insensitive and with a parenthetical qualifier
 * ignored. `requests`, `concurrency` or `total` describe no duration.
 *
 * @param {string} label
 * @param {unknown} resetsAt used to size a calendar month.
 * @returns {number|null}
 */
function durationFromLabel(label, resetsAt) {
  if (!label) return null;
  if (label === 'daily' || label === 'day') return DAY_MS;
  if (label === 'weekly' || label === 'week') return 7 * DAY_MS;
  if (label === 'monthly' || label === 'month') return monthDurationMs(resetsAt);

  const match = /^(\d+)\s*-?\s*(m|min|mins|minute|minutes|h|hr|hrs|hour|hours|d|day|days)$/.exec(label);
  if (!match) return null;
  const count = Number(match[1]);
  if (!Number.isFinite(count) || count <= 0) return null;
  const unit = match[2];
  if (unit.startsWith('m')) return count * MINUTE_MS;
  if (unit.startsWith('h')) return count * HOUR_MS;
  return count * DAY_MS;
}

/**
 * How long a quota window lasts, in ms, or null when the window does not say.
 *
 * Precedence: `windowMinutes` when it is a positive number, then `period` (a
 * provider-declared duration such as `monthly`, which survives a label that
 * names no length — Mistral's `Month`/`Vibe` budget windows), then the label.
 *
 * @param {Record<string, any>|null|undefined} window
 * @returns {number|null}
 */
function windowDurationMs(window) {
  if (!window || typeof window !== 'object') return null;
  const minutes = window.windowMinutes;
  if (typeof minutes === 'number' && Number.isFinite(minutes) && minutes > 0) return minutes * MINUTE_MS;

  const period = typeof window.period === 'string' ? window.period.trim().toLowerCase() : '';
  const fromPeriod = durationFromLabel(period, window.resetsAt);
  if (fromPeriod !== null) return fromPeriod;

  return durationFromLabel(windowLabel(window), window.resetsAt);
}

/**
 * Pace state from the projected usage at the reset.
 *
 * @param {number} projectedPct
 * @returns {'behind'|'on'|'ahead'}
 */
function paceState(projectedPct) {
  if (projectedPct < 80) return 'behind';
  if (projectedPct > 110) return 'ahead';
  return 'on';
}

/**
 * Pace for one window, or null when it cannot be projected: no duration, no
 * reset, or too early in the window (< 5% elapsed) to extrapolate.
 *
 * @param {Record<string, any>} window
 * @param {number} usedPct
 * @param {number} resetMs
 * @param {number} now
 * @returns {QuotaPace|null}
 */
function windowPace(window, usedPct, resetMs, now) {
  const durationMs = windowDurationMs(window);
  if (durationMs === null) return null;
  const elapsedRaw = ((now - (resetMs - durationMs)) / durationMs) * 100;
  const elapsedPct = Math.min(100, Math.max(0, elapsedRaw));
  if (elapsedPct < 5) return null;
  const projectedPct = usedPct / (elapsedPct / 100);
  if (!Number.isFinite(projectedPct)) return null;
  return {
    window: typeof window.label === 'string' ? window.label : null,
    usedPct,
    elapsedPct,
    projectedPct,
    state: paceState(projectedPct),
  };
}

/**
 * A path's window-combine mode. Paths absent from the map use `all`.
 *
 * @param {Map<string, string>|Record<string, string>|null|undefined} windowCombine
 * @param {string} pathId
 * @returns {'all'|'any'}
 */
function combineMode(windowCombine, pathId) {
  if (!windowCombine) return WINDOW_COMBINE_DEFAULT;
  const value = windowCombine instanceof Map
    ? windowCombine.get(pathId)
    : (Object.hasOwn(windowCombine, pathId) ? windowCombine[pathId] : undefined);
  return value === 'any' ? 'any' : WINDOW_COMBINE_DEFAULT;
}

/** A headroom percentage for the reason text: at most one decimal. */
function formatPct(value) {
  return String(Math.round(value * 10) / 10);
}

/**
 * @param {Record<string, any>|null|undefined} quota
 * @param {{ now?: number, maxAgeMs?: number, threshold?: number, windowCombine?: Map<string, string>|Record<string, string> }} [options]
 *   `windowCombine` maps a path id to `'all'` (every window binds, the default)
 *   or `'any'` (failover, the largest headroom wins).
 * @returns {Map<string, CapacityEntry>}
 */
function readCapacity(
  quota,
  { now = Date.now(), maxAgeMs = DEFAULT_MAX_AGE_MS, threshold = DEFAULT_THRESHOLD, windowCombine } = {},
) {
  /** @type {Map<string, CapacityEntry>} */
  const map = new Map();
  const paths = (quota && quota.paths) || {};
  const snapshotMs = toMs(quota && quota.generatedAt);

  for (const [pathId, entry] of Object.entries(paths)) {
    const combineAny = combineMode(windowCombine, pathId) === 'any';
    const windows = Array.isArray(entry && entry.windows)
      ? entry.windows.filter((w) => w && typeof w === 'object')
      : [];
    const observedMs = toMs(entry && entry.updatedAt) ?? snapshotMs;
    const observedAt = observedMs === null ? null : new Date(observedMs).toISOString();

    /** @type {number|null} */
    let headroomPct = null;
    /** @type {string|null} Label of the window that sets the `all` minimum. */
    let bindingWindow = null;
    let recentResetSinceObservation = false;
    let oldResetSinceObservation = false;
    /** @type {number|null} */
    let soonestResetMs = null;
    /** @type {QuotaPace|null} */
    let pace = null;
    /** @type {number|null} */
    let paceResetMs = null;

    /**
     * Fold one window's headroom into the path's. Under `any` the largest wins
     * (failover); under `all` the smallest wins, and the window that sets it is
     * remembered so a saturated reason can name it. A reset window contributes
     * 100, which never lowers an `all` minimum.
     *
     * @param {number} headroom
     * @param {string|null} label
     */
    const fold = (headroom, label) => {
      if (combineAny) {
        headroomPct = headroomPct === null ? headroom : Math.max(headroomPct, headroom);
      } else if (headroomPct === null || headroom < headroomPct) {
        headroomPct = headroom;
        bindingWindow = label;
      }
    };

    for (const window of windows) {
      const resetMs = toMs(window.resetsAt);
      if (resetMs !== null && resetMs <= now) {
        // Already reset: fresh headroom regardless of the last observation.
        fold(100, null);
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
      fold(100 - used, typeof window.label === 'string' && window.label.trim() ? window.label : null);

      // Pace binds to the window with the highest projection: that is the one
      // whose quota is most likely to run out (or go unused) first. A tie goes
      // to the earlier reset, so the answer is deterministic.
      if (resetMs !== null) {
        const candidate = windowPace(window, used, resetMs, now);
        if (candidate !== null
          && (pace === null
            || candidate.projectedPct > pace.projectedPct
            || (candidate.projectedPct === pace.projectedPct && paceResetMs !== null && resetMs < paceResetMs))) {
          pace = candidate;
          paceResetMs = resetMs;
        }
      }
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
      // Only the reason text changes: under `all` the binding window explains
      // which limit is holding the path down.
      reason = !combineAny && bindingWindow !== null
        ? `headroom below threshold (${bindingWindow}: ${formatPct(headroomPct)}% left)`
        : 'headroom below threshold';
    }

    map.set(pathId, {
      path: pathId,
      state,
      headroomPct,
      resetsAt: soonestResetMs === null ? null : new Date(soonestResetMs).toISOString(),
      observedAt,
      stale,
      reason,
      pace,
      quotaPressure: pace === null ? null : Math.min(4, Math.max(0.25, pace.projectedPct / 100)),
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
    pace: null,
    quotaPressure: null,
  };
}

module.exports = {
  DEFAULT_MAX_AGE_MS,
  DEFAULT_THRESHOLD,
  windowDurationMs,
  readCapacity,
  capacityFor,
};

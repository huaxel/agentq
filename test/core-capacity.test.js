'use strict';
/**
 * Capacity tests. The invariant under test: absence of data is UNKNOWN, never
 * available — the fail-open behaviour of lib/model-picker.js is exactly what
 * routing has to stop doing.
 */
const assert = require('node:assert/strict');
const test = require('node:test');

const { capacityFor, readCapacity, windowDurationMs } = require('../src/core/capacity.js');

const MINUTE = 60 * 1000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

const NOW = Date.parse('2026-11-08T12:00:00Z');
const FRESH = new Date(NOW - 60_000).toISOString();
const FUTURE = new Date(NOW + 3600_000).toISOString();
const LONG_AGO = new Date(NOW - 7 * 3600_000).toISOString();

function snapshot(paths, generatedAt = FRESH) {
  return { generatedAt, paths };
}

test('a fresh window reports headroom, reset time, and observation time', () => {
  const capacity = readCapacity(
    snapshot({ codex: { updatedAt: FRESH, windows: [{ label: 'weekly', usedPercent: 20, resetsAt: FUTURE }] } }),
    { now: NOW },
  );
  const entry = capacity.get('codex');
  assert.deepEqual(
    {
      path: entry.path,
      state: entry.state,
      headroomPct: entry.headroomPct,
      resetsAt: entry.resetsAt,
      observedAt: entry.observedAt,
      stale: entry.stale,
      reason: entry.reason,
    },
    {
      path: 'codex',
      state: 'available',
      headroomPct: 80,
      resetsAt: FUTURE,
      observedAt: FRESH,
      stale: false,
      reason: null,
    },
  );
  // 1h into a 7d window: nearly the whole window has elapsed, so 20% used
  // projects to about 20% at the reset — behind pace, pressure clamped low.
  assert.equal(entry.pace.window, 'weekly');
  assert.equal(entry.pace.usedPct, 20);
  assert.ok(entry.pace.elapsedPct > 99 && entry.pace.elapsedPct <= 100);
  assert.equal(entry.pace.state, 'behind');
  assert.equal(entry.quotaPressure, 0.25);
});

test('path headroom is the best window, so one full window does not saturate', () => {
  const capacity = readCapacity(
    snapshot({
      go: {
        updatedAt: FRESH,
        windows: [
          { label: 'monthly (sub-1)', usedPercent: 100, resetsAt: FUTURE },
          { label: '5-hour (sub-2)', usedPercent: 0, resetsAt: FUTURE },
        ],
      },
    }),
    { now: NOW },
  );
  assert.equal(capacity.get('go').headroomPct, 100);
  assert.equal(capacity.get('go').state, 'available');
});

test('a fully used path is saturated', () => {
  const capacity = readCapacity(
    snapshot({ cursor: { updatedAt: FRESH, windows: [{ label: 'total', usedPercent: 100, resetsAt: FUTURE }] } }),
    { now: NOW },
  );
  assert.equal(capacity.get('cursor').state, 'saturated');
  assert.equal(capacity.get('cursor').headroomPct, 0);
  assert.equal(capacity.get('cursor').reason, 'headroom below threshold');
});

test('the threshold keeps usedPercent below it for a path to count as available', () => {
  const at = (usedPercent) =>
    readCapacity(
      snapshot({ codex: { updatedAt: FRESH, windows: [{ usedPercent, resetsAt: FUTURE }] } }),
      { now: NOW, threshold: 85 },
    ).get('codex');
  assert.equal(at(85).state, 'saturated');
  assert.equal(at(85).headroomPct, 15);
  assert.equal(at(84).state, 'available');
  assert.equal(at(84).headroomPct, 16);
});

test('stale observations are unknown, not available', () => {
  const capacity = readCapacity(
    snapshot({ umans: { updatedAt: LONG_AGO, windows: [{ label: 'requests', usedPercent: 12.5 }] } }),
    { now: NOW },
  );
  const entry = capacity.get('umans');
  assert.equal(entry.state, 'unknown');
  assert.equal(entry.stale, true);
  assert.equal(entry.reason, 'quota data stale');
  assert.equal(entry.headroomPct, 87.5);
});

test('a stale observation is overridden by a window that already reset', () => {
  const capacity = readCapacity(
    snapshot({
      antigravity: {
        updatedAt: LONG_AGO,
        windows: [{ label: 'weekly', usedPercent: 100, resetsAt: new Date(NOW - 1000).toISOString() }],
      },
    }),
    { now: NOW },
  );
  const entry = capacity.get('antigravity');
  assert.equal(entry.state, 'available');
  assert.equal(entry.stale, true);
  assert.equal(entry.reason, 'window reset since observation');
  assert.equal(entry.headroomPct, 100);
});

test('a reset older than the staleness limit does not rescue a stale observation', () => {
  const DAY = 24 * 3600 * 1000;
  const capacity = readCapacity(
    snapshot({
      cursor: {
        updatedAt: new Date(NOW - 100 * DAY).toISOString(),
        windows: [{ label: 'total', usedPercent: 40, resetsAt: new Date(NOW - 75 * DAY).toISOString() }],
      },
    }),
    { now: NOW },
  );
  const entry = capacity.get('cursor');
  assert.equal(entry.state, 'unknown');
  assert.equal(entry.stale, true);
  assert.match(entry.reason, /reset long ago/);
});

test('a reset before the stale observation does not rescue it', () => {
  const capacity = readCapacity(
    snapshot({
      codex: {
        updatedAt: new Date(NOW - 7 * 3600 * 1000).toISOString(),
        windows: [{ usedPercent: 95, resetsAt: new Date(NOW - 8 * 3600 * 1000).toISOString() }],
      },
    }),
    { now: NOW },
  );
  assert.equal(capacity.get('codex').state, 'unknown');
});

test('missing observation time is unknown', () => {
  const capacity = readCapacity({ paths: { local: { windows: [{ usedPercent: 0 }] } } }, { now: NOW });
  const entry = capacity.get('local');
  assert.equal(entry.state, 'unknown');
  assert.equal(entry.stale, true);
  assert.equal(entry.reason, 'no observation time');
  assert.equal(entry.observedAt, null);
});

test('observedAt falls back to the snapshot generatedAt', () => {
  const capacity = readCapacity(snapshot({ codex: { windows: [{ usedPercent: 5, resetsAt: FUTURE }] } }), { now: NOW });
  assert.equal(capacity.get('codex').observedAt, FRESH);
  assert.equal(capacity.get('codex').stale, false);
});

test('resetsAt is the soonest future reset, ignoring past resets', () => {
  const soon = new Date(NOW + 60_000).toISOString();
  const later = new Date(NOW + 7200_000).toISOString();
  const capacity = readCapacity(
    snapshot({
      codex: {
        updatedAt: FRESH,
        windows: [
          { usedPercent: 10, resetsAt: new Date(NOW - 5000).toISOString() },
          { usedPercent: 40, resetsAt: later },
          { usedPercent: 30, resetsAt: soon },
        ],
      },
    }),
    { now: NOW },
  );
  assert.equal(capacity.get('codex').resetsAt, soon);
});

test('a path with no windows counts as full headroom but still needs a fresh observation', () => {
  const fresh = readCapacity(snapshot({ clinepass: { updatedAt: FRESH, windows: [] } }), { now: NOW }).get('clinepass');
  assert.equal(fresh.state, 'available');
  assert.equal(fresh.headroomPct, 100);
  assert.equal(fresh.resetsAt, null);
  const stale = readCapacity(snapshot({ clinepass: { updatedAt: LONG_AGO, windows: [] } }), { now: NOW }).get('clinepass');
  assert.equal(stale.state, 'unknown');
});

test('a missing path is unknown with no quota data', () => {
  const capacity = readCapacity(snapshot({ codex: { updatedAt: FRESH, windows: [{ usedPercent: 1 }] } }), { now: NOW });
  const entry = capacityFor(capacity, 'clinepass');
  assert.deepEqual(entry, {
    path: 'clinepass',
    state: 'unknown',
    headroomPct: null,
    resetsAt: null,
    observedAt: null,
    stale: true,
    reason: 'no quota data',
    pace: null,
    quotaPressure: null,
  });
  assert.equal(capacityFor(null, 'local').state, 'unknown');
});

/* ───── quota pace ───── */

/** A window at `elapsedPct` through `durationMs`, resetting in the remainder. */
function windowAt(label, durationMs, elapsedPct, usedPercent, extra = {}) {
  const remaining = durationMs * (1 - elapsedPct / 100);
  return {
    label,
    usedPercent,
    resetsAt: new Date(NOW + remaining).toISOString(),
    ...extra,
  };
}

function paceOf(windows) {
  return readCapacity(snapshot({ codex: { updatedAt: FRESH, windows } }), { now: NOW }).get('codex');
}

test('window duration parses every label form', () => {
  const cases = [
    [{ label: '5h' }, 5 * HOUR],
    [{ label: '5-hour' }, 5 * HOUR],
    [{ label: '5-hour (gosingle)' }, 5 * HOUR],
    [{ label: '30m' }, 30 * MINUTE],
    [{ label: '10d' }, 10 * DAY],
    [{ label: 'daily' }, DAY],
    [{ label: 'day' }, DAY],
    [{ label: '24h' }, DAY],
    [{ label: 'weekly' }, 7 * DAY],
    [{ label: 'week' }, 7 * DAY],
    [{ label: '7d' }, 7 * DAY],
    [{ label: 'WEEKLY' }, 7 * DAY],
  ];
  for (const [window, expected] of cases) {
    assert.equal(windowDurationMs(window), expected, `label ${window.label}`);
  }
});

test('a month is the calendar month before its reset, in UTC', () => {
  const marchFirst = { label: 'monthly', resetsAt: '2026-03-01T00:00:00Z' };
  assert.equal(windowDurationMs(marchFirst), 28 * DAY, 'February 2026 has 28 days');
  assert.equal(
    windowDurationMs({ label: 'month', resetsAt: '2026-03-01T00:00:00Z' }),
    28 * DAY,
  );
});

test('windowMinutes wins over the label, and a parenthetical is ignored', () => {
  assert.equal(windowDurationMs({ label: 'weekly', windowMinutes: 60 }), HOUR);
  assert.equal(windowDurationMs({ label: '5-hour (gosingle)' }), 5 * HOUR);
  assert.equal(windowDurationMs({ label: 'total', windowMinutes: 90 }), 90 * MINUTE);
});

test('a label that describes no duration gives none', () => {
  for (const label of ['requests', 'concurrency', 'total', '', undefined]) {
    assert.equal(windowDurationMs({ label }), null, `label ${String(label)}`);
  }
  assert.equal(windowDurationMs(null), null);
});

test('a projection needs at least 5% of the window elapsed', () => {
  const early = paceOf([windowAt('5h', 5 * HOUR, 4, 1)]);
  assert.equal(early.pace, null);
  assert.equal(early.quotaPressure, null);

  const atThreshold = paceOf([windowAt('5h', 5 * HOUR, 5, 1)]);
  assert.ok(atThreshold.pace !== null);
  assert.equal(atThreshold.pace.elapsedPct, 5);
  assert.equal(atThreshold.pace.projectedPct, 20);
});

test('pace state is behind below 80, on at 80 and 110, ahead above 110', () => {
  const at = (usedPercent) => paceOf([windowAt('5h', 5 * HOUR, 50, usedPercent)]).pace;
  assert.equal(at(39.9).state, 'behind');
  assert.equal(at(39.9).projectedPct, 79.8);
  assert.equal(at(40).projectedPct, 80);
  assert.equal(at(40).state, 'on');
  assert.equal(at(55).projectedPct, 110);
  assert.equal(at(55).state, 'on');
  assert.equal(at(55.1).state, 'ahead');
});

test('the binding window is the highest projection, not the earliest reset', () => {
  const entry = paceOf([
    windowAt('5h', 5 * HOUR, 50, 15), // projected 30
    windowAt('weekly', 7 * DAY, 50, 60), // projected 120, later reset
  ]);
  assert.equal(entry.pace.window, 'weekly');
  assert.equal(entry.pace.projectedPct, 120);
  assert.equal(entry.pace.state, 'ahead');
  assert.equal(entry.quotaPressure, 1.2);
});

test('a projection tie goes to the earlier reset', () => {
  const entry = paceOf([
    windowAt('weekly', 7 * DAY, 50, 30), // projected 60, later reset
    windowAt('5h', 5 * HOUR, 50, 30), // projected 60, earlier reset
  ]);
  assert.equal(entry.pace.window, '5h');
});

test('a window that already reset contributes no pace', () => {
  const reset = { label: 'weekly', usedPercent: 0, resetsAt: new Date(NOW - HOUR).toISOString() };
  const onlyReset = paceOf([reset]);
  assert.equal(onlyReset.pace, null);
  assert.equal(onlyReset.quotaPressure, null);

  const future = windowAt('5h', 5 * HOUR, 50, 20);
  const mixed = paceOf([reset, future]);
  assert.equal(mixed.pace.window, '5h');
  assert.equal(mixed.pace.projectedPct, 40);
});

test('quotaPressure is clamped to [0.25, 4]', () => {
  assert.equal(paceOf([windowAt('5h', 5 * HOUR, 50, 5)]).quotaPressure, 0.25);
  assert.equal(paceOf([windowAt('5h', 5 * HOUR, 50, 250)]).quotaPressure, 4);
});

test('property: elapsedPct stays in [0, 100] and pressure in [0.25, 4] or null', () => {
  const durations = [5 * HOUR, DAY, 7 * DAY, 30 * DAY];
  const labels = ['5h', 'daily', 'weekly', '30d'];
  for (let i = 0; i < durations.length; i += 1) {
    for (const elapsedPct of [0, 1, 4.9, 5, 25, 50, 99.9, 100]) {
      for (const usedPercent of [0, 1, 50, 100, 250]) {
        const entry = paceOf([windowAt(labels[i], durations[i], elapsedPct, usedPercent)]);
        if (entry.pace === null) {
          assert.equal(entry.quotaPressure, null);
          continue;
        }
        assert.ok(entry.pace.elapsedPct >= 0 && entry.pace.elapsedPct <= 100);
        assert.ok(entry.quotaPressure >= 0.25 && entry.quotaPressure <= 4);
      }
    }
  }
});

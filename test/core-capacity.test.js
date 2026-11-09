'use strict';
/**
 * Capacity tests. The invariant under test: absence of data is UNKNOWN, never
 * available — the fail-open behaviour of lib/model-picker.js is exactly what
 * routing has to stop doing.
 */
const assert = require('node:assert/strict');
const test = require('node:test');

const { capacityFor, readCapacity } = require('../src/core/capacity.js');

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
  assert.deepEqual(entry, {
    path: 'codex',
    state: 'available',
    headroomPct: 80,
    resetsAt: FUTURE,
    observedAt: FRESH,
    stale: false,
    reason: null,
  });
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
  });
  assert.equal(capacityFor(null, 'local').state, 'unknown');
});

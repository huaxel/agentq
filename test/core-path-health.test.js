'use strict';
/**
 * Path health: fold a window of per-path attempt outcomes into a per-path
 * degraded/healthy verdict. Pure — injected clock, no I/O.
 */
const assert = require('node:assert/strict');
const test = require('node:test');

const { WINDOW_MS, THRESHOLD, COOLDOWN_MS, pathHealth } = require('../src/core/path-health.js');

const NOW = Date.parse('2026-11-09T12:00:00Z');
const iso = (ms) => new Date(ms).toISOString();
const MIN = 60 * 1000;

function row(path, outcome, ageMs) {
  return { path, outcome, created_at: iso(NOW - ageMs) };
}

test('three consecutive timeouts degrade the path', () => {
  const health = pathHealth(
    [row('mistral', 'timeout', 20 * MIN), row('mistral', 'timeout', 10 * MIN), row('mistral', 'timeout', 5 * MIN)],
    { now: NOW },
  );
  const entry = health.get('mistral');
  assert.equal(entry.state, 'degraded');
  assert.equal(entry.consecutive, 3);
  assert.equal(entry.lastFailureAt, iso(NOW - 5 * MIN));
  assert.match(entry.reason, /3 consecutive failures \(3 timeout, 0 error, 0 lost\), last 5m ago/);
});

test('two failures stay healthy under the default threshold of three', () => {
  const health = pathHealth(
    [row('mistral', 'timeout', 10 * MIN), row('mistral', 'error', 5 * MIN)],
    { now: NOW },
  );
  assert.equal(health.get('mistral').state, 'healthy');
  assert.equal(health.get('mistral').consecutive, 2);
  assert.equal(health.get('mistral').reason, null);
});

test('mixed timeouts and errors count together', () => {
  const health = pathHealth(
    [row('p', 'error', 9 * MIN), row('p', 'timeout', 4 * MIN), row('p', 'error', 2 * MIN)],
    { now: NOW },
  );
  assert.equal(health.get('p').state, 'degraded');
});

test('an ok after the failures resets the path', () => {
  const health = pathHealth(
    [
      row('p', 'timeout', 30 * MIN),
      row('p', 'timeout', 20 * MIN),
      row('p', 'timeout', 10 * MIN),
      row('p', 'ok', 5 * MIN),
    ],
    { now: NOW },
  );
  const entry = health.get('p');
  assert.equal(entry.state, 'healthy');
  assert.equal(entry.consecutive, 0);
});

test('the reason counts only the failures since the last ok', () => {
  // timeout, ok, timeout, timeout, timeout: the pre-ok timeout must not be
  // counted, or the text contradicts the "3 consecutive" prefix.
  const health = pathHealth(
    [
      row('p', 'timeout', 40 * MIN),
      row('p', 'ok', 30 * MIN),
      row('p', 'timeout', 20 * MIN),
      row('p', 'timeout', 10 * MIN),
      row('p', 'timeout', 5 * MIN),
    ],
    { now: NOW },
  );
  const entry = health.get('p');
  assert.equal(entry.state, 'degraded');
  assert.equal(entry.consecutive, 3);
  assert.equal(entry.reason, '3 consecutive failures (3 timeout, 0 error, 0 lost), last 5m ago');
});

test('the kind counts reset with the streak for mixed kinds too', () => {
  const health = pathHealth(
    [
      row('p', 'error', 50 * MIN),
      row('p', 'lost', 40 * MIN),
      row('p', 'ok', 30 * MIN),
      row('p', 'timeout', 20 * MIN),
      row('p', 'error', 10 * MIN),
      row('p', 'lost', 5 * MIN),
    ],
    { now: NOW },
  );
  const entry = health.get('p');
  assert.equal(entry.state, 'degraded');
  assert.equal(entry.reason, '3 consecutive failures (1 timeout, 1 error, 1 lost), last 5m ago');
});

test('verify_failed rows are ignored and never reset a streak', () => {
  const health = pathHealth(
    [
      row('p', 'timeout', 30 * MIN),
      row('p', 'verify_failed', 20 * MIN),
      row('p', 'timeout', 10 * MIN),
      row('p', 'timeout', 5 * MIN),
    ],
    { now: NOW },
  );
  assert.equal(health.get('p').state, 'degraded');
  assert.equal(health.get('p').consecutive, 3);

  const trailing = pathHealth(
    [row('p', 'timeout', 30 * MIN), row('p', 'timeout', 20 * MIN), row('p', 'timeout', 10 * MIN), row('p', 'verify_failed', MIN)],
    { now: NOW },
  );
  assert.equal(trailing.get('p').state, 'degraded');
});

test('failures outside the window do not count', () => {
  const health = pathHealth(
    [
      row('p', 'timeout', WINDOW_MS + MIN),
      row('p', 'timeout', 10 * MIN),
      row('p', 'timeout', 5 * MIN),
    ],
    { now: NOW },
  );
  assert.equal(health.get('p').state, 'healthy');
  assert.equal(health.get('p').consecutive, 2);
});

test('a row exactly on the window edge still counts', () => {
  const health = pathHealth(
    [row('p', 'timeout', WINDOW_MS), row('p', 'timeout', 10 * MIN), row('p', 'timeout', 5 * MIN)],
    { now: NOW },
  );
  assert.equal(health.get('p').state, 'degraded');
});

test('a stale streak past cooldown is healthy again', () => {
  const health = pathHealth(
    [row('p', 'timeout', 50 * MIN), row('p', 'timeout', 45 * MIN), row('p', 'timeout', 40 * MIN)],
    { now: NOW },
  );
  const entry = health.get('p');
  assert.equal(entry.state, 'healthy');
  assert.equal(entry.consecutive, 3);
  assert.equal(entry.reason, null);
});

test('cooldown expiry is strict: exactly cooldown old is healthy again', () => {
  const rows = [row('p', 'timeout', COOLDOWN_MS + MIN), row('p', 'timeout', COOLDOWN_MS), row('p', 'timeout', COOLDOWN_MS)];
  const health = pathHealth(rows, { now: NOW });
  assert.equal(health.get('p').state, 'healthy');
});

test('paths are independent', () => {
  const health = pathHealth(
    [
      row('bad', 'timeout', 20 * MIN),
      row('bad', 'timeout', 10 * MIN),
      row('bad', 'timeout', 5 * MIN),
      row('good', 'timeout', 10 * MIN),
      row('good', 'ok', 5 * MIN),
    ],
    { now: NOW },
  );
  assert.equal(health.get('bad').state, 'degraded');
  assert.equal(health.get('good').state, 'healthy');
  assert.equal(health.get('good').consecutive, 0);
});

test('unknown outcomes and unparseable timestamps are skipped', () => {
  const health = pathHealth(
    [
      { path: 'p', outcome: 'weird', created_at: iso(NOW - MIN) },
      { path: 'p', outcome: 'timeout', created_at: 'not-a-date' },
      row('p', 'ok', MIN),
    ],
    { now: NOW },
  );
  assert.equal(health.get('p').state, 'healthy');
  assert.equal(health.get('p').consecutive, 0);
  assert.equal(health.get('p').lastFailureAt, null);
});

test('custom threshold and window apply', () => {
  const rows = [row('p', 'timeout', 10 * MIN), row('p', 'timeout', 5 * MIN)];
  assert.equal(pathHealth(rows, { now: NOW, threshold: 2 }).get('p').state, 'degraded');
  assert.equal(pathHealth(rows, { now: NOW, window: MIN }).get('p'), undefined);
});

test('defaults are a 60-minute window, 3 failures, 30-minute cooldown', () => {
  assert.equal(WINDOW_MS, 60 * 60 * 1000);
  assert.equal(THRESHOLD, 3);
  assert.equal(COOLDOWN_MS, 30 * 60 * 1000);
});

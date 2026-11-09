'use strict';
/**
 * Routing with path health: a degraded path sorts after every healthy choice
 * but stays eligible. Without health the result is byte-identical to today.
 */
const assert = require('node:assert/strict');
const test = require('node:test');

const { rank } = require('../src/core/routing.js');

const SOON = '2026-11-08T13:00:00Z';

function entry(id, overrides = {}) {
  return {
    id,
    path: 'codex',
    harness: 'pi',
    modelKey: id,
    intelligence: 50,
    costPerMTok: 1,
    tier: 'Workhorse',
    speed: 50,
    scored: true,
    ...overrides,
  };
}

function cap(pathName, overrides = {}) {
  return {
    path: pathName,
    state: 'available',
    headroomPct: 60,
    resetsAt: null,
    observedAt: '2026-11-08T11:00:00Z',
    stale: false,
    reason: null,
    ...overrides,
  };
}

function degraded(pathName, consecutive = 3) {
  return new Map([[pathName, {
    state: 'degraded',
    consecutive,
    lastFailureAt: SOON,
    reason: `3 consecutive failures (3 timeout, 0 error, 0 lost), last 12m ago`,
  }]]);
}

function args() {
  return {
    catalog: [
      entry('cheap', { path: 'mistral', costPerMTok: 0.1 }),
      entry('strong', { path: 'codex', costPerMTok: 2 }),
    ],
    capacity: new Map([cap('mistral'), cap('codex')].map((e) => [e.path, e])),
    tier: 'medium',
  };
}

test('a degraded path sorts after a more expensive healthy choice', () => {
  const without = rank(args());
  assert.equal(without.choices[0].id, 'cheap');

  const withHealth = rank({ ...args(), pathHealth: degraded('mistral') });
  assert.equal(withHealth.choices[0].id, 'strong');
  assert.equal(withHealth.choices[1].id, 'cheap');
  assert.match(
    withHealth.choices[1].reasons.join(' '),
    /path degraded: 3 consecutive failures \(3 timeout, 0 error, 0 lost\), last 12m ago/,
  );
  // The healthy choice is unchanged: no new reason noise.
  assert.deepEqual(withHealth.choices[0].reasons, without.choices[1].reasons);
});

test('the existing cost order holds among healthy choices', () => {
  const withHealth = rank({
    catalog: [
      entry('a', { path: 'p1', costPerMTok: 5 }),
      entry('b', { path: 'p2', costPerMTok: 1 }),
    ],
    capacity: new Map([cap('p1'), cap('p2')].map((e) => [e.path, e])),
    tier: 'medium',
    pathHealth: new Map([['p1', { state: 'healthy', consecutive: 1, lastFailureAt: SOON, reason: null }]]),
  });
  assert.deepEqual(withHealth.choices.map((choice) => choice.id), ['b', 'a']);
});

test('an all-degraded catalog still returns a choice, with the reason', () => {
  const health = new Map([
    ['mistral', { state: 'degraded', consecutive: 3, lastFailureAt: SOON, reason: '3 consecutive failures (3 timeout, 0 error, 0 lost), last 12m ago' }],
    ['codex', { state: 'degraded', consecutive: 5, lastFailureAt: SOON, reason: '5 consecutive failures (5 timeout, 0 error, 0 lost), last 3m ago' }],
  ]);
  const result = rank({ ...args(), pathHealth: health });
  assert.equal(result.choices.length, 2);
  // Cheapest-first still applies among degraded choices.
  assert.equal(result.choices[0].id, 'cheap');
  for (const choice of result.choices) {
    assert.match(choice.reasons.join(' '), /path degraded: \d+ consecutive failures/);
  }
});

test('no pathHealth means an unchanged result', () => {
  const base = args();
  assert.deepEqual(rank(base), rank({ ...base, pathHealth: undefined }));
  assert.deepEqual(rank(base), rank({ ...base, pathHealth: null }));
  assert.deepEqual(rank(base), rank({ ...base, pathHealth: new Map() }));
  const withHealthy = rank({
    ...base,
    pathHealth: new Map([['mistral', { state: 'healthy', consecutive: 0, lastFailureAt: null, reason: null }]]),
  });
  assert.deepEqual(withHealthy, rank(base));
});

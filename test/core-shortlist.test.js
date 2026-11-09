'use strict';
/**
 * Shortlist tests: the roles that name the trade-offs, the dedup that keeps one
 * option per choice, and the invariants a caller relies on (a subset of the
 * ranked choices, unique ids, never more than `max`).
 *
 * Every fixture is synthetic: no clock, no files, no home directory.
 */
const assert = require('node:assert/strict');
const test = require('node:test');

const { ALTERNATIVE_ROLE, ROLE_ORDER, shortlist } = require('../src/core/shortlist.js');

const SOON = '2026-11-08T13:00:00Z';
const LATER = '2026-11-09T13:00:00Z';

/**
 * A ranked choice as src/core/routing.js emits it.
 * @param {string} id
 * @param {Record<string, any>} [overrides]
 */
function choice(id, overrides = {}) {
  return {
    id,
    path: 'codex',
    intelligence: 50,
    intelligenceSource: 'roi',
    aaIndex: null,
    calibration: null,
    costPerMTok: 1,
    costSource: 'roi',
    capacityState: 'available',
    headroomPct: 60,
    resetsAt: null,
    observedAt: '2026-11-08T11:00:00Z',
    subscriptionState: 'active',
    reasons: ['intelligence 50.0 >= floor 38'],
    ...overrides,
  };
}

/** @param {any[]} options */
function rolesById(options) {
  return Object.fromEntries(options.map((option) => [option.id, option.roles]));
}

test('one choice that earns every role is one option carrying all four', () => {
  const options = shortlist([choice('solo', { headroomPct: 55, resetsAt: SOON })]);
  assert.equal(options.length, 1);
  assert.deepEqual(options[0].roles, ['cheapest', 'smartest', 'expiring', 'best-value']);
});

test('four distinct winners give four options in role order', () => {
  const options = shortlist([
    // cheapest: the lowest price, and nothing else.
    choice('cheap', { costPerMTok: 1, intelligence: 40 }),
    // smartest: the highest intelligence.
    choice('smart', { costPerMTok: 5, intelligence: 90 }),
    // expiring: the only path with a reset time.
    choice('soon', { costPerMTok: 3, intelligence: 50, headroomPct: 25, resetsAt: SOON }),
    // best-value: the best intelligence per dollar among what is left.
    choice('value', { costPerMTok: 2, intelligence: 60 }),
  ]);
  assert.deepEqual(options.map((option) => option.id), ['cheap', 'smart', 'soon', 'value']);
  assert.deepEqual(options.map((option) => option.roles), [
    ['cheapest'],
    ['smartest'],
    ['expiring'],
    ['best-value'],
  ]);
});

test('two choices give at most two options, never padding past the choices', () => {
  const options = shortlist([
    choice('a', { costPerMTok: 1, intelligence: 40 }),
    choice('b', { costPerMTok: 2, intelligence: 60, headroomPct: 80, resetsAt: SOON }),
  ]);
  assert.equal(options.length, 2);
  assert.deepEqual(options.map((option) => option.id), ['a', 'b']);
});

test('max caps the options and the rest stay out', () => {
  const ranked = ['a', 'b', 'c', 'd'].map((id, index) => choice(id, { costPerMTok: index + 1, intelligence: 40 + index }));
  assert.equal(shortlist(ranked, { max: 2 }).length, 2);
  assert.deepEqual(shortlist(ranked, { max: 0 }), []);
  assert.deepEqual(shortlist([]), []);
  assert.deepEqual(shortlist(null), []);
});

test('there is no expiring role without a reset time', () => {
  const options = shortlist([
    choice('a', { costPerMTok: 1, headroomPct: 90, resetsAt: null }),
    choice('b', { costPerMTok: 2, headroomPct: 90, resetsAt: undefined }),
  ]);
  assert.equal(rolesById(options).a.includes('expiring'), false);
  assert.ok(options.every((option) => !option.roles.includes('expiring')));
});

test('expiring needs at least 20% headroom', () => {
  const low = shortlist([choice('a', { headroomPct: 19, resetsAt: SOON, costPerMTok: 1 })]);
  assert.ok(!low[0].roles.includes('expiring'));

  const atThreshold = shortlist([choice('a', { headroomPct: 20, resetsAt: SOON, costPerMTok: 1 })]);
  assert.ok(atThreshold[0].roles.includes('expiring'));
});

test('the earliest reset wins the expiring role', () => {
  const options = shortlist([
    choice('later', { path: 'codex', costPerMTok: 1, intelligence: 40, headroomPct: 90, resetsAt: LATER }),
    choice('sooner', { path: 'mistral', costPerMTok: 2, intelligence: 60, headroomPct: 90, resetsAt: SOON }),
  ]);
  assert.deepEqual(rolesById(options).sooner, ['smartest', 'expiring']);
  assert.deepEqual(rolesById(options).later, ['cheapest', 'best-value']);
});

test('a distinct path breaks an expiring tie', () => {
  // Two paths reset at the same time; the one whose path is not already in the
  // shortlist takes the role, so the options do not collapse onto one path.
  const options = shortlist([
    choice('cheap', { path: 'codex', costPerMTok: 1, intelligence: 40, headroomPct: 90, resetsAt: LATER }),
    choice('smart', { path: 'mistral', costPerMTok: 2, intelligence: 60, headroomPct: 90, resetsAt: SOON }),
    choice('other', { path: 'xai', costPerMTok: 3, intelligence: 50, headroomPct: 90, resetsAt: SOON }),
  ]);
  assert.deepEqual(options.map((option) => option.id), ['cheap', 'smart', 'other']);
  assert.deepEqual(rolesById(options).smart, ['smartest'], 'same reset time, but its path is taken');
  assert.deepEqual(rolesById(options).other, ['expiring']);
  assert.deepEqual(rolesById(options).cheap, ['cheapest', 'best-value']);
});

test('the distinct-path tie-break also separates cheapest from smartest', () => {
  const options = shortlist([
    choice('a', { path: 'codex', costPerMTok: 1, intelligence: 50 }),
    choice('b', { path: 'mistral', costPerMTok: 1, intelligence: 50 }),
  ]);
  assert.deepEqual(rolesById(options).a, ['cheapest', 'best-value']);
  assert.deepEqual(rolesById(options).b, ['smartest']);
});

test('a real score beats an estimate when they tie', () => {
  const options = shortlist([
    choice('estimated', { path: 'codex', costPerMTok: 1, intelligence: 50, intelligenceSource: 'aa-estimate' }),
    choice('measured', { path: 'mistral', costPerMTok: 2, intelligence: 50, intelligenceSource: 'roi' }),
  ]);
  assert.deepEqual(rolesById(options).measured, ['smartest']);
  assert.ok(!rolesById(options).estimated.includes('smartest'));
});

test('a free local choice is best-value only when no paid choice exists', () => {
  const withPaid = shortlist([
    choice('local', { path: 'local', costPerMTok: 0, intelligence: 70 }),
    choice('paid', { path: 'codex', costPerMTok: 2, intelligence: 60 }),
  ]);
  // The local path is still the cheapest, but the paid one carries the value.
  assert.deepEqual(rolesById(withPaid).local, ['cheapest', 'smartest']);
  assert.deepEqual(rolesById(withPaid).paid, ['best-value']);

  const freeOnly = shortlist([choice('local', { path: 'local', costPerMTok: 0, intelligence: 70 })]);
  assert.deepEqual(rolesById(freeOnly).local, ['cheapest', 'smartest', 'best-value']);
});

test('a degraded choice keeps its degraded reason', () => {
  const reason = 'path degraded: 3 consecutive failures (2 timeout, 1 lost), last 12m ago';
  const options = shortlist([choice('degraded', { reasons: ['intelligence 50.0 >= floor 38', reason] })]);
  assert.deepEqual(options[0].reasons, ['intelligence 50.0 >= floor 38', reason]);
});

test('an option carries the RankedChoice fields a caller weighs', () => {
  const options = shortlist([
    choice('a', {
      intelligence: 53.95,
      intelligenceSource: 'aa-estimate',
      costPerMTok: 0.1234,
      costSource: 'aa-price',
      headroomPct: 42,
      resetsAt: SOON,
      capacityState: 'available',
    }),
  ]);
  assert.deepEqual(options[0], {
    id: 'a',
    path: 'codex',
    roles: ['cheapest', 'smartest', 'expiring', 'best-value'],
    intelligence: 53.95,
    intelligenceSource: 'aa-estimate',
    costPerMTok: 0.1234,
    costSource: 'aa-price',
    headroomPct: 42,
    resetsAt: SOON,
    capacityState: 'available',
    reasons: ['intelligence 50.0 >= floor 38'],
  });
});

test('unscored and unpriced choices still get an option, without inventing data', () => {
  const options = shortlist([choice('unscored', { intelligence: null, intelligenceSource: null, costPerMTok: null })]);
  assert.deepEqual(options[0].roles, ['cheapest']);
  assert.equal(options[0].intelligence, null);
  assert.equal(options[0].costPerMTok, null);
});

test('remaining slots are filled in rank order with role alternative', () => {
  const ranked = [
    choice('a', { path: 'codex', costPerMTok: 1, intelligence: 40 }),
    choice('b', { path: 'mistral', costPerMTok: 2, intelligence: 60 }),
    choice('c', { path: 'xai', costPerMTok: 3, intelligence: 40 }),
    choice('d', { path: 'google', costPerMTok: 4, intelligence: 40 }),
    choice('e', { path: 'local', costPerMTok: 5, intelligence: 40 }),
  ];
  const options = shortlist(ranked);
  assert.equal(options.length, 4);
  assert.deepEqual(options.map((option) => option.id), ['a', 'b', 'c', 'd']);
  assert.deepEqual(rolesById(options).c, ['best-value']);
  assert.deepEqual(rolesById(options).d, [ALTERNATIVE_ROLE]);
});

// --- property-style invariants over random choice sets ---

/** Deterministic PRNG so a failure is reproducible. */
function rng(seed) {
  let state = seed >>> 0;
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 0x100000000;
  };
}

function randomChoices(next, count) {
  const paths = ['codex', 'mistral', 'xai', 'google', 'local'];
  const resets = [null, SOON, LATER, 'not-a-date'];
  return Array.from({ length: count }, (_, index) => choice(`m${index}`, {
    path: paths[Math.floor(next() * paths.length)],
    intelligence: next() < 0.15 ? null : Math.round(next() * 1000) / 10,
    intelligenceSource: next() < 0.3 ? 'aa-estimate' : 'roi',
    costPerMTok: next() < 0.15 ? null : Math.round(next() * 500) / 100,
    headroomPct: next() < 0.1 ? null : Math.floor(next() * 100),
    resetsAt: resets[Math.floor(next() * resets.length)],
  }));
}

test('options are a subset of the choices, with unique ids and at most max roles each', () => {
  const next = rng(20261108);
  for (let round = 0; round < 200; round += 1) {
    const ranked = randomChoices(next, Math.floor(next() * 9));
    const max = 1 + Math.floor(next() * 5);
    const options = shortlist(ranked, { max });
    const ids = new Set(ranked.map((entry) => entry.id));

    assert.ok(options.length <= Math.min(max, ranked.length), `round ${round}: length`);
    const seen = new Set();
    for (const option of options) {
      assert.ok(ids.has(option.id), `round ${round}: ${option.id} is not a choice`);
      assert.ok(!seen.has(option.id), `round ${round}: duplicate id ${option.id}`);
      seen.add(option.id);
      assert.ok(option.roles.length >= 1, `round ${round}: an option needs a role`);
      assert.equal(new Set(option.roles).size, option.roles.length, `round ${round}: duplicate role`);
      for (const role of option.roles) {
        assert.ok(role === ALTERNATIVE_ROLE || ROLE_ORDER.includes(role), `round ${round}: unknown role ${role}`);
      }
    }

    // Every role appears at most once across the whole shortlist.
    const allRoles = options.flatMap((option) => option.roles);
    for (const role of ROLE_ORDER) {
      assert.ok(allRoles.filter((entry) => entry === role).length <= 1, `round ${round}: ${role} twice`);
    }
    // The role order is stable: the first role of each option only moves forward.
    const positions = options.map((option) => ROLE_ORDER.indexOf(option.roles[0]));
    const named = positions.filter((position) => position !== -1);
    assert.deepEqual(named, [...named].sort((a, b) => a - b), `round ${round}: role order`);
  }
});

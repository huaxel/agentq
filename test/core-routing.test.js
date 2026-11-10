'use strict';
/**
 * Routing tests: floor enforcement, capacity gating, and a deterministic
 * cheapest-first order. Fixtures are hand-built so each rule is isolated.
 */
const assert = require('node:assert/strict');
const test = require('node:test');

const { ORDER, TIER_FLOORS, intelligenceText, rank, recommend } = require('../src/core/routing.js');

const SOON = '2026-11-08T13:00:00Z';
const LATER = '2026-11-09T13:00:00Z';

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

function cap(path, overrides = {}) {
  return {
    path,
    state: 'available',
    headroomPct: 60,
    resetsAt: null,
    observedAt: '2026-11-08T11:00:00Z',
    stale: false,
    reason: null,
    ...overrides,
  };
}

function capacityOf(...entries) {
  return new Map(entries.map((e) => [e.path, e]));
}

test('tier floors reject work that is too cheap for the tier', () => {
  const catalog = [entry('cheap', { intelligence: 35 })];
  const capacity = capacityOf(cap('codex'));

  const big = rank({ catalog, capacity, tier: 'big' });
  assert.deepEqual(big.choices, []);
  assert.equal(big.rejected.length, 1);
  assert.match(big.rejected[0].reasons.join(' '), /intelligence 35 below floor 45/);

  assert.equal(rank({ catalog, capacity, tier: 'small' }).choices.length, 1);
  assert.equal(rank({ catalog, capacity, tier: 'medium' }).choices.length, 0);
  assert.equal(TIER_FLOORS.small, 30);
  assert.equal(TIER_FLOORS.medium, 38);
  assert.equal(TIER_FLOORS.big, 45);
});

test('an unknown tier falls back to the medium floor and minIntelligence overrides it', () => {
  const catalog = [entry('mid', { intelligence: 40 })];
  const capacity = capacityOf(cap('codex'));
  assert.equal(rank({ catalog, capacity, tier: 'gigantic' }).policy.floor, TIER_FLOORS.medium);
  assert.equal(rank({ catalog, capacity, tier: 'gigantic' }).choices.length, 1);
  assert.equal(rank({ catalog, capacity, tier: 'big', minIntelligence: 40 }).choices.length, 1);
  assert.equal(rank({ catalog, capacity, tier: 'small', minIntelligence: 41 }).choices.length, 0);
});

test('prototype keys are not tiers: the floor falls back to medium', () => {
  const catalog = [entry('weak', { intelligence: 1 })];
  const capacity = capacityOf(cap('codex'));
  for (const tier of ['constructor', 'toString', '__proto__', 'hasOwnProperty']) {
    const result = rank({ catalog, capacity, tier });
    assert.equal(result.policy.floor, TIER_FLOORS.medium, `tier ${tier} must not resolve to a prototype value`);
    assert.deepEqual(result.choices, [], `tier ${tier} must still enforce the floor`);
    assert.match(result.rejected[0].reasons.join(' '), /below floor 38/);
  }
});

test('saturated capacity is rejected even when the model is smart enough', () => {
  const catalog = [entry('saturated-model')];
  const capacity = capacityOf(cap('codex', { state: 'saturated', headroomPct: 0 }));
  const result = rank({ catalog, capacity, tier: 'medium' });
  assert.deepEqual(result.choices, []);
  assert.match(result.rejected[0].reasons.join(' '), /capacity saturated: 0% headroom/);
  assert.equal(result.rejected[0].capacityState, 'saturated');
});

test('unknown capacity is rejected unless explicitly allowed', () => {
  const catalog = [entry('unknown-model', { path: 'clinepass' })];
  const capacity = capacityOf(cap('clinepass', { state: 'unknown', headroomPct: null, stale: true, reason: 'no quota data' }));

  const blocked = rank({ catalog, capacity, tier: 'medium' });
  assert.deepEqual(blocked.choices, []);
  assert.match(blocked.rejected[0].reasons.join(' '), /capacity unknown: no quota data/);

  const allowed = rank({ catalog, capacity, tier: 'medium', allowUnknownCapacity: true });
  assert.equal(allowed.choices.length, 1);
  assert.equal(allowed.choices[0].capacityState, 'unknown');
  assert.match(allowed.choices[0].reasons.join(' '), /capacity unknown: allowed/);
});

test('a path missing from the snapshot is unknown, never available', () => {
  const catalog = [entry('local-model', { path: 'local' })];
  const result = rank({ catalog, capacity: capacityOf(cap('codex')), tier: 'medium' });
  assert.deepEqual(result.choices, []);
  assert.match(result.rejected[0].reasons.join(' '), /capacity unknown: no quota data/);
});

test('unscored entries are rejected unless allowed, and then sort last', () => {
  const catalog = [
    entry('unscored-model', { intelligence: null, costPerMTok: null, scored: false }),
    entry('scored-model', { intelligence: 60, costPerMTok: 5 }),
  ];
  const capacity = capacityOf(cap('codex'));

  const blocked = rank({ catalog, capacity, tier: 'medium' });
  assert.deepEqual(blocked.choices.map((c) => c.id), ['scored-model']);
  assert.match(blocked.rejected[0].reasons.join(' '), /unscored: no ROI score row/);

  const allowed = rank({ catalog, capacity, tier: 'medium', allowUnscored: true });
  assert.deepEqual(allowed.choices.map((c) => c.id), ['scored-model', 'unscored-model']);
  assert.match(allowed.choices[1].reasons.join(' '), /unscored: allowed/);
});

test('choices sort by cost, then soonest reset, then intelligence, then id', () => {
  // resetsAt comes from the path's capacity entry, so each fixture gets its own path.
  const catalog = [
    entry('pricey', { path: 'p-pricey', costPerMTok: 30, intelligence: 90 }),
    entry('cheap-later', { path: 'p-later', costPerMTok: 1, intelligence: 40 }),
    entry('cheap-soon', { path: 'p-soon', costPerMTok: 1, intelligence: 40 }),
    entry('cheap-no-reset', { path: 'p-noreset', costPerMTok: 1, intelligence: 99 }),
    entry('tie-b', { path: 'p-tie-b', costPerMTok: 2, intelligence: 50 }),
    entry('tie-a', { path: 'p-tie-a', costPerMTok: 2, intelligence: 50 }),
    entry('smarter', { path: 'p-smarter', costPerMTok: 2, intelligence: 70 }),
  ];
  const capacity = capacityOf(
    cap('p-pricey'),
    cap('p-later', { resetsAt: LATER }),
    cap('p-soon', { resetsAt: SOON }),
    cap('p-noreset', { resetsAt: null }),
    cap('p-tie-a', { resetsAt: SOON }),
    cap('p-tie-b', { resetsAt: SOON }),
    cap('p-smarter', { resetsAt: SOON }),
  );
  const { choices, policy } = rank({ catalog, capacity, tier: 'medium' });

  assert.deepEqual(choices.map((c) => c.id), [
    'cheap-soon',
    'cheap-later',
    'cheap-no-reset',
    'smarter',
    'tie-a',
    'tie-b',
    'pricey',
  ]);
  assert.deepEqual(policy.order, ORDER);
  assert.equal(policy.floor, TIER_FLOORS.medium);
});

test('ranking is deterministic across repeated runs', () => {
  const catalog = [entry('b'), entry('a'), entry('c')];
  const capacity = capacityOf(cap('codex'));
  const first = rank({ catalog, capacity, tier: 'medium' }).choices.map((c) => c.id);
  const second = rank({ catalog: [...catalog].reverse(), capacity, tier: 'medium' }).choices.map((c) => c.id);
  assert.deepEqual(first, ['a', 'b', 'c']);
  assert.deepEqual(second, first);
});

test('recommend returns a shortlist plus the default, or null with the rejection reasons', () => {
  const capacity = capacityOf(cap('codex'));
  const catalog = [
    entry('best', { costPerMTok: 1 }),
    entry('second', { costPerMTok: 2 }),
  ];
  const picked = recommend({ catalog, capacity, tier: 'medium' });
  // `default` is the old `choice`: the head of the ranked list, not a verdict.
  assert.deepEqual(picked.default, picked.choices[0]);
  assert.equal(picked.default.id, 'best');
  assert.deepEqual(picked.choices.map((c) => c.id), ['best', 'second']);
  assert.deepEqual(picked.options.map((option) => option.id), ['best', 'second']);
  assert.ok(picked.options.every((option) => option.roles.length >= 1));
  assert.deepEqual(picked.rejected, []);
  assert.deepEqual(picked.policy, { floor: TIER_FLOORS.medium, order: ORDER });

  const none = recommend({ catalog: [entry('dumb', { intelligence: 1 })], capacity, tier: 'big' });
  assert.equal(none.default, null);
  assert.deepEqual(none.options, []);
  assert.deepEqual(none.choices, []);
  assert.equal(none.rejected.length, 1);

  const empty = recommend({ catalog: [], capacity: null, tier: 'small' });
  assert.equal(empty.default, null);
  assert.deepEqual(empty.options, []);
  assert.deepEqual(empty.choices, []);
  assert.deepEqual(empty.rejected, []);
});

test('an estimated model is eligible like a score but every reason says so', () => {
  const calibration = { n: 6, r: 0.9478884888361071, rmse: 2.7706407696590007 };
  const catalog = [
    entry('estimated', {
      intelligence: 53.95,
      intelligenceSource: 'aa-estimate',
      aaIndex: 35.5,
      calibration,
      costPerMTok: null,
      scored: false,
    }),
  ];
  const { choices, rejected } = rank({ catalog, capacity: capacityOf(cap('codex')), tier: 'big' });

  assert.deepEqual(choices.map((c) => c.id), ['estimated'], 'the tier floor applies to the estimate');
  assert.equal(choices[0].intelligenceSource, 'aa-estimate');
  assert.equal(choices[0].aaIndex, 35.5);
  assert.deepEqual(choices[0].calibration, calibration);
  assert.match(choices[0].reasons.join(' '), /intelligence ≈54 \(AA estimate, n=6, r=0\.95\) >= floor 45/);
  assert.deepEqual(rejected, []);
});

test('an estimate below the floor is rejected with the same marked wording', () => {
  const catalog = [
    entry('weak-estimate', {
      intelligence: 31.2,
      intelligenceSource: 'aa-estimate',
      aaIndex: 4,
      calibration: { n: 6, r: 0.95, rmse: 2.77 },
      costPerMTok: null,
      scored: false,
    }),
  ];
  const { choices, rejected } = rank({ catalog, capacity: capacityOf(cap('codex')), tier: 'medium' });
  assert.deepEqual(choices, []);
  assert.match(rejected[0].reasons.join(' '), /intelligence ≈31\.2 \(AA estimate, n=6, r=0\.95\) below floor 38/);
});

test('allowUnscored still means "no intelligence at all", not "estimated"', () => {
  const catalog = [
    entry('estimated', { intelligence: 50, intelligenceSource: 'aa-estimate', aaIndex: 30, calibration: { n: 6, r: 0.95, rmse: 2.77 }, scored: false }),
    entry('unknown', { intelligence: null, costPerMTok: null, scored: false }),
  ];
  const capacity = capacityOf(cap('codex'));

  const strict = rank({ catalog, capacity, tier: 'medium' });
  assert.deepEqual(strict.choices.map((c) => c.id), ['estimated'], 'an estimate needs no allowUnscored');
  assert.match(strict.rejected[0].reasons.join(' '), /unscored: no ROI score row/);

  const permissive = rank({ catalog, capacity, tier: 'medium', allowUnscored: true });
  assert.deepEqual(permissive.choices.map((c) => c.id), ['estimated', 'unknown']);
});

test('an AA-priced estimate competes on cost and says where the price came from', () => {
  const catalog = [
    entry('estimated-cheap', {
      intelligence: 50,
      intelligenceSource: 'aa-estimate',
      aaIndex: 30,
      calibration: { n: 6, r: 0.95, rmse: 2.77 },
      costPerMTok: 0.5,
      costSource: 'aa-price',
      scored: false,
    }),
    entry('scored-pricey', { intelligence: 60, costPerMTok: 2, costSource: 'roi' }),
  ];
  const { choices } = rank({ catalog, capacity: capacityOf(cap('codex')), tier: 'medium' });

  assert.deepEqual(choices.map((c) => c.id), ['estimated-cheap', 'scored-pricey'], 'cheaper first, estimate or not');
  assert.equal(choices[0].costSource, 'aa-price');
  assert.match(choices[0].reasons.join(' '), /cost \$0\.50\/MTok \(AA list price\)/);
  assert.equal(choices[1].costSource, 'roi');
  assert.doesNotMatch(choices[1].reasons.join(' '), /AA list price/);
});

test('intelligenceText marks only estimates', () => {
  assert.equal(intelligenceText(53.95, 'roi', null), '54');
  assert.equal(intelligenceText(53.95, 'aa-estimate', { n: 6, r: 0.9478 }), '≈54 (AA estimate, n=6, r=0.95)');
  assert.equal(intelligenceText(31.2, 'aa-estimate', { n: 6, r: 0.95 }), '≈31.2 (AA estimate, n=6, r=0.95)');
  assert.equal(intelligenceText(31.2, null, null), '31.2');
  assert.equal(intelligenceText(31.2, 'aa-estimate', null), '≈31.2 (AA estimate)');
});

test('ranked items carry the capacity evidence used to decide', () => {
  const catalog = [entry('evidence', { intelligence: 55, costPerMTok: 3 })];
  const capacity = capacityOf(
    cap('codex', { headroomPct: 42, resetsAt: SOON, observedAt: '2026-11-08T11:30:00Z' }),
  );
  const [choice] = rank({ catalog, capacity, tier: 'medium' }).choices;
  assert.equal(choice.path, 'codex');
  assert.equal(choice.intelligence, 55);
  assert.equal(choice.costPerMTok, 3);
  assert.equal(choice.capacityState, 'available');
  assert.equal(choice.headroomPct, 42);
  assert.equal(choice.resetsAt, SOON);
  assert.equal(choice.observedAt, '2026-11-08T11:30:00Z');
  assert.match(choice.reasons.join(' '), /intelligence 55 >= floor 38/);
  assert.match(choice.reasons.join(' '), /capacity available: 42% headroom/);
});

test('a behind-pace path outranks a cheaper list-price path once cost is adjusted', () => {
  const catalog = [
    entry('scarce', { path: 'p-scarce', costPerMTok: 3, intelligence: 50 }),
    entry('cheap', { path: 'p-cheap', costPerMTok: 1, intelligence: 50 }),
  ];
  const capacity = capacityOf(
    cap('p-scarce', {
      pace: { window: 'weekly', usedPct: 10, elapsedPct: 50, projectedPct: 20, state: 'behind' },
      quotaPressure: 0.25,
    }),
    cap('p-cheap', { pace: null, quotaPressure: null }),
  );
  const { choices } = rank({ catalog, capacity, tier: 'medium' });
  assert.deepEqual(choices.map((choice) => choice.id), ['scarce', 'cheap']);
  assert.equal(choices[0].effectiveCostPerMTok, 0.75, '3 × 0.25');
  assert.equal(choices[1].effectiveCostPerMTok, 1);
  assert.match(
    choices[0].reasons.join('\n'),
    /pace behind: 10% used, 50% of window elapsed \(projected 20%\)/,
  );
  assert.ok(!choices[1].reasons.some((reason) => reason.startsWith('pace ')));
});

test('a null pace leaves the order on list price', () => {
  const catalog = [
    entry('pricey', { path: 'p-pricey', costPerMTok: 3, intelligence: 50 }),
    entry('cheap', { path: 'p-cheap', costPerMTok: 1, intelligence: 50 }),
  ];
  const capacity = capacityOf(cap('p-pricey'), cap('p-cheap'));
  const { choices } = rank({ catalog, capacity });
  assert.deepEqual(choices.map((choice) => choice.id), ['cheap', 'pricey']);
  assert.equal(choices[0].effectiveCostPerMTok, 1);
  assert.ok(choices.every((choice) => choice.pace === null && choice.quotaPressure === null));
  assert.ok(choices.every((choice) => !choice.reasons.some((reason) => reason.startsWith('pace '))));
});

// --- path prices and data sharing (W16) -------------------------------------

const COST_BASIS = {
  source: 'path-price',
  mix: { cacheRead: 0.95, cacheWrite: 0, input: 0.05, output: 0 },
  mixSource: 'observed-path',
  mixTokens: 41_000_000,
  peak: true,
  allowanceScale: 0.1,
};

test('a path-price cost carries its basis and its own reason into the choice', () => {
  const { choices } = rank({
    catalog: [entry('priced', {
      costSource: 'path-price',
      costBasis: COST_BASIS,
      costReason: 'cost $0.0012/MTok (path price, peak, mix 95/0/5/0 cache-read/write/in/out observed 41M tok, × $10/$100 allowance)',
    })],
    capacity: new Map([['codex', cap('codex')]]),
    tier: 'medium',
  });
  assert.deepEqual(choices[0].costBasis, COST_BASIS);
  assert.equal(choices[0].dataSharing, false);
  assert.ok(choices[0].reasons.includes(
    'cost $0.0012/MTok (path price, peak, mix 95/0/5/0 cache-read/write/in/out observed 41M tok, × $10/$100 allowance)',
  ));
});

test('an expired price entry is rejected with its date', () => {
  const { choices, rejected } = rank({
    catalog: [entry('expired', { priceExpired: 'price entry expired 2026-11-01' })],
    capacity: new Map([['codex', cap('codex')]]),
    tier: 'medium',
  });
  assert.deepEqual(choices, []);
  assert.deepEqual(rejected[0].reasons, ['price entry expired 2026-11-01']);
});

test('a data-sharing choice stays eligible with a reason, unless private work excludes it', () => {
  const catalog = [entry('shared', { dataSharing: true }), entry('clean', { costPerMTok: 2 })];
  const capacity = new Map([['codex', cap('codex')]]);

  const open = rank({ catalog, capacity, tier: 'medium' });
  assert.deepEqual(open.choices.map((choice) => choice.id), ['shared', 'clean']);
  assert.ok(open.choices[0].reasons.includes('data sharing: provider may retain prompts'));

  const private_ = rank({ catalog, capacity, tier: 'medium', excludeDataSharing: true });
  assert.deepEqual(private_.choices.map((choice) => choice.id), ['clean']);
  assert.deepEqual(private_.rejected[0].reasons, ['data sharing: excluded for private work']);
});

test('recommend passes the private switch through, and the option carries the flag', () => {
  const catalog = [entry('shared', { dataSharing: true })];
  const capacity = new Map([['codex', cap('codex')]]);
  const open = recommend({ catalog, capacity, tier: 'medium' });
  assert.equal(open.options[0].dataSharing, true);
  assert.deepEqual(open.options[0].costBasis, null);

  const excluded = recommend({ catalog, capacity, tier: 'medium', excludeDataSharing: true });
  assert.deepEqual(excluded.options, []);
  assert.equal(excluded.default, null);
});

'use strict';

/**
 * Track records: the pure fold (weights, tier inheritance, key resolution,
 * verify_failed override), the Wilson bound, and the one routing effect the
 * record has — it can make an unscored model eligible, and it never reorders a
 * scored one.
 *
 * Synthetic rows only; no clock, no database.
 */

const assert = require('node:assert/strict');
const test = require('node:test');

const {
  REVIEW_TIERS,
  REVIEW_VERDICTS,
  TRACK_RECORD_MIN_N,
  TRACK_RECORD_MIN_LOWER,
  buildTrackRecords,
  eligibilityReason,
  keyResolver,
  qualifies,
  recordCell,
  successesText,
  trackRecordFor,
  trackRecordPolicy,
  trackRecordReason,
  trackRecordStats,
  verdictWeight,
  wilsonLowerBound,
} = require('../src/core/track-record.js');
const { rank, recommend } = require('../src/core/routing.js');

const NOW = '2026-11-10T12:00:00Z';

/** @param {Partial<{model: string, tier: string, verdict: string, task_id: string|null}>} [overrides] */
function review(overrides = {}) {
  return { model: 'mistral/deepseek-v4-1-flash-1017', tier: 'medium', verdict: 'accepted', task_id: null, ...overrides };
}

// Two quota paths, one model: the first declares its key, the second relies on
// the key of its id. Both must fold to deepseek-v4-1-flash.
const RUNNABLES = [
  { id: 'mistral/deepseek-v4-1-flash-1017', path: 'mistral', modelKey: 'deepseek-v4-1-flash' },
  { id: 'opencode/deepseek-v4-1-flash', path: 'opencode', modelKey: null },
];

// --- Wilson bound ---

test('the Wilson lower bound keeps a small perfect sample below the threshold', () => {
  // 5 of 5 is not proof: the 95% lower bound is only ~0.566.
  assert.ok(Math.abs(wilsonLowerBound(5, 5) - 0.5655) < 0.001, `saw ${wilsonLowerBound(5, 5)}`);
  // 10 of 10 is ~0.722, which clears 0.70.
  assert.ok(Math.abs(wilsonLowerBound(10, 10) - 0.7225) < 0.001, `saw ${wilsonLowerBound(10, 10)}`);
  // 11 of 11 is ~0.741, the "0.74" the routing reason quotes.
  assert.ok(Math.abs(wilsonLowerBound(11, 11) - 0.7412) < 0.001, `saw ${wilsonLowerBound(11, 11)}`);
});

test('the Wilson lower bound is 0 with nothing to go on and rises with successes', () => {
  assert.equal(wilsonLowerBound(0, 0), 0);
  assert.equal(wilsonLowerBound(0, 5), 0);
  const bounds = [0, 1, 2, 3, 4, 5].map((successes) => wilsonLowerBound(successes, 5));
  for (let index = 1; index < bounds.length; index += 1) {
    assert.ok(bounds[index] > bounds[index - 1], `bound must rise: ${bounds.join(', ')}`);
  }
  // Fractional successes are allowed (a with-fixes verdict is half).
  assert.ok(wilsonLowerBound(4.5, 5) > wilsonLowerBound(4, 5));
});

test('the unlock thresholds are the documented constants and a record must clear both', () => {
  assert.equal(TRACK_RECORD_MIN_N, 5);
  assert.equal(TRACK_RECORD_MIN_LOWER, 0.7);

  const fiveOfFive = { n: 5, lowerBound: wilsonLowerBound(5, 5) };
  const tenOfTen = { n: 10, lowerBound: wilsonLowerBound(10, 10) };
  assert.equal(qualifies(fiveOfFive), false, '5/5 is ~0.566, below 0.70');
  assert.equal(qualifies(tenOfTen), true);
  assert.equal(qualifies(null), false);
  // Either threshold alone is not enough.
  assert.equal(qualifies({ n: 4, lowerBound: 0.99 }), false);
  assert.equal(qualifies({ n: 40, lowerBound: 0.69 }), false);
});

// --- Weights ---

test('verdict weights are 1, 0.5 and 0', () => {
  assert.deepEqual(REVIEW_VERDICTS, ['accepted', 'accepted-with-fixes', 'rejected']);
  assert.equal(verdictWeight('accepted'), 1);
  assert.equal(verdictWeight('accepted-with-fixes'), 0.5);
  assert.equal(verdictWeight('rejected'), 0);
  assert.equal(verdictWeight('nonsense'), null);
});

test('accepted-with-fixes counts as half a success', () => {
  const records = buildTrackRecords({
    reviews: [
      review({ verdict: 'accepted' }),
      review({ verdict: 'accepted' }),
      review({ verdict: 'accepted-with-fixes' }),
      review({ verdict: 'accepted-with-fixes' }),
      review({ verdict: 'rejected' }),
    ],
    runnables: RUNNABLES,
  });
  const record = trackRecordFor(records, 'deepseek-v4-1-flash', 'medium');
  assert.deepEqual(record, {
    n: 5,
    accepted: 2,
    withFixes: 2,
    rejected: 1,
    rate: 0.6,
    lowerBound: wilsonLowerBound(3, 5),
  });
  assert.equal(successesText(record), '3');
});

test('a fractional success is shown as such', () => {
  const records = buildTrackRecords({
    reviews: [review({ verdict: 'accepted-with-fixes' }), review({ verdict: 'accepted' })],
    runnables: RUNNABLES,
  });
  const record = trackRecordFor(records, 'deepseek-v4-1-flash', 'medium');
  assert.equal(successesText(record), '1.5');
  assert.equal(recordCell(record), '1.5/2');
});

// --- Tier inheritance ---

test('a review at big also counts for medium and small, never the other way', () => {
  const big = buildTrackRecords({ reviews: [review({ tier: 'big' })], runnables: RUNNABLES });
  assert.equal(trackRecordFor(big, 'deepseek-v4-1-flash', 'big').n, 1);
  assert.equal(trackRecordFor(big, 'deepseek-v4-1-flash', 'medium').n, 1);
  assert.equal(trackRecordFor(big, 'deepseek-v4-1-flash', 'small').n, 1);

  const small = buildTrackRecords({ reviews: [review({ tier: 'small' })], runnables: RUNNABLES });
  assert.equal(trackRecordFor(small, 'deepseek-v4-1-flash', 'small').n, 1);
  assert.equal(trackRecordFor(small, 'deepseek-v4-1-flash', 'medium'), null);
  assert.equal(trackRecordFor(small, 'deepseek-v4-1-flash', 'big'), null);

  const medium = buildTrackRecords({ reviews: [review({ tier: 'medium' })], runnables: RUNNABLES });
  assert.equal(trackRecordFor(medium, 'deepseek-v4-1-flash', 'medium').n, 1);
  assert.equal(trackRecordFor(medium, 'deepseek-v4-1-flash', 'small').n, 1);
  assert.equal(trackRecordFor(medium, 'deepseek-v4-1-flash', 'big'), null);
});

test('an unknown tier is never counted', () => {
  const records = buildTrackRecords({ reviews: [review({ tier: 'gigantic' })], runnables: RUNNABLES });
  assert.equal(records.size, 0);
});

// --- Key resolution ---

test('the same model on two paths shares one record', () => {
  // One runnable declares modelKey, the other does not: the catalog folds both
  // ids to the same key, and so does the record.
  assert.equal(keyResolver(RUNNABLES)('mistral/deepseek-v4-1-flash-1017'), 'deepseek-v4-1-flash');
  assert.equal(keyResolver(RUNNABLES)('opencode/deepseek-v4-1-flash'), 'deepseek-v4-1-flash');

  const records = buildTrackRecords({
    reviews: [
      review({ model: 'mistral/deepseek-v4-1-flash-1017', verdict: 'accepted' }),
      review({ model: 'opencode/deepseek-v4-1-flash', verdict: 'rejected' }),
    ],
    runnables: RUNNABLES,
  });
  assert.deepEqual([...records.keys()], ['deepseek-v4-1-flash']);
  const record = trackRecordFor(records, 'deepseek-v4-1-flash', 'medium');
  assert.equal(record.n, 2);
  assert.equal(record.accepted, 1);
  assert.equal(record.rejected, 1);
});

test('a model that is no longer a runnable keeps a record under its id key', () => {
  const records = buildTrackRecords({
    reviews: [review({ model: 'ghost/gpt-9-preview', verdict: 'accepted' })],
    runnables: [],
  });
  assert.ok(records.has('gpt-9'));
});

// --- verify_failed ---

test('verify_failed counts as a rejection only when no review covers the task', () => {
  const unreviewed = buildTrackRecords({
    verifyOutcomes: [{ model: 'mistral/deepseek-v4-1-flash-1017', task_id: 't1', outcome: 'verify_failed' }],
    runnables: RUNNABLES,
  });
  const record = trackRecordFor(unreviewed, 'deepseek-v4-1-flash', 'medium');
  assert.equal(record.n, 1);
  assert.equal(record.rejected, 1);
  assert.equal(record.lowerBound, 0);

  // The considered verdict wins: the same task's review replaces the outcome.
  const reviewed = buildTrackRecords({
    reviews: [review({ task_id: 't1', verdict: 'accepted' })],
    verifyOutcomes: [{ model: 'mistral/deepseek-v4-1-flash-1017', task_id: 't1', outcome: 'verify_failed' }],
    runnables: RUNNABLES,
  });
  const reviewedRecord = trackRecordFor(reviewed, 'deepseek-v4-1-flash', 'medium');
  assert.equal(reviewedRecord.n, 1);
  assert.equal(reviewedRecord.accepted, 1);
  assert.equal(reviewedRecord.rejected, 0);
});

test('other outcomes and model-less verify failures contribute nothing', () => {
  const records = buildTrackRecords({
    verifyOutcomes: [
      { model: 'mistral/deepseek-v4-1-flash-1017', task_id: 't1', outcome: 'ok' },
      { model: 'mistral/deepseek-v4-1-flash-1017', task_id: 't2', outcome: 'timeout' },
      { model: null, task_id: 't3', outcome: 'verify_failed' },
    ],
    runnables: RUNNABLES,
  });
  assert.equal(records.size, 0);
});

test('a verify failure counts at medium, so it reaches small but not big', () => {
  const records = buildTrackRecords({
    verifyOutcomes: [{ model: 'mistral/deepseek-v4-1-flash-1017', task_id: 't1', outcome: 'verify_failed' }],
    runnables: RUNNABLES,
  });
  assert.equal(trackRecordFor(records, 'deepseek-v4-1-flash', 'medium').n, 1);
  assert.equal(trackRecordFor(records, 'deepseek-v4-1-flash', 'small').n, 1);
  assert.equal(trackRecordFor(records, 'deepseek-v4-1-flash', 'big'), null);
});

// --- Policy and presentation ---

test('the policy reads the config key and falls back on missing or invalid values', () => {
  assert.deepEqual(trackRecordPolicy(null), { minReviews: 5, minLowerBound: 0.7 });
  assert.deepEqual(trackRecordPolicy({}), { minReviews: 5, minLowerBound: 0.7 });
  assert.deepEqual(trackRecordPolicy({ trackRecord: { minReviews: 8, minLowerBound: 0.8 } }), { minReviews: 8, minLowerBound: 0.8 });
  assert.deepEqual(trackRecordPolicy({ trackRecord: { minReviews: -1, minLowerBound: 2 } }), { minReviews: 5, minLowerBound: 0.7 });
  assert.deepEqual(trackRecordPolicy({ trackRecord: 'nonsense' }), { minReviews: 5, minLowerBound: 0.7 });
});

test('the record cell and the reason sentences read as documented', () => {
  const record = { n: 6, accepted: 6, withFixes: 0, rejected: 0, rate: 1, lowerBound: 0.6096 };
  assert.equal(recordCell(record), '6/6');
  assert.equal(recordCell(null), '—');
  assert.equal(trackRecordReason(record, 'big'), 'track record 6/6 at big');
  assert.equal(
    eligibilityReason({ ...record, n: 11, accepted: 11, lowerBound: wilsonLowerBound(11, 11) }, 'medium'),
    'track record 11/11 accepted at medium (lower bound 0.74 >= 0.70)',
  );
});

test('stats flatten every record in a stable order', () => {
  const records = buildTrackRecords({
    reviews: [
      review({ model: 'mistral/deepseek-v4-1-flash-1017', tier: 'big' }),
      review({ model: 'opencode/deepseek-v4-1-flash', tier: 'small', verdict: 'rejected' }),
    ],
    runnables: RUNNABLES,
  });
  const stats = trackRecordStats(records);
  assert.equal(stats.count, 3);
  assert.deepEqual(stats.records.map((row) => row.tier), ['small', 'medium', 'big']);
  assert.equal(stats.records[0].model, 'deepseek-v4-1-flash');
  assert.deepEqual(trackRecordStats(null), { count: 0, records: [] });
});

// --- Routing: the one effect a record has ---

function catalogEntry(id, overrides = {}) {
  return {
    id,
    path: 'codex',
    harness: 'pi',
    modelKey: id,
    intelligence: 50,
    costPerMTok: 1,
    scored: true,
    ...overrides,
  };
}

function capacityOf(path) {
  return new Map([[
    path,
    { path, state: 'available', headroomPct: 60, resetsAt: null, observedAt: NOW, stale: false, reason: null },
  ]]);
}

function recordsFor(modelKey, tier, reviews) {
  return buildTrackRecords({
    reviews: reviews.map((verdict) => review({ model: modelKey, tier, verdict })),
    runnables: [{ id: modelKey, path: 'codex', modelKey }],
  });
}

test('a qualifying record makes an unscored model eligible, with the documented reason', () => {
  const trackRecords = recordsFor('sol', 'medium', Array(11).fill('accepted'));
  const result = rank({
    catalog: [catalogEntry('sol', { intelligence: null, costPerMTok: null, scored: false })],
    capacity: capacityOf('codex'),
    tier: 'medium',
    trackRecords,
  });
  assert.equal(result.rejected.length, 0);
  assert.equal(result.choices.length, 1);
  const choice = result.choices[0];
  assert.equal(choice.intelligence, null, 'the intelligence stays unknown');
  assert.equal(choice.reasons[0], 'track record 11/11 accepted at medium (lower bound 0.74 >= 0.70)');
  assert.equal(choice.trackRecord.n, 11);
});

test('without a qualifying record an unscored model is still rejected', () => {
  // 9/9 is 0.7008, which just clears 0.70; 8/8 is 0.676 and does not.
  for (const reviews of [[], Array(5).fill('accepted'), Array(8).fill('accepted')]) {
    const result = rank({
      catalog: [catalogEntry('sol', { intelligence: null, costPerMTok: null, scored: false })],
      capacity: capacityOf('codex'),
      tier: 'medium',
      trackRecords: recordsFor('sol', 'medium', reviews),
    });
    assert.equal(result.choices.length, 0, `${reviews.length} reviews must not unlock`);
    assert.match(result.rejected[0].reasons.join(' '), /unscored: no ROI score row/);
  }
});

test('the thresholds are overridable through the policy argument', () => {
  const trackRecords = recordsFor('sol', 'medium', Array(5).fill('accepted'));
  const strict = rank({
    catalog: [catalogEntry('sol', { intelligence: null, costPerMTok: null, scored: false })],
    capacity: capacityOf('codex'),
    tier: 'medium',
    trackRecords,
  });
  assert.equal(strict.choices.length, 0);

  const lenient = rank({
    catalog: [catalogEntry('sol', { intelligence: null, costPerMTok: null, scored: false })],
    capacity: capacityOf('codex'),
    tier: 'medium',
    trackRecords,
    trackRecordPolicy: { minReviews: 5, minLowerBound: 0.5 },
  });
  assert.equal(lenient.choices.length, 1);
  assert.match(lenient.choices[0].reasons[0], /lower bound 0\.57 >= 0\.50/);
});

test('a scored model keeps its order and gains the record plus a reason', () => {
  const trackRecords = recordsFor('alpha', 'big', ['accepted', 'accepted', 'accepted', 'accepted', 'rejected']);
  const catalog = [
    catalogEntry('beta', { costPerMTok: 1 }),
    catalogEntry('alpha', { costPerMTok: 2 }),
  ];
  const result = rank({ catalog, capacity: capacityOf('codex'), tier: 'big', trackRecords });
  assert.deepEqual(result.choices.map((choice) => choice.id), ['beta', 'alpha'], 'cost order is unchanged');
  const alpha = result.choices.find((choice) => choice.id === 'alpha');
  assert.equal(alpha.trackRecord.n, 5);
  assert.ok(alpha.reasons.includes('track record 4/5 at big'), alpha.reasons.join(' | '));
  const beta = result.choices.find((choice) => choice.id === 'beta');
  assert.equal(beta.trackRecord, null);
});

test('every choice and every option carries the record for the requested tier', () => {
  const trackRecords = recordsFor('alpha', 'medium', ['accepted', 'accepted']);
  const decision = recommend({
    catalog: [catalogEntry('alpha', { costPerMTok: 1 }), catalogEntry('beta', { costPerMTok: 2 })],
    capacity: capacityOf('codex'),
    tier: 'medium',
    trackRecords,
  });
  for (const choice of decision.choices) {
    assert.ok('trackRecord' in choice, `${choice.id} is missing trackRecord`);
  }
  const alpha = decision.options.find((option) => option.id === 'alpha');
  assert.equal(alpha.trackRecord.n, 2);
  assert.equal(recordCell(alpha.trackRecord), '2/2');
  const beta = decision.options.find((option) => option.id === 'beta');
  assert.equal(beta.trackRecord, null);
});

test('a record at a harder tier unlocks an unscored model at an easier one', () => {
  const trackRecords = recordsFor('sol', 'big', Array(11).fill('accepted'));
  const result = rank({
    catalog: [catalogEntry('sol', { intelligence: null, costPerMTok: null, scored: false })],
    capacity: capacityOf('codex'),
    tier: 'small',
    trackRecords,
  });
  assert.equal(result.choices.length, 1);
  assert.match(result.choices[0].reasons[0], /accepted at small/);
});

test('allowUnscored keeps its meaning alongside records', () => {
  const result = rank({
    catalog: [catalogEntry('sol', { intelligence: null, costPerMTok: null, scored: false })],
    capacity: capacityOf('codex'),
    tier: 'medium',
    allowUnscored: true,
    trackRecords: recordsFor('sol', 'medium', ['rejected']),
  });
  assert.equal(result.choices.length, 1);
  assert.ok(result.choices[0].reasons.includes('unscored: allowed, intelligence unknown'));
  assert.ok(result.choices[0].reasons.includes('track record 0/1 at medium'));
});

test('the review tiers are the routing tiers', () => {
  assert.deepEqual(REVIEW_TIERS, ['small', 'medium', 'big']);
});

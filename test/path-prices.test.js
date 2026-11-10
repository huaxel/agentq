'use strict';
/**
 * Unit tests for src/lib/path-prices.js: the subscription's own price list, the
 * allowance scale, peak/off-peak selection, expiry, and the config rules.
 * Synthetic prices, fixed `now`. Run with `npm test`.
 */
const { test } = require('node:test');
const assert = require('node:assert/strict');

const {
  pathPrice,
  pathFee,
  offPeakActive,
  offPeakWindows,
  parseClock,
  localMinutes,
  priceSet,
  mixCost,
  priceProblems,
  priceWarnings,
  formatCost,
  formatTokens,
} = require('../src/lib/path-prices.js');

/** 12:00 UTC: inside the peak window of the schedule below. */
const NOW = Date.parse('2026-11-08T12:00:00Z');

/** The observed mix the formula test uses (95% cache reads). */
const MIX = { cacheRead: 0.9459, cacheWrite: 0, input: 0.0514, output: 0.0027 };

const SCHEDULE = { tz: 'UTC', start: '16:30', end: '00:30' };

const PEAK = { input: 0.15, output: 0.6, cacheRead: 0.003, cacheWrite: null };
const OFF_PEAK = { input: 0.075, output: 0.3, cacheRead: 0.0015 };

/**
 * @param {Record<string, any>} [overrides]
 * @returns {Array<Record<string, any>>}
 */
function subscriptions(overrides = {}) {
  return [{
    id: 'go',
    name: 'Orbit Go',
    type: 'Wallet',
    fee: 10,
    startDate: '20260101',
    models: ['atlas-flash'],
    offPeakHours: SCHEDULE,
    prices: {
      'atlas-flash': { ...PEAK, offPeak: OFF_PEAK, monthlyLimit: 100 },
    },
    ...overrides,
  }];
}

/** An observed-path mix result, as src/core/token-mix.js returns it. */
function observed(mix, tokens = 41_000_000) {
  return { mix, mixSource: 'observed-path', mixTokens: tokens };
}

test('cost is the mixed list price scaled by fee ÷ monthlyLimit', () => {
  const priced = pathPrice({
    subscriptions: subscriptions(),
    quotaPath: 'go',
    modelKey: 'atlas-flash',
    now: NOW,
    mix: observed(MIX),
  });
  // 0.9459*0.003 + 0.0514*0.15 + 0.0027*0.6 = 0.0121677, × 10/100.
  assert.ok(Math.abs(priced.costPerMTok - 0.00121677) < 1e-12, String(priced.costPerMTok));
  assert.equal(Number(priced.costPerMTok.toFixed(7)), 0.0012168, 'the worked example rounds to 0.0012168');
  assert.equal(priced.fee, 10);
  assert.equal(priced.allowanceScale, 0.1);
  assert.equal(priced.peak, true);
  assert.equal(priced.pathId, 'go');
  assert.equal(priced.free, false);
  assert.equal(priced.dataSharing, false);
  assert.equal(priced.expiredReason, null);
  assert.match(priced.reason, /^cost \$0\.0012\/MTok \(path price, peak, mix 95\/0\/5\/0 cache-read\/write\/in\/out observed 41M tok, × \$10\/\$100 allowance\)$/);
});

test('a monthlyLimit of null is pay-per-token: no scaling', () => {
  const priced = pathPrice({
    subscriptions: subscriptions({
      prices: { 'atlas-flash': { ...PEAK, monthlyLimit: null } },
    }),
    quotaPath: 'go',
    modelKey: 'atlas-flash',
    now: NOW,
    mix: observed(MIX),
  });
  assert.equal(priced.allowanceScale, null);
  assert.ok(Math.abs(priced.costPerMTok - 0.0121677) < 1e-9);
  assert.match(priced.reason, /pay-per-token \(no monthly limit\)/);
});

test('the fee is the sum of the ACTIVE funding entries', () => {
  const now = Date.parse('2026-11-08T12:00:00Z');
  const subs = [
    { id: 'go', type: 'Wallet', fee: 10, startDate: '20260101', endDate: '20261001', models: ['atlas-flash'] },
    {
      id: 'gosingle',
      sourcePath: 'go',
      name: 'Orbit Go single',
      type: 'Wallet',
      fee: 20,
      startDate: '20261001',
      models: ['atlas-flash'],
      prices: { 'atlas-flash': { ...PEAK, monthlyLimit: 100 } },
    },
  ];
  assert.equal(pathFee(subs, 'go', now), 20, 'the ended plan no longer pays');
  const priced = pathPrice({ subscriptions: subs, quotaPath: 'go', modelKey: 'atlas-flash', now, mix: observed(MIX) });
  assert.equal(priced.fee, 20);
  assert.equal(priced.allowanceScale, 0.2);

  // Two active plans for one quota path are two payments for one allowance.
  const both = subs.map((entry) => ({ ...entry, endDate: undefined, startDate: '20260101' }));
  assert.equal(pathFee(both, 'go', now), 30);
});

test('off-peak prices apply inside the window, and a window may wrap midnight', () => {
  const at = (iso) => pathPrice({
    subscriptions: subscriptions(),
    quotaPath: 'go',
    modelKey: 'atlas-flash',
    now: Date.parse(iso),
    mix: observed(MIX),
  });
  const peak = at('2026-11-08T12:00:00Z');
  const off = at('2026-11-08T17:00:00Z');
  assert.equal(peak.peak, true);
  assert.equal(off.peak, false);
  assert.ok(Math.abs(off.costPerMTok - 0.000608385) < 1e-9, String(off.costPerMTok));
  assert.match(off.reason, /path price, off-peak,/);

  // 16:30 is the inclusive start; 00:30 is the exclusive end (back on peak).
  assert.equal(offPeakActive(SCHEDULE, Date.parse('2026-11-08T16:30:00Z')), true);
  assert.equal(offPeakActive(SCHEDULE, Date.parse('2026-11-08T00:15:00Z')), true, 'after midnight, still in the window');
  assert.equal(offPeakActive(SCHEDULE, Date.parse('2026-11-08T00:30:00Z')), false);
  assert.equal(offPeakActive(SCHEDULE, Date.parse('2026-11-08T16:29:00Z')), false);
});

test('the schedule is read in its own time zone', () => {
  const tokyo = { tz: 'Asia/Tokyo', start: '16:30', end: '00:30' };
  // 08:00 UTC is 17:00 in Tokyo: inside the window.
  assert.equal(localMinutes(Date.parse('2026-11-08T08:00:00Z'), 'Asia/Tokyo'), 17 * 60);
  assert.equal(offPeakActive(tokyo, Date.parse('2026-11-08T08:00:00Z')), true);
  // 02:00 UTC is 11:00 in Tokyo: before the window.
  assert.equal(offPeakActive(tokyo, Date.parse('2026-11-08T02:00:00Z')), false);
  assert.equal(parseClock('00:30'), 30);
  assert.equal(parseClock('24:00'), null);
  assert.equal(parseClock('9:05'), null);
});

/** OpenCode Go's two daily off-peak blocks, both UTC. */
const GO_WINDOWS = [
  { tz: 'UTC', start: '01:00', end: '04:00' },
  { tz: 'UTC', start: '06:00', end: '10:00' },
];

/** Price `atlas-flash` on the `go` path with the given schedule at `iso`. */
function pricedAt(offPeakHours, iso) {
  return pathPrice({
    subscriptions: subscriptions({ offPeakHours }),
    quotaPath: 'go',
    modelKey: 'atlas-flash',
    now: Date.parse(iso),
    mix: observed(MIX),
  });
}

test('an array of windows is off-peak inside any window and peak between them', () => {
  // 02:30 is inside 01:00–04:00, 08:00 inside 06:00–10:00, 05:00 in the gap.
  const first = pricedAt(GO_WINDOWS, '2026-11-08T02:30:00Z');
  const second = pricedAt(GO_WINDOWS, '2026-11-08T08:00:00Z');
  const between = pricedAt(GO_WINDOWS, '2026-11-08T05:00:00Z');
  assert.equal(first.peak, false);
  assert.equal(second.peak, false);
  assert.equal(between.peak, true);
  assert.match(first.reason, /path price, off-peak,/);
  assert.match(second.reason, /path price, off-peak,/);
  assert.match(between.reason, /path price, peak,/);
  assert.ok(Math.abs(first.costPerMTok - 0.000608385) < 1e-9, String(first.costPerMTok));
  assert.ok(Math.abs(between.costPerMTok - 0.00121677) < 1e-9, String(between.costPerMTok));
  // Each window keeps the single-window boundaries: start inclusive, end exclusive.
  assert.equal(pricedAt(GO_WINDOWS, '2026-11-08T01:00:00Z').peak, false);
  assert.equal(pricedAt(GO_WINDOWS, '2026-11-08T04:00:00Z').peak, true);
  assert.equal(pricedAt(GO_WINDOWS, '2026-11-08T06:00:00Z').peak, false);
  assert.equal(pricedAt(GO_WINDOWS, '2026-11-08T10:00:00Z').peak, true);
});

test('a wrapping window works inside an array', () => {
  const windows = [SCHEDULE, { tz: 'UTC', start: '06:00', end: '10:00' }];
  // 00:15 is after midnight, still inside 16:30 → 00:30.
  assert.equal(pricedAt(windows, '2026-11-08T00:15:00Z').peak, false);
  assert.equal(pricedAt(windows, '2026-11-08T17:00:00Z').peak, false);
  assert.equal(pricedAt(windows, '2026-11-08T08:00:00Z').peak, false);
  assert.equal(pricedAt(windows, '2026-11-08T12:00:00Z').peak, true);
  assert.equal(pricedAt(windows, '2026-11-08T00:30:00Z').peak, true, 'the wrapping end is exclusive');
});

test('each window of an array is read in its own time zone', () => {
  const windows = [
    { tz: 'UTC', start: '01:00', end: '04:00' },
    { tz: 'Asia/Tokyo', start: '16:30', end: '00:30' },
  ];
  // 08:00 UTC is 17:00 in Tokyo: inside the Tokyo window, outside the UTC one.
  assert.equal(pricedAt(windows, '2026-11-08T08:00:00Z').peak, false);
  // 02:00 UTC is 11:00 in Tokyo: inside the UTC window, outside the Tokyo one.
  assert.equal(pricedAt(windows, '2026-11-08T02:00:00Z').peak, false);
  // 18:00 UTC is 03:00 next day in Tokyo: outside both (the Tokyo window is
  // 16:30 → 00:30 local, i.e. 07:30 → 15:30 UTC).
  assert.equal(pricedAt(windows, '2026-11-08T18:00:00Z').peak, true);
});

test('the single-object form is unchanged, and a one-element array matches it', () => {
  assert.deepEqual(offPeakWindows(SCHEDULE), [SCHEDULE]);
  assert.deepEqual(offPeakWindows([SCHEDULE]), [SCHEDULE]);
  assert.equal(offPeakWindows(undefined), null);
  assert.equal(offPeakWindows('night'), null);
  for (const iso of ['2026-11-08T12:00:00Z', '2026-11-08T17:00:00Z', '2026-11-08T00:15:00Z']) {
    const single = pricedAt(SCHEDULE, iso);
    const listed = pricedAt([SCHEDULE], iso);
    assert.equal(single.peak, listed.peak, iso);
    assert.deepEqual(single.prices, listed.prices, iso);
    assert.equal(single.reason, listed.reason, iso);
  }
  assert.equal(pricedAt(SCHEDULE, '2026-11-08T12:00:00Z').peak, true);
  assert.equal(pricedAt(SCHEDULE, '2026-11-08T17:00:00Z').peak, false);
});

test('an unknown time zone reads as peak instead of throwing', () => {
  assert.equal(localMinutes(NOW, 'Mars/Olympus'), null);
  assert.equal(offPeakActive({ tz: 'Mars/Olympus', start: '00:00', end: '23:59' }, NOW), false);
  const priced = pathPrice({
    subscriptions: subscriptions({ offPeakHours: { tz: 'Mars/Olympus', start: '00:00', end: '23:59' } }),
    quotaPath: 'go',
    modelKey: 'atlas-flash',
    now: NOW,
    mix: observed(MIX),
  });
  assert.equal(priced.peak, true, 'the peak set applies when the window cannot be read');
});

test('without an off-peak schedule the peak price always applies and the reason says so', () => {
  const priced = pathPrice({
    subscriptions: subscriptions({ offPeakHours: undefined }),
    quotaPath: 'go',
    modelKey: 'atlas-flash',
    now: Date.parse('2026-11-08T17:00:00Z'),
    mix: observed(MIX),
  });
  assert.equal(priced.peak, null);
  assert.ok(Math.abs(priced.costPerMTok - 0.00121677) < 1e-9);
  assert.match(priced.reason, /peak price \(no off-peak schedule\)/);
});

test('an offPeak price set without a schedule is inert, and the reason names the missing prices', () => {
  const priced = pathPrice({
    subscriptions: subscriptions({ offPeakHours: undefined }),
    quotaPath: 'go',
    modelKey: 'atlas-flash',
    now: NOW,
    mix: observed(MIX),
  });
  assert.equal(priced.peak, null);
  assert.match(priced.reason, /peak price \(no off-peak schedule\)/);

  // A schedule exists but the entry declares no off-peak prices: the peak set
  // applies and the reason says why.
  const scheduleNoPrices = pathPrice({
    subscriptions: subscriptions({
      offPeakHours: { tz: 'UTC', start: '00:00', end: '00:01' },
      prices: { 'atlas-flash': { ...PEAK, monthlyLimit: 100 } },
    }),
    quotaPath: 'go',
    modelKey: 'atlas-flash',
    now: NOW,
    mix: observed(MIX),
  });
  assert.equal(scheduleNoPrices.peak, null);
  assert.match(scheduleNoPrices.reason, /peak price \(no off-peak prices\)/);
});

test('a free entry costs 0 whatever the mix', () => {
  const priced = pathPrice({
    subscriptions: subscriptions({
      prices: { 'atlas-flash': { ...PEAK, monthlyLimit: 100, free: true } },
    }),
    quotaPath: 'go',
    modelKey: 'atlas-flash',
    now: NOW,
    mix: observed(MIX),
  });
  assert.equal(priced.costPerMTok, 0);
  assert.equal(priced.free, true);
  assert.match(priced.reason, /^cost \$0\/MTok \(path price, free\)$/);
});

test('until expires the entry from that date, with a different reason for a free tier', () => {
  const paid = subscriptions({
    prices: { 'atlas-flash': { ...PEAK, monthlyLimit: 100, until: '2026-12-31' } },
  });
  const at = (iso, subs = paid) => pathPrice({
    subscriptions: subs, quotaPath: 'go', modelKey: 'atlas-flash', now: Date.parse(iso), mix: observed(MIX),
  });
  assert.equal(at('2026-12-30T23:59:59Z').expiredReason, null, 'the day before is still valid');
  assert.equal(at('2026-12-31T00:00:00Z').expiredReason, 'price entry expired 2026-12-31');
  assert.equal(at('2027-01-01T00:00:00Z').expiredReason, 'price entry expired 2026-12-31');

  const free = subscriptions({
    prices: { 'atlas-flash': { ...PEAK, monthlyLimit: 100, until: '2026-12-31', free: true } },
  });
  assert.equal(at('2027-01-01T00:00:00Z', free).expiredReason, 'free tier ended 2026-12-31');
});

test('a null price counts as 0 and the reason names it only when the mix spends on it', () => {
  const subs = subscriptions({
    prices: { 'atlas-flash': { input: null, output: 0.6, cacheRead: 0.003, cacheWrite: null, monthlyLimit: 100 } },
  });
  const priced = pathPrice({
    subscriptions: subs,
    quotaPath: 'go',
    modelKey: 'atlas-flash',
    now: NOW,
    mix: observed({ cacheRead: 0.5, cacheWrite: 0.1, input: 0.3, output: 0.1 }),
  });
  // input and cache-write prices are null → 0; cache-read and output still count.
  assert.ok(Math.abs(priced.costPerMTok - (0.5 * 0.003 + 0.1 * 0.6) * 0.1) < 1e-12);
  assert.match(priced.reason, /\(no input price, no cache-write price\)/);

  // A mix with no cache writes never mentions the missing cache-write price.
  const noWrites = pathPrice({
    subscriptions: subs,
    quotaPath: 'go',
    modelKey: 'atlas-flash',
    now: NOW,
    mix: observed({ cacheRead: 0.9, cacheWrite: 0, input: 0.05, output: 0.05 }),
  });
  assert.match(noWrites.reason, /\(no input price\)\)$/);
});

test('an offPeak set replaces only the fields it declares', () => {
  const set = priceSet({ input: 1, output: 2, cacheRead: 3, cacheWrite: 4, offPeak: { input: 0.5 } }, { offPeak: true });
  assert.deepEqual(set, { input: 0.5, output: 2, cacheRead: 3, cacheWrite: 4 });
  assert.deepEqual(priceSet({ input: 1 }, { offPeak: false }), {
    input: 1, output: null, cacheRead: null, cacheWrite: null,
  });
  assert.equal(mixCost({ input: 1, output: 1, cacheRead: 1, cacheWrite: 1 }, MIX), 0.9459 + 0.0514 + 0.0027);
});

test('no token mix means no computed cost, but the entry facts still apply', () => {
  const priced = pathPrice({
    subscriptions: subscriptions({
      prices: { 'atlas-flash': { ...PEAK, monthlyLimit: 100, dataSharing: true } },
    }),
    quotaPath: 'go',
    modelKey: 'atlas-flash',
    now: NOW,
    mix: null,
  });
  assert.equal(priced.costPerMTok, null);
  assert.equal(priced.dataSharing, true);
  assert.match(priced.reason, /^cost unknown\/MTok/);
});

test('a model with no price entry on the path resolves to null', () => {
  assert.equal(pathPrice({
    subscriptions: subscriptions(), quotaPath: 'go', modelKey: 'not-priced', now: NOW, mix: observed(MIX),
  }), null);
  assert.equal(pathPrice({
    subscriptions: null, quotaPath: 'go', modelKey: 'atlas-flash', now: NOW, mix: observed(MIX),
  }), null);
});

test('price keys are normalized with modelKey, and the first entry wins', () => {
  const priced = pathPrice({
    subscriptions: subscriptions({
      prices: {
        'orbit/atlas-flash': { ...PEAK, monthlyLimit: 100 },
        'atlas-flash': { input: 9, output: 9, cacheRead: 9, monthlyLimit: 100 },
      },
    }),
    quotaPath: 'go',
    modelKey: 'atlas-flash',
    now: NOW,
    mix: observed(MIX),
  });
  assert.ok(Math.abs(priced.costPerMTok - 0.00121677) < 1e-9, 'the folded key wins, not the later literal one');
});

test('formatting helpers stay readable at both ends of the scale', () => {
  assert.equal(formatCost(0), '$0');
  assert.equal(formatCost(0.0012168), '$0.0012');
  assert.equal(formatCost(12.5), '$12.50');
  assert.equal(formatTokens(41_000_000), '41M');
  assert.equal(formatTokens(1_500_000), '1.5M');
  assert.equal(formatTokens(250_000), '250k');
  assert.equal(formatTokens(900), '900');
});

// --- validation -------------------------------------------------------------

/** A minimal valid config with one priced path. */
function config(prices, extra = {}) {
  return {
    paths: [{
      id: 'go', type: 'Wallet', fee: 10, models: ['atlas-flash'], prices, ...extra,
    }],
  };
}

test('a valid price table produces no problems', () => {
  assert.deepEqual(priceProblems(config({
    'atlas-flash': {
      ...PEAK,
      monthlyLimit: 100,
      offPeak: OFF_PEAK,
      longContext: [{ aboveTokens: 512000, input: 0.6, output: 2.4 }],
      free: false,
      until: '2026-12-31',
      dataSharing: false,
    },
  }, { offPeakHours: SCHEDULE })), []);
});

test('wrong types, negative prices and a non-positive monthlyLimit are errors', () => {
  const problems = priceProblems(config({
    'atlas-flash': { input: 'free', output: -1, cacheRead: null, monthlyLimit: 0 },
    'atlas-mini': { input: 1, offPeak: 'cheap' },
    'atlas-ultra': { input: 1, longContext: [{ aboveTokens: 0, input: -2 }] },
    '': { input: 1 },
    'atlas-nano': { input: 1, free: 'yes', dataSharing: 1, until: '31/12/2026' },
  }));
  assert.ok(problems.some((p) => /prices\["atlas-flash"\]\.input: expected a number or null/.test(p)));
  assert.ok(problems.some((p) => /prices\["atlas-flash"\]\.output: must not be negative/.test(p)));
  assert.ok(problems.some((p) => /prices\["atlas-flash"\]\.monthlyLimit: must be a positive number/.test(p)));
  assert.ok(problems.some((p) => /prices\["atlas-mini"\]\.offPeak: must be an object of prices/.test(p)));
  assert.ok(problems.some((p) => /prices\["atlas-ultra"\]\.longContext\[0\]\.aboveTokens: must be a positive number/.test(p)));
  assert.ok(problems.some((p) => /prices\["atlas-ultra"\]\.longContext\[0\]\.input: must not be negative/.test(p)));
  assert.ok(problems.some((p) => /model key must be a non-empty string/.test(p)));
  assert.ok(problems.some((p) => /\.free: expected a boolean/.test(p)));
  assert.ok(problems.some((p) => /\.dataSharing: expected a boolean/.test(p)));
  assert.ok(problems.some((p) => /\.until: expected a YYYY-MM-DD date/.test(p)));
});

test('a malformed prices block or offPeakHours is an error', () => {
  assert.ok(priceProblems(config([])).some((p) => /"prices" must be an object/.test(p)));
  assert.ok(priceProblems(config({ 'atlas-flash': 'cheap' })).some((p) => /must be an object/.test(p)));

  const bad = priceProblems(config({ 'atlas-flash': PEAK }, {
    offPeakHours: { tz: 'Mars/Olympus', start: '25:00', end: '25:00' },
  }));
  assert.ok(bad.some((p) => /offPeakHours\.tz "Mars\/Olympus" is not a known time zone/.test(p)));
  assert.ok(bad.some((p) => /offPeakHours\.start must be a HH:MM time/.test(p)));
  assert.ok(bad.some((p) => /offPeakHours\.end must be a HH:MM time/.test(p)));

  assert.ok(priceProblems(config({ 'atlas-flash': PEAK }, { offPeakHours: { tz: 'UTC', start: '16:30', end: '16:30' } }))
    .some((p) => /start and end must differ/.test(p)));
  assert.ok(priceProblems(config({ 'atlas-flash': PEAK }, { offPeakHours: { tz: '', start: '16:30', end: '17:00' } }))
    .some((p) => /offPeakHours\.tz must be a non-empty time zone name/.test(p)));
  assert.ok(priceProblems(config({ 'atlas-flash': PEAK }, { offPeakHours: 'night' }))
    .some((p) => /"offPeakHours" must be an object/.test(p)));
});

test('an empty offPeakHours array or a malformed window inside it is an error', () => {
  assert.ok(priceProblems(config({ 'atlas-flash': PEAK }, { offPeakHours: [] }))
    .some((p) => /"offPeakHours" must not be an empty array/.test(p)));

  const bad = priceProblems(config({ 'atlas-flash': PEAK }, {
    offPeakHours: [
      { tz: 'UTC', start: '01:00', end: '04:00' },
      { tz: 'Mars/Olympus', start: '06:00', end: '10:00' },
      { tz: 'UTC', start: '25:00', end: '26:00' },
      { tz: 'UTC', start: '06:00', end: '06:00' },
      'night',
    ],
  }));
  assert.ok(bad.some((p) => /offPeakHours\[1\]\.tz "Mars\/Olympus" is not a known time zone/.test(p)));
  assert.ok(bad.some((p) => /offPeakHours\[2\]\.start must be a HH:MM time/.test(p)));
  assert.ok(bad.some((p) => /offPeakHours\[2\]\.end must be a HH:MM time/.test(p)));
  assert.ok(bad.some((p) => /offPeakHours\[3\]\.start and end must differ/.test(p)));
  assert.ok(bad.some((p) => /offPeakHours\[4\] must be an object with tz, start and end/.test(p)));
  assert.equal(bad.length, 5, bad.join('\n'));

  // Overlapping windows are legal: two blocks may cover the same minutes.
  assert.deepEqual(priceProblems(config({ 'atlas-flash': PEAK }, {
    offPeakHours: [
      { tz: 'UTC', start: '01:00', end: '04:00' },
      { tz: 'UTC', start: '03:00', end: '06:00' },
    ],
  })), []);
});

test('a price key outside the path coverage is only a warning, and "*" covers all', () => {
  const uncovered = priceWarnings(config({
    'atlas-flash': PEAK,
    'atlas-ultra': PEAK,
  }));
  assert.deepEqual(uncovered, ['path go: price for atlas-ultra is not in the path\u2019s coverage'.replace('\u2019', "'")]);

  const wildcard = { paths: [{ id: 'openrouter', type: 'Metered', fee: 0, models: ['*'], prices: { anything: PEAK } }] };
  assert.deepEqual(priceWarnings(wildcard), []);

  // Coverage is the union over every entry funding the same quota path.
  const alias = {
    paths: [
      { id: 'go', type: 'Wallet', fee: 10, models: ['atlas-flash'] },
      { id: 'gosingle', sourcePath: 'go', type: 'Wallet', fee: 10, models: ['atlas-ultra'], prices: { 'atlas-ultra': PEAK } },
    ],
  };
  assert.deepEqual(priceWarnings(alias), []);
});

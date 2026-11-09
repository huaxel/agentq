'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');

const { printRollupDashboard, coverageNote } = require('../src/roi-tracker/tracker.js');

function captureLog(fn) {
  const lines = [];
  const original = console.log;
  console.log = (...args) => lines.push(args.join(' '));
  try {
    fn();
  } finally {
    console.log = original;
  }
  return lines.join('\n');
}

test('printRollupDashboard prints monthly fees with a real cadence', () => {
  const output = captureLog(() => printRollupDashboard({
    subs: [
      {
        id: 'claudemax',
        name: 'Claude Max',
        fee: 200,
        valueTotal: 500,
        roi: 2.5,
        verdict: 'keep',
        usedPct: null,
        usedSource: null,
      },
    ],
  }));
  assert.match(output, /\$200\/mo/);
  assert.doesNotMatch(output, /\/period/);
});

test('coverageNote is null when everything is scored', () => {
  assert.equal(coverageNote({ scored: 49, unscored: 0, unscoredActionable: 0, unscoredSpend: 0, incomplete: 0 }), null);
  assert.equal(coverageNote(undefined), null);
});

test('coverageNote names the gap and its dollar impact', () => {
  const note = coverageNote({ scored: 49, unscored: 33, unscoredActionable: 28, unscoredSpend: 1450.42, incomplete: 0 });
  assert.match(note, /28 usage model\(s\) unscored/);
  assert.match(note, /\$1450/);
  assert.match(note, /benchmark-inputs\.json/);
});

test('coverageNote reports incomplete registered models separately', () => {
  const note = coverageNote({ unscoredActionable: 0, unscoredSpend: 0, incomplete: 3 });
  assert.match(note, /3 registered model\(s\) incomplete/);
  assert.doesNotMatch(note, /usage model/);
});

test('printRollupDashboard labels zero-fee paths as free', () => {
  const output = captureLog(() => printRollupDashboard({
    subs: [
      {
        id: 'local',
        name: 'Local',
        fee: 0,
        valueTotal: 10,
        roi: null,
        verdict: 'keep',
        usedPct: null,
        usedSource: null,
      },
    ],
  }));
  assert.match(output, /\(FREE\)/);
});

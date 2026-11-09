'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { parseSinceArg, defaultSince } = require('../src/lib/since.js');

test('parseSinceArg returns YYYYMMDD for YYYY-MM-DD input', () => {
  assert.equal(parseSinceArg(['--since', '2026-05-01'], '20260101'), '20260501');
});

test('parseSinceArg returns YYYYMMDD for YYYYMMDD input', () => {
  assert.equal(parseSinceArg(['--since', '20260501'], '20260101'), '20260501');
});

test('parseSinceArg uses fallback when --since is missing', () => {
  assert.equal(parseSinceArg([]), '20260501');
});

test('parseSinceArg rejects invalid date strings', () => {
  assert.throws(() => parseSinceArg(['--since', 'not-a-date'], null), /Invalid date format/);
});

test('parseSinceArg rejects fallback when it is invalid', () => {
  assert.throws(() => parseSinceArg([], null), /Missing required argument: --since YYYY-MM-DD/);
});

test('defaultSince falls back to the private-history start without env', () => {
  assert.equal(defaultSince({}), '20260501');
});

test('defaultSince honors ROI_SINCE when set', () => {
  assert.equal(defaultSince({ ROI_SINCE: '20260101' }), '20260101');
});

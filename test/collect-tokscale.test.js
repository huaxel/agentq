'use strict';
/**
 * A following flag is not a --clients value: '--clients --daily' must mean
 * all clients, not a client literally named '--daily' (which would silently
 * return no data). Run with `npm test`.
 */
const { test } = require('node:test');
const assert = require('node:assert/strict');

const { parseClients } = require('../src/roi-tracker/collect/tokscale.js');

test('parseClients parses a comma list', () => {
  assert.deepEqual(parseClients(['--clients', 'pi,claude']), ['pi', 'claude']);
});

test('parseClients treats a following flag as no value (all clients)', () => {
  assert.deepEqual(parseClients(['--clients', '--daily']), []);
  assert.deepEqual(parseClients(['--clients']), []);
  assert.deepEqual(parseClients(['--since', '20260101']), []);
});
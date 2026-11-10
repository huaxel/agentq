'use strict';

/**
 * test/helpers/stderr.js: Node's own warnings are not agentq output.
 *
 * The helper is what makes an exact stderr comparison portable across Node
 * versions: Node 22 prints an ExperimentalWarning for node:sqlite before
 * agentq's message, Node 24 does not.
 */

const assert = require('node:assert/strict');
const test = require('node:test');

const { ownStderr } = require('./helpers/stderr.js');

const WARNING = '(node:4321) ExperimentalWarning: SQLite is an experimental feature and might change at any time';
const HINT = '(Use `node --trace-warnings ...` to show where the warning was created)';

test('ownStderr drops a Node warning and its hint line, keeping the message', () => {
  assert.equal(ownStderr(`${WARNING}\n${HINT}\nshow requires --id\n`), 'show requires --id');
});

test('ownStderr keeps a message with no warning and trims it', () => {
  assert.equal(ownStderr('\nshow requires --id\n\n'), 'show requires --id');
});

test('ownStderr of empty input is empty', () => {
  assert.equal(ownStderr(''), '');
});

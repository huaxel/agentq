'use strict';

/**
 * Fixtures for the executor result contract (AGENTQ_RESULT).
 *
 * Fake executors in the tests are shell scripts, so they cannot require this
 * module. `emitResult(root, payload)` returns a shell command that writes the
 * payload to $AGENTQ_RESULT atomically via helpers/write-result-file.js.
 */
const fs = require('node:fs');
const path = require('node:path');

const WRITER = path.join(__dirname, 'write-result-file.js');
let counter = 0;

function resultPayload(overrides = {}) {
  return {
    version: 1,
    worktree: null,
    branch: null,
    session: null,
    usage: null,
    verification: null,
    stop: false,
    ...overrides,
  };
}

function emitResult(root, payload) {
  const file = path.join(root, `result-payload-${process.pid}-${counter++}.json`);
  fs.writeFileSync(file, JSON.stringify(payload));
  return `node ${JSON.stringify(WRITER)} ${JSON.stringify(file)}`;
}

module.exports = { WRITER, resultPayload, emitResult };

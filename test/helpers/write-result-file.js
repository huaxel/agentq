#!/usr/bin/env node
'use strict';

/**
 * Test stand-in for a shipped executor: copy one prepared payload onto
 * $AGENTQ_RESULT atomically (tmp + rename in the same directory), exactly as
 * the documented executor contract requires. A no-op when AGENTQ_RESULT is
 * unset (a standalone run).
 *
 * The work happens in main() only: node's test runner treats every file under
 * test/ as a test file, so importing this module must have no side effects.
 */
const fs = require('node:fs');
const path = require('node:path');

function writeResult(source, target = process.env.AGENTQ_RESULT) {
  if (!target) return null;
  const data = fs.readFileSync(source, 'utf8');
  const tmp = path.join(path.dirname(target), `.${path.basename(target)}.${process.pid}.tmp`);
  fs.writeFileSync(tmp, data, { mode: 0o600 });
  fs.renameSync(tmp, target);
  return target;
}

if (require.main === module) {
  writeResult(process.argv[2]);
}

module.exports = { writeResult };

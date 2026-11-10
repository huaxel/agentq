#!/usr/bin/env node
'use strict';

/**
 * Read one executor input from stdin and print the fields the shell executors
 * need, NUL-delimited so trailing newlines survive without shell evaluation.
 *
 *   node src/runners/executor-input.js <issue-number|task-id>
 *
 * Queued mode (`AGENTQ_PINNED_INPUT=1`): stdin is the generic pinned task
 * input, and its digest must equal `AGENTQ_INPUT_SHA256`. A stripped
 * environment is a refusal, never a fallback to live GitHub text.
 *
 * Standalone mode: stdin is the raw `gh issue view` JSON, converted to the
 * same generic shape so every executor has one input contract.
 *
 * Output, in order: source, ref, title, body, slug. A leading `github` source
 * means the GitHub issue framing applies; `file` and `inline` are specs.
 */

const fs = require('node:fs');
const { taskInputFromGithubJson, taskSlug, validateTaskInput } = require('../core/task-input.js');

/**
 * @returns {void}
 */
function main() {
  const subject = process.argv[2] ?? '';
  const pinned = process.env.AGENTQ_PINNED_INPUT === '1';
  try {
    const raw = fs.readFileSync(0, 'utf8');
    let input;
    if (pinned) {
      input = validateTaskInput(JSON.parse(raw));
      if (input.sha256 !== process.env.AGENTQ_INPUT_SHA256) throw new Error('digest mismatch');
      // A GitHub task's subject is its issue number: a snapshot for another
      // issue must not be run under this task's identity.
      if (/^[0-9]+$/.test(subject) && input.source === 'github' && input.ref !== subject) {
        throw new Error('ref mismatch');
      }
    } else {
      if (!/^[0-9]+$/.test(subject)) throw new Error('standalone input needs an issue number');
      input = taskInputFromGithubJson(JSON.parse(raw));
      if (input.ref !== subject) throw new Error('ref mismatch');
    }
    process.stdout.write([
      input.source,
      input.ref ?? '',
      input.title,
      input.body,
      taskSlug(input),
    ].join('\0') + '\0');
  } catch {
    process.stderr.write('Invalid task input; enqueue a new job rather than fetching replacement text.\n');
    process.exitCode = 1;
  }
}

if (require.main === module) main();

module.exports = { taskSlug };

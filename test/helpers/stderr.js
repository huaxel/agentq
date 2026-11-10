'use strict';

/**
 * agentq's own stderr, without Node's runtime warnings.
 *
 * A child Node process prints its own warnings on stderr before agentq writes
 * anything. Node 22 flags node:sqlite as experimental, so it adds:
 *
 *   (node:1234) ExperimentalWarning: SQLite is an experimental feature and might change at any time
 *   (Use `node --trace-warnings ...` to show where the warning was created)
 *
 * Those lines are Node's, not agentq's, and they differ between Node versions.
 * A test that compares a CLI child's stderr exactly must strip them first, or
 * it passes on Node 24 and fails on Node 22 for a reason the product does not
 * control.
 */

/** The warning itself: `(node:<pid>) <Something>Warning: ...`. */
const NODE_WARNING = /^\(node:\d+\) \w*Warning:/;

/** The hint line Node prints after a warning. */
const TRACE_HINT = /^\(Use `node --trace-warnings/;

/**
 * @param {string} text raw child stderr
 * @returns {string} stderr without Node's own warning lines, trimmed
 */
function ownStderr(text) {
  if (typeof text !== 'string' || text === '') return '';
  return text
    .split('\n')
    .filter((line) => !NODE_WARNING.test(line) && !TRACE_HINT.test(line))
    .join('\n')
    .trim();
}

module.exports = { ownStderr };

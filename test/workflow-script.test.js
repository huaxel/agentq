'use strict';
/**
 * pi-workflow.sh embeds untrusted issue text into a generated JS workflow.
 * Shell quoting (${var@Q}) is not valid JavaScript and breaks on every
 * apostrophe or newline — issue text must be JSON-encoded instead. These
 * content assertions guard the encoding (the full generation needs gh/pi,
 * so it is verified out-of-band). Run with `npm test`.
 */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const ROOT = path.join(__dirname, '..');
const SCRIPT = fs.readFileSync(path.join(ROOT, 'pi-workflow.sh'), 'utf8');

function runWrapper(name, args) {
  return spawnSync('bash', [path.join(ROOT, name), ...args], { encoding: 'utf8', timeout: 15_000 });
}

test('pi-workflow.sh JSON-encodes issue text for JS embedding, not @Q', () => {
  assert.ok(!SCRIPT.includes('${title@Q}'), 'shell @Q quoting is invalid JavaScript');
  assert.ok(!SCRIPT.includes('${body@Q}'));
  assert.ok(SCRIPT.includes('jq -Rs'), 'issue text must be JSON-encoded via stdin rather than oversized arguments');
});

test('pi-workflow.sh JSON-encodes the stop condition', () => {
  // A raw single-quoted interpolation breaks on apostrophes and allows JS
  // injection into the workflow pi executes.
  assert.ok(!SCRIPT.includes("STOP_CONDITION = '${AGENTQ_STOP_WHEN}'"));
  assert.ok(SCRIPT.includes('const STOP_CONDITION = ${STOP_JS}'));
});

test('pi-workflow.sh JSON-encodes the issue title in the generated meta', () => {
  // The title is untrusted issue text; a raw interpolation into the
  // single-quoted description literal allows a title like
  // `x'); console.log(1); ('` to break out of the string literal. The body
  // and stop condition are jq-encoded; the title must be too (TITLE_JS).
  assert.ok(!SCRIPT.includes("description: 'Implement GitHub issue #${ISSUE}: ${title}'"));
  assert.ok(SCRIPT.includes("'Implement GitHub issue #${ISSUE}: ' + ${TITLE_JS}"));
});

for (const [wrapper, usage] of [
  ['pi-issue.sh', /usage: pi-issue\.sh <issue-number> <provider\/model>/],
  ['pi-workflow.sh', /usage: pi-workflow\.sh <issue-number> <provider\/model>/],
]) {
  test(`${wrapper} requires an explicit model instead of defaulting to a dropped subscription`, () => {
    const source = fs.readFileSync(path.join(ROOT, wrapper), 'utf8');
    assert.doesNotMatch(source, /MODEL="\$\{2:-[^}]+\}"/, 'a silent model default spends a subscription the caller may have dropped');

    // A missing model is a usage error, not a fallback. agentq always passes
    // the resolved model as the second argument.
    const missing = runWrapper(wrapper, ['42']);
    assert.equal(missing.status, 2);
    assert.match(missing.stderr, usage);

    // A flag in the model position must not be mistaken for a model id.
    const flag = runWrapper(wrapper, ['42', '--agentq-pinned-input']);
    assert.equal(flag.status, 2);
    assert.match(flag.stderr, usage);

    const none = runWrapper(wrapper, []);
    assert.equal(none.status, 2);
    assert.match(none.stderr, usage);
  });
}

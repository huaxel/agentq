'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('child_process');

const TRACKER = require.resolve('../src/roi-tracker/tracker.js');
const ROOT = path.join(__dirname, '..');

// tracker runs the pipeline when no roi-output exists, so give it an isolated
// temp copy of the synthetic fixture home.
const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'agentq-tracker-home-'));
fs.cpSync(path.join(ROOT, 'testdata', 'home'), HOME, { recursive: true });

function runTracker(args = [], home = HOME) {
  let stdout = '';
  let stderr = '';
  let exitCode = 0;
  try {
    stdout = execFileSync(process.execPath, [TRACKER, ...args], {
      encoding: 'utf8',
      timeout: 15_000,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, AGENTQ_HOME: home },
    });
  } catch (err) {
    stdout = err.stdout || '';
    stderr = err.stderr || '';
    exitCode = err.status ?? 1;
  }
  return { stdout, stderr, exitCode };
}

test('tracker --help prints usage without running the pipeline', () => {
  const { exitCode, stdout, stderr } = runTracker(['--help']);
  assert.equal(exitCode, 0);
  assert.match(stdout, /Usage: npm run tracker/);
  assert.doesNotMatch(stdout + stderr, /scoring pipeline|wrote data\/roi-output/);
});

test('pipeline gives a one-line hint when the home setup is missing', () => {
  const emptyHome = fs.mkdtempSync(path.join(os.tmpdir(), 'agentq-empty-home-'));
  const { exitCode, stdout, stderr } = runTracker([], emptyHome);
  assert.notEqual(exitCode, 0);
  assert.ok((stdout + stderr).includes(`no setup at ${path.join(emptyHome, 'config', 'roi.config.json')} — run 'agentq home init' or set AGENTQ_HOME`));
  assert.doesNotMatch(stdout + stderr, /profiles\\.tax missing/);
});

test('tracker rejects date flags that cannot affect existing pipeline data', () => {
  const { exitCode, stdout, stderr } = runTracker(['--since', '2026-05-01']);
  assert.notEqual(exitCode, 0);
  assert.match(stdout + stderr, /Use refresh --since/);
});

test('tracker prints the current dashboard', () => {
  const { exitCode, stdout } = runTracker();
  assert.equal(exitCode, 0);
  assert.match(stdout, /Subscription ROI Dashboard/);
});

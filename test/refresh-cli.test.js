'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync } = require('child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { collectMachineArgs } = require('../src/roi-tracker/refresh.js');

const REPO_ROOT = path.join(__dirname, '..');

// refresh.js (even with --no-collect) spawns the pipeline and renderer, which
// write ROI output and snapshots. Keep those writes in a disposable synthetic
// AGENTQ_HOME, never the developer's actual home or repository.
function isolatedRepoCopy() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'refresh-cli-'));
  fs.cpSync(path.join(REPO_ROOT, 'src'), path.join(dir, 'src'), { recursive: true });
  fs.cpSync(path.join(REPO_ROOT, 'config', 'defaults'), path.join(dir, 'config', 'defaults'), { recursive: true });
  fs.cpSync(path.join(REPO_ROOT, 'testdata', 'home', 'config'), path.join(dir, 'config'), { recursive: true });
  fs.cpSync(path.join(REPO_ROOT, 'testdata', 'home', 'data'), path.join(dir, 'data'), { recursive: true });
  return dir;
}

function runRefresh(args = []) {
  const repo = isolatedRepoCopy();
  const refreshScript = path.join(repo, 'src', 'roi-tracker', 'refresh.js');
  let stdout = '';
  let stderr = '';
  let exitCode = 0;
  try {
    stdout = execFileSync(process.execPath, [refreshScript, ...args], {
      encoding: 'utf8',
      timeout: 30_000,
      // The throwaway copy is the home: the child pipeline/render inherit it.
      env: { ...process.env, AGENTQ_HOME: repo },
    });
  } catch (err) {
    stdout = err.stdout || '';
    stderr = err.stderr || '';
    exitCode = err.status ?? 1;
  }
  return { stdout, stderr, exitCode };
}

test('refresh --help is side-effect-free and documents explicit git sync', () => {
  const { exitCode, stdout, stderr } = runRefresh(['--help']);
  assert.equal(exitCode, 0);
  assert.match(stdout, /Usage: npm run refresh/);
  assert.match(stdout, /Git synchronization is off by default/);
  assert.doesNotMatch(stdout + stderr, /scoring pipeline|collecting this machine/);
});

test('refresh --no-collect succeeds when --since is missing', () => {
  const { exitCode } = runRefresh(['--no-collect']);
  assert.equal(exitCode, 0);
});

test('refresh --no-collect exits non-zero for an invalid --since date', () => {
  const { exitCode, stderr } = runRefresh(['--no-collect', '--since', 'not-a-date']);
  assert.notEqual(exitCode, 0);
  assert.match(stderr, /Invalid date format/);
});

test('collectMachineArgs defaults to reusing a fresh bundle', () => {
  assert.deepEqual(collectMachineArgs([], {}), ['--max-age-min', '15']);
  assert.deepEqual(collectMachineArgs([], { REFRESH_MAX_AGE_MINUTES: '30' }), ['--max-age-min', '30']);
  assert.deepEqual(collectMachineArgs([], { USAGE_BUNDLE_MAX_AGE_MINUTES: '45' }), ['--max-age-min', '45']);
});

test('collectMachineArgs forwards freshness and git flags to collect-machine', () => {
  assert.deepEqual(
    collectMachineArgs(['--since', '2026-06-01', '--max-age-min', '60', '--sync-git']),
    ['--since', '2026-06-01', '--max-age-min', '60', '--sync-git'],
  );
  assert.deepEqual(
    collectMachineArgs(['--no-git'], {}),
    ['--max-age-min', '15', '--no-git'],
  );
});

test('collectMachineArgs forwards tokscale and daily flags to collect-machine', () => {
  assert.deepEqual(collectMachineArgs(['--tokscale'], {}), ['--max-age-min', '15', '--tokscale']);
  assert.deepEqual(collectMachineArgs(['--tokscale', '--daily'], {}), ['--max-age-min', '15', '--tokscale', '--daily']);
  // --daily without --tokscale is meaningless; still forwarded as passed
  assert.deepEqual(collectMachineArgs(['--daily', '--fresh'], {}), ['--daily']);
});

test('collectMachineArgs --fresh disables bundle reuse', () => {
  assert.deepEqual(collectMachineArgs(['--fresh'], {}), []);
  assert.deepEqual(collectMachineArgs(['--fresh', '--max-age-min', '60'], {}), []);
});

test('collectMachineArgs rejects invalid max age values', () => {
  assert.throws(
    () => collectMachineArgs(['--max-age-min', 'nope']),
    /Invalid value for --max-age-min/,
  );
  assert.throws(
    () => collectMachineArgs(['--max-age-min']),
    /Invalid value for --max-age-min/,
  );
  assert.throws(
    () => collectMachineArgs([], { REFRESH_MAX_AGE_MINUTES: 'nope' }),
    /Invalid value for REFRESH_MAX_AGE_MINUTES/,
  );
  assert.throws(
    () => collectMachineArgs([], { USAGE_BUNDLE_MAX_AGE_MINUTES: 'nope' }),
    /Invalid value for USAGE_BUNDLE_MAX_AGE_MINUTES/,
  );
});

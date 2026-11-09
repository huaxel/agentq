'use strict';
/**
 * `agentq home` and the routing commands against a temp AGENTQ_HOME: the
 * bootstrap command creates the layout, and snapshot/pick/status read only from
 * that home — never from the checkout.
 */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { execFileSync } = require('node:child_process');

const { CHEAP_MODEL, writeRoutingFixture } = require('./helpers/routing-fixture.js');

const AGENTQ = require.resolve('../src/interfaces/cli/agentq.js');
const EXAMPLES = path.join(__dirname, '..', 'examples', 'home', 'config');

function tmpdir(prefix = 'agentq-home-cli-') {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function run(args, env = {}) {
  try {
    const stdout = execFileSync(process.execPath, [AGENTQ, ...args], {
      encoding: 'utf8',
      env: { ...process.env, AGENTQ_QUOTA_REFRESH: '0', ...env },
      timeout: 30_000,
    });
    return { exitCode: 0, stdout, stderr: '' };
  } catch (err) {
    return { exitCode: err.status ?? 1, stdout: err.stdout || '', stderr: err.stderr || '' };
  }
}

test('agentq home init creates the layout and prints the home path', () => {
  const home = tmpdir();
  const result = run(['home', 'init'], { AGENTQ_HOME: home });
  assert.equal(result.exitCode, 0, result.stderr);
  assert.match(result.stdout, new RegExp(`home: ${home.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`));
  for (const name of fs.readdirSync(EXAMPLES)) {
    assert.ok(fs.existsSync(path.join(home, 'config', name)), `${name} should be seeded`);
    assert.match(result.stdout, new RegExp(`wrote\\s+config/${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`));
  }
  assert.ok(fs.statSync(path.join(home, 'data')).isDirectory());
});

test('a second init keeps the existing files and --force overwrites them', () => {
  const home = tmpdir();
  assert.equal(run(['home', 'init'], { AGENTQ_HOME: home }).exitCode, 0);
  const target = path.join(home, 'config', 'roi.config.json');
  fs.writeFileSync(target, '{"paths":[]}');

  const second = run(['home', 'init'], { AGENTQ_HOME: home });
  assert.equal(second.exitCode, 0, second.stderr);
  assert.equal(fs.readFileSync(target, 'utf8'), '{"paths":[]}');
  assert.match(second.stdout, /kept\s+config\/roi\.config\.json/);

  const forced = run(['home', 'init', '--force'], { AGENTQ_HOME: home });
  assert.equal(forced.exitCode, 0, forced.stderr);
  assert.notEqual(fs.readFileSync(target, 'utf8'), '{"paths":[]}');
  assert.match(forced.stdout, /wrote\s+config\/roi\.config\.json/);
});

test('agentq home prints the resolved path and which config files exist', () => {
  const home = tmpdir();
  const before = run(['home'], { AGENTQ_HOME: home });
  assert.equal(before.exitCode, 0, before.stderr);
  assert.match(before.stdout, new RegExp(`home: ${home.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`));
  assert.match(before.stdout, /missing config\/roi\.config\.json/);

  assert.equal(run(['home', 'init'], { AGENTQ_HOME: home }).exitCode, 0);
  const after = run(['home'], { AGENTQ_HOME: home });
  assert.match(after.stdout, /ok\s+config\/roi\.config\.json/);
  assert.doesNotMatch(after.stdout, /missing/);
});

test('agentq home rejects an unknown subcommand', () => {
  const home = tmpdir();
  const result = run(['home', 'nope'], { AGENTQ_HOME: home });
  assert.equal(result.exitCode, 1);
  assert.match(result.stderr, /unknown home command: nope/);
});

test('pick reads runnables, scores, quota and subscriptions from the temp home', () => {
  const fixture = writeRoutingFixture();
  const result = run(['pick', '--json'], fixture.env());
  assert.equal(result.exitCode, 0, result.stderr);
  const picked = JSON.parse(result.stdout);
  assert.equal(picked.default.id, CHEAP_MODEL);
  assert.equal(picked.default.path, 'mistral');
  assert.equal(picked.default.subscriptionState, 'active');
});

test('status opens the queue inside the temp home', () => {
  const fixture = writeRoutingFixture();
  const result = run(['status', '--json'], fixture.env());
  assert.equal(result.exitCode, 0, result.stderr);
  const status = JSON.parse(result.stdout);
  assert.ok(Array.isArray(status), 'an empty queue is an empty task list');
  assert.ok(fs.existsSync(path.join(fixture.home, 'data', 'orchestrator.sqlite')), 'the queue lives in the home');
  assert.ok(!fs.existsSync(path.join(__dirname, '..', 'data', 'orchestrator.sqlite')), 'never the checkout');
});

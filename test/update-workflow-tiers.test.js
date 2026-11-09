'use strict';

/**
 * bin/update-workflow-tiers.sh must never paper over an unroutable tier with a
 * hard-coded model: the existing value stays, the warning names the tier and
 * the resolver's message, and the script exits non-zero.
 *
 * Every test uses a temp HOME and routing fixtures, so the real
 * ~/.pi/workflows/model-tiers.json and data/ files are never touched.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const { CHEAP_MODEL, STRONG_MODEL, writeRoutingFixture } = require('./helpers/routing-fixture.js');

const ROOT = path.join(__dirname, '..');
const SCRIPT = path.join(ROOT, 'bin', 'update-workflow-tiers.sh');
const SCRIPT_SOURCE = fs.readFileSync(SCRIPT, 'utf8');

function home() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'agentq-tiers-home-'));
}

function tiersFile(homeDir) {
  return path.join(homeDir, '.pi', 'workflows', 'model-tiers.json');
}

function writeExisting(homeDir, value) {
  fs.mkdirSync(path.dirname(tiersFile(homeDir)), { recursive: true });
  fs.writeFileSync(tiersFile(homeDir), `${JSON.stringify(value, null, 2)}\n`);
}

function run(fixture, homeDir, args = []) {
  return spawnSync('bash', [SCRIPT, ...args], {
    encoding: 'utf8',
    timeout: 30_000,
    env: { ...process.env, HOME: homeDir, ...fixture.env() },
  });
}

// Only the 40-intelligence model is scored, so the big tier (floor 45) cannot
// resolve while small/medium still can.
function cheapOnlyFixture() {
  return writeRoutingFixture({
    roi: { models: [{ model: 'deepseek-v4-1-flash', genIntel: 40, mtok: 0.1 }] },
  });
}

test('the script has no hard-coded model fallbacks', () => {
  assert.doesNotMatch(SCRIPT_SOURCE, /\|\|\s*echo\s+"?(commandcode|openai-codex|cline-pass)/);
  assert.doesNotMatch(SCRIPT_SOURCE, /commandcode\/|openai-codex\//, 'tier models must come from the resolver');
});

test('resolves every tier and writes them with a timestamp', () => {
  const fixture = writeRoutingFixture();
  const homeDir = home();

  const result = run(fixture, homeDir);
  assert.equal(result.status, 0, result.stderr);

  const written = JSON.parse(fs.readFileSync(tiersFile(homeDir), 'utf8'));
  assert.equal(written.small, CHEAP_MODEL);
  assert.equal(written.medium, CHEAP_MODEL);
  assert.equal(written.big, STRONG_MODEL);
  assert.match(written.updatedAt, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/);
});

test('an unroutable tier keeps its existing value, warns, and exits non-zero', () => {
  const fixture = cheapOnlyFixture();
  const homeDir = home();
  writeExisting(homeDir, {
    small: 'old/small',
    medium: 'old/medium',
    big: 'kept/big',
    updatedAt: '2026-01-01T00:00:00Z',
  });

  const result = run(fixture, homeDir);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /tier 'big' did not resolve: No model available for auto routing \(tier big\)/);
  assert.match(result.stderr, /keeping the existing value for 'big'/);

  const written = JSON.parse(fs.readFileSync(tiersFile(homeDir), 'utf8'));
  assert.equal(written.small, CHEAP_MODEL);
  assert.equal(written.medium, CHEAP_MODEL);
  assert.equal(written.big, 'kept/big');
});

test('a failed tier with no existing value is not invented', () => {
  const fixture = cheapOnlyFixture();
  const homeDir = home();

  const result = run(fixture, homeDir);
  assert.notEqual(result.status, 0);

  const written = JSON.parse(fs.readFileSync(tiersFile(homeDir), 'utf8'));
  assert.equal(written.small, CHEAP_MODEL);
  assert.equal(written.big, undefined);
});

test('refuses to write an empty tiers file when nothing resolves', () => {
  const fixture = writeRoutingFixture({ quota: { generatedAt: new Date().toISOString(), paths: {} } });
  const homeDir = home();

  const result = run(fixture, homeDir);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /refusing to write an empty tiers file/);
  assert.equal(fs.existsSync(tiersFile(homeDir)), false);
});

test('--dry-run reports the merged values without writing', () => {
  const fixture = writeRoutingFixture();
  const homeDir = home();
  writeExisting(homeDir, { small: 'old/small', medium: 'old/medium', big: 'old/big' });
  const before = fs.readFileSync(tiersFile(homeDir), 'utf8');

  const result = run(fixture, homeDir, ['--dry-run']);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Would write to/);
  assert.match(result.stdout, new RegExp(CHEAP_MODEL.replace(/[/.]/g, '\\$&')));
  assert.equal(fs.readFileSync(tiersFile(homeDir), 'utf8'), before);
});

test('a malformed existing tiers file is an error, not silently replaced', () => {
  const fixture = writeRoutingFixture();
  const homeDir = home();
  fs.mkdirSync(path.dirname(tiersFile(homeDir)), { recursive: true });
  fs.writeFileSync(tiersFile(homeDir), '{ not json');

  const result = run(fixture, homeDir);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /cannot read existing/);
  assert.equal(fs.readFileSync(tiersFile(homeDir), 'utf8'), '{ not json');
});

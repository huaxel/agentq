'use strict';

/**
 * quota-resolver CLI contract: the shell wrappers (bin/resolve-model.sh,
 * .agents/skills/agentq/scripts/*.sh) read .model/.path/.headroom/.source from
 * --json and rely on plain mode printing the model id, exiting 1 with a stderr
 * message when nothing is eligible.
 */

const assert = require('node:assert/strict');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const test = require('node:test');

const {
  CHEAP_MODEL,
  STRONG_MODEL,
  quotaFixture,
  writeRoutingFixture,
} = require('./helpers/routing-fixture.js');

const RESOLVER = path.join(__dirname, '..', 'src', 'lib', 'quota-resolver.js');

function run(args, fixture, env = {}) {
  try {
    const stdout = execFileSync(process.execPath, [RESOLVER, ...args], {
      encoding: 'utf8',
      env: { ...process.env, ...fixture.env(), ...env },
      timeout: 30_000,
    });
    return { exitCode: 0, stdout, stderr: '' };
  } catch (error) {
    return { exitCode: error.status ?? 1, stdout: error.stdout || '', stderr: error.stderr || '' };
  }
}

test('plain --tier prints only the model id on stdout', () => {
  const fixture = writeRoutingFixture();
  const result = run(['--tier', 'medium'], fixture);
  assert.equal(result.exitCode, 0);
  assert.equal(result.stdout.trim(), CHEAP_MODEL);
  assert.equal(result.stderr, '');
});

test('--json --tier keeps the fields the shell wrappers read', () => {
  const fixture = writeRoutingFixture();
  const result = run(['--tier', 'medium', '--json'], fixture);
  assert.equal(result.exitCode, 0);
  const resolved = JSON.parse(result.stdout);
  assert.equal(resolved.model, CHEAP_MODEL);
  assert.equal(resolved.path, 'mistral');
  assert.equal(resolved.tier, 'medium');
  assert.equal(resolved.headroom, 90);
  assert.equal(resolved.source, 'routing');
});

test('--tier big honours the higher intelligence floor', () => {
  const fixture = writeRoutingFixture();
  const result = run(['--tier', 'big', '--json'], fixture);
  assert.equal(JSON.parse(result.stdout).model, STRONG_MODEL);
});

test('no eligible model exits 1 with the routing error on stderr', () => {
  const fixture = writeRoutingFixture({ quota: { generatedAt: new Date().toISOString(), paths: {} } });
  const result = run(['--tier', 'medium'], fixture);
  assert.equal(result.exitCode, 1);
  assert.equal(result.stdout, '');
  assert.match(result.stderr, /No model available for auto routing \(tier medium\): /);
  assert.match(result.stderr, /capacity unknown/);
});

test('--fallback prints the fallback model instead of failing', () => {
  const fixture = writeRoutingFixture({ quota: { generatedAt: new Date().toISOString(), paths: {} } });
  const result = run(['--tier', 'medium', '--fallback', 'fallback/model'], fixture);
  assert.equal(result.exitCode, 0);
  assert.equal(result.stdout.trim(), 'fallback/model');

  const json = JSON.parse(run(['--tier', 'medium', '--fallback', 'fallback/model', '--json'], fixture).stdout);
  assert.equal(json.source, 'fallback');
  assert.equal(json.path, 'fallback');
});

test('--check reports the capacity entry and eligibility', () => {
  const fixture = writeRoutingFixture();
  const result = run(['--check', CHEAP_MODEL, '--json'], fixture);
  assert.equal(result.exitCode, 0);
  const checked = JSON.parse(result.stdout);
  assert.equal(checked.model, CHEAP_MODEL);
  assert.equal(checked.path, 'mistral');
  assert.equal(checked.headroom, true);
  assert.equal(checked.usedPercent, 10);
  assert.equal(checked.eligible, true);
  assert.equal(checked.capacity.state, 'available');

  const saturated = writeRoutingFixture({ quota: quotaFixture({ mistral: 95 }) });
  const notEligible = JSON.parse(run(['--check', CHEAP_MODEL, '--json'], saturated).stdout);
  assert.equal(notEligible.headroom, false);
  assert.equal(notEligible.eligible, false);
  assert.match(notEligible.reasons.join(' '), /capacity saturated/);
});

test('--check on a model outside the catalog reports unknown capacity and ineligibility', () => {
  const fixture = writeRoutingFixture();
  const checked = JSON.parse(run(['--check', 'not/a-runnable', '--json'], fixture).stdout);
  assert.equal(checked.eligible, false);
  assert.equal(checked.headroom, null);
  assert.match(checked.reasons.join(' '), /not a runnable/);
});

test('--all --json reports every tier', () => {
  const fixture = writeRoutingFixture();
  const result = run(['--all', '--json'], fixture);
  assert.equal(result.exitCode, 0);
  const all = JSON.parse(result.stdout);
  assert.deepEqual(Object.keys(all), ['small', 'medium', 'big']);
  assert.equal(all.medium.model, CHEAP_MODEL);
  assert.equal(all.big.model, STRONG_MODEL);
});

test('--quota overrides the environment quota path', () => {
  const fixture = writeRoutingFixture();
  const other = writeRoutingFixture({ quota: { generatedAt: new Date().toISOString(), paths: {} } });
  const result = run(['--tier', 'medium', '--quota', other.quotaPath], fixture);
  assert.equal(result.exitCode, 1);
  assert.match(result.stderr, /No model available for auto routing/);
});

test('--threshold tightens the capacity cutoff', () => {
  // 96% used leaves 4% headroom: saturated at the default 85 threshold,
  // available once the threshold asks for only 1% headroom.
  const fixture = writeRoutingFixture({ quota: quotaFixture({ mistral: 96 }) });
  assert.equal(run(['--tier', 'medium'], fixture).stdout.trim(), STRONG_MODEL);
  assert.equal(run(['--tier', 'medium', '--threshold', '99'], fixture).stdout.trim(), CHEAP_MODEL);
});

test('an unknown tier exits 1 with a usage-style error', () => {
  const fixture = writeRoutingFixture();
  const result = run(['--tier', 'huge'], fixture);
  assert.equal(result.exitCode, 1);
  assert.match(result.stderr, /Unknown tier: huge/);
});

test('--threshold rejects non-numeric and out-of-range values as usage errors', () => {
  const fixture = writeRoutingFixture();
  for (const value of ['abc', '0', '-5', '101', '']) {
    const result = run(['--tier', 'medium', '--threshold', value], fixture);
    assert.equal(result.exitCode, 1, `threshold ${JSON.stringify(value)} must be rejected`);
    assert.match(result.stderr, /--threshold must be a number greater than 0 and at most 100/);
    assert.match(result.stderr, /Usage: quota-resolver\.js/);
    assert.equal(result.stdout, '');
  }

  const missing = run(['--tier', 'medium', '--threshold'], fixture);
  assert.equal(missing.exitCode, 1);
  assert.match(missing.stderr, /--threshold must be a number greater than 0 and at most 100, got: nothing/);
});

test('--threshold accepts the inclusive upper bound', () => {
  const fixture = writeRoutingFixture();
  const result = run(['--tier', 'medium', '--threshold', '100'], fixture);
  assert.equal(result.exitCode, 0, result.stderr);
  assert.equal(result.stdout.trim(), CHEAP_MODEL);
});

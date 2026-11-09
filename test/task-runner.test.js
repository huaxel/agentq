'use strict';

/**
 * The task runner contract: package.json scripts are the source of truth, and
 * the justfile is only a thin alias layer over them. A Makefile is gone on
 * purpose (one runner, one lockfile), so this test fails if either drifts back.
 */

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const ROOT = path.join(__dirname, '..');
const pkg = require('../package.json');

/** Parse the justfile into { recipe: [command lines] }. */
function readJustfile() {
  const source = fs.readFileSync(path.join(ROOT, 'justfile'), 'utf8');
  /** @type {Map<string, string[]>} */
  const recipes = new Map();
  let current = null;
  for (const line of source.split('\n')) {
    if (line.trim() === '' || line.trimStart().startsWith('#')) continue;
    if (!line.startsWith(' ') && !line.startsWith('\t')) {
      const match = line.match(/^([A-Za-z0-9_-]+)(?:\s+\*?[A-Z_]+)?\s*:/);
      current = match ? match[1] : null;
      if (current) recipes.set(current, []);
      continue;
    }
    if (current) recipes.get(current).push(line.trim());
  }
  return recipes;
}

test('there is exactly one task runner: npm scripts', () => {
  assert.equal(fs.existsSync(path.join(ROOT, 'Makefile')), false, 'the Makefile is deleted; use npm run');
  assert.equal(fs.existsSync(path.join(ROOT, 'makefile')), false);
  assert.equal(fs.existsSync(path.join(ROOT, 'GNUmakefile')), false);
});

test('package.json owns the collection entry points', () => {
  assert.equal(pkg.scripts.collect, 'npm run collect-machine --');
  assert.equal(pkg.scripts['collect:sync'], 'npm run collect-machine -- --tokscale --daily --sync-git');
  assert.equal(pkg.scripts.check, 'npm run lint && npm run typecheck && bash -n pi-issue.sh claude-issue.sh pi-workflow.sh bin/*.sh .agents/skills/agentq/scripts/*.sh && npm test && npm run verify:fixtures');
});

test('package.json owns the docker and clean entry points', () => {
  assert.equal(pkg.scripts['docker-build'], 'docker build -t sub-roi-dashboard .');
  assert.equal(pkg.scripts['docker-up'], 'docker compose up --build -d');
  assert.equal(pkg.scripts['docker-down'], 'docker compose down');
  assert.match(pkg.scripts['docker-logs'], /^docker compose logs/);
  assert.match(pkg.scripts.clean, /^rm -f /);
});

test('every justfile recipe is a thin alias for an npm command', () => {
  const recipes = readJustfile();
  assert.ok(recipes.size >= 10, `expected the alias recipes, saw ${recipes.size}`);
  for (const [name, body] of recipes) {
    assert.ok(body.length > 0, `${name} has no command`);
    for (const command of body) {
      assert.match(
        command,
        /^npm (run [a-z:*-]+( --)?|ci|test)/,
        `${name}: "${command}" must call an npm script, not do work of its own`,
      );
    }
  }
});

test('the justfile aliases the documented workflows', () => {
  const recipes = readJustfile();
  for (const name of ['ci', 'check', 'test', 'build', 'clean', 'collect', 'collect-sync', 'docker-up', 'docker-down']) {
    assert.ok(recipes.has(name), `missing justfile recipe: ${name}`);
  }
  assert.match(recipes.get('collect').join('\n'), /npm run collect -- --tokscale --daily/);
  assert.match(recipes.get('collect-sync').join('\n'), /--sync-git/);
});

test('the package bin map points at real entry points', () => {
  for (const [name, target] of Object.entries(pkg.bin)) {
    assert.ok(fs.existsSync(path.join(ROOT, target)), `bin ${name} points at a missing file: ${target}`);
  }
  assert.equal(pkg.bin.agentq, 'bin/agentq.js');
  assert.equal(pkg.bin['agentq-mcp'], 'bin/agentq-mcp.js');
});

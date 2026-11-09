'use strict';
/**
 * The personal-trace guard must be testable without any real personal data:
 * every name here is invented, and the deny list lives in a temp dir.
 */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync, spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const SCRIPT = path.join(__dirname, '..', 'scripts', 'scan-personal.js');

function tempRepo() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'scan-personal-'));
  execFileSync('git', ['init', '-q'], { cwd: dir });
  return dir;
}

function writeTracked(dir, name, content) {
  const file = path.join(dir, name);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
  execFileSync('git', ['add', name], { cwd: dir });
  return file;
}

function run(args, cwd, env = {}) {
  return spawnSync(process.execPath, [SCRIPT, ...args], {
    cwd,
    encoding: 'utf8',
    env: { ...process.env, AGENTQ_DENY_LIST: '', ...env },
  });
}

test('scan-personal reports file:line for each match and exits 1', () => {
  const repo = tempRepo();
  const deny = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'scan-deny-')), 'deny.txt');
  fs.writeFileSync(deny, '# invented terms\nhomelab-llm\ndevbox\n');
  writeTracked(repo, 'src/ok.js', 'const a = 1;\n');
  writeTracked(repo, 'src/leak.js', 'const host = "homelab-llm";\nconst box = "devbox";\n');

  const res = run(['--deny', deny], repo);

  assert.equal(res.status, 1);
  assert.match(res.stdout, /^src\/leak\.js:1: homelab-llm$/m);
  assert.match(res.stdout, /^src\/leak\.js:2: devbox$/m);
  assert.doesNotMatch(res.stdout, /src\/ok\.js/);
});

test('scan-personal exits 0 when the deny list matches nothing', () => {
  const repo = tempRepo();
  const deny = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'scan-deny-')), 'deny.txt');
  fs.writeFileSync(deny, 'homelab-llm\n');
  writeTracked(repo, 'src/ok.js', 'const a = 1;\n');

  const res = run(['--deny', deny], repo);

  assert.equal(res.status, 0);
  assert.equal(res.stdout.trim(), '');
});

test('scan-personal skips package-lock.json', () => {
  const repo = tempRepo();
  const deny = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'scan-deny-')), 'deny.txt');
  fs.writeFileSync(deny, 'homelab-llm\n');
  writeTracked(repo, 'package-lock.json', '{"host":"homelab-llm"}\n');

  const res = run(['--deny', deny], repo);

  assert.equal(res.status, 0);
});

test('scan-personal accepts the deny list from AGENTQ_DENY_LIST', () => {
  const repo = tempRepo();
  const deny = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'scan-deny-')), 'deny.txt');
  fs.writeFileSync(deny, 'homelab-llm\n');
  writeTracked(repo, 'src/leak.js', 'const host = "homelab-llm";\n');

  const res = run([], repo, { AGENTQ_DENY_LIST: deny });

  assert.equal(res.status, 1);
  assert.match(res.stdout, /^src\/leak\.js:1: homelab-llm$/m);
});

test('scan-personal prints usage and exits 0 without a deny list', () => {
  const repo = tempRepo();
  writeTracked(repo, 'src/leak.js', 'const host = "homelab-llm";\n');

  const res = run([], repo);

  assert.equal(res.status, 0);
  assert.match(res.stdout, /Usage: node scripts\/scan-personal\.js --deny <file>/);
  assert.equal(res.stdout.includes('leak.js'), false);
});

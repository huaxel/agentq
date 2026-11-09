'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const {
  validatePrompt,
  DEFAULT_CUA_IMAGE,
  safeGuestPath,
  truncateUtf8,
  validatePatchTargets,
  validateSourcePaths,
  assertCleanWorktree,
  archiveTrackedSource,
  resolveCuaEntry,
  makeSerial,
  createTools,
  runGuest,
} = require('../src/runners/cua-feedback.js');


test('default sandbox image uses the canonical CUA Linux image', () => {
  assert.equal(DEFAULT_CUA_IMAGE, 'ghcr.io/trycua/linux:24.04');
});

test('feedback prompt is non-empty and byte-bounded', () => {
  assert.equal(validatePrompt('  a task  '), '  a task  ');
  assert.throws(() => validatePrompt('  '), /empty/i);
  assert.throws(() => validatePrompt('éé', 3), /exceeds 3 bytes/i);
});

test('guest file tools reject absolute, traversal, metadata, and dependency paths', () => {
  assert.equal(safeGuestPath('/guest/work', 'src/app.js'), '/guest/work/src/app.js');
  for (const candidate of ['/etc/passwd', '../secret', 'src/../../secret', '.git/config', 'node_modules/pkg']) {
    assert.throws(() => safeGuestPath('/guest/work', candidate), /not allowed|escapes|protected/i);
  }
});

test('tool output truncation is byte-bounded and reports its state', () => {
  assert.deepEqual(truncateUtf8(Buffer.from('short'), 5), { text: 'short', truncated: false });
  assert.deepEqual(truncateUtf8(Buffer.from('longer'), 4), { text: 'long', truncated: true });
});

test('guest patch validation rejects host paths, sensitive config, and symlinks', () => {
  assert.equal(validatePatchTargets(['src/app.js'], Buffer.from('diff --git a/src/app.js b/src/app.js\n')).length > 0, true);
  for (const candidate of ['/tmp/outside', '../outside', '.git/config', 'node_modules/x', '.env', '.pi/auth.json']) {
    assert.throws(() => validatePatchTargets([candidate], Buffer.from('diff\n')));
  }
  assert.throws(() => validatePatchTargets(['src/link'], Buffer.from('new file mode 120000\n')), /symlink/i);
});

test('CUA package resolution supports import-only ESM exports', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agentq-cua-esm-test-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const entry = path.join(root, 'node_modules', '@trycua', 'cua', 'dist', 'index.js');
  fs.mkdirSync(path.dirname(entry), { recursive: true });
  fs.writeFileSync(path.join(root, 'node_modules', '@trycua', 'cua', 'package.json'), JSON.stringify({
    name: '@trycua/cua', type: 'module', main: './dist/index.js',
    exports: { '.': { types: './dist/index.d.ts', import: './dist/index.js' } },
  }));
  fs.writeFileSync(entry, 'export {};');
  assert.equal(resolveCuaEntry(root), require('node:url').pathToFileURL(entry).href);
  assert.throws(() => resolveCuaEntry(path.join(root, 'missing')), /must have @trycua\/cua installed/);
});

test('tracked-source path filter refuses credentials and host configuration', () => {
  for (const candidate of ['.env', 'nested/.env.production', '.npmrc', '.pi/agent/auth.json', 'id_ed25519', 'certs/key.pem']) {
    assert.throws(() => validateSourcePaths([candidate]), /sensitive-looking/i);
  }
  assert.deepEqual(validateSourcePaths(['src/app.js', 'config/settings.sample', '.env.example']), ['src/app.js', 'config/settings.sample', '.env.example']);
});

test('tracked-source staging requires a clean repository and creates a HEAD-only archive', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agentq-cua-source-test-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  execFileSync('git', ['init', '-q', root]);
  execFileSync('git', ['-C', root, 'config', 'user.name', 'test']);
  execFileSync('git', ['-C', root, 'config', 'user.email', 'test@example.invalid']);
  fs.writeFileSync(path.join(root, 'tracked.txt'), 'tracked');
  execFileSync('git', ['-C', root, 'add', 'tracked.txt']);
  execFileSync('git', ['-C', root, 'commit', '-qm', 'base']);
  assert.equal(assertCleanWorktree(root), fs.realpathSync(root));
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'agentq-cua-archive-test-'));
  t.after(() => fs.rmSync(temp, { recursive: true, force: true }));
  const archive = archiveTrackedSource(root, temp);
  const listing = execFileSync('tar', ['-tzf', archive], { encoding: 'utf8' });
  assert.match(listing, /tracked\.txt/);
  fs.writeFileSync(path.join(root, 'dirty.txt'), 'untracked');
  assert.throws(() => assertCleanWorktree(root), /dirty/i);
});

test('Pi custom tool schemas expose only serialized guest operations', async () => {
  const pi = await import('@earendil-works/pi-coding-agent');
  const TypeBox = await import('typebox');
  const tools = await createTools({
    Type: TypeBox.Type,
    defineTool: pi.defineTool,
    spacesd: {},
    serial: makeSerial(),
    getSession: () => null,
  });
  assert.deepEqual(tools.map(tool => tool.name), ['guest_bash', 'guest_read', 'guest_write', 'guest_edit']);
  assert.ok(tools.every(tool => tool.executionMode === 'sequential'));
});

test('guest process output is capped without buffering unbounded output', async () => {
  const events = [
    { kind: 0, data: Buffer.from('12345') },
    { kind: 3, exit: { code: 137 } },
  ];
  const spacesd = {
    spawn: async command => {
      assert.equal(command.program, '/bin/sh');
      assert.equal(command.timeoutMs, 5_000);
      return {
        nextEvent: async () => events.shift(),
      };
    },
  };
  const result = await runGuest(spacesd, 'echo not-on-host', 5_000, 4);
  assert.equal(result.stdout, '1234');
  assert.equal(result.truncated, true);
});

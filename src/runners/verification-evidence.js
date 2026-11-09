'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { execFileSync } = require('node:child_process');

function fail(reason) {
  throw Object.assign(new Error(reason), { snapshotReason: reason });
}

function part(hash, value) {
  const bytes = Buffer.isBuffer(value) ? value : Buffer.from(value);
  hash.update(`${bytes.length}:`);
  hash.update(bytes);
}

function safeParents(file, root) {
  const relative = path.relative(root, path.dirname(file));
  if (path.isAbsolute(relative) || relative === '..' || relative.startsWith(`..${path.sep}`)) fail('unsafe-path');
  let parent = root;
  for (const name of relative.split(path.sep).filter(Boolean)) {
    parent = path.join(parent, name);
    const stat = fs.lstatSync(parent);
    if (stat.isSymbolicLink()) fail('symlinked-ancestor');
    if (!stat.isDirectory()) fail('unsupported-file-type');
  }
}

// A bounded content identity, not a hermetic execution boundary. Ignored file
// contents, outside dependencies/services, and change-then-restore are outside
// its scope. Submodules and nested repositories require separate evidence.
function captureGitSnapshot(cwd, { maxFiles = 10_000, maxBytes = 64 * 1024 * 1024, maxMs = 2000 } = {}) {
  try {
    if (![maxFiles, maxBytes, maxMs].every(value => Number.isSafeInteger(value) && value >= 0)) fail('invalid-snapshot-budget');
    const deadline = Date.now() + maxMs;
    const checkTime = () => { if (Date.now() >= deadline) fail('snapshot-timeout'); };
    let bytes = 0n;
    const charge = size => {
      checkTime();
      if (size > BigInt(maxBytes) - bytes) fail('snapshot-too-large');
      bytes += size;
    };
    const root = fs.realpathSync.native(cwd);
    const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_')));
    Object.assign(env, {
      GIT_OPTIONAL_LOCKS: '0', GIT_CONFIG_NOSYSTEM: '1',
      GIT_CONFIG_GLOBAL: os.devNull, GIT_TERMINAL_PROMPT: '0', LC_ALL: 'C',
    });
    const git = (...args) => {
      checkTime();
      return execFileSync('git', ['-c', 'core.fsmonitor=false', '-c', `core.excludesFile=${os.devNull}`, '-C', root, ...args], {
        stdio: ['ignore', 'pipe', 'pipe'], timeout: Math.max(1, deadline - Date.now()), maxBuffer: 4 * 1024 * 1024, env,
      });
    };
    let top;
    try { top = git('rev-parse', '--show-toplevel').toString('utf8').replace(/\n$/, ''); }
    catch (error) {
      if (!error.snapshotReason && error.status === 128 && String(error.stderr).includes('not a git repository')) {
        try { fs.lstatSync(path.join(root, '.git')); }
        catch (markerError) { if (markerError.code === 'ENOENT') fail('not-git'); }
      }
      throw error;
    }
    if (fs.realpathSync.native(top) !== root) fail('not-repository-root');
    const head = git('rev-parse', '--verify', 'HEAD').toString('utf8').trim();
    const buffer = Buffer.allocUnsafe(64 * 1024);
    const readRegular = (file, stat) => {
      if (!stat.isFile()) fail('unsupported-file-type');
      charge(stat.size);
      const fd = fs.openSync(file, fs.constants.O_RDONLY
        | (fs.constants.O_NOFOLLOW || 0) | (fs.constants.O_NONBLOCK || 0));
      const contents = createHash('sha256');
      try {
        const before = fs.fstatSync(fd, { bigint: true });
        if (!before.isFile() || before.dev !== stat.dev || before.ino !== stat.ino || before.size !== stat.size) fail('file-changed-during-capture');
        let remaining = before.size;
        while (remaining > 0n) {
          checkTime();
          const length = fs.readSync(fd, buffer, 0, Number(remaining < BigInt(buffer.length) ? remaining : BigInt(buffer.length)), null);
          if (length === 0) fail('file-changed-during-capture');
          contents.update(buffer.subarray(0, length));
          remaining -= BigInt(length);
        }
        const after = fs.fstatSync(fd, { bigint: true });
        for (const field of ['dev', 'ino', 'size', 'mtimeNs', 'ctimeNs', 'mode']) {
          if (before[field] !== after[field]) fail('file-changed-during-capture');
        }
        return { executable: Number(before.mode & 0o111n), digest: contents.digest('hex') };
      } finally {
        fs.closeSync(fd);
      }
    };
    // --exclude-standard consults local info/exclude too. Bind its exact bytes,
    // while suppressing user/global excludes so host policy cannot hide inputs.
    const commonName = git('rev-parse', '--git-common-dir').toString('utf8').replace(/\n$/, '');
    const common = fs.realpathSync.native(path.resolve(root, commonName));
    const exclude = path.join(common, 'info', 'exclude');
    let localExcludes = null;
    let excludeStat;
    try { excludeStat = fs.lstatSync(exclude, { bigint: true }); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    if (excludeStat) {
      safeParents(exclude, common);
      if (excludeStat.isSymbolicLink()) fail('symlinked-ignore-policy');
      localExcludes = readRegular(exclude, excludeStat).digest;
    }
    const index = git('ls-files', '--stage', '-z');
    const listed = git('ls-files', '--cached', '--others', '--exclude-standard', '-z');
    const text = listed.toString('utf8');
    if (!Buffer.from(text).equals(listed)) fail('unsupported-filename-encoding');
    const names = [...new Set(text.split('\0').filter(Boolean))].sort();
    if (names.length > maxFiles) fail('snapshot-too-large');
    const hash = createHash('sha256');
    part(hash, 'agentq-git-visible-v2');
    part(hash, head);
    part(hash, index);
    part(hash, JSON.stringify(['local-excludes', localExcludes]));
    for (const name of names) {
      checkTime();
      if (path.isAbsolute(name) || name.split('/').some(segment => segment === '..' || segment === '.git')) fail('unsafe-path');
      const file = path.join(root, name);
      let stat;
      try { stat = fs.lstatSync(file, { bigint: true }); }
      catch (error) {
        if (error.code !== 'ENOENT') throw error;
        part(hash, JSON.stringify([name, 'missing']));
        continue;
      }
      safeParents(file, root);
      if (stat.isSymbolicLink()) {
        charge(stat.size);
        part(hash, JSON.stringify([name, 'symlink']));
        part(hash, fs.readlinkSync(file, { encoding: 'buffer' }));
      } else {
        const content = readRegular(file, stat);
        part(hash, JSON.stringify([name, 'file', content.executable, content.digest]));
      }
    }
    checkTime();
    return { available: true, version: 2, scope: 'git-visible-files', head, digest: hash.digest('hex'), files: names.length, bytes: Number(bytes), local_excludes_digest: localExcludes };
  } catch (error) {
    // No file contents, stderr or host paths in persisted failure evidence.
    return { available: false, reason: error.snapshotReason || (error.code === 'ETIMEDOUT' ? 'snapshot-timeout' : 'git-or-file-read-failed') };
  }
}

module.exports = { captureGitSnapshot };

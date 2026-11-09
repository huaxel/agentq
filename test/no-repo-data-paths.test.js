'use strict';

/**
 * Enforcement: no runtime code may build a path into the checkout's `data/` or
 * `config/` directory.
 *
 * The repository holds code, the method's defaults and examples. Everything
 * personal (subscriptions, path maps, usage, quota, prices, snapshots, the
 * queue) lives in AGENTQ_HOME (src/lib/home.js). This test keeps future code
 * from coupling back to the repo: it resolves every literal `path.join(...)` /
 * `path.resolve(...)` call anchored at a repo-root constant and fails when the
 * result lands in `<repo>/data` or `<repo>/config`.
 *
 * The scan is textual, so it also follows aliases: `const ROOT = path.join(
 * __dirname, '..')` makes ROOT a repo root, and `const BASE = path.join(ROOT)`
 * inherits that. A join over a variable that is not a known repo root is left
 * alone (it may be a temp dir or the home).
 *
 * `<repo>/config/defaults` is the one allowed exception: those files are the
 * method, not a setup, and are tracked on purpose.
 */

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const { execFileSync } = require('node:child_process');

const ROOT = path.join(__dirname, '..');
const SCAN_DIRS = ['src', 'bin'];
const ALLOWED_CONFIG_SUBDIR = path.join(ROOT, 'config', 'defaults');
const PATH_MODULE = String.raw`(?:path|require\(\s*['"]node:path['"]\s*\))`;
const CALL = new RegExp(`${PATH_MODULE}\\.(?:join|resolve)\\(`, 'g');
const ASSIGN = new RegExp(`(?:const|let|var)\\s+([A-Za-z_$][\\w$]*)\\s*=\\s*${PATH_MODULE}\\.(?:join|resolve)\\(`, 'g');

function walk(dir, out = []) {
  if (!fs.existsSync(dir)) return out;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, out);
    else if (entry.isFile() && (full.endsWith('.js') || full.endsWith('.sh'))) out.push(full);
  }
  return out;
}

/** Split a call's argument text on top-level commas. */
function splitArgs(text) {
  const args = [];
  let depth = 0;
  let quote = null;
  let current = '';
  for (const ch of text) {
    if (quote) {
      current += ch;
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === "'" || ch === '"' || ch === '`') { quote = ch; current += ch; continue; }
    if (ch === '(' || ch === '[' || ch === '{') depth++;
    if (ch === ')' || ch === ']' || ch === '}') depth--;
    if (ch === ',' && depth === 0) { args.push(current.trim()); current = ''; continue; }
    current += ch;
  }
  if (current.trim()) args.push(current.trim());
  return args;
}

/** The argument text of the call whose `(` ends at `openIndex`. */
function callArgs(source, openIndex) {
  let depth = 1;
  let quote = null;
  let index = openIndex;
  for (; index < source.length && depth > 0; index++) {
    const ch = source[index];
    if (quote) {
      if (ch === quote && source[index - 1] !== '\\') quote = null;
      continue;
    }
    if (ch === "'" || ch === '"' || ch === '`') { quote = ch; continue; }
    if (ch === '(') depth++;
    else if (ch === ')') depth--;
  }
  return splitArgs(source.slice(openIndex, index - 1));
}

/**
 * Every literal path.join/path.resolve call in a file.
 * @param {string} file
 */
function pathCalls(file) {
  const source = fs.readFileSync(file, 'utf8');
  const calls = [];
  for (const match of source.matchAll(CALL)) {
    const line = source.slice(0, match.index).split('\n').length;
    calls.push({ line, args: callArgs(source, match.index + match[0].length) });
  }
  return calls;
}

/** A literal string argument, or null for a non-literal. */
function literal(arg) {
  const match = arg.match(/^(['"])(.*)\1$/);
  return match ? match[2] : null;
}

/**
 * Identifiers that resolve to the repository root, per file.
 *
 * Starts from `__dirname` and a bare `ROOT`, then repeatedly folds assignments
 * like `const BASE = path.join(__dirname, '..', '..')` into the set when they
 * resolve to the repo root.
 *
 * @param {string} file
 * @returns {Map<string, string>} identifier -> resolved base
 */
function repoRoots(file) {
  const source = fs.readFileSync(file, 'utf8');
  const roots = new Map([
    ['__dirname', path.dirname(file)],
    ['ROOT', ROOT],
    ['root', ROOT],
  ]);
  let changed = true;
  while (changed) {
    changed = false;
    for (const match of source.matchAll(ASSIGN)) {
      const name = match[1];
      if (roots.has(name)) continue;
      const args = callArgs(source, match.index + match[0].length);
      const values = args.map((arg) => (roots.has(arg) ? roots.get(arg) : literal(arg)));
      if (values.some((value) => value === null)) continue;
      const resolved = path.resolve(...values);
      roots.set(name, resolved);
      changed = true;
    }
  }
  return roots;
}

function isRepoDataOrConfig(target) {
  const rel = path.relative(ROOT, target);
  if (rel.startsWith('..') || path.isAbsolute(rel)) return false;
  const inside = (dir) => rel === dir || rel.startsWith(`${dir}${path.sep}`);
  if (inside('data')) return true;
  if (!inside('config')) return false;
  // config/defaults is the tracked method, not a setup.
  return !(target === ALLOWED_CONFIG_SUBDIR || target.startsWith(`${ALLOWED_CONFIG_SUBDIR}${path.sep}`));
}

test('no source file builds a path into the checkout data/ or config/', () => {
  const violations = [];
  for (const file of SCAN_DIRS.flatMap((dir) => walk(path.join(ROOT, dir)))) {
    if (!file.endsWith('.js')) continue;
    const roots = repoRoots(file);
    for (const call of pathCalls(file)) {
      const values = call.args.map((arg) => (roots.has(arg) ? roots.get(arg) : literal(arg)));
      // A non-literal argument (a variable that is not a repo root) cannot be
      // resolved here; it may legitimately be a temp dir or the home.
      if (values.some((value) => value === null)) continue;
      const target = path.resolve(...values);
      if (isRepoDataOrConfig(target)) {
        violations.push(`${path.relative(ROOT, file)}:${call.line} -> ${path.relative(ROOT, target)} (use src/lib/home.js)`);
      }
    }
  }
  assert.deepEqual(violations, []);
});

test('no shell script points at the checkout data/ or config/', () => {
  const violations = [];
  for (const file of SCAN_DIRS.flatMap((dir) => walk(path.join(ROOT, dir))).filter((f) => f.endsWith('.sh'))) {
    const lines = fs.readFileSync(file, 'utf8').split('\n');
    lines.forEach((line, index) => {
      // ${SCRIPT_DIR}/../data|config/… and $SCRIPT_DIR/data|config/…
      if (/\$\{?SCRIPT_DIR\}?\/\.\.\/(data|config)\//.test(line) || /\$\{?SCRIPT_DIR\}?\/(data|config)\//.test(line)) {
        violations.push(`${path.relative(ROOT, file)}:${index + 1} ${line.trim()}`);
      }
    });
  }
  assert.deepEqual(violations, []);
});

test('git tracks no files under data/ or config except defaults', () => {
  const tracked = execFileSync('git', ['ls-files', 'data', 'config'], {
    cwd: ROOT,
    encoding: 'utf8',
  }).trim().split('\n').filter(Boolean);
  const violations = tracked.filter((file) =>
    file.startsWith('data/') || (file.startsWith('config/') && !file.startsWith('config/defaults/')),
  );
  assert.deepEqual(violations, [], 'only config/defaults may remain tracked');
});

test('the scanner resolves repo roots, including aliases', () => {
  const files = SCAN_DIRS.flatMap((dir) => walk(path.join(ROOT, dir)));
  assert.ok(files.length > 50, `expected to scan the source tree, saw ${files.length} files`);
  const home = path.join(ROOT, 'src', 'lib', 'home.js');
  assert.ok(pathCalls(home).length > 0);
  assert.equal(repoRoots(home).get('ROOT'), ROOT);
  // Sanity: the resolver flags a repo-anchored data path.
  assert.equal(isRepoDataOrConfig(path.join(ROOT, 'data', 'quota.json')), true);
  assert.equal(isRepoDataOrConfig(path.join(ROOT, 'config', 'defaults', 'roi.json')), false);
  assert.equal(isRepoDataOrConfig(path.join(ROOT, 'examples', 'home', 'config')), false);
});

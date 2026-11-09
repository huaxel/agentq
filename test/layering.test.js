'use strict';

/**
 * Dependency-direction guard for the whole source tree.
 *
 * The product is layered so each layer can be reasoned about (and tested)
 * without the ones above it:
 *
 *   core        pure catalog/capacity/routing/admission policy
 *   lib         leaf helpers (no product layers, except one CLI adapter)
 *   queue       the SQLite task store and its sources
 *   runners     worktree preparation + executors
 *   interfaces  cli / http / mcp adapters
 *   bin         composition roots (thin entry points)
 *   roi-tracker the separate ROI product
 *
 * Allowed edges are listed in ALLOWED; anything else fails with file:line and
 * the resolved target, so a violation is fixed by moving code, not by widening
 * the table. Two deliberate narrowings are expressed separately:
 *
 *   - core may use only the lib leaves listed in CORE_LIB_LEAVES;
 *   - lib may require core only from the one CLI adapter in LIB_CORE_ADAPTERS.
 *
 * Relative requires must be static string literals. A dynamic relative
 * require cannot be checked, so it is only allowed in the files listed in
 * DYNAMIC_REQUIRES with a reason.
 */

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const ROOT = path.join(__dirname, '..');

/** Layer of a repo-relative path ('unknown' when a new top-level dir appears). */
function layerOf(rel) {
  if (rel.startsWith('bin/')) return 'bin';
  if (rel.startsWith('src/core/')) return 'core';
  if (rel.startsWith('src/queue/')) return 'queue';
  if (rel.startsWith('src/runners/')) return 'runners';
  if (rel.startsWith('src/interfaces/cli/')) return 'interface:cli';
  if (rel.startsWith('src/interfaces/http/')) return 'interface:http';
  if (rel.startsWith('src/interfaces/mcp/')) return 'interface:mcp';
  if (rel.startsWith('src/lib/')) return 'lib';
  if (rel.startsWith('src/roi-tracker/')) return 'roi';
  return 'unknown';
}

/**
 * layer -> layers it may require.
 *
 * Note what is absent: core may not reach queue/runners/interfaces/roi; an
 * interface may require its own files but never a DIFFERENT interface (shared
 * code goes down a layer); roi-tracker may not require core, queue, runners or
 * interfaces.
 */
const ALLOWED = {
  core: ['core', 'lib'],
  lib: ['lib', 'core'],
  queue: ['queue', 'core', 'lib'],
  runners: ['runners', 'core', 'lib', 'queue'],
  'interface:cli': ['interface:cli', 'core', 'lib', 'queue', 'runners'],
  'interface:http': ['interface:http', 'core', 'lib', 'queue', 'runners'],
  'interface:mcp': ['interface:mcp', 'core', 'lib', 'queue', 'runners'],
  bin: ['bin', 'core', 'lib', 'queue', 'runners', 'interface:cli', 'interface:http', 'interface:mcp'],
  roi: ['roi', 'lib'],
};

/**
 * The only lib files core may require: pure leaves with no product imports.
 *
 * home.js is here because the snapshot and catalog own path resolution for
 * every interface, and runtime paths now come from AGENTQ_HOME rather than the
 * checkout. It is a leaf: it reads JSON and computes paths, and requires only
 * lib/load.js (another leaf).
 */
const CORE_LIB_LEAVES = new Set([
  'src/lib/aa-pricing.js',
  'src/lib/home.js',
  'src/lib/model-key.js',
  'src/lib/path-attribution.js',
  'src/lib/path-coverage.js',
  'src/lib/subscriptions.js',
]);

/**
 * The only lib files allowed to require core: quota-resolver is a CLI adapter
 * (argv, stdout, exit codes), so it cannot live in the pure core.
 */
const LIB_CORE_ADAPTERS = new Set(['src/lib/quota-resolver.js']);

/**
 * Files allowed a dynamic relative require, with the reason.
 * @type {Map<string, string>}
 */
const DYNAMIC_REQUIRES = new Map([
  ['bin/agentq-mcp.js', 'composition root: loads routing-core modules lazily by path and reads package.json'],
  ['src/lib/capacity-remote.js', 'the dynamic require is inside a generated observer source string, not executed here'],
]);

function walk(dir, out = []) {
  if (!fs.existsSync(dir)) return out;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, out);
    else if (entry.isFile() && full.endsWith('.js')) out.push(full);
  }
  return out;
}

const rel = (file) => path.relative(ROOT, file).split(path.sep).join('/');

const files = [...walk(path.join(ROOT, 'src')), ...walk(path.join(ROOT, 'bin'))]
  .map((file) => ({ abs: file, rel: rel(file) }))
  .sort((a, b) => (a.rel < b.rel ? -1 : a.rel > b.rel ? 1 : 0));

const STATIC = /(?:require\.resolve\(\s*|require\(\s*)(['"])([^'"]+)\1/g;
const DYNAMIC = /require\(\s*(?!['"])/g;

/**
 * Every require in one file, with its line number.
 * @param {{ abs: string, rel: string }} file
 */
function requiresOf({ abs, rel: name }) {
  const source = fs.readFileSync(abs, 'utf8');
  const lines = source.split('\n');
  const found = [];
  lines.forEach((line, index) => {
    for (const match of line.matchAll(STATIC)) {
      found.push({ specifier: match[2], line: index + 1, dynamic: false });
    }
    if (DYNAMIC.test(line)) {
      DYNAMIC.lastIndex = 0;
      found.push({ specifier: null, line: index + 1, dynamic: true });
    }
  });
  return found.map((entry) => ({ ...entry, file: name }));
}

const allRequires = files.flatMap(requiresOf);

test('the layered source tree exists and is scanned', () => {
  const layers = ['src/core', 'src/lib', 'src/queue', 'src/runners', 'src/interfaces/cli', 'src/interfaces/http', 'src/interfaces/mcp', 'src/roi-tracker', 'bin'];
  for (const layer of layers) {
    assert.ok(fs.existsSync(path.join(ROOT, layer)), `missing layer directory: ${layer}`);
  }
  assert.ok(files.length > 50, `expected the scan to see the source tree, saw ${files.length} files`);
  assert.ok(allRequires.length > 100, `expected requires to be parsed, saw ${allRequires.length}`);
});

test('every source file belongs to a known layer', () => {
  const unknown = files.filter((file) => layerOf(file.rel) === 'unknown').map((file) => file.rel);
  assert.deepEqual(unknown, [], 'classify the new top-level directory in layerOf() and ALLOWED');
});

test('relative requires are static string literals, or explicitly allowed', () => {
  const violations = allRequires
    .filter((entry) => entry.dynamic && !DYNAMIC_REQUIRES.has(entry.file))
    .map((entry) => `${entry.file}:${entry.line} dynamic require (add it to DYNAMIC_REQUIRES with a reason)`);
  assert.deepEqual(violations, []);
});

test('every relative require resolves to a file in the tree', () => {
  const violations = [];
  for (const entry of allRequires) {
    if (entry.dynamic || !entry.specifier.startsWith('.')) continue;
    const target = path.resolve(path.dirname(path.join(ROOT, entry.file)), entry.specifier);
    if (!fs.existsSync(target)) {
      violations.push(`${entry.file}:${entry.line} -> ${entry.specifier} (unresolvable)`);
    }
  }
  assert.deepEqual(violations, []);
});

test('requires only cross layers in the allowed direction', () => {
  const violations = [];
  for (const entry of allRequires) {
    if (entry.dynamic || !entry.specifier.startsWith('.')) continue;
    const target = rel(path.resolve(path.dirname(path.join(ROOT, entry.file)), entry.specifier));
    const from = layerOf(entry.file);
    const to = layerOf(target);
    if (to === 'unknown') {
      violations.push(`${entry.file}:${entry.line} -> ${target} (target is not in a known layer)`);
      continue;
    }
    if (!ALLOWED[from].includes(to)) {
      violations.push(`${entry.file}:${entry.line} -> ${target} (${from} must not require ${to})`);
      continue;
    }
    if (from === 'core' && to === 'lib' && !CORE_LIB_LEAVES.has(target)) {
      violations.push(`${entry.file}:${entry.line} -> ${target} (core may only use the lib leaves in CORE_LIB_LEAVES)`);
    }
    if (from === 'lib' && to === 'core' && !LIB_CORE_ADAPTERS.has(entry.file)) {
      violations.push(`${entry.file}:${entry.line} -> ${target} (only LIB_CORE_ADAPTERS may require core)`);
    }
    // A lib adapter that reaches core would let the ROI tracker reach core
    // transitively.
    if (from === 'roi' && LIB_CORE_ADAPTERS.has(target)) {
      violations.push(`${entry.file}:${entry.line} -> ${target} (roi-tracker must not reach core through a lib adapter)`);
    }
  }
  assert.deepEqual(violations, []);
});

test('core requires only node: built-ins besides its relative edges', () => {
  // Core stays pure: no npm packages and no bare built-in names that dodge the
  // explicit `node:` prefix.
  const violations = allRequires
    .filter((entry) => !entry.dynamic && layerOf(entry.file) === 'core')
    .filter((entry) => !entry.specifier.startsWith('.') && !entry.specifier.startsWith('node:'))
    .map((entry) => `${entry.file}:${entry.line} -> ${entry.specifier} (core may only require node: built-ins)`);
  assert.deepEqual(violations, []);
});

test('the interface layer never requires another interface', () => {
  const violations = [];
  for (const entry of allRequires) {
    if (entry.dynamic || !entry.specifier.startsWith('.')) continue;
    const target = rel(path.resolve(path.dirname(path.join(ROOT, entry.file)), entry.specifier));
    const from = layerOf(entry.file);
    const to = layerOf(target);
    if (from.startsWith('interface:') && to.startsWith('interface:') && from !== to) {
      violations.push(`${entry.file}:${entry.line} -> ${target} (move the shared code below the interface layer)`);
    }
  }
  assert.deepEqual(violations, []);
});

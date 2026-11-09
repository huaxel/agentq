'use strict';

/**
 * Path helpers shared by the queue and the runner.
 *
 * `canonicalizePath` resolves a path component by component through
 * `realpath`, so containment checks cannot be fooled by a symlinked ancestor or
 * a symlink loop, and returns null for anything it cannot prove (a dangling
 * symlink, a non-directory ancestor, `..` after a missing component).
 */

const fs = require('node:fs');
const path = require('node:path');

function canonicalizePath(p) {
  if (typeof p !== 'string' || !p) return null;
  const absolute = path.isAbsolute(p) ? p : path.resolve(p);
  const parts = absolute.split(path.sep).filter(Boolean);
  let current = path.parse(absolute).root;
  let missing = false;
  for (const part of parts) {
    if (part === '.') continue;
    if (part === '..') {
      if (missing) return null;
      current = path.dirname(current);
      continue;
    }
    const candidate = path.join(current, part);
    if (missing) {
      current = candidate;
      continue;
    }
    try {
      current = fs.realpathSync(candidate);
    } catch (err) {
      if (err.code !== 'ENOENT') return null;
      try {
        const stat = fs.lstatSync(candidate);
        // Dangling symlinks are not ordinary missing path components.
        if (stat.isSymbolicLink()) return null;
      } catch (statErr) {
        if (statErr.code !== 'ENOENT') return null;
      }
      try {
        if (!fs.statSync(current).isDirectory()) return null;
      } catch { return null; }
      missing = true;
      current = candidate;
    }
  }
  return current;
}

module.exports = { canonicalizePath };

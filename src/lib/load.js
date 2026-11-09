/**
 * Shared JSON loading — one place that turns a half-written or missing data
 * file into a clear, sourced error instead of a bare `Unexpected token` stack.
 *
 *   readJson(absPath)      → parsed value, throws "cannot read …" / "invalid JSON in …"
 *   tryReadJson(absPath)   → parsed value, or null if missing/unparseable
 *   makeLoader(root)       → { load, loadOptional } bound to a repo-relative root
 *
 * Collectors and the pipeline all read config + data files relative to the repo
 * root; `makeLoader(ROOT)` keeps those call sites to `load('data/foo.json')`.
 */
const fs = require('fs');
const path = require('path');

/** Read & parse JSON from an absolute path, with a clear error on failure. */
function readJson(file) {
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (e) {
    throw new Error(`cannot read ${file}: ${e.message}`);
  }
  try {
    return JSON.parse(text);
  } catch (e) {
    throw new Error(`invalid JSON in ${file}: ${e.message}`);
  }
}

/** Like readJson, but returns null when the file is missing or unparseable. */
function tryReadJson(file) {
  try { return readJson(file); } catch { return null; }
}

/** Bind a root dir so callers can load by repo-relative path. */
function makeLoader(root) {
  return {
    load: rel => readJson(path.join(root, rel)),
    loadOptional: rel => tryReadJson(path.join(root, rel)),
  };
}

module.exports = { readJson, tryReadJson, makeLoader };

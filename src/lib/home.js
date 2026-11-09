'use strict';

/**
 * Home directory — the single source of runtime paths.
 *
 * The repository holds code, the method's defaults and examples. Everything
 * personal (which subscriptions you hold and their fees, the path/runnable
 * maps, usage, quota, prices, snapshots and the SQLite queue) lives in a
 * per-user directory outside the checkout:
 *
 *   $AGENTQ_HOME                 explicit override (resolved to an absolute path)
 *   ${XDG_CONFIG_HOME}/agentq    otherwise
 *   ~/.config/agentq             when XDG_CONFIG_HOME is unset or blank
 *
 * Layout:
 *
 *   <home>/config/roi.config.json      your setup (merged over config/defaults/roi.json)
 *   <home>/config/runnables.json       the model paths you can actually run
 *   <home>/config/execution-paths.json machine/harness inventory
 *   <home>/data/…                      usage, quota, prices, snapshots, queue
 *
 * Precedence for every runtime path: an explicit option, then the file's own
 * environment variable, then the home directory. Nothing falls back to the
 * checkout, so a fresh clone cannot silently read someone else's data.
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { readJson, tryReadJson } = require('./load.js');

const ROOT = path.join(__dirname, '..', '..');
/** Tracked method defaults (no personal setup). */
const DEFAULTS_DIR = path.join(ROOT, 'config', 'defaults');
/** Fictional setup shipped for `agentq home init`. */
const EXAMPLES_DIR = path.join(ROOT, 'examples', 'home', 'config');

/** A non-empty, non-blank string, or null. */
function nonEmpty(value) {
  return typeof value === 'string' && value.trim() !== '' ? value : null;
}

/**
 * The resolved agentq home.
 *
 * @param {{ env?: Record<string, string|undefined>, home?: string }} [opts]
 *   `env` defaults to process.env, `home` to os.homedir().
 * @returns {string} an absolute path.
 */
function agentqHome({ env = process.env, home = os.homedir() } = {}) {
  const override = nonEmpty(env.AGENTQ_HOME);
  if (override) return path.resolve(override);
  const configHome = nonEmpty(env.XDG_CONFIG_HOME);
  const base = configHome ? path.resolve(configHome) : path.join(home, '.config');
  return path.join(base, 'agentq');
}

/**
 * `<home>/config/<name>`.
 *
 * @param {string} name file name, e.g. `runnables.json`
 * @param {{ env?: Record<string, string|undefined>, home?: string }} [opts]
 * @returns {string}
 */
function homeConfigPath(name, opts) {
  return path.join(agentqHome(opts), 'config', name);
}

/**
 * `<home>/data/<...parts>`.
 *
 * @param {...string} parts path segments below `data/`
 * @returns {string}
 */
function homeDataPath(...parts) {
  return path.join(agentqHome(), 'data', ...parts);
}

/** `<home>/config` (created by `agentq home init`). */
function homeConfigDir(opts) {
  return path.join(agentqHome(opts), 'config');
}

/** `<home>/data` (created by `agentq home init`). */
function homeDataDir(opts) {
  return path.join(agentqHome(opts), 'data');
}

/**
 * Read a home-relative file (`data/x.json`, `config/x.json`). Lazy, so a test
 * or a long-lived process can change AGENTQ_HOME between calls.
 *
 * @param {string} rel
 */
function homeLoad(rel) {
  return readJson(path.join(agentqHome(), rel));
}

/** Like homeLoad, but null when the file is missing or unparseable. */
function homeLoadOptional(rel) {
  return tryReadJson(path.join(agentqHome(), rel));
}

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/**
 * Deep-merge the user's setup over the method defaults.
 *
 * Objects merge recursively; arrays and scalars from the user file replace the
 * default outright (a subscription list is a decision, not a set of patches).
 *
 * @param {unknown} base
 * @param {unknown} override
 * @returns {unknown}
 */
function deepMerge(base, override) {
  if (!isPlainObject(base) || !isPlainObject(override)) return override;
  const out = { ...base };
  for (const [key, value] of Object.entries(override)) {
    out[key] = isPlainObject(value) && isPlainObject(out[key]) ? deepMerge(out[key], value) : value;
  }
  return out;
}

/** The tracked method defaults (`config/defaults/roi.json`). */
function roiDefaults() {
  return readJson(path.join(DEFAULTS_DIR, 'roi.json'));
}

/**
 * The effective ROI config: `config/defaults/roi.json` (the method) merged with
 * `<home>/config/roi.config.json` (your setup).
 *
 * A missing user file is not an error — it returns the defaults alone, and the
 * caller's validator explains which setup keys are still missing. Invalid JSON
 * is an error that names the file.
 *
 * @param {{ home?: string }} [opts]
 * @returns {Record<string, any>}
 */
function loadRoiConfig({ home = agentqHome() } = {}) {
  const defaults = roiDefaults();
  const userPath = path.join(home, 'config', 'roi.config.json');
  if (!fs.existsSync(userPath)) return defaults;
  return deepMerge(defaults, readJson(userPath));
}

/**
 * The user's setup, or a one-line error naming the missing file.
 *
 * `loadRoiConfig` deliberately tolerates a missing user file (the method
 * defaults alone are a valid config object), but a command that needs a real
 * setup should say so instead of surfacing the validator's list of missing
 * keys. The message names the exact path and the two ways to create it.
 *
 * @param {{ home?: string }} [opts]
 * @returns {Record<string, any>}
 */
function loadRequiredRoiConfig({ home = agentqHome() } = {}) {
  const userPath = path.join(home, 'config', 'roi.config.json');
  if (!fs.existsSync(userPath)) {
    throw new Error(`no setup at ${userPath} — run 'agentq home init' or set AGENTQ_HOME`);
  }
  return loadRoiConfig({ home });
}

/** Files `agentq home init` seeds, in a stable order. */
function exampleConfigFiles() {
  if (!fs.existsSync(EXAMPLES_DIR)) return [];
  return fs.readdirSync(EXAMPLES_DIR, { withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => entry.name)
    .sort();
}

/**
 * Create `<home>/config` and `<home>/data`, then copy the example setup into
 * `<home>/config` only where a file is missing. `--force` overwrites.
 *
 * @param {{ force?: boolean, home?: string }} [opts]
 * @returns {{ home: string, created: string[], kept: string[] }}
 */
function initHome({ force = false, home = agentqHome() } = {}) {
  fs.mkdirSync(path.join(home, 'config'), { recursive: true });
  fs.mkdirSync(path.join(home, 'data'), { recursive: true });
  const created = [];
  const kept = [];
  for (const name of exampleConfigFiles()) {
    const target = path.join(home, 'config', name);
    if (!force && fs.existsSync(target)) {
      kept.push(name);
      continue;
    }
    fs.copyFileSync(path.join(EXAMPLES_DIR, name), target);
    created.push(name);
  }
  return { home, created, kept };
}

/** Which config files exist under `<home>/config`, for `agentq home`. */
function homeConfigStatus({ home = agentqHome() } = {}) {
  const dir = path.join(home, 'config');
  const names = new Set(exampleConfigFiles());
  if (fs.existsSync(dir)) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.isFile()) names.add(entry.name);
    }
  }
  return [...names].sort().map((name) => ({ name, path: path.join(dir, name), exists: fs.existsSync(path.join(dir, name)) }));
}

module.exports = {
  DEFAULTS_DIR,
  EXAMPLES_DIR,
  agentqHome,
  deepMerge,
  exampleConfigFiles,
  homeConfigDir,
  homeConfigPath,
  homeConfigStatus,
  homeDataDir,
  homeDataPath,
  homeLoad,
  homeLoadOptional,
  initHome,
  loadRequiredRoiConfig,
  loadRoiConfig,
  roiDefaults,
};

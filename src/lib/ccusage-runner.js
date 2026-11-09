/**
 * Shared ccusage runner — one place for the "prefer a ccusage on PATH, fall
 * back to `npx -y ccusage@latest`" dance that the adapter and the value-run
 * collector both need. Returns parsed JSON, or throws the last error if neither
 * invocation works (or the output isn't JSON).
 */
const { execFile, execFileSync } = require('child_process');

const DEFAULT_OPTS = {
  encoding: 'utf8',
  maxBuffer: 64 * 1024 * 1024,
  stdio: ['ignore', 'pipe', 'ignore'],
  timeout: 300_000,
};

// Pin ccusage version for reproducibility and supply-chain safety.
// Update this version only after manual testing and release notes review.
const CCUSAGE_VERSION = '20.0.18';

/**
 * @param {string[]} args  ccusage CLI args (e.g. ['daily', '--json']).
 * @param {object} [opts]  execFileSync overrides (e.g. { timeout }).
 * @returns {*} parsed JSON from ccusage stdout.
 */
function attemptsFor(args) {
  return [
    { cmd: 'ccusage', args },
    { cmd: 'npx', args: [`-y`, `ccusage@${CCUSAGE_VERSION}`, ...args] },
  ];
}

function runCcusageJson(args, opts = {}) {
  const execOpts = { ...DEFAULT_OPTS, ...opts };
  let lastErr;
  for (const { cmd, args: cmdArgs } of attemptsFor(args)) {
    try {
      return JSON.parse(execFileSync(cmd, cmdArgs, execOpts));
    } catch (err) {
      lastErr = err;
    }
  }
  throw lastErr || new Error('ccusage not available');
}

function execFileJson(cmd, args, opts) {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, opts, (err, stdout) => {
      if (err) return reject(err);
      try { resolve(JSON.parse(stdout)); }
      catch (e) { reject(e); }
    });
  });
}

async function runCcusageJsonAsync(args, opts = {}) {
  const execOpts = { ...DEFAULT_OPTS, ...opts };
  let lastErr;
  for (const { cmd, args: cmdArgs } of attemptsFor(args)) {
    try {
      return await execFileJson(cmd, cmdArgs, execOpts);
    } catch (err) {
      lastErr = err;
    }
  }
  throw lastErr || new Error('ccusage not available');
}

module.exports = { runCcusageJson, runCcusageJsonAsync };

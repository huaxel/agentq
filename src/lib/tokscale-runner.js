/**
 * Shared tokscale runner — one place for the "prefer a tokscale on PATH, fall
 * back to `npx -y tokscale@<pinned>`" dance, mirroring ccusage-runner.js.
 * Returns parsed JSON from tokscale stdout, or throws the last error if
 * neither invocation works (or the output isn't JSON).
 *
 * tokscale is the Rust-core token tracker (github.com/junhoyeo/tokscale) used
 * as a second opinion on per-model spend and, importantly, per-PROVIDER
 * attribution that ccusage's modelBreakdowns drop (see pi-session-scanner.js).
 */
const { execFile, execFileSync } = require('child_process');

const DEFAULT_OPTS = {
  encoding: 'utf8',
  maxBuffer: 64 * 1024 * 1024,
  stdio: ['ignore', 'pipe', 'ignore'],
  timeout: 300_000,
};

// Pin tokscale version for reproducibility and supply-chain safety.
// Update this version only after manual testing and release notes review.
// Verified: --json output shape, --since ISO dates, --no-spinner, --group-by.
const TOKSCALE_VERSION = '4.9.0';

/**
 * @param {string[]} args  tokscale CLI args (e.g. ['--json', '--since', '2026-05-01']).
 * @returns {Array<{cmd: string, args: string[]}>} fallback attempts, PATH first.
 */
function attemptsFor(args) {
  return [
    { cmd: 'tokscale', args },
    { cmd: 'npx', args: [`-y`, `tokscale@${TOKSCALE_VERSION}`, ...args] },
  ];
}

function runTokscaleJson(args, opts = {}) {
  const execOpts = { ...DEFAULT_OPTS, ...opts };
  let lastErr;
  for (const { cmd, args: cmdArgs } of attemptsFor(args)) {
    try {
      return JSON.parse(execFileSync(cmd, cmdArgs, execOpts));
    } catch (err) {
      lastErr = err;
    }
  }
  throw lastErr || new Error('tokscale not available');
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

async function runTokscaleJsonAsync(args, opts = {}) {
  const execOpts = { ...DEFAULT_OPTS, ...opts };
  let lastErr;
  for (const { cmd, args: cmdArgs } of attemptsFor(args)) {
    try {
      return await execFileJson(cmd, cmdArgs, execOpts);
    } catch (err) {
      lastErr = err;
    }
  }
  throw lastErr || new Error('tokscale not available');
}

module.exports = { runTokscaleJson, runTokscaleJsonAsync, TOKSCALE_VERSION };

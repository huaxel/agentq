'use strict';

/**
 * Per-job runtime state: the PID file a running executor is recorded in, the
 * process-tree kill behind `agentq cancel`, and the managed worktree path.
 *
 * It lives in the queue layer because it IS queue state: `cancel`, `recover`
 * and `prune` read it without launching anything, while the runner writes the
 * PID file when it starts the executor. Keeping it here is what lets the queue
 * stay independent of the runner (the runner imports the queue, not the other
 * way round).
 */

const fs = require('node:fs');
const path = require('node:path');

// Keep orchestrator claims valid for the full configured executor window even
// if heartbeat delivery is delayed or the worker briefly loses connectivity.
const EXECUTOR_TIMEOUT_MS = 12 * 60 * 60 * 1000;

// --- PID tracking for cancel support ---
//
// The queue's state file (the SQLite database for a local source) locates the
// per-job pid files, so `cancel` can find the executor a run-next/drain
// process spawned.

function pidFilePath(statePath, id) {
  return path.join(path.dirname(statePath), 'logs', `agentq-job-${id}.pid`);
}

function writePidFile(statePath, id, pid) {
  const p = pidFilePath(statePath, id);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, String(pid));
}

function readPidFile(statePath, id) {
  try {
    return Number(fs.readFileSync(pidFilePath(statePath, id), 'utf8').trim());
  } catch {
    return null;
  }
}

function removePidFile(statePath, id) {
  try { fs.unlinkSync(pidFilePath(statePath, id)); } catch {}
}

/** Kill a process tree (process + children) using SIGTERM, then SIGKILL after 5s. */
function killProcessTree(pid) {
  if (!pid || pid <= 0) return null;
  try {
    process.kill(-pid, 'SIGTERM');
  } catch {}
  const timer = setTimeout(() => {
    try { process.kill(-pid, 'SIGKILL'); } catch {}
  }, 5000);
  timer.unref();
  return timer;
}

/** Cancel a running job by killing its process tree. */
function cancelJob(statePath, id) {
  const pid = readPidFile(statePath, id);
  if (!pid) return { cancelled: false, reason: 'no PID file found' };
  try {
    process.kill(pid, 0);
  } catch {
    removePidFile(statePath, id);
    return { cancelled: false, reason: 'process already exited' };
  }
  killProcessTree(pid);
  removePidFile(statePath, id);
  return { cancelled: true, pid };
}

// The per-job worktree lives under the queue's directory so `prepare` and
// `prune` agree on where it is. Absolute so it works as a spawn cwd regardless
// of the caller's cwd (git would otherwise create it relative to the repo via -C).
function jobWorktreePath(statePath, id) {
  return path.resolve(path.dirname(statePath), 'worktrees', `job-${id}`);
}

module.exports = {
  EXECUTOR_TIMEOUT_MS,
  pidFilePath,
  writePidFile,
  readPidFile,
  removePidFile,
  killProcessTree,
  cancelJob,
  jobWorktreePath,
};

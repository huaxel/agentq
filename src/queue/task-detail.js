'use strict';

/**
 * The full record of one task (queue layer): the read behind `agentq show`.
 *
 * Every piece already lives in the queue — the task row, its pinned input, its
 * `task_events` audit trail, and the `reviews` rows that name it — but nothing
 * read them together, so the CLI could only list tasks or reach for raw SQL.
 *
 * The read is strictly read-only: the file is opened without creating,
 * migrating or setting journal mode on it, so `show` takes no write lock and
 * cannot change what it reports. (Reading a WAL-mode database still lets SQLite
 * materialize the empty `-wal`/`-shm` sidecar files, exactly as the read-only
 * queue reads behind `review list` and `pick` already do.)
 *
 * Core and lib never import queue; interfaces and runners may.
 */

const fs = require('node:fs');
const { DatabaseSync } = require('node:sqlite');

const { assertQueueDbPath, taskToJob } = require('./sources.js');
const { getTask, listReviews, listTaskEvents, resolveTaskId } = require('./db.js');
const { parseJson } = require('./db-helpers.js');
const { storedTier } = require('../core/auto-model.js');

/** A database written before a table existed has none of that table's rows. */
function isMissingTable(error) {
  const message = error instanceof Error ? error.message : String(error ?? '');
  return /no such table/i.test(message);
}

/**
 * Open an existing queue file for reading only.
 *
 * A missing file is an error, not an empty queue: `show` names one task, and no
 * task exists without a queue that some command already created.
 *
 * @param {string} dbPath
 * @returns {import('node:sqlite').DatabaseSync}
 */
function openQueueDbReadOnly(dbPath) {
  assertQueueDbPath(dbPath);
  if (!fs.existsSync(dbPath)) throw new Error(`No queue database at ${dbPath}`);
  try {
    return new DatabaseSync(dbPath, { readOnly: true });
  } catch (error) {
    throw new Error(`Cannot open the queue read-only at ${dbPath}: ${error.message}`);
  }
}

/**
 * One task in full.
 *
 * `id` is a full task id or a unique prefix, resolved exactly as `run --id`
 * resolves it, so an unknown or ambiguous prefix is that resolver's error.
 *
 * @param {string} dbPath SQLite queue file
 * @param {string} id full task id or unique prefix
 * @returns {{
 *   task: Record<string, any>,
 *   input: Record<string, any>|null,
 *   events: Array<Record<string, any>>,
 *   reviews: Array<Record<string, any>>,
 * }} `task` is the job shape `status` prints, plus the `tier` stored in
 *   routing_policy; `input` is the pinned task input (the spec file itself is
 *   never re-read, because it may have changed since enqueue), and it is the one
 *   place the task text appears — `prompt`/`task_input` are dropped from `task`
 *   when there is a pinned input to show; `events` are the audit rows oldest
 *   first with each payload parsed; `reviews` are the outcome reviews recorded
 *   against this task, newest first.
 */
function showTask(dbPath, id) {
  const db = openQueueDbReadOnly(dbPath);
  try {
    const taskId = resolveTaskId(db, id);
    const row = getTask(db, taskId);
    if (!row) throw new Error(`No task found with id ${id}`);
    const job = taskToJob(row);
    const task = { ...job, tier: storedTier(row) };
    if (job.task_input) {
      // `prompt` is the same snapshot as a string and `task_input` its parsed
      // form: with `input` reported, keeping them would print the whole task
      // text three times. A task with no readable pinned input (a plain prompt,
      // a corrupt snapshot) keeps its raw prompt, the only record of its text.
      delete task.prompt;
      delete task.task_input;
    }
    const events = listTaskEvents(db, taskId)
      .map((event) => ({ ...event, payload: parseJson(event.payload) }));
    let reviews = [];
    try {
      reviews = listReviews(db, { taskId });
    } catch (error) {
      // Reviews are one section of the report, not a precondition of it.
      if (!isMissingTable(error)) throw error;
    }
    return { task, input: job.task_input, events, reviews };
  } catch (error) {
    if (isMissingTable(error)) {
      throw new Error(`Queue database at ${dbPath} has no task tables; point --db at an agentq queue`);
    }
    throw error;
  } finally {
    try { db.close(); } catch { /* already closed */ }
  }
}

module.exports = { openQueueDbReadOnly, showTask };

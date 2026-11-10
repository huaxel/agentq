'use strict';

/**
 * W29: `formatStatusTable` — the readable status table.
 *
 * Fixed rows and a fixed `now`: the header, 8-character ids, the age units,
 * a spec title without its file path, truncation to at most 120 characters, the
 * `—` model, the waits-on and input-error notes, and the empty `no tasks` case.
 *
 * W30 adds `formatQueueSummary`: the one-line queue breakdown, its fixed status
 * order, skipped zeros, unknown statuses appended last, and the empty queue.
 */

const assert = require('node:assert/strict');
const test = require('node:test');

const { formatStatusTable, formatQueueSummary } = require('../src/interfaces/cli/format.js');

// Fixed reference time; rows below are dated relative to it.
const NOW = new Date('2026-01-01T12:00:00.000Z');
const ago = (ms) => new Date(NOW.getTime() - ms).toISOString();

/** A plausible status() row, with the fields the table reads. */
function job(overrides = {}) {
  return {
    id: '1b8ca469-0000-4000-8000-000000000000',
    status: 'pending',
    kind: 'spec',
    created_at: ago(45_000),
    model: 'anthropic/claude-sonnet-4',
    issue_number: null,
    task_input: { source: 'file', title: 'A spec title', ref: '/abs/path/to/spec.md' },
    depends_on: [],
    input_error: null,
    ...overrides,
  };
}

test('the header names every column and ids are truncated to 8 characters', () => {
  const out = formatStatusTable([
    job({ id: '1b8ca469-0000-4000-8000-000000000000', created_at: ago(45_000) }),
    job({ id: '22222222-1111-4222-8222-111111111111', created_at: ago(12 * 60_000) }),
  ], { now: NOW });

  const lines = out.split('\n');
  assert.match(lines[0], /^id +status +kind +age +model +title$/);
  // Only the 8-character prefix appears; the full uuid never does.
  assert.match(lines[1], /^1b8ca469 /);
  assert.match(lines[2], /^22222222 /);
  assert.doesNotMatch(out, /1b8ca469-0000/);
  assert.doesNotMatch(out, /22222222-1111/);
});

test('age renders in compact units (s, m, h, d) against now', () => {
  const out = formatStatusTable([
    job({ id: '11111111-0000-4000-8000-000000000000', created_at: ago(45_000) }),
    job({ id: '22222222-0000-4000-8000-000000000000', created_at: ago(12 * 60_000) }),
    job({ id: '33333333-0000-4000-8000-000000000000', created_at: ago(3 * 3_600_000) }),
    job({ id: '44444444-0000-4000-8000-000000000000', created_at: ago(5 * 86_400_000) }),
  ], { now: NOW });

  assert.match(out, / 45s /);
  assert.match(out, / 12m /);
  assert.match(out, / 3h /);
  assert.match(out, / 5d /);
});

test('a spec task shows the pinned title, never the file path', () => {
  const out = formatStatusTable([
    job({
      id: '1b8ca469-0000-4000-8000-000000000000',
      task_input: { source: 'file', title: 'Pinned spec title', ref: '/very/long/absolute/path/to/spec.md' },
    }),
  ], { now: NOW });

  assert.match(out, /Pinned spec title/);
  assert.doesNotMatch(out, /very\/long\/absolute/);
});

test('an issue task shows `issue N`, a null model shows `—`', () => {
  const out = formatStatusTable([
    job({
      id: '1b8ca469-0000-4000-8000-000000000000',
      kind: 'github_issue',
      issue_number: 42,
      model: null,
      task_input: { source: 'github', title: 'The issue title', ref: '42' },
    }),
  ], { now: NOW });

  assert.match(out, /issue 42/);
  // The `—` model cell sits between the age and the title.
  assert.match(out, /—\s+issue 42/);
});

test('a long title is truncated so the whole row stays at most 120 characters', () => {
  const longTitle = 'x'.repeat(200);
  const out = formatStatusTable([
    job({ id: '1b8ca469-0000-4000-8000-000000000000', model: null, task_input: { source: 'file', title: longTitle, ref: 'f' } }),
  ], { now: NOW });

  for (const line of out.split('\n')) {
    assert.ok(line.length <= 120, `row too long (${line.length}): ${line}`);
  }
  assert.match(out, /x+…$/m);
});

test('a pending job waiting on an unsucceeded dependency gets a waits-on note', () => {
  const depId = 'aaaabbbb-0000-4000-8000-000000000000';
  const out = formatStatusTable([
    job({ id: depId, status: 'pending' }),
    job({
      id: 'ccccdddd-0000-4000-8000-000000000000',
      status: 'pending',
      depends_on: [depId],
    }),
  ], { now: NOW });

  assert.match(out, /waits on aaaabbbb/);
  assert.doesNotMatch(out, /aaaabbbb-0000/);
});

test('a pending job with an input error gets an input-error note', () => {
  const out = formatStatusTable([
    job({ id: '1b8ca469-0000-4000-8000-000000000000', status: 'pending', input_error: 'branch "x" already exists' }),
  ], { now: NOW });

  assert.match(out, /input error/);
  assert.doesNotMatch(out, /waits on/);
});

test('an empty list prints `no tasks`', () => {
  assert.equal(formatStatusTable([]), 'no tasks');
  assert.equal(formatStatusTable(null), 'no tasks');
});

/** The summary counts rows only for their status, so these are all it reads. */
function counted(...statuses) {
  return statuses.map((status) => ({ status }));
}

/** `counted` for n rows sharing a status. */
function many(status, n) {
  return counted(...Array.from({ length: n }, () => status));
}

test('the summary lists statuses in the fixed order, not the order seen', () => {
  const jobs = counted(
    'succeeded', 'succeeded', 'failed', 'rejected', 'pending', 'running', 'unverified', 'blocked', 'pending', 'succeeded', 'failed', 'pending', 'running', 'failed', 'succeeded',
  );
  assert.equal(
    formatQueueSummary(jobs),
    'queue: 2 running, 3 pending, 1 blocked, 3 failed, 1 unverified, 1 rejected, 4 succeeded',
  );
});

test('the summary skips statuses with no tasks', () => {
  // The specification's example: nothing blocked, unverified or rejected.
  const jobs = [...many('running', 1), ...many('pending', 2), ...many('failed', 3), ...many('succeeded', 8)];
  assert.equal(formatQueueSummary(jobs), 'queue: 1 running, 2 pending, 3 failed, 8 succeeded');
});

test('an unknown status is appended after the known ones, alphabetically', () => {
  const jobs = counted('zombie', 'pending', 'awaiting-review', 'succeeded', 'amputated', 'zombie');
  assert.equal(
    formatQueueSummary(jobs),
    'queue: 1 pending, 1 succeeded, 1 amputated, 1 awaiting-review, 2 zombie',
  );
});

test('the summary of an empty queue is an empty string', () => {
  assert.equal(formatQueueSummary([]), '');
  assert.equal(formatQueueSummary(null), '');
  // Rows with no status at all are nothing to count either.
  assert.equal(formatQueueSummary([{}, { status: null }]), '');
});

test('a dependency outside the shown rows is looked up in allJobs', () => {
  const dep = job({ id: 'ccccdddd-0000-4000-8000-000000000000', status: 'succeeded' });
  const waiter = job({ id: 'eeeeffff-0000-4000-8000-000000000000', depends_on: [dep.id] });
  // Filtered to the waiter only: the succeeded dep is not a shown row.
  const out = formatStatusTable([waiter], { now: NOW, allJobs: [dep, waiter] });
  assert.doesNotMatch(out, /waits on/);
  const pendingDep = { ...dep, status: 'pending' };
  assert.match(formatStatusTable([waiter], { now: NOW, allJobs: [pendingDep, waiter] }), /waits on ccccdddd/);
});

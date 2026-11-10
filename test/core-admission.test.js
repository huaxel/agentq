'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { admit, ADMISSION_CHECKS } = require('../src/core/admission.js');
const { createIssueInput } = require('../src/core/issue-input.js');
const { taskInputFromIssue } = require('../src/core/task-input.js');

const ISSUE_NUMBER = 42;
const INVALID_INPUT = 'Missing or invalid pinned task input; enqueue a new job to capture the intended task text.';

function rawIssue(number = ISSUE_NUMBER) {
  return {
    number,
    title: 'Fixture issue',
    body: 'fixture body',
    url: `https://github.com/test/repo/issues/${number}`,
    updatedAt: '2026-11-02T00:00:00Z',
  };
}

function pinnedInput(number = ISSUE_NUMBER) {
  return taskInputFromIssue(createIssueInput(rawIssue(number)));
}

function issueJob(overrides = {}) {
  return {
    id: 1,
    kind: 'github_issue',
    issue_number: ISSUE_NUMBER,
    task_input: pinnedInput(),
    model: 'test/model',
    trusted: true,
    ...overrides,
  };
}

function feedbackJob(overrides = {}) {
  return { id: 7, kind: 'feedback', prompt: 'review this', model: 'test/model', trusted: true, ...overrides };
}

test('ADMISSION_CHECKS lists the checks in execution order and is frozen', () => {
  assert.deepEqual(ADMISSION_CHECKS, [
    'cua-feedback-only',
    'feedback-prompt',
    'feedback-model',
    'trust',
    'issue-input',
  ]);
  assert.equal(Object.isFrozen(ADMISSION_CHECKS), true);
  assert.throws(() => { ADMISSION_CHECKS.push('extra'); }, TypeError);
});

const refusals = [
  {
    check: 'cua-feedback-only',
    name: 'cua on a non-feedback job',
    job: () => issueJob(),
    caps: { cua: true },
    reason: '--cua can run feedback jobs only.',
  },
  {
    check: 'cua-feedback-only',
    name: 'cua on a plain prompt job',
    job: () => ({ id: 3, kind: 'prompt', prompt: 'do work', model: 'test/model', trusted: true }),
    caps: { cua: true, sandbox: 'worktree' },
    reason: '--cua can run feedback jobs only.',
  },
  {
    check: 'feedback-prompt',
    name: 'feedback without a prompt payload',
    job: () => feedbackJob({ prompt: undefined }),
    caps: { sandbox: 'worktree' },
    reason: 'Feedback job #7 has no prompt payload.',
  },
  {
    check: 'feedback-prompt',
    name: 'feedback with a whitespace-only prompt',
    job: () => feedbackJob({ prompt: '  \n\t ' }),
    caps: { cua: true },
    reason: 'Feedback job #7 has no prompt payload.',
  },
  {
    check: 'feedback-model',
    name: 'feedback without a model',
    job: () => feedbackJob({ model: '' }),
    caps: { sandbox: 'worktree' },
    reason: 'Feedback job #7 has no model configured.',
  },
  {
    check: 'feedback-model',
    name: 'feedback with a non-string model',
    job: () => feedbackJob({ model: 42 }),
    caps: { allowUntrusted: true },
    reason: 'Feedback job #7 has no model configured.',
  },
  {
    check: 'trust',
    name: 'untrusted issue job without a capability',
    job: () => issueJob({ trusted: false }),
    caps: {},
    reason: 'Refusing untrusted job #1 without --sandbox or --allow-untrusted. '
      + 'Task text can contain arbitrary instructions; pi executes bash with your full user rights.',
  },
  {
    check: 'trust',
    name: 'untrusted issue job with falsy capabilities',
    job: () => issueJob({ trusted: 0 }),
    caps: { sandbox: false, cua: false, allowUntrusted: false },
    reason: 'Refusing untrusted job #1 without --sandbox or --allow-untrusted. '
      + 'Task text can contain arbitrary instructions; pi executes bash with your full user rights.',
  },
  {
    check: 'trust',
    name: 'trusted feedback job without a capability',
    job: () => feedbackJob(),
    caps: {},
    reason: 'Refusing feedback job #7 without --sandbox or --allow-untrusted. '
      + 'Feedback content is always untrusted.',
  },
  {
    check: 'issue-input',
    name: 'issue job without a pinned input',
    job: () => issueJob({ task_input: undefined }),
    caps: {},
    reason: INVALID_INPUT,
    carriesError: true,
  },
  {
    check: 'issue-input',
    name: 'issue job with a tampered pinned input',
    job: () => {
      const job = issueJob();
      job.task_input.body = 'changed without its digest';
      return job;
    },
    caps: {},
    reason: INVALID_INPUT,
    carriesError: true,
  },
  {
    check: 'issue-input',
    name: 'issue job whose input belongs to another issue',
    job: () => issueJob({ task_input: pinnedInput(43) }),
    caps: {},
    reason: INVALID_INPUT,
    carriesError: true,
  },
  {
    check: 'issue-input',
    name: 'issue job without an issue number',
    job: () => ({ id: 1, kind: 'github_issue', model: 'test/model', trusted: true }),
    caps: {},
    reason: INVALID_INPUT,
    carriesError: true,
  },
  {
    check: 'issue-input',
    name: 'a job with neither a kind nor an issue number',
    job: () => ({ id: 6, prompt: 'do work', model: 'test/model', trusted: true }),
    caps: {},
    reason: INVALID_INPUT,
    carriesError: true,
  },
];

for (const { check, name, job, caps, reason, carriesError = false } of refusals) {
  test(`admit refuses ${name} (${check})`, () => {
    const refusal = admit(job(), caps);
    assert.equal(refusal.ok, false);
    assert.equal(refusal.reason, reason);
    assert.equal(refusal.retryable, false);
    if (carriesError) {
      assert.ok(refusal.error instanceof Error, 'the issue-input check carries its original Error');
    } else {
      assert.equal(refusal.error, undefined, 'only the issue-input check carries an Error');
    }
  });
}

test('admit preserves the original validation error object on the issue-input check', () => {
  const refusal = admit(issueJob({ task_input: undefined }), {});
  assert.equal(refusal.ok, false);
  assert.ok(refusal.error instanceof Error);
  assert.equal(refusal.error.message, refusal.reason);
  assert.equal(refusal.error.statusCode, 400);
});

test('admit checks run in the documented order', () => {
  // A feedback job that fails every check reports the first one only.
  const refusal = admit({ id: 9, kind: 'feedback', trusted: false }, {});
  assert.equal(refusal.reason, 'Feedback job #9 has no prompt payload.');
  // cua is refused before the trust gate can accept the job.
  assert.equal(admit(issueJob(), { cua: true, allowUntrusted: true }).reason, '--cua can run feedback jobs only.');
  // The trust gate is decided before the pinned input is validated.
  assert.equal(admit(issueJob({ trusted: false, task_input: undefined }), {}).reason,
    'Refusing untrusted job #1 without --sandbox or --allow-untrusted. '
    + 'Task text can contain arbitrary instructions; pi executes bash with your full user rights.');
});

const happyPaths = [
  {
    name: 'a trusted issue job with a valid pinned input',
    job: () => issueJob(),
    caps: {},
  },
  {
    name: 'an untrusted issue job under allowUntrusted',
    job: () => issueJob({ trusted: false }),
    caps: { allowUntrusted: true },
  },
  {
    name: 'an untrusted issue job under a sandbox',
    job: () => issueJob({ trusted: 0 }),
    caps: { sandbox: 'worktree' },
  },
  {
    name: 'a feedback job under a sandbox',
    job: () => feedbackJob(),
    caps: { sandbox: 'worktree' },
  },
  {
    name: 'a feedback job under cua',
    job: () => feedbackJob({ trusted: false }),
    caps: { cua: true },
  },
  {
    name: 'a feedback job under allowUntrusted',
    job: () => feedbackJob(),
    caps: { allowUntrusted: true },
  },
  {
    name: 'a trusted prompt job without issue metadata',
    job: () => ({ id: 4, kind: 'prompt', prompt: 'do work', model: 'test/model', trusted: true }),
    caps: {},
  },
];

for (const { name, job, caps } of happyPaths) {
  test(`admit allows ${name}`, () => {
    const job0 = job();
    const admission = admit(job0, caps);
    assert.equal(admission.ok, true);
    assert.deepEqual(admission.job, job0);
  });
}

test('admit returns the canonical pinned input for a valid issue job', () => {
  const job = issueJob();
  const admission = admit(job, {});
  assert.equal(admission.ok, true);
  assert.deepEqual(admission.job.task_input, job.task_input);
  assert.equal(admission.job.task_input.sha256, job.task_input.sha256);
  assert.equal(admission.job.issue_number, ISSUE_NUMBER);
});

test('admit returns the same job object when no input is produced', () => {
  const job = feedbackJob();
  const admission = admit(job, { sandbox: 'worktree' });
  assert.equal(admission.ok, true);
  assert.equal(admission.job, job);
});

test('admit never mutates the job it is given', () => {
  const deepFreeze = value => {
    if (value && typeof value === 'object' && !Object.isFrozen(value)) {
      Object.freeze(value);
      for (const child of Object.values(value)) deepFreeze(child);
    }
    return value;
  };
  const cases = [
    { job: deepFreeze(issueJob()), caps: {} },
    { job: deepFreeze(issueJob({ trusted: false })), caps: {} },
    { job: deepFreeze(feedbackJob()), caps: { sandbox: 'worktree' } },
    { job: deepFreeze(issueJob({ task_input: undefined })), caps: {} },
  ];
  for (const { job, caps } of cases) {
    const before = structuredClone(job);
    admit(job, caps);
    assert.deepEqual(job, before);
  }
  // The admitted copy must not alias the frozen input of the caller's job.
  const job = deepFreeze(issueJob());
  const admission = admit(job, {});
  assert.equal(admission.ok, true);
  assert.notEqual(admission.job, job);
  assert.deepEqual(Object.keys(admission.job).sort(), Object.keys(job).sort());
});

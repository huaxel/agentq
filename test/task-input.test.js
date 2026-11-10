'use strict';

/**
 * The generic pinned task input and its file source.
 *
 * A spec is read once, at enqueue time; the stored snapshot is what runs. These
 * tests use synthetic files only: no network, no gh.
 */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  MAX_INPUT_BYTES,
  createInlineTaskInput,
  readSpecFile,
  taskInputFromIssue,
  taskInputFromPrompt,
  taskInputFromTask,
  taskSlug,
  validateTaskInput,
  validateTaskJob,
} = require('../src/core/task-input.js');
const { createIssueInput } = require('../src/core/issue-input.js');
const { storedTier } = require('../src/core/auto-model.js');
const { SqliteSource } = require('../src/queue/sources.js');
const { resolveExecutor } = require('../src/runners/execute.js');

function workspace(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agentq-task-input-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const repo = path.join(root, 'repo');
  fs.mkdirSync(repo);
  return { root, repo };
}

function writeSpec(root, name, body) {
  const file = path.join(root, name);
  fs.writeFileSync(file, body);
  return file;
}

test('the file adapter takes the title from the first "# " heading', (t) => {
  const { root } = workspace(t);
  const file = writeSpec(root, 'spec.md', '# Ship the thing\n\nDo the work.\n');
  const input = readSpecFile(file);
  assert.equal(input.type, 'agentq.task-input/v1');
  assert.equal(input.source, 'file');
  assert.equal(input.ref, path.resolve(file));
  assert.equal(input.title, 'Ship the thing');
  assert.equal(input.body, '# Ship the thing\n\nDo the work.\n');
  assert.equal(input.url, null);
  assert.match(input.sha256, /^[a-f0-9]{64}$/);
  assert.deepEqual(validateTaskInput(input), input);
});

test('the file adapter falls back to the file name when there is no heading', (t) => {
  const { root } = workspace(t);
  const file = writeSpec(root, 'no-heading.md', 'Just prose, no heading.\n');
  assert.equal(readSpecFile(file).title, 'no-heading.md');
  // A heading that is not at line start is not a heading.
  const indented = writeSpec(root, 'indented.md', '  # not a heading\n');
  assert.equal(readSpecFile(indented).title, 'indented.md');
});

test('a missing, empty or oversized spec is refused with a one-line error', (t) => {
  const { root } = workspace(t);
  const missing = path.join(root, 'absent.md');
  assert.throws(() => readSpecFile(missing), /^Error: Spec file not found: /);

  const empty = writeSpec(root, 'empty.md', '   \n\t\n');
  assert.throws(() => readSpecFile(empty), /^Error: Spec file is empty: /);

  const oversized = writeSpec(root, 'big.md', `# Big\n\n${'x'.repeat(MAX_INPUT_BYTES + 1)}`);
  assert.throws(() => readSpecFile(oversized), /^Error: Spec file is larger than \d+ bytes: /);

  const directory = path.join(root, 'dir.md');
  fs.mkdirSync(directory);
  assert.throws(() => readSpecFile(directory), /^Error: Spec path is not a file: /);
});

test('a NUL byte in a spec names the NUL instead of the generic refusal', (t) => {
  const { root } = workspace(t);
  const file = writeSpec(root, 'nul.md', '# NUL spec\n\nbefore\0after\n');
  assert.throws(() => readSpecFile(file), /^Error: Task body must not contain a NUL byte\.$/);
  // The same field-level error for the title.
  const titleFile = writeSpec(root, 'title.md', '# bad\0title\n\nbody\n');
  assert.throws(() => readSpecFile(titleFile), /^Error: Task title must not contain a NUL byte\.$/);
});

test('a NUL byte in an inline body names the NUL instead of the generic refusal', () => {
  assert.throws(() => createInlineTaskInput('Title', 'before\0after'), /^Error: Task body must not contain a NUL byte\.$/);
  assert.throws(() => createInlineTaskInput('bad\0title', 'body'), /^Error: Task title must not contain a NUL byte\.$/);
});

test('an input over MAX_INPUT_BYTES after JSON encoding names the limit', () => {
  // Each quote doubles when JSON-encoded, so this body is under the raw limit
  // but over it once serialized: exactly the case the size guard exists for.
  const body = '"'.repeat(MAX_INPUT_BYTES - 100);
  assert.ok(Buffer.byteLength(body) < MAX_INPUT_BYTES);
  assert.throws(
    () => createInlineTaskInput('Title', body),
    new RegExp(`^Error: Pinned task input is larger than ${MAX_INPUT_BYTES} bytes\\.$`),
  );
});

test('the digest is stable for the same content and capture time', (t) => {
  const { root } = workspace(t);
  const file = writeSpec(root, 'spec.md', '# Stable\n\nbody\n');
  const capturedAt = '2026-11-10T00:00:00.000Z';
  const first = readSpecFile(file, capturedAt);
  const second = readSpecFile(file, capturedAt);
  assert.deepEqual(first, second);
  assert.equal(validateTaskInput(first).sha256, first.sha256);
  // Changing one byte changes the digest.
  fs.writeFileSync(file, '# Stable\n\nbody!\n');
  assert.notEqual(readSpecFile(file, capturedAt).sha256, first.sha256);
});

test('editing the file after enqueue does not change the stored input', async (t) => {
  const { root, repo } = workspace(t);
  const file = writeSpec(root, 'spec.md', '# Original spec\n\nDo the original work.\n');
  const source = new SqliteSource(path.join(root, 'queue.sqlite'));
  t.after(() => source.stop());

  const { id } = await source.enqueue({ repo, spec: file, base: 'main', model: 'test/model', trusted: true });
  fs.writeFileSync(file, '# Edited spec\n\nDo something else entirely.\n');

  const job = await source.claimNext();
  assert.equal(job.kind, 'spec');
  assert.equal(job.issue_number, null);
  assert.equal(job.task_input.title, 'Original spec');
  assert.equal(job.task_input.body, '# Original spec\n\nDo the original work.\n');
  assert.equal(job.task_input.ref, path.resolve(file));
  assert.equal(source.status()[0].id, id);
});

test('an inline input is the MCP shape: no ref, no url', () => {
  const input = createInlineTaskInput('Inline title', 'Inline body');
  assert.equal(input.source, 'inline');
  assert.equal(input.ref, null);
  assert.equal(input.url, null);
  assert.equal(input.title, 'Inline title');
  assert.equal(validateTaskInput(input).sha256, input.sha256);
  assert.throws(() => createInlineTaskInput('', 'body'), /invalid pinned task input/i);
});

test('a legacy issue snapshot converts at read time, in one place', () => {
  const legacy = createIssueInput({
    number: 42, title: 'Legacy issue', body: 'legacy body',
    url: 'https://github.com/test/repo/issues/42', updatedAt: '2026-11-02T00:00:00Z',
  });
  const converted = taskInputFromIssue(legacy);
  assert.equal(converted.source, 'github');
  assert.equal(converted.ref, '42');
  assert.equal(converted.title, 'Legacy issue');
  assert.equal(converted.body, 'legacy body');
  assert.equal(converted.capturedAt, legacy.captured_at);

  // A stored prompt in the old shape reads back as the generic input.
  assert.deepEqual(taskInputFromPrompt(JSON.stringify(legacy), 42), converted);
  assert.deepEqual(taskInputFromTask({ prompt: JSON.stringify(legacy), issue_num: 42 }), converted);
  // The same snapshot for another issue is not this task's input.
  assert.equal(taskInputFromPrompt(JSON.stringify(legacy), 43), null);
});

test('an old-shape issue task still validates and runs', async (t) => {
  const { root, repo } = workspace(t);
  const source = new SqliteSource(path.join(root, 'queue.sqlite'), {
    issueRunner: () => JSON.stringify({
      number: 7, title: 'Old issue', body: 'old body',
      url: 'https://github.com/test/repo/issues/7', updatedAt: '2026-11-02T00:00:00Z',
    }),
  });
  t.after(() => source.stop());
  const { id } = await source.enqueue({ repo, issue: '7', base: 'main', model: 'test/model', trusted: true });

  // Rewrite the row the way an older agentq stored it: the legacy snapshot.
  const legacy = createIssueInput({
    number: 7, title: 'Old issue', body: 'old body',
    url: 'https://github.com/test/repo/issues/7', updatedAt: '2026-11-02T00:00:00Z',
  });
  source.db.prepare('UPDATE tasks SET prompt = ? WHERE id = ?').run(JSON.stringify(legacy), id);

  const job = await source.claimNext();
  assert.equal(job.kind, 'github_issue');
  assert.equal(job.task_input.source, 'github');
  assert.equal(job.task_input.body, 'old body');
  assert.equal(job.task_input.sha256, taskInputFromIssue(legacy).sha256);
  assert.deepEqual(source.status()[0].input_error, undefined);
});

test('validateTaskJob refuses a spec without an input and accepts a valid one', () => {
  const input = createInlineTaskInput('Spec title', 'Spec body');
  assert.deepEqual(validateTaskJob({ kind: 'spec', prompt: JSON.stringify(input) }), input);
  assert.throws(() => validateTaskJob({ kind: 'spec', prompt: 'not a spec' }), /invalid pinned task input/i);
  assert.throws(
    () => validateTaskJob({ kind: 'spec', prompt: JSON.stringify({ ...input, body: 'tampered' }) }),
    /invalid pinned task input/i,
  );
  // A github job still requires a github input for its own issue number.
  assert.throws(() => validateTaskJob({ kind: 'github_issue', issue_number: 1, prompt: JSON.stringify(input) }),
    /invalid pinned task input/i);
  // Feedback and plain prompt jobs carry no pinned input.
  assert.equal(validateTaskJob({ kind: 'feedback', prompt: 'x' }), null);
  assert.equal(validateTaskJob({ kind: 'prompt', prompt: 'x' }), null);
});

test('a spec task defaults to pi-task.sh', () => {
  const executor = resolveExecutor({ kind: 'spec' }, { model: 'test/model' });
  assert.equal(executor, path.resolve(__dirname, '..', 'pi-task.sh'));
  // An explicit executor still wins.
  assert.equal(
    resolveExecutor({ kind: 'spec', executor: '/tmp/custom.sh' }, { model: 'test/model' }),
    path.resolve('/tmp/custom.sh'),
  );
});

test('the spec task subject names the title and the file', async (t) => {
  const { root, repo } = workspace(t);
  const file = writeSpec(root, 'spec.md', '# Named spec\n\nbody\n');
  const source = new SqliteSource(path.join(root, 'queue.sqlite'));
  t.after(() => source.stop());
  await source.enqueue({ repo, spec: file, base: 'main', model: 'test/model', trusted: true });
  const [job] = source.status();
  assert.equal(job.subject, `spec: Named spec (${path.resolve(file)})`);
  assert.equal(job.kind, 'spec');
});

test('a spec enqueue stores the requested tier in routing_policy', async (t) => {
  const { root, repo } = workspace(t);
  const file = writeSpec(root, 'spec.md', '# Tiered\n\nbody\n');
  const source = new SqliteSource(path.join(root, 'queue.sqlite'));
  t.after(() => source.stop());
  await source.enqueue({ repo, spec: file, base: 'main', model: 'test/model', tier: 'big', trusted: true });
  const row = source.db.prepare('SELECT routing_policy FROM tasks').get();
  assert.deepEqual(JSON.parse(row.routing_policy), { tier: 'big' });
  assert.equal(storedTier(row), 'big');
});

test('storedTier reads only a known tier out of routing_policy', () => {
  const row = (policy) => ({ routing_policy: policy });
  assert.equal(storedTier(row('{"tier":"small"}')), 'small');
  assert.equal(storedTier(row('{"tier":"big","other":1}')), 'big');
  assert.equal(storedTier(row('{"tier":"huge"}')), null);
  assert.equal(storedTier(row('not json')), null);
  assert.equal(storedTier(row(null)), null);
  assert.equal(storedTier({}), null);
  assert.equal(storedTier(null), null);
});

test('the spec slug matches what the executors create', (t) => {
  const { root } = workspace(t);
  // A file spec is named from the FILE, an inline one from its title.
  const spec = readSpecFile(writeSpec(root, 'fancy.md', '# A Fancy Title!\n\nbody\n'));
  assert.equal(taskSlug(spec), 'task-fancy');
  assert.equal(taskSlug(createInlineTaskInput('A Fancy Title!', 'body')), 'task-a-fancy-title');
  assert.equal(taskSlug(createInlineTaskInput('!!!', 'body')), 'task-spec');
  const issue = taskInputFromIssue(createIssueInput({
    number: 9, title: 'x', body: 'y',
    url: 'https://github.com/test/repo/issues/9', updatedAt: '2026-11-02T00:00:00Z',
  }));
  assert.equal(taskSlug(issue), 'issue-9');
});

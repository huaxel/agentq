'use strict';

/**
 * W24: `agentq show --id` — one task, everything about it.
 *
 * A spec task with a tier, one extra audit event and one outcome review, all in
 * a temp queue database. Covers the human report (header, pinned input, events,
 * reviews), the `--json` envelope, id-prefix resolution, the read-only promise
 * (show never creates the queue, and never re-reads a spec file), and the usage
 * errors.
 */

const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const dbModule = require('../src/queue/db.js');
const { ownStderr } = require('./helpers/stderr.js');

const AGENTQ = require.resolve('../src/interfaces/cli/agentq.js');
const MODEL = 'anthropic/claude-sonnet-4';

function tmpdir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'agentq-show-'));
}

/** @param {string} dbPath @param {string[]} args @param {Record<string,string>} [env] */
function runCli(dbPath, args, env = {}) {
  try {
    const stdout = execFileSync(process.execPath, [AGENTQ, '--db', dbPath, ...args], {
      encoding: 'utf8',
      env: { ...process.env, AGENTQ_QUOTA_REFRESH: '0', ...env },
      timeout: 30_000,
    });
    return { exitCode: 0, stdout, stderr: '' };
  } catch (error) {
    return { exitCode: error.status ?? 1, stdout: error.stdout || '', stderr: error.stderr || '' };
  }
}

function openDb(dbPath) {
  const db = dbModule.openDb(dbPath);
  dbModule.initSchema(db);
  return db;
}

/** A spec file with a heading (the pinned title) and more lines than `show` prints. */
function writeSpec(root, lines = 12) {
  const spec = path.join(root, 'show-one-task.md');
  const body = ['# Show one task in full', ''];
  for (let index = 1; index <= lines; index += 1) body.push(`Detail line ${index}.`);
  fs.writeFileSync(spec, `${body.join('\n')}\n`);
  return spec;
}

/**
 * Enqueue a spec task with a tier, then record one event and one review against
 * it through the store (the CLI has no write path for either).
 */
function seededTask(root) {
  const repo = path.join(root, 'repo');
  fs.mkdirSync(repo, { recursive: true });
  const spec = writeSpec(root);
  const dbPath = path.join(root, 'orchestrator.sqlite');
  const enqueued = runCli(dbPath, [
    'enqueue', '--repo', repo, '--spec', spec, '--model', MODEL, '--tier', 'medium', '--json',
  ]);
  assert.equal(enqueued.exitCode, 0, enqueued.stderr);
  const { id } = JSON.parse(enqueued.stdout);

  const db = openDb(dbPath);
  try {
    dbModule.createTaskEvent(db, id, 'model-chosen', { model: MODEL, tier: 'medium', reason: 'capacity' });
    dbModule.addReview(db, {
      model: MODEL,
      tier: 'medium',
      verdict: 'accepted-with-fixes',
      taskId: id,
      note: 'kept the pinned-input read',
      reviewer: 'juan',
    });
  } finally {
    db.close();
  }
  return { id, dbPath, repo, spec };
}

// --- Human output ---

test('show prints the header, the pinned input, the events and the reviews', () => {
  const root = tmpdir();
  const { id, dbPath } = seededTask(root);

  const result = runCli(dbPath, ['show', '--id', id]);
  assert.equal(result.exitCode, 0, result.stderr);
  const out = result.stdout;

  // Header, in the documented order.
  assert.match(out, /^id\s+[0-9a-f-]{36}$/m);
  assert.match(out, /^kind\s+spec$/m);
  assert.match(out, /^status\s+pending$/m);
  assert.match(out, /^model\s+anthropic\/claude-sonnet-4$/m);
  assert.match(out, /^tier\s+medium$/m);
  // A spec task's stored commit policy is `none`, so it is printed.
  assert.match(out, /^commit\s+none$/m);
  assert.match(out, /^attempts\s+0\/1$/m);
  assert.match(out, /^created\s+\d{4}-\d{2}-\d{2}T/m);
  assert.match(out, /^started\s+—$/m);
  assert.match(out, /^finished\s+—$/m);

  // Input: source, ref, title and the first lines of the pinned body.
  const sections = ['input', 'events', 'reviews'];
  const positions = sections.map((name) => out.indexOf(`\n${name}\n`));
  assert.deepEqual(positions, [...positions].sort((a, b) => a - b), `sections out of order: ${out}`);
  assert.match(out, /^ {2}source\s+file$/m);
  assert.match(out, /^ {2}ref\s+.*show-one-task\.md$/m);
  assert.match(out, /^ {2}title\s+Show one task in full$/m);
  assert.match(out, /^ {2}body\s+# Show one task in full$/m);
  // Exactly 5 body lines are on screen, and the count says how many are not.
  assert.match(out, /^ {10}Detail line 3\.$/m);
  assert.ok(!out.includes('Detail line 4.'), 'show printed more than 5 body lines');
  assert.match(out, /… \(\+9 more lines\)/);

  // Events: one line each, time then event then payload.
  assert.match(out, /^ {2}\d{4}-\d{2}-\d{2}T\S+\s+created\s+\{.*"kind":"spec"/m);
  assert.match(out, /^ {2}\d{4}-\d{2}-\d{2}T\S+\s+model-chosen\s+\{/m);
  assert.match(out, /"reason":"capacity"/);

  // Reviews: verdict, tier, reviewer and note.
  assert.match(out, /^ {2}\d{4}-\d{2}-\d{2}T\S+\s+accepted-with-fixes\s+medium\s+anthropic\/claude-sonnet-4\s+by juan\s+/m);
  assert.match(out, /kept the pinned-input read/);
});

test('show truncates a long event payload to about 100 characters', () => {
  const root = tmpdir();
  const { id, dbPath } = seededTask(root);
  const db = openDb(dbPath);
  try {
    dbModule.createTaskEvent(db, id, 'verification', { detail: 'x'.repeat(400) });
  } finally {
    db.close();
  }

  const out = runCli(dbPath, ['show', '--id', id]).stdout;
  const line = out.split('\n').find((entry) => entry.includes('verification'));
  assert.ok(line, `no verification line in:\n${out}`);
  const payload = line.slice(line.indexOf('verification') + 'verification'.length).trim();
  assert.equal(payload.length, 100, `payload cell was ${payload.length} chars`);
  assert.ok(payload.endsWith('…'), payload);
});

test('show keeps an enormous pinned body line to one printed line', () => {
  const root = tmpdir();
  const repo = path.join(root, 'repo');
  fs.mkdirSync(repo, { recursive: true });
  const spec = path.join(root, 'one-huge-line.md');
  fs.writeFileSync(spec, `# Huge line\n\n${'y'.repeat(2000)}\nafter the long line\n`);
  const dbPath = path.join(root, 'orchestrator.sqlite');
  const enqueued = runCli(dbPath, [
    'enqueue', '--repo', repo, '--spec', spec, '--model', MODEL, '--tier', 'small', '--json',
  ]);
  assert.equal(enqueued.exitCode, 0, enqueued.stderr);
  const { id } = JSON.parse(enqueued.stdout);

  const out = runCli(dbPath, ['show', '--id', id]).stdout;
  const lines = out.split('\n');
  const longLine = lines.find((line) => line.includes('yyy'));
  assert.ok(longLine, `no long body line in:\n${out}`);
  assert.equal(longLine.length, 10 + 100, `printed body cell was ${longLine.length - 10} chars`);
  assert.ok(longLine.endsWith('…'), longLine);
  // The line after it is short and prints whole, so nothing else was cut.
  assert.match(out, /^ {10}after the long line$/m);
});

test('show reads the pinned input, not the spec file as it is now', () => {
  const root = tmpdir();
  const { id, dbPath, spec } = seededTask(root);
  fs.writeFileSync(spec, '# Title rewritten after enqueue\n\nNothing like the pinned text.\n');

  const out = runCli(dbPath, ['show', '--id', id]).stdout;
  assert.match(out, /^ {2}title\s+Show one task in full$/m);
  assert.ok(!out.includes('Title rewritten after enqueue'), out);
});

test('show reports the sections a task does not have as empty', () => {
  const root = tmpdir();
  const dbPath = path.join(root, 'orchestrator.sqlite');
  const db = openDb(dbPath);
  let id;
  try {
    id = dbModule.createTask(db, { kind: 'prompt', prompt: 'a plain prompt with no pinned input' }).id;
  } finally {
    db.close();
  }

  const out = runCli(dbPath, ['show', '--id', id]).stdout;
  assert.match(out, /^model\s+—$/m);
  assert.match(out, /^provider\s+—$/m);
  assert.match(out, /^tier\s+—$/m);
  assert.match(out, /^attempts\s+0\/3$/m);
  // A prompt task has no stored commit policy, so there is no commit line.
  assert.ok(!/^commit/m.test(out), out);
  assert.match(out, /\ninput\n {2}\(none — this task has no pinned input\)/);
  assert.match(out, /\nevents\n {2}\d{4}-\d{2}-\d{2}T\S+\s+created\s+/);
  assert.match(out, /\nreviews\n {2}\(none\)/);

  // A prompt task has no pinned input to report, so its prompt stays visible.
  const detail = JSON.parse(runCli(dbPath, ['show', '--id', id, '--json']).stdout);
  assert.equal(detail.input, null);
  assert.equal(detail.task.prompt, 'a plain prompt with no pinned input');
  assert.equal(detail.reviews.length, 0);
});

// --- JSON envelope ---

test('show --json prints one object with task, input, events and reviews', () => {
  const root = tmpdir();
  const { id, dbPath, spec } = seededTask(root);

  const result = runCli(dbPath, ['show', '--id', id, '--json']);
  assert.equal(result.exitCode, 0, result.stderr);
  const detail = JSON.parse(result.stdout);
  assert.deepEqual(Object.keys(detail).sort(), ['events', 'input', 'reviews', 'task']);

  assert.equal(detail.task.id, id);
  assert.equal(detail.task.kind, 'spec');
  assert.equal(detail.task.status, 'pending');
  assert.equal(detail.task.model, MODEL);
  assert.equal(detail.task.tier, 'medium');
  assert.equal(detail.task.attempts, 0);
  assert.equal(detail.task.execution_policy.commit, 'none');
  assert.ok(detail.task.created_at);
  // The task text is reported once, under `input` — not again as the raw
  // snapshot and its parsed form inside `task`.
  assert.ok(!('prompt' in detail.task), JSON.stringify(Object.keys(detail.task)));
  assert.ok(!('task_input' in detail.task));
  assert.ok(!('task_input' in detail.input));

  assert.equal(detail.input.source, 'file');
  assert.equal(detail.input.ref, spec);
  assert.equal(detail.input.title, 'Show one task in full');
  assert.match(detail.input.body, /Detail line 12\./);
  assert.equal(result.stdout.split('Detail line 12.').length - 1, 1, 'the pinned body is repeated in --json');

  assert.deepEqual(detail.events.map((event) => event.event), ['created', 'model-chosen']);
  assert.deepEqual(detail.events[1].payload, { model: MODEL, tier: 'medium', reason: 'capacity' });

  assert.equal(detail.reviews.length, 1);
  assert.equal(detail.reviews[0].task_id, id);
  assert.equal(detail.reviews[0].verdict, 'accepted-with-fixes');
  assert.equal(detail.reviews[0].tier, 'medium');
  assert.equal(detail.reviews[0].reviewer, 'juan');
});

test('show --json only reports the reviews of the task it shows', () => {
  const root = tmpdir();
  const { id, dbPath } = seededTask(root);
  const db = openDb(dbPath);
  try {
    dbModule.addReview(db, { model: MODEL, tier: 'small', verdict: 'rejected', taskId: 'other-task', note: 'not mine' });
  } finally {
    db.close();
  }

  const detail = JSON.parse(runCli(dbPath, ['show', '--id', id, '--json']).stdout);
  assert.equal(detail.reviews.length, 1);
  assert.ok(!JSON.stringify(detail.reviews).includes('not mine'));
});

// --- Id resolution ---

test('show resolves a unique id prefix like every other --id', () => {
  const root = tmpdir();
  const { id, dbPath } = seededTask(root);
  const prefix = id.slice(0, 8);

  const human = runCli(dbPath, ['show', '--id', prefix]);
  assert.equal(human.exitCode, 0, human.stderr);
  assert.match(human.stdout, new RegExp(`^id\\s+${id}$`, 'm'));

  const json = JSON.parse(runCli(dbPath, ['show', '--id', prefix, '--json']).stdout);
  assert.equal(json.task.id, id);
});

test('an unknown id fails with the resolver error and a non-zero exit', () => {
  const root = tmpdir();
  const { dbPath } = seededTask(root);
  const missing = '0f0f0f0f-0f0f-4f0f-8f0f-0f0f0f0f0f0f';

  const result = runCli(dbPath, ['show', '--id', missing]);
  assert.notEqual(result.exitCode, 0);
  assert.equal(result.stdout, '');
  assert.match(result.stderr, new RegExp(`No task found with id ${missing}`));

  const short = runCli(dbPath, ['show', '--id', '0f0f0']);
  assert.notEqual(short.exitCode, 0);
  assert.match(short.stderr, /a prefix must be at least 6 characters/);
});

test('an ambiguous id prefix fails with the matches listed', () => {
  const root = tmpdir();
  const { dbPath } = seededTask(root);
  const db = openDb(dbPath);
  try {
    const created = new Date().toISOString();
    for (const suffix of ['11', '22']) {
      db.prepare('INSERT INTO tasks (id, kind, status, created_at) VALUES (?, ?, ?, ?)')
        .run(`abcdef${suffix}-0000-4000-8000-000000000000`, 'prompt', 'pending', created);
    }
  } finally {
    db.close();
  }

  const result = runCli(dbPath, ['show', '--id', 'abcdef']);
  assert.notEqual(result.exitCode, 0);
  assert.match(result.stderr, /Ambiguous id prefix abcdef matches 2 tasks/);
});

// --- Errors and read-only behaviour ---

test('show without --id fails with a one-line error', () => {
  const root = tmpdir();
  const { dbPath } = seededTask(root);

  const result = runCli(dbPath, ['show']);
  assert.notEqual(result.exitCode, 0);
  assert.equal(result.stdout, '');
  assert.equal(ownStderr(result.stderr), 'show requires --id');
  assert.equal(ownStderr(result.stderr).split('\n').length, 1);
});

test('show does not create a queue database it was pointed at', () => {
  const root = tmpdir();
  const dbPath = path.join(root, 'absent.sqlite');

  const result = runCli(dbPath, ['show', '--id', 'abcdef12']);
  assert.notEqual(result.exitCode, 0);
  assert.match(result.stderr, new RegExp(`No queue database at ${dbPath}`));
  assert.ok(!fs.existsSync(dbPath), `show created ${dbPath}`);
});

test('show is read-only: it leaves the queue file and its rows untouched', () => {
  const root = tmpdir();
  const { id, dbPath } = seededTask(root);
  const before = fs.readFileSync(dbPath);

  runCli(dbPath, ['show', '--id', id]);
  runCli(dbPath, ['show', '--id', id, '--json']);

  assert.ok(Buffer.compare(before, fs.readFileSync(dbPath)) === 0, 'show wrote to the queue file');
  const db = openDb(dbPath);
  try {
    assert.equal(dbModule.listTaskEvents(db, id).length, 2);
    assert.equal(dbModule.getTask(db, id).status, 'pending');
  } finally {
    db.close();
  }
});

test('show --source orchestrator refuses instead of reading the wrong queue', () => {
  const root = tmpdir();
  const { id, dbPath } = seededTask(root);

  const result = runCli(dbPath, ['--source', 'orchestrator', 'show', '--id', id]);
  assert.notEqual(result.exitCode, 0);
  assert.match(result.stderr, /not implemented for --source orchestrator/);
});

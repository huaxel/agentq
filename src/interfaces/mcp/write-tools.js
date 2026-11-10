'use strict';

/**
 * MCP write tools: enqueue, claim, complete.
 *
 * These are OFF by default and must be enabled explicitly (`--allow-write` or
 * `AGENTQ_MCP_WRITE=1`). The server only registers them when enabled, so a
 * read-only client never even sees them in `tools/list`.
 *
 * Three rules are enforced here, not in the client:
 *
 * 1. There is no approve/reject tool. Every task created through MCP is
 *    `approval_required = 1`, `source = 'mcp'`, `trust_level = 'untrusted'`,
 *    and the argument schema has no trust or approval fields at all. A human
 *    approves in the orchestrator dashboard or CLI.
 * 2. `claim_task` is a self-claim by a caller with no sandbox, so it may only
 *    claim what `admit(job, {})` would accept: approved, `trusted_agent`, not
 *    a feedback job, valid pinned issue input. The filter is applied BEFORE
 *    the claim (queue-side predicate), never as a post-claim failure.
 * 3. `claim_token` leaves the store only in the `claim_task` response, because
 *    the claimer needs it to complete. Every other projection omits it.
 *
 * Every external dependency is injected so the tools are unit-testable with
 * fakes and no database.
 */

const fs = require('node:fs');
const path = require('node:path');
const { admit } = require('../../core/admission.js');
const {
  TIERS,
  assertKnownArgs,
  optionalBoolean,
  optionalEnum,
  optionalNumber,
  requiredString,
  invalidArgument,
  shapeTask,
  admissionJob,
} = require('./shape.js');
const { REVIEW_TIERS, REVIEW_VERDICTS } = require('../../core/track-record.js');
const { createInlineTaskInput } = require('../../core/task-input.js');
const { storedTier } = require('../../core/auto-model.js');

/** Names of the tools this module builds. */
const WRITE_TOOL_NAMES = ['enqueue_task', 'claim_task', 'complete_task', 'review_task'];

const ENQUEUE_KINDS = ['prompt', 'github_issue', 'spec'];
const COMPLETE_STATUSES = ['succeeded', 'failed'];
const MAX_SUMMARY_CHARS = 4000;
const MAX_SPEC_TITLE_CHARS = 500;
const MAX_SPEC_BODY_CHARS = 100000;
const MAX_DEPENDS_ON = 20;

/**
 * Statuses a task may be reviewed in.
 *
 * The queue has no `done`: a finished success is `succeeded` and a finished
 * failure is `failed`. Anything still pending, running, unverified or rejected
 * has no outcome to review yet, so the review is refused rather than recorded
 * against work nobody has seen.
 */
const REVIEWABLE_STATUSES = ['succeeded', 'failed'];

/** Tier assumed when neither the argument nor the dispatch event names one. */
const DEFAULT_REVIEW_TIER = 'medium';
const MAX_NOTE_CHARS = 2000;

/** Kinds a self-claiming MCP caller must never take. */
const CLAIM_EXCLUDED_KINDS = ['feedback'];

/** Trust level a self-claiming MCP caller requires. */
const CLAIM_TRUST_LEVELS = ['trusted_agent'];

/**
 * @typedef {Object} WriteToolDeps
 * @property {(task: Record<string, any>) => Record<string, any>} createTask
 * @property {(options: Record<string, any>) => Record<string, any> | null} claimNextTask
 * @property {(id: string, result: Record<string, any>, options: { claimToken: string }) => void} completeTask
 * @property {(id: string) => Record<string, any> | undefined} getTask
 * @property {(id: string) => Array<Record<string, any>>} listTaskEvents task events, oldest first
 * @property {(review: Record<string, any>) => Record<string, any>} addReview
 * @property {(repo: string, issueNumber: number) => Record<string, any> | Promise<Record<string, any>>} captureIssueInput
 * @property {(tier: string) => { model: string, provider?: string|null }} resolveAutoModel
 * @property {number} [pid] process id used for the default worker id
 */

/**
 * Is the write surface enabled for this invocation?
 *
 * Only the exact string `1` enables writes through the environment: a value
 * like `0`, `false`, or an empty string must never be read as "on".
 *
 * @param {{ argv?: string[], env?: Record<string, string|undefined> }} [options]
 * @returns {boolean}
 */
function writeEnabled({ argv = [], env = {} } = {}) {
  if (argv.includes('--allow-write')) return true;
  return env.AGENTQ_MCP_WRITE === '1';
}

/**
 * @param {Record<string, any>} args
 * @returns {string[]|undefined}
 */
function optionalTaskIds(args) {
  const value = args.depends_on;
  if (value === undefined || value === null) return undefined;
  if (!Array.isArray(value)) throw invalidArgument('depends_on must be an array of task ids');
  if (value.length > MAX_DEPENDS_ON) throw invalidArgument(`depends_on must contain at most ${MAX_DEPENDS_ON} ids`);
  for (const id of value) {
    if (typeof id !== 'string' || id.trim() === '') throw invalidArgument('depends_on entries must be non-empty strings');
    if (id.length > 128) throw invalidArgument('depends_on entries must be at most 128 characters');
  }
  return value;
}

/**
 * Resolve and validate the repository a task will run in.
 *
 * The path is resolved through `realpath` so the stored value cannot be a
 * symlink to somewhere else, and it must be an existing directory holding a
 * `.git` entry (a directory for a normal clone, a file for a linked
 * worktree). Validation happens before any issue capture, so a bad path never
 * spends a `gh` call and never creates a task.
 *
 * @param {Record<string, any>} args
 * @param {string} key
 * @returns {string}
 */
function requiredRepoPath(args, key) {
  const value = requiredString(args, key, { max: 4096 });
  if (value.includes('\0')) throw invalidArgument(`${key} must not contain NUL bytes`);
  if (!path.isAbsolute(value)) throw invalidArgument(`${key} must be an absolute path`);

  /** @type {string} */
  let real;
  try {
    real = fs.realpathSync(value);
  } catch {
    throw invalidArgument(`${key} must be an existing directory: ${value}`);
  }
  /** @type {import('node:fs').Stats} */
  let stat;
  try {
    stat = fs.statSync(real);
  } catch {
    throw invalidArgument(`${key} must be an existing directory: ${value}`);
  }
  if (!stat.isDirectory()) throw invalidArgument(`${key} must be a directory: ${value}`);

  /** @type {import('node:fs').Stats|null} */
  let gitStat = null;
  try {
    gitStat = fs.statSync(path.join(real, '.git'));
  } catch {
    gitStat = null;
  }
  if (!gitStat || !(gitStat.isDirectory() || gitStat.isFile())) {
    throw invalidArgument(`${key} must be a Git repository (no .git in ${real})`);
  }
  return real;
}

/**
 * Build the write tool set.
 * @param {WriteToolDeps} deps
 * @returns {import('./protocol.js').McpTool[]}
 */
function buildWriteTools(deps) {
  if (!deps || typeof deps !== 'object') throw new TypeError('buildWriteTools requires a deps object');
  for (const key of ['createTask', 'claimNextTask', 'completeTask', 'getTask', 'listTaskEvents', 'addReview', 'captureIssueInput', 'resolveAutoModel']) {
    if (typeof (/** @type {any} */ (deps)[key]) !== 'function') {
      throw new TypeError(`buildWriteTools: deps.${key} must be a function`);
    }
  }
  const pid = Number.isInteger(deps.pid) ? deps.pid : process.pid;

  /**
   * Response for a created task. `approval_required` is reported as the
   * boolean the caller must act on, not the stored 0/1 flag.
   * @param {Record<string, any>} created
   * @returns {Record<string, any>}
   */
  const respond = (created) => ({
    id: created.id,
    status: created.status ?? 'pending',
    approval_required: true,
    next: 'A human must approve this task in the orchestrator dashboard or CLI before any worker can claim it.',
  });

  return [
    {
      name: 'enqueue_task',
      description:
        'Enqueue a task on the agentq queue. The task is ALWAYS created untrusted with '
        + 'approval_required: a human must approve it in the orchestrator dashboard or CLI '
        + 'before any worker can claim it. There is no approve tool and no trust or approval '
        + 'argument. For kind "github_issue" the server captures a pinned snapshot of the issue '
        + 'now (title, body, url, updated_at, digest) and the task runs against that snapshot, '
        + 'not against later edits. Returns the new task id and status.',
      inputSchema: {
        type: 'object',
        properties: {
          kind: {
            type: 'string',
            enum: ENQUEUE_KINDS,
            description: '"github_issue" to work a GitHub issue, "spec" for an inline specification, "prompt" for a free-form instruction.',
          },
          repo: {
            type: 'string',
            description: 'Absolute path to an existing Git repository (a directory containing .git) the worker should operate on.',
          },
          issue: {
            type: 'integer',
            minimum: 1,
            description: 'GitHub issue number. Required for kind "github_issue", invalid otherwise.',
          },
          prompt: {
            type: 'string',
            maxLength: 100000,
            description: 'Task instruction. Required for kind "prompt", invalid otherwise.',
          },
          title: {
            type: 'string',
            maxLength: MAX_SPEC_TITLE_CHARS,
            description: `Spec title. Required for kind "spec", invalid otherwise (max ${MAX_SPEC_TITLE_CHARS} characters).`,
          },
          body: {
            type: 'string',
            maxLength: MAX_SPEC_BODY_CHARS,
            description: `Spec body, the whole specification text. Required for kind "spec", invalid otherwise (max ${MAX_SPEC_BODY_CHARS} characters).`,
          },
          model: {
            type: 'string',
            maxLength: 128,
            default: 'auto',
            description: 'Model id, or "auto" to let the claimer route by capacity. Defaults to "auto".',
          },
          priority: {
            type: 'integer',
            minimum: -100,
            maximum: 100,
            default: 0,
            description: 'Queue priority, higher runs first. Defaults to 0.',
          },
          depends_on: {
            type: 'array',
            items: { type: 'string', maxLength: 128 },
            maxItems: MAX_DEPENDS_ON,
            description: `Task ids that must succeed first (max ${MAX_DEPENDS_ON}).`,
          },
        },
        required: ['kind', 'repo'],
        additionalProperties: false,
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
      handler(args) {
        assertKnownArgs(args, ['kind', 'repo', 'issue', 'prompt', 'title', 'body', 'model', 'priority', 'depends_on']);
        const kind = optionalEnum(args, 'kind', ENQUEUE_KINDS);
        if (!kind) throw invalidArgument(`kind is required and must be one of: ${ENQUEUE_KINDS.join(', ')}`);
        const repo = requiredRepoPath(args, 'repo');
        const issue = optionalNumber(args, 'issue', { min: 1, integer: true });
        const priority = optionalNumber(args, 'priority', { min: -100, max: 100, integer: true }) ?? 0;
        const dependsOn = optionalTaskIds(args);
        const model = args.model === undefined || args.model === null
          ? 'auto'
          : requiredString(args, 'model', { max: 128 });
        if (kind !== 'spec' && (args.title !== undefined || args.body !== undefined)) {
          throw invalidArgument('title and body are only valid for kind "spec"');
        }

        /** @type {Record<string, any>} */
        const task = {
          kind,
          repo,
          model,
          priority,
          depends_on: dependsOn,
          // Non-negotiable: no argument can change these three.
          source: 'mcp',
          trust_level: 'untrusted',
          approval_required: 1,
        };

        if (kind === 'github_issue') {
          if (issue === undefined) throw invalidArgument('issue is required for kind "github_issue"');
          if (args.prompt !== undefined && args.prompt !== null) {
            throw invalidArgument('prompt is not allowed for kind "github_issue": the issue snapshot is captured server-side');
          }
          task.issue_num = issue;

          const capture = () => deps.captureIssueInput(repo, issue);
          const finish = (input) => {
            if (!input || typeof input !== 'object') {
              throw new Error('Issue capture returned no snapshot; nothing was enqueued.');
            }
            task.prompt = JSON.stringify(input);
            return respond(deps.createTask(task));
          };
          const pending = capture();
          if (pending && typeof (/** @type {any} */ (pending).then) === 'function') {
            return Promise.resolve(pending).then(finish);
          }
          return finish(pending);
        }

        if (issue !== undefined) throw invalidArgument('issue is only valid for kind "github_issue"');

        if (kind === 'spec') {
          if (args.prompt !== undefined && args.prompt !== null) {
            throw invalidArgument('prompt is not allowed for kind "spec": give title and body');
          }
          const title = requiredString(args, 'title', { max: MAX_SPEC_TITLE_CHARS });
          const body = requiredString(args, 'body', { max: MAX_SPEC_BODY_CHARS });
          task.prompt = JSON.stringify(createInlineTaskInput(title, body));
          return respond(deps.createTask(task));
        }

        task.prompt = requiredString(args, 'prompt', { max: 100000 });
        return respond(deps.createTask(task));
      },
    },
    {
      name: 'claim_task',
      description:
        'Claim the next eligible task for this caller. Only tasks a sandbox-less caller may '
        + 'actually run are considered: trusted tasks (trust_level "trusted_agent"), approved if '
        + 'approval was required, kind not "feedback", and a valid pinned issue snapshot. '
        + 'Ineligible tasks stay pending and are skipped, never claimed and failed. Returns the '
        + 'task summary, the claim_token needed to complete it, and the task text under '
        + 'untrusted_content. Returns { "claimed": null } when nothing is eligible.',
      inputSchema: {
        type: 'object',
        properties: {
          kind: {
            type: 'string',
            maxLength: 64,
            default: 'github_issue',
            description: 'Task kind to claim. Defaults to "github_issue"; "feedback" is refused.',
          },
          worker_id: {
            type: 'string',
            maxLength: 128,
            description: 'Worker identity recorded on the claim. Defaults to "mcp-<pid>".',
          },
          tier: {
            type: 'string',
            enum: TIERS,
            default: 'medium',
            description: 'Tier used to route tasks whose model is "auto". Defaults to medium.',
          },
        },
        additionalProperties: false,
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
      handler(args) {
        assertKnownArgs(args, ['kind', 'worker_id', 'tier']);
        const kind = args.kind === undefined || args.kind === null
          ? 'github_issue'
          : requiredString(args, 'kind', { max: 64, pattern: /^[a-z][a-z0-9_]*$/ });
        if (CLAIM_EXCLUDED_KINDS.includes(kind)) {
          throw invalidArgument(`kind "${kind}" cannot be self-claimed over MCP: feedback content is always untrusted`);
        }
        const workerId = args.worker_id === undefined || args.worker_id === null
          ? `mcp-${pid}`
          : requiredString(args, 'worker_id', { max: 128 });
        const tier = optionalEnum(args, 'tier', TIERS) ?? 'medium';

        // Route lazily: only a task whose model is "auto" needs a decision, and
        // a routing failure must skip that task rather than claim it with an
        // unresolved model. The first failure is remembered so a claim that
        // ends up empty can report why.
        /** @type {{ ok: true, value: { model: string, provider: string|null } } | { ok: false, error: Error } | null} */
        let resolution = null;
        const resolveAuto = () => {
          if (resolution === null) {
            try {
              const value = deps.resolveAutoModel(tier);
              if (!value || typeof value.model !== 'string' || value.model.trim() === '') {
                throw new Error(`no eligible model for tier "${tier}"`);
              }
              resolution = { ok: true, value: { model: value.model, provider: value.provider ?? null } };
            } catch (error) {
              resolution = { ok: false, error: error instanceof Error ? error : new Error(String(error)) };
            }
          }
          if (!resolution.ok) throw resolution.error;
          return resolution.value;
        };

        const claimed = deps.claimNextTask({
          kind,
          workerId,
          trustLevels: CLAIM_TRUST_LEVELS,
          excludeKinds: CLAIM_EXCLUDED_KINDS,
          resolveAutoModel: resolveAuto,
          acceptCandidate: (row) => admit(admissionJob(row), {}).ok,
        });

        if (!claimed) {
          if (resolution && !resolution.ok) {
            throw new Error(
              `Cannot claim a task with model "auto": routing found no eligible model for tier "${tier}" `
              + `(${resolution.error.message}). Nothing was claimed.`,
            );
          }
          return { claimed: null };
        }

        return {
          ...shapeTask(claimed),
          claim_token: claimed.claim_token,
          next: 'Work the task, then call complete_task with this id and claim_token before lease_expires_at.',
        };
      },
    },
    {
      name: 'complete_task',
      description:
        'Report the outcome of a task you claimed. Requires the claim_token returned by '
        + 'claim_task: a wrong or stale token is rejected and the task is left unchanged. '
        + 'Report "failed" for work that did not succeed; the queue may re-pend the task if it '
        + 'has attempts left. A "succeeded" report without verified: true is stored as '
        + '"unverified", which keeps dependents blocked until a human verifies the work.',
      inputSchema: {
        type: 'object',
        properties: {
          id: { type: 'string', minLength: 1, maxLength: 128, description: 'Task id.' },
          claim_token: {
            type: 'string',
            minLength: 1,
            maxLength: 128,
            description: 'The claim_token returned by claim_task for this claim.',
          },
          status: {
            type: 'string',
            enum: COMPLETE_STATUSES,
            description: 'Outcome to record.',
          },
          summary: {
            type: 'string',
            minLength: 1,
            maxLength: MAX_SUMMARY_CHARS,
            description: `Short human-readable result (max ${MAX_SUMMARY_CHARS} characters).`,
          },
          branch: {
            type: 'string',
            maxLength: 255,
            description: 'Branch the work landed on, when applicable.',
          },
          verified: {
            type: 'boolean',
            description: 'Whether the change was independently verified (tests run, diff reviewed).',
          },
        },
        required: ['id', 'claim_token', 'status', 'summary'],
        additionalProperties: false,
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
      handler(args) {
        assertKnownArgs(args, ['id', 'claim_token', 'status', 'summary', 'branch', 'verified']);
        const id = requiredString(args, 'id', { max: 128 });
        const claimToken = requiredString(args, 'claim_token', { max: 128 });
        const status = optionalEnum(args, 'status', COMPLETE_STATUSES);
        if (!status) throw invalidArgument(`status is required and must be one of: ${COMPLETE_STATUSES.join(', ')}`);
        const summary = requiredString(args, 'summary', { max: MAX_SUMMARY_CHARS });
        const branch = args.branch === undefined || args.branch === null
          ? null
          : requiredString(args, 'branch', { max: 255 });
        const verified = optionalBoolean(args, 'verified') ?? false;
        // Repo convention: only an explicitly verified success is 'succeeded';
        // dependents unblock on 'succeeded' alone, so an unverified claim of
        // success must stay distinguishable from a verified one.
        const storedStatus = status === 'succeeded' && verified !== true ? 'unverified' : status;

        // Fence on the claim token only: the token identifies the CLAIM, which
        // is strictly stronger than the claimant identity (a stale session of
        // the same worker must not complete a later re-claim). The MCP caller
        // has no stable worker identity to assert here.
        deps.completeTask(id, {
          status: storedStatus,
          summary,
          branch,
          verified,
          reported_by: 'mcp',
        }, { claimToken });

        const after = deps.getTask(id);
        return {
          id,
          status: after?.status ?? null,
          requested_status: status,
          stored_status: storedStatus,
          // A failed task with attempts remaining is re-pended rather than
          // terminal; report that instead of implying the task is finished.
          retried: after?.status === 'pending',
        };
      },
    },
    {
      name: 'review_task',
      description:
        'Record what you thought of what a model produced for a finished task. This is an '
        + 'outcome review, not a status change: it never re-runs, re-pends or completes anything. '
        + 'The model is the one the task actually ran on (the latest model-chosen event, else '
        + 'the task\'s stored model); the tier is the argument, else the tier recorded at dispatch. '
        + 'Only a succeeded or failed task can be reviewed. Reviews fold into per-model track '
        + 'records that inform routing, and a strong record can make a model with no '
        + 'intelligence score eligible. Returns the recorded review.',
      inputSchema: {
        type: 'object',
        properties: {
          id: { type: 'string', minLength: 1, maxLength: 128, description: 'Task id.' },
          verdict: {
            type: 'string',
            enum: REVIEW_VERDICTS,
            description: '"accepted" (usable as is), "accepted-with-fixes" (usable after edits), or "rejected".',
          },
          note: {
            type: 'string',
            maxLength: MAX_NOTE_CHARS,
            description: `Short note on what was right or wrong (max ${MAX_NOTE_CHARS} characters).`,
          },
          tier: {
            type: 'string',
            enum: REVIEW_TIERS,
            description: 'Tier the work is judged at. Defaults to the tier recorded at dispatch, else medium.',
          },
        },
        required: ['id', 'verdict'],
        additionalProperties: false,
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
      handler(args) {
        assertKnownArgs(args, ['id', 'verdict', 'note', 'tier']);
        const id = requiredString(args, 'id', { max: 128 });
        const verdict = optionalEnum(args, 'verdict', REVIEW_VERDICTS);
        if (!verdict) {
          throw invalidArgument(`verdict is required and must be one of: ${REVIEW_VERDICTS.join(', ')}`);
        }
        const note = args.note === undefined || args.note === null
          ? null
          : requiredString(args, 'note', { max: MAX_NOTE_CHARS });
        const requestedTier = optionalEnum(args, 'tier', REVIEW_TIERS);

        const task = deps.getTask(id);
        if (!task) throw new Error(`Task not found: ${id}`);
        const status = typeof task.status === 'string' ? task.status : 'unknown';
        if (!REVIEWABLE_STATUSES.includes(status)) {
          throw invalidArgument(
            `task ${id} is ${status}: only a ${REVIEWABLE_STATUSES.join(' or ')} task has an outcome to review`,
          );
        }

        // The dispatch event is the audit trail of what actually ran: a task
        // queued as "auto" stores 'auto', so its stored model says nothing.
        const chosen = latestModelChoice(deps.listTaskEvents(id));
        const model = chosen.model ?? (typeof task.model === 'string' && task.model.trim() && task.model !== 'auto'
          ? task.model.trim()
          : null);
        if (!model) {
          throw new Error(`task ${id} has no recorded model: nothing to attribute the review to`);
        }
        const tier = requestedTier ?? chosen.tier ?? storedTier(task) ?? DEFAULT_REVIEW_TIER;

        const review = deps.addReview({
          model,
          tier,
          verdict,
          taskId: id,
          note,
          reviewer: 'mcp',
        });
        return {
          id,
          model,
          tier,
          verdict,
          review,
        };
      },
    },
  ];
}

/**
 * The model and tier from the most recent `model-chosen` event.
 *
 * The payload is stored as JSON text; an unreadable or absent payload simply
 * contributes nothing, so the caller falls back to the task row.
 *
 * @param {Array<Record<string, any>>|null|undefined} events oldest first
 * @returns {{ model: string|null, tier: string|null }}
 */
function latestModelChoice(events) {
  const rows = Array.isArray(events) ? events : [];
  for (let index = rows.length - 1; index >= 0; index -= 1) {
    const row = rows[index];
    if (!row || row.event !== 'model-chosen') continue;
    let payload = row.payload;
    if (typeof payload === 'string') {
      try {
        payload = JSON.parse(payload);
      } catch {
        payload = null;
      }
    }
    if (!payload || typeof payload !== 'object') return { model: null, tier: null };
    return {
      model: typeof payload.model === 'string' && payload.model ? payload.model : null,
      tier: typeof payload.tier === 'string' && REVIEW_TIERS.includes(payload.tier) ? payload.tier : null,
    };
  }
  return { model: null, tier: null };
}

module.exports = {
  buildWriteTools,
  writeEnabled,
  requiredRepoPath,
  WRITE_TOOL_NAMES,
  ENQUEUE_KINDS,
  COMPLETE_STATUSES,
  MAX_SUMMARY_CHARS,
  MAX_SPEC_TITLE_CHARS,
  MAX_SPEC_BODY_CHARS,
  MAX_DEPENDS_ON,
  CLAIM_EXCLUDED_KINDS,
  CLAIM_TRUST_LEVELS,
  REVIEWABLE_STATUSES,
  DEFAULT_REVIEW_TIER,
  latestModelChoice,
};

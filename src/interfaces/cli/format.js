'use strict';

/**
 * Pure formatting and presentation helpers for the agentq CLI: model/capacity
 * rows, job summary blocks, and cost formatting. No I/O; every function is
 * exported for direct testing.
 *
 * Model rows are built from the routing core's own inputs (catalog + capacity)
 * so the CLI can never show a model the router would not consider.
 */

const path = require('node:path');
const { capacityFor } = require('../../core/capacity.js');
const { recordCell, reviewsToUnlock } = require('../../core/track-record.js');
const { formatCost: formatPrice, formatDollars } = require('../../lib/path-prices.js');

/**
 * @param {import('../../core/capacity.js').CapacityEntry|undefined} entry
 * @returns {string}
 */
function capacityText(entry) {
  if (!entry || entry.state === 'unknown') return `unknown (${(entry && entry.reason) || 'no data'})`;
  if (entry.state === 'saturated') return `saturated (${entry.headroomPct}% left)`;
  return entry.headroomPct == null ? 'available' : `available (${entry.headroomPct}% left)`;
}

/**
 * Join catalog entries with capacity and the routing decision.
 *
 * @param {{
 *   catalog?: import('../../core/catalog.js').CatalogEntry[],
 *   capacity?: Map<string, import('../../core/capacity.js').CapacityEntry>|null,
 *   decision?: { default: any, rejected: any[] }|null,
 * }} [input]
 * @returns {Array<{ model: string, path: string, intelligence: number|null, costPerMTok: number|null, capacity: any, recommended: boolean, reasons: string[] }>}
 */
function buildModelRows({ catalog = [], capacity = null, decision = null } = {}) {
  const recommendedId = decision && decision.default ? decision.default.id : null;
  const rejected = new Map(((decision && decision.rejected) || []).map((item) => [item.id, item.reasons || []]));

  return catalog.map((entry) => {
    const recommended = entry.id === recommendedId;
    const reasons = rejected.get(entry.id) ?? (recommended ? decision.default.reasons || [] : []);
    return {
      model: entry.id,
      path: entry.path,
      intelligence: entry.intelligence,
      intelligenceSource: entry.intelligenceSource ?? null,
      costPerMTok: entry.costPerMTok,
      costSource: entry.costSource ?? null,
      capacity: capacityFor(capacity, entry.path),
      recommended,
      reasons,
    };
  });
}

/**
 * Intelligence as a table cell. An AA-derived estimate is marked `~` so it is
 * never read as a real score.
 *
 * @param {{ intelligence?: number|null, intelligenceSource?: string|null }} entry
 * @returns {string}
 */
function intelligenceCell(entry) {
  if (entry.intelligence == null) return '—';
  const value = Number(entry.intelligence).toFixed(1);
  return entry.intelligenceSource === 'aa-estimate' ? `~${value}` : value;
}

/**
 * A $/MTok amount with enough precision to compare. Allowance-scaled
 * subscription prices are fractions of a cent, and `$0.00` would hide the
 * ordering the table exists to show: two decimals from $1, four below it.
 *
 * @param {number} amount
 * @returns {string}
 */
function dollars(amount) {
  const value = Number(amount);
  if (value === 0) return '$0';
  return `$${Math.abs(value) >= 1 ? value.toFixed(2) : value.toFixed(4)}`;
}

/**
 * Cost as a table cell. An AA list price is marked `~` like the estimate it
 * travels with.
 *
 * @param {{ costPerMTok?: number|null, costSource?: string|null }} entry
 * @returns {string}
 */
function costCell(entry) {
  if (entry.costPerMTok == null) return '—';
  const value = dollars(entry.costPerMTok);
  return entry.costSource === 'aa-price' ? `~${value}` : value;
}

/**
 * Pace-adjusted cost as a table cell, marked like the list price it scales.
 *
 * @param {{ effectiveCostPerMTok?: number|null, costSource?: string|null }} entry
 * @returns {string}
 */
function effectiveCostCell(entry) {
  if (entry.effectiveCostPerMTok == null) return '—';
  const value = dollars(entry.effectiveCostPerMTok);
  return entry.costSource === 'aa-price' ? `~${value}` : value;
}

/**
 * Pace as a table cell: `behind 30%`, `ahead 140%`, `on 95%`, or `—` when the
 * path reports no window it can project.
 *
 * @param {{ pace?: { state?: string, projectedPct?: number|null }|null }} entry
 * @returns {string}
 */
function paceCell(entry) {
  const pace = entry && entry.pace;
  if (!pace || typeof pace.projectedPct !== 'number' || !Number.isFinite(pace.projectedPct)) return '—';
  return `${pace.state} ${Math.round(pace.projectedPct)}%`;
}

/** Longest subscription name the path column shows before it is elided. */
const PATH_NAME_MAX = 24;

/**
 * The path column of the options table: the funding subscription's name, with
 * the quota path id in brackets when the two differ (`Claude Pro (claudemax)`).
 * The name is elided to 24 characters so one long subscription cannot push the
 * rest of the row off the screen; the id is never elided, because it is what a
 * caller passes back to dispatch.
 *
 * @param {{ path?: string, pathName?: string }} option
 * @returns {string}
 */
function pathCell(option) {
  const id = typeof option?.path === 'string' ? option.path : '';
  const raw = typeof option?.pathName === 'string' && option.pathName ? option.pathName : id;
  if (!raw || raw === id) return id || '—';
  const name = raw.length > PATH_NAME_MAX ? `${raw.slice(0, PATH_NAME_MAX - 1)}…` : raw;
  return `${name} (${id})`;
}

/**
 * @param {ReturnType<typeof buildModelRows>[number]} row
 * @param {number|string} index
 * @returns {string}
 */
function formatModelRow(row, index) {
  const intel = intelligenceCell(row);
  const cost = costCell(row);
  const mark = row.recommended ? '→' : ' ';
  const note = row.recommended ? 'recommended' : ((row.reasons || []).at(-1) || 'eligible');
  return `  ${mark} ${index}  ${row.model.padEnd(44)} ${(row.path || '—').padEnd(12)} ${intel.padStart(5)} ${cost.padStart(7)}  ${capacityText(row.capacity).padEnd(30)} ${note}`;
}

/**
 * @param {{
 *   catalog?: import('../../core/catalog.js').CatalogEntry[],
 *   capacity?: Map<string, import('../../core/capacity.js').CapacityEntry>|null,
 *   decision?: { default: any, rejected: any[], policy?: { floor: number } }|null,
 *   title?: string,
 * }} [input]
 * @returns {string}
 */
function formatModelTable({ catalog = [], capacity = null, decision = null, title = 'models' } = {}) {
  const floor = decision && decision.policy ? ` (intelligence floor ${decision.policy.floor})` : '';
  const lines = [
    `${title} — auto = cheapest eligible first${floor}`,
    '',
    `  #  ${'model'.padEnd(44)} ${'path'.padEnd(12)} ${'intel'.padStart(5)} ${'$/MTok'.padStart(7)}  capacity`,
  ];
  buildModelRows({ catalog, capacity, decision }).forEach((row, i) => lines.push(formatModelRow(row, i + 1)));
  return lines.join('\n');
}

/**
 * The shortlist as a short table: one row per option, with the roles it plays.
 *
 * This is what `agentq pick` prints instead of the whole catalog: the point of
 * the routing core is to inform a choice, and a caller cannot weigh forty rows.
 * `default` is printed by the caller underneath, never as a row: it is what
 * "auto" would pick, not a verdict on the options.
 *
 * The `record` column is the outcome-review track record for the requested
 * tier (`5/6`), or `—` when there is none. It is informational: only a model
 * with no intelligence at all can be made eligible by it, and the table says
 * so through its reasons, not by reordering rows.
 *
 * @param {Array<{ id: string, path: string, pathName?: string, roles: string[], intelligence: number|null, intelligenceSource?: string|null, costPerMTok: number|null, costSource?: string|null, effectiveCostPerMTok?: number|null, pace?: { state?: string, projectedPct?: number|null }|null, headroomPct: number|null, resetsAt: string|null, trackRecord?: { n: number, accepted: number, withFixes: number }|null }>} [options]
 * @param {{ title?: string }} [input]
 * @returns {string}
 */
function formatOptionsTable(options = [], { title = 'options' } = {}) {
  // The path cells vary in length (`go` vs `Claude Pro (claudemax)`), so the
  // column is sized to the widest one instead of a fixed width that would
  // misalign every column after it.
  const paths = options.map((option) => pathCell(option));
  const pathWidth = Math.max('path'.length, ...paths.map((cell) => cell.length));
  const lines = [
    title,
    '',
    `  ${'id'.padEnd(44)} ${'path'.padEnd(pathWidth)} ${'roles'.padEnd(40)} ${'intel'.padStart(5)} ${'$/MTok'.padStart(7)} ${'eff $/MTok'.padStart(10)} ${'headroom'.padStart(8)} ${'record'.padStart(6)}  pace`,
  ];
  options.forEach((option, index) => {
    const headroom = option.headroomPct == null ? '—' : `${option.headroomPct}%`;
    const roles = (option.roles || []).join(', ');
    lines.push(
      `  ${String(option.id).padEnd(44)} ${paths[index].padEnd(pathWidth)} ${roles.padEnd(40)} `
      + `${intelligenceCell(option).padStart(5)} ${costCell(option).padStart(7)} ${effectiveCostCell(option).padStart(10)} `
      + `${headroom.padStart(8)} ${recordCell(option.trackRecord).padStart(6)}  ${paceCell(option)}`,
    );
  });
  return lines.join('\n');
}

/**
 * The track records as a table: one row per (model key, tier).
 *
 * `rate` is the weighted acceptance rate (with-fixes counts half), `lower` is
 * the Wilson 95% bound the unlock thresholds compare against, `needed` is how
 * many more accepted reviews would clear both thresholds (0 already unlocks,
 * `—` is out of reach), and `unlock` says whether this record would make an
 * unscored model at this tier eligible.
 *
 * @param {{ count: number, records: Array<{ model: string, tier: string, n: number, accepted: number, withFixes: number, rejected: number, rate: number, lowerBound: number, needed?: number|null }> }} [stats]
 * @param {{ minReviews?: number, minLowerBound?: number }} [policy]
 * @returns {string}
 */
function formatTrackRecordTable(stats, { minReviews = 5, minLowerBound = 0.7 } = {}) {
  const records = stats && Array.isArray(stats.records) ? stats.records : [];
  if (!records.length) return 'no track records: record one with "agentq review add"';
  const width = Math.max('model'.length, ...records.map((record) => record.model.length));
  const lines = [
    'track records — outcome reviews, weighted (accepted 1, with-fixes 0.5, rejected 0)',
    '',
    `  ${'model'.padEnd(width)} ${'tier'.padEnd(6)} ${'n'.padStart(3)} ${'ok'.padStart(4)} ${'fix'.padStart(4)} ${'no'.padStart(3)} ${'rate'.padStart(6)} ${'lower'.padStart(6)} ${'needed'.padStart(6)}  unlock`,
  ];
  for (const record of records) {
    const unlock = record.n >= minReviews && record.lowerBound >= minLowerBound ? 'yes' : 'no';
    // The row is authoritative; a row built without `needed` gets measured
    // against the same policy the `unlock` column uses.
    const needed = Number.isFinite(record.needed)
      ? record.needed
      : reviewsToUnlock(record, { minReviews, minLowerBound });
    const neededCell = String(needed ?? '—').padStart(6);
    lines.push(
      `  ${record.model.padEnd(width)} ${record.tier.padEnd(6)} ${String(record.n).padStart(3)} `
      + `${String(record.accepted).padStart(4)} ${String(record.withFixes).padStart(4)} ${String(record.rejected).padStart(3)} `
      + `${record.rate.toFixed(2).padStart(6)} ${record.lowerBound.toFixed(2).padStart(6)} ${neededCell}  ${unlock}`,
    );
  }
  lines.push('', '  needed — further accepted reviews to clear both thresholds (0 already unlocks, — is out of reach)');
  return lines.join('\n');
}

/**
 * The price-table gap report as text: one block per priced quota path, the
 * missing (priced, not runnable) models cheapest first, then the runnables the
 * price table does not cover.
 *
 * @param {{ paths?: Array<{ path: string, pathName: string, fee: number, missing: Array<{ modelKey: string, costPerMTok: number|null, reason: string|null, expired: boolean }>, unpriced: Array<{ id: string, modelKey: string }> }> }} [report]
 * @returns {string}
 */
function formatGapReport(report) {
  const paths = report && Array.isArray(report.paths) ? report.paths : [];
  if (!paths.length) return 'no priced paths: add a "prices" table to config.paths[]';
  const lines = ['path gaps — priced models with no runnable, cheapest first', ''];
  for (const entry of paths) {
    const name = entry.pathName && entry.pathName !== entry.path ? `${entry.pathName} (${entry.path})` : entry.path;
    lines.push(`${name} — fee ${formatDollars(entry.fee)}`);
    if (!entry.missing.length && !entry.unpriced.length) {
      lines.push('  no gaps');
      continue;
    }
    for (const gap of entry.missing) {
      const cost = gap.costPerMTok === null ? '—' : `${formatPrice(gap.costPerMTok)}/MTok`;
      const note = gap.expired ? 'expired' : (gap.reason || '');
      lines.push(`  missing   ${gap.modelKey.padEnd(28)} ${cost.padStart(12)}  ${note}`);
    }
    for (const gap of entry.unpriced) {
      lines.push(`  unpriced  ${gap.id.padEnd(28)} ${'—'.padStart(12)}  no price entry (falls back to roi or aa-price)`);
    }
  }
  return lines.join('\n');
}

function truncateRepo(repoPath) {
  return path.basename(repoPath || '');
}

/** Body lines `agentq show` prints before it counts the rest. */
const SHOW_BODY_LINES = 5;
/** Characters `agentq show` prints for one cell: a body line, a payload, a note. */
const SHOW_CELL_CHARS = 100;
/** Label width of the `show` header block (`attempts`, `provider`, `finished`). */
const SHOW_LABEL_WIDTH = 8;
/** Label width inside the `show` input block (`source`). */
const SHOW_INPUT_LABEL_WIDTH = 6;

/**
 * Cut a string to `max` characters, ellipsis included, so a cell never grows
 * past the width its caller asked for.
 *
 * @param {string} text
 * @param {number} max
 * @returns {string}
 */
function truncateTo(text, max) {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}

/**
 * Any value as one display cell: whitespace collapses, the cell is cut to
 * `max` characters with an ellipsis, and nothing renders as an empty string.
 *
 * @param {unknown} value
 * @param {number} [max]
 * @returns {string}
 */
function showCell(value, max = SHOW_CELL_CHARS) {
  if (value === null || value === undefined || value === '') return '—';
  const text = typeof value === 'string' ? value : (JSON.stringify(value) ?? String(value));
  const oneLine = text.replace(/\s+/g, ' ').trim();
  if (!oneLine) return '—';
  return truncateTo(oneLine, max);
}

/**
 * The full record of one task (`agentq show`) as text, in four blocks:
 * header, input, events, reviews.
 *
 * The input block is the pinned snapshot, so what prints here is what the task
 * was queued to do rather than what a spec file says now. Long text is cut to
 * one printed line. An absent section prints `(none)` instead of nothing, so an
 * empty list is visibly empty; an absent header field prints `—`, and a task
 * with no stored commit policy gets no commit line at all.
 *
 * @param {{
 *   task: Record<string, any>,
 *   input?: Record<string, any>|null,
 *   events?: Array<Record<string, any>>,
 *   reviews?: Array<Record<string, any>>,
 * }} detail
 * @returns {string}
 */
function formatTaskDetail(detail) {
  const task = detail && detail.task ? detail.task : {};
  const input = detail ? detail.input : null;
  const events = detail && Array.isArray(detail.events) ? detail.events : [];
  const reviews = detail && Array.isArray(detail.reviews) ? detail.reviews : [];
  const field = (label, value) => `${label.padEnd(SHOW_LABEL_WIDTH)}  ${value}`;
  const lines = [
    field('id', showCell(task.id)),
    field('kind', showCell(task.kind)),
    field('status', showCell(task.status)),
    field('model', showCell(task.model)),
    field('provider', showCell(task.provider)),
    field('tier', showCell(task.tier)),
  ];
  const commit = task.execution_policy && task.execution_policy.commit;
  if (commit) {
    const author = task.execution_policy.author;
    const authorText = author ? ` (${author.name} <${author.email}>)` : '';
    lines.push(field('commit', `${commit}${authorText}`));
  }
  lines.push(
    field('attempts', `${showCell(task.attempts)}/${showCell(task.max_attempts)}`),
    field('created', showCell(task.created_at)),
    field('started', showCell(task.started_at)),
    field('finished', showCell(task.finished_at)),
  );

  lines.push('', 'input');
  if (!input) {
    lines.push('  (none — this task has no pinned input)');
  } else {
    const inputField = (label, value) => `  ${label.padEnd(SHOW_INPUT_LABEL_WIDTH)}  ${value}`;
    lines.push(
      inputField('source', showCell(input.source)),
      inputField('ref', showCell(input.ref)),
      inputField('title', showCell(input.title)),
    );
    // The first ~5 lines are what a caller skims; the count of the rest says how
    // much of the pinned text is not on screen.
    const bodyLines = String(input.body ?? '').replace(/\s+$/, '').split(/\r?\n/);
    if (!bodyLines[0]) {
      lines.push(inputField('body', '—'));
    } else {
      const shown = bodyLines
        .slice(0, SHOW_BODY_LINES)
        // A spec can hold one enormous line; a printed line stays one line,
        // and its own text is not rewritten beyond the cut.
        .map((line) => truncateTo(line.replace(/\s+$/, ''), SHOW_CELL_CHARS));
      const hidden = bodyLines.length - shown.length;
      shown.forEach((line, index) => {
        const label = index === 0 ? 'body' : '';
        lines.push(`  ${label.padEnd(SHOW_INPUT_LABEL_WIDTH)}  ${line}`);
      });
      if (hidden > 0) {
        lines.push(`  ${''.padEnd(SHOW_INPUT_LABEL_WIDTH)}  … (+${hidden} more line${hidden === 1 ? '' : 's'})`);
      }
    }
  }

  lines.push('', 'events');
  if (!events.length) lines.push('  (none)');
  for (const event of events) {
    // Time, then the event name padded to a column, then the short payload.
    lines.push(`  ${showCell(event.created_at)}  ${showCell(event.event, 24).padEnd(24)}  ${showCell(event.payload)}`);
  }

  lines.push('', 'reviews');
  if (!reviews.length) lines.push('  (none)');
  for (const review of reviews) {
    const cells = [
      showCell(review.created_at),
      showCell(review.verdict, 24).padEnd(24),
      showCell(review.tier, 6).padEnd(6),
      showCell(review.model),
    ];
    if (review.reviewer) cells.push(`by ${showCell(review.reviewer, 30)}`);
    if (review.note) cells.push(showCell(review.note));
    lines.push(`  ${cells.join('  ')}`);
  }

  return lines.map((line) => line.replace(/\s+$/, '')).join('\n');
}

function formatCost(usageJson) {
  if (!usageJson) return null;
  let usage;
  try { usage = JSON.parse(usageJson); } catch { return null; }
  const cost = usage.totalCost ?? usage.cost;
  if (typeof cost !== 'number') return null;
  return `$${cost.toFixed(4)}`;
}

function formatJobBlock(job) {
  const repo = truncateRepo(job.repo_path);
  const verify = job.verified === 1 ? ' ✓ verified' : job.verified === 0 ? ' ✗ tests failed' : '';
  const exitInfo = job.exit_code != null && job.exit_code !== 0 ? ` · exit=${job.exit_code}` : '';
  const subject = job.task_input && job.task_input.source !== 'github'
    ? job.subject
    : `${repo}#${job.issue_number}`;
  const lines = [
    `#${job.id}  ${job.status}${verify}${exitInfo}`,
    `    ${subject}  ·  ${job.model}`,
  ];
  if (job.input_error) lines.push(`    input: ${job.input_error}`);
  if (job.branch) lines.push(`    branch: ${job.branch}`);
  const cost = formatCost(job.usage_json);
  if (cost) lines.push(`    cost: ${cost}`);
  if (job.worktree_path) lines.push(`    worktree: ${job.worktree_path}`);
  if (job.log_path) lines.push(`    log: ${job.log_path}`);
  return lines.join('\n');
}

function summarizeCosts(jobs) {
  let total = 0;
  let count = 0;
  for (const j of jobs) {
    if (!j.usage_json) continue;
    let parsed;
    try { parsed = JSON.parse(j.usage_json); } catch { continue; }
    const cost = parsed.totalCost ?? parsed.cost ?? null;
    if (typeof cost !== 'number') continue;
    total += cost;
    count += 1;
  }
  return { jobs: count, total: Math.round(total * 10000) / 10000 };
}

/**
 * Compact age against a fixed `now`: seconds under a minute, then minutes,
 * hours, days. Anything that is not a readable time renders as `—`.
 *
 * @param {string|number|Date} createdAt
 * @param {string|number|Date} now
 * @returns {string}
 */
function compactAge(createdAt, now) {
  const nowMs = now instanceof Date ? now.getTime() : new Date(now).getTime();
  const createdMs = createdAt instanceof Date ? createdAt.getTime() : new Date(createdAt).getTime();
  if (!Number.isFinite(createdMs) || !Number.isFinite(nowMs)) return '—';
  const ms = nowMs - createdMs;
  const s = Math.floor(ms / 1000);
  if (s < 0) return '0s';
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h`;
  return `${Math.floor(h / 24)}d`;
}

/**
 * The title a status row shows: an issue task is `issue N`, a spec task is its
 * pinned input title (already stripped of its file path by the pinner), and
 * anything else falls back to its kind.
 *
 * @param {{ issue_number?: number|null, task_input?: { title?: string }|null, kind?: string }} job
 * @returns {string}
 */
function statusTitle(job) {
  if (job.issue_number != null) return `issue ${job.issue_number}`;
  if (job.task_input && job.task_input.title) return job.task_input.title;
  return job.kind || 'task';
}

/**
 * A short trailing note for a row: a pending job whose input failed validation,
 * or a job that still waits on a dependency that has not succeeded. The
 * dependency statuses come from the other rows in the same list (the queue's
 * `status()` returns every task), so a dep that is missing from the list is
 * treated as not-yet-succeeded and still reported as waiting.
 *
 * @param {{ input_error?: string|null, depends_on?: string[] }} job
 * @param {Map<string, string>} statusById id -> status for this list
 * @returns {string|null}
 */
function statusNote(job, statusById) {
  if (job.input_error) return 'input error';
  if (Array.isArray(job.depends_on) && job.depends_on.length) {
    const waiting = job.depends_on.find((depId) => {
      const depStatus = statusById.get(String(depId));
      return depStatus == null || depStatus !== 'succeeded';
    });
    if (waiting != null) return `waits on ${String(waiting).slice(0, 8)}`;
  }
  return null;
}

/**
 * One fixed-width status row (used for the header and for data rows). The model
 * column is padded so the title column always starts at the same offset; the
 * note that may follow the title is free-form and extends past it.
 *
 * @param {string} id
 * @param {string} status
 * @param {string} kind
 * @param {string} age
 * @param {string} model
 * @param {string} title
 * @param {number} [modelWidth] the model column width, sized to the rows shown
 * @returns {string}
 */
function statusRow(id, status, kind, age, model, title, modelWidth = 24) {
  return `${String(id).padEnd(8)}  ${String(status).padEnd(10)} ${String(kind).padEnd(12)} ${String(age).padEnd(4)} ${String(model).padEnd(modelWidth)} ${title}`;
}

/**
 * The `agentq status` text table: one row per job, newest-first ordering left to
 * the caller. Columns are id (8 chars), status, kind, age, model (or `—`), and
 * title. The title is cut to keep the whole row at most 120 characters, leaving
 * room for any trailing note. An empty list prints `no tasks`.
 *
 * @param {Array<Record<string, any>>} jobs
 * @param {{ now?: string|number|Date }} [options]
 * @returns {string}
 */
function formatStatusTable(jobs, { now = new Date(), allJobs = jobs } = {}) {
  if (!Array.isArray(jobs) || jobs.length === 0) return 'no tasks';
  // Dependency statuses come from the whole queue, not just the rows shown:
  // a filtered or limited table must not report a succeeded dep as waiting.
  const statusById = new Map((Array.isArray(allJobs) ? allJobs : jobs).map((job) => [String(job.id), job.status]));
  // The model column fits the longest model shown, so titles stay aligned.
  const modelWidth = Math.max(5, ...jobs.map((job) => (job.model ? String(job.model).length : 1)));
  const lines = [statusRow('id', 'status', 'kind', 'age', 'model', 'title', modelWidth)];
  const MAX = 120;
  for (const job of jobs) {
    const id = String(job.id).slice(0, 8);
    const status = job.status == null ? '—' : String(job.status);
    const kind = job.kind == null ? '—' : String(job.kind);
    const age = job.created_at == null ? '—' : compactAge(job.created_at, now);
    const model = job.model ? String(job.model) : '—';
    const title = statusTitle(job);
    const note = statusNote(job, statusById);
    const noteStr = note ? `  ${note}` : '';
    const base = statusRow(id, status, kind, age, model, '', modelWidth);
    const budget = MAX - base.length - noteStr.length;
    const shownTitle = budget > 0 ? truncateTo(title, budget) : '';
    lines.push(`${base}${shownTitle}${noteStr}`);
  }
  return lines.join('\n');
}

module.exports = {
  capacityText,
  intelligenceCell,
  costCell,
  buildModelRows,
  formatModelRow,
  formatModelTable,
  formatOptionsTable,
  formatGapReport,
  formatTaskDetail,
  formatTrackRecordTable,
  effectiveCostCell,
  paceCell,
  pathCell,
  truncateRepo,
  formatCost,
  formatJobBlock,
  showCell,
  truncateTo,
  summarizeCosts,
  formatStatusTable,
  compactAge,
  statusTitle,
  statusNote,
};

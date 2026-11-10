#!/usr/bin/env node
'use strict';

// Interactive menu for agentq — a thin readline loop over the core functions.
// No deps, no TUI framework. Works identically in tmux and phone-via-Termius.
// Invoked by `npm run agentq` with no command; everything else still scriptable.

const readline = require('node:readline/promises');
const { stdin, stdout } = require('node:process');
const path = require('node:path');
const fs = require('node:fs');
const { execFileSync } = require('node:child_process');
const {
  runNext, drain, buildModelRows, formatModelRow, formatJobBlock, summarizeCosts,
} = require('./agentq.js');
const { SqliteSource } = require('../../queue/sources.js');
const { getCatalog, getCapacity, recommend } = require('../../core/snapshot.js');
const { degradedMarkers } = require('../../core/routing.js');
const { loadPathHealth } = require('../../queue/path-health.js');
const { loadTrackRecords } = require('../../queue/track-records.js');
const { DEFAULT_TIER, resolveAutoModel, summarizeRejections } = require('../../core/auto-model.js');
const { isSqliteBusy } = require('../../queue/db-helpers.js');
const { listRepos, listIssues, listPrs, listMilestones, groupIssuesByMilestone, DEFAULT_CLONE_ROOT } = require('../../runners/gh.js');
const { homeDataPath } = require('../../lib/home.js');

const ROOT = path.join(__dirname, '..', '..', '..');
// Local menu state (last repo, clone root) lives in AGENTQ_HOME, not the repo.
const stateFile = () => homeDataPath('agentq.state.json');

// Clear the screen and move cursor home. Falls back to a newline if stdout
// isn't a TTY (e.g. piped), so output stays readable either way.
function clearScreen() {
  if (stdout.isTTY) {
    stdout.write('\x1b[2J\x1b[H');
  }
}

function loadState() {
  try { return JSON.parse(fs.readFileSync(stateFile(), 'utf8')); } catch { return {}; }
}

function saveState(state) {
  const file = stateFile();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(state, null, 2) + '\n');
}

function statusCounts(jobs) {
  return jobs.reduce((acc, j) => {
    acc[j.status] = (acc[j.status] || 0) + 1;
    return acc;
  }, {});
}

function header(jobs) {
  const c = statusCounts(jobs);
  const parts = ['pending', 'blocked', 'running', 'succeeded', 'failed', 'unverified']
    .filter(s => c[s])
    .map(s => `${c[s]} ${s}`);
  return `agentq — ${parts.join(' · ') || 'empty'}`;
}

async function ask(rl, prompt, fallback) {
  const answer = (await rl.question(prompt)).trim();
  return answer || fallback;
}

async function topMenu(rl, source) {
  while (true) {
    const jobs = source.status();
    clearScreen();
    console.log(header(jobs));
    console.log('');
    console.log('  1  enqueue     add an issue');
    console.log('  2  run-next    run one pending job');
    console.log('  3  drain       run all pending');
    console.log('  4  requeue     rerun a finished job');
    console.log('  5  status      show all jobs');
    console.log('  6  pick        what would auto choose now?');
    console.log('  7  recover     reset stale running jobs');
    console.log('  8  prune       remove worktrees of finished jobs');
    console.log('  q  quit');
    const choice = (await rl.question('\n> ')).trim();
    if (choice === '1') await doEnqueue(rl, source);
    else if (choice === '2') await doRunNext(rl, source);
    else if (choice === '3') await doDrain(rl, source);
    else if (choice === '4') await doRequeue(rl, source);
    else if (choice === '5') await doStatus(rl, source);
    else if (choice === '6') doPick(source);
    else if (choice === '7') doRecover(source);
    else if (choice === '8') doPrune(source);
    else if (choice === 'q' || choice === 'quit' || choice === 'exit') return 0;
    else console.log('unknown choice');
  }
}

async function doEnqueue(rl, source) {
  const state = loadState();
  const cloneRoot = state.cloneRoot || DEFAULT_CLONE_ROOT;

  const repo = await chooseRepo(rl, cloneRoot, state.lastRepo);
  if (!repo) { console.log('no repo given'); return; }
  saveState({ ...state, lastRepo: repo.nameWithOwner });

  const issue = await chooseIssue(rl, repo.nameWithOwner);
  if (!issue) { console.log('no issue given'); return; }

  const model = await chooseModel(rl, source);
  // Fail closed: an issue from a public repo is attacker-controllable, so
  // plain Enter must keep the trust gate (sandboxed verification etc.), not
  // drop it. Confirming a trusted run now requires typing 'n' deliberately.
  const untrusted = (await ask(rl, 'untrusted (from a public issue)? [Y/n]: ', 'Y')).toLowerCase() === 'n';
  // enqueue() reads options.trusted, not options.untrusted — translate the
  // prompt's answer or it's silently discarded and every job ends up untrusted.
  const opts = { repo: repo.localPath, issue, model, trusted: !untrusted };
  if (model === 'jules') opts.executor = path.join(ROOT, 'src', 'runners', 'jules-issue.js');
  const result = await source.enqueue(opts);
  let note = `enqueued #${result.id} — ${repo.nameWithOwner}#${issue}`;
  if (model === 'auto') {
    // Preview only: the job stores 'auto' and resolves at claim time.
    try {
      note += ` (auto → ${resolveAutoModel('auto', { tier: DEFAULT_TIER, pathHealth: loadPathHealth(source && source.db), trackRecords: loadTrackRecords(source && source.db) }).model})`;
    } catch (err) {
      note += `\n  ⚠ ${err.message}`;
    }
  }
  console.log(note);
}

async function chooseRepo(rl, cloneRoot, lastRepoName) {
  const repos = listRepos({ cloneRoot });
  if (!repos.length) {
    console.log(`no cloned repos found under ${cloneRoot} (configure via cloneRoot in <home>/data/agentq.state.json)`);
    const manual = (await rl.question('repo path: ')).trim();
    if (!manual || !fs.existsSync(manual)) return null;
    return { nameWithOwner: path.basename(manual), localPath: manual };
  }

  console.log('\nrepos — cloned locally');
  repos.forEach((r, i) => {
    const marker = r.nameWithOwner === lastRepoName ? ' ←' : '';
    console.log(`  ${i + 1}  ${r.nameWithOwner.padEnd(34)} ${r.name}${marker}`);
  });
  console.log('  r  refresh from gh');
  console.log('');

  const choice = (await rl.question('pick repo (number) or type a path: ')).trim();
  if (choice === 'r') return chooseRepo(rl, cloneRoot, lastRepoName);
  if (/^\d+$/.test(choice)) {
    const idx = Number(choice) - 1;
    if (repos[idx]) return repos[idx];
  }
  if (choice && fs.existsSync(choice)) {
    return { nameWithOwner: path.basename(choice), localPath: choice };
  }
  console.log('no repo picked');
  return null;
}

async function chooseIssue(rl, nameWithOwner) {
  const issues = listIssues(nameWithOwner);
  if (!issues.length) {
    const manual = (await rl.question('issue number (no open issues found): ')).trim();
    return (/^\d+$/.test(manual)) ? manual : null;
  }

  const groups = groupIssuesByMilestone(issues);
  const hasMilestones = groups.some(g => g.milestone);

  if (!hasMilestones) {
    // No milestones at all — show the flat list (original behaviour)
    return pickIssueFromList(rl, nameWithOwner, issues);
  }

  // Milestone-grouped view
  clearScreen();
  console.log(`open issues — ${nameWithOwner}\n`);
  console.log('  milestones');
  let groupIdx = 0;
  groups.forEach((g, i) => {
    if (g.milestone) {
      console.log(`  ${i + 1}  ${g.milestone.title.padEnd(50)} ${g.issues.length} open`);
      groupIdx = i;
    }
  });
  const unassigned = groups.find(g => !g.milestone);
  if (unassigned) {
    const idx = groups.indexOf(unassigned) + 1;
    console.log('\n  other');
    console.log(`  ${idx}  unassigned                                       ${unassigned.issues.length} open`);
  }
  console.log('\n  p  show open PRs instead');
  console.log('');

  const choice = (await rl.question('pick a group (number): ')).trim();
  if (choice === 'p') return choosePr(rl, nameWithOwner);
  if (/^\d+$/.test(choice)) {
    const idx = Number(choice) - 1;
    if (groups[idx]) return pickIssueFromGroup(rl, nameWithOwner, groups[idx]);
  }
  console.log('no group picked');
  return null;
}

async function pickIssueFromGroup(rl, nameWithOwner, group) {
  const label = group.milestone ? group.milestone.title : 'unassigned';
  return pickIssueFromList(rl, nameWithOwner, group.issues, label);
}

async function pickIssueFromList(rl, nameWithOwner, issues, heading) {
  const title = heading || `open issues — ${nameWithOwner}`;
  clearScreen();
  console.log(`${title}\n`);
  issues.forEach((iss, i) => {
    const issueTitle = iss.title.length > 60 ? iss.title.slice(0, 57) + '...' : iss.title;
    console.log(`  ${i + 1}  #${iss.number}  ${issueTitle}`);
  });
  if (!heading) console.log('  p  show open PRs instead');
  console.log('  b  back');
  console.log('');

  const choice = (await rl.question('pick issue (number) or type an issue #: ')).trim();
  if (choice === 'b') return chooseIssue(rl, nameWithOwner);
  if (choice === 'p' && !heading) return choosePr(rl, nameWithOwner);
  if (/^\d+$/.test(choice)) {
    const idx = Number(choice) - 1;
    // A number in list range picks that row; otherwise treat it as a raw issue #.
    return issues[idx] ? String(issues[idx].number) : choice;
  }
  console.log('no issue picked');
  return null;
}

async function choosePr(rl, nameWithOwner) {
  const prs = listPrs(nameWithOwner);
  if (!prs.length) {
    const manual = (await rl.question('PR number (no open PRs found): ')).trim();
    return (/^\d+$/.test(manual)) ? manual : null;
  }

  console.log(`\nopen PRs — ${nameWithOwner}`);
  prs.forEach((pr, i) => {
    const title = pr.title.length > 60 ? pr.title.slice(0, 57) + '...' : pr.title;
    console.log(`  ${i + 1}  #${pr.number}  ${title}`);
  });
  console.log('');

  const choice = (await rl.question('pick PR (number) or type a PR #: ')).trim();
  if (/^\d+$/.test(choice)) {
    const idx = Number(choice) - 1;
    // A number in list range picks that row; otherwise treat it as a raw PR #.
    return prs[idx] ? String(prs[idx].number) : choice;
  }
  console.log('no PR picked');
  return null;
}

async function chooseModel(rl, source = null) {
  const raw = (await rl.question('model [auto]: ')).trim();
  if (!raw) return 'auto';
  if (raw !== 'l' && raw !== 'list') return raw;

  const catalog = getCatalog();
  const capacity = new Map(getCapacity().map(entry => [entry.path, entry]));
  const decision = recommend({
    tier: DEFAULT_TIER,
    pathHealth: loadPathHealth(source && source.db),
    trackRecords: loadTrackRecords(source && source.db),
  });
  const rows = buildModelRows({ catalog, capacity, decision });

  const julesRow = {
    model: 'jules',
    path: 'jules',
    intelligence: null,
    costPerMTok: null,
    capacity: { state: 'available', headroomPct: null, reason: 'cloud agent' },
    recommended: false,
    reasons: [],
  };

  console.log(`\npick a model — auto = cheapest eligible (tier ${DEFAULT_TIER})\n`);
  for (const marker of degradedMarkers(decision.choices)) console.log(`  degraded: ${marker.path} (${marker.reason})`);
  console.log(`  #  ${'model'.padEnd(44)} ${'path'.padEnd(12)} ${'intel'.padStart(5)} ${'$/MTok'.padStart(7)}  capacity`);
  console.log(`  0  ${'auto'.padEnd(44)} ${'—'.padEnd(12)} ${'—'.padStart(5)} ${'—'.padStart(7)}  ${decision.default ? `→ ${decision.default.id}` : `none eligible: ${summarizeRejections(decision.rejected)}`}`);
  console.log(formatModelRow(julesRow, 'j'));
  rows.forEach((row, i) => console.log(formatModelRow(row, i + 1)));
  console.log('');

  const choice = (await rl.question('enter #, model id, or j for Jules: ')).trim();
  if (!choice || choice === '0') return 'auto';
  if (choice === 'j' || choice === 'jules') return 'jules';
  if (/^\d+$/.test(choice)) {
    const idx = Number(choice) - 1;
    if (rows[idx]) return rows[idx].model;
  }
  if (rows.some(r => r.model === choice)) return choice;
  console.log('no match, defaulting to auto');
  return 'auto';
}

async function doRunNext(rl, source) {
  // Avoid asking for execution options when the queue is visibly empty. The
  // command remains authoritative about races and blocked/approval-gated jobs;
  // this is only an interactive UX fast path for an idle queue.
  if (!source.status().some(job => job.status === 'pending')) {
    console.log('no pending jobs');
    return;
  }
  const verify = await ask(rl, 'verify command [npm test]: ', 'npm test');
  const opts = { executor: path.join(ROOT, 'pi-issue.sh'), verify };
  let result;
  try {
    result = await runNext(source, opts);
  } catch (e) {
    if (isSqliteBusy(e)) { console.log('another agentq process is currently working — try again shortly'); return; }
    throw e;
  }
  // 'busy' (another process holds the queue's write lock) must be handled
  // before 'idle' — it isn't a genuinely empty queue, and falling through to
  // the line below would print "#undefined busy".
  if (result.status === 'busy') { console.log('another agentq process is currently working — try again shortly'); return; }
  if (result.status === 'refused') { printRefusals(result.refused); return; }
  if (result.status === 'idle') { console.log('no pending jobs'); return; }
  console.log(`#${result.id} ${result.status}${result.exitCode != null ? ` exit=${result.exitCode}` : ''}`);
  if (result.status === 'unverified') console.log('  ⚠ tests failed — diff is in the worktree, review before merging');
  if (result.status === 'failed') console.log('  ⚠ executor failed — check the log');
}

async function doDrain(rl, source) {
  const verify = await ask(rl, 'verify command [npm test]: ', 'npm test');
  const opts = { executor: path.join(ROOT, 'pi-issue.sh'), verify };
  let ran = 0, succeeded = 0, failed = 0, unverified = 0, busy = false;
  while (true) {
    let result;
    try {
      result = await runNext(source, opts);
    } catch (e) {
      if (isSqliteBusy(e)) { busy = true; break; }
      throw e;
    }
    if (result.status === 'busy') {
      // Another process holds the queue's write lock — stop rather than spin,
      // but don't count this as a run and don't let it fall through to the
      // `else failed++` branch below (this isn't a failure, and pending jobs
      // may remain untouched).
      busy = true;
      break;
    }
    if (result.status === 'refused') { printRefusals(result.refused); break; }
    if (result.status === 'idle') break;
    ran++;
    if (result.status === 'succeeded') succeeded++;
    else if (result.status === 'unverified') unverified++;
    else failed++;
    process.stdout.write(`  #${result.id} ${result.status}  (${ran} so far)
`);
  }
  console.log(`
ran ${ran}: ${succeeded} succeeded, ${unverified} unverified, ${failed} failed`);
  if (busy) console.log('  ⚠ another agentq process is currently working — some pending jobs may remain, try again shortly');
  if (unverified) console.log('  ⚠ some jobs failed verification — diffs are in their worktrees, review before merging');
  if (failed) console.log('  ⚠ some jobs failed — check status');
  const blocked = source.status().filter(j => j.status === 'blocked').length;
  if (blocked) console.log(`  ⚠ ${blocked} job(s) blocked — a prerequisite hasn't succeeded`);
}

/**
 * Admission refused the pending work: say why, so the queue does not look
 * empty (each line is the reason the claim gate gave).
 */
function printRefusals(refused) {
  if (!refused?.length) { console.log('no pending jobs'); return; }
  console.log('nothing runnable here:');
  for (const entry of refused) console.log(`  job ${String(entry.id).slice(0, 8)}: ${entry.reason}`);
}

async function doRequeue(rl, source) {
  const id = await ask(rl, 'job id: ');
  if (!id) { console.log('invalid id'); return; }
  const changeModel = (await rl.question('change model? [blank=keep]: ')).trim();
  const opts = changeModel ? { id, model: changeModel } : { id };
  try {
    const result = source.requeue(opts);
    console.log(`#${result.id} back to pending`);
  } catch (e) {
    console.log(e.message);
  }
}

async function doStatus(rl, source) {
  const jobs = source.status();
  if (!jobs.length) { console.log('no jobs'); return; }
  clearScreen();
  console.log(`${header(jobs)}\n`);
  for (const j of jobs) {
    console.log(formatJobBlock(j));
    console.log('');
  }
  const costSummary = summarizeCosts(jobs);
  if (costSummary.jobs > 0) console.log(`  cost: $${costSummary.total.toFixed(4)} across ${costSummary.jobs} job(s)`);
  console.log('  [id or prefix] inspect a job\'s diff   ·   Enter to return');
  const choice = (await rl.question('> ')).trim();
  if (choice) {
    const matches = jobs.filter(j => j.id === choice || j.id.startsWith(choice));
    if (matches.length === 1) await inspectJob(rl, matches[0]);
    else if (matches.length > 1) console.log('ambiguous id — type more characters');
    else console.log('no job with that id');
  }
}

async function inspectJob(rl, job) {
  if (!job.worktree_path || !fs.existsSync(job.worktree_path)) {
    console.log('no worktree to inspect');
    await rl.question('press Enter to return... ');
    return;
  }
  const wt = job.worktree_path;
  const base = job.base_branch || 'master';

  clearScreen();
  console.log(`#${job.id}  ${job.repo_path ? path.basename(job.repo_path) : ''}#${job.issue_number}\n`);

  // Commits
  console.log('commits:');
  try {
    const log = execFileSync('git', ['-C', wt, '--no-pager', 'log', '--oneline', `${base}..HEAD`],
      { encoding: 'utf8', timeout: 10_000 });
    console.log(log.trimEnd() || '  (no commits)');
  } catch {
    console.log('  (could not read git log)');
  }

  // Diff stat
  console.log('\ndiffstat:');
  try {
    const stat = execFileSync('git', ['-C', wt, '--no-pager', 'diff', '--stat', `${base}...HEAD`],
      { encoding: 'utf8', timeout: 10_000 });
    console.log(stat.trimEnd() || '  (no changes)');
  } catch {
    console.log('  (could not read diff stat)');
  }

  console.log('\n  d  full diff   ·   p  push branch   ·   o  open PR   ·   Enter to return');
  const choice = (await rl.question('> ')).trim();
  if (choice === 'd') {
    clearScreen();
    try {
      const diff = execFileSync('git', ['-C', wt, '--no-pager', 'diff', `${base}...HEAD`],
        { encoding: 'utf8', timeout: 30_000 });
      const lines = diff.split('\n');
      const pageSize = 40;
      for (let i = 0; i < lines.length; i += pageSize) {
        console.log(lines.slice(i, i + pageSize).join('\n'));
        if (i + pageSize < lines.length) {
          const more = (await rl.question('-- more (Enter) / q to stop -- ')).trim();
          if (more === 'q') break;
          clearScreen();
        }
      }
    } catch {
      console.log('  (could not read diff)');
    }
    await rl.question('press Enter to return... ');
  } else if (choice === 'p') {
    await pushBranch(rl, job, wt);
  } else if (choice === 'o') {
    // openPr issues the final pause; don't prompt twice.
    await pushBranch(rl, job, wt, { pause: false });
    await openPr(rl, job);
  }
}

async function pushBranch(rl, job, wt, { pause = true } = {}) {
  const branch = job.branch;
  if (!branch) { console.log('no branch name stored'); return; }
  try {
    execFileSync('git', ['-C', wt, 'push', '-u', 'origin', branch],
      { encoding: 'utf8', timeout: 30_000 });
    console.log(`pushed ${branch} to origin`);
  } catch (e) {
    console.log(`push failed: ${e.stderr ? e.stderr.trimEnd() : e.message}`);
  }
  if (pause) await rl.question('press Enter to return... ');
}

async function openPr(rl, job) {
  try {
    const out = execFileSync('gh', ['pr', 'create', '--fill'],
      { encoding: 'utf8', cwd: job.worktree_path || process.cwd(), timeout: 30_000 });
    console.log(`PR: ${out.trimEnd()}`);
  } catch (e) {
    console.log(`PR create failed: ${e.stderr ? e.stderr.trimEnd() : e.message}`);
  }
  await rl.question('press Enter to return... ');
}

function doPick(source = null) {
  const decision = recommend({
    tier: DEFAULT_TIER,
    pathHealth: loadPathHealth(source && source.db),
    trackRecords: loadTrackRecords(source && source.db),
  });
  for (const marker of degradedMarkers(decision.choices)) console.log(`  degraded: ${marker.path} (${marker.reason})`);
  if (decision.default) {
    console.log(`auto would pick: ${decision.default.id} (${decision.default.path}, tier ${DEFAULT_TIER})`);
    return;
  }
  console.log(`auto would pick nothing (tier ${DEFAULT_TIER}): ${summarizeRejections(decision.rejected)}`);
}

function doRecover(source) {
  const result = source.recover();
  console.log(`recovered ${result.recovered} stale job(s) (${result.skipped} still running)`);
}

function doPrune(source) {
  const result = source.prune();
  console.log(`pruned ${result.removed} worktree(s)${result.ids.length ? `: ${result.ids.join(', ')}` : ''}`);
  for (const s of result.skipped) console.log(`  skipped #${s.id}: ${s.reason}`);
  if (!result.removed && !result.skipped.length) console.log('  nothing to prune');
}

async function main() {
  // --db / AGENTQ_DB name the SQLite queue (the orchestrator's database).
  const dbPath = process.env.AGENTQ_DB || homeDataPath('orchestrator.sqlite');
  const source = new SqliteSource(dbPath);
  const rl = readline.createInterface({ input: stdin, output: stdout });
  try {
    await topMenu(rl, source);
  } finally {
    rl.close();
    await source.stop();
  }
  return 0;
}

if (require.main === module) {
  main().catch(e => { console.error(e.message); process.exit(1); });
}

module.exports = { main, header, statusCounts, chooseModel };

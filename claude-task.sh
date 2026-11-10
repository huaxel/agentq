#!/usr/bin/env bash
# claude-task.sh — run ONE pinned task input through Claude Code headless in an
# isolated git worktree, then show exit code + cost + diff for your review.
#
#   ./claude-task.sh <issue-number> <model>                 # standalone GitHub issue
#   ./claude-task.sh <task-id> <model> --agentq-pinned-input # queued task
#
# Sibling of pi-task.sh with the SAME argument/stdin/environment contract, so
# agentq selects it per runnable harness without changing the queue:
#   <issue-number|task-id> <provider/model> [--agentq-pinned-input]
#   AGENTQ_PINNED_INPUT=1 + AGENTQ_INPUT_SHA256 + generic pinned input on stdin
#   AGENTQ_WORKTREE (reuse an agentq-managed worktree), AGENTQ_BRANCH,
#   BASE_BRANCH, AGENTQ_STOP_WHEN, AGENTQ_JOB_ID, AGENTQ_RESULT.
# AGENTQ_MAX_TURNS — optional positive integer, forwarded as --max-turns.
#
# PERMISSIONS — read this before changing the command line.
# Headless Claude Code cannot answer its own permission prompts, so an
# un-answered prompt is a denial, not an approval. File edits are accepted
# (--permission-mode acceptEdits); every other tool (Bash, WebFetch, ...) runs
# only if config/defaults/claude-job-settings.json (passed with --settings) or the
# target repository's `.claude/settings.json` allows it, and agentq's deny
# rules win over any repository allow. This
# script never passes --dangerously-skip-permissions. The execution boundary
# stays agentq's: the trust gate decides whether the job may run at all, and a
# --sandbox wrapper receives `sandbox <this script> ...` unchanged, exactly as
# for pi.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
RESULT_WRITER="${SCRIPT_DIR}/src/runners/result-file.js"
INPUT_READER="${SCRIPT_DIR}/src/runners/executor-input.js"

usage() {
  echo "usage: claude-task.sh <issue-number|task-id> <provider/model> [--agentq-pinned-input]" >&2
}

# There is no default model: a silent default would keep spending a
# subscription the caller may have dropped. agentq always passes the resolved
# model as the second argument.
SUBJECT="${1:-}"
MODEL="${2:-}"
if [ -z "$SUBJECT" ] || [ -z "$MODEL" ]; then
  usage
  exit 2
fi
case "$MODEL" in
  -*) usage; exit 2 ;;
esac
if [ "${3:-}" = --agentq-pinned-input ] && { [ "${AGENTQ_PINNED_INPUT:-}" != 1 ] || [ -z "${AGENTQ_INPUT_SHA256:-}" ] || [ -z "${AGENTQ_WORKTREE:-}" ] || [ -z "${BASE_BRANCH:-}" ]; }; then
  echo "Queued input metadata is missing; forward arguments, stdin, AGENTQ input environment, AGENTQ_WORKTREE and BASE_BRANCH." >&2
  exit 1
fi
BASE="${BASE_BRANCH:-$(git symbolic-ref --short HEAD)}"

root="$(git rev-parse --show-toplevel)"

if [ "${AGENTQ_PINNED_INPUT:-}" = 1 ]; then
  echo "▶ task ${SUBJECT} — using pinned enqueue input"
  task_input="$(cat)"
elif [ -n "${AGENTQ_JOB_ID:-}" ]; then
  echo "Queued task execution requires pinned input; enqueue a new job." >&2
  exit 1
else
  # Standalone mode names a GitHub issue. Validate it BEFORE spending a gh
  # call: a spec is queued (pinned stdin), never fetched by number.
  case "$SUBJECT" in
    ''|*[!0-9]*) echo "claude-task.sh standalone mode needs a positive issue number, got '${SUBJECT}'." >&2; exit 2 ;;
  esac
  case "$SUBJECT" in
    *[1-9]*) : ;;
    *) echo "claude-task.sh standalone mode needs a positive issue number, got '${SUBJECT}'." >&2; exit 2 ;;
  esac
  echo "▶ issue #${SUBJECT} — fetching standalone input via gh"
  task_input="$(gh issue view "$SUBJECT" --json number,title,body,url,updatedAt)"
fi
# NUL-delimited fields preserve trailing newlines without shell evaluation.
# The reader owns the digest check and the legacy-to-generic conversion.
{
  IFS= read -r -d '' input_source
  IFS= read -r -d '' ref
  IFS= read -r -d '' title
  IFS= read -r -d '' body
  IFS= read -r -d '' slug
} < <(printf '%s' "$task_input" | node "$INPUT_READER" "$SUBJECT")
unset task_input
if [ -z "${slug:-}" ]; then
  echo "Invalid task input; enqueue a new job rather than fetching replacement text." >&2
  exit 1
fi
wt="${AGENTQ_WORKTREE:-$(mktemp -d)/claude-${slug}}"
branch="${AGENTQ_BRANCH:-$(git -C "$wt" branch --show-current 2>/dev/null || echo "claude/${slug}")}"

echo "▶ worktree ${wt}  (branch ${branch}, base ${BASE})"
if [ -z "${AGENTQ_WORKTREE:-}" ]; then
  # An existing branch may contain unreviewed commits or dirty work.
  if git -C "$root" show-ref --verify --quiet "refs/heads/${branch}"; then
    echo "Refusing to replace existing branch '${branch}'. Inspect it or explicitly reuse its worktree with AGENTQ_WORKTREE." >&2
    exit 1
  fi
  git -C "$root" worktree add -b "$branch" "$wt" "$BASE" >/dev/null
else
  echo "▶ reusing agentq-managed worktree"
fi

# Commit policy from the queue (AGENTQ_COMMIT_MODE=agent|none; unset means agent).
# In none mode the agent must not commit: the reviewer commits under their own
# identity. GIT_AUTHOR_*/GIT_COMMITTER_* arrive here in the environment when a
# commit author is configured, and `env -u AGENTQ_RESULT` below passes them
# through to the agent untouched (it only removes AGENTQ_RESULT).
COMMIT_MODE="${AGENTQ_COMMIT_MODE:-agent}"
if [ "$COMMIT_MODE" = none ]; then
  COMMIT_LINE="Do NOT commit. Leave all changes uncommitted in the working tree for review."
else
  COMMIT_LINE="Make focused commits on this branch as you go."
fi
# Commits the agent made in none mode, counted after the run (empty = none).
UNEXPECTED_COMMITS=""

if [ "$input_source" = github ]; then
read -r -d '' PROMPT <<EOF || true
You are working in a fresh git worktree on branch ${branch}.
Implement this GitHub issue and nothing else.

Issue #${ref}: ${title}

${body}

Constraints:
- ${COMMIT_LINE}
- Run the repo's tests/typecheck if present and make them pass.
- Do NOT push and do NOT open a PR — leave the branch for review.
EOF
else
read -r -d '' PROMPT <<EOF || true
You are working in a fresh git worktree on branch ${branch}.
Implement this specification and nothing else.

Spec: ${title}
Source: ${ref:-inline}

${body}

Constraints:
- ${COMMIT_LINE}
- Run the repo's tests/typecheck if present and make them pass.
- Do NOT push and do NOT open a PR — leave the branch for review.
EOF
fi

# --stop-when: when agentq drain is run with a natural-language stop condition,
# the condition arrives here via AGENTQ_STOP_WHEN. The agent prints
# SHOULD_FULLY_STOP=true as its LAST output line when it believes the objective
# is fully satisfied; agentq scans for that sentinel to end the drain loop.
if [ -n "${AGENTQ_STOP_WHEN:-}" ]; then
  PROMPT="${PROMPT}

Stop condition (set by agentq drain --stop-when):
${AGENTQ_STOP_WHEN}

When you are confident this stop condition is fully satisfied, print this exact
line as the VERY LAST line of your output and then stop:
  SHOULD_FULLY_STOP=true
Otherwise do not print it. Keep working normally toward the task."
fi

# agentq runnable ids carry the provider prefix (claude/claude-sonnet-5-5);
# Claude Code takes the bare model name.
case "$MODEL" in
  claude/*) CLAUDE_MODEL="${MODEL#claude/}" ;;
  *) CLAUDE_MODEL="$MODEL" ;;
esac
if [ -z "$CLAUDE_MODEL" ]; then
  echo "Invalid model '${MODEL}': expected <provider>/<model> or a bare model id." >&2
  exit 2
fi

# Every job loads agentq's permission settings (allowed test/git commands,
# denied push/network/installs/secret reads) on top of the repo's own. Deny
# rules win across sources, so a repo cannot re-allow what agentq denies.
# AGENTQ_CLAUDE_SETTINGS overrides the file; a missing or invalid file is a
# refusal, never a run without it.
CLAUDE_SETTINGS="${AGENTQ_CLAUDE_SETTINGS:-${SCRIPT_DIR}/config/defaults/claude-job-settings.json}"
if [ ! -f "$CLAUDE_SETTINGS" ] || ! node -e 'JSON.parse(require("node:fs").readFileSync(process.argv[1], "utf8"))' "$CLAUDE_SETTINGS" 2>/dev/null; then
  echo "Claude job settings missing or not valid JSON: ${CLAUDE_SETTINGS}" >&2
  exit 2
fi

CLAUDE_ARGS=( -p --model "$CLAUDE_MODEL" --output-format json --permission-mode acceptEdits --settings "$CLAUDE_SETTINGS" )
if [ -n "${AGENTQ_MAX_TURNS:-}" ]; then
  case "$AGENTQ_MAX_TURNS" in
    *[!0-9]*)
      echo "AGENTQ_MAX_TURNS must be a positive integer, got '${AGENTQ_MAX_TURNS}'." >&2
      exit 2
      ;;
  esac
  if [ "$AGENTQ_MAX_TURNS" -le 0 ]; then
    echo "AGENTQ_MAX_TURNS must be a positive integer, got '${AGENTQ_MAX_TURNS}'." >&2
    exit 2
  fi
  CLAUDE_ARGS+=( --max-turns "$AGENTQ_MAX_TURNS" )
fi

RESULT_FILE="$(mktemp)"
ERR_FILE="$(mktemp)"
cleanup() { rm -f "$RESULT_FILE" "$ERR_FILE"; }
trap cleanup EXIT

echo "▶ running Claude Code headless (${CLAUDE_MODEL})…"
set +e
# The model must not see AGENTQ_RESULT: only this shell and the writer may write
# the result, so a prompt-injected model cannot forge one.
( cd "$wt" && printf '%s' "$PROMPT" | env -u AGENTQ_RESULT claude "${CLAUDE_ARGS[@]}" ) >"$RESULT_FILE" 2>"$ERR_FILE"
code=$?
# Whatever sits at the result path now was not written by this script (the
# model may have learned the path from the parent's environment): drop it
# before writing the real result.
if [ -n "${AGENTQ_RESULT:-}" ]; then rm -f "$AGENTQ_RESULT"; fi
set -e
if [ -s "$ERR_FILE" ]; then cat "$ERR_FILE" >&2; fi
echo "▶ claude exit code: ${code}   ($([ "$code" -eq 0 ] && echo SUCCESS || echo FAILED/aborted))"

# The result is one JSON object (--output-format json). This block prints the
# human summary and writes the machine-readable AGENTQ_RESULT file agentq reads:
# session, normalized usage, and the stop sentinel found in the assistant text.
# Exit codes: 3 = the result reports is_error (a reported failure must never be
# recorded as success), 1 = the output is not the expected JSON.
parse_status=0
node - "$RESULT_FILE" "$CLAUDE_MODEL" "$wt" "$branch" "$RESULT_WRITER" "$UNEXPECTED_COMMITS" <<'NODE' || parse_status=$?
const fs = require('node:fs');
const [file, requested, worktree, branch, writerPath, unexpectedRaw] = process.argv.slice(2);
const unexpectedCommits = /^[1-9][0-9]*$/.test(unexpectedRaw || '') ? Number(unexpectedRaw) : null;
let data;
try { data = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { process.exit(1); }
if (!data || typeof data !== 'object' || typeof data.session_id !== 'string' || !data.session_id) process.exit(1);

const usage = data.usage && typeof data.usage === 'object' ? data.usage : {};
const reportedModels = Object.keys(data.modelUsage && typeof data.modelUsage === 'object' ? data.modelUsage : {});
const model = reportedModels.length ? reportedModels[0] : requested;
const cost = Number(data.total_cost_usd);
const cacheRead = Number(usage.cache_read_input_tokens) || 0;
const cacheWrite = Number(usage.cache_creation_input_tokens) || 0;

// snake_case is Claude Code's own shape; the camelCase cache keys are what
// usage-normalize reads, so a job's cache tokens are not silently dropped.
const normalized = {
  input_tokens: Number(usage.input_tokens) || 0,
  output_tokens: Number(usage.output_tokens) || 0,
  cache_read_input_tokens: cacheRead,
  cache_creation_input_tokens: cacheWrite,
  cacheReadTokens: cacheRead,
  cacheWriteTokens: cacheWrite,
  totalCost: Number.isFinite(cost) ? cost : 0,
  provider: 'claude',
  model,
};

const resultText = typeof data.result === 'string' ? data.result : '';
// The stop sentinel only counts as the agent's LAST line, so an issue body that
// merely mentions it cannot end a drain. agentq never scans stdout for it, so
// it travels in the result file instead.
const { endsWithStopSentinel, writeResultFile } = require(writerPath);
const stop = endsWithStopSentinel(resultText);

const turns = Number.isFinite(Number(data.num_turns)) ? ` turns=${data.num_turns}` : '';
const duration = Number.isFinite(Number(data.duration_ms)) ? ` duration=${data.duration_ms}ms` : '';
process.stdout.write(`▶ claude result: subtype=${data.subtype ?? 'unknown'}${turns}${duration} cost=${normalized.totalCost} USD\n`);
process.stdout.write(`▶ session: ${data.session_id}\n`);
if (resultText) {
  process.stdout.write(`▶ result:\n${resultText}\n`);
}
process.stdout.write(`▶ usage: ${JSON.stringify(normalized)}\n`);

// Machine-readable result (AGENTQ_RESULT): JSON is encoded here, never by
// shell interpolation, and written atomically (tmp + rename). A write failure
// is reported but must not turn the run's exit code into a failure on its own.
if (process.env.AGENTQ_RESULT) {
  try {
    writeResultFile(process.env.AGENTQ_RESULT, {
      version: 1,
      worktree,
      branch,
      session: data.session_id,
      usage: normalized,
      verification: null,
      stop,
      unexpectedCommits,
    });
  } catch (err) {
    // Never leave a stale or partial file: agentq reads "missing" instead.
    try { fs.rmSync(process.env.AGENTQ_RESULT, { force: true }); } catch { /* best effort */ }
    process.stderr.write(`▶ could not write the agentq result file: ${err.message}\n`);
  }
}
if (data.is_error === true) process.exit(3);
NODE
# Any result agentq cannot read is a failure, even when the process exited 0:
# a run whose cost, session and output are unknown must never be recorded as
# succeeded.
if [ "$parse_status" -ne 0 ]; then
  if [ "$parse_status" -eq 3 ]; then
    echo "▶ Claude Code reported is_error=true; recording the run as failed." >&2
  else
    # The raw output is untrusted and unbounded; dump a bounded prefix as
    # evidence instead of flooding the terminal and the job log.
    size="$(wc -c < "$RESULT_FILE" | tr -d ' ')"
    echo "▶ could not parse the Claude Code JSON result; recording the run as failed. Raw output (first 64 KiB):" >&2
    head -c 65536 "$RESULT_FILE" >&2 || true
    if [ "$size" -gt 65536 ]; then
      echo "" >&2
      echo "▶ (truncated: ${size} bytes of output, only the first 65536 shown)" >&2
    fi
  fi
  if [ "$code" -eq 0 ]; then code=1; fi
fi

if [ "$COMMIT_MODE" = none ]; then
  echo "▶ uncommitted changes in working tree (no-commit mode):"
  git -C "$wt" status --short || true
  git -C "$wt" --no-pager diff --stat || true
  UNEXPECTED_COMMITS="$(git -C "$wt" rev-list --count "${BASE}..HEAD" 2>/dev/null || echo 0)"
  case "$UNEXPECTED_COMMITS" in ''|*[!0-9]*) UNEXPECTED_COMMITS=0 ;; esac
  if [ "$UNEXPECTED_COMMITS" -gt 0 ]; then
    echo "▶ WARNING: the agent committed ${UNEXPECTED_COMMITS} commit(s) despite no-commit mode; they are recorded in the result file." >&2
  fi
else
echo "▶ commits + diff on ${branch}:"
git -C "$wt" --no-pager log  --oneline "${BASE}..HEAD" || true
git -C "$wt" --no-pager diff --stat "${BASE}...HEAD" || true
fi

cat <<EOF

── review ──────────────────────────────────────────────
worktree : ${wt}
branch   : ${branch}
inspect  : cd ${wt} && git diff ${BASE}
keep     : git -C ${wt} push -u origin ${branch}   # then open PR yourself
discard  : git -C ${root} worktree remove --force ${wt} && git -C ${root} branch -D ${branch}
────────────────────────────────────────────────────────
EOF

# Diagnostics must not turn a failed agent run into a successful executor.
exit "$code"

# SECURITY — read before unattended use:
# Claude Code's permission layer is narrower than pi's (no permission layer at
# all), but it is not a sandbox: acceptEdits lets the agent write files, and any
# Bash rule in .claude/settings.json lets it run commands with your full user
# rights. For a supervised run on YOUR repo with an issue YOU wrote, that's
# acceptable — you're watching. The moment this runs unattended, or the issue
# text comes from anyone else, wrap this whole invocation in a container with
# egress restricted to the model endpoint. That boundary is the only thing
# between "issue body" and arbitrary code execution on your rack.

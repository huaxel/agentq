#!/usr/bin/env bash
# pi-workflow.sh — Run a pi-dynamic-workflows workflow for a GitHub issue.
#
#   ./pi-workflow.sh <issue-number> <provider/model> [workflow-name]
#
# The workflow name is optional — if omitted, the model writes an inline script.
# If provided, it runs a saved workflow from ~/.pi/workflows/saved/<name>.js
#
# Environment:
#   BASE_BRANCH      — base branch for worktree (default: current branch)
#   AGENTQ_STOP_WHEN — stop condition from agentq drain
#   AGENTQ_WORKFLOW_SCRIPT — inline workflow script (overrides saved workflow)
#   AGENTQ_WORKFLOW_ARGS   — JSON args passed to the workflow
#   AGENTQ_WORKTREE        — optional existing agentq worktree to reuse
#   AGENTQ_BRANCH          — optional branch label when reusing a worktree
#   AGENTQ_RESULT          — optional path agentq reads the machine-readable
#                            result from (see "Executor result contract" in docs/agentq.md)
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
RESULT_WRITER="${SCRIPT_DIR}/src/runners/result-file.js"

usage() {
  echo "usage: pi-workflow.sh <issue-number> <provider/model> [workflow-name]" >&2
}

# There is no default model: a silent default would keep spending a
# subscription the caller may have dropped. agentq always passes the resolved
# model as the second argument.
ISSUE="${1:-}"
MODEL="${2:-}"
if [ -z "$ISSUE" ] || [ -z "$MODEL" ]; then
  usage
  exit 2
fi
case "$MODEL" in
  -*) usage; exit 2 ;;
esac
WORKFLOW_NAME="${3:-}"
if [ "$WORKFLOW_NAME" = --agentq-pinned-input ]; then
  WORKFLOW_NAME=''
  if [ "${AGENTQ_PINNED_INPUT:-}" != 1 ] || [ -z "${AGENTQ_INPUT_SHA256:-}" ] || [ -z "${AGENTQ_WORKTREE:-}" ] || [ -z "${BASE_BRANCH:-}" ]; then
    echo "Queued input metadata is missing; forward arguments, stdin, AGENTQ input environment, AGENTQ_WORKTREE and BASE_BRANCH." >&2
    exit 1
  fi
fi
# The name becomes a filename under ~/.pi/workflows/saved/ — reject
# separators and traversal (../*) so it can't read a script outside it.
if [ -n "$WORKFLOW_NAME" ]; then
  case "$WORKFLOW_NAME" in
    ..|.|*/*|*..*) echo "pi-workflow.sh: invalid workflow name: $WORKFLOW_NAME" >&2; exit 1;;
  esac
fi
BASE="${BASE_BRANCH:-$(git symbolic-ref --short HEAD)}"

root="$(git rev-parse --show-toplevel)"
slug="issue-${ISSUE}"
wt="${AGENTQ_WORKTREE:-$(mktemp -d)/pi-${slug}}"
branch="${AGENTQ_BRANCH:-$(git -C "$wt" branch --show-current 2>/dev/null || echo "pi/${slug}")}"

if [ "${AGENTQ_PINNED_INPUT:-}" = 1 ]; then
  echo "▶ issue #${ISSUE} — using pinned enqueue input"
  issue_input="$(cat)"
elif [ -n "${AGENTQ_JOB_ID:-}" ]; then
  echo "Queued issue execution requires pinned input; enqueue a new job." >&2
  exit 1
else
  echo "▶ issue #${ISSUE} — fetching standalone input via gh"
  issue_input="$(gh issue view "$ISSUE" --json number,title,body,url,updatedAt)"
fi
# NUL-delimited fields preserve trailing newlines without shell evaluation.
{
  IFS= read -r -d '' title
  IFS= read -r -d '' body
} < <(printf '%s' "$issue_input" | node -e '
  try {
    const data = JSON.parse(require("node:fs").readFileSync(0, "utf8"));
    const pinned = process.env.AGENTQ_PINNED_INPUT === "1";
    if (pinned) {
      const { sha256, ...payload } = data;
      const digest = require("node:crypto").createHash("sha256").update("agentq-issue-input-v1\0").update(JSON.stringify(payload)).digest("hex");
      if (data.type !== "agentq.github-issue-input" || data.version !== 1 || digest !== sha256 || sha256 !== process.env.AGENTQ_INPUT_SHA256) throw new Error();
    }
    const issue = pinned ? data.issue : data;
    if (issue.number !== Number(process.argv[1]) || !issue.title
      || [issue.title, issue.body].some(value => typeof value !== "string" || value.includes("\0") || Buffer.from(value).toString("utf8") !== value)) throw new Error();
    process.stdout.write(issue.title + "\0" + issue.body + "\0");
  } catch {
    console.error("Invalid issue input; enqueue a new job rather than fetching replacement text.");
    process.exitCode = 1;
  }
' "$ISSUE")
unset issue_input

# Issue text is embedded into a generated JS workflow below. It MUST be
# JSON-encoded (not ${var@Q}, which emits shell quoting that is invalid
# JavaScript and breaks on every apostrophe or newline). jq is already a
# repo dependency (bin/*.sh).
command -v jq >/dev/null || { echo "pi-workflow.sh requires jq for safe JS string encoding" >&2; exit 1; }
TITLE_JS="$(printf '%s' "$title" | jq -Rs .)"
BODY_JS="$(printf '%s' "$body" | jq -Rs .)"

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

# Build the workflow script
if [ -n "${AGENTQ_WORKFLOW_SCRIPT:-}" ]; then
  # Inline script from agentq job
  SCRIPT="$AGENTQ_WORKFLOW_SCRIPT"
elif [ -n "$WORKFLOW_NAME" ] && [ -f "$HOME/.pi/workflows/saved/${WORKFLOW_NAME}.js" ]; then
  # Saved workflow
  SCRIPT="$(cat "$HOME/.pi/workflows/saved/${WORKFLOW_NAME}.js")"
else
  # Auto-generate a workflow for the issue
  SCRIPT=$(cat <<JSEOF
export const meta = {
  name: 'issue-${ISSUE}',
  description: 'Implement GitHub issue #${ISSUE}: ' + ${TITLE_JS},
  phases: [{ title: 'Analyze' }, { title: 'Implement' }, { title: 'Verify' }],
}

const ISSUE_TITLE = ${TITLE_JS}
const ISSUE_BODY = ${BODY_JS}

phase('Analyze')
const analysis = await agent(
  \`Analyze this GitHub issue and plan the implementation:
  
Issue #${ISSUE}: \${ISSUE_TITLE}

\${ISSUE_BODY}

Identify:
1. What files need to change
2. What the implementation approach should be
3. What tests are needed\`,
  { tier: 'medium', label: 'analysis' }
)

phase('Implement')
const implementation = await agent(
  \`Implement GitHub issue #${ISSUE} based on this analysis:

\${analysis}

Work in the current directory. Make focused commits as you go.
Run tests/typecheck if present and make them pass.
Do NOT push and do NOT open a PR.\`,
  { tier: 'big', label: 'implementation', isolation: 'worktree' }
)

phase('Verify')
const verification = await agent(
  \`Verify the implementation of issue #${ISSUE}:

\${implementation}

Check:
1. Are there any obvious bugs?
2. Do the changes match the issue requirements?
3. Are tests passing?
4. Is the code clean and follow project conventions?\`,
  { tier: 'medium', label: 'verification' }
)

return { analysis, implementation, verification }
JSEOF
)
fi

# Add stop condition if provided (JSON-encoded: a raw single-quoted
# interpolation would break on apostrophes and allow JS injection).
if [ -n "${AGENTQ_STOP_WHEN:-}" ]; then
  STOP_JS="$(jq -Rn --arg s "$AGENTQ_STOP_WHEN" '$s')"
  SCRIPT="${SCRIPT}

// Stop condition from agentq drain
const STOP_CONDITION = ${STOP_JS};
// The workflow result will be checked by agentq for completion.
"
fi

# Build the prompt for pi
read -r -d '' PROMPT <<EOF || true
Run a workflow to implement GitHub issue #${ISSUE}.

Issue: ${title}

${body}

Workflow script:
\`\`\`js
${SCRIPT}
\`\`\`

Execute this workflow in the current working directory.
EOF

# Add args if provided
if [ -n "${AGENTQ_WORKFLOW_ARGS:-}" ]; then
  PROMPT="${PROMPT}

Workflow args (JSON): ${AGENTQ_WORKFLOW_ARGS}"
fi

SESSION="$wt/.pi-session.jsonl"
echo "▶ running pi workflow (${MODEL})…"
# pi's stdout is streamed (so the job log stays live) and a bounded copy of its
# last 64 KiB is kept only so the stop sentinel can be checked as the agent's
# LAST line (an issue body that merely mentions it must not end a drain).
# Nothing else is parsed out of this output: agentq reads its metadata from the
# AGENTQ_RESULT file below, because the output also echoes the untrusted issue
# body. The copy is bounded by a tail reader behind a FIFO, which keeps
# PIPESTATUS[0] pointing at pi and lets us wait for the copy to finish.
CAPTURE_DIR="$(mktemp -d)"
trap 'rm -rf "$CAPTURE_DIR"' EXIT
OUT_FILE="${CAPTURE_DIR}/tail"
CAPTURE_FIFO="${CAPTURE_DIR}/pipe"
mkfifo "$CAPTURE_FIFO"
tail -c 65536 > "$OUT_FILE" < "$CAPTURE_FIFO" &
capture_pid=$!
set +e
# The model must not see AGENTQ_RESULT: only this shell and the writer may
# write the result, so a prompt-injected model cannot forge one.
( cd "$wt" && printf '%s' "$PROMPT" | env -u AGENTQ_RESULT pi --model "$MODEL" --name "$slug" --session "$SESSION" -p ) | tee "$CAPTURE_FIFO"
code="${PIPESTATUS[0]}"
# Whatever sits at the result path now was not written by this script (the
# model may have learned the path from the parent's environment): drop it
# before writing the real result.
if [ -n "${AGENTQ_RESULT:-}" ]; then rm -f "$AGENTQ_RESULT"; fi
set -e
wait "$capture_pid" || true
echo "▶ pi exit code: ${code}   ($([ "$code" -eq 0 ] && echo SUCCESS || echo FAILED/aborted))"

# Cost/usage from session (human diagnostic; the result file below carries the
# same record to agentq, parsed by node rather than matched as text).
if [ -f "$SESSION" ]; then
  echo "▶ session usage/cost (last usage record):"
  grep '"usage"' "$SESSION" | tail -1 || echo "  (no inline usage record)"
else
  echo "▶ (no session file — usage not captured)"
fi

# Diff summary
echo "▶ diff stat:"
( cd "$wt" && git diff --stat "$BASE" ) || echo "  (no changes or not a git repo)"

# Human-readable summary. agentq reads the AGENTQ_RESULT file below instead of
# these lines: this output echoes the untrusted issue body.
echo "worktree: ${wt}"
echo "branch: ${branch}"
echo "session: ${SESSION}"

# Machine-readable result (AGENTQ_RESULT). JSON is encoded by node, never by
# shell interpolation, and the file is replaced atomically. A failure to write
# it leaves the run's metadata unknown, so it must not change the exit code.
if [ -n "${AGENTQ_RESULT:-}" ]; then
  if ! node "$RESULT_WRITER" \
    --worktree "$wt" \
    --branch "$branch" \
    --session "$SESSION" \
    --usage-file "$SESSION" \
    --stop-from-file "$OUT_FILE"; then
    # Never leave a stale or partial file: agentq reads "missing" instead.
    rm -f "$AGENTQ_RESULT"
    echo "▶ could not write the agentq result file" >&2
  fi
fi

# Diagnostics must not turn a failed agent run into a successful executor.
exit "$code"

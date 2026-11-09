#!/usr/bin/env bash
# pi-issue.sh — M1 smoke test: run ONE GitHub issue through pi headless in an
# isolated git worktree, then show exit code + cost + diff for your review.
#
#   ./pi-issue.sh <issue-number> <provider/model>
#   ./pi-issue.sh 147 opencode-go/deepseek-v4-flash
#
# Run it INSIDE a checkout of the target repo. Supervised manual test only —
# see the SECURITY note at the bottom before running anything unattended.
# AGENTQ_WORKTREE — optional existing agentq worktree to reuse instead of creating one.
# AGENTQ_BRANCH   — optional branch label when reusing an agentq worktree.
# AGENTQ_RESULT   — optional path agentq reads the machine-readable result from
#                   (see "Executor result contract" in docs/agentq.md).
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
RESULT_WRITER="${SCRIPT_DIR}/src/runners/result-file.js"

usage() {
  echo "usage: pi-issue.sh <issue-number> <provider/model> [--agentq-pinned-input]" >&2
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
if [ "${3:-}" = --agentq-pinned-input ] && { [ "${AGENTQ_PINNED_INPUT:-}" != 1 ] || [ -z "${AGENTQ_INPUT_SHA256:-}" ] || [ -z "${AGENTQ_WORKTREE:-}" ] || [ -z "${BASE_BRANCH:-}" ]; }; then
  echo "Queued input metadata is missing; forward arguments, stdin, AGENTQ input environment, AGENTQ_WORKTREE and BASE_BRANCH." >&2
  exit 1
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

read -r -d '' PROMPT <<EOF || true
You are working in a fresh git worktree on branch ${branch}.
Implement this GitHub issue and nothing else.

Issue #${ISSUE}: ${title}

${body}

Constraints:
- Make focused commits on this branch as you go.
- Run the repo's tests/typecheck if present and make them pass.
- Do NOT push and do NOT open a PR — leave the branch for review.
EOF

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
Otherwise do not print it. Keep working normally toward the issue."
fi

SESSION="$wt/.pi-session.jsonl"
echo "▶ running pi headless (${MODEL})…"
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

# Cost/usage: pi's session JSONL carries cache-aware usage per turn.
if [ -f "$SESSION" ]; then
  echo "▶ session usage/cost (last usage record):"
  # Human diagnostic only; the result file below carries the same record to
  # agentq, parsed by node rather than matched as text.
  grep '"usage"' "$SESSION" | tail -1 || echo "  (no inline usage record — try: pi --session \"$SESSION\" --print \"/session\")"
else
  echo "▶ no session file at ${SESSION} — pi may have written its default location instead."
  echo "  find it with: ls -t ~/.pi/agent/sessions | head -3"
fi

echo "▶ commits + diff on ${branch}:"
git -C "$wt" --no-pager log  --oneline "${BASE}..HEAD" || true
git -C "$wt" --no-pager diff --stat "${BASE}...HEAD" || true

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
# pi has NO permission layer; headless it executes bash + file writes with your
# full user rights (SECURITY.md). For a supervised run on YOUR repo with an issue
# YOU wrote, that's acceptable — you're watching. The moment this runs unattended,
# or the issue text comes from anyone else, wrap this whole invocation in a
# container with egress restricted to the model endpoint. That boundary is the
# only thing between "issue body" and arbitrary code execution on your rack.

# agentq

`agentq` turns GitHub issues into reviewable coding-agent runs. Local mode and
orchestrator mode share one SQLite task store: local mode opens the database
in-process, orchestrator mode reaches it over HTTP for multiple workers. Both
reuse the repository's quota-aware model resolver.

## Requirements

- Node.js 22.5+
- git
- GitHub CLI (`gh`) authenticated for issue/repository discovery and issue enqueue
- `pi` (installed locally by `npm ci`, or available on `PATH`)

Jules execution additionally requires `JULES_API_KEY` and a repository connected
to the Jules GitHub app. Runnables with `"harness": "claude"` require the Claude
Code CLI (`claude`, 2.1+) on `PATH` and a logged-in Claude subscription.

## Home directory

The checkout holds code, the method's defaults and examples. Everything personal
lives in `AGENTQ_HOME`, outside the repository:

```text
$AGENTQ_HOME/                       # default: ${XDG_CONFIG_HOME:-~/.config}/agentq
├── config/
│   ├── roi.config.json             # your subscriptions, fees, model coverage, path maps, aliases
│   ├── runnables.json              # the model paths you can run
│   └── execution-paths.json        # machine/harness inventory
└── data/
    ├── orchestrator.sqlite         # the task queue (+ worktrees, logs)
    ├── quota.json, pricing.json    # collected snapshots
    ├── roi-output.json             # scored models and economics
    ├── roi-dashboard.html          # generated dashboard
    ├── benchmark-inputs.json       # benchmark registry
    ├── usage-imports/<host>.json   # per-machine usage bundles
    ├── snapshots/<date>.json       # daily trend history
    └── ccagg-*.csv                 # exports
```

```bash
agentq home            # print the resolved home and which config files exist
agentq home init       # create config/ + data/ and copy examples/home/config
agentq home init --force   # overwrite existing config files with the examples
```

`agentq home init` seeds `examples/home/config/`, which contains fictional
subscriptions and path maps — edit them to describe your own setup. The score
weights, tier thresholds, partition maps and Claude job permissions are the
method, tracked in `config/defaults/`, and are merged underneath your setup
(objects merge recursively; arrays and scalars in your file replace the default).

Precedence for every runtime path:

1. an explicit option (`--db`, `--quota`, `--config`, …);
2. the file's environment variable (`AGENTQ_DB`, `AGENTQ_QUOTA`,
   `AGENTQ_ROI_CONFIG`, `AGENTQ_ROI_OUTPUT`, `AGENTQ_AA_SNAPSHOT`,
   `AGENTQ_BENCHMARK_INPUTS`, `AGENTQ_VALUES_INPUTS`, `AGENTQ_GOLDEN`,
   `AGENTQ_WORKER_DIR`, `AGENTQ_ORCHESTRATOR_DB`, `ORCHESTRATOR_DB`);
3. the home directory.

Nothing falls back to the checkout, so a fresh clone cannot read someone else's
data. A test enforces this for `src/` and `bin/`.

## Interactive use

```bash
npm run agentq
```

The menu discovers local clones, lists open issues and pull requests, remembers
the last repository, and shows model/quota impact before enqueueing.

## Scriptable local queue

```bash
# Enqueue an issue you authored or otherwise trust
npm run agentq -- enqueue \
  --repo /path/to/repo \
  --issue 42 \
  --model auto \
  --trusted

# Run one job or drain every ready job
npm run agentq -- run-next --verify 'npm test'
npm run agentq -- drain --verify 'npm test'

# Run one specific task (id or unique prefix), e.g. from a dispatcher
npm run agentq -- run --id 3f2a8c1e --model auto --verify 'npm test'

npm run agentq -- status
npm run agentq -- requeue --id 3f2a8c1e --model auto
npm run agentq -- prune
```

Run `npm run agentq -- --help` for the complete command surface.

Task ids are UUIDs. Every `--id` (and `--depends-on`) accepts a full id or a
unique prefix of at least six characters; an ambiguous prefix is an error that
lists the matches.

### Running one specific task

```bash
npm run agentq -- run --id 3f2a8c1e [--model MODEL|auto] [--tier T] \
  [--executor PATH] [--verify CMD] [--sandbox PATH | --cua] \
  [--allow-untrusted] [--retry N] [--json]
```

`run --id` claims exactly that task instead of the next one, so a dispatcher
(the MCP `dispatch_task` tool, a script, or a human) can hand a specific task to
a worker. Everything else is `run-next`: the same executor selection, admission
gate, verification and retries.

Exit codes: `0` success, the executor's exit code on failure, `1` for an
unverified run or an unusable request (unknown id, a task that is not
`pending`), `2` when a gate refused the task, and `3` when the queue was busy
(another process held the SQLite write lock) so nothing was claimed. Exit `3`
is retryable; `2` is not (fix the cause first). A busy queue is reported as `3`
both when the claim hits the lock and when opening the queue already does
(WAL mode and schema init are writes).

Every gate is a refusal: the task stays `pending` with no state change and the
reason is printed. That covers admission, a task of a different kind than this
worker claims (`--kind`), human approval still pending (a task this machine did
not enqueue itself), dependencies that have not succeeded, a spent attempt
budget (`attempts >= max_attempts` on a task this machine does not own), and a
provider rate limit with no lease available. The approval, dependency,
attempt-budget and rate-limit decisions run inside the claim transaction
(`claimTaskById`), so a concurrent approval, completion or lease release is
never missed. A task that is not `pending` is an error, not an idle queue,
because the caller named it.

`--model` overrides the stored model for this claim only (the same
`modelOverride` the orchestrator worker applies), and `auto` is routed through
the routing core before the claim, so the audit row records the concrete model
that ran. When the override replaces a different stored model, the `claimed`
task event keeps `previous_model` and `previous_provider` alongside it.

`--worker-id` (or `AGENTQ_WORKER_ID`) names the local claim identity (default `local-<host>-<pid>`).
Only two shapes are accepted in local mode: `local-<host>-<pid>` and
`local-<host>-dispatch-<pid>`; anything else is a usage error (exit `2`). The
MCP dispatcher passes the second shape, which is how the dispatch concurrency
cap counts its claims from the queue for this host and how `recover` still
recognises a crashed dispatch worker.

`run --id` is local-queue only: `--source orchestrator` has no claim-by-id
endpoint, so it is refused rather than silently running a different task.

### Pinned issue inputs

Issue enqueue requires GitHub access. One bounded `gh issue view` request captures
number, title, body, URL, and update time before the job is stored. The queue keeps
the exact text, capture time, and SHA-256 snapshot digest. A failed fetch creates
no job. Execution and retries use that stored input, not the issue's latest text.

`requeue` retains the original input. For changed requirements, enqueue a new job;
there is no implicit refresh. Local jobs without a valid snapshot remain visible
as blocked with an input error. Selection skips them so independent valid jobs
can continue. Orchestrator workers terminally fail invalid claimed issue jobs
without retries; approval-gated legacy jobs cannot be approved. Review them and
enqueue replacement jobs explicitly, including replacement dependencies where
needed. No old inputs or dependency links are automatically rewritten or deleted.

The CLI captures on the enqueueing machine. Dashboard/API issue creation without
an input snapshot captures on the server, which therefore needs `gh` access and
an accessible repository directory locally. Server captures are asynchronous and
limited to four concurrent requests; a busy server returns 503 without creating
a task. A client may instead send a snapshot from
`src/core/issue-input.js` as `JSON.stringify(snapshot)` in `prompt`; the server
validates it without refetching. Issue input cannot be patched in place, even
before approval. Approval and completion records identify the snapshot digest.
For dashboard issue jobs, leave Prompt blank and keep requirements in the issue;
Prompt remains available for non-issue tasks.

Issue executors receive a third `--agentq-pinned-input` argument and the canonical
snapshot on stdin, with `AGENTQ_PINNED_INPUT=1` and `AGENTQ_INPUT_SHA256`. Sandbox
wrappers must forward arguments, stdin, these non-secret input variables,
`AGENTQ_WORKTREE`, `AGENTQ_RESULT`, and `BASE_BRANCH` unchanged. The queued-mode argument prevents
a stripped environment from falling back to a live fetch. Unavailable or corrupt
transport fails without a host fallback. Custom issue executors must consume
this contract too. Direct,
supervised standalone scripts still fetch current issue text once per invocation.

Snapshots contain full issue text: keep queue state private. The digest is a
snapshot identity, not an authentication signature or a replacement for the
separate approval and execution-trust gates.

### Durable state

The queue is one SQLite database, `$AGENTQ_HOME/data/orchestrator.sqlite` by default — the
same file the orchestrator, the dashboard and the MCP server read. `--db PATH`
(or `AGENTQ_DB`) names a different file. Local mode calls the task functions
directly; `--source orchestrator` uses the HTTP API over the same schema. One
queue, two access modes.

`tasks` and `task_events` are the audit trail (one row per transition), so
`sqlite3 "$AGENTQ_HOME/data/orchestrator.sqlite" 'select * from task_events'` replaces the old
`jq`-over-JSONL workflow. Logs and worktrees are kept under
`$AGENTQ_HOME/data/logs/` and `$AGENTQ_HOME/data/worktrees/`.

A legacy JSONL log is no longer a queue. Import it once:

```bash
npm run agentq -- import-log --log data/agentq.log
```

The import is a one-shot migration, not a sync: an id that already exists is
left completely untouched and counted as `skipped` (a row created by another
producer is also reported as a collision). It keeps the original task ids and
the legacy completion record (worktree, branch, exit code, session, log,
verification), so prune can still find imported worktrees. Pointing `--db` at a
`.log` file, or at a file whose contents are JSONL, fails with that
instruction.

For git repositories, each job gets:

```text
branch:   agentq/job-<task-id>
worktree: <queue-directory>/worktrees/job-<task-id>
```

Completed worktrees remain for review. `prune` reclaims files only: it removes
finished jobs' worktrees/branches, records a `pruned` task event with what was
removed or skipped, and never deletes task rows or usage (age-based row cleanup
stays with the orchestrator's `pruneCompletedTasks`). Without `--force` it
refuses to discard an uncommitted worktree; a worktree or branch it cannot
prove is job-owned is reported and left for manual deletion.

## Trust boundary

An issue body becomes an agent prompt, and `pi` can execute shell commands with
the current user's permissions. Jobs therefore default to untrusted.

Choose one explicit execution boundary:

```bash
# Trusted issue text
npm run agentq -- enqueue ... --trusted

# Untrusted issue through a wrapper you control
npm run agentq -- run-next --sandbox /usr/local/bin/agentq-sandbox

# Supervised one-off override
npm run agentq -- run-next --allow-untrusted
```

A sandbox wrapper receives:

```text
sandbox <executor> <issue-number> <provider/model> --agentq-pinned-input
# Issue snapshot JSON is supplied on stdin; preserve the input environment above.
# Feedback tasks instead receive <task-id> <provider/model> and their prompt on stdin.
# When --verify is also set, verification uses the same wrapper:
sandbox sh -c <verification-command>
```

The wrapper must forward the environment unchanged, including `AGENTQ_RESULT`:
that path is how the executor reports its result back to agentq, and a wrapper
that drops it makes the run's metadata unknown (see the executor contract
below). It needs write access to that one per-attempt result directory only —
mount the log directory read-only and the result directory writable, so a
compromised run cannot rewrite earlier attempts' results or the job logs.

Workers claim one task kind at a time (`--kind`, default `github_issue`);
orchestrator workers register only that capability. Feedback workers use
`--executor` for a custom executor or `--cua` for the built-in CUA executor;
orchestrator workers also require `--model` before the queue is contacted. The selected model is applied only when claiming an eligible
feedback task with no model set; `--model auto` also resolves server-side
through the routing core. Approval still gates the claim, and an unapproved task
remains unchanged.
The feedback prompt is forwarded as stdin rather than placed in process
arguments. This is transport, not a sandbox: feedback is always treated as
untrusted and requires a verified `--sandbox` wrapper, the opt-in `--cua` mode
below, or a deliberate `--allow-untrusted` override. Feedback executors must
work inside `AGENTQ_WORKTREE` rather than creating standalone worktrees.

### CUA feedback pilot

`--cua` selects AgentQ's dedicated host-Pi/guest-VM executor. It is feedback-only
and cannot be combined with `--sandbox` or `--executor`:

```bash
AGENTQ_CUA_INTEGRATION_ROOT=/path/to/reviewed/pi-durable \
CUA_HOME=/path/to/local/cua-home \
npm run agentq -- --source orchestrator --kind feedback drain --model auto --cua --verify 'npm test'
```

Configure `AGENTQ_CUA_INTEGRATION_ROOT` to an already-installed, reviewed local
Pi Durable CUA integration and `CUA_HOME` to the local CUA runtime state.
Optionally set `AGENTQ_PI_AGENT_DIR` to select an existing Pi profile; otherwise
the SDK uses its default agent directory. The executor creates a uniquely named
local QEMU VM from `ghcr.io/trycua/linux:24.04` by default (override with
`AGENTQ_CUA_IMAGE`), with guest networking disabled, no published ports/services,
a 24-hour deletion backstop, and explicit cleanup.
It sends only clean tracked `HEAD` source (never `.git`, dotenv/auth files, or
host user config) and, when present and manifest-matched, the repository's
existing `node_modules` tree. No package install or network access occurs in
the guest. The host Pi SDK uses the existing Pi credential store; the guest
never receives credentials or host filesystem/shell tools. Model-provider
requests still originate from the host.

`--verify` runs inside that same VM. A failed check retains the patch in the
AgentQ worktree but records the job as `unverified`; it never falls back to a
host-side command. The VM produces a patch that is path-checked, rejects
symlinks and sensitive config targets, and is applied (not staged or committed)
to the host job worktree. If no matching local `node_modules` is available,
the agent can still edit, but project checks may be unavailable.

This is a pilot integration, not an approval shortcut. It has not been deployed
as a worker or used to claim/run any queued feedback task. `--cua` does not
approve tasks; an orchestrator task must still pass its separate human approval
gate.

Both invocations run in the job worktree. The wrapper must support both forms;
refusing verification records the job as `unverified`, without a host fallback.
It should remove secrets, restrict the filesystem and network, then `exec "$@"`.
The trust gate is intentionally inconvenient to bypass unattended.

Two separate mechanisms gate a job, and **approval does not lift the trust
gate**:

- **Approval** is a human checkpoint on the queue: a task with
  `approval_required` is not *claimable* by an HTTP worker until approved. It
  says nothing about how the job will execute. An untrusted CLI enqueue is
  stored with `approval_required: 1`; the local CLI may still run it (enqueueing
  on this machine is the human act), which is what keeps an orchestrator worker
  from claiming it and failing it on the trust gate. That local exemption keys
  on the task's `source`, so the sources agentq writes itself (`cli`, `mcp`,
  `agentq`) are reserved: `POST /api/tasks` rejects them with 400 and the MCP
  server always forces `mcp`, so no HTTP client can mint a locally-owned task.
- **The trust gate** (execution time, both backends) is what protects the
  machine: a job runs bare only if it was enqueued `--trusted`, or the worker
  passes `--sandbox`, `--cua`, or `--allow-untrusted`. An approved but untrusted job is
  still refused at execution time — approval and trust are independent.

The orchestrator has a single credential (`AUTH_TOKEN`): anyone who holds it
can create, approve, and claim, so the token is the trust boundary for the
queue API. `trust_level` on a task is an assertion by its creator under that
token, not a server-verified identity. Likewise, the interactive menu asks
whether the issue comes from a public repo and defaults to *untrusted*; a trusted
run requires an explicit answer. The CLI and programmatic enqueue also default
to *untrusted*.

Pruning retains terminal prerequisites while they have unfinished dependents.
Automatic cleanup skips them; explicit deletion refuses them. This preserves
failed dependency outcomes instead of silently unblocking downstream tasks.

Prune also never auto-deletes a branch it cannot prove is job-owned: the
worktree/branch values come from the executor's result file, so a branch is deleted only
if the job's worktree still has it checked out, or the worktree is gone and
the name is in the `pi/` namespace. Unprovable branches are reported in the
prune output and left for manual deletion.

## Refusals

Admission is the claim's candidate filter: a job this worker may not run stays
pending with no state change at all. That is not an empty queue, so the CLI
says why:

```text
$ npm run agentq -- run-next
job 3f2a8c1e: Refusing untrusted job #3f2a8c1e-... without --sandbox or --allow-untrusted. ...
```

`run-next` exits 2 when nothing was claimed but something was refused; `drain`
reports the same list and exits 2 when it ran nothing. `--json` output includes
`refused: [{ id, reason }]`. The interactive menu prints the reasons instead of
"no pending jobs".

A refusal that only becomes visible after the claim (a tampered or mutated row,
or a model whose harness/mode cannot run here) is terminal, exactly as on the
orchestrator: the claim is released and the task ends `failed` with the reason
in its result, so a drain moves on to the next task instead of re-claiming and
re-refusing the same head-of-queue job. `requeue` starts it again once the cause
is fixed. Transient interruptions still re-pend.

## Executor result contract (AGENTQ_RESULT)

A run's metadata does not come from stdout. The executor's output echoes the
issue body and the model's own text, so it is kept as the human log only.
Instead agentq creates one result directory per attempt under the job's log
directory and passes the file inside it as `AGENTQ_RESULT`:

```text
<queue>/logs/agentq-result-<task-id>-<attempt-id>-<random>/result.json
```

The directory is created with `mkdtemp` and mode `0700`, so it is unique per
attempt, empty by construction, not derivable from sibling file names, and
readable only by the user running agentq. Nothing is created at `result.json`
itself: an executor that writes nothing leaves nothing to read.

`AGENTQ_RESULT` is removed from the model's own process environment
(`env -u AGENTQ_RESULT pi …` / `… claude …`, and from the CUA executor's host
child processes). Without a sandbox this hiding is best-effort: a model running
as the same user can still read the parent's environment (`ps eww`, `/proc`).
What agentq actually relies on is that the executor deletes anything at the
path once the model exits and then writes its own result atomically, so a file
the model planted is never the one read back. A model that keeps a background
process alive past the executor can still race that; run untrusted jobs in a
sandbox that does not mount the result directory into the model's view.

The executor writes ONE JSON object there, atomically (write a temporary file in
the same directory, then rename over the target), encoded by a JSON encoder
rather than shell string interpolation:

```json
{
  "version": 1,
  "worktree": "/abs/path/or/null",
  "branch": "agentq/job-<id>",
  "session": "<session id or path, or null>",
  "usage": { "inputTokens": 0, "outputTokens": 0 },
  "verification": "passed",
  "stop": false
}
```

`version` (`1`) and `stop` (boolean) are required; every other field may be
omitted and is read as `null`. `verification` is `passed`, `failed`, or `null`.
Unknown top-level keys are rejected, and the file is capped at 64 KiB.

`usage` is filtered rather than rejected. Only the fields the sinks consume are
kept (`inputTokens`/`input_tokens`/`input`, the output, cache and total-token
names, `totalCost`/`total_cost`/`total_cost_usd`, a numeric or breakdown
`cost`, and the `provider`/`model` attribution); each must be a finite,
non-negative number within bounds (tokens `<= 1e10`, cost `<= 1e4`). Anything
unknown, non-numeric, negative or implausible is dropped, and a usage object
with nothing usable left is written and read as `null`. agentq never clamps or
invents a number the executor did not report.

agentq reads that file through one descriptor opened `O_RDONLY|O_NOFOLLOW`
(no symlink is followed), requires a regular file owned by the user running
agentq whose mtime is not older than the executor's start, and reads at most
64 KiB + 1 byte to detect a file that grew. It then applies the same safety
checks as before to `worktree` and `branch`: a worktree must stay inside the
job's own footprint, and a branch must be a sane refname. Nothing in stdout can
influence the persisted worktree, branch, session, usage, verification or stop
flag.

When the file is absent, empty, oversized, not JSON, or off-schema, the run's
metadata is `null` and the reason (`result_file: 'missing'` or `'invalid'`) is
appended to the job log and reported by `run-next --json`. There is no fallback
to scraping stdout, and the process exit code is unchanged.

The shipped executors (`pi-issue.sh`, `pi-workflow.sh`, `claude-issue.sh`, and
the CUA feedback executor) implement this contract; `src/runners/result-file.js`
holds the schema, the atomic writer and the reader. A writer failure removes
any partial file, so the run reports `missing` rather than reading a fragment.
Custom `--executor` targets and persisted executors receive the same
`AGENTQ_RESULT` path and are expected to honour it. A standalone run without
`AGENTQ_RESULT` writes no result file.

Two fields are statements by the executor, not by agentq:

- `stop` is model-controlled. The shipped executors set it when the agent's
  last non-empty output line is exactly `SHOULD_FULLY_STOP=true`, and agentq
  only acts on it when the run was started with `--stop-when`.
- `verification` is only read in `--cua` mode, where the executor (the CUA
  guest's own `--verify` run) reports `passed`/`failed`. Every other mode
  ignores it and runs `--verify` itself in the job worktree.

## Verification, retries, and dependencies

### Verification

```bash
npm run agentq -- drain --verify 'npm test'
```

The command runs inside the job worktree after a successful agent exit. A failed
check records `unverified`, not `succeeded`, and returns a non-zero process
status.

### Retry with backoff

```bash
npm run agentq -- drain --retry 3 --verify 'npm test'
```

A retry is a new claim of the same task: the failed attempt is recorded, the
task is re-pended, and it is re-claimed by id with a fresh claim token. If
another owner requeued or claimed the task during the backoff, the retry is
superseded and no second executor runs. The default backoff is exponential;
tests can set `--retry-base-ms 0`. Local tasks are stored with one attempt per
claim, so the store never retries on its own — `--retry` is the only retry
policy in local mode.

### Dependencies

```bash
npm run agentq -- enqueue --repo . --issue 101 --model auto --trusted
npm run agentq -- enqueue --repo . --issue 102 --model auto --trusted --depends-on 3f2a8c1e
```

A dependent job stays blocked until every prerequisite succeeds. Failed or
unverified prerequisites remain visible rather than silently releasing later
work.

### Stop condition

```bash
npm run agentq -- drain \
  --stop-when 'all tests pass and the README documents the flag'
```

The condition is forwarded to the executor. A job can emit the exact final
sentinel `SHOULD_FULLY_STOP=true`; the executor reports that as `"stop": true`
in its result file, and the drain then leaves remaining jobs pending. Only the
agent's last non-empty line counts, so an issue body that merely mentions the
sentinel cannot end a drain, and agentq never reads it back from stdout.

## Agent-facing execution facts

Use `node bin/capacity.js` for read-only execution paths, observed Pi models,
quota state/freshness and harness constraints. It informs agent reasoning;
it neither selects nor dispatches work. See [capacity.md](capacity.md).
The queue resolver below reads the same quota snapshot. Shepherdr profiles are
not configured by `update-subagent-models.sh`.

## Quota-aware model selection

`--model auto` resolves when the job starts, not when it is enqueued. This avoids
reserving a model that is saturated by the time work runs.

```bash
npm run agentq -- pick
npm run agentq -- pick --tier big --json
npm run agentq -- drain --tier small --verify 'npm test'
npm run resolve-model -- --tier medium
node src/lib/quota-resolver.js --all --json
```

Routing is data-driven, not a hard-coded ladder:

- `$AGENTQ_HOME/config/runnables.json`: which model id runs on which quota path and harness.
- `$AGENTQ_HOME/config/roi.config.json` `paths[].models`: which models each subscription covers.
- `$AGENTQ_HOME/data/roi-output.json`: intelligence (`genIntel`) and cost (`mtok`) per model.
- `$AGENTQ_HOME/data/quota.json`: per-path windows, observation time, and reset time.

Coverage and runnables are different questions. `paths[].models` says "this
subscription offers this model" — a list of model keys (normalized with
`src/lib/model-key.js`), or `["*"]` for a metered pay-per-token path that serves
whatever the registry lists; a missing or empty list covers nothing. A runnable
says "I have wired this model for dispatch on this path". A runnable's path is a
quota path id, so coverage is the union over every config entry that funds it
through `sourcePath` — a newer plan for the same quota path covers what it
serves, even when an older entry's model list is stale. Scoring needs
coverage, so a model can be scored without a runnable, but a runnable whose
path does not cover its `modelKey` is a setup mistake: `npm run verify` fails
with `runnable <id>: path <path> does not cover <modelKey>`, and `agentq pick`
warns instead of refusing to route. Coverage lives in your config, never in the
benchmark registry, so a new subscription is one config entry and a registry row
that still carries an old `on*` column is simply ignored.

The router ranks eligible runnables cheapest-first, then by soonest reset, then
by intelligence. `--tier small|medium|big` (default `medium`) sets the
intelligence floor. Unknown or stale quota is never treated as available: a path
without a fresh observation is ineligible, and when nothing is eligible the run
fails with the rejection reasons instead of silently falling back to a model.
Explicit model ids bypass routing entirely.

`--check MODEL` reports a model's capacity entry and eligibility; `--all` lists
every tier. Both read the same snapshot the queue uses.

### Quota windows

`config.paths[].quotaWindows` says how a path's windows combine into one
headroom figure, and it defaults to `"all"`: every window binds, so a path's
headroom is the smallest headroom over the windows that have not reset. That is
the safe reading, because most providers enforce every limit at once — Claude
Max has a 5-hour and a weekly limit, Go has 5-hour, weekly and monthly ones —
and any exhausted window blocks the path. Taking the best window would report a
path as available whenever its shortest window had room, which fails open.

Use `"any"` when the windows really are alternatives: separate sub-accounts, or
model groups, where using up one leaves the others usable. Then headroom is the
largest, and the path stays available while any window has room. A window past
its reset counts as 100% headroom under either mode, and a path with no windows
reports 100%. Under `"all"` a saturated path's reason names the binding window,
for example `headroom below threshold (weekly: 0% left)`.

A window may also carry `period`, a provider-declared duration string parsed
with the label rules below (`monthly`, `5h`, …). It outranks the label, which
matters when the label names no length: Mistral's budget windows are labelled
`Month` and `Vibe`, and the fetcher marks both `period: "monthly"` so pace can
project them.

### Quota pace

A subscription path's cost is not flat: it depends on how fast the window is
being consumed. Each window's duration comes from `windowMinutes` when it is a
positive number, then from `period`, otherwise from its label (`5h`, `5-hour`,
`daily`, `weekly`, `monthly`, `<n>m|h|d`, case-insensitive). A parenthetical
qualifier is ignored, so `5-hour (gosingle)` is a 5-hour window, and a label
such as `requests`, `concurrency` or `total` describes no duration. With
`elapsedPct` the fraction of the window already gone and `usedPercent` the
quota consumed,
`projectedPct = usedPercent / (elapsedPct / 100)` extrapolates linearly to the
reset. It is null before 5% of the window has elapsed, where extrapolation is
noise. The binding window is the one with the highest projection (the earliest
reset breaks a tie) and reports
`pace: { window, usedPct, elapsedPct, projectedPct, state }`, where `state` is
`behind` below 80, `ahead` above 110, and `on` in between.

`quotaPressure = clamp(0.25, 4, projectedPct / 100)` scales the list price into
`effectiveCostPerMTok`, and that is what routing orders and the shortlist roles
compare: quota behind pace is cheap because it would reset unused, quota ahead
of pace is dear because spending it now displaces later work. Pressure only
scales cost — it never makes a saturated path eligible — and a path with no
projection keeps its list price and today's order.

### Options, not a verdict

agentq informs rather than chooses. Ranking answers "what is eligible, cheapest
first", which is not a decision, and the full ranked list is too long to reason
about. So a recommendation is a **shortlist** of up to four options, each
carrying the roles that make it interesting:

- `cheapest` — the lowest pace-adjusted cost per MTok. Found by price, not by
position, so a degraded path can still be the cheapest thing on the board.
- `smartest` — the highest intelligence. A measured score beats an AA-derived
  estimate when the two tie.
- `expiring` — the most-behind path: among choices whose pace is `behind`, the
  lowest projection, which is the most quota projected to go unused. Ties go to
  the earlier reset. Left out when no choice is behind pace.
- `best-value` — the most intelligence per pace-adjusted dollar among the
  choices that have not already earned a role. A free (local) path only counts
  when no paid choice exists.

A choice that earns several roles is one option with several roles, the
remaining slots are filled in rank order as `alternative`, and ties prefer a
path that is not already on the list so the options stay distinct. A degraded
path may appear, always with its degraded reason attached.

The result also carries a `default`: the head of the ranked list. It exists only
for `auto` — the dispatch mode where nobody is there to choose — and is not a
verdict on the options. A caller (a person, or a main assistant reading the MCP
tools) picks an option and passes its id to `dispatch_task` as `model`; the
choice is recorded in the task's event trail with the roles that model played.

### Path health

Every execution attempt's outcome is recorded per quota path (`path_outcomes`:
`ok`, `timeout`, `error`, `verify_failed`, `lost`): the local runner writes it
through its queue sink, and the orchestrator writes it in the HTTP completion
route for remote workers. `lost` is written by lease recovery
(`recoverExpiredTasks`): the attempt's lease expired with no completion report,
so the worker hung or died. Routing then folds the last hour of outcomes into
per-path health: a path whose most recent 3 outcomes are all
`timeout`/`error`/`lost`, with the last one less than 30 minutes ago, is
**degraded**. Any `ok` after the failures resets it, and `verify_failed` (exit 0
with failed verification — a task failure, not an infrastructure failure) never
counts against the path.

`lost` has a known trade-off: a machine that sleeps with several running jobs
on one path wakes up with all of them recovered as `lost`, which can push that
path into the degraded state for up to the 30-minute cooldown even though
nothing is actually wrong with the provider. That is acceptable by design: a
degraded path is only demoted (sorted after healthy choices), never rejected.

Local runs record no `lost` outcome: a hung local executor is already bounded
by the executor timeout and recorded as `timeout`, and a dead local worker
process found by `agentq recover` usually means a manual kill or reboot rather
than a provider failure, so it is deliberately not counted against the path.

A degraded path stays eligible but sorts after every healthy choice, so a
wrong "no model" never beats a slow one. The degraded choice carries a
reason such as `path degraded: 3 consecutive failures (2 timeout, 1 lost), last 12m ago`,
and `pick` and the interactive menu print a short `degraded` marker alongside
the table. `quota-resolver` accepts the same health map programmatically and
notes a degraded pick on stderr. A DB read failure never breaks routing — it
is logged once to stderr and the command routes without health. Set
`AGENTQ_PATH_HEALTH=0` to disable it.

To update external pi workflow settings from the same policy:

```bash
./bin/update-subagent-models.sh
./bin/update-workflow-tiers.sh
```

`update-workflow-tiers.sh` writes only tiers that resolved. A tier that does not
resolve keeps its existing value in `~/.pi/workflows/model-tiers.json`, the
warning names the tier and the resolver's message, and the script exits
non-zero. There are no hard-coded model fallbacks.

### Quota freshness

Quota older than six hours is unknown, and nothing collects quota on its own.
So that an idle machine does not silently lose every `auto` decision, the
commands that are about to route (`pick`, and `run-next` / `drain` / `run --id`
when the task's model is `auto`) check the snapshot first and collect it when it
is stale:

```text
quota refreshed in 12.3s
quota refresh skipped: collector exited 1
```

One line is printed only when a collection actually ran: a fresh snapshot, an
opt-out, a rate-limited attempt, and a refresh another process already finished
all stay silent.

The refresh runs the same collector as `npm run collect-quota` as a subprocess
(90 s timeout). It is deliberately conservative:

- fresh data is never re-collected (same six-hour window routing uses);
- one collection at a time across processes. The lock next to the snapshot
  records `{ pid, startedAt, nonce }` and is created by writing the complete
  record to a private file and hard-linking it into place, so it is never
  visible empty or half-written (leftover files from a process that died
  mid-acquire are swept once they are a minute old). A second caller waits and
  re-reads instead of starting another collection. A lock is broken only when
  its holder is dead or it is older than 2x the timeout; breakers are
  serialized by a breaker directory whose own staleness is 30 s, and the break
  re-reads the lock and unlinks it only when it still carries the exact owner
  record that was judged stale, so a lock that changed hands is never removed.
  A release only removes a lock that still carries its own nonce;
- at most one attempt per ten minutes, including after a failure, so a broken
  collector is not retried on every command (and if the attempt stamp cannot be
  written, the command does not collect at all rather than collecting on every
  call). The stamp is written before collecting, so a **cancelled** collection
  still counts as an attempt: an interrupted refresh does not retry
  immediately;
- failures never fail the command: they are reported as a skipped refresh, and
  the collector's stderr (which can contain account labels) is not echoed;
- if the process is interrupted (SIGTERM/SIGINT/SIGHUP) or exits mid-collection,
  the collector's process group is killed and the lock is released before the
  signal is re-raised with its default behaviour. A cancellation (the MCP
  server's client going away) kills the collector and then waits for the
  collection to settle before the lock is released, so a replacement collection
  never starts alongside one that is still writing.

Pid liveness is single-host: sharing one `data/` directory between hosts or
containers is not supported, because a lock held by another machine looks like
a dead holder here and the collector would run twice.

`--no-quota-refresh` disables it for one command, and `AGENTQ_QUOTA_REFRESH=0`
disables it for a process (the MCP server included). A custom snapshot path
(`--quota` / `AGENTQ_QUOTA`) is not refreshed with the shipped collector, which
always writes `$AGENTQ_HOME/data/quota.json`.

`AGENTQ_QUOTA_COLLECTOR=<script>` is a **test hook** (and an escape hatch for a
deployment that collects elsewhere): it replaces the collector command, is
resolved to an absolute path, and because the replacement may write any file it
also lifts the custom-path guard above. It is not a supported way to point the
shipped collector at another snapshot.

## Recovery and cancellation

```bash
npm run agentq -- cancel --id 3f2a8c1e
npm run agentq -- recover --max-age-min 60
npm run agentq -- prune
```

`recover` returns interrupted **local** jobs to pending: only claims made by
this host (`local-<hostname>-*`). A local claim holds a full executor-window
lease (there is no heartbeat process), so liveness comes from the job's PID
file: an old local task whose executor is gone is re-pended, and one whose
executor is still alive is left alone. Expired orchestrator leases are the
orchestrator server's job (`npm run orchestrator -- recover`), so a shared
database never has one worker stealing another's task. Recovery does not reset
the attempt counter; only an explicit `requeue` starts a fresh budget.

`task_events` records every claim, attempt, retry, completion, recovery,
requeue and prune. `cancel` kills the executor's process tree and records the
task as failed with a cancellation reason (the schema has no separate cancelled
status). A task that already finished is never overwritten: its stale PID file
is removed instead.

## Orchestrator mode

Start the service:

```bash
npm run orchestrator
# non-local deployment
AUTH_TOKEN='replace-me' npm run orchestrator -- --host 0.0.0.0 --port 8090
```

Use it from `agentq`:

```bash
npm run agentq -- \
  --source orchestrator \
  --orchestrator-url http://127.0.0.1:8090 \
  enqueue --repo /path/to/repo --issue 42 --model auto --trusted

npm run agentq -- --source orchestrator drain --verify 'npm test'

# Feedback tasks require a matching queued model and an explicit boundary.
npm run agentq -- --source orchestrator --kind feedback run-next --model auto --cua
```

The browser dashboard is served at `/`. The service supports task creation,
claiming, approval/rejection, completion, bulk operations, export, worker
heartbeats, rate-limit leases, and server-sent events.

Important endpoints:

| Method | Path | Purpose |
| --- | --- | --- |
| `POST` | `/api/tasks` | create a task |
| `GET` | `/api/tasks` | list/filter tasks |
| `GET` | `/api/tasks/next` | claim next runnable task |
| `POST` | `/api/tasks/:id/result` | complete/fail a claimed task |
| `POST` | `/api/tasks/:id/approve` | approve pending work |
| `POST` | `/api/tasks/:id/reject` | reject pending work |
| `POST` | `/api/workers` | register a worker |
| `POST` | `/api/workers/:id/heartbeat` | renew worker/task lease |
| `GET` | `/api/events` | SSE event stream |
| `GET` | `/api/tasks/export?format=csv` | export task data |

Run `npm run orchestrator -- --help` for lifecycle and cleanup flags.
`npm run orchestrator -- migrate --log data/agentq.log` performs the same
one-shot legacy import as `agentq import-log`.

### Programmatic worker

```js
const { OrchestratorWorker } = require('./src/queue/worker.js');

const worker = new OrchestratorWorker('http://127.0.0.1:8090', 'worker-1');
await worker.register();
const task = await worker.claimNext();
if (task) await worker.complete(task.id, { status: 'succeeded' });
```

## Jules executor

```bash
npm run agentq -- enqueue \
  --repo /path/to/repo \
  --issue 42 \
  --model jules \
  --executor src/runners/jules-issue.js \
  --trusted

npm run agentq -- drain --verify 'npm test'
```

The executor creates a Jules session with `AUTO_CREATE_PR`, waits for completion,
and checks the PR branch into the agentq worktree so local verification still
applies. Always review Jules output before merging; remote agents can work from a
stale repository view.

Crash recovery and inspection:

```bash
npm run agentq -- jules-reconnect
npm run agentq -- jules-sessions
```

## Claude Code harness

A runnable with `"harness": "claude"` runs through Claude Code instead of pi, on
the Claude Pro subscription. `resolveExecutor` picks the executor from the
runnable's harness for the job's resolved model, so nothing about the queue
changes:

```bash
npm run agentq -- enqueue \
  --repo /path/to/repo \
  --issue 42 \
  --model claude/claude-sonnet-5-5 \
  --trusted

npm run agentq -- run-next --verify 'npm test'
```

An explicit executor still wins: `--executor` first, then an executor persisted
on the job; the harness only supplies the default. `--workflow`, feedback jobs
and `--cua` stay pi-only: a claude-harness model is refused for them before the
job is claimed. A runnable whose harness agentq cannot launch is refused the
same way rather than silently running on pi.

### Executor contract

`claude-issue.sh` is a sibling of `pi-issue.sh` with the identical contract:

```text
claude-issue.sh <issue-number> <provider/model> [--agentq-pinned-input]
```

The same pinned snapshot on stdin (`AGENTQ_PINNED_INPUT`,
`AGENTQ_INPUT_SHA256`), `AGENTQ_WORKTREE` reuse, `BASE_BRANCH`,
`AGENTQ_STOP_WHEN`, `AGENTQ_RESULT`, refusal to replace an existing branch, and
the same human-readable review block. It runs, in the job worktree and with the
prompt on stdin:

```text
claude -p --model <model> --output-format json --permission-mode acceptEdits [--max-turns N]
```

`<model>` is the runnable id without its `claude/` prefix. `AGENTQ_MAX_TURNS`
(a positive integer) sets `--max-turns`. The script never passes
`--dangerously-skip-permissions` or `bypassPermissions`.

### Permissions

Headless Claude Code cannot answer its own permission prompts, so an unanswered
prompt is a denial, not an approval. File edits are accepted
(`--permission-mode acceptEdits`). Every job also loads agentq's own settings
with `--settings config/defaults/claude-job-settings.json` (override with
`AGENTQ_CLAUDE_SETTINGS`; a missing or invalid file refuses the job with exit
`2`, it never runs without them):

- **allowed**: read-only and committing `git` (status, diff, log, show, add,
  commit, mv, rm, restore) and the usual test/lint/build commands (npm, node,
  just, pytest/uv, cargo, go);
- **denied**: `git push`/`remote`/`checkout`/`switch`/`reset`/`clean`/`rebase`/
  `worktree`/`config`, `gh`, `curl`/`wget`/`ssh`/`scp`, WebFetch/WebSearch,
  package installs and publishing, `npx -y`, `sudo`, `rm -rf`, and reads of
  `.env*` and credential directories (`~/.ssh`, `~/.aws`, `~/.gnupg`,
  `~/.config`, `~/.pi`, `~/dotfiles`, `~/.claude`).

The target repository's own `.claude/settings.json` still applies on top, but
deny rules win across sources, so a repository can allow more tools yet never
re-allow what agentq denies. Review both files like you review the sandbox
wrapper: an allowed `npm test` runs whatever the repository's test script says,
so an untrusted issue that rewrites that script runs code as you. That is what
the trust gate and `--sandbox` are for; a sandbox wrapper must let the executor
read the settings file. Trust is still decided by agentq, exactly as
for pi: the trust gate decides whether the job may run at all, and a `--sandbox`
wrapper receives `sandbox <executor> ...` unchanged (the claude executor is
passed through as the first argument, with the pi argument contract).

The SECURITY note at the bottom of `claude-issue.sh` applies: `acceptEdits` is a
permission mode, not a sandbox.

### Usage and session

The JSON result's `total_cost_usd`, `usage` and `session_id` are printed in the
same shape agentq already extracts for pi, so the job records cost, cache-aware
tokens and the session id:

```text
session : <session_id>
▶ usage: {"usage":{...}}
```

Cache tokens are mapped to the names the queue's usage normalizer reads, and the
record carries `provider: claude` plus the model Claude Code reports, so the ROI
pipeline attributes the spend to the `claudemax` quota path (funded by the
`claudepro2` subscription in `config/roi.config.json`). A result that reports
`is_error` is recorded as a failure even if the process exited 0. Claude Code
keeps its own transcripts under `~/.claude/projects`; the job stores the session
id, not a session file.

### Models

`config/runnables.json` declares `claude/claude-sonnet-5-5`,
`claude/claude-opus-5-5` and `claude/claude-haiku-5-5` on path `claudemax`.
They are **explicit-only**: `modelKey` is `null` until the ROI registry scores
the 5.5 models, so routing reports them as unscored and `--model auto` never
picks them (borrowing an older model's scores would misprice the choice).

To make them routable:

1. add the 5.5 models to the ROI registry so `$AGENTQ_HOME/data/roi-output.json` has a row per
   model (`npm run refresh`);
2. set the runnable's `modelKey` to that row's normalized key
   (`claude-sonnet-5-5`, see `src/lib/model-key.js`);
3. confirm with
   `npm run resolve-model -- --check claude/claude-sonnet-5-5 --json` that the
   entry is scored and its quota path has fresh capacity. Until step 2 it
   reports `"eligible": false, "reasons": ["unscored: no ROI score row"]`.

## Usage attribution

Agent session JSONL records include provider, model, token usage, and cost.
Completed jobs write their usage into the queue database's `usage_records`
table, which the ROI pipeline reads. Logs from pre-SQLite local runs can be
imported once into the same `--db`:

```bash
npm run agentq -- import-usage
```

This is the coupling between the two products: the ROI tracker measures which
paths deliver value, while agentq consumes the same quota and path policy for
routing future work.

## Before publishing

`node scripts/scan-personal.js --deny ~/agentq-denylist.txt` (or `AGENTQ_DENY_LIST=<file>`) scans every tracked file for the personal host names, accounts and home paths listed in that out-of-repo deny list and exits 1 printing `file:line` for each hit.

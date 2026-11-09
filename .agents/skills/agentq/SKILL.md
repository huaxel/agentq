---
name: agentq
description: Interact with the agentq repo — a capacity-aware coding-agent dispatcher (queue, routing, MCP server) backed by an AI subscription ROI tracker and a pi session cost-attribution scanner. Use when editing code, running the ROI pipeline, dispatching agent jobs, debugging the agent queue, resolving quota-aware models for subagents, or investigating pi session cost attribution.
metadata:
  version: 2.0
  repo: agentq
  pathMap: config/roi.config.json
  quotaData: data/quota.json
---

# agentq repo guide

## Table of Contents

- [Quick Reference](#quick-reference)
- [Repo Orientation](#repo-orientation)
- [Daily ROI Tracker](#daily-roi-tracker)
- [Quota-Aware Model Selection](#quota-aware-model-selection)
- [Pi Session & Cost Attribution](#pi-session--cost-attribution)
- [Agentq Workflow](#agentq-workflow)
- [Orchestrator Mode](#orchestrator-mode)
- [Jules Cloud Agent](#jules-cloud-agent)
- [Development Commands](#development-commands)
- [Data Files Reference](#data-files-reference)
- [Security Notes](#security-notes)
- [Common Agent Mistakes to Avoid](#common-agent-mistakes-to-avoid)

---

## Quick Reference

| When you want to… | Run this |
|---|---|
| Refresh the ROI dashboard (default daily) | `npm run refresh` |
| Force fresh usage + pipeline + render | `npm run refresh:fresh` |
| Enqueue a GitHub issue for agentq | `npm run agentq -- enqueue --repo . --issue <N> --model auto` |
| Drain the agentq queue | `npm run agentq -- drain --verify 'npm test'` |
| Inspect execution paths/models/quota facts without choosing | `node bin/capacity.js` — see `docs/capacity.md` |
| Check what model a legacy queue tier resolves to | `node src/lib/quota-resolver.js --tier medium --json` |
| Scan pi sessions for cost attribution | `node -e "console.log(JSON.stringify(require('./src/lib/pi-session-scanner.js').scanPiSessions('20250101', {...}), null, 2))"` |
| Update legacy subagent overrides (not Shepherdr) | `./bin/update-subagent-models.sh` |
| Update workflow model tiers (before drain) | `./bin/update-workflow-tiers.sh` |
| Run full CI before committing | `npm run ci` (or `just ci`) |
| Run golden-cell verification after scoring changes | `npm run verify` |

---

## Repo Orientation

This repo contains two tightly coupled subsystems:

1. **Subscription ROI tracker** — collects live model pricing, your actual usage, and benchmark scores into a self-contained HTML dashboard (`docs/roi-dashboard.html`).
2. **agentq / orchestrator** — a small autonomous-agent primitive that turns GitHub issues into sequential `pi` headless runs with durable logs, worktrees, and a quota-aware model picker.

### Layout

| Path | Purpose |
|---|---|
| `src/roi-tracker/` | Pipeline, scoring, rendering, and live-cost tracker |
| `src/core/` | Pure catalog, capacity, routing, admission and auto-model policy |
| `src/queue/` | SQLite task store, queue sources, worker client, Jules sync |
| `src/runners/` | Worktree prep, executors, result file, verification evidence |
| `src/interfaces/cli/` | CLI, menu and formatting |
| `src/interfaces/http/` | HTTP orchestrator server, routes and dashboard |
| `src/interfaces/mcp/` | stdio MCP server and tools |
| `src/lib/` | Shared helpers: model key normalization, config/validation, quota parsing, pi session scanner |
| `config/roi.config.json` | Single source of truth for scoring weights, path economics, provider/agent mappings |
| `data/` | Canonical JSON data files (gitignored outputs live here too) |
| `bin/` | Scripts for cron, tier updates, model resolution |
| `docs/` | Architecture docs and generated dashboard |

### Key stack

- **Runtime:** Node.js >= 22.5.0, plain `.js` (CommonJS) with `tsconfig.json` for type-checking
- **Task runner:** `npm run` is canonical; `just` provides thin aliases
- **Formatter/linter:** Biome (`npm run lint`)
- **Test runner:** Node built-in (`node:test`), run with `npm test`

---

## Daily ROI Tracker

The everyday command is:

```bash
npm run refresh
```

This collects usage if the local bundle is stale, refreshes pricing, runs the pipeline, and renders the dashboard.

| Command | When to use |
|---|---|
| `npm run refresh` | Default daily refresh |
| `npm run refresh:fresh` | Force usage collection now |
| `npm run refresh:quick` | Skip pricing and reuse a matching bundle for 60 min |
| `npm run pipeline` | Recompute scores from existing data files |
| `npm run render` | Regenerate `docs/roi-dashboard.html` from `data/roi-output.json` |
| `npm run export-csv` | Produce `data/ccagg-by-model.csv` and `data/ccagg-daily.csv` |

### Multi-machine usage

On each machine run:

```bash
npm run collect -- --tokscale --daily  # local bundle only
npm run collect:sync                    # explicit commit + push when wanted
npm run refresh -- --no-collect
```

The pipeline sums all `data/usage-imports/*.json` bundles. **Do not delete other hosts' bundles.** Git synchronization is off by default; only `--sync-git`, `collect:sync`, or `refresh:sync` may commit and push.

### Benchmark data

- `data/benchmark-inputs.json` is the maintained benchmark registry.
- An ignored root `ModelBenchmark_v4.xlsx` is an optional editing bridge for `npm run export`; it is not required to build.
- Formula logic lives in `config/roi.config.json` + `src/roi-tracker/score.js` and `values.js`.
- Golden fidelity runs automatically inside `npm run check` (`npm run verify` standalone also works).
- After deliberate registry edits (new/corrected benchmark rows), re-freeze the snapshot with `npm run golden:refresh`.

---

## Quota-Aware Model Selection

This is the infrastructure that maps abstract tiers (small/medium/big) to concrete provider/model IDs with rate-limit headroom. Used by agentq, pi subagents, and pi-dynamic-workflows.

### Tier map

| Tier | Typical use | Priority pool | Fallback pool |
|---|---|---|---|
| **small** | Quick analysis, grep, simple tasks | commandcode (deepseek-v4-flash, mimo-v2.5) + codex (gpt-5.6-terra) | explicit `--fallback`, else null |
| **medium** | Code review, moderate reasoning | commandcode (GLM-5.2, MiniMax-M3) + codex (gpt-5.6-luna) + cursor (composer-2.5) | explicit `--fallback`, else null |
| **big** | Complex synthesis, architecture | codex (luna/sol/terra) + commandcode (MiniMax-M3, GLM-5.2) + cursor (grok-4.5, composer-2.5) | explicit `--fallback`, else null |

See [references/MODEL-TIERS.md](references/MODEL-TIERS.md) for the full candidate list and rationale.

### CLI tools

```bash
# Check what model a tier resolves to
node src/lib/quota-resolver.js --tier medium
node src/lib/quota-resolver.js --tier medium --json

# Check if a specific model has headroom
node src/lib/quota-resolver.js --check "xai/grok-4.5" --json

# See all tiers at once
node src/lib/quota-resolver.js --all --json

# Resolve with a custom threshold
node src/lib/quota-resolver.js --tier small --threshold 90
```

### Agent-facing capacity versus legacy subagent configuration

`node bin/capacity.js` exposes observed machine/harness/subscription/model paths
and sanitized quota states for agent reasoning, without selecting, dispatching
or modifying profiles. Native auth/entitlements and remote machines stay unknown
until observed; shared bucket IDs are not independent capacity. See
[docs/capacity.md](../../../docs/capacity.md).

The scripts below are legacy integrations, not the capacity API. Installed
Shepherdr uses `shepherdr/profiles/*/profile.json`, not `subagents.agentOverrides`;
do not use `update-subagent-models.sh` to configure it.


Two scripts tie this into pi's settings:

```bash
# Update pi settings.json → subagents.agentOverrides
./bin/update-subagent-models.sh
# Then reload pi: /reload

# Update pi-dynamic-workflows model-tiers.json
./bin/update-workflow-tiers.sh
```

Role → tier mapping is fixed in `bin/update-subagent-models.sh`; concrete models
resolve from live quota at run time, so check `~/.pi/agent/settings.json` for
the current values rather than trusting a snapshot here:

| Agent role | Tier |
|---|---|
| `worker` | small |
| `disciplined-worker` | medium |
| `reviewer` | big |

### Manual model resolution for subagent spawns

```bash
# Before spawning subagents, resolve what's available
MODEL=$(node src/lib/quota-resolver.js --tier medium)
echo "Using: $MODEL"
```

Or use the skill helper:

```bash
./.agents/skills/agentq/scripts/resolve-model.sh medium
```

### Key files

| File | Role |
|---|---|
| `src/lib/quota-resolver.js` | CLI + module: resolves tiers through the routing core |
| `src/core/auto-model.js` | Shared `resolveAutoModel()` for `--model auto` |
| `src/core/snapshot.js` | Catalog + capacity + `recommend()` used by every interface |
| `config/runnables.json` | Runnable universe: model id → quota path |
| `data/quota.json` | Live quota headroom data (generated by `npm run collect-quota`) |
| `bin/update-subagent-models.sh` | Writes pi subagent overrides |
| `bin/update-workflow-tiers.sh` | Writes `~/.pi/workflows/model-tiers.json` |
| `bin/resolve-model.sh` | Shell-friendly wrapper around quota-resolver.js |

---

## Pi Session & Cost Attribution

The ROI pipeline attributes costs to subscription paths by reading **pi's session files** directly.

### How it works

Pi writes every assistant message to a JSONL session file in `~/.pi/agent/sessions/`. Each message includes:

- **provider** — the provider that served the response
- **model** — the model id
- **usage.cost** — pre-priced cost breakdown (input, output, cacheRead, cacheWrite, total)
- **timestamp** — ISO date used for daily aggregation

The scanner (`src/lib/pi-session-scanner.js`):

1. Walks `~/.pi/agent/sessions/` recursively for `.jsonl` files
2. Parses each line, extracting assistant messages with cost data
3. Filters to an inclusive date range (prunes old files via mtime for efficiency)
4. Normalizes provider names via `PROVIDER_ALIASES` (e.g. `opencode-go` → `opencodego`)
5. Maps each normalized provider → path ID using `config.roi.config.json[providerPathMap]`
6. Aggregates into per-path, per-provider, and per-model cost buckets

For zero-cost entries (Umans agreement pricing, free-tier models), it falls back to computing cost from token counts × list prices using `modelPriceAliases`.

### Reading session data

```js
const { scanPiSessions } = require('./src/lib/pi-session-scanner.js');

// All sessions since a date
const result = scanPiSessions('20260601', { umans: 'umans', opencodego: 'go' });
console.log(result.perPath);      // { umans: 33.12, go: 4.89, ... }
console.log(result.perProvider);  // { 'opencode-go': { total: 4.89, models: {...} } }
console.log(result.providerRecords); // per-message records with date/model/provider/cost/tokens
```

### Why this matters

The pi session scanner replaces the old `modelPathPatterns` approach. It's the **only** way to attribute costs by provider for pi usage — ccusage daily's `modelBreakdowns` drop the provider field entirely. Since 2026-08 it scans **all** pi stores (default `~/.pi/agent/sessions`, any `PI_CODING_AGENT_DIR/sessions`, and `~/.omp/agent/sessions`) — reading only one store silently undercounts by ~15× (see git history: firepass $0 → $2.4k).

Tokscale (`npm run collect-tokscale`, `VALUE_RUN_SOURCE=tokscale`) is an alternative provider-attribution source with the same per-provider view; its JSON has no per-day dates, so keep ccusage for daily-granular numbers.

### Raw session inspection

```bash
# Peek at a session file
tail -5 ~/.pi/agent/sessions/*/*.jsonl | head -20

# Extract cost data from all recent sessions
jq -r 'select(.type=="message" and .message.role=="assistant") | {timestamp: .timestamp, provider: .message.provider, model: .message.model, cost: .message.usage.cost.total}' ~/.pi/agent/sessions/*/*.jsonl

# Check what providers pi has used
jq -r 'select(.message.role=="assistant") | .message.provider' ~/.pi/agent/sessions/*/*.jsonl | sort -u
```

### Key files

| File | Role |
|---|---|
| `src/lib/pi-session-scanner.js` | Scanner + parser + aggregator |
| `test/pi-session-scanner.test.js` | Tests for pruning, provider records, safety windows |
| `docs/data-pipeline.md` | How pi sessions fit into the overall data pipeline |

---

## Agentq Workflow

### Local queue

```bash
# enqueue work (model can be concrete or 'auto')
npm run agentq -- enqueue --repo /path/to/repo --issue 304 --model auto

# run one ready job
npm run agentq -- run-next

# drain everything ready, with optional verification
npm run agentq -- drain --verify 'npm test'

# inspect the ledger
npm run agentq -- status

# rerun a failed/interrupted job, optionally with a different model
npm run agentq -- requeue --id 3f2a8c1e --model xai/grok-4.5

# clean up finished worktrees/branches
npm run agentq -- prune
```

### Advanced options

```bash
# Timeouts and cancellation
npm run agentq -- drain --timeout 3600            # 1 hour per job
npm run agentq -- cancel --id 3f2a8c1e            # kill a running job

# Parallel execution
npm run agentq -- drain --parallel 3               # run up to 3 jobs concurrently

# Webhook callbacks
npm run agentq -- enqueue --repo /path --issue 42 --callback-url https://hooks.slack.com/...

# Stop condition — natural-language objective check
npm run agentq -- drain --stop-when 'all tests pass'
```

### Usage tracking and sync

```bash
# Import legacy local usage.jsonl into the queue DB (one-shot)
npm run agentq -- import-usage

# Import a legacy JSONL event log (one-shot, idempotent)
npm run agentq -- import-log --log data/agentq.log
```

### Jules session management

```bash
# Reconnect to in-flight Jules sessions (after crash)
npm run agentq -- jules-reconnect

# List all tracked Jules sessions
npm run agentq -- jules-sessions
```

### Important conventions

- **The database is the queue.** `data/orchestrator.sqlite` (`--db`/`AGENTQ_DB`) is shared by local mode, the orchestrator, the dashboard and the MCP server. Read `tasks`/`task_events` with `sqlite3`; the old `data/agentq.log` is imported once with `import-log`.
- **Jobs default to untrusted.** Requires `--trusted`, `--sandbox <wrap>`, or `--allow-untrusted` at run time.
- **Worktrees are isolated.** Each git job runs in `data/worktrees/job-<task-id>/` on branch `agentq/job-<task-id>`.
- **`--model auto`** resolves at run time via `data/quota.json`. Cheapest model with headroom wins.
- **Task ids are UUIDs.** `--id` and `--depends-on` accept a full id or a unique prefix of at least 6 characters.
- **Dependencies** set via `--depends-on ID[,ID...]`. Blocked jobs skipped until prerequisites succeed.
- **Usage** is written to `usage_records` in the queue DB on completion.
- **Refusals are reported.** A job the worker may not run stays pending and `run-next` prints `job <id8>: <reason>` (exit 2, `refused` in `--json`); it is not an empty queue.
- **`prune` reclaims files only.** It removes finished worktrees/branches, records a `pruned` event, and never deletes task rows or usage.
- **Untrusted CLI enqueues carry `approval_required: 1`.** The local CLI may still run them; HTTP orchestrator workers may not claim them until approved.

### Headless pi wrappers

Two bash scripts run pi headless on GitHub issues in isolated worktrees:

| Script | Model argument | Workflow style |
|---|---|---|
| `pi-issue.sh <N> <provider/model>` | required | Single-shot prompt with stop-condition support |
| `pi-workflow.sh <N> <provider/model> [workflow]` | required | 3-phase workflow (analyze → implement → verify) via pi-dynamic-workflows |

Neither wrapper has a default model: a missing model is a usage error (exit 2),
so a dropped subscription is never spent silently. `agentq` always passes the
resolved model as the second argument.

Both capture session JSONL for cost tracking and support `AGENTQ_STOP_WHEN` for natural-language stop conditions. See [references/PIPELINE-DATA.md](references/PIPELINE-DATA.md) for how session data flows into ROI.

### Key files

| File | Role |
|---|---|
| `bin/agentq.js` | CLI entry point (implementation in `src/interfaces/cli/agentq.js`) |
| `src/runners/execute.js` | Job execution, worktree prep, model picking, verification |
| `src/queue/sources.js` | Local in-process SQLite source and orchestrator HTTP source |
| `src/interfaces/cli/menu.js` | Interactive readline menu |
| `pi-issue.sh` | Single-shot headless pi runner |
| `pi-workflow.sh` | 3-phase workflow pi runner |

---

## Orchestrator Mode

Start the orchestrator:

```bash
npm run orchestrator
# with auth:
AUTH_TOKEN=secret npm run orchestrator -- --host 127.0.0.1 --port 8090
```

Then point agentq at it:

```bash
AGENTQ_SOURCE=orchestrator AGENTQ_ORCHESTRATOR_URL=http://localhost:8090 npm run agentq -- status
```

### API endpoints

| Endpoint | Description |
|---|---|
| `GET /api/tasks` | List tasks (query: `status`, `limit`) |
| `PATCH /api/tasks/:id` | Update priority or prompt |
| `DELETE /api/tasks/:id` | Delete completed task |
| `POST /api/tasks/bulk/{approve,reject,delete}` | Bulk operations |
| `GET /api/tasks/export?format={csv,jsonl}` | Export tasks |
| `GET /api/events` | SSE event stream |
| `GET /api/jules-sessions` | List Jules sessions |
| `GET /api/jules-sessions/inflight` | List in-flight Jules sessions |

### Worker client

For agents that want to claim and report tasks programmatically:

```js
const { OrchestratorWorker } = require('./src/queue/worker.js');
const worker = new OrchestratorWorker('http://localhost:8090', 'my-agent');
await worker.register();
const task = await worker.claimNext();
// ... do work ...
await worker.complete(task.id, { status: 'succeeded' });
```

---

## Jules Cloud Agent

Dispatch to Jules (Google's cloud coding agent) instead of local pi:

```bash
npm run agentq -- enqueue --repo /path/to/repo --issue 304 --model jules --executor src/runners/jules-issue.js
npm run agentq -- drain --verify 'npm test'
```

Requirements: `JULES_API_KEY` env var, repo connected as a Jules source (GitHub app), `gh` CLI authenticated.

### Session states

| State | Meaning |
|---|---|
| `QUEUED` | Waiting to start |
| `PLANNING` | Analyzing the task |
| `IN_PROGRESS` | Working |
| `COMPLETED` / `SUCCEEDED` | Finished |
| `FAILED` | Failed |

---

## Development Commands

Before committing or claiming work is done, run local CI:

```bash
npm run ci         # lint + typecheck + test + build
# `just ci` is a thin alias; or run individually:
npm run lint       # Biome
npm run typecheck  # tsc --noEmit
npm test           # Node built-in test runner
npm run build      # Build dashboard (if applicable)
```

### Testing

- `npm test` covers config validation, model-key normalization, source merging, agentq execution, orchestrator HTTP, and ROI scoring.
- If you change `config/roi.config.json`, also run `npm run verify`.

### Code style

- Biome for formatting/linting (`npm run lint`)
- TypeScript for type-checking only (`npm run typecheck`); source files remain `.js` (CommonJS)

---

## Data Files Reference

| File | Purpose | Editable? |
|---|---|---|
| `config/roi.config.json` | Scoring weights, paths, provider/agent mappings, model aliases | Yes — run tests + verify after |
| `data/pricing.json` | Live list prices | No — generated |
| `data/usage-by-model.json` | Aggregated usage from ccusage | No — generated |
| `data/usage-imports/<host>.json` | Per-machine usage bundles | Generated, then intentionally tracked for private multi-machine sync |
| `data/quota.json` | Rate-limit / quota headroom | No — generated by `npm run collect-quota` |
| `data/value-run.json` | Per-path value run | No — generated |
| `data/benchmark-inputs.json` | Maintained benchmark registry | Yes — run tests + verify after scoring edits |
| `data/roi-output.json` | Canonical pipeline output | No — generated |
| `data/orchestrator.sqlite` | Agentq queue: tasks, events, usage (shared with the orchestrator) | No — use the CLI |

---

## Security Notes

- `agentq` and `pi-issue.sh` execute `pi` headless with full user rights. Treat issue bodies as **untrusted code**.
- Never commit `AUTH_TOKEN`, API keys, or `data/orchestrator.sqlite` (all gitignored by default).
- The Docker dashboard is read-only without auth and binds host loopback by default. Use `tailscale serve` rather than adding a public bind; set `REFRESH_TOKEN` for remote mutations.
- Jobs default to **untrusted** — do not casually bypass the trust gate.

---

## Common Agent Mistakes to Avoid

1. **Running `npm run agentq` without reading the trust/sandbox implications.** Jobs default untrusted; `run-next` refuses them unless `--allow-untrusted` or `--sandbox` is supplied.
2. **Deleting other hosts' `data/usage-imports/*.json` files.** The pipeline sums them.
3. **Editing `data/*.json` outputs by hand** (unless they're config files like `config/roi.config.json`).
4. **Treating `data/agentq.log` as the queue.** It is a legacy JSONL log; the queue is `data/orchestrator.sqlite`. Import once with `import-log`.
5. **Committing generated artifacts.** The dashboard (`docs/roi-dashboard.html`) and CSVs are built products.
6. **Confusing legacy overrides with Shepherdr.** Inspect `node bin/capacity.js` for current facts; do not rewrite Shepherdr profiles as a routing step.

---

## Need more detail?

- For ROI commands: `docs/roi-tracker.md`.
- For agentq commands: `docs/agentq.md`.
- For data architecture: `docs/data-pipeline.md` and [references/PIPELINE-DATA.md](references/PIPELINE-DATA.md).
- For scoring formulas: `src/roi-tracker/score.js`, `src/roi-tracker/economics.js`, and `config/roi.config.json`.
- For agentq internals: `src/runners/execute.js` and `src/queue/sources.js`.
- For model tiers: [references/MODEL-TIERS.md](references/MODEL-TIERS.md).

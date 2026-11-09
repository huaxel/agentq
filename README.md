# agentq

A local-first, capacity-aware dispatcher for coding agents. It knows which
models you can run through which subscription, how capable and expensive each
one is, how much quota each subscription has left right now, and which tasks
are open, and it uses that to pick a model for each job and run it through
`pi` with durable logs, verification gates, and isolated worktrees.

Agents can ask it directly over MCP (`bin/agentq-mcp.js`, see
[docs/mcp.md](docs/mcp.md)): capacity, model rankings, recommendations, and the
task queue, with write tools behind an explicit opt-in and human approval.

The subscription ROI tracker is the data source behind it: it turns local
usage, subscription fees, quota windows, pricing, and benchmark data into
scores, a keep/review/cancel dashboard, and the quota snapshot routing reads.

The repository holds only code, the method's defaults and examples. Everything
personal — subscriptions and fees, path maps, usage, quota, prices, snapshots and
the queue — lives in a per-user directory outside the checkout (see Setup).

## Setup

Runtime data comes from `AGENTQ_HOME`, never from the checkout:

```bash
export AGENTQ_HOME="$HOME/.config/agentq"   # the default when unset
agentq home init                            # create config/ + data/, seed the example setup
agentq home                                 # print the resolved home and which config files exist
```

Without `AGENTQ_HOME` the home is `${XDG_CONFIG_HOME:-~/.config}/agentq`.

| Location | Holds |
| --- | --- |
| `$AGENTQ_HOME/config/roi.config.json` | your subscriptions, fees, path maps, aliases (merged over the method defaults) |
| `$AGENTQ_HOME/config/runnables.json` | the model paths you can actually run |
| `$AGENTQ_HOME/config/execution-paths.json` | machine/harness inventory |
| `$AGENTQ_HOME/data/` | usage, quota, prices, snapshots, CSVs, the dashboard and the SQLite queue |
| `config/defaults/` | the method: score weights, tier thresholds, Claude job permissions |
| `examples/home/config/` | fictional setup copied by `agentq home init` |

`agentq home init` never overwrites an existing file; pass `--force` to replace
it with the example. Every runtime path can still be overridden explicitly
(`AGENTQ_DB`, `AGENTQ_QUOTA`, `AGENTQ_ROI_CONFIG`, `AGENTQ_ROI_OUTPUT`, …), and
those overrides win over the home.

## Start here

**Requirements:** Node.js 22.5+, npm, and git. The recommended collector uses
[tokscale](https://github.com/junhoyeo/tokscale) through its local command or an
`npx` fallback; the legacy ccusage-compatible path remains available by
omitting `--tokscale`. `agentq` additionally expects `gh` and `pi`.

```bash
npm ci
npm run check
```

### Build the ROI dashboard

```bash
# Collect this machine, fetch pricing/quota, score, and render.
# This does NOT commit or push anything.
npm run refresh -- --tokscale --daily

xdg-open "${AGENTQ_HOME:-${XDG_CONFIG_HOME:-$HOME/.config}/agentq}/data/roi-dashboard.html"
# or print the compact terminal roll-up
npm run tracker
```

Useful variants:

```bash
npm run refresh:quick                   # reuse recent local data
npm run refresh -- --no-collect         # score/render only
npm run refresh -- --help               # all options
npm run export-csv                      # spreadsheet-friendly exports
```

For intentional multi-machine synchronization, review the generated bundle and
opt in explicitly:

```bash
npm run refresh:sync -- --tokscale --daily
# equivalent collector-only shortcut:
npm run collect:sync
```

Git synchronization is **off by default**. Only `--sync-git`,
`refresh:sync`, or `collect:sync` can commit and push a host bundle.

### Run the agent queue

```bash
npm run agentq                          # interactive terminal menu

# Scriptable flow for an issue you trust
npm run agentq -- enqueue --repo /path/to/repo --issue 42 --model auto --trusted
npm run agentq -- drain --verify 'npm test'
npm run agentq -- status
```

The queue is one SQLite database (`$AGENTQ_HOME/data/orchestrator.sqlite`),
shared with the orchestrator, dashboard and MCP server. Task ids are UUIDs;
`--id` accepts a unique prefix. A legacy `data/agentq.log` can be imported with
`npm run agentq -- import-log --log data/agentq.log`.

`--model auto` is routed at execution time from `config/runnables.json`, ROI
scores, and quota freshness (`--tier small|medium|big`, default `medium`).
Unknown or stale quota never counts as available, and an unroutable `auto` job
fails with its rejection reasons instead of falling back. Git jobs run in
per-job worktrees and remain available for review. Issue text is untrusted code,
so bare execution requires an explicit trust decision; use `--sandbox` for
untrusted work.

See **[docs/agentq.md](docs/agentq.md)** for dependencies, retries, verification,
the orchestrator, and Jules execution.

## What is useful today

| Capability | Command | Output |
| --- | --- | --- |
| Subscription keep/review/cancel roll-up | `npm run refresh` | `$AGENTQ_HOME/data/roi-dashboard.html` |
| Compact terminal ROI view | `npm run tracker` | stdout |
| Model/path/daily exports | `npm run export-csv` | `$AGENTQ_HOME/data/ccagg-*.csv` |
| Quota-aware model choice | `npm run resolve-model -- --tier medium` | provider/model id |
| Local autonomous issue queue | `npm run agentq` | `$AGENTQ_HOME/data/orchestrator.sqlite` + worktrees |
| HTTP task orchestrator | `npm run orchestrator` | `http://127.0.0.1:8090` |
| Dashboard viewer container | `docker compose up -d --build` | `http://127.0.0.1:8088` |

## How the pieces fit

```text
local sessions + tokscale/ccusage ─┐
subscription fees + quota windows ─┼─> ROI pipeline ─> HTML + CSV + alerts
pricing + benchmark inputs ────────┘          │
                                             └─> quota/model routing ─> agentq
```

| Path | Responsibility |
| --- | --- |
| `src/roi-tracker/` | collection, economics, scoring, rendering, serving |
| `src/core/` | routing policy: catalog, capacity, routing, admission, AA estimates |
| `src/queue/` | SQLite task store, local and HTTP queue sources |
| `src/runners/` | worktrees, executors, result files, verification |
| `src/interfaces/` | CLI and menu (`cli/`), HTTP orchestrator and dashboard (`http/`), MCP server (`mcp/`) |
| `src/lib/` | model normalization, quota resolution, session scanners, shared helpers |
| `config/defaults/` | the method: score weights, partition maps, tier thresholds, Claude job permissions |
| `examples/home/config/` | fictional setup `agentq home init` copies |
| `$AGENTQ_HOME/config/` | your setup: subscriptions, fees, provider mappings, aliases, runnables |
| `$AGENTQ_HOME/data/` | benchmark registry, per-machine usage bundles, quota, prices, snapshots, queue |

The implementation is plain CommonJS on Node 22. Runtime modules avoid external
packages; development installs Biome, TypeScript, and a pinned `pi` CLI.

## Documentation

- [ROI tracker and data collection](docs/roi-tracker.md)
- [agentq, orchestrator, and Jules](docs/agentq.md)
- [Data pipeline design and source caveats](docs/data-pipeline.md)
- [Model tier policy](.agents/skills/agentq/references/MODEL-TIERS.md)

## Architecture

| Layer | Path | Responsibility |
| --- | --- | --- |
| Core | `src/core/` | catalog (runnables x ROI scores, AA estimates), capacity (quota freshness), routing, auto-model, admission, issue input |
| Queue | `src/queue/` | SQLite task store shared by the CLI, orchestrator and MCP server |
| Interfaces | `src/interfaces/mcp/`, `src/interfaces/cli/` (`bin/agentq.js`), `src/interfaces/http/` | MCP server, CLI/menu, HTTP orchestrator |
| Runners | `src/runners/execute.js`, `pi-issue.sh`, `claude-issue.sh`, `pi-workflow.sh` | worktrees, executors (pi / Claude Code), verification |
| Data sources | `src/roi-tracker/`, `src/lib/` scanners/collectors | usage, quota, pricing, scoring, dashboard |

Dependencies only point down: `src/core/**` never imports the queue, runner,
interface or ROI layers, interfaces never import each other, and the ROI
tracker never reaches core (`test/layering.test.js` enforces it).
`$AGENTQ_HOME/config/runnables.json` lists what can be dispatched; routing only
considers a runnable whose subscription in `$AGENTQ_HOME/config/roi.config.json`
is active and whose quota data is fresh.

Tests use synthetic fixtures under `testdata/home/`; real configuration and
usage remain in `AGENTQ_HOME` and are not part of the repository.

## Development

```bash
npm run check        # lint + type-check + tests
npm run ci           # check + build dashboard/CSVs
npm run verify       # verify the user's AGENTQ_HOME after scoring changes
npm run verify:fixtures # check the synthetic golden regression in testdata/home

# Optional aliases
just ci
make help
```

The full CI gate runs on every push and pull request. Generated dashboards,
CSVs, quota snapshots, SQLite databases, and queue logs are ignored.

## Safety boundaries

- Keep the repository private unless usage bundles are removed from history.
- Collection stays local unless `--sync-git` is explicit.
- `agentq` treats issue bodies as executable, untrusted input.
- The Docker viewer binds to loopback. Use `tailscale serve --bg 8088` rather
  than exposing the unauthenticated read view directly.
- Set `AUTH_TOKEN` for a non-local orchestrator and `REFRESH_TOKEN` for remote
  dashboard mutations. Orchestrator CORS is off by default; if a separate web
  origin must call it, list exact origins in `AGENTQ_CORS_ALLOWED_ORIGINS`
  (comma-separated).

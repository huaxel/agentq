# Pipeline Data Flow — How Pi Sessions Feed the ROI Dashboard

This document traces the journey of cost/usage data from pi session files through to the rendered ROI dashboard.

## Overview

```
┌─────────────────────┐     ┌──────────────┐     ┌──────────────────┐     ┌──────────────────┐
│  Data Sources       │     │  Normalize   │     │   Aggregate      │     │    Render        │
│                     │     │              │     │                  │     │                  │
│ ~/.pi/agent/sessions│ ──► │  pi-session  │ ──► │  pipeline.js     │ ──► │  render-html.js  │
│   *.jsonl           │     │  -scanner.js │     │  score.js        │     │  → ROI dashboard │
│                     │     │              │     │  economics.js    │     │                  │
│ ccusage daily --json│ ──► │  collect-    │ ──► │  values.js       │     │                  │
│                     │     │  usage.js    │     │                  │     │                  │
│ codexbar            │ ──► │  collect-    │     │                  │     │                  │
│                     │     │  quota.js    │     │                  │     │                  │
│ benchmark-inputs    │ ──► │  model-key   │ ──► │                  │     │                  │
│   .json             │     │  + config    │     │                  │     │                  │
└─────────────────────┘     └──────────────┘     └──────────────────┘     └──────────────────┘
```

## Stage 1: Sources

### Pi Sessions (the primary pi cost source)

**Location:** `~/.pi/agent/sessions/*/*.jsonl`

**Format:** Append-only JSONL with one entry per message turn.

Key fields in each assistant-message line:

```json
{
  "type": "message",
  "timestamp": "2026-06-28T12:00:00.000Z",
  "message": {
    "role": "assistant",
    "provider": "opencode-go",
    "model": "deepseek-v4-flash",
    "usage": {
      "cost": {
        "input": 0.00123,
        "output": 0.00456,
        "cacheRead": 0.00078,
        "cacheWrite": 0.00012,
        "total": 0.00669
      },
      "input": 1234,
      "output": 5678,
      "cacheRead": 789,
      "cacheWrite": 123,
      "totalTokens": 7824
    }
  }
}
```

**How the scanner works** (`src/lib/pi-session-scanner.js`):

1. Walks **all pi session stores** recursively for `.jsonl` files — default `~/.pi/agent/sessions`, `PI_CODING_AGENT_DIR/sessions` (e.g. a dotfiles checkout), and `~/.omp/agent/sessions` (deduped; `defaultSessionDirs()`). Single-store scanning silently undercounts by ~15×.
2. Skips files older than the `since` date (minus a 24h safety window) via mtime
3. Parses each line — only processes `type: "message"` with `role: "assistant"`
4. Normalizes provider names via `PROVIDER_ALIASES`:
   - `opencode-go` → `opencodego`
   - `opencode` → `opencodego`
   - `openai-codex` → `codex`
   - (self-hosted providers need no alias — map them to `local` in `providerPathMap`)
5. Maps each normalized provider → path ID via `config/roi.config.json.providerPathMap`
6. For zero-cost entries (Umans, free tiers), computes cost from token counts × list prices using `modelPriceAliases`

**Key insight:** Pi sessions record the provider per message; ccusage's `modelBreakdowns` drop it. Tokscale is a second provider-aware source: aggregate mode has no dates, while `--daily` graph mode preserves them.

### ccusage (all-agent aggregate)

```
npm run collect-usage
# → data/usage-by-model.json
```

Aggregates across ALL agents (pi, Claude Code, Cline, etc.) but lacks per-provider attribution. Cost is shared across agents in a row and can't be split.

### codexbar (quota headroom)

```
npm run collect-quota
# → data/quota.json
```

Per-provider rate-limit windows with `usedPercent` and `resetsAt`. Used by the quota-aware model resolver.

### Benchmark data (model quality)

`data/benchmark-inputs.json` is the maintained registry of coding, agent, general, and scientific benchmark fields. An ignored root `ModelBenchmark_v4.xlsx` can optionally regenerate it through `npm run export`, but the spreadsheet is not required for normal builds.

## Stage 2: Normalize

The `normalize` stage unifies model IDs across all sources. A single model may appear as:

- `deepseek-v4-flash` (in pi sessions)
- `opencode-go/deepseek-v4-flash` (in ccusage)
- `deepseek/deepseek-v4-flash` (in pricing data)

**Key file:** `src/lib/model-key.js` — model id normalization; critical because pricing, usage, and benchmarks key on the same id.

## Stage 3: Aggregate (pipeline.js)

The pipeline (`src/roi-tracker/pipeline.js`) produces `data/roi-output.json`:

1. **per-path cost** — summed from pi sessions + ccusage, routed through `providerPathMap`
2. **quality score** — profile-weighted capability index from benchmark data
3. **path economics** — effective multiplier, ROI, value (comparing value extracted vs subscription cost)
4. **status** — green/yellow/red based on utilization and budget

### Scoring

- `score.js` — profile-weighted capability index across coding, agents, general, scientific
- `economics.js` — path ROI / effective multiplier computation
- `values.js` — PERF vs COST tradeoff

### Config

`config/roi.config.json` is the single source of truth:

- `providerPathMap` — normalized provider → path ID
- `modelPriceAliases` — model variant → canonical pricing key
- `profiles` — Tax/Hobby usage profiles with per-category weights
- `tierThresholds` — frontier/high/mid quality cutoffs
- `paths` — subscription details (fee, allowance, quota windows)

## Stage 4: Render

```
npm run render
# → docs/roi-dashboard.html
```

`src/roi-tracker/render-html.js` takes `data/roi-output.json` and produces a self-contained HTML dashboard.

## Common Commands by Layer

| Layer | Command | What it does |
|---|---|---|
| **All** | `npm run refresh` | Collect (if stale) + pipeline + render |
| **Fresh** | `npm run refresh:fresh` | Force everything from scratch |
| **Sources only** | `npm run collect` | Write machine usage bundle |
| **Pipeline only** | `npm run pipeline` | Recompute from existing data files |
| **Render only** | `npm run render` | Regenerate HTML from pipeline output |
| **Quota** | `npm run collect-quota` | Refresh headroom data |
| **Verify** | `npm run verify` | Check JS scoring matches xlsx golden cells |

## Attribution Pipeline Detail

How a single pi assistant message ends up in the dashboard:

```
1. pi writes message → ~/.pi/agent/sessions/.../session.jsonl
2. pi-session-scanner.js reads it
   ├─ extracts provider ("opencode-go")
   ├─ normalizes via PROVIDER_ALIASES → "opencodego"
   ├─ maps via providerPathMap → path "go"
   └─ records cost ($0.00669) under path "go"
3. pipeline.js sums all "go" costs across all sessions
4. economics.js computes ROI: value / subscription fee
5. render-html.js draws the "go" row in the dashboard
```

## Relevant Files

| File | Role |
|---|---|
| `src/lib/pi-session-scanner.js` | Pi session parser + aggregator |
| `src/lib/model-key.js` | Model ID normalization |
| `src/lib/model-picker.js` | Shared quota-aware picker |
| `src/roi-tracker/pipeline.js` | Top-level scoring pipeline |
| `src/roi-tracker/score.js` | Quality scoring |
| `src/roi-tracker/economics.js` | ROI / effective multiplier |
| `src/roi-tracker/render-html.js` | Dashboard HTML generation |
| `config/roi.config.json` | Scoring weights, provider→path map, pricing aliases |
| `docs/data-pipeline.md` | Original architecture design doc |

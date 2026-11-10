# ROI tracker

The tracker estimates the value extracted from each AI access path and compares
it with actual fees and quota use. It produces:

- a keep/review/cancel subscription roll-up;
- model rankings under tax and hobby weighting profiles;
- per-path economics and data-quality warnings;
- a self-contained HTML dashboard and CSV exports.

## Daily workflow

```bash
npm ci
npm run refresh -- --tokscale --daily
xdg-open "${AGENTQ_HOME:-${XDG_CONFIG_HOME:-$HOME/.config}/agentq}/data/roi-dashboard.html"
```

`refresh` runs four stages:

1. fetch live pricing and available quota data;
2. collect this machine's usage bundle;
3. compute path economics and model scores;
4. render `$AGENTQ_HOME/data/roi-dashboard.html`.

Collectors fail soft where possible. Missing optional provider tools leave a
warning and preserve the last local data instead of destroying a useful build.

### Refresh options

```bash
npm run refresh -- --help

npm run refresh:quick                    # offline price mode, 60-minute cache
npm run refresh:fresh                    # bypass the usage-bundle cache
npm run refresh -- --no-collect          # existing data -> score -> render
npm run refresh -- --since 2026-08-01    # explicit window start
npm run refresh -- --strict              # non-zero when active wallets are underwater
```

The default window start (used when `--since` is absent) comes from the
`ROI_SINCE` environment variable; without it, the configured private-history
start applies.

The default npm command uses the ccusage-compatible collection path unless
`--tokscale` is supplied. The recommended full-fidelity path is:

```bash
npm run refresh -- --tokscale --daily
```

The `--daily` graph records preserve dates for window filtering and daily CSVs.
Aggregate tokscale mode still provides provider attribution but cannot recover
per-day history from its JSON output.

## Safe collection and multi-machine sync

Every machine writes only its own bundle:

```text
data/usage-imports/<hostname>.json
```

The pipeline sums those bundles. Different hostnames avoid normal git conflicts,
and duplicate pi session IDs are filtered by the session scanner.

Collection is local-only by default:

```bash
npm run collect -- --tokscale --daily
# or the thin alias
just collect
```

After inspecting the generated bundle, explicitly synchronize it:

```bash
npm run collect:sync
# or the thin alias
just collect-sync
```

`--sync-git` stages only that host's bundle, commits it, integrates remote
changes, and pushes. `--no-git` remains accepted for old scripts but is no
longer necessary. Do not delete another host's bundle.

Cloud/web-only sessions cannot be read from local logs. For flat subscriptions,
quota percentage is therefore an account-wide signal while local dollar value
is a lower bound.

## Inputs and source precedence

| Input | Purpose | Notes |
| --- | --- | --- |
| pi session JSONL | message-level provider, model, tokens, embedded cost | authoritative for pi usage |
| tokscale | cross-client provider/model usage | recommended collector |
| ccusage | dated model/agent usage | legacy/fallback collector; overlaps pi |
| codexbar and provider APIs | quota windows | coverage varies by provider |
| OpenRouter/OpenCode | list pricing | fetched live, cached locally |
| `$AGENTQ_HOME/data/benchmark-inputs.json` | quality and price registry | private user-maintained input |
| `$AGENTQ_HOME/config/roi.config.json` | paths, fees, model coverage, aliases | editable setup |
| `config/defaults/roi.json` | score weights, thresholds, partition maps | tracked method |

The pipeline avoids known overlaps:

- pi-native rows are not added again from ccusage;
- tokscale bundles use one authoritative scan rather than summing tokscale and
  ccusage totals;
- provider-attributed records take precedence over weaker model-name guesses;
- model IDs pass through `src/lib/model-key.js` before joins.

See [data-pipeline.md](data-pipeline.md) for source caveats and attribution
rationale.

## Path coverage

Which subscription serves which model is a fact about your setup, so each
`config.paths[]` entry declares it in `models`: an array of model keys,
normalized with `src/lib/model-key.js` (so `openrouter/anthropic/claude-opus-4.8`
and `claude-opus-4-8` are the same key). The single entry `"*"` means every
model in the registry and is the right answer for a metered pay-per-token path
such as OpenRouter; there is no other wildcard, and a missing or empty `models`
means the path covers nothing. The registry holds only facts about a model
(prices, benchmarks), so adding a subscription is one config entry instead of a
new column on every registry row.

A runnable's `path` is a quota path id, which a config entry can fund through
`sourcePath` (a newer plan for the same quota path). Coverage is therefore the
union over every entry funding that path, so `gosingle` (`sourcePath: "go"`)
covers a runnable on `go` even when the older `go` entry's model list is stale.

Coverage is not the same as `config/runnables.json`. Coverage says "this path
offers the model"; a runnable says "I have wired this model for dispatch on this
path". Scoring needs coverage, so a covered model can be scored without being
runnable, but a runnable on a path that does not cover its `modelKey` is a setup
mistake: `npm run verify` fails with `runnable <id>: path <path> does not cover
<modelKey>` (routing warns about it instead of refusing to pick). A `models`
entry the registry does not have is only a warning, since the registry can lag a
new subscription.

```json
{
  "id": "openrouter",
  "type": "Metered",
  "fee": 0,
  "models": ["*"]
}
```

Optional `quotaWindows` on a `config.paths[]` entry decides how that path's
quota windows combine into one headroom figure (see
[agentq.md](agentq.md#quota-windows)): `"all"` (the default) makes every window
bind and takes the smallest headroom, which is what a provider enforcing a
5-hour and a weekly limit at once requires; `"any"` takes the largest, for
separate sub-accounts or model groups that fail over. Any other value is a
validation error.

A home that still carries the old per-subscription registry columns (`onLocal`,
`onGo`, `onCodex`, `onClaudeMax`, `onOpenRouter`, …) and `paths[].availKey` is
converted once with:

```bash
node scripts/migrate-path-coverage.js --home "$AGENTQ_HOME"            # dry run
node scripts/migrate-path-coverage.js --home "$AGENTQ_HOME" --write    # apply
```

The script turns each `availKey` column into that path's `models` (a column set
for every registry row becomes `["*"]`), then removes `availKey` and every `on*`
column. A registry row that still has an `on*` column is ignored without an
error, so a half-migrated home still scores.

## Economics

For each configured access path, the pipeline computes:

```text
value run     = list-price value of observed usage
covered       = min(value run, allowance) for capped paths
ROI           = monthly covered value / effective monthly fee
effective cost multiplier = fee / covered value
```

Wallet charges can be recurring, bounded by start/end dates, or represented as
actual payments. Canceled paths stay in history but are excluded from current
keep/review/cancel totals.

The quality plane is independent: benchmarks produce a capability score, then
path economics adjust the cost penalty for each model. This is why a flat-rate
model with remaining quota can rank above the same model on a metered path.

## Outputs

| File | Description | Tracked? |
| --- | --- | --- |
| `$AGENTQ_HOME/data/roi-output.json` | canonical pipeline result | no |
| `$AGENTQ_HOME/data/roi-dashboard.html` | self-contained dashboard | no |
| `$AGENTQ_HOME/data/ccagg-by-model.csv` | model aggregate | no |
| `$AGENTQ_HOME/data/ccagg-by-model-path.csv` | model/path aggregate | no |
| `$AGENTQ_HOME/data/ccagg-daily.csv` | dated usage | no |
| `$AGENTQ_HOME/data/snapshots/<date>.json` | local trend history | no |
| `$AGENTQ_HOME/data/aa-snapshot.json` | optional local Artificial Analysis catalog (Free tier) | no |
| `$AGENTQ_HOME/data/aa-snapshot-pro.json` | optional local Artificial Analysis catalog (Pro tier) | no |
| `$AGENTQ_HOME/data/usage-imports/<host>.json` | private cross-machine source bundle | no |

Run the stages independently when debugging:

```bash
npm run collect-pricing
npm run collect-quota
npm run pipeline
npm run render
npm run export-csv
```

## Benchmark maintenance

`$AGENTQ_HOME/data/benchmark-inputs.json` and
`$AGENTQ_HOME/data/values-inputs.json` are private user-maintained inputs.
`testdata/home/` contains fictional test data only. The repository ships the
Artificial Analysis connector, not Artificial Analysis data. `src/roi-tracker/score.js`
and `values.js` are the formula source of truth.

An optional root-level `ModelBenchmark_v4.xlsx` can still be used as an editing
surface:

```bash
npm run export
npm run verify
```

The spreadsheet is intentionally ignored and is not required to build the
project. Save it in Excel or LibreOffice before export so formula cells have
cached values. `npm run verify` checks the JavaScript formula port against the golden snapshot
in the user's `AGENTQ_HOME` — it scores the golden's frozen model subset, so
adding new models to the registry does not invalidate the check. CI uses the
fictional fixture home via `npm run verify:fixtures`.

After a deliberate registry edit (new model rows, corrected benchmark values),
re-freeze the snapshot with:

```bash
npm run golden:refresh
```

For local user data, this regenerates `$AGENTQ_HOME/data/golden.json` from the
current inputs and immediately re-verifies it. To refresh the fictional test
golden, run `npm run fixtures:golden`.

Models still waiting on data, with the research already done on each, are
catalogued in [benchmark-backlog.md](benchmark-backlog.md).

### Artificial Analysis snapshots and score proposals

Registry rows can be filled from a recorded Artificial Analysis catalog instead
of the spreadsheet bridge:

```bash
npm run aa-sync                 # Free endpoint -> $AGENTQ_HOME/data/aa-snapshot.json
npm run aa-sync -- --pro        # Pro endpoint  -> $AGENTQ_HOME/data/aa-snapshot-pro.json
npm run aa-propose              # proposals for runnables that cannot score yet
npm run aa-propose -- --models grok-4-6 --json
npm run aa-propose -- --write   # fill nulls / add rows, then:
npm run pipeline && npm run verify
npm run aa-propose -- --prices  # registry price drift against AA (report only)
```

Each tier writes its own snapshot, because the two bodies answer different
questions and must never be confused: the Free body carries the headline
indices, prices and median performance, the Pro body adds per-benchmark
evaluations. `aa-propose` reads the Pro snapshot when it exists and the Free one
otherwise, and says which tier it used and which fields are missing because of
that tier.

The key comes from `AA_API_KEY`, otherwise
`${XDG_CONFIG_HOME:-~/.config}/agentq/aa-api-key`. The key file must be a
regular file owned by the current uid with mode exactly 0600; it is opened with
`O_NOFOLLOW` and read through the descriptor, so a symlink, a swapped path or a
group-readable file is refused instead of used. The collector never logs the
key, and without one it fails before any request.

#### What is importer parity, and what is not

`aa-propose` reproduces exactly the mapping the sheet importer
(`gscripts/model-catalogs.gs`, the `AA_fetch` columns) and the xlsx exporter
already perform: `aaSlug`, `intRef`, `aaCoding`, `aaAgentic`, `cachePrice`,
`inputPrice`, `outputPrice`, `speed`. That is the whole parity set.

The Pro per-benchmark evaluations (`terminalBench`, `sciCode`, `aaLcr`, `hle`,
`gpqa`, `critPt`) are **not** importer parity: the importer exports no such
column, so neither the AA field names nor their scale are verified against the
registry. They are refused by default and only proposed with
`--include-benchmarks`, which prints an `UNVERIFIED mapping` warning per field.
Treat those values as a research aid to check by hand, not as imported data.

Fields that [benchmark-backlog.md](benchmark-backlog.md) marks unsafe (`gdpval`,
`tau3Banking`, `apexAgents`) plus the ambiguous `aaOmni` column are never
filled, whatever the flags say.

#### Identity and writing

Matching is strict, because a wrong model is worse than no proposal:

- a registry row's `aaSlug` pins the match to that exact slug and nothing else;
- otherwise an exact slug match for the model key wins;
- a match that only folds (a `-preview`/`-thinking`/date suffix, a
  parenthetical qualifier, or a display-name fallback) is reported as
  `FOLDED MATCH` and is **not** written unless `--confirm-match <modelKey>`
  names it;
- a tie, or a `model_creator` that disagrees with the model's provider, is a
  rejection with a reason, never a guess.

`--write` fills null fields only: an existing value always wins. A new row is
named `<creator>/<AA slug>` from the AA record, never after a runnable id, and
is skipped when the AA row has no creator or slug. `config/runnables.json` is
never edited — the `modelKey` updates to make are printed instead, including for
models whose row needed no new values.

A Free snapshot cannot complete a model by itself: the four scoring partitions
need the Pro per-benchmark evaluations, and the agents partition has no safe AA
source at all. `intRef` is proposed with the snapshot's Intelligence Index
version because the registry has no version column.

#### Price drift

`cachePrice`/`inputPrice`/`outputPrice` drive `mtok`, and `mtok` drives routing
order for every scored model, but `--write` never replaces a non-null price. A
registry price that has gone stale is therefore invisible. The `--prices` mode
compares the two sides instead of proposing:

```bash
npm run aa-propose -- --prices                         # human table
npm run aa-propose -- --prices --json                  # same report as JSON
npm run aa-propose -- --prices --drift-k 3             # wider tolerance
npm run aa-propose -- --prices --write --confirm-price gpt-5-6-luna
npm run pipeline && npm run verify
```

The report covers every registry row with an **exact** AA identity: an `aaSlug`
pin, otherwise an exact slug match. That is the same strict rule `--write` uses,
so a folded match (a `-preview`/`-thinking`/date suffix, a parenthetical
qualifier, a display name) is out of scope and is printed in its own list
rather than compared. Both sides are blended with `blendMtok` from
`src/lib/aa-pricing.js` and the `costBlend` weights in `config/defaults/roi.json`,
exactly as `score.js` prices a model, and the per-component ratios are printed
alongside the blended one. A row is **flagged** when the blended registry/AA
ratio falls outside `[1/k, k]`, with `k` from `--drift-k` (default 2).

Unknown prices are not compared. `0` and a missing value both mean unknown on
either side, with one asymmetry that mirrors the pipeline. A null registry
cache price is compared as `score.js` scores it: cached tokens count as free
(`blendMtok` blends a null as 0), and the row carries the note
`registry cache null: scored as free` instead of hiding the gap. A null AA
cache price instead falls back to the AA input price, the same substitution the
AA estimate pricing makes. Unknown rows are listed separately with the reason
instead of being flagged. The table is sorted by
absolute log ratio, so the worst drift comes first, and the exit code is 0 even
when rows are flagged: this is a report, and the pipeline gate must not fail
because a provider moved a list price.

There is no automatic overwrite, by design. AA publishes one median list price
for a model across providers, while a registry row may intentionally carry the
price of the specific provider this machine is billed by (a discounted tier, an
enterprise rate, a subscription-included path). Rewriting the columns on every
snapshot would replace a provider-specific price with a different provider's
list price, which changes `mtok` and therefore the routing order of every
scored model. So a fix is opt-in and per row: `--write --confirm-price k1,k2`
rewrites the three price columns only for the named rows, and only when they
are flagged. Naming an unflagged, not-comparable or unmatched row is an error,
and `--write` without `--confirm-price` is refused, so there is no bulk
overwrite. A null AA cache price is written as the AA input price, the value
those tokens are billed at, so the row afterwards blends to the AA blend the
report showed; the next step is the usual `npm run pipeline && npm run verify`.

### Intelligence estimates for unscored runnables

A runnable the registry cannot score is not invisible to routing. When the AA
snapshot carries an exact row for it, `src/core/aa-estimate.js` supplies an
intelligence **estimate** from the AA Intelligence Index, and the catalog marks
it: `intelligenceSource: 'aa-estimate'`, the `aaIndex` it came from, and the
`calibration` behind it. A real ROI score always wins and keeps
`intelligenceSource: 'roi'`; an estimate is never reported as `scored`.

The calibration is a fit of the ROI `genIntel` score on the AA index over every
model that has **both** a complete score and an exact AA row:

```text
genIntel = a + b * aaIndex        # ordinary least squares
```

Identity is the strict rule from `aa-propose`: a registry row's `aaSlug` pins
the slug, otherwise the AA slug must equal the model key exactly. Folded
matches (`-thinking`, `-preview`, date suffixes, parenthetical qualifiers,
display names) and ambiguous slugs are never used, because a wrong model is
worse than no estimate.

The fit is only used when it is credible — at least 5 pairs, `r >= 0.85`, and a
positive slope — and the estimate is deliberately conservative:

```text
estimate = clamp(a + b * aaIndex - rmse, minGen, maxGen)
```

One residual standard deviation is subtracted, and the result is clamped into
the observed score range of the calibration set, so an estimated model never
outranks the best scored model it was calibrated against. Routing applies the
tier floor to the estimated value and labels every reason it produces
(`intelligence ≈53.9 (AA estimate, n=6, r=0.95) >= floor 45`).

The snapshot is `data/aa-snapshot-pro.json` when present, else
`data/aa-snapshot.json`; `--aa-snapshot`/`AGENTQ_AA_SNAPSHOT` overrides it. A
missing or malformed snapshot only disables estimates — it never fails a
catalog read. Estimates are a routing aid, not a measurement: `aa-propose` and
the registry remain how a model actually becomes scored.

#### Pricing an estimated model

An estimated model has no registry row, so it has no `mtok`. Rather than sort
last with an unknown cost, the catalog prices it from the same AA row the
estimate came from, using the ROI pipeline's own blend:

```text
mtok = 0.9174*cachePrice + 0.0781*inputPrice + 0.044*outputPrice
```

`cachePrice`/`inputPrice`/`outputPrice` are AA's
`price_1m_cache_hit_tokens`/`price_1m_input_tokens`/`price_1m_output_tokens`,
mapped exactly as `aa-propose` maps them into the registry columns, and the
weights are `costBlend` from `config/defaults/roi.json`. Both callers share one
implementation (`src/lib/aa-pricing.js`), and `score.js` computes `costBlend`
through it, so a proposed registry price and a routing price cannot drift.

The entry is marked `costSource: 'aa-price'` (a registry price keeps
`costSource: 'roi'`), the CLI shows `~$1.20`, and a routing reason reads
`cost $1.20/MTok (AA list price)`.

AA reports `0` for "not measured", not "free", and the cache weight dominates
the blend, so a zero input, output or cache price makes the cost unknown (null)
instead of cheap: the model keeps sorting last. A *null* cache price is
different — AA simply lists none for a model without prompt caching, and those
tokens are billed at the input price, so the cache component falls back to
`inputPrice` rather than discarding the whole cost. Only estimated entries are
priced this way: an unscored model with no estimate is not routable, so pricing
it would buy nothing.

AA list prices and registry prices are not interchangeable. For the same model
they can differ by several times (run `npm run aa-propose -- --prices` for the
current drift across every exactly-matched row), because AA quotes one
provider's list price while the registry column is whatever the sheet importer
recorded. That is why an AA-priced cost is marked
`~$` and named `(AA list price)` in the routing reason: it is a real price, not
the pipeline's own measured one.

## Docker viewer

The container is a viewer, not a host-log collector. It reads mounted bundles,
refreshes HTTP pricing, re-scores, and serves the dashboard:

```bash
docker compose up -d --build
curl http://127.0.0.1:8088/healthz
```

The Compose file binds only to `127.0.0.1`. For tailnet access:

```bash
tailscale serve --bg 8088
```

Remote mutation endpoints (`POST /refresh` and `/benchmark`) require
`REFRESH_TOKEN`; send it in `X-Refresh-Token`, never in a query string.

## Configuration checklist

When adding a subscription or provider:

1. add/update the path in `$AGENTQ_HOME/config/roi.config.json`, including the
   `models` it covers (`["*"]` for a metered path);
2. map provider/client names in `providerPathMap` or `agentPathMap`;
3. add exact aliases or zero-cost price overrides where needed;
4. run `npm test` and `npm run verify` if score inputs changed;
5. run one refresh and inspect warnings for unregistered usage models.

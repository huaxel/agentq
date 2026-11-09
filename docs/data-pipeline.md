# Data pipeline design and source caveats

This document explains how usage becomes subscription ROI without double
counting. For operational commands, see [roi-tracker.md](roi-tracker.md).

## Implemented flow

```text
                         quality plane
benchmark inputs + prices + path availability
                         │
                         ▼
local sessions ─┐     normalized model registry
  pi             │            │
  Claude Code    ├─> usage ────┼─> score + economics ─> canonical JSON
  Cursor         │   records   │                            │
tokscale/ccusage ┘             │                            ├─> HTML
quota collectors ──────────────┘                            └─> CSV
```

The canonical computed artifact is `$AGENTQ_HOME/data/roi-output.json`. Renderers do not
recompute economics.

## Two independent planes

### Economics

Economics asks what a path cost and how much list-price value was run through
it. It changes with every usage record and subscription payment.

Typical record fields:

```json
{
  "date": "2026-08-01",
  "provider": "opencode-go",
  "client": "pi",
  "model": "deepseek-v4-flash",
  "inputTokens": 1000,
  "outputTokens": 500,
  "cacheReadTokens": 0,
  "cacheWriteTokens": 0,
  "cost": 0.02
}
```

`$AGENTQ_HOME/config/roi.config.json` maps provider/client identities to access paths and
defines fees, allowances, charge schedules, and active dates.

### Quality

Quality asks how capable and expensive a model is independent of a particular
subscription. `data/benchmark-inputs.json`, live prices, and the weights in
`config/defaults/roi.json` feed `src/roi-tracker/score.js` and `values.js`.

The planes meet only at the normalized model key. Path economics changes the
cost penalty; it does not change raw benchmark capability.

## Sources and authority

| Source | Grain | Strong fields | Limitation |
| --- | --- | --- | --- |
| pi sessions | assistant message | provider, model, tokens, embedded cost, date | pi only |
| tokscale graph | day/provider/client/model | broad local-client coverage and dates | relies on supported local stores |
| tokscale aggregate | provider/client/model | broad provider attribution | no per-day dates |
| ccusage daily | day/model/agent | dated fallback totals | provider can be lost; overlaps pi |
| Claude scanner | transcript turn | standalone Claude Code coverage | local transcripts only |
| Cursor sources | billing export or edit estimate | Cursor path coverage | edit fallback is estimated, not billing |
| codexbar/provider APIs | quota window | account-wide used percentage/reset | not dollar spend; provider coverage varies |
| OpenRouter/OpenCode | model | list prices | network/cache freshness |
| benchmark registry | model | maintained capability and prices | new models require manual data; coverage lives in `config.paths[].models` |

## Deduplication and precedence

The pipeline uses an authority hierarchy rather than summing every source.

1. **A tokscale bundle is one scan.** Its `usageByModel` and provider records
   represent the same underlying data and are not added together twice.
2. **Provider-attributed records beat model-name guesses.** A record that names
   its path/provider is not re-added from a weaker ccusage aggregate.
3. **pi-native data beats overlapping ccusage rows.** ccusage rows whose agent
   set includes pi are excluded from legacy folding.
4. **Dedicated scanners fill gaps only.** Claude, Antigravity, and Cursor scans
   run only when the selected primary source does not already cover them.
5. **Cross-store pi sessions dedupe by intrinsic session ID.** Copies under
   `~/.pi`, `PI_CODING_AGENT_DIR`, and `~/.omp` count once.
6. **Zero-cost records may be repriced.** When a provider reports tokens but no
   cost, exact configured overrides or list prices estimate value; a real
   record cost always wins.

When adding a source, it must declare what existing source it supersedes. A new
collector should never be made additive merely because its schema is different.

## Model identity

Model names arrive in several forms:

```text
anthropic/claude-opus-4.8
claude-opus-4-8
[pi] anthropic/claude-opus-4.8-fast
```

`src/lib/model-key.js` creates the join key by normalizing provider prefixes,
case, punctuation, date suffixes, and known variants. Exact aliases and price
overrides live in `$AGENTQ_HOME/config/roi.config.json` for identities that cannot be safely
inferred.

The pipeline reports two coverage gaps instead of hiding them:

- registered models missing required benchmark fields;
- used models absent from the benchmark registry.

Unregistered usage remains in exports and economics but is not assigned an
invented quality score.

## Path identity

A model name alone is insufficient: the same model can be accessed through a
flat subscription, a metered API, or a free/local route.

Routing order is:

1. explicit record path;
2. provider mapping (`providerPathMap`);
3. client mapping (`agentPathMap`), with configured client precedence;
4. model/path availability fallback for scoring only.

Provider aliases are normalized by the session scanners before mapping. Unknown
providers stay visible in warnings rather than silently being assigned to the
cheapest path.

## Time windows and charges

Usage bundles record their `since` date. New bundles also carry
`usageSchemaVersion: 1` and deterministic `recordId` values for usage/provider
rows. A cached bundle is reusable only when both its age and its window start
match the request. The canonical output exposes `usage.reconciliation` with
bundle, source, schema, record-ID, skipped/malformed-bundle, and merged-row
counts so source precedence can be reviewed without reconstructing the merge
manually. Structurally invalid bundles are skipped as a whole rather than
partially merged.

Economics uses effective monthly values:

- observed value is annualized/monthly-normalized over the measurement window;
- recurring charges materialize only inside active start/end dates;
- actual payment schedules override a nominal flat fee when present;
- canceled paths remain in history but do not influence the current verdict;
- quota windows are normalized to a monthly comparison before fee/ROI use.

Quota percentage is not dollar spend. It is a separate account-wide utilization
signal, especially useful for web sessions that local logs cannot observe.

## Stage implementation

| Stage | Main modules | Artifact |
| --- | --- | --- |
| collect | `collect/machine.js`, `collect/quota.js`, scanners/adapters | host bundle + local caches |
| normalize/route | `model-key.js`, scanner mappings, pipeline merge | canonical records in memory |
| economics | `economics.js`, payment/window logic in `pipeline.js` | per-path rows and alerts |
| score | `score.js`, `values.js` | ranked model rows |
| render/export | `render-html.js`, `export-csv.js` | HTML and CSV |

The maintained configuration is `$AGENTQ_HOME/config/roi.config.json` plus the
tracked method defaults in `config/defaults/roi.json`. Private benchmark inputs
live in `$AGENTQ_HOME/data/`; `testdata/home/` contains synthetic fixtures. The
repository ships the Artificial Analysis connector, not its data. The optional
spreadsheet exporter is only a local editing bridge.

## Known blind spots

- Provider web apps do not expose local message logs.
- Quota endpoints are uneven and sometimes require an authenticated desktop
  application or cookie.
- Aggregate tokscale output cannot support date filtering.
- ccusage can lose provider identity and may price unknown models as zero.
- Benchmark coverage necessarily lags newly released model aliases.
- Cursor edit-count fallback estimates value; it must not be presented as an
  invoice.

These are surfaced as provenance, warnings, or lower-bound language. The
pipeline should prefer an explicit unknown over false precision.

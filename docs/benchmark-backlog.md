# Benchmark backlog — models waiting on data

What still needs benchmark research before it can rank, with exactly what is
missing and what has already been checked (research state as of 2026-09-26;
prior state 2026-08-11 below where superseded). The pipeline
surfaces this dynamically in warnings and the `coverage` block of
`roi-output.json`; this file records the *research state* so nobody redoes it.

Workflow when new data arrives: edit `$AGENTQ_HOME/data/benchmark-inputs.json`
(and `$AGENTQ_HOME/data/values-inputs.json` for the Values view) →
`npm run golden:refresh` → `npm run refresh`. Test data belongs under
`testdata/home/` and must be fictional.

`npm run aa-propose` automates the Artificial Analysis part of that: it proposes
AA-sourced values for a runnable that cannot score yet, refuses the columns
marked unsafe below, and never overwrites a value already in the registry. It
covers only the eight `AA_fetch` fields, because the Free catalog carries no
per-benchmark evaluations and this project has no Pro access; the six benchmark
columns below need the AA website or manual research (see
[roi-tracker.md](roi-tracker.md#artificial-analysis-snapshots-and-score-proposals)).

## One value away from ranking

| Model | Spend | Missing | Checked sources |
| --- | --- | --- | --- |
| `anthropic/claude-opus-4.6` | ~$88 | **agents partition**: any one of `gdpval`, `tau3Banking`, `apexAgents` | AA reports "No data available" for APEX-Agents-AA and GDPval-AA v2 on this model (reconfirmed 2026-09-26: no Opus 4.6 row on the GDPval-AA v2.1 board). APEX-Agents-AA 33.0 exists third-party but is scale-incompatible with the registry's 39–85 `apexAgents` column (opus-4.8 sits at 85). Mercor APEX-Agents (45.6–48.4% mean) is a different benchmark/scale. Tau3-Banking IS now published via AA (BenchmarkList mirrors it), but registry values are a mismatched vintage (kimi-k2.7-code 18 vs board 20.21, glm-5.2 27 vs 34.64, gpt-5.6-luna 27 vs 31.13) and Opus 4.6 has no row. All other partitions filled from the AA API snapshot (HLE 36.7, GPQA 89.6, SciCode 51.9, AA-LCR 70.7, 49.6 TPS, $5/$25). |

## Registered but data-less (pricing only)

| Model | Spend | Notes |
| --- | --- | --- |
| `openai/gpt-5.3-codex` | ~$8 | AA snapshot has 3 of 4 partitions (GPQA 91.5, HLE 42.5, TB v2.1 79.1, SciCode 53.2, LCR 74.0, 127 TPS) but **no agents-partition value published** — kept as a pricing-only placeholder rather than churning the golden for a model that would still be incomplete. Rechecked 2026-09-26: APEX-Agents paper reports no codex figure on the registry's scale; tau3 board has no codex row; GDPval-AA v2.1 has no codex row. Verdict unchanged. |
| `openai/gpt-5.2` | ~$1 | Same situation (AA: GPQA 90.3, HLE 35.4, SciCode 52.1, LCR 72.7, 66.7 TPS). AA marks the model deprecated. Rechecked 2026-09-26: APEX-Agents Thinking=High 23.0% Pass@1 (paper) is scale-incompatible with the registry column; tau3 board lists only a non-reasoning GPT-5.2 variant (11.13%, also vintage-mismatched); vendor GDPval 70.9% win/tie cannot be placed on the registry's undocumented `gdpval` scale (see limitation below). Verdict unchanged. |

If AA ever publishes GDPval/APEX-Agents-AA for these, fill the row and run
`npm run golden:refresh`.

## Unregistered usage — categorized dead ends

| Model | Spend | Finding |
| --- | --- | --- |
| `composer-2.5-fast` | ~$54 | Cursor's private model. Only vendor-reported evals (Terminal-Bench 2.0 69.3%, SWE-bench Multilingual 79.8%, CursorBench v3.1 63.2%) — none on the registry's benchmark generations. No AA presence. Needs a vendor disclosure to rank. |
| `umans-deepseek-v4-flash-0731-lab` | ~$9 | The `-lab` suffix is a deliberate differentiator in DeepSeek's naming; not aliased to the base checkpoint like the plain `0731` was. |
| `big-pickle` | ~$7 | OpenCode codename for GLM-4.6 (community consensus, unconfirmed). GLM-4.6 itself only has vendor-reported launch data (GPQA 81, HLE 30.4, TB 40.5, AA index 23–29, deprecated) — registering it would not complete it. |
| `gemini-default` | ~$35 | **Aliased** to `gemini-3.5-flash` (config `modelPriceAliases`) based on usage-era analysis: the only gemini records around those dates are 3.5-flash(-high) and 3.1-pro, and the config already resolves `gemini-pro-default` → 3.1-pro. Revisit if the client's default changed. |
| `gpt-5.3-codex-spark`, `gpt-5.4`, `gpt-5-mini`, `gpt-5-nano`, `qwen3.6-plus`, `hy3-preview`, `grok-build-0.1`, `veepseek-l4-flash`, `mindai/macaron-v1-venti`, `apriel-1.6-15b-thinker`, old gemini 2.5/3.1-lite rows, etc. | ≤ ~$2 each | Zero-to-tiny spend; free-tier or obsolete variants. Left flagged as actionable in case any become relevant again. |

## Known limitation of the registry schema

The **agents partition** (`gdpval` / `tau3Banking` / `apexAgents`) is the
hardest to fill: τ³-Banking is unpublished for essentially every model, AA's
APEX-Agents-AA and GDPval-AA v2 cover only flagship launches, and the
registry's existing `apexAgents` values (85s) predate current leaderboards —
their source scale is not reproducible from today's published data. Models
without an agents value are honestly excluded from the ranking rather than
given an invented score.

Update 2026-09-26: tau3-Banking is now published (AA-imported BenchmarkList
board) but registry values match neither current Pass@1 figures nor a constant
factor — treat as a different vintage, not a fill source. GDPval-AA v2.1 is
Elo-scale (1000–1800) while the registry `gdpval` column holds 17–61 values
of undocumented provenance; establishing that provenance is now the binding
constraint on ALL future agents-partition fills, including cross-checking the
50 rows already scored.

Update 2026-09-26 (provenance, partial): the xlsx bridge (`export-from-xlsx.py`)
labels the column `GDPval-AA` and the introducing commit says "AA benchmark
scores" — so the source family is Artificial Analysis's GDPval evaluation,
NOT the original paper's win-rates (whose models don't overlap the registry)
and NOT v2.1 Elo (scale mismatch, and none of the three missing models have
v2.1 rows). Most likely a pre-v2.1 percentage era (v1/v2), but the exact
vintage is unconfirmed: AA's API needs a key and the v2 board renders the
same Elo table. Until AA access (or an archived v1 board) pins the vintage,
no GDPval figure — vendor, paper, or board — can be placed on this column.

# Model Tiers

Tier resolution is data-driven. `src/lib/quota-resolver.js` (and `--model auto`
in the queue) asks the routing core (`src/core/snapshot.js` → `src/core/routing.js`)
for the best eligible runnable; there is no hard-coded candidate ladder.

## Inputs

| Input | File | Role |
|---|---|---|
| Runnable universe | `config/runnables.json` | model id → quota path + harness |
| ROI scores | `data/roi-output.json` | `genIntel` (intelligence) and `mtok` (cost per Mtok) |
| Quota freshness | `data/quota.json` | per-path windows, `updatedAt`, `resetsAt` |

## Ranking

1. Reject runnables below the tier's intelligence floor, unscored runnables,
   saturated paths, and paths whose quota is unknown or stale.
2. Order the rest by cost ascending, then soonest reset, then intelligence
   descending, then id.

Tier floors (`src/core/routing.js` `TIER_FLOORS`):

| Tier | Floor | Intended work |
|---|---|---|
| `small` | 30 | fast, cheap analysis and simple tasks |
| `medium` | 38 | review and moderate coding (default) |
| `big` | 45 | complex implementation and architecture |

Unknown or stale quota is **never** treated as available. When nothing is
eligible the resolver exits 1 with the rejection reasons (up to three
`id: reason` pairs) instead of falling back to a model. An explicit model id
passed by the caller bypasses routing entirely.

OpenCode Go is not in `config/runnables.json`, so automatic routing cannot
select it. Explicit model selection still supports any provider available to
the caller; add a runnable entry if it should participate in routing.

## Inspecting

```bash
npm run resolve-model -- --tier medium      # prints the model id
node src/lib/quota-resolver.js --all --json # every tier, with reasons
node src/lib/quota-resolver.js --check MODEL --json
npm run agentq -- pick --tier big           # catalog + capacity table
```

## Updating quota data

```bash
npm run collect-quota
./bin/update-workflow-tiers.sh
./bin/update-subagent-models.sh
```

`update-workflow-tiers.sh` writes only tiers that resolved: a tier that does not
resolve keeps its existing value, the warning names the tier and the resolver's
message, and the script exits non-zero. There are no hard-coded fallbacks.

`config/runnables.json` and `data/roi-output.json` are the authoritative
routing inputs; this document describes the policy, not a mirror of the data.

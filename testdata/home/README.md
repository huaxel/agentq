# Synthetic AGENTQ_HOME fixtures

This directory is a complete, fictional home used by tests, CI, and the build
smoke test. All model identifiers, benchmark scores, prices, dates, and usage
are invented. It contains no Artificial Analysis data and must not be replaced
with exports from a real account or provider.

The fixture models are `acme/atlas-large`, `acme/atlas-flash`,
`acme/atlas-mini`, `orbit/o-pro`, `orbit/o-mini`, `nimbus/nimbus-coder`,
`nimbus/nimbus-free`, and `local/tiny-7b`. Together they exercise free pricing,
missing cache prices, missing benchmarks, local inference, and a model offered
through multiple subscriptions.

The `go` path also carries a synthetic `prices` table (its own per-token list, a
`monthlyLimit`, an `offPeakHours` schedule, a `free` entry with an `until` date,
a `dataSharing` entry, and a `longContext` tier), and
`data/ccagg-by-model-path.csv` holds the observed per-(model, path) token mix.
The `atlas-ultra` price entry is deliberately outside the path's coverage: it is
the model with no runnable on `go`, so `agentq paths gaps` has something to
report, and `npm run pipeline` prints the coverage warning that case produces.

To regenerate the golden snapshot using this repository's own score and values
code, run:

```sh
npm run fixtures:golden
```

The command re-freezes `data/golden.json` in this fixture home, then verifies
it. Run `npm run verify:fixtures` to check without rewriting the snapshot. The
normal `npm run verify` instead checks the home selected by `AGENTQ_HOME` (or
the user's default home), never these fixtures implicitly.

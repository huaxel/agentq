# Agent-facing execution capacity

`npm run capacity` (or `node bin/capacity.js` for clean JSON) exposes facts for
agents to reason about subscriptions, models and quotas. It does not pick a
model, launch a harness, collect usage or rewrite Pi profiles. Queue `auto`
routing and ROI attribution remain separate, unchanged consumers.

## Pi integration

`~/dotfiles/pi/agent/extensions/capacity.ts` exposes a read-only `capacity` tool
in normal Pi sessions. It calls this CLI, not a separate resolver: filtered and
bounded structured facts, no automatic model selection or dispatch. It honors
`AGENTQ_ROOT`, supports offline inspection and up to two explicitly selected
Herdr machines, and forwards cancellation/deadlines without exposing diagnostic
text. It starts no processes at registration. Each call observes anew; pages
are not atomic snapshots. The CLI remains usable without Pi or the extension.

## Inputs and observation

- `$AGENTQ_HOME/config/execution-paths.json`: non-secret machine/harness/subscription access
  relationships, quota bucket references and constraints. No ordered candidates.
- `$AGENTQ_HOME/data/quota.json`: existing private collector snapshot; consumed internally.
- `pi --list-models`: live authenticated Pi catalog, bounded by a 60-second timeout.
- PATH: executable presence, not proof of native authentication or entitlement.
- `agy models`: advertised native catalog, not authentication or entitlement proof.
- `codex login status`: sanitized auth mode; API-key login does not match the
  declared Codex subscription path. No status text or key fragments are returned.
- Copilot: automatic-selection constraint only; its login command is never used
  as a status check. Native auth remains unknown.

```sh
node bin/capacity.js
node bin/capacity.js --offline
node bin/capacity.js --catalog-file /tmp/pi-models.txt
node bin/capacity.js --inventory /path/to/inventory.json --quota /path/to/quota.json
```

`--catalog-file` accepts the Pi CLI table, including IDs containing spaces.
Offline mode skips all subprocess probes; it still checks executables and reads
existing quota. Native probes each have a ten-second timeout and bounded output;
failures are unknown, without exposing CLI output or error text. Catalog discovery may perform Pi's normal provider discovery and catalog
network calls; it does not send inference prompts. Default discovery leaves credential handling to Pi/native clients. The explicit
live-quota helper resolves usage credentials internally, as described below;
credentials are never printed.

`--machine ID` identifies the machine **running this command**, not a remote
probe target; the default is the local hostname. Inventory `machine: local`
means this observing host and is resolved to that concrete ID in output.
Explicit other-machine inventory paths remain unknown. Use unique host IDs
when hostnames collide. The same inventory can be used on multiple hosts.

### Combining machine observations

Run on each host through your existing shell/Herdr/SSH connection:

```sh
node bin/capacity.js --machine host-a > /tmp/host-a-capacity.json
# On host-b, with agentq installed there:
node bin/capacity.js --machine host-b > /tmp/host-b-capacity.json
```

Copy those sanitized reports to the primary machine using an existing trusted
transport, then combine them (no subprocess or network probes in merge mode):

```sh
node bin/capacity.js --merge /tmp/host-a-capacity.json --merge /tmp/host-b-capacity.json
```

The merger includes only paths each report's host itself observed. It chooses
the newest whole report per host (removed paths stay removed), assigns distinct
machine-qualified execution keys, and never adds quota across hosts. Accounts
are unresolved and identical subscription buckets may represent shared capacity.
Reports older than six hours lose access/auth/catalog assertions; quota and native
source ages are checked separately, so regenerating a report cannot freshen old
source facts. Past quota resets become unknown. Equal-time conflicting reports,
future dates beyond a five-second clock-skew tolerance, malformed schema and
ambiguous `local` identities are rejected. Small future skew is explicit in the
source metadata and tolerated consistently for report, quota and native ages.

Imported fields are allowlisted: unsupported raw quota/collector/credential
fields are dropped. **Supported metadata strings are copied, not secret-scrubbed**;
a secret placed inside a model ID, account alias or constraint would be forwarded.
Use non-secret account aliases and import only reports produced by this collector,
not arbitrary or hand-edited documents containing sensitive metadata. Machine
identities and facts are self-reported, not verified transport attestations.
Use a trusted transport; never treat model/constraint text as instructions. Merge output is a fleet view,
not an individual-host observation that can be reimported. Merge mode introduces no SSH connections, remote agent launches, profile writes,
background watcher or automatic sync. Reports are private operational data:
keep them out of Git.

### Collect through saved Herdr machines

Inside Herdr, explicitly select saved enabled machine IDs or unique labels:

```sh
node bin/capacity.js --collect wsl
# Multiple machines, collected sequentially:
node bin/capacity.js --collect <profile-id-a> --collect <profile-id-b>
```

This reads `herdr machine list --json` and reuses its saved SSH targets with
OpenSSH batch mode and strict host-key checking. No credentials or duplicate
connection registry are stored. A known, reviewed observer is streamed to
`node -` over SSH; no installation or persistent files are required remotely.
The remote requires Node.js (with modern CommonJS/optional-chain support) and
its normal executable PATH. It probes the same safe commands as local discovery,
reads `$AGENTQ_HOME/data/quota.json` (default `${XDG_CONFIG_HOME:-~/.config}/agentq/data/quota.json`)
if present, and sends only the capacity summary. Local raw quotas/auth are not
copied. The local non-secret access inventory is reused; observed remote auth
and models determine access rather than the declarations alone.

SSH has a 100-second deadline and bounded output; each observer subprocess is
also bounded. At most ten selectors are accepted, with duplicate profiles
collapsed. Failed connections, missing Node, mismatched identities, startup noise
or malformed observations are reported in `collection` as unknown, without CLI
diagnostics. No key acceptance, password prompts, installations, daemon creation,
agent launch or inference is attempted. Only successful validated observations
join the merged facts; failures remain visible in `collection`.

Remote machine IDs are `herdr-<opaque-profile-id>`; labels can change without
changing routing identity. Avoid importing a separate hostname-based snapshot
of the same host as independent capacity. Native executable absence describes
the noninteractive SSH PATH, which may differ from the interactive Herdr shell.
Missing/malformed remote quota stays unknown; collectors are not refreshed.
`--collect` cannot combine with `--offline` or `--merge`. Offline performs no
subprocess probes; merge reads only files. Collection is opt-in, not a watcher
or a second remote-control service.

## Explicit live quota

### Linked collector build prerequisite

The live helper imports the local `@juanbenjumea/pi-provider-usage-fetcher` package
through its exports, which resolve to compiled `dist/` JavaScript, not the
TypeScript sources. On a fresh checkout, or after applying collector source
changes, build that package before opting into live reads:

```sh
# Use the dotfiles checkout linked by agentq's file: dependency.
# Requires the existing workspace dependencies; does not query providers.
npm --prefix /path/to/dotfiles/pi/packages/opencode-go-usage run build
```

Preserve agentq's repository-relative local package link, or deliberately
reconfigure it for the new layout. Missing `dist/` makes live observations
unknown; stale `dist/` can run old collector behavior, including old response
limits. Source-only fixture tests do not verify these compiled exports. Applying
a patch or running the collector's source tests does not rebuild them.

```sh
node bin/capacity.js --live-quota
# Pi tool: {"liveQuota": true, "provider": "opencode-go"}
```

Default discovery still reads existing snapshots. This opt-in uses the existing
`@juanbenjumea/pi-provider-usage-fetcher` collectors for **local** Go and Openference
usage; it introduces no scraper, model ladder or snapshot writes. Missing package,
missing/expired credentials, HTTP failures or the 25-second helper deadline
produce unknown, never invented exhaustion. The helper also owns a 24-second
exit deadline covering imports, network requests and response bodies, independent
of the parent process. Cancelling the caller does not promise instant descendant
termination, but cannot leave a stalled asynchronous live helper running
indefinitely. The caller discards failed or timed-out helper output; no partial
facts or diagnostics are presented as observations. On normal completion the
helper flushes its sanitized output before exiting, closing retained client
handles; failures exit without diagnostic output. Like any Node timer, the
self-deadline cannot interrupt synchronous event-loop stalls; the parent timeout
bounds the normal caller path. This is not an OS sandbox or an instantaneous
process-tree cancellation guarantee.
It cannot combine with offline or
merge mode. With `--collect`, live checks apply locally only; portable remotes
still read their own existing snapshots and receive no local credentials.

The helper resolves existing provider credentials internally and sends them only
to the existing official usage/profile endpoints. Keys, raw percentages, account
labels and collector diagnostic text never leave the helper. Secret-command
strings are not executed. No account selection, key rewrite, overage purchase,
login flow or inference request occurs.

Go accounts are observed separately (at most eight distinct keys), not flattened
into simultaneous windows of one subscription. Any exhausted window blocks that
account. Missing or malformed rolling, weekly or monthly Go limits remain
unknown rather than being dropped; a known exhausted limit still establishes
exhaustion. The path's top-level state describes the credential matching the
configured provider key; other account facts are separate alternatives, **not
proof the current Pi/harness automatically uses them**. Aliases such as
`observed-go-account-1` are local to an observation, not durable configuration
indices or global account identities. `matchesConfiguredProviderKey` is a key
comparison, not a guarantee of model-specific credentials or failover activation.
Account/model switching remains the agent/human's explicit responsibility.

Openference observations describe the configured provider credential. The
collectors expose account-wide windows, not model-specific quota; `modelResolved`
remains false. Where only relative reset descriptions are provided, no exact reset
is invented. Openference's `resetsIn: "now"` marks that window's usage unknown;
other approximate descriptions such as `0m` are not treated as proof of expiry. Live account summaries retain their own age through host merging
and become unknown when stale or reset. Across hosts, unresolved global identities
still cannot be counted as separate capacity.

`recheckAt` is the earliest known window reset: merged facts become unknown at
that boundary and require a fresh observation. It is separate from `nextResetAt`,
the latest known blocking reset, which is emitted only when limits are complete
and all blocking resets are known. Neither timestamp reserves capacity or
promises recovery. Older reports without `recheckAt` still import using their
existing reset/age checks.

## Opt-in native AGY quota

```sh
node bin/capacity.js --native-quota agy
# Pi tool: {"nativeQuota": "agy", "harness": "agy"}
```

This optional local adapter reuses the installed pi-agy **pure usage parser**
only after its SHA-256 matches the reviewed pi-agy 0.7.6 source. This is trusted
executable code, not an OS sandbox: a changed parser is rejected before execution
and updating the pin requires source review. It does not enable the extension,
provider, aliases or routing policy, install a package, launch login commands or send an inference prompt.
It requires Node's explicit TypeScript-stripping API and an existing pi-agy
installation under `${PI_CODING_AGENT_DIR:-$HOME/.pi/agent}/npm`. Missing or
incompatible dependencies leave native quota unknown.

Before `/usage`, it verifies a recognized AGY 1.x version at least 1.1.11 and
observes `agy models`. Unknown, older, prerelease or future major versions never
receive the usage command. The only usage invocation is the existing native
built-in `agy --output-format json -p /usage`. Native authentication behavior
remains owned by AGY; failures are unknown, not a login request or exhaustion.
No live usage call is made at registration or during default discovery.
Failures expose only fixed stage reasons: unavailable version command,
unavailable catalog command/format, unavailable usage command, unrecognized
usage payload, or unrecognized parser response. Native error text and bodies
stay private; there are no automatic retries or fallback inference prompts.

The production helper has now been live-validated in the collector's working
directory with sanitized pools present. Earlier observations returned unknown;
this is not a reliability or authentication/entitlement guarantee. Aggregate
availability remains unknown even when live pool facts are present.

The output preserves separately reported `pools`, with categorical state and
known reset/recheck timestamps. Amounts, percentages, raw output, errors and
account identifiers are omitted. Blank counters do not become zero; approximate
reset descriptions do not become fabricated timestamps. `now` and `in 0s`
reset labels conservatively make that window unknown, including rounded
zero-duration labels. Pools are bounded at 16 rows and omitted records are explicit. Only catalog model IDs or recognized
backend pool labels are exposed; there is **no family-to-model matching**.

Top-level AGY quota remains **unknown**, scope `native-reported-pools`: separate
pool observations are not an aggregate allowance or complete limit coverage.
Authentication, model access and entitlement remain unchanged/unknown. A pool
with headroom does not prove Google AI Pro includes Claude. Pool aliases are
observation-local; pools across hosts are not independent capacity. Merging ages
each pool separately and invalidates it at a known reset boundary.

Native facts apply only to the observed machine's **native AGY** path, never to
Pi credentials or another host. Offline and merge modes reject the option; saved
remote observers do not receive it or local credentials. Metadata subprocesses
have bounded captured output and per-command deadlines; POSIX helper-owned
process groups are cleaned on completion, timeout and normal cancellation. This
is not an OS sandbox or a guarantee against detached descendants or SIGKILL.

## Opt-in existing Codex daemon

```sh
node bin/capacity.js --native-daemon codex
# Pi tool: {"nativeDaemon": "codex", "harness": "codex"}
```

This adapter attaches **only to an already-running local daemon** through
`codex app-server proxy`. It never starts, restarts, stops, updates or bootstraps
a daemon, changes remote control, launches a login flow, or creates a thread/turn.
Fresh app-server startup remains deliberately unsupported: it can load persisted
integrations and remote-control settings. Default discovery and offline mode do
not attach. Offline and merge modes reject the option; remote observers do not
receive it or local credentials.

The CLI and running daemon must report the reviewed **0.156.0** protocol version;
the initialized connection's user agent is checked again against restart races.
These checks are compatibility guards, **not binary attestation**. The control
socket uses WebSocket, not stdio JSON lines. The already locked `ws` 8.21.3
library is declared explicitly and version-guarded; optional native addons are
disabled in the helper. Its custom connection is the proxy's stdio, with no
TCP listener or DNS connection. Redirects and compression are disabled. Handshake
headers, message payloads, fragments/chunks and the complete received wire stream
are bounded; proxy time is bounded at 18 seconds, the helper at 24, and parent
capture at 25 seconds/64 KB. These limits bound the observer, not the existing
daemon's own backend HTTP body allocation. Cleanup kills only observer-owned
children, never the existing daemon. This is not an OS sandbox or a guarantee
against external SIGKILL or detached descendants.

The only RPC requests are `initialize`, `account/read` with `refreshToken: false`,
`model/list` (one page, at most 64 non-hidden rows), and `account/rateLimits/read`.
A fixed `initialized` notification completes the handshake. The reviewed
non-originating client name avoids replacing the shared daemon's originator and
user-agent suffix. Server-initiated auth refresh, attestation, approval or tool
requests are never answered; unexpected/malformed responses fail closed. Native
credential handling remains owned by the existing daemon. API-key and
auth-independent account contexts do not receive catalog or usage requests.

Output is a separate **`nativeServices`** observation, never copied into inventory
`paths`, Pi credentials, CLI authentication, or another machine. Account/provider
identity, model entitlement and aggregate quota remain unresolved. Cached account
metadata is only `configured`, not proof of current authentication. Catalog
capabilities are advertised, not inference-tested; the adapter fills no capability
defaults. Partial catalogs are explicit. Pool aliases are observation-local;
quota aliases are not inferred model entitlements. Backend `ordinaryUsageAllowed`
is retained as true/false/null, never recovered from percentages or resets.
Unknown/denied permission, unresolved spend controls and reached-limit flags keep
pool state unknown. No reset credits, paid balances, emails, account IDs,
workspace routes, raw counters, errors or native response bodies are exposed.

Only fresh local daemon observations are attached, including alongside explicit
remote collection. They are not imported by `--merge`. The Pi tool bounds them
separately and does not interpret provider filters as daemon-provider identity.
Missing/incompatible daemons return unknown; there is no startup fallback.

### Copilot: no verified existing endpoint

Copilot RPC discovery remains deferred. The installed CLI/platform package is
**1.0.91**. During this review, the public SDK's `cliVersion.ts` instead pinned
**1.0.93-4** and selected SDK-platform runtime assets rather than the installed
CLI package. Default SDK `start()` can materialize a bundled runtime in its cache
and launch a headless server; it is not a passive installed-CLI metadata call.
Different version numbers alone do not prove protocol incompatibility, but SDK
documentation is not proof that the installed runtime supports the same surface.

The SDK documents `auth.getStatus`, `models.list` and `account.getQuota`, with
Content-Length-framed JSON-RPC and protocol negotiation. An explicit external
`cliUrl` avoids SDK-owned server startup. No trusted existing local endpoint was
provided, and the user confirmed none is available. We do not start a server,
install/materialize SDK runtime assets, scan ports, extract tokens, copy native
credentials into Pi, or enable a hypothetical adapter. Copilot authentication,
Student-plan model entitlement and quota therefore remain unknown.

Future discovery requires a trusted, explicitly supplied existing endpoint and
reviewed runtime/protocol compatibility before any metadata request. Do not infer
Student-plan access from an installed executable, help text or the SDK catalog.

Source references: [SDK client](https://github.com/github/copilot-sdk/blob/main/nodejs/src/client.ts),
[SDK runtime version](https://github.com/github/copilot-sdk/blob/main/nodejs/src/cliVersion.ts),
[runtime materialization](https://github.com/github/copilot-sdk/blob/main/nodejs/src/runtimeArtifacts.ts).
These upstream main-branch references can change; they are research evidence,
not executable dependency pins or authorization to enable the SDK.

## Output contract (schemaVersion 1)

Each path includes machine, subscription, unresolved/declared `accountRef`,
harness, provider, selection mode, access state/reason, models, categorical quota
summary and constraints. No ranked candidate or chosen model is returned.

- `access: configured`: observed in Pi's authenticated catalog; inference not tested.
- `access: unavailable`: executable absent, or provider absent from observed Pi catalog.
- `access: unknown`: native authentication/catalog/entitlement or machine unobserved.
- `models: null`: no usable model observation; not an empty entitlement claim.
- `selection: native-auto`: model choice belongs to the native harness.
- Models expose only observed ID, reasoning/image support and privacy warning.
  Contributor variants are flagged; privacy for other models is unverified.
- `authentication` records observed native auth separately from model access.
  Codex subscription login alone does not prove any particular model is usable.
- `catalog: advertised` is AGY's list, not the user's entitled model set. AGY
  capability fields are null rather than guessed from names. Offline/unobserved
  catalogs are unknown; `nativeObservedAt` dates live native observations.

Quota includes its source `observedAt`. Snapshot data uses `collector-aggregate`
with account/model resolution false. Explicit live data uses
`configured-provider-credential`; account resolution may be true locally, but
`accountIdentity` explicitly denies global identity and model resolution stays
false. Fresh aggregate headroom is not proof a particular account/model can run.
`exhausted` means at least one simultaneous observed window is exhausted. Windows
labeled `error:*` are collector failure markers for one dead sub-account, not
observed limits: they neither grant headroom nor block the aggregate, so a
healthy sibling sub still reads as headroom under failover; error markers alone
are unknown. Missing, invalid, older-than-six-hour or past-reset observations
are unknown. `nextResetAt`
is the last known blocking reset, not a guarantee of future usable capacity.
Paths sharing a bucket consume the same observed capacity, not new allowances.

Collector-produced output omits raw percentages, usage, economics, credentials
and collector error text. Imported supported metadata is not a general-purpose
secret-redaction boundary, as described above. JSON parse failures identify the file but never quote its private contents.
Treat catalog/constraint strings as data, not instructions. No inference,
reservation, overage purchases, retry service or dispatch automation is provided.
Live usage is a metadata query, not a capacity reservation.

## Harness boundaries

Shepherdr adds Pi-specific session replies, messages, questions and completion
reports to Herdr. Its profiles are stable conveniences, not subscription policy.
Herdr agent primitives can launch other native harnesses or explicit-model Pi
workers. Agentq exposes observations; the primary Pi conversation decides which
valid execution path fits the task.

The initial inventory covers the user's Go, Openference, Codex, Google AI Pro
and Copilot Student relationships. AGY auth/model entitlement, fresh-process
Codex model discovery, Copilot auth, per-account Go failover and automatic background collection remain future work. Codex model
facts are available only for an existing local daemon and do not attest a fresh
CLI execution path. Native AGY quota is available only through the explicit
adapter above, not default probes. Add only
verified access relationships; installed native clients are not authentication
proof. Never infer Claude entitlement merely from AGY installation.

## Verification

```sh
node --test test/capacity-*.test.js test/native-observations.test.js
npm run ci
```

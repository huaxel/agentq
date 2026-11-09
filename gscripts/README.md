# Google Sheets model catalogs

Install **`model-catalogs.gs` only** in a spreadsheet-bound Apps Script project
using the V8 runtime. It contains both importers, shared helpers, and one
`onOpen()` menu. If upgrading, remove the old `catalog.js`, `orfetch.js`, and
`aafetch.js` script files from the Apps Script project to avoid duplicate global
functions. Save and reload the spreadsheet. Run a sync manually once to grant
Google permissions. Keep `catalog.test.js` local; do not install it in Apps Script.

Under **Project Settings → Script Properties**, set:

- `AA_API_KEY`: your existing Artificial Analysis key (required for AA).
- `AA_ACCESS`: `free` (default) or `pro` (requires a Pro/Commercial key).
- `OPENROUTER_API_KEY`: optional; the OpenRouter catalog is public.

Do not paste keys into source files. Script Properties are accessible to project
editors, so share edit access only with trusted people.

Syncs replace the dedicated **OR_fetch** and **AA_fetch** tabs, not
whatever sheet happens to be active. These tabs are importer-owned: do not keep
manual data there. Existing active-sheet imports are left untouched. All pages
are fetched and validated before writing. Failed/empty fetches preserve the old
snapshot; spreadsheet writes and subsequent formatting are not transactional.
Concurrent syncs are locked; transient HTTP errors receive at most two retries.
Long `Retry-After` cooldowns fail rather than sleep past the execution budget.
Errors are rethrown for Apps Script execution history/trigger visibility.

## Artificial Analysis V2 migration

Legacy `/api/v2/data/*` endpoints retire **November 4, 2026, 23:59 UTC**.
This language-model importer uses only supported endpoints:

- Free: `/api/v2/language/models/free?page=N`
- Pro: `/api/v2/language/models?page=N`

The existing key continues to work. Free responses omit Pro-only fields; the
current sheet exports the common headline benchmarks, token pricing and median
performance. Pro opt-in selects the Pro endpoint but does not add Pro-only
columns. Pagination and Intelligence Index version are validated across pages.
The version is recorded per row to avoid comparing scores from different index
versions accidentally. Missing metrics stay blank; numeric zero stays zero.
**Cost Per Task** uses only `cost_per_task.total_cost`; full evaluation cost has
its own column and is never substituted for per-task cost.

OpenRouter prices are converted from USD/token to USD/million tokens. Pricing
overrides retain their complete JSON in native USD/token units, including time
windows and inclusive thresholds. Unknown moderation is blank, not "No".
API strings are escaped so they cannot become spreadsheet formulas.

References:
- https://artificialanalysis.ai/data-api/docs
- https://artificialanalysis.ai/data-api/migrate-v2-data
- https://openrouter.ai/docs/api/api-reference/models/get-models

## Local verification

From the repository root: `node --test gscripts/catalog.test.js`.
Tests use a mocked Apps Script runtime; they do not call paid APIs, modify a live
spreadsheet, or deploy. After installation, manually verify both menu items,
AA pagination, formatting, and refresh behavior in a test spreadsheet before
using scheduled triggers.

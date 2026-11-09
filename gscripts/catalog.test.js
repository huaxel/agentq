const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const { join } = require("node:path");
const { test } = require("node:test");
const vm = require("node:vm");

function runtime(responses = [], properties = {}) {
  const calls = [], writes = [], clears = [], sleeps = [], menu = [], toasts = [];
  let released = 0;
  const range = {
    setValues(values) { writes.push(values); return this; },
    clearContent() { clears.push(true); return this; },
    setFontWeight() { return this; }, setBackground() { return this; },
    setFontColor() { return this; }, setNumberFormat() { return this; },
  };
  const sheet = {
    getLastRow: () => 10, getLastColumn: () => 25,
    getMaxRows: () => 1000, getMaxColumns: () => 26,
    getRange: () => range, setFrozenRows() {}, autoResizeColumns() {},
  };
  const spreadsheet = {
    getSheetByName(name) { calls.push({ sheet: name }); return sheet; },
    toast(message) { toasts.push(message); },
    getActiveSheet() { throw new Error("Must not write to the active sheet"); },
  };
  const ui = { createMenu() { return this; },
    addItem(label, handler) { menu.push({ label, handler }); return this; }, addToUi() {} };
  const context = vm.createContext({
    SpreadsheetApp: { getActiveSpreadsheet: () => spreadsheet, getUi: () => ui },
    PropertiesService: { getScriptProperties: () => ({ getProperty: (key) => properties[key] }) },
    LockService: { getDocumentLock: () => ({ tryLock: () => true, releaseLock() { released++; } }) },
    Logger: { log() {} },
    Utilities: { sleep(ms) { sleeps.push(ms); }, formatDate: (date) => date.toISOString().slice(0, 10) },
    UrlFetchApp: { fetch(url, options) {
      calls.push({ url, options });
      const next = responses.shift();
      assert.ok(next, "Unexpected request");
      return { getResponseCode: () => next.status ?? 200,
        getContentText: () => next.raw ?? JSON.stringify(next.payload),
        getAllHeaders: () => next.headers ?? {} };
    } },
  });
  vm.runInContext(
    readFileSync(join(__dirname, "model-catalogs.gs"), "utf8"),
    context,
  );
  return { context, calls, writes, clears, sleeps, menu, toasts, released: () => released };
}

function aaPage(page, total, data) {
  return { payload: { intelligence_index_version: 4.1,
    pagination: { page, total_pages: total, has_more: page < total }, data } };
}

test("one menu with valid handlers for both importers", () => {
  const r = runtime();
  r.context.onOpen();
  assert.equal(r.menu.length, 2);
  for (const item of r.menu) assert.equal(typeof r.context[item.handler], "function");
});

test("AA paginates supported Free endpoint and distinguishes task vs total costs", () => {
  const r = runtime([
    aaPage(1, 2, [{ id: "a", name: "=IMPORTXML(\"evil\")", evaluations: { artificial_analysis_intelligence_index: 0 },
      artificial_analysis_intelligence_index_cost: { total_cost: 25 }, pricing: { price_1m_input_tokens: 0 } }]),
    aaPage(2, 2, [{ id: "b", performance: { median_time_to_first_answer_token_seconds: 0 },
      artificial_analysis_intelligence_index_cost: { total_cost: 50, cost_per_task: { total_cost: 0.2 } } }]),
  ], { AA_API_KEY: "existing-key" });
  r.context.fetchArtificialAnalysisData();
  const requests = r.calls.filter((c) => c.url);
  assert.deepEqual(requests.map((c) => c.url), [
    "https://artificialanalysis.ai/api/v2/language/models/free?page=1",
    "https://artificialanalysis.ai/api/v2/language/models/free?page=2",
  ]);
  assert.equal(requests[0].options.headers["x-api-key"], "existing-key");
  assert.deepEqual(r.calls.filter((c) => c.sheet), [{ sheet: "AA_fetch" }]);
  const [header, a, b] = r.writes[0];
  assert.equal(header.length, 19);
  assert.equal(a[0], "'=IMPORTXML(\"evil\")");
  assert.equal(a[4], 0); assert.equal(a[7], ""); assert.equal(a[8], 0);
  assert.equal(a[17], 4.1); assert.equal(a[18], 25);
  assert.equal(b[7], 0.2); assert.equal(b[14], 0);
  assert.deepEqual(r.sleeps, [150]);
  assert.equal(r.released(), 1);
});

test("AA Pro is explicit and configuration failure does not fetch or write", () => {
  const pro = runtime([aaPage(1, 1, [{ id: "a" }])], { AA_API_KEY: "key", AA_ACCESS: "pro" });
  pro.context.fetchArtificialAnalysisData();
  assert.equal(pro.calls[0].url, "https://artificialanalysis.ai/api/v2/language/models?page=1");
  for (const properties of [{}, { AA_API_KEY: "key", AA_ACCESS: "unknown" }]) {
    const r = runtime([], properties);
    assert.throws(() => r.context.fetchArtificialAnalysisData());
    assert.equal(r.calls.length, 0); assert.equal(r.writes.length, 0);
    assert.equal(r.released(), 1);
  }
});

test("AA rejects malformed, repeated, changing or unbounded pages before writing", () => {
  const cases = [
    [{ payload: { data: [{ id: "a" }] } }],
    [aaPage(1, 101, [{ id: "a" }])],
    [aaPage(1, 2, [] )],
    [aaPage(1, 2, [{ id: "a" }]), aaPage(1, 2, [{ id: "b" }])],
    [aaPage(1, 2, [{ id: "a" }]), aaPage(2, 2, [{ id: "a" }])],
    [aaPage(1, 2, [{ id: "a" }]), { payload: { ...aaPage(2, 2, [{ id: "b" }]).payload, intelligence_index_version: 5 } }],
    [aaPage(1, 1, [])],
    [aaPage(1, 2, [{ id: "a" }]), { status: 401, raw: "secret" }],
  ];
  for (const responses of cases) {
    const r = runtime(responses, { AA_API_KEY: "key" });
    assert.throws(() => r.context.fetchArtificialAnalysisData());
    assert.equal(r.writes.length, 0); assert.equal(r.clears.length, 0);
    assert.equal(r.released(), 1);
  }
});

test("OpenRouter preserves zero, blanks missing values, and retains override conditions", () => {
  const overrides = [{ min_prompt_tokens: 0, prompt: "0", utc_start: 100, utc_end: 600 }];
  const r = runtime([{ payload: { data: [{ id: "x", name: "+evil", created: 0,
    pricing: { prompt: "0", completion: "0.000002", input_cache_read: "not-a-price", overrides },
    description: "hello\nworld", reasoning: { supported_efforts: null },
    benchmarks: { artificial_analysis: { coding_index: 0 } } }] } }]);
  r.context.fetchOpenRouterModelsDetailed();
  assert.equal(r.calls[0].options.headers.Authorization, undefined);
  assert.equal(r.calls[1].sheet, "OR_fetch");
  const row = r.writes[0][1];
  assert.equal(row[2], "'+evil"); assert.equal(row[3], "1970-01-01");
  assert.equal(row[6], 0); assert.equal(row[7], 2); assert.equal(row[8], "");
  assert.equal(row[11], JSON.stringify(overrides)); assert.equal(row[13], 0);
  assert.equal(row[16], ""); assert.equal(row[20], ""); assert.equal(row[22], "hello world");
  assert.equal(r.clears.length, 2);
});

test("bounded transient retries respect Retry-After and omit sensitive error bodies", () => {
  const r = runtime([{ status: 429, headers: { "retry-after": "2" } }, { status: 503 },
    { payload: { data: [{ id: "x" }] } }], { OPENROUTER_API_KEY: "key" });
  r.context.fetchOpenRouterModelsDetailed();
  assert.deepEqual(r.sleeps, [2000, 2000]);
  assert.equal(r.calls[0].options.headers.Authorization, "Bearer key");
  for (const response of [{ status: 403, raw: "secret" }, { status: 410, raw: "secret" },
    { status: 429, headers: { "Retry-After": "600" } }, { raw: "not json" },
    { payload: { data: {} } }]) {
    const failure = runtime([response]);
    assert.throws(() => failure.context.fetchOpenRouterModelsDetailed(), (error) => !error.message.includes("secret"));
    assert.equal(failure.writes.length, 0); assert.equal(failure.released(), 1);
  }
  const exhausted = runtime([{ status: 500 }, { status: 500 }, { status: 500 }]);
  assert.throws(() => exhausted.context.fetchOpenRouterModelsDetailed(), /HTTP 500/);
  assert.equal(exhausted.calls.length, 3);
});

test("cell sanitation retains numeric values and escapes formula-like strings", () => {
  const r = runtime();
  for (const value of ["=1", " +1", "-1", "@formula", "\t=1"]) {
    assert.equal(r.context.catalogCell(value), `'${value}`);
  }
  assert.equal(r.context.catalogCell(-1), -1);
  assert.equal(r.context.catalogNumber(" "), "");
  assert.equal(r.context.catalogNumber(false), "");
});

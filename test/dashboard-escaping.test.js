'use strict';
/**
 * Regression tests for dashboard XSS hardening. The orchestrator dashboard
 * renders task-controlled data (prompts, dependency lists, ids) into
 * innerHTML, so every interpolation must pass through esc(). Run with
 * `npm test`.
 */
const { test } = require('node:test');
const assert = require('node:assert/strict');

const DASHBOARD_HTML = require('../src/interfaces/http/dashboard-html.js');

test('dashboard esc() escapes single quotes for onclick(\'...\') contexts', () => {
  // Task ids flow into onclick="fn('${esc(id)}')" — without &#39; a quote in
  // an id would break out of the JS string. Ids are server-generated today,
  // but the escaper must not rely on that.
  assert.ok(DASHBOARD_HTML.includes("replace(/'/g,'&#39;')"));
});

test('dashboard escapes the dependency list in the title attribute', () => {
  // depends_on is client-supplied at task creation; rendering it raw inside
  // title="..." would be stored XSS.
  assert.ok(DASHBOARD_HTML.includes('esc(deps.join'));
  assert.ok(!DASHBOARD_HTML.includes('Depends on: ${deps.join('));
});

test('dashboard passes ids via data attributes, never inline JS strings', () => {
  // HTML entities decode before JS runs, so no esc()-escaped value may sit
  // inside an onclick('...') string: ids travel in data-id (HTML-escaped)
  // and handlers read this.dataset.id. Status-derived class names allow
  // identifiers only; the priority value attribute is HTML-escaped.
  // (The export is the evaluated outer template, so inner client sinks
  // read as plain ${...} here; source uses \${...} to defer them.)
  assert.ok(DASHBOARD_HTML.includes('this.dataset.id'));
  assert.ok(!DASHBOARD_HTML.includes("showTaskDetail('${esc(t.id)}')"));
  assert.ok(!DASHBOARD_HTML.includes("showTaskDetail('${escJs(t.id)}')"));
  assert.ok(!DASHBOARD_HTML.includes("updatePriority('${esc(t.id)}'"));
  assert.ok(!DASHBOARD_HTML.includes("deleteTask('${esc(id)}')"));
  assert.ok(DASHBOARD_HTML.includes('escClass(t.status)'));
  assert.ok(DASHBOARD_HTML.includes('value="${esc(pri)}"'));
});

test('dashboard escapes task prompts, models, and event details', () => {
  for (const sink of ['esc(data.prompt)', 'esc(data.model', 'esc(detail)', 'esc(t.prompt)']) {
    assert.ok(DASHBOARD_HTML.includes(sink), `missing escaped sink: ${sink}`);
  }
});

test('dashboard escapes the status class fragment in task detail', () => {
  // The task detail badge interpolates the status into a class attribute.
  // The task table already uses escClass(t.status); the detail view must too,
  // or a hostile status value breaks out of the class="..." attribute
  // (stored XSS in the dashboard origin).
  assert.ok(DASHBOARD_HTML.includes('badge-${escClass(data.status)}'));
  assert.ok(!DASHBOARD_HTML.includes('badge-${data.status}"'));
});

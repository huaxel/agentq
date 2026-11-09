'use strict';
/**
 * The quota collector must never replace good data with an all-failure stub:
 * an all-failure stub would erase the only evidence routing has, so an empty
 * file would strand every 'auto' task. Run with
 * `npm test`.
 */
const { test } = require('node:test');
const assert = require('node:assert/strict');

const { resolveQuotaWrite, mergeQuotaPaths, queriesCodexbar } = require('../src/roi-tracker/collect/quota.js');

test('resolveQuotaWrite writes when the scan returned paths', () => {
  assert.equal(resolveQuotaWrite({ go: {} }, { go: {}, codex: {} }), 'write');
  assert.equal(resolveQuotaWrite(null, { go: {} }), 'write');
});

test('resolveQuotaWrite keeps last good data on an empty result', () => {
  assert.equal(resolveQuotaWrite({ go: {} }, {}), 'keep');
  assert.equal(resolveQuotaWrite({ go: {} }, null), 'keep');
});

test('resolveQuotaWrite flags first-run emptiness instead of silently stubbing', () => {
  assert.equal(resolveQuotaWrite(null, {}), 'empty');
  assert.equal(resolveQuotaWrite(null, null), 'empty');
});

test('mergeQuotaPaths preserves failed providers with original timestamps', () => {
  // A partial run (codex fresh, go failed) must keep go's last windows:
  // missing quota reads as AVAILABLE downstream, so dropping them would
  // route work onto a possibly saturated provider.
  const prev = {
    go: { windows: [{ label: 'monthly', usedPercent: 100 }], updatedAt: '2026-01-01T00:00:00.000Z' },
    codex: { windows: [{ label: '5-hour', usedPercent: 1 }], updatedAt: '2026-01-01T00:00:00.000Z' },
  };
  const next = { codex: { windows: [{ label: '5-hour', usedPercent: 2 }], updatedAt: '2026-02-01T00:00:00.000Z' } };
  const { paths, preserved } = mergeQuotaPaths(prev, next);
  assert.equal(preserved, 1);
  assert.equal(paths.go.windows[0].usedPercent, 100);
  assert.equal(paths.go.updatedAt, '2026-01-01T00:00:00.000Z');
  assert.equal(paths.codex.windows[0].usedPercent, 2);
});
test('queriesCodexbar skips providers routed to the local path', () => {
  // Self-hosted endpoints are recognized from config.providerPathMap, so an
  // invented host name needs no code change to be skipped.
  assert.equal(queriesCodexbar('homelab-llm', 'local'), false);
  assert.equal(queriesCodexbar('claude', 'claudemax'), true);
});

test('queriesCodexbar skips providers codexbar cannot query', () => {
  for (const provider of ['nan', 'fireworks', 'firepass', 'google', 'commandcode', 'cursor']) {
    assert.equal(queriesCodexbar(provider, `${provider}-path`), false, provider);
  }
});

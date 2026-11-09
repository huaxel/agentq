'use strict';
/**
 * Unit tests for lib/model-key.js — the join key every source folds to. Locks
 * in the cross-scheme bridge: provider prefix dropped, case/dots/underscores
 * normalized, and trailing variant + date suffixes stripped. Run `npm test`.
 */
const { test } = require('node:test');
const assert = require('node:assert/strict');

const { modelKey } = require('../src/lib/model-key.js');

test('folds case, dots, and underscores to a dashed lowercase key', () => {
  assert.equal(modelKey('Claude-Sonnet-4.6'), 'claude-sonnet-4-6');
  assert.equal(modelKey('claude_sonnet_4_6'), 'claude-sonnet-4-6');
});

test('drops agent/provider prefixes so slug/bare ids meet', () => {
  assert.equal(modelKey('[pi] deepseek-v4-flash'), 'deepseek-v4-flash');
  assert.equal(modelKey('[pi] deepseek/deepseek-v4-flash'), 'deepseek-v4-flash');
  assert.equal(modelKey('anthropic/claude-opus-4.8'), 'claude-opus-4-8');
  assert.equal(modelKey('openrouter/anthropic/claude-opus-4.8'), 'claude-opus-4-8');
  assert.equal(modelKey('claude-opus-4-8'), 'claude-opus-4-8');
});

test('strips trailing variant suffixes to the base model', () => {
  assert.equal(modelKey('claude-opus-4.8-fast'), 'claude-opus-4-8');
  assert.equal(modelKey('gpt-5.3-preview'), 'gpt-5-3');
  assert.equal(modelKey('some-model-thinking'), 'some-model');
  assert.equal(modelKey('some-model-free'), 'some-model');
});

test('strips an 8-digit date suffix but keeps other trailing numbers', () => {
  assert.equal(modelKey('claude-haiku-4-5-20251001'), 'claude-haiku-4-5');
  assert.equal(modelKey('model-1234'), 'model-1234');
});

test('coerces non-strings without throwing', () => {
  assert.equal(modelKey(undefined), 'undefined');
  assert.equal(modelKey(123), '123');
});

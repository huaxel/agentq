#!/usr/bin/env node
/**
 * Pricing collector — live list prices per model, from the sources a developer
 * actually shops across, keyed by the shared model key so they line up with the
 * benchmarks and your usage:
 *
 *   - OpenRouter   (api/v1/models)   — the metered marketplace price
 *   - OpenCode     (models.dev, the `opencode/*` provider) — the Go-wallet price
 *
 * Both are normalized to blended $/Mtok using config.costBlend (same blend as
 * the scoring), so "token-for-money" is directly comparable across sources and
 * against the xlsx list price you entered. Writes data/pricing.json.
 *
 * Usage:  node src/collect-pricing.js [--dry-run]
 */
const https = require('https');
const fs = require('fs');
const { modelKey } = require('../../lib/model-key.js');
const { homeDataPath, loadRoiConfig } = require('../../lib/home.js');


function getJson(url, extraOpts = {}) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, { timeout: 15000, ...extraOpts }, res => {
      if (res.statusCode !== 200) { res.resume(); return reject(new Error(`HTTP ${res.statusCode} ${url}`)); }
      let s = ''; res.on('data', d => s += d); res.on('end', () => {
        try { resolve(JSON.parse(s)); } catch (e) { reject(e); }
      });
    });
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.on('error', reject);
  });
}

const blendOf = (costBlend, p) =>
  costBlend.cache * (p.cache || 0) + costBlend.input * (p.input || 0) + costBlend.output * (p.output || 0);

// nan.builders access retired 2026-10: the key answers 401 since Aug and the
// provider is dormant (last usage Aug 1–3). No quota tier routes to nan by
// design, so there is no live source to collect — but pricing.json is joined
// at attribution time, so the already-collected nan entries are carried
// forward from the previous pricing file to keep historical nan usage priced.
function carryForwardNan(prevModels) {
  const models = {};
  for (const [k, v] of Object.entries(prevModels || {})) {
    if (v && v.nan) models[k] = { nan: v.nan };
  }
  return { models, count: Object.keys(models).length };
}

// Among OpenRouter variants sharing a key, prefer the canonical one (no -fast/
// -free/-turbo suffix, then shortest id) — that's the standard list price.
function pickCanonical(variants) {
  return variants.slice().sort((a, b) => {
    const sa = /-(fast|free|turbo)$/.test(a.id) ? 1 : 0;
    const sb = /-(fast|free|turbo)$/.test(b.id) ? 1 : 0;
    return sa - sb || a.id.length - b.id.length;
  })[0];
}

async function collectOpenRouter(costBlend) {
  const data = (await getJson('https://openrouter.ai/api/v1/models')).data || [];
  const byKey = {};
  for (const m of data) (byKey[modelKey(m.id)] ??= []).push(m);
  const out = {};
  for (const [key, variants] of Object.entries(byKey)) {
    const m = pickCanonical(variants);
    const pr = m.pricing || {};
    const p = {
      cache: +pr.input_cache_read * 1e6 || 0,
      input: +pr.prompt * 1e6 || 0,
      output: +pr.completion * 1e6 || 0,
      id: m.id,
    };
    p.blend = blendOf(costBlend, p);
    out[key] = p;
  }
  return out;
}

async function collectOpenCode(costBlend) {
  // models.dev costs are already per-Mtok. Prefer the `opencode` provider; fall
  // back to the direct anthropic/openai provider if OpenCode doesn't list it.
  const md = await getJson('https://models.dev/api.json');
  const pref = ['opencode'];
  const out = {};
  let opencodeProviderCount = 0;
  const add = (provId, mid, m) => {
    const key = modelKey(mid);
    if (!m.cost || (out[key] && !pref.includes(provId))) return;
    const p = {
      cache: m.cost.cache_read ?? 0, input: m.cost.input ?? 0,
      output: m.cost.output ?? 0, id: `${provId}/${mid}`,
    };
    p.blend = blendOf(costBlend, p);
    if (pref.includes(provId) || !out[key]) out[key] = p;
    if (provId === 'opencode') opencodeProviderCount++;
  };
  // First pass: opencode provider wins; second pass fills gaps from any provider.
  for (const provId of pref) for (const [mid, m] of Object.entries(md[provId]?.models || {})) add(provId, mid, m);
  for (const [provId, prov] of Object.entries(md))
    for (const [mid, m] of Object.entries(prov.models || {})) { const k = modelKey(mid); if (!out[k]) add(provId, mid, m); }
  return { models: out, total: Object.keys(out).length, opencodeProviderCount };
}

async function run() {
  const config = loadRoiConfig();
  const cb = config.costBlend;
  const result = { generatedAt: new Date().toISOString(), sources: {}, models: {} };

  const [or, oc] = await Promise.allSettled([collectOpenRouter(cb), collectOpenCode(cb)]);
  const openrouter = or.status === 'fulfilled' ? or.value : {};
  const opencodeResult = oc.status === 'fulfilled' ? oc.value : { models: {}, total: 0, opencodeProviderCount: 0 };
  const opencode = opencodeResult.models;
  result.sources.openrouter = or.status === 'fulfilled' ? `${Object.keys(openrouter).length} models` : `error: ${or.reason?.message ?? String(or.reason)}`;
  result.sources.opencode = oc.status === 'fulfilled'
    ? `${opencodeResult.opencodeProviderCount} models (opencode) + ${opencodeResult.total - opencodeResult.opencodeProviderCount} others (models.dev)`
    : `error: ${oc.reason?.message ?? String(oc.reason)}`;
  const nanResult = carryForwardNan(readPreviousModels());
  result.sources.nan = nanResult.count
    ? `${nanResult.count} models carried forward (provider retired 2026-10)`
    : 'no nan pricing data';

  const keys = new Set([...Object.keys(openrouter), ...Object.keys(opencode), ...Object.keys(nanResult.models || {})]);
  for (const k of keys) result.models[k] = { openrouter: openrouter[k] || null, opencode: opencode[k] || null, nan: (nanResult.models || {})[k] || null };
  return result;
}

async function main() {
  const result = await run();
  console.error('pricing sources:', result.sources);
  console.error(`merged ${Object.keys(result.models).length} model keys`);
  if (process.argv.includes('--dry-run')) return;
  const decision = resolvePricingWrite(readPreviousModels(), result.models);
  if (decision === 'keep') {
    console.error('refusing to overwrite data/pricing.json with an empty result — keeping last good data');
    process.exitCode = 1;
    return;
  }
  fs.writeFileSync(homeDataPath('pricing.json'), JSON.stringify(result, null, 2) + '\n');
  console.error('wrote data/pricing.json');
  if (decision === 'empty') process.exitCode = 1;
}

function readPreviousModels() {
  try {
    const prev = JSON.parse(fs.readFileSync(homeDataPath('pricing.json'), 'utf8'));
    return prev && prev.models ? prev.models : null;
  } catch { return null; }
}

// Decide what a collection result may do to data/pricing.json.
// A transient outage (DNS, down API) must never wipe the last known prices:
// an empty result keeps the previous file and fails loud. Returns 'write'
// (new data), 'keep' (empty result, previous exists), or 'empty' (empty
// result, nothing previous — stub is written so shape stays stable, flagged).
function resolvePricingWrite(prevModels, nextModels) {
  const nextKeys = nextModels ? Object.keys(nextModels).length : 0;
  if (nextKeys > 0) return 'write';
  const prevKeys = prevModels ? Object.keys(prevModels).length : 0;
  return prevKeys > 0 ? 'keep' : 'empty';
}

if (require.main === module) main().catch(e => { console.error(e.message); process.exit(1); });
module.exports = { run, resolvePricingWrite };

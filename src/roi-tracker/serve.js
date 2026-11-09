#!/usr/bin/env node
/**
 * Dashboard server — serve the rendered dashboard over HTTP (for viewing on
 * other devices via Tailscale). Zero dependencies (Node http).
 *
 * It is a VIEWER, not a collector: usage/quota come from each machine's own
 * ccusage/codexbar and are synced here via git (the per-machine bundles in
 * data/usage-imports/). This process only does the parts that need no host
 * tools — refresh live pricing (HTTP), re-score, re-render — then serves.
 *
 * On startup and every REFRESH_MINUTES it: best-effort `git pull`, refresh
 * pricing, run the pipeline, render. POST /refresh forces a rebuild.
 *
 * Env: PORT (default 8088), HOST (default 0.0.0.0), REFRESH_MINUTES (default
 *      30), GIT_PULL (1 to try), REFRESH_TOKEN (required for non-localhost
 *      /refresh — POST with an `X-Refresh-Token` header, never a URL query
 *      string, which would land in browser history / proxy logs / Referer
 *      headers). Non-localhost hosts require REFRESH_TOKEN by default; if
 *      none is set, /refresh is disabled (403) rather than accepting nothing.
 *
 * Usage:  node src/roi-tracker/serve.js   (or `npm run serve`, or via Docker)
 */
const http = require('http');
const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');

const { homeDataPath } = require('../lib/home.js');

const ROOT = path.join(__dirname, '..', '..');
/** The dashboard is generated data, so it lives in AGENTQ_HOME. */
const dashboardPath = () => homeDataPath('roi-dashboard.html');
const PORT = Number(process.env.PORT) || 8088;
const HOST = process.env.HOST || '0.0.0.0';
const REFRESH_MS = (Number(process.env.REFRESH_MINUTES) || 30) * 60_000;
const REFRESH_TOKEN = process.env.REFRESH_TOKEN || '';
// Require token for non-localhost by default; localhost-only needs no token.
// The same credential protects every mutating dashboard endpoint.
const isLocalhost = HOST === '127.0.0.1' || HOST === 'localhost' || HOST === '::1';
const MIN_MANUAL_REFRESH_MS = 5_000; // debounce: ignore /refresh spam
const MAX_BENCHMARK_BODY_BYTES = 64 * 1024;

function atomicWriteFile(filePath, content) {
  const tempPath = `${filePath}.tmp-${process.pid}-${Date.now()}`;
  try {
    fs.writeFileSync(tempPath, content);
    fs.renameSync(tempPath, filePath);
  } catch (err) {
    try { fs.unlinkSync(tempPath); } catch {}
    throw err;
  }
}

function authorizeMutation(req, res, { isLocalhost, refreshToken }) {
  if (refreshToken && req.headers['x-refresh-token'] !== refreshToken) {
    res.writeHead(403, { 'Content-Type': 'text/plain' });
    res.end('forbidden');
    return false;
  }
  if (!refreshToken && !isLocalhost) {
    res.writeHead(403, { 'Content-Type': 'text/plain' });
    res.end('mutations are disabled for non-localhost access: set REFRESH_TOKEN to enable them');
    return false;
  }
  return true;
}

const log = (...a) => console.error(new Date().toISOString(), ...a);

function gitPull() {
  return new Promise(resolve => {
    if (process.env.GIT_PULL !== '1') return resolve('skipped');
    execFile('git', ['pull', '--rebase', '--autostash'], { cwd: ROOT, timeout: 30_000 },
      err => {
        if (!err) return resolve('ok');
        const message = 'failed: ' + err.message.split('\n')[0];
        // A conflicting or killed (timeout) rebase leaves .git/rebase-merge
        // behind, wedging the bind-mounted host repo's own git pull/collect
        // loop until someone notices and repairs it manually. Best-effort
        // abort restores the pre-pull state (re-applying any autostash).
        execFile('git', ['rebase', '--abort'], { cwd: ROOT, timeout: 10_000 }, () => resolve(message));
      });
  });
}

function makeRebuild(state, { htmlPath = dashboardPath() } = {}) {
  return async function rebuild(reason) {
    if (state.building) return;
    state.building = true;
    try {
      const git = await gitPull();
      // Refresh live prices (pure HTTP — safe in a container, no host tools).
      // Never persist an empty result: an outage must not wipe last prices.
      try {
        const pricing = await require('./collect/pricing.js').run();
        if (Object.keys(pricing.models || {}).length) {
          atomicWriteFile(homeDataPath('pricing.json'), JSON.stringify(pricing, null, 2) + '\n');
        } else {
          log('pricing refresh returned no models (keeping last data/pricing.json)');
        }
      } catch (e) { log('pricing refresh failed (keeping last):', e.message); }
      // Score + render from the synced data.
      const pipeline = require('./pipeline.js');
      const out = pipeline.run();
      out.trend = pipeline.snapshotAndTrend(out); // also writes today's data/snapshots/<date>.json
      atomicWriteFile(homeDataPath('roi-output.json'), JSON.stringify(out, null, 2));
      atomicWriteFile(htmlPath, require('./render-html.js').page(out));
      state.lastBuilt = new Date().toISOString();
      state.lastError = null;
      log(`rebuilt (${reason}) — git ${git}, ${out.models.length} models, ${out.economics.length} paths`);
    } catch (e) {
      state.lastError = e.message;
      log('rebuild failed:', e.message);
    } finally {
      state.building = false;
    }
  };
}

/**
 * Build the request handler as a pure function of injected config/state, so
 * it's testable without a live network fetch, a real rebuild, or binding a
 * port. `state` is a shared mutable object rebuild() also writes into.
 */
function createRequestHandler({ isLocalhost, refreshToken, rebuild, state, htmlPath = dashboardPath(), minManualRefreshMs = MIN_MANUAL_REFRESH_MS }) {
  return async (req, res) => {
    const url = (req.url || '/').split('?')[0];

    if (url === '/healthz') {
      // A server that has never completed a build can't serve a real
      // dashboard (see the '/' 503 case below) — that's the one case worth
      // failing a Docker HEALTHCHECK over. A later refresh failing while a
      // prior build still exists just means the data is stale, not down.
      const healthy = state.lastBuilt !== null;
      res.writeHead(healthy ? 200 : 503, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({
        ok: !state.lastError, healthy, lastBuilt: state.lastBuilt, lastError: state.lastError, building: state.building,
      }));
    }

    if (url === '/refresh') {
      if (req.method !== 'POST') {
        res.writeHead(405, { 'Content-Type': 'text/plain', Allow: 'POST' });
        return res.end('POST required to refresh');
      }
      if (refreshToken) {
        // A token is configured — enforce it regardless of isLocalhost. An
        // operator who bound HOST to 127.0.0.1 behind a reverse proxy (TLS
        // termination, forwarding to loopback) and ALSO set REFRESH_TOKEN
        // wants that as defense in depth; isLocalhost alone must not bypass
        // an explicitly configured credential.
        // Header, not a URL query string — a query-string token ends up in
        // browser history, proxy/access logs, and Referer headers.
        if (req.headers['x-refresh-token'] !== refreshToken) {
          res.writeHead(403, { 'Content-Type': 'text/plain' });
          return res.end('forbidden');
        }
      } else if (!isLocalhost) {
        // No token configured and not localhost — no request could ever
        // prove itself. Say so plainly instead of a 405 that dangles an
        // unsatisfiable "add a token" hint.
        res.writeHead(403, { 'Content-Type': 'text/plain' });
        return res.end('refresh is disabled for non-localhost access: set REFRESH_TOKEN to enable it');
      }
      // else: localhost with no token configured — trusted, no checks.
      const now = Date.now();
      if (now - state.lastManualRefresh < minManualRefreshMs) {
        res.writeHead(429, { 'retry-after': '5' });
        return res.end('refresh throttled — try again shortly');
      }
      state.lastManualRefresh = now;
      await rebuild('manual');
      res.writeHead(303, { location: '/' });
      return res.end();
    }

    if (url === '/benchmark' && req.method === 'POST') {
      // Accept benchmark values for an unregistered model, append to
      // benchmark-inputs.json, then rebuild the dashboard. This is a
      // mutation just like /refresh, so it uses the same localhost/token gate.
      if (!authorizeMutation(req, res, { isLocalhost, refreshToken })) return;
      const contentLength = Number(req.headers['content-length']);
      if (Number.isFinite(contentLength) && contentLength > MAX_BENCHMARK_BODY_BYTES) {
        res.writeHead(413, { 'Content-Type': 'text/plain' });
        return res.end('benchmark body too large');
      }
      let body = '';
      let bodyBytes = 0;
      let tooLarge = false;
      req.on('data', c => {
        if (tooLarge) return;
        bodyBytes += c.length;
        if (bodyBytes > MAX_BENCHMARK_BODY_BYTES) {
          tooLarge = true;
          body = '';
          return;
        }
        body += c;
      });
      req.on('end', async () => {
        try {
          if (tooLarge) {
            res.writeHead(413, { 'Content-Type': 'text/plain' });
            return res.end('benchmark body too large');
          }
          const entry = JSON.parse(body);
          if (entry && entry.model != null) entry.model = String(entry.model).trim();
          // Validate: need at least a model name
          if (!entry || !entry.model) {
            res.writeHead(400, { 'content-type': 'application/json' });
            return res.end(JSON.stringify({ ok: false, error: 'model name required' }));
          }
          // Read existing benchmarks
          const bPath = homeDataPath('benchmark-inputs.json');
          let benchmarks = { models: [] };
          try { benchmarks = JSON.parse(fs.readFileSync(bPath, 'utf8')); } catch { /* start fresh */ }
          // Upsert: update fields for existing model, or append new one.
          const existingIdx = benchmarks.models.findIndex(m => m.model === entry.model);
          // Clean entry: keep only known fields, coerce numeric
          // Map from form field names to benchmark-inputs.json field names
          const fieldMap = {
            'INT': 'intRef', 'COD': 'aaCoding', 'AGE': 'aaAgentic',
            'GPQA': 'gpqa', 'HLE': 'hle', 'IFBench': 'ifBench',
            'AA-LCR': 'aaLcr', 'GDPval-AA': 'gdpval', 'SciCode': 'sciCode',
            'Terminal': 'terminalBench', 'AA-Omni': 'aaOmni',
            'speed': 'speed', 'cache': 'cachePrice', 'input': 'inputPrice',
            'output': 'outputPrice'
          };
          const fields = Object.keys(fieldMap);
          const cleaned = { model: entry.model };
          for (const f of fields) {
            const target = fieldMap[f];
            const raw = typeof entry[f] === 'string' ? entry[f].trim() : entry[f];
            if (raw === undefined || raw === null || raw === '') continue;
            // Every benchmark/pricing field is a non-negative number. Reject
            // garbage (non-numeric strings coerce to NaN, which serializes
            // to null and silently unscores a model) and negatives (which
            // would distort min-max normalization) instead of storing them.
            const n = Number(raw);
            if (!Number.isFinite(n) || n < 0) {
              res.writeHead(400, { 'content-type': 'application/json' });
              return res.end(JSON.stringify({ ok: false, error: `invalid non-negative number for ${f}: ${String(entry[f]).slice(0, 50)}` }));
            }
            cleaned[target] = n;
          }
          if (!cleaned.model) {
            res.writeHead(400, { 'content-type': 'application/json' });
            return res.end(JSON.stringify({ ok: false, error: 'model name required' }));
          }
          if (existingIdx !== -1) {
            // Merge new fields into existing entry (don't overwrite nulls)
            const existing = benchmarks.models[existingIdx];
            // Legacy per-subscription availability columns are dead: coverage
            // lives in config.paths[].models (src/lib/path-coverage.js). Drop
            // them on write instead of carrying them forward.
            for (const key of Object.keys(existing)) {
              if (/^on[A-Z]/.test(key)) delete existing[key];
            }
            for (const [fk, fv] of Object.entries(cleaned)) {
              if (fv !== null && fv !== undefined && fv !== '') existing[fk] = fv;
            }
          } else {
            benchmarks.models.push(cleaned);
          }
          atomicWriteFile(bPath, JSON.stringify(benchmarks, null, 2) + '\n');
          log(`benchmark ${existingIdx !== -1 ? 'updated' : 'added'}: ${cleaned.model}`);
          // Rebuild to pick up the new model
          await rebuild('benchmark-added');
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ ok: true, model: cleaned.model }));
        } catch (e) {
          res.writeHead(400, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ ok: false, error: e.message }));
        }
      });
      return;
    }

    if (url === '/benchmark-models') {
      // Return all models in benchmark-inputs with their current field values
      // so the frontend can pre-fill the form.
      const bPath = homeDataPath('benchmark-inputs.json');
      try {
        const data = JSON.parse(fs.readFileSync(bPath, 'utf8'));
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify(data.models));
      } catch {
        res.writeHead(500);
        res.end('[]');
      }
      return;
    }

    if (url === '/' || url === '/index.html') {
      fs.readFile(htmlPath, (err, buf) => {
        if (err) { res.writeHead(503); return res.end('dashboard not built yet'); }
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
        res.end(buf);
      });
      return;
    }

    res.writeHead(404); res.end('not found');
  };
}

function createServer(opts) {
  return http.createServer(createRequestHandler(opts));
}

if (require.main === module) {
  const state = { building: false, lastBuilt: null, lastError: null, lastManualRefresh: 0 };
  const rebuild = makeRebuild(state);
  const server = createServer({ isLocalhost, refreshToken: REFRESH_TOKEN, rebuild, state });

  (async () => {
    await rebuild('startup');
    setInterval(() => rebuild('interval'), REFRESH_MS);
    server.listen(PORT, HOST, () => {
      const addr = server.address();
      log(`serving dashboard on http://${HOST}:${addr.port} (refresh every ${REFRESH_MS / 60000}m)`);
    });
  })();
}

module.exports = {
  atomicWriteFile, createServer, createRequestHandler, makeRebuild };

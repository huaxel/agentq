/**
 * Values view — faithful port of ModelBenchmark_v4.xlsx "Values" sheet.
 *
 * A simpler, cost-blind PERF-vs-COST lens than Score v2 (which is profile- and
 * path-aware). Here every benchmark is normalized by its own column max raised
 * to the 1.5 power (rewarding being near the frontier), then averaged:
 *
 *   normBench = (raw / max(raw over column))^1.5     // blank raw -> 0
 *   AVER      = mean of the 11 normBench values       // includes the zeros
 *   PERF      = AVER / max(AVER)                       // 1.0 = best model
 *   MTOK      = 0.9174*cache + 0.0781*input + 0.044*output
 *   COST      = MTOK / MTOK(model with max AVER)       // 1.0 = best model's price
 *
 * So PERF=1, COST=1 is the top-scorer; cheap-and-strong models sit at high PERF
 * with COST < 1. Matches the xlsx exactly (see verify.js).
 */

const BENCHES = ['INT', 'COD', 'AGE', 'GPQA', 'HLE', 'IFBench', 'AA-LCR', 'GDPval-AA', 'SciCode', 'Terminal', 'AA-Omni'];

const num = v => (typeof v === 'number' && isFinite(v)) ? v : null;

function buildValues(rows, costBlend) {
  const { cache: wc, input: wi, output: wo } = costBlend;

  // Column maxima (MAX ignores blanks/text).
  const colMax = {};
  for (const b of BENCHES) {
    let m = -Infinity;
    for (const r of rows) { const v = num(r[b]); if (v != null && v > m) m = v; }
    colMax[b] = m === -Infinity ? null : m;
  }

  const out = rows.map(r => {
    // Per-bench power-1.5 normalization; blank raw -> 0 (matches Excel arithmetic).
    let sum = 0;
    for (const b of BENCHES) {
      const v = num(r[b]) ?? 0;
      const mx = colMax[b];
      const n = (mx && mx > 0) ? Math.pow(v / mx, 1.5) : 0;
      sum += n;
    }
    const aver = sum / BENCHES.length;
    const mtok = wc * (num(r.cache) ?? 0) + wi * (num(r.input) ?? 0) + wo * (num(r.output) ?? 0);
    return { model: r.model, speed: num(r.speed), aver, mtok };
  });

  // PERF normalized by max AVER; COST normalized by the MTOK of that same model.
  let best = null;
  for (const o of out) if (!best || o.aver > best.aver) best = o;
  const maxAver = best ? best.aver : 0;
  const refMtok = best ? best.mtok : 0;
  for (const o of out) {
    o.perf = maxAver > 0 ? o.aver / maxAver : null;
    o.cost = refMtok > 0 ? o.mtok / refMtok : null;
  }
  return out;
}

module.exports = { buildValues, BENCHES };

/**
 * Economics engine — faithful port of ModelBenchmark_v4.xlsx "Paths".
 *
 * Per access path, given { fee, allowance, valueRun, months } (valueRun =
 * list-$ of usage you pushed through it, from ccusage / pi / dashboards;
 * months = collection window in months), derive:
 *   covered, util, effMult, roi, status
 * and the effMults map that scoring.js consumes.
 *
 * effMult turns a model's list $/Mtok into effective $/Mtok on that path.
 * A wallet is UNDERWATER (ROI < 1) when you paid more than the list value run.
 *
 * valueRun and fee are both annualized via `months` so the comparison is
 * period-neutral: a 3-month window is not unfairly penalised vs a 12-month
 * window.
 */

/**
 * Materialize the payment schedule for a path.
 *
 * Returns the explicit `charges` array when present, otherwise generates one
 * from `recurring` — a list of subscription schedules, each:
 *   { start: 'YYYY-MM-DD', amount: <usd/mo>, firstAmount?: <prorated first charge> }
 * Charges are generated monthly from `start` (month-end clamping: 05-31 ->
 * 06-30 -> 07-31 -> 08-31), up to today (or the path endDate), so you declare
 * the cadence once instead of logging each payment. Example (OpenCode Go):
 *   recurring: [
 *     { start: '2026-05-31', amount: 10, firstAmount: 5 },  // sub 1, prorated
 *     { start: '2026-07-17', amount: 10 }                    // sub 2
 *   ]
 * -> charges 05-31:5, 06-30:10, 07-31:10, 07-17:10 (08-31/08-17 not due yet).
 * @param {object} p  path config
 * @param {string} [today8]  YYYYMMDD cutoff; defaults to today
 */
function scheduledCharges(p, today8 = new Date().toISOString().slice(0, 10).replace(/-/g, '')) {
  if (Array.isArray(p.charges) && p.charges.length) return p.charges;
  if (!Array.isArray(p.recurring) || !p.recurring.length) return [];
  const end8 = p.endDate ? String(p.endDate).replace(/-/g, '') : null;
  const out = [];
  for (const r of p.recurring) {
    if (!r || !r.start) continue;
    const startRaw = String(r.start).replace(/-/g, '');
    if (!/^\d{8}$/.test(startRaw)) continue;
    const y = +startRaw.slice(0, 4), mo = +startRaw.slice(4, 6) - 1, d = +startRaw.slice(6, 8);
    for (let n = 0; ; n++) {
      // Month-add with last-day clamping: JS Date.UTC rolls overflow FORWARD
      // (May 31 + 1mo -> Jul 1), but billing months clamp BACK (-> Jun 30).
      const tgtY = y + Math.floor((mo + n) / 12);
      const tgtM = ((mo + n) % 12 + 12) % 12;
      const lastDay = new Date(Date.UTC(tgtY, tgtM + 1, 0)).getUTCDate();
      const chargeDate = new Date(Date.UTC(tgtY, tgtM, Math.min(d, lastDay)));
      const c8 = chargeDate.toISOString().slice(0, 10).replace(/-/g, '');
      if (c8 > today8) break;                 // not due yet — don't charge the future
      if (end8 && c8 > end8) break;
      if (n === 0 && r.firstAmount != null) out.push({ date: c8, amount: r.firstAmount });
      else out.push({ date: c8, amount: r.amount });
    }
  }
  return out;
}

/**
 * Effective monthly fee for a path.
 *
 * If the path has charges (explicit `charges` or materialized `recurring`
 * schedules), the monthly fee is the total paid within
 * [startDate, endDate|now] divided by the window length. This models prorated
 * first charges and overlapping seat additions that a flat `fee` field cannot
 * (e.g. OpenCode Go: $5 on 05-31 + $10 on 06-30 + $10 on 07-31 + $10 on
 * 07-17 = $35 over 2.15 months -> $16.30/mo). Falls back to the flat `fee`
 * when neither is present.
 * @param {object} p  path config (fee, charges?/recurring?, startDate?, endDate?)
 * @param {number} [months]  window length in months (win); defaults to 1
 * @param {string} [today8]  YYYYMMDD cutoff; defaults to p.asOf or today
 */
function effectiveMonthlyFee(p, months = 1, today8 = p?.asOf) {
  const win = (typeof months === 'number' && months > 0) ? months : 1;
  const charges = scheduledCharges(p, today8);
  if (charges.length) {
    const startRaw = p.startDate ? String(p.startDate).replace(/-/g, '') : null;
    const end8 = p.endDate ? String(p.endDate).replace(/-/g, '') : null;
    let start8 = startRaw || '00000000';
    let total = 0;
    for (const c of charges) {
      if (!c || !c.date) continue;
      const d8 = String(c.date).replace(/-/g, '');
      if (!/^\d{8}$/.test(d8)) continue;
      // Window bound: startDate (or earliest charge) .. endDate (or today)
      if (d8 < start8) { if (!startRaw) start8 = d8; continue; }
      if (end8 && d8 > end8) continue;
      total += Number(c.amount) || 0;
    }
    return total / win;
  }
  return typeof p.fee === 'number' ? p.fee : 0;
}

function computePath(p) {
  const { type, allowance, valueRun, months } = p;
  const has = v => v !== null && v !== undefined && v !== '';
  const win = (typeof months === 'number' && months > 0) ? months : 1;
  const fee = effectiveMonthlyFee(p, win, p.asOf);

  let covered = null, util = null, effMult, roi, status;

  if (type === 'Local') {
    effMult = 0;
    roi = 'sunk';
    status = 'free at margin (your hardware)';
  } else if (type === 'Metered') {
    effMult = 1;
    roi = 'n/a';
    status = 'pay per token at list';
  } else if (type === 'Wallet') {
    const valueMonthly = has(valueRun) ? valueRun / win : null;
    covered = !has(valueRun) ? null : (has(allowance) ? Math.min(valueMonthly, allowance) : valueMonthly);
    if (has(allowance) && has(covered)) util = covered / allowance;
    effMult = (!has(valueRun) || !has(covered)) ? 1 : Math.min(fee / Math.max(covered, 0.0001), 1000);
    // A zero-fee wallet (e.g. an expired/complimentary sub) has nothing to
    // divide covered by: covered/0 is Infinity (serialized to null — reads as
    // "no data") or NaN if covered is also 0, and `NaN < 1` is false, so it
    // was always mislabeled "paying off". Treat it like Local/Metered: a
    // non-numeric roi string, which isUnderwater/breakEven already special-case.
    if (!has(valueRun)) {
      roi = null;
      status = 'enter Value run to activate';
    } else if (fee === 0) {
      roi = 'free';
      status = 'free (no fee)';
    } else {
      roi = covered / fee;
      // A canceled subscription (config endDate in the past) is history: the
      // ROI over its paid window is still shown for transparency, but the
      // wallet is never flagged underwater — you're not paying it anymore.
      const end8 = p.endDate ? String(p.endDate).replace(/-/g, '') : null;
      const today8 = new Date().toISOString().slice(0, 10).replace(/-/g, '');
      status = (end8 != null && end8 < today8)
        ? `canceled (${end8.slice(0, 4)}-${end8.slice(4, 6)}-${end8.slice(6, 8)})`
        : roi < 1 ? 'UNDERWATER — run more or cancel' : 'paying off';
    }
  } else {
    // Unknown type (config typo, etc.) — guard against undefined effMult/roi.
    // Config validation should catch this early, but if it slips through we
    // default to Metered-like passthrough so the rest of the pipeline doesn't
    // silently NaN out from an effMult of undefined.
    effMult = 1;
    roi = null;
    status = `unrecognized path type "${type}"`;
  }

  const materialized = p.recurring
    ? scheduledCharges(p, p.asOf)
    : (Array.isArray(p.charges) && p.charges.length ? p.charges : undefined);
  return { ...p, fee, ...(materialized ? { charges: materialized } : {}), covered, util, effMult, roi, status };
}

/**
 * @param {Array} paths  config.paths, optionally each with a `valueRun`.
 * @returns {{ rows: Array, effMults: Object }}
 */
function buildEconomics(paths) {
  const rows = paths.map(computePath);
  const effMults = {};
  for (const r of rows) effMults[r.id] = r.effMult;
  return { rows, effMults };
}

module.exports = { buildEconomics, computePath, effectiveMonthlyFee, scheduledCharges };

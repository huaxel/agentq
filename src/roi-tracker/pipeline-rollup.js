'use strict';

/**
 * Rollup math — quota window classification, subscription windows, and the
 * keep/review/cancel verdict. Pure functions over economics rows and machine
 * metadata; no I/O.
 */

const { parseDate8, date8, round2 } = require('./pipeline-util.js');

function quotaWindowKind(label) {
  const value = String(label || '').toLowerCase();
  if (/\bmonthly\b|\bmonth\b/.test(value)) return 'monthly';
  if (/\bweekly\b|\bweek\b/.test(value)) return 'weekly';
  if (/\b5\s*-?\s*hour\b|\b5h\b/.test(value)) return '5-hour';
  return null;
}

function quotaWindowMultiplier(label) {
  const kind = quotaWindowKind(label);
  if (kind === 'monthly') return 1;
  if (kind === 'weekly') return 30.44 / 7;
  if (kind === '5-hour') return (30.44 * 24) / 5;
  return null;
}

function preferredQuotaWindow(windows) {
  const priority = ['monthly', 'weekly', '5-hour'];
  for (const kind of priority) {
    const matches = (windows || []).filter(w => quotaWindowKind(w.label) === kind && Number(w.usedPercent) > 0);
    if (matches.length) return matches.reduce((best, w) => Number(w.usedPercent) > Number(best.usedPercent) ? w : best);
  }
  return null;
}

function windowMonths(machines, nowMs = Date.now()) {
  const sinces = (machines || []).map(m => m.since).filter(Boolean).sort();
  if (!sinces.length) return 1;
  const startMs = parseDate8(sinces[0]);
  if (startMs == null) return 1;
  const days = (nowMs - startMs) / 86_400_000;
  return Math.max(0.5, days / 30.44);
}

/**
 * Per-subscription window in months, based on its optional startDate and endDate.
 * If the sub provides a startDate (YYYYMMDD or YYYY-MM-DD), compute its
 * window from that date to now (or to endDate if provided). Otherwise fall back
 * to the global machine window so established subs with data stretching back to
 * the earliest collector "since" don't suddenly change their numbers.
 *
 * Minimum 1 day to avoid division-by-zero on same-day subs.
 */
function subMonths(sub, fallbackMonths, nowMs = Date.now()) {
  const startMs = parseDate8(sub.startDate);
  if (startMs == null) return fallbackMonths;
  let endMs = nowMs;
  const configuredEnd = parseDate8(sub.endDate);
  if (configuredEnd != null) endMs = Math.min(configuredEnd, nowMs);
  const days = (endMs - startMs) / 86_400_000;
  return Math.max(1 / 30.44, days / 30.44);
}

/**
 * Roll each paid subscription (fee > 0) up to a keep/cancel verdict that fuses
 * two signals: measured $ value-per-month (a FLOOR — misses cloud/other-machine
 * usage) and the account-wide quota % (the truth for rate-limited subs). So a
 * sub underwater on $ but heavily used by quota reads as "review", not "cancel".
 *
 * @param {Array} economics  Array of economics rows (each has id, fee, valueRun,
 *                           months, quota, etc.)
 * @param {Array} machines   Machine metadata for global window calculation
 * @param {Array} [pathUsageRecords]  Per-date, per-pathId cost records from pi
 *                           session scanner — used to compute current-period
 *                           valueRun for quota-adjusted ROI projection.
 */
function buildRollup(economics, machines, pathUsageRecords, nowMs = Date.now()) {
  const globalMonths = windowMonths(machines, nowMs);
  const today8 = date8(nowMs).replace(/-/g, '');

  /**
   * Compute the current billing period start for a subscription.
   * The quota is aligned to the billing cycle (e.g. monthly from startDate),
   * not a rolling 30-day window. Given a startDate like 20260531 (May 31),
   * the periods are: May 31→Jun 30, Jun 30→Jul 30, etc.
   * Returns the start of the current period as YYYY-MM-DD.
   */
  function currentPeriodStart(startRaw, nowMs) {
    const startMs = parseDate8(startRaw);
    if (startMs == null) return null;
    if (nowMs <= startMs) return date8(startMs);
    // Number of full monthly cycles between start and now. Clamp month-end
    // overflow (e.g. May 31 + 1 month) instead of letting Date roll to July.
    const startDate = new Date(startMs);
    let cycles = Math.floor((nowMs - startMs) / (30.44 * 86_400_000));
    while (cycles > 0) {
      const target = new Date(Date.UTC(startDate.getUTCFullYear(), startDate.getUTCMonth() + cycles + 1, 0));
      const candidate = Date.UTC(target.getUTCFullYear(), target.getUTCMonth(), Math.min(startDate.getUTCDate(), target.getUTCDate()));
      if (candidate <= nowMs) return date8(candidate);
      cycles--;
    }
    return date8(startMs);
  }

  // Helper to compute valueRun within the current quota/billing period for a
  // path. Date-only records are used only for monthly/weekly windows, whose
  // boundaries can be represented safely at day precision.
  function currentPeriodRun(pathRecs, startRaw, window, nowMs) {
    const periodStart = quotaPeriodStart(startRaw, window, nowMs);
    if (!periodStart) return null;
    let total = 0;
    for (const rec of pathRecs) {
      if (rec.date >= periodStart) total += rec.cost || 0;
    }
    return total;
  }

  function quotaPeriodStart(startRaw, window, nowMs) {
    const kind = quotaWindowKind(window?.label);
    if (kind === 'weekly') {
      const resetMs = Date.parse(window.resetsAt || '');
      const endMs = Number.isFinite(resetMs) && resetMs > nowMs ? resetMs : nowMs;
      return date8(endMs - 7 * 86_400_000);
    }
    if (kind === 'monthly') return currentPeriodStart(startRaw, nowMs);
    // Five-hour quota windows cannot be reconstructed from date-only usage
    // records without inventing intra-day precision; do not fabricate ROI.
    return null;
  }

  const subs = economics.filter(p => p.fee > 0).map(p => {
    // p.months was already computed per-sub (via subMonths) when the paths
    // were built in run(), before buildEconomics — reuse it here instead of
    // recomputing, so the rollup's ROI can never disagree with the economics
    // row's own ROI for the same sub.
    const months = p.months;
    const valueTotal = p.valueRun;
    const valuePerMonth = valueTotal == null ? null : round2(valueTotal / months);
    const roi = valuePerMonth == null ? null : round2(valuePerMonth / p.fee);
    // "Used %": choose the same preferred quota cadence used for the
    // projection (monthly > weekly > 5-hour), rather than maxing unrelated
    // windows together. Fall back to the busiest window only for unknown
    // cadence labels that cannot be projected.
    const bestWindow = preferredQuotaWindow(p.quota?.windows || []);
    const quotaPct = bestWindow ? Number(bestWindow.usedPercent) : (p.quota?.windows?.length ? Math.max(...p.quota.windows.map(w => w.usedPercent)) : null);
    const allowancePct = p.util != null ? Math.round(p.util * 100) : null;
    const usedPct = quotaPct ?? allowancePct;
    const usedSource = quotaPct != null ? 'rate-limit' : allowancePct != null ? 'allowance' : null;
    // Canceled = config endDate set and in the past.
    const end8 = p.endDate ? String(p.endDate).replace(/-/g, '') : null;
    const canceled = end8 != null && end8 < today8;

    // Quota-adjusted value: project the selected quota window to a monthly
    // equivalent before comparing it with the monthly subscription fee.
    let quotaValuePerMonth = null, quotaRoi = null;
    const sourcePath = p.sourcePath || p.id;
    const pathRecs = (pathUsageRecords || []).filter(r => r.pathId === sourcePath);
    const quotaKind = bestWindow ? quotaWindowKind(bestWindow.label) : null;
    const periodValue = bestWindow ? currentPeriodRun(pathRecs, p.startDate, bestWindow, nowMs) : null;
    // A period value is unavailable only for a monthly window on a sub with no
    // startDate (weekly windows always derive a period from resetsAt; 5-hour is
    // handled below). Fall back to the measured per-month value instead of the
    // full collection-window total, which can span several months and would
    // overstate the monthly quota projection.
    const recentValue = quotaKind === '5-hour' ? null : (periodValue != null ? periodValue : valuePerMonth);
    const multiplier = bestWindow ? quotaWindowMultiplier(bestWindow.label) : null;
    if (recentValue != null && bestWindow && multiplier != null && bestWindow.usedPercent > 0) {
      const fullQuotaValue = bestWindow.usedPercent >= 99.5
        ? recentValue
        : recentValue / (bestWindow.usedPercent / 100);
      quotaValuePerMonth = round2(fullQuotaValue * multiplier);
      quotaRoi = round2(quotaValuePerMonth / p.fee);
    }

    let verdict;
    if (canceled) verdict = 'canceled';
    else if (roi == null && usedPct == null) verdict = 'no-data';
    else if (roi != null && roi >= 1) verdict = 'keep';
    else if (usedPct != null && usedPct >= 50) verdict = 'review';
    else verdict = 'cancel';
    return { id: p.id, name: p.name, fee: p.fee, valueTotal, valuePerMonth, quotaValuePerMonth, roi, quotaRoi, usedPct, usedSource, verdict, canceled, endDate: p.endDate || null };
  });
  // Canceled subs (endDate in the past) are history: their value is still
  // shown, but they no longer contribute to the current monthly fee/value
  // burden — you're not paying them anymore.
  const activeSubs = subs.filter(s => !s.canceled);
  const feePerMonth = activeSubs.reduce((s, x) => s + x.fee, 0);
  const valuePerMonth = round2(activeSubs.reduce((s, x) => s + (x.valuePerMonth || 0), 0));
  return {
    windowMonths: round2(globalMonths),
    subs,
    totals: { feePerMonth, valuePerMonth, net: round2(valuePerMonth - feePerMonth) },
  };
}

module.exports = {
  quotaWindowKind,
  quotaWindowMultiplier,
  preferredQuotaWindow,
  windowMonths,
  subMonths,
  buildRollup,
};

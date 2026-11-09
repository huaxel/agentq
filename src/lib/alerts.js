/**
 * Underwater detection + break-even hints over the economics rows.
 *
 * A wallet is underwater when ROI < 1 — you paid the fee but pushed less list-$
 * of value through it. `breakEven` says what would flip it: how much more list-$
 * value-run you'd need, and the equivalent % more usage. If an allowance caps
 * the covered value below the fee, volume alone can't fix it (reachable: false).
 *
 * underwaterAlerts accepts an optional monthlyRoiMap (pathId → windowed ROI)
 * so that subs with short collection windows use their annualized ROI instead
 * of the raw covered/fee ratio. The breakEven calculation always uses raw
 * dollars (needUsd = fee - covered) regardless of windowing.
 */

const round2 = n => Math.round(n * 100) / 100;
const has = v => v != null && v !== '';

/** Numeric ROI strictly under 1 (string roi like 'sunk'/'n/a' is never underwater). */
function isUnderwater(row, effectiveRoi) {
  const roi = effectiveRoi ?? row.roi;
  return typeof roi === 'number' && roi < 1;
}

/**
 * @returns {{ needUsd: number, needPct: number|null, reachable: boolean } | null}
 *   null when the row isn't underwater (checks against the effective roi).
 */
function breakEven(row, effectiveRoi) {
  if (!isUnderwater(row, effectiveRoi)) return null;
  const { fee, covered, allowance, type } = row;
  const cov = has(covered) ? covered : 0;
  const capped = type === 'Wallet' && has(allowance) && allowance < fee;
  return {
    needUsd: round2(Math.max(0, fee - cov)),
    // Show at least 1% for any real positive gap, so a sub-0.5% shortfall on an
    // underwater wallet never reads as a misleading "+0% to break even".
    needPct: cov > 0 ? Math.max(1, Math.round((fee / cov - 1) * 100)) : null,
    reachable: !capped,
  };
}

/** Underwater rows, each with its break-even hint, for alerting/rendering.
 *  Reuses a breakEven the caller already attached to the row, else computes it.
 *
 * @param {Array} economics  Path economics rows
 * @param {Object} [monthlyRoiMap]  Optional map of pathId → windowed monthly ROI.
 *        When provided, the monthly ROI is used for underwater detection and the
 *        alert's roi field; the breakEven hint still uses raw dollars.
 */
function underwaterAlerts(economics, monthlyRoiMap = {}) {
  return economics
    .filter(r => {
      // Canceled subs (endDate in the past) are history — never flag them
      // underwater even if their paid-window ROI was < 1.
      const end8 = r.endDate ? String(r.endDate).replace(/-/g, '') : null;
      const today8 = new Date().toISOString().slice(0, 10).replace(/-/g, '');
      if (end8 != null && end8 < today8) return false;
      const effRoi = monthlyRoiMap[r.id] ?? r.roi;
      return isUnderwater(r, effRoi);
    })
    .map(r => ({
      id: r.id,
      name: r.name,
      fee: r.fee,
      covered: r.covered,
      roi: monthlyRoiMap[r.id] ?? r.roi,
      breakEven: r.breakEven ?? breakEven(r, monthlyRoiMap[r.id] ?? r.roi),
    }));
}

module.exports = { isUnderwater, breakEven, underwaterAlerts };

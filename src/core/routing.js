'use strict';

/**
 * Routing: rank runnable choices for a task's intelligence floor and the
 * current capacity state. Pure — no fs, no clock reads.
 *
 * Order is cheapest-first, then use-it-before-it-resets, then most intelligent,
 * then id. Cost leads because a saturated path costs nothing to skip while an
 * unused window is wasted capacity. "Cheapest" means pace-adjusted cost
 * (`effectiveCostPerMTok`): quota behind pace is cheap because it would reset
 * unused, quota ahead of pace is dear because spending it displaces later work.
 *
 * An intelligence ESTIMATE (src/core/aa-estimate.js) is eligible exactly like a
 * real score — the tier floor applies to the estimated value — but every reason
 * it produces says so, so a caller can never mistake it for a measured score.
 * `allowUnscored` still means "no intelligence at all", not "estimated".
 */

const { capacityFor } = require('./capacity.js');
const { shortlist } = require('./shortlist.js');

/**
 * genIntel floors per tier. Tunable: these are product judgement, not physics.
 * `small` work should not silently land on a frontier model, and `big` work
 * should not silently land on a cheap one.
 */
const TIER_FLOORS = { small: 30, medium: 38, big: 45 };

const ORDER = ['effectiveCostPerMTok asc', 'resetsAt asc', 'intelligence desc', 'id asc'];

/** Prefix of the routing reason a degraded (but still eligible) choice carries. */
const DEGRADED_REASON_PREFIX = 'path degraded: ';

/**
 * @typedef {object} RankedChoice
 * @property {string} id
 * @property {string} path Quota path id; dispatch, quota and health are keyed by it.
 * @property {string} pathName Display name of the active funding subscription, else `path`.
 * @property {number|null} intelligence Score or estimate; null when unknown.
 * @property {'roi'|'aa-estimate'|null} intelligenceSource
 * @property {number|null} aaIndex Exact AA Intelligence Index behind an estimate.
 * @property {{ n: number, r: number, rmse: number }|null} calibration
 * @property {number|null} costPerMTok
 * @property {'roi'|'aa-price'|null} costSource
 * @property {import('./capacity.js').QuotaPace|null} pace
 * @property {number|null} quotaPressure
 * @property {number|null} effectiveCostPerMTok costPerMTok × quotaPressure, or costPerMTok
 * @property {string} capacityState
 * @property {number|null} headroomPct
 * @property {string|null} resetsAt
 * @property {string|null} observedAt
 * @property {string|null} subscriptionState null when the catalog carries no subscription status
 * @property {string[]} reasons
 */

/**
 * @param {unknown} value
 * @returns {number|null}
 */
function numericOrNull(value) {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

/**
 * Cost adjusted by quota pace: cheap quota behind pace is cheaper than its
 * list price, scarce quota ahead of pace is dearer. Without a pace the list
 * price stands, so a path that reports no window keeps today's order.
 *
 * @param {number|null} costPerMTok
 * @param {number|null} quotaPressure
 * @returns {number|null}
 */
function effectiveCost(costPerMTok, quotaPressure) {
  const cost = numericOrNull(costPerMTok);
  const pressure = numericOrNull(quotaPressure);
  return cost !== null && pressure !== null ? cost * pressure : cost;
}

/**
 * `pace behind: 12% used, 40% of window elapsed (projected 30%)`. Only a
 * behind or ahead pace is worth a reason: an on-pace path is unremarkable.
 *
 * @param {import('./capacity.js').QuotaPace|null|undefined} pace
 * @returns {string|null}
 */
function paceReason(pace) {
  if (!pace || (pace.state !== 'behind' && pace.state !== 'ahead')) return null;
  const used = Math.round(pace.usedPct);
  const elapsed = Math.round(pace.elapsedPct);
  const projected = Math.round(pace.projectedPct);
  return `pace ${pace.state}: ${used}% used, ${elapsed}% of window elapsed (projected ${projected}%)`;
}

/**
 * Human text for an intelligence value, marked when it is an estimate:
 * `53.9` for a score, `≈53.9 (AA estimate, n=6, r=0.95)` for a fit.
 *
 * @param {number} intelligence
 * @param {'roi'|'aa-estimate'|null|undefined} source
 * @param {{ n: number, r: number }|null|undefined} calibration
 * @returns {string}
 */
function intelligenceText(intelligence, source, calibration) {
  const value = Number(intelligence.toFixed(1));
  if (source !== 'aa-estimate') return String(value);
  const n = calibration && Number.isFinite(calibration.n) ? calibration.n : null;
  const r = calibration && Number.isFinite(calibration.r) ? calibration.r.toFixed(2) : null;
  const detail = [n === null ? null : `n=${n}`, r === null ? null : `r=${r}`].filter(Boolean).join(', ');
  return `≈${value} (AA estimate${detail ? `, ${detail}` : ''})`;
}

/**
 * Sort key for an ISO timestamp: null/invalid sorts last.
 *
 * @param {string|null|undefined} value
 * @returns {number}
 */
function timeKey(value) {
  const ms = Date.parse(/** @type {string} */ (value));
  return Number.isFinite(ms) ? ms : Number.POSITIVE_INFINITY;
}

/**
 * Degraded paths sort after every healthy path, without disturbing the
 * existing cost → reset → intelligence → id order among healthy choices.
 *
 * @param {RankedChoice} choice
 * @param {Map<string, { state: string }>|null|undefined} health
 * @returns {number} 1 when the choice's path is degraded, else 0.
 */
function healthRank(choice, health) {
  if (!(health instanceof Map)) return 0;
  const entry = health.get(choice.path);
  return entry && entry.state === 'degraded' ? 1 : 0;
}

/**
 * @param {RankedChoice} a
 * @param {RankedChoice} b
 * @returns {number}
 */
function compareChoices(a, b) {
  const costA = a.effectiveCostPerMTok;
  const costB = b.effectiveCostPerMTok;
  if (costA !== costB) {
    if (costA === null) return 1;
    if (costB === null) return -1;
    return costA - costB;
  }
  const resetA = timeKey(a.resetsAt);
  const resetB = timeKey(b.resetsAt);
  if (resetA !== resetB) return resetA - resetB;
  const intelA = a.intelligence;
  const intelB = b.intelligence;
  if (intelA !== intelB) {
    if (intelA === null) return 1;
    if (intelB === null) return -1;
    return intelB - intelA;
  }
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

/**
 * @param {{
 *   catalog?: import('./catalog.js').CatalogEntry[],
 *   capacity?: Map<string, import('./capacity.js').CapacityEntry>|Record<string, import('./capacity.js').CapacityEntry>,
 *   tier?: string,
 *   minIntelligence?: number,
 *   allowUnknownCapacity?: boolean,
 *   allowUnscored?: boolean,
 *   pathHealth?: Map<string, { state: 'healthy'|'degraded', consecutive: number, lastFailureAt: string|null, reason: string|null }>|null,
 * }} [args]
 * @returns {{ choices: RankedChoice[], rejected: RankedChoice[], policy: { floor: number, order: string[] } }}
 */
function rank({
  catalog = [],
  capacity = null,
  tier,
  minIntelligence,
  allowUnknownCapacity = false,
  allowUnscored = false,
  pathHealth = null,
} = {}) {
  // Object.hasOwn, not `TIER_FLOORS[tier]`: a tier of 'constructor' or
  // 'toString' would otherwise yield a function floor and silently skip the
  // floor check (every `intelligence < fn` comparison is false).
  const tierFloor = typeof tier === 'string' && Object.hasOwn(TIER_FLOORS, tier) ? TIER_FLOORS[tier] : undefined;
  const floor = numericOrNull(minIntelligence) ?? tierFloor ?? TIER_FLOORS.medium;

  /** @type {RankedChoice[]} */
  const choices = [];
  /** @type {RankedChoice[]} */
  const rejected = [];

  for (const entry of catalog) {
    const cap = capacityFor(capacity, entry.path);
    const intelligence = numericOrNull(entry.intelligence);
    const item = {
      id: entry.id,
      path: entry.path,
      // Computed by the catalog, which owns the subscription status; routing
      // only carries it, so a hand-built catalog entry still shows its path.
      pathName: typeof entry.pathName === 'string' && entry.pathName ? entry.pathName : entry.path,
      intelligence,
      intelligenceSource: entry.intelligenceSource ?? null,
      aaIndex: numericOrNull(entry.aaIndex),
      calibration: entry.calibration ?? null,
      costPerMTok: numericOrNull(entry.costPerMTok),
      costSource: entry.costSource ?? null,
      pace: cap.pace ?? null,
      quotaPressure: numericOrNull(cap.quotaPressure),
      effectiveCostPerMTok: effectiveCost(entry.costPerMTok, cap.quotaPressure),
      capacityState: cap.state,
      headroomPct: cap.headroomPct,
      resetsAt: cap.resetsAt,
      observedAt: cap.observedAt,
      subscriptionState: entry.subscription ? entry.subscription.state : null,
      reasons: [],
    };

    // A cancelled, future or unconfigured subscription is never routable,
    // whatever its scores or leftover quota data say.
    const sub = entry.subscription;
    if (sub && sub.state !== 'active') {
      const detail = sub.state === 'ended' && sub.endDate
        ? ` (${sub.ids.join(', ')} ended ${sub.endDate.slice(0, 4)}-${sub.endDate.slice(4, 6)}-${sub.endDate.slice(6, 8)})`
        : sub.ids.length ? ` (${sub.ids.join(', ')})` : ` (no roi.config path funds ${entry.path})`;
      rejected.push({ ...item, reasons: [`subscription ${sub.state}${detail}`] });
      continue;
    }

    // An entry without a usable intelligence score cannot be floor-checked;
    // allowUnscored is the only way such an entry becomes eligible, and it
    // still sorts behind every scored choice (cost is null).
    if (intelligence === null) {
      if (!allowUnscored) {
        rejected.push({ ...item, reasons: ['unscored: no ROI score row'] });
        continue;
      }
      item.reasons.push('unscored: allowed, intelligence unknown');
    } else if (intelligence < floor) {
      rejected.push({
        ...item,
        reasons: [`intelligence ${intelligenceText(intelligence, item.intelligenceSource, item.calibration)} below floor ${floor}`],
      });
      continue;
    } else {
      item.reasons.push(
        `intelligence ${intelligenceText(intelligence, item.intelligenceSource, item.calibration)} >= floor ${floor}`,
      );
      // An AA list price is not a measured ROI cost, so the reason says so.
      if (item.costSource === 'aa-price' && item.costPerMTok !== null) {
        item.reasons.push(`cost $${item.costPerMTok.toFixed(2)}/MTok (AA list price)`);
      }
    }

    if (cap.state === 'saturated') {
      rejected.push({
        ...item,
        reasons: [...item.reasons, `capacity saturated: ${cap.headroomPct}% headroom`],
      });
      continue;
    }
    if (cap.state === 'unknown' && !allowUnknownCapacity) {
      rejected.push({
        ...item,
        reasons: [...item.reasons, `capacity unknown: ${cap.reason ?? 'no data'}`],
      });
      continue;
    }
    if (cap.state === 'unknown') {
      item.reasons.push(`capacity unknown: allowed (${cap.reason ?? 'no data'})`);
    } else {
      item.reasons.push(`capacity available: ${cap.headroomPct}% headroom`);
    }

    // Pace scales the cost; the reason says so in the same words the CLI and
    // the shortlist use, so the number is never unexplained.
    const paceText = paceReason(item.pace);
    if (paceText !== null) item.reasons.push(paceText);

    // A degraded path stays eligible — a wrong "no model" is worse than a
    // slow one — but it sorts after every healthy choice. The health verdict
    // (and its "Xm ago" text) is computed by src/core/path-health.js, so
    // rank() itself reads no clock.
    const degraded = pathHealth instanceof Map ? pathHealth.get(entry.path) : null;
    if (degraded && degraded.state === 'degraded') {
      item.reasons.push(`${DEGRADED_REASON_PREFIX}${degraded.reason}`);
    }

    choices.push(item);
  }

  choices.sort((a, b) => (healthRank(a, pathHealth) - healthRank(b, pathHealth)) || compareChoices(a, b));
  return { choices, rejected, policy: { floor, order: [...ORDER] } };
}

/**
 * The degraded (but still eligible) choices in a ranked result, as
 * `{ path, reason }`. One formatter for the CLI, the menu and the resolver,
 * so the marker text cannot drift from the routing reason.
 *
 * @param {Array<{ path?: string, reasons?: string[] }>} [choices]
 * @returns {Array<{ path: string, reason: string }>}
 */
function degradedMarkers(choices = []) {
  const markers = [];
  for (const choice of choices || []) {
    const reason = (choice?.reasons || []).find(
      (entry) => typeof entry === 'string' && entry.startsWith(DEGRADED_REASON_PREFIX),
    );
    if (reason) markers.push({ path: choice.path, reason });
  }
  return markers;
}

/**
 * Rank, then narrow the result to a shortlist of options.
 *
 * `options` is what a caller reasons about: a few choices that differ along
 * the axes that matter (src/core/shortlist.js). `default` is deliberately NOT
 * a decision — it is what "auto" would take, kept so an automatic dispatch has
 * something to run on. `choices` and `rejected` stay for inspection.
 *
 * @param {Parameters<typeof rank>[0]} [args]
 * @returns {{ options: ReturnType<typeof shortlist>, default: RankedChoice|null, choices: RankedChoice[], rejected: RankedChoice[], policy: { floor: number, order: string[] } }}
 */
function recommend(args) {
  const { choices, rejected, policy } = rank(args);
  return {
    options: shortlist(choices),
    default: choices.length ? choices[0] : null,
    choices,
    rejected,
    policy,
  };
}

module.exports = { TIER_FLOORS, ORDER, DEGRADED_REASON_PREFIX, intelligenceText, degradedMarkers, rank, recommend };

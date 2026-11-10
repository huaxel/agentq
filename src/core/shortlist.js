'use strict';

/**
 * Shortlist: the routing core's ranked choices, narrowed to the handful of
 * options a caller can actually weigh.
 *
 * agentq informs rather than chooses. rank() (src/core/routing.js) answers
 * "what is eligible, cheapest first"; that single answer is not a decision,
 * and the full ranked list is too long to reason about. shortlist() names the
 * few choices that differ along the axes that matter — price, intelligence,
 * quota about to reset, value — so the caller (a person or a main assistant)
 * picks and agentq dispatches and logs.
 *
 * Pure: no clock, no file system. Everything comes from rank()'s choices.
 *
 * Roles, in the order they are reported:
 *
 *   cheapest    lowest effectiveCostPerMTok — the pace-adjusted price floor,
 *               whatever health order says
 *   smartest    highest intelligence; a real score beats an estimate on a tie
 *   expiring    the most-behind path: among choices whose pace is `behind`,
 *               the lowest projectedPct, which is the most quota projected to
 *               go unused. Ties go to the earlier resetsAt. Absent when no
 *               choice is behind pace.
 *   best-value  highest intelligence / effectiveCostPerMTok among paid choices.
 *               A free (local) choice only qualifies when no paid choice
 *               exists. A choice that already earned a role is offered again
 *               only when nothing else qualifies, so the role shows a
 *               different trade-off whenever one exists.
 *
 * A choice that earns several roles is ONE option carrying all of them, and
 * the remaining slots are filled in rank order with role `alternative`.
 */

/** Roles in report order. An option's roles always follow this order. */
const ROLE_ORDER = ['cheapest', 'smartest', 'expiring', 'best-value'];

/** Role given to a filler option that won no role of its own. */
const ALTERNATIVE_ROLE = 'alternative';

/** How many options a caller gets by default. */
const DEFAULT_MAX = 4;

/**
 * @param {unknown} value
 * @returns {number|null}
 */
function finiteOrNull(value) {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

/** `-1|0|1` for finite-or-infinite numbers; NaN never reaches it. */
function compareNumbers(a, b) {
  if (a === b) return 0;
  return a < b ? -1 : 1;
}

/**
 * Pace-adjusted cost with an unknown price last: an unpriced choice is never
 * the cheapest. Routing always sets the field; the list price is the fallback
 * for a hand-built choice.
 */
function costKey(choice) {
  return finiteOrNull(choice.effectiveCostPerMTok)
    ?? finiteOrNull(choice.costPerMTok)
    ?? Number.POSITIVE_INFINITY;
}

/** Intelligence with an unknown score last: unscored never wins `smartest`. */
function intelligenceKey(choice) {
  return finiteOrNull(choice.intelligence) ?? Number.NEGATIVE_INFINITY;
}

/** Sort key for a reset timestamp: a missing or unparseable one sorts last. */
function timeKey(value) {
  const ms = typeof value === 'string' ? Date.parse(value) : Number.NaN;
  return Number.isFinite(ms) ? ms : Number.POSITIVE_INFINITY;
}

/** An AA-derived estimate, marked so it can never be read as a measurement. */
function isEstimate(choice) {
  return choice.intelligenceSource === 'aa-estimate';
}

/**
 * Value: intelligence per dollar, or -Infinity when the choice cannot have one
 * (unknown score or price).
 *
 * A free (local) path has no price to divide by, so its value is its
 * intelligence. The two are never compared: a free choice is only in the pool
 * when no paid choice exists.
 */
function valueKey(choice) {
  const intelligence = finiteOrNull(choice.intelligence);
  const cost = costKey(choice);
  if (intelligence === null || cost === Number.POSITIVE_INFINITY || cost < 0) return Number.NEGATIVE_INFINITY;
  return cost === 0 ? intelligence : intelligence / cost;
}

/** Cheapest first. */
function compareCheapest(a, b) {
  return compareNumbers(costKey(a), costKey(b));
}

/** Smartest first, and a measured score ahead of an estimate of the same value. */
function compareSmartest(a, b) {
  return compareNumbers(intelligenceKey(b), intelligenceKey(a))
    || compareNumbers(isEstimate(a) ? 1 : 0, isEstimate(b) ? 1 : 0);
}

/**
 * Most quota projected to go unused first: the lowest projection, then the
 * earlier reset. Candidates are already filtered to `behind` pace, so a
 * projection is present.
 */
function compareExpiring(a, b) {
  const projectedA = a.pace && finiteOrNull(a.pace.projectedPct);
  const projectedB = b.pace && finiteOrNull(b.pace.projectedPct);
  return compareNumbers(
    projectedA === null || projectedA === undefined ? Number.POSITIVE_INFINITY : projectedA,
    projectedB === null || projectedB === undefined ? Number.POSITIVE_INFINITY : projectedB,
  ) || compareNumbers(timeKey(a.resetsAt), timeKey(b.resetsAt));
}

/** Most intelligence per dollar first. */
function compareBestValue(a, b) {
  return compareNumbers(valueKey(b), valueKey(a));
}

/**
 * The winner of one role among `candidates` (given in rank order).
 *
 * Candidates that tie on the role's own comparison are separated by path: a
 * path already in the shortlist loses to one that is not, so the options stay
 * on distinct paths where the data allows it. Rank order breaks what is left.
 *
 * @param {any[]} candidates
 * @param {(a: any, b: any) => number} compare
 * @param {Set<string>} usedPaths
 * @returns {any|null}
 */
function pickRole(candidates, compare, usedPaths) {
  if (!candidates.length) return null;
  const ranked = candidates
    .map((entry, index) => ({ entry, index }))
    .sort((a, b) => compare(a.entry, b.entry) || a.index - b.index);
  const head = ranked[0].entry;
  const tied = ranked.filter((item) => compare(item.entry, head) === 0).map((item) => item.entry);
  return tied.find((choice) => !usedPaths.has(choice.path)) ?? tied[0];
}

/**
 * One option: the RankedChoice fields a caller needs, in the same wording, plus
 * the roles this choice plays. `roles` is sorted into report order.
 *
 * @param {any} choice
 * @param {string[]} roles
 * @returns {any}
 */
function toOption(choice, roles) {
  const roleRank = (role) => {
    const index = ROLE_ORDER.indexOf(role);
    return index === -1 ? ROLE_ORDER.length : index;
  };
  return {
    id: choice.id,
    path: choice.path,
    // The name is the catalog's; `path` stays the id the caller dispatches by.
    pathName: typeof choice.pathName === 'string' && choice.pathName ? choice.pathName : choice.path,
    roles: [...roles].sort((a, b) => roleRank(a) - roleRank(b)),
    intelligence: finiteOrNull(choice.intelligence),
    intelligenceSource: choice.intelligenceSource ?? null,
    costPerMTok: finiteOrNull(choice.costPerMTok),
    costSource: choice.costSource ?? null,
    // How a mix-derived cost was computed. Carried through, never recomputed:
    // the catalog owns the price, the mix and the allowance scale.
    costBasis: choice.costBasis ?? null,
    dataSharing: choice.dataSharing === true,
    effectiveCostPerMTok: finiteOrNull(choice.effectiveCostPerMTok),
    pace: choice.pace ?? null,
    quotaPressure: finiteOrNull(choice.quotaPressure),
    headroomPct: finiteOrNull(choice.headroomPct),
    resetsAt: typeof choice.resetsAt === 'string' ? choice.resetsAt : null,
    capacityState: typeof choice.capacityState === 'string' ? choice.capacityState : 'unknown',
    reasons: Array.isArray(choice.reasons) ? choice.reasons.slice() : [],
  };
}

/**
 * Up to `max` options, each naming the roles it plays.
 *
 * @param {any[]} choices ranked choices from src/core/routing.js `rank()`
 * @param {{ max?: number }} [options]
 * @returns {Array<{ id: string, path: string, pathName: string, roles: string[], intelligence: number|null, intelligenceSource: string|null, costPerMTok: number|null, costSource: string|null, costBasis: import('./catalog.js').CostBasis|null, dataSharing: boolean, effectiveCostPerMTok: number|null, pace: import('./capacity.js').QuotaPace|null, quotaPressure: number|null, headroomPct: number|null, resetsAt: string|null, capacityState: string, reasons: string[] }>}
 */
function shortlist(choices, { max = DEFAULT_MAX } = {}) {
  const ranked = Array.isArray(choices)
    ? choices.filter((choice) => choice && typeof choice === 'object')
    : [];
  const limit = Number.isFinite(max) ? Math.max(0, Math.floor(max)) : DEFAULT_MAX;
  if (!ranked.length || limit === 0) return [];

  /** @type {Array<{ entry: any, roles: string[] }>} */
  const picked = [];
  const usedPaths = () => new Set(picked.map((option) => option.entry.path));
  const isPicked = (choice) => picked.some((option) => option.entry.id === choice.id);

  /**
   * Give `role` to `choice`. A choice that already holds a role gains another
   * one on the SAME option; a new option is added only while there is room.
   */
  const assign = (choice, role) => {
    if (!choice) return;
    const existing = picked.find((option) => option.entry.id === choice.id);
    if (existing) {
      existing.roles.push(role);
      return;
    }
    if (picked.length < limit) picked.push({ entry: choice, roles: [role] });
  };

  // The price floor. Health order may have moved choices[0], so the cheapest
  // is found by cost, not by position.
  assign(pickRole(ranked, compareCheapest, usedPaths()), 'cheapest');

  // Only a scored choice can be the smartest one.
  const scored = ranked.filter((choice) => finiteOrNull(choice.intelligence) !== null);
  assign(pickRole(scored, compareSmartest, usedPaths()), 'smartest');

  // Quota behind pace will reset unused, so it is capacity the caller would
  // otherwise waste. The most-behind path is the strongest case for using it.
  const expiring = ranked.filter((choice) => choice.pace && choice.pace.state === 'behind');
  assign(pickRole(expiring, compareExpiring, usedPaths()), 'expiring');

  // Best value needs a score and a price. A free (local) path counts only when
  // there is no paid choice to compare it against.
  const priced = ranked.filter((choice) => valueKey(choice) !== Number.NEGATIVE_INFINITY);
  const paid = priced.filter((choice) => costKey(choice) > 0);
  const free = priced.filter((choice) => costKey(choice) === 0);
  const pool = paid.length ? paid : free;
  const unpicked = pool.filter((choice) => !isPicked(choice));
  assign(pickRole(unpicked.length ? unpicked : pool, compareBestValue, usedPaths()), 'best-value');

  // Fill the remaining slots in rank order, never past the choices we have.
  for (const choice of ranked) {
    if (picked.length >= limit) break;
    if (isPicked(choice)) continue;
    picked.push({ entry: choice, roles: [ALTERNATIVE_ROLE] });
  }

  return picked.map((option) => toOption(option.entry, option.roles));
}

module.exports = {
  ROLE_ORDER,
  ALTERNATIVE_ROLE,
  DEFAULT_MAX,
  shortlist,
};

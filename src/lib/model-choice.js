'use strict';

/**
 * The `model-chosen` task event, in one shape.
 *
 * Every path that resolves a model for a task records the same audit event:
 * MCP `dispatch_task` (src/interfaces/mcp/dispatch.js) and the local CLI claim
 * paths `run --id`, `run-next` and `drain` (src/queue/sources.js). The event
 * says which model runs, who picked it, what the shortlist said about it and
 * the tier it was chosen for, so `agentq show --id` and `review_task` read one
 * shape back whichever path claimed the task.
 *
 * This is a leaf (no product imports) so both layers can share it: the queue
 * may require lib, and so may every interface.
 *
 *   - 'caller': the caller named the model (`--model`, and not 'auto');
 *   - 'pinned': the task's stored concrete model was used as-is;
 *   - 'auto': the routing core picked it for a tier.
 */

/** The values `chosenBy` may take. */
const CHOSEN_BY = Object.freeze(['caller', 'pinned', 'auto']);

/**
 * The roles a model plays in the shortlist a routing decision returned.
 *
 * Empty when the model is not on it, and always empty for a model that was not
 * routed (a pin or a caller's pick is not re-routed). Reading the shortlist
 * only records which option was taken; it never changes the model.
 *
 * @param {Record<string, any>|null|undefined} decision a routing decision
 *   (`{ options: [{ id, roles }] }`), as returned by `recommend`
 * @param {string} model
 * @returns {string[]}
 */
function optionRoles(decision, model) {
  const options = Array.isArray(decision && decision.options) ? decision.options : [];
  const option = options.find((candidate) => candidate && candidate.id === model);
  return option && Array.isArray(option.roles) ? [...option.roles] : [];
}

/**
 * Shape one `model-chosen` payload.
 *
 * `tier` is the tier the model was chosen for (`null` when none was used) and
 * `dataSharing` is the catalog's flag for the model's path, recorded so a
 * later review can see what was sent where. Callers pass a concrete model:
 * this is the record of a decision, not of an unresolved 'auto'.
 *
 * @param {{
 *   model: string,
 *   chosenBy: 'caller'|'pinned'|'auto',
 *   roles?: string[],
 *   tier?: string|null,
 *   dataSharing?: boolean,
 * }} input
 * @returns {{ model: string, tier: string|null, chosenBy: string, roles: string[], dataSharing: boolean }}
 */
function modelChosenEvent({ model, chosenBy, roles = [], tier = null, dataSharing = false }) {
  if (typeof model !== 'string' || model === '') {
    throw new TypeError('model-chosen needs a concrete model id');
  }
  if (!CHOSEN_BY.includes(chosenBy)) {
    throw new TypeError(`model-chosen chosenBy must be one of ${CHOSEN_BY.join('|')}, got: ${chosenBy}`);
  }
  return {
    model,
    tier: typeof tier === 'string' && tier !== '' ? tier : null,
    chosenBy,
    roles: Array.isArray(roles) ? [...roles] : [],
    dataSharing: dataSharing === true,
  };
}

module.exports = { CHOSEN_BY, modelChosenEvent, optionRoles };

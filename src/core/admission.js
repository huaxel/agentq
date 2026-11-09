'use strict';

/**
 * agentq admission gate: pure pre-execution policy checks.
 *
 * The gate answers one question: may this job run at all, with these
 * capabilities? It performs no I/O and knows nothing about queues, sources or
 * sinks, so the same decision applies to the local queue and to jobs the
 * orchestrator already claimed remotely.
 *
 * Callers own the side effects of a refusal (releasing a remote claim,
 * throwing) so the policy itself stays testable in isolation.
 */

const { validateIssueJob } = require('./issue-input.js');

/**
 * Admission checks in the order they run. Names are stable identifiers for
 * tests and logs; the list is frozen so callers cannot reorder policy.
 */
const ADMISSION_CHECKS = Object.freeze([
  'cua-feedback-only',
  'feedback-prompt',
  'feedback-model',
  'trust',
  'issue-input',
]);

/**
 * @typedef {object} AdmissionCaps
 * @property {boolean} [cua] capabilities granted to this run
 * @property {string|boolean} [sandbox]
 * @property {boolean} [allowUntrusted]
 */

/**
 * @typedef {{ ok: true, job: object }} Admitted
 * @typedef {{ ok: false, reason: string, retryable: false, error?: Error }} Refused
 */

/**
 * Decide whether a job may execute.
 *
 * Checks, in order: (1) --cua only runs feedback jobs, (2) feedback needs a
 * prompt, (3) feedback needs a model, (4) the trust gate, (5) the pinned issue
 * input must validate. The job is never mutated; check (5) returns a copy with
 * the canonical `issue_input` when validation yields one.
 *
 * @param {object} job
 * @param {AdmissionCaps} caps
 * @returns {Admitted | Refused}
 */
function admit(job, caps) {
  if (caps.cua && job.kind !== 'feedback') {
    return { ok: false, reason: '--cua can run feedback jobs only.', retryable: false };
  }
  if (job.kind === 'feedback' && (typeof job.prompt !== 'string' || !job.prompt.trim())) {
    return { ok: false, reason: `Feedback job #${job.id} has no prompt payload.`, retryable: false };
  }
  if (job.kind === 'feedback' && (typeof job.model !== 'string' || !job.model.trim())) {
    return { ok: false, reason: `Feedback job #${job.id} has no model configured.`, retryable: false };
  }
  const trusted = job.trusted === 1 || job.trusted === true;
  if ((!trusted || job.kind === 'feedback') && !caps.sandbox && !caps.cua && !caps.allowUntrusted) {
    const reason = job.kind === 'feedback'
      ? `Refusing feedback job #${job.id} without --sandbox or --allow-untrusted. Feedback content is always untrusted.`
      : `Refusing untrusted job #${job.id} without --sandbox or --allow-untrusted. ` +
        `Issue text can contain arbitrary instructions; pi executes bash with your full user rights.`;
    return { ok: false, reason, retryable: false };
  }
  try {
    const input = validateIssueJob(job);
    return { ok: true, job: input ? { ...job, issue_input: input } : job };
  } catch (error) {
    // Preserve the original error object: callers rethrow it so its type and
    // extra properties (statusCode) survive the gate.
    return { ok: false, reason: error.message, retryable: false, error };
  }
}

module.exports = { admit, ADMISSION_CHECKS };

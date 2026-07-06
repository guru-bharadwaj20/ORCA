/**
 * The approval gate. Presents the plan + diagram, accepts user edits, and only lets
 * the pipeline proceed to build once the user approves. Nothing is built before this
 * returns an approved result.
 *
 * STAGE: 4 (plan) — headline feature: approve-before-build
 * Inputs: a `ServicePlan` and the run options (auto-approve short-circuits prompts).
 * Outputs: a `ReviewOutcome` — approved (possibly edited plan) or rejected.
 */

import type { ServicePlan } from './types.js';
import type { RunOptions } from '../core/context.js';

/** The result of the human review gate. */
export interface ReviewOutcome {
  approved: boolean;
  /** The plan to build — may differ from the input if the user made edits. */
  plan: ServicePlan;
  /** Optional reason when rejected. */
  reason?: string;
}

// TODO(stage-4): print the diagram + plan table, prompt for approve/edit/reject,
// apply any edits, and honor options.autoApprove.
export async function reviewPlan(
  _plan: ServicePlan,
  _options: RunOptions
): Promise<ReviewOutcome> {
  throw new Error('not implemented');
}

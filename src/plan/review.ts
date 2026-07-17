/**
 * The approval gate. Presents the plan + diagram and only lets the pipeline proceed
 * to build once the user approves. Nothing is built before this returns an approved
 * result. (Plan *editing* is deliberately out of scope for v1 — the outcome contract
 * supports it, but the gate is approve/reject only.)
 *
 * STAGE: 4 (plan) — headline feature: approve-before-build. REAL code.
 * Inputs: a `ServicePlan` and the run options (auto-approve short-circuits prompts).
 * Outputs: a `ReviewOutcome` — approved or rejected (with a reason).
 */

import { createInterface } from 'node:readline/promises';

import { renderPlanTable } from '../cli/output/index.js';
import type { RunOptions } from '../core/context.js';
import { renderDiagram } from './diagram.js';
import type { ServicePlan } from './types.js';

/** The result of the human review gate. */
export interface ReviewOutcome {
  approved: boolean;
  /** The plan to build — may differ from the input if the user made edits. */
  plan: ServicePlan;
  /** Optional reason when rejected. */
  reason?: string;
}

/** Injectable streams so the gate is testable and embeddable; defaults to the TTY. */
export interface ReviewIO {
  input?: NodeJS.ReadableStream;
  output?: NodeJS.WritableStream;
}

/** Render the human-readable plan summary: diagram source + service table. */
function renderSummary(plan: ServicePlan): string {
  return [
    '',
    `ORCA plan for ${plan.projectName} (source: ${plan.source})`,
    '',
    'Service graph (Mermaid — paste into https://mermaid.live to view):',
    '',
    renderDiagram(plan),
    '',
    renderPlanTable(plan),
    '',
    'Nothing has been built or run yet.',
    '',
  ].join('\n');
}

/**
 * Print the diagram + plan table and gate on approval. `--auto-approve` skips the
 * prompt; a non-interactive stdin (CI) without auto-approve rejects, never hangs.
 */
export async function reviewPlan(
  plan: ServicePlan,
  options: RunOptions,
  io: ReviewIO = {}
): Promise<ReviewOutcome> {
  const output = io.output ?? process.stdout;
  output.write(renderSummary(plan));

  if (options.autoApprove) {
    output.write('Plan auto-approved (--auto-approve).\n');
    return { approved: true, plan };
  }

  const input = io.input ?? process.stdin;
  const interactive = io.input !== undefined || (process.stdin.isTTY ?? false);
  if (!interactive) {
    return {
      approved: false,
      plan,
      reason: 'non-interactive session without --auto-approve',
    };
  }

  const rl = createInterface({ input, output });
  try {
    const answer = (await rl.question('Approve this plan and continue? [y/N] ')).trim();
    if (/^y(es)?$/i.test(answer)) {
      return { approved: true, plan };
    }
    return { approved: false, plan, reason: 'rejected by user at the approval gate' };
  } finally {
    rl.close();
  }
}

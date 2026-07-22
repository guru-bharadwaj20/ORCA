import { createInterface } from 'node:readline/promises';

import { renderPlanTable } from '../cli/output.js';
import type { RunOptions } from '../core/context.js';
import { renderDiagram } from './diagram.js';
import type { ServicePlan } from './types.js';

export interface ReviewOutcome {
  approved: boolean;
  plan: ServicePlan;
  reason?: string;
}

export interface ReviewIO {
  input?: NodeJS.ReadableStream;
  output?: NodeJS.WritableStream;
}

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

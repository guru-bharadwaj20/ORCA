import { createInterface } from 'node:readline/promises';

import { renderPlanTable } from '../cli/output.js';
import { loadSettings, type Settings } from '../config/settings.js';
import type { RunOptions } from '../core/context.js';
import { isolationArgs } from '../probe/sandbox.js';
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

/**
 * The tier-4 disclosure, shown at the gate when — and only when — probing is opted in.
 *
 * Security-contract clause 3 is "the user sees WHAT would be executed and WHY before
 * anything runs". `describeProbePlan` existed and was tested, but it was only ever LOGGED,
 * after approval and after the stack was already up: the user approved a plan without
 * being told that repo code would afterwards be executed. Approval is the only place this
 * disclosure means anything, so it belongs in the text the gate prints.
 *
 * Nothing is printed when probing is off, which is the default — a run that cannot probe
 * must not be made to look like one that can.
 */
function renderProbeNotice(settings: Settings): string {
  if (!settings.enableProbing) return '';
  const images = 'each service image built for this plan';
  return [
    '',
    'DYNAMIC PROBING IS ENABLED (tier 4, ORCA_ENABLE_PROBING).',
    `After the stack is healthy, ORCA will run ${images} once more in a throwaway,`,
    'isolated container to observe the ports it binds, the process it starts, and its',
    'first log lines. This EXECUTES the repository’s own code.',
    `Isolation: ${isolationArgs(settings).join(' ')}.`,
    'No host path is mounted; each container is removed afterwards.',
    'Approving this plan approves that too. Unset ORCA_ENABLE_PROBING to decline.',
  ].join('\n');
}

function renderSummary(plan: ServicePlan, settings: Settings): string {
  return [
    '',
    `ORCA plan for ${plan.projectName} (source: ${plan.source})`,
    '',
    'Service graph (Mermaid — paste into https://mermaid.live to view):',
    '',
    renderDiagram(plan),
    '',
    renderPlanTable(plan),
    renderProbeNotice(settings),
    '',
    'Nothing has been built or run yet.',
    '',
  ].join('\n');
}

export async function reviewPlan(
  plan: ServicePlan,
  options: RunOptions,
  io: ReviewIO = {},
  settings: Settings = loadSettings()
): Promise<ReviewOutcome> {
  const output = io.output ?? process.stdout;
  output.write(renderSummary(plan, settings));

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

import { PassThrough } from 'node:stream';
import { describe, expect, it } from 'vitest';

import { DEFAULT_RUN_OPTIONS, type RunOptions } from '../../src/core/context.js';
import { detectStack } from '../../src/detect/index.js';
import { buildServicePlan } from '../../src/plan/servicePlan.js';
import { reviewPlan } from '../../src/plan/review.js';
import { fileURLToPath } from 'node:url';

const options = (over: Partial<RunOptions> = {}): RunOptions => ({
  ...DEFAULT_RUN_OPTIONS,
  ...over,
});

async function mernPlan() {
  const detection = await detectStack(
    fileURLToPath(new URL('../fixtures/mern-repo', import.meta.url))
  );
  return buildServicePlan(detection, {});
}

async function runGate(answer: string | null, opts: RunOptions) {
  const input = new PassThrough();
  const output = new PassThrough();
  let printed = '';
  output.on('data', (chunk: Buffer) => (printed += chunk.toString()));

  const plan = await mernPlan();
  if (answer !== null) input.write(`${answer}\n`);
  const outcome = await reviewPlan(plan, opts, { input, output });
  return { outcome, printed, plan };
}

describe('reviewPlan approval gate', () => {
  it('prints the diagram + table and approves on "y"', async () => {
    const { outcome, printed, plan } = await runGate('y', options());

    expect(outcome).toEqual({ approved: true, plan });
    expect(printed).toContain('flowchart LR');
    expect(printed).toContain('Approve this plan and continue?');
    expect(printed).toContain('backend');
    expect(printed).toContain('Nothing has been built or run yet.');
  });

  it('rejects on anything that is not yes', async () => {
    const { outcome } = await runGate('n', options());

    expect(outcome.approved).toBe(false);
    expect(outcome.reason).toContain('rejected by user');
  });

  it('auto-approves without prompting when --auto-approve is set', async () => {
    const { outcome, printed } = await runGate(null, options({ autoApprove: true }));

    expect(outcome.approved).toBe(true);
    expect(printed).toContain('auto-approved');
    expect(printed).not.toContain('Approve this plan and continue?');
  });
});

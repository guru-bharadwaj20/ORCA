/**
 * Security-contract clause 3: "the user sees WHAT would be executed and WHY before
 * anything runs."
 *
 * `describeProbePlan` existed and was tested, but it was only ever LOGGED — after
 * approval, and after the stack was already up. The user approved a plan without being
 * told that repo code would afterwards be executed, which is the one moment the
 * disclosure is worth anything. It now goes in the text the approval gate prints.
 */
import { PassThrough } from 'node:stream';

import { describe, expect, it } from 'vitest';

import { DEFAULT_SETTINGS } from '../../src/config/settings.js';
import { DEFAULT_RUN_OPTIONS } from '../../src/core/context.js';
import { reviewPlan } from '../../src/plan/review.js';
import type { ServicePlan } from '../../src/plan/types.js';

const plan: ServicePlan = {
  projectName: 'orca-test',
  source: 'detected',
  services: [
    {
      id: 'backend',
      name: 'backend',
      kind: 'backend',
      source: { type: 'build', context: '.', dockerfile: 'Dockerfile' },
      ports: [{ host: 3000, container: 3000, protocol: 'tcp' }],
      environment: {},
      dependsOn: [],
      volumes: [],
    },
  ],
  networks: ['orca-net'],
  volumes: [],
} as unknown as ServicePlan;

/** Run the gate with auto-approve and capture what it printed. */
async function gateOutput(settings = DEFAULT_SETTINGS): Promise<string> {
  const output = new PassThrough();
  let text = '';
  output.on('data', (chunk: Buffer) => {
    text += chunk.toString();
  });

  await reviewPlan(plan, { ...DEFAULT_RUN_OPTIONS, autoApprove: true }, { output }, settings);
  return text;
}

describe('the approval gate discloses probing', () => {
  it('says nothing about probing when it is off', async () => {
    // The default. A run that cannot probe must not be made to look like one that can.
    const text = await gateOutput();

    expect(text).not.toMatch(/prob/i);
    expect(text).toContain('Nothing has been built or run yet.');
  });

  it('states plainly that repo code will be executed when probing is on', async () => {
    const text = await gateOutput({ ...DEFAULT_SETTINGS, enableProbing: true });

    expect(text).toContain('DYNAMIC PROBING IS ENABLED');
    // The honest sentence — this is what the user is actually consenting to.
    expect(text).toContain('EXECUTES the repository’s own code');
  });

  it('shows the isolation the container will run under', async () => {
    const text = await gateOutput({ ...DEFAULT_SETTINGS, enableProbing: true });

    expect(text).toContain('--network none');
    expect(text).toContain('--cap-drop ALL');
    expect(text).toContain('No host path is mounted');
  });

  it('tells the user how to decline', async () => {
    // Approving the plan approves probing, so declining has to be an available answer.
    const text = await gateOutput({ ...DEFAULT_SETTINGS, enableProbing: true });

    expect(text).toContain('Unset ORCA_ENABLE_PROBING to decline');
  });

  it('reflects a relaxed isolation setting rather than the default text', async () => {
    // The disclosure must describe the run the user is about to approve, not a generic one.
    const text = await gateOutput({
      ...DEFAULT_SETTINGS,
      enableProbing: true,
      probeNetwork: 'bridge',
      probeReadOnlyRootfs: false,
    });

    expect(text).toContain('--network bridge');
    expect(text).not.toContain('--read-only');
  });
});

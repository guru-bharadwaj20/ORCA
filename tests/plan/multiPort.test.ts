/**
 * End-to-end coverage for the multi-port data flow: detectPorts already surfaces every
 * EXPOSE'd port, but the plan/compose layer used to truncate to the first one when
 * building DockerfileVars/ServiceNode/the synthesized Dockerfile. This proves every
 * detected port reaches ServiceSpec.ports and the rendered compose/Dockerfile output —
 * not just detectPorts in isolation (see tests/detect/ports.test.ts for that).
 */
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import { detectStack } from '../../src/detect/index.js';
import { planToComposeVars } from '../../src/generate/composeVars.js';
import { buildServicePlan, refinedComponentVars } from '../../src/plan/servicePlan.js';
import { dockerfileFromVars } from '../../src/generate/dockerfileFromVars.js';
import { renderCompose } from '../../src/templates/render.js';

const fixture = (name: string): string =>
  fileURLToPath(new URL(`../fixtures/${name}`, import.meta.url));

describe('multi-port repos publish every detected port', () => {
  it('a backend with a multi-EXPOSE Dockerfile carries all ports through to the plan, compose, and Dockerfile output', async () => {
    const detection = await detectStack(fixture('multiport-express-repo'));

    expect(detection.backend).not.toBeNull();
    // detectPorts already returns both — this is the pre-existing, correct signal.
    expect(detection.backend?.ports.map((p) => p.port)).toEqual([3000, 9090]);

    const plan = buildServicePlan(detection, {});
    const backendNode = plan.services.find((s) => s.id === 'backend');
    expect(backendNode).toBeDefined();
    // The fix: ServiceNode.ports must carry both, not just the first.
    expect(backendNode?.ports).toEqual([
      { host: 3000, container: 3000, protocol: 'tcp' },
      { host: 9090, container: 9090, protocol: 'tcp' },
    ]);

    const vars = planToComposeVars(plan);
    const backendSpec = vars.services.find((s) => s.name === 'backend');
    expect(backendSpec?.ports).toEqual(['3000:3000', '9090:9090']);

    const composeText = renderCompose(vars);
    expect(composeText).toContain('"3000:3000"');
    expect(composeText).toContain('"9090:9090"');

    // The synthesized Dockerfile EXPOSEs both, not just the primary port.
    const dockerfileVars = refinedComponentVars(detection.backend!, 'backend', {});
    const dockerfileText = dockerfileFromVars(detection.backend!, dockerfileVars);
    expect(dockerfileText).toContain('EXPOSE 3000');
    expect(dockerfileText).toContain('EXPOSE 9090');
    // The primary port (index 0) still drives PORT/start-command concerns unchanged.
    expect(dockerfileVars.port).toBe(3000);
  });

  it('regression: a plain single-port backend (MERN) is unaffected — one EXPOSE, one published port', async () => {
    const detection = await detectStack(fixture('mern-repo'));
    expect(detection.backend?.ports.map((p) => p.port)).toEqual([3000]);

    const plan = buildServicePlan(detection, {});
    const backendNode = plan.services.find((s) => s.id === 'backend');
    expect(backendNode?.ports).toEqual([{ host: 3000, container: 3000, protocol: 'tcp' }]);

    const backendSpec = planToComposeVars(plan).services.find((s) => s.name === 'backend');
    expect(backendSpec?.ports).toEqual(['3000:3000']);

    const dockerfileVars = refinedComponentVars(detection.backend!, 'backend', {});
    const dockerfileText = dockerfileFromVars(detection.backend!, dockerfileVars);
    expect(dockerfileText).toContain('EXPOSE 3000');
    // Exactly one EXPOSE line — no accidental extra ports leaking in.
    expect(dockerfileText.match(/^EXPOSE /gm)).toHaveLength(1);
  });
});

/**
 * P0 acceptance test — a monorepo with 3+ same-role components must produce 3+ services
 * in the compose plan, with no ambiguous-* warning. This is the exact bug pickCandidate
 * used to have: it kept exactly one candidate per role and silently dropped the rest
 * behind a non-fatal `ambiguous-backend` warning. See src/detect/index.ts (components[]),
 * src/plan/servicePlan.ts (one ServiceNode per component, not per role).
 */
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import { detectStack } from '../../src/detect/index.js';
import { buildServicePlan } from '../../src/plan/servicePlan.js';

const fixture = (name: string): string =>
  fileURLToPath(new URL(`../fixtures/${name}`, import.meta.url));

describe('ACCEPTANCE: a monorepo with 3 same-role components', () => {
  it('detectStack surfaces all 3 backend components, not just 1', async () => {
    const result = await detectStack(fixture('multi-backend-repo'));

    const backends = result.components.filter((c) => c.role === 'backend');
    expect(backends.map((c) => c.rootDir).sort()).toEqual(['api', 'auth', 'orders']);

    // Nothing dropped, so no ambiguous-* warning - only the informational one.
    expect(result.warnings.some((w) => w.code.startsWith('ambiguous'))).toBe(false);
    expect(result.warnings).toContainEqual(
      expect.objectContaining({ code: 'multiple-backend-components' })
    );

    // The derived compat field still resolves to a sensible single primary (directory
    // hint: 'api' matches the server|backend|api|service convention).
    expect(result.backend?.rootDir).toBe('api');
  });

  it('buildServicePlan places all 3 as distinct backend services, not 1', async () => {
    const result = await detectStack(fixture('multi-backend-repo'));
    const plan = buildServicePlan(result, {});

    const backendServices = plan.services.filter((s) => s.kind === 'backend');
    expect(backendServices).toHaveLength(3);

    // The primary keeps the literal 'backend' id; the others are rootDir-derived and
    // unique - nothing collides, nothing was silently overwritten.
    expect(backendServices.map((s) => s.id).sort()).toEqual(['auth', 'backend', 'orders']);
    expect(backendServices.map((s) => s.componentRootDir).sort()).toEqual([
      'api',
      'auth',
      'orders',
    ]);

    // Each is independently buildable: its own context, its own Dockerfile.
    for (const svc of backendServices) {
      expect(svc.source.type).toBe('build');
      if (svc.source.type === 'build') {
        expect(svc.source.context).toBe(`./${svc.componentRootDir}`);
        expect(svc.source.dockerfile).toBe('Dockerfile'); // no rootDir collisions here
      }
    }
  });
});

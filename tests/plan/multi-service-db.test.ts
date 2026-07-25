/**
 * ACCEPTANCE (roadmap P0 "Route Node/Python through recipes", AC #3): a multi-service
 * Node repo must wire a database to EVERY service that needs one — the same way the
 * multi-service Go/Rust ecosystem fixtures already do.
 *
 * The roadmap item was originally framed as routing Node/Python through the generic
 * ecosystem/recipe path so servicePlan's N-component DB wiring would reach them. The
 * components[] P0 work (see src/detect/index.ts, src/plan/servicePlan.ts) reached the
 * same outcome through the SEED path instead: N same-role Node/Python components are all
 * placed, and every backend-role component gets the shared connection env + health-gated
 * depends_on. This test pins that behavior so the capability the roadmap item promised
 * stays covered, and documents WHY the two detection paths remain deliberately disjoint
 * (see the double-placement regression tests in tests/detect/detect.test.ts).
 */
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import { detectStack } from '../../src/detect/index.js';
import { buildServicePlan } from '../../src/plan/servicePlan.js';

const fixture = (name: string): string =>
  fileURLToPath(new URL(`../fixtures/${name}`, import.meta.url));

describe('ACCEPTANCE: a multi-service Node repo wires a DB to every service', () => {
  it('detects one postgres database from the shared `pg` dependency', async () => {
    const result = await detectStack(fixture('multi-backend-db-repo'));

    expect(result.databases).toEqual([
      { engine: 'postgres', defaultPort: 5432, detectedFrom: 'pg' },
    ]);
    // All three Express services are placed via the seed components[] path...
    expect(
      result.components
        .filter((c) => c.role === 'backend')
        .map((c) => c.rootDir)
        .sort()
    ).toEqual(['api', 'auth', 'orders']);
    // ...and NOT double-placed as ecosystem components (the two paths stay disjoint).
    expect(result.insights.ecosystemComponents).toEqual([]);
  });

  it('wires the postgres connection env + health-gated depends_on to all 3 services', async () => {
    const result = await detectStack(fixture('multi-backend-db-repo'));
    const plan = buildServicePlan(result, {});

    const backends = plan.services.filter((s) => s.kind === 'backend');
    expect(backends).toHaveLength(3);

    for (const svc of backends) {
      // Every service that needs a DB gets the same connection env, addressed at the
      // single detected db node — none is left orphaned.
      expect(svc.environment.POSTGRES_HOST).toBe('db');
      expect(svc.environment.POSTGRES_DB).toBe('orca');
      expect(svc.environment.POSTGRES_PORT).toBe('5432');
      // ...and a startup edge that waits for the db to be healthy.
      expect(svc.dependsOn).toContainEqual({ serviceId: 'db', condition: 'service_healthy' });
    }
  });
});

/**
 * `ServiceNode.id` is the compose service key; `ServiceNode.name` is the diagram's
 * display label. They hold the same string today only because every construction site
 * writes `name: id` — nothing enforces it, and `name` is documented as human-facing.
 *
 * Tier-4 probing looked its image up by `name` against a map `composeImages` keys by the
 * compose service, which worked purely by that coincidence. These pin the contract so the
 * coincidence cannot be relied on again: the compose key comes from `id`, and the day
 * `name` becomes a real display label the mapping still has to hold.
 */
import { describe, expect, it } from 'vitest';

import { planToComposeVars } from '../../src/generate/composeVars.js';
import type { ServiceNode, ServicePlan } from '../../src/plan/types.js';

function node(overrides: Partial<ServiceNode> = {}): ServiceNode {
  return {
    id: 'backend',
    name: 'backend',
    kind: 'backend',
    source: { type: 'build', context: './server', dockerfile: 'Dockerfile' },
    ports: [{ host: 3000, container: 3000, protocol: 'tcp' }],
    environment: {},
    dependsOn: [],
    volumes: [],
    ...overrides,
  };
}

function plan(services: ServiceNode[]): ServicePlan {
  return { projectName: 'orca-test', services, networks: ['orca-net'], volumes: [] };
}

describe('the compose service key is the node id', () => {
  it('uses id, not the display name', () => {
    // A node whose display name deliberately differs from its id — the shape that would
    // have silently broken the probe image lookup.
    const vars = planToComposeVars(plan([node({ id: 'api', name: 'Orders API' })]));

    expect(vars.services.map((s) => s.name)).toEqual(['api']);
  });

  it('keeps dependency edges pointing at ids too', () => {
    const vars = planToComposeVars(
      plan([
        node({ id: 'db', name: 'Postgres', kind: 'database' }),
        node({
          id: 'api',
          name: 'Orders API',
          dependsOn: [{ serviceId: 'db', condition: 'service_healthy' }],
        }),
      ])
    );

    const api = vars.services.find((s) => s.name === 'api');
    expect(api?.dependsOn).toEqual([{ service: 'db', condition: 'service_healthy' }]);
  });
});

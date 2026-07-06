/**
 * Computes correct startup ordering: backend depends_on database (service_healthy),
 * frontend depends_on backend, etc. Produces a topologically valid ordering and the
 * `depends_on` conditions used by compose.
 *
 * STAGE: 6 (orchestrate)
 * Inputs: a `ServicePlan`.
 * Outputs: the plan with dependency edges + a validated startup order (no cycles).
 */

import type { ServicePlan } from '../plan/types.js';

// TODO(stage-6): infer dependency edges and set the right depends_on conditions.
export function resolveDependsOn(_plan: ServicePlan): ServicePlan {
  throw new Error('not implemented');
}

// TODO(stage-6): topologically sort services; throw on a dependency cycle.
export function topologicalOrder(_plan: ServicePlan): string[] {
  throw new Error('not implemented');
}

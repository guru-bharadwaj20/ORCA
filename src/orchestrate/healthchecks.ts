/**
 * Derives sensible container healthchecks for known services (e.g. `pg_isready` for
 * Postgres, a mongo ping, an HTTP check for the backend) and attaches them to the plan.
 *
 * STAGE: 6 (orchestrate)
 * Inputs: a `ServicePlan`.
 * Outputs: the same plan with `healthcheck` populated where appropriate.
 */

import type { ServicePlan } from '../plan/types.js';

// TODO(stage-6): add engine-appropriate healthchecks to database/backend nodes.
export function applyHealthchecks(_plan: ServicePlan): ServicePlan {
  throw new Error('not implemented');
}

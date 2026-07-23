/**
 * The single owned mapping from the reviewable `ServicePlan` to the `ComposeVars`
 * render context the Stage 1 compose template consumes. Pure and mechanical — any
 * modelling decision belongs in the plan, not here, so the two service models
 * cannot drift apart silently.
 *
 * STAGE: 5 (generate) — REAL code, pulled forward with Stage 4.
 * Inputs: an approved `ServicePlan`.
 * Outputs: `ComposeVars` for `renderCompose()`.
 */

import type { ServicePlan, ServiceNode, VolumeMount } from '../plan/types.js';
import type { ComposeVars, ServiceSpec } from '../templates/types.js';

/** Compose volume string for each mount kind (anonymous = target only). */
function volumeString(mount: VolumeMount): string {
  return mount.kind === 'anonymous' ? mount.target : `${mount.source}:${mount.target}`;
}

function toServiceSpec(node: ServiceNode): ServiceSpec {
  const spec: ServiceSpec = {
    name: node.id,
    // The render contract only has frontend/backend/database. A cache renders like a
    // database; a generic ecosystem 'service' renders like a backend app service.
    kind: node.kind === 'cache' ? 'database' : node.kind === 'service' ? 'backend' : node.kind,
    ports: node.ports.map((p) => `${p.host}:${p.container}`),
    environment: node.environment,
    // Long form: startup conditions (service_healthy etc.) gate on healthchecks.
    dependsOn: node.dependsOn.map((dep) => ({ service: dep.serviceId, condition: dep.condition })),
    volumes: node.volumes.map(volumeString),
  };

  if (node.source.type === 'image') spec.image = node.source.image;
  else spec.build = { context: node.source.context, dockerfile: node.source.dockerfile };
  if (node.envFile !== undefined) spec.envFile = node.envFile;
  if (node.healthcheck !== undefined) spec.healthcheck = node.healthcheck;

  return spec;
}

/** Map an approved plan onto the compose template's render context. */
export function planToComposeVars(plan: ServicePlan): ComposeVars {
  return {
    projectName: plan.projectName,
    services: plan.services.map(toServiceSpec),
    networkName: plan.networks[0] ?? 'orca-net',
    namedVolumes: [...new Set(plan.volumes)],
  };
}

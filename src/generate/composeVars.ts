/**
 * The single owned mapping from the reviewable `ServicePlan` to the `ComposeVars`
 * render context the Stage 1 compose template consumes. Pure and mechanical — any
 * modelling decision belongs in the plan, not here, so the two service models
 * cannot drift apart silently.
 *
 * STAGE: 5 (generate) — REAL code, pulled forward with Stage 4.
 * Inputs: an approved `ServicePlan`.
 * Outputs: `ComposeVars` for `renderCompose()`.
 *
 * NOTE: dependency *conditions* are intentionally not mapped yet — the Stage 1
 * compose template renders short-form `depends_on`. Stage 6 extends the template
 * to the long form and starts consuming `ServiceDependency.condition`.
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
    // The render contract has no 'cache' kind; a cache renders like a database.
    kind: node.kind === 'cache' ? 'database' : node.kind,
    ports: node.ports.map((p) => `${p.host}:${p.container}`),
    environment: node.environment,
    dependsOn: node.dependsOn.map((dep) => dep.serviceId),
    volumes: node.volumes.map(volumeString),
  };

  if (node.source.type === 'image') spec.image = node.source.image;
  else spec.build = { context: node.source.context, dockerfile: node.source.dockerfile };
  if (node.healthcheck !== undefined) spec.healthcheck = node.healthcheck;
  if (node.command !== undefined) spec.command = node.command;

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

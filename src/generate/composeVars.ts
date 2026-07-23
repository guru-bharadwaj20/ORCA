import type { ServicePlan, ServiceNode, VolumeMount } from '../plan/types.js';
import type { ComposeVars, ServiceSpec } from '../templates/types.js';

function volumeString(mount: VolumeMount): string {
  return mount.kind === 'anonymous' ? mount.target : `${mount.source}:${mount.target}`;
}

function toServiceSpec(node: ServiceNode): ServiceSpec {
  const spec: ServiceSpec = {
    name: node.id,
    kind: node.kind === 'cache' ? 'database' : node.kind,
    ports: node.ports.map((p) => `${p.host}:${p.container}`),
    environment: node.environment,
    dependsOn: node.dependsOn.map((dep) => ({ service: dep.serviceId, condition: dep.condition })),
    volumes: node.volumes.map(volumeString),
  };

  if (node.source.type === 'image') spec.image = node.source.image;
  else spec.build = { context: node.source.context, dockerfile: node.source.dockerfile };
  if (node.envFile !== undefined) spec.envFile = node.envFile;
  if (node.healthcheck !== undefined) spec.healthcheck = node.healthcheck;

  return spec;
}

export function planToComposeVars(plan: ServicePlan): ComposeVars {
  return {
    projectName: plan.projectName,
    services: plan.services.map(toServiceSpec),
    networkName: plan.networks[0] ?? 'orca-net',
    namedVolumes: [...new Set(plan.volumes)],
  };
}

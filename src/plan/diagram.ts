/**
 * Renders a `ServicePlan` to a Mermaid diagram string so the user can eyeball the
 * service graph (nodes + dependency edges + exposed ports) before approving.
 *
 * STAGE: 4 (plan) — headline feature: approve-before-build diagram. REAL code.
 * Inputs: a `ServicePlan`.
 * Outputs: a Mermaid `flowchart` source string.
 */

import type { ServiceNode, ServicePlan } from './types.js';

/** Mermaid label text: name, what it is, and the published ports. */
function labelFor(node: ServiceNode): string {
  const what = node.source.type === 'image' ? node.source.image : `build ${node.source.context}`;
  const ports = node.ports.map((p) => `:${p.host}`).join(' ');
  return [node.name, `${node.kind} — ${what}`, ports].filter((line) => line !== '').join('<br/>');
}

/** Databases and caches render as cylinders; app services as rounded boxes. */
function shapeFor(node: ServiceNode, label: string): string {
  const escaped = label.replace(/"/g, '#quot;');
  return node.kind === 'database' || node.kind === 'cache'
    ? `${node.id}[("${escaped}")]`
    : `${node.id}("${escaped}")`;
}

/** Emit one Mermaid node per service and one labeled edge per dependency. */
export function renderDiagram(plan: ServicePlan): string {
  const lines = ['flowchart LR'];

  for (const node of plan.services) {
    lines.push(`  ${shapeFor(node, labelFor(node))}`);
  }
  for (const node of plan.services) {
    for (const dep of node.dependsOn) {
      lines.push(`  ${node.id} -->|${dep.condition}| ${dep.serviceId}`);
    }
  }

  return lines.join('\n');
}

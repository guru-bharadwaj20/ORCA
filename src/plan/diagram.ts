import type { ServiceNode, ServicePlan } from './types.js';

function labelFor(node: ServiceNode): string {
  const what = node.source.type === 'image' ? node.source.image : `build ${node.source.context}`;
  const ports = node.ports.map((p) => `:${p.host}`).join(' ');
  return [node.name, `${node.kind} — ${what}`, ports].filter((line) => line !== '').join('<br/>');
}

function shapeFor(node: ServiceNode, label: string): string {
  const escaped = label.replace(/"/g, '#quot;');
  return node.kind === 'database' || node.kind === 'cache'
    ? `${node.id}[("${escaped}")]`
    : `${node.id}("${escaped}")`;
}

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

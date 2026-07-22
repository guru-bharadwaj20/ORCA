import chalk from 'chalk';
import Table from 'cli-table3';

import type { ServiceNode, ServicePlan } from '../plan/types.js';
import type { DiagnosisEntry } from '../core/context.js';

function describeSource(node: ServiceNode): string {
  return node.source.type === 'image'
    ? node.source.image
    : `build ${node.source.context} (${node.source.dockerfile})`;
}

export function renderPlanTable(plan: ServicePlan): string {
  const table = new Table({ head: ['Service', 'Kind', 'Source', 'Ports', 'Depends on'] });
  for (const node of plan.services) {
    table.push([
      node.name,
      node.kind,
      describeSource(node),
      node.ports.map((p) => `${p.host}:${p.container}`).join(', '),
      node.dependsOn.map((d) => `${d.serviceId} (${d.condition})`).join(', ') || '—',
    ]);
  }
  return table.toString();
}

export function renderDiagnosisLog(entries: DiagnosisEntry[]): string {
  if (entries.length === 0) return '';

  const lines = [chalk.bold('Self-heal log:')];
  for (const entry of entries) {
    const outcome = entry.resolved
      ? chalk.green('resolved — the next attempt succeeded')
      : chalk.red('did not resolve the failure');
    lines.push(
      `  ${chalk.yellow(`Attempt ${entry.attempt}:`)} ${entry.explanation}`,
      `    Fix: ${entry.fix}` +
        (entry.changedFiles.length > 0
          ? chalk.dim(` (changed: ${entry.changedFiles.join(', ')})`)
          : ''),
      `    Outcome: ${outcome}`
    );
  }
  return `${lines.join('\n')}\n`;
}

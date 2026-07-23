import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

import type { DiagnosisEntry, RunContext } from 'orca-agent-cli';
import type { ServicePlan } from 'orca-agent-cli/plan';

const execFileAsync = promisify(execFile);

export interface ServiceUrl {
  name: string;
  url: string;
}

export function serviceUrls(plan: ServicePlan | undefined): ServiceUrl[] {
  const urls: ServiceUrl[] = [];
  for (const node of plan?.services ?? []) {
    if (node.kind !== 'frontend' && node.kind !== 'backend') continue;
    for (const port of node.ports) {
      urls.push({ name: node.name, url: `http://localhost:${port.host}` });
    }
  }
  return urls;
}

export function renderDiagnosisEntry(entry: DiagnosisEntry): string {
  const changed =
    entry.changedFiles.length > 0 ? ` (changed: ${entry.changedFiles.join(', ')})` : '';
  return `[self-heal] attempt ${entry.attempt}: ${entry.explanation}\n           fix: ${entry.fix}${changed}`;
}

export function observeDiagnosis(ctx: RunContext, log: (line: string) => void): void {
  const target = ctx.diagnosis;
  ctx.diagnosis = new Proxy(target, {
    get(source, prop, receiver): unknown {
      if (prop === 'push') {
        return (...entries: DiagnosisEntry[]): number => {
          for (const entry of entries) log(renderDiagnosisEntry(entry));
          return Array.prototype.push.apply(source, entries);
        };
      }
      return Reflect.get(source, prop, receiver);
    },
  });
}

export function isAbortError(err: unknown): boolean {
  if (typeof err !== 'object' || err === null) return false;
  const e = err as { name?: string; code?: string };
  return e.name === 'AbortError' || e.code === 'ABORT_ERR';
}

export function isPlanRejected(err: unknown): boolean {
  return (
    typeof err === 'object' && err !== null && (err as { code?: string }).code === 'PLAN_REJECTED'
  );
}

export async function stopStack(workspaceDir: string): Promise<void> {
  await execFileAsync('docker', ['compose', 'down', '--remove-orphans'], { cwd: workspaceDir });
}

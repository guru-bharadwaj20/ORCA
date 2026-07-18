/**
 * Pure helpers for the full-run command (Phase 6), kept free of the `vscode` API so
 * they stay unit-testable: service-URL derivation, live self-heal rendering, error
 * classification, and stopping a running stack. The editor orchestration (progress,
 * notifications, cancellation UI) lives in extension.ts.
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

import type { DiagnosisEntry, RunContext } from 'orca-agent-cli';
import type { ServicePlan } from 'orca-agent-cli/plan';

const execFileAsync = promisify(execFile);

/** A reachable service endpoint from a running stack. */
export interface ServiceUrl {
  name: string;
  url: string;
}

/** Localhost URLs for the frontend/backend services in a plan (dbs/caches excluded). */
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

/** One self-heal attempt, formatted for the output channel. */
export function renderDiagnosisEntry(entry: DiagnosisEntry): string {
  const changed =
    entry.changedFiles.length > 0 ? ` (changed: ${entry.changedFiles.join(', ')})` : '';
  return `[self-heal] attempt ${entry.attempt}: ${entry.explanation}\n           fix: ${entry.fix}${changed}`;
}

/**
 * Render each self-heal `DiagnosisEntry` to `log` as the pipeline appends it. Wraps
 * `ctx.diagnosis` in a proxy that intercepts `push`; all other array access is
 * untouched, so the pipeline's own reads/writes keep working.
 */
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

/** True for a run cancelled via the AbortSignal (from `throwIfAborted`). */
export function isAbortError(err: unknown): boolean {
  if (typeof err !== 'object' || err === null) return false;
  const e = err as { name?: string; code?: string };
  return e.name === 'AbortError' || e.code === 'ABORT_ERR';
}

/** True for the pipeline's typed "plan rejected at the gate" error. */
export function isPlanRejected(err: unknown): boolean {
  return (
    typeof err === 'object' && err !== null && (err as { code?: string }).code === 'PLAN_REJECTED'
  );
}

/** Stop a running stack: `docker compose down` in the run's workspace. */
export async function stopStack(workspaceDir: string): Promise<void> {
  await execFileAsync('docker', ['compose', 'down', '--remove-orphans'], { cwd: workspaceDir });
}

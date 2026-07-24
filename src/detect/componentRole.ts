/**
 * Role detection for components that are not web-shaped
 * (docs/universal-understanding-plan.md §2.3).
 *
 * ORCA's original model assumed every component is a `frontend` or a `backend` — i.e.
 * that everything listens on a port. Plenty of real repos do not: a Celery/Sidekiq/BullMQ
 * worker, a CLI published via npm's `bin`. Those still need containerizing, they just
 * must not be handed a fabricated published port.
 *
 * THE MASTER GATE IS "DOES IT LISTEN?". If a component declares a port anywhere real —
 * `.env`, a Dockerfile `EXPOSE`, or its own source — it is a service, whatever else it
 * looks like, and this module declines to reclassify it. That single rule is what keeps
 * a Django app that happens to depend on Celery from being demoted to a worker.
 *
 * `worker` and `cli` are decided here, by positive signals strong enough to act on
 * directly. `job` and `library` are decided by the `ROLE_DETECTORS` plugins in
 * `detectors/role.ts`, which this function consults once every rule below declines —
 * they rest on a scheduler signal and on pure absence of an entrypoint respectively, and
 * keeping them as `Detector`s means a further role is a new plugin, not a new branch.
 *
 * ORDER IS BEHAVIOR: positive evidence is checked before negative, so a component that
 * looks like a worker is never demoted to `library` merely for lacking an entry file.
 *
 * STAGE: 2 (detect) — REAL code. Pure signal matching, no AI.
 */

import { join } from 'node:path';

import { bestClaim, reasoning, type Claim } from '../model/claim.js';
import { ROLE_DETECTORS, hasWebDependency, hasWorkerDependency } from './detectors/role.js';

import { readPackageJson } from './manifest.js';
import { readFileIfExists } from '../utils/fs.js';
import type { RunnableRole } from './types.js';

/** A role assignment plus the evidence sentence that justifies it. */
export interface RoleDetection {
  role: RunnableRole;
  /** Human-readable justification, folded into the reasoning trail. */
  signal: string;
}

/** Facts the caller has already gathered at this component root. */
export interface RoleFacts {
  /** Direct dependency names at this root, across every ecosystem. */
  dependencies: readonly string[];
  /** Ports the root GENUINELY declares (see `declaredPorts`) — defaults excluded. */
  declaredPorts: readonly number[];
  /** The matched recipe's start command, when a recipe matched. */
  startCommand?: string;
}

/**
 * A start command that runs a queue consumer rather than a server. Deliberately narrow:
 * a bare mention of the word "queue" is not enough, the command has to name a worker
 * runner or point at a worker entrypoint file/module.
 */
const WORKER_COMMAND =
  /\b(?:celery|sidekiq|dramatiq|huey|resque|faktory)\b|\brq\s+worker\b|\bworker(?:\.[a-z]+)?\b|\bconsumer(?:\.[a-z]+)?\b/i;

/** Scripts that mean "this starts a long-lived server", which rules out `cli`. */
const SERVER_SCRIPTS = ['start', 'dev', 'serve'];

/**
 * Classify a component root as `worker` or `cli` when the evidence is unambiguous.
 * Returns null when it is not — the caller then keeps its existing default role, so a
 * repo ORCA already understood is never silently reclassified.
 */
export async function detectComponentRole(
  dir: string,
  facts: RoleFacts
): Promise<RoleDetection | null> {
  // Master gate: anything that genuinely declares a port is a service. No exceptions.
  if (facts.declaredPorts.length > 0) return null;

  // 1. A Procfile that declares a worker process and no web process is explicit intent.
  const procfile = await readFileIfExists(join(dir, 'Procfile'));
  if (procfile !== null) {
    const hasWeb = /^web:/m.test(procfile);
    const workerLine = /^(?:worker|consumer)[^:]*:\s*(.+)$/m.exec(procfile);
    if (!hasWeb && workerLine !== null) {
      return { role: 'worker', signal: 'Procfile declares a worker process and no web process' };
    }
  }

  // 2. The component's own start command runs a queue consumer.
  const pkg = await readPackageJson(dir);
  const scripts = pkg?.scripts ?? {};
  const candidates = [
    facts.startCommand,
    scripts['start'],
    scripts['dev'],
    scripts['worker'],
  ].filter((c): c is string => typeof c === 'string' && c.trim() !== '');
  const workerCommand = candidates.find((c) => WORKER_COMMAND.test(c));
  if (workerCommand !== undefined) {
    return { role: 'worker', signal: `start command runs a worker (\`${workerCommand}\`)` };
  }

  // 3. An npm package that ships a `bin` and has no server script is a CLI.
  if (pkg?.bin !== undefined && !SERVER_SCRIPTS.some((s) => typeof scripts[s] === 'string')) {
    const names = typeof pkg.bin === 'string' ? [pkg.name ?? 'binary'] : Object.keys(pkg.bin);
    return {
      role: 'cli',
      signal: `package.json declares bin (${names.join(', ')}) with no server script`,
    };
  }

  // 4. Weakest rule, last: a background-processing library with no web framework and no
  //    port anywhere. Suggestive enough to act on only once everything above is ruled out.
  const workerDep = hasWorkerDependency(facts.dependencies);
  if (workerDep !== null && !hasWebDependency(facts.dependencies)) {
    return {
      role: 'worker',
      signal: `background-processing dependency (${workerDep}) with no web framework or port`,
    };
  }

  // 5. Everything positive above declined. Hand off to the registered role detectors —
  //    `job` (scheduler signal) then `library` (no entrypoint at all). They are ordinary
  //    `Detector` plugins, so adding a further role is a new detector plus a registry
  //    entry rather than another branch here. `bestClaim` ranks them by confidence, which
  //    is what keeps positive evidence ahead of negative.
  const claims: Claim<RunnableRole>[] = [];
  for (const detector of ROLE_DETECTORS) {
    claims.push(
      ...((await detector.detect({ repoPath: dir, scopeDir: '.' })) as Claim<RunnableRole>[])
    );
  }
  const best = bestClaim(claims);
  return best === null ? null : { role: best.value, signal: reasoning(best).join('; ') };
}

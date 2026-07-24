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
 * Only `worker` and `cli` are assigned here. `library` and `job` exist in the type but
 * have no detector: `library` is identifiable only by the absence of an entrypoint, and
 * `job` is not separable from `worker` without a scheduler signal. Guessing either from
 * weak evidence is exactly what tier-3 AI inference is for.
 *
 * STAGE: 2 (detect) — REAL code. Pure signal matching, no AI.
 */

import { join } from 'node:path';

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
 * Background-processing libraries. A dependency on one of these is suggestive but never
 * sufficient on its own — a web app can enqueue jobs without being a worker — so it is
 * the weakest rule below and still requires the no-port gate plus no web framework.
 */
const WORKER_DEPENDENCIES = [
  // Python
  'celery',
  'rq',
  'dramatiq',
  'huey',
  // Node
  'bull',
  'bullmq',
  'bee-queue',
  'agenda',
  // Ruby
  'sidekiq',
  'resque',
  'delayed_job',
  // Go / Rust (module paths, matched by substring)
  'hibiken/asynq',
  'riverqueue/river',
  'gocraft/work',
  'lapin',
];

/** Web frameworks — their presence means "service", which vetoes the dependency rule. */
const WEB_DEPENDENCY = new RegExp(
  [
    'express',
    'fastify',
    'koa',
    'hapi',
    '@nestjs/core',
    'next',
    'django',
    'flask',
    'fastapi',
    'starlette',
    'rails',
    'sinatra',
    'laravel/framework',
    'symfony/',
    'gin-gonic/gin',
    'labstack/echo',
    'gofiber/fiber',
    'actix-web',
    'axum',
    'rocket',
    'spring-boot-starter-web',
  ]
    .map((name) => name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
    .join('|'),
  'i'
);

/**
 * A start command that runs a queue consumer rather than a server. Deliberately narrow:
 * a bare mention of the word "queue" is not enough, the command has to name a worker
 * runner or point at a worker entrypoint file/module.
 */
const WORKER_COMMAND =
  /\b(?:celery|sidekiq|dramatiq|huey|resque|faktory)\b|\brq\s+worker\b|\bworker(?:\.[a-z]+)?\b|\bconsumer(?:\.[a-z]+)?\b/i;

/** Scripts that mean "this starts a long-lived server", which rules out `cli`. */
const SERVER_SCRIPTS = ['start', 'dev', 'serve'];

function hasWorkerDependency(dependencies: readonly string[]): string | null {
  for (const dep of dependencies) {
    const name = dep.toLowerCase();
    const hit = WORKER_DEPENDENCIES.find((w) => name === w || name.includes(w));
    if (hit !== undefined) return dep;
  }
  return null;
}

function hasWebDependency(dependencies: readonly string[]): boolean {
  return dependencies.some((dep) => WEB_DEPENDENCY.test(dep));
}

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

  return null;
}

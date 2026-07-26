/**
 * Tier-1 component-role detectors on the evidence model (§2.3): `job` and `library`.
 *
 * These complete the role vocabulary. `worker` and `cli` are decided by positive,
 * unambiguous signals inside `componentRole.ts`; the two here are the awkward remainder:
 *
 *   - `job` rests on a SCHEDULER signal — a cron table, or a Procfile `release:` process
 *     with nothing long-lived beside it. That is positive evidence, just a different kind
 *     from "runs a queue consumer", so it ranks above `library`.
 *   - `library` rests on purely NEGATIVE evidence: a component with no entrypoint of any
 *     kind. Nothing to start means nothing to containerize as a service, so it is the
 *     lowest-confidence claim here and is only reached once every positive rule declines.
 *
 * Each is a standalone `Detector` returning `Claim`s — the Phase A/B plugin shape — so a
 * future role is a new file plus a registry entry, never another branch in a switch. They
 * are self-sufficient: a `Detector` receives only a `RepoContext`, so each reads the facts
 * it needs from disk and is correct when run in isolation.
 *
 * NOTE ON REGISTRATION: these now emit tagged `RoleFact` values, so they can safely share
 * `defaultDetectorRegistry()` with the runtime detectors — a consumer narrows to the kind
 * it wants via `claimsOfKind` and is unaffected by the rest. (Previously they had to keep
 * a separate `ROLE_DETECTORS` list, because untagged claims were recovered with an
 * unchecked cast that mixing kinds would have corrupted.) `ROLE_DETECTORS` remains as the
 * role-only view, for `detectComponentRole`, which wants exactly these two and no others.
 *
 * STAGE: 2 (detect) — REAL code. Pure signal matching, no AI.
 */

import { readdir } from 'node:fs/promises';
import { join } from 'node:path';

import { claim, type Claim, type Evidence } from '../../model/claim.js';
import type { Detector, RepoContext } from '../../model/detector.js';
import { roleFact, type RoleFact } from './facts.js';
import { readFileIfExists, walk } from '../../utils/fs.js';
import { readAllDependencies, readPackageJson } from '../manifest.js';
import {
  readGoDependencies,
  readJvmDependencies,
  readPhpDependencies,
  readRubyDependencies,
  readRustDependencies,
} from '../manifestExt.js';
import { declaredPorts } from '../ports.js';

/**
 * Background-processing libraries. A dependency on one is suggestive but never
 * sufficient on its own — a web app can enqueue jobs without being a worker.
 */
export const WORKER_DEPENDENCIES = [
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

/** Web frameworks — their presence means "service", which vetoes the quieter roles. */
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

/** The first worker library found among `dependencies`, or null. */
export function hasWorkerDependency(dependencies: readonly string[]): string | null {
  for (const dep of dependencies) {
    const name = dep.toLowerCase();
    const hit = WORKER_DEPENDENCIES.find((w) => name === w || name.includes(w));
    if (hit !== undefined) return dep;
  }
  return null;
}

/** True when any dependency names a web framework. */
export function hasWebDependency(dependencies: readonly string[]): boolean {
  return dependencies.some((dep) => WEB_DEPENDENCY.test(dep));
}

/** Cron tables a repo may ship at a component root. */
const CRON_FILES = ['crontab', '.crontab', 'crontab.txt', 'cron.yaml', 'cron.yml', 'cron.json'];

/**
 * Node entry files: their presence means the package is runnable, not consumed.
 */
const NODE_ENTRY_FILES = [
  'index.js',
  'index.mjs',
  'index.cjs',
  'server.js',
  'app.js',
  'main.js',
  'index.ts',
  'server.ts',
  'main.ts',
  'src/index.ts',
  'src/server.ts',
  'src/main.ts',
];

/** Python entry files: a runnable app rather than an importable package. */
const PYTHON_ENTRY_FILES = ['main.py', 'app.py', 'manage.py', 'wsgi.py', 'asgi.py', '__main__.py'];

/**
 * Scripts that mean "this starts a long-lived process". Exported so `componentRole.ts`
 * shares this exact list instead of independently redeclaring it — two copies of the
 * same list can silently drift (e.g. one gaining `preview` for Vite/Next apps but not
 * the other), desyncing role classification between the two call sites that are
 * supposed to agree.
 */
export const SERVER_SCRIPTS = ['start', 'dev', 'serve'];

/** Resolve a detector context to the absolute directory it should inspect. */
function dirOf(ctx: RepoContext): string {
  return ctx.scopeDir === '.' ? ctx.repoPath : join(ctx.repoPath, ctx.scopeDir);
}

/** True when `dir` contains a directory named `name`. */
async function hasDir(dir: string, name: string): Promise<boolean> {
  try {
    const entries = await readdir(dir, { withFileTypes: true });
    return entries.some((e) => e.isDirectory() && e.name === name);
  } catch {
    return false;
  }
}

/** The Procfile's declared process names, or [] when there is no Procfile. */
async function procfileProcesses(dir: string): Promise<string[]> {
  const raw = await readFileIfExists(join(dir, 'Procfile'));
  if (raw === null) return [];
  const names: string[] = [];
  for (const line of raw.split('\n')) {
    const match = /^([A-Za-z][\w-]*)\s*:\s*\S/.exec(line.trim());
    if (match?.[1] !== undefined) names.push(match[1].toLowerCase());
  }
  return names;
}

/** Direct dependencies across every ecosystem reader that applies at this root. */
async function dependenciesAt(dir: string): Promise<string[]> {
  const groups = await Promise.all([
    readAllDependencies(dir),
    readGoDependencies(dir),
    readRustDependencies(dir),
    readJvmDependencies(dir),
    readPhpDependencies(dir),
    readRubyDependencies(dir),
  ]);
  return [...new Set(groups.flat())];
}

/**
 * `job` — a component whose only declared process is scheduled or one-shot.
 *
 * Two accepted signals, both positive:
 *   1. A cron table at the component root.
 *   2. A Procfile declaring `release:` (or `cron:`/`scheduler:`) and NOTHING long-lived —
 *      no `web:`, no `worker:`. A `release:` beside a `web:` is a deploy hook for a
 *      service, not a job, so the absence of the long-lived process is what makes it one.
 *
 * Gated on declaring no port, like every other non-listening role.
 */
export const jobDetector: Detector<RoleFact> = {
  id: 'role:job',
  tier: 1,
  async detect(ctx: RepoContext): Promise<Claim<RoleFact>[]> {
    const dir = dirOf(ctx);
    if ((await declaredPorts(dir)).length > 0) return [];

    const evidence: Evidence[] = [];

    for (const name of CRON_FILES) {
      if ((await readFileIfExists(join(dir, name))) !== null) {
        evidence.push({
          detector: 'role:job',
          signal: `cron table '${name}' present`,
          weight: 0.75,
        });
        break;
      }
    }

    const processes = await procfileProcesses(dir);
    const longLived = processes.some(
      (p) => p === 'web' || p.startsWith('worker') || p.startsWith('consumer')
    );
    const scheduled = processes.filter((p) => p === 'release' || p === 'cron' || p === 'scheduler');
    if (!longLived && scheduled.length > 0) {
      evidence.push({
        detector: 'role:job',
        signal: `Procfile declares '${scheduled.join("', '")}' and no long-lived process`,
        weight: 0.75,
      });
    }

    if (evidence.length === 0) return [];
    return [claim<RoleFact>(roleFact('job'), evidence, 'deterministic')];
  },
};

/** Any of `files` present at `dir`. */
async function anyPresent(dir: string, files: readonly string[]): Promise<boolean> {
  for (const f of files) {
    if ((await readFileIfExists(join(dir, f))) !== null) return true;
  }
  return false;
}

/** True when any Go file under `dir` declares `package main` — i.e. it builds a binary. */
async function hasGoMainPackage(dir: string): Promise<boolean> {
  let files: string[];
  try {
    files = (await walk(dir)).filter((f) => f.endsWith('.go')).slice(0, MAX_SCANNED_GO_FILES);
  } catch {
    return false;
  }
  for (const file of files) {
    const raw = await readFileIfExists(file);
    if (raw !== null && /^package\s+main\b/m.test(raw)) return true;
  }
  return false;
}

/** Cap on Go files read while looking for `package main`. */
const MAX_SCANNED_GO_FILES = 200;

/**
 * Per-ecosystem "this is a library" rules. Each returns the evidence sentence when the
 * ecosystem's own convention says the component is importable rather than runnable, and
 * null when it says nothing either way.
 *
 * ECOSYSTEM-SPECIFIC ON PURPOSE. An earlier draft used one generic "no recognizable entry
 * file" rule and it mislabelled real services: a Maven app whose entry point is
 * `src/main/java/.../App.java` and a PHP app whose entry point is `public/index.php` both
 * came out as libraries, because the generic file list only knew Node/Go/Python
 * conventions. Negative evidence is only safe where the ecosystem has a positive
 * convention to read, so JVM, PHP, .NET, and Ruby DECLINE here rather than guess — which
 * is the same "leave it for tier 3" rule the rest of the detectors follow.
 */
const LIBRARY_RULES: readonly ((dir: string, deps: readonly string[]) => Promise<string | null>)[] =
  [
    // Node: a package with no `bin`, no server script, and no entry module.
    async (dir) => {
      const pkg = await readPackageJson(dir);
      if (pkg === null) return null;
      if (pkg.bin !== undefined) return null;
      if (SERVER_SCRIPTS.some((s) => typeof (pkg.scripts ?? {})[s] === 'string')) return null;
      if (await anyPresent(dir, NODE_ENTRY_FILES)) return null;
      return 'package.json declares no bin, no start/dev/serve script, and no entry module';
    },
    // Go: a module in which nothing declares `package main`, so it builds no binary.
    async (dir) => {
      if ((await readFileIfExists(join(dir, 'go.mod'))) === null) return null;
      if (await hasDir(dir, 'cmd')) return null;
      if (await hasGoMainPackage(dir)) return null;
      return 'go.mod present but no file declares `package main` and there is no cmd/';
    },
    // Rust: a crate with a lib target and no binary target.
    async (dir) => {
      const cargo = await readFileIfExists(join(dir, 'Cargo.toml'));
      if (cargo === null) return null;
      if (/^\s*\[\[bin\]\]/m.test(cargo)) return null;
      if ((await readFileIfExists(join(dir, 'src/main.rs'))) !== null) return null;
      if ((await readFileIfExists(join(dir, 'src/lib.rs'))) === null) return null;
      return 'Cargo.toml has a lib target (src/lib.rs) and no [[bin]] or src/main.rs';
    },
    // Python: a distributable package with no runnable module.
    async (dir) => {
      const packaged =
        (await readFileIfExists(join(dir, 'pyproject.toml'))) !== null ||
        (await readFileIfExists(join(dir, 'setup.py'))) !== null;
      if (!packaged) return null;
      if (await anyPresent(dir, PYTHON_ENTRY_FILES)) return null;
      return 'a packaged Python project with no runnable module (no main/app/manage/wsgi)';
    },
  ];

/**
 * `library` — a component the ecosystem's own conventions say is imported, not run.
 *
 * PURELY NEGATIVE EVIDENCE, which is why it ranks last, carries a low weight, and is
 * consulted only after every positive rule declines. A `library` publishes no port and
 * starts no process, so a false positive costs an inert node rather than a broken
 * container — but see `LIBRARY_RULES` for why the rules are per-ecosystem rather than one
 * generic heuristic.
 */
export const libraryDetector: Detector<RoleFact> = {
  id: 'role:library',
  tier: 1,
  async detect(ctx: RepoContext): Promise<Claim<RoleFact>[]> {
    const dir = dirOf(ctx);
    if ((await declaredPorts(dir)).length > 0) return [];
    if ((await procfileProcesses(dir)).length > 0) return [];

    const dependencies = await dependenciesAt(dir);
    if (hasWebDependency(dependencies)) return [];
    if (hasWorkerDependency(dependencies) !== null) return [];

    for (const rule of LIBRARY_RULES) {
      const signal = await rule(dir, dependencies);
      if (signal === null) continue;
      return [
        claim<RoleFact>(
          roleFact('library'),
          [{ detector: 'role:library', signal, weight: 0.45 }],
          'deterministic'
        ),
      ];
    }
    return [];
  },
};

/**
 * The role detectors, most-confident-first. Consumed by `detectComponentRole` after its
 * positive worker/cli rules decline; `bestClaim` picks the winner, so `job` (positive
 * evidence, weight 0.75) beats `library` (negative evidence, weight 0.45) whenever both
 * somehow apply.
 */
export const ROLE_DETECTORS: readonly Detector<RoleFact>[] = [jobDetector, libraryDetector];

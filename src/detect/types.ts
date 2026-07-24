/**
 * Shared data contract: the result of STAGE 2 (static, AI-free detection).
 *
 * STAGE: 2 (detect)
 * REAL CODE — this is the type every detector writes into and every later stage
 * (templates, AI, plan, build) reads from. It is intentionally complete and stable
 * up front so the rest of the pipeline can be built against it.
 *
 * Inputs (conceptual): a cloned repo directory on disk.
 * Outputs: a fully populated `DetectionResult` describing the repo's stack.
 *
 * SCOPE: ORCA only supports a narrow set of stacks. The union types below encode
 * that scope on purpose — anything outside it is represented as `'unknown'` plus a
 * human-readable entry in `warnings`.
 */

import type { PackageManager as BasePackageManager } from '../templates/types.js';

/**
 * Programming languages ORCA can reason about. The first three drive the seed stacks
 * end-to-end; the rest (Phase B) are recognized at the detection layer — surfaced in
 * `DetectionResult.languages` and routed to ecosystem `BuildRecipe`s — even before the
 * full containerize path supports them, so an unfamiliar repo is *classified*, never
 * silently dropped.
 */
export type Language =
  | 'javascript'
  | 'typescript'
  | 'python'
  | 'go'
  | 'rust'
  | 'java'
  | 'csharp'
  | 'php'
  | 'ruby'
  | 'unknown';

/**
 * Package managers ORCA can detect and drive. The open base taxonomy lives in
 * `templates/types.ts` (known members + extensible string); detection adds `'unknown'`
 * for a root whose manager couldn't be determined.
 */
export type PackageManager = BasePackageManager | 'unknown';

/** Supported frontend frameworks. */
export type FrontendFramework = 'react' | 'unknown';

/** Supported backend frameworks. */
export type BackendFramework = 'express' | 'django' | 'unknown';

/** Supported database / cache engines. */
export type DatabaseEngine = 'postgres' | 'mongodb' | 'redis';

/**
 * The high-level role a detected component plays in the app
 * (docs/universal-understanding-plan.md §2.3).
 *
 * The first three are the original web-shaped roles and are unchanged. The rest widen
 * the model to repos that are not web apps at all: a background `worker`, a `cli` binary,
 * a `library` package, a one-shot `job`. The distinction that matters downstream is that
 * only `frontend`/`backend` are assumed to LISTEN — the others get no default port (see
 * `defaultPortFor` in `ports.ts`) and publish none in the plan.
 *
 * `library` and `job` are currently type-only: they are part of the vocabulary so the
 * model can express them, but no deterministic detector assigns them yet. `library` is
 * detectable only by *negative* evidence ("no entrypoint anywhere"), which is precisely
 * the ambiguity that belongs to tier-3 AI inference; `job` is not separable from `worker`
 * without a scheduler signal. Both are left for a detector that has real evidence.
 */
export type ComponentRole =
  'frontend' | 'backend' | 'database' | 'worker' | 'cli' | 'library' | 'job';

/** The roles that describe a runnable component (everything except the database node). */
export type RunnableRole = Exclude<ComponentRole, 'database'>;

/** Roles ORCA expects to listen on a port. Everything else publishes none. */
export const LISTENING_ROLES: readonly ComponentRole[] = ['frontend', 'backend'];

/**
 * A network port a component listens on, together with how ORCA learned about it.
 * `source` lets the explainable log say *why* a port was chosen.
 */
export interface DetectedPort {
  /** The container-internal port number, e.g. 3000, 8000, 5432. */
  port: number;
  /** Transport protocol; ORCA only cares about tcp for supported stacks. */
  protocol: 'tcp' | 'udp';
  /** How the port was discovered, used by the explainable log. */
  source: 'default' | 'code' | 'env' | 'dockerfile' | 'readme' | 'inferred';
}

/** The command that starts a component and where it should run. */
export interface Entrypoint {
  /** Which component this entrypoint belongs to. */
  role: ComponentRole;
  /** The raw start command, e.g. `npm run dev` or `python manage.py runserver`. */
  command: string;
  /** Working directory (relative to repo root) the command should run in. */
  workingDir: string;
  /** How the entrypoint was discovered, used by the explainable log. */
  source: 'package-json-script' | 'procfile' | 'manage-py' | 'readme' | 'inferred';
}

/**
 * A detected application component. The seed-stack detectors only ever produce
 * `frontend`/`backend`; the wider roles arrive via `insights.ecosystemComponents`, which
 * is why this is now the full runnable set rather than the old two-member `Extract`.
 */
export interface DetectedComponent {
  role: RunnableRole;
  /** Path to the component root, relative to the repo root (`.` for single-package repos). */
  rootDir: string;
  language: Language;
  packageManager: PackageManager;
  /** The framework detected for this component, if any. */
  framework: FrontendFramework | BackendFramework | 'unknown';
  /** Direct dependency names read from the manifest (package.json / requirements.txt). */
  dependencies: string[];
  /** Ports this component is believed to listen on. */
  ports: DetectedPort[];
  /** The command that starts this component, if one was found. */
  entrypoint: Entrypoint | null;
}

/** A detected database or cache dependency the app needs to run. */
export interface DetectedDatabase {
  engine: DatabaseEngine;
  /** The default port for this engine (5432 / 27017 / 6379). */
  defaultPort: number;
  /** The dependency/library that revealed this database (e.g. `pg`, `mongoose`, `psycopg2`). */
  detectedFrom: string;
}

/** Non-fatal issues worth surfacing to the user (unknown stack, ambiguous config, etc.). */
export interface DetectionWarning {
  code: string;
  message: string;
  /** Which detector raised the warning, for traceability. */
  detector: string;
}

/**
 * Richer, forward-looking detection signals gathered by the Phase-B/C detectors
 * (frameworks beyond the seed set, monorepo topology, CI-recovered build commands and
 * runtime versions). Additive and advisory: the seed-stack containerize path does not
 * depend on it, but it feeds the reasoning trail and future generic-build stages so
 * unfamiliar repos are understood rather than dropped.
 */
export interface RepoInsights {
  /** Framework ids matched by the signature table, e.g. ["nextjs", "react"]. */
  frameworks: string[];
  /** Runtimes detected across the repo, e.g. ["node", "go"]. */
  runtimes: string[];
  /** Monorepo tooling detected, e.g. ["turborepo", "pnpm"]; empty for single-package repos. */
  monorepoTools: string[];
  /** Build/test/start commands recovered from CI workflows. */
  ciCommands: { command: string; kind: string }[];
  /** Runtime versions pinned in CI, e.g. [{ runtime: "node", version: "20" }]. */
  ciRuntimeVersions: { runtime: string; version: string }[];
  /**
   * CI configs recovered from non-GitHub-Actions providers (GitLab CI, Azure
   * Pipelines, CircleCI), kept as structured stages/jobs rather than flattened
   * like `ciCommands` above, since job/stage grouping is what was asked for.
   */
  ciProviders: {
    provider: 'gitlab' | 'azure' | 'circleci';
    file: string;
    stages: string[];
    jobs: {
      name: string;
      stage: string | null;
      commands: { command: string; kind: string }[];
      image: string | null;
    }[];
    image: string | null;
  }[];
  /** Dockerfiles parsed from the repo, with their extracted build/run signals. */
  dockerfiles: {
    rootDir: string;
    file: string;
    baseImage: string;
    exposedPorts: number[];
    installCommands: string[];
    buildCommands: string[];
    startCommand: string;
    workingDir: string;
  }[];
  /**
   * Build/run/test tasks recovered from the repo's task runners (Makefile, Taskfile,
   * justfile, package scripts) — the maintainer's own entrypoints. Phase-3 signal.
   */
  taskCommands: { source: string; name: string; command: string; kind: string }[];
  /**
   * Build/run commands and ports recovered from repo-authored shell snippets
   * (README fenced shell blocks and shipped shell scripts).
   */
  scriptSources: {
    source: 'readme' | 'shell-script';
    file: string;
    commands: { command: string; kind: string }[];
    ports: number[];
    /**
     * The same `ports` as proper `DetectedPort` entries (source: 'readme'), origin-tagged
     * for anything that wants the standard shape. Only ever set for a `'readme'` entry —
     * `DetectedPort.source` has no `'shell-script'` member, so that source stays bare
     * numbers here.
     */
    readmePorts?: DetectedPort[];
  }[];
  /**
   * Ecosystem components (Go/Rust/JVM/.NET) that matched a `BuildRecipe` but fall
   * outside the seed-stack frontend/backend split. Each pairs a repo-relative root with
   * the id of its matched recipe, so the pipeline can place them as open `'service'`
   * nodes and synthesize their Dockerfiles.
   */
  ecosystemComponents: {
    rootDir: string;
    runtime: string;
    recipeId: string;
    /**
     * The role this component plays. `'backend'` unless a role detector found
     * unambiguous evidence otherwise (a queue worker, a CLI binary) — so every repo that
     * resolved to a service before this field existed still resolves to one.
     */
    role: RunnableRole;
  }[];
  /**
   * The build/run shape recovered from every source that declares one — CI (GitHub
   * Actions plus every `ciProviders` entry), task runners, README/shell scripts — ranked
   * with provenance, or null when nothing declared anything actionable.
   *
   * This is the consumer the other command fields never had: `ciCommands`,
   * `ciProviders`, `taskCommands`, and `scriptSources` were previously read only by
   * `logInsights`. The plan overlays this onto a matched recipe so a repo's own declared
   * commands actually drive the build (§5 Phase C exit criterion).
   */
  recoveredBuild: {
    installCommands: string[];
    buildCommands: string[];
    startCommand: string | null;
    image: string | null;
    commands: { command: string; kind: string; source: string; origin: string }[];
    /** Distinct files/jobs that contributed, e.g. ["gitlab:.gitlab-ci.yml#build_app"]. */
    origins: string[];
    /** The recovery claim's computed confidence. */
    confidence: number;
    /** The claim's evidence projected to strings, same convention as `reasoning`. */
    reasoning: string[];
  } | null;
}

/**
 * The complete, aggregated output of the detect stage.
 * Populated by `src/detect/index.ts` from the individual detectors.
 */
export interface DetectionResult {
  /** Absolute path to the cloned repo on disk. */
  repoPath: string;
  /** Every language seen anywhere in the repo. */
  languages: Language[];
  /** Every package manager seen anywhere in the repo. */
  packageManagers: PackageManager[];
  /** The detected frontend component, or null if there isn't one. */
  frontend: DetectedComponent | null;
  /** The detected backend component, or null if there isn't one. */
  backend: DetectedComponent | null;
  /** Databases/caches the app depends on (may be empty). */
  databases: DetectedDatabase[];
  /** True when ORCA is confident the repo is a supported stack it can containerize. */
  isSupported: boolean;
  /** Rough 0..1 confidence in the overall detection. */
  confidence: number;
  /**
   * The reasoning trail behind `confidence` — one human-readable signal per piece of
   * evidence, e.g. "backend component detected", "database dependency found". Part of
   * the Universal Understanding model (docs/universal-understanding-plan.md §4): every
   * inference explains itself. May be empty for an unsupported repo.
   */
  reasoning: string[];
  /** Forward-looking Phase-B/C signals (frameworks, monorepo, CI). Advisory. */
  insights: RepoInsights;
  /** Non-fatal issues surfaced during detection. */
  warnings: DetectionWarning[];
}

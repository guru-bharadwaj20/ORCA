/**
 * The template render-context data contracts — the exact shape the Handlebars
 * templates consume. These names ARE the contract the AI layer (Stage 3) must produce,
 * so they are chosen deliberately and kept minimal.
 *
 * STAGE: 1 (templates) — REAL code.
 * Inputs: nothing (pure type definitions).
 * Outputs: `DockerfileVars`, `ServiceSpec`, `ComposeVars` used by render.ts.
 *
 * Who fills these fields:
 *  - Stage 1 fills them statically (by hand) for the bundled samples / golden files.
 *  - Stage 3 (ai) fills `DockerfileVars` from the README + detection result.
 *  - Stage 6 (orchestrate) enriches `healthcheck` and `dependsOn`.
 */

/** Package managers ORCA knows how to drive (no 'unknown' — a concrete choice is required to render). */
export type PackageManager = 'npm' | 'yarn' | 'pnpm' | 'pip' | 'poetry';

/** The role a compose service plays. */
export type ServiceKind = 'frontend' | 'backend' | 'database';

/**
 * Everything a single Dockerfile template needs. One `DockerfileVars` renders one
 * Dockerfile (a React client, a Node server, or a Django app).
 */
export interface DockerfileVars {
  /** Base image, e.g. "node:20-slim" / "python:3.12-slim". Stage 3 picks this from detection. */
  baseImage: string;
  /** Working directory inside the image. Stage 1 default: "/app". */
  workdir: string;
  /** Which package manager's install idiom to use. Stage 2 detects; Stage 3 supplies. */
  packageManager: PackageManager;
  /** Manifest/lock files copied first for Docker layer caching, e.g. ["package.json"]. Stage 3. */
  dependencyFiles: string[];
  /** Dependency install command, e.g. "npm install" / "pip install -r requirements.txt". Stage 3. */
  installCommand: string;
  /** Optional build step (e.g. a React production build). Omitted for dev/hot-reload. Stage 3. */
  buildCommand?: string;
  /** Process start command, e.g. "npm run dev" / "python manage.py runserver 0.0.0.0:8000". Stage 3. */
  startCommand: string;
  /** Port the service listens on inside the container. Stage 2 detects; Stage 3 supplies. */
  port: number;
  /** Extra apt packages to install (e.g. Django+pg needs ["libpq-dev", "gcc"]). Stage 3. Omit if none. */
  systemPackages?: string[];
  /** Optional entrypoint script path relative to the build context (e.g. Django migrate-then-run). Stage 3. */
  entrypointScript?: string;
}

/** A single service in the generated docker-compose file. */
export interface ServiceSpec {
  /** Service key in compose (also the in-network hostname), e.g. "web", "db". Stage 1/3. */
  name: string;
  /** What this service is. Stage 2 detects; Stage 1/3 supplies. */
  kind: ServiceKind;
  /** Official image to pull (databases only — Postgres/Mongo). Mutually exclusive with `build`. Stage 1/3. */
  image?: string;
  /** Build context + Dockerfile for buildable services (client/server/app). Stage 1/3. */
  build?: { context: string; dockerfile: string };
  /** Published port mappings, e.g. ["3000:3000"]. Stage 2/3. */
  ports: string[];
  /** Environment variables injected into the service. Stage 3 (from inferEnv). */
  environment: Record<string, string>;
  /** Optional env file path (relative to the compose file); inline `environment` wins. */
  envFile?: string;
  /**
   * Services that must start first. A bare string renders compose's short form;
   * the object form renders the long form with a startup `condition`
   * (e.g. `service_healthy`, gated on the dependency's healthcheck).
   */
  dependsOn: (string | { service: string; condition: string })[];
  /** Bind mounts (hot reload) + named volumes (db data), e.g. ["./server:/app", "/app/node_modules"]. Stage 1/3. */
  volumes: string[];
  /**
   * Optional healthcheck. Stage 1 leaves this as a simple static slot; Stage 6 populates
   * it richly and wires `dependsOn` conditions off it.
   */
  healthcheck?: {
    test: string[];
    interval: string;
    timeout: string;
    retries: number;
  };
  /** Optional command override (falls back to the image/Dockerfile default). Stage 3/6. */
  command?: string;
}

/** Everything the docker-compose template needs to render a full stack. */
export interface ComposeVars {
  /** docker-compose project name (derived from the repo name). Stage 1/3. */
  projectName: string;
  /** All services in the stack (0..N app services + database). Stage 1/3. */
  services: ServiceSpec[];
  /** Single user-defined bridge network all services attach to. Stage 1. */
  networkName: string;
  /** Named volumes referenced by services (e.g. db data). Stage 1/3. */
  namedVolumes: string[];
}

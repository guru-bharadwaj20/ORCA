/**
 * Builds the `ServicePlan` (the service graph) from the detection result plus the
 * AI-filled templates. This is where components + databases become concrete container
 * nodes with ports, env, volumes, and dependency edges. The conventions (images,
 * healthchecks, env names, volume shapes) mirror the hand-verified Stage 1 golden
 * configs — this module generalizes them.
 *
 * STAGE: 4 (plan) — REAL code.
 * Inputs: a `DetectionResult` and the filled template variables (keyed by role).
 * Outputs: a `ServicePlan` ready for review, diagram, and generation.
 */

import { basename } from 'node:path';

import type { FilledTemplateVars, InferredEnv } from '../ai/schema.js';
import { refineDockerfileVars } from '../ai/refineVars.js';
import { selectEnvVars } from '../orchestrate/envFiles.js';
import { LISTENING_ROLES } from '../detect/types.js';
import type { DetectedComponent, DetectedDatabase, DetectionResult } from '../detect/types.js';
import type { BuildRecipe } from '../model/recipe.js';
import { describeComponent } from '../templates/registry.js';
import type { DockerfileVars } from '../templates/types.js';
import type { Healthcheck, ServiceDependency, ServiceNode, ServicePlan } from './types.js';

/** Shared dev credentials/database name across generated stacks (mirrors the goldens). */
const DB_NAME = 'orca';

/** Engine-specific container knowledge: image, data dir, healthcheck. */
const DB_SPECS: Record<
  DetectedDatabase['engine'],
  { image: string; dataDir: string | null; healthcheck: Healthcheck }
> = {
  postgres: {
    image: 'postgres:16',
    dataDir: '/var/lib/postgresql/data',
    healthcheck: {
      test: ['CMD-SHELL', `pg_isready -U ${DB_NAME}`],
      interval: '5s',
      timeout: '5s',
      retries: 5,
    },
  },
  mongodb: {
    image: 'mongo:7',
    dataDir: '/data/db',
    healthcheck: {
      test: ['CMD', 'mongosh', '--eval', "db.adminCommand('ping')"],
      interval: '10s',
      timeout: '5s',
      retries: 5,
    },
  },
  redis: {
    image: 'redis:7',
    dataDir: null, // cache — no persistent volume
    healthcheck: {
      test: ['CMD', 'redis-cli', 'ping'],
      interval: '5s',
      timeout: '5s',
      retries: 5,
    },
  },
};

/** Sanitize a repo basename into a valid compose project name. */
function projectNameFor(repoPath: string): string {
  const slug = basename(repoPath)
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, '-')
    .replace(/^[-_]+|[-_]+$/g, '');
  return `orca-${slug || 'app'}`;
}

/** Compose build context for a component root ('.' stays '.', others become './dir'). */
function contextFor(rootDir: string): string {
  return rootDir === '.' ? '.' : `./${rootDir}`;
}

/**
 * The node id for a non-primary same-role component: its rootDir's basename ("app" at
 * the repo root), matching the convention `ecosystemComponentsFrom` (pipeline.ts)
 * already uses. The primary keeps the literal 'backend'/'frontend' id — see
 * `buildServicePlan` — so a single-frontend+single-backend repo is unaffected.
 */
function idFromRootDir(rootDir: string): string {
  return rootDir === '.' ? 'app' : (rootDir.split('/').pop() ?? 'app');
}

/** `candidate` if free, else `candidate-2`, `candidate-3`, ... — never drops a component. */
function uniqueId(candidate: string, taken: ReadonlySet<string>): string {
  if (!taken.has(candidate)) return candidate;
  let n = 2;
  while (taken.has(`${candidate}-${n}`)) n++;
  return `${candidate}-${n}`;
}

/**
 * rootDirs that produced both a frontend AND a backend component — the same collision
 * the original single-pair `sharedRoot` check caught (a candidate directory with both
 * react + express), generalized to N components. A single candidate can only ever yield
 * at most one frontend + one backend (`buildComponent` runs once per role per
 * candidate — see index.ts), so a rootDir can never collide with more than these two;
 * no numbered Dockerfile suffixes are needed beyond the existing `.frontend`/`.backend`.
 */
function sharedRootDirs(components: readonly DetectedComponent[]): Set<string> {
  const seen = new Set<string>();
  const shared = new Set<string>();
  for (const c of components) {
    if (seen.has(c.rootDir)) shared.add(c.rootDir);
    seen.add(c.rootDir);
  }
  return shared;
}

/** A detected database paired with the concrete node built for it. */
interface DatabasePair {
  db: DetectedDatabase;
  node: ServiceNode;
}

interface DatabaseNodes {
  nodes: ServiceNode[];
  pairs: DatabasePair[];
}

function databaseNodes(databases: DetectedDatabase[]): DatabaseNodes {
  const nodes: ServiceNode[] = [];
  const pairs: DatabasePair[] = [];
  let primaryTaken = false;

  for (const db of databases) {
    const spec = DB_SPECS[db.engine];
    const isCache = db.engine === 'redis';
    const id = isCache ? 'cache' : primaryTaken ? db.engine : 'db';
    if (!isCache) primaryTaken = true;

    const node: ServiceNode = {
      id,
      name: id,
      kind: isCache ? 'cache' : 'database',
      source: { type: 'image', image: spec.image },
      ports: [{ host: db.defaultPort, container: db.defaultPort, protocol: 'tcp' }],
      environment:
        db.engine === 'postgres'
          ? { POSTGRES_DB: DB_NAME, POSTGRES_USER: DB_NAME, POSTGRES_PASSWORD: DB_NAME }
          : {},
      dependsOn: [],
      volumes:
        spec.dataDir === null
          ? []
          : [{ source: `${id}-data`, target: spec.dataDir, kind: 'named' }],
      healthcheck: spec.healthcheck,
    };
    nodes.push(node);
    pairs.push({ db, node });
  }
  return { nodes, pairs };
}

/**
 * Connection env a backend needs for each database node, keyed off the golden configs.
 * Wires each database to the exact node built for it (not an engine lookup), so a node is
 * never orphaned or mis-addressed if detection ever yields two of the same engine.
 */
function connectionEnv(pairs: DatabasePair[]): Record<string, string> {
  const env: Record<string, string> = {};
  for (const { db, node } of pairs) {
    if (db.engine === 'postgres') {
      Object.assign(env, {
        POSTGRES_DB: DB_NAME,
        POSTGRES_USER: DB_NAME,
        POSTGRES_PASSWORD: DB_NAME,
        POSTGRES_HOST: node.id,
        POSTGRES_PORT: String(db.defaultPort),
      });
    } else if (db.engine === 'mongodb') {
      env['MONGO_URL'] = `mongodb://${node.id}:${db.defaultPort}/${DB_NAME}`;
    } else {
      env['REDIS_URL'] = `redis://${node.id}:${db.defaultPort}`;
    }
  }
  return env;
}

/** Dev-mode volumes: source bind mount, plus an anonymous node_modules shield for Node. */
function componentVolumes(
  component: DetectedComponent,
  vars: DockerfileVars
): ServiceNode['volumes'] {
  const volumes: ServiceNode['volumes'] = [
    { source: contextFor(component.rootDir), target: vars.workdir, kind: 'bind' },
  ];
  if (component.language !== 'python') {
    volumes.push({ source: '', target: `${vars.workdir}/node_modules`, kind: 'anonymous' });
  }
  return volumes;
}

/**
 * Build a generic `'service'` node for an ecosystem/inferred component from its matched
 * `BuildRecipe`. Role-agnostic (a Go worker, a Rust CLI, a JVM app): it builds from a
 * synthesized Dockerfile (the recipe rides inline on `source.recipe` so the generate
 * stage synthesizes directly — no registry lookup, so AI-inferred `ai-*` recipes build
 * identically), and — when the component's role is one that listens — publishes every
 * one of the recipe's default ports (e.g. a Dockerfile with multiple EXPOSEs), not just
 * the first. No DB wiring here — that stays with the seed-stack backend path until
 * ecosystem DB inference exists.
 */
export function ecosystemServiceNode(
  id: string,
  component: DetectedComponent,
  recipe: BuildRecipe,
  commandOrigins: readonly string[] = []
): ServiceNode {
  // Only a listening role publishes a port. Every shipped ecosystem recipe carries
  // `defaultPorts: [8080]` because it was written for web services, so a worker/CLI/job
  // would otherwise advertise a port nothing binds — the component's detected role, not
  // the recipe's default, is the authority here (§2.3). When it does listen, every
  // default port is published, not just the first (e.g. a Dockerfile with multiple
  // EXPOSEs).
  const listens = LISTENING_ROLES.includes(component.role);
  const ports = listens ? recipe.defaultPorts : [];
  return {
    id,
    name: id,
    kind: 'service',
    source: {
      type: 'build',
      context: contextFor(component.rootDir),
      dockerfile: 'Dockerfile',
      recipeId: recipe.id,
      recipe,
      // Provenance travels with the node so the review gate and the diagnosis log can
      // say which file a command came from, not just what it is.
      ...(commandOrigins.length > 0 ? { commandOrigins: [...commandOrigins] } : {}),
    },
    ports: ports.map((port) => ({ host: port, container: port, protocol: 'tcp' })),
    environment: {},
    dependsOn: [],
    volumes: [],
  };
}

/**
 * The final `DockerfileVars` for a component: registry defaults, refined by the AI
 * fill for that role when one exists. Exported so the pipeline/generate stages render
 * Dockerfiles from exactly the vars the plan was built with (no drift).
 */
export function refinedComponentVars(
  component: DetectedComponent,
  role: 'frontend' | 'backend',
  filled: Record<string, FilledTemplateVars>
): DockerfileVars {
  const defaults = describeComponent(component).defaults;
  const fill = filled[role];
  return fill === undefined ? defaults : refineDockerfileVars(defaults, fill);
}

/** An ecosystem/inferred component to place as a generic `'service'` node. */
export interface EcosystemComponent {
  /** Stable node id + compose key, e.g. "api" or the workspace dir basename. */
  id: string;
  component: DetectedComponent;
  recipe: BuildRecipe;
  /**
   * Origins of any commands recovered from the repo's own declarations (CI job, Makefile
   * target, README block) and overlaid onto `recipe`. Empty/absent when the recipe's own
   * defaults were used unchanged.
   */
  commandOrigins?: string[];
}

/** Assemble ServiceNodes for frontend/backend/databases and wire dependency edges. */
export function buildServicePlan(
  detection: DetectionResult,
  filled: Record<string, FilledTemplateVars>,
  inferred: InferredEnv | null = null,
  ecosystem: readonly EcosystemComponent[] = []
): ServicePlan {
  const { nodes: dbNodes, pairs: dbPairs } = databaseNodes(detection.databases);
  const nodes: ServiceNode[] = [...dbNodes];
  const usedIds = new Set<string>(nodes.map((n) => n.id));

  // Any detected database is a repo-wide dependency, so every backend-role component
  // (and every ecosystem service, below) gets the same health-gated `depends_on` and
  // connection env — computed once, reused by every node that needs it.
  const dbEnv = connectionEnv(dbPairs);
  const dbDeps: ServiceDependency[] = dbNodes.map((db) => ({
    serviceId: db.id,
    condition: db.healthcheck ? 'service_healthy' : 'service_started',
  }));

  const shared = sharedRootDirs(detection.components);
  const refined = (component: DetectedComponent, role: 'frontend' | 'backend'): DockerfileVars =>
    refinedComponentVars(component, role, filled);

  // Backend nodes: one per detected backend-role component, not just detection.backend.
  // The hint-preferred primary (detection.backend) keeps the literal 'backend' id, so a
  // single-backend repo is unaffected; additional components get a rootDir-derived id
  // (uniqueId guards a basename collision — never dropped, unlike the old pickCandidate
  // behavior this replaces).
  let primaryBackendNode: ServiceNode | null = null;
  let primaryBackendVars: DockerfileVars | null = null;
  for (const component of detection.components) {
    if (component.role !== 'backend') continue;
    const isPrimary = detection.backend?.rootDir === component.rootDir;
    const vars = refined(component, 'backend');
    const id = uniqueId(isPrimary ? 'backend' : idFromRootDir(component.rootDir), usedIds);
    usedIds.add(id);
    const node: ServiceNode = {
      id,
      name: id,
      kind: 'backend',
      componentRootDir: component.rootDir,
      source: {
        type: 'build',
        context: contextFor(component.rootDir),
        dockerfile: shared.has(component.rootDir) ? 'Dockerfile.backend' : 'Dockerfile',
      },
      ports: (vars.ports ?? [vars.port]).map((port) => ({
        host: port,
        container: port,
        protocol: 'tcp',
      })),
      environment: {
        ...(component.language === 'python'
          ? { DJANGO_DEBUG: '1' }
          : { NODE_ENV: 'development', PORT: String(vars.port) }),
        ...dbEnv,
      },
      dependsOn: [...dbDeps],
      volumes: componentVolumes(component, vars),
    };
    nodes.push(node);
    if (isPrimary) {
      primaryBackendNode = node;
      primaryBackendVars = vars;
    }
  }

  // Frontend nodes: same pattern. VITE_API_URL and the startup dependency always point
  // at the PRIMARY backend for every frontend — with N backends there's no signal for
  // which frontend talks to which, so every frontend gets the same default the
  // single-backend case already had, rather than guessing a pairing.
  let primaryFrontendNode: ServiceNode | null = null;
  for (const component of detection.components) {
    if (component.role !== 'frontend') continue;
    const isPrimary = detection.frontend?.rootDir === component.rootDir;
    const vars = refined(component, 'frontend');
    const id = uniqueId(isPrimary ? 'frontend' : idFromRootDir(component.rootDir), usedIds);
    usedIds.add(id);
    const node: ServiceNode = {
      id,
      name: id,
      kind: 'frontend',
      componentRootDir: component.rootDir,
      source: {
        type: 'build',
        context: contextFor(component.rootDir),
        dockerfile: shared.has(component.rootDir) ? 'Dockerfile.frontend' : 'Dockerfile',
      },
      ports: (vars.ports ?? [vars.port]).map((port) => ({
        host: port,
        container: port,
        protocol: 'tcp',
      })),
      environment: {
        NODE_ENV: 'development',
        // The browser talks to the backend from the host, hence localhost.
        ...(primaryBackendVars !== null
          ? { VITE_API_URL: `http://localhost:${primaryBackendVars.port}` }
          : {}),
      },
      dependsOn:
        primaryBackendNode !== null
          ? [{ serviceId: primaryBackendNode.id, condition: 'service_started' }]
          : [],
      volumes: componentVolumes(component, vars),
    };
    nodes.push(node);
    if (isPrimary) primaryFrontendNode = node;
  }

  // Ecosystem/inferred components (Go/Rust/JVM/.NET) become generic 'service' nodes
  // that build from a synthesized Dockerfile. Ids are de-duplicated against nodes
  // already placed (databases, seed components).
  for (const eco of ecosystem) {
    if (nodes.some((n) => n.id === eco.id)) continue;
    const node = ecosystemServiceNode(eco.id, eco.component, eco.recipe, eco.commandOrigins ?? []);
    Object.assign(node.environment, dbEnv);
    node.dependsOn = [...node.dependsOn, ...dbDeps];
    nodes.push(node);
  }

  // AI-inferred app env rides in a .env file attached to the app service: the backend
  // when there is one, else the frontend, else the first ecosystem 'service' node (a
  // pure Go/Rust/inferred repo has no seed component). Vars the plan already injects
  // inline are filtered out, so an empty selection means no .env and no env_file at all.
  if (inferred !== null) {
    const appNode = primaryBackendNode ?? primaryFrontendNode ?? nodes.find((n) => n.kind === 'service');
    if (appNode !== undefined && selectEnvVars(inferred, { services: nodes }).length > 0) {
      appNode.envFile = '.env';
    }
  }

  return {
    projectName: projectNameFor(detection.repoPath),
    services: nodes,
    networks: ['orca-net'],
    volumes: nodes.flatMap((n) => n.volumes.filter((v) => v.kind === 'named').map((v) => v.source)),
    createdAt: new Date().toISOString(),
    source: Object.keys(filled).length > 0 ? 'ai' : 'template',
  };
}

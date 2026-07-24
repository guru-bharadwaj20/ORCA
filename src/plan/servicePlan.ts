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

interface DatabaseNodes {
  nodes: ServiceNode[];
  byEngine: Map<DetectedDatabase['engine'], ServiceNode>;
}

function databaseNodes(databases: DetectedDatabase[]): DatabaseNodes {
  const nodes: ServiceNode[] = [];
  const byEngine = new Map<DetectedDatabase['engine'], ServiceNode>();
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
    byEngine.set(db.engine, node);
  }
  return { nodes, byEngine };
}

/** Connection env a backend needs for each database node, keyed off the golden configs. */
function connectionEnv(
  byEngine: Map<DetectedDatabase['engine'], ServiceNode>,
  databases: DetectedDatabase[]
): Record<string, string> {
  const env: Record<string, string> = {};
  for (const db of databases) {
    const node = byEngine.get(db.engine);
    if (node === undefined) continue;
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
 * identically), and publishes the recipe's first default port when it has one. No DB
 * wiring here — that stays with the seed-stack backend path until ecosystem DB inference
 * exists.
 */
export function ecosystemServiceNode(
  id: string,
  component: DetectedComponent,
  recipe: BuildRecipe
): ServiceNode {
  // Only a listening role publishes a port. Every shipped ecosystem recipe carries
  // `defaultPorts: [8080]` because it was written for web services, so a worker/CLI/job
  // would otherwise advertise a port nothing binds — the component's detected role, not
  // the recipe's default, is the authority here (§2.3).
  const listens = LISTENING_ROLES.includes(component.role);
  const port = listens ? recipe.defaultPorts[0] : undefined;
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
    },
    ports: port === undefined ? [] : [{ host: port, container: port, protocol: 'tcp' }],
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
}

/** Assemble ServiceNodes for frontend/backend/databases and wire dependency edges. */
export function buildServicePlan(
  detection: DetectionResult,
  filled: Record<string, FilledTemplateVars>,
  inferred: InferredEnv | null = null,
  ecosystem: readonly EcosystemComponent[] = []
): ServicePlan {
  const { nodes: dbNodes, byEngine } = databaseNodes(detection.databases);
  const nodes: ServiceNode[] = [...dbNodes];

  // Both components sharing one root would collide on ./Dockerfile — disambiguate.
  const sharedRoot =
    detection.frontend !== null &&
    detection.backend !== null &&
    detection.frontend.rootDir === detection.backend.rootDir;

  const refined = (component: DetectedComponent, role: 'frontend' | 'backend'): DockerfileVars =>
    refinedComponentVars(component, role, filled);

  let backendNode: ServiceNode | null = null;
  let backendVars: DockerfileVars | null = null;
  if (detection.backend !== null) {
    backendVars = refined(detection.backend, 'backend');
    const dbDeps: ServiceDependency[] = dbNodes.map((db) => ({
      serviceId: db.id,
      condition: db.healthcheck ? 'service_healthy' : 'service_started',
    }));
    backendNode = {
      id: 'backend',
      name: 'backend',
      kind: 'backend',
      source: {
        type: 'build',
        context: contextFor(detection.backend.rootDir),
        dockerfile: sharedRoot ? 'Dockerfile.backend' : 'Dockerfile',
      },
      ports: [{ host: backendVars.port, container: backendVars.port, protocol: 'tcp' }],
      environment: {
        ...(detection.backend.language === 'python'
          ? { DJANGO_DEBUG: '1' }
          : { NODE_ENV: 'development', PORT: String(backendVars.port) }),
        ...connectionEnv(byEngine, detection.databases),
      },
      dependsOn: dbDeps,
      volumes: componentVolumes(detection.backend, backendVars),
    };
    nodes.push(backendNode);
  }

  if (detection.frontend !== null) {
    const vars = refined(detection.frontend, 'frontend');
    nodes.push({
      id: 'frontend',
      name: 'frontend',
      kind: 'frontend',
      source: {
        type: 'build',
        context: contextFor(detection.frontend.rootDir),
        dockerfile: sharedRoot ? 'Dockerfile.frontend' : 'Dockerfile',
      },
      ports: [{ host: vars.port, container: vars.port, protocol: 'tcp' }],
      environment: {
        NODE_ENV: 'development',
        // The browser talks to the backend from the host, hence localhost.
        ...(backendVars !== null ? { VITE_API_URL: `http://localhost:${backendVars.port}` } : {}),
      },
      dependsOn:
        backendNode !== null ? [{ serviceId: backendNode.id, condition: 'service_started' }] : [],
      volumes: componentVolumes(detection.frontend, vars),
    });
  }

  // Ecosystem/inferred components (Go/Rust/JVM/.NET) become generic 'service' nodes
  // that build from a synthesized Dockerfile. Ids are de-duplicated against nodes
  // already placed (databases, seed components). Any detected database is a repo-wide
  // dependency, so each ecosystem service gets the same health-gated `depends_on` and
  // connection env a seed backend would — that's the ecosystem DB wiring.
  const dbEnv = connectionEnv(byEngine, detection.databases);
  const dbDeps: ServiceDependency[] = dbNodes.map((db) => ({
    serviceId: db.id,
    condition: db.healthcheck ? 'service_healthy' : 'service_started',
  }));
  for (const eco of ecosystem) {
    if (nodes.some((n) => n.id === eco.id)) continue;
    const node = ecosystemServiceNode(eco.id, eco.component, eco.recipe);
    Object.assign(node.environment, dbEnv);
    node.dependsOn = [...node.dependsOn, ...dbDeps];
    nodes.push(node);
  }

  // AI-inferred app env rides in a .env file attached to the app service: the backend
  // when there is one, else the frontend, else the first ecosystem 'service' node (a
  // pure Go/Rust/inferred repo has no seed component). Vars the plan already injects
  // inline are filtered out, so an empty selection means no .env and no env_file at all.
  if (inferred !== null) {
    const appNode =
      backendNode ??
      nodes.find((n) => n.id === 'frontend') ??
      nodes.find((n) => n.kind === 'service');
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

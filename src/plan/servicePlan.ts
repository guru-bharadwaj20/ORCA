import { basename } from 'node:path';

import type { FilledTemplateVars, InferredEnv } from '../ai/schema.js';
import { refineDockerfileVars } from '../ai/refineVars.js';
import { selectEnvVars } from '../orchestrate/envFiles.js';
import type { DetectedComponent, DetectedDatabase, DetectionResult } from '../detect/types.js';
import { describeComponent } from '../templates/registry.js';
import type { DockerfileVars } from '../templates/types.js';
import type { Healthcheck, ServiceDependency, ServiceNode, ServicePlan } from './types.js';

const DB_NAME = 'orca';

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
    dataDir: null,
    healthcheck: {
      test: ['CMD', 'redis-cli', 'ping'],
      interval: '5s',
      timeout: '5s',
      retries: 5,
    },
  },
};

function projectNameFor(repoPath: string): string {
  const slug = basename(repoPath)
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, '-')
    .replace(/^[-_]+|[-_]+$/g, '');
  return `orca-${slug || 'app'}`;
}

function contextFor(rootDir: string): string {
  return rootDir === '.' ? '.' : `./${rootDir}`;
}

function databaseNodes(databases: DetectedDatabase[]): ServiceNode[] {
  const nodes: ServiceNode[] = [];
  let primaryTaken = false;

  for (const db of databases) {
    const spec = DB_SPECS[db.engine];
    const isCache = db.engine === 'redis';
    const id = isCache ? 'cache' : primaryTaken ? db.engine : 'db';
    if (!isCache) primaryTaken = true;

    nodes.push({
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
    });
  }
  return nodes;
}

function connectionEnv(
  dbNodes: ServiceNode[],
  databases: DetectedDatabase[]
): Record<string, string> {
  const env: Record<string, string> = {};
  for (const db of databases) {
    const isCache = db.engine === 'redis';
    const node = dbNodes.find((n) => (isCache ? n.kind === 'cache' : n.kind === 'database'));
    if (!node) continue;
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

export function refinedComponentVars(
  component: DetectedComponent,
  role: 'frontend' | 'backend',
  filled: Record<string, FilledTemplateVars>
): DockerfileVars {
  const defaults = describeComponent(component).defaults;
  const fill = filled[role];
  return fill === undefined ? defaults : refineDockerfileVars(defaults, fill);
}

export function buildServicePlan(
  detection: DetectionResult,
  filled: Record<string, FilledTemplateVars>,
  inferred: InferredEnv | null = null
): ServicePlan {
  const dbNodes = databaseNodes(detection.databases);
  const nodes: ServiceNode[] = [...dbNodes];

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
        ...connectionEnv(dbNodes, detection.databases),
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
        ...(backendVars !== null ? { VITE_API_URL: `http://localhost:${backendVars.port}` } : {}),
      },
      dependsOn:
        backendNode !== null ? [{ serviceId: backendNode.id, condition: 'service_started' }] : [],
      volumes: componentVolumes(detection.frontend, vars),
    });
  }

  if (inferred !== null) {
    const appNode = backendNode ?? nodes.find((n) => n.id === 'frontend');
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

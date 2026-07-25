/**
 * Open-role plan model — the ecosystem `'service'` node builder. Pure: a DetectedComponent
 * + a BuildRecipe → a role-agnostic ServiceNode that builds from a synthesized Dockerfile.
 */
import { describe, expect, it } from 'vitest';

import { buildServicePlan, ecosystemServiceNode } from '../../src/plan/servicePlan.js';
import type { EcosystemComponent } from '../../src/plan/servicePlan.js';
import type { DetectedComponent, DetectionResult } from '../../src/detect/types.js';
import type { BuildRecipe } from '../../src/model/recipe.js';

const component = (rootDir: string): DetectedComponent => ({
  role: 'backend',
  rootDir,
  language: 'go',
  packageManager: 'unknown',
  framework: 'unknown',
  dependencies: [],
  ports: [],
  entrypoint: null,
});

const recipe: BuildRecipe = {
  id: 'go-mod',
  runtime: 'go',
  dependencyFiles: ['go.mod', 'go.sum'],
  installCommands: ['go mod download'],
  buildCommands: ['go build -o /app/server ./...'],
  startCommand: '/app/server',
  defaultPorts: [8080],
  baseImages: { build: 'golang:1.23', runtime: 'gcr.io/distroless/base-debian12' },
};

describe('ecosystemServiceNode', () => {
  it('produces a build service node that carries the recipe id for synthesis', () => {
    const node = ecosystemServiceNode('api', component('services/api'), recipe);
    expect(node.kind).toBe('service');
    expect(node.source).toMatchObject({
      type: 'build',
      context: './services/api',
      dockerfile: 'Dockerfile',
      recipeId: 'go-mod',
    });
    expect(node.ports).toEqual([{ host: 8080, container: 8080, protocol: 'tcp' }]);
  });

  it('uses "." context for a root component and publishes no port when the recipe has none', () => {
    const portless: BuildRecipe = { ...recipe, defaultPorts: [] };
    const node = ecosystemServiceNode('app', component('.'), portless);
    expect((node.source as { context: string }).context).toBe('.');
    expect(node.ports).toEqual([]);
  });
});

/** Minimal detection with one Postgres dependency and no seed frontend/backend. */
const detectionWithPostgres = (): DetectionResult => ({
  repoPath: '/tmp/eco',
  languages: ['go'],
  packageManagers: ['unknown'],
  components: [],
  frontend: null,
  backend: null,
  databases: [{ engine: 'postgres', defaultPort: 5432, detectedFrom: 'lib/pq' }],
  isSupported: true,
  confidence: 0.6,
  reasoning: [],
  insights: {
    frameworks: [],
    runtimes: ['go'],
    monorepoTools: [],
    ciCommands: [],
    ciRuntimeVersions: [],
    ciProviders: [],
    dockerfiles: [],
    taskCommands: [],
    scriptSources: [],
    ecosystemComponents: [],
    recoveredBuild: null,
    recoveredRuntimes: null,
  },
  warnings: [],
});

describe('buildServicePlan — ecosystem DB wiring', () => {
  it('wires a detected database into an ecosystem service (env + health-gated depends_on)', () => {
    const eco: EcosystemComponent[] = [{ id: 'app', recipe, component: component('.') }];
    const plan = buildServicePlan(detectionWithPostgres(), {}, null, eco);

    const svc = plan.services.find((s) => s.kind === 'service');
    expect(svc).toBeDefined();
    // Gets the same Postgres connection env a seed backend would.
    expect(svc?.environment).toMatchObject({
      POSTGRES_HOST: 'db',
      POSTGRES_PORT: '5432',
      POSTGRES_DB: 'orca',
    });
    // Waits for the db to be healthy before starting.
    expect(svc?.dependsOn).toContainEqual({ serviceId: 'db', condition: 'service_healthy' });
  });

  it('leaves an ecosystem service unwired when there is no database', () => {
    const detection = detectionWithPostgres();
    detection.databases = [];
    const eco: EcosystemComponent[] = [{ id: 'app', recipe, component: component('.') }];
    const plan = buildServicePlan(detection, {}, null, eco);

    const svc = plan.services.find((s) => s.kind === 'service');
    expect(svc?.environment).toEqual({});
    expect(svc?.dependsOn).toEqual([]);
  });

  it('attaches an inferred .env to the ecosystem service when there is no seed component', () => {
    const detection = detectionWithPostgres();
    detection.databases = []; // pure ecosystem repo, no seed frontend/backend
    const eco: EcosystemComponent[] = [{ id: 'app', recipe, component: component('.') }];
    const plan = buildServicePlan(
      detection,
      {},
      { variables: [{ key: 'API_TOKEN', value: 'x', required: true, reason: 'auth' }] },
      eco
    );

    const svc = plan.services.find((s) => s.kind === 'service');
    expect(svc?.envFile).toBe('.env');
  });

  it('wires BOTH a seed backend and a coexisting ecosystem service to the database (polyglot repo)', () => {
    // A repo with a Django backend AND a Go worker sharing one Postgres: the ecosystem
    // service gets the same DB env + health-gated dependency the seed backend does, and
    // the two nodes coexist without colliding.
    const detection = detectionWithPostgres();
    detection.backend = {
      role: 'backend',
      rootDir: '.',
      language: 'python',
      packageManager: 'pip',
      framework: 'django',
      dependencies: ['django', 'psycopg2-binary'],
      ports: [{ port: 8000, protocol: 'tcp', source: 'default' }],
      entrypoint: null,
    };
    // buildServicePlan now reads .components, not the derived .backend directly — keep
    // them in sync, same as detectStack always does.
    detection.components = [detection.backend];
    const eco: EcosystemComponent[] = [{ id: 'worker', recipe, component: component('worker') }];
    const plan = buildServicePlan(detection, {}, null, eco);

    const backend = plan.services.find((s) => s.id === 'backend');
    const worker = plan.services.find((s) => s.id === 'worker');
    expect(backend).toBeDefined();
    expect(worker?.kind).toBe('service');
    // Both talk to the same db, both health-gate on it.
    expect(backend?.environment).toMatchObject({ POSTGRES_HOST: 'db' });
    expect(worker?.environment).toMatchObject({ POSTGRES_HOST: 'db' });
    expect(worker?.dependsOn).toContainEqual({ serviceId: 'db', condition: 'service_healthy' });
    // No id collision: db, backend, worker are all distinct nodes.
    expect(plan.services.map((s) => s.id).sort()).toEqual(['backend', 'db', 'worker']);
  });

  it('does not double-place an ecosystem component whose id collides with an existing node', () => {
    // If an ecosystem id matches a node already placed (e.g. "db"), it is skipped rather
    // than overwriting the database node.
    const detection = detectionWithPostgres();
    const eco: EcosystemComponent[] = [{ id: 'db', recipe, component: component('.') }];
    const plan = buildServicePlan(detection, {}, null, eco);

    const dbNodes = plan.services.filter((s) => s.id === 'db');
    expect(dbNodes).toHaveLength(1);
    expect(dbNodes[0]?.kind).toBe('database'); // the real db, not overwritten by the service
  });
});

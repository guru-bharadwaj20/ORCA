/**
 * STAGE 4 tests — plan assembly, Mermaid rendering, and the plan → compose round-trip.
 * Detection runs for real against the Stage 2 fixtures; nothing is mocked.
 */
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { parse as parseYaml } from 'yaml';

import { FilledTemplateVarsSchema, validateAgainst } from '../../src/ai/schema.js';
import { detectStack } from '../../src/detect/index.js';
import { planToComposeVars } from '../../src/generate/composeVars.js';
import { renderDiagram } from '../../src/plan/diagram.js';
import { buildServicePlan } from '../../src/plan/servicePlan.js';
import { renderCompose } from '../../src/templates/render.js';

const fixture = (name: string): string =>
  fileURLToPath(new URL(`../fixtures/${name}`, import.meta.url));

describe('buildServicePlan', () => {
  it('assembles the MERN graph: db → backend → frontend', async () => {
    const detection = await detectStack(fixture('mern-repo'));
    const plan = buildServicePlan(detection, {});

    expect(plan.projectName).toBe('orca-mern-repo');
    expect(plan.source).toBe('template');
    expect(plan.services.map((s) => s.id)).toEqual(['db', 'backend', 'frontend']);

    const [db, backend, frontend] = plan.services;
    expect(db?.source).toEqual({ type: 'image', image: 'mongo:7' });
    expect(db?.healthcheck?.test).toContain('mongosh');
    expect(db?.volumes).toEqual([{ source: 'db-data', target: '/data/db', kind: 'named' }]);

    expect(backend?.source).toEqual({
      type: 'build',
      context: './server',
      dockerfile: 'Dockerfile',
    });
    expect(backend?.ports).toEqual([{ host: 3000, container: 3000, protocol: 'tcp' }]);
    expect(backend?.environment).toMatchObject({
      NODE_ENV: 'development',
      PORT: '3000',
      MONGO_URL: 'mongodb://db:27017/orca',
    });
    expect(backend?.dependsOn).toEqual([{ serviceId: 'db', condition: 'service_healthy' }]);
    expect(backend?.volumes).toEqual([
      { source: './server', target: '/app', kind: 'bind' },
      { source: '', target: '/app/node_modules', kind: 'anonymous' },
    ]);

    expect(frontend?.ports[0]?.container).toBe(5173);
    expect(frontend?.environment['VITE_API_URL']).toBe('http://localhost:3000');
    expect(frontend?.dependsOn).toEqual([{ serviceId: 'backend', condition: 'service_started' }]);

    expect(plan.volumes).toEqual(['db-data']);
    expect(plan.networks).toEqual(['orca-net']);
  });

  it('assembles the Django+Postgres graph with golden env conventions', async () => {
    const detection = await detectStack(fixture('django-postgres-repo'));
    const plan = buildServicePlan(detection, {});

    expect(plan.services.map((s) => s.id)).toEqual(['db', 'backend']);
    const [db, backend] = plan.services;

    expect(db?.source).toEqual({ type: 'image', image: 'postgres:16' });
    expect(db?.environment).toEqual({
      POSTGRES_DB: 'orca',
      POSTGRES_USER: 'orca',
      POSTGRES_PASSWORD: 'orca',
    });
    expect(db?.healthcheck?.test).toEqual(['CMD-SHELL', 'pg_isready -U orca']);

    expect(backend?.source).toEqual({ type: 'build', context: '.', dockerfile: 'Dockerfile' });
    expect(backend?.environment).toMatchObject({
      DJANGO_DEBUG: '1',
      POSTGRES_HOST: 'db',
      POSTGRES_PORT: '5432',
    });
    // Python components get the bind mount but no node_modules shield.
    expect(backend?.volumes).toEqual([{ source: '.', target: '/app', kind: 'bind' }]);
  });

  it('applies AI-refined variables and marks the plan source as ai', async () => {
    const detection = await detectStack(fixture('mern-repo'));
    const filled = validateAgainst(FilledTemplateVarsSchema, {
      variables: { port: 4000 },
      notes: ['README says the API listens on 4000.'],
    });

    const plan = buildServicePlan(detection, { backend: filled });

    expect(plan.source).toBe('ai');
    const backend = plan.services.find((s) => s.id === 'backend');
    expect(backend?.ports).toEqual([{ host: 4000, container: 4000, protocol: 'tcp' }]);
    expect(backend?.environment['PORT']).toBe('4000');
    // The frontend's API URL follows the refined backend port.
    const frontend = plan.services.find((s) => s.id === 'frontend');
    expect(frontend?.environment['VITE_API_URL']).toBe('http://localhost:4000');
  });
});

describe('renderDiagram', () => {
  it('renders one node per service and labeled dependency edges', async () => {
    const detection = await detectStack(fixture('mern-repo'));
    const diagram = renderDiagram(buildServicePlan(detection, {}));

    expect(diagram.startsWith('flowchart LR')).toBe(true);
    expect(diagram).toContain('db[("'); // database renders as a cylinder
    expect(diagram).toContain('backend("');
    expect(diagram).toContain('backend -->|service_healthy| db');
    expect(diagram).toContain('frontend -->|service_started| backend');
    expect(diagram).toContain(':5173');
  });
});

describe('planToComposeVars → renderCompose round-trip', () => {
  it('produces valid compose YAML with the full service wiring', async () => {
    const detection = await detectStack(fixture('mern-repo'));
    const plan = buildServicePlan(detection, {});

    const composeText = renderCompose(planToComposeVars(plan));
    const compose = parseYaml(composeText) as {
      name: string;
      services: Record<
        string,
        { depends_on?: string[]; volumes?: string[]; ports?: string[]; image?: string }
      >;
      volumes: Record<string, unknown>;
      networks: Record<string, unknown>;
    };

    expect(compose.name).toBe('orca-mern-repo');
    expect(Object.keys(compose.services)).toEqual(['db', 'backend', 'frontend']);
    expect(compose.services['db']?.image).toBe('mongo:7');
    expect(compose.services['backend']?.depends_on).toEqual(['db']);
    expect(compose.services['backend']?.ports).toEqual(['3000:3000']);
    // Anonymous volume renders target-only; bind renders source:target.
    expect(compose.services['backend']?.volumes).toEqual(['./server:/app', '/app/node_modules']);
    expect(Object.keys(compose.volumes)).toEqual(['db-data']);
    expect(Object.keys(compose.networks)).toEqual(['orca-net']);
  });
});

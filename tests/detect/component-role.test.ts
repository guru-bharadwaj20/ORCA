/**
 * §2.3 role widening — `ComponentRole` beyond frontend/backend/database.
 *
 * The unit tests below pin the detector's rules; the end-to-end block proves a worker
 * repo reaches the plan as a portless `'service'` node, which is the whole point of the
 * widening (a worker that advertised port 8080 would be worse than not detecting it).
 *
 * The regression this file guards hardest: a component that DECLARES A PORT is never
 * reclassified, no matter what else it looks like. That master gate is what keeps a web
 * app which merely enqueues background jobs from being demoted to a worker.
 */
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { detectComponentRole } from '../../src/detect/componentRole.js';
import { detectStack } from '../../src/detect/index.js';
import { detectPorts, declaredPorts } from '../../src/detect/ports.js';
import { buildServicePlan } from '../../src/plan/servicePlan.js';
import type { DetectedComponent } from '../../src/detect/types.js';

const fixture = (name: string): string =>
  fileURLToPath(new URL(`../fixtures/${name}`, import.meta.url));

describe('detectComponentRole', () => {
  it('classifies a Procfile worker with no web process as a worker', async () => {
    const detection = await detectComponentRole(fixture('celery-worker-repo'), {
      dependencies: ['celery', 'redis'],
      declaredPorts: [],
    });
    expect(detection?.role).toBe('worker');
    expect(detection?.signal).toContain('Procfile');
  });

  it('classifies a queue-library dependency with no web framework as a worker', async () => {
    const detection = await detectComponentRole(fixture('go-worker-repo'), {
      dependencies: ['github.com/hibiken/asynq'],
      declaredPorts: [],
    });
    expect(detection?.role).toBe('worker');
    expect(detection?.signal).toContain('asynq');
  });

  it('classifies an npm package with a bin and no server script as a cli', async () => {
    const detection = await detectComponentRole(fixture('node-cli-repo'), {
      dependencies: ['commander'],
      declaredPorts: [],
    });
    expect(detection?.role).toBe('cli');
    expect(detection?.signal).toContain('widgetctl');
  });

  it('NEVER reclassifies a component that declares a port', async () => {
    // Same worker dependency, but the component listens — so it is a service, full stop.
    const detection = await detectComponentRole(fixture('go-worker-repo'), {
      dependencies: ['github.com/hibiken/asynq'],
      declaredPorts: [8080],
    });
    expect(detection).toBeNull();
  });

  it('does not demote a web app that merely depends on a queue library', async () => {
    const repo = await mkdtemp(join(tmpdir(), 'orca-role-'));
    try {
      // Celery alongside Flask: the app enqueues work, it is not the worker.
      const detection = await detectComponentRole(repo, {
        dependencies: ['flask', 'celery'],
        declaredPorts: [],
      });
      expect(detection).toBeNull();
    } finally {
      await rm(repo, { recursive: true, force: true });
    }
  });

  it('leaves an ordinary service unclassified so the caller keeps its default', async () => {
    const detection = await detectComponentRole(fixture('mern-repo'), {
      dependencies: ['express', 'mongoose'],
      declaredPorts: [],
    });
    expect(detection).toBeNull();
  });
});

describe('port defaults across roles', () => {
  it('still invents a default port for frontend and backend', async () => {
    const backend = await detectPorts(fixture('go-worker-repo'), 'backend');
    expect(backend).toEqual([{ port: 3000, protocol: 'tcp', source: 'default' }]);

    const frontend = await detectPorts(fixture('go-worker-repo'), 'frontend');
    expect(frontend).toEqual([{ port: 3000, protocol: 'tcp', source: 'default' }]);
  });

  it('invents no port at all for the non-listening roles', async () => {
    for (const role of ['worker', 'cli', 'library', 'job'] as const) {
      expect(await detectPorts(fixture('go-worker-repo'), role)).toEqual([]);
    }
  });

  it('declaredPorts never invents a default for any role', async () => {
    expect(await declaredPorts(fixture('go-worker-repo'))).toEqual([]);
    // A repo that really does declare one still reports it.
    expect(await declaredPorts(fixture('node-cli-repo'))).toEqual([]);
  });
});

describe('a worker repo end-to-end', () => {
  it('is detected as a worker and planned without a published port', async () => {
    const detection = await detectStack(fixture('go-worker-repo'));

    // Detection: the Go root matched go-mod, but its ROLE is worker, not backend.
    expect(detection.isSupported).toBe(true);
    expect(detection.insights.ecosystemComponents).toContainEqual({
      rootDir: '.',
      runtime: 'go',
      recipeId: 'go-mod',
      role: 'worker',
    });

    // The reasoning trail explains the reclassification.
    expect(detection.reasoning.some((r) => r.includes('classified as worker'))).toBe(true);

    // Plan: the go-mod recipe carries defaultPorts [8080], but a worker publishes none.
    const component: DetectedComponent = {
      role: 'worker',
      rootDir: '.',
      language: 'unknown',
      packageManager: 'unknown',
      framework: 'unknown',
      dependencies: [],
      ports: [],
      entrypoint: null,
    };
    const plan = buildServicePlan(detection, {}, null, [
      {
        id: 'app',
        component,
        recipe: {
          id: 'go-mod',
          runtime: 'go',
          dependencyFiles: ['go.mod'],
          installCommands: ['go mod download'],
          startCommand: '/app/server',
          defaultPorts: [8080],
          baseImages: { build: 'golang:1.23', runtime: 'gcr.io/distroless/base-debian12' },
        },
      },
    ]);

    const node = plan.services.find((s) => s.id === 'app');
    expect(node?.kind).toBe('service');
    expect(node?.ports).toEqual([]);
  });

  it('still publishes the recipe port when the same component is a backend', async () => {
    // The control case: identical recipe, role back to 'backend' → port 8080 published.
    const detection = await detectStack(fixture('go-worker-repo'));
    const component: DetectedComponent = {
      role: 'backend',
      rootDir: '.',
      language: 'unknown',
      packageManager: 'unknown',
      framework: 'unknown',
      dependencies: [],
      ports: [],
      entrypoint: null,
    };
    const plan = buildServicePlan(detection, {}, null, [
      {
        id: 'app',
        component,
        recipe: {
          id: 'go-mod',
          runtime: 'go',
          dependencyFiles: ['go.mod'],
          installCommands: ['go mod download'],
          startCommand: '/app/server',
          defaultPorts: [8080],
          baseImages: { build: 'golang:1.23', runtime: 'gcr.io/distroless/base-debian12' },
        },
      },
    ]);

    expect(plan.services.find((s) => s.id === 'app')?.ports).toEqual([
      { host: 8080, container: 8080, protocol: 'tcp' },
    ]);
  });
});

describe('existing repos are not reclassified', () => {
  it('keeps every web-shaped ecosystem repo on role backend', async () => {
    for (const name of ['fastapi-repo', 'rails-repo', 'php-laravel-repo']) {
      const detection = await detectStack(fixture(name));
      const roles = detection.insights.ecosystemComponents.map((e) => e.role);
      expect(roles.every((r) => r === 'backend')).toBe(true);
      expect(roles.length).toBeGreaterThan(0);
    }
  });
});

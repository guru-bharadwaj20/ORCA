/**
 * Open-role plan model — the ecosystem `'service'` node builder. Pure: a DetectedComponent
 * + a BuildRecipe → a role-agnostic ServiceNode that builds from a synthesized Dockerfile.
 */
import { describe, expect, it } from 'vitest';

import { ecosystemServiceNode } from '../../src/plan/servicePlan.js';
import type { DetectedComponent } from '../../src/detect/types.js';
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

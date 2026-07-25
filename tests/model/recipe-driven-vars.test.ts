/**
 * Decision #1 ("kill switch") acceptance: react/express/django are ordinary recipes, and
 * a seed component's Dockerfile vars are DRIVEN by its recipe — not by the old hardcoded
 * `switch (framework)` in templates/registry.ts (deleted along with `describeComponent`).
 *
 * The proof that this is recipe-driven, not a renamed switch: `recipeForComponent` resolves
 * each framework to its `BuildRecipe`, and every framework-specific field in the derived
 * `DockerfileVars` (base image, start command, default port, system packages, entrypoint)
 * equals the recipe's data. Package-manager-derived fields still come from what detection
 * found, so alternate managers are honored unchanged.
 */
import { describe, expect, it } from 'vitest';

import type { DetectedComponent } from '../../src/detect/types.js';
import { ALL_RECIPES, recipeForComponent } from '../../src/model/recipes/index.js';
import { dockerfileVarsFor } from '../../src/templates/registry.js';

function component(overrides: Partial<DetectedComponent>): DetectedComponent {
  return {
    role: 'backend',
    rootDir: '.',
    language: 'javascript',
    packageManager: 'npm',
    framework: 'express',
    dependencies: [],
    ports: [],
    entrypoint: null,
    ...overrides,
  };
}

const recipeById = (id: string) => ALL_RECIPES.find((e) => e.recipe.id === id)!.recipe;

describe('recipeForComponent: seed frameworks resolve to their recipes', () => {
  it('maps react/express/django to the shipped seed recipes', () => {
    expect(recipeForComponent(component({ role: 'frontend', framework: 'react' })).id).toBe(
      'node-react'
    );
    expect(recipeForComponent(component({ framework: 'express' })).id).toBe('node-express');
    expect(recipeForComponent(component({ language: 'python', framework: 'django' })).id).toBe(
      'python-django'
    );
  });

  it('falls back to a bare-runtime recipe for an unclassified component', () => {
    expect(recipeForComponent(component({ framework: 'unknown' })).id).toBe('node-app');
    expect(recipeForComponent(component({ language: 'python', framework: 'unknown' })).id).toBe(
      'python-app'
    );
  });
});

describe('dockerfileVarsFor: framework-specific fields come from the recipe', () => {
  it('django vars are sourced from the python-django recipe', () => {
    const recipe = recipeById('python-django');
    const vars = dockerfileVarsFor(component({ language: 'python', framework: 'django' }));

    expect(vars.baseImage).toBe(recipe.baseImages.runtime);
    expect(vars.startCommand).toBe(recipe.startCommand);
    expect(vars.port).toBe(recipe.defaultPorts[0]);
    expect(vars.systemPackages).toEqual(recipe.systemPackages);
    expect(vars.entrypointScript).toBe(recipe.entrypointScript);
  });

  it('react vars are sourced from the node-react recipe', () => {
    const recipe = recipeById('node-react');
    const vars = dockerfileVarsFor(component({ role: 'frontend', framework: 'react' }));

    expect(vars.baseImage).toBe(recipe.baseImages.runtime);
    expect(vars.startCommand).toBe(recipe.startCommand);
    expect(vars.port).toBe(recipe.defaultPorts[0]);
  });

  it('still honors the detected package manager over the recipe default', () => {
    const yarn = dockerfileVarsFor(component({ framework: 'express', packageManager: 'yarn' }));
    expect(yarn.installCommand).toBe('yarn install');
    // ...while the framework-specific start command still comes from the recipe.
    expect(yarn.startCommand).toBe(recipeById('node-express').startCommand);
  });

  it('honors a detected port over the recipe default', () => {
    const vars = dockerfileVarsFor(
      component({
        framework: 'express',
        ports: [{ port: 5000, protocol: 'tcp', source: 'default' }],
      })
    );
    expect(vars.port).toBe(5000);
  });
});

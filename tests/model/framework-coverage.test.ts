/**
 * Coverage guarantees for the widened framework set.
 *
 * These assert the two properties that make a new framework genuinely supported rather
 * than merely listed: its recipe MATCHES on the dependency that identifies it, and it
 * matches ahead of the generic fallbacks that would otherwise swallow it.
 */

import { describe, it, expect } from 'vitest';

import { defaultRecipeRegistry, ALL_RECIPES } from '../../src/model/recipes/index.js';

const registry = defaultRecipeRegistry();

const nodeFacts = (dependencies: string[]) => ({
  runtime: 'node',
  dependencies,
  files: ['package.json'],
});

const pyFacts = (dependencies: string[]) => ({
  runtime: 'python',
  dependencies,
  files: ['requirements.txt'],
});

describe('node framework coverage', () => {
  const cases: ReadonlyArray<readonly [string, string]> = [
    ['fastify', 'node-fastify'],
    ['koa', 'node-koa'],
    ['@hapi/hapi', 'node-hapi'],
    ['hono', 'node-hono'],
    ['@remix-run/node', 'node-remix'],
    ['nuxt', 'node-nuxt'],
    ['@sveltejs/kit', 'node-sveltekit'],
    ['astro', 'node-astro'],
    ['@adonisjs/core', 'node-adonis'],
  ];

  for (const [dependency, recipeId] of cases) {
    it(`routes ${dependency} to ${recipeId}`, () => {
      expect(registry.match(nodeFacts([dependency]))?.id).toBe(recipeId);
    });
  }

  it('beats the bare fallback for every covered framework', () => {
    // Each of these repos also has a package.json, which `node-app` matches on alone —
    // so this asserts ordering, not just presence.
    for (const [dependency, recipeId] of cases) {
      expect(registry.match(nodeFacts([dependency]))?.id).not.toBe('node-app');
      expect(registry.match(nodeFacts([dependency]))?.id).toBe(recipeId);
    }
  });
});

describe('python framework coverage', () => {
  const cases: ReadonlyArray<readonly [string, string]> = [
    ['litestar', 'python-litestar'],
    ['starlette', 'python-starlette'],
    ['quart', 'python-quart'],
    ['sanic', 'python-sanic'],
    ['streamlit', 'python-streamlit'],
    ['bottle', 'python-bottle'],
  ];

  for (const [dependency, recipeId] of cases) {
    it(`routes ${dependency} to ${recipeId}`, () => {
      expect(registry.match(pyFacts([dependency]))?.id).toBe(recipeId);
    });
  }

  it('beats the bare python fallback for every covered framework', () => {
    for (const [dependency, recipeId] of cases) {
      expect(registry.match(pyFacts([dependency]))?.id).toBe(recipeId);
    }
  });
});

describe('recipe registry invariants', () => {
  it('has no duplicate recipe ids', () => {
    // Two entries may legitimately share an id only across install flavours, which are
    // suffixed (`-uv`, `-poetry`). A true duplicate means one is unreachable.
    const ids = ALL_RECIPES.map((e) => e.recipe.id);
    const duplicated = ids.filter((id, i) => ids.indexOf(id) !== i);

    expect(duplicated).toEqual([]);
  });

  it('leaves a start command blank only where blank MEANS something', () => {
    // Blank is a deliberate signal — "this recipe does not know how the app starts, ask
    // the repo" — resolved by `startCommandFor` (seed) and `withStartCommand` (ecosystem).
    // It is correct for exactly two groups: the bare runtime fallback, and the frameworks
    // that ship no CLI and no start convention, where the maintainer's own script is the
    // only right answer. Anywhere else a blank would emit a Dockerfile with an empty CMD,
    // so this list is allow-listed rather than merely counted.
    const blank = ALL_RECIPES.filter((e) => e.recipe.startCommand.trim() === '').map(
      (e) => e.recipe.id
    );

    expect(new Set(blank)).toEqual(
      new Set(['node-app', 'node-fastify', 'node-koa', 'node-hapi', 'node-hono'])
    );
  });

  it('gives every recipe at least one default port or none by design', () => {
    for (const { recipe } of ALL_RECIPES) {
      expect(Array.isArray(recipe.defaultPorts)).toBe(true);
    }
  });

  it('gives every recipe a build and runtime base image', () => {
    for (const { recipe } of ALL_RECIPES) {
      expect(recipe.baseImages.build).not.toBe('');
      expect(recipe.baseImages.runtime).not.toBe('');
    }
  });
});

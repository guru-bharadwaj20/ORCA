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

  it('gives every recipe a non-empty start command or leaves it deliberately blank', () => {
    // A blank start command is meaningful ONLY for the registered bare fallbacks, where
    // it signals "unknown" for the fill chain to resolve. Anywhere else it is a bug that
    // would emit a Dockerfile with an empty CMD.
    const blank = ALL_RECIPES.filter((e) => e.recipe.startCommand.trim() === '').map(
      (e) => e.recipe.id
    );

    expect(blank).toEqual(['node-app']);
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

/**
 * PHASE A tests — the generic build model (src/model/recipe.ts). Verifies the three
 * current stacks are correctly expressed as DATA (decision #1) and that matching is
 * deterministic, most-specific-first, and returns null when nothing matches (the
 * signal for a later phase to synthesize a recipe).
 */
import { describe, expect, it } from 'vitest';

import { RecipeRegistry, SEED_RECIPES, type MatchFacts } from '../../src/model/recipe.js';

const facts = (over: Partial<MatchFacts>): MatchFacts => ({
  runtime: 'node',
  dependencies: [],
  files: [],
  ...over,
});

describe('SEED_RECIPES', () => {
  it('expresses react, express, and django as data', () => {
    expect(SEED_RECIPES.map((e) => e.recipe.id)).toEqual([
      'node-react',
      'node-express',
      'python-django',
    ]);
  });
});

describe('RecipeRegistry.match', () => {
  const registry = new RecipeRegistry();

  it('matches a React component by dependency', () => {
    const recipe = registry.match(facts({ runtime: 'node', dependencies: ['react', 'react-dom'] }));
    expect(recipe?.id).toBe('node-react');
    expect(recipe?.defaultPorts).toEqual([5173]);
    expect(recipe?.startCommand).toBe('npm run dev');
  });

  it('matches an Express component by dependency', () => {
    const recipe = registry.match(facts({ runtime: 'node', dependencies: ['express'] }));
    expect(recipe?.id).toBe('node-express');
    expect(recipe?.defaultPorts).toEqual([3000]);
  });

  it('matches Django by dependency + manage.py, carrying its system packages', () => {
    const recipe = registry.match(
      facts({
        runtime: 'python',
        dependencies: ['django'],
        files: ['manage.py', 'requirements.txt'],
      })
    );
    expect(recipe?.id).toBe('python-django');
    expect(recipe?.systemPackages).toEqual(['libpq-dev', 'gcc']);
    expect(recipe?.entrypointScript).toBe('entrypoint.sh');
  });

  it('requires the manage.py file for Django, not just the dependency', () => {
    // django dep but no manage.py → no seed recipe matches.
    expect(registry.match(facts({ runtime: 'python', dependencies: ['django'] }))).toBeNull();
  });

  it('returns null when no recipe matches (synthesis signal)', () => {
    expect(
      registry.match(facts({ runtime: 'rust', dependencies: [], files: ['Cargo.toml'] }))
    ).toBeNull();
  });

  it('accepts additional recipes via register(), matched by priority order', () => {
    const extended = new RecipeRegistry().register({
      matcher: { runtime: 'rust', anyFile: ['Cargo.toml'] },
      recipe: {
        id: 'rust-cargo',
        runtime: 'rust',
        dependencyFiles: ['Cargo.toml', 'Cargo.lock'],
        installCommands: ['cargo fetch'],
        buildCommands: ['cargo build --release'],
        startCommand: './target/release/{{binary}}',
        defaultPorts: [8080],
        baseImages: { build: 'rust:1-slim', runtime: 'debian:bookworm-slim' },
      },
    });
    expect(extended.match(facts({ runtime: 'rust', files: ['Cargo.toml'] }))?.id).toBe(
      'rust-cargo'
    );
  });
});

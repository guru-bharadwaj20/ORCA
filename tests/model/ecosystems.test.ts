/**
 * PHASE B tests — ecosystem BuildRecipes matched through the default registry. Proves
 * that adding a language is adding DATA: Go/Rust/Maven/Gradle/.NET all resolve to a
 * recipe with build + run commands and multi-stage base images, with no bespoke code.
 */
import { describe, expect, it } from 'vitest';

import { defaultRecipeRegistry } from '../../src/model/recipes/index.js';
import type { MatchFacts } from '../../src/model/recipe.js';

const registry = defaultRecipeRegistry();
const facts = (over: Partial<MatchFacts>): MatchFacts => ({
  runtime: 'node',
  dependencies: [],
  files: [],
  ...over,
});

describe('ecosystem recipes via defaultRecipeRegistry', () => {
  it('still resolves the seed stacks first', () => {
    expect(registry.match(facts({ runtime: 'node', dependencies: ['react'] }))?.id).toBe(
      'node-react'
    );
  });

  it('resolves Go and produces a compiled multi-stage recipe', () => {
    const recipe = registry.match(facts({ runtime: 'go', files: ['go.mod'] }));
    expect(recipe?.id).toBe('go-mod');
    expect(recipe?.buildCommands?.[0]).toContain('go build');
    expect(recipe?.baseImages.runtime).toContain('distroless');
  });

  it('resolves Rust with a release build and a slim runtime image', () => {
    const recipe = registry.match(facts({ runtime: 'rust', files: ['Cargo.toml'] }));
    expect(recipe?.id).toBe('rust-cargo');
    expect(recipe?.buildCommands).toEqual(['cargo build --release']);
    expect(recipe?.baseImages.build).toContain('rust');
  });

  it('distinguishes Maven from Gradle by build file', () => {
    expect(registry.match(facts({ runtime: 'jvm', files: ['pom.xml'] }))?.id).toBe('jvm-maven');
    expect(registry.match(facts({ runtime: 'jvm', files: ['build.gradle'] }))?.id).toBe(
      'jvm-gradle'
    );
  });

  it('resolves .NET to a publish-based recipe', () => {
    const recipe = registry.match(facts({ runtime: 'dotnet', files: ['global.json'] }));
    expect(recipe?.id).toBe('dotnet-sdk');
    expect(recipe?.buildCommands?.[0]).toContain('dotnet publish');
  });

  // Python web frameworks (FastAPI/Flask, in uv/Poetry/pip flavours) are matched per
  // lockfile and covered in tests/model/python-recipes.test.ts — not duplicated here.

  it('still returns null for an unknown runtime (synthesis signal)', () => {
    expect(registry.match(facts({ runtime: 'haskell', files: ['stack.yaml'] }))).toBeNull();
  });
});

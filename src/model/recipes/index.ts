/**
 * Composition point for the recipe registry: the Node/Python framework recipes, the
 * seed stacks (React/Express/Django), the generic Vite bundler, and the Phase-B
 * ecosystem recipes (Go/Rust/JVM/.NET). `defaultRecipeRegistry()` is what the pipeline
 * uses; tests can build narrower registries from the exported entry lists.
 *
 * ORDER IS BEHAVIOR. `RecipeRegistry.match` returns the FIRST satisfied matcher, so
 * this list is strictly most-specific-first:
 *
 *   1. Node frameworks   — Next/Nest declare `react`/`express` themselves, so they must
 *                          be tried before the seed matchers that key off those names
 *                          (otherwise a Next.js repo resolves to `node-react`).
 *   2. Python frameworks — FastAPI/Flask, each in uv/Poetry/pip flavours.
 *   3. Seed stacks       — the original React/Express/Django recipes, unchanged.
 *   4. Node bundler      — `vite` is a bundler, not a framework: last among Node so a
 *                          React+Vite repo keeps matching `node-react`, while Vue/
 *                          Svelte/Solid/vanilla Vite repos still get a recipe.
 *   5. Ecosystems        — Go/Rust/JVM/.NET, each on a distinct runtime.
 *   6. Scripting         — PHP (Composer) and Ruby (Bundler), each on a distinct runtime.
 *
 * Entries 5 and 6 key off runtimes distinct from every earlier entry, so their position
 * relative to the Node/Python groups never changes a match — they are ordered only among
 * themselves (most-specific framework before the generic manifest fallback).
 *
 * PHASE: B — REAL code.
 */

import { RecipeRegistry, SEED_RECIPES } from '../recipe.js';
import { ECOSYSTEM_RECIPES } from './ecosystems.js';
import { NODE_BUNDLER_RECIPES, NODE_FRAMEWORK_RECIPES } from './node.js';
import { PYTHON_RECIPES } from './python.js';
import { SCRIPTING_RECIPES } from './scripting.js';

export { ECOSYSTEM_RECIPES } from './ecosystems.js';
export { NODE_BUNDLER_RECIPES, NODE_FRAMEWORK_RECIPES } from './node.js';
export { PYTHON_RECIPES } from './python.js';
export { PHP_RECIPES, RUBY_RECIPES, SCRIPTING_RECIPES } from './scripting.js';

/** Every recipe ORCA ships, in the priority order documented above. */
export const ALL_RECIPES = [
  ...NODE_FRAMEWORK_RECIPES,
  ...PYTHON_RECIPES,
  ...SEED_RECIPES,
  ...NODE_BUNDLER_RECIPES,
  ...ECOSYSTEM_RECIPES,
  ...SCRIPTING_RECIPES,
];

/** The registry the pipeline uses: every shipped recipe, in priority order. */
export function defaultRecipeRegistry(): RecipeRegistry {
  return new RecipeRegistry(ALL_RECIPES);
}

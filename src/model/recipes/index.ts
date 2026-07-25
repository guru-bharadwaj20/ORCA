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

import type { DetectedComponent } from '../../detect/types.js';
import { RecipeRegistry, SEED_RECIPES, type BuildRecipe } from '../recipe.js';
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

/**
 * The `BuildRecipe` that drives a seed frontend/backend component's Dockerfile — the
 * single source of its build knowledge (base image, ports, install/start commands,
 * system packages, entrypoint). This is decision #1's "templates become data": the old
 * `templates/registry.ts` `switch (framework)` that hardcoded ports/start-commands is
 * gone — that data now lives on the recipe and is looked up here.
 *
 * Selection honors the detector's already-made framework classification (it did the
 * dependency/manifest work the registry matcher would otherwise redo, and — unlike the
 * matcher — needs no file list, keeping this pure and synchronous). react/express/django
 * map to their seed recipes; a component the detector left framework-'unknown' falls back
 * to a bare-runtime recipe reproducing the pre-recipe defaults exactly.
 */
const SEED_RECIPE_BY_FRAMEWORK: Readonly<Record<string, string>> = {
  react: 'node-react',
  express: 'node-express',
  django: 'python-django',
};

/**
 * Bare-runtime fallbacks for an unclassified (framework-'unknown') node/python component.
 * These reproduce, as data, exactly what the old `defaultDockerfileVars` switch emitted
 * for such a component: the Node dev-server defaults, and the slim Python base with the
 * same `npm run dev` default the old `startCommandFor('unknown')` returned (preserved
 * verbatim so this refactor changes no output — the only Python seed framework, Django,
 * has its own recipe above and never reaches this fallback).
 */
const BARE_NODE_RECIPE: BuildRecipe = {
  id: 'node-app',
  runtime: 'node',
  packageManager: 'npm',
  dependencyFiles: ['package.json'],
  installCommands: ['npm install'],
  startCommand: 'npm run dev',
  defaultPorts: [3000],
  baseImages: { build: 'node:20-slim', runtime: 'node:20-slim' },
};

const BARE_PYTHON_RECIPE: BuildRecipe = {
  id: 'python-app',
  runtime: 'python',
  packageManager: 'pip',
  dependencyFiles: ['requirements.txt'],
  installCommands: ['pip install -r requirements.txt'],
  startCommand: 'npm run dev',
  defaultPorts: [3000],
  baseImages: { build: 'python:3.12-slim', runtime: 'python:3.12-slim' },
};

export function recipeForComponent(component: DetectedComponent): BuildRecipe {
  const id = SEED_RECIPE_BY_FRAMEWORK[component.framework];
  const seed = id === undefined ? undefined : ALL_RECIPES.find((e) => e.recipe.id === id)?.recipe;
  if (seed !== undefined) return seed;
  return component.language === 'python' ? BARE_PYTHON_RECIPE : BARE_NODE_RECIPE;
}

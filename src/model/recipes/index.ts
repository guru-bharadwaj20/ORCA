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
 *   7. Bare runtimes     — Node/Python with a manifest and nothing else recognizable.
 *                          Strictly LAST: matching on a manifest alone, it would shadow
 *                          every Node/Python recipe above it from any earlier position.
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

/**
 * Bare-runtime fallbacks for an unclassified (framework-'unknown') node/python component.
 *
 * These reproduce, as data, exactly what the old `defaultDockerfileVars` switch emitted
 * for such a component: the Node dev-server defaults, and the slim Python base.
 *
 * They are also REGISTERED (last, in `BARE_RUNTIME_RECIPES` below), which they were not
 * originally — see that list for why that mattered.
 */
const BARE_NODE_RECIPE: BuildRecipe = {
  id: 'node-app',
  runtime: 'node',
  packageManager: 'npm',
  dependencyFiles: ['package.json'],
  installCommands: ['npm install'],
  // `npm run dev` is what `startCommandFor('unknown')` returned; kept verbatim so the
  // `recipeForComponent` path below emits byte-identical output to before.
  startCommand: 'npm run dev',
  defaultPorts: [3000],
  baseImages: { build: 'node:20-slim', runtime: 'node:20-slim' },
  // The `node.Dockerfile.hbs` template set this on EVERY node image it rendered,
  // classified or not, so the unclassified component this recipe serves keeps it. It is
  // inherited by the registered ecosystem fallback too, which is correct rather than
  // incidental: ORCA generates a dev stack (compose bind-mounts the source and already
  // sets `NODE_ENV=development` on the service), so a bare node image is a dev image.
  env: { NODE_ENV: 'development' },
};

/**
 * `python main.py` is a convention guess by construction — an unclassified Python app
 * declares no framework to ask. Build recovery overlays the repo's own command when CI,
 * a task runner, or the README declares one.
 *
 * This WAS `npm run dev`: the old switch's Node default, carried into the Python fallback
 * when it was extracted. Harmless only because nothing could reach it — registering these
 * recipes makes it reachable, so it is corrected here.
 *
 * 8000 is the port convention every Python framework recipe already uses (Django,
 * FastAPI, Flask); 3000 was inherited from the Node default alongside the start bug.
 */
const BARE_PYTHON_COMMON = {
  runtime: 'python' as const,
  startCommand: 'python main.py',
  defaultPorts: [8000],
  baseImages: { build: 'python:3.12-slim', runtime: 'python:3.12-slim' },
  // Carried over from `python.Dockerfile.hbs`, which set both on every Python image:
  // unbuffered stdout is what makes container logs appear at all, and skipping .pyc
  // writes keeps a bind-mounted source tree clean. Neither is dev-only.
  env: { PYTHONUNBUFFERED: '1', PYTHONDONTWRITEBYTECODE: '1' },
};

/**
 * The bare Python fallback, one entry per install flavour.
 *
 * ONE ENTRY PER FLAVOUR IS NOT OPTIONAL, and `pythonServiceRecipes` already works this
 * way for the same reason: a `BuildRecipe` carries ONE `dependencyFiles` list and ONE
 * `installCommands` list, so a matcher must only accept files its install command can
 * actually use. A single entry accepting both `requirements.txt` and `pyproject.toml`
 * while running `pip install -r requirements.txt` emits a Dockerfile whose
 * `COPY requirements.txt` is guaranteed to fail on a pyproject-only repo — an honest
 * no-match is strictly better than that, which is exactly what
 * `tests/model/python-recipes.test.ts` pins.
 *
 * Ordered most-specific-first (uv.lock → poetry.lock → requirements.txt → pyproject),
 * mirroring the framework recipes.
 */
const BARE_PYTHON_RECIPES = [
  {
    matcher: { runtime: 'python' as const, anyFile: ['uv.lock'] },
    recipe: {
      ...BARE_PYTHON_COMMON,
      id: 'python-app-uv',
      packageManager: 'uv',
      dependencyFiles: ['pyproject.toml', 'uv.lock'],
      installCommands: ['pip install uv', 'uv sync --frozen --no-install-project'],
      startCommand: `uv run --frozen --no-sync ${BARE_PYTHON_COMMON.startCommand}`,
    },
  },
  {
    matcher: { runtime: 'python' as const, anyFile: ['poetry.lock'] },
    recipe: {
      ...BARE_PYTHON_COMMON,
      id: 'python-app-poetry',
      packageManager: 'poetry',
      dependencyFiles: ['pyproject.toml', 'poetry.lock'],
      installCommands: ['pip install poetry', 'poetry install --no-root --no-interaction'],
      startCommand: `poetry run ${BARE_PYTHON_COMMON.startCommand}`,
    },
  },
  {
    matcher: { runtime: 'python' as const, anyFile: ['requirements.txt'] },
    recipe: {
      ...BARE_PYTHON_COMMON,
      id: 'python-app',
      packageManager: 'pip',
      dependencyFiles: ['requirements.txt'],
      installCommands: ['pip install -r requirements.txt'],
    },
  },
  {
    // A PEP-517 project with no lockfile and no requirements.txt. `pip install .` is the
    // standard build for exactly this shape, so it needs no requirements.txt to exist.
    matcher: { runtime: 'python' as const, anyFile: ['pyproject.toml'] },
    recipe: {
      ...BARE_PYTHON_COMMON,
      id: 'python-app-pyproject',
      packageManager: 'pip',
      dependencyFiles: ['pyproject.toml'],
      installCommands: ['pip install .'],
    },
  },
];

/**
 * The `recipeForComponent` fallback for a framework-'unknown' Python component.
 *
 * Read OFF the registered pip variant rather than re-declared. Both spellings existed and
 * were byte-identical, which is precisely the setup where one gets edited and the other
 * does not — the same duplication that let `startCommand: 'npm run dev'` survive in the
 * Python fallback for as long as it did.
 */
const BARE_PYTHON_RECIPE: BuildRecipe = (() => {
  const registered = BARE_PYTHON_RECIPES.find((e) => e.recipe.id === 'python-app')?.recipe;
  if (registered === undefined) {
    throw new Error('BARE_PYTHON_RECIPES must contain the pip variant with id "python-app"');
  }
  return registered;
})();

/**
 * The bare fallbacks as REGISTERED matchers, last in priority.
 *
 * WHY THIS EXISTS. Both recipes above were defined but never registered, so they were
 * reachable only from `recipeForComponent` — which needs a component that already
 * classified. `RecipeRegistry.match()` therefore returned null for any Node/Python root
 * whose framework no specific recipe names, and `gatherInsights` placed NOTHING: a
 * `fastify`, `koa`, or `nuxt` repo detected as `isSupported=false, confidence=0`, despite
 * ORCA having already established the runtime, a manifest, and a start script.
 *
 * ORDER IS LOAD-BEARING (see the header): these must be LAST so they can never shadow a
 * framework recipe. A React repo still matches `node-react`, a Next.js repo `node-next`,
 * a Flask repo `python-flask` — the fallback is reached only when nothing else matches.
 *
 * MATCHING ON A MANIFEST ALONE IS THE POINT. A manifest plus a runtime is genuinely
 * enough to build a container, and "we know the runtime but not the framework" describes
 * most of the long tail this project exists to cover. Roots that declare a manifest but
 * are not runnable (a workspace root, a library) are excluded downstream by the role
 * detectors, not here — this list answers "how would this build", not "should it run".
 */
export const BARE_RUNTIME_RECIPES = [
  {
    matcher: { runtime: 'node' as const, anyFile: ['package.json'] },
    // NOTE the empty `startCommand`, and that it differs from `BARE_NODE_RECIPE` above.
    // A bare fallback knows the runtime but NOT how the app starts, and saying so is the
    // point: empty means "unknown", which lets the fill chain in `ecosystemComponentsFrom`
    // use the repo's own declared command. Hardcoding `npm run dev` here instead produced
    // an image that built and then exited with `Missing script: "dev"` on the very common
    // repo whose only script is `start`. `BARE_NODE_RECIPE` keeps the old literal because
    // it feeds `recipeForComponent`, whose golden output must not move.
    recipe: { ...BARE_NODE_RECIPE, startCommand: '' },
  },
  // The Python fallbacks KEEP their start commands, deliberately. `python main.py` is a
  // convention guess, but the uv/poetry variants wrap it (`uv run …`, `poetry run …`) so
  // the app resolves the managed environment — emptying them would drop that wrapper and
  // let a raw command run outside the venv. `detectEntrypoint` also finds a Python start
  // command far less often than a Node one (package scripts vs. only Procfile/manage.py),
  // so blanking them would frequently leave nothing to fill and emit an empty CMD.
  ...BARE_PYTHON_RECIPES,
];

/**
 * Ids of the bare runtime fallbacks, for consumers that must treat "matched only because
 * a manifest exists" differently from "matched a real framework". Derived from the list
 * so it cannot fall out of step with it.
 */
export const BARE_RUNTIME_RECIPE_IDS: ReadonlySet<string> = new Set(
  BARE_RUNTIME_RECIPES.map((entry) => entry.recipe.id)
);

/** Every recipe ORCA ships, in the priority order documented above. */
export const ALL_RECIPES = [
  ...NODE_FRAMEWORK_RECIPES,
  ...PYTHON_RECIPES,
  ...SEED_RECIPES,
  ...NODE_BUNDLER_RECIPES,
  ...ECOSYSTEM_RECIPES,
  ...SCRIPTING_RECIPES,
  ...BARE_RUNTIME_RECIPES,
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
  // Frameworks the detector can now NAME (the taxonomies in `detect/types.ts` are open).
  // Each must resolve to a real recipe here, or a newly-nameable component would fall to
  // the bare runtime fallback and build worse than it did as an ecosystem component —
  // naming a framework has to be an upgrade, never a downgrade.
  vue: 'node-vite',
  svelte: 'node-vite',
  fastify: 'node-fastify',
  koa: 'node-koa',
  hapi: 'node-hapi',
};

export function recipeForComponent(component: DetectedComponent): BuildRecipe {
  const id = SEED_RECIPE_BY_FRAMEWORK[component.framework];
  const seed = id === undefined ? undefined : ALL_RECIPES.find((e) => e.recipe.id === id)?.recipe;
  if (seed !== undefined) return seed;
  return component.language === 'python' ? BARE_PYTHON_RECIPE : BARE_NODE_RECIPE;
}

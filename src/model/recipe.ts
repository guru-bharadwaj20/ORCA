/**
 * The generic build model (docs/universal-understanding-plan.md §2.2) — the data
 * abstraction that will replace `templates/registry.ts`'s hardcoded switch.
 *
 * A `BuildRecipe` is DATA describing how a runtime is built and run: install/build/
 * start commands, ports, base images. The React/Express/Django logic is expressed here
 * as three seed recipes (decision #1: "generic engine, templates become data"). Recipes
 * per ecosystem (Go, Rust, Java, …) and AI-synthesized recipes join them — all without
 * touching control flow.
 *
 * PHASE: A (foundation) — REAL code. Decision #1 is complete, renderer included: the old
 * `describeComponent` / `switch (framework)` in `templates/registry.ts` is gone, a seed
 * component's build knowledge is sourced from its recipe here via `recipeForComponent`
 * (`model/recipes/index.ts`), and the `.hbs` Dockerfile templates are deleted — seed and
 * ecosystem components alike render through `synthesizeDockerfile`.
 */

import type { PackageManager } from '../templates/types.js';

/** Open runtime taxonomy. Known members are typed; the string keeps it extensible. */
export type Runtime =
  'node' | 'python' | 'go' | 'rust' | 'jvm' | 'dotnet' | 'php' | 'ruby' | (string & {});

/**
 * How one runtime is built and run, as data. Fields mirror what a Dockerfile needs so
 * a synthesizer (Phase E) can emit a multi-stage image directly. Command strings may
 * contain `{{placeholder}}` tokens the caller fills (e.g. a Rust binary name).
 */
export interface BuildRecipe {
  /** Stable id, e.g. "node-react", "python-django", "rust-cargo". */
  id: string;
  runtime: Runtime;
  /** Package manager, when the runtime has one (Go/Rust use the toolchain directly). */
  packageManager?: PackageManager;
  /** Manifest/lock files copied first for layer caching, e.g. ["package.json"]. */
  dependencyFiles: string[];
  /** Dependency install commands, run in order, e.g. ["npm install"]. */
  installCommands: string[];
  /** Optional build commands (compiled/bundled runtimes), e.g. ["cargo build --release"]. */
  buildCommands?: string[];
  /** Process start command, e.g. "npm run dev" or "./target/release/{{binary}}". */
  startCommand: string;
  /** Default in-container ports when detection finds none. */
  defaultPorts: number[];
  /** Build- and runtime-stage base images (multi-stage: builder → slim runtime). */
  baseImages: { build: string; runtime: string };
  /** Extra apt packages the build/runtime needs, e.g. ["libpq-dev", "gcc"]. */
  systemPackages?: string[];
  /** Optional entrypoint script (e.g. Django migrate-then-run). */
  entrypointScript?: string;
  /**
   * Image-level environment a runtime needs to behave, e.g. `NODE_ENV=development` or
   * Python's unbuffered/no-bytecode pair. Data, like everything else here: this is the
   * last thing the seed `.hbs` templates expressed that a recipe could not, and carrying
   * it means one synthesizer can emit the seed images as faithfully as the ecosystem ones.
   * NOT app configuration — secrets and per-deployment values belong in compose `environment`
   * and the generated `.env`, which is where `inferEnv` puts them.
   */
  env?: Record<string, string>;
}

/**
 * A predicate over lightweight repo facts that decides whether a recipe applies. Kept
 * data-shaped (not arbitrary code) so recipes stay declarative and testable.
 */
export interface RecipeMatcher {
  /** Runtime this recipe serves. */
  runtime: Runtime;
  /** Any of these dependency names present in the component's manifest triggers a match. */
  anyDependency?: string[];
  /** Any of these files present at the component root triggers a match. */
  anyFile?: string[];
  /**
   * Any file at the root ending with one of these suffixes triggers a match — for
   * manifests whose *name* is arbitrary but whose *extension* is the signal (e.g. .NET's
   * `<Project>.csproj` / `<Solution>.sln`). Keeps the matcher declarative: it's data, not
   * a glob engine.
   */
  anySuffix?: string[];
}

/** A recipe plus the matcher that selects it. */
export interface RecipeEntry {
  matcher: RecipeMatcher;
  recipe: BuildRecipe;
}

/** Facts a caller supplies to `RecipeRegistry.match` (derived from detection). */
export interface MatchFacts {
  runtime: Runtime;
  /** Direct dependency names from the component manifest. */
  dependencies: readonly string[];
  /** Files present at the component root (basenames). */
  files: readonly string[];
}

/**
 * The three seed stacks, expressed as data. These ARE the source of the defaults
 * `templates/registry.ts` now derives (via `recipeForComponent`) — decision #1 with zero
 * capability change. Ordered by specificity (framework recipes before bare-runtime).
 */
export const SEED_RECIPES: readonly RecipeEntry[] = [
  {
    matcher: { runtime: 'node', anyDependency: ['react', 'react-dom'] },
    recipe: {
      id: 'node-react',
      runtime: 'node',
      packageManager: 'npm',
      dependencyFiles: ['package.json'],
      installCommands: ['npm install'],
      startCommand: 'npm run dev',
      defaultPorts: [5173],
      baseImages: { build: 'node:20-slim', runtime: 'node:20-slim' },
      env: { NODE_ENV: 'development' },
    },
  },
  {
    matcher: { runtime: 'node', anyDependency: ['express'] },
    recipe: {
      id: 'node-express',
      runtime: 'node',
      packageManager: 'npm',
      dependencyFiles: ['package.json'],
      installCommands: ['npm install'],
      startCommand: 'npm run dev',
      defaultPorts: [3000],
      baseImages: { build: 'node:20-slim', runtime: 'node:20-slim' },
      env: { NODE_ENV: 'development' },
    },
  },
  {
    matcher: { runtime: 'python', anyDependency: ['django'], anyFile: ['manage.py'] },
    recipe: {
      id: 'python-django',
      runtime: 'python',
      packageManager: 'pip',
      dependencyFiles: ['requirements.txt'],
      installCommands: ['pip install -r requirements.txt'],
      startCommand: 'python manage.py runserver 0.0.0.0:8000',
      defaultPorts: [8000],
      baseImages: { build: 'python:3.12-slim', runtime: 'python:3.12-slim' },
      systemPackages: ['libpq-dev', 'gcc'],
      entrypointScript: 'entrypoint.sh',
      env: { PYTHONUNBUFFERED: '1', PYTHONDONTWRITEBYTECODE: '1' },
    },
  },
];

/**
 * A registry of recipes matched against repo facts. Deterministic: the first entry
 * whose matcher is satisfied wins (entries are ordered most-specific first). Returns
 * null when nothing matches — the signal for a later phase to synthesize a recipe.
 */
export class RecipeRegistry {
  private readonly entries: RecipeEntry[];

  constructor(entries: readonly RecipeEntry[] = SEED_RECIPES) {
    this.entries = [...entries];
  }

  /** Append a recipe entry (e.g. a new ecosystem). Returns `this` for chaining. */
  register(entry: RecipeEntry): this {
    this.entries.push(entry);
    return this;
  }

  /** The first recipe whose matcher the facts satisfy, or null if none match. */
  match(facts: MatchFacts): BuildRecipe | null {
    for (const { matcher, recipe } of this.entries) {
      if (matches(matcher, facts)) return recipe;
    }
    return null;
  }
}

/** True when every constraint the matcher declares is satisfied by the facts. */
function matches(m: RecipeMatcher, facts: MatchFacts): boolean {
  if (m.runtime !== facts.runtime) return false;
  if (m.anyDependency && !m.anyDependency.some((d) => facts.dependencies.includes(d))) {
    return false;
  }
  if (m.anyFile && !m.anyFile.some((f) => facts.files.includes(f))) {
    return false;
  }
  if (m.anySuffix && !m.anySuffix.some((s) => facts.files.some((f) => f.endsWith(s)))) {
    return false;
  }
  return true;
}

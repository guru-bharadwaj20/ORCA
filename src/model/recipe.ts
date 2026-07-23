/**
 * The generic build model (docs/universal-understanding-plan.md §2.2) — the data
 * abstraction that will replace `templates/registry.ts`'s hardcoded switch.
 *
 * A `BuildRecipe` is DATA describing how a runtime is built and run: install/build/
 * start commands, ports, base images. The current React/Express/Django logic is
 * re-expressed here as three seed recipes (decision #1: "generic engine, templates
 * become data"). Later phases add recipes per ecosystem (Go, Rust, Java, …) and
 * synthesize recipes from `Claim`s when none match — all without touching control flow.
 *
 * PHASE: A (foundation) — REAL code, additive. The legacy `describeComponent` switch
 * still runs the pipeline; this registry provides the data-driven path + a matcher so
 * the migration is incremental and behavior-preserving.
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
 * The three current stacks, expressed as data. These reproduce the defaults that
 * `templates/registry.ts` derives via its switch — proving decision #1 with zero
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
  return true;
}

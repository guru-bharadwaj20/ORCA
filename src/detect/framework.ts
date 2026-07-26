import { readNodeDependencies, readPythonDependencies } from './manifest.js';
import type { FrontendFramework, BackendFramework } from './types.js';
import { NODE_FRAMEWORK_RECIPES } from '../model/recipes/node.js';

/**
 * Dependency markers that select a more specific Node framework recipe
 * (`NODE_FRAMEWORK_RECIPES`: Next.js/NestJS/Angular). Those frameworks declare
 * `react`/`express` themselves, so the seed react/express checks below must defer to
 * them — the same reasoning `model/recipes/node.ts` already documents for the recipe
 * registry's own ordering. Sourced directly from that registry so the two lists can
 * never drift apart.
 */

/**
 * Seed frontend frameworks, in match order: the dependency that names each, and the
 * framework id it resolves to.
 *
 * DATA, NOT BRANCHES. These used to be `if` chains that could only ever name `react` and
 * `express`, because the return types were closed unions. With the taxonomies open
 * (`types.ts`), naming a framework is one row here — which is the same rule the recipe
 * registry has always followed for how to BUILD one.
 */
const FRONTEND_MARKERS: ReadonlyArray<readonly [readonly string[], FrontendFramework]> = [
  [['react', 'react-dom'], 'react'],
  [['vue'], 'vue'],
  [['svelte'], 'svelte'],
];

/** Seed backend frameworks, in match order. Node markers first, then Python. */
const NODE_BACKEND_MARKERS: ReadonlyArray<readonly [readonly string[], BackendFramework]> = [
  [['express'], 'express'],
  [['fastify'], 'fastify'],
  [['koa'], 'koa'],
  [['@hapi/hapi', 'hapi'], 'hapi'],
];

const PYTHON_BACKEND_MARKERS: ReadonlyArray<readonly [readonly string[], BackendFramework]> = [
  [['django'], 'django'],
];

/**
 * Markers for frameworks the SEED detector can name itself, derived from the tables
 * above so the two can never disagree.
 *
 * Subtracted from the recipe markers below, because "defer to a more specific recipe"
 * has to mean "a framework this detector cannot name", NOT "a framework that has a
 * recipe". Those were the same set only while react/express/django were the sole
 * nameable frameworks. The moment `fastify`/`koa`/`hapi` gained recipes they joined the
 * recipe markers too, so the seed detector started deferring on exactly the frameworks
 * it had just learned to name — and every one of them silently returned `'unknown'`.
 */
const SEED_NAMEABLE: ReadonlySet<string> = new Set(
  [...FRONTEND_MARKERS, ...NODE_BACKEND_MARKERS].flatMap(([markers]) => markers)
);

/**
 * Dependency markers that select a more specific Node framework recipe the seed path
 * cannot name (Next.js / NestJS / Angular). Those frameworks declare `react`/`express`
 * themselves, so the seed checks must defer to them — the same reasoning
 * `model/recipes/node.ts` documents for the registry's own ordering. Sourced from that
 * registry so the two lists can never drift apart.
 */
const MORE_SPECIFIC_NODE_MARKERS: readonly string[] = NODE_FRAMEWORK_RECIPES.flatMap(
  (entry) => entry.matcher.anyDependency ?? []
).filter((marker) => !SEED_NAMEABLE.has(marker));

function hasMoreSpecificNodeFramework(deps: readonly string[]): boolean {
  return MORE_SPECIFIC_NODE_MARKERS.some((marker) => deps.includes(marker));
}

/** The first framework whose markers appear in `deps`, or null. */
function firstMatch<T>(
  deps: readonly string[],
  table: ReadonlyArray<readonly [readonly string[], T]>
): T | null {
  for (const [markers, framework] of table) {
    if (markers.some((m) => deps.includes(m))) return framework;
  }
  return null;
}

export async function detectFrontendFramework(componentPath: string): Promise<FrontendFramework> {
  const deps = await readNodeDependencies(componentPath);
  if (hasMoreSpecificNodeFramework(deps)) return 'unknown';
  return firstMatch(deps, FRONTEND_MARKERS) ?? 'unknown';
}

export async function detectBackendFramework(componentPath: string): Promise<BackendFramework> {
  const nodeDeps = await readNodeDependencies(componentPath);
  if (hasMoreSpecificNodeFramework(nodeDeps)) return 'unknown';
  const node = firstMatch(nodeDeps, NODE_BACKEND_MARKERS);
  if (node !== null) return node;

  const pythonDeps = await readPythonDependencies(componentPath);
  return firstMatch(pythonDeps, PYTHON_BACKEND_MARKERS) ?? 'unknown';
}

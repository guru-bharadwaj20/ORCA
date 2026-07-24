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
const MORE_SPECIFIC_NODE_MARKERS: readonly string[] = NODE_FRAMEWORK_RECIPES.flatMap(
  (entry) => entry.matcher.anyDependency ?? []
);

function hasMoreSpecificNodeFramework(deps: readonly string[]): boolean {
  return MORE_SPECIFIC_NODE_MARKERS.some((marker) => deps.includes(marker));
}

export async function detectFrontendFramework(componentPath: string): Promise<FrontendFramework> {
  const deps = await readNodeDependencies(componentPath);
  if (hasMoreSpecificNodeFramework(deps)) return 'unknown';
  if (deps.includes('react') || deps.includes('react-dom')) return 'react';
  return 'unknown';
}

export async function detectBackendFramework(componentPath: string): Promise<BackendFramework> {
  const nodeDeps = await readNodeDependencies(componentPath);
  if (hasMoreSpecificNodeFramework(nodeDeps)) return 'unknown';
  if (nodeDeps.includes('express')) return 'express';

  const pythonDeps = await readPythonDependencies(componentPath);
  if (pythonDeps.includes('django')) return 'django';

  return 'unknown';
}

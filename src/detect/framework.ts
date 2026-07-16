/**
 * Detects the frontend/backend framework of a component from its dependency manifest
 * (react in package.json; express in package.json; django in requirements/pyproject). NO AI.
 *
 * STAGE: 2 (detect) — REAL code.
 * Inputs: an absolute component root path.
 * Outputs: the detected frontend and backend framework (each may be 'unknown').
 */

import { readNodeDependencies, readPythonDependencies } from './manifest.js';
import type { FrontendFramework, BackendFramework } from './types.js';

/** Look for `react` / `react-dom` in the manifest. */
export async function detectFrontendFramework(componentPath: string): Promise<FrontendFramework> {
  const deps = await readNodeDependencies(componentPath);
  if (deps.includes('react') || deps.includes('react-dom')) return 'react';
  return 'unknown';
}

/** Look for `express` (Node) or `django` (Python) in the manifest. */
export async function detectBackendFramework(componentPath: string): Promise<BackendFramework> {
  const nodeDeps = await readNodeDependencies(componentPath);
  if (nodeDeps.includes('express')) return 'express';

  const pythonDeps = await readPythonDependencies(componentPath);
  if (pythonDeps.includes('django')) return 'django';

  return 'unknown';
}

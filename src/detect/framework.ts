/**
 * Detects the frontend/backend framework of a component from its dependency manifest
 * (react in package.json; express in package.json; django in requirements/pyproject). NO AI.
 *
 * STAGE: 2 (detect)
 * Inputs: an absolute component root path.
 * Outputs: the detected frontend and backend framework (each may be 'unknown').
 */

import type { FrontendFramework, BackendFramework } from './types.js';

// TODO(stage-2): look for `react` / `react-dom` in the manifest.
export async function detectFrontendFramework(_componentPath: string): Promise<FrontendFramework> {
  throw new Error('not implemented');
}

// TODO(stage-2): look for `express` (Node) or `django` (Python) in the manifest.
export async function detectBackendFramework(_componentPath: string): Promise<BackendFramework> {
  throw new Error('not implemented');
}

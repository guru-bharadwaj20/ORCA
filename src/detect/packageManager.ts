/**
 * Detects the package manager for a component from lockfiles and manifests:
 * npm (package-lock.json), yarn (yarn.lock), pnpm (pnpm-lock.yaml),
 * pip (requirements.txt), poetry (poetry.lock / pyproject.toml). NO AI.
 *
 * STAGE: 2 (detect)
 * Inputs: an absolute component root path.
 * Outputs: the detected `PackageManager` (or 'unknown').
 */

import type { PackageManager } from './types.js';

// TODO(stage-2): check for lockfiles in priority order, then fall back to manifests.
export async function detectPackageManager(_componentPath: string): Promise<PackageManager> {
  throw new Error('not implemented');
}

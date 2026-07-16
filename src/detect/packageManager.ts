/**
 * Detects the package manager for a component from lockfiles and manifests:
 * npm (package-lock.json), yarn (yarn.lock), pnpm (pnpm-lock.yaml),
 * pip (requirements.txt), poetry (poetry.lock / pyproject.toml). NO AI.
 *
 * STAGE: 2 (detect) — REAL code.
 * Inputs: an absolute component root path.
 * Outputs: the detected `PackageManager` (or 'unknown').
 */

import { join } from 'node:path';

import { readFileIfExists } from '../utils/fs.js';
import type { PackageManager } from './types.js';

/** Lockfiles are the strongest signal; checked before any manifest fallback. */
const LOCKFILE_MANAGER: ReadonlyArray<readonly [string, PackageManager]> = [
  ['pnpm-lock.yaml', 'pnpm'],
  ['yarn.lock', 'yarn'],
  ['package-lock.json', 'npm'],
  ['poetry.lock', 'poetry'],
];

async function exists(dir: string, file: string): Promise<boolean> {
  return (await readFileIfExists(join(dir, file))) !== null;
}

/** Check lockfiles in priority order, then fall back to manifests. */
export async function detectPackageManager(componentPath: string): Promise<PackageManager> {
  for (const [lockfile, manager] of LOCKFILE_MANAGER) {
    if (await exists(componentPath, lockfile)) return manager;
  }

  // Manifest fallbacks (no lockfile committed — common in student repos).
  const pyproject = await readFileIfExists(join(componentPath, 'pyproject.toml'));
  if (pyproject !== null && pyproject.includes('[tool.poetry]')) return 'poetry';
  if (await exists(componentPath, 'requirements.txt')) return 'pip';
  if (await exists(componentPath, 'package.json')) return 'npm';

  return 'unknown';
}

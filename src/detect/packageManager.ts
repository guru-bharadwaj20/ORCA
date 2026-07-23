import { join } from 'node:path';

import { readFileIfExists } from '../utils/fs.js';
import type { PackageManager } from './types.js';

const LOCKFILE_MANAGER: ReadonlyArray<readonly [string, PackageManager]> = [
  ['pnpm-lock.yaml', 'pnpm'],
  ['yarn.lock', 'yarn'],
  ['package-lock.json', 'npm'],
  ['poetry.lock', 'poetry'],
];

async function exists(dir: string, file: string): Promise<boolean> {
  return (await readFileIfExists(join(dir, file))) !== null;
}

export async function detectPackageManager(componentPath: string): Promise<PackageManager> {
  for (const [lockfile, manager] of LOCKFILE_MANAGER) {
    if (await exists(componentPath, lockfile)) return manager;
  }

  const pyproject = await readFileIfExists(join(componentPath, 'pyproject.toml'));
  if (pyproject !== null && pyproject.includes('[tool.poetry]')) return 'poetry';
  if (await exists(componentPath, 'requirements.txt')) return 'pip';
  if (await exists(componentPath, 'package.json')) return 'npm';

  return 'unknown';
}

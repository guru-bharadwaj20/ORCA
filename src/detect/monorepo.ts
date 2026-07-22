/**
 * Monorepo topology detection (Phase-1 spec: Turborepo, Nx, pnpm/npm/yarn workspaces).
 * Identifies the workspace tool and the declared package globs so later stages know a
 * repo holds multiple buildable packages rather than a single app. Pure file/manifest
 * inspection — no AI.
 *
 * STAGE: 2 (detect) / PHASE B — REAL code.
 */

import { join } from 'node:path';

import { readPackageJson } from './manifest.js';
import { readFileIfExists } from '../utils/fs.js';

/** The monorepo tool orchestrating a workspace. */
export type MonorepoTool = 'turborepo' | 'nx' | 'pnpm' | 'npm' | 'yarn' | 'lerna';

/** What ORCA learned about a repo's workspace layout. */
export interface MonorepoInfo {
  isMonorepo: boolean;
  /** Tools detected, most authoritative first (e.g. turborepo before the pnpm it rides on). */
  tools: MonorepoTool[];
  /** Declared workspace package globs, e.g. ["packages/*", "apps/*"]. */
  packageGlobs: string[];
}

/** Extract `packages:` globs from a pnpm-workspace.yaml (light line scan, no YAML dep). */
function parsePnpmWorkspaceGlobs(yaml: string): string[] {
  const globs: string[] = [];
  let inPackages = false;
  for (const line of yaml.split('\n')) {
    if (/^packages:/.test(line)) {
      inPackages = true;
      continue;
    }
    if (inPackages) {
      const item = /^\s*-\s*['"]?([^'"#\s]+)['"]?/.exec(line);
      if (item?.[1]) globs.push(item[1]);
      else if (/^\S/.test(line)) break; // next top-level key ends the list
    }
  }
  return globs;
}

/**
 * Inspect the repo root for monorepo markers. A repo is a monorepo when a workspace
 * tool config exists OR package.json declares `workspaces`. Turborepo/Nx are recorded
 * in addition to the underlying package-manager workspace they build on.
 */
export async function detectMonorepo(repoPath: string): Promise<MonorepoInfo> {
  const tools: MonorepoTool[] = [];
  const packageGlobs: string[] = [];

  if ((await readFileIfExists(join(repoPath, 'turbo.json'))) !== null) tools.push('turborepo');
  if (
    (await readFileIfExists(join(repoPath, 'nx.json'))) !== null ||
    (await readFileIfExists(join(repoPath, 'workspace.json'))) !== null
  ) {
    tools.push('nx');
  }
  if ((await readFileIfExists(join(repoPath, 'lerna.json'))) !== null) tools.push('lerna');

  const pnpmWorkspace = await readFileIfExists(join(repoPath, 'pnpm-workspace.yaml'));
  if (pnpmWorkspace !== null) {
    tools.push('pnpm');
    packageGlobs.push(...parsePnpmWorkspaceGlobs(pnpmWorkspace));
  }

  // package.json `workspaces` (npm/yarn): array form or the { packages: [...] } object form.
  const pkg = await readPackageJson(repoPath);
  const ws = (pkg as { workspaces?: string[] | { packages?: string[] } } | null)?.workspaces;
  if (ws) {
    const globs = Array.isArray(ws) ? ws : (ws.packages ?? []);
    packageGlobs.push(...globs);
    // Prefer yarn only when a yarn lock is present; otherwise treat as npm workspaces.
    const isYarn = (await readFileIfExists(join(repoPath, 'yarn.lock'))) !== null;
    tools.push(isYarn ? 'yarn' : 'npm');
  }

  return {
    isMonorepo: tools.length > 0 || packageGlobs.length > 0,
    tools: [...new Set(tools)],
    packageGlobs: [...new Set(packageGlobs)],
  };
}

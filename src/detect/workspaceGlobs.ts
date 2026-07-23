/**
 * Expand monorepo workspace globs (from `detectMonorepo`) into concrete package
 * directories, so `findCandidateRoots` promotes nested workspace packages
 * (`services/api`, `apps/web`) to detected components. Supports the two glob shapes
 * that dominate real workspaces:
 *   - `dir/*`       → every immediate subdirectory of `dir`
 *   - `dir/pkg`     → that exact directory
 * Deeper `**` patterns are intentionally out of scope (rare in workspace configs and
 * a walk-cost risk); they degrade to a literal path check.
 *
 * STAGE: 2 (detect) / PHASE B follow-up — REAL code. No AI.
 */

import { readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';

/** Resolve one workspace glob to existing, repo-relative directory paths. */
async function expandGlob(repoPath: string, glob: string): Promise<string[]> {
  const normalized = glob.replace(/\/+$/, '');

  if (normalized.endsWith('/*')) {
    const parent = normalized.slice(0, -2);
    const parentAbs = join(repoPath, parent);
    try {
      const entries = await readdir(parentAbs, { withFileTypes: true });
      return entries
        .filter((e) => e.isDirectory())
        .map((e) => (parent === '' ? e.name : `${parent}/${e.name}`));
    } catch {
      return [];
    }
  }

  // Literal path (or an unsupported deeper pattern): include it if it's a real dir.
  if (normalized.includes('*')) return [];
  try {
    if ((await stat(join(repoPath, normalized))).isDirectory()) return [normalized];
  } catch {
    // not present
  }
  return [];
}

/**
 * Expand every workspace glob to the set of existing package directories, deduped and
 * repo-relative. Order follows the input globs; callers still filter by manifest presence.
 */
export async function expandWorkspaceGlobs(
  repoPath: string,
  globs: readonly string[]
): Promise<string[]> {
  const dirs: string[] = [];
  for (const glob of globs) {
    for (const dir of await expandGlob(repoPath, glob)) {
      if (!dirs.includes(dir)) dirs.push(dir);
    }
  }
  return dirs;
}

/**
 * Expand monorepo workspace globs (from `detectMonorepo`) into concrete package
 * directories, so `findCandidateRoots` promotes nested workspace packages
 * (`services/api`, `apps/web`) to detected components. Supports the glob shapes that
 * dominate real workspaces:
 *   - `dir/*`       → every immediate subdirectory of `dir`
 *   - `dir/**`      → same immediate subdirectories (the ubiquitous pnpm form; the packages
 *                     themselves live one level down, and `findCandidateRoots` filters the
 *                     results by manifest presence, so a non-package group dir drops out)
 *   - `dir/pkg`     → that exact directory
 * A `*`/`**` anywhere but the trailing segment is still out of scope (rare, and a walk-cost
 * risk); such patterns degrade to a literal path check that finds nothing.
 *
 * STAGE: 2 (detect) / PHASE B follow-up — REAL code. No AI.
 */

import { readdir, stat } from 'node:fs/promises';

import { resolveWithinRoot } from '../utils/fs.js';

/**
 * Resolve one workspace glob to existing, repo-relative directory paths.
 *
 * `workspaces`/`pnpm-workspace.yaml` entries are repo-controlled content (an attacker
 * who controls the scanned repo controls these strings), so every path this resolves —
 * the `dir/*` parent and the literal-path case — is checked against `resolveWithinRoot`
 * before being touched. Without that, a glob like `"../../../"` (or a literal
 * `"../secret"`) would make ORCA `readdir`/`stat` directories outside the cloned repo.
 */
async function expandGlob(repoPath: string, glob: string): Promise<string[]> {
  const normalized = glob.replace(/\/+$/, '');

  // `dir/*` and `dir/**` both resolve to the immediate subdirectories of `dir`: that's
  // where workspace packages live, and the manifest filter downstream discards any
  // subdirectory that isn't actually a package.
  const star = /\/\*{1,2}$/.exec(normalized);
  if (star) {
    const parent = normalized.slice(0, star.index);
    const parentAbs = resolveWithinRoot(repoPath, parent);
    if (parentAbs === null) return [];
    try {
      const entries = await readdir(parentAbs, { withFileTypes: true });
      return entries
        .filter((e) => e.isDirectory())
        .map((e) => (parent === '' ? e.name : `${parent}/${e.name}`));
    } catch {
      return [];
    }
  }

  // Literal path (or an unsupported non-trailing wildcard): include it if it's a real dir.
  if (normalized.includes('*')) return [];
  const literalAbs = resolveWithinRoot(repoPath, normalized);
  if (literalAbs === null) return [];
  try {
    if ((await stat(literalAbs)).isDirectory()) return [normalized];
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

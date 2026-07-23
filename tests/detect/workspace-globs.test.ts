/**
 * PHASE B follow-up tests — workspace glob expansion. Turns monorepo package globs
 * into concrete, existing package directories so nested workspace packages become
 * detected components.
 */
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { expandWorkspaceGlobs } from '../../src/detect/workspaceGlobs.js';

let repo: string;
beforeEach(async () => {
  repo = await mkdtemp(join(tmpdir(), 'orca-glob-'));
});
afterEach(async () => {
  await rm(repo, { recursive: true, force: true });
});

describe('expandWorkspaceGlobs', () => {
  it('expands a dir/* glob to every immediate subdirectory', async () => {
    await mkdir(join(repo, 'services', 'api'), { recursive: true });
    await mkdir(join(repo, 'services', 'worker'), { recursive: true });
    await writeFile(join(repo, 'services', 'note.txt'), 'x'); // files ignored

    const dirs = await expandWorkspaceGlobs(repo, ['services/*']);
    expect(dirs.sort()).toEqual(['services/api', 'services/worker']);
  });

  it('resolves a literal package path when it exists', async () => {
    await mkdir(join(repo, 'apps', 'web'), { recursive: true });
    expect(await expandWorkspaceGlobs(repo, ['apps/web'])).toEqual(['apps/web']);
  });

  it('drops globs and literals that do not resolve to a directory', async () => {
    expect(await expandWorkspaceGlobs(repo, ['nope/*', 'missing/pkg'])).toEqual([]);
  });

  it('dedupes across overlapping globs and preserves order', async () => {
    await mkdir(join(repo, 'packages', 'a'), { recursive: true });
    const dirs = await expandWorkspaceGlobs(repo, ['packages/*', 'packages/a']);
    expect(dirs).toEqual(['packages/a']);
  });

  it('ignores unsupported deep ** patterns rather than walking', async () => {
    await mkdir(join(repo, 'packages', 'a'), { recursive: true });
    expect(await expandWorkspaceGlobs(repo, ['packages/**'])).toEqual([]);
  });
});

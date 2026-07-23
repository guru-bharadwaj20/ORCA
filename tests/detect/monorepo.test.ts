/**
 * PHASE B tests — monorepo topology detection across Turborepo, Nx, pnpm, and
 * npm/yarn workspaces. Real files in a temp dir; asserts the tool set and the
 * declared package globs.
 */
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { detectMonorepo } from '../../src/detect/monorepo.js';

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'orca-mono-'));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe('detectMonorepo', () => {
  it('reports a plain single-package repo as not a monorepo', async () => {
    await writeFile(join(dir, 'package.json'), JSON.stringify({ name: 'app' }));
    const info = await detectMonorepo(dir);
    expect(info.isMonorepo).toBe(false);
    expect(info.tools).toEqual([]);
  });

  it('detects Turborepo riding on npm workspaces with globs', async () => {
    await writeFile(join(dir, 'turbo.json'), JSON.stringify({ pipeline: {} }));
    await writeFile(
      join(dir, 'package.json'),
      JSON.stringify({ name: 'root', workspaces: ['apps/*', 'packages/*'] })
    );
    const info = await detectMonorepo(dir);
    expect(info.isMonorepo).toBe(true);
    expect(info.tools).toEqual(expect.arrayContaining(['turborepo', 'npm']));
    expect(info.packageGlobs).toEqual(['apps/*', 'packages/*']);
  });

  it('detects pnpm workspaces and parses packages globs from yaml', async () => {
    await writeFile(
      join(dir, 'pnpm-workspace.yaml'),
      "packages:\n  - 'packages/*'\n  - 'apps/*'\n"
    );
    const info = await detectMonorepo(dir);
    expect(info.tools).toContain('pnpm');
    expect(info.packageGlobs).toEqual(['packages/*', 'apps/*']);
  });

  it('detects Nx', async () => {
    await writeFile(join(dir, 'nx.json'), JSON.stringify({}));
    expect((await detectMonorepo(dir)).tools).toContain('nx');
  });

  it('prefers yarn over npm when a yarn.lock is present', async () => {
    await writeFile(join(dir, 'package.json'), JSON.stringify({ workspaces: ['pkgs/*'] }));
    await writeFile(join(dir, 'yarn.lock'), '# yarn lockfile v1\n');
    expect((await detectMonorepo(dir)).tools).toContain('yarn');
  });

  it('handles the object form of workspaces', async () => {
    await writeFile(
      join(dir, 'package.json'),
      JSON.stringify({ workspaces: { packages: ['libs/*'] } })
    );
    expect((await detectMonorepo(dir)).packageGlobs).toEqual(['libs/*']);
  });
});

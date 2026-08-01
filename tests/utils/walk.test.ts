import { mkdtemp, mkdir, rm, writeFile, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, it, expect } from 'vitest';

import { walk, MAX_WALK_DEPTH, MAX_WALK_ENTRIES } from '../../src/utils/fs.js';

async function fixture(): Promise<string> {
  return mkdtemp(join(tmpdir(), 'orca-walk-'));
}

/**
 * Symlink creation requires elevation (or Developer Mode) on Windows. A test that the
 * platform cannot run should SKIP, not fail: a red suite that is red for environmental
 * reasons trains people to ignore red suites, and hides the failures that matter.
 */
async function canSymlink(): Promise<boolean> {
  const dir = await mkdtemp(join(tmpdir(), 'orca-symcheck-'));
  try {
    await mkdir(join(dir, 'target'));
    await symlink(join(dir, 'target'), join(dir, 'link'), 'dir');
    return true;
  } catch {
    return false;
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

const symlinksAvailable = await canSymlink();

describe('walk', () => {
  it('lists files recursively and deterministically', async () => {
    const root = await fixture();
    await mkdir(join(root, 'src'), { recursive: true });
    await writeFile(join(root, 'b.txt'), '');
    await writeFile(join(root, 'a.txt'), '');
    await writeFile(join(root, 'src', 'c.txt'), '');

    const files = await walk(root);

    // Sorted per directory, so the order is stable run to run.
    expect(files.map((f) => f.slice(root.length + 1))).toEqual([
      'a.txt',
      'b.txt',
      join('src', 'c.txt'),
    ]);
  });

  it('skips ignored directory names', async () => {
    const root = await fixture();
    await mkdir(join(root, 'node_modules', 'pkg'), { recursive: true });
    await writeFile(join(root, 'node_modules', 'pkg', 'index.js'), '');
    await writeFile(join(root, 'keep.txt'), '');

    const files = await walk(root);

    expect(files.map((f) => f.slice(root.length + 1))).toEqual(['keep.txt']);
  });

  it('accepts a legacy string[] ignore argument', async () => {
    const root = await fixture();
    await mkdir(join(root, 'skipme'), { recursive: true });
    await writeFile(join(root, 'skipme', 'x.txt'), '');
    await writeFile(join(root, 'y.txt'), '');

    // The pre-caps call shape must keep working â€” callers pass a bare array.
    const files = await walk(root, ['skipme']);

    expect(files.map((f) => f.slice(root.length + 1))).toEqual(['y.txt']);
  });

  it.runIf(symlinksAvailable)('does not follow symlinks, so a cycle terminates', async () => {
    const root = await fixture();
    await mkdir(join(root, 'a'), { recursive: true });
    await writeFile(join(root, 'a', 'f.txt'), '');
    // A self-referential loop: a/loop -> a. readdir reports it as neither a file nor a
    // directory (lstat semantics), so walk skips it outright and needs no visited set.
    await symlink(join(root, 'a'), join(root, 'a', 'loop'), 'dir');

    const files = await walk(root);

    expect(files.map((f) => f.slice(root.length + 1))).toEqual([join('a', 'f.txt')]);
  });

  it('truncates at maxDepth instead of recursing without bound', async () => {
    const root = await fixture();
    // root/d1/d2/d3/deep.txt â€” four levels below the root.
    await mkdir(join(root, 'd1', 'd2', 'd3'), { recursive: true });
    await writeFile(join(root, 'top.txt'), '');
    await writeFile(join(root, 'd1', 'd2', 'd3', 'deep.txt'), '');

    const shallow = await walk(root, { maxDepth: 1 });
    const full = await walk(root, { maxDepth: 10 });

    expect(shallow.map((f) => f.slice(root.length + 1))).toEqual(['top.txt']);
    expect(full.map((f) => f.slice(root.length + 1))).toContain(join('d1', 'd2', 'd3', 'deep.txt'));
  });

  it('truncates at maxEntries rather than collecting everything', async () => {
    const root = await fixture();
    for (let i = 0; i < 12; i++) {
      await writeFile(join(root, `f${String(i).padStart(2, '0')}.txt`), '');
    }

    const capped = await walk(root, { maxEntries: 5 });

    // Truncation is deterministic: sorted order means the same 5 files every run.
    expect(capped).toHaveLength(5);
    expect(capped.map((f) => f.slice(root.length + 1))).toEqual([
      'f00.txt',
      'f01.txt',
      'f02.txt',
      'f03.txt',
      'f04.txt',
    ]);
  });

  it('truncates rather than throwing when a cap is hit', async () => {
    const root = await fixture();
    await mkdir(join(root, 'nested'), { recursive: true });
    await writeFile(join(root, 'nested', 'a.txt'), '');

    // A partial list still drives useful detection; failing the run would not.
    await expect(walk(root, { maxDepth: 0, maxEntries: 0 })).resolves.toEqual([]);
  });

  it('ships caps that are generous enough for real repositories', async () => {
    expect(MAX_WALK_DEPTH).toBeGreaterThanOrEqual(16);
    expect(MAX_WALK_ENTRIES).toBeGreaterThanOrEqual(10_000);
  });
});

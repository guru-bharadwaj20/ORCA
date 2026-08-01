/**
 * `walk` promised more than it delivered: the header documents that it truncates rather
 * than throwing, but only the depth/entry CAPS truncated. An unreadable directory — or one
 * deleted mid-walk, which a repo being cloned or cleaned up underneath detection can
 * genuinely do — propagated an I/O error, and `portsFromCode` calls `walk` unguarded.
 */
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { walk } from '../../src/utils/fs.js';

describe('walk never throws', () => {
  it('returns empty for a directory that does not exist', async () => {
    await expect(walk(join(tmpdir(), 'orca-does-not-exist-9f3a2b'))).resolves.toEqual([]);
  });

  it('truncates the branch it cannot read and keeps the rest', async () => {
    const root = await mkdtemp(join(tmpdir(), 'orca-walkerr-'));
    try {
      await mkdir(join(root, 'gone'), { recursive: true });
      await writeFile(join(root, 'keep.txt'), '');
      await rm(join(root, 'gone'), { recursive: true, force: true });

      expect((await walk(root)).map((f) => f.slice(root.length + 1))).toEqual(['keep.txt']);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

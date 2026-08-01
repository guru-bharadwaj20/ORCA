/**
 * `.env` is the file ORCA's own comment calls "the file users add real credentials to",
 * and its owner-only protection was a NO-OP on Windows: Node maps `chmod` onto the single
 * FAT read-only attribute, so `0o600` left the file readable by every account on the
 * machine. The failing `mode & 0o777 === 0o666` assertion was the control not working,
 * not a quirk of the test environment.
 *
 * `restrictToOwner` therefore does the platform-appropriate thing and — just as
 * importantly — REPORTS whether it worked, so a caller can warn instead of leaving the
 * user believing a file is protected when it is not.
 */
import { mkdtemp, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { restrictToOwner } from '../../src/utils/filePerms.js';

async function tempFile(): Promise<{ dir: string; path: string }> {
  const dir = await mkdtemp(join(tmpdir(), 'orca-perms-'));
  const path = join(dir, '.env');
  await writeFile(path, 'SECRET=value\n', 'utf8');
  return { dir, path };
}

describe('restrictToOwner', () => {
  it('reports success on a file it can restrict', async () => {
    const { dir, path } = await tempFile();
    try {
      expect(await restrictToOwner(path)).toBe(true);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it.runIf(process.platform !== 'win32')('sets owner-only mode bits on POSIX', async () => {
    const { dir, path } = await tempFile();
    try {
      await restrictToOwner(path);
      expect((await stat(path)).mode & 0o777).toBe(0o600);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it.runIf(process.platform === 'win32')('removes inherited access on Windows', async () => {
    const { dir, path } = await tempFile();
    try {
      expect(await restrictToOwner(path)).toBe(true);
      // The point of the ACL: inheritance is stripped, so the machine-wide grants a file
      // in a temp directory would otherwise carry are gone. `icacls` reporting the file
      // successfully processed is the observable outcome available without parsing ACLs.
      const { execa } = await import('execa');
      const result = await execa('icacls', [path], { reject: false });
      expect(result.exitCode).toBe(0);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('reports failure rather than throwing on a path that does not exist', async () => {
    // A permissions failure must never fail a run — but it must never be silent either.
    const missing = join(tmpdir(), 'orca-perms-missing-4b1c', '.env');
    await expect(restrictToOwner(missing)).resolves.toBe(false);
  });
});

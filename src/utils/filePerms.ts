/**
 * Restrict a file to its owner, on every platform ORCA runs on.
 *
 * WHY THIS EXISTS. `chmod(path, 0o600)` is a NO-OP on Windows for the thing it is being
 * asked to do: Node maps chmod onto the single FAT read-only attribute, so the generated
 * `.env` — the file whose own comment calls it "the file users add real credentials to" —
 * stayed readable by every account on the machine. The failing assertion (`mode & 0o777`
 * came back `0o666`) was not a test-environment quirk; it was the control not working.
 *
 * Windows has no mode bits, so the equivalent is an ACL: strip inheritance and grant the
 * current user alone. `icacls` ships with Windows and is the supported way to do it.
 *
 * Returns whether the restriction is known to have been applied, so callers can WARN
 * rather than silently believe a file is protected when it is not. A security control
 * that quietly fails is worse than one that is absent.
 */

import { chmod } from 'node:fs/promises';

import { execa } from 'execa';

/** Owner-only file permissions, POSIX-style. */
const OWNER_ONLY = 0o600;

/**
 * Make `path` readable and writable by its owner only.
 *
 * Never throws: a permissions failure must not fail a run that is otherwise fine. The
 * boolean is the signal — `false` means "this file is NOT restricted", and the caller is
 * expected to say so out loud.
 */
export async function restrictToOwner(path: string): Promise<boolean> {
  if (process.platform !== 'win32') {
    try {
      await chmod(path, OWNER_ONLY);
      return true;
    } catch {
      return false;
    }
  }

  // Windows: replace the file's ACL with a single grant to the current user.
  //   /inheritance:r  drop inherited ACEs (which is where "Users: Read" comes from)
  //   /grant:r        replace, rather than add to, any existing grant for that user
  const user = process.env['USERNAME'];
  if (user === undefined || user.trim() === '') return false;
  try {
    const result = await execa('icacls', [path, '/inheritance:r', '/grant:r', `${user}:(R,W)`], {
      reject: false,
      timeout: 15_000,
    });
    return result.exitCode === 0;
  } catch {
    return false;
  }
}

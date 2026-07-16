/**
 * Filesystem helpers used across stages: safe reads, recursive walks, JSON parsing,
 * and existence checks. Keeps raw node:fs usage in one place.
 *
 * STAGE: utils (shared) — REAL code.
 * Inputs: file/dir paths.
 * Outputs: file contents, parsed JSON, directory listings.
 */

import { mkdir, readdir, readFile, writeFile as fsWriteFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

/**
 * Directory names that are never worth descending into during detection walks:
 * dependency trees, build output, VCS metadata, caches, and virtualenvs.
 */
export const DEFAULT_WALK_IGNORE: string[] = [
  'node_modules',
  '.git',
  'dist',
  'build',
  'coverage',
  '__pycache__',
  '.venv',
  'venv',
  '.orca',
  '.orca-golden',
];

/** Read a UTF-8 file, returning null if it doesn't exist (other errors propagate). */
export async function readFileIfExists(path: string): Promise<string | null> {
  try {
    return await readFile(path, 'utf8');
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ENOENT' || code === 'EISDIR') return null;
    throw err;
  }
}

/** Read + JSON.parse a file into a typed object. Throws if missing or invalid JSON. */
export async function readJson<T>(path: string): Promise<T> {
  const raw = await readFile(path, 'utf8');
  return JSON.parse(raw) as T;
}

/**
 * Recursively list files under a dir (absolute paths), skipping any directory whose
 * basename is in `ignore` (defaults to `DEFAULT_WALK_IGNORE`). Symlinks are not followed.
 */
export async function walk(dir: string, ignore: string[] = DEFAULT_WALK_IGNORE): Promise<string[]> {
  const out: string[] = [];
  const entries = await readdir(dir, { withFileTypes: true });
  // Sorted for deterministic output across platforms/filesystems.
  entries.sort((a, b) => a.name.localeCompare(b.name));
  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (!ignore.includes(entry.name)) out.push(...(await walk(full, ignore)));
    } else if (entry.isFile()) {
      out.push(full);
    }
  }
  return out;
}

/** Ensure a directory exists (mkdir -p equivalent). */
export async function ensureDir(dir: string): Promise<void> {
  await mkdir(dir, { recursive: true });
}

/** Write a UTF-8 file, creating parent directories as needed. */
export async function writeFile(path: string, contents: string): Promise<void> {
  await ensureDir(dirname(path));
  await fsWriteFile(path, contents, 'utf8');
}

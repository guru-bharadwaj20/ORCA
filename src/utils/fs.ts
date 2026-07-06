/**
 * Filesystem helpers used across stages: safe reads, recursive walks, JSON parsing,
 * and existence checks. Keeps raw node:fs usage in one place.
 *
 * STAGE: utils (shared)
 * Inputs: file/dir paths.
 * Outputs: file contents, parsed JSON, directory listings.
 */

// TODO(stage-utils): read a UTF-8 file, returning null if it doesn't exist.
export async function readFileIfExists(_path: string): Promise<string | null> {
  throw new Error('not implemented');
}

// TODO(stage-utils): read + JSON.parse a file into a typed object.
export async function readJson<T>(_path: string): Promise<T> {
  throw new Error('not implemented');
}

// TODO(stage-utils): recursively list files under a dir, honoring an ignore list.
export async function walk(_dir: string, _ignore?: string[]): Promise<string[]> {
  throw new Error('not implemented');
}

// TODO(stage-utils): ensure a directory exists (mkdir -p equivalent).
export async function ensureDir(_dir: string): Promise<void> {
  throw new Error('not implemented');
}

// TODO(stage-utils): write a UTF-8 file, creating parent directories as needed.
export async function writeFile(_path: string, _contents: string): Promise<void> {
  throw new Error('not implemented');
}

import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';

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

export async function readFileIfExists(path: string): Promise<string | null> {
  try {
    return await readFile(path, 'utf8');
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ENOENT' || code === 'EISDIR') return null;
    throw err;
  }
}

/**
 * Depth cap for `walk`. Deep enough for any realistic source tree (a pnpm monorepo's
 * `packages/<pkg>/src/<area>/…` bottoms out well before this); shallow enough that a
 * pathological or generated tree cannot spend unbounded time here.
 */
export const MAX_WALK_DEPTH = 24;

/**
 * Entry cap for `walk`. Detection only ever needs a representative sample of a repo's
 * files (language mix, port literals, entrypoints) — not a complete inventory — so
 * stopping here bounds the cost of a huge checkout without changing what is inferred.
 */
export const MAX_WALK_ENTRIES = 20_000;

/** Options for `walk`. Both caps default to the module constants above. */
export interface WalkOptions {
  ignore?: string[];
  maxDepth?: number;
  maxEntries?: number;
}

/**
 * Recursively list every file under `dir`, skipping `ignore`d directory names.
 *
 * BOUNDED BY DESIGN. Detection runs against arbitrary cloned repositories, so this is
 * hardened against pathological trees: recursion stops at `maxDepth`, and collection
 * stops once `maxEntries` files have been gathered. Hitting either cap **truncates**
 * rather than throwing — a partial file list still yields useful detection, whereas an
 * exception would fail the whole run over a repo that is merely large.
 *
 * Symlinks are never followed: `readdir(withFileTypes)` reports a symlink as neither
 * `isDirectory()` nor `isFile()` (lstat semantics), so a symlink cycle terminates on its
 * own and no `visited` set is required.
 *
 * Results are sorted per directory, so output order is deterministic — which is what lets
 * the caps truncate reproducibly instead of arbitrarily.
 */
export async function walk(
  dir: string,
  options: string[] | WalkOptions = DEFAULT_WALK_IGNORE
): Promise<string[]> {
  const opts: WalkOptions = Array.isArray(options) ? { ignore: options } : options;
  const ignore = opts.ignore ?? DEFAULT_WALK_IGNORE;
  const maxDepth = opts.maxDepth ?? MAX_WALK_DEPTH;
  const maxEntries = opts.maxEntries ?? MAX_WALK_ENTRIES;

  const out: string[] = [];
  await walkInto(dir, ignore, maxDepth, maxEntries, 0, out);
  return out;
}

/** Depth-first collector for `walk`; appends into `out` and stops at either cap. */
async function walkInto(
  dir: string,
  ignore: string[],
  maxDepth: number,
  maxEntries: number,
  depth: number,
  out: string[]
): Promise<void> {
  if (depth > maxDepth || out.length >= maxEntries) return;

  const entries = await readdir(dir, { withFileTypes: true });
  entries.sort((a, b) => a.name.localeCompare(b.name));

  for (const entry of entries) {
    if (out.length >= maxEntries) return;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (!ignore.includes(entry.name)) {
        await walkInto(full, ignore, maxDepth, maxEntries, depth + 1, out);
      }
    } else if (entry.isFile()) {
      out.push(full);
    }
  }
}

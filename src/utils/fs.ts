import { AsyncLocalStorage } from 'node:async_hooks';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';

/**
 * What an active read scope must provide. Declared here (rather than importing `FsCache`)
 * so this module stays dependency-free and there is no import cycle with `fsCache.ts`.
 */
export interface FsReadScope {
  readFile(path: string): Promise<string | null>;
  walk(dir: string, options?: string[] | WalkOptions): Promise<string[]>;
}

/**
 * The read scope in effect for the current async execution, if any.
 *
 * WHY AMBIENT RATHER THAN A PARAMETER. Detection has ~60 read sites spread over 19
 * modules, and each detector is deliberately self-sufficient — it reads whatever it needs,
 * whenever it needs it. Threading a cache argument through all of them would change every
 * signature (and every caller and test) purely to pass a performance concern through code
 * that has no business knowing about it.
 *
 * WHY THIS IS NOT A GLOBAL. `AsyncLocalStorage` binds the scope to one async execution
 * tree, so it is established by `withFsReadScope` for the duration of a single detection
 * run and is invisible outside it. Two concurrent runs — including two tests in the same
 * process — each see their own scope or none at all, which is what keeps the suite
 * hermetic. Absent a scope, reads behave exactly as they always did.
 */
const readScope = new AsyncLocalStorage<FsReadScope>();

/** The scope for the current execution, or `undefined` when running unscoped. */
export function activeFsReadScope(): FsReadScope | undefined {
  return readScope.getStore();
}

/**
 * Run `fn` with `scope` serving reads made anywhere beneath it.
 *
 * Safe to memoize inside because detection reads a STATIC checkout: nothing ORCA does
 * mutates the repo between the first detector and the last, so a file cannot change
 * within one scope. The scope ends when `fn` settles, which is what makes invalidation a
 * non-problem — a cache never outlives the snapshot it described.
 */
export function withFsReadScope<T>(scope: FsReadScope, fn: () => Promise<T>): Promise<T> {
  return readScope.run(scope, fn);
}

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

/** Read a file, returning null when it is absent — bypassing any active scope. */
export async function readFileUncached(path: string): Promise<string | null> {
  try {
    return await readFile(path, 'utf8');
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ENOENT' || code === 'EISDIR') return null;
    throw err;
  }
}

/**
 * Read a file, returning null when it is absent.
 *
 * Served from the active read scope when there is one, so the same manifest read by five
 * detectors costs one syscall. Identical behavior either way — the scope only removes
 * repeat work.
 */
export async function readFileIfExists(path: string): Promise<string | null> {
  const scope = activeFsReadScope();
  return scope === undefined ? readFileUncached(path) : scope.readFile(path);
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
  const scope = activeFsReadScope();
  if (scope !== undefined) return scope.walk(dir, options);
  return walkUncached(dir, options);
}

/** `walk`, bypassing any active read scope. The scope itself calls this on a miss. */
export async function walkUncached(
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

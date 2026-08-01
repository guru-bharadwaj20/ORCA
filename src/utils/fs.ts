import { AsyncLocalStorage } from 'node:async_hooks';
import { lstat, readdir, readFile } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';

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

/**
 * Resolve `candidate` (a repo-relative path, or one taken from repo-controlled content
 * such as a `workspaces` glob, a CI `template:`/`include:` reference, or a generated
 * file's relative path) against `root`, and return the absolute path only if it stays
 * inside `root`.
 *
 * Several call sites across `src/detect/**` and `src/generate/writeConfigs.ts`
 * previously did their own ad hoc `join(root, candidate)` with no such check, which let
 * a malicious repo point `candidate` at `../../..` (or an absolute path) to make ORCA
 * read or write outside the intended directory. Centralizing the check means every call
 * site gets it, and gets it the same way.
 */
export function resolveWithinRoot(root: string, candidate: string): string | null {
  const absRoot = resolve(root);
  const abs = resolve(absRoot, candidate);
  const rel = relative(absRoot, abs);
  if (rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) return null;
  return abs;
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

/**
 * Byte cap for a single `readFileUncached` call. Detection only ever needs text
 * evidence (manifests, README excerpts, CI YAML, shell scripts) — no legitimate one of
 * those approaches this size. Repos scanned here are untrusted, so without a cap a
 * single crafted multi-gigabyte file at a well-known path (`README.md`, `package.json`)
 * would be read entirely into memory as one JS string, a straightforward
 * memory-exhaustion DoS. 8 MiB comfortably covers any real-world text file this module
 * reads while still bounding the worst case.
 */
export const MAX_READ_BYTES = 8 * 1024 * 1024;

/**
 * Read a file, returning null when it is absent, oversized, or a symlink — bypassing
 * any active scope.
 *
 * Refuses to follow symlinks: detection reads fixed, well-known filenames
 * (`package.json`, `README.md`, …) out of an untrusted cloned repo, and `readFile`
 * dereferences symlinks by default. A repo that commits one of those names as a
 * symlink to a sensitive host path (`~/.ssh/id_rsa`, `~/.aws/credentials`, …) would
 * otherwise have its target's real contents read and forwarded to the configured AI
 * provider as "detection evidence." An `lstat` up front (treating a symlink, or a file
 * over `MAX_READ_BYTES`, the same as a missing file) closes both of these off without
 * needing every one of the ~85 call sites to know about it.
 */
export async function readFileUncached(path: string): Promise<string | null> {
  try {
    const stats = await lstat(path);
    if (stats.isSymbolicLink() || stats.size > MAX_READ_BYTES) return null;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') return null;
    throw err;
  }
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
 * exception would fail the whole run over a repo that is merely large. An unreadable
 * directory (permissions, or one deleted mid-walk) truncates the same way, so the
 * guarantee is "never throws", not merely "never throws on a cap".
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

  // An unreadable directory truncates this branch, exactly like hitting a cap does.
  // Previously only the CAPS truncated while an I/O error propagated, so the documented
  // "a partial file list still yields useful detection, whereas an exception would fail
  // the whole run" held for a large repo but not for a permission-denied subdirectory —
  // or for a directory that vanished mid-walk, which a repo being cloned or cleaned up
  // underneath detection can genuinely do.
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
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

/**
 * A detection-scoped filesystem cache (docs/universal-understanding-plan.md §10 row 12).
 *
 * Detection is single-pass over a **static checkout**: nothing ORCA runs mutates the repo
 * between the first detector and the last. But the detectors are deliberately independent
 * — each reads the facts it needs from disk — so the same `package.json`, the same
 * `Cargo.toml`, and the same directory listings are re-read many times over. There are
 * ~85 `readFileIfExists`/`walk` call sites under `src/detect/`, several of them inside a
 * per-candidate-root loop, which makes the redundant work O(roots × detectors).
 *
 * This cache removes that cost without touching detector independence: a detector still
 * asks for whatever it wants, whenever it wants, and simply gets a memoized answer the
 * second time. Independence is the design property worth keeping; the repeated I/O was
 * only ever an artifact of it.
 *
 * SCOPE IS EXPLICIT, NOT GLOBAL. A cache instance is created per detection run and thrown
 * away with it — there is no module-level singleton. That is what makes invalidation a
 * non-problem (a run cannot outlive the checkout it read) and what keeps tests hermetic:
 * two runs in the same process never share state.
 *
 * PROMISES ARE CACHED, NOT JUST RESULTS, so concurrent callers for the same path share
 * one in-flight read rather than racing to issue duplicates — detection fans out with
 * `Promise.all` in several places, so this is the common case, not an edge case.
 *
 * STAGE: 2 (detect) — REAL code. Pure memoization, no behavior change.
 */

import {
  readFileUncached,
  walkUncached,
  withFsReadScope,
  type FsReadScope,
  type WalkOptions,
  DEFAULT_WALK_IGNORE,
} from './fs.js';

/** Cache-key a walk by its directory *and* the options that change its result. */
function walkKey(dir: string, options: string[] | WalkOptions): string {
  const opts: WalkOptions = Array.isArray(options) ? { ignore: options } : options;
  const ignore = (opts.ignore ?? DEFAULT_WALK_IGNORE).join(',');
  return `${dir}\0${ignore}\0${opts.maxDepth ?? ''}\0${opts.maxEntries ?? ''}`;
}

/**
 * Memoizes file reads and directory walks for the lifetime of one detection run.
 *
 * Construct one per run and pass it to whatever wants it; never share across runs. Misses
 * delegate to the plain `fs.ts` helpers, so behavior is identical to calling them directly
 * — this only removes repeat work.
 */
export class FsCache implements FsReadScope {
  private readonly files = new Map<string, Promise<string | null>>();
  private readonly walks = new Map<string, Promise<string[]>>();

  /** Hits served from cache, for tests and diagnostics. */
  private hitCount = 0;
  /** Underlying reads actually issued, for tests and diagnostics. */
  private missCount = 0;

  /** `readFileIfExists`, memoized by absolute path. Missing files cache as `null`. */
  async readFile(path: string): Promise<string | null> {
    const cached = this.files.get(path);
    if (cached !== undefined) {
      this.hitCount++;
      return cached;
    }
    this.missCount++;
    // Must call the UNCACHED primitive: when this cache is the active scope, the public
    // `readFileIfExists` would route straight back here and recurse forever.
    const pending = this.forget(this.files, path, readFileUncached(path));
    this.files.set(path, pending);
    return pending;
  }

  /** `walk`, memoized by directory + the options that affect its result. */
  async walk(
    dir: string,
    options: string[] | WalkOptions = DEFAULT_WALK_IGNORE
  ): Promise<string[]> {
    const key = walkKey(dir, options);
    const cached = this.walks.get(key);
    if (cached !== undefined) {
      this.hitCount++;
      return cached;
    }
    this.missCount++;
    const pending = this.forget(this.walks, key, walkUncached(dir, options));
    this.walks.set(key, pending);
    return pending;
  }

  /**
   * Cache a pending read, but evict it if it REJECTS.
   *
   * Memoizing a rejection turns one transient failure into a permanent one: an EMFILE
   * under `Promise.all` fan-out, or an EACCES on a directory that is momentarily locked,
   * would be replayed to every later caller for the rest of the run, and the run would
   * behave as though the file were permanently unreadable. Successes are still cached
   * forever, which is the whole point — a run reads a static checkout.
   *
   * Note this returns the SAME promise it stores, so a rejection is delivered to the
   * caller exactly once and never becomes an unhandled rejection.
   */
  private forget<T>(store: Map<string, Promise<T>>, key: string, pending: Promise<T>): Promise<T> {
    return pending.catch((err: unknown) => {
      store.delete(key);
      throw err;
    });
  }

  /** Hit/miss counters — how much repeat I/O this run avoided. */
  stats(): { hits: number; misses: number } {
    return { hits: this.hitCount, misses: this.missCount };
  }

  /** Drop everything. Rarely needed: a run's cache normally dies with the run. */
  clear(): void {
    this.files.clear();
    this.walks.clear();
    this.hitCount = 0;
    this.missCount = 0;
  }
}

/**
 * Run `fn` with a fresh `FsCache` serving every read beneath it, then discard it.
 *
 * This is the intended entry point: one call wraps a whole detection pass, and the ~60
 * scattered `readFileIfExists`/`walk` sites underneath are memoized without any of them
 * taking a cache argument. The cache is returned alongside the result so a caller can log
 * how much repeat I/O was avoided.
 */
export async function withFsCache<T>(fn: () => Promise<T>): Promise<{ result: T; cache: FsCache }> {
  const cache = new FsCache();
  const result = await withFsReadScope(cache, fn);
  return { result, cache };
}

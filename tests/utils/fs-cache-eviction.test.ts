/**
 * `FsCache` memoized the PROMISE, so a rejection was cached alongside every success.
 *
 * That turns one transient failure into a permanent one: an EMFILE during the `Promise.all`
 * fan-out detection does in several places, or a momentarily locked file on Windows, would
 * be replayed to every later caller and the whole run would behave as though the file were
 * unreadable. Successes must still cache forever — a run reads a static checkout — so the
 * fix is specifically "evict on reject", and that is what these pin.
 *
 * The underlying primitives are mocked rather than provoked: the real error codes differ
 * per platform (a path beneath a regular file is ENOTDIR on Linux and ENOENT on Windows),
 * so a test that tried to cause a genuine I/O failure would assert different things on
 * different machines. Mocking makes the contract itself the subject.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const readFileUncached = vi.fn<(path: string) => Promise<string | null>>();
const walkUncached = vi.fn<(dir: string, options?: unknown) => Promise<string[]>>();

vi.mock('../../src/utils/fs.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/utils/fs.js')>();
  return {
    ...actual,
    readFileUncached: (path: string) => readFileUncached(path),
    walkUncached: (dir: string, options?: unknown) => walkUncached(dir, options),
  };
});

const { FsCache } = await import('../../src/utils/fsCache.js');

beforeEach(() => {
  readFileUncached.mockReset();
  walkUncached.mockReset();
});

describe('a rejected read is not memoized', () => {
  it('retries the next time instead of replaying the failure', async () => {
    readFileUncached
      .mockRejectedValueOnce(new Error('EMFILE: too many open files'))
      .mockResolvedValueOnce('recovered');
    const cache = new FsCache();

    await expect(cache.readFile('/repo/package.json')).rejects.toThrow('EMFILE');
    // The whole point: the second call reaches disk again rather than being served the
    // cached rejection.
    await expect(cache.readFile('/repo/package.json')).resolves.toBe('recovered');
    expect(readFileUncached).toHaveBeenCalledTimes(2);
  });

  it('counts the retry as a miss, so the eviction is observable', async () => {
    readFileUncached.mockRejectedValueOnce(new Error('boom')).mockResolvedValueOnce('ok');
    const cache = new FsCache();

    await expect(cache.readFile('/a')).rejects.toThrow('boom');
    await cache.readFile('/a');

    expect(cache.stats()).toEqual({ hits: 0, misses: 2 });
  });

  it('delivers the rejection to every caller that shared the in-flight read', async () => {
    // Concurrent callers still share ONE read — evicting on reject must not break the
    // de-duplication that makes the cache worth having.
    readFileUncached.mockRejectedValue(new Error('shared failure'));
    const cache = new FsCache();

    const [a, b] = await Promise.allSettled([cache.readFile('/x'), cache.readFile('/x')]);

    expect(a.status).toBe('rejected');
    expect(b.status).toBe('rejected');
    expect(readFileUncached).toHaveBeenCalledTimes(1);
  });
});

describe('a successful read is still cached forever', () => {
  it('reads once and serves the rest from cache', async () => {
    readFileUncached.mockResolvedValue('contents');
    const cache = new FsCache();

    await cache.readFile('/same');
    await cache.readFile('/same');
    await cache.readFile('/same');

    expect(readFileUncached).toHaveBeenCalledTimes(1);
    expect(cache.stats()).toEqual({ hits: 2, misses: 1 });
  });

  it('caches an absent file as null — that is a real answer, not a failure', async () => {
    readFileUncached.mockResolvedValue(null);
    const cache = new FsCache();

    await cache.readFile('/missing');
    await cache.readFile('/missing');

    expect(readFileUncached).toHaveBeenCalledTimes(1);
  });
});

describe('walks evict on reject too', () => {
  it('re-walks after a failure', async () => {
    walkUncached.mockRejectedValueOnce(new Error('EACCES')).mockResolvedValueOnce(['/repo/a.ts']);
    const cache = new FsCache();

    await expect(cache.walk('/repo')).rejects.toThrow('EACCES');
    await expect(cache.walk('/repo')).resolves.toEqual(['/repo/a.ts']);
    expect(walkUncached).toHaveBeenCalledTimes(2);
  });

  it('keys a successful walk by its options, so a different scan is a different entry', async () => {
    walkUncached.mockResolvedValue([]);
    const cache = new FsCache();

    await cache.walk('/repo');
    await cache.walk('/repo', { maxDepth: 1 });
    await cache.walk('/repo');

    expect(walkUncached).toHaveBeenCalledTimes(2);
    expect(cache.stats()).toEqual({ hits: 1, misses: 2 });
  });
});

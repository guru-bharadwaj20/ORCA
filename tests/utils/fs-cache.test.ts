import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, it, expect } from 'vitest';

import { FsCache } from '../../src/utils/fsCache.js';

async function fixture(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'orca-fscache-'));
  await mkdir(join(root, 'src'), { recursive: true });
  await writeFile(join(root, 'package.json'), '{"name":"x"}');
  await writeFile(join(root, 'src', 'index.ts'), 'export {};');
  return root;
}

describe('FsCache', () => {
  it('returns the same content as an uncached read', async () => {
    const root = await fixture();
    const cache = new FsCache();

    await expect(cache.readFile(join(root, 'package.json'))).resolves.toBe('{"name":"x"}');
  });

  it('reads a file once and serves repeats from cache', async () => {
    const root = await fixture();
    const cache = new FsCache();
    const path = join(root, 'package.json');

    await cache.readFile(path);
    await cache.readFile(path);
    await cache.readFile(path);

    expect(cache.stats()).toEqual({ hits: 2, misses: 1 });
  });

  it('caches a missing file as null without re-hitting disk', async () => {
    const root = await fixture();
    const cache = new FsCache();
    const path = join(root, 'nope.toml');

    await expect(cache.readFile(path)).resolves.toBeNull();
    await expect(cache.readFile(path)).resolves.toBeNull();
    expect(cache.stats()).toEqual({ hits: 1, misses: 1 });
  });

  it('shares one in-flight read between concurrent callers', async () => {
    const root = await fixture();
    const cache = new FsCache();
    const path = join(root, 'package.json');

    // Detection fans out with Promise.all in several places, so this is the common case.
    const [a, b, c] = await Promise.all([
      cache.readFile(path),
      cache.readFile(path),
      cache.readFile(path),
    ]);

    expect([a, b, c]).toEqual(['{"name":"x"}', '{"name":"x"}', '{"name":"x"}']);
    expect(cache.stats().misses).toBe(1);
  });

  it('memoizes walks by directory', async () => {
    const root = await fixture();
    const cache = new FsCache();

    const first = await cache.walk(root);
    const second = await cache.walk(root);

    expect(second).toEqual(first);
    expect(cache.stats()).toEqual({ hits: 1, misses: 1 });
  });

  it('treats different walk options as different entries', async () => {
    const root = await fixture();
    const cache = new FsCache();

    const deep = await cache.walk(root, { maxDepth: 10 });
    const shallow = await cache.walk(root, { maxDepth: 0 });

    // Distinct options must not collide on one key, or the second call gets a wrong answer.
    expect(deep.length).toBeGreaterThan(shallow.length);
    expect(cache.stats()).toEqual({ hits: 0, misses: 2 });
  });

  it('keys legacy array ignores the same as the equivalent options object', async () => {
    const root = await fixture();
    const cache = new FsCache();

    await cache.walk(root, ['node_modules']);
    await cache.walk(root, { ignore: ['node_modules'] });

    expect(cache.stats()).toEqual({ hits: 1, misses: 1 });
  });

  it('does not share state between instances', async () => {
    const root = await fixture();
    const a = new FsCache();
    const b = new FsCache();

    await a.readFile(join(root, 'package.json'));
    await b.readFile(join(root, 'package.json'));

    // Per-run scoping is what makes invalidation a non-problem and keeps tests hermetic.
    expect(a.stats().misses).toBe(1);
    expect(b.stats().misses).toBe(1);
  });

  it('clears cached entries and counters', async () => {
    const root = await fixture();
    const cache = new FsCache();
    const path = join(root, 'package.json');

    await cache.readFile(path);
    cache.clear();
    await cache.readFile(path);

    expect(cache.stats()).toEqual({ hits: 0, misses: 1 });
  });
});

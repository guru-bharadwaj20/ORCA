/**
 * The seed detector must NAME the frameworks the taxonomy now allows.
 *
 * Recipe coverage and detector naming are separate things: a framework can build
 * correctly while still arriving as an anonymous `'service'` node. These tests cover the
 * naming half — that `detectFrontendFramework`/`detectBackendFramework` return the
 * specific framework rather than `'unknown'`.
 */

import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, it, expect } from 'vitest';

import { detectBackendFramework, detectFrontendFramework } from '../../src/detect/framework.js';

async function repoWith(dependencies: Record<string, string>): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'orca-fw-'));
  await writeFile(join(dir, 'package.json'), JSON.stringify({ name: 'x', dependencies }));
  return dir;
}

describe('frontend framework naming', () => {
  it('names react', async () => {
    expect(await detectFrontendFramework(await repoWith({ react: '^18.0.0' }))).toBe('react');
  });

  it('names vue', async () => {
    expect(await detectFrontendFramework(await repoWith({ vue: '^3.4.0' }))).toBe('vue');
  });

  it('names svelte', async () => {
    expect(await detectFrontendFramework(await repoWith({ svelte: '^4.0.0' }))).toBe('svelte');
  });

  it('defers to a more specific framework recipe', async () => {
    // Next declares react itself; naming it 'react' would route it to the wrong recipe.
    const dir = await repoWith({ next: '^14.0.0', react: '^18.0.0' });

    expect(await detectFrontendFramework(dir)).toBe('unknown');
  });
});

describe('backend framework naming', () => {
  it('names express', async () => {
    expect(await detectBackendFramework(await repoWith({ express: '^4.18.0' }))).toBe('express');
  });

  it('names fastify', async () => {
    expect(await detectBackendFramework(await repoWith({ fastify: '^4.26.0' }))).toBe('fastify');
  });

  it('names koa', async () => {
    expect(await detectBackendFramework(await repoWith({ koa: '^2.15.0' }))).toBe('koa');
  });

  it('names hapi from its scoped package', async () => {
    expect(await detectBackendFramework(await repoWith({ '@hapi/hapi': '^21.0.0' }))).toBe('hapi');
  });

  it('defers to nest rather than naming its express dependency', async () => {
    const dir = await repoWith({ '@nestjs/core': '^10.0.0', express: '^4.18.0' });

    expect(await detectBackendFramework(dir)).toBe('unknown');
  });

  it('returns unknown for an unrecognized dependency', async () => {
    expect(await detectBackendFramework(await repoWith({ lodash: '^4.0.0' }))).toBe('unknown');
  });
});

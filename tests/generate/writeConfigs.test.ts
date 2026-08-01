import { existsSync } from 'node:fs';
import { readFile, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { parse as parseYaml } from 'yaml';

import type { InferredEnv } from '../../src/ai/schema.js';
import { cleanupWorkspace, cloneRepo, createWorkspace } from '../../src/clone/workspace.js';
import { createRunContext, type Logger, type RunContext } from '../../src/core/context.js';
import { detectStack } from '../../src/detect/index.js';
import { writeConfigs } from '../../src/generate/writeConfigs.js';
import { buildServicePlan } from '../../src/plan/servicePlan.js';

const fixture = (name: string): string =>
  fileURLToPath(new URL(`../fixtures/${name}`, import.meta.url));

const silentLogger: Logger = { debug() {}, info() {}, warn() {}, error() {} };

const workspaces: Awaited<ReturnType<typeof createWorkspace>>[] = [];

afterEach(async () => {
  while (workspaces.length > 0) await cleanupWorkspace(workspaces.pop()!);
});

async function contextFor(name: string, inferred: InferredEnv | null = null): Promise<RunContext> {
  const workspace = await createWorkspace();
  workspaces.push(workspace);
  const repoDir = await cloneRepo(fixture(name), workspace);

  const ctx = createRunContext({ repoUrl: name, workspaceDir: repoDir, logger: silentLogger });
  ctx.detection = await detectStack(repoDir);
  ctx.filled = {};
  if (inferred !== null) ctx.inferredEnv = inferred;
  ctx.plan = buildServicePlan(ctx.detection, ctx.filled, inferred);
  return ctx;
}

describe('writeConfigs', () => {
  it('writes Dockerfiles, .dockerignore, and compose for the MERN fixture', async () => {
    const ctx = await contextFor('mern-repo');

    const generated = await writeConfigs(ctx);

    expect(generated.map((f) => f.path).sort()).toEqual([
      'client/.dockerignore',
      'client/Dockerfile',
      'docker-compose.yml',
      'server/.dockerignore',
      'server/Dockerfile',
    ]);
    expect(ctx.generatedFiles).toEqual(generated);

    const dockerfile = await readFile(join(ctx.workspaceDir, 'server/Dockerfile'), 'utf8');
    expect(dockerfile).toContain('FROM node:20-slim');

    const compose = parseYaml(
      await readFile(join(ctx.workspaceDir, 'docker-compose.yml'), 'utf8')
    ) as {
      services: Record<string, { depends_on?: Record<string, { condition: string }> }>;
    };
    expect(Object.keys(compose.services)).toEqual(['db', 'backend', 'frontend']);
    expect(compose.services['backend']?.depends_on).toEqual({
      db: { condition: 'service_healthy' },
    });
  });

  it('writes the inferred .env and references it via env_file', async () => {
    const ctx = await contextFor('mern-repo', {
      variables: [
        { key: 'JWT_SECRET', value: 'change-me', required: true, reason: 'README auth section' },
      ],
    });

    const generated = await writeConfigs(ctx);

    expect(generated.find((f) => f.kind === 'env')?.path).toBe('.env');
    // An env file is where users put real credentials — keep it owner-only, not 0644.
    //
    // Asserted only where mode bits MEAN something. Windows has none: Node maps `chmod`
    // onto the single read-only attribute, so this assertion used to fail there with
    // 0o666 — and that failure was real, not a test artifact. `restrictToOwner` now sets
    // an ACL on Windows instead, which `filePerms.test.ts` covers; asserting a POSIX mode
    // here on a platform that has no such thing would only be re-testing Node's fallback.
    if (process.platform !== 'win32') {
      const mode = (await stat(join(ctx.workspaceDir, '.env'))).mode & 0o777;
      expect(mode).toBe(0o600);
    }
    const envText = await readFile(join(ctx.workspaceDir, '.env'), 'utf8');
    expect(envText).toContain('JWT_SECRET=change-me');

    const compose = parseYaml(
      await readFile(join(ctx.workspaceDir, 'docker-compose.yml'), 'utf8')
    ) as { services: Record<string, { env_file?: string[] }> };
    expect(compose.services['backend']?.env_file).toEqual(['.env']);
    expect(compose.services['db']?.env_file).toBeUndefined();
  });

  it('supplies an executable migrate-then-run entrypoint for Django', async () => {
    const ctx = await contextFor('django-postgres-repo');

    const generated = await writeConfigs(ctx);

    const entrypoint = generated.find((f) => f.kind === 'entrypoint');
    expect(entrypoint?.path).toBe('entrypoint.sh');
    const abs = join(ctx.workspaceDir, 'entrypoint.sh');
    expect((await readFile(abs, 'utf8')).includes('manage.py migrate')).toBe(true);
    if (process.platform !== 'win32') {
      expect(((await stat(abs)).mode & 0o111) !== 0).toBe(true);
    }
  });

  it("keeps the repo's own entrypoint script (app source is never overwritten)", async () => {
    const ctx = await contextFor('django-postgres-repo');
    const abs = join(ctx.workspaceDir, 'entrypoint.sh');
    await writeFile(abs, '#!/bin/sh\necho custom\n', 'utf8');

    const generated = await writeConfigs(ctx);

    expect(await readFile(abs, 'utf8')).toContain('echo custom');
    expect(generated.some((f) => f.kind === 'entrypoint')).toBe(false);
    expect(existsSync(join(ctx.workspaceDir, 'docker-compose.yml'))).toBe(true);
  });
});

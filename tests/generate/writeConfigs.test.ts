/**
 * STAGE 5 tests — writeConfigs against a real temp workspace: files land where the
 * compose build contexts expect them, the compose file is valid long-form YAML, and
 * the generated-file audit trail (= the self-heal allowlist) is complete.
 */
import { existsSync } from 'node:fs';
import { readFile, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { parse as parseYaml } from 'yaml';

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

/** Clone a fixture into a disposable workspace and build a ready-to-generate ctx. */
async function contextFor(name: string): Promise<RunContext> {
  const workspace = await createWorkspace();
  workspaces.push(workspace);
  const repoDir = await cloneRepo(fixture(name), workspace);

  const ctx = createRunContext({ repoUrl: name, workspaceDir: repoDir, logger: silentLogger });
  ctx.detection = await detectStack(repoDir);
  ctx.filled = {};
  ctx.plan = buildServicePlan(ctx.detection, ctx.filled);
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
    expect(ctx.generatedFiles).toEqual(generated); // recorded on the context too

    const dockerfile = await readFile(join(ctx.workspaceDir, 'server/Dockerfile'), 'utf8');
    expect(dockerfile).toContain('FROM node:20-slim');

    const compose = parseYaml(
      await readFile(join(ctx.workspaceDir, 'docker-compose.yml'), 'utf8')
    ) as {
      services: Record<string, { depends_on?: Record<string, { condition: string }> }>;
    };
    expect(Object.keys(compose.services)).toEqual(['db', 'backend', 'frontend']);
    // Long-form depends_on made it to disk: startup gated on the db healthcheck.
    expect(compose.services['backend']?.depends_on).toEqual({
      db: { condition: 'service_healthy' },
    });
  });

  it('supplies an executable migrate-then-run entrypoint for Django', async () => {
    const ctx = await contextFor('django-postgres-repo');

    const generated = await writeConfigs(ctx);

    const entrypoint = generated.find((f) => f.kind === 'entrypoint');
    expect(entrypoint?.path).toBe('entrypoint.sh');
    const abs = join(ctx.workspaceDir, 'entrypoint.sh');
    expect((await readFile(abs, 'utf8')).includes('manage.py migrate')).toBe(true);
    expect(((await stat(abs)).mode & 0o111) !== 0).toBe(true); // executable
  });

  it("keeps the repo's own entrypoint script (app source is never overwritten)", async () => {
    const ctx = await contextFor('django-postgres-repo');
    const abs = join(ctx.workspaceDir, 'entrypoint.sh');
    await writeFile(abs, '#!/bin/sh\necho custom\n', 'utf8');

    const generated = await writeConfigs(ctx);

    expect(await readFile(abs, 'utf8')).toContain('echo custom');
    // Not ORCA-generated → not in the audit trail → self-heal may not patch it.
    expect(generated.some((f) => f.kind === 'entrypoint')).toBe(false);
    expect(existsSync(join(ctx.workspaceDir, 'docker-compose.yml'))).toBe(true);
  });
});

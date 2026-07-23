/**
 * Open-role generate integration — an ecosystem 'service' node flows through
 * buildServicePlan → writeConfigs and yields a SYNTHESIZED (multi-stage) Dockerfile,
 * not a seed-stack template. Uses a real temp workspace with a Go module.
 */
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createRunContext, type Logger } from '../../src/core/context.js';
import { detectStack } from '../../src/detect/index.js';
import { writeConfigs } from '../../src/generate/writeConfigs.js';
import { defaultRecipeRegistry } from '../../src/model/recipes/index.js';
import { buildServicePlan, type EcosystemComponent } from '../../src/plan/servicePlan.js';

const silent: Logger = { debug() {}, info() {}, warn() {}, error() {} };

let repo: string;
beforeEach(async () => {
  repo = await mkdtemp(join(tmpdir(), 'orca-eco-'));
});
afterEach(async () => {
  await rm(repo, { recursive: true, force: true });
});

describe('ecosystem generate integration', () => {
  it('synthesizes a multi-stage Dockerfile for a Go service node', async () => {
    const svcDir = join(repo, 'api');
    await mkdir(svcDir, { recursive: true });
    await writeFile(join(svcDir, 'go.mod'), 'module example.com/api\n\ngo 1.23\n');
    await writeFile(join(svcDir, 'main.go'), 'package main\nfunc main() {}\n');

    const detection = await detectStack(repo);
    const recipe = defaultRecipeRegistry().match({
      runtime: 'go',
      dependencies: [],
      files: ['go.mod'],
    });
    expect(recipe).not.toBeNull();

    // detection.backend is null for a Go repo (no seed framework), so describe the
    // component directly — this is what the eventual detection wiring will supply.
    const eco: EcosystemComponent[] = [
      {
        id: 'api',
        recipe: recipe!,
        component: {
          role: 'backend',
          rootDir: 'api',
          language: 'go',
          packageManager: 'unknown',
          framework: 'unknown',
          dependencies: [],
          ports: [],
          entrypoint: null,
        },
      },
    ];

    const ctx = createRunContext({ repoUrl: 'x', workspaceDir: repo, logger: silent });
    ctx.detection = detection;
    ctx.filled = {};
    ctx.plan = buildServicePlan(detection, {}, null, eco);

    const files = await writeConfigs(ctx);
    const dockerfile = files.find((f) => f.path === 'api/Dockerfile');
    expect(dockerfile).toBeDefined();

    const body = await readFile(join(repo, 'api/Dockerfile'), 'utf8');
    expect(body).toContain('AS builder'); // synthesized multi-stage, not a template
    expect(body).toContain('go build');
    expect(body).toContain('COPY --from=builder');
    // The compose file references the service.
    const compose = await readFile(join(repo, 'docker-compose.yml'), 'utf8');
    expect(compose).toContain('api:');
    // The .dockerignore carries the Go build outputs on top of the base set.
    const dockerignore = await readFile(join(repo, 'api/.dockerignore'), 'utf8');
    expect(dockerignore).toContain('node_modules'); // base set
    expect(dockerignore).toContain('vendor'); // go-specific
    expect(dockerignore).toContain('bin'); // go-specific
  });

  it('writes a synthesized Dockerfile for an AI-inferred (ai-*) recipe with blank base images', async () => {
    // The inferred-recipe shape inferBuild returns: id `ai-*`, empty baseImages. It is
    // NOT in the shipped registry, so this proves the inline-recipe path (not id lookup)
    // and the synthesizer's base-image fallback both work through writeConfigs.
    await writeFile(join(repo, 'main.rs'), 'fn main() {}\n');

    const detection = await detectStack(repo);
    const eco: EcosystemComponent[] = [
      {
        id: 'app',
        recipe: {
          id: 'ai-rust',
          runtime: 'rust',
          dependencyFiles: [],
          installCommands: ['cargo fetch'],
          buildCommands: ['cargo build --release'],
          startCommand: './target/release/app',
          defaultPorts: [8080],
          baseImages: { build: '', runtime: '' },
        },
        component: {
          role: 'backend',
          rootDir: '.',
          language: 'rust',
          packageManager: 'unknown',
          framework: 'unknown',
          dependencies: [],
          ports: [],
          entrypoint: null,
        },
      },
    ];

    const ctx = createRunContext({ repoUrl: 'x', workspaceDir: repo, logger: silent });
    ctx.detection = detection;
    ctx.filled = {};
    ctx.plan = buildServicePlan(detection, {}, null, eco);

    const files = await writeConfigs(ctx);
    expect(files.some((f) => f.path === 'Dockerfile')).toBe(true);
    expect(files.some((f) => f.path === '.dockerignore')).toBe(true);

    const body = await readFile(join(repo, 'Dockerfile'), 'utf8');
    expect(body).toContain('recipe ai-rust');
    expect(body).toContain('cargo build --release');
    expect(body).toContain('FROM rust:1 AS builder'); // blank base image filled in
    expect(body).not.toContain('FROM  AS builder');
  });

  it('writes a passthrough entrypoint script when a recipe declares one', async () => {
    // The synthesizer emits `COPY <entrypointScript>` + ENTRYPOINT; writeConfigs must
    // supply the script so the COPY resolves and the build does not fail.
    await writeFile(join(repo, 'go.mod'), 'module example.com/svc\n\ngo 1.23\n');

    const detection = await detectStack(repo);
    const eco: EcosystemComponent[] = [
      {
        id: 'app',
        recipe: {
          id: 'svc-with-entry',
          runtime: 'go',
          dependencyFiles: ['go.mod'],
          installCommands: ['go mod download'],
          buildCommands: ['go build -o /app/server ./...'],
          startCommand: '/app/server',
          defaultPorts: [8080],
          baseImages: { build: 'golang:1.23', runtime: 'gcr.io/distroless/base-debian12' },
          entrypointScript: 'entrypoint.sh',
        },
        component: {
          role: 'backend',
          rootDir: '.',
          language: 'go',
          packageManager: 'unknown',
          framework: 'unknown',
          dependencies: [],
          ports: [],
          entrypoint: null,
        },
      },
    ];

    const ctx = createRunContext({ repoUrl: 'x', workspaceDir: repo, logger: silent });
    ctx.detection = detection;
    ctx.filled = {};
    ctx.plan = buildServicePlan(detection, {}, null, eco);

    const files = await writeConfigs(ctx);
    expect(files.some((f) => f.path === 'entrypoint.sh' && f.kind === 'entrypoint')).toBe(true);
    const body = await readFile(join(repo, 'Dockerfile'), 'utf8');
    expect(body).toContain('COPY entrypoint.sh /usr/local/bin/entrypoint.sh');
    expect(body).toContain('ENTRYPOINT ["/usr/local/bin/entrypoint.sh"]');
    const script = await readFile(join(repo, 'entrypoint.sh'), 'utf8');
    expect(script).toContain('exec "$@"');
  });

  it('does not overwrite a repo-provided entrypoint script', async () => {
    await writeFile(join(repo, 'go.mod'), 'module example.com/svc\n\ngo 1.23\n');
    await writeFile(join(repo, 'entrypoint.sh'), '#!/bin/sh\necho "mine"\nexec "$@"\n');

    const detection = await detectStack(repo);
    const eco: EcosystemComponent[] = [
      {
        id: 'app',
        recipe: {
          id: 'svc-keep-entry',
          runtime: 'go',
          dependencyFiles: ['go.mod'],
          installCommands: ['go mod download'],
          buildCommands: ['go build -o /app/server ./...'],
          startCommand: '/app/server',
          defaultPorts: [8080],
          baseImages: { build: 'golang:1.23', runtime: 'gcr.io/distroless/base-debian12' },
          entrypointScript: 'entrypoint.sh',
        },
        component: {
          role: 'backend',
          rootDir: '.',
          language: 'go',
          packageManager: 'unknown',
          framework: 'unknown',
          dependencies: [],
          ports: [],
          entrypoint: null,
        },
      },
    ];

    const ctx = createRunContext({ repoUrl: 'x', workspaceDir: repo, logger: silent });
    ctx.detection = detection;
    ctx.filled = {};
    ctx.plan = buildServicePlan(detection, {}, null, eco);

    await writeConfigs(ctx);
    // The repo's own script is app source — kept verbatim, never replaced.
    const script = await readFile(join(repo, 'entrypoint.sh'), 'utf8');
    expect(script).toContain('echo "mine"');
  });
});

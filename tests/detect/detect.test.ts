import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import { detectStack } from '../../src/detect/index.js';
import { detectLanguages } from '../../src/detect/language.js';
import { detectPackageManager } from '../../src/detect/packageManager.js';

const fixture = (name: string): string =>
  fileURLToPath(new URL(`../fixtures/${name}`, import.meta.url));

describe('detect stage', () => {
  it('detects a MERN repo as react + express + mongodb', async () => {
    const result = await detectStack(fixture('mern-repo'));

    expect(result.isSupported).toBe(true);
    expect(result.languages).toEqual(['javascript']);
    expect(result.packageManagers).toEqual(['yarn', 'npm']);

    expect(result.frontend).not.toBeNull();
    expect(result.frontend?.framework).toBe('react');
    expect(result.frontend?.rootDir).toBe('client');
    expect(result.frontend?.language).toBe('javascript');
    expect(result.frontend?.packageManager).toBe('yarn');
    expect(result.frontend?.dependencies).toContain('react');
    expect(result.frontend?.ports).toEqual([{ port: 5173, protocol: 'tcp', source: 'code' }]);
    expect(result.frontend?.entrypoint).toEqual({
      role: 'frontend',
      command: 'yarn dev',
      workingDir: 'client',
      source: 'package-json-script',
    });

    expect(result.backend).not.toBeNull();
    expect(result.backend?.framework).toBe('express');
    expect(result.backend?.rootDir).toBe('server');
    expect(result.backend?.packageManager).toBe('npm');
    expect(result.backend?.ports).toEqual([{ port: 3000, protocol: 'tcp', source: 'code' }]);
    expect(result.backend?.entrypoint).toEqual({
      role: 'backend',
      command: 'npm run dev',
      workingDir: 'server',
      source: 'package-json-script',
    });

    // Single-component-per-role repos: .components is the authoritative list, and the
    // derived .frontend/.backend compat fields must mirror it exactly (P0 fix regression
    // guard — see tests/plan/multi-component.test.ts for the multi-component case).
    expect(result.components).toHaveLength(2);
    expect(result.components).toContainEqual(result.frontend);
    expect(result.components).toContainEqual(result.backend);

    expect(result.databases).toEqual([
      { engine: 'mongodb', defaultPort: 27017, detectedFrom: 'mongoose' },
    ]);
    expect(result.warnings).toEqual([]);
    expect(result.confidence).toBeGreaterThan(0.8);
    // Confidence carries a reasoning trail (Universal Understanding model §4).
    expect(result.reasoning).toEqual(
      expect.arrayContaining([
        expect.stringContaining('backend component detected'),
        expect.stringContaining('frontend component detected'),
        expect.stringContaining('database dependency found'),
      ])
    );
    // Phase-B/C insights surface the richer framework signals alongside the seed path.
    expect(result.insights.frameworks).toEqual(expect.arrayContaining(['react', 'express']));
    expect(result.insights.monorepoTools).toEqual([]);
  });

  it('detects a Django + Postgres repo', async () => {
    const result = await detectStack(fixture('django-postgres-repo'));

    expect(result.isSupported).toBe(true);
    expect(result.languages).toEqual(['python']);
    expect(result.packageManagers).toEqual(['pip']);
    expect(result.frontend).toBeNull();

    expect(result.backend).not.toBeNull();
    expect(result.backend?.framework).toBe('django');
    expect(result.backend?.rootDir).toBe('.');
    expect(result.backend?.language).toBe('python');
    expect(result.backend?.packageManager).toBe('pip');
    expect(result.backend?.dependencies).toEqual(
      expect.arrayContaining(['django', 'psycopg2-binary'])
    );
    expect(result.backend?.ports).toEqual([{ port: 8000, protocol: 'tcp', source: 'default' }]);
    expect(result.backend?.entrypoint).toEqual({
      role: 'backend',
      command: 'python manage.py runserver 0.0.0.0:8000',
      workingDir: '.',
      source: 'manage-py',
    });

    expect(result.databases).toEqual([
      { engine: 'postgres', defaultPort: 5432, detectedFrom: 'psycopg2-binary' },
    ]);
    expect(result.confidence).toBeGreaterThan(0.5);
  });

  it('supports a Rust repo via an ecosystem recipe (open-role containerization)', async () => {
    // The Rust fixture matches the cargo recipe, so it's now containerizable as an
    // open 'service' even without a seed frontend/backend: supported, non-zero
    // confidence, and the ecosystem component surfaced for the plan to place.
    const result = await detectStack(fixture('unsupported-repo'));

    expect(result.languages).toEqual(['rust']);
    expect(result.isSupported).toBe(true);
    expect(result.frontend).toBeNull();
    expect(result.backend).toBeNull();
    expect(result.confidence).toBeGreaterThan(0);
    expect(result.insights.ecosystemComponents).toContainEqual(
      expect.objectContaining({
        rootDir: '.',
        runtime: 'rust',
        recipeId: 'rust-cargo',
        // A web-shaped ecosystem repo stays a backend — role widening reclassifies nothing.
        role: 'backend',
      })
    );
  });

  it('supports a FastAPI repo via an ecosystem recipe, not the seed backend path', async () => {
    // FastAPI has no seed BackendFramework, so the seed path leaves backend null; the
    // Python ecosystem recipe places it as an open 'service' instead. Django's seed path
    // is untouched (it carries manage.py and stays on the backend path).
    const result = await detectStack(fixture('fastapi-repo'));

    expect(result.isSupported).toBe(true);
    expect(result.languages).toEqual(['python']);
    expect(result.backend).toBeNull();
    expect(result.frontend).toBeNull();
    expect(result.insights.ecosystemComponents).toContainEqual(
      expect.objectContaining({
        rootDir: '.',
        runtime: 'python',
        recipeId: 'python-fastapi',
        role: 'backend',
      })
    );
    // The Postgres dependency is still detected — it wires into the service's plan node.
    expect(result.databases).toEqual([
      { engine: 'postgres', defaultPort: 5432, detectedFrom: 'psycopg2-binary' },
    ]);
  });

  describe('Node framework recipes take priority over the seed react/express match', () => {
    // Next.js/NestJS declare react/express themselves, so a naive seed match would
    // misdetect them; Angular/non-React Vite previously matched nothing at all. Each
    // must resolve through the more specific recipe at the full detectStack level, not
    // just when the registry is queried directly (that layer was already correct).

    it('routes a Next.js repo to node-next, not the seed react match', async () => {
      const result = await detectStack(fixture('nextjs-repo'));

      expect(result.isSupported).toBe(true);
      expect(result.frontend).toBeNull();
      expect(result.backend).toBeNull();
      expect(result.insights.ecosystemComponents).toContainEqual(
        expect.objectContaining({
          rootDir: '.',
          runtime: 'node',
          recipeId: 'node-next',
          role: 'backend',
        })
      );
    });

    it('routes a NestJS repo to node-nest, not the seed express match', async () => {
      const result = await detectStack(fixture('nestjs-repo'));

      expect(result.isSupported).toBe(true);
      expect(result.frontend).toBeNull();
      expect(result.backend).toBeNull();
      expect(result.insights.ecosystemComponents).toContainEqual(
        expect.objectContaining({
          rootDir: '.',
          runtime: 'node',
          recipeId: 'node-nest',
          role: 'backend',
        })
      );
    });

    it('routes an Angular repo to node-angular (previously unmatched)', async () => {
      const result = await detectStack(fixture('angular-repo'));

      expect(result.isSupported).toBe(true);
      expect(result.frontend).toBeNull();
      expect(result.insights.ecosystemComponents).toContainEqual(
        expect.objectContaining({
          rootDir: '.',
          runtime: 'node',
          recipeId: 'node-angular',
          role: 'backend',
        })
      );
    });

    it('routes a non-React Vite (Vue) repo to node-vite (previously unmatched)', async () => {
      const result = await detectStack(fixture('vite-vue-repo'));

      expect(result.isSupported).toBe(true);
      expect(result.frontend).toBeNull();
      expect(result.insights.ecosystemComponents).toContainEqual(
        expect.objectContaining({
          rootDir: '.',
          runtime: 'node',
          recipeId: 'node-vite',
          role: 'backend',
        })
      );
    });

    it('regression: a plain React + Express repo (MERN) still resolves to the seed path, with no double-placement', async () => {
      const result = await detectStack(fixture('mern-repo'));

      expect(result.frontend?.framework).toBe('react');
      expect(result.backend?.framework).toBe('express');
      // node-react/node-express must NOT also appear as ecosystem components for the
      // same roots — the seed path and the ecosystem path must stay disjoint.
      expect(result.insights.ecosystemComponents).toEqual([]);
    });

    it('regression: a plain Express-only repo still resolves to node-express via the seed path', async () => {
      const result = await detectStack(fixture('express-dbconfig-repo'));

      expect(result.backend?.framework).toBe('express');
      expect(result.insights.ecosystemComponents).toEqual([]);
    });
  });

  it('supports a bare .csproj .NET repo (matched by project-file extension)', async () => {
    // The common .NET shape is a project file with an arbitrary name and no global.json.
    // It must be detected by the `.csproj` extension, not a fixed manifest filename.
    const result = await detectStack(fixture('dotnet-csproj-repo'));

    expect(result.isSupported).toBe(true);
    expect(result.insights.ecosystemComponents).toContainEqual(
      expect.objectContaining({
        rootDir: '.',
        runtime: 'dotnet',
        recipeId: 'dotnet-sdk',
        role: 'backend',
      })
    );
  });

  it('treats an existing Dockerfile as a supported deterministic signal', async () => {
    const result = await detectStack(fixture('dockerfile-node-repo'));

    expect(result.isSupported).toBe(true);
    expect(result.frontend).toBeNull();
    expect(result.backend).toBeNull();
    expect(result.insights.dockerfiles).toHaveLength(1);
    expect(result.insights.dockerfiles[0]).toMatchObject({
      rootDir: '.',
      file: 'Dockerfile',
      baseImage: 'node:20-slim',
      exposedPorts: [3000],
      startCommand: 'npm start',
      workingDir: '/app',
    });
    expect(result.reasoning).toEqual(
      expect.arrayContaining([expect.stringContaining('Dockerfile parsed')])
    );
  });

  it('flags a genuinely unrecognizable repo with no language and no evidence', async () => {
    const result = await detectStack(fixture('unknown-repo'));

    expect(result.isSupported).toBe(false);
    expect(result.languages).toEqual(['unknown']);
    expect(result.packageManagers).toEqual([]);
    expect(result.confidence).toBe(0);
    // No supported shape observed → no evidence, so no reasoning trail.
    expect(result.reasoning).toEqual([]);
    expect(result.warnings.some((w) => w.code === 'unsupported-stack')).toBe(true);
  });

  it('ignores a database port in config and picks the port the app listens on', async () => {
    const result = await detectStack(fixture('express-dbconfig-repo'));

    expect(result.backend?.framework).toBe('express');
    expect(result.backend?.ports.map((p) => p.port)).toEqual([4000]);
    expect(result.backend?.ports.map((p) => p.port)).not.toContain(5432);
  });

  it('orders languages by evidence and detects package managers from lockfiles', async () => {
    await expect(detectLanguages(fixture('mern-repo'))).resolves.toEqual(['javascript']);
    await expect(detectPackageManager(fixture('mern-repo/client'))).resolves.toBe('yarn');
    await expect(detectPackageManager(fixture('mern-repo/server'))).resolves.toBe('npm');
    await expect(detectPackageManager(fixture('django-postgres-repo'))).resolves.toBe('pip');
    await expect(detectPackageManager(fixture('unsupported-repo'))).resolves.toBe('unknown');
  });

  it('classifies a Pipenv (Pipfile) repo as Python and detects pipenv', async () => {
    // A Pipfile with no .py files still identifies the project as Python — Pipenv is a
    // common manifest the language detector must recognize alongside requirements/pyproject.
    await expect(detectLanguages(fixture('pipfile-repo'))).resolves.toEqual(['python']);
    await expect(detectPackageManager(fixture('pipfile-repo'))).resolves.toBe('pipenv');
  });
});

import { describe, expect, it } from 'vitest';

import type {
  BackendFramework,
  DetectedComponent,
  DetectedDatabase,
  DetectionResult,
  FrontendFramework,
  Language,
  PackageManager,
} from '../../src/detect/types.js';
import { defaultDockerfileVars, selectDockerfileTemplate } from '../../src/templates/registry.js';
import { KNOWN_PACKAGE_MANAGERS } from '../../src/templates/types.js';

function component(overrides: Partial<DetectedComponent>): DetectedComponent {
  return {
    role: 'backend',
    rootDir: '.',
    language: 'javascript',
    packageManager: 'npm',
    framework: 'express',
    dependencies: [],
    ports: [],
    entrypoint: null,
    ...overrides,
  };
}

function port(n: number) {
  return { port: n, protocol: 'tcp' as const, source: 'default' as const };
}

function detectionResult(parts: {
  frontend?: DetectedComponent | null;
  backend?: DetectedComponent | null;
  databases?: DetectedDatabase[];
}): DetectionResult {
  return {
    repoPath: '/tmp/repo',
    languages: ['javascript', 'python'] as Language[],
    packageManagers: ['npm', 'pip'] as PackageManager[],
    frontend: parts.frontend ?? null,
    backend: parts.backend ?? null,
    databases: parts.databases ?? [],
    isSupported: true,
    confidence: 0.9,
    reasoning: [],
    insights: {
      frameworks: [],
      runtimes: [],
      monorepoTools: [],
      ciCommands: [],
      ciRuntimeVersions: [],
      taskCommands: [],
      ecosystemComponents: [],
    },
    warnings: [],
  };
}

describe('selectDockerfileTemplate', () => {
  it('picks the node template for JS/TS components', () => {
    expect(selectDockerfileTemplate(component({ language: 'javascript' }))).toBe(
      'node.Dockerfile.hbs'
    );
    expect(selectDockerfileTemplate(component({ language: 'typescript' }))).toBe(
      'node.Dockerfile.hbs'
    );
  });

  it('picks the python template for python components', () => {
    expect(selectDockerfileTemplate(component({ language: 'python', framework: 'django' }))).toBe(
      'python.Dockerfile.hbs'
    );
  });
});

describe('defaultDockerfileVars', () => {
  it('Node + Express backend', () => {
    const vars = defaultDockerfileVars(
      component({
        language: 'javascript',
        framework: 'express',
        packageManager: 'npm',
        ports: [port(5000)],
      })
    );
    expect(vars).toMatchObject({
      baseImage: 'node:20-slim',
      workdir: '/app',
      packageManager: 'npm',
      dependencyFiles: ['package.json'],
      installCommand: 'npm install',
      startCommand: 'npm run dev',
      port: 5000,
    });
    expect(vars.systemPackages).toBeUndefined();
    expect(vars.entrypointScript).toBeUndefined();
    expect(vars.buildCommand).toBeUndefined();
  });

  it('React frontend', () => {
    const vars = defaultDockerfileVars(
      component({ role: 'frontend', framework: 'react' as FrontendFramework, ports: [port(5173)] })
    );
    expect(vars.baseImage).toBe('node:20-slim');
    expect(vars.startCommand).toBe('npm run dev');
    expect(vars.port).toBe(5173);
  });

  it('Django backend gets libpq/build deps + a migrate entrypoint', () => {
    const vars = defaultDockerfileVars(
      component({
        language: 'python',
        framework: 'django' as BackendFramework,
        packageManager: 'pip',
        ports: [port(8000)],
      })
    );
    expect(vars).toMatchObject({
      baseImage: 'python:3.12-slim',
      packageManager: 'pip',
      dependencyFiles: ['requirements.txt'],
      installCommand: 'pip install -r requirements.txt',
      startCommand: 'python manage.py runserver 0.0.0.0:8000',
      port: 8000,
      systemPackages: ['libpq-dev', 'gcc'],
      entrypointScript: 'entrypoint.sh',
    });
  });

  it('honors alternate package managers', () => {
    expect(defaultDockerfileVars(component({ packageManager: 'yarn' })).installCommand).toBe(
      'yarn install'
    );
    expect(defaultDockerfileVars(component({ packageManager: 'pnpm' })).installCommand).toBe(
      'pnpm install'
    );
    const poetry = defaultDockerfileVars(
      component({ language: 'python', framework: 'django', packageManager: 'poetry' })
    );
    expect(poetry.installCommand).toBe('poetry install');
    expect(poetry.dependencyFiles).toEqual(['pyproject.toml']);
  });

  it('falls back to framework default ports when none were detected', () => {
    expect(defaultDockerfileVars(component({ framework: 'express', ports: [] })).port).toBe(3000);
    expect(
      defaultDockerfileVars(component({ role: 'frontend', framework: 'react', ports: [] })).port
    ).toBe(5173);
  });

  it("resolves an 'unknown' package manager per toolchain", () => {
    expect(
      defaultDockerfileVars(component({ language: 'javascript', packageManager: 'unknown' }))
        .packageManager
    ).toBe('npm');
    expect(
      defaultDockerfileVars(
        component({ language: 'python', framework: 'django', packageManager: 'unknown' })
      ).packageManager
    ).toBe('pip');
  });
});

describe('representative DetectionResults (MERN + Django)', () => {
  it('MERN: react client + express server + mongo', () => {
    const result = detectionResult({
      frontend: component({ role: 'frontend', framework: 'react', ports: [port(5173)] }),
      backend: component({ role: 'backend', framework: 'express', ports: [port(5000)] }),
      databases: [{ engine: 'mongodb', defaultPort: 27017, detectedFrom: 'mongoose' }],
    });

    expect(selectDockerfileTemplate(result.frontend!)).toBe('node.Dockerfile.hbs');
    expect(selectDockerfileTemplate(result.backend!)).toBe('node.Dockerfile.hbs');
    expect(result.databases[0]!.engine).toBe('mongodb');
  });

  it('Django + postgres', () => {
    const result = detectionResult({
      backend: component({
        language: 'python',
        framework: 'django',
        packageManager: 'pip',
        ports: [port(8000)],
      }),
      databases: [{ engine: 'postgres', defaultPort: 5432, detectedFrom: 'psycopg2' }],
    });

    expect(selectDockerfileTemplate(result.backend!)).toBe('python.Dockerfile.hbs');
    expect(defaultDockerfileVars(result.backend!).systemPackages).toEqual(['libpq-dev', 'gcc']);
    expect(result.databases[0]!.engine).toBe('postgres');
  });
});

describe('open PackageManager taxonomy', () => {
  it('accepts an ecosystem manager outside the known set (open string)', () => {
    // The point of the open taxonomy: a new ecosystem's manager is data, not an enum
    // edit. `cargo` is not a known member, yet it's a valid PackageManager.
    const cargo: PackageManager = 'cargo';
    expect(cargo).toBe('cargo');
  });

  it('exposes the known managers as the closed hand-tuned core', () => {
    expect([...KNOWN_PACKAGE_MANAGERS]).toEqual([
      'npm',
      'yarn',
      'pnpm',
      'pip',
      'poetry',
      'uv',
      'pipenv',
    ]);
    // Every known member is, of course, assignable to the open type.
    for (const pm of KNOWN_PACKAGE_MANAGERS) {
      const assigned: PackageManager = pm;
      expect(assigned).toBe(pm);
    }
  });
});

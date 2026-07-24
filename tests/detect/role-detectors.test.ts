/**
 * §2.3 role detectors — `job` and `library` as standalone `Detector` plugins.
 *
 * These two complete the role vocabulary and are the awkward half of it: `job` rests on a
 * scheduler signal, `library` on the ABSENCE of an entrypoint. Negative evidence is easy
 * to get wrong, so as much of this file is about what must NOT be claimed as about what
 * must: a Maven app, a PHP app, an empty directory, and anything that listens all have to
 * come back with no claim at all.
 */
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { fileURLToPath } from 'node:url';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createRunContext, DEFAULT_RUN_OPTIONS, type Logger } from '../../src/core/context.js';
import { runPipeline } from '../../src/core/pipeline.js';
import { detectComponentRole } from '../../src/detect/componentRole.js';
import { jobDetector, libraryDetector, ROLE_DETECTORS } from '../../src/detect/detectors/role.js';
import { detectStack } from '../../src/detect/index.js';

const docker = vi.hoisted(() => ({
  assertDockerAvailable: vi.fn(),
  composeBuild: vi.fn(),
  composeUp: vi.fn(),
  composeDown: vi.fn(),
  composeLogs: vi.fn(),
}));
vi.mock('../../src/build/docker.js', () => docker);

const fixture = (name: string): string =>
  fileURLToPath(new URL(`../fixtures/${name}`, import.meta.url));

function silentLogger(): Logger {
  const noop = (): void => undefined;
  return { debug: noop, info: noop, warn: noop, error: noop };
}

const ctxFor = (dir: string) => ({ repoPath: dir, scopeDir: '.' });

describe('the role detectors follow the Detector plugin shape', () => {
  it('are tier-1 detectors with stable ids, registered in confidence order', () => {
    expect(ROLE_DETECTORS.map((d) => d.id)).toEqual(['role:job', 'role:library']);
    for (const detector of ROLE_DETECTORS) expect(detector.tier).toBe(1);
  });

  it('return Claims carrying non-empty evidence', async () => {
    const claims = await jobDetector.detect(ctxFor(fixture('job-release-repo')));
    expect(claims).toHaveLength(1);
    expect(claims[0]?.evidence.length).toBeGreaterThan(0);
    expect(claims[0]?.confidence).toBeGreaterThan(0);
    expect(claims[0]?.source).toBe('deterministic');
  });
});

describe('ACCEPTANCE: job', () => {
  it('classifies a Procfile release process with no web or worker as a job', async () => {
    const detection = await detectComponentRole(fixture('job-release-repo'), {
      dependencies: [],
      declaredPorts: [],
    });
    expect(detection?.role).toBe('job');
    expect(detection?.signal).toContain('release');
  });

  it('reaches the plan as a job with NO published port', async () => {
    const detection = await detectStack(fixture('job-release-repo'));
    expect(detection.insights.ecosystemComponents).toContainEqual({
      rootDir: '.',
      runtime: 'go',
      recipeId: 'go-mod',
      role: 'job',
    });

    const repo = fixture('job-release-repo');
    const output = new PassThrough();
    output.resume();
    const ctx = createRunContext({
      repoUrl: repo,
      workspaceDir: repo,
      logger: silentLogger(),
      options: { ...DEFAULT_RUN_OPTIONS, dryRun: true, autoApprove: true },
    });
    await runPipeline(ctx, { output });

    // go-mod carries defaultPorts [8080]; a job is not a listening role, so none is published.
    expect(ctx.plan?.services.find((s) => s.kind === 'service')?.ports).toEqual([]);
  });
});

describe('ACCEPTANCE: library', () => {
  it('classifies a package with no entrypoint of any kind as a library', async () => {
    const detection = await detectComponentRole(fixture('go-library-repo'), {
      dependencies: [],
      declaredPorts: [],
    });
    expect(detection?.role).toBe('library');
    expect(detection?.signal).toContain('package main');
  });

  it('reaches the plan as a library with NO published port', async () => {
    const detection = await detectStack(fixture('go-library-repo'));
    expect(detection.insights.ecosystemComponents).toContainEqual({
      rootDir: '.',
      runtime: 'go',
      recipeId: 'go-mod',
      role: 'library',
    });

    const repo = fixture('go-library-repo');
    const output = new PassThrough();
    output.resume();
    const ctx = createRunContext({
      repoUrl: repo,
      workspaceDir: repo,
      logger: silentLogger(),
      options: { ...DEFAULT_RUN_OPTIONS, dryRun: true, autoApprove: true },
    });
    await runPipeline(ctx, { output });

    expect(ctx.plan?.services.find((s) => s.kind === 'service')?.ports).toEqual([]);
  });
});

describe('what library must NOT claim', () => {
  let repo: string;
  beforeEach(async () => {
    repo = await mkdtemp(join(tmpdir(), 'orca-role-'));
  });
  afterEach(async () => {
    await rm(repo, { recursive: true, force: true });
  });

  it('declines for an empty directory — nothing is not a library', async () => {
    expect(await libraryDetector.detect(ctxFor(repo))).toEqual([]);
  });

  it('declines for ecosystems with no reliable library convention (JVM, PHP)', async () => {
    // Regression: a generic "no recognizable entry file" rule called a Maven app whose
    // entry point is src/main/java/.../App.java, and a PHP app served from
    // public/index.php, libraries. Those ecosystems now decline rather than guess.
    for (const sample of ['jvm-maven-sample', 'jvm-gradle-sample', 'dotnet-sample']) {
      const dir = fileURLToPath(new URL(`../../examples/${sample}`, import.meta.url));
      expect(await libraryDetector.detect(ctxFor(dir))).toEqual([]);
    }
    expect(await libraryDetector.detect(ctxFor(fixture('php-plain-repo')))).toEqual([]);
  });

  it('declines for a Go module that builds a binary', async () => {
    await writeFile(join(repo, 'go.mod'), 'module x\n\ngo 1.23\n');
    await writeFile(join(repo, 'server.go'), 'package main\n\nfunc main() {}\n');
    expect(await libraryDetector.detect(ctxFor(repo))).toEqual([]);
  });

  it('declines for a Go module with a cmd/ directory', async () => {
    await writeFile(join(repo, 'go.mod'), 'module x\n\ngo 1.23\n');
    await mkdir(join(repo, 'cmd'));
    expect(await libraryDetector.detect(ctxFor(repo))).toEqual([]);
  });

  it('declines for a Node package that ships a bin or a start script', async () => {
    await writeFile(
      join(repo, 'package.json'),
      JSON.stringify({ name: 'x', bin: { x: './c.js' } })
    );
    expect(await libraryDetector.detect(ctxFor(repo))).toEqual([]);

    await writeFile(
      join(repo, 'package.json'),
      JSON.stringify({ name: 'x', scripts: { start: 'node server.js' } })
    );
    expect(await libraryDetector.detect(ctxFor(repo))).toEqual([]);
  });

  it('claims a Node package with no bin, no server script, and no entry module', async () => {
    await writeFile(
      join(repo, 'package.json'),
      JSON.stringify({ name: 'x', main: 'dist/index.js', scripts: { build: 'tsc' } })
    );
    const claims = await libraryDetector.detect(ctxFor(repo));
    expect(claims[0]?.value).toBe('library');
  });

  it('declines for a Rust crate with a binary target', async () => {
    await writeFile(join(repo, 'Cargo.toml'), '[package]\nname = "x"\n\n[[bin]]\nname = "x"\n');
    await mkdir(join(repo, 'src'));
    await writeFile(join(repo, 'src', 'lib.rs'), 'pub fn f() {}\n');
    expect(await libraryDetector.detect(ctxFor(repo))).toEqual([]);
  });

  it('claims a Rust crate with only a lib target', async () => {
    await writeFile(join(repo, 'Cargo.toml'), '[package]\nname = "x"\nversion = "0.1.0"\n');
    await mkdir(join(repo, 'src'));
    await writeFile(join(repo, 'src', 'lib.rs'), 'pub fn f() {}\n');
    expect((await libraryDetector.detect(ctxFor(repo)))[0]?.value).toBe('library');
  });

  it('declines whenever the component declares a port', async () => {
    await writeFile(join(repo, 'package.json'), JSON.stringify({ name: 'x', main: 'i.js' }));
    await writeFile(join(repo, '.env'), 'PORT=4000\n');
    expect(await libraryDetector.detect(ctxFor(repo))).toEqual([]);
    expect(await jobDetector.detect(ctxFor(repo))).toEqual([]);
  });

  it('declines when a web or queue dependency is present', async () => {
    await writeFile(
      join(repo, 'package.json'),
      JSON.stringify({ name: 'x', main: 'i.js', dependencies: { express: '^4' } })
    );
    expect(await libraryDetector.detect(ctxFor(repo))).toEqual([]);
  });
});

describe('job ranking and gating', () => {
  let repo: string;
  beforeEach(async () => {
    repo = await mkdtemp(join(tmpdir(), 'orca-job-'));
  });
  afterEach(async () => {
    await rm(repo, { recursive: true, force: true });
  });

  it('declines a release process that sits beside a web process', async () => {
    // `release:` next to `web:` is a deploy hook for a service, not a job.
    await writeFile(join(repo, 'Procfile'), 'web: ./serve\nrelease: ./migrate.sh\n');
    expect(await jobDetector.detect(ctxFor(repo))).toEqual([]);
  });

  it('claims a cron table', async () => {
    await writeFile(join(repo, 'crontab'), '0 3 * * * /app/nightly.sh\n');
    expect((await jobDetector.detect(ctxFor(repo)))[0]?.value).toBe('job');
  });

  it('outranks library when a component could satisfy both', async () => {
    // Positive evidence must beat negative: bestClaim picks job (0.75) over library (0.45).
    await writeFile(join(repo, 'package.json'), JSON.stringify({ name: 'x', main: 'i.js' }));
    await writeFile(join(repo, 'crontab'), '0 3 * * * /app/nightly.sh\n');
    const detection = await detectComponentRole(repo, { dependencies: [], declaredPorts: [] });
    expect(detection?.role).toBe('job');
  });

  it('lets a worker keep winning over both — positive rules run first', async () => {
    await writeFile(
      join(repo, 'Procfile'),
      'worker: celery -A tasks worker\nrelease: ./migrate.sh\n'
    );
    const detection = await detectComponentRole(repo, { dependencies: [], declaredPorts: [] });
    expect(detection?.role).toBe('worker');
  });
});

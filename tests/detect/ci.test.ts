/**
 * PHASE C tests — GitHub Actions CI analysis. Writes real workflow YAML into a temp
 * .github/workflows dir and asserts the recovered commands (classified by intent) and
 * pinned runtime versions from setup-* actions.
 */
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { analyzeCi, classifyCommand, parseRuntimeFromImage } from '../../src/detect/ci.js';

let repo: string;
beforeEach(async () => {
  repo = await mkdtemp(join(tmpdir(), 'orca-ci-'));
});
afterEach(async () => {
  await rm(repo, { recursive: true, force: true });
});

async function writeWorkflow(name: string, content: string): Promise<void> {
  const dir = join(repo, '.github', 'workflows');
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, name), content);
}

describe('classifyCommand', () => {
  it('classifies by intent keywords', () => {
    expect(classifyCommand('npm install')).toBe('install');
    expect(classifyCommand('npm run build')).toBe('build');
    expect(classifyCommand('pytest -q')).toBe('test');
    expect(classifyCommand('python manage.py runserver')).toBe('start');
    expect(classifyCommand('echo hello')).toBe('other');
  });
});

describe('parseRuntimeFromImage', () => {
  it('parses clean and suffixed version tags across runtimes', () => {
    expect(parseRuntimeFromImage('node:20')).toEqual({ runtime: 'node', version: '20' });
    expect(parseRuntimeFromImage('python:3.12-slim')).toEqual({
      runtime: 'python',
      version: '3.12',
    });
    expect(parseRuntimeFromImage('golang:1.22-alpine')).toEqual({ runtime: 'go', version: '1.22' });
    expect(parseRuntimeFromImage('eclipse-temurin:21-jdk')).toEqual({
      runtime: 'java',
      version: '21',
    });
  });

  it('parses a namespaced image (registry/org prefix before the runtime name)', () => {
    expect(parseRuntimeFromImage('cimg/node:20.10')).toEqual({ runtime: 'node', version: '20.10' });
  });

  it('finds the runtime keyword anywhere in a multi-segment repo path, using the LAST colon for the tag', () => {
    // The runtime keyword ("dotnet") isn't the last path segment ("sdk") — the whole
    // repo path is searched, not just the final segment. And the last `:` (before "8.0")
    // is what separates the tag, not the first one.
    expect(parseRuntimeFromImage('mcr.microsoft.com/dotnet/sdk:8.0')).toEqual({
      runtime: 'dotnet',
      version: '8.0',
    });
  });

  it('matches a bare "go" image only as an exact path segment, not a substring', () => {
    expect(parseRuntimeFromImage('go:1.23')).toEqual({ runtime: 'go', version: '1.23' });
    // "django" contains "go" as a substring but is not the Go runtime.
    expect(parseRuntimeFromImage('django:4.2')).toBeNull();
  });

  it('rejects an unversioned tag (e.g. "latest") even for a recognized runtime', () => {
    expect(parseRuntimeFromImage('node:latest')).toBeNull();
  });

  it('rejects an image with no tag at all', () => {
    expect(parseRuntimeFromImage('node')).toBeNull();
  });

  it('rejects an unrecognized/custom image, even with a clean version tag', () => {
    expect(parseRuntimeFromImage('registry.example.com/internal/base:2.3.1')).toBeNull();
  });
});

describe('analyzeCi', () => {
  it('reports not-found when there are no workflows', async () => {
    const analysis = await analyzeCi(repo);
    expect(analysis.found).toBe(false);
    expect(analysis.commands).toEqual([]);
  });

  it('recovers run commands and the pinned node version', async () => {
    await writeWorkflow(
      'ci.yml',
      [
        'name: CI',
        'on: [push]',
        'jobs:',
        '  build:',
        '    runs-on: ubuntu-latest',
        '    steps:',
        '      - uses: actions/checkout@v4',
        '      - uses: actions/setup-node@v4',
        '        with:',
        "          node-version: '20'",
        '      - run: npm ci',
        '      - run: npm run build',
        '      - run: npm test',
      ].join('\n')
    );

    const analysis = await analyzeCi(repo);
    expect(analysis.found).toBe(true);
    expect(analysis.runtimeVersions).toContainEqual({ runtime: 'node', version: '20' });

    const kinds = Object.fromEntries(analysis.commands.map((c) => [c.command, c.kind]));
    expect(kinds['npm ci']).toBe('install');
    expect(kinds['npm run build']).toBe('build');
    expect(kinds['npm test']).toBe('test');
  });

  it('splits multi-line run blocks and dedupes across files', async () => {
    await writeWorkflow(
      'a.yml',
      'jobs:\n  x:\n    steps:\n      - run: |\n          go mod download\n          go build ./...'
    );
    await writeWorkflow('b.yml', 'jobs:\n  y:\n    steps:\n      - run: go build ./...');

    const analysis = await analyzeCi(repo);
    const builds = analysis.commands.filter((c) => c.command === 'go build ./...');
    expect(builds).toHaveLength(1); // deduped across files
    expect(analysis.commands.find((c) => c.command === 'go mod download')?.kind).toBe('install');
  });

  it('recovers python and go versions from their setup actions', async () => {
    await writeWorkflow(
      'multi.yml',
      [
        'jobs:',
        '  a:',
        '    steps:',
        '      - uses: actions/setup-python@v5',
        '        with:',
        "          python-version: '3.12'",
        '  b:',
        '    steps:',
        '      - uses: actions/setup-go@v5',
        '        with:',
        "          go-version: '1.23'",
      ].join('\n')
    );

    const analysis = await analyzeCi(repo);
    expect(analysis.runtimeVersions).toContainEqual({ runtime: 'python', version: '3.12' });
    expect(analysis.runtimeVersions).toContainEqual({ runtime: 'go', version: '1.23' });
  });

  it('recovers java and dotnet versions from their setup actions', async () => {
    await writeWorkflow(
      'jvm-dotnet.yml',
      [
        'jobs:',
        '  build:',
        '    steps:',
        '      - uses: actions/setup-java@v4',
        '        with:',
        "          java-version: '21'",
        '      - uses: actions/setup-dotnet@v4',
        '        with:',
        "          dotnet-version: '8.0'",
      ].join('\n')
    );

    const analysis = await analyzeCi(repo);
    expect(analysis.runtimeVersions).toContainEqual({ runtime: 'java', version: '21' });
    expect(analysis.runtimeVersions).toContainEqual({ runtime: 'dotnet', version: '8.0' });
  });

  it('skips malformed workflow YAML without throwing', async () => {
    await writeWorkflow('broken.yml', 'jobs: [this is: not valid yaml: {{{');
    await expect(analyzeCi(repo)).resolves.toMatchObject({ found: true });
  });
});

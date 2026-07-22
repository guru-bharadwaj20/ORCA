/**
 * PHASE C tests — GitHub Actions CI analysis. Writes real workflow YAML into a temp
 * .github/workflows dir and asserts the recovered commands (classified by intent) and
 * pinned runtime versions from setup-* actions.
 */
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { analyzeCi, classifyCommand } from '../../src/detect/ci.js';

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

  it('skips malformed workflow YAML without throwing', async () => {
    await writeWorkflow('broken.yml', 'jobs: [this is: not valid yaml: {{{');
    await expect(analyzeCi(repo)).resolves.toMatchObject({ found: true });
  });
});

/**
 * PHASE 3 tests — repository-understanding task recovery from Makefile, Taskfile,
 * justfile, and package.json scripts. Real files in a temp dir; asserts the recovered
 * task names, commands, and classified intents.
 */
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { recoverTasks } from '../../src/detect/taskRunners.js';

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'orca-task-'));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

const byName = (tasks: Awaited<ReturnType<typeof recoverTasks>>, name: string) =>
  tasks.find((t) => t.name === name);

describe('recoverTasks', () => {
  it('parses Makefile targets and their first recipe line', async () => {
    await writeFile(
      join(dir, 'Makefile'),
      [
        '.PHONY: build run',
        '',
        'build:',
        '\tgo build -o bin/app ./...',
        '',
        'run:',
        '\t./bin/app',
      ].join('\n')
    );
    const tasks = await recoverTasks(dir);
    expect(byName(tasks, 'build')).toMatchObject({
      command: 'go build -o bin/app ./...',
      kind: 'build',
    });
    expect(byName(tasks, 'run')?.kind).toBe('start');
    expect(byName(tasks, '.PHONY')).toBeUndefined();
  });

  it('recognizes a GNUmakefile (GNU make searches it first)', async () => {
    await writeFile(join(dir, 'GNUmakefile'), 'test:\n\tgo test ./...\n');
    expect(byName(await recoverTasks(dir), 'test')).toMatchObject({
      source: 'makefile',
      kind: 'test',
    });
  });

  it('parses a Taskfile tasks map', async () => {
    await writeFile(
      join(dir, 'Taskfile.yml'),
      ['version: "3"', 'tasks:', '  build:', '    cmds:', '      - cargo build --release'].join(
        '\n'
      )
    );
    expect(byName(await recoverTasks(dir), 'build')).toMatchObject({
      source: 'taskfile',
      command: 'cargo build --release',
      kind: 'build',
    });
  });

  it('parses a justfile', async () => {
    await writeFile(join(dir, 'justfile'), 'dev:\n    npm run dev\n');
    expect(byName(await recoverTasks(dir), 'dev')).toMatchObject({
      source: 'justfile',
      kind: 'start',
    });
  });

  it('recognizes a capitalized Justfile (a valid `just` filename)', async () => {
    await writeFile(join(dir, 'Justfile'), 'build:\n    npm run build\n');
    expect(byName(await recoverTasks(dir), 'build')).toMatchObject({
      source: 'justfile',
      kind: 'build',
    });
  });

  it('includes package.json scripts', async () => {
    await writeFile(
      join(dir, 'package.json'),
      JSON.stringify({ scripts: { build: 'tsc', start: 'node dist/index.js' } })
    );
    const tasks = await recoverTasks(dir);
    expect(byName(tasks, 'build')).toMatchObject({ source: 'npm-scripts', kind: 'build' });
    expect(byName(tasks, 'start')?.kind).toBe('start');
  });

  it('classifies by task name even when the command body is opaque', async () => {
    await writeFile(join(dir, 'Makefile'), 'install:\n\t@./scripts/setup.sh\n');
    expect(byName(await recoverTasks(dir), 'install')?.kind).toBe('install');
  });

  it('returns [] for a repo with no task runners', async () => {
    expect(await recoverTasks(dir)).toEqual([]);
  });
});

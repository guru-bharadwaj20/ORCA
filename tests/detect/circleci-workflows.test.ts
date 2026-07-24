/**
 * CircleCI `workflows:` ordering — recovering the DAG that `jobs:` alone cannot express.
 *
 * CircleCI has no `stages:` key; `workflows:` is its analog, and it declares order as a
 * dependency graph rather than a list. `CircleCiConfig.stages` therefore carries the
 * recovered execution order as `<workflow>:<job>` entries, workflow-qualified so several
 * workflows stay recoverable as several sequences.
 *
 * The rule these tests pin hardest is CircleCI's own, because it is easy to assume
 * otherwise: a job with NO `requires:` starts immediately, in parallel with every other
 * unblocked job. It does not implicitly wait for the jobs declared above it.
 */
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { analyzeCircleCi } from '../../src/detect/circleci.js';
import { detectStack } from '../../src/detect/index.js';

const fixture = (name: string): string =>
  fileURLToPath(new URL(`../fixtures/${name}`, import.meta.url));

describe('ACCEPTANCE: dependency order, not declaration order', () => {
  it('orders a job behind the two jobs it requires', async () => {
    const analysis = await analyzeCircleCi(fixture('circleci-workflow-repo'));
    const config = analysis.configs[0]!;

    // `package` is declared last in the file AND requires [lint, unit]; lint and unit
    // have no requires, so they are level 0 and `package` follows them.
    expect(config.stages.filter((s) => s.startsWith('verify:'))).toEqual([
      'verify:lint',
      'verify:unit',
      'verify:package',
    ]);
  });

  it('keeps a second workflow as its own sequence rather than merging them', async () => {
    const analysis = await analyzeCircleCi(fixture('circleci-workflow-repo'));
    const config = analysis.configs[0]!;

    expect(config.stages).toEqual([
      'verify:lint',
      'verify:unit',
      'verify:package',
      'nightly:publish',
    ]);
  });

  it('labels each job with the workflow that runs it', async () => {
    const analysis = await analyzeCircleCi(fixture('circleci-workflow-repo'));
    const byName = new Map(analysis.configs[0]!.jobs.map((j) => [j.name, j.stage]));

    expect(byName.get('lint')).toBe('verify');
    expect(byName.get('package')).toBe('verify');
    expect(byName.get('publish')).toBe('nightly');
  });

  it('surfaces the recovered order through detectStack insights', async () => {
    const result = await detectStack(fixture('circleci-workflow-repo'));
    const circle = result.insights.ciProviders.find((c) => c.provider === 'circleci');

    expect(circle?.stages).toEqual([
      'verify:lint',
      'verify:unit',
      'verify:package',
      'nightly:publish',
    ]);
  });
});

describe('CircleCI default sequencing', () => {
  let repo: string;
  const write = async (yaml: string): Promise<string> => {
    await mkdir(join(repo, '.circleci'), { recursive: true });
    await writeFile(join(repo, '.circleci', 'config.yml'), yaml);
    return repo;
  };
  const stagesOf = async (): Promise<string[]> =>
    (await analyzeCircleCi(repo)).configs[0]?.stages ?? [];

  beforeEach(async () => {
    repo = await mkdtemp(join(tmpdir(), 'orca-circle-wf-'));
  });
  afterEach(async () => {
    await rm(repo, { recursive: true, force: true });
  });

  it('treats jobs with no requires as concurrent, not implicitly sequential', async () => {
    // CircleCI's own rule: an unblocked job starts immediately. Both are level 0, so
    // declaration order only breaks the tie inside that level.
    await write(
      'version: 2.1\njobs:\n  a: {}\n  b: {}\nworkflows:\n  w:\n    jobs:\n      - a\n      - b\n'
    );
    expect(await stagesOf()).toEqual(['w:a', 'w:b']);
  });

  it('respects a chain declared out of order', async () => {
    await write(
      'version: 2.1\njobs:\n  a: {}\n  b: {}\n  c: {}\n' +
        'workflows:\n  w:\n    jobs:\n      - c:\n          requires: [b]\n      - b:\n          requires: [a]\n      - a\n'
    );
    expect(await stagesOf()).toEqual(['w:a', 'w:b', 'w:c']);
  });

  it('accepts a scalar requires as well as a list', async () => {
    await write(
      'version: 2.1\njobs:\n  a: {}\n  b: {}\nworkflows:\n  w:\n    jobs:\n      - b:\n          requires: a\n      - a\n'
    );
    expect(await stagesOf()).toEqual(['w:a', 'w:b']);
  });

  it('uses a job alias as the identity other jobs require', async () => {
    await write(
      'version: 2.1\njobs:\n  test: {}\n  deploy: {}\n' +
        'workflows:\n  w:\n    jobs:\n      - test:\n          name: test-py39\n      - deploy:\n          requires: [test-py39]\n'
    );
    expect(await stagesOf()).toEqual(['w:test-py39', 'w:deploy']);
  });

  it('ignores a requires naming a job outside the workflow', async () => {
    await write(
      'version: 2.1\njobs:\n  a: {}\nworkflows:\n  w:\n    jobs:\n      - a:\n          requires: [somewhere-else]\n'
    );
    expect(await stagesOf()).toEqual(['w:a']);
  });

  it('keeps every job when the graph has a cycle instead of dropping them', async () => {
    // CircleCI would reject this config; losing jobs would be worse than an imperfect
    // order for something that cannot run anyway.
    await write(
      'version: 2.1\njobs:\n  a: {}\n  b: {}\n' +
        'workflows:\n  w:\n    jobs:\n      - a:\n          requires: [b]\n      - b:\n          requires: [a]\n'
    );
    expect((await stagesOf()).sort()).toEqual(['w:a', 'w:b']);
  });

  it('skips the workflows version key rather than treating it as a workflow', async () => {
    await write(
      'version: 2.1\njobs:\n  a: {}\nworkflows:\n  version: 2\n  w:\n    jobs:\n      - a\n'
    );
    expect(await stagesOf()).toEqual(['w:a']);
  });

  it('leaves stages empty for a config with no workflows section', async () => {
    await write('version: 2.1\njobs:\n  a:\n    steps:\n      - run: npm ci\n');
    expect(await stagesOf()).toEqual([]);
    expect((await analyzeCircleCi(repo)).configs[0]?.jobs[0]?.stage).toBeNull();
  });

  it('records a workflow job that has no jobs: entry of its own (an orb job)', async () => {
    // `node/test` comes from an orb, so it never appears under `jobs:` — but it is a real
    // part of the order, so dropping it would misreport the sequence.
    await write(
      'version: 2.1\njobs:\n  build: {}\n' +
        'workflows:\n  w:\n    jobs:\n      - node/test\n      - build:\n          requires: [node/test]\n'
    );
    expect(await stagesOf()).toEqual(['w:node/test', 'w:build']);
  });
});

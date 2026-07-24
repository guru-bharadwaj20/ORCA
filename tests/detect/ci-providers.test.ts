/**
 * PHASE C tests — GitLab CI, Azure Pipelines, and CircleCI analysis. Uses real config
 * fixtures under tests/fixtures/ and asserts the recovered stages/jobs/commands/image,
 * plus that multiple CI providers in the same repo are all detected.
 */
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { analyzeAzurePipelines } from '../../src/detect/azurePipelines.js';
import { analyzeCircleCi } from '../../src/detect/circleci.js';
import { analyzeGitlabCi } from '../../src/detect/gitlabCi.js';
import { detectStack } from '../../src/detect/index.js';

const fixture = (name: string): string =>
  fileURLToPath(new URL(`../fixtures/${name}`, import.meta.url));

describe('analyzeGitlabCi', () => {
  it('reports not-found when there is no .gitlab-ci.yml', async () => {
    const analysis = await analyzeGitlabCi(fixture('circleci-repo'));
    expect(analysis.found).toBe(false);
    expect(analysis.configs).toEqual([]);
  });

  it('parses stages, jobs, scripts, and image from .gitlab-ci.yml', async () => {
    const analysis = await analyzeGitlabCi(fixture('gitlab-ci-repo'));
    expect(analysis.found).toBe(true);
    expect(analysis.configs).toHaveLength(1);

    const config = analysis.configs[0]!;
    expect(config.stages).toEqual(['install', 'build', 'test']);
    expect(config.image).toBe('node:20-slim');
    expect(config.jobs).toHaveLength(3);

    const install = config.jobs.find((j) => j.name === 'install_deps');
    expect(install).toMatchObject({ stage: 'install', image: 'node:20-slim' });
    expect(install?.commands).toEqual([{ command: 'npm ci', kind: 'install' }]);

    const build = config.jobs.find((j) => j.name === 'build_app');
    expect(build?.commands).toEqual([{ command: 'npm run build', kind: 'build' }]);

    // A job-level `image:` overrides the top-level default.
    const test = config.jobs.find((j) => j.name === 'run_tests');
    expect(test).toMatchObject({ stage: 'test', image: 'node:20' });
    expect(test?.commands).toEqual([{ command: 'npm test', kind: 'test' }]);
  });

  it('populates runtimeVersions from job images, deduped by runtime:version', async () => {
    const analysis = await analyzeGitlabCi(fixture('gitlab-ci-repo'));
    // install_deps/build_app inherit the top-level node:20-slim, run_tests overrides to
    // node:20 — both parse to the same {node, 20}, so this is one entry, not three.
    expect(analysis.runtimeVersions).toEqual([{ runtime: 'node', version: '20' }]);
  });
});

describe('analyzeAzurePipelines', () => {
  it('reports not-found when there is no azure-pipelines.yml', async () => {
    const analysis = await analyzeAzurePipelines(fixture('circleci-repo'));
    expect(analysis.found).toBe(false);
    expect(analysis.configs).toEqual([]);
  });

  it('parses stages, jobs, steps, and pool/vmImage from azure-pipelines.yml', async () => {
    const analysis = await analyzeAzurePipelines(fixture('azure-pipelines-repo'));
    expect(analysis.found).toBe(true);
    expect(analysis.configs).toHaveLength(1);

    const config = analysis.configs[0]!;
    expect(config.stages).toEqual(['Build', 'Test']);
    expect(config.image).toBe('ubuntu-latest');
    expect(config.jobs).toHaveLength(3);

    const buildJob = config.jobs.find((j) => j.name === 'BuildJob');
    expect(buildJob).toMatchObject({ stage: 'Build', image: 'ubuntu-latest' });
    expect(buildJob?.commands).toEqual([
      { command: 'npm ci', kind: 'install' },
      { command: 'npm run build', kind: 'build' },
    ]);

    // A job-level pool.vmImage overrides the pipeline-level default.
    const testJob = config.jobs.find((j) => j.name === 'TestJob');
    expect(testJob).toMatchObject({ stage: 'Test', image: 'ubuntu-22.04' });
    expect(testJob?.commands).toEqual([{ command: 'npm test', kind: 'test' }]);

    // A job-level container: overrides pool.vmImage too — a real runtime image, not
    // just an OS label.
    const packageJob = config.jobs.find((j) => j.name === 'PackageJob');
    expect(packageJob).toMatchObject({ stage: 'Build', image: 'python:3.12' });
    expect(packageJob?.commands).toEqual([
      { command: 'pip install -r requirements.txt', kind: 'install' },
    ]);
  });

  it('populates runtimeVersions only from real container images, not vmImage OS labels', async () => {
    const analysis = await analyzeAzurePipelines(fixture('azure-pipelines-repo'));
    // BuildJob (ubuntu-latest) and TestJob (ubuntu-22.04) are VM OS labels, not runtime
    // images — only PackageJob's container: python:3.12 parses to a runtime version.
    expect(analysis.runtimeVersions).toEqual([{ runtime: 'python', version: '3.12' }]);
  });
});

describe('analyzeCircleCi', () => {
  it('reports not-found when there is no .circleci/config.yml', async () => {
    const analysis = await analyzeCircleCi(fixture('gitlab-ci-repo'));
    expect(analysis.found).toBe(false);
    expect(analysis.configs).toEqual([]);
  });

  it('parses jobs, run steps, and docker image from .circleci/config.yml', async () => {
    const analysis = await analyzeCircleCi(fixture('circleci-repo'));
    expect(analysis.found).toBe(true);
    expect(analysis.configs).toHaveLength(1);

    const config = analysis.configs[0]!;
    // The config declares `workflows.build_and_test` over both jobs, so `stages` now
    // carries the recovered execution order (workflow-qualified) rather than [].
    expect(config.stages).toEqual(['build_and_test:build', 'build_and_test:test']);
    expect(config.jobs).toHaveLength(2);

    const build = config.jobs.find((j) => j.name === 'build');
    expect(build).toMatchObject({ stage: 'build_and_test', image: 'cimg/node:20.10' });
    expect(build?.commands).toEqual([
      { command: 'npm ci', kind: 'install' },
      { command: 'npm run build', kind: 'build' },
    ]);

    const test = config.jobs.find((j) => j.name === 'test');
    expect(test?.commands).toEqual([{ command: 'npm test', kind: 'test' }]);
  });

  it('populates runtimeVersions from docker image, deduped across jobs', async () => {
    const analysis = await analyzeCircleCi(fixture('circleci-repo'));
    // build and test both use cimg/node:20.10 — one entry, not two.
    expect(analysis.runtimeVersions).toEqual([{ runtime: 'node', version: '20.10' }]);
  });
});

describe('multiple CI providers in one repo', () => {
  it('detects GitLab CI and CircleCI configs independently, not just one', async () => {
    const [gitlab, circle] = await Promise.all([
      analyzeGitlabCi(fixture('multi-ci-repo')),
      analyzeCircleCi(fixture('multi-ci-repo')),
    ]);

    expect(gitlab.found).toBe(true);
    expect(gitlab.configs).toHaveLength(1);
    expect(gitlab.configs[0]?.jobs.map((j) => j.name)).toEqual(['test_job']);

    expect(circle.found).toBe(true);
    expect(circle.configs).toHaveLength(1);
    expect(circle.configs[0]?.jobs.map((j) => j.name)).toEqual(['build']);
  });

  it('surfaces both providers in DetectionResult.insights.ciProviders', async () => {
    const result = await detectStack(fixture('multi-ci-repo'));
    const providers = result.insights.ciProviders.map((c) => c.provider).sort();
    expect(providers).toEqual(['circleci', 'gitlab']);
  });
});

describe('insights.ciRuntimeVersions merges across all CI sources', () => {
  let repo: string;
  beforeEach(async () => {
    repo = await mkdtemp(join(tmpdir(), 'orca-ci-runtime-'));
  });
  afterEach(async () => {
    await rm(repo, { recursive: true, force: true });
  });

  it('still extracts GitHub Actions setup-node pins unchanged (regression)', async () => {
    const wf = join(repo, '.github', 'workflows');
    await mkdir(wf, { recursive: true });
    await writeFile(
      join(wf, 'ci.yml'),
      [
        'jobs:',
        '  build:',
        '    steps:',
        '      - uses: actions/setup-node@v4',
        '        with:',
        "          node-version: '18'",
      ].join('\n')
    );

    const result = await detectStack(repo);
    expect(result.insights.ciRuntimeVersions).toEqual([{ runtime: 'node', version: '18' }]);
  });

  it('keeps BOTH entries on a genuine cross-source version difference (GH Actions node:18 vs a GitLab image node:20)', async () => {
    const wf = join(repo, '.github', 'workflows');
    await mkdir(wf, { recursive: true });
    await writeFile(
      join(wf, 'ci.yml'),
      [
        'jobs:',
        '  build:',
        '    steps:',
        '      - uses: actions/setup-node@v4',
        '        with:',
        "          node-version: '18'",
      ].join('\n')
    );
    await writeFile(
      join(repo, '.gitlab-ci.yml'),
      ['stages:', '  - test', '', 'test_job:', '  stage: test', '  image: node:20', '  script:', '    - npm test'].join(
        '\n'
      )
    );

    const result = await detectStack(repo);
    // Deduped by the full runtime:version key, not by runtime alone — a real
    // discrepancy between sources is surfaced, not silently collapsed.
    expect(result.insights.ciRuntimeVersions).toEqual(
      expect.arrayContaining([
        { runtime: 'node', version: '18' },
        { runtime: 'node', version: '20' },
      ])
    );
    expect(result.insights.ciRuntimeVersions).toHaveLength(2);
  });

  it('skips an image that does not cleanly parse (unrecognized name, no version)', async () => {
    await writeFile(
      join(repo, '.gitlab-ci.yml'),
      [
        'stages:',
        '  - deploy',
        '',
        'deploy_job:',
        '  stage: deploy',
        '  image: registry.example.com/internal/base:latest',
        '  script:',
        '    - echo deploying',
      ].join('\n')
    );

    const result = await detectStack(repo);
    expect(result.insights.ciRuntimeVersions).toEqual([]);
  });
});

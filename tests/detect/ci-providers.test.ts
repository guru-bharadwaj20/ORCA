/**
 * PHASE C tests — GitLab CI, Azure Pipelines, and CircleCI analysis. Uses real config
 * fixtures under tests/fixtures/ and asserts the recovered stages/jobs/commands/image,
 * plus that multiple CI providers in the same repo are all detected.
 */
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

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
    expect(config.jobs).toHaveLength(2);

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
    expect(config.stages).toEqual([]);
    expect(config.jobs).toHaveLength(2);

    const build = config.jobs.find((j) => j.name === 'build');
    expect(build).toMatchObject({ stage: null, image: 'cimg/node:20.10' });
    expect(build?.commands).toEqual([
      { command: 'npm ci', kind: 'install' },
      { command: 'npm run build', kind: 'build' },
    ]);

    const test = config.jobs.find((j) => j.name === 'test');
    expect(test?.commands).toEqual([{ command: 'npm test', kind: 'test' }]);
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

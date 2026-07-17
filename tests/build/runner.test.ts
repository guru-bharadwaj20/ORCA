/**
 * STAGE 5 tests — one build+run attempt with the docker wrappers MOCKED.
 * No docker is invoked.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { runOnce } from '../../src/build/runner.js';

const docker = vi.hoisted(() => ({
  composeBuild: vi.fn(),
  composeUp: vi.fn(),
  composeLogs: vi.fn(),
}));

vi.mock('../../src/build/docker.js', () => docker);

const ok = { exitCode: 0, stdout: '', stderr: '' };

beforeEach(() => {
  vi.clearAllMocks();
  docker.composeBuild.mockResolvedValue(ok);
  docker.composeUp.mockResolvedValue(ok);
  docker.composeLogs.mockResolvedValue({ exitCode: 0, stdout: 'db | ready', stderr: '' });
});

describe('runOnce', () => {
  it('succeeds when build and up both exit 0', async () => {
    await expect(runOnce('/proj')).resolves.toEqual({ ok: true, phase: 'up' });
    expect(docker.composeLogs).not.toHaveBeenCalled();
  });

  it('reports a build failure with the captured output', async () => {
    docker.composeBuild.mockResolvedValue({
      exitCode: 1,
      stdout: '',
      stderr: 'npm ERR! missing script: dev',
    });

    const result = await runOnce('/proj');

    expect(result.ok).toBe(false);
    expect(result.phase).toBe('build');
    expect(result.errorOutput).toContain('missing script: dev');
    expect(docker.composeUp).not.toHaveBeenCalled();
  });

  it('classifies an unhealthy stack as a healthcheck failure and appends logs', async () => {
    docker.composeUp.mockResolvedValue({
      exitCode: 1,
      stdout: '',
      stderr: 'container orca-db-1 is unhealthy',
    });

    const result = await runOnce('/proj');

    expect(result.phase).toBe('healthcheck');
    expect(result.errorOutput).toContain('unhealthy');
    expect(result.errorOutput).toContain('db | ready'); // service logs included
  });
});

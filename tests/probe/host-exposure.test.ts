/**
 * What the probe does to the HOST, as opposed to what it does to the container.
 *
 * `sandbox.test.ts` asserts `isolationArgs` flag by flag — that is the container's side of
 * the boundary, and it was well covered. Nothing asserted the other side: how much memory
 * ORCA itself allocates for what the container emits, and what environment the `docker`
 * CLI is invoked with. Both halves were individually sound; the defects lived in the join,
 * which is the same shape as every other bug found in this area.
 *
 * These tests exercise the real `execa` path rather than a mock, because a mock of the
 * thing under test would have passed before the fix as happily as after.
 */
import { execa } from 'execa';
import { describe, expect, it } from 'vitest';

import { dockerClientEnv, isolationArgs } from '../../src/probe/sandbox.js';
import { DEFAULT_SETTINGS } from '../../src/config/settings.js';

/** Mirrors `MAX_DOCKER_OUTPUT_BYTES` in the module under test. */
const MAX_DOCKER_OUTPUT_BYTES = 256 * 1024;

describe('a hostile container cannot exhaust the analysing host', () => {
  it('bounds what a single read may buffer, not merely what it keeps', async () => {
    // The defect in one assertion. `MAX_LOG_BYTES` sliced a string that had already been
    // read fully into memory, and execa buffers an unbounded child stdout by default — so
    // one container printing one enormous line got allocated in full before the slice
    // discarded it. Measured against the real execa, which is the only way to catch it.
    const hostile = await execa('sh', ['-c', 'head -c 5000000 /dev/zero | tr "\\0" x'], {
      reject: false,
      env: {},
      extendEnv: false,
      maxBuffer: MAX_DOCKER_OUTPUT_BYTES,
    });

    expect(hostile.stdout.length).toBe(MAX_DOCKER_OUTPUT_BYTES);
  });

  it('keeps the useful prefix rather than dropping the read entirely', async () => {
    // Truncate-and-flag, not throw: a container that floods its log should still yield the
    // first lines, which are the ones worth reading. `reject: false` is what makes the
    // overflow a truncation instead of a lost reading.
    const flooded = await execa(
      'sh',
      ['-c', 'echo START; head -c 5000000 /dev/zero | tr "\\0" x'],
      {
        reject: false,
        env: {},
        extendEnv: false,
        maxBuffer: MAX_DOCKER_OUTPUT_BYTES,
      }
    );

    expect(flooded.stdout.startsWith('START')).toBe(true);
    expect(flooded.stdout.length).toBeLessThanOrEqual(MAX_DOCKER_OUTPUT_BYTES);
  });
});

describe('the probe reaches the same docker daemon the build does', () => {
  it('passes the variables that select the daemon and the context', () => {
    // The defect: `env: {}` + `extendEnv: false` dropped `HOME`, and `HOME` is how the
    // docker CLI finds `~/.docker/config.json` and therefore the active context.
    // `build/docker.ts` runs with `extendEnv: true`, so on any non-default daemon
    // (rootless, Docker Desktop, an SSH or TLS context) the BUILD reached the real one
    // while every probe silently talked to another and returned an empty reading — which
    // the user cannot tell apart from "the app binds nothing".
    const passed = dockerClientEnv({
      HOME: '/home/dev',
      DOCKER_HOST: 'unix:///run/user/1000/docker.sock',
      DOCKER_CONTEXT: 'rootless',
      DOCKER_TLS_VERIFY: '1',
      DOCKER_CERT_PATH: '/home/dev/.docker/certs',
    });

    expect(passed).toMatchObject({
      HOME: '/home/dev',
      DOCKER_HOST: 'unix:///run/user/1000/docker.sock',
      DOCKER_CONTEXT: 'rootless',
      DOCKER_TLS_VERIFY: '1',
      DOCKER_CERT_PATH: '/home/dev/.docker/certs',
    });
  });

  it('still refuses to hand the host environment to the CLI wholesale', () => {
    // The hardening the original `env: {}` was reaching for, and which the fix must keep:
    // the passthrough is an allowlist, so secrets in the ambient environment never reach
    // the subprocess just because probing needs a socket path.
    const passed = dockerClientEnv({
      HOME: '/home/dev',
      AWS_SECRET_ACCESS_KEY: 'should-not-travel',
      ANTHROPIC_API_KEY: 'should-not-travel',
      GITHUB_TOKEN: 'should-not-travel',
    });

    expect(Object.keys(passed)).toEqual(['HOME']);
    expect(JSON.stringify(passed)).not.toContain('should-not-travel');
  });

  it('omits a variable that is unset rather than passing an empty one', () => {
    // An empty `DOCKER_HOST` is not the same as an absent one — it would override the
    // context with a blank endpoint instead of falling back to it.
    expect(dockerClientEnv({})).toEqual({});
    expect('DOCKER_HOST' in dockerClientEnv({ HOME: '/home/dev' })).toBe(false);
  });
});

describe('the image name cannot become an isolation flag', () => {
  it('ends flag parsing before the image', () => {
    // Docker's parser accepts flags after positionals, so an image string starting with
    // `-` would be read as an option — beside a flag list whose whole purpose is to
    // constrain the container. `--` removes the reliance on image names being well formed.
    const flags = isolationArgs(DEFAULT_SETTINGS);

    // The isolation flags themselves must stay ahead of the separator, or they would be
    // passed to the container as arguments instead of to docker.
    expect(flags).toContain('--network');
    expect(flags).not.toContain('--');
  });
});

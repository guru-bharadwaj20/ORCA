/**
 * Thin, typed wrappers over the `docker` and `docker compose` CLIs (via execa). This
 * is the ONLY module that shells out to docker; everything else stays testable by
 * mocking these functions.
 *
 * STAGE: 5 (build) — REAL code.
 * Inputs: a compose file path / project dir + command args.
 * Outputs: captured stdout/stderr + exit codes (never throws on non-zero exit;
 * `assertDockerAvailable` is the one function that throws, and only typed).
 */

import { execa } from 'execa';

import { DEFAULT_SETTINGS } from '../config/settings.js';
import { MissingDependencyError } from '../utils/errors.js';

/** The captured result of running a docker/compose command. */
export interface DockerCommandResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

/** Seconds `compose up --wait` waits for every healthcheck before failing. */
const UP_WAIT_TIMEOUT_S = 120;

/** Run `docker <args>` in a project dir, capturing output instead of throwing. */
async function runDocker(
  args: string[],
  projectDir?: string,
  signal?: AbortSignal
): Promise<DockerCommandResult> {
  const result = await execa('docker', args, {
    ...(projectDir !== undefined ? { cwd: projectDir } : {}),
    ...(signal !== undefined ? { cancelSignal: signal } : {}),
    reject: false,
    timeout: DEFAULT_SETTINGS.dockerTimeoutMs,
    // A run-level cancel (e.g. the extension's cancel button) kills the docker child.
    ...(signal !== undefined ? { cancelSignal: signal } : {}),
    // Plain buildkit progress keeps build logs line-oriented and readable for
    // the self-heal diagnosis (no ANSI redraw noise).
    env: { BUILDKIT_PROGRESS: 'plain' },
    extendEnv: true,
  });
  return {
    exitCode: typeof result.exitCode === 'number' ? result.exitCode : 1,
    stdout: typeof result.stdout === 'string' ? result.stdout : '',
    stderr: typeof result.stderr === 'string' ? result.stderr : '',
  };
}

/** Verify the docker CLI exists and the daemon is reachable; throw typed if not. */
export async function assertDockerAvailable(signal?: AbortSignal): Promise<void> {
  const result = await runDocker(['info', '--format', '{{.ServerVersion}}'], undefined, signal);
  if (result.exitCode !== 0) {
    throw new MissingDependencyError(
      'Docker is required but unavailable (is the docker daemon running?). ' +
        `Details: ${(result.stderr || result.stdout).trim().slice(0, 300) || 'docker CLI not found'}`
    );
  }
}

/** Run `docker compose build` in the given project dir. */
export async function composeBuild(
  projectDir: string,
  signal?: AbortSignal
): Promise<DockerCommandResult> {
  return runDocker(['compose', 'build'], projectDir, signal);
}

/**
 * Run `docker compose up -d --wait` — `--wait` blocks until every service is
 * running AND healthy (per its healthcheck), so an unhealthy stack fails here.
 */
export async function composeUp(
  projectDir: string,
  signal?: AbortSignal
): Promise<DockerCommandResult> {
  return runDocker(
    ['compose', 'up', '-d', '--wait', '--wait-timeout', String(UP_WAIT_TIMEOUT_S)],
    projectDir,
    signal
  );
}

/** Run `docker compose down` to tear everything down (safe on a never-started stack). */
export async function composeDown(
  projectDir: string,
  signal?: AbortSignal
): Promise<DockerCommandResult> {
  return runDocker(['compose', 'down', '--remove-orphans'], projectDir, signal);
}

/** Recent logs (all services, or one) to feed the self-heal diagnosis. */
export async function composeLogs(
  projectDir: string,
  service?: string,
  signal?: AbortSignal
): Promise<DockerCommandResult> {
  return runDocker(
    ['compose', 'logs', '--no-color', '--tail', '100', ...(service !== undefined ? [service] : [])],
    projectDir,
    signal
  );
}

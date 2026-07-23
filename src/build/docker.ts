import { execa } from 'execa';

import { loadSettings } from '../config/settings.js';
import { MissingDependencyError } from '../utils/errors.js';

export interface DockerCommandResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

const UP_WAIT_TIMEOUT_S = 120;

async function runDocker(
  args: string[],
  projectDir?: string,
  signal?: AbortSignal
): Promise<DockerCommandResult> {
  const result = await execa('docker', args, {
    ...(projectDir !== undefined ? { cwd: projectDir } : {}),
    ...(signal !== undefined ? { cancelSignal: signal } : {}),
    reject: false,
    timeout: loadSettings().dockerTimeoutMs,
    env: { BUILDKIT_PROGRESS: 'plain' },
    extendEnv: true,
  });
  return {
    exitCode: typeof result.exitCode === 'number' ? result.exitCode : 1,
    stdout: typeof result.stdout === 'string' ? result.stdout : '',
    stderr: typeof result.stderr === 'string' ? result.stderr : '',
  };
}

export async function assertDockerAvailable(signal?: AbortSignal): Promise<void> {
  const result = await runDocker(['info', '--format', '{{.ServerVersion}}'], undefined, signal);
  if (result.exitCode !== 0) {
    throw new MissingDependencyError(
      'Docker is required but unavailable (is the docker daemon running?). ' +
        `Details: ${(result.stderr || result.stdout).trim().slice(0, 300) || 'docker CLI not found'}`
    );
  }
}

export async function composeBuild(
  projectDir: string,
  signal?: AbortSignal
): Promise<DockerCommandResult> {
  return runDocker(['compose', 'build'], projectDir, signal);
}

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

export async function composeDown(
  projectDir: string,
  signal?: AbortSignal
): Promise<DockerCommandResult> {
  return runDocker(['compose', 'down', '--remove-orphans'], projectDir, signal);
}

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

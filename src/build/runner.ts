/**
 * Drives a single build+run attempt: build images, start the stack, and capture any
 * build/runtime errors in a structured form the self-heal loop can act on.
 *
 * STAGE: 5 (build) — REAL code.
 * Inputs: a project dir containing generated compose + Dockerfiles.
 * Outputs: an `AttemptResult` (success or captured error output).
 */

import { composeBuild, composeLogs, composeUp, type DockerCommandResult } from './docker.js';

/** The outcome of one build+run attempt. */
export interface AttemptResult {
  ok: boolean;
  /** Which phase produced the outcome. */
  phase: 'build' | 'up' | 'healthcheck';
  /** Combined, truncated error output when `ok` is false. */
  errorOutput?: string;
}

/** Keep the tail — that's where the actual error usually is. */
const MAX_OUTPUT_CHARS = 8000;

function combined(result: DockerCommandResult): string {
  const text = [result.stdout, result.stderr].filter((s) => s.trim() !== '').join('\n');
  return text.length > MAX_OUTPUT_CHARS
    ? `[...truncated by ORCA...]\n${text.slice(-MAX_OUTPUT_CHARS)}`
    : text;
}

/** build -> up (which waits for health), returning the first failure or success. */
export async function runOnce(projectDir: string, signal?: AbortSignal): Promise<AttemptResult> {
  const build = await composeBuild(projectDir, signal);
  if (build.exitCode !== 0) {
    return { ok: false, phase: 'build', errorOutput: combined(build) };
  }

  const up = await composeUp(projectDir, signal);
  if (up.exitCode !== 0) {
    // `up --wait` fails for unhealthy services too; the container logs carry the
    // actual reason, so append them for the diagnosis.
    const logs = await composeLogs(projectDir, undefined, signal);
    const phase = /unhealthy|health/i.test(`${up.stdout}\n${up.stderr}`) ? 'healthcheck' : 'up';
    const errorOutput = [combined(up), '## service logs (tail)', combined(logs)]
      .filter((s) => s !== '')
      .join('\n\n');
    return { ok: false, phase, errorOutput };
  }

  return { ok: true, phase: 'up' };
}

import { composeBuild, composeLogs, composeUp, type DockerCommandResult } from './docker.js';

export interface AttemptResult {
  ok: boolean;
  phase: 'build' | 'up' | 'healthcheck';
  errorOutput?: string;
}

const MAX_OUTPUT_CHARS = 8000;

function combined(result: DockerCommandResult): string {
  const text = [result.stdout, result.stderr].filter((s) => s.trim() !== '').join('\n');
  return text.length > MAX_OUTPUT_CHARS
    ? `[...truncated by ORCA...]\n${text.slice(-MAX_OUTPUT_CHARS)}`
    : text;
}

export async function runOnce(projectDir: string, signal?: AbortSignal): Promise<AttemptResult> {
  const build = await composeBuild(projectDir, signal);
  if (build.exitCode !== 0) {
    return { ok: false, phase: 'build', errorOutput: combined(build) };
  }

  const up = await composeUp(projectDir, signal);
  if (up.exitCode !== 0) {
    const logs = await composeLogs(projectDir, undefined, signal);
    const phase = /unhealthy|health/i.test(`${up.stdout}\n${up.stderr}`) ? 'healthcheck' : 'up';
    const errorOutput = [combined(up), '## service logs (tail)', combined(logs)]
      .filter((s) => s !== '')
      .join('\n\n');
    return { ok: false, phase, errorOutput };
  }

  return { ok: true, phase: 'up' };
}

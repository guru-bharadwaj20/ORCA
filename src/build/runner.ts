/**
 * Drives a single build+run attempt: build images, start the stack, and capture any
 * build/runtime errors in a structured form the self-heal loop can act on.
 *
 * STAGE: 5 (build)
 * Inputs: a project dir containing generated compose + Dockerfiles.
 * Outputs: an `AttemptResult` (success or captured error output).
 */

/** The outcome of one build+run attempt. */
export interface AttemptResult {
  ok: boolean;
  /** Which phase produced the outcome. */
  phase: 'build' | 'up' | 'healthcheck';
  /** Combined, truncated error output when `ok` is false. */
  errorOutput?: string;
}

// TODO(stage-5): build -> up -> wait for health, returning the first failure or success.
export async function runOnce(_projectDir: string): Promise<AttemptResult> {
  throw new Error('not implemented');
}

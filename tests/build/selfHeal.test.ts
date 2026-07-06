/**
 * STAGE 5 tests — build/run + self-heal loop with docker wrappers MOCKED.
 * Stubs only: no docker is invoked in tests.
 */
import { describe, it } from 'vitest';

describe('build + self-heal (mocked docker)', () => {
  // TODO(stage-5): mock docker.ts + the heal prompt and drive the retry loop.
  it.todo('retries up to maxHealAttempts then throws HealExhaustedError');
  it.todo('records one plain-English DiagnosisEntry per attempt');
  it.todo('stops early once a build succeeds');
});

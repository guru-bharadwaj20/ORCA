/**
 * The two `ProbeReading` fields that used to lie.
 *
 *   - `timedOut` was hardcoded `false` on every path, so it could not be true. A field
 *     that cannot be true is worse than no field: a caller reads it and concludes the run
 *     completed when it may have been killed at its wall-clock cap.
 *   - `exitCode` came from `{{.State.ExitCode}}` alone, which Docker reports as `0` for a
 *     container that is still RUNNING. "Exited cleanly" and "has not exited" arrived as
 *     the same value.
 */
import { describe, expect, it } from 'vitest';

import { parseExitCode } from '../../src/probe/sandbox.js';

describe('exit code is only reported once there is one', () => {
  it('returns null while the container is still running', () => {
    // The bug in one line: this used to come back as 0, meaning "finished successfully".
    expect(parseExitCode('running 0')).toBeNull();
  });

  it('returns null for every other not-yet-exited state', () => {
    for (const status of ['created', 'paused', 'restarting', 'removing']) {
      expect(parseExitCode(`${status} 0`)).toBeNull();
    }
  });

  it('reports a real exit code once the container has exited', () => {
    expect(parseExitCode('exited 0')).toBe(0);
    expect(parseExitCode('exited 1')).toBe(1);
    expect(parseExitCode('exited 137')).toBe(137);
    expect(parseExitCode('dead 255')).toBe(255);
  });

  it('returns null rather than guessing on unusable output', () => {
    // `docker inspect` failing yields '' through the sandbox's error path.
    for (const output of ['', '   ', 'exited', 'exited notanumber', 'garbage']) {
      expect(parseExitCode(output)).toBeNull();
    }
  });

  it('tolerates the whitespace docker actually emits', () => {
    expect(parseExitCode('  exited   3  \n')).toBe(3);
  });
});

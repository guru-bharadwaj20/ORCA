/**
 * The probe's time budget and its cancellation, both of which were absent.
 *
 *   - `probeTimeoutMs` was applied PER docker call. A probe issues a run, a settle, four
 *     reads and a teardown, so a 60s "timeout" actually bounded the probe at roughly six
 *     minutes — and a container that hung every call hung for all of them.
 *   - Nothing threaded `AbortSignal`, so Ctrl-C during a probe left the run waiting on the
 *     settle and on docker.
 *
 * Teardown is deliberately exempt from both: it is the one step that must still happen
 * when everything else has been cancelled or has run out of time, or the container the
 * contract promises to destroy outlives the run.
 */
import { describe, expect, it, vi } from 'vitest';

import { DEFAULT_SETTINGS } from '../../src/config/settings.js';
import type { ProbeReading } from '../../src/model/prober.js';
import { runProbers } from '../../src/probe/runner.js';
import type { ProbeSandbox, SandboxSpec } from '../../src/probe/sandbox.js';

/** Records the spec it was handed, so the runner's plumbing is observable. */
function recordingSandbox(): ProbeSandbox & { spec: SandboxSpec | null } {
  const sandbox = {
    spec: null as SandboxSpec | null,
    run: (spec: SandboxSpec): Promise<ProbeReading> => {
      sandbox.spec = spec;
      return Promise.resolve({
        exitCode: null,
        timedOut: false,
        netTcp: '',
        processes: [],
        log: '',
      });
    },
  };
  return sandbox;
}

const settings = { ...DEFAULT_SETTINGS, enableProbing: true };

describe('the runner passes a whole-probe budget to the sandbox', () => {
  it('hands over the configured timeout and settle', async () => {
    const sandbox = recordingSandbox();

    await runProbers({
      repoPath: '/repo',
      image: 'app:latest',
      gate: { enabled: true, approved: true },
      sandbox,
      settings: { ...settings, probeTimeoutMs: 45_000, probeSettleMs: 1500 },
    });

    expect(sandbox.spec?.timeoutMs).toBe(45_000);
    expect(sandbox.spec?.settleMs).toBe(1500);
  });
});

describe('cancellation reaches the sandbox', () => {
  it('forwards an AbortSignal when the run supplies one', async () => {
    const sandbox = recordingSandbox();
    const controller = new AbortController();

    await runProbers({
      repoPath: '/repo',
      image: 'app:latest',
      gate: { enabled: true, approved: true },
      sandbox,
      settings,
      signal: controller.signal,
    });

    expect(sandbox.spec?.signal).toBe(controller.signal);
  });

  it('omits the field entirely when there is no signal', async () => {
    // `exactOptionalPropertyTypes` is on: passing `signal: undefined` is a different
    // thing from not passing it, and execa treats an explicit undefined as a value.
    const sandbox = recordingSandbox();

    await runProbers({
      repoPath: '/repo',
      image: 'app:latest',
      gate: { enabled: true, approved: true },
      sandbox,
      settings,
    });

    expect(sandbox.spec !== null && 'signal' in sandbox.spec).toBe(false);
  });

  it('still runs the probers after an aborted settle rather than throwing', async () => {
    // An aborted settle means "read the container's state now" — the caller's own abort
    // handling decides what happens next, and a probe never fails a run.
    const controller = new AbortController();
    controller.abort();
    const sandbox = recordingSandbox();

    const outcome = await runProbers({
      repoPath: '/repo',
      image: 'app:latest',
      gate: { enabled: true, approved: true },
      sandbox,
      settings,
      signal: controller.signal,
    });

    expect(outcome.skipped).toBeNull();
    expect(outcome.claims).toEqual([]);
  });
});

describe('a sandbox that reports a timeout is surfaced, not hidden', () => {
  it('still returns cleanly when the reading is marked timed out', async () => {
    const timedOut: ProbeSandbox = {
      run: () =>
        Promise.resolve({
          exitCode: null,
          timedOut: true,
          netTcp: '',
          processes: [],
          log: 'partial output before the cap',
        }),
    };
    const spy = vi.spyOn(timedOut, 'run');

    const outcome = await runProbers({
      repoPath: '/repo',
      image: 'app:latest',
      gate: { enabled: true, approved: true },
      sandbox: timedOut,
      settings,
    });

    expect(spy).toHaveBeenCalledOnce();
    // A timed-out probe is a completed probe with a partial reading, not a skipped one.
    expect(outcome.skipped).toBeNull();
  });
});

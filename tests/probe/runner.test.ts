/**
 * PHASE G — the GATES (security-contract clauses 2 and 3) and the probers themselves.
 *
 * The gate tests assert something stronger than "returns no claims": they assert the
 * sandbox was never even ASKED to run. A check that filtered results afterwards would
 * satisfy a claims-only assertion while still having started a container, which is the
 * exact failure mode these clauses exist to prevent — so the fake sandbox counts its
 * calls and the count is the assertion.
 *
 * Hermetic: a stub `ProbeSandbox` stands in for Docker, the same way the AI facade is
 * injected elsewhere. Nothing here builds, runs, or pulls anything.
 */
import { describe, expect, it } from 'vitest';

import { DEFAULT_SETTINGS } from '../../src/config/settings.js';
import { PROBE_CONFIDENCE_CEILING } from '../../src/model/claim.js';
import type { ProbeReading } from '../../src/model/prober.js';
import { listeningPorts, logProber, portProber, processProber } from '../../src/probe/probers.js';
import { describeProbePlan, runProbers } from '../../src/probe/runner.js';
import type { ProbeSandbox } from '../../src/probe/sandbox.js';

/** A real `/proc/net/tcp` excerpt: one LISTEN on 8080 (0x1F90), one outbound connection. */
const NET_TCP = [
  '  sl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode',
  '   0: 00000000:1F90 00000000:0000 0A 00000000:00000000 00:00000000 00000000     0        0 12345 1',
  '   1: 0100007F:C1B2 0100007F:1538 01 00000000:00000000 00:00000000 00000000     0        0 12346 1',
].join('\n');

const READING: ProbeReading = {
  exitCode: 0,
  timedOut: false,
  netTcp: NET_TCP,
  processes: ['node /app/server.js', '/bin/sh -c cat /proc/net/tcp', 'ps aux'],
  log: [
    'Server listening on http://0.0.0.0:8080',
    'compiled 42 modules',
    'Error: ECONNREFUSED',
  ].join('\n'),
};

/** A sandbox that records how many times it was asked to run. */
function countingSandbox(reading: ProbeReading = READING): ProbeSandbox & { calls: number } {
  const sandbox = {
    calls: 0,
    run: (): Promise<ProbeReading> => {
      sandbox.calls += 1;
      return Promise.resolve(reading);
    },
  };
  return sandbox;
}

const settings = { ...DEFAULT_SETTINGS, enableProbing: true, probeSettleMs: 0 };

describe('the gates run before the sandbox, not after it', () => {
  it('never touches the sandbox when probing is not opted into', async () => {
    const sandbox = countingSandbox();

    const outcome = await runProbers({
      repoPath: '/repo',
      image: 'app:latest',
      gate: { enabled: false, approved: true },
      sandbox,
      settings,
    });

    expect(sandbox.calls).toBe(0);
    expect(outcome.claims).toEqual([]);
    expect(outcome.skipped).toContain('ORCA_ENABLE_PROBING');
  });

  it('never touches the sandbox when the plan was not approved', async () => {
    // Clause 3: probing rides the SAME approval that guards `docker compose up`. There
    // is deliberately no separate probe consent to grant.
    const sandbox = countingSandbox();

    const outcome = await runProbers({
      repoPath: '/repo',
      image: 'app:latest',
      gate: { enabled: true, approved: false },
      sandbox,
      settings,
    });

    expect(sandbox.calls).toBe(0);
    expect(outcome.skipped).toBe('the plan was not approved');
  });

  it('distinguishes "produced nothing" from "never ran"', async () => {
    const sandbox = countingSandbox({
      exitCode: 0,
      timedOut: false,
      netTcp: '',
      processes: [],
      log: '',
    });

    const outcome = await runProbers({
      repoPath: '/repo',
      image: 'app:latest',
      gate: { enabled: true, approved: true },
      sandbox,
      settings,
    });

    expect(sandbox.calls).toBe(1);
    expect(outcome.claims).toEqual([]);
    expect(outcome.skipped).toBeNull();
  });

  it('runs exactly one container no matter how many probers are registered', async () => {
    // The reason probers are pure parsers over a shared reading: registering a tenth
    // prober must not mean a tenth container.
    const sandbox = countingSandbox();

    await runProbers({
      repoPath: '/repo',
      image: 'app:latest',
      gate: { enabled: true, approved: true },
      sandbox,
      settings,
    });

    expect(sandbox.calls).toBe(1);
  });

  it('keeps one broken prober from losing the others observations', async () => {
    const sandbox = countingSandbox();
    const exploding = {
      id: 'probe:boom',
      tier: 4 as const,
      probe: (): Promise<never> => Promise.reject(new Error('boom')),
    };

    const outcome = await runProbers({
      repoPath: '/repo',
      image: 'app:latest',
      gate: { enabled: true, approved: true },
      sandbox,
      settings,
      probers: [exploding, portProber],
    });

    expect(outcome.claims.map((c) => c.value)).toEqual([
      { kind: 'port', port: 8080, protocol: 'tcp' },
    ]);
  });
});

describe('what the probers make of a reading', () => {
  const enabled = { repoPath: '/repo', scopeDir: '.', enabled: true, reading: READING };

  it('reads only LISTENing sockets out of /proc/net/tcp', async () => {
    // 0x1F90 = 8080, state 0A = LISTEN. The second row is an outbound connection (state
    // 01) on an ephemeral port — counting it would publish a port nothing offers.
    expect(listeningPorts(NET_TCP)).toEqual([8080]);

    const claims = await portProber.probe(enabled);
    expect(claims.map((c) => c.value)).toEqual([{ kind: 'port', port: 8080, protocol: 'tcp' }]);
  });

  it('reports the workload process and not the reader own commands', async () => {
    const claims = await processProber.probe(enabled);
    expect(claims.map((c) => c.value)).toEqual([
      { kind: 'process', command: 'node /app/server.js' },
    ]);
  });

  it('keeps the log lines that explain the run and drops the noise', async () => {
    const claims = await logProber.probe(enabled);
    expect(claims.map((c) => (c.value.kind === 'log' ? c.value.line : ''))).toEqual([
      'Server listening on http://0.0.0.0:8080',
      'Error: ECONNREFUSED',
    ]);
  });

  it('yields nothing for a disabled context, before looking at the reading', async () => {
    // Restated in every prober rather than trusted to the runner, because a prober may
    // one day be invoked from somewhere that forgot the gate.
    const disabled = { ...enabled, enabled: false };
    for (const prober of [portProber, processProber, logProber]) {
      await expect(prober.probe(disabled)).resolves.toEqual([]);
    }
  });

  it('yields nothing when nothing was observed', async () => {
    const noReading = { repoPath: '/repo', scopeDir: '.', enabled: true };
    for (const prober of [portProber, processProber, logProber]) {
      await expect(prober.probe(noReading)).resolves.toEqual([]);
    }
  });
});

describe('a probe can never outrank the deterministic tiers', () => {
  it('caps probe confidence below what a deterministic detector reaches', async () => {
    const claims = await portProber.probe({
      repoPath: '/repo',
      scopeDir: '.',
      enabled: true,
      reading: READING,
    });

    // Clause 5's other half: an observation of ONE run under ONE configuration must not
    // be able to overturn the manifest. A container denied a network may never reach the
    // code path that binds the real port.
    for (const c of claims) {
      expect(c.source).toBe('probe');
      expect(c.confidence).toBeLessThanOrEqual(PROBE_CONFIDENCE_CEILING);
      expect(c.evidence.length).toBeGreaterThan(0);
    }
    expect(PROBE_CONFIDENCE_CEILING).toBeLessThan(0.95);
  });
});

describe('what the approval gate is shown', () => {
  it('names the image and the isolation it would run under', () => {
    // Clause 3 is "the user sees WHAT would be executed and WHY", so this has to be
    // specific enough to judge — not merely "probing is enabled".
    const description = describeProbePlan('app:latest', DEFAULT_SETTINGS);

    expect(description).toContain('app:latest');
    expect(description).toContain('--network none');
    expect(description).toContain('--cap-drop ALL');
    expect(description).toContain('No host path is mounted');
  });
});

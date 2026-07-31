/**
 * PHASE G — the tier-4 `Prober` CONTRACT, tested against a throwaway in-test prober.
 *
 * Deliberately kept separate from the shipped implementation's tests (`tests/probe/`):
 * this file pins what the seam demands of ANY prober — tier 4, and a disabled context
 * yields no claims — so it keeps holding for a prober written years from now against a
 * different runtime. `tests/probe/` covers the probers ORCA actually ships and the
 * isolation they run under.
 */
import { describe, expect, it } from 'vitest';

import { claim } from '../../src/model/claim.js';
import type { Prober, ProbeContext, ProbeObservation } from '../../src/model/prober.js';

/** A stand-in prober: emits a single port observation, but only when enabled. */
const portProber: Prober = {
  id: 'probe:ports',
  tier: 4,
  probe(ctx: ProbeContext) {
    if (!ctx.enabled) return Promise.resolve([]);
    const obs: ProbeObservation = { kind: 'port', port: 8080, protocol: 'tcp' };
    return Promise.resolve([
      claim(
        obs,
        [{ detector: 'probe:ports', signal: 'observed bind :8080', weight: 0.6 }],
        'probe'
      ),
    ]);
  },
};

const ctx = (enabled: boolean): ProbeContext => ({ repoPath: '/tmp/x', scopeDir: '.', enabled });

describe('Prober seam (Phase G, no execution)', () => {
  it('is pinned to tier 4 — the last, most-guarded rung of the ladder', () => {
    expect(portProber.tier).toBe(4);
  });

  it('yields no claims when probing is not opted-in/approved (disabled context)', async () => {
    await expect(portProber.probe(ctx(false))).resolves.toEqual([]);
  });

  it('emits an evidence-backed, probe-sourced claim when enabled', async () => {
    const claims = await portProber.probe(ctx(true));
    expect(claims).toHaveLength(1);
    expect(claims[0]?.source).toBe('probe');
    expect(claims[0]?.value).toEqual({ kind: 'port', port: 8080, protocol: 'tcp' });
    // Every probe fact is auditable, like any other claim.
    expect(claims[0]?.evidence.length).toBeGreaterThan(0);
  });
});

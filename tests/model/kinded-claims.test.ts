import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, it, expect } from 'vitest';

import { claim, claimsOfKind, bestClaim, type Claim } from '../../src/model/claim.js';
import { DetectorRegistry, type Detector, type RepoContext } from '../../src/model/detector.js';
import {
  mixedDetectorRegistry,
  defaultDetectorRegistry,
} from '../../src/detect/detectors/index.js';
import {
  runtimeFact,
  roleFact,
  type RuntimeFact,
  type RoleFact,
} from '../../src/detect/detectors/facts.js';

const ev = (signal: string, weight = 0.9) => [{ detector: 'test', signal, weight }];

describe('claimsOfKind', () => {
  it('selects only claims of the requested kind', () => {
    const claims: Claim<unknown>[] = [
      claim(runtimeFact('go'), ev('go.mod present'), 'deterministic'),
      claim(roleFact('job'), ev('crontab present'), 'deterministic'),
      claim(runtimeFact('rust'), ev('Cargo.toml present'), 'deterministic'),
    ];

    const runtimes = claimsOfKind<RuntimeFact>(claims, 'runtime');
    const roles = claimsOfKind<RoleFact>(claims, 'role');

    expect(runtimes.map((c) => c.value.runtime)).toEqual(['go', 'rust']);
    expect(roles.map((c) => c.value.role)).toEqual(['job']);
  });

  it('returns nothing for a kind that is absent', () => {
    const claims: Claim<unknown>[] = [
      claim(roleFact('library'), ev('no entrypoint'), 'deterministic'),
    ];

    expect(claimsOfKind<RuntimeFact>(claims, 'runtime')).toEqual([]);
  });

  it('ignores untagged and primitive values rather than mis-typing them', () => {
    // The pre-tag world: a bare string claim. A cast would have silently accepted this
    // as a RuntimeFact; the runtime check drops it.
    const claims: Claim<unknown>[] = [
      claim('go' as unknown, ev('legacy untagged claim'), 'deterministic'),
      claim(null as unknown, ev('null value'), 'deterministic'),
      claim(runtimeFact('go'), ev('go.mod present'), 'deterministic'),
    ];

    const runtimes = claimsOfKind<RuntimeFact>(claims, 'runtime');

    expect(runtimes).toHaveLength(1);
    expect(runtimes[0]?.value.runtime).toBe('go');
  });

  it('composes with bestClaim to rank within one kind only', () => {
    const claims: Claim<unknown>[] = [
      claim(runtimeFact('go'), ev('go.mod present', 0.9), 'deterministic'),
      // Higher confidence, but a different kind — must not win the runtime question.
      claim(roleFact('job'), ev('crontab present', 0.99), 'deterministic'),
    ];

    const best = bestClaim(claimsOfKind<RuntimeFact>(claims, 'runtime'));

    expect(best?.value.runtime).toBe('go');
  });
});

describe('DetectorRegistry with mixed claim kinds', () => {
  const runtimeStub: Detector<RuntimeFact> = {
    id: 'test:runtime',
    tier: 1,
    detect: async () => [claim(runtimeFact('rust'), ev('Cargo.toml present'), 'deterministic')],
  };
  const roleStub: Detector<RoleFact> = {
    id: 'test:role',
    tier: 1,
    detect: async () => [claim(roleFact('job'), ev('crontab present'), 'deterministic')],
  };

  const ctx: RepoContext = { repoPath: '/nonexistent', scopeDir: '.' };

  it('accepts detectors of different kinds in one registry', async () => {
    const registry = new DetectorRegistry();
    registry.register(runtimeStub).register(roleStub);

    const claims = await registry.collectAtTier(1, ctx);

    expect(claims).toHaveLength(2);
  });

  it('lets each consumer narrow to its own kind, unaffected by the other', async () => {
    const registry = new DetectorRegistry();
    registry.register(runtimeStub).register(roleStub);

    const claims = await registry.collectAtTier(1, ctx);

    // This is the guarantee that removed the second registry: one list, no corruption.
    expect(claimsOfKind<RuntimeFact>(claims, 'runtime')[0]?.value.runtime).toBe('rust');
    expect(claimsOfKind<RoleFact>(claims, 'role')[0]?.value.role).toBe('job');
  });

  it('collects nothing from a tier with no detectors', async () => {
    const registry = new DetectorRegistry();
    registry.register(runtimeStub);

    await expect(registry.collectAtTier(3, ctx)).resolves.toEqual([]);
  });
});

describe('shipped registries', () => {
  it('keeps the default registry runtime-only, so no walk is wasted', () => {
    const ids = defaultDetectorRegistry()
      .all()
      .map((d) => d.id);

    expect(ids.every((id) => id.startsWith('manifest:'))).toBe(true);
    expect(ids).not.toContain('role:library');
  });

  it('mixes both kinds in one registry and narrows them apart on a real repo', async () => {
    const repo = await mkdtemp(join(tmpdir(), 'orca-mixed-'));
    await writeFile(join(repo, 'go.mod'), 'module example.com/x\n');
    await writeFile(join(repo, 'crontab'), '0 * * * * /bin/true\n');

    const claims = await mixedDetectorRegistry().collectAtTier(1, {
      repoPath: repo,
      scopeDir: '.',
    });

    // Both kinds are present in one list, and each narrows cleanly out of it.
    expect(claimsOfKind<RuntimeFact>(claims, 'runtime').map((c) => c.value.runtime)).toEqual([
      'go',
    ]);
    expect(claimsOfKind<RoleFact>(claims, 'role').map((c) => c.value.role)).toContain('job');
  });
});

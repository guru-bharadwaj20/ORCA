/**
 * Coverage and honesty guarantees for the bare-runtime fallback (P0/P1).
 *
 * Both were found by probing detection against real manifests rather than reading types,
 * so both are pinned end-to-end here rather than at the registry alone — the P0 bug was
 * only half in the registry: the recipe matched fine in isolation while `filesAt` never
 * surfaced `package.json`, so the fallback stayed unreachable through the detect path.
 */

import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { describe, it, expect } from 'vitest';

import { detectStack } from '../../src/detect/index.js';
import { assessUnderstanding } from '../../src/detect/understanding.js';

const FIXTURE = join(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  'fixtures',
  'bare-runtime-repo'
);

describe('bare-runtime fallback', () => {
  it('places a Node component whose framework no recipe names', async () => {
    const result = await detectStack(FIXTURE);

    // Fastify has no recipe of its own. Before the fallback was registered this whole
    // repo detected as isSupported=false, confidence=0, placed=[].
    const gateway = result.insights.ecosystemComponents.find((c) => c.rootDir === 'gateway');
    expect(gateway?.recipeId).toBe('node-app');
    expect(result.isSupported).toBe(true);
  });

  it('reports the component it could not place', async () => {
    const result = await detectStack(FIXTURE);

    // `legacy` is a candidate root (manage.py is a manifest) that nothing places.
    const unplaced = result.warnings.filter((w) => w.code === 'unplaced-component');
    expect(unplaced.map((w) => w.message)).toEqual([expect.stringContaining("'legacy'")]);
  });

  it('grades the partial stack as partial, not success', async () => {
    const understanding = assessUnderstanding(await detectStack(FIXTURE));

    // The point of the pair: placing MORE (P0) must not mean claiming completeness (P1).
    expect(understanding.level).toBe('partial');
    expect(understanding.shouldEscalate).toBe(true);
    expect(understanding.gaps.some((g) => g.includes('legacy'))).toBe(true);
  });
});

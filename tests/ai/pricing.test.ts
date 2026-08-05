/**
 * `estimateUsd` is a SAFETY CONTROL, not a display value.
 *
 * It feeds the ledger that enforces `--cost-cap` (`router.ts`), so the two directions of
 * error are not symmetric: an estimate that is too low lets a run overspend its ceiling,
 * while one that is too high only trips the cap early. That asymmetry is what these tests
 * pin — the exact rates will move, but "never under-count" must not.
 */
import { describe, expect, it } from 'vitest';

import { estimateUsd } from '../../src/ai/providers/anthropic.js';

/** One million input tokens and one million output tokens — rates read directly in USD. */
const MTOK = 1_000_000;
const priceOf = (model: string): number => estimateUsd(model, MTOK, MTOK);

/** Every model id the pricing table is expected to name. */
const KNOWN_MODELS = [
  'claude-fable-5',
  'claude-mythos-5',
  'claude-opus-5',
  'claude-opus-4-8',
  'claude-opus-4-7',
  'claude-opus-4-6',
  'claude-sonnet-5',
  'claude-sonnet-4-6',
  'claude-haiku-4-5',
];

describe('estimateUsd', () => {
  it('prices the current models at their published rates', () => {
    expect(priceOf('claude-fable-5')).toBe(60); // $10 in + $50 out
    expect(priceOf('claude-opus-5')).toBe(30); // $5 + $25
    expect(priceOf('claude-sonnet-5')).toBe(18); // $3 + $15
    expect(priceOf('claude-haiku-4-5')).toBe(6); // $1 + $5
  });

  it('scales linearly with token counts', () => {
    expect(estimateUsd('claude-opus-5', MTOK / 2, 0)).toBe(2.5);
    expect(estimateUsd('claude-opus-5', 0, MTOK / 2)).toBe(12.5);
    expect(estimateUsd('claude-opus-5', 0, 0)).toBe(0);
  });
});

describe('an unknown model must never be under-counted', () => {
  it('never estimates a new model below any model we do know', () => {
    // The regression this file exists for. The fallback used to be the Opus rate, so
    // `--model claude-fable-5 --cost-cap 1.00` billed at $10/$50 while the ledger counted
    // $5/$25 — the run could spend twice its ceiling before the cap noticed. Any model
    // that ships between ORCA releases lands here, so the fallback has to assume the
    // worst rather than guess a mid-tier price.
    const unknown = priceOf('claude-some-model-released-after-this-test');
    const dearestKnown = Math.max(...KNOWN_MODELS.map(priceOf));

    expect(unknown).toBeGreaterThanOrEqual(dearestKnown);
  });

  it('applies the same floor to an empty or junk model id', () => {
    // These reach `estimateUsd` through `--model`, which takes an arbitrary string.
    const dearestKnown = Math.max(...KNOWN_MODELS.map(priceOf));

    for (const id of ['', 'gpt-4', 'claude', 'CLAUDE-OPUS-5']) {
      expect(priceOf(id)).toBeGreaterThanOrEqual(dearestKnown);
    }
  });

  it('still prices every known model exactly, not at the ceiling', () => {
    // The guard must not degrade into "charge everything the maximum" — that would make
    // the cap useless in the ordinary case.
    expect(priceOf('claude-haiku-4-5')).toBeLessThan(priceOf('claude-fable-5'));
    expect(priceOf('claude-sonnet-5')).toBeLessThan(priceOf('claude-opus-5'));
  });
});

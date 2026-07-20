/**
 * PHASE A tests — the evidence-based detection model (src/model/claim.ts).
 * Pure math + invariants; no I/O. Covers the confidence-combination formula, the
 * "every claim explains itself" guarantee, and the AI confidence ceiling that
 * enforces deterministic-first.
 */
import { describe, expect, it } from 'vitest';

import {
  AI_CONFIDENCE_CEILING,
  bestClaim,
  claim,
  combineConfidence,
  reasoning,
  type Evidence,
} from '../../src/model/claim.js';

const ev = (weight: number, signal = 's'): Evidence => ({ detector: 'test', signal, weight });

describe('combineConfidence', () => {
  it('is 0 for no evidence', () => {
    expect(combineConfidence([])).toBe(0);
  });

  it('returns the single weight for one signal', () => {
    expect(combineConfidence([ev(0.5)])).toBe(0.5);
  });

  it('combines independent signals as a probabilistic OR (agreement raises confidence)', () => {
    // 1 - (1-0.5)(1-0.5) = 0.75 — two agreeing signals beat either alone.
    expect(combineConfidence([ev(0.5), ev(0.5)])).toBe(0.75);
  });

  it('clamps out-of-range weights instead of exploding', () => {
    expect(combineConfidence([ev(2)])).toBe(1);
    expect(combineConfidence([ev(-1)])).toBe(0);
  });

  it('never exceeds 1', () => {
    expect(combineConfidence([ev(0.9), ev(0.9), ev(0.9)])).toBeLessThanOrEqual(1);
  });
});

describe('claim', () => {
  it('computes confidence from evidence rather than accepting a hand-set value', () => {
    const c = claim('rust', [ev(0.6), ev(0.6)], 'deterministic');
    expect(c.confidence).toBe(combineConfidence([ev(0.6), ev(0.6)]));
    expect(c.value).toBe('rust');
  });

  it('throws when a claim has no evidence — every inference must explain itself', () => {
    expect(() => claim('go', [], 'deterministic')).toThrow(/evidence/);
  });

  it('caps AI-sourced claims at the ceiling (deterministic-first)', () => {
    const c = claim('fastapi', [ev(0.95), ev(0.95)], 'ai');
    expect(c.confidence).toBe(AI_CONFIDENCE_CEILING);
  });

  it('does not cap a deterministic claim with the same evidence', () => {
    const c = claim('fastapi', [ev(0.95), ev(0.95)], 'deterministic');
    expect(c.confidence).toBeGreaterThan(AI_CONFIDENCE_CEILING);
  });
});

describe('reasoning', () => {
  it('projects evidence to the human-readable signal strings', () => {
    const c = claim(
      'rust',
      [ev(0.5, 'Cargo.toml present'), ev(0.4, 'CI runs cargo build')],
      'deterministic'
    );
    expect(reasoning(c)).toEqual(['Cargo.toml present', 'CI runs cargo build']);
  });
});

describe('bestClaim', () => {
  it('returns null for an empty list', () => {
    expect(bestClaim([])).toBeNull();
  });

  it('picks the highest-confidence claim', () => {
    const low = claim('a', [ev(0.3)], 'deterministic');
    const high = claim('b', [ev(0.8)], 'deterministic');
    expect(bestClaim([low, high])?.value).toBe('b');
  });

  it('breaks ties toward the earlier (higher-priority) claim', () => {
    const first = claim('a', [ev(0.5)], 'deterministic');
    const second = claim('b', [ev(0.5)], 'deterministic');
    expect(bestClaim([first, second])?.value).toBe('a');
  });
});

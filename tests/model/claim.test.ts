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
    // 1 - (1-0.5)(1-0.5) = 0.75 — two agreeing signals from DIFFERENT families beat
    // either alone. Independence is what licenses the probabilistic OR.
    const a: Evidence = { detector: 'manifest', family: 'manifest', signal: 's', weight: 0.5 };
    const b: Evidence = { detector: 'ci', family: 'ci', signal: 's', weight: 0.5 };
    expect(combineConfidence([a, b])).toBe(0.75);
  });

  it('does not let correlated signals in one family compound', () => {
    // Same family = one fact observed twice (a lockfile is generated from its manifest),
    // so the strongest wins instead of folding to 1 - (1-0.85)(1-0.85) = 0.978.
    expect(combineConfidence([ev(0.85), ev(0.85)])).toBe(0.85);
  });

  it('defaults a signal family to its detector', () => {
    // The honest default: two signals from one detector are rarely independent.
    const same: Evidence[] = [
      { detector: 'manifest:rust', signal: 'Cargo.toml present', weight: 0.85 },
      { detector: 'manifest:rust', signal: 'Cargo.lock present', weight: 0.85 },
    ];
    expect(combineConfidence(same)).toBe(0.85);
  });

  it('keeps the strongest weight within a family, not the first', () => {
    expect(combineConfidence([ev(0.2), ev(0.7), ev(0.4)])).toBe(0.7);
  });

  it('stops ten correlated weak signals from manufacturing near-certainty', () => {
    // The naive fold gives 0.893 here — a pile of guesses reading as near-certain.
    expect(combineConfidence(Array.from({ length: 10 }, () => ev(0.2)))).toBe(0.2);
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

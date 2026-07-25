/**
 * How well ORCA actually understands a repo — the graded outcome the plan calls for
 * (docs/universal-understanding-plan.md §4, §10 rows 2–3).
 *
 * THE PROBLEM THIS SOLVES. `DetectionResult.isSupported` is a boolean, and tier-3
 * escalation was gated on it: `if (!detection.isSupported)`. So a repo ORCA *placed* but
 * barely understood — a matched recipe with no build command, no start command, and a
 * confidence of 0.3 — never escalated, because "placed at all" and "understood well
 * enough to build" were the same bit. Only a total miss could ask for help, which is
 * exactly backwards: the total miss is obvious, while the half-understood repo is the one
 * that silently produces a broken Dockerfile.
 *
 * WHY THIS IS DERIVED, NOT A NEW FIELD. It is computed from an existing `DetectionResult`
 * rather than stored on it, so no detector, serializer, or persisted record changes shape.
 * The grade is a *view* over evidence already gathered — which also means it stays correct
 * automatically as detection improves.
 *
 * STAGE: 2 (detect) — REAL code. Pure function over a `DetectionResult`. No I/O, no AI.
 */

import type { DetectionResult } from './types.js';

/**
 * Confidence at or above which a placed repo is considered well understood, provided it
 * also has no structural gaps. Deliberately not near-certain: the point is to catch the
 * genuinely thin cases, not to send every ordinary repo to the model.
 */
export const CONFIDENT_THRESHOLD = 0.6;

/** How well the deterministic ladder understood this repo. */
export type UnderstandingLevel =
  /** Nothing placeable — no component, no ecosystem match, no Dockerfile. */
  | 'none'
  /** Placed, but with real gaps: thin confidence or a recipe missing how to run. */
  | 'partial'
  /** Placed, corroborated, and complete enough to build from. */
  | 'confident';

/** The graded outcome: a level, the number behind it, and what is missing. */
export interface Understanding {
  level: UnderstandingLevel;
  /** The aggregate detection confidence this grade was derived from. */
  confidence: number;
  /**
   * Human-readable gaps, empty when none. These are what a reviewer (or the tier-3
   * prompt) should look at — "matched a recipe but no start command" is far more useful
   * than "confidence 0.42".
   */
  gaps: string[];
  /**
   * Whether escalating to tier-3 inference would plausibly help. False for a confident
   * repo (nothing to add) and false when nothing was placed *and* the repo looks empty —
   * the caller still decides whether a key is available.
   */
  shouldEscalate: boolean;
}

/**
 * Grade a detection result.
 *
 * `none` preserves today's hard-stop condition exactly, so the failure path is unchanged.
 * The new information is the `partial` band: placed, but with a stated reason to doubt it.
 */
export function assessUnderstanding(detection: DetectionResult): Understanding {
  const gaps: string[] = [];
  const confidence = detection.confidence;

  if (!detection.isSupported) {
    return {
      level: 'none',
      confidence,
      gaps: ['no component, ecosystem recipe, or Dockerfile could be placed'],
      shouldEscalate: true,
    };
  }

  // A placed component that cannot say how to START is the sharpest gap there is: the
  // image would build and then have nothing to run.
  for (const eco of detection.insights.ecosystemComponents) {
    if (eco.recipeId === '' || eco.recipeId === undefined) {
      gaps.push(`'${eco.rootDir}' was placed without a matched recipe`);
    }
  }

  // Nothing in the repo declares how it is built — no CI, no task runner, no README/script
  // block, no Dockerfile. Deterministic detection guessed the build entirely from shape.
  const declaresBuild =
    detection.insights.ciCommands.length > 0 ||
    detection.insights.ciProviders.length > 0 ||
    detection.insights.taskCommands.length > 0 ||
    detection.insights.scriptSources.length > 0 ||
    detection.insights.dockerfiles.length > 0;
  if (!declaresBuild) {
    gaps.push('nothing in the repo declares how it is built (no CI, task runner, or script)');
  }

  if (confidence < CONFIDENT_THRESHOLD) {
    gaps.push(`aggregate detection confidence is ${confidence.toFixed(2)}`);
  }

  const level: UnderstandingLevel = gaps.length === 0 ? 'confident' : 'partial';
  return { level, confidence, gaps, shouldEscalate: level !== 'confident' };
}

/** One-line summary for logs and the review gate. */
export function describeUnderstanding(u: Understanding): string {
  if (u.level === 'confident') return `understood with confidence ${u.confidence.toFixed(2)}`;
  const reason = u.gaps.length > 0 ? ` — ${u.gaps.join('; ')}` : '';
  return `${u.level} understanding (confidence ${u.confidence.toFixed(2)})${reason}`;
}

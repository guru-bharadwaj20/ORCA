/**
 * The plugin contract for detection (docs/universal-understanding-plan.md §3).
 *
 * A detector is a standalone `(ctx) => Claim[]` unit registered in a list. This is the
 * formalization of what `src/detect/index.ts` already does informally — its header
 * comment even notes each detector "could later become its own agent". Making the
 * interface explicit is what turns "add a framework = edit closed enums + a switch"
 * into "add a framework = push a detector onto the registry".
 *
 * PHASE: A (foundation) — REAL contract. Detectors migrate onto it incrementally;
 * the legacy `detectStack` path keeps working until the port is complete.
 */

import type { Claim } from './claim.js';

/** Read-only context handed to every detector: where the repo is + shared lookups. */
export interface RepoContext {
  /** Absolute path to the cloned repo on disk. */
  repoPath: string;
  /**
   * Repo-relative directory this detector should focus on (`.` for the repo root).
   * Component-scoped detectors receive the component root; repo-wide ones receive `.`.
   */
  scopeDir: string;
}

/**
 * One detection plugin. `tier` places it on the inference ladder: 1 = manifest/static,
 * 2 = CI analysis, 3 = AI inference, 4 = dynamic probing. The runner executes tiers in
 * order and only escalates to a higher tier when confidence gaps remain (deterministic-first).
 */
export interface Detector {
  /** Stable id, namespaced by kind, e.g. "manifest:node", "ci:github-actions". */
  id: string;
  /** Ladder rung (see docs §3). */
  tier: 1 | 2 | 3 | 4;
  /** Emit zero or more scored, evidence-backed claims for this context. */
  detect(ctx: RepoContext): Promise<Claim<unknown>[]>;
}

/**
 * An ordered, append-only registry of detectors. Registration order is priority order
 * (used as the tie-break in `bestClaim`). Kept deliberately tiny — the power is in the
 * detectors, not the registry.
 */
export class DetectorRegistry {
  private readonly detectors: Detector[] = [];

  /** Register a detector. Returns `this` for chaining. */
  register(detector: Detector): this {
    this.detectors.push(detector);
    return this;
  }

  /** All detectors at a given tier, in registration order. */
  atTier(tier: Detector['tier']): Detector[] {
    return this.detectors.filter((d) => d.tier === tier);
  }

  /** Every registered detector, in registration order. */
  all(): readonly Detector[] {
    return this.detectors;
  }
}

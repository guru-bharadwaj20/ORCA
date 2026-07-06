/**
 * Runs every independent detector and aggregates their output into a single
 * `DetectionResult`. This is the one place that composes the detect stage; each
 * detector stays standalone so it could later become its own agent.
 *
 * STAGE: 2 (detect)
 * Inputs: an absolute repo path.
 * Outputs: a fully-populated `DetectionResult` (the STAGE 2 contract).
 */

import type { DetectionResult } from './types.js';

export type { DetectionResult } from './types.js';

// TODO(stage-2): locate frontend/backend component roots, run each detector, decide
// `isSupported` + `confidence`, and collect warnings.
export async function detectStack(_repoPath: string): Promise<DetectionResult> {
  throw new Error('not implemented');
}

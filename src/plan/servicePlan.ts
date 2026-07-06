/**
 * Builds the `ServicePlan` (the service graph) from the detection result plus the
 * AI-filled templates. This is where components + databases become concrete container
 * nodes with ports, env, volumes, and dependency edges.
 *
 * STAGE: 4 (plan)
 * Inputs: a `DetectionResult` and the filled template variables.
 * Outputs: a `ServicePlan` ready for review, diagram, and generation.
 */

import type { DetectionResult } from '../detect/types.js';
import type { FilledTemplateVars } from '../ai/schema.js';
import type { ServicePlan } from './types.js';

// TODO(stage-4): assemble ServiceNodes for frontend/backend/databases and wire edges.
export function buildServicePlan(
  _detection: DetectionResult,
  _filled: Record<string, FilledTemplateVars>
): ServicePlan {
  throw new Error('not implemented');
}

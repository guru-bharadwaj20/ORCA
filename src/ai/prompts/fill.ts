/**
 * Prompt builder for the "fill template variables" task.
 *
 * STAGE: 3 (ai)
 * Inputs: detection facts + the template's required variables + README text.
 * Outputs: a { system, user } prompt pair for the client.
 */

import type { DetectionResult } from '../../detect/types.js';

/** A system+user prompt pair. */
export interface PromptPair {
  system: string;
  user: string;
}

// TODO(stage-3): compose the fill-template prompt with strict, schema-shaped output.
export function buildFillPrompt(_detection: DetectionResult, _readme: string): PromptPair {
  throw new Error('not implemented');
}

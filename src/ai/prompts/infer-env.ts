/**
 * Prompt builder for the "infer environment variables" task.
 *
 * STAGE: 3 (ai)
 * Inputs: detection facts + README/source hints.
 * Outputs: a { system, user } prompt pair for the client.
 */

import type { DetectionResult } from '../../detect/types.js';
import type { PromptPair } from './fill.js';

// TODO(stage-3): compose the infer-env prompt with strict, schema-shaped output.
export function buildInferEnvPrompt(_detection: DetectionResult, _readme: string): PromptPair {
  throw new Error('not implemented');
}

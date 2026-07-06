/**
 * Uses the LLM to infer the environment variables the app expects (DB URLs, secrets,
 * ports) from code references and the README, so ORCA can generate a sensible .env.
 *
 * STAGE: 3 (ai)
 * Inputs: a `DetectionResult` + README/source hints.
 * Outputs: validated `InferredEnv` (key/value/required/reason per variable).
 */

import type { DetectionResult } from '../detect/types.js';
import type { CostLedger } from '../core/context.js';
import type { InferredEnv } from './schema.js';

// TODO(stage-3): build the infer-env prompt, call the client, validate with the schema.
export async function inferEnv(
  _detection: DetectionResult,
  _readme: string,
  _ledger: CostLedger
): Promise<InferredEnv> {
  throw new Error('not implemented');
}

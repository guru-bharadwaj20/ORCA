/**
 * Uses the LLM to infer the environment variables the app expects (DB URLs, secrets,
 * ports) from code references and the README, so ORCA can generate a sensible .env.
 *
 * STAGE: 3 (ai) — REAL code.
 * Inputs: a `DetectionResult` + README/source hints.
 * Outputs: validated `InferredEnv` (key/value/required/reason per variable).
 */

import type { DetectionResult } from '../detect/types.js';
import type { CostLedger } from '../core/context.js';
import { ai, type AIFacade } from './client.js';
import { buildInferEnvPrompt } from './prompts/infer-env.js';
import { InferredEnvSchema, type InferredEnv } from './schema.js';

/** Build the infer-env prompt and run it through the provider router (validated). */
export async function inferEnv(
  detection: DetectionResult,
  readme: string,
  ledger: CostLedger,
  client: AIFacade = ai
): Promise<InferredEnv> {
  const prompt = buildInferEnvPrompt(detection, readme);
  return client.complete(prompt, InferredEnvSchema, ledger, { schemaName: 'InferredEnv' });
}

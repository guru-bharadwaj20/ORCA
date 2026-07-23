import type { DetectionResult } from '../detect/types.js';
import type { CostLedger } from '../core/context.js';
import { ai, type AIFacade } from './client.js';
import { buildInferEnvPrompt } from './prompts/inferEnv.js';
import { InferredEnvSchema, type InferredEnv } from './schema.js';

export async function inferEnv(
  detection: DetectionResult,
  readme: string,
  ledger: CostLedger,
  client: AIFacade = ai
): Promise<InferredEnv> {
  const prompt = buildInferEnvPrompt(detection, readme);
  return client.complete(prompt, InferredEnvSchema, ledger, { schemaName: 'InferredEnv' });
}

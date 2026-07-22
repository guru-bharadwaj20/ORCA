import type { z } from 'zod';

import { DEFAULT_SETTINGS } from '../config/settings.js';
import type { CostLedger } from '../core/context.js';
import { CostCapExceededError } from '../utils/errors.js';
import { AnthropicProvider } from './providers/anthropic.js';
import { recordUsage } from './providers/types.js';
import { AIRouter, type RouterCallOptions, type RouterPrompt } from './router.js';

export { createAnthropicClient, estimateUsd } from './providers/anthropic.js';

export interface CompletionRequest {
  system: string;
  user: string;
  model?: string;
  maxTokens?: number;
  schemaName?: string;
  costCapUsd?: number;
}

export interface CompletionResult {
  text: string;
  inputTokens: number;
  outputTokens: number;
}

export interface AIFacade {
  complete<Output, Input = Output>(
    prompt: RouterPrompt,
    schema: z.ZodType<Output, z.ZodTypeDef, Input>,
    ledger: CostLedger,
    options?: RouterCallOptions
  ): Promise<Output>;
}

let defaultRouter: AIRouter | null = null;
function getRouter(): AIRouter {
  return (defaultRouter ??= new AIRouter());
}

export const ai: AIFacade = {
  complete(prompt, schema, ledger, options) {
    return getRouter().completeValidated(prompt, schema, ledger, options);
  },
};

export function aiFor(router: AIRouter): AIFacade {
  return {
    complete(prompt, schema, ledger, options) {
      return router.completeValidated(prompt, schema, ledger, options);
    },
  };
}

export async function complete(
  request: CompletionRequest,
  ledger: CostLedger
): Promise<CompletionResult> {
  const costCapUsd = request.costCapUsd ?? DEFAULT_SETTINGS.costCapUsd;
  if (ledger.estimatedUsd >= costCapUsd) {
    throw new CostCapExceededError(
      `LLM cost cap reached ($${ledger.estimatedUsd.toFixed(4)} of $${costCapUsd.toFixed(2)}); ` +
        `refusing further calls${request.schemaName ? ` (wanted: ${request.schemaName})` : ''}.`
    );
  }

  const provider = new AnthropicProvider();
  const completion = await provider.complete(request.user, {
    system: request.system,
    ...(request.model !== undefined ? { model: request.model } : {}),
    ...(request.maxTokens !== undefined ? { maxTokens: request.maxTokens } : {}),
  });
  recordUsage(ledger, provider.name, completion);

  return {
    text: completion.text,
    inputTokens: completion.inputTokens,
    outputTokens: completion.outputTokens,
  };
}

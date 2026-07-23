import type { z } from 'zod';

import type { CostLedger } from '../core/context.js';
import { AIRouter, type RouterCallOptions, type RouterPrompt } from './router.js';

export { createAnthropicClient, estimateUsd } from './providers/anthropic.js';

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

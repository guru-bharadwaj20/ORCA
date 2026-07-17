/**
 * The AI facade the rest of the pipeline talks to. Orchestrators call
 * `ai.complete(prompt, schema, ledger)` and get back a validated object — provider
 * selection, retries, and Qwen→Claude fallback all live behind this boundary in
 * `router.ts` / `providers/*`.
 *
 * Also keeps the original Anthropic-direct `complete()` (and `createAnthropicClient`)
 * for callers that explicitly want the fallback provider, e.g. diagnostics.
 *
 * STAGE: 3 (ai) — REAL code.
 * Inputs: a prompt (system + user), a zod schema, and the run's cost ledger.
 * Outputs: validated structured output + token usage recorded on the ledger.
 */

import type { z } from 'zod';

import { DEFAULT_SETTINGS } from '../config/settings.js';
import type { CostLedger } from '../core/context.js';
import { CostCapExceededError } from '../utils/errors.js';
import { AnthropicProvider } from './providers/anthropic.js';
import { recordUsage } from './providers/types.js';
import { AIRouter, type RouterCallOptions, type RouterPrompt } from './router.js';

export { createAnthropicClient, estimateUsd } from './providers/anthropic.js';

/** Options for a single (Anthropic-direct) model call. */
export interface CompletionRequest {
  system: string;
  user: string;
  /** Anthropic model id; defaults to the configured model. */
  model?: string;
  maxTokens?: number;
  /** Optional JSON schema name for structured-output requests (used in error messages/logs). */
  schemaName?: string;
  /** Hard cap on total LLM spend for the run, in USD; defaults to the configured cap. */
  costCapUsd?: number;
}

/** A model response plus the usage it incurred. */
export interface CompletionResult {
  text: string;
  inputTokens: number;
  outputTokens: number;
}

/**
 * The provider-agnostic completion surface orchestrators depend on. The default
 * `ai` export implements it from env config; `aiFor()` builds a run-scoped one
 * (e.g. honoring `--model` / `--cost-cap`), carried on `RunContext.ai`.
 */
export interface AIFacade {
  complete<Output, Input = Output>(
    prompt: RouterPrompt,
    schema: z.ZodType<Output, z.ZodTypeDef, Input>,
    ledger: CostLedger,
    options?: RouterCallOptions
  ): Promise<Output>;
}

/** Lazily-built default router so env-based config is read when first needed. */
let defaultRouter: AIRouter | null = null;
function getRouter(): AIRouter {
  return (defaultRouter ??= new AIRouter());
}

/**
 * What orchestrators use. One call = one AI task, provider-agnostic:
 * primary provider → validation → retries → fallback, per the router policy.
 */
export const ai: AIFacade = {
  complete(prompt, schema, ledger, options) {
    return getRouter().completeValidated(prompt, schema, ledger, options);
  },
};

/** Wrap a configured router as the facade orchestrators consume. */
export function aiFor(router: AIRouter): AIFacade {
  return {
    complete(prompt, schema, ledger, options) {
      return router.completeValidated(prompt, schema, ledger, options);
    },
  };
}

/**
 * Anthropic-direct completion (bypasses the router; no fallback). Enforces the cost
 * cap *before* the call and records usage — including the per-provider slice — on
 * the ledger.
 */
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

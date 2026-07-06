/**
 * Thin wrapper around the Anthropic SDK. Owns model selection, ret/timeout config,
 * and cost-cap enforcement so no other module talks to the LLM directly. BYOK: the
 * key comes from ANTHROPIC_API_KEY.
 *
 * STAGE: 3 (ai)
 * Inputs: a prompt (system + user) and generation options.
 * Outputs: the model's text/structured response + token usage for the cost ledger.
 */

import type { CostLedger } from '../core/context.js';

/** Options for a single model call. */
export interface CompletionRequest {
  system: string;
  user: string;
  /** Anthropic model id; defaults to the configured model. */
  model?: string;
  maxTokens?: number;
  /** Optional JSON schema name for structured-output requests. */
  schemaName?: string;
}

/** A model response plus the usage it incurred. */
export interface CompletionResult {
  text: string;
  inputTokens: number;
  outputTokens: number;
}

// TODO(stage-3): construct the Anthropic client from env; throw a clear error if the
// key is missing.
export function createAnthropicClient(): unknown {
  throw new Error('not implemented');
}

// TODO(stage-3): send a completion, enforce the cost cap against the ledger, and
// return text + usage.
export async function complete(
  _request: CompletionRequest,
  _ledger: CostLedger
): Promise<CompletionResult> {
  throw new Error('not implemented');
}

/**
 * The provider abstraction for ORCA's AI layer. Every LLM backend (Qwen, Anthropic,
 * future providers) implements `AIProvider`; the router and orchestrators only ever
 * see this interface, so the rest of the pipeline never knows which provider ran.
 *
 * STAGE: 3 (ai) — REAL code.
 * Inputs: a user prompt + completion options.
 * Outputs: response text + token usage + the provider's own cost estimate.
 */

import type { CostLedger } from '../../core/context.js';
import type { ProviderName } from '../../config/settings.js';

export type { ProviderName } from '../../config/settings.js';

/** Options for a single completion. */
export interface CompletionOptions {
  /** System prompt, kept separate so providers can map it to their native shape. */
  system?: string;
  /** Max output tokens; defaults to the configured setting. */
  maxTokens?: number;
  /** Provider-specific model id override; defaults to the provider's configured model. */
  model?: string;
}

/**
 * What a provider returns. Deliberately richer than a bare string: the cost-ledger
 * requirement (independent per-provider accounting) needs token usage and a price
 * estimate, and only the provider knows its own pricing.
 */
export interface ProviderCompletion {
  text: string;
  inputTokens: number;
  outputTokens: number;
  estimatedUsd: number;
}

/** One LLM backend. Implementations must be stateless per call (BYOK keys read from env). */
export interface AIProvider {
  readonly name: ProviderName;
  complete(prompt: string, options?: CompletionOptions): Promise<ProviderCompletion>;
}

/** Record one completion's usage on the run ledger — totals plus the per-provider slice. */
export function recordUsage(
  ledger: CostLedger,
  provider: ProviderName,
  completion: ProviderCompletion
): void {
  ledger.inputTokens += completion.inputTokens;
  ledger.outputTokens += completion.outputTokens;
  ledger.estimatedUsd += completion.estimatedUsd;

  const byProvider = (ledger.byProvider ??= {});
  const slice = (byProvider[provider] ??= { inputTokens: 0, outputTokens: 0, estimatedUsd: 0 });
  slice.inputTokens += completion.inputTokens;
  slice.outputTokens += completion.outputTokens;
  slice.estimatedUsd += completion.estimatedUsd;
}

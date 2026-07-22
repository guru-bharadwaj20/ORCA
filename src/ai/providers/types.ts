import type { CostLedger } from '../../core/context.js';
import type { ProviderName } from '../../config/settings.js';

export type { ProviderName } from '../../config/settings.js';

export interface CompletionOptions {
  system?: string;
  maxTokens?: number;
  model?: string;
  signal?: AbortSignal;
}

export interface ProviderCompletion {
  text: string;
  inputTokens: number;
  outputTokens: number;
  estimatedUsd: number;
}

export interface AIProvider {
  readonly name: ProviderName;
  complete(prompt: string, options?: CompletionOptions): Promise<ProviderCompletion>;
}

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

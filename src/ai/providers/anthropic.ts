import Anthropic from '@anthropic-ai/sdk';

import { ENV_KEYS, envKeyResolver, loadSettings, type KeyResolver } from '../../config/settings.js';
import { OrcaError } from '../../utils/errors.js';
import type { AIProvider, CompletionOptions, ProviderCompletion } from './types.js';

const MODEL_PRICING: Record<string, { inputPerMTok: number; outputPerMTok: number }> = {
  'claude-opus-4-8': { inputPerMTok: 5, outputPerMTok: 25 },
  'claude-sonnet-5': { inputPerMTok: 3, outputPerMTok: 15 },
  'claude-haiku-4-5': { inputPerMTok: 1, outputPerMTok: 5 },
};
const FALLBACK_PRICING = MODEL_PRICING['claude-opus-4-8']!;

export function estimateUsd(model: string, inputTokens: number, outputTokens: number): number {
  const pricing = MODEL_PRICING[model] ?? FALLBACK_PRICING;
  return (
    (inputTokens / 1_000_000) * pricing.inputPerMTok +
    (outputTokens / 1_000_000) * pricing.outputPerMTok
  );
}

export function createAnthropicClient(resolveKey: KeyResolver = envKeyResolver): Anthropic {
  const apiKey = resolveKey(ENV_KEYS.apiKey);
  if (!apiKey) {
    throw new OrcaError(
      `${ENV_KEYS.apiKey} is not set. ORCA is BYOK — export your Anthropic API key first.`,
      'MISSING_API_KEY'
    );
  }
  return new Anthropic({
    apiKey,
    timeout: loadSettings().llmTimeoutMs,
  });
}

export class AnthropicProvider implements AIProvider {
  readonly name = 'anthropic' as const;

  constructor(private readonly resolveKey: KeyResolver = envKeyResolver) {}

  async complete(prompt: string, options: CompletionOptions = {}): Promise<ProviderCompletion> {
    const client = createAnthropicClient(this.resolveKey);
    const settings = loadSettings();
    const model = options.model ?? settings.model;
    const response = await client.messages.create(
      {
        model,
        max_tokens: options.maxTokens ?? settings.maxOutputTokens,
        ...(options.system !== undefined ? { system: options.system } : {}),
        messages: [{ role: 'user', content: prompt }],
      },
      options.signal ? { signal: options.signal } : {}
    );

    const text = response.content
      .filter((block) => block.type === 'text')
      .map((block) => (block as { text: string }).text)
      .join('');

    const inputTokens = response.usage.input_tokens;
    const outputTokens = response.usage.output_tokens;
    return {
      text,
      inputTokens,
      outputTokens,
      estimatedUsd: estimateUsd(model, inputTokens, outputTokens),
    };
  }
}

import Anthropic from '@anthropic-ai/sdk';

import { ENV_KEYS, envKeyResolver, loadSettings, type KeyResolver } from '../../config/settings.js';
import { OrcaError } from '../../utils/errors.js';
import type { AIProvider, CompletionOptions, ProviderCompletion } from './types.js';

/**
 * Published per-million-token rates, by model id. Anything a user can select with
 * `--model` / `ORCA_MODEL` belongs here — see `FALLBACK_PRICING` for why.
 */
const MODEL_PRICING: Record<string, { inputPerMTok: number; outputPerMTok: number }> = {
  'claude-fable-5': { inputPerMTok: 10, outputPerMTok: 50 },
  'claude-mythos-5': { inputPerMTok: 10, outputPerMTok: 50 },
  'claude-opus-5': { inputPerMTok: 5, outputPerMTok: 25 },
  'claude-opus-4-8': { inputPerMTok: 5, outputPerMTok: 25 },
  'claude-opus-4-7': { inputPerMTok: 5, outputPerMTok: 25 },
  'claude-opus-4-6': { inputPerMTok: 5, outputPerMTok: 25 },
  'claude-sonnet-5': { inputPerMTok: 3, outputPerMTok: 15 },
  'claude-sonnet-4-6': { inputPerMTok: 3, outputPerMTok: 15 },
  'claude-haiku-4-5': { inputPerMTok: 1, outputPerMTok: 5 },
};

/**
 * What an UNKNOWN model costs — the most expensive rate we know of, not a mid-tier guess.
 *
 * THIS ESTIMATE IS A SAFETY CONTROL, not a display value: `estimateUsd` feeds the ledger
 * that enforces `--cost-cap` (`router.ts`), so an estimate that is too LOW lets a run
 * overspend its ceiling, while one that is too high only trips the cap early. The two
 * errors are not symmetric, so an unrecognized model must be assumed expensive.
 *
 * This was previously the Opus rate, which under-counted every model above that tier:
 * `--model claude-fable-5 --cost-cap 1.00` bills at $10/$50 and was estimated at $5/$25,
 * so the run could spend $2.00 against a $1.00 cap before the ledger noticed. Pricing
 * moves and new models ship between ORCA releases, so a fallback is always reachable —
 * it just must not be a cheap one.
 */
const FALLBACK_PRICING = { inputPerMTok: 10, outputPerMTok: 50 };

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

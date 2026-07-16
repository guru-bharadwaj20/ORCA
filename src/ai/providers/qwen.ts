/**
 * Qwen provider — the primary backend, targeting Qwen3-Coder over the OpenAI-compatible
 * chat-completions protocol that every common Qwen host speaks (Alibaba DashScope,
 * vLLM, Ollama, OpenRouter). Uses Node's built-in fetch: no extra dependency.
 * BYOK: the key comes from QWEN_API_KEY; the endpoint from QWEN_BASE_URL.
 *
 * STAGE: 3 (ai) — REAL code.
 * Inputs: a prompt + completion options.
 * Outputs: a `ProviderCompletion` (text + usage + cost estimate).
 */

import { DEFAULT_SETTINGS, ENV_KEYS } from '../../config/settings.js';
import { OrcaError } from '../../utils/errors.js';
import type { AIProvider, CompletionOptions, ProviderCompletion } from './types.js';

/**
 * Rough USD per 1M tokens for the ledger. Qwen3-Coder pricing is tiered by input
 * length on DashScope; this uses the base tier so small template-fill calls are
 * estimated accurately and the cap still errs on the safe side overall.
 */
const PRICING = { inputPerMTok: 1, outputPerMTok: 5 };

/** Estimated USD cost of a single call's token usage on Qwen. */
export function estimateQwenUsd(inputTokens: number, outputTokens: number): number {
  return (
    (inputTokens / 1_000_000) * PRICING.inputPerMTok +
    (outputTokens / 1_000_000) * PRICING.outputPerMTok
  );
}

/** The subset of an OpenAI-compatible chat-completions response ORCA reads. */
interface ChatCompletionResponse {
  choices?: { message?: { content?: string | null } }[];
  usage?: { prompt_tokens?: number; completion_tokens?: number };
}

export class QwenProvider implements AIProvider {
  readonly name = 'qwen' as const;

  async complete(prompt: string, options: CompletionOptions = {}): Promise<ProviderCompletion> {
    const apiKey = process.env[ENV_KEYS.qwenApiKey];
    if (!apiKey) {
      throw new OrcaError(
        `${ENV_KEYS.qwenApiKey} is not set. ORCA is BYOK — export your Qwen/DashScope API key first.`,
        'MISSING_API_KEY'
      );
    }
    const baseUrl = (process.env[ENV_KEYS.qwenBaseUrl] ?? DEFAULT_SETTINGS.qwenBaseUrl).replace(
      /\/$/,
      ''
    );
    const model = options.model ?? process.env[ENV_KEYS.qwenModel] ?? DEFAULT_SETTINGS.qwenModel;

    const messages: { role: 'system' | 'user'; content: string }[] = [];
    if (options.system !== undefined) messages.push({ role: 'system', content: options.system });
    messages.push({ role: 'user', content: prompt });

    const response = await fetch(`${baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model,
        max_tokens: options.maxTokens ?? DEFAULT_SETTINGS.maxOutputTokens,
        messages,
      }),
      signal: AbortSignal.timeout(DEFAULT_SETTINGS.llmTimeoutMs),
    });

    if (!response.ok) {
      const body = await response.text().catch(() => '');
      throw new OrcaError(
        `Qwen request failed: HTTP ${response.status} ${body.slice(0, 300)}`,
        'AI_PROVIDER_HTTP'
      );
    }

    const data = (await response.json()) as ChatCompletionResponse;
    const text = data.choices?.[0]?.message?.content;
    if (typeof text !== 'string' || text === '') {
      throw new OrcaError('Qwen response contained no message content.', 'AI_PROVIDER_EMPTY');
    }

    const inputTokens = data.usage?.prompt_tokens ?? 0;
    const outputTokens = data.usage?.completion_tokens ?? 0;
    return {
      text,
      inputTokens,
      outputTokens,
      estimatedUsd: estimateQwenUsd(inputTokens, outputTokens),
    };
  }
}

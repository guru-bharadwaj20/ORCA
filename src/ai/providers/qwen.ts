import { ENV_KEYS, envKeyResolver, loadSettings, type KeyResolver } from '../../config/settings.js';
import { OrcaError } from '../../utils/errors.js';
import type { AIProvider, CompletionOptions, ProviderCompletion } from './types.js';

const PRICING = { inputPerMTok: 1, outputPerMTok: 5 };

function estimateQwenUsd(inputTokens: number, outputTokens: number): number {
  return (
    (inputTokens / 1_000_000) * PRICING.inputPerMTok +
    (outputTokens / 1_000_000) * PRICING.outputPerMTok
  );
}

interface ChatCompletionResponse {
  choices?: { message?: { content?: string | null } }[];
  usage?: { prompt_tokens?: number; completion_tokens?: number };
}

export class QwenProvider implements AIProvider {
  readonly name = 'qwen' as const;

  constructor(private readonly resolveKey: KeyResolver = envKeyResolver) {}

  async complete(prompt: string, options: CompletionOptions = {}): Promise<ProviderCompletion> {
    const apiKey = this.resolveKey(ENV_KEYS.qwenApiKey);
    if (!apiKey) {
      throw new OrcaError(
        `${ENV_KEYS.qwenApiKey} is not set. ORCA is BYOK — export your Qwen/DashScope API key first.`,
        'MISSING_API_KEY'
      );
    }
    const settings = loadSettings();
    const baseUrl = settings.qwenBaseUrl;
    const model = options.model ?? settings.qwenModel;

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
        max_tokens: options.maxTokens ?? settings.maxOutputTokens,
        messages,
      }),
      signal: options.signal
        ? AbortSignal.any([AbortSignal.timeout(settings.llmTimeoutMs), options.signal])
        : AbortSignal.timeout(settings.llmTimeoutMs),
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

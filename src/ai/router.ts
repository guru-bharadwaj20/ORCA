import type { z } from 'zod';

import {
  envKeyResolver,
  loadSettings,
  type KeyResolver,
  type ProviderName,
} from '../config/settings.js';
import type { CostLedger } from '../core/context.js';
import { CostCapExceededError, OrcaError } from '../utils/errors.js';
import { AnthropicProvider } from './providers/anthropic.js';
import { QwenProvider } from './providers/qwen.js';
import { recordUsage, type AIProvider } from './providers/types.js';
import { parseModelJson, validateAgainst } from './schema.js';

export interface RouterPrompt {
  system: string;
  user: string;
}

export interface RouterCallOptions {
  maxTokens?: number;
  schemaName?: string;
}

export interface RouterConfig {
  primary: ProviderName;
  fallback: ProviderName | null;
  maxPrimaryAttempts: number;
  minConfidence: number;
  costCapUsd: number;
  modelOverrides?: Partial<Record<ProviderName, string>>;
  signal?: AbortSignal;
}

const NON_RETRYABLE_CODES = new Set(['MISSING_API_KEY']);

export function resolveRouterConfig(env: NodeJS.ProcessEnv = process.env): RouterConfig {
  const settings = loadSettings(env);
  return {
    primary: settings.primaryProvider,
    fallback: settings.fallbackProvider,
    maxPrimaryAttempts: settings.maxPrimaryAttempts,
    minConfidence: settings.minConfidence,
    costCapUsd: settings.costCapUsd,
  };
}

export function modelProviderFor(model: string): ProviderName | null {
  if (model.startsWith('claude')) return 'anthropic';
  if (model.startsWith('qwen')) return 'qwen';
  return null;
}

export function unroutableModelWarning(model: string | undefined): string | null {
  if (model === undefined || model === '' || modelProviderFor(model) !== null) return null;
  return (
    `Ignoring --model '${model}': ORCA routes 'claude*' to Anthropic and 'qwen*' to Qwen, ` +
    `and will not send an unrecognised id to either API. The run continues on the ` +
    `configured provider defaults.`
  );
}

export function routerConfigForRun(
  overrides: { costCapUsd?: number; model?: string; signal?: AbortSignal },
  env: NodeJS.ProcessEnv = process.env
): RouterConfig {
  const config = resolveRouterConfig(env);
  if (overrides.costCapUsd !== undefined && Number.isFinite(overrides.costCapUsd)) {
    config.costCapUsd = Math.max(0, overrides.costCapUsd);
  }
  if (overrides.model !== undefined && overrides.model !== '') {
    const provider = modelProviderFor(overrides.model);
    if (provider !== null) config.modelOverrides = { [provider]: overrides.model };
  }
  if (overrides.signal !== undefined) config.signal = overrides.signal;
  return config;
}

export type ProviderFactories = Record<ProviderName, () => AIProvider>;

export function defaultProviderFactories(
  resolveKey: KeyResolver = envKeyResolver
): ProviderFactories {
  return {
    qwen: () => new QwenProvider(resolveKey),
    anthropic: () => new AnthropicProvider(resolveKey),
  };
}

export class AIRouter {
  constructor(
    private readonly config: RouterConfig = resolveRouterConfig(),
    private readonly factories: ProviderFactories = defaultProviderFactories()
  ) {}

  async completeValidated<Output, Input = Output>(
    prompt: RouterPrompt,
    schema: z.ZodType<Output, z.ZodTypeDef, Input>,
    ledger: CostLedger,
    options: RouterCallOptions = {}
  ): Promise<Output> {
    const plan: { provider: ProviderName; attempts: number }[] = [
      { provider: this.config.primary, attempts: this.config.maxPrimaryAttempts },
    ];
    if (this.config.fallback !== null && this.config.fallback !== this.config.primary) {
      plan.push({ provider: this.config.fallback, attempts: 1 });
    }

    let lastError: unknown;
    for (const step of plan) {
      for (let attempt = 1; attempt <= step.attempts; attempt++) {
        this.enforceCostCap(ledger, options.schemaName);

        let completion;
        try {
          const provider = this.factories[step.provider]();
          const model = this.config.modelOverrides?.[step.provider];
          completion = await provider.complete(prompt.user, {
            system: prompt.system,
            ...(options.maxTokens !== undefined ? { maxTokens: options.maxTokens } : {}),
            ...(model !== undefined ? { model } : {}),
            ...(this.config.signal !== undefined ? { signal: this.config.signal } : {}),
          });
        } catch (err) {
          lastError = err;
          if (err instanceof OrcaError && NON_RETRYABLE_CODES.has(err.code)) break;
          continue;
        }

        recordUsage(ledger, step.provider, completion);

        try {
          const parsed = parseModelJson(completion.text);
          this.assertConfident(parsed, step.provider);
          return validateAgainst(schema, parsed);
        } catch (err) {
          lastError = err;
        }
      }
    }

    throw (
      lastError ??
      new OrcaError(
        `No AI provider produced a valid response${options.schemaName ? ` for ${options.schemaName}` : ''}.`,
        'AI_PROVIDER_FAILED'
      )
    );
  }

  private enforceCostCap(ledger: CostLedger, schemaName?: string): void {
    if (ledger.estimatedUsd >= this.config.costCapUsd) {
      throw new CostCapExceededError(
        `LLM cost cap reached ($${ledger.estimatedUsd.toFixed(4)} of ` +
          `$${this.config.costCapUsd.toFixed(2)}); refusing further calls` +
          `${schemaName ? ` (wanted: ${schemaName})` : ''}.`
      );
    }
  }

  private assertConfident(parsed: unknown, provider: ProviderName): void {
    if (parsed === null || typeof parsed !== 'object') return;
    const confidence = (parsed as Record<string, unknown>)['confidence'];
    if (typeof confidence === 'number' && confidence < this.config.minConfidence) {
      throw new OrcaError(
        `${provider} reported low confidence (${confidence} < ${this.config.minConfidence}).`,
        'AI_LOW_CONFIDENCE'
      );
    }
  }
}

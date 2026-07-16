/**
 * Provider router for the AI layer: tries the primary provider (Qwen), validates the
 * response, retries, and escalates to the fallback provider (Claude) when the primary
 * throws, returns invalid JSON, fails schema validation, exceeds its retry budget, or
 * explicitly reports low confidence. The rest of the pipeline never learns which
 * provider produced a result.
 *
 * STAGE: 3 (ai) — REAL code.
 * Inputs: a {system, user} prompt + a zod schema + the run's cost ledger.
 * Outputs: a schema-validated object (or the last underlying error).
 */

import type { z } from 'zod';

import { DEFAULT_SETTINGS, ENV_KEYS, type ProviderName } from '../config/settings.js';
import type { CostLedger } from '../core/context.js';
import { CostCapExceededError, OrcaError } from '../utils/errors.js';
import { AnthropicProvider } from './providers/anthropic.js';
import { QwenProvider } from './providers/qwen.js';
import { recordUsage, type AIProvider } from './providers/types.js';
import { parseModelJson, validateAgainst } from './schema.js';

/** A system+user prompt (structurally identical to the prompt builders' PromptPair). */
export interface RouterPrompt {
  system: string;
  user: string;
}

/** Per-call options passed through to the winning provider. */
export interface RouterCallOptions {
  maxTokens?: number;
  /** Task label used in error messages/logs (e.g. 'FilledTemplateVars'). */
  schemaName?: string;
}

/** How the router picks and escalates providers. */
export interface RouterConfig {
  primary: ProviderName;
  fallback: ProviderName | null;
  /** Attempts on the primary before escalating (>=1). */
  maxPrimaryAttempts: number;
  /** A model-reported top-level `confidence` below this escalates. */
  minConfidence: number;
  /** Hard cap on total LLM spend for the run, in USD (all providers combined). */
  costCapUsd: number;
}

/** Error codes that no amount of retrying the same provider will fix. */
const NON_RETRYABLE_CODES = new Set(['MISSING_API_KEY']);

/** Resolve the router config from env overrides on top of the defaults. */
export function resolveRouterConfig(env: NodeJS.ProcessEnv = process.env): RouterConfig {
  const asProvider = (value: string | undefined): ProviderName | undefined =>
    value === 'qwen' || value === 'anthropic' ? value : undefined;

  const fallbackRaw = env[ENV_KEYS.fallbackProvider];
  const attempts = Number(env[ENV_KEYS.maxPrimaryAttempts]);
  const costCap = Number(env[ENV_KEYS.costCap]);

  return {
    primary: asProvider(env[ENV_KEYS.primaryProvider]) ?? DEFAULT_SETTINGS.primaryProvider,
    fallback:
      fallbackRaw === 'none'
        ? null
        : (asProvider(fallbackRaw) ?? DEFAULT_SETTINGS.fallbackProvider),
    maxPrimaryAttempts:
      Number.isInteger(attempts) && attempts >= 1 ? attempts : DEFAULT_SETTINGS.maxPrimaryAttempts,
    minConfidence: DEFAULT_SETTINGS.minConfidence,
    costCapUsd: Number.isFinite(costCap) && costCap > 0 ? costCap : DEFAULT_SETTINGS.costCapUsd,
  };
}

/** Default provider constructors; tests may inject fakes. */
export type ProviderFactories = Record<ProviderName, () => AIProvider>;
const DEFAULT_FACTORIES: ProviderFactories = {
  qwen: () => new QwenProvider(),
  anthropic: () => new AnthropicProvider(),
};

export class AIRouter {
  constructor(
    private readonly config: RouterConfig = resolveRouterConfig(),
    private readonly factories: ProviderFactories = DEFAULT_FACTORIES
  ) {}

  /**
   * Run one AI task end-to-end: primary provider (with retries) → fallback provider,
   * validating every response before it is trusted. Returns the first response that
   * passes the schema; rethrows the last underlying error when everything failed.
   * The cost cap is global across providers and is checked before every attempt.
   */
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
          completion = await provider.complete(prompt.user, {
            system: prompt.system,
            ...(options.maxTokens !== undefined ? { maxTokens: options.maxTokens } : {}),
          });
        } catch (err) {
          lastError = err;
          // Config problems (missing key) won't improve on retry — move on now.
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

  /** Throw before any call once the run's total spend has reached the cap. */
  private enforceCostCap(ledger: CostLedger, schemaName?: string): void {
    if (ledger.estimatedUsd >= this.config.costCapUsd) {
      throw new CostCapExceededError(
        `LLM cost cap reached ($${ledger.estimatedUsd.toFixed(4)} of ` +
          `$${this.config.costCapUsd.toFixed(2)}); refusing further calls` +
          `${schemaName ? ` (wanted: ${schemaName})` : ''}.`
      );
    }
  }

  /**
   * Escalation hook for self-reported uncertainty: if the parsed JSON carries a
   * top-level numeric `confidence` below the threshold, treat the attempt as failed.
   * Schemas ignore unknown keys, so a confident response validates unchanged.
   */
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

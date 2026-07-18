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
  /** Per-provider model id overrides (e.g. from `--model`); others keep defaults. */
  modelOverrides?: Partial<Record<ProviderName, string>>;
  /** Cancels in-flight provider calls when the run is aborted. */
  signal?: AbortSignal;
}

/** Error codes that no amount of retrying the same provider will fix. */
const NON_RETRYABLE_CODES = new Set(['MISSING_API_KEY']);

/** Resolve the router config from env overrides on top of the defaults (loadSettings). */
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

/**
 * Router config for one run: env-resolved config with the run's options applied on
 * top (CLI flags already folded env values in, so they win here by design).
 * `model` is provider-aware — the id's family decides which provider it overrides;
 * ids outside both families are ignored so a typo can't silently hit the wrong API.
 */
export function routerConfigForRun(
  overrides: { costCapUsd?: number; model?: string; signal?: AbortSignal },
  env: NodeJS.ProcessEnv = process.env
): RouterConfig {
  const config = resolveRouterConfig(env);
  if (overrides.costCapUsd !== undefined && overrides.costCapUsd > 0) {
    config.costCapUsd = overrides.costCapUsd;
  }
  if (overrides.model !== undefined && overrides.model !== '') {
    if (overrides.model.startsWith('claude'))
      config.modelOverrides = { anthropic: overrides.model };
    else if (overrides.model.startsWith('qwen')) config.modelOverrides = { qwen: overrides.model };
  }
  if (overrides.signal !== undefined) config.signal = overrides.signal;
  return config;
}

/** Default provider constructors; tests may inject fakes. */
export type ProviderFactories = Record<ProviderName, () => AIProvider>;

/**
 * Build the default factories bound to a key resolver. The CLI uses the env resolver;
 * an embedder passes one backed by its own secret store so keys never touch env.
 */
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
          const model = this.config.modelOverrides?.[step.provider];
          completion = await provider.complete(prompt.user, {
            system: prompt.system,
            ...(options.maxTokens !== undefined ? { maxTokens: options.maxTokens } : {}),
            ...(model !== undefined ? { model } : {}),
            ...(this.config.signal !== undefined ? { signal: this.config.signal } : {}),
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

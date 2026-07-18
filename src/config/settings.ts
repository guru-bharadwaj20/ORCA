/**
 * Central, real configuration constants for ORCA: default model, retry cap, cost caps,
 * and timeouts. Values may be overridden by environment variables at load time.
 *
 * STAGE: config (shared) — REAL code.
 * Inputs: environment variables (optional overrides).
 * Outputs: a frozen `Settings` object other stages read from.
 *
 * `loadSettings()` is the single place env overrides are parsed and validated —
 * providers and the router derive their configuration from it. Invalid values fall
 * back to the defaults (a bad env var should degrade, not crash a run).
 */

/** AI providers ORCA can route completions to. */
export type ProviderName = 'qwen' | 'anthropic';

/**
 * How the AI layer looks up a BYOK secret by env-var name. The CLI resolves against
 * `process.env`; an embedder (the VS Code extension) can inject a resolver backed by
 * `vscode.SecretStorage` instead of mutating the shared host's `process.env`.
 */
export type KeyResolver = (name: string) => string | undefined;

/** The default resolver: read the secret straight from `process.env` (CLI use). */
export const envKeyResolver: KeyResolver = (name) => process.env[name];

/** ORCA-wide tunables. */
export interface Settings {
  /** Anthropic model id used when the anthropic provider handles a call. */
  model: string;
  /** Qwen model id used when the qwen provider handles a call. */
  qwenModel: string;
  /** OpenAI-compatible base URL the qwen provider posts to (DashScope, vLLM, Ollama...). */
  qwenBaseUrl: string;
  /** Provider tried first for every AI task. */
  primaryProvider: ProviderName;
  /** Provider escalated to when the primary keeps failing; null disables fallback. */
  fallbackProvider: ProviderName | null;
  /** Attempts on the primary provider before escalating to the fallback. */
  maxPrimaryAttempts: number;
  /** A model-reported `confidence` below this triggers escalation. */
  minConfidence: number;
  /** Max self-heal attempts before giving up. */
  maxHealAttempts: number;
  /** Hard cap on total LLM spend per run, in USD. */
  costCapUsd: number;
  /** Timeout for a single docker build/up command, in ms. */
  dockerTimeoutMs: number;
  /** Timeout for a single LLM call, in ms. */
  llmTimeoutMs: number;
  /** Max tokens per LLM completion. */
  maxOutputTokens: number;
}

/** Real, hand-picked defaults used when env overrides are absent. */
export const DEFAULT_SETTINGS: Settings = {
  model: 'claude-opus-4-8',
  qwenModel: 'qwen3-coder-plus',
  qwenBaseUrl: 'https://dashscope-intl.aliyuncs.com/compatible-mode/v1',
  primaryProvider: 'qwen',
  fallbackProvider: 'anthropic',
  maxPrimaryAttempts: 2,
  minConfidence: 0.5,
  maxHealAttempts: 3,
  costCapUsd: 1.0,
  dockerTimeoutMs: 10 * 60 * 1000,
  llmTimeoutMs: 60 * 1000,
  maxOutputTokens: 4096,
};

/** Environment variable names ORCA reads overrides from. */
export const ENV_KEYS = {
  apiKey: 'ANTHROPIC_API_KEY',
  qwenApiKey: 'QWEN_API_KEY',
  qwenBaseUrl: 'QWEN_BASE_URL',
  qwenModel: 'ORCA_QWEN_MODEL',
  model: 'ORCA_MODEL',
  primaryProvider: 'ORCA_PRIMARY_PROVIDER',
  fallbackProvider: 'ORCA_FALLBACK_PROVIDER',
  maxPrimaryAttempts: 'ORCA_MAX_PRIMARY_ATTEMPTS',
  costCap: 'ORCA_COST_CAP_USD',
  maxHealAttempts: 'ORCA_MAX_HEAL_ATTEMPTS',
} as const;

/** A validated provider name, or undefined when the value is absent/unknown. */
function asProvider(value: string | undefined): ProviderName | undefined {
  return value === 'qwen' || value === 'anthropic' ? value : undefined;
}

/** A strictly positive integer, or undefined when absent/invalid. */
function asPositiveInt(value: string | undefined): number | undefined {
  const parsed = Number(value);
  return value !== undefined && Number.isInteger(parsed) && parsed >= 1 ? parsed : undefined;
}

/** A strictly positive finite number, or undefined when absent/invalid. */
function asPositiveNumber(value: string | undefined): number | undefined {
  const parsed = Number(value);
  return value !== undefined && Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
}

/**
 * Read ENV_KEYS overrides on top of DEFAULT_SETTINGS. Invalid values fall back to
 * the default rather than crashing; `ORCA_FALLBACK_PROVIDER=none` disables fallback.
 */
export function loadSettings(env: NodeJS.ProcessEnv = process.env): Settings {
  const fallbackRaw = env[ENV_KEYS.fallbackProvider];
  return Object.freeze({
    ...DEFAULT_SETTINGS,
    model: env[ENV_KEYS.model] || DEFAULT_SETTINGS.model,
    qwenModel: env[ENV_KEYS.qwenModel] || DEFAULT_SETTINGS.qwenModel,
    qwenBaseUrl: (env[ENV_KEYS.qwenBaseUrl] || DEFAULT_SETTINGS.qwenBaseUrl).replace(/\/$/, ''),
    primaryProvider: asProvider(env[ENV_KEYS.primaryProvider]) ?? DEFAULT_SETTINGS.primaryProvider,
    fallbackProvider:
      fallbackRaw === 'none'
        ? null
        : (asProvider(fallbackRaw) ?? DEFAULT_SETTINGS.fallbackProvider),
    maxPrimaryAttempts:
      asPositiveInt(env[ENV_KEYS.maxPrimaryAttempts]) ?? DEFAULT_SETTINGS.maxPrimaryAttempts,
    costCapUsd: asPositiveNumber(env[ENV_KEYS.costCap]) ?? DEFAULT_SETTINGS.costCapUsd,
    maxHealAttempts:
      asPositiveInt(env[ENV_KEYS.maxHealAttempts]) ?? DEFAULT_SETTINGS.maxHealAttempts,
  });
}

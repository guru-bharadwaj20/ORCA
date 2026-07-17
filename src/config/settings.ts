/**
 * Central, real configuration constants for ORCA: default model, retry cap, cost caps,
 * and timeouts. Values may be overridden by environment variables at load time.
 *
 * STAGE: config (shared)
 * Inputs: environment variables (optional overrides).
 * Outputs: a frozen `Settings` object other stages read from.
 *
 * NOTE: The default values here are REAL; `loadSettings()` (env parsing) is a stub.
 */

/** AI providers ORCA can route completions to. */
export type ProviderName = 'qwen' | 'anthropic';

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

// TODO(stage-7): read ENV_KEYS overrides on top of DEFAULT_SETTINGS and validate them.
export function loadSettings(_env: NodeJS.ProcessEnv): Settings {
  throw new Error('not implemented');
}

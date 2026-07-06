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

/** ORCA-wide tunables. */
export interface Settings {
  /** Anthropic model id used for AI stages. */
  model: string;
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
  maxHealAttempts: 3,
  costCapUsd: 1.0,
  dockerTimeoutMs: 10 * 60 * 1000,
  llmTimeoutMs: 60 * 1000,
  maxOutputTokens: 4096,
};

/** Environment variable names ORCA reads overrides from. */
export const ENV_KEYS = {
  apiKey: 'ANTHROPIC_API_KEY',
  model: 'ORCA_MODEL',
  costCap: 'ORCA_COST_CAP_USD',
  maxHealAttempts: 'ORCA_MAX_HEAL_ATTEMPTS',
} as const;

// TODO(stage-7): read ENV_KEYS overrides on top of DEFAULT_SETTINGS and validate them.
export function loadSettings(_env: NodeJS.ProcessEnv): Settings {
  throw new Error('not implemented');
}

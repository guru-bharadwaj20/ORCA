export type ProviderName = 'qwen' | 'anthropic';

export type KeyResolver = (name: string) => string | undefined;

export const envKeyResolver: KeyResolver = (name) => process.env[name];

export interface Settings {
  model: string;
  qwenModel: string;
  qwenBaseUrl: string;
  primaryProvider: ProviderName;
  fallbackProvider: ProviderName | null;
  maxPrimaryAttempts: number;
  minConfidence: number;
  maxHealAttempts: number;
  costCapUsd: number;
  dockerTimeoutMs: number;
  llmTimeoutMs: number;
  maxOutputTokens: number;
}

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
  minConfidence: 'ORCA_MIN_CONFIDENCE',
  dockerTimeoutMs: 'ORCA_DOCKER_TIMEOUT_MS',
  llmTimeoutMs: 'ORCA_LLM_TIMEOUT_MS',
  maxOutputTokens: 'ORCA_MAX_OUTPUT_TOKENS',
} as const;

function asProvider(value: string | undefined): ProviderName | undefined {
  return value === 'qwen' || value === 'anthropic' ? value : undefined;
}

function asPositiveInt(value: string | undefined): number | undefined {
  const parsed = Number(value);
  return value !== undefined && Number.isInteger(parsed) && parsed >= 1 ? parsed : undefined;
}

function asNonNegativeNumber(value: string | undefined): number | undefined {
  const parsed = Number(value);
  return value !== undefined && value !== '' && Number.isFinite(parsed) && parsed >= 0
    ? parsed
    : undefined;
}

function asFraction(value: string | undefined): number | undefined {
  const parsed = asNonNegativeNumber(value);
  return parsed !== undefined && parsed <= 1 ? parsed : undefined;
}

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
    costCapUsd: asNonNegativeNumber(env[ENV_KEYS.costCap]) ?? DEFAULT_SETTINGS.costCapUsd,
    maxHealAttempts:
      asPositiveInt(env[ENV_KEYS.maxHealAttempts]) ?? DEFAULT_SETTINGS.maxHealAttempts,
    minConfidence: asFraction(env[ENV_KEYS.minConfidence]) ?? DEFAULT_SETTINGS.minConfidence,
    dockerTimeoutMs:
      asPositiveInt(env[ENV_KEYS.dockerTimeoutMs]) ?? DEFAULT_SETTINGS.dockerTimeoutMs,
    llmTimeoutMs: asPositiveInt(env[ENV_KEYS.llmTimeoutMs]) ?? DEFAULT_SETTINGS.llmTimeoutMs,
    maxOutputTokens:
      asPositiveInt(env[ENV_KEYS.maxOutputTokens]) ?? DEFAULT_SETTINGS.maxOutputTokens,
  });
}

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
  /**
   * Tier-4 dynamic probing (Phase G). OFF BY DEFAULT and deliberately so — this is the
   * one feature that executes repo code, and clause 2 of the prober security contract
   * requires an explicit opt-in. With this false, `runProbers` returns before a container
   * can be created and ORCA behaves exactly as it does with no tier 4 at all.
   */
  enableProbing: boolean;
  /** Wall-clock cap on each docker call a probe makes. */
  probeTimeoutMs: number;
  /** How long to let a probed container settle before reading its state. */
  probeSettleMs: number;
  /** Memory cap for a probe container (also its swap cap — see `isolationArgs`). */
  probeMemory: string;
  /** CPU cap for a probe container. */
  probeCpus: number;
  /** Process cap for a probe container — the fork-bomb guard. */
  probePidsLimit: number;
  /**
   * Docker network for a probe container. `none` by default and that is the point of the
   * setting existing rather than the value being hardcoded: an app that cannot resolve
   * its database dies before it binds anything, so a user debugging why a probe saw
   * nothing has a supported way to widen this for one run instead of editing the
   * isolation boundary. Anything other than `none` weakens contract clause 1 — it is an
   * informed choice, not a default.
   */
  probeNetwork: string;
  /**
   * Whether the probe container gets a read-only root filesystem. True by default. Many
   * real images write a cache or a pid file at startup and exit immediately without this
   * relaxed, which reads as "the app binds no ports" when the truth is "the app never
   * started".
   */
  probeReadOnlyRootfs: boolean;
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
  enableProbing: false,
  probeTimeoutMs: 60 * 1000,
  probeSettleMs: 3000,
  probeMemory: '512m',
  probeCpus: 1,
  probePidsLimit: 256,
  probeNetwork: 'none',
  probeReadOnlyRootfs: true,
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
  enableProbing: 'ORCA_ENABLE_PROBING',
  probeTimeoutMs: 'ORCA_PROBE_TIMEOUT_MS',
  probeSettleMs: 'ORCA_PROBE_SETTLE_MS',
  probeMemory: 'ORCA_PROBE_MEMORY',
  probeCpus: 'ORCA_PROBE_CPUS',
  probePidsLimit: 'ORCA_PROBE_PIDS_LIMIT',
  probeNetwork: 'ORCA_PROBE_NETWORK',
  probeReadOnlyRootfs: 'ORCA_PROBE_READONLY',
} as const;

/**
 * Only an explicit, affirmative value turns probing on. Anything else — unset, empty,
 * `0`, `false`, or a typo — leaves it off, because this is the flag that decides whether
 * repo code executes at all and a permissive parse would be the wrong kind of forgiving.
 */
function asOptIn(value: string | undefined): boolean {
  return value === '1' || value?.toLowerCase() === 'true';
}

/** The mirror of `asOptIn`: only an explicit negative turns a default-on setting off. */
function asOptOut(value: string | undefined): boolean {
  return value === '0' || value?.toLowerCase() === 'false';
}

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
    enableProbing: asOptIn(env[ENV_KEYS.enableProbing]),
    probeTimeoutMs: asPositiveInt(env[ENV_KEYS.probeTimeoutMs]) ?? DEFAULT_SETTINGS.probeTimeoutMs,
    probeSettleMs: asPositiveInt(env[ENV_KEYS.probeSettleMs]) ?? DEFAULT_SETTINGS.probeSettleMs,
    probeMemory: env[ENV_KEYS.probeMemory] || DEFAULT_SETTINGS.probeMemory,
    probeCpus: asPositiveInt(env[ENV_KEYS.probeCpus]) ?? DEFAULT_SETTINGS.probeCpus,
    probePidsLimit: asPositiveInt(env[ENV_KEYS.probePidsLimit]) ?? DEFAULT_SETTINGS.probePidsLimit,
    probeNetwork: env[ENV_KEYS.probeNetwork] || DEFAULT_SETTINGS.probeNetwork,
    // Only an explicit opt-OUT relaxes the root filesystem, mirroring how the probing
    // flag itself is parsed: a typo must leave the stricter setting in place.
    probeReadOnlyRootfs: !asOptOut(env[ENV_KEYS.probeReadOnlyRootfs]),
  });
}

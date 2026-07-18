/**
 * Shared data contract: the `RunContext` — the mutable state object threaded through
 * every stage of the pipeline. Each stage reads what it needs and writes its output
 * back onto the context, so stages stay decoupled and independently testable.
 *
 * STAGE: core (spans all stages)
 * REAL CODE — this is the backbone the whole pipeline shares.
 *
 * Inputs: the CLI options + repo URL that start a run.
 * Outputs: a context that accumulates detection -> plan -> generated configs ->
 * build/heal diagnosis as the run progresses.
 */

import type { AIFacade } from '../ai/client.js';
import type { FilledTemplateVars, InferredEnv } from '../ai/schema.js';
import { envKeyResolver, type KeyResolver } from '../config/settings.js';
import type { DetectionResult } from '../detect/types.js';
import type { ServicePlan } from '../plan/types.js';

/** Severity levels ORCA logs at. */
export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

/**
 * Minimal structured logger interface the pipeline depends on. The concrete
 * implementation lives in `src/utils/logging.ts`; the context only needs the shape.
 */
export interface Logger {
  debug(message: string, meta?: Record<string, unknown>): void;
  info(message: string, meta?: Record<string, unknown>): void;
  warn(message: string, meta?: Record<string, unknown>): void;
  error(message: string, meta?: Record<string, unknown>): void;
}

/** User-controlled options for a single run, parsed from CLI flags. */
export interface RunOptions {
  /** Generate configs and show the plan, but never build or run containers. */
  dryRun: boolean;
  /** Skip the interactive approval gate (CI / non-interactive use). */
  autoApprove: boolean;
  /** Maximum self-heal attempts before giving up. */
  maxHealAttempts: number;
  /** Hard cap on total LLM spend for the run, in USD. */
  costCapUsd: number;
  /** Anthropic model id to use for AI stages. */
  model: string;
  /** Emit verbose debug logging. */
  verbose: boolean;
  /**
   * Cancels the run when aborted: checked between stages and threaded into the clone,
   * docker, and AI calls so an embedder (e.g. a VS Code cancel button) can stop a run.
   */
  signal?: AbortSignal;
}

/** A file ORCA generated and wrote to disk during the run. */
export interface GeneratedFile {
  /** Path relative to the repo/workspace root. */
  path: string;
  /** What produced it, for the audit trail. */
  kind: 'dockerfile' | 'compose' | 'env' | 'dockerignore' | 'entrypoint';
}

/**
 * One entry in the plain-English self-heal log (headline feature: explainable heal).
 * Appended once per build/heal attempt.
 */
export interface DiagnosisEntry {
  /** 1-based attempt number. */
  attempt: number;
  /** The raw error signature ORCA matched on (truncated build/runtime output). */
  errorSignature: string;
  /** Plain-English explanation of what went wrong. */
  explanation: string;
  /** Plain-English description of the fix ORCA applied. */
  fix: string;
  /** Files ORCA changed to apply the fix. */
  changedFiles: string[];
  /** Whether this attempt ultimately succeeded. */
  resolved: boolean;
  /** ISO timestamp of the attempt. */
  timestamp: string;
}

/** One provider's slice of the run's LLM usage. */
export interface ProviderUsage {
  inputTokens: number;
  outputTokens: number;
  estimatedUsd: number;
}

/** Running tally of LLM usage, checked against `RunOptions.costCapUsd`. */
export interface CostLedger {
  inputTokens: number;
  outputTokens: number;
  estimatedUsd: number;
  /**
   * Per-provider breakdown (keyed by provider name, e.g. 'qwen' / 'anthropic').
   * Created lazily on first use so plain `{inputTokens, outputTokens, estimatedUsd}`
   * literals remain valid ledgers.
   */
  byProvider?: Record<string, ProviderUsage>;
}

/**
 * The full run state. Fields are populated progressively:
 * clone -> `workspaceDir`, detect -> `detection`, plan -> `plan`,
 * generate -> `generatedFiles`, build/heal -> `diagnosis`.
 */
export interface RunContext {
  /** The git URL (or local path) ORCA was asked to containerize. */
  repoUrl: string;
  /** Absolute path to the temp workspace the repo was cloned into. */
  workspaceDir: string;
  /** Parsed CLI options for this run. */
  options: RunOptions;
  /** Structured logger for all stages. */
  logger: Logger;
  /**
   * Run-scoped AI facade honoring this run's options (--model, --cost-cap).
   * Populated by the pipeline; stages fall back to the env-configured default.
   */
  ai?: AIFacade;
  /**
   * Resolves BYOK secrets by env-var name. Defaults to `process.env` (CLI); an
   * embedder injects one backed by its own secret store (VS Code SecretStorage).
   */
  resolveKey: KeyResolver;
  /** STAGE 2 output; undefined until detection has run. */
  detection?: DetectionResult;
  /** STAGE 3 output: validated AI refinements keyed by role ({} when keyless). */
  filled?: Record<string, FilledTemplateVars>;
  /** STAGE 3 output: AI-inferred app env vars (undefined when keyless/failed). */
  inferredEnv?: InferredEnv;
  /** STAGE 4 output; undefined until the plan is built. */
  plan?: ServicePlan;
  /** Whether the user approved the plan at the review gate. */
  approved: boolean;
  /** Files ORCA generated and wrote to disk. */
  generatedFiles: GeneratedFile[];
  /** Append-only, human-readable record of every self-heal attempt. */
  diagnosis: DiagnosisEntry[];
  /** Running LLM cost tally. */
  cost: CostLedger;
  /** When the run started. */
  startedAt: Date;
}

/** Sensible defaults for a run's options; overridden by CLI flags / env. */
export const DEFAULT_RUN_OPTIONS: RunOptions = {
  dryRun: false,
  autoApprove: false,
  maxHealAttempts: 3,
  costCapUsd: 1.0,
  model: 'claude-opus-4-8',
  verbose: false,
};

/**
 * Factory for a fresh `RunContext`. Real (not a stub): it wires up the initial,
 * empty state so downstream stages have a well-formed object to mutate.
 */
export function createRunContext(params: {
  repoUrl: string;
  workspaceDir: string;
  logger: Logger;
  options?: Partial<RunOptions>;
  /** BYOK secret resolver; defaults to `process.env` (CLI). */
  resolveKey?: KeyResolver;
}): RunContext {
  return {
    repoUrl: params.repoUrl,
    workspaceDir: params.workspaceDir,
    options: { ...DEFAULT_RUN_OPTIONS, ...params.options },
    logger: params.logger,
    resolveKey: params.resolveKey ?? envKeyResolver,
    approved: false,
    generatedFiles: [],
    diagnosis: [],
    cost: { inputTokens: 0, outputTokens: 0, estimatedUsd: 0 },
    startedAt: new Date(),
  };
}

import type { AIFacade } from '../ai/client.js';
import type { FilledTemplateVars, InferredEnv } from '../ai/schema.js';
import { envKeyResolver, type KeyResolver } from '../config/settings.js';
import type { DetectionResult } from '../detect/types.js';
import type { ServicePlan } from '../plan/types.js';

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

export interface Logger {
  debug(message: string, meta?: Record<string, unknown>): void;
  info(message: string, meta?: Record<string, unknown>): void;
  warn(message: string, meta?: Record<string, unknown>): void;
  error(message: string, meta?: Record<string, unknown>): void;
}

export interface RunOptions {
  dryRun: boolean;
  autoApprove: boolean;
  maxHealAttempts: number;
  costCapUsd: number;
  model: string;
  verbose: boolean;
  signal?: AbortSignal;
}

export interface GeneratedFile {
  path: string;
  kind: 'dockerfile' | 'compose' | 'env' | 'dockerignore' | 'entrypoint';
}

export interface DiagnosisEntry {
  attempt: number;
  errorSignature: string;
  explanation: string;
  fix: string;
  changedFiles: string[];
  resolved: boolean;
  timestamp: string;
}

export interface ProviderUsage {
  inputTokens: number;
  outputTokens: number;
  estimatedUsd: number;
}

export interface CostLedger {
  inputTokens: number;
  outputTokens: number;
  estimatedUsd: number;
  byProvider?: Record<string, ProviderUsage>;
}

export interface RunContext {
  repoUrl: string;
  workspaceDir: string;
  options: RunOptions;
  logger: Logger;
  ai?: AIFacade;
  resolveKey: KeyResolver;
  detection?: DetectionResult;
  filled?: Record<string, FilledTemplateVars>;
  inferredEnv?: InferredEnv;
  plan?: ServicePlan;
  approved: boolean;
  generatedFiles: GeneratedFile[];
  diagnosis: DiagnosisEntry[];
  cost: CostLedger;
  startedAt: Date;
}

export const DEFAULT_RUN_OPTIONS: RunOptions = {
  dryRun: false,
  autoApprove: false,
  maxHealAttempts: 3,
  costCapUsd: 1.0,
  model: 'claude-opus-4-8',
  verbose: false,
};

export function createRunContext(params: {
  repoUrl: string;
  workspaceDir: string;
  logger: Logger;
  options?: Partial<RunOptions>;
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

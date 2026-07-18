/**
 * The public library surface of orca-cli: what embedders (the VS Code extension,
 * scripts) import as `orca-cli`. Subpath exports: `orca-cli/plan`, `orca-cli/ai`,
 * `orca-cli/config`.
 *
 * STAGE: core — REAL code (re-exports only).
 */

export { runPipeline, type PipelineIO } from './core/pipeline.js';
export {
  createRunContext,
  DEFAULT_RUN_OPTIONS,
  type CostLedger,
  type DiagnosisEntry,
  type GeneratedFile,
  type Logger,
  type LogLevel,
  type ProviderUsage,
  type RunContext,
  type RunOptions,
} from './core/context.js';
export { detectStack, type DetectionResult } from './detect/index.js';
export { OrcaError } from './utils/errors.js';
export { createLogger } from './utils/logging.js';

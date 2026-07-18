/**
 * Barrel for globally-shared types that don't belong to a single stage. Re-exports the
 * canonical data contracts so consumers can import from one place if they prefer.
 *
 * STAGE: shared
 * Inputs: n/a.
 * Outputs: re-exported type definitions.
 *
 * The re-exports below are REAL; add genuinely cross-cutting shared types here as the
 * stages are implemented.
 */

export type {
  DetectionResult,
  DetectedComponent,
  DetectedDatabase,
  DetectedPort,
  Entrypoint,
  Language,
  PackageManager,
  FrontendFramework,
  BackendFramework,
  DatabaseEngine,
} from '../detect/types.js';

export type {
  ServicePlan,
  ServiceNode,
  ServiceKind,
  PortBinding,
  Healthcheck,
} from '../plan/types.js';

export type { RunContext, RunOptions, DiagnosisEntry, Logger, LogLevel } from '../core/context.js';

// TODO(stage-8): add any remaining cross-cutting shared types here.

/**
 * Generates a `.env` file (and per-service env wiring) from the AI-inferred variables,
 * filling in defaults for database URLs/credentials that match the generated services.
 *
 * STAGE: 6 (orchestrate)
 * Inputs: the inferred env variables + the `ServicePlan`.
 * Outputs: the textual `.env` contents to write to disk.
 */

import type { InferredEnv } from '../ai/schema.js';
import type { ServicePlan } from '../plan/types.js';

// TODO(stage-6): merge inferred vars with plan-derived connection strings into .env text.
export function buildEnvFile(_inferred: InferredEnv, _plan: ServicePlan): string {
  throw new Error('not implemented');
}

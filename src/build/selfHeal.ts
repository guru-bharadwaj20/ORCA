/**
 * The self-healing retry loop. On a failed attempt it asks the LLM to diagnose the
 * error and propose a patch, applies the patch, records a plain-English diagnosis
 * entry, and retries — up to `maxHealAttempts` (default 3). Headline feature.
 *
 * STAGE: 5 (build) — self-heal
 * Inputs: a `RunContext` (project dir, options, cost ledger, diagnosis log).
 * Outputs: the final `AttemptResult`; appends a `DiagnosisEntry` per attempt.
 */

import type { RunContext } from '../core/context.js';
import type { AttemptResult } from './runner.js';

// TODO(stage-5): loop runOnce -> on failure call the heal prompt, validate the patch,
// apply it, log a DiagnosisEntry, and retry until success or the attempt cap.
export async function runSelfHealLoop(_ctx: RunContext): Promise<AttemptResult> {
  throw new Error('not implemented');
}
